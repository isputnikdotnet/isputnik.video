// Watching: which file an episode or movie plays from, whether a browser can play
// it as it is, and how far each person got (home's docs/apps-platform-plan.md →
// V2). Direct play only for now: a file the browser cannot play says so, and
// converting it on the fly (remux, transcode) comes later.
//
// Progress belongs to the person home says is asking (X-Isputnik-User-Id); it
// never reaches anyone else, and an item outside the person's libraries is not
// there for them, progress or not.
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
import { canSee, type Identity } from "./identity.js";
import { resolveInside } from "./media.js";

export type ItemType = "episode" | "movie";

/** Whether a browser plays the file as it is: "yes" for MP4 and WebM, "maybe"
 *  for Matroska and QuickTime (Chrome and Edge play most, with H.264 and AAC
 *  inside; Safari and Firefox fewer), "no" for the rest. */
export type DirectPlay = "yes" | "maybe" | "no";

const BROWSER_TYPES: Record<string, { mime: string; direct: DirectPlay }> = {
  ".mp4": { mime: "video/mp4", direct: "yes" },
  ".m4v": { mime: "video/mp4", direct: "yes" },
  ".webm": { mime: "video/webm", direct: "yes" },
  ".mkv": { mime: "video/x-matroska", direct: "maybe" },
  ".mov": { mime: "video/quicktime", direct: "maybe" }
};

export function browserPlayability(file: string): { mime: string; direct: DirectPlay } {
  return BROWSER_TYPES[path.extname(file).toLowerCase()] ?? { mime: "application/octet-stream", direct: "no" };
}

/** Watched once this much of it has played: the credits are not owed. */
export const WATCHED_FRACTION = 0.92;
/** Less than this in is a peek, not a place to come back to. */
export const RESUME_MIN_S = 30;

export interface Progress {
  position: number;
  duration: number | null;
  watched: boolean;
  updatedAt: string;
}

interface ProgressRow {
  item_id: string;
  item_type: ItemType;
  position_s: number;
  duration_s: number | null;
  watched: number;
  updated_at: string;
}

const toProgress = (row: ProgressRow): Progress => ({
  position: row.position_s,
  duration: row.duration_s,
  watched: row.watched === 1,
  updatedAt: row.updated_at
});

/** Where a watched item starts again: at the beginning. */
export function resumeAt(progress: Progress | null | undefined): number {
  if (!progress || progress.watched || progress.position < RESUME_MIN_S) return 0;
  return progress.position;
}

/** This person's progress for the given items. */
export function progressFor(db: Db, userId: string, ids: string[]): Map<string, Progress> {
  const found = new Map<string, Progress>();
  // SQLite's variable limit is far above a season; chunk anyway for a long show.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    if (chunk.length === 0) continue;
    const rows = db.prepare(`SELECT * FROM progress WHERE user_id = ? AND item_id IN (${chunk.map(() => "?").join(", ")})`)
      .all(userId, ...chunk) as ProgressRow[];
    for (const row of rows) found.set(row.item_id, toProgress(row));
  }
  return found;
}

// ── Items ───────────────────────────────────────────────────────────────────

export interface EpisodeRef {
  id: string;
  showId: string;
  season: number;
  episode: number;
  title: string | null;
}

export interface PlayableItem {
  id: string;
  type: ItemType;
  libraryId: string;
  title: string;
  runtimeMinutes: number | null;
  /** Episodes only: the show, and where in it. */
  show: { id: string; title: string } | null;
  season: number | null;
  episode: number | null;
  /** Relative to the media root. */
  relative: string;
}

