// Cast and crew (credits.ts): from a title's .nfo first, TMDB's credits where it
// has none; one person across the library; their page, search and picture only
// through titles a person may see.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";
const GOOD_KEY = "0123456789abcdef0123456789abcdef";
const as = (id: string, role: "admin" | "member", libraries: string[] = []) => ({
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": id,
  "x-isputnik-user-role": role,
  "x-isputnik-libraries": libraries.join(",")
});
const admin = as("admin", "admin", ["lib_tv", "lib_mov"]);
const mum = as("mum", "member", ["lib_tv", "lib_mov"]);
const kid = as("kid", "member", ["lib_tv"]);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** TMDB for one film and one show, with their credits; every request counted. */
function fakeTmdb() {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    asked.push(url.pathname);
    if (url.hostname === "image.tmdb.org") return new Response(Buffer.from(`photo ${url.pathname}`), { status: 200 });
    const path = url.pathname.replace(/^\/3/, "");
    const query = url.searchParams.get("query") ?? "";
    if (path === "/configuration") return json({ images: {} });
    if (path === "/search/movie") return json({ results: query === "Loose Film" ? [{ id: 77, title: "Loose Film", release_date: "1999-01-01" }] : [] });
    if (path === "/search/tv") return json({ results: query.startsWith("Counterpart") ? [{ id: 202, name: "Counterpart", first_air_date: "2017-12-10" }] : [] });
    if (path === "/movie/77") {
      expect(url.searchParams.get("append_to_response")).toBe("images,credits");
      return json({
        id: 77, title: "Loose Film", release_date: "1999-01-01", genres: [],
        credits: {
          cast: [
            { id: 9, name: "Second Billed", character: "The Friend", order: 1, profile_path: "/p9.jpg" },
            { id: 8, name: "Михаил Боярский", character: "Д'Артаньян", order: 0, profile_path: "/p8.jpg" }
          ],
          crew: [
            { id: 5, name: "Георгий Юнгвальд-Хилькевич", job: "Director" },
            { id: 6, name: "A Writer", job: "Screenplay" },
            { id: 7, name: "Someone Else", job: "Gaffer" }
          ]
        }
      });
    }
    if (path === "/tv/202") {
      return json({
        id: 202, name: "Counterpart", first_air_date: "2017-12-10", genres: [],
        created_by: [{ id: 30, name: "Justin Marks" }],
        aggregate_credits: { cast: [{ id: 31, name: "J. K. Simmons", order: 0, profile_path: "/p31.jpg", roles: [{ character: "Howard Silk", episode_count: 20 }] }], crew: [] }
      });
    }
    if (path === "/tv/202/season/2") return json({ episodes: [] });
    return json({ status_message: "Not found" }, 404);
  }) as typeof fetch;
  return { fetchImpl, asked };
}

let fixture: Fixture;
let app: FastifyInstance;
let tmdb: ReturnType<typeof fakeTmdb>;

beforeEach(async () => {
  fixture = makeFixture();
  // Some Film's .nfo names its cast; Боярский without an id, so he is linked to TMDB's by name.
  fixture.write("Movies/Some Film (2010)/movie.nfo", `<movie><title>Some Film</title><year>2010</year>
    <actor><name>Second Actor</name><role>Two</role><order>2</order></actor>
    <actor><name>Михаил Боярский</name><role>Сам</role><order>1</order></actor>
    <director>Nfo Director</director></movie>`);
  tmdb = fakeTmdb();
  app = await buildApp({
    gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
    scan: { settleMs: 60_000 }, fetch: tmdb.fetchImpl, tools: null, fastify: { logger: false }
  });
  for (const [id, body] of [["lib_tv", { name: "TV", kind: "shows", folder: "Shows" }], ["lib_mov", { name: "Movies", kind: "movies", folder: "Movies" }]] as const) {
    await app.inject({ method: "PUT", url: `/video/api/admin/libraries/${id}`, headers: admin, payload: body });
  }
  await app.scansSettled();
  await app.inject({ method: "PUT", url: "/video/api/admin/metadata", headers: admin, payload: { tmdbKey: GOOD_KEY } });
  await app.scansSettled();
});

afterEach(async () => {
  await app.close();
  fixture.cleanup();
});

