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
import { countSets, markSetChecked, rebuildSets, saveSetTmdb, setsDueForTmdb } from "./sets.js";

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
  set_tmdb_id: string | null;
  set_name: string | null;
  set_checked: number;
  /** A TMDB backdrop the admin chose; wins over the one picked by votes. */
  backdrop_choice: string | null;
  /** 1 once the backdrop was picked from TMDB's textless ones (0.18.0): before
   *  that it was TMDB's default, so a title is asked once more. */
  backdrop_picked: number;
  /** Where on TMDB the match was found; null (before 0.21.0) means the title's own kind. */
  tmdb_kind: TmdbKind | null;
  /** A TMDB poster the admin chose; wins over TMDB's own. */
  poster_choice: string | null;
  /** A poster the admin uploaded ("cache:<file>"); wins over every other. */
  poster_upload: string | null;
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

/** A TMDB picture's file in the art folder: what it shows and which picture it is. */
function cacheName(name: string, imagePath: string): string {
  const which = crypto.createHash("sha1").update(imagePath).digest("hex").slice(0, 8);
  return `${name}-${which}${path.extname(imagePath).toLowerCase()}`;
}

/** Where a picture is served, with a version so a new one isn't cached as the old. */
export function versionedArtUrl(api: string, id: string, kind: ArtKind, source: string): string {
  const version = crypto.createHash("sha1").update(source).digest("hex").slice(0, 8);
  return `${api}/art/${id}/${kind}?v=${version}`;
}

/** Where an item's picture is served; null for none. */
export function artUrl(api: string, row: MetaRow | undefined, kind: ArtKind): string | null {
  const source = row?.[kind];
  if (!row || !source) return null;
  return versionedArtUrl(api, row.item_id, kind, source);
}

/** The file behind an item's picture: beside the video, or in the art folder. */
export function artFile(row: Partial<Record<ArtKind, string | null>> | undefined | null, kind: ArtKind, mediaRoot: string, artDir: string): string | null {
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
  /** Film sets with two or more films (sets.ts), after the pass. */
  sets: number;
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
    poster_path: null, backdrop_path: null, still_path: null, checked_at: null, error: null,
    set_tmdb_id: null, set_name: null, set_checked: 0, backdrop_choice: null, backdrop_picked: 0, tmdb_kind: null,
    poster_choice: null, poster_upload: null
  };
}

