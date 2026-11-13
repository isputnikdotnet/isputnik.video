// HLS for the files a browser can't play as they are (delivery.ts): a VOD
// playlist of the whole film up front, so the player knows its length and can
// seek anywhere, and the segments cut by ffmpeg as they are asked for.
//
// Where the cuts fall is decided before ffmpeg runs, so a segment is the same
// whichever run made it: on the file's own keyframes when the picture goes
// through as it is (it can only be cut there), on a fixed grid with keyframes
// forced onto it when it is re-encoded. Timestamps stay the file's own
// (-copyts), so a run started after a seek lines up with the segments before it.
//
// A version of a film (variantOf: the file, its sound track, burned subtitles,
// quality) is one entry, shared by everyone watching it. Each viewer's requests
// may start a run of ffmpeg, into a folder of its own; it runs ahead of its
// player, stops once far enough ahead, at a segment that is already there, or
// where a run ahead of it began, and starts again where the player gets to. A
// viewer nobody hears from for a minute is stopped; a version nobody watches
// goes, or, when its picture is re-encoded and there is a disk, waits ten
// minutes for someone to come back — and once every segment of it has been
// made it is kept (its folder under cache/ gets an entry.json) until the
// cleanup removes it (cache.ts: one limit with the copies for download).
//
// ffmpeg writes each segment to the transcode folder; once it is finished it is
// read into memory and the file goes, up to the memory the admin gives every
// viewer together (ConversionSettings). Past that a segment stays on the disk,
// or with memory only the run waits for the player to catch up — which is all
// there is when the folder is not a disk mapped into the container (mounts.ts).
// Only so many versions are converted at once; the next one is told so
// (HlsBusyError) rather than everyone slowing.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RUNG_LIMITS, type Delivery, type Rung } from "./delivery.js";
import { hdrOf, type MediaInfo, type Tools } from "./ffmpeg.js";
import { TONEMAP_VAAPI, deviceArgs, type GpuRun, type Hardware, type HardwareMode } from "./hardware.js";

/** Inside the conversion folder: the copies kept for download, never swept. */
export const COPIES_FOLDER = "copies";
/** …and every version being converted, one folder each, the ones converted all
 *  the way through kept (with an entry.json) between restarts. */
export const CACHE_FOLDER = "cache";
const ENTRY_FILE = "entry.json";
/** A version a job is filling: kept over a restart, so the job carries on. */
const FILLING_FILE = "filling.json";
/** A half-filled version whose job never came back is removed after this long. */
const FILLING_MAX_AGE_MS = 7 * 24 * 3600_000;
/** A half-made version kept on the disk is dropped this long after its last viewer. */
const ENTRY_GRACE_MS = 10 * 60_000;

/** How long a segment is meant to be. */
export const SEGMENT_TARGET_S = 6;
/** The shortest last segment. */
const MIN_LAST_S = 2;
/** A run stops once it is this many segments ahead of the player. */
const MAX_AHEAD = 30;
/** …and starts again when the player is this close to the end of what was made. */
const RESTART_WITHIN = 8;
/** Segments kept behind the player, for a short step back. */
const KEEP_BEHIND = 10;
/** A request further ahead than this of the run starts a new run there. */
const JUMP_AHEAD = 3;
/** With "wait", a run whose viewer's memory is full still keeps this many ahead. */
const MIN_AHEAD = 3;
const IDLE_MS = 60_000;
/** A playing film asks every few seconds. One silent this long is closed or paused,
 *  and no longer keeps its person from starting another. */
const PERSON_HOLD_MS = 20_000;
/** How long a request waits for its segment (a re-encode's first one is slowest). */
const WAIT_MS = 45_000;

export interface HlsPlan {
  itemId: string;
  file: string;
  info: MediaInfo;
  delivery: Delivery;
  /** Where each segment starts, in the file's own seconds. */
  starts: number[];
  /** Where the last one ends. */
  end: number;
  /** The file's size and time (`<size>:<mtime ms>`): a changed file is another
   *  version, so a kept one is never served for it. */
  stamp?: string;
}

/** The segment boundaries: keyframes at least a target apart, or a fixed grid. */
export function segmentStarts(info: MediaInfo, videoCopy: boolean, keyframes: number[] | null): number[] {
  // A sliver at the very end goes into the segment before it.
  const last = info.start + info.duration - MIN_LAST_S;
  if (!videoCopy || !keyframes || keyframes.length === 0) {
    const starts: number[] = [];
    for (let at = info.start; at < last || starts.length === 0; at += SEGMENT_TARGET_S) starts.push(round(at));
    return starts;
  }
  const starts = [keyframes[0]];
  for (const at of keyframes) {
    if (at - starts[starts.length - 1] >= SEGMENT_TARGET_S && at < last) starts.push(at);
  }
  return starts;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** A file's stamp for its plan: its size and time, so a changed file is another version. */
export const fileStamp = (file: { size: number; modified: Date }) => `${file.size}:${file.modified.getTime()}`;

export function buildPlan(itemId: string, file: string, info: MediaInfo, delivery: Delivery, keyframes: number[] | null, stamp?: string): HlsPlan {
  const starts = segmentStarts(info, delivery.videoCopy, keyframes);
  return { itemId, file, info, delivery, starts, end: Math.max(info.start + info.duration, starts[starts.length - 1] + 0.1), ...(stamp ? { stamp } : {}) };
}

const durationOf = (plan: HlsPlan, n: number) => (n + 1 < plan.starts.length ? plan.starts[n + 1] : plan.end) - plan.starts[n];

export function playlist(plan: HlsPlan): string {
  const durations = plan.starts.map((_, n) => durationOf(plan, n));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(Math.max(...durations)))}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS"
  ];
  durations.forEach((duration, n) => lines.push(`#EXTINF:${duration.toFixed(3)},`, `${n}.ts`));
  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}

/** The tallest picture a conversion makes without a rung asked; taller ones are scaled down to it. */
const MAX_HEIGHT = 1080;

/** ffmpeg's spelling of a bitrate: "8M", "1.5M", "128k". */
const rate = (bitsPerSecond: number) => (bitsPerSecond >= 1_000_000 ? `${bitsPerSecond / 1_000_000}M` : `${bitsPerSecond / 1000}k`);

/** HDR → SDR on the CPU: to linear light, into BT.709's colours, Hable's curve,
 *  back to BT.709 8-bit. What Jellyfin and most players do without a GPU. */
export function cpuTonemap(hdr: "pq" | "hlg"): string {
  const transfer = hdr === "pq" ? "smpte2084" : "arib-std-b67";
  return `zscale=tin=${transfer}:min=bt2020nc:pin=bt2020:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,` +
    "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";
}

/** The film as one MP4 instead of segments (copies.ts): where it goes, what it
 *  may cost, and how many threads a CPU encode may take. */
export interface WholeFile {
  path: string;
  limits: { bitRate: number; maxRate: number; audioRate: number };
  threads?: number;
}

/** ffmpeg's arguments for a run that starts at segment `from`. `gpu`: the
 *  picture is encoded on the GPU (hardware.ts), and decoded there too when
 *  it says so; null keeps it all on the CPU. */
/** How a background job (copies.ts) encodes its segments: a copy's limits, a
 *  slower preset than live (it has time, and the file is kept), fewer threads. */
export interface JobEncode {
  limits: { bitRate: number; maxRate: number; audioRate: number };
  threads?: number;
  preset?: string;
}

