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
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .run(CONVERSION_KEY, JSON.stringify(settings));
}