function saveRow(db: Db, row: MetaRow): void {
  db.prepare(`
    INSERT INTO metadata (item_id, kind, tmdb_id, locked, tmdb_state, title, original_title, plot, year, aired, genres, rating, status,
      poster, backdrop, still, poster_path, backdrop_path, still_path, checked_at, error, set_tmdb_id, set_name, set_checked,
      backdrop_choice, backdrop_picked, tmdb_kind, poster_choice, poster_upload)
    VALUES (@item_id, @kind, @tmdb_id, @locked, @tmdb_state, @title, @original_title, @plot, @year, @aired, @genres, @rating, @status,
      @poster, @backdrop, @still, @poster_path, @backdrop_path, @still_path, @checked_at, @error, @set_tmdb_id, @set_name, @set_checked,
      @backdrop_choice, @backdrop_picked, @tmdb_kind, @poster_choice, @poster_upload)
    ON CONFLICT (item_id) DO UPDATE SET kind = excluded.kind, tmdb_id = excluded.tmdb_id, locked = excluded.locked,
      tmdb_state = excluded.tmdb_state, title = excluded.title, original_title = excluded.original_title, plot = excluded.plot,
      year = excluded.year, aired = excluded.aired, genres = excluded.genres, rating = excluded.rating, status = excluded.status,
      poster = excluded.poster, backdrop = excluded.backdrop, still = excluded.still, poster_path = excluded.poster_path,
      backdrop_path = excluded.backdrop_path, still_path = excluded.still_path, checked_at = excluded.checked_at, error = excluded.error,
      set_tmdb_id = excluded.set_tmdb_id, set_name = excluded.set_name, set_checked = excluded.set_checked,
      backdrop_choice = excluded.backdrop_choice, backdrop_picked = excluded.backdrop_picked, tmdb_kind = excluded.tmdb_kind,
      poster_choice = excluded.poster_choice, poster_upload = excluded.poster_upload,
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
      // A film matched before sets came in: asked once more for its collection;
      // a title whose backdrop was TMDB's default, once more for a better one.
      return age > RECHECK_MATCHED || (row.kind === "movie" && !row.set_checked) || (row.kind !== "episode" && !row.backdrop_picked);
  }
}

export class MetadataRunner {
  constructor(private ctx: MetadataContext) {}

  private tmdb(): Tmdb | null {
    const key = readTmdbKey(this.ctx.db);
    return key ? new Tmdb(key, this.ctx.fetch) : null;
  }

  /** A TMDB image into the art folder, named after what it shows and which of
   *  TMDB's pictures it is — so another picture is another address, which no
   *  browser has kept — and the old one goes. */
  private async download(tmdb: Tmdb, imagePath: string, size: string, name: string, previous: string | null): Promise<string> {
    const bytes = await tmdb.image(imagePath, size);
    await sleep(PAUSE_MS);
    fs.mkdirSync(this.ctx.artDir, { recursive: true });
    const file = cacheName(name, imagePath);
    fs.writeFileSync(path.join(this.ctx.artDir, file), bytes);
    if (previous?.startsWith("cache:") && previous.slice(6) !== file) fs.rmSync(path.join(this.ctx.artDir, previous.slice(6)), { force: true });
    return `cache:${file}`;
  }

  /** The picture to show: one beside the files, else TMDB's (fetched if it isn't
   *  here yet), else none. The kept file's name says which of TMDB's pictures it
   *  is, so nothing else has to remember it: a record written by 0.18.0 named the
   *  chosen picture without having fetched it, and one named before 0.18.1 says
   *  nothing — both are fetched again, once. */
  private async pick(tmdb: Tmdb | null, row: MetaRow, kind: ArtKind, local: string | null, imagePath: string | null): Promise<string | null> {
    if (local) return local;
    const current = row[kind];
    const cached = current?.startsWith("cache:") && artFile(row, kind, this.ctx.mediaRoot, this.ctx.artDir) ? current : null;
    if (!imagePath) return null;
    if (cached === `cache:${cacheName(`${row.item_id}-${kind}`, imagePath)}`) return cached;
    if (!tmdb) return cached;
    const size = kind === "poster" ? IMAGE_SIZES.poster : kind === "backdrop" ? IMAGE_SIZES.backdrop : IMAGE_SIZES.still;
    return this.download(tmdb, imagePath, size, `${row.item_id}-${kind}`, current);
  }

  /** The TMDB id for a title, and where on TMDB it was found: the one fixed by
   *  hand, the .nfo's or folder's, the IMDb id's, else the best search hit.
   *
   *  The title's own kind first; then the other, since TMDB files a Soviet
   *  miniseries kept as a film («Д'Артаньян и три мушкетёра») as a TV show, and a
   *  concert kept as a film the same way. The names as they are first, then with
   *  their first word dropped ("Concert Peter's Pop Show"): a name of three
   *  words or more often opens with a word that isn't the title's. */
  private async match(tmdb: Tmdb, kind: TmdbKind, title: TitleRow, row: MetaRow, language: string): Promise<{ id: string; kind: TmdbKind } | null> {
    if (row.locked && row.tmdb_id) return { id: row.tmdb_id, kind: row.tmdb_kind ?? kind };
    if (title.tmdb_id) return { id: title.tmdb_id, kind };
    const kinds: TmdbKind[] = [kind, kind === "movie" ? "tv" : "movie"];
    if (title.imdb_id) {
      for (const where of kinds) {
        const found = await tmdb.findByImdb(where, title.imdb_id);
        await sleep(PAUSE_MS);
        if (found) return { id: found, kind: where };
      }
    }
    const distinct = (values: string[]) => values.filter((value, at, all) => all.indexOf(value) === at);
    const names = distinct([title.title, title.original_title].filter((value): value is string => Boolean(value)));
    const trimmed = distinct(names.map((name) => name.trim().split(/\s+/)).filter((words) => words.length >= 3).map((words) => words.slice(1).join(" ")))
      .filter((query) => !names.includes(query));
    for (const queries of [names, trimmed]) {
      for (const where of kinds) {
        for (const query of queries) {
          for (const year of title.year ? [title.year, null] : [null]) {
            const results = await tmdb.search(where, query, year, language);
            await sleep(PAUSE_MS);
            // With a year, one within a year of it (release dates differ by country); without, the first.
            const hit = title.year ? results.find((result) => result.year !== null && Math.abs(result.year - title.year!) <= 1) : results[0];
            if (hit) return { id: hit.tmdbId, kind: where };
          }
        }
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

    // Beside the files: the title's own folder; a film without one, its own name in the folder it sits in.
    const loose = kind === "movie" && title.folder === title.file;
    const dir = loose ? path.posix.dirname(posix(library.folder, title.folder)) : posix(library.folder, title.folder);
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
        const found = await this.match(tmdb, tmdbKind, title, row, library.language);
        if (found) {
          details = await tmdb.details(found.kind, found.id, library.language);
          await sleep(PAUSE_MS);
          // A show's episodes are TMDB's only when it is a show there too.
          for (const season of found.kind === "tv" ? [...new Set(episodes.map((episode) => episode.season))] : []) {
            seasons.set(season, await tmdb.season(found.id, season, library.language));
            await sleep(PAUSE_MS);
          }
          Object.assign(row, {
            tmdb_id: details.tmdbId, tmdb_kind: found.kind, tmdb_state: "matched", title: details.title, original_title: details.originalTitle, plot: details.plot,
            year: details.year, aired: details.aired, genres: JSON.stringify(details.genres), rating: details.rating, status: details.status,
            // The admin's choice of TMDB's backdrops (Fix match) over the one picked by votes.
            poster_path: row.poster_choice ?? details.posterPath, backdrop_path: row.backdrop_choice ?? details.backdropPath, error: null,
            set_tmdb_id: details.collection?.tmdbId ?? null, set_name: details.collection?.name ?? null, set_checked: 1,
            backdrop_picked: 1
          });
        } else {
          Object.assign(row, { tmdb_state: "unmatched", tmdb_kind: null, error: null, set_tmdb_id: null, set_name: null, set_checked: 1 });
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
      // A poster the admin uploaded wins over the one beside the files and TMDB's.
      const uploaded = row.poster_upload && artFile({ poster: row.poster_upload }, "poster", mediaRoot, this.ctx.artDir) ? row.poster_upload : null;
      row.poster = uploaded ?? await this.pick(tmdb, row, "poster", localPoster, row.poster_path);
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
    const summary: MetadataSummary = { titles: 0, matched: 0, unmatched: 0, failed: 0, posters: 0, sets: 0, error: null };
    const titles = library.kind === "shows"
      ? db.prepare("SELECT id, folder, NULL AS file, title, original_title, year, imdb_id, tmdb_id FROM shows WHERE library_id = ? ORDER BY sort_title").all(library.id) as TitleRow[]
      : db.prepare("SELECT id, folder, file, title, original_title, year, imdb_id, tmdb_id FROM movies WHERE library_id = ? ORDER BY sort_title").all(library.id) as TitleRow[];
    let refused = false;
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
          refused = true;
          break;
        }
        throw err;
      }
    }
    if (library.kind === "movies") {
      try {
        await this.refreshSets(refused ? null : tmdb, force, summary);
      } catch (err) {
        summary.error ??= err instanceof TmdbError && err.status === 401 ? "TMDB refused the key; nothing more was asked" : `Sets: ${(err as Error).message}`;
      }
    }
    return summary;
  }

  /** Every film's set worked out again; then TMDB's words, art and order for the sets that are due. */
  async refreshSets(tmdb: Tmdb | null, force: boolean, summary?: MetadataSummary): Promise<void> {
    const { db, artDir } = this.ctx;
    rebuildSets(db, artDir);
    if (tmdb) {
      const now = Date.now();
      for (const set of setsDueForTmdb(db, now, force)) {
        const checkedAt = new Date(now).toISOString();
        try {
          const found = await tmdb.collection(set.tmdb_id!, set.language);
          await sleep(PAUSE_MS);
          const keep = async (kind: "poster" | "backdrop", imagePath: string | null) => {
            const current = set[kind];
            if (!imagePath) return null;
            if (current && set[`${kind}_path`] === imagePath && artFile(set, kind, this.ctx.mediaRoot, artDir)) return current;
            return this.download(tmdb, imagePath, kind === "poster" ? IMAGE_SIZES.poster : IMAGE_SIZES.backdrop, `${set.id}-${kind}`, current);
          };
          saveSetTmdb(db, set.id, {
            tmdb_name: found.name,
            tmdb_overview: found.overview,
            parts: JSON.stringify(found.parts),
            poster: await keep("poster", found.posterPath),
            backdrop: await keep("backdrop", found.backdropPath),
            poster_path: found.posterPath,
            backdrop_path: found.backdropPath,
            checked_at: checkedAt
          });
        } catch (err) {
          if (err instanceof TmdbError && err.status === 401) throw err;
          markSetChecked(db, set.id, checkedAt);
          if (summary) summary.error ??= `${set.name}: ${(err as Error).message}`;
          this.ctx.log.warn({ err, set: set.id }, "TMDB collection lookup failed");
        }
      }
      // TMDB's names and release dates in place: once more, so they show.
      rebuildSets(db, artDir);
    }
    if (summary) summary.sets = countSets(db);
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
    const summary: MetadataSummary = { titles: 1, matched: 0, unmatched: 0, failed: 0, posters: 0, sets: 0, error: null };
    const tmdb = this.tmdb();
    await this.refreshTitle(tmdb, library, { ...title, file: title.file ?? undefined }, episodes, true, summary);
    if (movie) await this.refreshSets(tmdb, false);
    return true;
  }
}

/** Fix the match of a show or movie by hand (a TMDB id, and where on TMDB it is
 *  when not the title's own kind), or give it back to the automatic one (null). */
export function setMatch(db: Db, itemId: string, kind: "show" | "movie", tmdbId: string | null, tmdbKind: TmdbKind | null = null): void {
  const row = metaFor(db, [itemId]).get(itemId) ?? emptyRow(itemId, kind);
  // Another title on TMDB: a backdrop chosen from the old one's means nothing now.
  saveRow(db, { ...row, kind, tmdb_id: tmdbId, tmdb_kind: tmdbId ? tmdbKind : null, locked: tmdbId ? 1 : 0, tmdb_state: "none", checked_at: null, backdrop_choice: null, poster_choice: null });
}

/** The admin's pick of a title's TMDB backdrops, or back to the best by votes (null). */
export function setBackdropChoice(db: Db, itemId: string, kind: "show" | "movie", imagePath: string | null): void {
  const row = metaFor(db, [itemId]).get(itemId) ?? emptyRow(itemId, kind);
  // backdrop_path stays the picture kept until the next pass fetches the chosen one.
  saveRow(db, { ...row, kind, backdrop_choice: imagePath, checked_at: null });
}

/** What a title is matched to on TMDB, for its backdrops; null when it isn't. */
export function tmdbMatchOf(db: Db, itemId: string): { tmdbId: string; tmdbKind: TmdbKind; choice: string | null; current: string | null } | null {
  const row = metaFor(db, [itemId]).get(itemId);
  if (!row?.tmdb_id || row.tmdb_state !== "matched") return null;
  return { tmdbId: row.tmdb_id, tmdbKind: row.tmdb_kind ?? (row.kind === "show" ? "tv" : "movie"), choice: row.backdrop_choice, current: row.backdrop_path };
}

/** The admin's pick of a title's TMDB posters, or back to TMDB's own (null). */
export function setPosterChoice(db: Db, itemId: string, kind: "show" | "movie", imagePath: string | null): void {
  const row = metaFor(db, [itemId]).get(itemId) ?? emptyRow(itemId, kind);
  saveRow(db, { ...row, kind, poster_choice: imagePath, checked_at: null });
}

/** Where a title's poster comes from now, for the Pictures tab. */
export function posterStateOf(db: Db, itemId: string): { uploaded: boolean; choice: string | null; current: string | null } {
  const row = metaFor(db, [itemId]).get(itemId);
  return { uploaded: Boolean(row?.poster_upload), choice: row?.poster_choice ?? null, current: row?.poster_path ?? null };
}

const UPLOAD_TYPES: { ext: string; test: (bytes: Buffer) => boolean }[] = [
  { ext: ".jpg", test: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { ext: ".png", test: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: ".webp", test: (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP" }
];

/** A poster the admin uploaded, kept in the art folder: shown at once, over any other.
 *  False when the bytes are not a JPEG, PNG or WebP picture. */
export function savePosterUpload(db: Db, artDir: string, itemId: string, kind: "show" | "movie", bytes: Buffer): boolean {
  const type = UPLOAD_TYPES.find((each) => each.test(bytes));
  if (!type) return false;
  const row = metaFor(db, [itemId]).get(itemId) ?? emptyRow(itemId, kind);
  fs.mkdirSync(artDir, { recursive: true });
  const file = `${itemId}-poster-upload-${crypto.createHash("sha1").update(bytes).digest("hex").slice(0, 8)}${type.ext}`;
  fs.writeFileSync(path.join(artDir, file), bytes);
  // The kept files it replaces: an upload before it, and TMDB's (fetched again if the upload goes).
  for (const previous of [row.poster_upload, row.poster]) {
    if (previous?.startsWith("cache:") && previous.slice(6) !== file) fs.rmSync(path.join(artDir, path.basename(previous.slice(6))), { force: true });
  }
  saveRow(db, { ...row, kind, poster_upload: `cache:${file}`, poster: `cache:${file}` });
  return true;
}

/** The uploaded poster gone: the next look (refreshOne) finds the one beside the files, or TMDB's. */
export function removePosterUpload(db: Db, artDir: string, itemId: string): void {
  const row = metaFor(db, [itemId]).get(itemId);
  if (!row?.poster_upload) return;
  fs.rmSync(path.join(artDir, path.basename(row.poster_upload.slice(6))), { force: true });
  saveRow(db, { ...row, poster_upload: null, poster: null });
}

/** Rows (and their images) whose item is gone; for the daily sweep. */
export function purgeOrphanMetadata(db: Db, artDir: string): number {
  const gone = db.prepare(`
    SELECT item_id, poster, backdrop, still, poster_upload FROM metadata
    WHERE item_id NOT IN (SELECT id FROM shows) AND item_id NOT IN (SELECT id FROM movies) AND item_id NOT IN (SELECT id FROM episodes)
  `).all() as { item_id: string; poster: string | null; backdrop: string | null; still: string | null; poster_upload: string | null }[];
  for (const row of gone) {
    for (const source of [row.poster, row.backdrop, row.still, row.poster_upload]) {
      if (source?.startsWith("cache:")) fs.rmSync(path.join(artDir, path.basename(source.slice(6))), { force: true });
    }
    db.prepare("DELETE FROM metadata WHERE item_id = ?").run(row.item_id);
  }
  return gone.length;
}