export function ffmpegArgs(plan: HlsPlan, from: number, outDir: string, gpuRun: GpuRun | null = null, whole: WholeFile | null = null, job: JobEncode | null = null): string[] {
  const { info, delivery } = plan;
  const args = ["-hide_banner", "-nostdin", "-v", "error", "-y"];
  // A whole file says how far it is on its standard output, for whoever waits.
  if (whole) args.push("-nostats", "-progress", "pipe:1");
  const gpu = delivery.videoCopy || !info.video ? null : gpuRun;
  if (gpu) {
    args.push(...deviceArgs(gpu.device));
    if (gpu.decode) args.push("-hwaccel", "vaapi", "-hwaccel_device", "va", "-hwaccel_output_format", "vaapi");
  }
  // Input seeking is relative to the file's start. A picture copied as it is can
  // only start on a keyframe, and ffmpeg lands on the one at or before the time
  // asked: just past the cut, so never the one before it.
  const offset = plan.starts[from] - info.start;
  if (from > 0) args.push("-ss", (offset + (delivery.videoCopy ? 0.05 : 0)).toFixed(3));
  // Segments keep the file's own clock, so runs line up; a whole file starts at zero.
  args.push("-i", plan.file, ...(whole ? [] : ["-copyts"]), "-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn");
  const burn = info.video ? delivery.burn : null;
  // The rung asked, else the tallest a conversion makes; and what it may cost.
  const maxHeight = delivery.rung ?? MAX_HEIGHT;
  const limits = whole?.limits ?? job?.limits ?? RUNG_LIMITS[delivery.rung ?? 1080];
  const threads = whole?.threads ?? job?.threads;
  const shrink = info.video !== null && info.video.height > maxHeight;
  // The GPU's scaler takes no "keep the shape" width: worked out here, even.
  const shrunkWidth = info.video && shrink ? Math.max(2, Math.round((info.video.width * maxHeight) / info.video.height / 2) * 2) : 0;
  // A picture drawn or scaled on the CPU goes up to the GPU to be encoded.
  const upload = gpu ? ",format=nv12,hwupload" : "";
  // HDR tone-mapped on the CPU, unless the GPU decodes and tone-maps it (H2).
  const hdr = delivery.videoCopy ? null : hdrOf(info.video);
  const cpuTone = hdr && !gpu?.tonemap ? cpuTonemap(hdr) : null;
  const gpuScale = shrink ? `scale_vaapi=w=${shrunkWidth}:h=${maxHeight}:format=nv12` : "scale_vaapi=format=nv12";
  if (info.video && burn && gpu?.overlay) {
    // All on the GPU (H3): the picture tone-mapped and scaled there, the
    // subtitle's canvas fitted to it on the CPU (a few small images), uploaded
    // with its alpha, and laid over it.
    const outW = shrink ? shrunkWidth : info.video.width;
    const outH = shrink ? maxHeight : info.video.height;
    const main = `[0:${info.video.index}]${gpu.tonemap ? `${TONEMAP_VAAPI},` : ""}${gpuScale}[m];`;
    const sub = `[0:${burn.index}]scale=${outW}:${outH},format=bgra,hwupload[sub];`;
    args.push("-filter_complex", `${main}${sub}[m][sub]overlay_vaapi=eof_action=pass[v]`, "-map", "[v]");
  } else if (info.video && burn) {
    // The subtitle drawn over the picture, its canvas fitted to the picture
    // first (a 1080p PGS track on a cropped or 720p film). An HDR picture is
    // tone-mapped before, so the subtitle keeps its own colours.
    const { width, height } = info.video;
    const fit = burn.width > 0 && burn.height > 0 && (burn.width !== width || burn.height !== height);
    const tone = cpuTone ? `[0:${info.video.index}]${cpuTone}[pic];` : "";
    const picture = cpuTone ? "[pic]" : `[0:${info.video.index}]`;
    const sub = fit ? `[0:${burn.index}]scale=${width}:${height}[sub];` : "";
    const over = `${picture}${fit ? "[sub]" : `[0:${burn.index}]`}overlay=eof_action=pass`;
    args.push("-filter_complex", `${tone}${sub}${over}${shrink ? `,scale=-2:${maxHeight}` : ""}${upload}[v]`, "-map", "[v]");
  } else if (info.video) {
    args.push("-map", `0:${info.video.index}`);
  }
  if (delivery.audio) args.push("-map", `0:${delivery.audio.index}`);

  if (delivery.videoCopy) {
    args.push("-c:v", "copy");
  } else if (gpu) {
    // Decoded on the GPU: scaled there, and never back to the CPU. Decoded on
    // the CPU: scaled there, then uploaded. The limits are the CPU encode's.
    if (!burn) {
      args.push("-vf", gpu.decode
        ? `${gpu.tonemap ? `${TONEMAP_VAAPI},` : ""}${gpuScale}`
        : `${shrink ? `scale=-2:${maxHeight},` : ""}${cpuTone ? `${cpuTone},` : ""}format=nv12,hwupload`);
    }
    args.push("-c:v", "h264_vaapi", "-rc_mode", "VBR", "-b:v", rate(limits.bitRate), "-maxrate", rate(limits.maxRate), "-bufsize", rate(limits.maxRate * 2), "-profile:v", "high");
    if (!whole) args.push("-force_key_frames", plan.starts.slice(from).map((at) => at.toFixed(3)).join(","));
  } else {
    args.push("-c:v", "libx264", "-preset", job?.preset ?? "veryfast", "-crf", "22", "-maxrate", rate(limits.maxRate), "-bufsize", rate(limits.maxRate * 2),
      "-profile:v", "high", "-pix_fmt", "yuv420p");
    const filters = [shrink ? `scale=-2:${maxHeight}` : null, cpuTone].filter(Boolean);
    if (filters.length > 0 && !burn) args.push("-vf", filters.join(","));
    // A keyframe on every cut, so every segment starts on one.
    if (!whole) args.push("-force_key_frames", plan.starts.slice(from).map((at) => at.toFixed(3)).join(","));
    if (threads) args.push("-threads", String(threads));
  }
  if (delivery.audio) {
    if (delivery.audioCopy) args.push("-c:a", "copy");
    else args.push("-c:a", "aac", "-ac", "2", "-b:a", rate(limits.audioRate));
    // Copied sound would start at the keyframe before the seek, seconds ahead of the
    // re-encoded picture. A player that sets its clock from a segment's first packet
    // (Media3, the TV app) would then show the whole film that far behind. A picture
    // that is copied too has to keep its keyframe, and starts on the cut anyway.
    if (delivery.audioCopy && !delivery.videoCopy) args.push("-copypriorss", "0");
  }

  // One file, its index at the front so a player can start before it has it all.
  if (whole) {
    args.push("-max_muxing_queue_size", "2048", "-movflags", "+faststart", "-f", "mp4", whole.path);
    return args;
  }

  // The segment muxer's split points count from the run's first timestamp; a
  // little early, so a cut lands on the keyframe meant and not the next one.
  const splits = plan.starts.slice(from + 1).map((at) => Math.max(0.1, at - plan.starts[from] - 0.3).toFixed(3));
  args.push("-max_muxing_queue_size", "2048", "-f", "segment");
  if (splits.length > 0) args.push("-segment_times", splits.join(","));
  else args.push("-segment_time", "100000");
  args.push("-segment_start_number", String(from), "-segment_format", "mpegts", "-muxdelay", "0", "-muxpreload", "0",
    path.join(outDir, "%d.ts"));
  return args;
}

