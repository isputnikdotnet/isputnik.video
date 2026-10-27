// ffprobe's answers kept per item (schema.sql → media_probe): the streams read
// on the first play, the keyframes on the first play that needs them. A file
// replaced on disk (new size or date) is probed again. Two requests for the same
// file while one probe runs share it.
import type { Db } from "./db.js";
import { keyframes, probe, type MediaInfo, type Tools } from "./ffmpeg.js";

interface ProbeRow {
  size: number;
  modified_ms: number;
  info: string;
  keyframes: string | null;
}

export interface ProbedFile {
  absolute: string;
  size: number;
  modified: Date;
}

export class MediaProbe {
  private running = new Map<string, Promise<unknown>>();

  constructor(private db: Db, private tools: Tools) {}

  private row(itemId: string, file: ProbedFile): ProbeRow | null {
    const row = this.db.prepare("SELECT size, modified_ms, info, keyframes FROM media_probe WHERE item_id = ?").get(itemId) as ProbeRow | undefined;
    return row && row.size === file.size && row.modified_ms === file.modified.getTime() ? row : null;
  }

  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const running = this.running.get(key);
    if (running) return running as Promise<T>;
    const promise = work().finally(() => this.running.delete(key));
    this.running.set(key, promise);
    return promise;
  }

  info(itemId: string, file: ProbedFile): Promise<MediaInfo> {
    const cached = this.row(itemId, file);
    const known = cached ? (JSON.parse(cached.info) as MediaInfo) : null;
    // A probe from before 0.6.0 kept no subtitles: read again, once.
    if (known && Array.isArray(known.subtitles)) return Promise.resolve(known);
    return this.once(`info:${itemId}`, async () => {
      const info = await probe(this.tools, file.absolute);
      this.db.prepare(`
        INSERT INTO media_probe (item_id, size, modified_ms, info, keyframes) VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT (item_id) DO UPDATE SET size = excluded.size, modified_ms = excluded.modified_ms,
          info = excluded.info, keyframes = NULL, probed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      `).run(itemId, file.size, file.modified.getTime(), JSON.stringify(info));
      return info;
    });
  }

  async keyframes(itemId: string, file: ProbedFile): Promise<number[]> {
    await this.info(itemId, file);
    const cached = this.row(itemId, file);
    if (cached?.keyframes) return JSON.parse(cached.keyframes) as number[];
    return this.once(`keyframes:${itemId}`, async () => {
      const times = await keyframes(this.tools, file.absolute);
      this.db.prepare("UPDATE media_probe SET keyframes = ? WHERE item_id = ?").run(JSON.stringify(times), itemId);
      return times;
    });
  }
}

/** Rows whose episode or movie is gone; for the daily sweep. */
export function purgeOrphanProbes(db: Db): number {
  return db.prepare(`
    DELETE FROM media_probe WHERE item_id NOT IN (SELECT id FROM episodes) AND item_id NOT IN (SELECT id FROM movies)
  `).run().changes;
}
