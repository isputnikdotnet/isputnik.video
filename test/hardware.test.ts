// Converting on the GPU (hardware.ts): what is found out, where each film is
// converted, the arguments ffmpeg gets, and the CPU taking over when the GPU
// fails. No test needs a GPU: VAAPI is Linux-only and CI has none, so a GPU run
// here really fails, which is what the fallback test relies on.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { decideDelivery } from "../src/delivery.js";
import { findTools, probe, type MediaInfo } from "../src/ffmpeg.js";
import { Hardware, SUBTITLE_CHANGES, decodeKeyOf, detectGpu, findDevice, type GpuCapabilities } from "../src/hardware.js";
import { buildPlan, cpuTonemap, ffmpegArgs } from "../src/hls.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const quiet = { info: () => undefined, warn: () => undefined };
const tools = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" };

const film = (codec: string, pixelFormat: string, height = 1080, width = 1920, colorTransfer: string | null = null): MediaInfo => ({
  container: "matroska,webm", start: 0, duration: 60,
  video: { index: 0, codec, profile: null, pixelFormat, width, height, colorTransfer, colorPrimaries: colorTransfer ? "bt2020" : null },
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
    expect(decodeKeyOf(film("vc1", "yuv420p"))).toBe("vc1");
    expect(decodeKeyOf(film("wmv3", "yuv420p"))).toBe("vc1");
    expect(decodeKeyOf(film("mpeg4", "yuv420p"))).toBeNull();
  });
});