const get = async (url: string, headers = mum) => app.inject({ method: "GET", url: `/video/api${url}`, headers });
const movieId = async (title: string) => ((await get("/movies?sort=title")).json().items as { id: string; title: string }[]).find((item) => item.title === title)!.id;
type Credit = { id: string; name: string; role: string | null; photo: string | null };

describe("cast and crew", () => {
  it("takes a film's cast and crew from its .nfo, in its order", async () => {
    const film = (await get(`/movies/${await movieId("Some Film")}`)).json() as { cast: Credit[]; crew: Credit[] };
    expect(film.cast.map((credit) => [credit.name, credit.role])).toEqual([["Михаил Боярский", "Сам"], ["Second Actor", "Two"]]);
    expect(film.crew.map((credit) => [credit.name, credit.role])).toEqual([["Nfo Director", "director"]]);
  });

  it("takes TMDB's where the .nfo names none: the billed cast in order, and the crew a family looks for", async () => {
    const film = (await get(`/movies/${await movieId("Loose Film")}`)).json() as { cast: Credit[]; crew: Credit[] };
    expect(film.cast.map((credit) => [credit.id, credit.name, credit.role])).toEqual([["t8", "Михаил Боярский", "Д'Артаньян"], ["t9", "Second Billed", "The Friend"]]);
    expect(film.crew.map((credit) => [credit.name, credit.role])).toEqual([["Георгий Юнгвальд-Хилькевич", "director"], ["A Writer", "writer"]]);
    const shows = (await get("/shows?sort=title")).json().items as { id: string; title: string }[];
    const show = (await get(`/shows/${shows.find((item) => item.title === "Counterpart")!.id}`)).json() as { cast: Credit[]; crew: Credit[] };
    expect(show.cast.map((credit) => [credit.name, credit.role])).toEqual([["J. K. Simmons", "Howard Silk"]]);
    expect(show.crew.map((credit) => [credit.name, credit.role])).toEqual([["Justin Marks", "creator"]]);
  });

  it("is one person across the library: an .nfo name without an id is TMDB's person of that name", async () => {
    const person = (await get("/people/t8")).json() as { name: string; titles: { title: string; characters: string[]; jobs: string[] }[] };
    expect(person.name).toBe("Михаил Боярский");
    expect(person.titles.map((title) => [title.title, title.characters])).toEqual([["Some Film", ["Сам"]], ["Loose Film", ["Д'Артаньян"]]]);
    // Found by part of the name, any case, ё or е.
    expect(((await get("/people?q=%D0%B1%D0%BE%D1%8F%D1%80%D1%81%D0%BA")).json().people as { id: string; titles: number }[])[0]).toMatchObject({ id: "t8", titles: 2 });
  });

  it("shows a person only through titles this person may see", async () => {
    expect((await get("/people/t8", kid)).statusCode).toBe(404);
    expect((await get("/people?q=Simmons", kid)).json().people.map((person: { name: string }) => person.name)).toEqual(["J. K. Simmons"]);
    expect((await get("/people?q=Боярский", kid)).json().people).toEqual([]);
    expect((await get("/people/t8/photo", kid)).statusCode).toBe(404);
  });

  it("fetches a person's picture the first time it is looked at, then keeps it", async () => {
    const film = (await get(`/movies/${await movieId("Loose Film")}`)).json() as { cast: Credit[] };
    const photo = film.cast[0].photo!;
    expect(photo).toMatch(/^\/video\/api\/people\/t8\/photo\?v=[0-9a-f]{8}$/);
    const first = await app.inject({ method: "GET", url: photo, headers: mum });
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe("photo /t/p/w185/p8.jpg");
    const fetches = tmdb.asked.filter((asked) => asked.endsWith("/p8.jpg")).length;
    expect((await app.inject({ method: "GET", url: photo, headers: mum })).body).toBe("photo /t/p/w185/p8.jpg");
    expect(tmdb.asked.filter((asked) => asked.endsWith("/p8.jpg")).length).toBe(fetches);
  });

  it("lets go of people whose titles are gone", async () => {
    fixture.remove("Movies/Some Film (2010)");
    fixture.remove("Movies/Loose Film (1999).mp4");
    await app.inject({ method: "POST", url: "/video/api/admin/libraries/lib_mov/scan", headers: admin });
    await app.scansSettled();
    expect((await get("/people/t8")).statusCode).toBe(404);
    expect((await get("/people?q=Second")).json().people).toEqual([]);
  });
});
