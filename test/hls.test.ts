// Converting what a browser can't play: the choice between direct, remux and
// transcode, the cuts and the playlist, and real segments cut by ffmpeg from a
// real (tiny) film with AC3 sound.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { decideDelivery } from "../src/delivery.js";
import { findTools, type MediaInfo } from "../src/ffmpeg.js";
import { buildPlan, ffmpegArgs, playlist, segmentStarts } from "../src/hls.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const info = (over: Partial<MediaInfo> & { vcodec?: string; pix?: string; acodec?: string }): MediaInfo => ({
  container: over.container ?? "matroska,webm",
  start: over.start ?? 0,
  duration: over.duration ?? 60,
  video: { index: 0, codec: over.vcodec ?? "h264", profile: "High", pixelFormat: over.pix ?? "yuv420p", width: 1920, height: 1080 },
  audio: over.acodec === "" ? [] : [{ index: 1, codec: over.acodec ?? "aac", channels: 6, language: "eng", title: null, default: true }]
});

describe("how a file plays", () => {
  it("sends MP4 and WebM with browser codecs as they are", () => {
    expect(decideDelivery(info({ container: "mov,mp4,m4a,3gp,3g2,mj2" }), ".mp4").mode).toBe("direct");
    expect(decideDelivery(info({ container: "matroska,webm", vcodec: "vp9", acodec: "opus" }), ".webm").mode).toBe("direct");
  });

  it("remuxes Matroska, converting only sound a browser can't decode", () => {
    const ac3 = decideDelivery(info({ acodec: "ac3" }), ".mkv");
    expect(ac3).toMatchObject({ mode: "remux", videoCopy: true, audioCopy: false });
    expect(ac3.reasons).toEqual(["container", "audio"]);
    expect(decideDelivery(info({ acodec: "aac" }), ".mkv")).toMatchObject({ mode: "remux", audioCopy: true, reasons: ["container"] });
    // An MP4 with AC3 sound: the picture is fine, the sound isn't.
    expect(decideDelivery(info({ container: "mov,mp4,m4a,3gp,3g2,mj2", acodec: "eac3" }), ".mp4"))
      .toMatchObject({ mode: "remux", reasons: ["audio"] });
  });

  it("transcodes a picture browsers can't show", () => {
    expect(decideDelivery(info({ vcodec: "hevc" }), ".mkv")).toMatchObject({ mode: "transcode", videoCopy: false });
    expect(decideDelivery(info({ container: "mov,mp4,m4a,3gp,3g2,mj2", pix: "yuv420p10le" }), ".mp4"))
      .toMatchObject({ mode: "transcode", reasons: ["video"] });
  });

  it("plays the default sound track", () => {
    const two = info({});
    two.audio = [
      { index: 1, codec: "ac3", channels: 6, language: "rus", title: null, default: false },
      { index: 2, codec: "aac", channels: 2, language: "eng", title: null, default: true }
    ];
    expect(decideDelivery(two, ".mkv")).toMatchObject({ audio: { index: 2 }, audioCopy: true });
  });
});

