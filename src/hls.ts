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
import type { MediaInfo, Tools } from "./ffmpeg.js";

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

/** ffmpeg's arguments for a run that starts at segment `from`. */
export function ffmpegArgs(plan: HlsPlan, from: number, outDir: string): string[] {
  const { info, delivery } = plan;
  const args = ["-hide_banner", "-nostdin", "-v", "error", "-y"];
  // Input seeking is relative to the file's start. A picture copied as it is can
  // only start on a keyframe, and ffmpeg lands on the one at or before the time
  // asked: just past the cut, so never the one before it.
  const offset = plan.starts[from] - info.start;
  if (from > 0) args.push("-ss", (offset + (delivery.videoCopy ? 0.05 : 0)).toFixed(3));
  args.push("-i", plan.file, "-copyts", "-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn");
  const burn = info.video ? delivery.burn : null;
  const shrink = info.video !== null && info.video.height > 1080;
  if (info.video && burn) {
    // The subtitle drawn over the picture, its canvas fitted to the picture
    // first (a 1080p PGS track on a cropped or 720p film).
    const { width, height } = info.video;
    const fit = burn.width > 0 && burn.height > 0 && (burn.width !== width || burn.height !== height);
    const sub = fit ? `[0:${burn.index}]scale=${width}:${height}[sub];` : "";
    const over = `[0:${info.video.index}]${fit ? "[sub]" : `[0:${burn.index}]`}overlay=eof_action=pass`;
    args.push("-filter_complex", `${sub}${over}${shrink ? ",scale=-2:1080" : ""}[v]`, "-map", "[v]");
  } else if (info.video) {
    args.push("-map", `0:${info.video.index}`);
  }
  if (delivery.audio) args.push("-map", `0:${delivery.audio.index}`);

  if (delivery.videoCopy) {
    args.push("-c:v", "copy");
  } else {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-maxrate", "10M", "-bufsize", "20M",
      "-profile:v", "high", "-pix_fmt", "yuv420p");
    if (shrink && !burn) args.push("-vf", "scale=-2:1080");
    // A keyframe on every cut, so every segment starts on one.
    args.push("-force_key_frames", plan.starts.slice(from).map((at) => at.toFixed(3)).join(","));
  }
  if (delivery.audio) {
    if (delivery.audioCopy) args.push("-c:a", "copy");
    else args.push("-c:a", "aac", "-ac", "2", "-b:a", "192k");
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
}

export const DEFAULT_CONVERSION: ConversionSettings = { memoryPerViewerMb: 300, maxViewers: 3, whenFull: "disk" };

/** A finished segment: in memory, or a file in the transcode folder. */
export type SegmentData = { data: Buffer } | { file: string; size: number };

/** One viewer converting, for the admin. */
export interface ConversionViewer {
  user: string;
  title: string;
  mode: string;
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
  /** The segment the current run started at. */
  runFrom: number;
  /** The last segment the current run has started writing. */
  writing: number;
  failure: string | null;
  lastWanted: number;
  touched: number;
}

export class HlsError extends Error {}

/** Everyone the admin allows is already watching something converted. */
export class HlsBusyError extends HlsError {
  constructor(readonly limit: number) {
    super(`${limit} ${limit === 1 ? "person is" : "people are"} already watching converted video`);
  }
}

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
  private sweeper: NodeJS.Timeout;
  private root: string;
  /** A folder made here (no TRANSCODE_PATH, or it was unusable): removed on close. */
  private ownsRoot: boolean;
  private settings: ConversionSettings = { ...DEFAULT_CONVERSION };

  /** `root` null: a fresh temporary folder. */
  constructor(private tools: Tools, root: string | null, private log: HlsLog) {
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

  /** Whether `key` may watch now: already converting, or a place is free. */
  canStart(key: string): boolean {
    return this.sessions.has(key) || this.sessions.size < this.settings.maxViewers;
  }

  /** Segment `n`, made if it isn't there yet. `who` names the session for the admin. */
  async segment(key: string, plan: HlsPlan, n: number, who: { user: string; title: string } = { user: "", title: "" }): Promise<SegmentData> {
    if (!Number.isInteger(n) || n < 0 || n >= plan.starts.length) throw new HlsError("No such segment");
    let session = this.sessions.get(key);
    // Another file under the same id, another sound track or other subtitles burned in: a new session.
    if (session && (session.plan.file !== plan.file || session.plan.delivery.audio?.index !== plan.delivery.audio?.index ||
      session.plan.delivery.burn?.index !== plan.delivery.burn?.index)) {
      this.stop(key);
      session = undefined;
    }
    if (!session) {
      if (!this.canStart(key)) throw new HlsBusyError(this.settings.maxViewers);
      session = this.open(key, plan, who);
    }
    session.touched = Date.now();
    session.lastWanted = n;
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
      if (session.failure && started) throw new HlsError(session.failure);
      const running = session.proc !== null;
      if (!running || n < session.runFrom || n > session.writing + JUMP_AHEAD) {
        if (started && !running) throw new HlsError(session.failure ?? "The conversion stopped");
        this.start(session, n);
        started = true;
      }
      if (Date.now() > deadline) throw new HlsError("The segment took too long to make");
      await new Promise((resolve) => setTimeout(resolve, 120));
      // The session was stopped while this request waited (the player left).
      if (this.sessions.get(key) !== session) throw new HlsError("Stopped");
    }
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
    const dir = fs.mkdtempSync(path.join(this.root, "s-"));
    const session: Session = {
      key, plan, user: who.user, title: who.title, dir,
      done: new Set(), memory: new Map(), memoryBytes: 0, onDisk: new Map(), settling: new Map(),
      proc: null, runFrom: 0, writing: -1, failure: null, lastWanted: 0, touched: Date.now()
    };
    this.sessions.set(key, session);
    return session;
  }

  private start(session: Session, from: number): void {
    this.kill(session);
    session.failure = null;
    session.runFrom = from;
    session.writing = from - 1;
    const args = ffmpegArgs(session.plan, from, session.dir);
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
      session.failure = `The conversion failed: ${reason}`;
      this.log.warn({ item: session.plan.itemId, code, signal, stderr: stderr.trim() }, "ffmpeg failed");
    });
    this.log.info({ item: session.plan.itemId, from, mode: session.plan.delivery.mode }, "Converting");
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
  }
}
