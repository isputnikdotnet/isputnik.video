// Films and shows in one list, for home's one video page: paged together in any
// sort, narrowed by kind, libraries and genres, and only ever from what a person
// may see.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, upgradeDatabase } from "../src/db.js";
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
const mum = as("mum", "member", ["lib_tv", "lib_mov", "lib_kids"]);

let fixture: Fixture;
let app: FastifyInstance;

beforeEach(async () => {
  fixture = makeFixture();
  app = await buildApp({
    gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
    scan: { settleMs: 60_000 },
    fastify: { logger: false }
  });
  await putLibrary("lib_tv", { name: "TV Shows", kind: "shows", folder: "Shows" });
  await putLibrary("lib_mov", { name: "Movies", kind: "movies", folder: "Movies" });
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

type Title = { kind: "shows" | "movies"; id: string; title: string };
const titles = async (query: string, headers = mum) => {
  const res = await app.inject({ method: "GET", url: `/video/api/titles${query}`, headers });
  expect(res.statusCode).toBe(200);
  return res.json() as { items: Title[]; total: number };
};
const names = (page: { items: Title[] }) => page.items.map((item) => `${item.kind}:${item.title}`);

describe("films and shows in one list", () => {
  it("lists both, each saying which it is, in one order across them", async () => {
    const page = await titles("?sort=title");
    expect(page.total).toBe(4);
    expect(names(page)).toEqual(["shows:Counterpart", "movies:Loose Film", "movies:Some Film", "shows:Радар"]);
    const film = page.items.find((item) => item.title === "Some Film");
    expect(film).toMatchObject({ kind: "movies", libraryId: "lib_mov", year: 2010, runtimeMinutes: 112, genres: ["Comedy"] });
    expect(page.items.find((item) => item.title === "Радар")).toMatchObject({ kind: "shows", seasons: 1, episodes: 3 });
  });

  it("pages the two together, so the second page carries on from the first", async () => {
    const first = await titles("?sort=title&pageSize=3");
    const second = await titles("?sort=title&pageSize=3&page=2");
    expect(first.total).toBe(4);
    expect([...names(first), ...names(second)]).toEqual(names(await titles("?sort=title")));
  });

  it("narrows to one kind", async () => {
    expect(names(await titles("?kind=movies&sort=title"))).toEqual(["movies:Loose Film", "movies:Some Film"]);
    expect(names(await titles("?kind=shows&sort=title"))).toEqual(["shows:Counterpart", "shows:Радар"]);
  });

  it("puts what came last first, whichever kind it is", async () => {
    fixture.write("Kids/Paper Rockets/Paper Rockets S01E01.mkv");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await putLibrary("lib_kids", { name: "Kids", kind: "shows", folder: "Kids" });
    const page = await titles("?sort=added");
    expect(names(page)[0]).toBe("shows:Paper Rockets");
    expect(page.total).toBe(5);
  });

  it("narrows to any of some libraries, and any of some genres", async () => {
    expect(names(await titles("?libraries=lib_mov&sort=title"))).toEqual(["movies:Loose Film", "movies:Some Film"]);
    expect(names(await titles("?genres=Comedy,Драма&sort=title"))).toEqual(["movies:Some Film", "shows:Радар"]);
    expect(names(await titles("?genres=Comedy&libraries=lib_tv"))).toEqual([]);
    expect(names(await titles("?q=film&sort=title"))).toEqual(["movies:Loose Film", "movies:Some Film"]);
  });

  it("shows nothing from a library home did not let a person into, even when asked for it", async () => {
    const onlyFilms = as("kid", "member", ["lib_mov"]);
    expect(names(await titles("?sort=title", onlyFilms))).toEqual(["movies:Loose Film", "movies:Some Film"]);
    expect((await titles("?libraries=lib_tv", onlyFilms)).total).toBe(0);
    expect((await titles("", as("guest", "member"))).total).toBe(0);
  });

  it("refuses a library id that is not one", async () => {
    const res = await app.inject({ method: "GET", url: "/video/api/titles?libraries=../etc", headers: mum });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("the genres to narrow by", () => {
  it("are every genre a person can find, in one kind or both", async () => {
    const genres = async (query: string, headers = mum) =>
      ((await app.inject({ method: "GET", url: `/video/api/genres${query}`, headers })).json() as { genres: string[] }).genres;
    expect(await genres("")).toEqual(["Comedy", "Драма", "Фантастика"]);
    expect(await genres("?kind=movies")).toEqual(["Comedy"]);
    expect(await genres("", as("kid", "member", ["lib_mov"]))).toEqual(["Comedy"]);
  });
});

describe("titles from before added_at", () => {
  it("take their files' age, so an old library doesn't all read as just added", () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO libraries (id, name, kind, folder) VALUES ('m', 'M', 'movies', 'M'), ('s', 'S', 'shows', 'S')").run();
    db.prepare("INSERT INTO movies (id, library_id, folder, file, title, sort_title, modified_at) VALUES ('f1', 'm', 'F', 'F/f.mkv', 'F', 'f', '2015-01-02T00:00:00.000Z')").run();
    db.prepare("INSERT INTO shows (id, library_id, folder, title, sort_title) VALUES ('s1', 's', 'S', 'S', 's')").run();
    db.prepare(`INSERT INTO episodes (id, show_id, season, episode, file, modified_at) VALUES
      ('e1', 's1', 1, 1, 'a.mkv', '2019-05-01T00:00:00.000Z'), ('e2', 's1', 1, 2, 'b.mkv', '2018-03-01T00:00:00.000Z')`).run();
    upgradeDatabase(db);
    expect(db.prepare("SELECT added_at FROM movies WHERE id = 'f1'").get()).toEqual({ added_at: "2015-01-02T00:00:00.000Z" });
    expect(db.prepare("SELECT added_at FROM shows WHERE id = 's1'").get()).toEqual({ added_at: "2018-03-01T00:00:00.000Z" });
    db.close();
  });
});
