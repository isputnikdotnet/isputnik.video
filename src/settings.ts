// The admin's choices the engine keeps (home's Control panel → Apps sets them
// through PUT /admin/conversion). One row per setting, its value JSON; a
// setting never saved, or one that no longer reads, is its default.
import { z } from "zod";
import type { Db } from "./db.js";
import { DEFAULT_CONVERSION, MEMORY_MAX_MB, MEMORY_MIN_MB, fromLegacy, legacyOf, type ConversionSettings } from "./hls.js";
import { DEFAULT_COPIES, copySettingsSchema, type CopySettings } from "./copies.js";

export const conversionSchema = z.object({
  storage: z.enum(["memory", "memory-disk", "disk"]),
  memoryMb: z.number().int().min(MEMORY_MIN_MB).max(MEMORY_MAX_MB),
  maxViewers: z.number().int().min(1).max(50),
  hardware: z.enum(["auto", "cpu", "gpu"]),
  remoteQuality: z.union([z.literal(1080), z.literal(720), z.literal(480)]).nullable()
});

/** What engines before 0.35 had, and a home of then still sends. */
const legacySchema = z.object({
  memoryPerViewerMb: z.number().int().min(0).max(MEMORY_MAX_MB),
  whenFull: z.enum(["disk", "wait"])
}).partial();

/** `patch` over `current`. A patch in the old words (a home from before 0.35,
 *  or a row saved then) that says something else than the new settings
 *  amount to is taken in the old words; one that only repeats them is not
 *  (home's new page sends the new words alone). */
export function mergeConversion(current: ConversionSettings, patch: unknown): ConversionSettings {
  const body = patch && typeof patch === "object" ? patch as Record<string, unknown> : {};
  const merged = conversionSchema.parse({ ...current, ...body });
  const legacy = legacySchema.parse({ memoryPerViewerMb: body.memoryPerViewerMb, whenFull: body.whenFull });
  const was = legacyOf(merged);
  const asked = { memoryPerViewerMb: legacy.memoryPerViewerMb ?? was.memoryPerViewerMb, whenFull: legacy.whenFull ?? was.whenFull };
  if (asked.memoryPerViewerMb === was.memoryPerViewerMb && asked.whenFull === was.whenFull) return merged;
  return { ...merged, ...fromLegacy(asked, merged.maxViewers, merged.memoryMb) };
}

const CONVERSION_KEY = "conversion";

export function readConversion(db: Db): ConversionSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(CONVERSION_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_CONVERSION };
  try {
    return mergeConversion(DEFAULT_CONVERSION, JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_CONVERSION };
  }
}

export function saveConversion(db: Db, settings: ConversionSettings): void {
  save(db, CONVERSION_KEY, settings);
}

function save(db: Db, key: string, value: unknown): void {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .run(key, JSON.stringify(value));
}

// Copies kept for download (copies.ts): how much room they may take together.
const COPIES_KEY = "copies";

export function readCopies(db: Db): CopySettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(COPIES_KEY) as { value: string } | undefined;
  try {
    return row ? copySettingsSchema.parse({ ...DEFAULT_COPIES, ...(JSON.parse(row.value) as object) }) : { ...DEFAULT_COPIES };
  } catch {
    return { ...DEFAULT_COPIES };
  }
}

export function saveCopies(db: Db, settings: CopySettings): void {
  save(db, COPIES_KEY, settings);
}

// Finding intros, recaps and credits by itself (detect.ts): on unless the admin
// turned it off on home's Settings → Video. It reads every episode's sound and
// picture once, which a small server may rather not spend.
export const detectionSchema = z.object({ enabled: z.boolean() });
export type DetectionSettings = z.infer<typeof detectionSchema>;

const DETECTION_KEY = "detection";

export function readDetection(db: Db): DetectionSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(DETECTION_KEY) as { value: string } | undefined;
  try {
    return row ? detectionSchema.parse(JSON.parse(row.value)) : { enabled: true };
  } catch {
    return { enabled: true };
  }
}

export function saveDetection(db: Db, settings: DetectionSettings): void {
  save(db, DETECTION_KEY, settings);
}
