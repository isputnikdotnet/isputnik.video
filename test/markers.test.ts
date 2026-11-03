// Where a title's intro and credits are: chapters by their names, an .edl beside
// the file over them, and a real chaptered film through /play and progress.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import Database from "better-sqlite3";
import { openDatabase } from "../src/db.js";
import { findTools, probe } from "../src/ffmpeg.js";
import { chapterKind, findMarkers, markersFromChapters, markersFromEdl, parseEdl } from "../src/markers.js";

const chapter = (start: number, end: number, title: string | null) => ({ start, end, title });

describe("a chapter's name", () => {
  it.each([
    ["Intro", "intro"], ["OPENING", "intro"], ["OP", "intro"], ["OP 1", "intro"], ["Opening Credits", "intro"], ["Заставка", "intro"], ["Начальные титры", "intro"],
    ["Credits", "credits"], ["End Credits", "credits"], ["ED", "credits"], ["Ending:", "credits"], ["Титры", "credits"], ["Финальные титры", "credits"],
    ["Recap", "recap"], ["Previously on...", "recap"], ["Ранее", "recap"], ["В предыдущих сериях", "recap"]
  ])("reads %s as %s", (title, kind) => {
    expect(chapterKind(title)).toBe(kind);
  });

  it.each(["Chapter 3", "The Opening Move", "Credits Where Due", "01", ""])("says nothing of %j", (title) => {
    expect(chapterKind(title)).toBeNull();
  });

  it("says nothing of a chapter with no name", () => {
    expect(chapterKind(null)).toBeNull();
  });
});

