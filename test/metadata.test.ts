// Posters and TMDB: art beside the files first, then a (fake) TMDB once the
// admin gives a key — matched by IMDb id or by title and year, its words only
// where the .nfo left a gap — and a match fixed by hand that a rescan keeps.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";
const GOOD_KEY = "0123456789abcdef0123456789abcdef";

const as = (id: string, role: "admin" | "member", libraries: string[] = []) => ({
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": id,
  "x-isputnik-user-name": id,
  "x-isputnik-user-role": role,
  "x-isputnik-libraries": libraries.join(",")
});
const admin = as("admin", "admin", ["lib_shows", "lib_films"]);
const mum = as("mum", "member", ["lib_shows", "lib_films"]);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Just enough of TMDB for the fixture's titles; every request is counted. */
function fakeTmdb() {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    asked.push(`${url.pathname}${url.search}`);
    if (url.hostname === "image.tmdb.org") return new Response(Buffer.from(`image ${url.pathname}`), { status: 200 });
    if (url.searchParams.get("api_key") !== GOOD_KEY) return json({ status_message: "Invalid API key" }, 401);
    const path = url.pathname.replace(/^\/3/, "");
    const query = url.searchParams.get("query") ?? "";
    if (path === "/configuration") return json({ images: {} });
    if (path === "/search/movie") {
      if (query === "Some Film") return json({ results: [{ id: 101, title: "Some Film", release_date: "2010-05-01", poster_path: "/p101.jpg" }] });
      if (query === "The Right Film") return json({ results: [{ id: 404, title: "The Right Film", release_date: "1999-01-01", overview: "The one.", poster_path: "/p404.jpg" }] });
      return json({ results: [] });
    }
    if (path === "/movie/101") return json({ id: 101, title: "Some Film", overview: "A film about something.", release_date: "2010-05-01", genres: [{ name: "Drama" }], vote_average: 7.1, poster_path: "/p101.jpg", backdrop_path: "/b101.jpg" });
    if (path === "/movie/404") return json({ id: 404, title: "The Right Film", overview: "The one.", release_date: "1999-01-01", genres: [{ name: "Thriller" }], vote_average: 6, poster_path: "/p404.jpg", backdrop_path: null });
    if (path === "/search/tv") return json({ results: query.startsWith("Counterpart") ? [{ id: 202, name: "Counterpart", first_air_date: "2017-12-10" }] : [] });
    if (path === "/find/tt33022834") return json({ movie_results: [], tv_results: [{ id: 303 }] });
    if (path === "/tv/202") return json({ id: 202, name: "Counterpart", overview: "A spy story.", first_air_date: "2017-12-10", genres: [{ name: "Sci-Fi" }], poster_path: "/p202.jpg", backdrop_path: "/b202.jpg" });
    if (path === "/tv/202/season/2") return json({ episodes: [
      { episode_number: 1, name: "Inside Out", overview: "Howard wakes.", still_path: "/s1.jpg" },
      { episode_number: 2, name: "Outside In", overview: "Emily returns.", still_path: "/s2.jpg" }
    ] });
    if (path === "/tv/303") return json({ id: 303, name: "Radar", overview: "English words TMDB has.", first_air_date: "2026-04-20", poster_path: "/p303.jpg" });
    if (path === "/tv/303/season/1") return json({ episodes: [{ episode_number: 1, name: "Episode 1", still_path: "/r1.jpg" }] });
    return json({ status_message: "Not found" }, 404);
  }) as typeof fetch;
  return { fetchImpl, asked };
}

let fixture: Fixture;
let app: FastifyInstance;
let tmdb: ReturnType<typeof fakeTmdb>;

beforeEach(async () => {
  fixture = makeFixture();
  // A poster beside the film: it wins over TMDB's.
  fixture.write("Movies/Some Film (2010)/poster.jpg", "local poster");
  tmdb = fakeTmdb();
  app = await buildApp({
    gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
    scan: { settleMs: 60_000 }, fetch: tmdb.fetchImpl, tools: null, fastify: { logger: false }
  });
  await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_shows", headers: admin, payload: { name: "Shows", kind: "shows", folder: "Shows" } });
  await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_films", headers: admin, payload: { name: "Films", kind: "movies", folder: "Movies" } });
  await app.scansSettled();
});

