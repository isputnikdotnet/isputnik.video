// Prepared copies (home's docs/video-quality-plan.md → travel copies): a film or
// episode made once into a smaller MP4 for a phone or tablet to download, and
// kept for whoever asks next.
//
// Asked for by a person who wants it on their device (home's Download ›
// Optimized). Unlike watching, nothing is made while they wait on a connection:
// the copy is a job on a queue here, one at a time, on the GPU where there is
// one, at low priority, and stood still while anyone watches something
// converted. They come back for the finished file, which then comes down as
// fast as the link allows, with byte ranges.
//
// A copy belongs to nobody: made for one person, it serves everyone who may see
// the title. They are kept under a size the admin sets (20 GB to start with);
// past it the ones used longest ago go. A copy of a file that has changed since
// is made again.
//
// A copy whose picture is re-encoded is made as the version a viewer would get
// (hls.ts fill, home's docs/video-cache-plan.md C3): its segments go into the
// shared cache, a gap at a time, alongside anyone watching it, and survive a
// restart; once all are there they are put together into the MP4 in seconds.
// The same queue fills versions an admin wants kept ready, and finishes off
// ones a viewer left mostly made — copies first, then those, then these.
// Copies asked for are noted in the catalog and asked for again after a
// restart (the app's resumeCopies); the other fills are asked for again by
// whoever wants them (Keep ready on start, finish-off when next left).
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { Db } from "./db.js";
import { RUNG_LIMITS, type Delivery, type Rung } from "./delivery.js";
import type { MediaInfo, Tools } from "./ffmpeg.js";
import type { GpuRun, Hardware } from "./hardware.js";
import { buildPlan, fileStamp, ffmpegArgs, type FillOptions, type FillState, type HlsLog, type HlsPlan } from "./hls.js";
import type { ProbedFile } from "./media-probe.js";

/** What a copy may cost: a rung's own limits, but 1080p held lower than a
 *  stream's — a tablet's screen, not a television's. */
export const COPY_LIMITS: Record<Rung, { bitRate: number; maxRate: number; audioRate: number }> = {
  1080: { bitRate: 5_000_000, maxRate: 7_000_000, audioRate: 160_000 },
  720: RUNG_LIMITS[720],
  480: RUNG_LIMITS[480]
};

export const copySettingsSchema = z.object({
  /** The most the kept copies may take together. */
  limitGb: z.number().int().min(1).max(10_000)
});
export type CopySettings = z.infer<typeof copySettingsSchema>;
export const DEFAULT_COPIES: CopySettings = { limitGb: 50 };

export type CopyState = "queued" | "running" | "ready" | "failed";

/** One copy, for the person waiting for it. */
export interface CopyStatus {
  state: CopyState;
  /** 0–1 of a running copy; 1 once ready. */
  progress: number;
  /** Jobs before this one, the running one counted. */
  ahead: number;
  /** A running copy, stood still while someone watches converted video. */
  paused: boolean;
  /** How long a running copy still needs, when that can be said. */
  etaSeconds: number | null;
  sizeBytes: number | null;
  error: string | null;
  /** Queued, and kept waiting by the admin's rule: for the server to be idle, or for the night. */
  waitingFor?: "idle" | "night" | null;
}

export interface CopyKey {
  itemId: string;
  rung: Rung;
  /** The sound track in it: ffprobe's stream index, -1 for a silent film. */
  audio: number;
}

export interface CopyJob extends CopyKey {
  title: string;
  /** Who asked (their own limit, perPerson); none for one asked for again after a restart. */
  by?: string;
  file: ProbedFile;
  info: MediaInfo;
  delivery: Delivery;
}

interface CopyRow {
  item_id: string;
  rung: number;
  audio: number;
  state: CopyState;
  title: string;
  size_bytes: number;
  source_size: number;
  source_modified: string;
  error: string | null;
  requested_at: string;
  ready_at: string | null;
  used_at: string | null;
}

interface Running {
  job: CopyJob;
  /** ffmpeg making the whole file, or putting a filled version together; null while filling. */
  proc: ChildProcess | null;
  gpu: GpuRun | null;
  startedAt: number;
  progress: number;
  paused: boolean;
  /** A copy made through the shared cache: stops its fill. */
  abort?: AbortController;
  /** Stood down by the gate, to carry on later. */
  parked?: boolean;
}