describe("the cuts and the playlist", () => {
  it("cuts on keyframes at least six seconds apart when the picture is copied", () => {
    const keys = [0, 2, 4, 6, 8, 10.4, 12, 20.8, 21, 29];
    expect(segmentStarts(info({ duration: 30 }), true, keys)).toEqual([0, 6, 12, 20.8]);
  });

  it("cuts on a six-second grid when the picture is re-encoded, from where the file's clock starts", () => {
    expect(segmentStarts(info({ duration: 20, start: 1.4 }), false, null)).toEqual([1.4, 7.4, 13.4]);
  });

  it("lists every segment with its length, and ends", () => {
    const plan = buildPlan("m1", "/media/film.mkv", info({ duration: 16 }), decideDelivery(info({ acodec: "ac3" }), ".mkv"), [0, 6.5, 13]);
    const text = playlist(plan);
    expect(text).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(text).toContain("#EXT-X-TARGETDURATION:7");
    expect(text.match(/#EXTINF:([\d.]+),/g)).toEqual(["#EXTINF:6.500,", "#EXTINF:6.500,", "#EXTINF:3.000,"]);
    expect(text.trim().endsWith("#EXT-X-ENDLIST")).toBe(true);
  });

  it("starts a later run just past its keyframe and splits relative to it", () => {
    const plan = buildPlan("m1", "/media/film.mkv", info({ duration: 30 }), decideDelivery(info({ acodec: "ac3" }), ".mkv"), [0, 6, 12, 18, 24]);
    const args = ffmpegArgs(plan, 2, "/tmp/s");
    expect(args[args.indexOf("-ss") + 1]).toBe("12.050");
    expect(args[args.indexOf("-segment_times") + 1]).toBe("5.700,11.700");
    expect(args[args.indexOf("-segment_start_number") + 1]).toBe("2");
    expect(args).toEqual(expect.arrayContaining(["-c:v", "copy", "-c:a", "aac", "-copyts"]));
  });
});

describe("real segments", () => {
  const SECRET = "video-secret-video-secret-0123456789";
  const headers = { "x-isputnik-gateway": SECRET, "x-isputnik-user-id": "mum", "x-isputnik-user-name": "Mum", "x-isputnik-user-role": "member", "x-isputnik-libraries": "lib_films" };
  const tools = findTools();
  let fixture: Fixture;
  let app: FastifyInstance;
  let filmId: string;

  beforeAll(async () => {
    fixture = makeFixture();
    // 20 seconds of H.264 with AC3 sound and a keyframe every 2 s: what a browser
    // shows without sound when sent as it is.
    const film = path.join(fixture.root, "Movies", "Loud Film (2020)", "Loud Film (2020).mkv");
    fs.mkdirSync(path.dirname(film), { recursive: true });
    execFileSync(tools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "20", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-c:a", "ac3", "-b:a", "192k", film]);
    const hourAgo = new Date(Date.now() - 3600_000);
    fs.utimesSync(film, hourAgo, hourAgo);

    app = await buildApp({ gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null, fastify: { logger: false } });
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_films", headers: { ...headers, "x-isputnik-user-role": "admin" }, payload: { name: "Films", kind: "movies", folder: "Movies" } });
    await app.scansSettled();
    const films = (await app.inject({ method: "GET", url: "/video/api/movies", headers })).json().items as { id: string; title: string }[];
    filmId = films.find((film) => film.title === "Loud Film")!.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    fixture?.cleanup();
  });

  it("offers the film as HLS, its sound converted", async () => {
    const play = (await app.inject({ method: "GET", url: `/video/api/play/${filmId}`, headers })).json();
    expect(play.playback).toMatchObject({ mode: "remux", reasons: ["container", "audio"], url: `/video/api/hls/${filmId}/index.m3u8` });
    expect(play.playback.duration).toBeCloseTo(20, 0);
  });

  it("cuts the segments the playlist lists, with AAC sound, wherever the player jumps", async () => {
    const list = await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/index.m3u8`, headers });
    expect(list.statusCode).toBe(200);
    expect(list.headers["content-type"]).toContain("application/vnd.apple.mpegurl");
    const lengths = [...list.body.matchAll(/#EXTINF:([\d.]+),/g)].map((match) => Number(match[1]));
    expect(lengths.length).toBe(3);
    expect(lengths.reduce((a, b) => a + b, 0)).toBeCloseTo(20, 0);

    // A jump to the third segment first, as a resume would, then the first.
    for (const n of [2, 0, 1]) {
      const segment = await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/${n}.ts`, headers });
      expect(segment.statusCode).toBe(200);
      expect(segment.headers["content-type"]).toBe("video/mp2t");
      const saved = path.join(fixture.root, `segment-${n}.ts`);
      fs.writeFileSync(saved, segment.rawPayload);
      const probed = JSON.parse(execFileSync(tools.ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", saved]).toString()) as {
        streams: { codec_type: string; codec_name: string; start_time: string }[];
      };
      expect(probed.streams.map((stream) => stream.codec_name).sort()).toEqual(["aac", "h264"]);
      const video = probed.streams.find((stream) => stream.codec_type === "video")!;
      // The file's own clock: segment n starts where the playlist says.
      const expected = lengths.slice(0, n).reduce((a, b) => a + b, 0);
      expect(Number(video.start_time)).toBeCloseTo(expected, 1);
    }
  }, 60_000);

  it("refuses a segment that isn't in the playlist, and someone who can't see the film", async () => {
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/99.ts`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/x.ts`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/index.m3u8`, headers: { ...headers, "x-isputnik-libraries": "" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/video/api/hls/${filmId}`, headers })).statusCode).toBe(204);
  });
});
