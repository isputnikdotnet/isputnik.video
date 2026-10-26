// Watching: the file streamed with byte ranges, each person's progress kept and
// never shown to anyone else, and what to watch next.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, parseRange } from "../src/app.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";

const as = (id: string, libraries: string[] = ["lib_tv", "lib_films"]) => ({
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": id,
  "x-isputnik-user-name": id,
  "x-isputnik-user-role": id === "admin" ? "admin" : "member",
  "x-isputnik-libraries": libraries.join(",")
});

let fixture: Fixture;
let app: FastifyInstance;
let radar: { id: string; seasons: { episodes: { id: string; episode: number; direct: string; progress: unknown }[] }[] };
let films: { id: string; title: string }[];

const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });
const saveProgress = (id: string, body: Record<string, unknown>, who = "mum") =>
  app.inject({ method: "PUT", url: `/video/api/progress/${id}`, headers: as(who), payload: body });

beforeEach(async () => {
  fixture = makeFixture();
  app = await buildApp({
    gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
    scan: { settleMs: 60_000 },
    fastify: { logger: false }
  });
  const admin = as("admin");
  await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_tv", headers: admin, payload: { name: "TV", kind: "shows", folder: "Shows" } });
  await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_films", headers: admin, payload: { name: "Films", kind: "movies", folder: "Movies" } });
  await app.scansSettled();
  const shows = (await get("/video/api/shows", as("mum"))).json().items as { id: string; title: string }[];
  radar = (await get(`/video/api/shows/${shows.find((show) => show.title === "Радар")!.id}`, as("mum"))).json();
  films = (await get("/video/api/movies", as("mum"))).json().items;
});

afterEach(async () => {
  await app.close();
  fixture.cleanup();
});

const episode = (n: number) => radar.seasons[0].episodes[n - 1];

