// A library from home to the family's screens: home puts it, the engine scans
// it, and the catalog answers only from the libraries a person may see.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";

const as = (id: string, role: "admin" | "member", libraries: string[] = []) => ({
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": id,
  "x-isputnik-user-name": encodeURIComponent(id),
  "x-isputnik-user-role": role,
  "x-isputnik-libraries": libraries.join(","),
  "x-isputnik-client-ip": "192.168.2.10"
});
const home = as("admin", "admin");

let fixture: Fixture;
let app: FastifyInstance;

beforeEach(async () => {
  fixture = makeFixture();
  app = await buildApp({
    gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
    // Files written an hour ago are settled; the one written just now is not.
    scan: { settleMs: 60_000 },
    fastify: { logger: false }
  });
});

afterEach(async () => {
  await app.close();
  fixture.cleanup();
});

async function putLibrary(id: string, body: Record<string, unknown>) {
  const res = await app.inject({ method: "PUT", url: `/video/api/admin/libraries/${id}`, headers: home, payload: body });
  await app.scansSettled();
  return res;
}

const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });

describe("a shows library", () => {
  it("is scanned when home adds it, and reads .nfo files before names", async () => {
    const res = await putLibrary("lib_tv", { name: "TV Shows", kind: "shows", folder: "Shows", language: "ru" });
    expect(res.statusCode).toBe(201);

    const list = (await get("/video/api/shows", as("mum", "member", ["lib_tv"]))).json();
    expect(list.total).toBe(2);
    const titles = list.items.map((show: { title: string }) => show.title);
    expect(titles).toEqual(["Counterpart", "Радар"]);

    const radar = list.items.find((show: { title: string }) => show.title === "Радар");
    expect(radar).toMatchObject({ year: 2026, imdbId: "tt33022834", genres: ["Драма", "Фантастика"], seasons: 1, episodes: 3 });
    const detail = (await get(`/video/api/shows/${radar.id}`, as("mum", "member", ["lib_tv"]))).json();
    expect(detail.source).toBe("nfo");
    expect(detail.seasons[0].episodes.map((ep: { episode: number; title: string; aired: string }) => [ep.episode, ep.title, ep.aired])).toEqual([
      [1, "Серия 1", "2026-04-21"], [2, "Серия 2", "2026-04-22"], [3, "Серия 3", "2026-04-23"]
    ]);
  });

  it("leaves a file being copied for later, and notes a file it cannot number", async () => {
    await putLibrary("lib_tv", { name: "TV Shows", kind: "shows", folder: "Shows" });
    const list = (await get("/video/api/shows", as("mum", "member", ["lib_tv"]))).json();
    const counterpart = list.items.find((show: { title: string }) => show.title === "Counterpart");
    expect(counterpart).toMatchObject({ seasons: 1, episodes: 2 });
    const events = (await get("/video/api/admin/events?event=scan", home)).json();
    expect(events.events[0]).toMatchObject({ event: "scan.finished", level: "warn", libraryId: "lib_tv" });
    expect(events.events[0].detail).toContain("1 file(s) still being copied");
    expect(events.events[0].detail).toContain("1 file(s) without a season and episode");
  });

  it("keeps ids across a rescan, and drops what is gone", async () => {
    await putLibrary("lib_tv", { name: "TV Shows", kind: "shows", folder: "Shows" });
    const member = as("mum", "member", ["lib_tv"]);
    const before = (await get("/video/api/shows", member)).json().items;
    fixture.remove("Shows/Radar (2026) [imdbid-tt33022834]/Season 01/Radar (2026) S01E03 - Серия 3.mkv");
    await app.inject({ method: "POST", url: "/video/api/admin/libraries/lib_tv/scan", headers: home });
    await app.scansSettled();
    const after = (await get("/video/api/shows", member)).json().items;
    expect(after.map((show: { id: string }) => show.id).sort()).toEqual(before.map((show: { id: string }) => show.id).sort());
    expect(after.find((show: { title: string }) => show.title === "Радар").episodes).toBe(2);
  });

  it("shows nothing to someone home did not let in, and a show by id only to those it did", async () => {
    await putLibrary("lib_tv", { name: "TV Shows", kind: "shows", folder: "Shows" });
    const id = (await get("/video/api/shows", as("mum", "member", ["lib_tv"]))).json().items[0].id;
    expect((await get("/video/api/shows", as("kid", "member", []))).json()).toMatchObject({ total: 0, items: [] });
    expect((await get(`/video/api/shows/${id}`, as("kid", "member", ["lib_other"]))).statusCode).toBe(404);
    expect((await get("/video/api/libraries", as("kid", "member", []))).json()).toEqual({ libraries: [] });
  });
});

describe("a movies library", () => {
  it("takes the biggest file of a folder, and a loose file as a film of its own", async () => {
    await putLibrary("lib_mov", { name: "Movies", kind: "movies", folder: "Movies" });
    const list = (await get("/video/api/movies", as("mum", "member", ["lib_mov"]))).json();
    expect(list.items.map((movie: { title: string; year: number }) => [movie.title, movie.year])).toEqual([["Loose Film", 1999], ["Some Film", 2010]]);
    const some = list.items.find((movie: { title: string }) => movie.title === "Some Film");
    expect(some).toMatchObject({ runtimeMinutes: 112, genres: ["Comedy"] });
    const library = (await get("/video/api/admin/libraries", home)).json().libraries[0];
    // The film, not the trailer, and the loose file.
    expect(library).toMatchObject({ titles: 2, sizeBytes: 8000, scanState: "idle" });
  });
});

describe("libraries as home manages them", () => {
  it("refuses a folder that is not under the media root", async () => {
    expect((await putLibrary("lib_x", { name: "X", kind: "shows", folder: "../../etc" })).statusCode).toBe(422);
    expect((await putLibrary("lib_x", { name: "X", kind: "shows", folder: "Nope" })).statusCode).toBe(422);
  });

  it("keeps a library's kind", async () => {
    await putLibrary("lib_tv", { name: "TV", kind: "shows", folder: "Shows" });
    expect((await putLibrary("lib_tv", { name: "TV", kind: "movies", folder: "Shows" })).statusCode).toBe(409);
  });

  it("only detaches a library home stops listing, and brings it back with its catalog", async () => {
    await putLibrary("lib_tv", { name: "TV", kind: "shows", folder: "Shows" });
    const member = as("mum", "member", ["lib_tv"]);
    const ids = (await get("/video/api/shows", member)).json().items.map((show: { id: string }) => show.id);
    const synced = await app.inject({ method: "POST", url: "/video/api/admin/libraries/sync", headers: home, payload: { ids: [] } });
    expect(synced.json()).toEqual({ detached: ["lib_tv"], reattached: [] });
    expect((await get("/video/api/shows", member)).json().total).toBe(0);
    await app.inject({ method: "POST", url: "/video/api/admin/libraries/sync", headers: home, payload: { ids: ["lib_tv"] } });
    expect((await get("/video/api/shows", member)).json().items.map((show: { id: string }) => show.id)).toEqual(ids);
  });

  it("deletes a library and its catalog when home deletes it", async () => {
    await putLibrary("lib_tv", { name: "TV", kind: "shows", folder: "Shows" });
    expect((await app.inject({ method: "DELETE", url: "/video/api/admin/libraries/lib_tv", headers: home })).json()).toEqual({ deleted: true });
    expect((await get("/video/api/admin/libraries", home)).json().libraries).toEqual([]);
    const copy = new Database((await get("/video/api/admin/backup", home)).rawPayload);
    expect((copy.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }).n).toBe(0);
    copy.close();
  });
});
