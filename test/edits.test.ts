// A title's details as the admin edits them: over the scan's, through every
// rescan, each field able to go back to what the scan found.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";
const as = (id: string, role: "admin" | "member", libraries: string[] = []) => ({
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": id,
  "x-isputnik-user-role": role,
  "x-isputnik-libraries": libraries.join(","),
  "x-isputnik-client-ip": "192.168.2.10"
});
const admin = as("admin", "admin", ["lib_tv", "lib_mov"]);
const mum = as("mum", "member", ["lib_tv", "lib_mov"]);

let fixture: Fixture;
let app: FastifyInstance;

const scan = async (id: string) => {
  await app.inject({ method: "POST", url: `/video/api/admin/libraries/${id}/scan`, headers: admin });
  await app.scansSettled();
};

beforeEach(async () => {
  fixture = makeFixture();
  app = await buildApp({
    gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
    scan: { settleMs: 60_000 },
    fastify: { logger: false }
  });
  for (const [id, body] of [["lib_tv", { name: "TV", kind: "shows", folder: "Shows" }], ["lib_mov", { name: "Movies", kind: "movies", folder: "Movies" }]] as const) {
    await app.inject({ method: "PUT", url: `/video/api/admin/libraries/${id}`, headers: admin, payload: body });
  }
  await app.scansSettled();
});

afterEach(async () => {
  await app.close();
  fixture.cleanup();
});

type Card = { id: string; title: string; year: number | null; genres: string[] };
const movies = async (query = "?sort=title") =>
  ((await app.inject({ method: "GET", url: `/video/api/movies${query}`, headers: mum })).json() as { items: Card[] }).items;
const movieId = async (title: string) => (await movies()).find((movie) => movie.title === title)!.id;
const save = (id: string, payload: unknown, headers = admin) => app.inject({ method: "PUT", url: `/video/api/admin/titles/${id}/edit`, headers, payload });
const state = async (id: string) => (await app.inject({ method: "GET", url: `/video/api/admin/titles/${id}/edit`, headers: admin })).json();

