// Where a title's intro and credits are: chapters by their names, an .edl beside
// the file over them, and a real chaptered film through /play and progress.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { findTools, probe } from "../src/ffmpeg.js";
import { chapterKind, findMarkers, markersFromChapters, markersFromEdl, parseEdl } from "../src/markers.js";

const chapter = (start: number, end: number, title: string | null) => ({ start, end, title });

describe("a chapter's name", () => {
  it.each([
    ["Intro", "intro"], ["OPENING", "intro"], ["OP", "intro"], ["OP 1", "intro"], ["Opening Credits", "intro"], ["Заставка", "intro"], ["Начальные титры", "intro"],
    ["Credits", "credits"], ["End Credits", "credits"], ["ED", "credits"], ["Ending:", "credits"], ["Титры", "credits"], ["Финальные титры", "credits"]
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

describe("chapters", () => {
  it("finds the intro in the first half and the credits in the second", () => {
    const found = markersFromChapters([
      chapter(0, 60, "Cold open"), chapter(60, 150, "Intro"), chapter(150, 2500, "Chapter 3"), chapter(2500, 2600, "End Credits"), chapter(2600, 2640, "Preview")
    ], 0, 2640);
    expect(found).toEqual({ intro: { start: 60, end: 150, source: "chapter" }, credits: { start: 2500, source: "chapter" } });
  });

  it("does not take a Credits chapter near the start for the end credits, nor an Opening near the end for the intro", () => {
    expect(markersFromChapters([chapter(0, 90, "Credits"), chapter(2000, 2100, "Opening")], 0, 2640)).toEqual({ intro: null, credits: null });
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
      intro: { start: 60, end: 150, source: "edl" },
      credits: { start: 2500, source: "edl" }
    });
  });

  it("makes nothing of a stretch in the middle", () => {
    expect(markersFromEdl([{ start: 1300, end: 1400 }], 2640)).toEqual({ intro: null, credits: null });
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
    fs.rmSync(root, { recursive: true, force: true });
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
    expect((await play()).markers).toEqual({ intro: { start: 5, end: 15, source: "chapter" }, credits: { start: 50, source: "chapter" } });
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
      expect((await play()).markers).toEqual({ intro: { start: 4, end: 14, source: "edl" }, credits: { start: 50, source: "chapter" } });
    } finally {
      fs.rmSync(edl);
    }
  });
});
