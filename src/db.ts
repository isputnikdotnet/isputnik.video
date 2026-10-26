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
  db.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
  return db;
}

export type Db = Database.Database;
