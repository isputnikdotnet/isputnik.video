// The disk check (home's docs/video-hardware-tests-plan.md, H3): for each active
// library, how long its disks take to answer and how fast they read, against what
// its heaviest film needs. What StefanKnol's reports came down to (isputnik.video
// #1, #6): disks on an Unraid user share that had spun down, each first read
// waiting seconds while the disk woke.
//
// Reads only, as everywhere in this engine. Run when an admin asks, never while
// someone watches converted video or a hardware test runs (they would share the
// disks and both measure wrong); background work waits while it runs.
import fs from "node:fs";
import type { Db } from "./db.js";
import type { Identity } from "./identity.js";
import { listLibraries, type LibraryView } from "./libraries.js";
import { normalizeRelative } from "./media.js";
import { fileOfAsync, findItem } from "./playback.js";

/** Sees every library: the engine's own check, not anyone's request. */
const ENGINE: Identity = { id: "engine", name: "engine", role: "admin", appRole: "manager", libraries: "all", lang: "en", theme: "", historyId: "engine", network: "home" };

export interface DiskLimits {
  /** Files looked up per library for the wake-up time, spread over its titles. */
  samples: number;
  /** The most read from one file for the reading speed. */
  readBytes: number;
  /** …and for how long at most. */
  readMs: number;
}

export const DEFAULT_DISK_LIMITS: DiskLimits = { samples: 6, readBytes: 512 * 1024 * 1024, readMs: 20_000 };

/** A first answer slower than this means a disk was asleep (or the share is very slow). */
const ASLEEP_MS = 2000;
/** What is read at each sampled file to wake its disk: a small piece, somewhere in it. */
const PROBE_BYTES = 64 * 1024;
const CHUNK = 4 * 1024 * 1024;
/** Less than this read says nothing of the disk's speed (a library of tiny files, a test's). */
const MIN_READ = 16 * 1024 * 1024;

export type DiskVerdict = "plenty" | "enough" | "short" | "unknown";

export interface LibraryDisk {
  libraryId: string;
  name: string;
  kind: LibraryView["kind"];
  /** The wake-up: each sampled file's first answer, in ms, in the order looked at. */
  wake: { samples: number[]; slowestMs: number | null; medianMs: number | null; asleep: boolean };
  /** The reading speed from the library's largest file. */
  /** `mbitPerSecond` is null when the largest file was too small to measure by. */
  read: { file: string; bytes: number; seconds: number; mbitPerSecond: number | null } | null;
  /** The most any probed film of the library needs, in Mbit/s; null when none is probed yet. */
  heaviestMbit: number | null;
  /** Reading against the heaviest: plenty (2× or more), enough (1–2×), short (less). */
  verdict: DiskVerdict;
  error: string | null;
}

export interface DiskCheck {
  id: number | null;
  startedAt: string;
  finishedAt: string | null;
  phase: "running" | "done" | "stopped" | "failed";
  /** The library being checked now, and what of it. */
  step: { libraryId: string; name: string; kind: "wake" | "read" } | null;
  reason: string | null;
  libraries: LibraryDisk[];
}

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

export const diskVerdict = (mbitPerSecond: number | null, heaviestMbit: number | null): DiskVerdict =>
  mbitPerSecond === null || heaviestMbit === null || heaviestMbit <= 0 ? "unknown"
    : mbitPerSecond >= heaviestMbit * 2 ? "plenty"
    : mbitPerSecond >= heaviestMbit ? "enough"
    : "short";

/** Items of a library to look up: one per title, spread over its titles (and so,
 *  on an Unraid share, most likely over its disks). */
function sampleItems(db: Db, library: LibraryView, count: number): string[] {
  const rows = library.kind === "movies"
    ? db.prepare("SELECT id FROM movies WHERE library_id = ? ORDER BY random() LIMIT ?").all(library.id, count)
    : db.prepare(`SELECT (SELECT e.id FROM episodes e WHERE e.show_id = s.id ORDER BY random() LIMIT 1) AS id
        FROM shows s WHERE s.library_id = ? ORDER BY random() LIMIT ?`).all(library.id, count);
  return (rows as { id: string | null }[]).map((row) => row.id).filter((id): id is string => Boolean(id));
}

