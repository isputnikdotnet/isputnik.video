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
// One run per person and film. It runs ahead of the player, stops once it is
// far enough ahead, and starts again where the player gets to; a seek past what
// it has made starts it there. A session nobody asks anything of for a minute
// is stopped and its segments deleted.
//
// ffmpeg writes each segment to the transcode folder; once it is finished it is
// read into memory and the file goes, up to the admin's share per viewer
// (ConversionSettings). Past that share a segment either stays on the disk or
// the run waits for the player to catch up. Only so many people convert at
// once; the next one is told so (HlsBusyError) rather than everyone slowing.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Delivery } from "./delivery.js";
import { hdrOf, type MediaInfo, type Tools } from "./ffmpeg.js";
import { TONEMAP_VAAPI, deviceArgs, type GpuRun, type Hardware, type HardwareMode } from "./hardware.js";

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

export function buildPlan(itemId: string, file: string, info: MediaInfo, delivery: Delivery, keyframes: number[] | null): HlsPlan {
  const starts = segmentStarts(info, delivery.videoCopy, keyframes);
  return { itemId, file, info, delivery, starts, end: Math.max(info.start + info.duration, starts[starts.length - 1] + 0.1) };
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

/** The tallest picture a conversion makes; taller ones are scaled down to it. */
const MAX_HEIGHT = 1080;

/** HDR → SDR on the CPU: to linear light, into BT.709's colours, Hable's curve,
 *  back to BT.709 8-bit. What Jellyfin and most players do without a GPU. */
export function cpuTonemap(hdr: "pq" | "hlg"): string {
  const transfer = hdr === "pq" ? "smpte2084" : "arib-std-b67";
  return `zscale=tin=${transfer}:min=bt2020nc:pin=bt2020:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,` +
    "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";
}

/** ffmpeg's arguments for a run that starts at segment `from`. `gpu`: the
 *  picture is encoded on the GPU (hardware.ts), and decoded there too when
 *  it says so; null keeps it all on the CPU. */
export function ffmpegArgs(plan: HlsPlan, from: number, outDir: string, gpuRun: GpuRun | null = null): string[] {
  const { info, delivery } = plan;
  const args = ["-hide_banner", "-nostdin", "-v", "error", "-y"];
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
  args.push("-i", plan.file, "-copyts", "-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn");
  const burn = info.video ? delivery.burn : null;
  const shrink = info.video !== null && info.video.height > MAX_HEIGHT;
  // The GPU's scaler takes no "keep the shape" width: worked out here, even.
  const shrunkWidth = info.video && shrink ? Math.max(2, Math.round((info.video.width * MAX_HEIGHT) / info.video.height / 2) * 2) : 0;
  // A picture drawn or scaled on the CPU goes up to the GPU to be encoded.
  const upload = gpu ? ",format=nv12,hwupload" : "";
  // HDR tone-mapped on the CPU, unless the GPU decodes and tone-maps it (H2).
  const hdr = delivery.videoCopy ? null : hdrOf(info.video);
  const cpuTone = hdr && !gpu?.tonemap ? cpuTonemap(hdr) : null;
  const gpuScale = shrink ? `scale_vaapi=w=${shrunkWidth}:h=${MAX_HEIGHT}:format=nv12` : "scale_vaapi=format=nv12";
  if (info.video && burn && gpu?.overlay) {
    // All on the GPU (H3): the picture tone-mapped and scaled there, the
    // subtitle's canvas fitted to it on the CPU (a few small images), uploaded
    // with its alpha, and laid over it.
    const outW = shrink ? shrunkWidth : info.video.width;
    const outH = shrink ? MAX_HEIGHT : info.video.height;
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
    args.push("-filter_complex", `${tone}${sub}${over}${shrink ? `,scale=-2:${MAX_HEIGHT}` : ""}${upload}[v]`, "-map", "[v]");
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
        : `${shrink ? `scale=-2:${MAX_HEIGHT},` : ""}${cpuTone ? `${cpuTone},` : ""}format=nv12,hwupload`);
    }
    args.push("-c:v", "h264_vaapi", "-rc_mode", "VBR", "-b:v", "8M", "-maxrate", "10M", "-bufsize", "20M", "-profile:v", "high");
    args.push("-force_key_frames", plan.starts.slice(from).map((at) => at.toFixed(3)).join(","));
  } else {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-maxrate", "10M", "-bufsize", "20M",
      "-profile:v", "high", "-pix_fmt", "yuv420p");
    const filters = [shrink ? `scale=-2:${MAX_HEIGHT}` : null, cpuTone].filter(Boolean);
    if (filters.length > 0 && !burn) args.push("-vf", filters.join(","));
    // A keyframe on every cut, so every segment starts on one.
    args.push("-force_key_frames", plan.starts.slice(from).map((at) => at.toFixed(3)).join(","));
  }
  if (delivery.audio) {
    if (delivery.audioCopy) args.push("-c:a", "copy");
    else args.push("-c:a", "aac", "-ac", "2", "-b:a", "192k");
    // Copied sound would start at the keyframe before the seek, seconds ahead of the
    // re-encoded picture. A player that sets its clock from a segment's first packet
    // (Media3, the TV app) would then show the whole film that far behind. A picture
    // that is copied too has to keep its keyframe, and starts on the cut anyway.
    if (delivery.audioCopy && !delivery.videoCopy) args.push("-copypriorss", "0");
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

/** What the admin sets on home's Apps page (GET/PUT /admin/conversion). */
export interface ConversionSettings {
  /** MB of finished segments each viewer keeps in memory; 0 keeps them all on the disk. */
  memoryPerViewerMb: number;
  /** How many people may watch a converted film at once. */
  maxViewers: number;
  /** Once a viewer's memory is full: carry on on the disk, or stay that far ahead. */
  whenFull: "disk" | "wait";
  /** Where a picture is re-encoded (hardware.ts): the GPU where it can, the CPU only, or the GPU only. */
  hardware: HardwareMode;
}

export const DEFAULT_CONVERSION: ConversionSettings = { memoryPerViewerMb: 300, maxViewers: 3, whenFull: "disk", hardware: "auto" };

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
  converting: boolean;
  memoryBytes: number;
  diskBytes: number;
}

