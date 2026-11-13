// Converting what a browser can't play: the choice between direct, remux and
// transcode, the cuts and the playlist, and real segments cut by ffmpeg from a
// real (tiny) film with AC3 sound.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { decideDelivery } from "../src/delivery.js";
import { findTools, keyframes, probe, type MediaInfo } from "../src/ffmpeg.js";
import { DEFAULT_CONVERSION, HlsSessions, HlsSupersededError, buildPlan, ffmpegArgs, playlist, prepareRoot, segmentStarts } from "../src/hls.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const info = (over: Partial<MediaInfo> & { vcodec?: string; pix?: string; acodec?: string; height?: number }): MediaInfo => ({
  container: over.container ?? "matroska,webm",
  start: over.start ?? 0,
  duration: over.duration ?? 60,
  bitRate: over.bitRate ?? null,
  video: { index: 0, codec: over.vcodec ?? "h264", profile: "High", pixelFormat: over.pix ?? "yuv420p", width: Math.round(((over.height ?? 1080) * 16) / 9), height: over.height ?? 1080, colorTransfer: null, colorPrimaries: null },
  audio: over.acodec === "" ? [] : [{ index: 1, codec: over.acodec ?? "aac", channels: 6, language: "eng", title: null, default: true }],
  subtitles: [],
  chapters: []
});

