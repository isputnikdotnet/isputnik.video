// What the family sees on a card besides a title: a poster, a backdrop, a
// description, episode stills (home's docs/apps-platform-plan.md → V1).
//
// Kept apart from what the scan writes (shows, episodes, movies), so a rescan
// never undoes it and a match the admin fixed by hand stays fixed:
//
// - Art beside the files wins — poster.jpg, fanart.jpg, "<film>-poster.jpg",
//   "<episode>-thumb.jpg", as Kodi, Jellyfin and Plex leave them. Looked for
//   on every pass; reading a folder costs nothing.
// - Then TMDB, when the admin has given a key: matched by the TMDB id in the
//   .nfo or the folder name, else by the IMDb id, else by searching the title
//   and year. Its words fill what the .nfo left empty, never replace it; its
//   images are kept in the art folder (ART_PATH, the image's /config/art) —
//   not in the backup, since they can always be fetched again.
//
// A match is checked again after a month, a miss after a week, a failure on the
// next pass. One library at a time, one request at a time: TMDB is generous,
// but a first pass over a large library is still thousands of requests.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Db } from "./db.js";
import { resolveInside } from "./media.js";
import { IMAGE_SIZES, Tmdb, TmdbError, type Fetch, type TmdbKind } from "./tmdb.js";

export type MetaKind = "show" | "movie" | "episode";
export type ArtKind = "poster" | "backdrop" | "still";
type TmdbState = "none" | "matched" | "unmatched" | "error";

export interface MetaRow {
  item_id: string;
  kind: MetaKind;
  tmdb_id: string | null;
  locked: number;
  tmdb_state: TmdbState;
  title: string | null;
  original_title: string | null;
  plot: string | null;
  year: number | null;
  aired: string | null;
  genres: string;
  rating: number | null;
  status: string | null;
  poster: string | null;
  backdrop: string | null;
  still: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  still_path: string | null;
  checked_at: string | null;
  error: string | null;
}

const DAY = 24 * 60 * 60 * 1000;
const RECHECK_MATCHED = 30 * DAY;
const RECHECK_UNMATCHED = 7 * DAY;
/** Between two requests to TMDB. */
const PAUSE_MS = 60;

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const POSTER_NAMES = ["poster", "folder", "cover", "show", "movie"];
const BACKDROP_NAMES = ["fanart", "backdrop", "background", "landscape"];

// ── The admin's key ────────────────────────────────────────────────────────

const TMDB_KEY = "tmdb";
export const tmdbKeySchema = z.string().trim().regex(/^[A-Za-z0-9._-]{20,400}$/);

export function readTmdbKey(db: Db): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(TMDB_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { key?: unknown };
    return typeof parsed.key === "string" && tmdbKeySchema.safeParse(parsed.key).success ? parsed.key : null;
  } catch {
    return null;
  }
}

export function saveTmdbKey(db: Db, key: string | null): void {
  if (!key) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(TMDB_KEY);
    return;
  }
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .run(TMDB_KEY, JSON.stringify({ key }));
}

/** The last four characters, for the admin to tell keys apart; never the key. */
export const keyHint = (key: string | null) => (key ? `…${key.slice(-4)}` : null);

// ── Reading it back, for the catalog ───────────────────────────────────────

export function metaFor(db: Db, ids: string[]): Map<string, MetaRow> {
  const found = new Map<string, MetaRow>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    if (chunk.length === 0) continue;
    const rows = db.prepare(`SELECT * FROM metadata WHERE item_id IN (${chunk.map(() => "?").join(", ")})`).all(...chunk) as MetaRow[];
    for (const row of rows) found.set(row.item_id, row);
  }
  return found;
}

