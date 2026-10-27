// The libraries home has told this engine about (home's docs/video-architecture.md).
// Home is the source of truth for which libraries exist and who may see them;
// this engine keeps their contents. Home sends a library when it is created or
// changed (put), says it is gone when it is deleted there (purge), and from time
// to time sends the whole list (sync): a library missing from that list is only
// detached — kept, out of sight — so restoring an older home backup cannot wipe
// the newer library's catalog and progress. Only a purge deletes.
import fs from "node:fs";
import type { Db } from "./db.js";
import { normalizeRelative, resolveInside } from "./media.js";

export type LibraryKind = "shows" | "movies";

export interface LibraryInput {
  name: string;
  kind: LibraryKind;
  folder: string;
  language: string;
}

export interface LibraryView {
  id: string;
  name: string;
  kind: LibraryKind;
  folder: string;
  language: string;
  state: "active" | "detached";
  detachedAt: string | null;
  scanState: "idle" | "queued" | "scanning" | "error";
  scanError: string | null;
  lastScanAt: string | null;
  /** Shows or movies. */
  titles: number;
  episodes: number;
  sizeBytes: number;
}

interface Row {
  id: string;
  name: string;
  kind: LibraryKind;
  folder: string;
  language: string;
  state: "active" | "detached";
  detached_at: string | null;
  scan_state: LibraryView["scanState"];
  scan_error: string | null;
  last_scan_at: string | null;
}

export class LibraryError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Create or change a library. Says whether its contents need a (re)scan, and
 *  whether TMDB must be asked again (its words are in the library's language). */
export function putLibrary(db: Db, mediaRoot: string, id: string, input: LibraryInput): { created: boolean; rescan: boolean; relanguage: boolean } {
  const folder = normalizeRelative(input.folder);
  const dir = resolveInside(mediaRoot, folder);
  if (!dir || !fs.statSync(dir).isDirectory()) throw new LibraryError(`The folder "${folder}" is not there on the video app`, 422);
  const existing = db.prepare("SELECT kind, folder, state, language FROM libraries WHERE id = ?").get(id) as Pick<Row, "kind" | "folder" | "state" | "language"> | undefined;
  if (existing && existing.kind !== input.kind) {
    // Shows and movies are read differently; a library keeps the kind it was made with.
    throw new LibraryError("A library's kind cannot change; make a new library instead", 409);
  }
  db.prepare(`
    INSERT INTO libraries (id, name, kind, folder, language)
    VALUES (@id, @name, @kind, @folder, @language)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, folder = excluded.folder, language = excluded.language,
      state = 'active', detached_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run({ id, name: input.name, kind: input.kind, folder, language: input.language });
  return {
    created: !existing,
    rescan: !existing || existing.folder !== folder || existing.state === "detached",
    relanguage: Boolean(existing) && existing!.language !== input.language
  };
}

/** Delete a library and everything catalogued in it: home deleted it. */
export function purgeLibrary(db: Db, id: string): boolean {
  return db.prepare("DELETE FROM libraries WHERE id = ?").run(id).changes > 0;
}

/** Home's whole list: the libraries in it are active, the others detached. */
export function syncLibraries(db: Db, ids: string[]): { detached: string[]; reattached: string[] } {
  const listed = new Set(ids);
  const rows = db.prepare("SELECT id, state FROM libraries").all() as Pick<Row, "id" | "state">[];
  const detached: string[] = [];
  const reattached: string[] = [];
  const run = db.transaction(() => {
    for (const row of rows) {
      if (listed.has(row.id) && row.state === "detached") {
        db.prepare("UPDATE libraries SET state = 'active', detached_at = NULL WHERE id = ?").run(row.id);
        reattached.push(row.id);
      } else if (!listed.has(row.id) && row.state === "active") {
        db.prepare("UPDATE libraries SET state = 'detached', detached_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(row.id);
        detached.push(row.id);
      }
    }
  });
  run();
  return { detached, reattached };
}

/** Detached libraries older than this are purged by the daily sweep. */
export const DETACHED_KEEP_DAYS = 30;

export function purgeDetached(db: Db, days = DETACHED_KEEP_DAYS): number {
  return db.prepare("DELETE FROM libraries WHERE state = 'detached' AND detached_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)").run(`-${days} days`).changes;
}

export function setScanState(db: Db, id: string, state: LibraryView["scanState"], error: string | null = null): void {
  db.prepare(`
    UPDATE libraries SET scan_state = ?, scan_error = ?,
      last_scan_at = CASE WHEN ? IN ('idle', 'error') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE last_scan_at END
    WHERE id = ?
  `).run(state, error, state, id);
}

export function listLibraries(db: Db): LibraryView[] {
  const rows = db.prepare("SELECT * FROM libraries ORDER BY name COLLATE NOCASE").all() as Row[];
  return rows.map((row) => libraryView(db, row));
}

export function getLibrary(db: Db, id: string): LibraryView | null {
  const row = db.prepare("SELECT * FROM libraries WHERE id = ?").get(id) as Row | undefined;
  return row ? libraryView(db, row) : null;
}

function libraryView(db: Db, row: Row): LibraryView {
  const counts = row.kind === "shows"
    ? db.prepare(`
        SELECT (SELECT COUNT(*) FROM shows WHERE library_id = @id) AS titles,
               (SELECT COUNT(*) FROM episodes e JOIN shows s ON s.id = e.show_id WHERE s.library_id = @id) AS episodes,
               (SELECT COALESCE(SUM(e.size_bytes), 0) FROM episodes e JOIN shows s ON s.id = e.show_id WHERE s.library_id = @id) AS size
      `).get({ id: row.id }) as { titles: number; episodes: number; size: number }
    : db.prepare(`
        SELECT COUNT(*) AS titles, 0 AS episodes, COALESCE(SUM(size_bytes), 0) AS size FROM movies WHERE library_id = @id
      `).get({ id: row.id }) as { titles: number; episodes: number; size: number };
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    folder: row.folder,
    language: row.language,
    state: row.state,
    detachedAt: row.detached_at,
    scanState: row.scan_state,
    scanError: row.scan_error,
    lastScanAt: row.last_scan_at,
    titles: counts.titles,
    episodes: counts.episodes,
    sizeBytes: counts.size
  };
}