/** What the queue needs of the shared cache (hls.ts). */
export interface Filler {
  readonly canKeep: boolean;
  fill(plan: HlsPlan, title: string, options: FillOptions): Promise<void>;
  fillState(plan: HlsPlan): FillState;
  keptSegments(plan: HlsPlan): string[] | null;
  pauseFills(paused: boolean): void;
}

/** A version to fill with no copy made of it: kept ready, or finished off. */
export interface FillJob {
  /** Its own name in the queue: one job per version. */
  id: string;
  kind: "keep" | "finish";
  itemId: string;
  title: string;
  plan: HlsPlan;
}

interface Filling {
  job: FillJob;
  abort: AbortController;
  progress: number;
  /** Stood down by the gate, to carry on later. */
  parked?: boolean;
}

const keyOf = (key: CopyKey) => `${key.itemId}:${key.rung}:${key.audio}`;
/** A copy's name in the admin's queue. */
export const copyJobId = (key: CopyKey) => `copy:${keyOf(key)}`;
const fileName = (key: CopyKey) => `${key.itemId}-${key.rung}-a${key.audio}.mp4`;
const now = () => new Date().toISOString();

/** How long making it takes, roughly, before it has started: a picture copied as
 *  it is goes at disk speed, a GPU several times faster than the film plays, a
 *  CPU barely faster. */
export function estimateCopySeconds(info: MediaInfo, delivery: Delivery, gpu: boolean): number {
  const speed = delivery.videoCopy ? 40 : gpu ? 5 : 1.5;
  return Math.max(10, Math.round(info.duration / speed));
}

/** When the queue works (home's docs/video-cache-plan.md C4): right away, only
 *  when the server is idle, or only in a window at night; how many jobs at once;
 *  how many copies one member may have waiting; and how fast a copy goes to
 *  someone away from home (0: as fast as it can). */
export const jobSettingsSchema = z.object({
  when: z.enum(["now", "idle", "night"]),
  nightStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  nightEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  atOnce: z.number().int().min(1).max(4),
  perPerson: z.number().int().min(1).max(1000),
  remoteMbps: z.number().min(0).max(10_000)
});
export type JobSettings = z.infer<typeof jobSettingsSchema>;
export const DEFAULT_JOBS: JobSettings = { when: "now", nightStart: "01:00", nightEnd: "07:00", atOnce: 1, perPerson: 10, remoteMbps: 0 };

/** Why jobs wait although there is room: the server is busy, or it is not night yet. */
export type JobGate = { open: true } | { open: false; reason: "idle" | "night" };

/** Idle: nobody watching converted video, and the load under this share of the
 *  cores, for this long. */
const IDLE_LOAD = 0.7;
const IDLE_FOR_MS = 2 * 60_000;

/** Minutes into the day of an "HH:MM". */
const minutesOf = (at: string) => Number(at.slice(0, 2)) * 60 + Number(at.slice(3, 5));

/** Whether `now` falls in the window from `start` to `end` (which may pass midnight). */
export function inWindow(now: Date, start: string, end: string): boolean {
  const at = now.getHours() * 60 + now.getMinutes();
  const from = minutesOf(start);
  const to = minutesOf(end);
  return from <= to ? at >= from && at < to : at >= from || at < to;
}

/** One job in the admin's queue. */
export interface JobView {
  id: string;
  kind: "copy" | "keep" | "finish";
  title: string;
  quality: Rung | null;
  state: "running" | "queued";
  progress: number;
  paused: boolean;
}

export class Copies {
  private queue: CopyJob[] = [];
  private runnings: Running[] = [];
  /** Fills waiting, Keep ready before finish-off, and the ones under way. */
  private fills: FillJob[] = [];
  private fillings: Filling[] = [];
  private settings: CopySettings = { ...DEFAULT_COPIES };
  private jobSettings: JobSettings = { ...DEFAULT_JOBS };
  /** Jobs the admin asked to run now, whatever the gate says. */
  private forced = new Set<string>();
  /** Since when the server has been idle; 0 while it isn't. */
  private calmSince = 0;
  private watcher: NodeJS.Timeout;
  private settled: (() => void)[] = [];
  private closed = false;
  /** A copy was just made: the app keeps everything kept under one limit (cache.ts). */
  onReady: ((key: CopyKey) => void) | null = null;