export const metaGenres = (row: MetaRow | undefined): string[] => {
  try {
    const parsed = JSON.parse(row?.genres ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
};

/** Where an item's picture is served, with a version so a new one isn't cached as the old; null for none. */
export function artUrl(api: string, row: MetaRow | undefined, kind: ArtKind): string | null {
  const source = row?.[kind];
  if (!row || !source) return null;
  const version = crypto.createHash("sha1").update(source).digest("hex").slice(0, 8);
  return `${api}/art/${row.item_id}/${kind}?v=${version}`;
}

/** The file behind an item's picture: beside the video, or in the art folder. */
export function artFile(row: MetaRow | undefined, kind: ArtKind, mediaRoot: string, artDir: string): string | null {
  const source = row?.[kind];
  if (!source) return null;
  if (source.startsWith("local:")) return resolveInside(mediaRoot, source.slice(6));
  if (source.startsWith("cache:")) {
    const name = source.slice(6);
    if (!/^[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(name)) return null;
    const file = path.join(artDir, name);
    return fs.existsSync(file) ? file : null;
  }
  return null;
}

// ── The pass ───────────────────────────────────────────────────────────────

export interface MetadataContext {
  db: Db;
  mediaRoot: string;
  artDir: string;
  fetch?: Fetch;
  log: { warn(obj: object, msg: string): void };
}

export interface MetadataSummary {
  titles: number;
  matched: number;
  unmatched: number;
  failed: number;
  /** Titles with a poster, from beside the files or from TMDB. */
  posters: number;
  /** The first failure, for the event. */
  error: string | null;
}

interface Library { id: string; kind: "shows" | "movies"; folder: string; language: string }
interface TitleRow { id: string; folder: string; file?: string; title: string; original_title: string | null; year: number | null; imdb_id: string | null; tmdb_id: string | null }
interface EpisodeRow { id: string; season: number; episode: number; file: string }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const posix = (...parts: string[]) => parts.filter(Boolean).join("/");

/** The first image in `dir` named one of `names` (any case, any image extension). */
function findImage(mediaRoot: string, dir: string, names: string[]): string | null {
  const absolute = resolveInside(mediaRoot, dir);
  if (!absolute) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(absolute);
  } catch {
    return null;
  }
  for (const name of names) {
    const hit = entries.find((entry) => {
      const ext = path.extname(entry).toLowerCase();
      return IMAGE_EXTENSIONS.includes(ext) && entry.slice(0, -ext.length).toLowerCase() === name.toLowerCase();
    });
    if (hit) return `local:${posix(dir, hit)}`;
  }
  return null;
}

function emptyRow(itemId: string, kind: MetaKind): MetaRow {
  return {
    item_id: itemId, kind, tmdb_id: null, locked: 0, tmdb_state: "none", title: null, original_title: null, plot: null,
    year: null, aired: null, genres: "[]", rating: null, status: null, poster: null, backdrop: null, still: null,
    poster_path: null, backdrop_path: null, still_path: null, checked_at: null, error: null
  };
}

function saveRow(db: Db, row: MetaRow): void {
  db.prepare(`
    INSERT INTO metadata (item_id, kind, tmdb_id, locked, tmdb_state, title, original_title, plot, year, aired, genres, rating, status,
      poster, backdrop, still, poster_path, backdrop_path, still_path, checked_at, error)
    VALUES (@item_id, @kind, @tmdb_id, @locked, @tmdb_state, @title, @original_title, @plot, @year, @aired, @genres, @rating, @status,
      @poster, @backdrop, @still, @poster_path, @backdrop_path, @still_path, @checked_at, @error)
    ON CONFLICT (item_id) DO UPDATE SET kind = excluded.kind, tmdb_id = excluded.tmdb_id, locked = excluded.locked,
      tmdb_state = excluded.tmdb_state, title = excluded.title, original_title = excluded.original_title, plot = excluded.plot,
      year = excluded.year, aired = excluded.aired, genres = excluded.genres, rating = excluded.rating, status = excluded.status,
      poster = excluded.poster, backdrop = excluded.backdrop, still = excluded.still, poster_path = excluded.poster_path,
      backdrop_path = excluded.backdrop_path, still_path = excluded.still_path, checked_at = excluded.checked_at, error = excluded.error,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(row);
}

/** Whether TMDB should be asked about this title again. */
function due(row: MetaRow | undefined, now: number, force: boolean): boolean {
  if (force || !row || !row.checked_at) return true;
  const age = now - Date.parse(row.checked_at);
  switch (row.tmdb_state) {
    case "none":
    case "error":
      return true;
    case "unmatched":
      return age > RECHECK_UNMATCHED;
    case "matched":
      return age > RECHECK_MATCHED;
  }
}

export class MetadataRunner {
  constructor(private ctx: MetadataContext) {}

  private tmdb(): Tmdb | null {
    const key = readTmdbKey(this.ctx.db);
    return key ? new Tmdb(key, this.ctx.fetch) : null;
  }

  /** A TMDB image into the art folder, named after what it shows; the old one goes. */
  private async download(tmdb: Tmdb, imagePath: string, size: string, name: string, previous: string | null): Promise<string> {
    const bytes = await tmdb.image(imagePath, size);
    await sleep(PAUSE_MS);
    fs.mkdirSync(this.ctx.artDir, { recursive: true });
    const file = `${name}${path.extname(imagePath).toLowerCase()}`;
    fs.writeFileSync(path.join(this.ctx.artDir, file), bytes);
    if (previous?.startsWith("cache:") && previous.slice(6) !== file) fs.rmSync(path.join(this.ctx.artDir, previous.slice(6)), { force: true });
    return `cache:${file}`;
  }

  /** The picture to show: one beside the files, else TMDB's (fetched if it isn't here yet), else none. */
  private async pick(tmdb: Tmdb | null, row: MetaRow, kind: ArtKind, local: string | null, imagePath: string | null): Promise<string | null> {
    if (local) return local;
    const current = row[kind];
    const pathColumn = `${kind}_path` as const;
    const cached = current?.startsWith("cache:") && artFile(row, kind, this.ctx.mediaRoot, this.ctx.artDir) ? current : null;
    if (!imagePath) return null;
    if (cached && row[pathColumn] === imagePath) return cached;
    if (!tmdb) return cached;
    const size = kind === "poster" ? IMAGE_SIZES.poster : kind === "backdrop" ? IMAGE_SIZES.backdrop : IMAGE_SIZES.still;
    return this.download(tmdb, imagePath, size, `${row.item_id}-${kind}`, current);
  }

  /** The TMDB id for a title: the one fixed by hand, the .nfo's or folder's, the IMDb id's, else the best search hit. */
  private async match(tmdb: Tmdb, kind: TmdbKind, title: TitleRow, row: MetaRow, language: string): Promise<string | null> {
    if (row.locked && row.tmdb_id) return row.tmdb_id;
    if (title.tmdb_id) return title.tmdb_id;
    if (title.imdb_id) {
      const found = await tmdb.findByImdb(kind, title.imdb_id);
      await sleep(PAUSE_MS);
      if (found) return found;
    }
    for (const query of [title.title, title.original_title].filter((value, at, all): value is string => Boolean(value) && all.indexOf(value) === at)) {
      for (const year of title.year ? [title.year, null] : [null]) {
        const results = await tmdb.search(kind, query, year, language);
        await sleep(PAUSE_MS);
        // With a year, one within a year of it (release dates differ by country); without, the first.
        const hit = title.year ? results.find((result) => result.year !== null && Math.abs(result.year - title.year!) <= 1) : results[0];
        if (hit) return hit.tmdbId;
      }
    }
    return null;
  }

  /** One show or movie: its art beside the files, and TMDB when it is due. */
  private async refreshTitle(tmdb: Tmdb | null, library: Library, title: TitleRow, episodes: EpisodeRow[], force: boolean, summary: MetadataSummary): Promise<void> {
    const { db, mediaRoot } = this.ctx;
    const kind: MetaKind = library.kind === "shows" ? "show" : "movie";
    const tmdbKind: TmdbKind = kind === "show" ? "tv" : "movie";
    const existing = metaFor(db, [title.id, ...episodes.map((episode) => episode.id)]);
    const row: MetaRow = { ...(existing.get(title.id) ?? emptyRow(title.id, kind)), kind };

    // Beside the files: the title's own folder; a loose film, its own name in the library folder.
    const loose = kind === "movie" && title.folder === title.file;
    const dir = loose ? library.folder : posix(library.folder, title.folder);
    const stem = title.file ? path.basename(title.file, path.extname(title.file)) : null;
    const ownNames = (suffixes: string[]) => (stem ? suffixes.map((suffix) => `${stem}-${suffix}`) : []);
    const localPoster = findImage(mediaRoot, dir, loose ? [...ownNames(["poster"]), stem!] : [...ownNames(["poster"]), ...POSTER_NAMES]);
    const localBackdrop = findImage(mediaRoot, dir, loose ? ownNames(["fanart", "backdrop"]) : [...ownNames(["fanart", "backdrop"]), ...BACKDROP_NAMES]);

    const now = Date.now();
    let details: Awaited<ReturnType<Tmdb["details"]>> | null = null;
    const seasons = new Map<number, Awaited<ReturnType<Tmdb["season"]>>>();
    const missingEpisode = episodes.some((episode) => !existing.has(episode.id));
    if (tmdb && (due(row, now, force) || (kind === "show" && missingEpisode && row.tmdb_state === "matched"))) {
      try {
        const id = await this.match(tmdb, tmdbKind, title, row, library.language);
        if (id) {
          details = await tmdb.details(tmdbKind, id, library.language);
          await sleep(PAUSE_MS);
          for (const season of [...new Set(episodes.map((episode) => episode.season))]) {
            seasons.set(season, await tmdb.season(id, season, library.language));
            await sleep(PAUSE_MS);
          }
          Object.assign(row, {
            tmdb_id: details.tmdbId, tmdb_state: "matched", title: details.title, original_title: details.originalTitle, plot: details.plot,
            year: details.year, aired: details.aired, genres: JSON.stringify(details.genres), rating: details.rating, status: details.status,
            poster_path: details.posterPath, backdrop_path: details.backdropPath, error: null
          });
        } else {
          Object.assign(row, { tmdb_state: "unmatched", error: null });
        }
      } catch (err) {
        const message = err instanceof TmdbError ? err.message : (err as Error).message;
        Object.assign(row, { tmdb_state: "error", error: message });
        summary.error ??= `${title.title}: ${message}`;
        this.ctx.log.warn({ err, item: title.id }, "TMDB lookup failed");
        // A refused key fails every title the same way: stop asking.
        if (err instanceof TmdbError && err.status === 401) throw err;
      }
      row.checked_at = new Date(now).toISOString();
    } else if (!tmdb && !row.checked_at) {
      row.checked_at = new Date(now).toISOString();
    }

    try {
      row.poster = await this.pick(tmdb, row, "poster", localPoster, row.poster_path);
      row.backdrop = await this.pick(tmdb, row, "backdrop", localBackdrop, row.backdrop_path);
    } catch (err) {
      summary.error ??= `${title.title}: ${(err as Error).message}`;
    }
    saveRow(db, row);
    if (row.tmdb_state === "matched") summary.matched += 1;
    else if (row.tmdb_state === "unmatched") summary.unmatched += 1;
    else if (row.tmdb_state === "error") summary.failed += 1;
    if (row.poster) summary.posters += 1;

    // Each episode: its thumb beside it, else TMDB's still; TMDB's words where the scan had none.
    for (const episode of episodes) {
      const own: MetaRow = { ...(existing.get(episode.id) ?? emptyRow(episode.id, "episode")), kind: "episode" };
      const fromTmdb = seasons.get(episode.season)?.find((entry) => entry.episode === episode.episode);
      if (fromTmdb) {
        Object.assign(own, { tmdb_state: "matched", title: fromTmdb.title, plot: fromTmdb.plot, aired: fromTmdb.aired, still_path: fromTmdb.stillPath });
      } else if (seasons.size > 0) {
        own.tmdb_state = "unmatched";
      }
      const episodeDir = path.posix.dirname(posix(dir, episode.file));
      const episodeStem = path.basename(episode.file, path.extname(episode.file));
      const localThumb = findImage(mediaRoot, episodeDir, [`${episodeStem}-thumb`, episodeStem]);
      try {
        own.still = await this.pick(tmdb, own, "still", localThumb, own.still_path);
      } catch (err) {
        summary.error ??= `${title.title} S${episode.season}E${episode.episode}: ${(err as Error).message}`;
      }
      own.checked_at ??= new Date(now).toISOString();
      saveRow(db, own);
    }
  }

  /** Every title of a library; `force` asks TMDB again even where it isn't due. */
  async refreshLibrary(libraryId: string, force = false): Promise<MetadataSummary | null> {
    const { db } = this.ctx;
    const library = db.prepare("SELECT id, kind, folder, language FROM libraries WHERE id = ? AND state = 'active'").get(libraryId) as Library | undefined;
    if (!library) return null;
    const tmdb = this.tmdb();
    const summary: MetadataSummary = { titles: 0, matched: 0, unmatched: 0, failed: 0, posters: 0, error: null };
    const titles = library.kind === "shows"
      ? db.prepare("SELECT id, folder, NULL AS file, title, original_title, year, imdb_id, tmdb_id FROM shows WHERE library_id = ? ORDER BY sort_title").all(library.id) as TitleRow[]
      : db.prepare("SELECT id, folder, file, title, original_title, year, imdb_id, tmdb_id FROM movies WHERE library_id = ? ORDER BY sort_title").all(library.id) as TitleRow[];
    for (const title of titles) {
      const episodes = library.kind === "shows"
        ? db.prepare("SELECT id, season, episode, file FROM episodes WHERE show_id = ? ORDER BY season, episode").all(title.id) as EpisodeRow[]
        : [];
      summary.titles += 1;
      try {
        await this.refreshTitle(tmdb, library, { ...title, file: title.file ?? undefined }, episodes, force, summary);
      } catch (err) {
        if (err instanceof TmdbError && err.status === 401) {
          summary.error = "TMDB refused the key; nothing more was asked";
          break;
        }
        throw err;
      }
    }
    return summary;
  }

  /** One show or movie, asked of TMDB again at once (after a match fixed by hand). */
  async refreshOne(itemId: string): Promise<boolean> {
    const { db } = this.ctx;
    const show = db.prepare("SELECT id, library_id, folder, NULL AS file, title, original_title, year, imdb_id, tmdb_id FROM shows WHERE id = ?").get(itemId) as (TitleRow & { library_id: string }) | undefined;
    const movie = show ? undefined : db.prepare("SELECT id, library_id, folder, file, title, original_title, year, imdb_id, tmdb_id FROM movies WHERE id = ?").get(itemId) as (TitleRow & { library_id: string }) | undefined;
    const title = show ?? movie;
    if (!title) return false;
    const library = db.prepare("SELECT id, kind, folder, language FROM libraries WHERE id = ?").get(title.library_id) as Library;
    const episodes = show ? db.prepare("SELECT id, season, episode, file FROM episodes WHERE show_id = ? ORDER BY season, episode").all(itemId) as EpisodeRow[] : [];
    const summary: MetadataSummary = { titles: 1, matched: 0, unmatched: 0, failed: 0, posters: 0, error: null };
    await this.refreshTitle(this.tmdb(), library, { ...title, file: title.file ?? undefined }, episodes, true, summary);
    return true;
  }
}

/** Fix the match of a show or movie by hand (a TMDB id), or give it back to the automatic one (null). */
export function setMatch(db: Db, itemId: string, kind: "show" | "movie", tmdbId: string | null): void {
  const row = metaFor(db, [itemId]).get(itemId) ?? emptyRow(itemId, kind);
  saveRow(db, { ...row, kind, tmdb_id: tmdbId, locked: tmdbId ? 1 : 0, tmdb_state: "none", checked_at: null });
}

/** Rows (and their images) whose item is gone; for the daily sweep. */
export function purgeOrphanMetadata(db: Db, artDir: string): number {
  const gone = db.prepare(`
    SELECT item_id, poster, backdrop, still FROM metadata
    WHERE item_id NOT IN (SELECT id FROM shows) AND item_id NOT IN (SELECT id FROM movies) AND item_id NOT IN (SELECT id FROM episodes)
  `).all() as { item_id: string; poster: string | null; backdrop: string | null; still: string | null }[];
  for (const row of gone) {
    for (const source of [row.poster, row.backdrop, row.still]) {
      if (source?.startsWith("cache:")) fs.rmSync(path.join(artDir, path.basename(source.slice(6))), { force: true });
    }
    db.prepare("DELETE FROM metadata WHERE item_id = ?").run(row.item_id);
  }
  return gone.length;
}
