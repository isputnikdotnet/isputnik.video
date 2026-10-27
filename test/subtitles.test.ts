// Subtitles: the tracks inside a film and the files beside it, text ones served
// as WebVTT (a Windows-1251 SRT too), image ones burned into the picture.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { decideDelivery } from "../src/delivery.js";
import { findTools, type MediaInfo } from "../src/ffmpeg.js";
import { buildPlan, ffmpegArgs } from "../src/hls.js";
import { burnIndexOf, decodeSubtitleText, listSubtitles } from "../src/subtitles.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SRT_EN = "1\n00:00:01,000 --> 00:00:03,000\nHello there\n\n2\n00:00:05,000 --> 00:00:07,500\nGeneral Kenobi\n";
const SRT_RU = "1\n00:00:02,000 --> 00:00:04,000\nПривет, мир\n";

const withSubs = (codecs: string[], height = 1080): MediaInfo => ({
  container: "matroska,webm",
  start: 0,
  duration: 60,
  video: { index: 0, codec: "h264", profile: "High", pixelFormat: "yuv420p", width: 1920, height },
  audio: [{ index: 1, codec: "aac", channels: 2, language: "eng", title: null, default: true }],
  subtitles: codecs.map((codec, n) => ({ index: n + 2, codec, language: n === 0 ? "eng" : "und", title: null, default: false, forced: false, width: codec === "hdmv_pgs_subtitle" ? 1920 : 0, height: codec === "hdmv_pgs_subtitle" ? 1080 : 0 }))
});

describe("which subtitles a film offers", () => {
  it("lists text and image tracks inside the file, skipping what can't be shown", () => {
    const tracks = listSubtitles(withSubs(["subrip", "hdmv_pgs_subtitle", "eia_608"]), "/nowhere/film.mkv");
    expect(tracks).toMatchObject([
      { id: "s2", kind: "text", language: "eng", external: false },
      { id: "s3", kind: "image", language: null }
    ]);
    expect(burnIndexOf(tracks, "s3")).toBe(3);
    // A text track is never burned in.
    expect(burnIndexOf(tracks, "s2")).toBeNull();
  });

  it("burns an image subtitle in: the picture is re-encoded with it drawn over", () => {
    const info = withSubs(["hdmv_pgs_subtitle"], 800);
    const delivery = decideDelivery(info, ".mkv", null, 2);
    expect(delivery).toMatchObject({ mode: "transcode", videoCopy: false, burn: { index: 2 } });
    expect(delivery.reasons).toContain("subtitles");
    const args = ffmpegArgs(buildPlan("m1", "/media/film.mkv", info, delivery, null), 0, "/tmp/s");
    // The 1080p canvas fitted to the cropped 1920x800 picture first.
    expect(args[args.indexOf("-filter_complex") + 1]).toBe("[0:2]scale=1920:800[sub];[0:0][sub]overlay=eof_action=pass[v]");
    expect(args[args.indexOf("-filter_complex") + 2]).toBe("-map");
    expect(args[args.indexOf("-filter_complex") + 3]).toBe("[v]");
    expect(args).not.toContain("-vf");
    // A direct MP4 goes HLS once something is burned in; without, it stays direct.
    const mp4 = { ...withSubs(["dvd_subtitle"]), container: "mov,mp4,m4a,3gp,3g2,mj2" };
    expect(decideDelivery(mp4, ".mp4").mode).toBe("direct");
    expect(decideDelivery(mp4, ".mp4", null, 2).mode).toBe("transcode");
  });

  it("reads Windows-1251 as such and leaves UTF-8 alone", () => {
    const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    expect(decodeSubtitleText(cp1251).toString("utf8")).toBe("Привет");
    expect(decodeSubtitleText(Buffer.from("﻿Привет", "utf8")).toString("utf8")).toBe("Привет");
  });
});

