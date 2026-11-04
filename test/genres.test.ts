// The admin's genres: raw words from the .nfo files and TMDB mapped onto a list
// of their own — on cards, in the filters, in the Genre facet and in Stremio.
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

beforeEach(async () => {
  fixture = makeFixture();
  // A second film whose .nfo says the same genre another way, and one TMDB-ish word.
  fixture.write("Movies/Other Film (2012)/Other Film (2012).mkv", "x".repeat(4000));
  fixture.write("Movies/Other Film (2012)/movie.nfo", "<movie><title>Other Film</title><year>2012</year><genre>comedy</genre><genre>TV Movie</genre><genre>Sci-Fi &amp; Fantasy</genre></movie>");
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

type Overview = { genres: { id: string; name: string; keywords: string[]; titles: number }[]; words: { value: string; titles: number; state: string; genres: string[] }[] };
const send = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, headers = admin) => {
  const res = await app.inject({ method, url: `/video/api/admin/genres${url}`, headers, ...(payload ? { payload } : {}) });
  return res;
};
const overview = async () => (await send("GET", "")).json() as Overview;
const facet = async () => ((await app.inject({ method: "GET", url: "/video/api/genres", headers: mum })).json() as { genres: string[] }).genres;
const filmGenres = async () => {
  const page = (await app.inject({ method: "GET", url: "/video/api/movies?sort=title", headers: mum })).json() as { items: { title: string; genres: string[] }[] };
  return Object.fromEntries(page.items.map((item) => [item.title, item.genres]));
};
const titlesOf = async (genre: string) =>
  ((await app.inject({ method: "GET", url: `/video/api/titles?sort=title&genres=${encodeURIComponent(genre)}`, headers: mum })).json() as { items: { title: string }[] }).items.map((item) => item.title);

describe("genres", () => {
  it("shows every word as it came while the list is empty, each listed as unsorted", async () => {
    expect(await filmGenres()).toMatchObject({ "Other Film": ["comedy", "TV Movie", "Sci-Fi & Fantasy"], "Some Film": ["Comedy"] });
    const { genres, words } = await overview();
    expect(genres).toEqual([]);
    // "Comedy" and "comedy" are one word, on two films.
    expect(words.find((word) => word.value === "Comedy")).toMatchObject({ titles: 2, state: "unsorted" });
  });

  it("maps keywords onto a genre, hides words, and splits a word into two", async () => {
    const created = (await send("POST", "", { name: "Комедия" })).json() as Overview;
    const comedy = created.genres.find((genre) => genre.name === "Комедия")!;
    expect((await send("POST", `/${comedy.id}/keywords`, { word: "Comedy" })).statusCode).toBe(200);
    expect((await send("POST", "/hidden", { word: "tv movie" })).statusCode).toBe(200);
    const sf = (await send("POST", "", { name: "Фантастика" })).json() as Overview;
    const fantasy = (await send("POST", "", { name: "Фэнтези" })).json() as Overview;
    for (const genre of [sf.genres.find((g) => g.name === "Фантастика")!, fantasy.genres.find((g) => g.name === "Фэнтези")!]) {
      await send("POST", `/${genre.id}/keywords`, { word: "Sci-Fi & Fantasy" });
    }
    expect(await filmGenres()).toMatchObject({ "Other Film": ["Комедия", "Фантастика", "Фэнтези"], "Some Film": ["Комедия"] });
    // The facet says the same; the show's own «Фантастика» is now the genre.
    expect(await facet()).toEqual(["Драма", "Комедия", "Фантастика", "Фэнтези"]);
    // A filter by the old word still finds them: saved rows keep working.
    expect(await titlesOf("Comedy")).toEqual(["Other Film", "Some Film"]);
    const { genres, words } = await overview();
    expect(genres.find((genre) => genre.name === "Комедия")).toMatchObject({ keywords: ["Comedy"], titles: 2 });
    expect(words.find((word) => word.value === "TV Movie")).toMatchObject({ state: "hidden", genres: [] });
  });

  it("keeps the old name as a keyword on rename, and refuses a name that is taken", async () => {
    const drama = ((await send("POST", "", { name: "Драма" })).json() as Overview).genres[0];
    await send("PATCH", `/${drama.id}`, { name: "Драмы" });
    expect(await titlesOf("Драма")).toEqual(["Радар"]);
    expect((await overview()).genres[0]).toMatchObject({ name: "Драмы", keywords: ["Драма"], titles: 1 });
    await send("POST", "", { name: "Comedy" });
    const taken = await send("PATCH", `/${drama.id}`, { name: "comedy" });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toContain("Comedy");
  });

  it("merges one genre into another, and deleting one hides its words", async () => {
    const a = ((await send("POST", "", { name: "Comedy" })).json() as Overview).genres[0];
    const b = ((await send("POST", "", { name: "Funny" })).json() as Overview).genres.find((genre) => genre.name === "Funny")!;
    await send("POST", `/${a.id}/merge`, { into: b.id });
    expect(await filmGenres()).toMatchObject({ "Some Film": ["Funny"] });
    expect((await overview()).genres).toEqual([expect.objectContaining({ name: "Funny", keywords: ["Comedy"], titles: 2 })]);
    await send("DELETE", `/${b.id}`);
    expect(await filmGenres()).toMatchObject({ "Some Film": [] });
    const { words } = await overview();
    expect(words.filter((word) => word.state === "hidden").map((word) => word.value).sort()).toEqual(["Comedy", "Funny"]);
    await send("POST", "/hidden/remove", { word: "comedy" });
    expect(await filmGenres()).toMatchObject({ "Some Film": ["Comedy"] });
  });

  it("starts from TMDB's list in one language, only onto an empty one", async () => {
    expect((await send("POST", "/seed", { language: "ru" })).statusCode).toBe(200);
    expect(await filmGenres()).toMatchObject({ "Other Film": ["Комедия", "Фантастика", "Фэнтези"], "Some Film": ["Комедия"] });
    expect((await overview()).words.filter((word) => word.state === "unsorted")).toEqual([]);
    expect((await send("POST", "/seed", { language: "en" })).statusCode).toBe(409);
  });

  it("is the admin's alone", async () => {
    expect((await send("GET", "", undefined, mum)).statusCode).toBe(403);
    expect((await send("POST", "", { name: "X" }, mum)).statusCode).toBe(403);
  });
});