const MP4 = "mov,mp4,m4a,3gp,3g2,mj2";

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

  it("re-encodes a picture taller or heavier than the rung asked, and leaves one under it as it is", () => {
    // A 1080p MP4 at 6 Mbit/s asked at 720p: taller than the rung.
    expect(decideDelivery(info({ container: MP4, bitRate: 6_000_000 }), ".mp4", null, null, 720))
      .toMatchObject({ mode: "transcode", videoCopy: false, reasons: ["size"], rung: 720 });
    // A 720p MP4 at 2 Mbit/s asked at 720p: nothing to shrink, sent as it is.
    expect(decideDelivery(info({ container: MP4, bitRate: 2_000_000, height: 720 }), ".mp4", null, null, 720))
      .toMatchObject({ mode: "direct", rung: 720 });
    // A 1080p Blu-ray remux at 28 Mbit/s asked at 1080p: heavier than the most the rung makes (10).
    expect(decideDelivery(info({ bitRate: 28_000_000 }), ".mkv", null, null, 1080))
      .toMatchObject({ mode: "transcode", videoCopy: false, reasons: ["container", "size"] });
    // The same film at 9 Mbit/s: under the most, copied as today.
    expect(decideDelivery(info({ bitRate: 9_000_000 }), ".mkv", null, null, 1080)).toMatchObject({ mode: "remux", videoCopy: true, rung: 1080 });
    // No rung: exactly today's decision, whatever the size.
    expect(decideDelivery(info({ bitRate: 28_000_000 }), ".mkv")).toMatchObject({ mode: "remux", rung: null });
    // A file whose bitrate isn't known is judged by its height alone.
    expect(decideDelivery(info({ container: MP4, height: 480 }), ".mp4", null, null, 480)).toMatchObject({ mode: "direct" });
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

  it("keeps copied sound from starting before a re-encoded picture, and leaves a copied picture its keyframe", () => {
    const reencoded = buildPlan("m1", "/media/film.mkv", info({ duration: 30, vcodec: "hevc", acodec: "aac" }), decideDelivery(info({ vcodec: "hevc", acodec: "aac" }), ".mkv"), null);
    expect(ffmpegArgs(reencoded, 2, "/tmp/s")).toEqual(expect.arrayContaining(["-c:a", "copy", "-copypriorss", "0"]));

    const copied = buildPlan("m1", "/media/film.mkv", info({ duration: 30, acodec: "aac" }), decideDelivery(info({ acodec: "aac" }), ".mkv"), [0, 6, 12, 18, 24]);
    expect(ffmpegArgs(copied, 2, "/tmp/s")).not.toContain("-copypriorss");

    const converted = buildPlan("m1", "/media/film.mkv", info({ duration: 30, vcodec: "hevc", acodec: "ac3" }), decideDelivery(info({ vcodec: "hevc", acodec: "ac3" }), ".mkv"), null);
    expect(ffmpegArgs(converted, 2, "/tmp/s")).not.toContain("-copypriorss");
  });

  it("starts a later run just past its keyframe and splits relative to it", () => {
    const plan = buildPlan("m1", "/media/film.mkv", info({ duration: 30 }), decideDelivery(info({ acodec: "ac3" }), ".mkv"), [0, 6, 12, 18, 24]);
    const args = ffmpegArgs(plan, 2, "/tmp/s");
    expect(args[args.indexOf("-ss") + 1]).toBe("12.050");
    expect(args[args.indexOf("-segment_times") + 1]).toBe("5.700,11.700");
    expect(args[args.indexOf("-segment_start_number") + 1]).toBe("2");
    expect(args).toEqual(expect.arrayContaining(["-c:v", "copy", "-c:a", "aac", "-copyts"]));
  });

  it("scales to the rung asked and spends what it allows, on the CPU and on the GPU", () => {
    const film = info({ bitRate: 28_000_000, acodec: "ac3" });
    const at720 = buildPlan("m1", "/media/film.mkv", film, decideDelivery(film, ".mkv", null, null, 720), null);
    const cpu = ffmpegArgs(at720, 0, "/tmp/s");
    expect(cpu[cpu.indexOf("-vf") + 1]).toBe("scale=-2:720");
    expect(cpu).toEqual(expect.arrayContaining(["-c:v", "libx264", "-maxrate", "4M", "-bufsize", "8M", "-b:a", "128k"]));
    const gpu = ffmpegArgs(at720, 0, "/tmp/s", { device: "/dev/dri/renderD128", decode: true });
    expect(gpu[gpu.indexOf("-vf") + 1]).toBe("scale_vaapi=w=1280:h=720:format=nv12");
    expect(gpu).toEqual(expect.arrayContaining(["-c:v", "h264_vaapi", "-b:v", "3M", "-maxrate", "4M", "-bufsize", "8M"]));

    const at480 = buildPlan("m1", "/media/film.mkv", film, decideDelivery(film, ".mkv", null, null, 480), null);
    expect(ffmpegArgs(at480, 0, "/tmp/s")).toEqual(expect.arrayContaining(["scale=-2:480", "-maxrate", "2M", "-bufsize", "4M", "-b:a", "96k"]));
    // 1080p is what a conversion made before there were rungs.
    const at1080 = buildPlan("m1", "/media/film.mkv", film, decideDelivery(film, ".mkv", null, null, 1080), null);
    expect(ffmpegArgs(at1080, 0, "/tmp/s")).toEqual(expect.arrayContaining(["-maxrate", "10M", "-bufsize", "20M", "-b:a", "192k"]));
    expect(ffmpegArgs(at1080, 0, "/tmp/s")).not.toContain("-vf");
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

  // A killed ffmpeg lets go of the film a moment later on Windows.
  afterAll(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

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

  it("starts a new run for another quality rung, re-encoding a picture the rung says is too heavy", async () => {
    const sessions = new HlsSessions(tools, null, quiet);
    try {
      await sessions.segment("mum:seek", plan, 0);
      expect(sessions.usage().viewers[0]).toMatchObject({ mode: "remux", rung: null, converter: null });
      // The same film said to be 50 Mbit/s: above the 480p rung, so the picture is re-encoded.
      const heavy = { ...plan.info, bitRate: 50_000_000 };
      const smaller = buildPlan("seek", plan.file, heavy, decideDelivery(heavy, ".mkv", null, null, 480), null);
      expect(smaller.delivery).toMatchObject({ mode: "transcode", videoCopy: false, rung: 480 });
      const made = await sessions.segment("mum:seek", smaller, 0);
      expect("data" in made ? made.data.length : made.size).toBeGreaterThan(0);
      expect(sessions.usage().viewers).toHaveLength(1);
      expect(sessions.usage().viewers[0]).toMatchObject({ mode: "transcode", rung: 480, converter: "cpu" });
    } finally {
      sessions.close();
    }
  }, 60_000);

  it("lets the playlist asked for last decide the version: a request left over from before a switch is turned away, not given the run", async () => {
    let converting = 0;
    const counting = { info: (_obj: object, msg: string) => { if (msg === "Converting") converting += 1; }, warn: () => undefined };
    const sessions = new HlsSessions(tools, null, counting);
    try {
      const heavy = { ...plan.info, bitRate: 50_000_000 };
      const smaller = buildPlan("seek", plan.file, heavy, decideDelivery(heavy, ".mkv", null, null, 480), null);
      sessions.choose("mum:seek", plan);
      // Stopped by the switch: what it waited for is not wanted any more.
      const old = sessions.segment("mum:seek", plan, 3).catch(() => undefined);
      // Another quality chosen while segment 3 is on its way: its playlist first, then its segment.
      sessions.choose("mum:seek", smaller);
      const fresh = sessions.segment("mum:seek", smaller, 0);
      // The old one asked again (a player or a proxy retrying) stands aside at once.
      await expect(sessions.segment("mum:seek", plan, 3)).rejects.toBeInstanceOf(HlsSupersededError);
      await fresh;
      await old;
      // Before, the two kept stopping each other's ffmpeg: 21 runs in 1.6 s (issue 3).
      expect(converting).toBe(2);
      // Switching back asks for the first playlist again, and is that version once more.
      sessions.choose("mum:seek", plan);
      await sessions.segment("mum:seek", plan, 3);
      expect(converting).toBe(3);
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
      // A player already gone holds nothing for later.
      expect(sessions.usage().viewers).toEqual([]);
    } finally {
      sessions.close();
    }
  });

  it("does not start a film again for a request from before the player left", async () => {
    const sessions = new HlsSessions(tools, null, quiet);
    try {
      const asked = Date.now() - 1;
      sessions.leave("mum:seek");
      await expect(sessions.segment("mum:seek", plan, 0, { asked })).rejects.toThrow("Stopped");
      expect(sessions.refusal("mum:other")).toBeNull();
      // Coming back to it afterwards is a new request.
      await expect(sessions.segment("mum:seek", plan, 0, { asked: Date.now() + 1 })).resolves.toBeTruthy();
    } finally {
      sessions.close();
    }
  }, 60_000);

  it("refuses a second film only while the first is being watched, and frees its place", async () => {
    const sessions = new HlsSessions(tools, null, quiet);
    const now = vi.spyOn(Date, "now");
    try {
      await sessions.segment("mum:seek", plan, 0, { who: { user: "Mum", title: "First" } });
      expect(sessions.refusal("mum:other")).toMatchObject({ reason: "person", title: "First" });
      expect(sessions.refusal("dad:other")).toBeNull();

      // Nothing asked for a while: closed, or paused. The film after it goes ahead.
      const later = Date.now() + 21_000;
      now.mockReturnValue(later);
      expect(sessions.refusal("mum:other")).toBeNull();
      sessions.configure({ ...DEFAULT_CONVERSION, maxViewers: 1 });
      expect(sessions.refusal("mum:other")).toBeNull();
      expect(sessions.refusal("dad:other")).toMatchObject({ reason: "household" });

      await sessions.segment("mum:other", plan, 0, { who: { user: "Mum", title: "Second" } });
      expect(sessions.usage().viewers.map((viewer) => viewer.title)).toEqual(["Second"]);
    } finally {
      now.mockRestore();
      sessions.close();
    }
  }, 60_000);
});

describe("real segments", () => {
  const SECRET = "video-secret-video-secret-0123456789";
  const headers = { "x-isputnik-gateway": SECRET, "x-isputnik-user-id": "mum", "x-isputnik-user-name": "Mum", "x-isputnik-user-role": "member", "x-isputnik-libraries": "lib_films" };
  const tools = findTools();
  let fixture: Fixture;
  let app: FastifyInstance;
  let filmId: string;
  let secondId: string;

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
    // The same again under another name: a second film to convert.
    const second = path.join(fixture.root, "Movies", "Second Film (2021)", "Second Film (2021).mkv");
    fs.mkdirSync(path.dirname(second), { recursive: true });
    fs.copyFileSync(film, second);
    fs.utimesSync(second, hourAgo, hourAgo);

    app = await buildApp({ gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, transcodeDir: path.join(fixture.root, ".transcode"), isMapped: () => true, version: "0.0.0-test", stage: null, fastify: { logger: false } });
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_films", headers: { ...headers, "x-isputnik-user-role": "admin" }, payload: { name: "Films", kind: "movies", folder: "Movies" } });
    await app.scansSettled();
    const films = (await app.inject({ method: "GET", url: "/video/api/movies", headers })).json().items as { id: string; title: string }[];
    filmId = films.find((film) => film.title === "Loud Film")!.id;
    secondId = films.find((film) => film.title === "Second Film")!.id;
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

  it("holds a viewer on the internet under the admin's rung, and lets one at home have the file as it is", async () => {
    const away = { ...headers, "x-isputnik-network": "internet" };
    // At home, nothing asked: the original, with every rung on offer.
    const home = (await app.inject({ method: "GET", url: `/video/api/play/${filmId}`, headers })).json();
    expect(home.playback.quality).toEqual({ current: null, allowed: [null, 1080, 720, 480], network: "home" });
    expect(home.playback.url).toBe(`/video/api/hls/${filmId}/t1/index.m3u8`);
    // At home, a rung asked: the address carries it. This film is 240p at a few
    // hundred kbit/s, so there is nothing to shrink and the sound alone is converted.
    const small = (await app.inject({ method: "GET", url: `/video/api/play/${filmId}?quality=480`, headers })).json();
    expect(small.playback).toMatchObject({ mode: "remux", url: `/video/api/hls/${filmId}/t1q480/index.m3u8`, quality: { current: 480 } });
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/t1q480/index.m3u8`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/t1q360/index.m3u8`, headers })).statusCode).toBe(404);

    // Away: the cap (720p to start with) is the default and the most; lower is theirs to pick.
    const capped = (await app.inject({ method: "GET", url: `/video/api/play/${filmId}`, headers: away })).json();
    expect(capped.playback.quality).toEqual({ current: 720, allowed: [720, 480], network: "internet" });
    expect(capped.playback.url).toBe(`/video/api/hls/${filmId}/t1q720/index.m3u8`);
    expect((await app.inject({ method: "GET", url: `/video/api/play/${filmId}?quality=original`, headers: away })).json().playback.quality.current).toBe(720);
    expect((await app.inject({ method: "GET", url: `/video/api/play/${filmId}?quality=480`, headers: away })).json().playback.quality.current).toBe(480);
    // The uncapped address is not theirs.
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/t1/index.m3u8`, headers: away })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/t1q1080/index.m3u8`, headers: away })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/t1q720/index.m3u8`, headers: away })).statusCode).toBe(200);

    // The admin lowers the cap, then lifts it.
    const adminHeaders = { ...headers, "x-isputnik-user-id": "admin", "x-isputnik-user-role": "admin" };
    const set = (remoteQuality: number | null) => app.inject({ method: "PUT", url: "/video/api/admin/conversion", headers: adminHeaders, payload: { remoteQuality } });
    expect((await set(480)).json().settings.remoteQuality).toBe(480);
    expect((await app.inject({ method: "GET", url: `/video/api/play/${filmId}`, headers: away })).json().playback.quality).toEqual({ current: 480, allowed: [480], network: "internet" });
    expect((await set(null)).json().settings.remoteQuality).toBeNull();
    expect((await app.inject({ method: "GET", url: `/video/api/play/${filmId}`, headers: away })).json().playback.quality).toEqual({ current: null, allowed: [null, 1080, 720, 480], network: "internet" });
    await set(720);
    await app.inject({ method: "DELETE", url: `/video/api/hls/${filmId}`, headers });
  }, 60_000);

  const adminHeaders = { ...headers, "x-isputnik-user-id": "admin", "x-isputnik-user-role": "admin" };
  const conversion = async () => (await app.inject({ method: "GET", url: "/video/api/admin/conversion", headers: adminHeaders })).json();
  /** The conversion's state once `ready` holds: the run carries on past the segment
   *  asked for, and each new one sits on the disk until it is read into memory, so a
   *  single look can land in between (it failed the v0.38.0 image build that way). */
  const conversionOnce = async (ready: (state: Awaited<ReturnType<typeof conversion>>) => boolean) => {
    const until = Date.now() + 10_000;
    let state = await conversion();
    while (!ready(state) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = await conversion();
    }
    return state;
  };
  const setConversion = (payload: object) => app.inject({ method: "PUT", url: "/video/api/admin/conversion", headers: adminHeaders, payload });

  it("keeps finished segments in memory, and on the disk when the admin gives none", async () => {
    await app.inject({ method: "DELETE", url: `/video/api/hls/${filmId}`, headers });
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/0.ts`, headers })).statusCode).toBe(200);
    let state = await conversionOnce((now) => now.usage.diskBytes === 0);
    expect(state.settings).toMatchObject({ storage: "memory-disk", memoryMb: DEFAULT_CONVERSION.memoryMb, maxViewers: 3, hardware: "auto", remoteQuality: 720 });
    expect(state.disk).toMatchObject({ mapped: true });
    expect(state.storage).toBe("memory-disk");
    expect(state.usage.viewers).toMatchObject([{ user: "Mum", title: "Loud Film", mode: "remux" }]);
    expect(state.usage.memoryBytes).toBeGreaterThan(0);
    expect(state.usage.diskBytes).toBe(0);

    expect((await setConversion({ storage: "disk" })).statusCode).toBe(200);
    await app.inject({ method: "DELETE", url: `/video/api/hls/${filmId}`, headers });
    const segment = await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/1.ts`, headers });
    expect(segment.statusCode).toBe(200);
    expect(Number(segment.headers["content-length"])).toBe(segment.rawPayload.length);
    state = await conversionOnce((now) => now.usage.memoryBytes === 0);
    expect(state.usage.memoryBytes).toBe(0);
    expect(state.usage.diskBytes).toBeGreaterThan(0);
    await app.inject({ method: "DELETE", url: `/video/api/hls/${filmId}`, headers });
    await setConversion({ storage: "memory-disk", memoryMb: DEFAULT_CONVERSION.memoryMb, maxViewers: 3 });
  }, 60_000);

  it("turns away a viewer past the admin's limit, lets them share what is being watched, and in once a place is free", async () => {
    await setConversion({ storage: "memory", maxViewers: 1 });
    const dad = { ...headers, "x-isputnik-user-id": "dad", "x-isputnik-user-name": "Dad" };
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/0.ts`, headers })).statusCode).toBe(200);

    // Another film needs a place of its own: there is none.
    expect((await app.inject({ method: "GET", url: `/video/api/play/${secondId}`, headers: dad })).json().playback.busy).toEqual({ reason: "household", limit: 1 });
    const refused = await app.inject({ method: "GET", url: `/video/api/hls/${secondId}/index.m3u8`, headers: dad });
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ code: "busy", reason: "household", limit: 1 });
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${secondId}/0.ts`, headers: dad })).json().code).toBe("busy");
    // The film Mum is watching is made once for both: Dad joins it.
    expect((await app.inject({ method: "GET", url: `/video/api/play/${filmId}`, headers: dad })).json().playback.busy).toBeNull();
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/0.ts`, headers: dad })).statusCode).toBe(200);
    const viewers = (await conversion()).usage.viewers as { user: string; shared: boolean }[];
    expect(viewers.map((viewer) => [viewer.user, viewer.shared])).toEqual([["Mum", true], ["Dad", true]]);
    // Mum, already watching, carries on.
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/1.ts`, headers })).statusCode).toBe(200);

    await app.inject({ method: "DELETE", url: `/video/api/hls/${filmId}`, headers });
    await app.inject({ method: "DELETE", url: `/video/api/hls/${filmId}`, headers: dad });
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${secondId}/0.ts`, headers: dad })).statusCode).toBe(200);
    await app.inject({ method: "DELETE", url: `/video/api/hls/${secondId}`, headers: dad });
    await setConversion({ storage: "memory-disk", memoryMb: DEFAULT_CONVERSION.memoryMb, maxViewers: 3 });
  }, 60_000);

  it("converts one film at a time for each person, refusing a second rather than taking over the first", async () => {
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/0.ts`, headers })).statusCode).toBe(200);
    // Places are free, but Mum is converting Loud Film already (another screen, a tab left open).
    expect((await app.inject({ method: "GET", url: `/video/api/play/${secondId}`, headers })).json().playback.busy)
      .toEqual({ reason: "person", limit: 3, title: "Loud Film" });
    const refused = await app.inject({ method: "GET", url: `/video/api/hls/${secondId}/0.ts`, headers });
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ code: "busy", reason: "person", error: "Already watching \"Loud Film\" converted" });
    // The first carries on; someone else may convert the second.
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/1.ts`, headers })).statusCode).toBe(200);
    const dad = { ...headers, "x-isputnik-user-id": "dad", "x-isputnik-user-name": "Dad" };
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${secondId}/0.ts`, headers: dad })).statusCode).toBe(200);
    // Once Mum leaves the first, the second is hers to watch.
    await app.inject({ method: "DELETE", url: `/video/api/hls/${filmId}`, headers });
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${secondId}/0.ts`, headers })).statusCode).toBe(200);
    await app.inject({ method: "DELETE", url: `/video/api/hls/${secondId}`, headers });
    await app.inject({ method: "DELETE", url: `/video/api/hls/${secondId}`, headers: dad });
  }, 60_000);

  it("keeps the admin's settings, refuses ones out of range, and lets only an admin near them", async () => {
    expect((await setConversion({ storage: "memory", memoryMb: 512, maxViewers: 2 })).json().settings)
      .toEqual({ storage: "memory", memoryMb: 512, maxViewers: 2, hardware: "auto", remoteQuality: 720, memoryPerViewerMb: 256, whenFull: "wait" });
    expect((await conversion()).settings.memoryMb).toBe(512);
    expect((await setConversion({ memoryMb: 10 })).statusCode).toBe(400);
    expect((await setConversion({ maxViewers: 0 })).statusCode).toBe(400);
    expect((await setConversion({ storage: "swap" })).statusCode).toBe(400);
    expect((await setConversion({ whenFull: "swap" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/video/api/admin/conversion", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/video/api/admin/conversion", headers, payload: { storage: "disk" } })).statusCode).toBe(403);
    const events = (await app.inject({ method: "GET", url: "/video/api/admin/events?event=conversion.changed", headers: adminHeaders })).json();
    expect(events.events[0].detail).toBe("Up to 2 viewer(s) converting on the GPU where it can, 512 MB of memory, then waiting; away from home up to 720p");

    // A home from before 0.35 sends back what it read, in the old words, with its change.
    const old = (await conversion()).settings;
    expect((await setConversion({ ...old, whenFull: "disk" })).json().settings).toMatchObject({ storage: "memory-disk", memoryMb: 512 });
    expect((await setConversion({ memoryPerViewerMb: 300, maxViewers: 3, whenFull: "disk" })).json().settings).toMatchObject({ storage: "memory-disk", memoryMb: 900 });
    expect((await setConversion({ memoryPerViewerMb: 0, maxViewers: 3, whenFull: "disk" })).json().settings).toMatchObject({ storage: "disk", memoryMb: 900 });
    // …and a repeat of the old words alone changes nothing.
    const now = (await conversion()).settings;
    expect((await setConversion({ ...now, remoteQuality: 480 })).json().settings).toMatchObject({ storage: "disk", memoryMb: 900, remoteQuality: 480 });
    await setConversion({ remoteQuality: 720 });
    await setConversion({ storage: "memory-disk", memoryMb: DEFAULT_CONVERSION.memoryMb, maxViewers: 3 });
  });

  it("refuses a segment that isn't in the playlist, and someone who can't see the film", async () => {
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/99.ts`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/x.ts`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/index.m3u8`, headers: { ...headers, "x-isputnik-libraries": "" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/video/api/hls/${filmId}`, headers })).statusCode).toBe(204);
  });
});
