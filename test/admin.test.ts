// The gateway check and the admin's routes: who gets in, the folder picker,
// the events, the log and the backup copy.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createLogBuffer } from "../src/log-buffer.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";
const as = (id: string, role: string) => ({
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": id,
  "x-isputnik-user-role": role,
  "x-isputnik-client-ip": "192.168.2.10",
  "x-isputnik-request-id": `home-${id}`
});
const admin = as("admin", "admin");
const mum = as("mum", "member");

let fixture: Fixture;
let app: FastifyInstance;

beforeEach(async () => {
  fixture = makeFixture();
  const logBuffer = createLogBuffer(100, { write: () => undefined });
  app = await buildApp({
    gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
    logBuffer,
    fastify: { logger: { level: "info", stream: logBuffer } }
  });
});

afterEach(async () => {
  await app.close();
  fixture.cleanup();
});

const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });

describe("the gateway check", () => {
  it("answers health to anyone and everything else only with the secret", async () => {
    expect((await get("/video/api/health", {})).json()).toEqual({ ok: true, version: "0.0.0-test" });
    expect((await get("/video/api/me", {})).statusCode).toBe(401);
    expect((await get("/video/api/me", { ...mum, "x-isputnik-gateway": "guess" })).statusCode).toBe(401);
    const me = (await get("/video/api/me", mum)).json();
    expect(me.user).toMatchObject({ id: "mum", role: "member", appRole: "member" });
    expect(me.libraries).toEqual([]);
  });

  it("treats a guest as nobody: video has no guests", async () => {
    expect((await get("/video/api/me", as("guest_x", "guest"))).statusCode).toBe(401);
  });

  it("records a refused caller, never the secret", async () => {
    await get("/video/api/shows", { ...mum, "x-isputnik-gateway": "guess-the-secret" });
    const page = (await get("/video/api/admin/events?event=gateway", admin)).json();
    expect(page.events[0].detail).toBe("GET /video/api/shows: wrong gateway secret");
    expect(page.rejected24h).toBe(1);
    expect(JSON.stringify(page)).not.toContain("guess-the-secret");
  });
});

describe("admin routes", () => {
  it("answer an admin only", async () => {
    for (const url of ["/video/api/admin/libraries", "/video/api/admin/folders", "/video/api/admin/events", "/video/api/admin/log", "/video/api/admin/backup", "/video/api/admin/disks"]) {
      expect((await get(url, mum)).statusCode, url).toBe(403);
      expect((await get(url, admin)).statusCode, url).toBe(200);
    }
  });

  it("list the engine's own folders for the picker, and nothing outside them", async () => {
    const top = (await get("/video/api/admin/folders", admin)).json();
    expect(top.folders.map((folder: { name: string }) => folder.name)).toEqual(["Kids", "Movies", "Shows"]);
    const shows = (await get("/video/api/admin/folders?path=Shows", admin)).json();
    expect(shows.folders).toEqual([
      { name: "Counterpart.S02.1080p.Wanterlude", path: "Shows/Counterpart.S02.1080p.Wanterlude", folders: 1 },
      { name: "Radar (2026) [imdbid-tt33022834]", path: "Shows/Radar (2026) [imdbid-tt33022834]", folders: 1 }
    ]);
    expect((await get("/video/api/admin/folders?path=..", admin)).statusCode).toBe(404);
    expect((await get("/video/api/admin/folders?path=Shows/../..", admin)).statusCode).toBe(404);
  });

  it("say which disks the libraries, posters and catalog sit on, for home's Dashboard", async () => {
    const put = await app.inject({
      method: "PUT", url: "/video/api/admin/libraries/tv", headers: admin,
      payload: { name: "TV Shows", kind: "shows", folder: "Shows", language: "en" }
    });
    expect(put.statusCode).toBeLessThan(300);
    const { disks } = (await get("/video/api/admin/disks", admin)).json() as {
      disks: { mount: string; filesystem: string; freeBytes: number; totalBytes: number; holds: { kind: string; name?: string; path: string }[]; sharesWith: string[] }[];
    };
    const holds = disks.flatMap((disk) => disk.holds);
    const library = holds.find((hold) => hold.kind === "library");
    expect(library).toMatchObject({ name: "TV Shows" });
    expect(library?.path.endsWith("Shows")).toBe(true);
    expect(holds.some((hold) => hold.kind === "artwork")).toBe(true);
    // An in-memory catalog has no file to measure.
    expect(holds.some((hold) => hold.kind === "database")).toBe(false);
    for (const disk of disks) {
      expect(disk.totalBytes).toBeGreaterThan(0);
      expect(disk.freeBytes).toBeLessThanOrEqual(disk.totalBytes);
      expect(disk.sharesWith).not.toContain(disk.mount);
    }
  });

  it("hand the catalog over for home's backup as a real database", async () => {
    const res = await get("/video/api/admin/backup", admin);
    expect(res.headers["content-type"]).toBe("application/vnd.sqlite3");
    expect(res.headers["x-isputnik-backup-version"]).toBe("0.0.0-test");
    const copy = new Database(res.rawPayload);
    expect(copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shows'").get()).toEqual({ name: "shows" });
    copy.close();
    expect((await get("/video/api/admin/events?event=backup.taken", admin)).json().total).toBe(1);
  });

  it("hand out the log tail", async () => {
    await get("/video/api/me", mum);
    const body = (await get("/video/api/admin/log?lines=50", admin)).json();
    expect(body.available).toBe(true);
    const line = body.lines.map((raw: string) => JSON.parse(raw)).find((entry: { msg: string; reqId?: string }) => entry.msg === "request completed" && entry.reqId === "home-mum");
    expect(line).toMatchObject({ user: "mum", ip: "192.168.2.10" });
  });

  it("answer an unknown address with JSON, never a page", async () => {
    const res = await get("/video/api/nope", admin);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Not found" });
  });
});
