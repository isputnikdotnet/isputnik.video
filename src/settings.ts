// The admin's choices the engine keeps (home's Control panel → Apps sets them
// through PUT /admin/conversion). One row per setting, its value JSON; a
// setting never saved, or one that no longer reads, is its default.
import { z } from "zod";
import type { Db } from "./db.js";
import { DEFAULT_CONVERSION, type ConversionSettings } from "./hls.js";

export const conversionSchema = z.object({
  memoryPerViewerMb: z.number().int().min(0).max(16_384),
  maxViewers: z.number().int().min(1).max(50),
  whenFull: z.enum(["disk", "wait"])
});

const CONVERSION_KEY = "conversion";

export function readConversion(db: Db): ConversionSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(CONVERSION_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_CONVERSION };
  try {
    return conversionSchema.parse({ ...DEFAULT_CONVERSION, ...(JSON.parse(row.value) as object) });
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
