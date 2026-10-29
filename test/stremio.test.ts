// The Stremio add-on (stremio.ts): the catalog in Stremio's protocol for the
// member home's gateway admitted by their link — filtered by X-Isputnik-Libraries
// like every route, named after this install, with absolute links on home's base.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { MediaInfo } from "../src/ffmpeg.js";
import { createLogBuffer } from "../src/log-buffer.js";
import { CATALOG_PAGE, engineIdOf, maskStremioToken, stremioLanguage, tvRisk } from "../src/stremio.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";
const TOKEN = "isp_video-stremio_TESTTOKEN";
const BASE = `https://home.example/video/stremio/${TOKEN}`;
const ROOT = `/video/stremio/${TOKEN}`;

const as = (id: string, libraries: string[] = ["lib_tv", "lib_films"], site = true) => ({
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": id,
  "x-isputnik-user-name": id,
  "x-isputnik-user-role": id === "admin" ? "admin" : "member",
  "x-isputnik-libraries": libraries.join(","),
  ...(site ? {
    "x-isputnik-via": "token",
    "x-isputnik-site-id": "site42",
    "x-isputnik-site-name": encodeURIComponent("iSputnik · home.example"),
    "x-isputnik-base-url": BASE
  } : {})
});

let fixture: Fixture;
let app: FastifyInstance;

const get = (url: string, headers: Record<string, string> = as("mum")) => app.inject({ method: "GET", url, headers });

beforeEach(async () => {
  fixture = makeFixture();
  fixture.write("Movies/Some Film (2010)/Some Film (2010).en.srt", "1\n00:00:01,000 --> 00:00:02,000\nHello\n");
  fixture.write("Movies/Some Film (2010)/Some Film (2010).ru.srt", "1\n00:00:01,000 --> 00:00:02,000\nПривет\n");
  app = await buildApp({
    gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.9.0", stage: null,
    scan: { settleMs: 60_000 }, tools: null,
    fastify: { logger: false }
  });
  const admin = as("admin", [], false);
  await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_tv", headers: admin, payload: { name: "TV", kind: "shows", folder: "Shows" } });
  await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_films", headers: admin, payload: { name: "Family films", kind: "movies", folder: "Movies" } });
  await app.scansSettled();
});

afterEach(async () => {
  await app.close();
  fixture.cleanup();
});

type Meta = { id: string; type: string; name: string; poster?: string | null; videos?: { id: string; season: number; episode: number; title: string; released: string }[] };
const catalog = async (type: string, id: string, extra = "") => (await get(`${ROOT}/catalog/${type}/${id}${extra ? `/${extra}` : ""}.json`)).json().metas as Meta[];

describe("the manifest", () => {
  it("is this install's add-on, with a catalog per library the member may see", async () => {
    const res = await get(`${ROOT}/manifest.json`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.json()).toMatchObject({
      id: "net.isputnik.home.site42",
      name: "iSputnik · home.example",
      version: "0.9.0",
      idPrefixes: ["isp-site42:"],
      types: ["movie", "series"],
      catalogs: [
        { type: "movie", id: "isp-continue" },
        { type: "series", id: "isp-continue" },
        { type: "movie", id: "isp-lib-lib_films", name: "Family films" },
        { type: "series", id: "isp-lib-lib_tv", name: "TV" }
      ]
    });
    // Each library offers its own genres to filter by (the .nfo's here).
    const tv = res.json().catalogs.find((c: { id: string }) => c.id === "isp-lib-lib_tv");
    expect(tv.extra).toContainEqual({ name: "genre", options: ["Драма", "Фантастика"] });

    const filmsOnly = (await get(`${ROOT}/manifest.json`, as("kid", ["lib_films"]))).json();
    expect(filmsOnly.catalogs.map((c: { type: string; id: string }) => `${c.type}:${c.id}`)).toEqual(["movie:isp-continue", "movie:isp-lib-lib_films"]);
    const nothing = (await get(`${ROOT}/manifest.json`, as("guest", []))).json();
    expect(nothing.catalogs).toEqual([]);
  });

  it("is refused without home's signature, or without the site headers", async () => {
    expect((await get(`${ROOT}/manifest.json`, {})).statusCode).toBe(401);
    expect((await get(`${ROOT}/manifest.json`, as("mum", ["lib_films"], false))).statusCode).toBe(400);
  });
});