describe("the stream", () => {
  it("sends the whole file, or the byte range asked for", async () => {
    const id = episode(2).id;
    const whole = await get(`/video/api/stream/${id}`, as("mum"));
    expect(whole.statusCode).toBe(200);
    expect(whole.headers["accept-ranges"]).toBe("bytes");
    expect(whole.headers["content-length"]).toBe("200");
    expect(whole.headers["content-type"]).toBe("video/x-matroska");
    expect(whole.body).toBe("x".repeat(200));

    const part = await app.inject({ method: "GET", url: `/video/api/stream/${id}`, headers: { ...as("mum"), range: "bytes=10-19" } });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 10-19/200");
    expect(part.body).toBe("x".repeat(10));

    const tail = await app.inject({ method: "GET", url: `/video/api/stream/${id}`, headers: { ...as("mum"), range: "bytes=150-" } });
    expect(tail.headers["content-range"]).toBe("bytes 150-199/200");

    const beyond = await app.inject({ method: "GET", url: `/video/api/stream/${id}`, headers: { ...as("mum"), range: "bytes=500-" } });
    expect(beyond.statusCode).toBe(416);
    expect(beyond.headers["content-range"]).toBe("bytes */200");
  });

  it("plays a film from its folder, and a loose one, as MP4 when it is one", async () => {
    const loose = films.find((film) => film.title === "Loose Film")!;
    const res = await get(`/video/api/stream/${loose.id}`, as("mum"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.body.length).toBe(3000);
    const some = films.find((film) => film.title === "Some Film")!;
    // The biggest file in the folder: the film, not its trailer.
    expect((await get(`/video/api/stream/${some.id}`, as("mum"))).body.length).toBe(5000);
  });

  it("is not there for someone outside the library, nor for anyone unsigned", async () => {
    expect((await get(`/video/api/stream/${episode(1).id}`, as("kid", ["lib_films"]))).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/video/api/stream/${episode(1).id}` })).statusCode).toBe(401);
  });

  it("answers 404 for a file that has gone from the disk", async () => {
    fixture.remove("Movies/Loose Film (1999).mp4");
    const loose = films.find((film) => film.title === "Loose Film")!;
    expect((await get(`/video/api/stream/${loose.id}`, as("mum"))).statusCode).toBe(404);
    expect((await get(`/video/api/play/${loose.id}`, as("mum"))).json()).toMatchObject({ available: false });
  });
});

describe("parseRange", () => {
  it("reads the single ranges players send and refuses nonsense", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=5-500", 100)).toEqual({ start: 5, end: 99 });
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("bytes=50-10", 100)).toBe("invalid");
    expect(parseRange("items=0-1", 100)).toBe("invalid");
  });
});

describe("progress", () => {
  it("is kept per person and shown on the show, and resumes where it stopped", async () => {
    const id = episode(1).id;
    expect((await saveProgress(id, { position: 600, duration: 2400 })).json().progress).toMatchObject({ position: 600, duration: 2400, watched: false });

    const play = (await get(`/video/api/play/${id}`, as("mum"))).json();
    expect(play).toMatchObject({ type: "episode", show: { title: "Радар" }, season: 1, episode: 1, direct: "maybe", resumeAt: 600, available: true });
    expect(play.next).toMatchObject({ id: episode(2).id, episode: 2 });

    const show = (await get(`/video/api/shows/${radar.id}`, as("mum"))).json();
    expect(show.seasons[0].episodes[0].progress).toMatchObject({ position: 600, watched: false });
    expect(show.nextUp).toMatchObject({ id, position: 600 });

    // Dad has his own place, and sees none of Mum's.
    const dads = (await get(`/video/api/shows/${radar.id}`, as("dad"))).json();
    expect(dads.seasons[0].episodes[0].progress).toBeNull();
    expect(dads.nextUp).toMatchObject({ id, position: 0 });
  });

  it("counts an episode watched near its end, and moves on to the next", async () => {
    expect((await saveProgress(episode(1).id, { position: 2300, duration: 2400 })).json().progress.watched).toBe(true);
    const show = (await get(`/video/api/shows/${radar.id}`, as("mum"))).json();
    expect(show.nextUp).toMatchObject({ id: episode(2).id, position: 0 });
    // Played again from the start, a watched one resumes at nothing.
    expect((await get(`/video/api/play/${episode(1).id}`, as("mum"))).json().resumeAt).toBe(0);
    // Marked unwatched by hand.
    expect((await saveProgress(episode(1).id, { position: 0, duration: 2400, watched: false })).json().progress.watched).toBe(false);
  });

  it("refuses an item outside the person's libraries", async () => {
    const res = await app.inject({ method: "PUT", url: `/video/api/progress/${episode(1).id}`, headers: as("kid", ["lib_films"]), payload: { position: 5, duration: 10 } });
    expect(res.statusCode).toBe(404);
  });
});

describe("continue watching", () => {
  it("lists what is left halfway and the next episode of a finished one, newest first, one per show", async () => {
    const some = films.find((film) => film.title === "Some Film")!;
    await saveProgress(episode(1).id, { position: 2350, duration: 2400 });
    await saveProgress(some.id, { position: 1200, duration: 6700 });
    // A peek is not a place to come back to.
    const loose = films.find((film) => film.title === "Loose Film")!;
    await saveProgress(loose.id, { position: 10, duration: 5000 });

    const items = (await get("/video/api/continue", as("mum"))).json().items;
    expect(items.map((item: { id: string }) => item.id)).toEqual([some.id, episode(2).id]);
    expect(items[0]).toMatchObject({ type: "movie", title: "Some Film", position: 1200, resume: true });
    expect(items[1]).toMatchObject({ type: "episode", show: { title: "Радар" }, episode: 2, position: 0, resume: false });

    expect((await get("/video/api/continue", as("dad"))).json().items).toEqual([]);
    // Outside the libraries a person may see, nothing shows, whatever was watched.
    expect((await get("/video/api/continue", as("mum", ["lib_tv"]))).json().items.map((item: { id: string }) => item.id)).toEqual([episode(2).id]);
  });

  it("drops a show once its last episode is watched", async () => {
    for (const n of [1, 2, 3]) await saveProgress(episode(n).id, { position: 2400, duration: 2400 });
    expect((await get("/video/api/continue", as("mum"))).json().items).toEqual([]);
    expect((await get(`/video/api/shows/${radar.id}`, as("mum"))).json().nextUp).toBeNull();
  });
});
