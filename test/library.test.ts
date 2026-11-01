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

describe("a folder of films, and a film in parts", () => {
  const member = as("mum", "member", ["lib_mov"]);
  const rescan = async () => {
    await app.inject({ method: "POST", url: "/video/api/admin/libraries/lib_mov/scan", headers: home });
    await app.scansSettled();
  };
  const movies = async () => (await get("/video/api/movies?pageSize=100", member)).json().items as { id: string; title: string }[];
  const titled = async (title: string) => (await movies()).find((movie) => movie.title === title)!;
  const angelique = () => {
    fixture.write("Movies/Angelique/Marvelous Angelique part-2.m4v", "x".repeat(6000));
    fixture.write("Movies/Angelique/Angelique and the King part-3.m4v", "x".repeat(6000));
    fixture.write("Movies/Angelique/Angélique, Marquise des Anges part-1.m4v", "x".repeat(7000));
  };
  const voditel = () => {
    fixture.write("Movies/Voditel avtobusa/Voditel avtobusa part1_HQ.avi", "x".repeat(700));
    fixture.write("Movies/Voditel avtobusa/Voditel avtobusa part2_HQ.avi", "x".repeat(680));
  };

  it("finds every film of a folder, as a set named after it, in the order the names number", async () => {
    angelique();
    await putLibrary("lib_mov", { name: "Movies", kind: "movies", folder: "Movies" });
    const titles = (await movies()).map((movie) => movie.title);
    expect(titles).toEqual(expect.arrayContaining(["Angélique, Marquise des Anges", "Marvelous Angelique", "Angelique and the King"]));
    const sets = (await get("/video/api/sets", member)).json();
    expect(sets.items).toMatchObject([{ name: "Angelique", films: 3 }]);
    const set = (await get(`/video/api/sets/${sets.items[0].id}`, member)).json();
    expect(set.films.map((film: { title: string }) => film.title)).toEqual(["Angélique, Marquise des Anges", "Marvelous Angelique", "Angelique and the King"]);
    // Each plays its own file, and the player's end card leads to the next.
    const second = (await get(`/video/api/play/${set.films[1].id}`, member)).json();
    expect(second).toMatchObject({ available: true, sizeBytes: 6000, next: { id: set.films[2].id, title: "Angelique and the King" } });
  });

  it("keeps the film a folder was catalogued as when the folder turns out to hold more", async () => {
    fixture.write("Movies/Angelique/Angélique, Marquise des Anges part-1.m4v", "x".repeat(7000));
    await putLibrary("lib_mov", { name: "Movies", kind: "movies", folder: "Movies" });
    const before = await titled("Angelique");
    await app.inject({ method: "PUT", url: `/video/api/progress/${before.id}`, headers: member, payload: { position: 300, duration: 7000 } });
    angelique();
    await rescan();
    const after = await titled("Angélique, Marquise des Anges");
    expect(after.id).toBe(before.id);
    expect((await get(`/video/api/movies/${after.id}`, member)).json().progress).toMatchObject({ position: 300 });
    expect(await titled("Angelique")).toBeUndefined();
  });

  it("reads files that differ only by a part number as one film, and plays them in turn", async () => {
    voditel();
    await putLibrary("lib_mov", { name: "Movies", kind: "movies", folder: "Movies" });
    const film = await titled("Voditel avtobusa");
    expect((await movies()).filter((movie) => movie.title.startsWith("Voditel"))).toHaveLength(1);
    expect((await get("/video/api/sets", member)).json().items).toEqual([]);
    const detail = (await get(`/video/api/movies/${film.id}`, member)).json();
    expect(detail.parts.map((part: { part: number }) => part.part)).toEqual([1, 2]);
    expect(detail.playId).toBe(film.id);

    const first = (await get(`/video/api/play/${film.id}`, member)).json();
    expect(first).toMatchObject({ title: "Voditel avtobusa (1/2)", sizeBytes: 700, next: { id: detail.parts[1].id, title: "Voditel avtobusa (2/2)" } });
    const second = (await get(`/video/api/play/${detail.parts[1].id}`, member)).json();
    expect(second).toMatchObject({ title: "Voditel avtobusa (2/2)", sizeBytes: 680, next: null });
    // The player's way back from a part is the film.
    expect((await get(`/video/api/movies/${detail.parts[1].id}`, member)).json().id).toBe(film.id);
    // And the library counts both files.
    const library = (await get("/video/api/admin/libraries", home)).json().libraries[0];
    expect(library.titles).toBe(3);
    expect(library.sizeBytes).toBe(8000 + 1380);
  });

  it("resumes a film in parts from the part a person has got to, and finishes it with the last", async () => {
    voditel();
    await putLibrary("lib_mov", { name: "Movies", kind: "movies", folder: "Movies" });
    const film = await titled("Voditel avtobusa");
    const partTwo = (await get(`/video/api/movies/${film.id}`, member)).json().parts[1].id;
    const save = (id: string, position: number) => app.inject({ method: "PUT", url: `/video/api/progress/${id}`, headers: member, payload: { position, duration: 3000 } });

    await save(film.id, 2990);
    const afterFirst = (await get(`/video/api/movies/${film.id}`, member)).json();
    expect(afterFirst).toMatchObject({ playId: partTwo, progress: null });
    expect((await get("/video/api/continue", member)).json().items).toMatchObject([{ id: partTwo, title: "Voditel avtobusa (2/2)", resume: false }]);

    await save(partTwo, 600);
    expect((await get(`/video/api/movies/${film.id}`, member)).json()).toMatchObject({ playId: partTwo, progress: { position: 600, watched: false } });
    expect((await get("/video/api/continue", member)).json().items).toMatchObject([{ id: partTwo, position: 600, resume: true }]);

    await save(partTwo, 2990);
    expect((await get(`/video/api/movies/${film.id}`, member)).json()).toMatchObject({ playId: film.id, progress: { watched: true } });
    expect((await get("/video/api/continue", member)).json().items).toEqual([]);
  });

  it("drops a part that has gone, and keeps the rest of the film", async () => {
    voditel();
    fixture.write("Movies/Voditel avtobusa/Voditel avtobusa part3_HQ.avi", "x".repeat(690));
    await putLibrary("lib_mov", { name: "Movies", kind: "movies", folder: "Movies" });
    const film = await titled("Voditel avtobusa");
    expect((await get(`/video/api/movies/${film.id}`, member)).json().parts).toHaveLength(3);
    fixture.remove("Movies/Voditel avtobusa/Voditel avtobusa part3_HQ.avi");
    await rescan();
    const after = (await get(`/video/api/movies/${film.id}`, member)).json();
    expect(after.parts.map((part: { part: number }) => part.part)).toEqual([1, 2]);
  });

  it("stays one film for what only goes with a film, an .nfo that says so, or copies of it", async () => {
    // Extras, by name and by size.
    fixture.write("Movies/Big One (2001)/Big One (2001).mkv", "x".repeat(5000));
    fixture.write("Movies/Big One (2001)/Big One (2001)-trailer.mkv", "x".repeat(4000));
    fixture.write("Movies/Big One (2001)/Making of.mkv", "x".repeat(500));
    fixture.write("Movies/Big One (2001)/Extras/Deleted.mkv", "x".repeat(4000));
    // movie.nfo: the folder is one film, whatever else is in it.
    fixture.write("Movies/Told (2002)/Told (2002).mkv", "x".repeat(5000));
    fixture.write("Movies/Told (2002)/Something else.mkv", "x".repeat(4000));
    fixture.write("Movies/Told (2002)/movie.nfo", "<movie><title>Told</title></movie>");
    // Two qualities of one film: the bigger.
    fixture.write("Movies/Twice (2003)/Twice (2003) - 1080p.mkv", "x".repeat(5000));
    fixture.write("Movies/Twice (2003)/Twice (2003) - 720p.mkv", "x".repeat(3000));
    // A disc copied as it is.
    fixture.write("Movies/Disc (2004)/BDMV/STREAM/00001.m2ts", "x".repeat(5000));
    fixture.write("Movies/Disc (2004)/BDMV/STREAM/00002.m2ts", "x".repeat(4000));
    await putLibrary("lib_mov", { name: "Movies", kind: "movies", folder: "Movies" });
    const titles = (await movies()).map((movie) => movie.title).sort();
    expect(titles).toEqual(["Big One", "Disc", "Loose Film", "Some Film", "Told", "Twice"]);
    expect((await get("/video/api/sets", member)).json().items).toEqual([]);
  });

  it("does not take a sequel for a part", async () => {
    fixture.write("Movies/Godfather/The Godfather.mkv", "x".repeat(5000));
    fixture.write("Movies/Godfather/The Godfather Part 2.mkv", "x".repeat(5000));
    fixture.write("Movies/Godfather/The Godfather Part 3.mkv", "x".repeat(5000));
    fixture.write("Movies/Potter/Deathly Hallows Part 1 (2010).mkv", "x".repeat(5000));
    fixture.write("Movies/Potter/Deathly Hallows Part 2 (2011).mkv", "x".repeat(5000));
    await putLibrary("lib_mov", { name: "Movies", kind: "movies", folder: "Movies" });
    const titles = (await movies()).map((movie) => movie.title);
    expect(titles).toEqual(expect.arrayContaining(["The Godfather", "The Godfather Part 2", "The Godfather Part 3", "Deathly Hallows Part 1", "Deathly Hallows Part 2"]));
  });

  it("reads loose files in parts as one film, and sub-folders as films of a set", async () => {
    fixture.write("Movies/Bare part 1.mkv", "x".repeat(2000));
    fixture.write("Movies/Bare part 2.mkv", "x".repeat(2000));
    fixture.write("Movies/Trilogy/First (1990)/First (1990).mkv", "x".repeat(5000));
    fixture.write("Movies/Trilogy/First (1990)/trailer.mkv", "x".repeat(50));
    fixture.write("Movies/Trilogy/Second (1992)/film.mkv", "x".repeat(5000));
    fixture.write("Movies/Discs/CD1/movie.avi", "x".repeat(700));
    fixture.write("Movies/Discs/CD2/movie.avi", "x".repeat(700));
    await putLibrary("lib_mov", { name: "Movies", kind: "movies", folder: "Movies" });
    const list = await movies();
    expect(list.filter((movie) => movie.title === "Bare")).toHaveLength(1);
    expect((await get(`/video/api/movies/${(await titled("Bare")).id}`, member)).json().parts).toHaveLength(2);
    expect((await get("/video/api/sets", member)).json().items).toMatchObject([{ name: "Trilogy", films: 2 }]);
    const second = await titled("Second");
    expect((await get(`/video/api/play/${second.id}`, member)).json()).toMatchObject({ available: true, sizeBytes: 5000 });
    expect((await get(`/video/api/movies/${(await titled("Discs")).id}`, member)).json().parts).toHaveLength(2);
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
