// Keyframes read ahead of the first play.
//
// A picture copied as it is can only be cut where its keyframes are, so the
// first play of such a title waits for them (media-probe.ts). An MP4 or MKV
// gives them up from its index in a moment; anything else — a Blu-ray folder's
// .m2ts, an .avi, an MKV without a usable index — is walked whole by ffprobe,
// minutes for a film on an array disk, and the player said "Getting it ready…"
// all that time. Here they are read after each scan and on start, one file at a
// time, films first: by the time someone presses Play they are kept already.
//
// Someone watching comes first: no new file is started while video is being
// converted for a viewer (one already being read finishes).
import type { Db } from "./db.js";
import type { MediaInfo } from "./ffmpeg.js";
import type { Identity } from "./identity.js";
import type { MediaProbe, ProbedFile } from "./media-probe.js";
import { fileOfAsync, findItem, type PlayableItem } from "./playback.js";

/** Sees every library: the engine's own work, not anyone's request. */
const ENGINE: Identity = { id: "engine", name: "engine", role: "admin", appRole: "manager", libraries: "all", lang: "en", theme: "", historyId: "engine", network: "home" };
/** How often a waiting pass looks again whether the viewers have gone. */
const VIEWER_POLL_MS = 15_000;

export interface KeyframeWarmerOptions {
  db: Db;
  mediaRoot: string;
  probe: MediaProbe;
  /** Whether a title plays with its picture copied as it is (so needs keyframes). */
  copiesPicture: (item: PlayableItem, info: MediaInfo) => boolean;
  /** Someone is watching converted video right now. */
  busy: () => boolean;
  log: { warn: (obj: object, msg: string) => void };
}

export class KeyframeWarmer {
  private chain: Promise<void> = Promise.resolve();
  private queued = false;

  constructor(private options: KeyframeWarmerOptions) {}

  /** A pass over every title, after the one going now; one waiting is enough. */
  queue(signal: AbortSignal): Promise<void> {
    if (this.queued) return this.chain;
    this.queued = true;
    this.chain = this.chain.then(async () => {
      this.queued = false;
      await this.run(signal);
    }).catch((err) => {
      if (!signal.aborted) this.options.log.warn({ err }, "Reading keyframes ahead failed");
    });
    return this.chain;
  }

  settled(): Promise<void> {
    return this.chain;
  }

  /** Every title in the active libraries: films (and their parts) first, by the
   *  ones watched lately, then episodes. Returns how many files were read. */
  async run(signal: AbortSignal): Promise<number> {
    const { db, mediaRoot, probe } = this.options;
    const ids = (db.prepare(`
      SELECT id FROM (
        SELECT m.id, 0 AS kind, m.sort_title AS sort FROM movies m JOIN libraries l ON l.id = m.library_id WHERE l.state = 'active'
        UNION ALL SELECT p.id, 0, m.sort_title FROM movie_parts p JOIN movies m ON m.id = p.movie_id JOIN libraries l ON l.id = m.library_id WHERE l.state = 'active'
        UNION ALL SELECT e.id, 1, s.sort_title FROM episodes e JOIN shows s ON s.id = e.show_id JOIN libraries l ON l.id = s.library_id WHERE l.state = 'active'
      ) t
      ORDER BY kind, (SELECT MAX(updated_at) FROM progress WHERE item_id = t.id) IS NULL, (SELECT MAX(updated_at) FROM progress WHERE item_id = t.id) DESC, sort
    `).all() as { id: string }[]).map((row) => row.id);
    let read = 0;
    for (const id of ids) {
      if (signal.aborted) break;
      const item = findItem(db, ENGINE, id);
      const file: ProbedFile | null = item ? await fileOfAsync(mediaRoot, item) : null;
      if (!item || !file || probe.hasKeyframes(id, file)) continue;
      await this.waitForViewers(signal);
      if (signal.aborted) break;
      try {
        const info = await probe.info(id, file);
        if (!info.video || !this.options.copiesPicture(item, info)) continue;
        await probe.keyframes(id, file);
        read += 1;
      } catch (err) {
        if (signal.aborted) break;
        // A file ffprobe can't read: the first play finds that out too, and says so.
        this.options.log.warn({ err, item: id }, "Could not read a video file's keyframes ahead");
      }
    }
    return read;
  }

  private async waitForViewers(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.options.busy()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, VIEWER_POLL_MS);
        timer.unref();
        signal.addEventListener("abort", done, { once: true });
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
      });
    }
  }
}