/** Where finished segments are kept (home's docs/video-cache-plan.md → Storage):
 *  memory only (once it is full a run stays a few segments ahead and waits),
 *  memory and then the disk, or the disk only. The disk modes are in force only
 *  when the conversion folder is a disk mapped into the container (mounts.ts);
 *  otherwise it is memory only, whatever was chosen. */
export type ConversionStorage = "memory" | "memory-disk" | "disk";

/** What the admin sets on home's Apps page (GET/PUT /admin/conversion). */
export interface ConversionSettings {
  storage: ConversionStorage;
  /** MB of finished segments the engine keeps in memory, everyone together. */
  memoryMb: number;
  /** How many people may watch a converted film at once. */
  maxViewers: number;
  /** Where a picture is re-encoded (hardware.ts): the GPU where it can, the CPU only, or the GPU only. */
  hardware: HardwareMode;
  /** The most a viewer away from home (on the internet, by the gateway's network
   *  class) may have: a rung, or null for the file as it is. Their default too. */
  remoteQuality: Rung | null;
}

/** The memory one engine may use to start with: a tenth of the server's, at most 1 GB. */
export const MEMORY_MIN_MB = 64;
export const MEMORY_MAX_MB = 16_384;
export function defaultMemoryMb(totalBytes = os.totalmem()): number {
  const tenth = Math.floor(totalBytes / 10 / 1024 / 1024 / 64) * 64;
  return Math.max(256, Math.min(1024, tenth));
}

export const DEFAULT_CONVERSION: ConversionSettings = { storage: "memory-disk", memoryMb: defaultMemoryMb(), maxViewers: 3, hardware: "auto", remoteQuality: 720 };

/** The settings of engines before 0.35, which a home of then still sends:
 *  memory per viewer, and what to do when it was full. */
export interface LegacyConversion {
  memoryPerViewerMb: number;
  whenFull: "disk" | "wait";
}

/** The old words for the new settings, for a home that only knows them. */
export function legacyOf(settings: Pick<ConversionSettings, "storage" | "memoryMb" | "maxViewers">): LegacyConversion {
  return {
    memoryPerViewerMb: settings.storage === "disk" ? 0 : Math.max(1, Math.round(settings.memoryMb / settings.maxViewers)),
    whenFull: settings.storage === "memory" ? "wait" : "disk"
  };
}

/** The old settings in the new words: no memory was the disk only; "wait" was
 *  memory only; memory per viewer becomes the pool it amounted to. */
export function fromLegacy(legacy: LegacyConversion, maxViewers: number, memoryMb: number): Pick<ConversionSettings, "storage" | "memoryMb"> {
  if (legacy.memoryPerViewerMb === 0) return { storage: "disk", memoryMb };
  return {
    storage: legacy.whenFull === "wait" ? "memory" : "memory-disk",
    memoryMb: Math.min(MEMORY_MAX_MB, Math.max(MEMORY_MIN_MB, legacy.memoryPerViewerMb * maxViewers))
  };
}

/** A finished segment: in memory, or a file in the transcode folder. */
export type SegmentData = { data: Buffer } | { file: string; size: number };

/** One viewer converting, for the admin. */
export interface ConversionViewer {
  user: string;
  title: string;
  mode: string;
  /** Where the picture is re-encoded; null when it goes through as it is. */
  converter: "gpu" | "cpu" | null;
  /** An HDR picture, tone-mapped on the way. */
  hdr: boolean;
  /** The quality rung the picture is held under; null for the file as it is. */
  rung: Rung | null;
  converting: boolean;
  /** What their version holds (shared with whoever watches it too). */
  memoryBytes: number;
  diskBytes: number;
  /** Someone else watches the same version: made once for both. */
  shared: boolean;
  /** A film kept whole: nothing is made. */
  kept: boolean;
}

export interface ConversionUsage {
  viewers: ConversionViewer[];
  memoryBytes: number;
  /** Being made now (kept films not counted). */
  diskBytes: number;
  /** Films converted all through and kept on the disk. */
  kept: { count: number; bytes: number };
}

/** One version of one film being watched (home's docs/video-cache-plan.md, C2):
 *  its segments, wherever they are, shared by everyone watching that version. */
interface Entry {
  variant: string;
  plan: HlsPlan;
  title: string;
  /** <root>/cache/<variant>-<random>: the finished segments, each run's own folder
   *  inside. Never reused: on Windows a folder just removed can't be made again
   *  at once, and a killed ffmpeg may still hold files in the last one. */
  dir: string;
  /** Segments finished, wherever they are. */
  done: Set<number>;
  /** Finished segments read into memory. */
  memory: Map<number, Buffer>;
  /** Bytes in memory, counting segments being read in. */
  memoryBytes: number;
  /** Finished segments that are files in `dir`, by size. */
  onDisk: Map<number, number>;
  /** Segments being read into memory just now. */
  settling: Map<number, Promise<void>>;
  runs: Set<Run>;
  /** A GPU run failed: the rest of this version is made on the CPU. */
  cpuOnly: boolean;
  viewers: Set<Viewer>;
  /** Kept on the disk, every segment there: nothing is made. */
  complete: boolean;
  /** When its last viewer went; 0 while someone watches. */
  idleSince: number;
  /** Background fills working on it: it is not dropped meanwhile. */
  holds: number;
  /** A job is filling it (filling.json): dropped, its folder stays for the job to carry on. */
  filling?: boolean;
}

/** One ffmpeg run, writing into a folder of its own and handing each finished
 *  segment to its entry. It belongs to the viewer whose request started it. */
interface Run {
  entry: Entry;
  owner: Viewer;
  proc: ChildProcess;
  dir: string;
  /** The run's GPU, or null on the CPU. */
  gpu: GpuRun | null;
  /** The segment it started at. */
  from: number;
  /** The last segment it has started writing. */
  writing: number;
  /** A job's run, stood still while someone watches converted video. */
  paused?: boolean;
}

/** How a background fill stands. */
export interface FillState {
  done: number;
  total: number;
  complete: boolean;
}

/** What a fill is asked to do. */
export interface FillOptions {
  encode: JobEncode;
  /** Below everything else that runs here (nice), where the system has a word for it. */
  polite: boolean;
  signal: AbortSignal;
  onProgress?: (state: FillState) => void;
}

export class FillError extends Error {}

/** Someone watching: a person and a film ("<person>:<item>"), at a place in an entry. */
interface Viewer {
  key: string;
  /** A background job's stand-in (fill): not in the viewers, never counted. */
  job?: boolean;
  entry: Entry;
  /** Whose and what, for the admin's list. */
  user: string;
  title: string;
  run: Run | null;
  failure: string | null;
  lastWanted: number;
  /** Counts requests: only the newest may move the run (a seek), so one
   *  still waiting for a segment behind it can't drag the run back. */
  asked: number;
  touched: number;
}

/** A film converted all the way through and kept, for the admin and the cleanup. */
export interface KeptFilm {
  variant: string;
  /** Its folder under cache/. */
  folder: string;
  itemId: string;
  title: string;
  rung: Rung | null;
  segments: number;
  sizeBytes: number;
  completedAt: string;
  usedAt: string;
  /** Someone is watching it now: it can't be removed. */
  inUse?: boolean;
}

export class HlsError extends Error {}

/** A request for a version the player has moved off (another quality, sound or
 *  subtitles asked for since): answered so that nobody asks it again. */
export class HlsSupersededError extends HlsError {
  constructor() {
    super("Superseded");
  }
}

