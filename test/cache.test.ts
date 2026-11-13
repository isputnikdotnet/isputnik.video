// One version of a film made once and shared, and kept whole once converted all
// the way through (hls.ts entries, cache/); one limit for everything kept (cache.ts).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { overLimit } from "../src/cache.js";
import { findTools } from "../src/ffmpeg.js";
import { CACHE_FOLDER } from "../src/hls.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";
const tools = findTools();

const as = (id: string) => ({
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": id,
  "x-isputnik-user-name": id,
  "x-isputnik-user-role": id === "admin" ? "admin" : "member",
  "x-isputnik-libraries": "lib_mov"
});

let fixture: Fixture;
let app: FastifyInstance;
let transcode: string;

const boot = async () => {
  app = await buildApp({
    gatewaySecret: SECRET, devUser: null, dbPath: path.join(fixture.root, "video.sqlite"), mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
    scan: { settleMs: 60_000 }, transcodeDir: transcode, copiesDir: path.join(transcode, "copies"), isMapped: () => true,
    fastify: { logger: false }
  });
};
const get = (url: string, who = "mum") => app.inject({ method: "GET", url, headers: as(who) });

beforeEach(async () => {
  fixture = makeFixture();
  transcode = path.join(fixture.root, "transcode");
  // Taller than 480p, so 480p re-encodes the picture.
  const file = path.join(fixture.root, "Movies", "Tall Film (2020).mkv");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(tools.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x540:rate=12", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "14", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "ac3", file]);
  const hourAgo = new Date(Date.now() - 3_600_000);
  fs.utimesSync(file, hourAgo, hourAgo);
  await boot();
  await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_mov", headers: as("admin"), payload: { name: "Films", kind: "movies", folder: "Movies" } });
  await app.scansSettled();
});

afterEach(async () => {
  await app.close();
  fixture.cleanup();
});

const tallId = async (who = "mum") => ((await get("/video/api/movies", who)).json() as { items: { id: string; title: string }[] }).items.find((item) => item.title === "Tall Film")!.id;

/** The film's playlist at a quality, and every segment of it fetched in turn. */
async function watchAll(quality: string, who = "mum"): Promise<{ id: string; url: string; segments: number }> {
  const id = await tallId(who);
  const play = (await get(`/video/api/play/${id}?quality=${quality}`, who)).json();
  const url = play.playback.url as string;
  const segments = (await get(url, who)).body.split("\n").filter((line) => line.endsWith(".ts")).length;
  for (let n = 0; n < segments; n++) expect((await get(url.replace("index.m3u8", `${n}.ts`), who)).statusCode).toBe(200);
  return { id, url, segments };
}

const conversion = async () => (await get("/video/api/admin/conversion", "admin")).json();

async function keptCount(count: number): Promise<void> {
  for (let tries = 0; tries < 100; tries++) {
    if ((await conversion()).usage.kept.count === count) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Never ${count} kept`);
}

describe("a film converted all the way through", () => {
  it("is kept, shared with the next viewer with nothing made, and outlives a restart", async () => {
    const { id, url, segments } = await watchAll("480");
    expect(segments).toBeGreaterThan(1);
    expect((await get(`/video/api/play/${id}?quality=480`)).json().playback.mode).toBe("transcode");
    await keptCount(1);
    const folders = fs.readdirSync(path.join(transcode, CACHE_FOLDER));
    expect(folders).toHaveLength(1);
    expect(fs.existsSync(path.join(transcode, CACHE_FOLDER, folders[0]!, "entry.json"))).toBe(true);

    // Dad gets it as it is: no conversion runs for him.
    expect((await get(url.replace("index.m3u8", "1.ts"), "dad")).statusCode).toBe(200);
    const dad = ((await conversion()).usage.viewers as { user: string; kept: boolean; converting: boolean }[]).find((viewer) => viewer.user === "dad");
    expect(dad).toMatchObject({ kept: true, converting: false });
    const listed = (await get("/video/api/admin/copies", "admin")).json();
    expect(listed.kept).toMatchObject([{ itemId: id, rung: 480, segments, inUse: true }]);
    expect(listed.keptBytes).toBeGreaterThan(0);

    await app.close();
    await boot();
    await keptCount(1);
    expect((await get(url.replace("index.m3u8", "0.ts"))).statusCode).toBe(200);
    expect(((await conversion()).usage.viewers as { kept: boolean }[])[0]).toMatchObject({ kept: true });
  }, 120_000);

  it("is not kept when only its sound was converted, nor with memory only", async () => {
    await watchAll("original");
    await watchAll("480", "dad");
    // The 480p one is kept; the original (picture copied) is not.
    await keptCount(1);

    await app.inject({ method: "PUT", url: "/video/api/admin/conversion", headers: as("admin"), payload: { storage: "memory" } });
    await app.inject({ method: "DELETE", url: "/video/api/admin/copies", headers: as("admin") });
    await app.inject({ method: "DELETE", url: `/video/api/hls/${await tallId()}`, headers: as("dad") });
    await app.inject({ method: "DELETE", url: "/video/api/admin/copies", headers: as("admin") });
    await keptCount(0);
    await watchAll("480", "gran");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await conversion()).usage.kept.count).toBe(0);
  }, 120_000);
});

describe("one limit for everything kept", () => {
  const thing = (id: string, sizeBytes: number, usedAt: string, held = false) => ({ kind: "film" as const, id, sizeBytes, usedAt, held });

  it("removes what was used longest ago until the rest fit, never what is held", () => {
    const things = [thing("new", 40, "2026-11-12"), thing("old", 30, "2026-11-01"), thing("mid", 30, "2026-11-05", true), thing("older", 10, "2026-10-01")];
    expect(overLimit(things, 100).map((t) => t.id)).toEqual(["older"]);
    expect(overLimit(things, 50).map((t) => t.id)).toEqual(["older", "old", "new"]);
    expect(overLimit(things, 1000)).toEqual([]);
  });
});