export interface ConversionUsage {
  viewers: ConversionViewer[];
  memoryBytes: number;
  diskBytes: number;
}

interface Session {
  key: string;
  plan: HlsPlan;
  /** Whose and what, for the admin's list. */
  user: string;
  title: string;
  dir: string;
  /** Segments finished, wherever they are. */
  done: Set<number>;
  /** Finished segments read into memory. */
  memory: Map<number, Buffer>;
  /** Bytes in memory, counting segments being read in. */
  memoryBytes: number;
  /** Finished segments left on the disk, by size. */
  onDisk: Map<number, number>;
  /** Segments being read into memory just now. */
  settling: Map<number, Promise<void>>;
  proc: ChildProcess | null;
  /** The current run's GPU, or null on the CPU. */
  gpu: GpuRun | null;
  /** A GPU run failed: the rest of this viewing is on the CPU. */
  cpuOnly: boolean;
  /** The segment the current run started at. */
  runFrom: number;
  /** The last segment the current run has started writing. */
  writing: number;
  failure: string | null;
  lastWanted: number;
  /** Counts requests: only the newest may move the run (a seek), so one
   *  still waiting for a segment behind it can't drag the run back. */
  asked: number;
  touched: number;
}

export class HlsError extends Error {}

/** Everyone the admin allows is already watching something converted. */
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

/** Whose a session is: the person in "<person>:<item>". */
const personOf = (key: string) => key.slice(0, key.lastIndexOf(":"));

/** Empties the folder and checks it can be written to; null when it can't. Only
 *  what is inside goes: the folder itself is often a mount point (/transcode in
 *  the image), which this user could never remove. What a previous process
 *  left behind is nobody's. */
export function prepareRoot(root: string, log: Pick<HlsLog, "warn">): string | null {
  try {
    fs.mkdirSync(root, { recursive: true });
    for (const entry of fs.readdirSync(root)) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    fs.rmdirSync(fs.mkdtempSync(path.join(root, "check-")));
    return root;
  } catch (err) {
    log.warn({ err, root }, `Can't convert video in ${root} (${(err as NodeJS.ErrnoException).code ?? "unwritable"}); using a temporary folder inside the container instead`);
    return null;
  }
}