  /** `busy`: someone is watching converted video right now — jobs wait. */
  constructor(
    private db: Db,
    private tools: Tools,
    readonly dir: string,
    private log: HlsLog,
    private hardware: Pick<Hardware, "choose" | "failed"> | null,
    private busy: () => boolean = () => false,
    private filler: Filler | null = null,
    private clock: () => Date = () => new Date(),
    private load: () => number = () => os.loadavg()[0] / Math.max(1, os.cpus().length)
  ) {
    fs.mkdirSync(dir, { recursive: true });
    // Half-made files go; copies asked for wait to be asked for again
    // (resumeCopies), what was being made with them.
    for (const entry of fs.readdirSync(dir)) {
      if (entry.endsWith(".part") || entry.endsWith(".list")) fs.rmSync(path.join(dir, entry), { force: true });
    }
    db.prepare("UPDATE copies SET state = 'queued' WHERE state = 'running'").run();
    this.watcher = setInterval(() => this.watch(), 3000);
    this.watcher.unref();
  }

  configure(settings: CopySettings): void {
    this.settings = { ...settings };
    this.trim(null);
  }

  /** When and how much the queue works; in force at once. */
  configureJobs(settings: JobSettings): void {
    this.jobSettings = { ...settings };
    this.watch();
  }

  /** Whether jobs may start now, and if not, why. */
  gate(): JobGate {
    const settings = this.jobSettings;
    if (settings.when === "night" && !inWindow(this.clock(), settings.nightStart, settings.nightEnd)) return { open: false, reason: "night" };
    if (settings.when === "idle") {
      const calm = !this.busy() && this.load() < IDLE_LOAD;
      if (!calm) this.calmSince = 0;
      else if (this.calmSince === 0) this.calmSince = Date.now();
      if (!calm || Date.now() - this.calmSince < IDLE_FOR_MS) return { open: false, reason: "idle" };
    }
    return { open: true };
  }

  /** The copy, if it was ever asked for; null otherwise. A finished one whose
   *  file has gone, or whose film has changed since, is forgotten first. */
  status(key: CopyKey, source: ProbedFile): CopyStatus | null {
    const row = this.row(key);
    if (!row) return null;
    if (row.state === "ready" && !this.fresh(row, key, source)) {
      this.drop(key);
      return null;
    }
    const running = this.runnings.find((candidate) => keyOf(candidate.job) === keyOf(key)) ?? null;
    const at = this.queue.findIndex((job) => keyOf(job) === keyOf(key));
    const progress = row.state === "ready" ? 1 : running?.progress ?? 0;
    const elapsed = running ? (Date.now() - running.startedAt) / 1000 : 0;
    const gate = this.gate();
    return {
      state: row.state,
      progress,
      ahead: row.state === "queued" ? Math.max(0, at) + this.runnings.length + this.fillings.length : 0,
      paused: running?.paused ?? false,
      etaSeconds: running && progress > 0.03 && !running.paused ? Math.round((elapsed / progress) * (1 - progress)) : null,
      sizeBytes: row.state === "ready" ? row.size_bytes : null,
      error: row.error,
      waitingFor: row.state === "queued" && !gate.open && !this.forced.has(copyJobId(key)) ? gate.reason : null
    };
  }

  /** Copies this person asked for that wait or are being made (since the start:
   *  ones asked for again after a restart belong to nobody). */
  waitingFor(person: string): number {
    return this.queue.filter((job) => job.by === person).length + this.runnings.filter((running) => running.job.by === person).length;
  }

  /** How many copies one member may have waiting. */
  get perPerson(): number {
    return this.jobSettings.perPerson;
  }

  /** How fast a copy goes to someone away from home, in bytes a second; 0 for no cap. */
  get remoteBytesPerSecond(): number {
    return Math.round((this.jobSettings.remoteMbps * 1_000_000) / 8);
  }

  /** Asks for a copy: queued, unless it is there, on its way, or already waiting. */
  request(job: CopyJob): CopyStatus {
    const existing = this.status(job, job.file);
    if (existing && existing.state !== "failed") return existing;
    this.db.prepare(`
      INSERT INTO copies (item_id, rung, audio, state, title, source_size, source_modified, requested_at)
      VALUES (@item, @rung, @audio, 'queued', @title, @size, @modified, @at)
      ON CONFLICT (item_id, rung, audio) DO UPDATE SET
        state = 'queued', title = excluded.title, size_bytes = 0, error = NULL,
        source_size = excluded.source_size, source_modified = excluded.source_modified,
        requested_at = excluded.requested_at, ready_at = NULL
    `).run({ item: job.itemId, rung: job.rung, audio: job.audio, title: job.title, size: job.file.size, modified: job.file.modified.toISOString(), at: now() });
    this.queue.push(job);
    this.next();
    return this.status(job, job.file)!;
  }

