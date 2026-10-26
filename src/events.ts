// The record of what happened, kept beside the catalog so the admin can read it
// from the home app without a shell on the host (Control panel → Apps → Events). Not
// the request log: that is pino on stdout, with the last lines kept in memory
// (log-buffer.ts). An event is something a person would ask about — a refused
// caller, a scan and what it found, a library home added or removed, a crash.
import type { Db } from "./db.js";

export type EventLevel = "info" | "warn" | "error";
export const EVENT_LEVELS: readonly EventLevel[] = ["info", "warn", "error"];

export interface EventInput {
  level: EventLevel;
  /** Dotted, category first: "gateway.rejected", "library.added", "scan.finished". */
  event: string;
  actorId?: string | null;
  actorName?: string | null;
  libraryId?: string | null;
  ip?: string | null;
  requestId?: string | null;
  detail?: string;
}

export interface EventRow {
  id: number;
  at: string;
  level: EventLevel;
  event: string;
  actorId: string | null;
  actorName: string | null;
  libraryId: string | null;
  ip: string | null;
  requestId: string | null;
  detail: string;
}

/** Days an event is kept: long enough to answer "what happened" after a holiday. */
export const EVENT_RETENTION_DAYS = 90;

/** How long a detail may run: a message, not a dump. */
const DETAIL_MAX = 500;

export function recordEvent(db: Db, input: EventInput): void {
  db.prepare(`
    INSERT INTO events (level, event, actor_id, actor_name, library_id, ip, request_id, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.level,
    input.event,
    input.actorId ?? null,
    input.actorName ?? null,
    input.libraryId ?? null,
    input.ip ?? null,
    input.requestId ?? null,
    (input.detail ?? "").slice(0, DETAIL_MAX)
  );
}

export interface EventQuery {
  level?: EventLevel | null;
  /** A category ("scan") lists everything under it; a full name ("scan.finished") exactly that. */
  event?: string | null;
  page: number;
  pageSize: number;
}

export interface EventPage {
  events: EventRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** Every event name on record, for a filter list. */
  facets: { event: string[] };
}

interface RawRow {
  id: number;
  at: string;
  level: EventLevel;
  event: string;
  actor_id: string | null;
  actor_name: string | null;
  library_id: string | null;
  ip: string | null;
  request_id: string | null;
  detail: string;
}

export function listEvents(db: Db, query: EventQuery): EventPage {
  const conditions: string[] = [];
  const params: Record<string, string | number> = {};
  if (query.level) {
    conditions.push("level = @level");
    params.level = query.level;
  }
  if (query.event) {
    if (query.event.includes(".")) {
      conditions.push("event = @event");
      params.event = query.event;
    } else {
      conditions.push("event LIKE @event");
      params.event = `${query.event}.%`;
    }
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM events ${where}`).get(params) as { count: number }).count;
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(Math.max(1, query.page), totalPages);
  const rows = db.prepare(`
    SELECT * FROM events ${where}
    ORDER BY at DESC, id DESC
    LIMIT @pageSize OFFSET @offset
  `).all({ ...params, pageSize: query.pageSize, offset: (page - 1) * query.pageSize }) as RawRow[];
  const facets = (db.prepare("SELECT DISTINCT event FROM events ORDER BY event").all() as { event: string }[]).map((row) => row.event);
  return {
    events: rows.map((row) => ({
      id: row.id,
      at: row.at,
      level: row.level,
      event: row.event,
      actorId: row.actor_id,
      actorName: row.actor_name,
      libraryId: row.library_id,
      ip: row.ip,
      requestId: row.request_id,
      detail: row.detail
    })),
    total,
    page,
    pageSize: query.pageSize,
    totalPages,
    facets: { event: facets }
  };
}

/** How many times `event` was recorded in the last `hours`. */
export function countEventsSince(db: Db, event: string, hours: number): number {
  return (db.prepare(
    "SELECT COUNT(*) AS count FROM events WHERE event = ? AND at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)"
  ).get(event, `-${hours} hours`) as { count: number }).count;
}

export function pruneEvents(db: Db, days = EVENT_RETENTION_DAYS): number {
  return db.prepare("DELETE FROM events WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)").run(`-${days} days`).changes;
}