describe("catalogs", () => {
  it("lists a library's titles with this install's ids, and honours any skip", async () => {
    const films = await catalog("movie", "isp-lib-lib_films");
    expect(films.map((film) => film.name)).toEqual(["Loose Film", "Some Film"]);
    expect(films.every((film) => film.id.startsWith("isp-site42:"))).toBe(true);
    const skipped = await catalog("movie", "isp-lib-lib_films", "skip=1");
    expect(skipped.map((film) => film.name)).toEqual(["Some Film"]);
    expect(CATALOG_PAGE).toBe(100);
  });

  it("filters by genre", async () => {
    expect((await catalog("movie", "isp-lib-lib_films", "genre=Comedy")).map((film) => film.name)).toEqual(["Some Film"]);
    expect((await catalog("series", "isp-lib-lib_tv", `genre=${encodeURIComponent("Драма")}`)).map((show) => show.name)).toEqual(["Радар"]);
    expect(await catalog("movie", "isp-lib-lib_films", "genre=Horror")).toEqual([]);
  });

  it("keeps Continue watching to the type of its row", async () => {
    const some = (await catalog("movie", "isp-lib-lib_films")).find((film) => film.name === "Some Film")!;
    const radar = (await catalog("series", "isp-lib-lib_tv")).find((show) => show.name === "Радар")!;
    const firstEpisode = ((await get(`${ROOT}/meta/series/${radar.id}.json`)).json().meta as Meta).videos![0].id;
    for (const id of [some.id, firstEpisode]) {
      await app.inject({ method: "PUT", url: `/video/api/progress/${id.slice("isp-site42:".length)}`, headers: as("mum", ["lib_tv", "lib_films"], false), payload: { position: 120, duration: 3000 } });
    }
    expect((await catalog("movie", "isp-continue")).map((meta) => meta.name)).toEqual(["Some Film"]);
    expect((await catalog("series", "isp-continue")).map((meta) => meta.name)).toEqual(["Радар"]);
  });

  it("searches, and never shows a library the member may not see", async () => {
    expect((await catalog("movie", "isp-lib-lib_films", "search=some")).map((film) => film.name)).toEqual(["Some Film"]);
    expect((await get(`${ROOT}/catalog/movie/isp-lib-lib_films.json`, as("kid", ["lib_tv"]))).json().metas).toEqual([]);
    // A catalog asked for under the wrong type is empty, not the other kind.
    expect(await catalog("series", "isp-lib-lib_films")).toEqual([]);
  });
});

describe("meta", () => {
  it("describes a show with its episodes, in watching order", async () => {
    const shows = await catalog("series", "isp-lib-lib_tv");
    const radar = shows.find((show) => show.name === "Радар")!;
    const meta = (await get(`${ROOT}/meta/series/${encodeURIComponent(radar.id)}.json`)).json().meta as Meta;
    expect(meta).toMatchObject({ id: radar.id, type: "series", name: "Радар", releaseInfo: "2026" });
    expect(meta.videos!.map((video) => [video.season, video.episode, video.title])).toEqual([[1, 1, "Серия 1"], [1, 2, "Серия 2"], [1, 3, "Серия 3"]]);
    expect(meta.videos![0].released).toBe("2026-04-21T00:00:00.000Z");
    expect(meta.videos!.every((video) => video.id.startsWith("isp-site42:"))).toBe(true);
  });

  it("answers nothing for another install's id, or a title the member may not see", async () => {
    const [film] = await catalog("movie", "isp-lib-lib_films");
    const engineId = film.id.slice("isp-site42:".length);
    expect((await get(`${ROOT}/meta/movie/isp-other:${engineId}.json`)).json().meta).toBeNull();
    expect((await get(`${ROOT}/meta/movie/${film.id}.json`, as("kid", ["lib_tv"]))).json().meta).toBeNull();
  });
});

