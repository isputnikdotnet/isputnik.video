// The folder for video, chosen in home instead of in the container's settings
// (video-folder.ts): the places offered, what is refused and why, and that a
// choice is in force from the next start — in a folder of the engine's own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { findTools } from "../src/ffmpeg.js";
import { isIgnoredName } from "../src/media.js";
import { parseMountinfo } from "../src/mounts.js";
import { VIDEO_FOLDER, diskMounts, folderProblem } from "../src/video-folder.js";

const SECRET = "test-secret-0123456789abcdef-0123456789";
const admin = { "x-isputnik-gateway": SECRET, "x-isputnik-user-id": "admin", "x-isputnik-user-name": "Admin", "x-isputnik-user-role": "admin", "x-isputnik-libraries": "" };

describe("the disks mapped into a container", () => {
  const mountinfo = [
    "1 0 0:50 / / rw - overlay overlay rw",
    "2 1 0:51 / /proc rw - proc proc rw",
    "3 1 0:52 / /dev/shm rw - tmpfs shm rw",
    "4 1 8:1 /appdata/video /config rw - xfs /dev/sdb1 rw",
    "5 1 0:60 /media /media ro - fuse.shfs shfs rw",
    "6 1 8:2 /cache /mnt/fast rw - btrfs /dev/nvme0n1p1 rw",
    "7 1 8:1 /etc/hosts /etc/hosts rw - xfs /dev/sdb1 rw"
  ].join("\n");

  it("offers the real disks, never the root, memory, the system's folders or the catalog's", () => {
    expect(diskMounts(parseMountinfo(mountinfo), "/config")).toEqual(["/media", "/mnt/fast"]);
  });
});