afterEach(async () => {
  await app.close();
  fixture.cleanup();
});

const movies = async () => (await app.inject({ method: "GET", url: "/video/api/movies", headers: mum })).json().items as Record<string, unknown>[];
const shows = async () => (await app.inject({ method: "GET", url: "/video/api/shows", headers: mum })).json().items as Record<string, unknown>[];
const byTitle = <T extends Record<string, unknown>>(items: T[], title: string) => items.find((item) => item.title === title)!;
const setKey = (tmdbKey: string | null) => app.inject({ method: "PUT", url: "/video/api/admin/metadata", headers: admin, payload: { tmdbKey } });

describe("without a TMDB key", () => {
  it("shows the art beside the files and asks TMDB nothing", async () => {
    const list = await movies();
    expect(byTitle(list, "Some Film").poster).toMatch(/^\/video\/api\/art\/[\w-]+\/poster\?v=[0-9a-f]{8}$/);
    expect(byTitle(list, "Loose Film").poster).toBeNull();
    const poster = await app.inject({ method: "GET", url: byTitle(list, "Some Film").poster as string, headers: mum });
    expect(poster.statusCode).toBe(200);
    expect(poster.headers["content-type"]).toBe("image/jpeg");
    expect(poster.body).toBe("local poster");
    expect(tmdb.asked).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/video/api/admin/metadata", headers: admin })).json()).toEqual({ hasKey: false, keyHint: null });
  });

  it("keeps a picture from anyone who can't see the title", async () => {
    const url = byTitle(await movies(), "Some Film").poster as string;
    expect((await app.inject({ method: "GET", url, headers: as("kid", "member", ["lib_shows"]) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: url.replace("poster", "nonsense"), headers: mum })).statusCode).toBe(404);
  });
});

