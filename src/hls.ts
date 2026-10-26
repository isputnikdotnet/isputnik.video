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
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
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
  if (info.video) args.push("-map", `0:${info.video.index}`);
  if (delivery.audio) args.push("-map", `0:${delivery.audio.index}`);

  if (delivery.videoCopy) {
    args.push("-c:v", "copy");
  } else {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-maxrate", "10M", "-bufsize", "20M",
      "-profile:v", "high", "-pix_fmt", "yuv420p");
    if (info.video && info.video.height > 1080) args.push("-vf", "scale=-2:1080");
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

interface Session {
  key: string;
  plan: HlsPlan;
  dir: string;
  /** Segments finished and on disk. */
  done: Set<number>;
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

export interface HlsLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export class HlsSessions {
  private sessions = new Map<string, Session>();
  private sweeper: NodeJS.Timeout;

  constructor(private tools: Tools, private root: string, private log: HlsLog) {
    // What a previous process left behind is nobody's.
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    this.sweeper = setInterval(() => this.sweep(), 15_000);
    this.sweeper.unref();
  }

  /** The file of segment `n`, made if it isn't there yet. */
  async segment(key: string, plan: HlsPlan, n: number): Promise<string> {
    if (!Number.isInteger(n) || n < 0 || n >= plan.starts.length) throw new HlsError("No such segment");
    let session = this.sessions.get(key);
    if (session && session.plan.file !== plan.file) {
      this.stop(key);
      session = undefined;
    }
    if (!session) session = this.open(key, plan);
    session.touched = Date.now();
    session.lastWanted = n;
    this.forgetBehind(session, n);

    const deadline = Date.now() + WAIT_MS;
    let started = false;
    for (;;) {
      this.refresh(session);
      if (session.done.has(n)) {
        this.keepAhead(session, n);
        return path.join(session.dir, `${n}.ts`);
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
    fs.rm(session.dir, { recursive: true, force: true }, () => undefined);
  }

  /** People converting right now, for the admin and the log. */
  active(): number {
    return [...this.sessions.values()].filter((session) => session.proc).length;
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const key of [...this.sessions.keys()]) this.stop(key);
    fs.rm(this.root, { recursive: true, force: true }, () => undefined);
  }

  private open(key: string, plan: HlsPlan): Session {
    const dir = fs.mkdtempSync(path.join(this.root, "s-"));
    const session: Session = { key, plan, dir, done: new Set(), proc: null, runFrom: 0, writing: -1, failure: null, lastWanted: 0, touched: Date.now() };
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
          if (fs.existsSync(path.join(session.dir, `${n}.ts`))) session.done.add(n);
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

  /** A segment is finished once the run has started the next one. */
  private refresh(session: Session): void {
    if (!session.proc) return;
    while (fs.existsSync(path.join(session.dir, `${session.writing + 1}.ts`))) session.writing += 1;
    for (let n = session.runFrom; n < session.writing; n++) session.done.add(n);
    if (session.writing - session.lastWanted > MAX_AHEAD) this.kill(session);
  }

  /** Near the end of what was made and nothing running: carry on from there. */
  private keepAhead(session: Session, n: number): void {
    if (session.proc) return;
    let next = n + 1;
    while (session.done.has(next)) next += 1;
    if (next < session.plan.starts.length && next - n <= RESTART_WITHIN) this.start(session, next);
  }

  private forgetBehind(session: Session, n: number): void {
    for (const done of session.done) {
      if (done < n - KEEP_BEHIND) {
        session.done.delete(done);
        fs.rm(path.join(session.dir, `${done}.ts`), { force: true }, () => undefined);
      }
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