/** Why someone may not start converting a film now: every place the admin
 *  allows is taken ("household"), or they are watching another film converted
 *  ("person" — on another screen, or a tab left playing; it lets go once it
 *  has asked for nothing for PERSON_HOLD_MS). */
export interface HlsRefusal {
  reason: "household" | "person";
  limit: number;
  /** "person": the film they are watching. */
  title?: string;
}

export class HlsBusyError extends HlsError {
  constructor(readonly refusal: HlsRefusal) {
    super(refusal.reason === "person"
      ? `Already watching ${refusal.title ? `"${refusal.title}"` : "another film"} converted`
      : `${refusal.limit} ${refusal.limit === 1 ? "person is" : "people are"} already watching converted video`);
  }
}

/** Whose a viewer is: the person in "<person>:<item>". */
const personOf = (key: string) => key.slice(0, key.lastIndexOf(":"));

/** Which version of a film a set of segments is. The same plan cuts the same
 *  segments, whoever asks; a changed file (its stamp) is another version. */
export function variantOf(plan: HlsPlan): string {
  const { delivery } = plan;
  return createHash("sha1").update([
    plan.itemId, plan.file, plan.stamp ?? "", delivery.mode, delivery.videoCopy ? "copy" : "encode", delivery.audioCopy ? "copy" : "encode",
    delivery.audio?.index ?? "-", delivery.burn?.index ?? "-", delivery.rung ?? "original", plan.starts.length, plan.end
  ].join("|")).digest("hex").slice(0, 24);
}

/** Empties the folder and checks it can be written to; null when it can't. Only
 *  what is inside goes: the folder itself is often a mount point (/transcode in
 *  the image), which this user could never remove. What a previous process
 *  left behind is nobody's — but the copies kept for download (copies.ts) and
 *  the films kept once converted all through (cache/, those with their
 *  entry.json) outlive a restart. */
export function prepareRoot(root: string, log: Pick<HlsLog, "warn">): string | null {
  try {
    fs.mkdirSync(root, { recursive: true });
    for (const entry of fs.readdirSync(root)) {
      if (entry === COPIES_FOLDER) continue;
      if (entry === CACHE_FOLDER && fs.statSync(path.join(root, entry)).isDirectory()) {
        sweepCache(path.join(root, entry));
        continue;
      }
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    }
    fs.rmdirSync(fs.mkdtempSync(path.join(root, "check-")));
    return root;
  } catch (err) {
    log.warn({ err, root }, `Can't convert video in ${root} (${(err as NodeJS.ErrnoException).code ?? "unwritable"}); using a temporary folder inside the container instead`);
    return null;
  }
}

/** Only complete entries stay, without any run's leftovers. */
function sweepCache(cache: string): void {
  for (const name of fs.readdirSync(cache)) {
    const dir = path.join(cache, name);
    const filling = path.join(dir, FILLING_FILE);
    const stale = fs.existsSync(filling) && Date.now() - fs.statSync(filling).mtimeMs > FILLING_MAX_AGE_MS;
    if (stale || (!fs.existsSync(path.join(dir, ENTRY_FILE)) && !fs.existsSync(filling))) {
      fs.rmSync(dir, { recursive: true, force: true });
      continue;
    }
    for (const inner of fs.readdirSync(dir)) {
      if (inner.startsWith("run-")) fs.rmSync(path.join(dir, inner), { recursive: true, force: true });
    }
  }
}

export interface HlsLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export class HlsSessions {
  private viewers = new Map<string, Viewer>();
  /** Entries someone watches, or watched a moment ago, by variant. */
  private entries = new Map<string, Entry>();
  /** Films kept whole on the disk, by variant (cache/<variant>/entry.json). */
  private kept = new Map<string, KeptFilm>();
  /** When each player said it had gone, so a request of its still on the way
   *  can't start the film again behind it. */
  private left = new Map<string, number>();
  private sweeper: NodeJS.Timeout;
  private root: string;
  private runCount = 0;
  /** A film was just kept whole: the app keeps everything kept under its limit. */
  onKept: (() => void) | null = null;
  /** A version mostly made, left by its last viewer: the app may finish it off
   *  in the background (copies.ts) so it is kept. */
  onUnfinished: ((plan: HlsPlan, title: string) => void) | null = null;
  /** Share of segments made from which a version left behind is finished off. */
  finishFrom = 0.7;
  /** Half-filled versions a job left (filling.json), by variant: its folder. */
  private partials = new Map<string, string>();
  /** The version whose playlist each viewer ("<person>:<item>") asked for last.
   *  A switch of quality, sound or subtitles asks for the new playlist first, so
   *  a segment of any other version is a request left over from before it, and
   *  must not stop the new version's run to start its own (turn about, issue 3). */
  private chosen = new Map<string, string>();

  /** Where segments are made: for the Disks answer home's Dashboard reads. */
  get folder(): string {
    return this.root;
  }
  /** A folder made here (no TRANSCODE_PATH, or it was unusable): removed on close. */
  private ownsRoot: boolean;
  private settings: ConversionSettings = { ...DEFAULT_CONVERSION };
  private diskMapped = false;

  /** Whether the conversion folder is a disk mapped into the container
   *  (mounts.ts), told by the app; a folder made here never is. The films kept
   *  there are read in then. */
  setMapped(mapped: boolean): void {
    this.diskMapped = mapped;
    this.kept.clear();
    if (this.mapped) this.readKept();
  }

  get mapped(): boolean {
    return this.diskMapped && !this.ownsRoot;
  }

  /** The storage in force: what the admin chose, but memory only without a disk. */
  get storage(): ConversionStorage {
    return this.mapped ? this.settings.storage : "memory";
  }

  /** `root` null: a fresh temporary folder. `hardware`: the GPU, when the
   *  engine looks for one; without it everything is converted on the CPU. */
  constructor(private tools: Tools, root: string | null, private log: HlsLog, private hardware: Pick<Hardware, "choose" | "failed"> | null = null) {
    const usable = root ? prepareRoot(root, log) : null;
    this.root = usable ?? fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-hls-"));
    this.ownsRoot = !usable;
    this.sweeper = setInterval(() => this.sweep(), 15_000);
    this.sweeper.unref();
  }

  /** The admin's limits, in force at once; whoever is watching carries on. */
  configure(settings: ConversionSettings): void {
    this.settings = { ...settings };
  }

  /** How many may watch converted video at once. */
  get limit(): number {
    return this.settings.maxViewers;
  }

  /** Why `key` may not watch now; null when it may: already watching this film,
   *  or a place is free and this person is watching nothing else. One film at a
   *  time per person, refused rather than taken over, so two screens on one
   *  account don't stop each other's conversion turn about. A film of theirs
   *  gone quiet gives way, and its place counts as free (attach stops it).
   *  Places are counted by versions being converted: someone joining a version
   *  already being watched, or one kept whole, takes none (`plan`, when known;
   *  an item id alone, for a picture copied whose cuts need its keyframes, counts
   *  any version of that film someone else is watching). */
  refusal(key: string, plan?: HlsPlan | string): HlsRefusal | null {
    if (this.viewers.has(key)) return null;
    const person = personOf(key);
    const now = Date.now();
    const other = [...this.viewers.values()].find((viewer) => personOf(viewer.key) === person && now - viewer.touched <= PERSON_HOLD_MS);
    if (other) return { reason: "person", limit: this.settings.maxViewers, title: other.title };
    if (typeof plan === "string") {
      const watched = [...this.entries.values()].some((entry) => entry.plan.itemId === plan && [...entry.viewers].some((viewer) => personOf(viewer.key) !== person));
      if (watched) return null;
    } else if (plan) {
      const variant = variantOf(plan);
      if (this.kept.has(variant)) return null;
      const live = this.entries.get(variant);
      if (live && [...live.viewers].some((viewer) => personOf(viewer.key) !== person)) return null;
    }
    const taken = [...this.entries.values()].filter((entry) =>
      !entry.complete && [...entry.viewers].some((viewer) => personOf(viewer.key) !== person)).length;
    if (taken >= this.settings.maxViewers) return { reason: "household", limit: this.settings.maxViewers };
    return null;
  }

