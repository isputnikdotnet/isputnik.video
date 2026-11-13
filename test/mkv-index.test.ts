// The keyframes a Matroska file's Cues give match what ffprobe finds walking the
// file, and the engine reads them ahead of the first play after a scan.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { buildApp } from "../src/app.js";
import { findTools, keyframes, probe } from "../src/ffmpeg.js";
import { mkvKeyframes } from "../src/mkv-index.js";

const tools = findTools()!;

/** Twelve seconds of picture with B-frames, a keyframe every two seconds, and sound. */
function encode(file: string, ...extra: string[]): string {
  execFileSync(tools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-bf", "2", "-g", "48", "-pix_fmt", "yuv420p", "-c:a", "aac", ...extra, file]);
  return file;
}

describe("keyframes from a Matroska file's index", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-mkv-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the same keyframes ffprobe finds: index at the end or the front, closed or open GOPs", async () => {
    for (const file of [encode(path.join(dir, "end.mkv")), encode(path.join(dir, "front.mkv"), "-cues_to_front", "1"),
      // Open GOPs: I-frames that are keyframes by their recovery-point SEI, not as IDRs.
      encode(path.join(dir, "open.mkv"), "-x264-params", "open-gop=1")]) {
      const info = await probe(tools, file);
      const walked = await keyframes(tools, file);
      const read = await mkvKeyframes(file, { start: info.start, duration: info.duration, video: info.video! });
      expect(read).not.toBeNull();
      expect(read).toEqual(walked.map((at) => expect.closeTo(at, 5)));
      expect(read!.length).toBeGreaterThanOrEqual(6);
    }
  }, 60_000);

  it("leaves a file with no index, and anything that is not Matroska, to ffprobe", async () => {
    // Written to a pipe, the muxer can't go back to write Cues (nor sizes).
    const streamed = path.join(dir, "streamed.mkv");
    fs.writeFileSync(streamed, execFileSync(tools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24",
      "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-g", "24", "-pix_fmt", "yuv420p", "-f", "matroska", "pipe:1"], { maxBuffer: 64 * 1024 * 1024 }));
    const mp4 = encode(path.join(dir, "film.mp4"));
    const span = { start: 0, duration: 12, video: { width: 160, height: 120 } };
    expect(await mkvKeyframes(streamed, { ...span, duration: 6 })).toBeNull();
    expect(await mkvKeyframes(mp4, span)).toBeNull();
  }, 60_000);

  it("won't use an index that stops short of the end of the film", async () => {
    const file = encode(path.join(dir, "short.mkv"));
    const info = await probe(tools, file);
    // As if the film went on for minutes after its last cue.
    expect(await mkvKeyframes(file, { start: info.start, duration: info.duration + 120, video: info.video! })).toBeNull();
  }, 60_000);

  it("picks the track whose picture ffprobe described when the file has several", async () => {
    const file = path.join(dir, "two.mkv");
    execFileSync(tools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24", "-f", "lavfi", "-i", "testsrc2=size=80x60:rate=12",
      "-t", "6", "-map", "0:v", "-map", "1:v", "-c:v", "libx264", "-preset", "ultrafast", "-g", "24", "-pix_fmt", "yuv420p", file]);
    const walked = await keyframes(tools, file);
    expect(await mkvKeyframes(file, { start: 0, duration: 6, video: { width: 160, height: 120 } })).toEqual(walked.map((at) => expect.closeTo(at, 5)));
    expect(await mkvKeyframes(file, { start: 0, duration: 6, video: { width: 10, height: 10 } })).toBeNull();
  }, 60_000);
});

describe("keyframes read ahead of the first play", () => {
  const SECRET = "video-secret-video-secret-0123456789";
  const headers = {
    "x-isputnik-gateway": SECRET,
    "x-isputnik-user-id": "admin",
    "x-isputnik-user-name": "admin",
    "x-isputnik-user-role": "admin",
    "x-isputnik-libraries": "lib_films"
  };
  let root: string;
  let dataDir: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-warm-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-warm-db-"));
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    // An MKV of H.264 plays with its picture copied (keyframes wanted); an MP4 of
    // H.264 and AAC plays as it is (none wanted).
    for (const name of ["Copied (2020)/Copied (2020).mkv", "Direct (2021)/Direct (2021).mp4"]) {
      const file = path.join(root, "Movies", ...name.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      encode(file);
      fs.utimesSync(file, hourAgo, hourAgo);
    }
    app = await buildApp({
      gatewaySecret: SECRET, devUser: null, dbPath: path.join(dataDir, "video.sqlite"), mediaRoot: root, version: "0.0.0-test", stage: null,
      scan: { settleMs: 60_000 }, tools, warmKeyframes: true, fastify: { logger: false }
    });
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_films", headers, payload: { name: "Films", kind: "movies", folder: "Movies" } });
    await app.scansSettled();
    await app.keyframesSettled();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("keeps the keyframes of a film whose picture is copied, and only of that one", () => {
    const db = new Database(path.join(dataDir, "video.sqlite"), { readonly: true });
    const rows = db.prepare(`
      SELECT m.title, p.keyframes FROM movies m LEFT JOIN media_probe p ON p.item_id = m.id ORDER BY m.title
    `).all() as { title: string; keyframes: string | null }[];
    db.close();
    expect(rows.map((row) => [row.title, row.keyframes === null ? null : JSON.parse(row.keyframes).length > 0])).toEqual([["Copied", true], ["Direct", null]]);
  });
});
