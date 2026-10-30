// Film sets: found in the .nfo files (both of Kodi's shapes) and in TMDB's
// collections, merged when they name the same set, ordered by release, and only
// ever shown as far as the person may see the films.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

const SECRET = "video-secret-video-secret-0123456789";
const GOOD_KEY = "0123456789abcdef0123456789abcdef";

const as = (id: string, role: "admin" | "member", libraries: string[] = []) => ({
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": id,
  "x-isputnik-user-name": id,
  "x-isputnik-user-role": role,
  "x-isputnik-libraries": libraries.join(",")
});
const admin = as("admin", "admin", ["lib_films", "lib_kids"]);
const mum = as("mum", "member", ["lib_films", "lib_kids"]);
const kid = as("kid", "member", ["lib_kids"]);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeTmdb() {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    asked.push(url.pathname);
    if (url.hostname === "image.tmdb.org") return new Response(Buffer.from(`image ${url.pathname}`), { status: 200 });
    const route = url.pathname.replace(/^\/3/, "");
    const query = url.searchParams.get("query") ?? "";
    if (route === "/configuration") return json({ images: {} });
    if (route === "/search/movie") {
      if (query === "The Matrix") return json({ results: [{ id: 603, title: "The Matrix", release_date: "1999-03-30" }] });
      if (query === "The Matrix Reloaded") return json({ results: [{ id: 604, title: "The Matrix Reloaded", release_date: "2003-05-15" }] });
      return json({ results: [] });
    }
    const collection = { id: 2344, name: "The Matrix Collection" };
    if (route === "/movie/603") return json({ id: 603, title: "The Matrix", release_date: "1999-03-30", belongs_to_collection: collection });
    if (route === "/movie/604") return json({ id: 604, title: "The Matrix Reloaded", release_date: "2003-05-15", belongs_to_collection: collection });
    if (route === "/collection/2344") return json({
      id: 2344, name: "The Matrix Collection", overview: "Neo and friends.", poster_path: "/c2344.jpg", backdrop_path: "/cb2344.jpg",
      parts: [{ id: 604, release_date: "2003-05-15" }, { id: 603, release_date: "1999-03-30" }, { id: 605, release_date: "2003-11-05" }]
    });
    return json({ status_message: "Not found" }, 404);
  }) as typeof fetch;
  return { fetchImpl, asked };
}

let root: string;
let app: FastifyInstance;
let tmdb: ReturnType<typeof fakeTmdb>;

const write = (relative: string, content = "video") => {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-sets-"));
  // A family's own set, spelled two ways, across two libraries.
  write("Films/Dacha 2019/Dacha 2019.mkv");
  write("Films/Dacha 2019/movie.nfo", "<movie><title>Dacha 2019</title><year>2019</year><set>Summer at the dacha</set></movie>");
  write("Kids/Dacha 2021/Dacha 2021.mkv");
  write("Kids/Dacha 2021/movie.nfo", "<movie><title>Dacha 2021</title><year>2021</year><set><name>summer at the  Dacha</name><overview>Every summer.</overview></set></movie>");
  write("Films/Dacha 2020/Dacha 2020.mkv");
  write("Films/Dacha 2020/movie.nfo", "<movie><title>Dacha 2020</title><year>2020</year><set>Summer at the dacha</set></movie>");
  // A set of one.
  write("Films/Alone (2001)/Alone (2001).mkv");
  write("Films/Alone (2001)/movie.nfo", "<movie><title>Alone</title><year>2001</year><set>Lonely set</set></movie>");
  // TMDB's collection, and an .nfo that names it without its id.
  write("Films/The Matrix (1999)/The Matrix (1999).mkv");
  write("Films/The Matrix Reloaded (2003)/The Matrix Reloaded (2003).mkv");
  write("Films/Animatrix (2003)/Animatrix (2003).mkv");
  write("Films/Animatrix (2003)/movie.nfo", "<movie><title>Animatrix</title><year>2003</year><set>The Matrix Collection</set></movie>");
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const touch = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) touch(full);
      else fs.utimesSync(full, hourAgo, hourAgo);
    }
  };
  touch(root);
  tmdb = fakeTmdb();
  app = await buildApp({
    gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: root, version: "0.0.0-test", stage: null,
    scan: { settleMs: 60_000 }, fetch: tmdb.fetchImpl, tools: null, fastify: { logger: false }
  });
  await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_films", headers: admin, payload: { name: "Films", kind: "movies", folder: "Films" } });
  await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_kids", headers: admin, payload: { name: "Kids", kind: "movies", folder: "Kids" } });
  await app.scansSettled();
});