export interface HlsLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export class HlsSessions {
  private sessions = new Map<string, Session>();
  /** When each player said it had gone, so a request of its still on the way
   *  can't start the film again behind it. */
  private left = new Map<string, number>();
  private sweeper: NodeJS.Timeout;
  private root: string;

  /** Where segments are made: for the Disks answer home's Dashboard reads. */
  get folder(): string {
    return this.root;
  }
  /** A folder made here (no TRANSCODE_PATH, or it was unusable): removed on close. */
  private ownsRoot: boolean;
  private settings: ConversionSettings = { ...DEFAULT_CONVERSION };

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

  /** Why `key` may not watch now; null when it may: already converting this
   *  film, or a place is free and this person is watching nothing else. One film
   *  at a time per person, refused rather than taken over, so two screens on
   *  one account don't stop each other's conversion turn about. A film of theirs
   *  gone quiet gives way, and its place counts as free (open stops it). */
  refusal(key: string): HlsRefusal | null {
    if (this.sessions.has(key)) return null;
    const person = personOf(key);
    const mine = [...this.sessions.values()].filter((session) => personOf(session.key) === person);
    const now = Date.now();
    const other = mine.find((session) => now - session.touched <= PERSON_HOLD_MS);
    if (other) return { reason: "person", limit: this.settings.maxViewers, title: other.title };
    if (this.sessions.size - mine.length >= this.settings.maxViewers) return { reason: "household", limit: this.settings.maxViewers };
    return null;
  }

  canStart(key: string): boolean {
    return this.refusal(key) === null;
  }

  /** Segment `n`, made if it isn't there yet. `who` names the session for the
   *  admin; `signal` is the player hanging up (a seek cancels the segment it
   *  was loading), which ends the wait; `asked` is when the request came in. */
  async segment(key: string, plan: HlsPlan, n: number, options: { who?: { user: string; title: string }; signal?: AbortSignal; asked?: number } = {}): Promise<SegmentData> {
    const who = options.who ?? { user: "", title: "" };
    const signal = options.signal;
    if (!Number.isInteger(n) || n < 0 || n >= plan.starts.length) throw new HlsError("No such segment");
    let session = this.sessions.get(key);
    // Another file under the same id, another sound track or other subtitles burned in: a new session.
    if (session && (session.plan.file !== plan.file || session.plan.delivery.audio?.index !== plan.delivery.audio?.index ||
      session.plan.delivery.burn?.index !== plan.delivery.burn?.index)) {
      this.stop(key);
      session = undefined;
    }
    if (!session) {
      if (signal?.aborted) throw new HlsError("Cancelled");
      const left = this.left.get(key);
      if (left !== undefined && options.asked !== undefined && options.asked < left) throw new HlsError("Stopped");
      const refused = this.refusal(key);
      if (refused) throw new HlsBusyError(refused);
      session = this.open(key, plan, who);
    }
    session.touched = Date.now();
    session.lastWanted = n;
    const ask = ++session.asked;
    this.forgetBehind(session, n);

    const deadline = Date.now() + WAIT_MS;
    let started = false;
    for (;;) {
      this.refresh(session);
      if (session.done.has(n)) {
        this.keepAhead(session, n);
        await session.settling.get(n);
        if (this.sessions.get(key) !== session) throw new HlsError("Stopped");
        const data = session.memory.get(n);
        if (data) return { data };
        // Not forgotten while it was read in: it stayed on the disk.
        if (session.done.has(n)) return { file: path.join(session.dir, `${n}.ts`), size: session.onDisk.get(n) ?? 0 };
      }
      if (signal?.aborted) throw new HlsError("Cancelled");
      // Still wanted: a slow first segment is someone watching, not silence.
      session.touched = Date.now();
      if (session.failure && started) throw new HlsError(session.failure);
      const running = session.proc !== null;
      if (!running || n < session.runFrom || n > session.writing + JUMP_AHEAD) {
        if (started && !running) throw new HlsError(session.failure ?? "The conversion stopped");
        // A newer request moved the run elsewhere: this one is not what the
        // player wants any more, and restarting for it would undo the seek.
        if (ask !== session.asked) throw new HlsError("Superseded");
        this.start(session, n);
        started = true;
      }
      if (Date.now() > deadline) throw new HlsError("The segment took too long to make");
      await new Promise((resolve) => setTimeout(resolve, 120));
      // The session was stopped while this request waited (the player left).
      if (this.sessions.get(key) !== session) throw new HlsError("Stopped");
    }
  }

