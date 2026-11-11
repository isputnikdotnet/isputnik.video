// Watched marks around browsing (home's issue #101): every card of a list says
// where the person asking is in it, a list narrows by that, and a whole show, a
// season or a film is marked in one call — each person's own, as progress is.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";

const as = (id: string, libraries: string[] = ["lib_tv", "lib_mov"]) => ({
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": id,
  "x-isputnik-user-name": id,
  "x-isputnik-user-role": id === "admin" ? "admin" : "member",
  "x-isputnik-libraries": libraries.join(",")
});

interface Card {
  kind: "shows" | "movies";
  id: string;
  title: string;
  episodes?: number;
  watchedEpisodes?: number;
  started?: boolean;
  playId?: string | null;
  progress?: { position: number; duration: number | null; watched: boolean } | null;
}
interface Show {
  id: string;
  marksAll: boolean;
  nextUp: { id: string; season: number; episode: number } | null;
  seasons: { number: number; episodes: { id: string; episode: number; progress: { watched: boolean; position: number } | null }[] }[];
}

let fixture: Fixture;
let app: FastifyInstance;

const get = (url: string, who = "mum") => app.inject({ method: "GET", url, headers: as(who) });
const put = (url: string, body: Record<string, unknown>, who = "mum") => app.inject({ method: "PUT", url, headers: as(who), payload: body });
const titles = async (query = "", who = "mum") => (await get(`/video/api/titles?sort=title${query}`, who)).json() as { items: Card[]; total: number; watch: boolean };
const card = async (title: string, who = "mum") => (await titles("", who)).items.find((item) => item.title === title)!;
const show = async (title: string, who = "mum") => (await get(`/video/api/shows/${(await card(title, who)).id}`, who)).json() as Show;
const names = (page: { items: Card[] }) => page.items.map((item) => item.title);

beforeEach(async () => {
  fixture = makeFixture();
  // A second season, so one can be marked apart from the other.
  for (let n = 1; n <= 2; n++) fixture.write(`Shows/Radar (2026) [imdbid-tt33022834]/Season 02/Radar (2026) S02E0${n}.mkv`, "x".repeat(50));
  app = await buildApp({
    gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
    scan: { settleMs: 60_000 },
    fastify: { logger: false }
  });
  const admin = as("admin");
  await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_tv", headers: admin, payload: { name: "TV", kind: "shows", folder: "Shows" } });
  await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_mov", headers: admin, payload: { name: "Films", kind: "movies", folder: "Movies" } });
  await app.scansSettled();
});

afterEach(async () => {
  await app.close();
  fixture.cleanup();
});

describe("a list's cards", () => {
  it("say the engine tracks it, and start with nothing watched", async () => {
    const page = await titles();
    expect(page.watch).toBe(true);
    expect(await card("Радар")).toMatchObject({ episodes: 5, watchedEpisodes: 0, started: false });
    const film = await card("Some Film");
    expect(film.progress).toBeNull();
    expect(film.playId).toBe(film.id);
  });

  it("carry a film's place and a show's count of episodes seen, for the person asking only", async () => {
    const film = await card("Some Film");
    await put(`/video/api/progress/${film.id}`, { position: 600, duration: 6000 });
    const radar = await show("Радар");
    await put(`/video/api/progress/${radar.seasons[0].episodes[0].id}`, { position: 0, duration: 2400, watched: true });

    expect((await card("Some Film")).progress).toMatchObject({ position: 600, duration: 6000, watched: false });
    expect(await card("Радар")).toMatchObject({ watchedEpisodes: 1, started: true, playId: radar.seasons[0].episodes[1].id });
    // Dad has seen none of it.
    expect((await card("Some Film", "dad")).progress).toBeNull();
    expect(await card("Радар", "dad")).toMatchObject({ watchedEpisodes: 0, started: false });
    // The lists by kind say the same.
    const shows = (await get("/video/api/shows")).json() as { items: Card[] };
    expect(shows.items.find((item) => item.title === "Радар")).toMatchObject({ watchedEpisodes: 1 });
    const movies = (await get("/video/api/movies")).json() as { items: Card[] };
    expect(movies.items.find((item) => item.title === "Some Film")?.progress).toMatchObject({ position: 600 });
  });
});

