// Converting on the GPU (home's docs/video-hw-transcode-plan.md, H1): Intel's
// media engine through VAAPI. What the GPU can do is found out by trying it — a
// second of generated picture encoded, and a short sample of each codec decoded —
// because what a driver says it supports and what works in this container are
// not always the same. A conversion then goes on the GPU where the GPU can do it,
// and on the CPU otherwise; a GPU run that fails is run again on the CPU
// (hls.ts), and three failures in an hour set the GPU aside until the admin
// checks again.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Delivery } from "./delivery.js";
import type { MediaInfo, Tools } from "./ffmpeg.js";

/** Automatic: the GPU where it can, else the CPU. GPU only: no CPU fallback. */
export type HardwareMode = "auto" | "cpu" | "gpu";

/** Codecs the decode test knows, by the name delivery and the probe use, with
 *  10-bit apart: a GPU can decode 8-bit HEVC and not 10-bit. */
export type DecodeKey = "h264" | "hevc" | "hevc10" | "vp9" | "vp9_10" | "av1" | "mpeg2video" | "vc1";

/** Codecs ffmpeg can decode but not make a sample of: what vainfo lists for them
 *  is taken as it says (a VAAPI decode profile, VAEntrypointVLD). */
const LISTED_ONLY: { key: DecodeKey; profile: RegExp }[] = [
  { key: "vc1", profile: /VAProfileVC1(Simple|Main|Advanced)\s*:\s*VAEntrypointVLD/ }
];

export interface GpuCapabilities {
  /** The render node tried, e.g. /dev/dri/renderD128; null when there is none. */
  device: string | null;
  /** The VAAPI driver, from vainfo, when it says. */
  driver: string | null;
  /** Encodes H.264 with keyframes where asked: what a GPU conversion needs. */
  encode: boolean;
  decode: DecodeKey[];
  /** Why the GPU is not used, when it isn't. */
  error: string | null;
  checkedAt: string;
}

/** How one run goes on the GPU: the device, and whether it decodes too. */
export interface GpuRun {
  device: string;
  decode: boolean;
}

/** A sample of each codec, as the CPU makes it, for the decode test. */
const SAMPLES: { key: DecodeKey; args: string[]; ext: string }[] = [
  { key: "h264", args: ["-c:v", "libx264", "-pix_fmt", "yuv420p"], ext: "mp4" },
  { key: "hevc", args: ["-c:v", "libx265", "-pix_fmt", "yuv420p", "-x265-params", "log-level=error"], ext: "mp4" },
  { key: "hevc10", args: ["-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-x265-params", "log-level=error"], ext: "mp4" },
  { key: "vp9", args: ["-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-deadline", "realtime"], ext: "webm" },
  { key: "vp9_10", args: ["-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p10le", "-deadline", "realtime"], ext: "webm" },
  { key: "av1", args: ["-c:v", "libsvtav1", "-pix_fmt", "yuv420p", "-preset", "12"], ext: "mp4" },
  { key: "mpeg2video", args: ["-c:v", "mpeg2video", "-pix_fmt", "yuv420p"], ext: "ts" }
];

const TEST_TIMEOUT_MS = 20_000;

type Runner = (binary: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; out: string }>;

const runTool: Runner = (binary, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}\n${stderr}` });
    });
  });

/** The render node to use: VIDEO_GPU_DEVICE, else the first /dev/dri/renderD*. */
export function findDevice(env: NodeJS.ProcessEnv = process.env, dir = "/dev/dri"): string | null {
  const chosen = env.VIDEO_GPU_DEVICE?.trim();
  if (chosen) return chosen;
  try {
    const node = fs.readdirSync(dir).filter((name) => /^renderD\d+$/.test(name)).sort()[0];
    return node ? path.join(dir, node).split(path.sep).join("/") : null;
  } catch {
    return null;
  }
}

/** The key the decode test filed a video stream's codec under. */
export function decodeKeyOf(info: MediaInfo): DecodeKey | null {
  const video = info.video;
  if (!video) return null;
  const tenBit = /10|12/.test(video.pixelFormat ?? "");
  switch (video.codec) {
    case "h264": return tenBit ? null : "h264";
    case "hevc": return tenBit ? "hevc10" : "hevc";
    case "vp9": return tenBit ? "vp9_10" : "vp9";
    case "av1": return tenBit ? null : "av1";
    case "mpeg2video": return "mpeg2video";
    // WMV3 is VC-1's Main profile.
    case "vc1":
    case "wmv3": return "vc1";
    default: return null;
  }
}

/** The ffmpeg arguments that open the device for a run. */
export const deviceArgs = (device: string) => ["-init_hw_device", `vaapi=va:${device}`, "-filter_hw_device", "va"];

/** Finds out what the GPU does in this container, by trying it. */
export async function detectGpu(tools: Tools, options: { device?: string | null; vainfo?: string | null; run?: Runner; workDir?: string } = {}): Promise<GpuCapabilities> {
  const run = options.run ?? runTool;
  const checkedAt = new Date().toISOString();
  const device = options.device === undefined ? findDevice() : options.device;
  const none = (error: string): GpuCapabilities => ({ device, driver: null, encode: false, decode: [], error, checkedAt });
  if (!device) return none("No GPU: /dev/dri is not passed to the container");
  if (!options.run) {
    try {
      fs.accessSync(device, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
      return none(`${device} is there but this user can't open it`);
    }
  }

  let driver: string | null = null;
  let profiles = "";
  const vainfo = options.vainfo === undefined ? vainfoPath(tools) : options.vainfo;
  if (vainfo) {
    const answer = await run(vainfo, ["--display", "drm", "--device", device], TEST_TIMEOUT_MS);
    driver = answer.out.match(/Driver version:\s*(.+)/)?.[1]?.trim() ?? null;
    profiles = answer.out;
  }

  // The encode a conversion makes: H.264 on the GPU, with keyframes forced.
  const encode = await run(tools.ffmpeg, [
    "-hide_banner", "-v", "error", ...deviceArgs(device),
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "1",
    "-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-force_key_frames", "0,0.5", "-f", "null", "-"
  ], TEST_TIMEOUT_MS);
  if (!encode.ok) {
    return { ...none(`The GPU can't encode H.264: ${lastLine(encode.out)}`), driver };
  }

  // Each codec: a sample made on the CPU, decoded on the GPU. scale_vaapi only
  // takes GPU frames, so a decode that quietly fell back to the CPU fails here.
  const work = fs.mkdtempSync(path.join(options.workDir ?? os.tmpdir(), "isputnik-gpu-"));
  const decode: DecodeKey[] = [];
  try {
    for (const sample of SAMPLES) {
      const file = path.join(work, `${sample.key}.${sample.ext}`);
      const made = await run(tools.ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-t", "0.5", ...sample.args, file], TEST_TIMEOUT_MS);
      // No encoder for it in this ffmpeg: not known to decode, so the CPU does.
      if (!made.ok) continue;
      const decoded = await run(tools.ffmpeg, [
        "-hide_banner", "-v", "error", "-hwaccel", "vaapi", "-hwaccel_device", device, "-hwaccel_output_format", "vaapi",
        "-i", file, "-vf", "scale_vaapi=w=160:h=120:format=nv12", "-f", "null", "-"
      ], TEST_TIMEOUT_MS);
      if (decoded.ok) decode.push(sample.key);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  for (const listed of LISTED_ONLY) if (listed.profile.test(profiles)) decode.push(listed.key);
  return { device, driver, encode: true, decode, error: null, checkedAt };
}

/** vainfo beside ffmpeg (a build that ships its own), else on the PATH. */
function vainfoPath(tools: Tools): string | null {
  const beside = path.join(path.dirname(tools.ffmpeg), "vainfo");
  if (path.isAbsolute(tools.ffmpeg) && fs.existsSync(beside)) return beside;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, "vainfo"))) return path.join(dir, "vainfo");
  }
  return null;
}

