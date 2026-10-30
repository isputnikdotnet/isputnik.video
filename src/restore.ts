// Putting a backup back (home's docs/dashboard-and-backups-plan.md → Container
// contract). Home keeps the backups and sends one here; this server checks it and
// swaps it in at once.
//
// The swap is not a file swap. The database stays open and every table's rows are
// replaced in ONE transaction, from a copy of the backup brought up to this
// version's schema first: nothing needs a restart, a statement prepared elsewhere
// keeps working, and anything going wrong halfway rolls back to what was there. The
// one kept file is the database a restore replaced, so the last restore can be undone.
import fs from "node:fs";
import Database from "better-sqlite3";
import type { Db } from "./db.js";

/** What a backup may weigh; home's own cap on what it stores from a container. */
export const RESTORE_BODY_LIMIT = 512 * 1024 * 1024;
export const SQLITE_CONTENT_TYPE = "application/vnd.sqlite3";

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

export class RestoreError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface RestoreTarget {
  db: Db;
  /** The live file, for where the replaced copy goes; ":memory:" keeps none. */
  dbPath: string;
  version: string;
  /** Tables a backup of this app must have: a database of anything else is refused. */
  tables: string[];
  /** What the refusal calls it. */
  name: string;
  /** Brings an older copy up to this version's schema. */
  upgrade: (db: Db) => void;
}

export interface UndoInfo {
  takenAt: string;
  version: string;
  bytes: number;
}

/** Numeric order of two versions, "1.2.3-x" reading as 1.2.3. */
function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split("-")[0].split(".").map((part) => Number(part) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const tablesOf = (db: Db) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map((row) => row.name);

const columnsOf = (db: Db, table: string) =>
  (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((row) => row.name);

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The bytes as a database of ours, in memory and on this version's schema. */
function openBackup(target: RestoreTarget, bytes: Buffer): Db {
  if (bytes.length < SQLITE_MAGIC.length || !bytes.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
    throw new RestoreError(400, "That file is not a database.");
  }
  // A copy of a WAL database says so in its header, and an in-memory database has
  // no WAL to open. The two bytes that say it go back to rollback mode, on a copy.
  const image = Buffer.from(bytes);
  image[18] = 1;
  image[19] = 1;
  let backup: Db;
  try {
    backup = new Database(image);
  } catch {
    throw new RestoreError(400, "That file is not a database that can be read.");
  }
  try {
    const check = backup.pragma("quick_check", { simple: true });
    if (check !== "ok") throw new RestoreError(400, `That database is damaged: ${String(check)}`);
    const has = new Set(tablesOf(backup));
    if (!target.tables.every((table) => has.has(table))) {
      throw new RestoreError(400, `That is not a backup of ${target.name}.`);
    }
    target.upgrade(backup);
    return backup;
  } catch (err) {
    backup.close();
    if (err instanceof RestoreError) throw err;
    throw new RestoreError(400, `That file is not a database that can be read: ${(err as Error).message}`);
  }
}

/** Every table's rows from the backup, or none of them. Both sides are on the same
 *  schema by now, unless the backup knows something this version doesn't. */
function replaceContents(target: RestoreTarget, backup: Db): void {
  const { db } = target;
  const live = new Set(tablesOf(db));
  const tables = tablesOf(backup);
  for (const table of tables) {
    if (!live.has(table)) throw new RestoreError(409, "That backup is from a newer version. Update this container first.");
    const columns = new Set(columnsOf(db, table));
    if (columnsOf(backup, table).some((column) => !columns.has(column))) {
      throw new RestoreError(409, "That backup is from a newer version. Update this container first.");
    }
  }
  const hasSequence = (from: Db) => from.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get() !== undefined;

  db.transaction(() => {
    // A child row may be inserted before its parent; the check waits for the commit.
    db.pragma("defer_foreign_keys = ON");
    for (const table of [...live]) db.prepare(`DELETE FROM ${quoted(table)}`).run();
    for (const table of tables) {
      const columns = columnsOf(backup, table).map(quoted).join(", ");
      const insert = db.prepare(`INSERT INTO ${quoted(table)} (${columns}) VALUES (${columnsOf(backup, table).map(() => "?").join(", ")})`);
      // Whole integers as they are: a BigInt comes through where a number would round.
      for (const row of backup.prepare(`SELECT ${columns} FROM ${quoted(table)}`).safeIntegers(true).raw().iterate()) {
        insert.run(...(row as unknown[]));
      }
    }
    // So an id used before the backup was taken is not handed out again.
    if (hasSequence(backup) && hasSequence(db)) {
      db.prepare("DELETE FROM sqlite_sequence").run();
      const put = db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)");
      for (const row of backup.prepare("SELECT name, seq FROM sqlite_sequence").safeIntegers(true).raw().iterate()) {
        put.run(...(row as unknown[]));
      }
    }
  })();
}

const undoFile = (target: RestoreTarget) => `${target.dbPath}.pre-restore`;
const undoMeta = (target: RestoreTarget) => `${undoFile(target)}.json`;

/** Replace the database with a backup. Returns whether the one replaced was kept. */
export function restoreDatabase(target: RestoreTarget, bytes: Buffer, fromVersion: string | null): { kept: boolean } {
  if (fromVersion && compareVersions(fromVersion, target.version) > 0) {
    throw new RestoreError(409, `That backup is from version ${fromVersion} and this container is ${target.version}. Update this container first.`);
  }
  const backup = openBackup(target, bytes);
  try {
    const keep = target.dbPath !== ":memory:";
    const replaced = keep ? target.db.serialize() : null;
    // Written first, under another name: a restore that fails leaves the copy kept
    // from the last one that worked.
    const pending = `${undoFile(target)}.tmp`;
    if (replaced) fs.writeFileSync(pending, replaced);
    try {
      replaceContents(target, backup);
    } catch (err) {
      fs.rmSync(pending, { force: true });
      throw err;
    }
    if (replaced) {
      fs.renameSync(pending, undoFile(target));
      fs.writeFileSync(undoMeta(target), JSON.stringify({ takenAt: new Date().toISOString(), version: target.version, bytes: replaced.length } satisfies UndoInfo));
    }
    return { kept: keep };
  } finally {
    backup.close();
  }
}

/** The copy a restore replaced, if one is kept. */
export function undoInfo(target: RestoreTarget): UndoInfo | null {
  if (target.dbPath === ":memory:" || !fs.existsSync(undoFile(target))) return null;
  try {
    return JSON.parse(fs.readFileSync(undoMeta(target), "utf8")) as UndoInfo;
  } catch {
    const stat = fs.statSync(undoFile(target));
    return { takenAt: stat.mtime.toISOString(), version: "", bytes: stat.size };
  }
}

/** Put that copy back. It is used up: undoing the undo is not on offer. */
export function undoRestore(target: RestoreTarget): void {
  if (!undoInfo(target)) throw new RestoreError(404, "There is no restore to undo.");
  const backup = openBackup(target, fs.readFileSync(undoFile(target)));
  try {
    replaceContents(target, backup);
  } finally {
    backup.close();
  }
  fs.rmSync(undoFile(target), { force: true });
  fs.rmSync(undoMeta(target), { force: true });
}