/** An episode or movie this person may see, by id; null when it is not there for them. */
export function findItem(db: Db, identity: Identity, id: string): PlayableItem | null {
  const episode = db.prepare(`
    SELECT e.id, e.season, e.episode, e.title, e.file, e.runtime_minutes,
           s.id AS show_id, s.title AS show_title, s.folder AS show_folder,
           l.id AS library_id, l.folder AS library_folder
    FROM episodes e JOIN shows s ON s.id = e.show_id JOIN libraries l ON l.id = s.library_id
    WHERE e.id = ? AND l.state = 'active'
  `).get(id) as Record<string, unknown> | undefined;
  if (episode) {
    if (!canSee(identity, episode.library_id as string)) return null;
    const season = episode.season as number;
    const number = episode.episode as number;
    return {
      id: episode.id as string,
      type: "episode",
      libraryId: episode.library_id as string,
      title: (episode.title as string | null) ?? `S${String(season).padStart(2, "0")}E${String(number).padStart(2, "0")}`,
      runtimeMinutes: (episode.runtime_minutes as number | null) ?? null,
      show: { id: episode.show_id as string, title: episode.show_title as string },
      season,
      episode: number,
      relative: `${episode.library_folder}/${episode.show_folder}/${episode.file}`
    };
  }
  const movie = db.prepare(`
    SELECT m.id, m.title, m.folder, m.file, m.runtime_minutes, l.id AS library_id, l.folder AS library_folder
    FROM movies m JOIN libraries l ON l.id = m.library_id
    WHERE m.id = ? AND l.state = 'active'
  `).get(id) as Record<string, unknown> | undefined;
  if (!movie || !canSee(identity, movie.library_id as string)) return null;
  // A film in a folder of its own is folder/file; a loose one is the folder itself.
  const folder = movie.folder as string;
  const file = movie.file as string;
  return {
    id: movie.id as string,
    type: "movie",
    libraryId: movie.library_id as string,
    title: movie.title as string,
    runtimeMinutes: (movie.runtime_minutes as number | null) ?? null,
    show: null,
    season: null,
    episode: null,
    relative: folder === file ? `${movie.library_folder}/${file}` : `${movie.library_folder}/${folder}/${file}`
  };
}

/** The file on disk for an item, with its size; null when it has gone missing. */
export function fileOf(mediaRoot: string, item: PlayableItem): { absolute: string; size: number; modified: Date } | null {
  const absolute = resolveInside(mediaRoot, item.relative);
  if (!absolute) return null;
  try {
    const stat = fs.statSync(absolute);
    return stat.isFile() ? { absolute, size: stat.size, modified: stat.mtime } : null;
  } catch {
    return null;
  }
}

/** The episodes of a show in watching order. */
function episodesOf(db: Db, showId: string): EpisodeRef[] {
  return (db.prepare("SELECT id, show_id, season, episode, title FROM episodes WHERE show_id = ? ORDER BY season, episode, file").all(showId) as {
    id: string; show_id: string; season: number; episode: number; title: string | null;
  }[]).map((row) => ({ id: row.id, showId: row.show_id, season: row.season, episode: row.episode, title: row.title }));
}

/** The episode after this one, or null after the last. */
export function nextEpisode(db: Db, showId: string, episodeId: string): EpisodeRef | null {
  const list = episodesOf(db, showId);
  const at = list.findIndex((row) => row.id === episodeId);
  return at >= 0 && at + 1 < list.length ? list[at + 1] : null;
}

/** What to play when the person opens a show: the episode they are in the
 *  middle of, else the one after the last they watched, else the first. */
export function nextUp(db: Db, userId: string, showId: string): EpisodeRef | null {
  const list = episodesOf(db, showId);
  if (list.length === 0) return null;
  const progress = progressFor(db, userId, list.map((row) => row.id));
  let latest: { at: number; progress: Progress } | null = null;
  list.forEach((row, at) => {
    const seen = progress.get(row.id);
    if (seen && (!latest || seen.updatedAt > latest.progress.updatedAt)) latest = { at, progress: seen };
  });
  if (!latest) return list[0];
  const { at, progress: last } = latest as { at: number; progress: Progress };
  if (!last.watched) return list[at];
  // After the last one watched, the first not yet watched.
  for (let i = at + 1; i < list.length; i++) {
    if (!progress.get(list[i].id)?.watched) return list[i];
  }
  return null;
}

