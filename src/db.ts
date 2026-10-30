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
  addColumns(db);
  db.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
}

/** Columns added after a table was first made: added to an older file before
 *  the schema runs (a new file gets them from schema.sql itself). */
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  ["movies", "set_name", "TEXT"],
  ["movies", "set_overview", "TEXT"],
  ["movies", "set_tmdb_id", "TEXT"],
  ["metadata", "set_tmdb_id", "TEXT"],
  ["metadata", "set_name", "TEXT"],
  ["metadata", "set_checked", "INTEGER NOT NULL DEFAULT 0"]
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