describe("real subtitles", () => {
  const SECRET = "video-secret-video-secret-0123456789";
  const headers = { "x-isputnik-gateway": SECRET, "x-isputnik-user-id": "mum", "x-isputnik-user-name": "Mum", "x-isputnik-user-role": "member", "x-isputnik-libraries": "lib_films" };
  const tools = findTools();
  let fixture: Fixture;
  let app: FastifyInstance;
  let filmId: string;

  beforeAll(async () => {
    fixture = makeFixture();
    // An MP4 a browser plays as it is, with an English text track inside it, a
    // Russian SRT beside it in Windows-1251 and a forced English one.
    const dir = path.join(fixture.root, "Movies", "Talking Film (2021)");
    fs.mkdirSync(dir, { recursive: true });
    const srt = path.join(dir, "inside.srt");
    fs.writeFileSync(srt, SRT_EN);
    const film = path.join(dir, "Talking Film (2021).mp4");
    execFileSync(tools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-i", srt, "-t", "10", "-map", "0:v", "-map", "1:a", "-map", "2:s", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-c:s", "mov_text",
      "-metadata:s:s:0", "language=eng", film]);
    fs.rmSync(srt);
    // Cyrillic А–я sit at 0xC0–0xFF in Windows-1251.
    fs.writeFileSync(path.join(dir, "Talking Film (2021).ru.srt"), Buffer.from([...SRT_RU].map((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x410 && code <= 0x44f ? code - 0x410 + 0xc0 : code;
    })));
    fs.writeFileSync(path.join(dir, "Talking Film (2021).en.forced.srt"), SRT_EN);
    // Another film's subtitles: not this one's.
    fs.writeFileSync(path.join(dir, "Talking Film (2021) - Extras.srt"), SRT_EN);
    const hourAgo = new Date(Date.now() - 3600_000);
    for (const name of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, name), hourAgo, hourAgo);

    app = await buildApp({ gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null, fastify: { logger: false } });
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_films", headers: { ...headers, "x-isputnik-user-role": "admin" }, payload: { name: "Films", kind: "movies", folder: "Movies" } });
    await app.scansSettled();
    const films = (await app.inject({ method: "GET", url: "/video/api/movies", headers })).json().items as { id: string; title: string }[];
    filmId = films.find((film) => film.title === "Talking Film")!.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    fixture?.cleanup();
  });

  it("offers the track inside and the files beside, and still plays the film as it is", async () => {
    const play = (await app.inject({ method: "GET", url: `/video/api/play/${filmId}`, headers })).json();
    expect(play.playback.mode).toBe("direct");
    expect(play.subtitleTracks).toHaveLength(3);
    expect(play.subtitleTracks[0]).toMatchObject({ id: "s2", kind: "text", codec: "mov_text", language: "eng", external: false, url: `/video/api/subtitles/${filmId}/s2.vtt`, burned: false });
    const beside = play.subtitleTracks.slice(1);
    expect(beside).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "text", language: "ru", forced: false, external: true }),
      expect.objectContaining({ kind: "text", language: "en", forced: true, external: true })
    ]));
    for (const track of beside) expect(track.id).toMatch(/^x[0-9a-f]{10}$/);
  });

  it("serves each as WebVTT, timed from the start of the film", async () => {
    const play = (await app.inject({ method: "GET", url: `/video/api/play/${filmId}`, headers })).json();
    const inside = await app.inject({ method: "GET", url: play.subtitleTracks[0].url, headers });
    expect(inside.statusCode).toBe(200);
    expect(inside.headers["content-type"]).toBe("text/vtt; charset=utf-8");
    expect(inside.body.startsWith("WEBVTT")).toBe(true);
    expect(inside.body).toContain("00:01.000 --> 00:03.000");
    expect(inside.body).toContain("General Kenobi");

    const russian = play.subtitleTracks.find((track: { language: string }) => track.language === "ru");
    const text = await app.inject({ method: "GET", url: russian.url, headers });
    expect(text.statusCode).toBe(200);
    expect(text.body).toContain("Привет, мир");
    expect(text.body).toContain("00:02.000 --> 00:04.000");
  }, 60_000);

  it("refuses a track the film doesn't have, and someone who can't see it", async () => {
    expect((await app.inject({ method: "GET", url: `/video/api/subtitles/${filmId}/s9.vtt`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/video/api/subtitles/${filmId}/../../x.vtt`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/video/api/subtitles/${filmId}/s2.vtt`, headers: { ...headers, "x-isputnik-libraries": "" } })).statusCode).toBe(404);
    // Asking to burn in a text track changes nothing.
    expect((await app.inject({ method: "GET", url: `/video/api/play/${filmId}?subtitle=s2`, headers })).json().playback.mode).toBe("direct");
    expect((await app.inject({ method: "GET", url: `/video/api/play/${filmId}?subtitle=nope`, headers })).statusCode).toBe(400);
  });
});