  canStart(key: string): boolean {
    return this.refusal(key) === null;
  }

  /** The player asked for this version's playlist: it is the one it plays now. */
  choose(key: string, plan: HlsPlan): void {
    this.chosen.delete(key);
    this.chosen.set(key, variantOf(plan));
    // Players that never said they left: the oldest go.
    while (this.chosen.size > 1000) this.chosen.delete(this.chosen.keys().next().value!);
  }

  /** Segment `n`, made if it isn't there yet. `who` names the viewer for the
   *  admin; `signal` is the player hanging up (a seek cancels the segment it
   *  was loading), which ends the wait; `asked` is when the request came in. */
  async segment(key: string, plan: HlsPlan, n: number, options: { who?: { user: string; title: string }; signal?: AbortSignal; asked?: number } = {}): Promise<SegmentData> {
    const who = options.who ?? { user: "", title: "" };
    const signal = options.signal;
    if (!Number.isInteger(n) || n < 0 || n >= plan.starts.length) throw new HlsError("No such segment");
    let viewer = this.viewers.get(key);
    // Another file under the same id, another sound track, other subtitles burned
    // in or another quality rung: another version (its cuts and its picture differ).
    const variant = variantOf(plan);
    const chosen = this.chosen.get(key);
    if (chosen !== undefined && chosen !== variant) throw new HlsSupersededError();
    if (viewer && viewer.entry.variant !== variant) {
      this.stop(key);
      viewer = undefined;
    }
    if (!viewer) {
      if (signal?.aborted) throw new HlsError("Cancelled");
      const left = this.left.get(key);
      if (left !== undefined && options.asked !== undefined && options.asked < left) throw new HlsError("Stopped");
      const refused = this.refusal(key, plan);
      if (refused) throw new HlsBusyError(refused);
      viewer = this.attach(key, plan, variant, who);
    }
    const entry = viewer.entry;
    viewer.touched = Date.now();
    viewer.lastWanted = n;
    const ask = ++viewer.asked;
    this.forgetBehind(entry);

    const deadline = Date.now() + WAIT_MS;
    let started = false;
    for (;;) {
      for (const run of [...entry.runs]) this.refresh(run);
      if (entry.done.has(n)) {
        this.keepAhead(viewer, n);
        await entry.settling.get(n);
        if (this.viewers.get(key) !== viewer) throw new HlsError("Stopped");
        const data = entry.memory.get(n);
        if (data) return { data };
        // Not forgotten while it was read in: it stayed on the disk.
        if (entry.onDisk.has(n)) return { file: path.join(entry.dir, `${n}.ts`), size: entry.onDisk.get(n) ?? 0 };
      }
      if (signal?.aborted) throw new HlsError("Cancelled");
      // Still wanted: a slow first segment is someone watching, not silence.
      viewer.touched = Date.now();
      if (viewer.failure && started) throw new HlsError(viewer.failure);
      // Someone's run is on its way to it (this viewer's, or another's).
      const coming = [...entry.runs].some((run) => n >= run.from && n <= run.writing + JUMP_AHEAD);
      if (!coming) {
        if (started && !viewer.run) throw new HlsError(viewer.failure ?? "The conversion stopped");
        // A newer request moved the run elsewhere: this one is not what the
        // player wants any more, and restarting for it would undo the seek.
        if (ask !== viewer.asked) throw new HlsSupersededError();
        this.start(viewer, n);
        started = true;
      }
      if (Date.now() > deadline) throw new HlsError("The segment took too long to make");
      await new Promise((resolve) => setTimeout(resolve, 120));
      // The viewer was stopped while this request waited (the player left).
      if (this.viewers.get(key) !== viewer) throw new HlsError("Stopped");
    }
  }

  /** The player has gone: stop now, and refuse what it asked before it went. */
  leave(key: string): void {
    this.left.set(key, Date.now());
    this.chosen.delete(key);
    this.stop(key);
  }

  /** The viewer goes; their run stops, and the entry follows once nobody is left. */
  stop(key: string): void {
    const viewer = this.viewers.get(key);
    if (!viewer) return;
    this.viewers.delete(key);
    if (viewer.run) this.kill(viewer.run);
    const entry = viewer.entry;
    entry.viewers.delete(viewer);
    if (entry.viewers.size > 0) return;
    entry.idleSince = Date.now();
    if (entry.holds > 0) {
      for (const n of [...entry.memory.keys()]) this.dropMemory(entry, n);
    } else if (entry.complete) {
      this.drop(entry, false);
    } else if (this.keeps(entry)) {
      // Kept a while on the disk for whoever comes next; memory goes now.
      for (const n of [...entry.memory.keys()]) this.dropMemory(entry, n);
      // Mostly made: finished off in the background, so it is kept.
      if (entry.onDisk.size >= entry.plan.starts.length * this.finishFrom) this.onUnfinished?.(entry.plan, entry.title);
    } else {
      this.drop(entry, true);
    }
  }

  /** Runs converting right now, for the admin and the log. */
  active(): number {
    let runs = 0;
    for (const entry of this.entries.values()) runs += entry.runs.size;
    return runs;
  }

  /** Who is watching converted video, and what it holds in memory and on the disk. */
  usage(): ConversionUsage {
    const viewers = [...this.viewers.values()].map((viewer) => {
      const entry = viewer.entry;
      return {
        user: viewer.user,
        title: viewer.title,
        mode: entry.plan.delivery.mode,
        converter: entry.plan.delivery.videoCopy || entry.complete ? null : viewer.run?.gpu ? "gpu" as const : "cpu" as const,
        hdr: !entry.plan.delivery.videoCopy && hdrOf(entry.plan.info.video) !== null,
        rung: entry.plan.delivery.rung,
        converting: viewer.run !== null,
        memoryBytes: entry.memoryBytes,
        diskBytes: sumOf(entry.onDisk),
        shared: entry.viewers.size > 1,
        kept: entry.complete
      };
    });
    const live = [...this.entries.values()];
    const kept = [...this.kept.values()];
    return {
      viewers,
      memoryBytes: live.reduce((sum, entry) => sum + entry.memoryBytes, 0),
      diskBytes: live.filter((entry) => !entry.complete).reduce((sum, entry) => sum + sumOf(entry.onDisk), 0),
      kept: { count: kept.length, bytes: kept.reduce((sum, film) => sum + film.sizeBytes, 0) }
    };
  }

  /** The films kept whole, used longest ago first. */
  keptFilms(): KeptFilm[] {
    return [...this.kept.values()]
      .map((film) => ({ ...film, inUse: (this.entries.get(film.variant)?.viewers.size ?? 0) > 0 }))
      .sort((a, b) => a.usedAt.localeCompare(b.usedAt));
  }