/** The library's largest file, by what the scan saw. */
function largestItem(db: Db, library: LibraryView): string | null {
  const row = library.kind === "movies"
    ? db.prepare("SELECT id FROM movies WHERE library_id = ? ORDER BY size_bytes DESC LIMIT 1").get(library.id)
    : db.prepare("SELECT e.id FROM episodes e JOIN shows s ON s.id = e.show_id WHERE s.library_id = ? ORDER BY e.size_bytes DESC LIMIT 1").get(library.id);
  return (row as { id: string } | undefined)?.id ?? null;
}

/** The most any probed film or episode of the library needs, in Mbit/s. */
function heaviestOf(db: Db, library: LibraryView): number | null {
  const rows = (library.kind === "movies"
    ? db.prepare("SELECT p.info FROM media_probe p JOIN movies m ON m.id = p.item_id WHERE m.library_id = ?").all(library.id)
    : db.prepare("SELECT p.info FROM media_probe p JOIN episodes e ON e.id = p.item_id JOIN shows s ON s.id = e.show_id WHERE s.library_id = ?").all(library.id)
  ) as { info: string }[];
  let most = 0;
  for (const row of rows) {
    try {
      const rate = Number((JSON.parse(row.info) as { bitRate?: number | null }).bitRate);
      if (Number.isFinite(rate) && rate > most) most = rate;
    } catch {
      /* a probe we can't read: left out */
    }
  }
  return most > 0 ? Math.round(most / 100_000) / 10 : null;
}

/** Opens a file and reads a small piece of it, somewhere in it. */
async function firstAnswer(file: string, size: number): Promise<void> {
  const handle = await fs.promises.open(file, "r");
  try {
    const at = size > PROBE_BYTES * 2 ? Math.floor(Math.random() * (size - PROBE_BYTES)) : 0;
    await handle.read(Buffer.alloc(PROBE_BYTES), 0, PROBE_BYTES, at);
  } finally {
    await handle.close();
  }
}

/** Reads from a file, from a point somewhere in it, as fast as the disk gives. */
async function readSpeed(file: string, size: number, limits: DiskLimits, signal: AbortSignal): Promise<{ bytes: number; seconds: number }> {
  const want = Math.min(limits.readBytes, size);
  // Not from the start, which a scan or a player read last; somewhere it is less
  // likely to be in the server's memory already.
  const from = size > want ? Math.floor(Math.random() * (size - want) / CHUNK) * CHUNK : 0;
  const buffer = Buffer.alloc(CHUNK);
  const handle = await fs.promises.open(file, "r");
  const started = performance.now();
  let read = 0;
  try {
    while (read < want && performance.now() - started < limits.readMs && !signal.aborted) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, want - read), from + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { bytes: read, seconds: (performance.now() - started) / 1000 };
}

/** How many checks are kept. */
const KEPT = 20;

export class DiskChecker {
  private current: DiskCheck | null = null;
  private abort: AbortController | null = null;
  private done: Promise<void> = Promise.resolve();
  private limits: DiskLimits;

  constructor(private options: { db: Db; mediaRoot: string; log: { warn(obj: object, msg: string): void }; limits?: Partial<DiskLimits> }) {
    this.limits = { ...DEFAULT_DISK_LIMITS, ...options.limits };
  }

  running(): boolean {
    return this.current?.phase === "running";
  }

  progress(): DiskCheck | null {
    return this.running() ? this.current : null;
  }

  settled(): Promise<void> {
    return this.done;
  }

  start(): DiskCheck {
    if (this.running()) throw new Error("A disk check is running already");
    const check: DiskCheck = { id: null, startedAt: new Date().toISOString(), finishedAt: null, phase: "running", step: null, reason: null, libraries: [] };
    this.current = check;
    this.abort = new AbortController();
    this.done = this.run(check, this.abort.signal);
    return check;
  }