afterEach(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const get = async (url: string, headers = mum) => (await app.inject({ method: "GET", url, headers })).json();
const sets = async (headers = mum, extra = "") => (await get(`/video/api/sets${extra}`, headers)).items as { id: string; name: string; films: number; firstYear: number; lastYear: number; poster: string | null }[];
const movieId = async (title: string) => ((await get("/video/api/movies?pageSize=200")).items as { id: string; title: string }[]).find((movie) => movie.title === title)!.id;

describe("sets from the .nfo files", () => {
  it("groups films that name one set, however it is spelled, in order", async () => {
    const list = await sets();
    expect(list.map((set) => [set.name, set.films])).toEqual([["Summer at the dacha", 3]]);
    expect([list[0].firstYear, list[0].lastYear]).toEqual([2019, 2021]);
    const set = await get(`/video/api/sets/${list[0].id}`);
    expect(set.films.map((film: { title: string }) => film.title)).toEqual(["Dacha 2019", "Dacha 2020", "Dacha 2021"]);
    expect(set.overview).toBe("Every summer.");
    expect(set.next.title).toBe("Dacha 2019");
  });

  it("leaves a set of one out of the list, and still names it on the film", async () => {
    expect((await sets()).some((set) => set.name === "Lonely set")).toBe(false);
    const alone = await get(`/video/api/movies/${await movieId("Alone")}`);
    expect(alone.set.name).toBe("Lonely set");
    expect(alone.set.films).toHaveLength(1);
  });

  it("shows each person only the films of a set they may see", async () => {
    expect(await sets(kid)).toEqual([]);
    const id = (await sets())[0].id;
    const forKid = await get(`/video/api/sets/${id}`, kid);
    expect(forKid.films.map((film: { title: string }) => film.title)).toEqual(["Dacha 2021"]);
    expect((await app.inject({ method: "GET", url: `/video/api/sets/${id}`, headers: as("guest", "member", []) })).statusCode).toBe(404);
    // The library facet narrows the films too.
    expect(await sets(mum, "?library=lib_kids")).toEqual([]);
  });

  it("goes on to the next film of the set after one ends", async () => {
    const played = await get(`/video/api/play/${await movieId("Dacha 2019")}`);
    expect(played.next).toMatchObject({ title: "Dacha 2020", season: null, episode: null });
    expect((await get(`/video/api/play/${await movieId("Dacha 2021")}`)).next).toBeNull();
  });

  it("plays on from the first film not yet watched", async () => {
    const first = await movieId("Dacha 2019");
    await app.inject({ method: "PUT", url: `/video/api/progress/${first}`, headers: mum, payload: { position: 100, duration: 100 } });
    const set = await get(`/video/api/sets/${(await sets())[0].id}`);
    expect(set.next.title).toBe("Dacha 2020");
  });
});

describe("sets from TMDB", () => {
  beforeEach(async () => {
    await app.inject({ method: "PUT", url: "/video/api/admin/metadata", headers: admin, payload: { tmdbKey: GOOD_KEY } });
    await app.scansSettled();
  });

  it("puts matched films into their collection, with its words, art and release order", async () => {
    const matrix = (await sets()).find((set) => set.name === "The Matrix Collection")!;
    expect(matrix.films).toBe(3);
    expect(matrix.poster).toMatch(new RegExp(`^/video/api/art/${matrix.id}/poster\\?v=`));
    const set = await get(`/video/api/sets/${matrix.id}`);
    expect(set.overview).toBe("Neo and friends.");
    // Release dates first; the .nfo film TMDB didn't match by its year after them.
    expect(set.films.map((film: { title: string }) => film.title)).toEqual(["The Matrix", "The Matrix Reloaded", "Animatrix"]);
    const poster = await app.inject({ method: "GET", url: matrix.poster!, headers: mum });
    expect(poster.statusCode).toBe(200);
    expect(poster.body).toBe("image /t/p/w500/c2344.jpg");
    expect((await app.inject({ method: "GET", url: matrix.poster!, headers: kid })).statusCode).toBe(404);
    expect(tmdb.asked.filter((asked) => asked.endsWith("/collection/2344"))).toHaveLength(1);
  });

  it("asks TMDB about a collection again only when it is due", async () => {
    await app.inject({ method: "POST", url: "/video/api/admin/libraries/lib_films/scan", headers: admin });
    await app.scansSettled();
    expect(tmdb.asked.filter((asked) => asked.endsWith("/collection/2344"))).toHaveLength(1);
    expect((await sets()).find((set) => set.name === "The Matrix Collection")!.films).toBe(3);
  });
});

describe("an older catalog file", () => {
  it("gets the new columns, and its matched films are asked about their set once", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { openDatabase } = await import("../src/db.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-old-"));
    const file = path.join(dir, "video.sqlite");
    const old = new Database(file);
    // The schema as it was before sets: without the columns they added.
    const schema = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "schema.sql"), "utf8");
    old.exec(schema.split(/\r?\n/).filter((line) => !/^\s+(set_name|set_overview|set_tmdb_id|set_checked)\s/.test(line)).join("\n"));
    old.prepare("INSERT INTO metadata (item_id, kind, tmdb_state) VALUES ('m1', 'movie', 'matched')").run();
    old.close();
    const db = openDatabase(file);
    expect(db.prepare("SELECT set_checked FROM metadata WHERE item_id = 'm1'").get()).toEqual({ set_checked: 0 });
    expect((db.prepare("SELECT name FROM pragma_table_info('movies')").all() as { name: string }[]).map((row) => row.name)).toContain("set_name");
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