  /** Removes a kept film; false while someone watches it. */
  removeKept(variant: string): boolean {
    const live = this.entries.get(variant);
    if (live && live.viewers.size > 0) return false;
    if (live) this.drop(live, true);
    const film = this.kept.get(variant);
    this.kept.delete(variant);
    if (film) fs.rm(path.join(this.root, CACHE_FOLDER, film.folder), { recursive: true, force: true }, () => undefined);
    return true;
  }

  /** How far a version is made: a live entry, a kept film, or nothing yet. */
  fillState(plan: HlsPlan): FillState {
    const variant = variantOf(plan);
    const total = plan.starts.length;
    if (this.kept.has(variant)) return { done: total, total, complete: true };
    const entry = this.entries.get(variant);
    if (entry) return { done: entry.onDisk.size, total, complete: entry.complete };
    const partial = this.partials.get(variant);
    if (partial) {
      const made = fs.readdirSync(path.join(this.root, CACHE_FOLDER, partial)).filter((name) => /^\d+\.ts$/.test(name)).length;
      return { done: made, total, complete: false };
    }
    return { done: 0, total, complete: false };
  }

  /** Whether a fill can finish here: kept versions need the disk. */
  get canKeep(): boolean {
    return this.storage !== "memory";
  }

  /** Makes every missing segment of a version in the background, a gap at a
   *  time, alongside whoever watches it (what they make counts; what this
   *  makes they get), until it is kept whole. Its folder is noted, so after a
   *  restart the same job carries on where it was. Rejects with FillError when
   *  it can't; resolves once kept. */
  async fill(plan: HlsPlan, title: string, options: FillOptions): Promise<void> {
    if (!this.canKeep) throw new FillError("Nothing can be kept: the conversion folder is not a disk of its own, or memory only is chosen");
    const variant = variantOf(plan);
    if (this.kept.has(variant)) return;
    const entry = this.entries.get(variant) ?? this.open(variant, plan, title);
    entry.holds += 1;
    entry.idleSince = 0;
    const stand: Viewer = { key: `job:${variant}`, job: true, entry, user: "", title, run: null, failure: null, lastWanted: 0, asked: 0, touched: Date.now() };
    const note = path.join(entry.dir, FILLING_FILE);
    try {
      fs.writeFileSync(note, JSON.stringify({ variant, itemId: plan.itemId, title }));
      entry.filling = true;
      const total = plan.starts.length;
      for (;;) {
        if (options.signal.aborted) throw new FillError("Stopped");
        if (this.entries.get(variant) !== entry) throw new FillError("Stopped");
        for (const run of [...entry.runs]) this.refresh(run);
        options.onProgress?.({ done: entry.onDisk.size, total, complete: entry.complete });
        if (entry.complete) return;
        let next = 0;
        while (next < total && entry.onDisk.has(next)) next += 1;
        if (next >= total) {
          // Every segment made, some only in memory a moment ago: kept now, or never.
          this.complete(entry);
          if (!entry.complete) throw new FillError("The version could not be kept");
          return;
        }
        if (stand.failure) throw new FillError(stand.failure);
        const coming = [...entry.runs].some((run) => next >= run.from && next <= run.writing + JUMP_AHEAD);
        if (!coming && !stand.run) this.start(stand, next, { encode: options.encode, polite: options.polite });
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    } finally {
      if (stand.run) this.kill(stand.run);
      entry.holds -= 1;
      if (entry.complete) {
        entry.filling = false;
        fs.rm(note, { force: true }, () => undefined);
      }
      if (entry.holds === 0 && entry.viewers.size === 0) {
        entry.idleSince = Date.now();
        if (entry.complete) this.drop(entry, false);
      }
    }
  }

  /** A job given up: its half-made version goes, unless someone is watching it. */
  dropFill(plan: HlsPlan): void {
    const variant = variantOf(plan);
    const partial = this.partials.get(variant);
    if (partial) {
      this.partials.delete(variant);
      fs.rm(path.join(this.root, CACHE_FOLDER, partial), { recursive: true, force: true }, () => undefined);
    }
    const entry = this.entries.get(variant);
    if (entry && !entry.complete && entry.viewers.size === 0 && entry.holds === 0) this.drop(entry, true);
  }

  /** A kept version's segments in order, for a copy made of them (copies.ts). */
  keptSegments(plan: HlsPlan): string[] | null {
    const film = this.kept.get(variantOf(plan));
    if (!film) return null;
    const dir = path.join(this.root, CACHE_FOLDER, film.folder);
    const files = plan.starts.map((_, n) => path.join(dir, `${n}.ts`));
    return files.every((file) => fs.existsSync(file)) ? files : null;
  }

  /** Whether a version is kept whole. */
  isKept(plan: HlsPlan): boolean {
    return this.kept.has(variantOf(plan));
  }

  /** Stands background fills still while someone watches converted video, and
   *  lets them go on after. (Not on Windows, which has no way to say so.) */
  pauseFills(paused: boolean): void {
    if (process.platform === "win32") return;
    for (const entry of this.entries.values()) {
      for (const run of entry.runs) {
        if (!run.owner.job || Boolean(run.paused) === paused) continue;
        run.paused = paused;
        run.proc.kill(paused ? "SIGSTOP" : "SIGCONT");
      }
    }
  }

  /** Viewers watching converted video now (not background fills). */
  watching(): number {
    let runs = 0;
    for (const entry of this.entries.values()) for (const run of entry.runs) if (!run.owner.job) runs += 1;
    return runs;
  }

  /** A half-filled folder taken up again: whatever segments it has count. */
  private adopt(variant: string, plan: HlsPlan, title: string, dir: string): Entry {
    for (const inner of fs.readdirSync(dir)) {
      if (inner.startsWith("run-")) fs.rmSync(path.join(dir, inner), { recursive: true, force: true });
    }
    const onDisk = new Map<number, number>();
    for (let n = 0; n < plan.starts.length; n++) {
      try {
        onDisk.set(n, fs.statSync(path.join(dir, `${n}.ts`)).size);
      } catch {
        /* still to make */
      }
    }
    const entry: Entry = {
      variant, plan, title, dir, done: new Set(onDisk.keys()), memory: new Map(), memoryBytes: 0, onDisk, settling: new Map(),
      runs: new Set(), cpuOnly: false, viewers: new Set(), complete: false, idleSince: 0, holds: 0
    };
    this.entries.set(variant, entry);
    return entry;
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const key of [...this.viewers.keys()]) this.stop(key);
    for (const entry of [...this.entries.values()]) this.drop(entry, !entry.complete);
    if (this.ownsRoot) fs.rm(this.root, { recursive: true, force: true }, () => undefined);
  }

  /** The memory everyone's segments may take together; none for the disk only. */
  private get budget(): number {
    return this.storage === "disk" ? 0 : this.settings.memoryMb * 1024 * 1024;
  }

  /** Bytes of segments in memory, every entry together. */
  private get pooled(): number {
    let sum = 0;
    for (const entry of this.entries.values()) sum += entry.memoryBytes;
    return sum;
  }

  /** Memory only and the memory full: a run goes no further than a few
   *  segments ahead of its player (each still gets those, so one viewer
   *  can't starve the rest). */
  private full(): boolean {
    return this.storage === "memory" && this.pooled >= this.budget;
  }

  /** Whether an entry's segments stay on the disk, to be kept once all are
   *  there: a picture re-encoded (dear to make again), with a disk to keep it on. */
  private keeps(entry: Entry): boolean {
    return this.storage !== "memory" && !entry.plan.delivery.videoCopy;
  }