  stop(reason: string): void {
    if (!this.running() || !this.abort || this.abort.signal.aborted) return;
    this.current!.reason = reason;
    this.abort.abort();
  }

  private async run(check: DiskCheck, signal: AbortSignal): Promise<void> {
    const { db, mediaRoot } = this.options;
    try {
      for (const library of listLibraries(db).filter((entry) => entry.state === "active")) {
        signal.throwIfAborted();
        const entry: LibraryDisk = {
          libraryId: library.id, name: library.name, kind: library.kind,
          wake: { samples: [], slowestMs: null, medianMs: null, asleep: false },
          read: null, heaviestMbit: heaviestOf(db, library), verdict: "unknown", error: null
        };
        check.libraries.push(entry);
        try {
          check.step = { libraryId: library.id, name: library.name, kind: "wake" };
          // One at a time: each file's own disk, not several waking at once.
          for (const id of sampleItems(db, library, this.limits.samples)) {
            signal.throwIfAborted();
            const item = findItem(db, ENGINE, id);
            if (!item) continue;
            // Finding the file counts too: on a user share that is where a sleeping disk is felt first.
            const started = performance.now();
            const file = await fileOfAsync(mediaRoot, item);
            if (!file) continue;
            await firstAnswer(file.absolute, file.size);
            entry.wake.samples.push(Math.round(performance.now() - started));
          }
          entry.wake.slowestMs = entry.wake.samples.length ? Math.max(...entry.wake.samples) : null;
          entry.wake.medianMs = median(entry.wake.samples);
          entry.wake.asleep = (entry.wake.slowestMs ?? 0) >= ASLEEP_MS;

          signal.throwIfAborted();
          check.step = { libraryId: library.id, name: library.name, kind: "read" };
          const largest = largestItem(db, library);
          const item = largest ? findItem(db, ENGINE, largest) : null;
          const file = item ? await fileOfAsync(mediaRoot, item) : null;
          if (file && file.size > 0) {
            const { bytes, seconds } = await readSpeed(file.absolute, file.size, this.limits, signal);
            signal.throwIfAborted();
            const mbit = seconds > 0 && bytes >= MIN_READ ? Math.round((bytes * 8) / seconds / 100_000) / 10 : null;
            entry.read = { file: normalizeRelative(item!.relative), bytes, seconds: Math.round(seconds * 100) / 100, mbitPerSecond: mbit };
          }
          entry.verdict = diskVerdict(entry.read?.mbitPerSecond ?? null, entry.heaviestMbit);
        } catch (err) {
          if (signal.aborted) throw err;
          entry.error = err instanceof Error ? err.message : String(err);
        }
      }
      check.phase = "done";
    } catch (err) {
      if (signal.aborted) {
        check.phase = "stopped";
        check.reason ??= "Stopped";
      } else {
        check.phase = "failed";
        check.reason = err instanceof Error ? err.message : String(err);
        this.options.log.warn({ err }, "The disk check failed");
      }
    } finally {
      check.step = null;
      check.finishedAt = new Date().toISOString();
      check.id = this.keep(check);
    }
  }

  private keep(check: DiskCheck): number | null {
    const { db } = this.options;
    if (!db.open) return null;
    const id = Number(db.prepare("INSERT INTO disk_checks (started_at, finished_at, phase, result) VALUES (?, ?, ?, ?)")
      .run(check.startedAt, check.finishedAt, check.phase, JSON.stringify(check)).lastInsertRowid);
    db.prepare("DELETE FROM disk_checks WHERE id NOT IN (SELECT id FROM disk_checks ORDER BY id DESC LIMIT ?)").run(KEPT);
    return id;
  }
}

export function listDiskChecks(db: Db, limit = KEPT): DiskCheck[] {
  return (db.prepare("SELECT id, result FROM disk_checks ORDER BY id DESC LIMIT ?").all(limit) as { id: number; result: string }[])
    .map((row) => ({ ...(JSON.parse(row.result) as DiskCheck), id: row.id }));
}
