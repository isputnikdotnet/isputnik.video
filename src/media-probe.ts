// ffprobe's answers kept per item (schema.sql → media_probe): the streams read
// on the first play, the keyframes on the first play that needs them. A file
// replaced on disk (new size or date) is probed again. Two requests for the same
// file while one probe runs share it. An MP4 gives up its keyframes from its
// header (mp4-index.ts), a Matroska file from its Cues (mkv-index.ts); every
// other file, and one whose index won't do, is walked by ffprobe.
import type { Db } from "./db.js";
import { keyframes, probe, type MediaInfo, type Tools } from "./ffmpeg.js";
import { mkvKeyframes } from "./mkv-index.js";
import { mp4Keyframes } from "./mp4-index.js";

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

const isMp4 = (container: string) => /(^|,)(mov|mp4)(,|$)/.test(container);
const isMatroska = (container: string) => /(^|,)(matroska|webm)(,|$)/.test(container);

export class MediaProbe {
  private running = new Map<string, Promise<unknown>>();
  /** Stops a walk of a whole file when the engine closes: a 30 GB film takes minutes. */
  private stop = new AbortController();

  constructor(private db: Db, private tools: Tools) {}

  private row(itemId: string, file: ProbedFile): ProbeRow | null {
    const row = this.db.prepare("SELECT size, modified_ms, info, keyframes FROM media_probe WHERE item_id = ?").get(itemId) as ProbeRow | undefined;
    return row && row.size === file.size && row.modified_ms === file.modified.getTime() ? row : null;
  }

  /** Once every probe running now has finished: closing waits, so no ffprobe is
   *  left holding a file (which Windows then can't delete). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  /** Stops what is walking a whole file, then waits for the rest. */
  async close(): Promise<void> {
    this.stop.abort();
    await this.idle();
  }

  /** Whether the keyframes of this file are kept already (no probe is run). */
  hasKeyframes(itemId: string, file: ProbedFile): boolean {
    return Boolean(this.row(itemId, file)?.keyframes);
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
    // A probe from before 0.6.0 kept no subtitles, one before 0.12.0 no chapters,
    // one before 0.25.0 no colour (so no HDR), one before 0.31.0 no bitrate (so no
    // quality rung): read again, once.
    const fresh = known && Array.isArray(known.subtitles) && Array.isArray(known.chapters) && (!known.video || "colorTransfer" in known.video)
      && "bitRate" in known;
    if (known && fresh) return Promise.resolve(known);
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
    const info = await this.info(itemId, file);
    const cached = this.row(itemId, file);
    if (cached?.keyframes) return JSON.parse(cached.keyframes) as number[];
    return this.once(`keyframes:${itemId}`, async () => {
      const fromHeader = !info.video ? null
        : isMp4(info.container) ? await mp4Keyframes(file.absolute, info.video).catch(() => null)
        : isMatroska(info.container) ? await mkvKeyframes(file.absolute, { start: info.start, duration: info.duration, video: info.video }).catch(() => null)
        : null;
      const times = fromHeader ?? await keyframes(this.tools, file.absolute, this.stop.signal);
      this.db.prepare("UPDATE media_probe SET keyframes = ? WHERE item_id = ?").run(JSON.stringify(times), itemId);
      return times;
    });
  }
}

/** Rows whose episode or movie is gone; for the daily sweep. */
export function purgeOrphanProbes(db: Db): number {
  return db.prepare(`
    DELETE FROM media_probe WHERE item_id NOT IN (SELECT id FROM episodes) AND item_id NOT IN (SELECT id FROM movies) AND item_id NOT IN (SELECT id FROM movie_parts)
  `).run().changes;
}