  private attach(key: string, plan: HlsPlan, variant: string, who: { user: string; title: string }): Viewer {
    // refusal let this through, so any other film of theirs has gone quiet.
    const person = personOf(key);
    for (const other of [...this.viewers.keys()]) {
      if (personOf(other) === person) this.stop(other);
    }
    const entry = this.entries.get(variant) ?? this.fromKept(variant, plan, who.title) ?? this.open(variant, plan, who.title);
    entry.idleSince = 0;
    const viewer: Viewer = { key, entry, user: who.user, title: who.title, run: null, failure: null, lastWanted: 0, asked: 0, touched: Date.now() };
    entry.viewers.add(viewer);
    this.viewers.set(key, viewer);
    const film = this.kept.get(variant);
    if (film) {
      film.usedAt = new Date().toISOString();
      this.writeKept(film);
    }
    return viewer;
  }

  private open(variant: string, plan: HlsPlan, title: string): Entry {
    fs.mkdirSync(path.join(this.root, CACHE_FOLDER), { recursive: true });
    const partial = this.partials.get(variant);
    this.partials.delete(variant);
    if (partial) return this.adopt(variant, plan, title, path.join(this.root, CACHE_FOLDER, partial));
    const dir = fs.mkdtempSync(path.join(this.root, CACHE_FOLDER, `${variant}-`));
    const entry: Entry = {
      variant, plan, title, dir, done: new Set(), memory: new Map(), memoryBytes: 0, onDisk: new Map(), settling: new Map(),
      runs: new Set(), cpuOnly: false, viewers: new Set(), complete: false, idleSince: 0, holds: 0
    };
    this.entries.set(variant, entry);
    return entry;
  }

  /** A kept film, back as an entry whose every segment is on the disk; null
   *  (and the film forgotten) when it isn't all there any more. */
  private fromKept(variant: string, plan: HlsPlan, title: string): Entry | null {
    const film = this.kept.get(variant);
    if (!film) return null;
    const dir = path.join(this.root, CACHE_FOLDER, film.folder);
    const onDisk = new Map<number, number>();
    for (let n = 0; n < plan.starts.length; n++) {
      try {
        onDisk.set(n, fs.statSync(path.join(dir, `${n}.ts`)).size);
      } catch {
        break;
      }
    }
    if (film.segments !== plan.starts.length || onDisk.size !== plan.starts.length) {
      this.log.warn({ item: film.itemId, variant }, "A kept film is no longer whole; making it again");
      this.kept.delete(variant);
      return null;
    }
    const entry: Entry = {
      variant, plan, title, dir, done: new Set(onDisk.keys()), memory: new Map(), memoryBytes: 0, onDisk, settling: new Map(),
      runs: new Set(), cpuOnly: false, viewers: new Set(), complete: true, idleSince: 0, holds: 0
    };
    this.entries.set(variant, entry);
    return entry;
  }

  /** Forgets a live entry; `files`: its folder goes too (not a kept film's). */
  private drop(entry: Entry, files: boolean): void {
    for (const run of [...entry.runs]) this.kill(run);
    entry.memory.clear();
    entry.memoryBytes = 0;
    if (this.entries.get(entry.variant) === entry) this.entries.delete(entry.variant);
    if (files && !entry.complete && entry.holds === 0) {
      // A job's half-filled version waits for the job to come back (night, idle).
      if (entry.filling) this.partials.set(entry.variant, path.basename(entry.dir));
      else fs.rm(entry.dir, { recursive: true, force: true }, () => undefined);
    }
  }

