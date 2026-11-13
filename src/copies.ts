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
// What waits or runs is only in memory: a restart drops it, and whoever is
// waiting asks again (home's downloader does, on its next look).
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Db } from "./db.js";
import { RUNG_LIMITS, type Delivery, type Rung } from "./delivery.js";
import type { MediaInfo, Tools } from "./ffmpeg.js";
import type { GpuRun, Hardware } from "./hardware.js";
import { buildPlan, ffmpegArgs, type HlsLog } from "./hls.js";
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
}

export interface CopyKey {
  itemId: string;
  rung: Rung;
  /** The sound track in it: ffprobe's stream index, -1 for a silent film. */
  audio: number;
}

export interface CopyJob extends CopyKey {
  title: string;
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
  proc: ChildProcess;
  gpu: GpuRun | null;
  startedAt: number;
  progress: number;
  paused: boolean;
}

const keyOf = (key: CopyKey) => `${key.itemId}:${key.rung}:${key.audio}`;
const fileName = (key: CopyKey) => `${key.itemId}-${key.rung}-a${key.audio}.mp4`;
const now = () => new Date().toISOString();

/** How long making it takes, roughly, before it has started: a picture copied as
 *  it is goes at disk speed, a GPU several times faster than the film plays, a
 *  CPU barely faster. */
export function estimateCopySeconds(info: MediaInfo, delivery: Delivery, gpu: boolean): number {
  const speed = delivery.videoCopy ? 40 : gpu ? 5 : 1.5;
  return Math.max(10, Math.round(info.duration / speed));
}

export class Copies {
  private queue: CopyJob[] = [];
  private running: Running | null = null;
  private settings: CopySettings = { ...DEFAULT_COPIES };
  private watcher: NodeJS.Timeout;
  private settled: (() => void)[] = [];
  private closed = false;

  /** `busy`: someone is watching converted video right now — the copy waits. */
  constructor(
    private db: Db,
    private tools: Tools,
    readonly dir: string,
    private log: HlsLog,
    private hardware: Pick<Hardware, "choose" | "failed"> | null,
    private busy: () => boolean = () => false
  ) {
    fs.mkdirSync(dir, { recursive: true });
    // Nothing outlives a restart but the finished copies: half-made files go, and
    // so does the word of anything that was waiting.
    for (const entry of fs.readdirSync(dir)) {
      if (entry.endsWith(".part")) fs.rmSync(path.join(dir, entry), { force: true });
    }
    db.prepare("DELETE FROM copies WHERE state IN ('queued', 'running')").run();
    this.watcher = setInterval(() => this.yieldToViewers(), 3000);
    this.watcher.unref();
  }

  configure(settings: CopySettings): void {
    this.settings = { ...settings };
    this.trim(null);
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
    const running = this.running && keyOf(this.running.job) === keyOf(key) ? this.running : null;
    const at = this.queue.findIndex((job) => keyOf(job) === keyOf(key));
    const progress = row.state === "ready" ? 1 : running?.progress ?? 0;
    const elapsed = running ? (Date.now() - running.startedAt) / 1000 : 0;
    return {
      state: row.state,
      progress,
      ahead: row.state === "queued" ? at + (this.running ? 1 : 0) : 0,
      paused: running?.paused ?? false,
      etaSeconds: running && progress > 0.03 && !running.paused ? Math.round((elapsed / progress) * (1 - progress)) : null,
      sizeBytes: row.state === "ready" ? row.size_bytes : null,
      error: row.error
    };
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

  /** A copy was just made: the app keeps everything kept under one limit (cache.ts). */
  onReady: ((key: CopyKey) => void) | null = null;

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

  /** Forgets every copy, made or not, and stops the one being made. */
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
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.settled.push(resolve));
  }

  close(): void {
    this.closed = true;
    clearInterval(this.watcher);
    this.queue = [];
    this.stop();
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
    if (this.running && keyOf(this.running.job) === keyOf(key)) this.stop();
    this.db.prepare("DELETE FROM copies WHERE item_id = ? AND rung = ? AND audio = ?").run(key.itemId, key.rung, key.audio);
    fs.rmSync(path.join(this.dir, fileName(key)), { force: true });
  }

  /** Kills the copy being made and removes what there was of it. */
  private stop(): void {
    const running = this.running;
    if (!running) return;
    this.running = null;
    if (running.paused) running.proc.kill("SIGCONT");
    running.proc.kill("SIGKILL");
    fs.rm(`${path.join(this.dir, fileName(running.job))}.part`, { force: true }, () => undefined);
    if (!this.closed) this.next();
  }

  private next(): void {
    if (this.closed || this.running) return;
    const job = this.queue.shift();
    if (!job) {
      for (const done of this.settled.splice(0)) done();
      return;
    }
    this.start(job, false);
  }

  private start(job: CopyJob, cpuOnly: boolean): void {
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
    this.running = running;
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
    const finish = (failure: string | null) => {
      if (this.running !== running) return;
      this.running = null;
      if (failure === null) {
        try {
          fs.renameSync(part, out);
          const size = fs.statSync(out).size;
          this.db.prepare("UPDATE copies SET state = 'ready', size_bytes = ?, ready_at = ?, used_at = ?, error = NULL WHERE item_id = ? AND rung = ? AND audio = ?")
            .run(size, now(), now(), job.itemId, job.rung, job.audio);
          this.log.info({ item: job.itemId, quality: job.rung, size, seconds: Math.round((Date.now() - running.startedAt) / 1000), gpu: Boolean(gpu) }, "A copy is ready to download");
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
    };
    proc.on("error", (err) => finish(`ffmpeg could not start: ${err.message}`));
    proc.on("exit", (code, signal) => {
      if (this.running !== running) return;
      if (code === 0) return finish(null);
      const reason = stderr.trim().split(/\r?\n/).pop() || `exit ${code ?? signal}`;
      // The GPU failed: the same copy again on the CPU, unless the admin asked for the GPU only.
      if (gpu && this.hardware?.failed(reason)) {
        this.log.warn({ item: job.itemId, reason }, "The GPU could not make this copy; making it on the CPU");
        this.running = null;
        fs.rm(part, { force: true }, () => undefined);
        this.start(job, true);
        return;
      }
      finish(`The copy could not be made: ${reason}`);
    });
    this.log.info({ item: job.itemId, quality: job.rung, mode: job.delivery.mode, gpu: gpu ? (gpu.decode ? "decode+encode" : "encode") : null }, "Making a copy to download");
  }

  /** Someone watching comes first: the copy stands still while video is converted
   *  for a viewer, and carries on after. (Not on Windows, which has no way to say so.) */
  private yieldToViewers(): void {
    const running = this.running;
    if (!running || process.platform === "win32") return;
    const wanted = this.busy();
    if (wanted === running.paused) return;
    running.paused = wanted;
    running.proc.kill(wanted ? "SIGSTOP" : "SIGCONT");
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