describe("where a film is converted", () => {
  it("goes all on the GPU when it decodes the codec", async () => {
    const hardware = await hardwareWith(found());
    const info = film("hevc", "yuv420p10le", 2160, 3840);
    expect(hardware.choose(info, decideDelivery(info, ".mkv"))).toEqual({ device: "/dev/dri/renderD128", decode: true, tonemap: false, overlay: false });
  });

  it("decodes on the CPU what the GPU can't, and still encodes on the GPU", async () => {
    // A Kaby Lake: no AV1.
    const hardware = await hardwareWith(found());
    const info = film("av1", "yuv420p");
    expect(hardware.choose(info, decideDelivery(info, ".mkv"))).toEqual({ device: "/dev/dri/renderD128", decode: false, tonemap: false, overlay: false });
  });

  it("decodes on the CPU when a subtitle is drawn in", async () => {
    const hardware = await hardwareWith(found());
    const info = film("hevc", "yuv420p");
    expect(hardware.choose(info, decideDelivery(info, ".mkv", null, 2))).toEqual({ device: "/dev/dri/renderD128", decode: false, tonemap: false, overlay: false });
  });

  it("draws the subtitle on the GPU too, where it can, and decodes there for it (H3)", async () => {
    const hardware = await hardwareWith(found({ overlay: true }));
    const info = film("hevc", "yuv420p");
    expect(hardware.choose(info, decideDelivery(info, ".mkv", null, 2))).toEqual({ device: "/dev/dri/renderD128", decode: true, tonemap: false, overlay: true });
    // A codec it can't decode: the CPU decodes and draws, the GPU encodes.
    const av1 = film("av1", "yuv420p");
    expect(hardware.choose(av1, decideDelivery(av1, ".mkv", null, 2))).toMatchObject({ decode: false, overlay: false });
  });

  it("decodes HDR on the GPU only where it tone-maps it there (H2)", async () => {
    const info = film("hevc", "yuv420p10le", 2160, 3840, "smpte2084");
    const delivery = decideDelivery(info, ".mkv");
    expect((await hardwareWith(found({ tonemap: true }))).choose(info, delivery)).toEqual({ device: "/dev/dri/renderD128", decode: true, tonemap: true, overlay: false });
    // Kaby Lake may decode 10-bit HEVC and still not tone-map: the CPU does both, the GPU encodes.
    expect((await hardwareWith(found({ tonemap: false }))).choose(info, delivery)).toEqual({ device: "/dev/dri/renderD128", decode: false, tonemap: false, overlay: false });
  });

  it("tone-maps HLG on the CPU even where the GPU tone-maps PQ: it carries no mastering display data (issue 2)", async () => {
    const info = film("hevc", "yuv420p10le", 2160, 3840, "arib-std-b67");
    expect((await hardwareWith(found({ tonemap: true }))).choose(info, decideDelivery(info, ".mkv"))).toEqual({ device: "/dev/dri/renderD128", decode: false, tonemap: false, overlay: false });
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

  it("sends a film the GPU can't tone-map for want of mastering data to the CPU, without holding it against the GPU", async () => {
    const hardware = await hardwareWith(found(), "gpu");
    const info = film("hevc", "yuv420p");
    const stderr = "[Parsed_tonemap_vaapi_0] No mastering display data from input\nError while filtering: Invalid argument";
    for (let i = 0; i < 3; i++) expect(hardware.failed("Error while filtering: Invalid argument", stderr)).toBe(true);
    expect(hardware.state().setAside).toBe(false);
    expect(hardware.choose(info, decideDelivery(info, ".mkv"))).not.toBeNull();
    // Kept for the diagnostics report, marked as the film's doing.
    hardware.failed("boom", "[h264_vaapi] boom");
    expect(hardware.recentFailures().map((failure) => [failure.reason, failure.counted])).toEqual([
      ["Error while filtering: Invalid argument", false], ["Error while filtering: Invalid argument", false], ["Error while filtering: Invalid argument", false], ["boom", true]
    ]);
    expect(hardware.recentFailures()[3].stderr).toBe("[h264_vaapi] boom");
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

  it("tone-maps HDR on the GPU, before scaling", () => {
    const args = ffmpegArgs(plan(film("hevc", "yuv420p10le", 2160, 3840, "smpte2084")), 0, "/tmp/s", { device: "/dev/dri/renderD128", decode: true, tonemap: true });
    expect(args[args.indexOf("-vf") + 1]).toBe("tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709,scale_vaapi=w=1920:h=1080:format=nv12");
  });

  it("tone-maps HDR on the CPU when the GPU can't, and uploads it to be encoded", () => {
    const args = ffmpegArgs(plan(film("hevc", "yuv420p10le", 2160, 3840, "smpte2084")), 0, "/tmp/s", { device: "/dev/dri/renderD128", decode: false });
    expect(args).not.toContain("-hwaccel");
    expect(args[args.indexOf("-vf") + 1]).toBe(`scale=-2:1080,${cpuTonemap("pq")},format=nv12,hwupload`);
  });

  it("draws the subtitle on the GPU over a picture tone-mapped and scaled there", () => {
    const args = ffmpegArgs(plan(film("hevc", "yuv420p10le", 2160, 3840, "smpte2084"), 2), 0, "/tmp/s", { device: "/dev/dri/renderD128", decode: true, tonemap: true, overlay: true });
    expect(args[args.indexOf("-filter_complex") + 1]).toBe(
      "[0:0]tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709,scale_vaapi=w=1920:h=1080:format=nv12[m];" +
      "[0:2]mpdecimate=max=12,format=bgra,hwupload[sub];[m][sub]overlay_vaapi=eof_action=pass[v]"
    );
    expect(args).toContain("-hwaccel");
    expect(args).not.toContain("-vf");
  });

  it("uploads only the subtitle canvases that changed, fitted to the picture after (#14)", () => {
    // A 1080p PGS track on a 720p film: scaled, but only the canvases kept.
    const args = ffmpegArgs(plan(film("h264", "yuv420p", 720, 1280), 2), 0, "/tmp/s", { device: "/dev/dri/renderD128", decode: true, overlay: true });
    expect(args[args.indexOf("-filter_complex") + 1]).toBe(
      "[0:0]scale_vaapi=format=nv12[m];[0:2]mpdecimate=max=12,scale=1280:720,format=bgra,hwupload[sub];[m][sub]overlay_vaapi=eof_action=pass[v]"
    );
  });

  it("drops the repeated canvases on the CPU and keeps every change at its frame", () => {
    // What the GPU branch does before the upload, run by the real ffmpeg: ten
    // seconds of an empty canvas resent every frame, a subtitle from 3 s to 5 s.
    const source = "color=c=black@0:size=1920x1080:rate=24:d=10,format=bgra," +
      "drawbox=x=100:y=900:w=600:h=80:color=white@1:t=fill:enable='between(t,3,5)'";
    const run = spawnSync(findTools().ffmpeg, ["-hide_banner", "-f", "lavfi", "-i", source,
      "-vf", `${SUBTITLE_CHANGES},format=bgra,showinfo`, "-f", "null", "-"], { encoding: "utf8", windowsHide: true });
    expect(run.status).toBe(0);
    const kept = [...run.stderr.matchAll(/pts_time:([\d.]+).*?fmt:(\w+).*?mean:\[(\d+)/g)]
      .map((m) => ({ at: Number(m[1]), fmt: m[2], on: Number(m[3]) > 0 }));
    // A fraction of the 240 frames, the canvas back in BGRA with its alpha.
    expect(kept.length).toBeLessThan(30);
    expect(new Set(kept.map((frame) => frame.fmt))).toEqual(new Set(["bgra"]));
    // Never more than 12 frames apart, so the overlay never holds the film back longer.
    for (let i = 1; i < kept.length; i++) expect(kept[i].at - kept[i - 1].at).toBeLessThanOrEqual(13 / 24 + 1e-4);
    // The subtitle comes and goes on its own frames, not up to half a second late.
    expect(kept.find((frame) => frame.on)?.at).toBe(3);
    expect(kept.find((frame, i) => i > 0 && kept[i - 1].on && !frame.on)?.at).toBeCloseTo(121 / 24, 3);
  });

  it("is the CPU's, as before, with no GPU", () => {
    const args = ffmpegArgs(plan(film("hevc", "yuv420p")), 0, "/tmp/s").join(" ");
    expect(args).toContain("-c:v libx264");
    expect(args).not.toContain("vaapi");
  });
});

describe("HDR on the CPU", () => {
  const plan = (info: MediaInfo, burn: number | null = null) => buildPlan("m1", "/media/film.mkv", info, decideDelivery(info, ".mkv", null, burn), null);

  it("tone-maps PQ and HLG, after scaling, and before a subtitle is drawn", () => {
    const pq = ffmpegArgs(plan(film("hevc", "yuv420p10le", 2160, 3840, "smpte2084")), 0, "/tmp/s");
    expect(pq[pq.indexOf("-vf") + 1]).toBe(`scale=-2:1080,${cpuTonemap("pq")}`);
    expect(cpuTonemap("hlg")).toContain("tin=arib-std-b67");
    const burned = ffmpegArgs(plan(film("hevc", "yuv420p10le", 1080, 1920, "smpte2084"), 2), 0, "/tmp/s");
    expect(burned[burned.indexOf("-filter_complex") + 1]).toBe(`[0:0]${cpuTonemap("pq")}[pic];[pic][0:2]overlay=eof_action=pass[v]`);
  });

  it("leaves an SDR picture as it was", () => {
    const args = ffmpegArgs(plan(film("hevc", "yuv420p10le")), 0, "/tmp/s").join(" ");
    expect(args).not.toContain("zscale");
  });

  it("really runs: a 10-bit HDR10 film is found HDR and converted to SDR", async () => {
    const realTools = findTools();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-hdr-"));
    try {
      const file = path.join(dir, "hdr.mkv");
      execFileSync(realTools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "1",
        "-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-x265-params", "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc", file]);
      const info = await probe(realTools, file);
      expect(info.video).toMatchObject({ colorTransfer: "smpte2084", colorPrimaries: "bt2020" });
      const out = path.join(dir, "sdr.mp4");
      execFileSync(realTools.ffmpeg, ["-v", "error", "-i", file, "-vf", cpuTonemap("pq"), "-c:v", "libx264", "-preset", "ultrafast", out]);
      const converted = await probe(realTools, out);
      expect(converted.video).toMatchObject({ pixelFormat: "yuv420p" });
      expect(converted.video?.colorTransfer).not.toBe("smpte2084");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
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
        if (binary.endsWith("vainfo")) {
          return { ok: true, out: "vainfo: Driver version: Intel iHD driver for Intel(R) Gen Graphics - 24.1.0\n      VAProfileVC1Advanced            : VAEntrypointVLD\n" };
        }
        const joined = args.join(" ");
        // No AV1 encoder in this ffmpeg; HEVC 10-bit made, but not decoded on the GPU.
        if (joined.includes("libsvtav1")) return { ok: false, out: "Unknown encoder 'libsvtav1'" };
        if (joined.includes("-hwaccel") && joined.includes("vp9_10.webm")) return { ok: false, out: "Impossible to convert between the formats" };
        return { ok: true, out: "" };
      }
    });
    expect(caps).toMatchObject({ device: "/dev/dri/renderD128", driver: "Intel iHD driver for Intel(R) Gen Graphics - 24.1.0", encode: true, error: null });
    // VC-1 can't be sampled (ffmpeg has no encoder for it): vainfo's word for it is taken.
    expect(caps.decode).toEqual(["h264", "hevc", "hevc10", "vp9", "mpeg2video", "vc1"]);
    expect(calls.find((call) => call.includes("h264_vaapi"))).toEqual(expect.arrayContaining(["-force_key_frames", "0,0.5"]));
    // 10-bit HEVC decodes, so tone mapping was tried; and drawing a subtitle.
    expect(caps).toMatchObject({ tonemap: true, overlay: true });
    expect(calls.some((call) => call.join(" ").includes("tonemap_vaapi"))).toBe(true);
    expect(calls.some((call) => call.join(" ").includes("overlay_vaapi"))).toBe(true);
  });

  it("doesn't try tone mapping where 10-bit HEVC doesn't decode, and says what failed", async () => {
    const calls: string[] = [];
    const caps = await detectGpu(tools, {
      device: "/dev/dri/renderD128", vainfo: null,
      run: async (_binary, args) => {
        const joined = args.join(" ");
        calls.push(joined);
        if (joined.includes("-hwaccel") && joined.includes("hevc10")) return { ok: false, out: "no" };
        if (joined.includes("overlay_vaapi")) return { ok: false, out: "No such filter: 'overlay_vaapi'" };
        return { ok: true, out: "" };
      }
    });
    expect(caps).toMatchObject({ encode: true, tonemap: false, overlay: false });
    expect(caps.decode).not.toContain("hevc10");
    expect(calls.some((call) => call.includes("tonemap_vaapi"))).toBe(false);
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
    // And an HDR10 film: HEVC 10-bit, PQ.
    const hdr = path.join(fixture.root, "Movies", "Bright Night (2024)", "Bright Night (2024).mkv");
    fs.mkdirSync(path.dirname(hdr), { recursive: true });
    execFileSync(realTools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "8", "-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-x265-params", "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc", "-c:a", "aac", hdr]);
    // And an XviD AVI with B-frames, as old rips are.
    const xvid = path.join(fixture.root, "Movies", "Old Rip (1973)", "Old Rip (1973).avi");
    fs.mkdirSync(path.dirname(xvid), { recursive: true });
    execFileSync(realTools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "4", "-c:v", "mpeg4", "-vtag", "XVID", "-bf", "1", "-c:a", "ac3", xvid]);
    const hourAgo = new Date(Date.now() - 3600_000);
    fs.utimesSync(file, hourAgo, hourAgo);
    fs.utimesSync(hdr, hourAgo, hourAgo);
    fs.utimesSync(xvid, hourAgo, hourAgo);
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
    expect((await conversion()).usage.viewers).toMatchObject([{ user: "Mum", mode: "transcode", converter: "cpu", hdr: false }]);
    await app.inject({ method: "DELETE", url: `/video/api/hls/${filmId}`, headers });
  }, 60_000);

  it("offers a TV the file as it is, but never a DivX/XviD one: its decoders get them wrong", async () => {
    const films = (await app.inject({ method: "GET", url: "/video/api/movies", headers })).json().items as { id: string; title: string }[];
    const play = async (title: string) => (await app.inject({ method: "GET", url: `/video/api/play/${films.find((item) => item.title === title)!.id}`, headers })).json();
    expect((await play("Old Tape")).playback.original).toMatch(/^\/video\/api\/stream\//);
    const rip = await play("Old Rip");
    expect(rip.playback.original).toBeNull();
    expect(rip.playback.mode).toBe("transcode");
    expect(rip.playback.url).toMatch(/\/index\.m3u8$/);
  }, 60_000);

  it("tone-maps an HDR film on the CPU when the GPU run fails, and marks it HDR", async () => {
    const hdrId = ((await app.inject({ method: "GET", url: "/video/api/movies", headers })).json().items as { id: string; title: string }[]).find((item) => item.title === "Bright Night")!.id;
    expect((await app.inject({ method: "GET", url: `/video/api/play/${hdrId}`, headers })).json().playback.mode).toBe("transcode");
    const segment = await app.inject({ method: "GET", url: `/video/api/hls/${hdrId}/0.ts`, headers });
    expect(segment.statusCode).toBe(200);
    const viewers = (await app.inject({ method: "GET", url: "/video/api/admin/conversion", headers: admin })).json().usage.viewers as { title: string; converter: string; hdr: boolean }[];
    expect(viewers.find((viewer) => viewer.title.startsWith("Bright Night"))).toMatchObject({ converter: "cpu", hdr: true });
    await app.inject({ method: "DELETE", url: `/video/api/hls/${hdrId}`, headers });
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