  private start(viewer: Viewer, from: number, job: { encode: JobEncode; polite: boolean } | null = null): void {
    const entry = viewer.entry;
    if (viewer.run) this.kill(viewer.run);
    viewer.failure = null;
    const gpu = entry.cpuOnly ? null : this.hardware?.choose(entry.plan.info, entry.plan.delivery) ?? null;
    const dir = path.join(entry.dir, `run-${++this.runCount}`);
    fs.mkdirSync(dir, { recursive: true });
    const args = ffmpegArgs(entry.plan, from, dir, gpu, null, job?.encode ?? null);
    const polite = Boolean(job?.polite) && process.platform !== "win32";
    const proc = spawn(polite ? "nice" : this.tools.ffmpeg, polite ? ["-n", "15", this.tools.ffmpeg, ...args] : args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    const run: Run = { entry, owner: viewer, proc, dir, gpu, from, writing: from - 1 };
    entry.runs.add(run);
    viewer.run = run;
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    proc.on("error", (err) => {
      if (!entry.runs.has(run)) return;
      this.end(run);
      viewer.failure = `ffmpeg could not start: ${err.message}`;
      this.log.warn({ item: entry.plan.itemId, err }, "ffmpeg could not start");
    });
    proc.on("exit", (code, signal) => {
      if (!entry.runs.has(run)) return;
      if (code === 0) {
        // The last segment of the run is finished too.
        for (let n = run.from; n < entry.plan.starts.length; n++) {
          if (fs.existsSync(path.join(dir, `${n}.ts`))) this.settle(entry, n, path.join(dir, `${n}.ts`));
        }
        this.end(run);
        return;
      }
      this.end(run);
      const reason = stderr.trim().split(/\r?\n/).pop() || `exit ${code ?? signal}`;
      // The GPU failed: the same segments again on the CPU, for the rest of this
      // version, unless the admin asked for the GPU only.
      if (gpu && this.hardware?.failed(reason, stderr)) {
        this.log.warn({ item: entry.plan.itemId, reason, stderr: stderr.trim() }, "The GPU could not convert this; converting it on the CPU");
        entry.cpuOnly = true;
        let next = run.from;
        while (entry.done.has(next)) next += 1;
        if (next < entry.plan.starts.length && this.viewers.get(viewer.key) === viewer) this.start(viewer, next);
        return;
      }
      viewer.failure = `The conversion failed: ${reason}`;
      this.log.warn({ item: entry.plan.itemId, code, signal, stderr: stderr.trim() }, "ffmpeg failed");
    });
    this.log.info({ item: entry.plan.itemId, from, mode: entry.plan.delivery.mode, gpu: gpu ? (gpu.decode ? "decode+encode" : "encode") : null, shared: entry.viewers.size > 1 }, "Converting");
  }

  /** A run is over: out of its entry and its viewer, its folder gone. */
  private end(run: Run): void {
    run.entry.runs.delete(run);
    if (run.owner.run === run) run.owner.run = null;
    fs.rm(run.dir, { recursive: true, force: true }, () => undefined);
  }

  /** Stops a run; the segment it was in the middle of goes with its folder. */
  private kill(run: Run): void {
    if (!run.entry.runs.has(run)) return;
    if (run.paused) run.proc.kill("SIGCONT");
    run.proc.kill("SIGKILL");
    this.end(run);
  }

  /** A finished segment from a run's folder: into the entry's (once — another
   *  run may have made it first), then into memory while the pool allows (its
   *  bytes counted at once, so two read in together can't both squeeze in).
   *  An entry being kept keeps the file as well; otherwise it goes once read in.
   *  With memory only everything goes into memory, and refresh stops the run
   *  once the pool is used. */
  private settle(entry: Entry, n: number, from: string): void {
    if (entry.done.has(n)) {
      fs.rm(from, { force: true }, () => undefined);
      return;
    }
    const file = path.join(entry.dir, `${n}.ts`);
    let size: number;
    try {
      fs.renameSync(from, file);
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    entry.done.add(n);
    entry.onDisk.set(n, size);
    const budget = this.budget;
    // Nobody watching (a background fill): straight to the disk.
    const toMemory = budget > 0 && entry.viewers.size > 0 && (this.storage === "memory" || this.pooled + size <= budget);
    if (!toMemory) {
      this.complete(entry);
      return;
    }
    entry.memoryBytes += size;
    const reading = fs.promises.readFile(file).then(
      (data) => {
        // Forgotten or dropped meanwhile: its place is given back.
        if (this.entries.get(entry.variant) !== entry || !entry.done.has(n)) {
          entry.memoryBytes -= size;
          return;
        }
        entry.memoryBytes += data.length - size;
        entry.memory.set(n, data);
        if (!this.keeps(entry)) {
          entry.onDisk.delete(n);
          fs.rm(file, { force: true }, () => undefined);
        }
        this.complete(entry);
      },
      () => {
        entry.memoryBytes -= size;
        entry.done.delete(n);
        entry.onDisk.delete(n);
      }
    ).finally(() => entry.settling.delete(n));
    entry.settling.set(n, reading);
  }

  /** Every segment a file on the disk: the film is kept whole. */
  private complete(entry: Entry): void {
    if (entry.complete || !this.keeps(entry) || entry.onDisk.size < entry.plan.starts.length) return;
    entry.complete = true;
    for (const run of [...entry.runs]) this.kill(run);
    const now = new Date().toISOString();
    const film: KeptFilm = {
      variant: entry.variant, folder: path.basename(entry.dir), itemId: entry.plan.itemId, title: entry.title, rung: entry.plan.delivery.rung,
      segments: entry.plan.starts.length, sizeBytes: sumOf(entry.onDisk), completedAt: now, usedAt: now
    };
    this.kept.set(entry.variant, film);
    this.writeKept(film);
    this.log.info({ item: film.itemId, variant: film.variant, bytes: film.sizeBytes }, "Converted all through: kept");
    this.onKept?.();
  }

  /** The note that keeps a film, written whole and swapped in: two notes at
   *  once, or a restart halfway, must never leave an empty one. */
  private writeKept(film: KeptFilm): void {
    const { inUse: _inUse, ...stored } = film;
    const file = path.join(this.root, CACHE_FOLDER, film.folder, ENTRY_FILE);
    try {
      fs.writeFileSync(`${file}.part`, JSON.stringify(stored));
      fs.renameSync(`${file}.part`, file);
    } catch (err) {
      this.log.warn({ err, variant: film.variant }, "Could not note a kept film");
    }
  }

  /** The kept films' notes, read on start. */
  private readKept(): void {
    const cache = path.join(this.root, CACHE_FOLDER);
    let names: string[];
    try {
      names = fs.readdirSync(cache);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const film = JSON.parse(fs.readFileSync(path.join(cache, name, ENTRY_FILE), "utf8")) as KeptFilm;
        if (typeof film.variant === "string") this.kept.set(film.variant, { ...film, folder: name });
        continue;
      } catch {
        /* not kept whole */
      }
      try {
        const filling = JSON.parse(fs.readFileSync(path.join(cache, name, FILLING_FILE), "utf8")) as { variant?: string };
        if (typeof filling.variant === "string") this.partials.set(filling.variant, name);
      } catch {
        /* not kept: prepareRoot removed it, or it is someone's leftover */
      }
    }
  }

  /** A run's finished segments go to its entry: a segment counts as finished
   *  once the run has started the next one. A run stops when it is far enough
   *  ahead of its viewer, when memory is full, or when it reaches a segment
   *  another run made or is making. */
  private refresh(run: Run): void {
    const entry = run.entry;
    if (!entry.runs.has(run)) return;
    while (fs.existsSync(path.join(run.dir, `${run.writing + 1}.ts`))) run.writing += 1;
    for (let n = run.from; n < run.writing; n++) {
      const file = path.join(run.dir, `${n}.ts`);
      if (fs.existsSync(file)) this.settle(entry, n, file);
    }
    if (!entry.runs.has(run)) return;
    if (run.owner.job) run.owner.lastWanted = run.writing;
    const ahead = run.writing - run.owner.lastWanted;
    // The segment it is writing now was made already, or a run started ahead of
    // it is making it: from here on it would only repeat what is there.
    const repeating = run.writing >= run.from && (entry.done.has(run.writing) ||
      [...entry.runs].some((other) => other !== run && other.from > run.from && other.from <= run.writing && run.writing <= other.writing + 1));
    if (ahead > MAX_AHEAD || (this.full() && ahead >= MIN_AHEAD) || repeating) this.kill(run);
  }

  /** Near the end of what was made and nothing coming: carry on from there. */
  private keepAhead(viewer: Viewer, n: number): void {
    const entry = viewer.entry;
    if (viewer.run || entry.complete) return;
    let next = n + 1;
    while (entry.done.has(next)) next += 1;
    if (next >= entry.plan.starts.length || next - n > RESTART_WITHIN) return;
    if ([...entry.runs].some((run) => next >= run.from && next <= run.writing + JUMP_AHEAD)) return;
    // Memory full: only once the player is nearly out of what was made.
    if (this.full() && next - n >= MIN_AHEAD) return;
    this.start(viewer, next);
  }

  /** Out of memory; still a file if it is one. */
  private dropMemory(entry: Entry, n: number): void {
    const data = entry.memory.get(n);
    if (!data) return;
    entry.memory.delete(n);
    entry.memoryBytes -= data.length;
    if (!entry.onDisk.has(n)) entry.done.delete(n);
  }

  private forget(entry: Entry, n: number): void {
    entry.done.delete(n);
    const data = entry.memory.get(n);
    if (data) {
      entry.memory.delete(n);
      entry.memoryBytes -= data.length;
    }
    if (entry.onDisk.delete(n)) fs.rm(path.join(entry.dir, `${n}.ts`), { force: true }, () => undefined);
  }

  /** What is behind every viewer of the entry: kept on the disk when the entry
   *  is being kept, else forgotten — and out of memory first when it is full. */
  private forgetBehind(entry: Entry): void {
    if (entry.complete || entry.viewers.size === 0) return;
    const low = Math.min(...[...entry.viewers].map((viewer) => viewer.lastWanted));
    const keeping = this.keeps(entry);
    for (const done of [...entry.done]) {
      if (done < low - KEEP_BEHIND) {
        if (keeping) this.dropMemory(entry, done);
        else this.forget(entry, done);
      }
    }
    // Memory full: what is behind the player goes first, to make room ahead.
    for (const done of [...entry.done].filter((at) => at < low).sort((a, b) => a - b)) {
      if (!this.full()) break;
      if (!entry.memory.has(done)) continue;
      if (keeping) this.dropMemory(entry, done);
      else this.forget(entry, done);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const entry of [...this.entries.values()]) {
      for (const run of [...entry.runs]) this.refresh(run);
    }
    for (const viewer of [...this.viewers.values()]) {
      if (now - viewer.touched > IDLE_MS) this.stop(viewer.key);
    }
    // Half-made versions nobody has come back to.
    for (const entry of [...this.entries.values()]) {
      if (entry.viewers.size === 0 && entry.holds === 0 && entry.idleSince > 0 && now - entry.idleSince > ENTRY_GRACE_MS) this.drop(entry, true);
    }
    for (const [key, at] of this.left) {
      if (now - at > IDLE_MS) this.left.delete(key);
    }
  }
}

const sumOf = (sizes: Map<number, number>) => {
  let sum = 0;
  for (const size of sizes.values()) sum += size;
  return sum;
};