describe("marking several at once", () => {
  it("marks a season watched, and the next season's first episode is next", async () => {
    const radar = await show("Радар");
    expect(radar.marksAll).toBe(true);
    const res = await put(`/video/api/watched/shows/${radar.id}`, { watched: true, season: 1 });
    expect(res.json()).toEqual({ marked: 3 });

    const after = await show("Радар");
    expect(after.seasons[0].episodes.every((episode) => episode.progress?.watched)).toBe(true);
    expect(after.seasons[1].episodes.every((episode) => episode.progress === null)).toBe(true);
    expect(after.nextUp).toMatchObject({ season: 2, episode: 1 });
    expect(await card("Радар")).toMatchObject({ watchedEpisodes: 3, started: true });
    // Continue watching offers it, as after an episode finished.
    const next = (await get("/video/api/continue")).json() as { items: { id: string; resume: boolean }[] };
    expect(next.items[0]).toMatchObject({ id: after.seasons[1].episodes[0].id, resume: false });
  });

  it("marks a whole show watched, then never seen again", async () => {
    const radar = await show("Радар");
    // Left part-way in one episode: its place goes with the mark.
    await put(`/video/api/progress/${radar.seasons[1].episodes[0].id}`, { position: 300, duration: 2400 });
    expect((await put(`/video/api/watched/shows/${radar.id}`, { watched: true })).json()).toEqual({ marked: 5 });
    let after = await show("Радар");
    expect(after.nextUp).toBeNull();
    expect(after.seasons[1].episodes[0].progress).toMatchObject({ watched: true, position: 2400 });
    expect(await card("Радар")).toMatchObject({ watchedEpisodes: 5, playId: null });

    await put(`/video/api/watched/shows/${radar.id}`, { watched: false });
    after = await show("Радар");
    expect(after.seasons.flatMap((season) => season.episodes).every((episode) => episode.progress === null)).toBe(true);
    expect(after.nextUp).toMatchObject({ season: 1, episode: 1 });
    expect(await card("Радар")).toMatchObject({ watchedEpisodes: 0, started: false });
  });

  it("unmarks one season and leaves the other's history alone", async () => {
    const radar = await show("Радар");
    await put(`/video/api/watched/shows/${radar.id}`, { watched: true });
    await put(`/video/api/watched/shows/${radar.id}`, { watched: false, season: 2 });
    const after = await show("Радар");
    expect(after.seasons[0].episodes.every((episode) => episode.progress?.watched)).toBe(true);
    expect(after.seasons[1].episodes.every((episode) => episode.progress === null)).toBe(true);
    expect(after.nextUp).toMatchObject({ season: 2, episode: 1 });
  });

  it("marks a film, with the running time its .nfo gives", async () => {
    const film = await card("Some Film");
    expect((await put(`/video/api/watched/movies/${film.id}`, { watched: true })).json()).toEqual({ marked: 1 });
    expect((await card("Some Film")).progress).toMatchObject({ watched: true });
    await put(`/video/api/watched/movies/${film.id}`, { watched: false });
    expect((await card("Some Film")).progress).toBeNull();
  });

  it("is each person's own, and only for a title they may see", async () => {
    const radar = await show("Радар");
    await put(`/video/api/watched/shows/${radar.id}`, { watched: true });
    expect(await card("Радар", "dad")).toMatchObject({ watchedEpisodes: 0 });
    const outsider = await app.inject({ method: "PUT", url: `/video/api/watched/shows/${radar.id}`, headers: as("kid", ["lib_mov"]), payload: { watched: true } });
    expect(outsider.statusCode).toBe(404);
    expect((await put(`/video/api/watched/films/${radar.id}`, { watched: true })).statusCode).toBe(404);
    expect((await put(`/video/api/watched/shows/${radar.id}`, {})).statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("narrowing a list by it", () => {
  beforeEach(async () => {
    // Some Film finished, Loose Film left part-way; Радар one season in, Counterpart untouched.
    await put(`/video/api/watched/movies/${(await card("Some Film")).id}`, { watched: true });
    await put(`/video/api/progress/${(await card("Loose Film")).id}`, { position: 400, duration: 5000 });
    await put(`/video/api/watched/shows/${(await card("Радар")).id}`, { watched: true, season: 1 });
  });

  it("takes each state apart, and any of several", async () => {
    expect(names(await titles("&watch=watched"))).toEqual(["Some Film"]);
    expect(names(await titles("&watch=progress"))).toEqual(["Loose Film", "Радар"]);
    expect(names(await titles("&watch=unwatched"))).toEqual(["Counterpart"]);
    expect(names(await titles("&watch=unwatched,progress"))).toEqual(["Counterpart", "Loose Film", "Радар"]);
    expect((await titles("&watch=watched")).total).toBe(1);
    // All three, or a word it doesn't know, is everything.
    expect((await titles("&watch=unwatched,progress,watched")).total).toBe(4);
    expect((await titles("&watch=seen")).total).toBe(4);
  });

  it("works with the other facets, and for the person asking", async () => {
    expect(names(await titles("&watch=progress&kind=movies"))).toEqual(["Loose Film"]);
    expect(names(await titles("&watch=unwatched", "dad"))).toEqual(["Counterpart", "Loose Film", "Some Film", "Радар"]);
  });

  it("counts a show finished only once every episode is, so a new one brings it back", async () => {
    const radar = await card("Радар");
    await put(`/video/api/watched/shows/${radar.id}`, { watched: true });
    expect(names(await titles("&watch=watched"))).toEqual(["Some Film", "Радар"]);
    fixture.write("Shows/Radar (2026) [imdbid-tt33022834]/Season 02/Radar (2026) S02E03.mkv", "x".repeat(60));
    await app.inject({ method: "POST", url: "/video/api/admin/libraries/lib_tv/scan", headers: as("admin") });
    await app.scansSettled();
    expect(await card("Радар")).toMatchObject({ episodes: 6, watchedEpisodes: 5 });
    expect(names(await titles("&watch=progress"))).toEqual(["Loose Film", "Радар"]);
  });
});