  /** The finished copy's file, and a note that it was wanted; null when there is none. */
  ready(key: CopyKey, source: ProbedFile): { path: string; size: number; modified: Date } | null {
    if (this.status(key, source)?.state !== "ready") return null;
    const file = path.join(this.dir, fileName(key));
    const stat = fs.statSync(file);
    this.db.prepare("UPDATE copies SET used_at = ? WHERE item_id = ? AND rung = ? AND audio = ?").run(now(), key.itemId, key.rung, key.audio);
    return { path: file, size: stat.size, modified: stat.mtime };
  }

  /** The copies asked for and not yet made, oldest first: the app asks for them
   *  again after a restart, and removes the ones it can't (their film is gone). */
  pendingCopies(): CopyKey[] {
    const rows = this.db.prepare("SELECT item_id, rung, audio FROM copies WHERE state = 'queued' ORDER BY requested_at").all() as CopyRow[];
    return rows.map((row) => ({ itemId: row.item_id, rung: row.rung as Rung, audio: row.audio }));
  }

  /** A fill to do: queued once (Keep ready ahead of finish-off), unless under way. */
  queueFill(job: FillJob): void {
    if (this.closed || this.fillings.some((filling) => filling.job.id === job.id) || this.fills.some((queued) => queued.id === job.id)) return;
    if (job.kind === "keep") {
      const at = this.fills.findIndex((queued) => queued.kind === "finish");
      if (at < 0) this.fills.push(job);
      else this.fills.splice(at, 0, job);
    } else {
      this.fills.push(job);
    }
    this.next();
  }

  /** How a fill stands in the queue: waiting (how many before it), under way, or not here. */
  fillStatus(id: string): { state: "queued"; ahead: number } | { state: "running"; progress: number } | null {
    const filling = this.fillings.find((candidate) => candidate.job.id === id);
    if (filling) return { state: "running", progress: filling.progress };
    const at = this.fills.findIndex((job) => job.id === id);
    return at < 0 ? null : { state: "queued", ahead: at + this.queue.length + this.runnings.length + this.fillings.length };
  }

  /** Takes the fills it picks off the queue, and stops the ones under way that it picks. */
  cancelFills(which: (job: FillJob) => boolean): void {
    this.fills = this.fills.filter((job) => !which(job));
    for (const filling of [...this.fillings]) if (which(filling.job)) filling.abort.abort();
  }

  /** A copy asked for before a restart, asked for again: back on the queue. */
  resume(job: CopyJob): void {
    if (this.closed || this.queue.some((queued) => keyOf(queued) === keyOf(job)) || this.runnings.some((running) => keyOf(running.job) === keyOf(job))) return;
    this.queue.push(job);
    this.next();
  }

  /** The queue as the admin sees it: what runs, then what waits, in order. */
  jobs(): { gate: JobGate; settings: JobSettings; jobs: JobView[] } {
    const copyView = (job: CopyJob, running: Running | null): JobView => ({
      id: copyJobId(job), kind: "copy", title: job.title, quality: job.rung,
      state: running ? "running" : "queued", progress: running?.progress ?? 0, paused: running?.paused ?? false
    });
    const fillView = (job: FillJob, filling: Filling | null): JobView => ({
      id: job.id, kind: job.kind, title: job.title, quality: job.plan.delivery.rung,
      state: filling ? "running" : "queued", progress: filling?.progress ?? 0, paused: false
    });
    return {
      gate: this.gate(),
      settings: { ...this.jobSettings },
      jobs: [
        ...this.runnings.map((running) => copyView(running.job, running)),
        ...this.fillings.map((filling) => fillView(filling.job, filling)),
        ...this.queue.map((job) => copyView(job, null)),
        ...this.fills.map((job) => fillView(job, null))
      ]
    };
  }

  /** Moves a waiting job to the front of its kind. */
  moveToTop(id: string): boolean {
    const copy = this.queue.findIndex((job) => copyJobId(job) === id);
    if (copy >= 0) {
      this.queue.unshift(...this.queue.splice(copy, 1));
      return true;
    }
    const fill = this.fills.findIndex((job) => job.id === id);
    if (fill >= 0) {
      this.fills.unshift(...this.fills.splice(fill, 1));
      return true;
    }
    return false;
  }

  /** Runs a waiting job as soon as there is room, whatever the time or the load. */
  runNow(id: string): boolean {
    if (!this.moveToTop(id)) return false;
    this.forced.add(id);
    this.next();
    return true;
  }