describe("a database from before recaps", () => {
  it("keeps its marks, and takes a recap mark after", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-widen-")), "video.sqlite");
    // The markers table as 0.15.0 made it.
    const old = new Database(file);
    old.exec(`CREATE TABLE markers (
      item_id TEXT NOT NULL, season INTEGER NOT NULL DEFAULT -1,
      kind TEXT NOT NULL CHECK (kind IN ('intro', 'credits')), start_s REAL NOT NULL, end_s REAL,
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'detected')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (item_id, season, kind));
      INSERT INTO markers (item_id, season, kind, start_s, end_s) VALUES ('show1', 2, 'intro', 60, 130);`);
    old.close();
    const db = openDatabase(file);
    try {
      expect(db.prepare("SELECT item_id, season, kind, start_s, end_s FROM markers").all()).toEqual([{ item_id: "show1", season: 2, kind: "intro", start_s: 60, end_s: 130 }]);
      db.prepare("INSERT INTO markers (item_id, kind, start_s, end_s) VALUES ('ep1', 'recap', 20, 80)").run();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'markers_before_recap'").get()).toBeUndefined();
    } finally {
      db.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});

describe("chapters", () => {
  it("finds the intro in the first half and the credits in the second", () => {
    const found = markersFromChapters([
      chapter(0, 60, "Cold open"), chapter(60, 150, "Intro"), chapter(150, 2500, "Chapter 3"), chapter(2500, 2600, "End Credits"), chapter(2600, 2640, "Preview")
    ], 0, 2640);
    expect(found).toEqual({ recap: null, intro: { start: 60, end: 150, source: "chapter" }, credits: { start: 2500, source: "chapter" } });
  });

  it("does not take a Credits chapter near the start for the end credits, nor an Opening near the end for the intro", () => {
    expect(markersFromChapters([chapter(0, 90, "Credits"), chapter(2000, 2100, "Opening")], 0, 2640)).toEqual({ recap: null, intro: null, credits: null });
  });

  it("counts from the start of a file whose clock does not start at 0", () => {
    expect(markersFromChapters([chapter(110, 200, "Intro")], 100, 2640).intro).toMatchObject({ start: 10, end: 100 });
  });

  it("ignores an intro too short to skip, and everything when the length is unknown", () => {
    expect(markersFromChapters([chapter(10, 11, "Intro")], 0, 2640).intro).toBeNull();
    expect(markersFromChapters([chapter(10, 100, "Intro")], 0, 0).intro).toBeNull();
  });
});

describe("an .edl", () => {
  it("reads cuts and commercial breaks, in seconds or a clock, and leaves mutes, markers and frames", () => {
    expect(parseEdl("60.5\t150\t3\r\n0:02:40 0:03:00 0\n300 310 1\n400 400 2\n#100 #200 3\nnonsense\n\n500 520\n")).toEqual([
      { start: 60.5, end: 150 }, { start: 160, end: 180 }, { start: 500, end: 520 }
    ]);
  });

  it("takes the stretch early on for the intro and the one reaching the end for the credits", () => {
    expect(markersFromEdl([{ start: 60, end: 150 }, { start: 1300, end: 1320 }, { start: 2500, end: 2638 }], 2640)).toEqual({
      recap: null,
      intro: { start: 60, end: 150, source: "edl" },
      credits: { start: 2500, source: "edl" }
    });
  });

  it("makes nothing of a stretch in the middle", () => {
    expect(markersFromEdl([{ start: 1300, end: 1400 }], 2640)).toEqual({ recap: null, intro: null, credits: null });
  });
});

describe("a chaptered film", () => {
  const SECRET = "video-secret-video-secret-0123456789";
  const headers = {
    "x-isputnik-gateway": SECRET,
    "x-isputnik-user-id": "admin",
    "x-isputnik-user-name": "admin",
    "x-isputnik-user-role": "admin",
    "x-isputnik-libraries": "lib_films"
  };
  const tools = findTools();
  let root: string;
  let film: string;
  let app: FastifyInstance;
  let id: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-markers-"));
    const dir = path.join(root, "Movies", "Film (2020)");
    fs.mkdirSync(dir, { recursive: true });
    film = path.join(dir, "Film (2020).mkv");
    const metadata = path.join(root, "chapters.txt");
    fs.writeFileSync(metadata, [
      ";FFMETADATA1",
      "[CHAPTER]", "TIMEBASE=1/1000", "START=0", "END=5000", "title=Cold open",
      "[CHAPTER]", "TIMEBASE=1/1000", "START=5000", "END=15000", "title=Intro",
      "[CHAPTER]", "TIMEBASE=1/1000", "START=15000", "END=50000", "title=Chapter 3",
      "[CHAPTER]", "TIMEBASE=1/1000", "START=50000", "END=60000", "title=Титры",
      ""
    ].join("\n"));
    execFileSync(tools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=4", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-i", metadata, "-map", "0", "-map", "1", "-map_chapters", "2", "-t", "60", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", film]);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(film, hourAgo, hourAgo);
    app = await buildApp({
      gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: root, version: "0.0.0-test", stage: null,
      scan: { settleMs: 60_000 }, tools, fastify: { logger: false }
    });
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_films", headers, payload: { name: "Films", kind: "movies", folder: "Movies" } });
    await app.scansSettled();
    id = (await app.inject({ method: "GET", url: "/video/api/movies", headers })).json().items[0].id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    // On Windows a file ffprobe still has open can't go yet: try again for a moment.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("has its chapters probed", async () => {
    const info = await probe(tools, film);
    expect(info.chapters.map((entry) => entry.title)).toEqual(["Cold open", "Intro", "Chapter 3", "Титры"]);
    expect(findMarkers(info, film).intro).toEqual({ start: 5, end: 15, source: "chapter" });
  });

  const play = async () => (await app.inject({ method: "GET", url: `/video/api/play/${id}`, headers })).json();
  const save = async (position: number) =>
    (await app.inject({ method: "PUT", url: `/video/api/progress/${id}`, headers, payload: { position, duration: 60 } })).json().progress;

  it("tells the player where its intro and credits are", async () => {
    expect((await play()).markers).toEqual({ recap: null, intro: { start: 5, end: 15, source: "chapter" }, credits: { start: 50, source: "chapter" } });
  });

  it("counts as watched from where the credits start, not at 92 %", async () => {
    expect((await save(49)).watched).toBe(false);
    expect((await save(51)).watched).toBe(true);
    expect((await save(30)).watched).toBe(false);
  });

  it("lets an .edl beside it win, for the kind it names, as soon as it is there", async () => {
    const edl = film.replace(/\.mkv$/, ".edl");
    fs.writeFileSync(edl, "4 14 3\n");
    try {
      expect((await play()).markers).toEqual({ recap: null, intro: { start: 4, end: 14, source: "edl" }, credits: { start: 50, source: "chapter" } });
    } finally {
      fs.rmSync(edl);
    }
  });

  const mark = (payload: object, as = headers) => app.inject({ method: "PUT", url: `/video/api/admin/markers/${id}`, headers: as, payload });

  it("lets an admin's mark win over the chapters, and clearing it gives them back", async () => {
    const set = await mark({ kind: "credits", scope: "episode", start: 40 });
    expect(set.statusCode).toBe(200);
    expect(set.json().markers.credits).toEqual({ start: 40, source: "manual", scope: "episode" });
    expect((await play()).markers.intro).toEqual({ start: 5, end: 15, source: "chapter" });
    expect((await save(45)).watched).toBe(true);
    const cleared = (await mark({ kind: "credits", scope: "episode", start: null })).json();
    expect(cleared.markers.credits).toEqual({ start: 50, source: "chapter" });
  });

  it("refuses a mark past the end, an intro that ends before it starts, a season for a film, and anyone but an admin", async () => {
    expect((await mark({ kind: "credits", scope: "episode", start: 70 })).statusCode).toBe(400);
    expect((await mark({ kind: "intro", scope: "episode", start: 10, end: 5 })).statusCode).toBe(400);
    expect((await mark({ kind: "intro", scope: "season", start: 1, end: 5 })).statusCode).toBe(400);
    expect((await mark({ kind: "intro", scope: "episode", start: 1, end: 5 }, { ...headers, "x-isputnik-user-role": "member" })).statusCode).toBe(403);
  });

  it("takes a recap mark for the title alone, never for a season", async () => {
    const set = await mark({ kind: "recap", scope: "episode", start: 1, end: 4.5 });
    expect(set.json().markers.recap).toEqual({ start: 1, end: 4.5, source: "manual", scope: "episode" });
    expect((await mark({ kind: "recap", scope: "season", start: 1, end: 4.5 })).statusCode).toBe(400);
    expect((await mark({ kind: "recap", scope: "episode", start: null })).json().markers.recap).toBeNull();
  });
});

describe("marks for a season", () => {
  const SECRET = "video-secret-video-secret-0123456789";
  const headers = {
    "x-isputnik-gateway": SECRET,
    "x-isputnik-user-id": "admin",
    "x-isputnik-user-name": "admin",
    "x-isputnik-user-role": "admin",
    "x-isputnik-libraries": "lib_shows"
  };
  let root: string;
  let app: FastifyInstance;
  let episodes: { id: string; season: number; episode: number }[];

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-marks-"));
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    for (const [season, episode] of [[1, 1], [1, 2], [2, 1]]) {
      const dir = path.join(root, "Shows", "Show (2020)", `Season ${season}`);
      fs.mkdirSync(dir, { recursive: true });
      // Not real video: marks need no probe.
      const file = path.join(dir, `Show (2020) S0${season}E0${episode}.mkv`);
      fs.writeFileSync(file, "x");
      fs.utimesSync(file, hourAgo, hourAgo);
    }
    app = await buildApp({
      gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: root, version: "0.0.0-test", stage: null,
      scan: { settleMs: 60_000 }, tools: null, fastify: { logger: false }
    });
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_shows", headers, payload: { name: "Shows", kind: "shows", folder: "Shows" } });
    await app.scansSettled();
    const show = (await app.inject({ method: "GET", url: "/video/api/shows", headers })).json().items[0];
    const detail = (await app.inject({ method: "GET", url: `/video/api/shows/${show.id}`, headers })).json();
    episodes = detail.seasons.flatMap((season: { number: number; episodes: { id: string; episode: number }[] }) =>
      season.episodes.map((entry) => ({ ...entry, season: season.number })));
  });

  afterAll(async () => {
    await app?.close();
    // On Windows a file ffprobe still has open can't go yet: try again for a moment.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const of = (season: number, episode: number) => episodes.find((entry) => entry.season === season && entry.episode === episode)!.id;
  const markersOf = async (itemId: string) => (await app.inject({ method: "GET", url: `/video/api/play/${itemId}`, headers })).json().markers;
  const mark = (itemId: string, payload: object) => app.inject({ method: "PUT", url: `/video/api/admin/markers/${itemId}`, headers, payload });

  it("holds for every episode of that season and no other, and an episode's own wins", async () => {
    expect((await mark(of(1, 1), { kind: "intro", scope: "season", start: 60, end: 120 })).statusCode).toBe(200);
    const seasonMark = { start: 60, end: 120, source: "manual", scope: "season" };
    expect((await markersOf(of(1, 2))).intro).toEqual(seasonMark);
    expect((await markersOf(of(2, 1))).intro).toBeNull();

    await mark(of(1, 2), { kind: "intro", scope: "episode", start: 10, end: 70 });
    expect((await markersOf(of(1, 2))).intro).toEqual({ start: 10, end: 70, source: "manual", scope: "episode" });
    expect((await markersOf(of(1, 1))).intro).toEqual(seasonMark);

    // The episode's own cleared: the season's comes back.
    await mark(of(1, 2), { kind: "intro", scope: "episode", start: null });
    expect((await markersOf(of(1, 2))).intro).toEqual(seasonMark);
  });
});
