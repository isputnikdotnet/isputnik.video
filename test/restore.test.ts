// A backup going back in (restore.ts): home sends a catalog it holds and it is in
// place at once, with no restart; the one it replaced can be put back once.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { Fetch } from "../src/tmdb.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";
const as = (id: string, role: string) => ({
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": id,
  "x-isputnik-user-role": role
});
const admin = as("admin", "admin");
const mum = as("mum", "member");

let fixture: Fixture;
let dir: string;
let app: FastifyInstance;
/** TMDB answers once this has resolved, so a test can hold a metadata pass open. */
let gate: Promise<void>;
const tmdb = (async () => {
  await gate;
  return new Response(JSON.stringify({ success: true, results: [] }), { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as Fetch;

beforeEach(async () => {
  gate = Promise.resolve();
  fixture = makeFixture();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-restore-"));
  app = await buildApp({
    gatewaySecret: SECRET, devUser: null, dbPath: path.join(dir, "video.sqlite"), mediaRoot: fixture.root, version: "1.0.0", stage: null,
    tools: null, artDir: path.join(dir, "art"), scan: { settleMs: 0 }, fetch: tmdb,
    fastify: { logger: false }
  });
});

afterEach(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fixture.cleanup();
});

/** A backup as a database to look into: a copy of a WAL file opens in memory only
 *  once its header stops saying WAL. */
const opened = (bytes: Buffer) => {
  const image = Buffer.from(bytes);
  image[18] = 1;
  image[19] = 1;
  return new Database(image);
};

const put = async (id: string) => {
  const res = await app.inject({
    method: "PUT",
    url: `/video/api/admin/libraries/${id}`,
    headers: admin,
    payload: { name: id, kind: "shows", folder: "Shows", language: "en" }
  });
  expect(res.statusCode).toBeLessThan(300);
};
const libraries = async () =>
  ((await app.inject({ method: "GET", url: "/video/api/admin/libraries", headers: admin })).json() as { libraries: { id: string; scanState: string }[] }).libraries;
const backup = async () => (await app.inject({ method: "GET", url: "/video/api/admin/backup", headers: admin })).rawPayload;
const restore = (body: Buffer, headers: Record<string, string> = admin, version?: string) =>
  app.inject({
    method: "POST",
    url: "/video/api/admin/restore",
    headers: { ...headers, "content-type": "application/vnd.sqlite3", ...(version ? { "x-isputnik-backup-version": version } : {}) },
    payload: body
  });

describe("restoring the catalog", () => {
  it("is for an admin only", async () => {
    expect((await restore(Buffer.from("x"), {})).statusCode).toBe(401);
    expect((await restore(Buffer.from("x"), mum)).statusCode).toBe(403);
  });

  it("puts the old catalog back, cascades and all, from a live WAL database", async () => {
    await put("one");
    await app.scansSettled();
    const snapshot = await backup();
    const titled = opened(snapshot);
    const shows = (titled.prepare("SELECT COUNT(*) AS n FROM shows").get() as { n: number }).n;
    titled.close();
    expect(shows).toBeGreaterThan(0);

    await put("two");
    await app.scansSettled();
    expect((await libraries()).map((library) => library.id).sort()).toEqual(["one", "two"]);

    expect((await restore(snapshot, admin, "1.0.0")).statusCode).toBe(200);
    expect((await libraries()).map((library) => library.id)).toEqual(["one"]);
    const after = opened(await backup());
    expect((after.prepare("SELECT COUNT(*) AS n FROM shows").get() as { n: number }).n).toBe(shows);
    after.close();
  });

  it("can be undone once", async () => {
    await put("one");
    await app.scansSettled();
    const empty = opened(await backup());
    empty.exec("DELETE FROM libraries");
    const none = empty.serialize();
    empty.close();

    expect((await restore(none)).statusCode).toBe(200);
    expect(await libraries()).toEqual([]);
    const info = (await app.inject({ method: "GET", url: "/video/api/admin/restore/undo", headers: admin })).json();
    expect(info.undo).toMatchObject({ version: "1.0.0" });

    expect((await app.inject({ method: "POST", url: "/video/api/admin/restore/undo", headers: admin })).statusCode).toBe(200);
    expect((await libraries()).map((library) => library.id)).toEqual(["one"]);
    expect((await app.inject({ method: "POST", url: "/video/api/admin/restore/undo", headers: admin })).statusCode).toBe(404);
  });

  it("is refused while a scan is at work, and leaves the catalog alone", async () => {
    await put("one");
    await app.scansSettled();
    const snapshot = await backup();
    const key = await app.inject({ method: "PUT", url: "/video/api/admin/metadata", headers: admin, payload: { tmdbKey: "k".repeat(32) } });
    expect(key.statusCode).toBe(200);
    let release = () => undefined as void;
    gate = new Promise((resolve) => { release = resolve; });
    await put("two"); // its scan, then a metadata pass held open at TMDB
    await new Promise((resolve) => setTimeout(resolve, 50));
    const res = await restore(snapshot);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/scan/i);
    release();
    await app.scansSettled();
    expect((await libraries()).map((library) => library.id).sort()).toEqual(["one", "two"]);
    expect((await restore(snapshot)).statusCode).toBe(200);
  });

  it("does not leave a library saying it is scanning", async () => {
    await put("one");
    await app.scansSettled();
    const mid = opened(await backup());
    mid.exec("UPDATE libraries SET scan_state = 'scanning'");
    const bytes = mid.serialize();
    mid.close();
    await restore(bytes);
    expect((await libraries())[0].scanState).toBe("idle");
  });

  it("brings an older catalog up to this version, and refuses a newer one", async () => {
    await put("one");
    await app.scansSettled();
    const older = opened(await backup());
    older.exec("DROP TABLE set_members; DROP TABLE sets; ALTER TABLE movies DROP COLUMN set_name");
    const oldBytes = older.serialize();
    older.close();
    expect((await restore(oldBytes, admin, "0.8.0")).statusCode).toBe(200);
    expect((await libraries()).map((library) => library.id)).toEqual(["one"]);

    const snapshot = await backup();
    expect((await restore(snapshot, admin, "9.0.0")).statusCode).toBe(409);
  });

  it("refuses a database of something else", async () => {
    const other = new Database(":memory:");
    other.exec("CREATE TABLE matches (id TEXT)");
    const res = await restore(other.serialize());
    other.close();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a backup of the video catalog/);
  });
});
