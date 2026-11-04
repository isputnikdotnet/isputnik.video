import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

// The engine's SQLite file: DB_PATH, else data/video.sqlite under the repo root
// (the image sets /config/video.sqlite). ":memory:" for the tests. The schema is
// idempotent, applied on every open; a column added later goes in as an ALTER
// guarded by a lookup, here, in order.
const here = path.dirname(fileURLToPath(import.meta.url));

export function openDatabase(file: string): Database.Database {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  if (file !== ":memory:") db.pragma("journal_mode = WAL");
  upgradeDatabase(db);
  return db;
}

/** This version's schema on a database of any older one: what opening does, and
 *  what a backup goes through before it is restored (restore.ts). */
export function upgradeDatabase(db: Database.Database): void {
  // All or nothing: a widening stopped halfway would leave the marks in the old table.
  db.transaction(() => {
    addColumns(db);
    const widening = setAsideNarrowMarkers(db);
    db.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
    if (widening) {
      db.exec(`INSERT INTO markers (item_id, season, kind, start_s, end_s, source, updated_at)
        SELECT item_id, season, kind, start_s, end_s, source, updated_at FROM ${OLD_MARKERS}; DROP TABLE ${OLD_MARKERS};`);
    }
    dateTheUndated(db);
  })();
}

/** Titles from before 0.19 have no added_at: their files' age stands in, so a
 *  library that has been there for years doesn't all read as "just added". */
function dateTheUndated(db: Database.Database): void {
  db.exec(`
    UPDATE movies SET added_at = COALESCE(modified_at, updated_at) WHERE added_at IS NULL;
    UPDATE shows SET added_at = COALESCE((SELECT MIN(e.modified_at) FROM episodes e WHERE e.show_id = shows.id), updated_at)
      WHERE added_at IS NULL;
  `);
}

const OLD_MARKERS = "markers_before_recap";

/** A markers table from 0.15/0.16 lets no 'recap' kind in, and SQLite can't change
 *  a CHECK in place: it is renamed so schema.sql makes the new one, and its rows
 *  are copied over. */
function setAsideNarrowMarkers(db: Database.Database): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'markers'").get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'recap'")) return false;
  db.exec(`DROP TABLE IF EXISTS ${OLD_MARKERS}; ALTER TABLE markers RENAME TO ${OLD_MARKERS};`);
  return true;
}

/** Columns added after a table was first made: added to an older file before
 *  the schema runs (a new file gets them from schema.sql itself). */
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  ["movies", "set_name", "TEXT"],
  ["movies", "set_overview", "TEXT"],
  ["movies", "set_tmdb_id", "TEXT"],
  ["movies", "set_order", "INTEGER"],
  ["metadata", "set_tmdb_id", "TEXT"],
  ["metadata", "set_name", "TEXT"],
  ["metadata", "set_checked", "INTEGER NOT NULL DEFAULT 0"],
  ["metadata", "backdrop_choice", "TEXT"],
  ["metadata", "backdrop_picked", "INTEGER NOT NULL DEFAULT 0"],
  ["metadata", "tmdb_kind", "TEXT CHECK (tmdb_kind IN ('movie', 'tv'))"],
  ["detected_markers", "recap_start", "REAL"],
  ["detected_markers", "recap_end", "REAL"],
  ["detected_markers", "recap_checked", "INTEGER NOT NULL DEFAULT 0"],
  ["shows", "added_at", "TEXT"],
  ["movies", "added_at", "TEXT"]
];

function addColumns(db: Database.Database): void {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[];
    // No table yet: schema.sql makes it whole.
    if (columns.length === 0 || columns.some((row) => row.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export type Db = Database.Database;
