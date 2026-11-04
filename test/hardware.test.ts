// Converting on the GPU (hardware.ts): what is found out, where each film is
// converted, the arguments ffmpeg gets, and the CPU taking over when the GPU
// fails. No test needs a GPU: VAAPI is Linux-only and CI has none, so a GPU run
// here really fails, which is what the fallback test relies on.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { decideDelivery } from "../src/delivery.js";
import { findTools, type MediaInfo } from "../src/ffmpeg.js";
import { Hardware, decodeKeyOf, detectGpu, findDevice, type GpuCapabilities } from "../src/hardware.js";
import { buildPlan, ffmpegArgs } from "../src/hls.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const quiet = { info: () => undefined, warn: () => undefined };
const tools = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" };

const film = (codec: string, pixelFormat: string, height = 1080, width = 1920): MediaInfo => ({
  container: "matroska,webm", start: 0, duration: 60,
  video: { index: 0, codec, profile: null, pixelFormat, width, height },
  audio: [{ index: 1, codec: "aac", channels: 2, language: null, title: null, default: true }],
  subtitles: [{ index: 2, codec: "hdmv_pgs_subtitle", language: "eng", title: null, default: false, forced: false, width: 1920, height: 1080 }],
  chapters: []
});

const found = (over: Partial<GpuCapabilities> = {}): GpuCapabilities => ({
  device: "/dev/dri/renderD128", driver: "Intel iHD driver 24.1", encode: true,
  decode: ["h264", "hevc", "hevc10", "vp9", "mpeg2video"], error: null, checkedAt: "2026-11-03T00:00:00.000Z", ...over
});

async function hardwareWith(caps: GpuCapabilities, mode: "auto" | "cpu" | "gpu" = "auto") {
  const hardware = new Hardware(async () => caps, quiet);
  hardware.configure(mode);
  await hardware.check();
  return hardware;
}

describe("which codec a film's picture is, for the decode test", () => {
  it("tells 10-bit apart, and leaves out what no GPU here decodes", () => {
    expect(decodeKeyOf(film("hevc", "yuv420p10le"))).toBe("hevc10");
    expect(decodeKeyOf(film("hevc", "yuv420p"))).toBe("hevc");
    expect(decodeKeyOf(film("vp9", "yuv420p10le"))).toBe("vp9_10");
    expect(decodeKeyOf(film("h264", "yuv420p10le"))).toBeNull();
    expect(decodeKeyOf(film("vc1", "yuv420p"))).toBeNull();
  });
});

describe("where a film is converted", () => {
  it("goes all on the GPU when it decodes the codec", async () => {
    const hardware = await hardwareWith(found());
    const info = film("hevc", "yuv420p10le", 2160, 3840);
    expect(hardware.choose(info, decideDelivery(info, ".mkv"))).toEqual({ device: "/dev/dri/renderD128", decode: true });
  });

  it("decodes on the CPU what the GPU can't, and still encodes on the GPU", async () => {
    // A Kaby Lake: no AV1.
    const hardware = await hardwareWith(found());
    const info = film("av1", "yuv420p");
    expect(hardware.choose(info, decideDelivery(info, ".mkv"))).toEqual({ device: "/dev/dri/renderD128", decode: false });
  });

  it("decodes on the CPU when a subtitle is drawn in", async () => {
    const hardware = await hardwareWith(found());
    const info = film("hevc", "yuv420p");
    expect(hardware.choose(info, decideDelivery(info, ".mkv", null, 2))).toEqual({ device: "/dev/dri/renderD128", decode: false });
  });

  it("needs neither for a picture that goes through as it is", async () => {
    const hardware = await hardwareWith(found());
    const info = film("h264", "yuv420p");
    expect(hardware.choose(info, decideDelivery(info, ".mkv"))).toBeNull();
  });

  it("stays on the CPU when asked to, or when no GPU was found", async () => {
    const info = film("hevc", "yuv420p");
    expect((await hardwareWith(found(), "cpu")).choose(info, decideDelivery(info, ".mkv"))).toBeNull();
    expect((await hardwareWith(found({ encode: false, error: "No GPU" }))).choose(info, decideDelivery(info, ".mkv"))).toBeNull();
  });

  it("sets the GPU aside after three failures in an hour, until it is checked again", async () => {
    const hardware = await hardwareWith(found());
    const info = film("hevc", "yuv420p");
    const delivery = decideDelivery(info, ".mkv");
    expect(hardware.failed("boom")).toBe(true);
    hardware.failed("boom");
    expect(hardware.choose(info, delivery)).not.toBeNull();
    hardware.failed("boom");
    expect(hardware.choose(info, delivery)).toBeNull();
    expect(hardware.state().setAside).toBe(true);
    await hardware.check();
    expect(hardware.choose(info, delivery)).not.toBeNull();
  });

  it("never falls back in GPU only, so the failure shows", async () => {
    expect((await hardwareWith(found(), "gpu")).failed("boom")).toBe(false);
  });
});