describe("editing a title", () => {
  it("puts the admin's details over the scan's, everywhere a title is read", async () => {
    const id = await movieId("Loose Film");
    const res = await save(id, { title: "A Better Name", year: 2001, plot: "Written by hand.", genres: ["Драма"] });
    expect(res.statusCode).toBe(200);
    expect(res.json().movie).toMatchObject({ title: "A Better Name", year: 2001, plot: "Written by hand.", genres: ["Драма"] });
    // Sorted and found by the new name.
    expect((await movies()).map((movie) => movie.title)).toEqual(["A Better Name", "Some Film"]);
    expect((await movies("?sort=title&q=Better")).map((movie) => movie.title)).toEqual(["A Better Name"]);
    const drama = (await app.inject({ method: "GET", url: `/video/api/titles?sort=title&genres=${encodeURIComponent("Драма")}`, headers: mum })).json() as { items: Card[] };
    expect(drama.items.map((item) => item.title)).toEqual(["A Better Name", "Радар"]);
    expect(await state(id)).toMatchObject({
      kind: "movies",
      title: { edited: "A Better Name", automatic: "Loose Film" },
      year: { edited: 2001, automatic: 1999 },
      genres: { edited: ["Драма"], automatic: [] }
    });
  });

  it("keeps the edits through a rescan, and the rescan's own changes as the automatic ones", async () => {
    const id = await movieId("Some Film");
    await save(id, { title: "Mine" });
    fixture.write("Movies/Some Film (2010)/movie.nfo", "<movie><title>Some Film Renamed</title><year>2011</year><genre>Comedy</genre></movie>");
    await scan("lib_mov");
    expect((await movies()).find((movie) => movie.id === id)).toMatchObject({ title: "Mine", year: 2011 });
    expect((await state(id)).title).toEqual({ edited: "Mine", automatic: "Some Film Renamed" });
  });

  it("hands a field back to the scan, and forgets a title with no edit left", async () => {
    const id = await movieId("Some Film");
    await save(id, { title: "Mine", year: 1950 });
    await save(id, { title: null });
    expect((await movies()).find((movie) => movie.id === id)).toMatchObject({ title: "Some Film", year: 1950 });
    await save(id, { year: null });
    expect((await movies()).find((movie) => movie.id === id)).toMatchObject({ title: "Some Film", year: 2010 });
    expect(await state(id)).toMatchObject({ title: { edited: null }, year: { edited: null, automatic: 2010 } });
    await scan("lib_mov");
    expect((await movies()).find((movie) => movie.id === id)).toMatchObject({ title: "Some Film", year: 2010 });
  });

  it("edits a show too, and sorts by a sort title of its own", async () => {
    const shows = ((await app.inject({ method: "GET", url: "/video/api/shows?sort=title", headers: mum })).json() as { items: Card[] }).items;
    const radar = shows.find((show) => show.title === "Радар")!;
    await save(radar.id, { sortTitle: "aaa" });
    const after = ((await app.inject({ method: "GET", url: "/video/api/shows?sort=title", headers: mum })).json() as { items: Card[] }).items;
    expect(after.map((show) => show.title)).toEqual(["Радар", "Counterpart"]);
  });

  it("puts films into a set by hand, in the order given, takes one out of its .nfo set, and keeps both through a rescan", async () => {
    // A third film whose .nfo puts it in a set of its own name.
    fixture.write("Movies/Third Film (2012)/Third Film (2012).mkv", "x".repeat(4000));
    fixture.write("Movies/Third Film (2012)/movie.nfo", "<movie><title>Third Film</title><year>2012</year><set>Old Set</set></movie>");
    await scan("lib_mov");
    const sets = async () => ((await app.inject({ method: "GET", url: "/video/api/sets", headers: mum })).json() as { items: { id: string; name: string; films: number }[] }).items;
    const setOf = async (title: string) =>
      ((await app.inject({ method: "GET", url: `/video/api/movies/${await movieId(title)}`, headers: mum })).json() as { set: { name: string; films: { title: string }[] } | null }).set;

    const loose = await movieId("Loose Film");
    const some = await movieId("Some Film");
    const third = await movieId("Third Film");
    expect((await save(some, { set: { mode: "named", name: "Our Films", order: 2 } })).statusCode).toBe(200);
    await save(loose, { set: { mode: "named", name: "our  films", order: 1 } });
    // One set, however it is spelled, its films in the order given.
    expect((await sets()).map((set) => [set.name, set.films])).toEqual([["Our Films", 2]]);
    expect((await setOf("Some Film"))!.films.map((film) => film.title)).toEqual(["Loose Film", "Some Film"]);
    expect((await state(some)).set).toEqual({ edited: { mode: "named", name: "Our Films", order: 2 }, automatic: null });

    // Out of the .nfo's set, which stays out.
    expect((await state(third)).set).toEqual({ edited: null, automatic: "Old Set" });
    await save(third, { set: { mode: "none" } });
    expect(await setOf("Third Film")).toBeNull();
    expect((await state(third)).set).toEqual({ edited: { mode: "none" }, automatic: "Old Set" });

    await scan("lib_mov");
    expect((await setOf("Some Film"))!.films.map((film) => film.title)).toEqual(["Loose Film", "Some Film"]);
    expect(await setOf("Third Film")).toBeNull();
    const names = (await app.inject({ method: "GET", url: "/video/api/admin/sets/names", headers: admin })).json();
    expect(names.sets.map((set: { name: string }) => set.name)).toContain("Our Films");

    // Automatic again: back in the .nfo's set, and out of the one made by hand.
    await save(third, { set: null });
    await save(some, { set: null });
    expect((await setOf("Third Film"))!.name).toBe("Old Set");
    expect((await sets()).map((set) => set.name)).toEqual([]);
  });

  it("is the admin's alone", async () => {
    const id = await movieId("Some Film");
    expect((await save(id, { title: "Nope" }, mum)).statusCode).toBe(403);
    expect((await save("nothing_here", { title: "Nope" })).statusCode).toBe(404);
  });
});

describe("an engine upgraded from 0.23.0", () => {
  it("takes the film's own set as the automatic one for edits saved before sets could be edited", async () => {
    const { openDatabase } = await import("../src/db.js");
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-edits-"));
    const file = path.join(dir, "video.sqlite");
    try {
      const old = openDatabase(file);
      old.prepare("INSERT INTO libraries (id, name, kind, folder) VALUES ('lib', 'Films', 'movies', 'Movies')").run();
      old.prepare("INSERT INTO movies (id, library_id, folder, file, title, sort_title, set_name, set_order) VALUES ('m1', 'lib', 'A', 'A/a.mkv', 'Mine', 'mine', 'Old Set', 3)").run();
      old.prepare("INSERT INTO title_edits (item_id, kind, title, auto_title) VALUES ('m1', 'movies', 'Mine', 'A')").run();
      // As 0.23.0 left it: no set columns.
      for (const column of ["set_name", "set_order", "no_set", "auto_set_name", "auto_set_tmdb_id", "auto_set_order"]) old.exec(`ALTER TABLE title_edits DROP COLUMN ${column}`);
      old.close();
      const db = openDatabase(file);
      expect(db.prepare("SELECT auto_set_name, auto_set_order, no_set FROM title_edits WHERE item_id = 'm1'").get()).toEqual({ auto_set_name: "Old Set", auto_set_order: 3, no_set: 0 });
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
