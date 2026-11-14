// A metadata pass as home sees it (app.ts metadataWork): waiting, then running
// with how far it is, then gone; and an episode whose frame ffmpeg couldn't take,
// not tried again until its file changes (metadata.ts frame_misses).
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";
const admin = {
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": "admin",
  "x-isputnik-user-role": "admin",
  "x-isputnik-client-ip": "192.168.2.10",
  "x-isputnik-request-id": "home-admin"
};

let fixture: Fixture;
let app: FastifyInstance;
let dbPath: string;

// "ffmpeg" here is Node itself: it refuses ffmpeg's arguments at once, the way
// ffmpeg fails on a file with no picture in it.
const failingTools = { ffmpeg: process.execPath, ffprobe: process.execPath };

beforeEach(async () => {
  fixture = makeFixture();
  for (let e = 1; e <= 3; e++) fixture.write(`Shows/A Show (2001)/Season 01/A Show S01E0${e}.mkv`, "x".repeat(500));
  dbPath = path.join(fixture.root, "..", `video-${Date.now()}.sqlite`);
  app = await buildApp({
    gatewaySecret: SECRET, devUser: null, dbPath, mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
    scan: { settleMs: 0 }, tools: failingTools, detect: false, fastify: { logger: false }
  });
  await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_shows", headers: admin, payload: { name: "Shows", kind: "shows", folder: "Shows" } });
  await app.scansSettled();
});

afterEach(async () => {
  await app.close();
  fixture.cleanup();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
});

const misses = () => {
  const db = new Database(dbPath, { readonly: true });
  try {
    // This test's own show; the fixture brings others.
    return (db.prepare("SELECT item_id, file, at FROM frame_misses ORDER BY file").all() as { item_id: string; file: string; at: string }[]).filter((miss) => miss.file.startsWith("Shows/A Show (2001)/"));
  } finally {
    db.close();
  }
};

describe("a frame that can't be taken", () => {
  it("is remembered, and tried again only once its file changes", async () => {
    const first = misses();
    expect(first.map((miss) => miss.file)).toEqual([
      "Shows/A Show (2001)/Season 01/A Show S01E01.mkv",
      "Shows/A Show (2001)/Season 01/A Show S01E02.mkv",
      "Shows/A Show (2001)/Season 01/A Show S01E03.mkv"
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.inject({ method: "POST", url: "/video/api/admin/libraries/lib_shows/metadata", headers: admin });
    await app.scansSettled();
    // Not tried again: the record is the first one, untouched.
    expect(misses()).toEqual(first);

    // The file changes (replaced with a fixed copy): tried again.
    const changed = path.join(fixture.root, "Shows/A Show (2001)/Season 01/A Show S01E02.mkv");
    fs.writeFileSync(changed, "y".repeat(800));
    await app.inject({ method: "POST", url: "/video/api/admin/libraries/lib_shows/metadata", headers: admin });
    await app.scansSettled();
    const again = misses();
    expect(again.find((miss) => miss.file.endsWith("E02.mkv"))!.at).not.toBe(first[1].at);
    expect(again.find((miss) => miss.file.endsWith("E01.mkv"))!.at).toBe(first[0].at);
  });
});

describe("a metadata pass as home sees it", () => {
  it("is on the library while it waits or runs, with how far it is, and gone when done", async () => {
    const queued = await app.inject({ method: "POST", url: "/video/api/admin/libraries/lib_shows/metadata", headers: admin });
    expect(queued.statusCode).toBe(202);
    expect(queued.json().library.metadata).toMatchObject({ tmdb: false });
    expect(["queued", "running"]).toContain(queued.json().library.metadata.state);
    await app.scansSettled();
    const after = (await app.inject({ method: "GET", url: "/video/api/admin/libraries", headers: admin })).json().libraries;
    expect(after[0].metadata).toBeNull();
    const report = (await app.inject({ method: "GET", url: "/video/api/admin/diagnostics", headers: admin })).json();
    expect(report.catalogWork).toEqual([]);
  });
});