describe("with a TMDB key", () => {
  it("refuses a key TMDB refuses, keeps a good one and never hands it back", async () => {
    const refused = await setKey("ffffffffffffffffffffffffffffffff");
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("video.tmdb_refused");
    const saved = await setKey(GOOD_KEY);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ hasKey: true, keyHint: "…cdef" });
    expect(JSON.stringify((await app.inject({ method: "GET", url: "/video/api/admin/metadata", headers: admin })).json())).not.toContain(GOOD_KEY);
    expect((await app.inject({ method: "PUT", url: "/video/api/admin/metadata", headers: mum, payload: { tmdbKey: GOOD_KEY } })).statusCode).toBe(403);
  });

  it("fills what the .nfo left empty, keeps the poster beside the film, and fetches the rest", async () => {
    await setKey(GOOD_KEY);
    await app.scansSettled();
    const some = byTitle(await movies(), "Some Film");
    const detail = (await app.inject({ method: "GET", url: `/video/api/movies/${some.id}`, headers: mum })).json();
    // The .nfo had no plot but a genre: TMDB gives the plot, the genre stays.
    expect(detail).toMatchObject({ plot: "A film about something.", genres: ["Comedy"], tmdbId: "101", rating: 7.1, tmdbMatch: { state: "matched", locked: false } });
    expect((await app.inject({ method: "GET", url: detail.poster, headers: mum })).body).toBe("local poster");
    const backdrop = await app.inject({ method: "GET", url: detail.backdrop, headers: mum });
    expect(backdrop.body).toBe("image /t/p/w1280/b101.jpg");
    // TMDB's poster was never fetched: the one beside the film wins.
    expect(tmdb.asked.some((request) => request.includes("p101"))).toBe(false);

    expect(byTitle(await movies(), "Loose Film")).toMatchObject({ poster: null });
    const loose = (await app.inject({ method: "GET", url: `/video/api/movies/${byTitle(await movies(), "Loose Film").id}`, headers: mum })).json();
    expect(loose.tmdbMatch).toMatchObject({ state: "unmatched", id: null });
  });

  it("matches a show by its IMDb id, and names a folder show's episodes by TMDB, with stills", async () => {
    await setKey(GOOD_KEY);
    await app.scansSettled();
    const list = await shows();
    const radar = (await app.inject({ method: "GET", url: `/video/api/shows/${byTitle(list, "Радар").id}`, headers: mum })).json();
    // The .nfo's Russian words stay; the .nfo's episode titles too.
    expect(radar).toMatchObject({ title: "Радар", plot: "1988 год.", tmdbId: "303" });
    expect(radar.seasons[0].episodes[0].title).toBe("Серия 1");
    expect(tmdb.asked.some((request) => request.startsWith("/3/find/tt33022834"))).toBe(true);

    const counterpart = (await app.inject({ method: "GET", url: `/video/api/shows/${byTitle(list, "Counterpart").id}`, headers: mum })).json();
    expect(counterpart).toMatchObject({ plot: "A spy story.", genres: ["Sci-Fi"] });
    const episodes = counterpart.seasons[0].episodes;
    expect(episodes.map((episode: { title: string; plot: string }) => [episode.title, episode.plot])).toEqual([["Inside Out", "Howard wakes."], ["Outside In", "Emily returns."]]);
    expect((await app.inject({ method: "GET", url: episodes[1].still, headers: mum })).body).toBe("image /t/p/w300/s2.jpg");
    expect((await app.inject({ method: "GET", url: byTitle(await shows(), "Counterpart").poster as string, headers: mum })).body).toBe("image /t/p/w500/p202.jpg");
  });

  it("asks TMDB again only when a title is due", async () => {
    await setKey(GOOD_KEY);
    await app.scansSettled();
    const before = tmdb.asked.length;
    await app.inject({ method: "POST", url: "/video/api/admin/libraries/lib_films/scan", headers: admin });
    await app.scansSettled();
    expect(tmdb.asked.length).toBe(before);
    // A refresh asked for: everything again (images already here are kept).
    await app.inject({ method: "POST", url: "/video/api/admin/libraries/lib_films/metadata", headers: admin });
    await app.scansSettled();
    expect(tmdb.asked.slice(before).filter((request) => request.startsWith("/3/movie/"))).toHaveLength(1);
    expect(tmdb.asked.slice(before).some((request) => request.startsWith("/t/p/"))).toBe(false);
  });

  it("lets an admin fix a match by hand, keeps it through a rescan, and give it back", async () => {
    await setKey(GOOD_KEY);
    await app.scansSettled();
    const search = await app.inject({ method: "GET", url: "/video/api/admin/metadata/search?kind=movie&q=The%20Right%20Film", headers: admin });
    expect(search.json().results).toEqual([
      { tmdbId: "404", title: "The Right Film", originalTitle: null, year: 1999, overview: "The one.", poster: "/video/api/admin/metadata/image/p404.jpg" }
    ]);
    expect((await app.inject({ method: "GET", url: "/video/api/admin/metadata/image/p404.jpg", headers: admin })).body).toBe("image /t/p/w185/p404.jpg");
    expect((await app.inject({ method: "GET", url: "/video/api/admin/metadata/search?kind=movie&q=x", headers: mum })).statusCode).toBe(403);

    const loose = byTitle(await movies(), "Loose Film");
    const fixed = await app.inject({ method: "PUT", url: `/video/api/admin/metadata/items/${loose.id}`, headers: admin, payload: { tmdbId: "404" } });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().movie).toMatchObject({ title: "Loose Film", plot: "The one.", tmdbId: "404", tmdbMatch: { state: "matched", locked: true } });

    await app.inject({ method: "POST", url: "/video/api/admin/libraries/lib_films/metadata", headers: admin });
    await app.scansSettled();
    expect((await app.inject({ method: "GET", url: `/video/api/movies/${loose.id}`, headers: mum })).json()).toMatchObject({ tmdbId: "404", tmdbMatch: { locked: true } });

    const back = await app.inject({ method: "PUT", url: `/video/api/admin/metadata/items/${loose.id}`, headers: admin, payload: { tmdbId: null } });
    expect(back.json().movie.tmdbMatch).toMatchObject({ state: "unmatched", locked: false });
    const events = (await app.inject({ method: "GET", url: "/video/api/admin/events?event=metadata.matched", headers: admin })).json();
    expect(events.events.map((event: { detail: string }) => event.detail)).toEqual(["Loose Film matched automatically again", "Loose Film matched by hand to TMDB 404"]);
  });
});