  /** The player has gone: stop now, and refuse what it asked before it went. */
  leave(key: string): void {
    this.left.set(key, Date.now());
    this.stop(key);
  }

  stop(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    this.kill(session);
    session.memory.clear();
    session.memoryBytes = 0;
    fs.rm(session.dir, { recursive: true, force: true }, () => undefined);
  }

  /** People converting right now, for the admin and the log. */
  active(): number {
    return [...this.sessions.values()].filter((session) => session.proc).length;
  }

  /** Who is watching converted video, and what it holds in memory and on the disk. */
  usage(): ConversionUsage {
    const viewers = [...this.sessions.values()].map((session) => ({
      user: session.user,
      title: session.title,
      mode: session.plan.delivery.mode,
      converter: session.plan.delivery.videoCopy ? null : session.gpu ? "gpu" as const : "cpu" as const,
      hdr: !session.plan.delivery.videoCopy && hdrOf(session.plan.info.video) !== null,
      converting: session.proc !== null,
      memoryBytes: session.memoryBytes,
      diskBytes: [...session.onDisk.values()].reduce((sum, size) => sum + size, 0)
    }));
    return {
      viewers,
      memoryBytes: viewers.reduce((sum, viewer) => sum + viewer.memoryBytes, 0),
      diskBytes: viewers.reduce((sum, viewer) => sum + viewer.diskBytes, 0)
    };
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const key of [...this.sessions.keys()]) this.stop(key);
    if (this.ownsRoot) fs.rm(this.root, { recursive: true, force: true }, () => undefined);
  }

  private get budget(): number {
    return this.settings.memoryPerViewerMb * 1024 * 1024;
  }

  /** "wait" and memory full: the run goes no further ahead. */
  private full(session: Session): boolean {
    return this.settings.whenFull === "wait" && this.budget > 0 && session.memoryBytes >= this.budget;
  }

  private open(key: string, plan: HlsPlan, who: { user: string; title: string }): Session {
    // refusal let this through, so any other film of theirs has gone quiet.
    const person = personOf(key);
    for (const other of [...this.sessions.keys()]) {
      if (personOf(other) === person) this.stop(other);
    }
    const dir = fs.mkdtempSync(path.join(this.root, "s-"));
    const session: Session = {
      key, plan, user: who.user, title: who.title, dir,
      done: new Set(), memory: new Map(), memoryBytes: 0, onDisk: new Map(), settling: new Map(),
      proc: null, gpu: null, cpuOnly: false, runFrom: 0, writing: -1, failure: null, lastWanted: 0, asked: 0, touched: Date.now()
    };
    this.sessions.set(key, session);
    return session;
  }

  private start(session: Session, from: number): void {
    this.kill(session);
    session.failure = null;
    session.runFrom = from;
    session.writing = from - 1;
    const gpu = session.cpuOnly ? null : this.hardware?.choose(session.plan.info, session.plan.delivery) ?? null;
    session.gpu = gpu;
    const args = ffmpegArgs(session.plan, from, session.dir, gpu);
    const proc = spawn(this.tools.ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    session.proc = proc;
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    proc.on("error", (err) => {
      if (session.proc !== proc) return;
      session.proc = null;
      session.failure = `ffmpeg could not start: ${err.message}`;
      this.log.warn({ item: session.plan.itemId, err }, "ffmpeg could not start");
    });
    proc.on("exit", (code, signal) => {
      if (session.proc !== proc) return;
      session.proc = null;
      if (code === 0) {
        // The last segment of the run is finished too.
        for (let n = session.runFrom; n < session.plan.starts.length; n++) {
          if (!session.done.has(n) && fs.existsSync(path.join(session.dir, `${n}.ts`))) this.settle(session, n);
        }
        return;
      }
      const reason = stderr.trim().split(/\r?\n/).pop() || `exit ${code ?? signal}`;
      // The GPU failed: the same segments again on the CPU, for the rest of the
      // viewing, unless the admin asked for the GPU only.
      if (gpu && this.hardware?.failed(reason)) {
        this.log.warn({ item: session.plan.itemId, reason, stderr: stderr.trim() }, "The GPU could not convert this; converting it on the CPU");
        session.cpuOnly = true;
        let next = session.runFrom;
        while (session.done.has(next)) next += 1;
        if (next < session.plan.starts.length) this.start(session, next);
        return;
      }
      session.failure = `The conversion failed: ${reason}`;
      this.log.warn({ item: session.plan.itemId, code, signal, stderr: stderr.trim() }, "ffmpeg failed");
    });
    this.log.info({ item: session.plan.itemId, from, mode: session.plan.delivery.mode, gpu: gpu ? (gpu.decode ? "decode+encode" : "encode") : null }, "Converting");
  }

  /** Stops the run and deletes the segment it was in the middle of. */
  private kill(session: Session): void {
    const proc = session.proc;
    if (!proc) return;
    session.proc = null;
    proc.kill("SIGKILL");
    for (let n = session.runFrom; n <= session.writing + 1; n++) {
      if (!session.done.has(n)) fs.rm(path.join(session.dir, `${n}.ts`), { force: true }, () => undefined);
    }
  }

  /** A finished segment: into memory while the viewer's share allows (its bytes
   *  counted at once, so two read in together can't both squeeze in), else left
   *  on the disk. With "wait" everything goes into memory, and refresh stops the
   *  run once the share is used. */
  private settle(session: Session, n: number): void {
    session.done.add(n);
    const file = path.join(session.dir, `${n}.ts`);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      session.done.delete(n);
      return;
    }
    const budget = this.budget;
    const toMemory = budget > 0 && (this.settings.whenFull === "wait" || session.memoryBytes + size <= budget);
    if (!toMemory) {
      session.onDisk.set(n, size);
      return;
    }
    session.memoryBytes += size;
    const reading = fs.promises.readFile(file).then(
      (data) => {
        // Forgotten or stopped meanwhile: its place is given back.
        if (this.sessions.get(session.key) !== session || !session.done.has(n)) {
          session.memoryBytes -= size;
          return;
        }
        session.memoryBytes += data.length - size;
        session.memory.set(n, data);
        fs.rm(file, { force: true }, () => undefined);
      },
      () => {
        session.memoryBytes -= size;
        session.done.delete(n);
      }
    ).finally(() => session.settling.delete(n));
    session.settling.set(n, reading);
  }

  /** A segment is finished once the run has started the next one. */
  private refresh(session: Session): void {
    if (!session.proc) return;
    while (fs.existsSync(path.join(session.dir, `${session.writing + 1}.ts`))) session.writing += 1;
    for (let n = session.runFrom; n < session.writing; n++) {
      if (!session.done.has(n)) this.settle(session, n);
    }
    const ahead = session.writing - session.lastWanted;
    if (ahead > MAX_AHEAD || (this.full(session) && ahead >= MIN_AHEAD)) this.kill(session);
  }

  /** Near the end of what was made and nothing running: carry on from there. */
  private keepAhead(session: Session, n: number): void {
    if (session.proc) return;
    let next = n + 1;
    while (session.done.has(next)) next += 1;
    if (next >= session.plan.starts.length || next - n > RESTART_WITHIN) return;
    // Memory full: only once the player is nearly out of what was made.
    if (this.full(session) && next - n >= MIN_AHEAD) return;
    this.start(session, next);
  }

  private forget(session: Session, n: number): void {
    session.done.delete(n);
    const data = session.memory.get(n);
    if (data) {
      session.memory.delete(n);
      session.memoryBytes -= data.length;
    }
    session.onDisk.delete(n);
    fs.rm(path.join(session.dir, `${n}.ts`), { force: true }, () => undefined);
  }

  private forgetBehind(session: Session, n: number): void {
    for (const done of [...session.done]) {
      if (done < n - KEEP_BEHIND) this.forget(session, done);
    }
    // Memory full: what is behind the player goes first, to make room ahead.
    for (const done of [...session.done].filter((at) => at < n).sort((a, b) => a - b)) {
      if (!this.full(session)) break;
      if (session.memory.has(done)) this.forget(session, done);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (session.proc) this.refresh(session);
      if (now - session.touched > IDLE_MS) this.stop(session.key);
    }
    for (const [key, at] of this.left) {
      if (now - at > IDLE_MS) this.left.delete(key);
    }
  }
}
