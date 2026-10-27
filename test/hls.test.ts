// Converting what a browser can't play: the choice between direct, remux and
// transcode, the cuts and the playlist, and real segments cut by ffmpeg from a
// real (tiny) film with AC3 sound.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { decideDelivery } from "../src/delivery.js";
import { findTools, keyframes, probe, type MediaInfo } from "../src/ffmpeg.js";
import { HlsSessions, buildPlan, ffmpegArgs, playlist, prepareRoot, segmentStarts } from "../src/hls.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const info = (over: Partial<MediaInfo> & { vcodec?: string; pix?: string; acodec?: string }): MediaInfo => ({
  container: over.container ?? "matroska,webm",
  start: over.start ?? 0,
  duration: over.duration ?? 60,
  video: { index: 0, codec: over.vcodec ?? "h264", profile: "High", pixelFormat: over.pix ?? "yuv420p", width: 1920, height: 1080 },
  audio: over.acodec === "" ? [] : [{ index: 1, codec: over.acodec ?? "aac", channels: 6, language: "eng", title: null, default: true }],
  subtitles: []
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

  it("sends a file with more than one sound track as HLS, since a page can't choose among them", () => {
    const mp4 = info({ container: "mov,mp4,m4a,3gp,3g2,mj2" });
    mp4.audio.push({ index: 2, codec: "aac", channels: 2, language: "rus", title: null, default: false });
    expect(decideDelivery(mp4, ".mp4")).toMatchObject({ mode: "remux", audio: { index: 1 }, audioCopy: true });
    expect(decideDelivery(mp4, ".mp4", 2)).toMatchObject({ mode: "remux", audio: { index: 2 } });
    // A track the file doesn't have: the default one.
    expect(decideDelivery(mp4, ".mp4", 7)).toMatchObject({ audio: { index: 1 } });
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

describe("the transcode folder", () => {
  const quiet = { info: () => undefined, warn: () => undefined };

  it("is emptied, never removed: in the image it is a mount point this user can't remove", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-root-"));
    fs.mkdirSync(path.join(root, "s-left-behind"));
    fs.writeFileSync(path.join(root, "s-left-behind", "3.ts"), "x");
    const inode = fs.statSync(root).ino;
    expect(prepareRoot(root, quiet)).toBe(root);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(fs.statSync(root).ino).toBe(inode);
    const sessions = new HlsSessions(findTools(), root, quiet);
    sessions.close();
    expect(fs.existsSync(root)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("falls back to a temporary folder, saying so, when it can't be written to", () => {
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-root-")), "a-file");
    fs.writeFileSync(blocker, "not a folder");
    const warnings: string[] = [];
    const log = { info: () => undefined, warn: (_obj: object, msg: string) => { warnings.push(msg); } };
    expect(prepareRoot(path.join(blocker, "transcode"), log)).toBeNull();
    const sessions = new HlsSessions(findTools(), path.join(blocker, "transcode"), log);
    expect(warnings[0]).toMatch(/using a temporary folder/);
    sessions.close();
    fs.rmSync(path.dirname(blocker), { recursive: true, force: true });
  });
});

describe("seeking", () => {
  const quiet = { info: () => undefined, warn: () => undefined };
  const tools = findTools();
  let dir: string;
  let plan: ReturnType<typeof buildPlan>;

  beforeAll(async () => {
    // A minute of tiny picture with AC3 sound, a keyframe every second: ten segments.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-seek-"));
    const film = path.join(dir, "film.mkv");
    execFileSync(tools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=12", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "60", "-c:v", "libx264", "-preset", "ultrafast", "-g", "12", "-c:a", "ac3", film]);
    const info = await probe(tools, film);
    plan = buildPlan("seek", film, info, decideDelivery(info, ".mkv"), await keyframes(tools, film));
  }, 60_000);

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("lets the newest request move the run: one still waiting behind it gives way instead of dragging it back", async () => {
    expect(plan.starts.length).toBeGreaterThanOrEqual(9);
    const sessions = new HlsSessions(tools, null, quiet);
    try {
      const started = Date.now();
      // The jump goes first; the request it replaces is still waiting, further back.
      const jump = sessions.segment("mum:seek", plan, 8);
      const behind = sessions.segment("mum:seek", plan, 1);
      const [far, near] = await Promise.allSettled([jump, behind]);
      // The older one either got its segment in passing or stood aside; before,
      // the two restarted ffmpeg in turn until both gave up after 45 seconds.
      if (far.status === "rejected") expect((far.reason as Error).message).toBe("Superseded");
      expect(near.status).toBe("fulfilled");
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      sessions.close();
    }
  }, 60_000);

  it("stops waiting once the player hangs up", async () => {
    const sessions = new HlsSessions(tools, null, quiet);
    try {
      const gone = new AbortController();
      gone.abort();
      await expect(sessions.segment("mum:seek", plan, 6, { signal: gone.signal })).rejects.toThrow("Cancelled");
    } finally {
      sessions.close();
    }
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
      "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000",
      "-t", "20", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48",
      "-c:a:0", "ac3", "-b:a:0", "192k", "-c:a:1", "aac", "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=rus",
      "-metadata:s:a:1", "title=Дубляж", "-disposition:a:0", "default", "-disposition:a:1", "0", film]);
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
    expect(play.playback).toMatchObject({ mode: "remux", reasons: ["container", "audio"], url: `/video/api/hls/${filmId}/t1/index.m3u8` });
    expect(play.audioTracks).toMatchObject([
      { index: 1, codec: "ac3", language: "eng", default: true, selected: true },
      { index: 2, codec: "aac", language: "rus", title: "Дубляж", default: false, selected: false }
    ]);
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

  it("plays the sound track chosen, and refuses one the film doesn't have", async () => {
    const play = (await app.inject({ method: "GET", url: `/video/api/play/${filmId}?audio=2`, headers })).json();
    expect(play.playback.url).toBe(`/video/api/hls/${filmId}/t2/index.m3u8`);
    expect(play.audioTracks.find((track: { selected: boolean }) => track.selected).index).toBe(2);

    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/t2/index.m3u8`, headers })).statusCode).toBe(200);
    const segment = await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/t2/1.ts`, headers });
    expect(segment.statusCode).toBe(200);
    const saved = path.join(fixture.root, "segment-t2.ts");
    fs.writeFileSync(saved, segment.rawPayload);
    const probed = JSON.parse(execFileSync(tools.ffprobe, ["-v", "error", "-show_streams", "-of", "json", saved]).toString()) as {
      streams: { codec_type: string; channels?: number }[];
    };
    const sound = probed.streams.filter((stream) => stream.codec_type === "audio");
    // Only the one chosen: the Russian AAC, copied as it is (mono), not the
    // English AC3 converted to stereo.
    expect(sound).toHaveLength(1);
    expect(sound[0].channels).toBe(1);

    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/t9/index.m3u8`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/tx/index.m3u8`, headers })).statusCode).toBe(404);
  }, 60_000);

  const adminHeaders = { ...headers, "x-isputnik-user-id": "admin", "x-isputnik-user-role": "admin" };
  const conversion = async () => (await app.inject({ method: "GET", url: "/video/api/admin/conversion", headers: adminHeaders })).json();
  const setConversion = (payload: object) => app.inject({ method: "PUT", url: "/video/api/admin/conversion", headers: adminHeaders, payload });

  it("keeps finished segments in memory, and on the disk when the admin gives none", async () => {
    await app.inject({ method: "DELETE", url: `/video/api/hls/${filmId}`, headers });
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/0.ts`, headers })).statusCode).toBe(200);
    let state = await conversion();
    expect(state.settings).toEqual({ memoryPerViewerMb: 300, maxViewers: 3, whenFull: "disk" });
    expect(state.usage.viewers).toMatchObject([{ user: "Mum", title: "Loud Film", mode: "remux" }]);
    expect(state.usage.memoryBytes).toBeGreaterThan(0);
    expect(state.usage.diskBytes).toBe(0);

    expect((await setConversion({ memoryPerViewerMb: 0, maxViewers: 3, whenFull: "disk" })).statusCode).toBe(200);
    await app.inject({ method: "DELETE", url: `/video/api/hls/${filmId}`, headers });
    const segment = await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/1.ts`, headers });
    expect(segment.statusCode).toBe(200);
    expect(Number(segment.headers["content-length"])).toBe(segment.rawPayload.length);
    state = await conversion();
    expect(state.usage.memoryBytes).toBe(0);
    expect(state.usage.diskBytes).toBeGreaterThan(0);
    await app.inject({ method: "DELETE", url: `/video/api/hls/${filmId}`, headers });
    await setConversion({ memoryPerViewerMb: 300, maxViewers: 3, whenFull: "disk" });
  }, 60_000);

  it("turns away a viewer past the admin's limit, and lets them in once a place is free", async () => {
    await setConversion({ memoryPerViewerMb: 300, maxViewers: 1, whenFull: "wait" });
    const dad = { ...headers, "x-isputnik-user-id": "dad", "x-isputnik-user-name": "Dad" };
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/0.ts`, headers })).statusCode).toBe(200);

    expect((await app.inject({ method: "GET", url: `/video/api/play/${filmId}`, headers: dad })).json().playback.busy).toEqual({ limit: 1 });
    const refused = await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/index.m3u8`, headers: dad });
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ code: "busy", limit: 1 });
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/0.ts`, headers: dad })).json().code).toBe("busy");
    // Mum, already watching, carries on.
    expect((await app.inject({ method: "GET", url: `/video/api/play/${filmId}`, headers })).json().playback.busy).toBeNull();
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/1.ts`, headers })).statusCode).toBe(200);

    await app.inject({ method: "DELETE", url: `/video/api/hls/${filmId}`, headers });
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/0.ts`, headers: dad })).statusCode).toBe(200);
    await app.inject({ method: "DELETE", url: `/video/api/hls/${filmId}`, headers: dad });
    await setConversion({ memoryPerViewerMb: 300, maxViewers: 3, whenFull: "disk" });
  }, 60_000);

  it("keeps the admin's settings, refuses ones out of range, and lets only an admin near them", async () => {
    expect((await setConversion({ memoryPerViewerMb: 512, maxViewers: 2, whenFull: "wait" })).json().settings)
      .toEqual({ memoryPerViewerMb: 512, maxViewers: 2, whenFull: "wait" });
    expect((await conversion()).settings.memoryPerViewerMb).toBe(512);
    expect((await setConversion({ memoryPerViewerMb: -1, maxViewers: 2, whenFull: "wait" })).statusCode).toBe(400);
    expect((await setConversion({ memoryPerViewerMb: 100, maxViewers: 0, whenFull: "wait" })).statusCode).toBe(400);
    expect((await setConversion({ memoryPerViewerMb: 100, maxViewers: 2, whenFull: "swap" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/video/api/admin/conversion", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/video/api/admin/conversion", headers, payload: { memoryPerViewerMb: 1, maxViewers: 1, whenFull: "disk" } })).statusCode).toBe(403);
    const events = (await app.inject({ method: "GET", url: "/video/api/admin/events?event=conversion.changed", headers: adminHeaders })).json();
    expect(events.events[0].detail).toBe("Up to 2 viewer(s) converting, 512 MB of memory each, then waiting");
    await setConversion({ memoryPerViewerMb: 300, maxViewers: 3, whenFull: "disk" });
  });

  it("refuses a segment that isn't in the playlist, and someone who can't see the film", async () => {
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/99.ts`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/x.ts`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/index.m3u8`, headers: { ...headers, "x-isputnik-libraries": "" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/video/api/hls/${filmId}`, headers })).statusCode).toBe(204);
  });
});