describe("choosing the folder for video", () => {
  let root: string;
  let app: FastifyInstance | null = null;
  const open = async () => {
    app = await buildApp({
      gatewaySecret: SECRET, devUser: null, dbPath: path.join(root, "config", "video.sqlite"), mediaRoot: path.join(root, "media"),
      transcodeDir: path.join(root, "transcode"), isMapped: (folder) => !folder.includes("inside"), version: "0.0.0-test", stage: null, fastify: { logger: false }
    });
    return app;
  };
  const conversion = async () => (await app!.inject({ method: "GET", url: "/video/api/admin/conversion", headers: admin })).json();
  const choose = (folder: string | null) => app!.inject({ method: "PUT", url: "/video/api/admin/conversion/folder", headers: admin, payload: { folder } });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-folder-"));
    for (const name of ["config", "media", "fast", "inside"]) fs.mkdirSync(path.join(root, name));
  });
  afterEach(async () => {
    await app?.close();
    app = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("says why a folder can't hold video", () => {
    const options = { mediaRoot: path.join(root, "media"), catalogDir: path.join(root, "config"), isMapped: (folder: string) => !folder.includes("inside") };
    expect(folderProblem("fast", options)).toMatch(/full path/);
    // Never beside the catalog: what is there is backed up.
    expect(folderProblem(path.join(root, "config"), options)).toMatch(/Config & Data folder, which is backed up/);
    expect(folderProblem(path.join(root, "config", "cache"), options)).toMatch(/Config & Data folder/);
    // With the libraries is fine, where the container may write there.
    expect(folderProblem(path.join(root, "media"), options)).toBeNull();
    expect(isIgnoredName(VIDEO_FOLDER)).toBe(true);
    expect(folderProblem(path.join(root, "nowhere"), options)).toMatch(/can't see that folder/);
    expect(folderProblem(path.join(root, "inside"), options)).toMatch(/inside the container itself/);
    expect(folderProblem(path.join(root, "fast"), options)).toBeNull();
    // Proving it can be written to made the engine's own folder there.
    expect(fs.existsSync(path.join(root, "fast", VIDEO_FOLDER))).toBe(true);
  });

  // Everything below needs ffmpeg: without it the engine converts nothing and has no folder.
  it.skipIf(!findTools())("keeps a choice for the next start, in a folder of its own, and goes back on asking", async () => {
    await open();
    const place = path.join(root, "fast");
    expect((await conversion()).disk).toMatchObject({ folder: path.join(root, "transcode"), choice: { folder: null, pending: false } });
    const offered = (await app!.inject({ method: "GET", url: "/video/api/admin/conversion/folders", headers: admin })).json();
    expect(offered.subfolder).toBe(VIDEO_FOLDER);
    // Two locations, as the picker names them: where the libraries are, and the
    // container's cache folder. Never the catalog's folder.
    // (On Linux the machine's own other disks follow as disk-N, and a CI runner has
    // some, so only these two are pinned.)
    const pinned = offered.places.filter((entry: { id: string }) => !entry.id.startsWith("disk-"));
    expect(pinned.map((entry: { id: string; path: string; writable: boolean }) => [entry.id, entry.path, entry.writable])).toEqual([
      ["libraries", path.join(root, "media"), true],
      ["cache", path.join(root, "transcode"), true]
    ]);
    expect(offered.container).toBe(path.join(root, "transcode"));

    // A location's folders are walked as Add library walks the libraries'.
    fs.mkdirSync(path.join(root, "media", "Extra", "Deep"), { recursive: true });
    fs.mkdirSync(path.join(root, "media", "video-cache"));
    const browse = async (place: string, at = "") => (await app!.inject({ method: "GET", url: `/video/api/admin/conversion/folders/browse?place=${place}&path=${encodeURIComponent(at)}`, headers: admin }));
    const top = (await browse("libraries")).json();
    expect(top).toMatchObject({ root: { id: "libraries" }, currentPath: "", selectedPath: path.join(root, "media"), parentPath: null });
    // The engine's own folder is never offered to go into.
    expect(top.entries).toEqual([{ name: "Extra", relativePath: "Extra" }]);
    expect((await browse("libraries", "Extra")).json()).toMatchObject({ currentPath: "Extra", selectedPath: path.join(root, "media", "Extra"), parentPath: "", entries: [{ name: "Deep", relativePath: "Extra/Deep" }] });
    expect((await browse("libraries", "../config")).statusCode).toBe(404);
    expect((await browse("nowhere")).statusCode).toBe(404);
    // The container's own cache folder, picked, is its own setting: nothing to restart for.
    expect((await choose(path.join(root, "transcode"))).json().disk.choice).toEqual({ folder: null, pending: false, problem: null });
    expect((await choose(path.join(root, "config"))).json().error).toMatch(/Config & Data folder/);

    expect((await choose("fast")).statusCode).toBe(400);
    expect((await choose(path.join(root, "inside"))).json().error).toMatch(/inside the container itself/);
    expect((await app!.inject({ method: "PUT", url: "/video/api/admin/conversion/folder", headers: { ...admin, "x-isputnik-user-role": "member" }, payload: { folder: place } })).statusCode).toBe(403);

    // Chosen: still where it was, until the next start.
    const chosen = (await choose(place)).json();
    expect(chosen.disk).toMatchObject({ folder: path.join(root, "transcode"), choice: { folder: place, pending: true } });

    // Something of the admin's own in that place is never touched.
    fs.writeFileSync(path.join(place, "keep.txt"), "mine");
    await app!.close();
    await open();
    expect((await conversion()).disk).toMatchObject({ mapped: true, folder: path.join(place, VIDEO_FOLDER), choice: { folder: place, pending: false } });
    expect(fs.readFileSync(path.join(place, "keep.txt"), "utf8")).toBe("mine");
    const copies = (await app!.inject({ method: "GET", url: "/video/api/admin/copies", headers: admin })).json();
    expect(copies).toMatchObject({ folder: path.join(place, VIDEO_FOLDER, "copies"), insideContainer: false });

    // Back to the container's own setting, again from the next start.
    expect((await choose(null)).json().disk.choice).toEqual({ folder: null, pending: true, problem: null });
    await app!.close();
    await open();
    expect((await conversion()).disk).toMatchObject({ folder: path.join(root, "transcode"), choice: { folder: null, pending: false } });
  });

  it.skipIf(!findTools())("sets aside a choice that stopped working, and says so", async () => {
    await open();
    const place = path.join(root, "fast");
    await choose(place);
    await app!.close();
    fs.rmSync(place, { recursive: true, force: true });
    await open();
    const disk = (await conversion()).disk;
    expect(disk.folder).toBe(path.join(root, "transcode"));
    expect(disk.choice).toMatchObject({ folder: place, pending: false });
    expect(disk.choice.problem).toMatch(/can't see that folder/);
  });
});