describe("streams and subtitles", () => {
  it("offers the original file on home's base, with what Stremio needs about it", async () => {
    const some = (await catalog("movie", "isp-lib-lib_films")).find((film) => film.name === "Some Film")!;
    const { streams } = (await get(`${ROOT}/stream/movie/${some.id}.json`)).json();
    const engineId = some.id.slice("isp-site42:".length);
    expect(streams).toEqual([expect.objectContaining({
      url: `${BASE}/play/${engineId}`,
      behaviorHints: expect.objectContaining({ notWebReady: true, filename: "Some Film (2010).mkv", videoSize: 5000 })
    })]);

    // The bytes themselves, by range, under the token prefix.
    const part = await app.inject({ method: "GET", url: `${ROOT}/play/${engineId}`, headers: { ...as("mum"), range: "bytes=0-9" } });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe("x".repeat(10));
  });

  it("groups a show's episodes for next-episode", async () => {
    const radar = (await catalog("series", "isp-lib-lib_tv")).find((show) => show.name === "Радар")!;
    const meta = (await get(`${ROOT}/meta/series/${radar.id}.json`)).json().meta as Meta;
    const { streams } = (await get(`${ROOT}/stream/series/${meta.videos![0].id}.json`)).json();
    expect(streams[0].behaviorHints.bingeGroup).toBe(`isputnik-site42-${radar.id.slice("isp-site42:".length)}`);
  });

  it("lists the subtitle files beside a film, in Stremio's language codes", async () => {
    const some = (await catalog("movie", "isp-lib-lib_films")).find((film) => film.name === "Some Film")!;
    const res = await get(`${ROOT}/subtitles/movie/${some.id}/filename=x.mkv&videoSize=5000.json`);
    const subtitles = res.json().subtitles as { lang: string; url: string }[];
    expect(subtitles.map((subtitle) => subtitle.lang).sort()).toEqual(["eng", "rus"]);
    expect(subtitles.every((subtitle) => subtitle.url.startsWith(`${BASE}/subs/`))).toBe(true);
  });
});

describe("formats a TV refuses", () => {
  const info = (video: Partial<NonNullable<MediaInfo["video"]>> | null): MediaInfo => ({
    container: "matroska,webm", start: 0, duration: 60, audio: [], subtitles: [],
    video: video ? { index: 0, codec: "h264", profile: "High", pixelFormat: "yuv420p", width: 1920, height: 1080, ...video } : null
  });

  it("lets through what a TV was seen to play", () => {
    expect(tvRisk(info({}))).toBeNull();
    expect(tvRisk(info({ codec: "hevc", pixelFormat: "yuv420p10le", profile: "Main 10" }))).toBeNull();
    expect(tvRisk(info(null))).toBeNull();
  });

  it("flags what crashed it or is not known to play", () => {
    expect(tvRisk(info({ pixelFormat: "yuv444p", profile: "High 4:4:4 Predictive" }))).toMatch(/yuv444p/);
    expect(tvRisk(info({ pixelFormat: "yuv420p10le", profile: "High 10" }))).toMatch(/10/);
    expect(tvRisk(info({ codec: "vc1" }))).toBe("vc1");
    expect(tvRisk(info({ codec: "mpeg2video" }))).toBe("mpeg2video");
    expect(tvRisk(null)).toBe("unread");
  });
});

describe("small things", () => {
  it("never writes a token to the log", () => {
    const lines: string[] = [];
    const buffer = createLogBuffer(10, { write: (chunk) => lines.push(chunk) });
    buffer.write(`{"url":"${ROOT}/stream/movie/x.json"}\n`);
    expect(lines.join("")).not.toContain(TOKEN);
    expect(buffer.tail(1)[0]).toContain("/video/stremio/<token>/stream/movie/x.json");
    expect(maskStremioToken(`${BASE}/play/a`)).toBe("https://home.example/video/stremio/<token>/play/a");
  });

  it("maps languages and reads only this install's ids", () => {
    expect([stremioLanguage("en"), stremioLanguage("rus"), stremioLanguage(null)]).toEqual(["eng", "rus", "und"]);
    const site = { id: "site42", name: "x", base: BASE };
    expect(engineIdOf(site, "isp-site42:abc_1")).toBe("abc_1");
    expect(engineIdOf(site, "isp-site43:abc")).toBeNull();
    expect(engineIdOf(site, "isp-site42:../x")).toBeNull();
  });
});
