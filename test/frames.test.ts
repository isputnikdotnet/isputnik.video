// An episode's own picture (metadata.ts frame()): with nothing beside the file and
// nothing from TMDB, a frame of the video itself — taken once, then kept.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { findTools } from "../src/ffmpeg.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";
const as = (id: string, role: "admin" | "member") => ({
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": id,
  "x-isputnik-user-role": role,
  "x-isputnik-libraries": "lib_tv"
});
const admin = as("admin", "admin");
const mum = as("mum", "member");

let fixture: Fixture;
let app: FastifyInstance;
let artDir: string;

beforeAll(async () => {
  fixture = makeFixture();
  const tools = findTools();
  // An old series: two 8-second episodes, and one with its own -thumb.jpg beside it.
  const dir = path.join(fixture.root, "Shows", "Long Road (1982)");
  fs.mkdirSync(dir, { recursive: true });
  const hourAgo = new Date(Date.now() - 3600_000);
  for (const n of [1, 2, 3]) {
    const file = path.join(dir, `Long Road S01E0${n}.mkv`);
    execFileSync(tools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=25`, "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    fs.utimesSync(file, hourAgo, hourAgo);
  }
  fixture.write("Shows/Long Road (1982)/Long Road S01E03-thumb.jpg", "a thumb someone saved");
  artDir = fs.mkdtempSync(path.join(fixture.root, "..", "isputnik-art-"));
  app = await buildApp({
    gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
    artDir, scan: { settleMs: 60_000 }, fastify: { logger: false }
  });
  await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_tv", headers: admin, payload: { name: "TV", kind: "shows", folder: "Shows" } });
  await app.scansSettled();
}, 120_000);

afterAll(async () => {
  await app?.close();
  fixture?.cleanup();
  fs.rmSync(artDir, { recursive: true, force: true });
});

type Episode = { id: string; episode: number; still: string | null };
const episodes = async () => {
  const shows = (await app.inject({ method: "GET", url: "/video/api/shows", headers: mum })).json().items as { id: string; title: string }[];
  const show = (await app.inject({ method: "GET", url: `/video/api/shows/${shows.find((item) => item.title === "Long Road")!.id}`, headers: mum })).json();
  return show.seasons[0].episodes as Episode[];
};

describe("an episode's own picture", () => {
  it("is a frame of the episode when nothing else has one, a JPEG kept in the art folder", async () => {
    await expect.poll(async () => (await episodes())[0].still, { timeout: 30_000 }).not.toBeNull();
    const [first, second] = await episodes();
    const picture = await app.inject({ method: "GET", url: first.still!, headers: mum });
    expect(picture.statusCode).toBe(200);
    expect(picture.headers["content-type"]).toBe("image/jpeg");
    expect(picture.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(second.still).not.toBe(first.still);
    expect(fs.readdirSync(artDir).filter((name) => name.includes("-frame-"))).toHaveLength(2);
  }, 60_000);

  it("never stands in for a picture saved beside the file", async () => {
    const third = (await episodes())[2];
    expect((await app.inject({ method: "GET", url: third.still!, headers: mum })).body).toBe("a thumb someone saved");
  });

  it("is taken once: the next pass keeps it", async () => {
    const before = fs.readdirSync(artDir).filter((name) => name.includes("-frame-")).map((name) => [name, fs.statSync(path.join(artDir, name)).mtimeMs]);
    const stills = (await episodes()).map((episode) => episode.still);
    await app.inject({ method: "POST", url: "/video/api/admin/libraries/lib_tv/metadata", headers: admin });
    await app.scansSettled();
    expect((await episodes()).map((episode) => episode.still)).toEqual(stills);
    expect(fs.readdirSync(artDir).filter((name) => name.includes("-frame-")).map((name) => [name, fs.statSync(path.join(artDir, name)).mtimeMs])).toEqual(before);
  }, 60_000);
});

// A film in two files that TMDB has as a film, not a show («Водитель автобуса»):
// its parts have no episode pictures to take, so each is a frame of its own file.
describe("a film's parts' pictures", () => {
  const family = { ...mum, "x-isputnik-libraries": "lib_films" };
  it("is a frame of each part", async () => {
    const dir = path.join(fixture.root, "Films", "Bus Driver (1983)");
    fs.mkdirSync(dir, { recursive: true });
    const hourAgo = new Date(Date.now() - 3600_000);
    for (const n of [1, 2]) {
      const target = path.join(dir, `Bus Driver (1983) part${n}.mkv`);
      execFileSync(findTools().ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", target]);
      fs.utimesSync(target, hourAgo, hourAgo);
    }
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_films", headers: admin, payload: { name: "Films", kind: "movies", folder: "Films" } });
    await app.scansSettled();
    const film = async () => {
      const items = (await app.inject({ method: "GET", url: "/video/api/movies", headers: family })).json().items as { id: string }[];
      return (await app.inject({ method: "GET", url: `/video/api/movies/${items[0].id}`, headers: family })).json() as { parts: { still: string | null }[] };
    };
    await expect.poll(async () => (await film()).parts.map((part) => part.still !== null), { timeout: 30_000 }).toEqual([true, true]);
    const [first, second] = (await film()).parts;
    expect(second.still).not.toBe(first.still);
    const picture = await app.inject({ method: "GET", url: first.still!, headers: family });
    expect(picture.statusCode).toBe(200);
    expect(picture.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  }, 90_000);
});