// ── Saving progress ─────────────────────────────────────────────────────────

export function saveProgress(
  db: Db,
  userId: string,
  item: Pick<PlayableItem, "id" | "type">,
  input: { position: number; duration: number | null; watched?: boolean }
): Progress {
  const duration = input.duration && input.duration > 0 ? input.duration : null;
  const position = Math.max(0, duration ? Math.min(input.position, duration) : input.position);
  const watched = input.watched ?? (duration !== null && position >= duration * WATCHED_FRACTION);
  db.prepare(`
    INSERT INTO progress (user_id, item_id, item_type, position_s, duration_s, watched, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT (user_id, item_id) DO UPDATE SET
      position_s = excluded.position_s,
      duration_s = COALESCE(excluded.duration_s, progress.duration_s),
      watched = excluded.watched,
      updated_at = excluded.updated_at
  `).run(userId, item.id, item.type, position, duration, watched ? 1 : 0);
  return progressFor(db, userId, [item.id]).get(item.id)!;
}

/** Progress whose episode or movie is gone; for the daily sweep. */
export function purgeOrphanProgress(db: Db): number {
  return db.prepare(`
    DELETE FROM progress WHERE
      (item_type = 'episode' AND item_id NOT IN (SELECT id FROM episodes)) OR
      (item_type = 'movie' AND item_id NOT IN (SELECT id FROM movies))
  `).run().changes;
}

// ── Continue watching ───────────────────────────────────────────────────────

export interface ContinueItem {
  id: string;
  type: ItemType;
  title: string;
  show: { id: string; title: string } | null;
  season: number | null;
  episode: number | null;
  /** Where it starts: 0 for the next episode of a show. */
  position: number;
  duration: number | null;
  /** false when this is the episode after one finished, not one left halfway. */
  resume: boolean;
  updatedAt: string;
}

/** For this person, newest first: films and episodes left halfway, and for a
 *  show whose latest episode was finished, the one after it. One per show. */
export function continueWatching(db: Db, identity: Identity, limit: number): ContinueItem[] {
  // rowid breaks a tie inside one millisecond: the row written last is newest.
  const rows = db.prepare("SELECT * FROM progress WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 400").all(identity.id) as ProgressRow[];
  const out: ContinueItem[] = [];
  const shows = new Set<string>();
  for (const row of rows) {
    if (out.length >= limit) break;
    const item = findItem(db, identity, row.item_id);
    if (!item) continue;
    const progress = toProgress(row);
    if (item.type === "movie") {
      if (progress.watched || progress.position < RESUME_MIN_S) continue;
      out.push({ ...entryOf(item), position: progress.position, duration: progress.duration, resume: true, updatedAt: progress.updatedAt });
      continue;
    }
    // A show counts once, by the episode watched most recently.
    if (shows.has(item.show!.id)) continue;
    shows.add(item.show!.id);
    if (!progress.watched) {
      if (progress.position < RESUME_MIN_S) continue;
      out.push({ ...entryOf(item), position: progress.position, duration: progress.duration, resume: true, updatedAt: progress.updatedAt });
      continue;
    }
    const next = nextUp(db, identity.id, item.show!.id);
    const nextItem = next ? findItem(db, identity, next.id) : null;
    if (!nextItem) continue;
    const nextProgress = progressFor(db, identity.id, [nextItem.id]).get(nextItem.id);
    const position = resumeAt(nextProgress);
    out.push({ ...entryOf(nextItem), position, duration: nextProgress?.duration ?? null, resume: position > 0, updatedAt: progress.updatedAt });
  }
  return out;
}

function entryOf(item: PlayableItem) {
  return { id: item.id, type: item.type, title: item.title, show: item.show, season: item.season, episode: item.episode };
}
