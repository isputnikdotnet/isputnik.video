// How much the engine logs, for a while (home's docs/diagnostic-logging-plan.md):
// Normal, or Detailed / Everything for 15 minutes, an hour or 4 hours, then back
// to Normal by itself. An admin turns it on from home's Diagnostics page to
// reproduce a problem; home's report then carries every line, not only the
// problems. The same contract as home's own (GET/PUT /admin/logging).
//
// Normal is LOG_LEVEL (info unless set). The choice and its end are kept in the
// settings table, so a restart keeps a level that hasn't run out. The log buffer
// grows from 500 lines to 2000 while it is on.
import type { Db } from "./db.js";
import type { LogBuffer } from "./log-buffer.js";

export type LoggingLevel = "normal" | "detailed" | "everything";
export const LOGGING_MINUTES = [15, 60, 240] as const;
const PINO: Record<Exclude<LoggingLevel, "normal">, string> = { detailed: "debug", everything: "trace" };
const KEY = "logging";
const NORMAL_LINES = 500;
const DETAILED_LINES = 2000;
/** The report carries every line for this long after a detailed level ends. */
const AFTER_MS = 60 * 60_000;

export interface LoggingState {
  level: LoggingLevel;
  until: string | null;
  normal: string;
  minutes: readonly number[];
  endedAt: string | null;
}

interface Stored { level: LoggingLevel; until: string | null }

export interface Logging {
  state(): LoggingState;
  set(level: LoggingLevel, minutes: number | null): LoggingState;
  /** A detailed level is on, or ended within the hour. */
  detailed(now?: number): boolean;
  close(): void;
}

export function createLogging(options: {
  db: Db;
  /** Whose level changes: the app's logger, which every request's is made from. */
  logger: { level: string; info(obj: object, msg: string): void };
  buffer?: LogBuffer;
  normal?: string;
}): Logging {
  const { db, logger, buffer } = options;
  const normal = options.normal ?? (process.env.LOG_LEVEL?.trim() || "info");
  let timer: NodeJS.Timeout | null = null;
  let endedAt: string | null = null;

  const read = (): Stored => {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    try {
      const value = row ? (JSON.parse(row.value) as Stored) : null;
      if (value && value.level !== "normal" && value.until && Date.parse(value.until) > Date.now()) return value;
    } catch {
      // Unreadable: Normal.
    }
    return { level: "normal", until: null };
  };
  const write = (value: Stored) => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(value));
  };

  const apply = () => {
    const stored = read();
    if (timer) clearTimeout(timer);
    timer = null;
    logger.level = stored.level === "normal" ? normal : PINO[stored.level];
    buffer?.resize(stored.level === "normal" ? NORMAL_LINES : DETAILED_LINES);
    if (stored.until) {
      timer = setTimeout(() => {
        endedAt = new Date().toISOString();
        write({ level: "normal", until: null });
        apply();
        logger.info({}, "Logging back to Normal");
      }, Math.max(0, Date.parse(stored.until) - Date.now()));
      timer.unref();
    }
  };

  const state = (): LoggingState => ({ ...read(), normal, minutes: LOGGING_MINUTES, endedAt });

  apply();
  return {
    state,
    set(level, minutes) {
      const before = read();
      if (level === "normal") {
        if (before.level !== "normal") endedAt = new Date().toISOString();
        write({ level: "normal", until: null });
      } else {
        const length = LOGGING_MINUTES.includes(minutes as (typeof LOGGING_MINUTES)[number]) ? minutes! : 60;
        write({ level, until: new Date(Date.now() + length * 60_000).toISOString() });
      }
      apply();
      return state();
    },
    detailed(now = Date.now()) {
      if (read().level !== "normal") return true;
      return endedAt !== null && now - Date.parse(endedAt) < AFTER_MS;
    },
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}