const lastLine = (text: string) => text.trim().split(/\r?\n/).filter(Boolean).pop() ?? "no answer";

/** Failures that set the GPU aside, and for how long they count. */
const FAILURES_ALLOWED = 3;
const FAILURE_WINDOW_MS = 60 * 60 * 1000;

/** What the admin sees on Settings → Video. */
export interface HardwareState extends GpuCapabilities {
  mode: HardwareMode;
  checking: boolean;
  /** Automatic stopped using the GPU after failures, until Check again. */
  setAside: boolean;
}

/** The GPU as conversions use it: the admin's mode, what was found, and the
 *  failures since. */
export class Hardware {
  private mode: HardwareMode = "auto";
  private caps: GpuCapabilities | null = null;
  private checking: Promise<void> | null = null;
  private failures: number[] = [];

  constructor(private detect: () => Promise<GpuCapabilities>, private log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void }) {}

  configure(mode: HardwareMode): void {
    const was = this.mode;
    this.mode = mode;
    if (mode !== "cpu" && (was === "cpu" || !this.caps)) void this.check();
  }

  /** Finds out again, and forgets the failures. */
  check(): Promise<void> {
    if (this.mode === "cpu") return Promise.resolve();
    this.checking ??= this.detect()
      .then((caps) => {
        this.caps = caps;
        this.failures = [];
        if (caps.error) this.log.info({ gpu: caps }, `Converting on the CPU: ${caps.error}`);
        else this.log.info({ gpu: caps }, `Converting on the GPU (${caps.device}${caps.driver ? `, ${caps.driver}` : ""}); it decodes ${caps.decode.join(", ") || "nothing"}`);
      })
      .catch((err: unknown) => {
        this.caps = { device: null, driver: null, encode: false, decode: [], error: `Checking the GPU failed: ${err instanceof Error ? err.message : String(err)}`, checkedAt: new Date().toISOString() };
      })
      .finally(() => { this.checking = null; });
    return this.checking;
  }

  private get setAside(): boolean {
    const since = Date.now() - FAILURE_WINDOW_MS;
    this.failures = this.failures.filter((at) => at > since);
    return this.mode === "auto" && this.failures.length >= FAILURES_ALLOWED;
  }

  /** Where a re-encode runs: on the GPU (and whether it decodes there too), or
   *  null for the CPU. A picture copied as it is needs neither. */
  choose(info: MediaInfo, delivery: Delivery): GpuRun | null {
    if (delivery.videoCopy || !info.video || this.mode === "cpu") return null;
    const caps = this.caps;
    if (!caps?.encode || !caps.device || this.setAside) return null;
    const key = decodeKeyOf(info);
    // A subtitle drawn in is drawn on the CPU (H3 moves it): the picture is
    // decoded there, and only the encode goes to the GPU.
    const decode = !delivery.burn && key !== null && caps.decode.includes(key);
    return { device: caps.device, decode };
  }

  /** A GPU run failed: whether to run it again on the CPU (not in GPU only). */
  failed(reason: string): boolean {
    this.failures.push(Date.now());
    if (this.setAside) this.log.warn({ reason }, `The GPU failed ${FAILURES_ALLOWED} times within an hour: converting on the CPU until the admin checks again`);
    return this.mode !== "gpu";
  }

  state(): HardwareState {
    const caps = this.caps ?? { device: null, driver: null, encode: false, decode: [], error: this.mode === "cpu" ? null : "Not checked yet", checkedAt: "" };
    return { ...caps, mode: this.mode, checking: this.checking !== null, setAside: this.setAside };
  }
}