describe("ffmpeg's arguments on the GPU", () => {
  const plan = (info: MediaInfo, burn: number | null = null) => buildPlan("m1", "/media/film.mkv", info, decideDelivery(info, ".mkv", null, burn), null);

  it("decodes, scales and encodes on the GPU, with a keyframe on every cut", () => {
    const args = ffmpegArgs(plan(film("hevc", "yuv420p10le", 2160, 3840)), 0, "/tmp/s", { device: "/dev/dri/renderD128", decode: true });
    const joined = args.join(" ");
    expect(joined).toContain("-init_hw_device vaapi=va:/dev/dri/renderD128 -filter_hw_device va -hwaccel vaapi -hwaccel_device va -hwaccel_output_format vaapi");
    expect(args.indexOf("-hwaccel")).toBeLessThan(args.indexOf("-i"));
    expect(joined).toContain("-vf scale_vaapi=w=1920:h=1080:format=nv12");
    expect(joined).toContain("-c:v h264_vaapi");
    expect(joined).toContain("-maxrate 10M");
    expect(args[args.indexOf("-force_key_frames") + 1]).toMatch(/^0\.000,6\.000,/);
    expect(args).not.toContain("libx264");
  });

  it("uploads a picture the CPU decoded, and one with a subtitle drawn in", () => {
    const decodedOnCpu = ffmpegArgs(plan(film("av1", "yuv420p")), 0, "/tmp/s", { device: "/dev/dri/renderD128", decode: false }).join(" ");
    expect(decodedOnCpu).not.toContain("-hwaccel");
    expect(decodedOnCpu).toContain("-vf format=nv12,hwupload");
    const burned = ffmpegArgs(plan(film("hevc", "yuv420p", 2160, 3840), 2), 0, "/tmp/s", { device: "/dev/dri/renderD128", decode: false });
    expect(burned[burned.indexOf("-filter_complex") + 1]).toBe("[0:2]scale=3840:2160[sub];[0:0][sub]overlay=eof_action=pass,scale=-2:1080,format=nv12,hwupload[v]");
    expect(burned).not.toContain("-vf");
  });

  it("is the CPU's, as before, with no GPU", () => {
    const args = ffmpegArgs(plan(film("hevc", "yuv420p")), 0, "/tmp/s").join(" ");
    expect(args).toContain("-c:v libx264");
    expect(args).not.toContain("vaapi");
  });
});

describe("finding out what the GPU does", () => {
  it("says so plainly when no GPU is passed to the container", async () => {
    expect(findDevice({}, path.join(__dirname, "no-such-dir"))).toBeNull();
    expect((await detectGpu(tools, { device: null })).error).toBe("No GPU: /dev/dri is not passed to the container");
  });

  it("uses the GPU the admin named", () => {
    expect(findDevice({ VIDEO_GPU_DEVICE: "/dev/dri/renderD129" })).toBe("/dev/dri/renderD129");
  });

  it("encodes a second of picture, then decodes a sample of each codec, keeping what worked", async () => {
    const calls: string[][] = [];
    const caps = await detectGpu(tools, {
      device: "/dev/dri/renderD128",
      vainfo: "/usr/bin/vainfo",
      run: async (binary, args) => {
        calls.push([binary, ...args]);
        if (binary.endsWith("vainfo")) return { ok: true, out: "vainfo: Driver version: Intel iHD driver for Intel(R) Gen Graphics - 24.1.0\n" };
        const joined = args.join(" ");
        // No AV1 encoder in this ffmpeg; HEVC 10-bit made, but not decoded on the GPU.
        if (joined.includes("libsvtav1")) return { ok: false, out: "Unknown encoder 'libsvtav1'" };
        if (joined.includes("-hwaccel") && joined.includes("vp9_10.webm")) return { ok: false, out: "Impossible to convert between the formats" };
        return { ok: true, out: "" };
      }
    });
    expect(caps).toMatchObject({ device: "/dev/dri/renderD128", driver: "Intel iHD driver for Intel(R) Gen Graphics - 24.1.0", encode: true, error: null });
    expect(caps.decode).toEqual(["h264", "hevc", "hevc10", "vp9", "mpeg2video"]);
    expect(calls.find((call) => call.includes("h264_vaapi"))).toEqual(expect.arrayContaining(["-force_key_frames", "0,0.5"]));
  });

  it("uses no GPU that can't encode, and says why", async () => {
    const caps = await detectGpu(tools, { device: "/dev/dri/renderD128", vainfo: null, run: async () => ({ ok: false, out: "Device creation failed: -22.\nFailed to set value 'vaapi=va:/dev/dri/renderD128'" }) });
    expect(caps).toMatchObject({ encode: false, decode: [], error: "The GPU can't encode H.264: Failed to set value 'vaapi=va:/dev/dri/renderD128'" });
  });
});

