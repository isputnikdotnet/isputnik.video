// Watching now (watching.ts, GET /admin/watching): a file played as it is counted
// as one play per person, title and device while its requests come, forgotten a
// minute after the last; and the route an admin reads it from.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { deviceOf, Watching } from "../src/watching.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";
const as = (id: string, extra: Record<string, string> = {}) => ({
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": id,
  "x-isputnik-user-name": id === "mum" ? "Mum" : id,
  "x-isputnik-user-role": id === "admin" ? "admin" : "member",
  "x-isputnik-libraries": "lib_tv,lib_films",
  ...extra
});

describe("the play tracker", () => {
  it("makes one play of a player's many range requests, and forgets it a minute after the last", () => {
    let now = Date.parse("2026-11-14T20:00:00Z");
    const watching = new Watching(() => now);
    const play = { kind: "direct" as const, user: "Mum", userId: "mum", itemId: "ep2", title: "Радар S01E02", network: "home", device: "TV" };
    const first = watching.begin(play);
    first.sent(1000);
    first.end();
    now += 5000;
    const second = watching.begin(play);
    second.sent(500);
    expect(watching.current()).toEqual([expect.objectContaining({ title: "Радар S01E02", bytes: 1500, since: "2026-11-14T20:00:00.000Z", device: "TV" })]);
    // Still open (a long read) a while later: still on.
    now += 120_000;
    expect(watching.current()).toHaveLength(1);
    second.end();
    now += 61_000;
    expect(watching.current()).toEqual([]);
  });

  it("tells a TV from a phone and a browser", () => {
    expect(deviceOf("Mozilla/5.0 (Linux; Android 9; AFTMM) isputnik-tv/0.15")).toBe("TV");
    expect(deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1")).toBe("Phone");
    expect(deviceOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36")).toBe("Browser");
    expect(deviceOf(undefined)).toBe("Unknown");
  });
});

describe("GET /admin/watching", () => {
  let fixture: Fixture;
  let app: FastifyInstance;

  beforeEach(async () => {
    fixture = makeFixture();
    app = await buildApp({
      gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
      scan: { settleMs: 60_000 }, tools: null, fastify: { logger: false }
    });
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_tv", headers: as("admin"), payload: { name: "TV", kind: "shows", folder: "Shows" } });
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_films", headers: as("admin"), payload: { name: "Films", kind: "movies", folder: "Movies" } });
    await app.scansSettled();
  });

  afterEach(async () => {
    await app.close();
    fixture.cleanup();
  });

  it("is for an admin, and lists a file being played as it is with who, what and on what", async () => {
    expect((await app.inject({ method: "GET", url: "/video/api/admin/watching", headers: as("mum") })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/video/api/admin/watching", headers: as("admin") })).json().plays).toEqual([]);

    const shows = (await app.inject({ method: "GET", url: "/video/api/shows", headers: as("mum") })).json().items as { id: string; title: string }[];
    const radar = (await app.inject({ method: "GET", url: `/video/api/shows/${shows.find((show) => show.title === "Радар")!.id}`, headers: as("mum") })).json();
    const episode = radar.seasons[0].episodes[1];
    const streamed = await app.inject({ method: "GET", url: `/video/api/stream/${episode.id}`, headers: { ...as("mum", { "x-isputnik-network": "internet" }), "user-agent": "Mozilla/5.0 (iPhone) Mobile/15E148 Safari/604.1", range: "bytes=0-9" } });
    expect(streamed.statusCode).toBe(206);

    const plays = (await app.inject({ method: "GET", url: "/video/api/admin/watching", headers: as("admin") })).json().plays;
    expect(plays).toEqual([expect.objectContaining({ kind: "direct", user: "Mum", itemId: episode.id, title: "Радар S01E02", device: "Phone", bytes: 10 })]);
    expect(["internet", "home"]).toContain(plays[0].network);
  });
});