  /** Takes a job off the queue (a copy is forgotten; a fill just stops). */
  cancel(id: string): boolean {
    const copy = [...this.queue, ...this.runnings.map((running) => running.job)].find((job) => copyJobId(job) === id);
    if (copy) {
      this.drop(copy);
      return true;
    }
    const known = this.fills.some((job) => job.id === id) || this.fillings.some((filling) => filling.job.id === id);
    if (known) this.cancelFills((job) => job.id === id);
    return known;
  }

  /** The finished copies, for the shared limit: what each takes and when it was last wanted. */
  readyItems(): { key: CopyKey; sizeBytes: number; usedAt: string }[] {
    const rows = this.db.prepare("SELECT * FROM copies WHERE state = 'ready'").all() as CopyRow[];
    return rows.map((row) => ({ key: { itemId: row.item_id, rung: row.rung as Rung, audio: row.audio }, sizeBytes: row.size_bytes, usedAt: row.used_at ?? row.ready_at ?? row.requested_at }));
  }

  /** Removes one copy (the shared limit's choice). */
  remove(key: CopyKey): void {
    this.drop(key);
  }

  /** Every copy, newest first, and what the finished ones take: for the admin. */
  list() {
    const rows = this.db.prepare("SELECT * FROM copies ORDER BY requested_at DESC").all() as CopyRow[];
    return {
      settings: { ...this.settings },
      folder: this.dir,
      usedBytes: rows.reduce((sum, row) => sum + (row.state === "ready" ? row.size_bytes : 0), 0),
      copies: rows.map((row) => ({
        itemId: row.item_id,
        quality: row.rung as Rung,
        audio: row.audio,
        title: row.title,
        state: row.state,
        sizeBytes: row.size_bytes,
        requestedAt: row.requested_at,
        readyAt: row.ready_at,
        usedAt: row.used_at,
        error: row.error
      }))
    };
  }

  /** Forgets every copy, made or not, and stops the ones being made. */
  clear(): number {
    const rows = this.db.prepare("SELECT item_id, rung, audio FROM copies").all() as CopyRow[];
    for (const row of rows) this.drop({ itemId: row.item_id, rung: row.rung as Rung, audio: row.audio });
    return rows.length;
  }

  /** Copies of titles that are no longer in the catalog; for the daily sweep. */
  purgeOrphans(): number {
    const rows = this.db.prepare(`
      SELECT item_id, rung, audio FROM copies WHERE item_id NOT IN (SELECT id FROM episodes)
        AND item_id NOT IN (SELECT id FROM movies) AND item_id NOT IN (SELECT id FROM movie_parts)
    `).all() as CopyRow[];
    for (const row of rows) this.drop({ itemId: row.item_id, rung: row.rung as Rung, audio: row.audio });
    return rows.length;
  }

  /** Once nothing waits or runs: for tests, and for closing. */
  idle(): Promise<void> {
    if (this.runnings.length === 0 && this.fillings.length === 0 && this.queue.length === 0 && this.fills.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.settled.push(resolve));
  }

  close(): void {
    this.closed = true;
    clearInterval(this.watcher);
    this.queue = [];
    this.fills = [];
    for (const filling of this.fillings) filling.abort.abort();
    for (const running of [...this.runnings]) this.stop(running);
    for (const done of this.settled.splice(0)) done();
  }

  private row(key: CopyKey): CopyRow | undefined {
    return this.db.prepare("SELECT * FROM copies WHERE item_id = ? AND rung = ? AND audio = ?").get(key.itemId, key.rung, key.audio) as CopyRow | undefined;
  }

  /** Still the copy of this file, and still on the disk. */
  private fresh(row: CopyRow, key: CopyKey, source: ProbedFile): boolean {
    return row.source_size === source.size && row.source_modified === source.modified.toISOString() && fs.existsSync(path.join(this.dir, fileName(key)));
  }

  private drop(key: CopyKey): void {
    this.queue = this.queue.filter((job) => keyOf(job) !== keyOf(key));
    const running = this.runnings.find((candidate) => keyOf(candidate.job) === keyOf(key));
    if (running) this.stop(running);
    this.db.prepare("DELETE FROM copies WHERE item_id = ? AND rung = ? AND audio = ?").run(key.itemId, key.rung, key.audio);
    fs.rmSync(path.join(this.dir, fileName(key)), { force: true });
  }