describe("a GPU that fails part-way", () => {
  const SECRET = "video-secret-video-secret-0123456789";
  const headers = { "x-isputnik-gateway": SECRET, "x-isputnik-user-id": "mum", "x-isputnik-user-name": "Mum", "x-isputnik-user-role": "member", "x-isputnik-libraries": "lib_films" };
  const admin = { ...headers, "x-isputnik-user-id": "admin", "x-isputnik-user-role": "admin" };
  const realTools = findTools();
  let fixture: Fixture;
  let app: FastifyInstance;
  let filmId: string;

  beforeAll(async () => {
    fixture = makeFixture();
    // MPEG-2: what no browser plays, so the picture is re-encoded.
    const file = path.join(fixture.root, "Movies", "Old Tape (1995)", "Old Tape (1995).mkv");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    execFileSync(realTools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "8", "-c:v", "mpeg2video", "-c:a", "aac", file]);
    const hourAgo = new Date(Date.now() - 3600_000);
    fs.utimesSync(file, hourAgo, hourAgo);
    // Told there is a GPU that decodes MPEG-2: there isn't, so the GPU run fails.
    app = await buildApp({
      gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null, fastify: { logger: false },
      detectGpu: async () => found({ device: "/dev/dri/renderD128", decode: ["mpeg2video"] })
    });
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_films", headers: admin, payload: { name: "Films", kind: "movies", folder: "Movies" } });
    await app.scansSettled();
    filmId = ((await app.inject({ method: "GET", url: "/video/api/movies", headers })).json().items as { id: string; title: string }[]).find((item) => item.title === "Old Tape")!.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    fixture?.cleanup();
  });

  it("is converted on the CPU instead, and the viewer never sees the failure", async () => {
    const conversion = async () => (await app.inject({ method: "GET", url: "/video/api/admin/conversion", headers: admin })).json();
    await expect.poll(async () => (await conversion()).hardware.encode).toBe(true);
    const play = (await app.inject({ method: "GET", url: `/video/api/play/${filmId}`, headers })).json();
    expect(play.playback.mode).toBe("transcode");
    const segment = await app.inject({ method: "GET", url: `/video/api/hls/${filmId}/0.ts`, headers });
    expect(segment.statusCode).toBe(200);
    expect((await conversion()).usage.viewers).toMatchObject([{ user: "Mum", mode: "transcode", converter: "cpu" }]);
    await app.inject({ method: "DELETE", url: `/video/api/hls/${filmId}`, headers });
  }, 60_000);

  it("keeps the admin's choice, keeps it when an older home leaves it out, and checks again on asking", async () => {
    const put = (payload: object) => app.inject({ method: "PUT", url: "/video/api/admin/conversion", headers: admin, payload });
    expect((await put({ memoryPerViewerMb: 300, maxViewers: 3, whenFull: "disk", hardware: "cpu" })).json().settings.hardware).toBe("cpu");
    expect((await put({ memoryPerViewerMb: 200, maxViewers: 3, whenFull: "disk" })).json().settings).toMatchObject({ memoryPerViewerMb: 200, hardware: "cpu" });
    expect((await put({ memoryPerViewerMb: 300, maxViewers: 3, whenFull: "disk", hardware: "everywhere" })).statusCode).toBe(400);
    await put({ memoryPerViewerMb: 300, maxViewers: 3, whenFull: "disk", hardware: "auto" });
    const checked = await app.inject({ method: "POST", url: "/video/api/admin/conversion/check", headers: admin });
    expect(checked.json().hardware).toMatchObject({ mode: "auto", device: "/dev/dri/renderD128", encode: true, setAside: false });
    expect((await app.inject({ method: "POST", url: "/video/api/admin/conversion/check", headers })).statusCode).toBe(403);
  });
});
