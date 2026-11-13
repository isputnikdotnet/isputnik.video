// The catalog work that runs after a scan (issues 1, 4, 7, 8): a scan stopped
// halfway leaves no library stuck, a pass with nothing new writes nothing, and
// a file probed again keeps the keyframes read from it before.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, upgradeDatabase } from "../src/db.js";
import { findTools } from "../src/ffmpeg.js";
import { MediaProbe } from "../src/media-probe.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";
const admin = {
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": "admin",
  "x-isputnik-user-name": "admin",
  "x-isputnik-user-role": "admin",
  "x-isputnik-libraries": "",
  "x-isputnik-client-ip": "192.168.2.10"
};

let fixture: Fixture | null = null;
let dataDir: string | null = null;
let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.cleanup();
  fixture = null;
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  dataDir = null;
});

const start = (dbPath: string, mediaRoot: string) => buildApp({
  gatewaySecret: SECRET, devUser: null, dbPath, mediaRoot, version: "0.0.0-test", stage: null,
  scan: { settleMs: 60_000 }, tools: null, fastify: { logger: false }
});

describe("after a scan", () => {
  it("leaves no library queued or scanning once the engine starts again", async () => {
    fixture = makeFixture();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-work-"));
    const dbPath = path.join(dataDir, "video.sqlite");
    app = await start(dbPath, fixture.root);
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_tv", headers: admin, payload: { name: "TV", kind: "shows", folder: "Shows" } });
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_mov", headers: admin, payload: { name: "Films", kind: "movies", folder: "Movies" } });
    await app.scansSettled();
    await app.close();
    // As a docker stop in the middle of a scan leaves them.
    const db = new Database(dbPath);
    db.prepare("UPDATE libraries SET scan_state = 'scanning' WHERE id = 'lib_tv'").run();
    db.prepare("UPDATE libraries SET scan_state = 'queued' WHERE id = 'lib_mov'").run();
    db.close();

    app = await start(dbPath, fixture.root);
    const libraries = (await app.inject({ method: "GET", url: "/video/api/admin/libraries", headers: admin })).json().libraries as { id: string; scanState: string }[];
    expect(libraries.map((library) => [library.id, library.scanState]).sort()).toEqual([["lib_mov", "idle"], ["lib_tv", "idle"]]);
  });

  it("writes no metadata row the pass found nothing new for", async () => {
    fixture = makeFixture();
    app = await start(":memory:", fixture.root);
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_tv", headers: admin, payload: { name: "TV", kind: "shows", folder: "Shows" } });
    await app.scansSettled();
    const stamps = async () => {
      const res = await app!.inject({ method: "GET", url: "/video/api/admin/backup", headers: admin });
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-copy-")), "copy.sqlite");
      fs.writeFileSync(file, res.rawPayload);
      const copy = new Database(file, { readonly: true });
      const rows = copy.prepare("SELECT item_id, updated_at FROM metadata ORDER BY item_id").all();
      copy.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      return rows;
    };
    const before = await stamps();
    expect(before.length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.inject({ method: "POST", url: "/video/api/admin/libraries/lib_tv/scan", headers: admin });
    await app.scansSettled();
    // The backup is SQLite's own copy, streamed: the same rows, untouched.
    expect(await stamps()).toEqual(before);
  });
});

describe("a file probed again", () => {
  it("keeps its keyframes while it is the same file, and forgets them once it changes", async () => {
    const tools = findTools();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-probe-"));
    const film = path.join(dataDir, "film.mkv");
    execFileSync(tools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=12", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", film]);
    const db = openDatabase(":memory:");
    upgradeDatabase(db);
    const stat = fs.statSync(film);
    const file = { absolute: film, size: stat.size, modified: stat.mtime };
    // A probe from before 0.31.0 (no bitRate), with the keyframes read then.
    db.prepare("INSERT INTO media_probe (item_id, size, modified_ms, info, keyframes) VALUES ('m1', ?, ?, ?, '[0,1]')")
      .run(file.size, file.modified.getTime(), JSON.stringify({ container: "matroska,webm", video: null, subtitles: [], chapters: [] }));
    const probe = new MediaProbe(db, tools);
    const info = await probe.info("m1", file);
    expect("bitRate" in info).toBe(true);
    expect((db.prepare("SELECT keyframes FROM media_probe WHERE item_id = 'm1'").get() as { keyframes: string | null }).keyframes).toBe("[0,1]");
    // Replaced on disk: another file, whose keyframes are not known yet.
    db.prepare("UPDATE media_probe SET size = size + 1, info = '{}' WHERE item_id = 'm1'").run();
    await probe.info("m1", file);
    expect((db.prepare("SELECT keyframes FROM media_probe WHERE item_id = 'm1'").get() as { keyframes: string | null }).keyframes).toBeNull();
    await probe.close();
    db.close();
  });
});