  /** Kills a copy being made and removes what there was of it. */
  private stop(running: Running): void {
    if (!this.runnings.includes(running)) return;
    this.runnings = this.runnings.filter((candidate) => candidate !== running);
    running.abort?.abort();
    if (running.proc) {
      if (running.paused) running.proc.kill("SIGCONT");
      running.proc.kill("SIGKILL");
    }
    fs.rm(`${path.join(this.dir, fileName(running.job))}.part`, { force: true }, () => undefined);
    if (!this.closed) this.next();
  }

  /** Starts what there is room for, and what the gate (or the admin) lets go. */
  private next(): void {
    if (this.closed) return;
    const open = this.gate().open;
    for (;;) {
      if (this.runnings.length + this.fillings.length >= this.jobSettings.atOnce) return;
      const copyAt = this.queue.findIndex((job) => open || this.forced.has(copyJobId(job)));
      if (copyAt >= 0) {
        const [job] = this.queue.splice(copyAt, 1);
        this.start(job, false);
        continue;
      }
      const fillAt = this.fills.findIndex((job) => open || this.forced.has(job.id));
      if (fillAt >= 0) {
        const [job] = this.fills.splice(fillAt, 1);
        this.startFill(job);
        continue;
      }
      if (this.runnings.length === 0 && this.fillings.length === 0 && this.queue.length === 0 && this.fills.length === 0) {
        for (const done of this.settled.splice(0)) done();
      }
      return;
    }
  }

  /** How a job encodes: a copy's limits, and on the CPU half the cores at a
   *  slower preset (the server has other things to do, and the result is kept). */
  private jobEncode(rung: Rung, gpu: boolean): FillOptions["encode"] {
    return { limits: COPY_LIMITS[rung], threads: gpu ? undefined : Math.max(1, Math.floor(os.cpus().length / 2)), preset: "medium" };
  }

  /** A version kept ready or finished off: filled, nothing else. */
  private startFill(job: FillJob): void {
    const filling: Filling = { job, abort: new AbortController(), progress: 0 };
    this.fillings.push(filling);
    const rung = (job.plan.delivery.rung ?? 1080) as Rung;
    const gpu = Boolean(this.hardware?.choose(job.plan.info, job.plan.delivery));
    this.log.info({ item: job.itemId, kind: job.kind, quality: job.plan.delivery.rung }, job.kind === "keep" ? "Keeping a version ready" : "Finishing off a version left mostly made");
    const done = (failure: string | null) => {
      if (!this.fillings.includes(filling)) return;
      this.fillings = this.fillings.filter((candidate) => candidate !== filling);
      if (!filling.parked) this.forced.delete(job.id);
      // Stood down by the gate: back at the front, to carry on where it was.
      if (filling.parked) this.fills.unshift(job);
      else if (failure && !filling.abort.signal.aborted) this.log.warn({ item: job.itemId, kind: job.kind }, failure);
      this.next();
    };
    if (!this.filler) {
      done("Nothing can be kept here");
      return;
    }
    this.filler.fill(job.plan, job.title, {
      encode: this.jobEncode(rung, gpu), polite: true, signal: filling.abort.signal,
      onProgress: (state) => { filling.progress = state.total > 0 ? state.done / state.total : 0; }
    }).then(() => done(null), (err: Error) => done(err.message));
  }

  /** A copy whose picture is re-encoded: made as the version a viewer would get,
   *  into the shared cache (resumable, shared), then put together as one MP4. */
  private startFilled(job: CopyJob): void {
    const filler = this.filler!;
    const plan = buildPlan(job.itemId, job.file.absolute, job.info, job.delivery, null, fileStamp(job.file));
    const abort = new AbortController();
    const gpu = this.hardware?.choose(job.info, job.delivery) ?? null;
    const running: Running = { job, proc: null, gpu, startedAt: Date.now(), progress: 0, paused: false, abort };
    this.runnings.push(running);
    this.db.prepare("UPDATE copies SET state = 'running' WHERE item_id = ? AND rung = ? AND audio = ?").run(job.itemId, job.rung, job.audio);
    this.log.info({ item: job.itemId, quality: job.rung, mode: job.delivery.mode, through: "cache" }, "Making a copy to download");
    filler.fill(plan, job.title, {
      encode: this.jobEncode(job.rung, Boolean(gpu)), polite: true, signal: abort.signal,
      onProgress: (state) => { running.progress = state.total > 0 ? Math.min(0.97, (0.97 * state.done) / state.total) : 0; }
    }).then(
      () => { if (this.runnings.includes(running)) this.putTogether(running, plan); },
      (err: Error) => {
        if (running.parked) {
          // Stood down by the gate: back at the front, to carry on where it was.
          this.runnings = this.runnings.filter((candidate) => candidate !== running);
          this.db.prepare("UPDATE copies SET state = 'queued' WHERE item_id = ? AND rung = ? AND audio = ?").run(job.itemId, job.rung, job.audio);
          this.queue.unshift(job);
          this.next();
          return;
        }
        this.finish(running, `The copy could not be made: ${err.message}`, "");
      }
    );
  }

  /** The kept version's segments, one after another, into an MP4: copied, not
   *  encoded, so it takes seconds. They go to ffmpeg as one MPEG-TS stream — they
   *  carry the film's own clock (-copyts), so they join byte for byte — not
   *  through the concat demuxer and a list file, which crashed (SIGSEGV) on the
   *  Linux ffmpeg build CI uses. */
  private putTogether(running: Running, plan: HlsPlan): void {
    const job = running.job;
    const files = this.filler?.keptSegments(plan) ?? null;
    if (!files) {
      this.finish(running, "The copy could not be made: its version was not kept whole", "");
      return;
    }
    const out = path.join(this.dir, fileName(job));
    // ADTS AAC (a converted sound, or AAC copied) needs its headers made MP4's.
    const aac = Boolean(job.delivery.audio) && (!job.delivery.audioCopy || job.delivery.audio?.codec === "aac");
    const args = ["-hide_banner", "-v", "error", "-y", "-f", "mpegts", "-i", "pipe:0", "-map", "0", "-c", "copy",
      ...(aac ? ["-bsf:a", "aac_adtstoasc"] : []), "-movflags", "+faststart", "-f", "mp4", `${out}.part`];
    const proc = spawn(this.tools.ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    running.proc = proc;
    running.abort = undefined;
    // ffmpeg gone early (an error, or stopped) breaks the pipe: its exit says why.
    proc.stdin?.on("error", () => undefined);
    void (async () => {
      for (const file of files) {
        if (!proc.stdin || proc.stdin.destroyed) return;
        await pipeline(fs.createReadStream(file), proc.stdin, { end: false }).catch(() => undefined);
      }
      proc.stdin?.end();
    })();
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    proc.on("error", (err) => this.finish(running, `ffmpeg could not start: ${err.message}`, stderr));
    proc.on("exit", (code, signal) => {
      if (code === 0) this.finish(running, null, stderr);
      else this.finish(running, `The copy could not be put together: ${stderr.trim().split(/\r?\n/).pop() || `exit ${code ?? signal}`}`, stderr);
    });
  }

  /** A copy is done: kept and ready, or failed, and the next job goes. */
  private finish(running: Running, failure: string | null, stderr: string): void {
    if (!this.runnings.includes(running)) return;
    this.runnings = this.runnings.filter((candidate) => candidate !== running);
    const job = running.job;
    this.forced.delete(copyJobId(job));
    const out = path.join(this.dir, fileName(job));
    const part = `${out}.part`;
    if (failure === null) {
      try {
        fs.renameSync(part, out);
        const size = fs.statSync(out).size;
        this.db.prepare("UPDATE copies SET state = 'ready', size_bytes = ?, ready_at = ?, used_at = ?, error = NULL WHERE item_id = ? AND rung = ? AND audio = ?")
          .run(size, now(), now(), job.itemId, job.rung, job.audio);
        this.log.info({ item: job.itemId, quality: job.rung, size, seconds: Math.round((Date.now() - running.startedAt) / 1000), gpu: Boolean(running.gpu) }, "A copy is ready to download");
        this.trim(job);
        this.onReady?.(job);
      } catch (err) {
        failure = `The copy could not be kept: ${(err as Error).message}`;
      }
    }
    if (failure !== null) {
      fs.rm(part, { force: true }, () => undefined);
      this.db.prepare("UPDATE copies SET state = 'failed', error = ? WHERE item_id = ? AND rung = ? AND audio = ?").run(failure, job.itemId, job.rung, job.audio);
      this.log.warn({ item: job.itemId, quality: job.rung, stderr: stderr.trim() }, failure);
    }
    this.next();
  }

  private start(job: CopyJob, cpuOnly: boolean): void {
    if (this.filler?.canKeep && !job.delivery.videoCopy) {
      this.startFilled(job);
      return;
    }
    const out = path.join(this.dir, fileName(job));
    const part = `${out}.part`;
    const gpu = cpuOnly ? null : this.hardware?.choose(job.info, job.delivery) ?? null;
    const plan = buildPlan(job.itemId, job.file.absolute, job.info, job.delivery, null);
    // On the CPU, half the cores: the server has other things to do.
    const threads = gpu || job.delivery.videoCopy ? undefined : Math.max(1, Math.floor(os.cpus().length / 2));
    const args = ffmpegArgs(plan, 0, this.dir, gpu, { path: part, limits: COPY_LIMITS[job.rung], threads });
    // Below everything else that runs here, where the system has a word for that.
    const polite = process.platform !== "win32";
    const proc = spawn(polite ? "nice" : this.tools.ffmpeg, polite ? ["-n", "15", this.tools.ffmpeg, ...args] : args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const running: Running = { job, proc, gpu, startedAt: Date.now(), progress: 0, paused: false };
    this.runnings.push(running);
    this.db.prepare("UPDATE copies SET state = 'running' WHERE item_id = ? AND rung = ? AND audio = ?").run(job.itemId, job.rung, job.audio);
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    // ffmpeg's own account of how far it is (-progress): microseconds of film written.
    proc.stdout?.on("data", (chunk: Buffer) => {
      const at = /out_time_(?:us|ms)=(\d+)/g;
      let last: RegExpExecArray | null = null;
      for (let match = at.exec(chunk.toString()); match; match = at.exec(chunk.toString())) last = match;
      if (last && job.info.duration > 0) running.progress = Math.min(0.999, Number(last[1]) / 1_000_000 / job.info.duration);
    });
    const finish = (failure: string | null) => this.finish(running, failure, stderr);
    proc.on("error", (err) => finish(`ffmpeg could not start: ${err.message}`));
    proc.on("exit", (code, signal) => {
      if (!this.runnings.includes(running)) return;
      if (code === 0) return finish(null);
      const reason = stderr.trim().split(/\r?\n/).pop() || `exit ${code ?? signal}`;
      // The GPU failed: the same copy again on the CPU, unless the admin asked for the GPU only.
      if (gpu && this.hardware?.failed(reason, stderr)) {
        this.log.warn({ item: job.itemId, reason }, "The GPU could not make this copy; making it on the CPU");
        this.runnings = this.runnings.filter((candidate) => candidate !== running);
        fs.rm(part, { force: true }, () => undefined);
        this.start(job, true);
        return;
      }
      finish(`The copy could not be made: ${reason}`);
    });
    this.log.info({ item: job.itemId, quality: job.rung, mode: job.delivery.mode, gpu: gpu ? (gpu.decode ? "decode+encode" : "encode") : null }, "Making a copy to download");
  }

  /** Every few seconds: someone watching comes first (jobs stand still while video
   *  is converted for a viewer, not on Windows, which has no way to say so); a gate
   *  that closes stands jobs made through the cache down, to carry on later where
   *  they were (a whole-file copy, a few minutes, finishes); one that opens lets
   *  the queue go. */
  private watch(): void {
    if (this.closed) return;
    const gate = this.gate();
    if (!gate.open) {
      for (const running of this.runnings) {
        if (running.abort && !running.parked && !this.forced.has(copyJobId(running.job))) {
          running.parked = true;
          running.abort.abort();
        }
      }
      for (const filling of this.fillings) {
        if (!filling.parked && !this.forced.has(filling.job.id)) {
          filling.parked = true;
          filling.abort.abort();
        }
      }
    }
    this.next();
    if (process.platform === "win32") return;
    const wanted = this.busy();
    // Fills (through the cache) stand still in hls.ts.
    if (this.fillings.length > 0 || this.runnings.some((running) => running.abort)) this.filler?.pauseFills(wanted);
    for (const running of this.runnings) {
      if (!running.proc || running.abort || wanted === running.paused) continue;
      running.paused = wanted;
      running.proc.kill(wanted ? "SIGSTOP" : "SIGCONT");
    }
  }

  /** Keeps the finished copies under the admin's size: the ones used longest ago
   *  go first, never the one just made. */
  private trim(keep: CopyKey | null): void {
    const limit = this.settings.limitGb * 1024 ** 3;
    const rows = this.db.prepare("SELECT * FROM copies WHERE state = 'ready' ORDER BY COALESCE(used_at, ready_at) ASC").all() as CopyRow[];
    let used = rows.reduce((sum, row) => sum + row.size_bytes, 0);
    for (const row of rows) {
      if (used <= limit) break;
      const key = { itemId: row.item_id, rung: row.rung as Rung, audio: row.audio };
      if (keep && keyOf(key) === keyOf(keep)) continue;
      this.drop(key);
      used -= row.size_bytes;
    }
  }
}
