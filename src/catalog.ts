// What the family browses: shows with their seasons and episodes, and movies —
// only ever from active libraries the person may see (X-Isputnik-Libraries, as
// home worked it out). Home's screens draw it; this answers in plain JSON.
import type { Db } from "./db.js";
import { canSee, type Identity } from "./identity.js";
import { browserPlayability, nextUp, progressFor, resumeAt } from "./playback.js";
import { BASE_PATH } from "./config.js";
import { artUrl, metaFor, metaGenres, type MetaRow } from "./metadata.js";

const API = `${BASE_PATH}/api`;

/** The scan's words first (an .nfo, a folder name), TMDB's where it had none. */
const filled = <T>(own: T | null | undefined, meta: T | null | undefined): T | null => own ?? meta ?? null;
const genresOf = (raw: unknown, meta: MetaRow | undefined) => {
  const own = genres(raw);
  return own.length > 0 ? own : metaGenres(meta);
};
/** What a card shows besides the title: the poster, the year, the rating. */
const art = (meta: MetaRow | undefined) => ({ poster: artUrl(API, meta, "poster"), rating: meta?.rating ?? null });

export interface ListQuery {
  library?: string;
  q?: string;
  sort: "title" | "year" | "added";
  page: number;
  pageSize: number;
}

/** The ids of the active libraries of a kind this person may see. */
export function visibleLibraries(db: Db, identity: Identity, kind?: "shows" | "movies"): { id: string; name: string; kind: "shows" | "movies" }[] {
  const rows = db.prepare(`SELECT id, name, kind FROM libraries WHERE state = 'active' ${kind ? "AND kind = ?" : ""} ORDER BY name COLLATE NOCASE`)
    .all(...(kind ? [kind] : [])) as { id: string; name: string; kind: "shows" | "movies" }[];
  return rows.filter((row) => canSee(identity, row.id));
}

const ORDER: Record<ListQuery["sort"], string> = {
  title: "sort_title COLLATE NOCASE, year",
  year: "year DESC, sort_title COLLATE NOCASE",
  added: "rowid DESC"
};

function scope(db: Db, identity: Identity, kind: "shows" | "movies", query: ListQuery): string[] {
  const ids = visibleLibraries(db, identity, kind).map((row) => row.id);
  return query.library ? ids.filter((id) => id === query.library) : ids;
}

/** One page of a list, and how many there are. A person who may see nothing gets an empty page. */
function page<T>(db: Db, table: "shows" | "movies", columns: string, libraries: string[], query: ListQuery, map: (row: Record<string, unknown>, meta: MetaRow | undefined) => T) {
  if (libraries.length === 0) return { items: [] as T[], total: 0, page: 1, pageSize: query.pageSize };
  const marks = libraries.map(() => "?").join(", ");
  // The scan's title or TMDB's, either in the original too: a show filed as
  // «Радар» is found by "Radar".
  const search = query.q?.trim()
    ? `AND (title LIKE ? OR original_title LIKE ? OR id IN (SELECT m.item_id FROM metadata m WHERE m.title LIKE ? OR m.original_title LIKE ?))`
    : "";
  const params: (string | number)[] = [...libraries];
  if (search) params.push(...Array(4).fill(`%${query.q!.trim()}%`));
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE library_id IN (${marks}) ${search}`).get(...params) as { n: number }).n;
  const rows = db.prepare(`SELECT ${columns} FROM ${table} WHERE library_id IN (${marks}) ${search} ORDER BY ${ORDER[query.sort]} LIMIT ? OFFSET ?`)
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as Record<string, unknown>[];
  const meta = metaFor(db, rows.map((row) => row.id as string));
  return { items: rows.map((row) => map(row, meta.get(row.id as string))), total, page: query.page, pageSize: query.pageSize };
}

const genres = (raw: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
};

export function listShows(db: Db, identity: Identity, query: ListQuery) {
  return page(db, "shows", `
      id, library_id, title, year, imdb_id, genres,
      (SELECT COUNT(DISTINCT season) FROM episodes WHERE show_id = shows.id) AS seasons,
      (SELECT COUNT(*) FROM episodes WHERE show_id = shows.id) AS episodes
    `, scope(db, identity, "shows", query), query, (row, meta) => ({
    id: row.id as string,
    libraryId: row.library_id as string,
    title: row.title as string,
    year: filled(row.year as number | null, meta?.year),
    imdbId: (row.imdb_id as string | null) ?? null,
    genres: genresOf(row.genres, meta),
    seasons: row.seasons as number,
    episodes: row.episodes as number,
    ...art(meta)
  }));
}

export function listMovies(db: Db, identity: Identity, query: ListQuery) {
  return page(db, "movies", "id, library_id, title, year, imdb_id, genres, runtime_minutes", scope(db, identity, "movies", query), query, (row, meta) => ({
    id: row.id as string,
    libraryId: row.library_id as string,
    title: row.title as string,
    year: filled(row.year as number | null, meta?.year),
    imdbId: (row.imdb_id as string | null) ?? null,
    genres: genresOf(row.genres, meta),
    runtimeMinutes: (row.runtime_minutes as number | null) ?? null,
    ...art(meta)
  }));
}

/** How the title is matched on TMDB, for the admin's Fix match. */
const matchOf = (meta: MetaRow | undefined) => ({
  tmdbMatch: meta ? { id: meta.tmdb_id, state: meta.tmdb_state, locked: meta.locked === 1, error: meta.error } : null
});

/** A show with its seasons and episodes, or null when it is not there for this person. */
export function getShow(db: Db, identity: Identity, id: string) {
  const show = db.prepare(`
    SELECT s.* FROM shows s JOIN libraries l ON l.id = s.library_id
    WHERE s.id = ? AND l.state = 'active'
  `).get(id) as Record<string, unknown> | undefined;
  if (!show || !canSee(identity, show.library_id as string)) return null;
  const episodes = db.prepare("SELECT id, season, episode, title, plot, aired, runtime_minutes, file FROM episodes WHERE show_id = ? ORDER BY season, episode, file")
    .all(id) as { id: string; season: number; episode: number; title: string | null; plot: string | null; aired: string | null; runtime_minutes: number | null; file: string }[];
  const progress = progressFor(db, identity.id, episodes.map((episode) => episode.id));
  const meta = metaFor(db, [id, ...episodes.map((episode) => episode.id)]);
  const showMeta = meta.get(id);
  // A show named only by its folder has its episodes named by their files
  // ("Inside.Out.1080p"): TMDB's names read better. An .nfo's stay.
  const fromFiles = show.source === "folder";
  const seasons = new Map<number, { number: number; episodes: unknown[] }>();
  for (const episode of episodes) {
    if (!seasons.has(episode.season)) seasons.set(episode.season, { number: episode.season, episodes: [] });
    seasons.get(episode.season)!.episodes.push({
      id: episode.id,
      episode: episode.episode,
      title: fromFiles ? filled(meta.get(episode.id)?.title, episode.title) : filled(episode.title, meta.get(episode.id)?.title),
      plot: filled(episode.plot, meta.get(episode.id)?.plot),
      aired: filled(episode.aired, meta.get(episode.id)?.aired),
      still: artUrl(API, meta.get(episode.id), "still"),
      runtimeMinutes: episode.runtime_minutes,
      direct: browserPlayability(episode.file).direct,
      progress: progress.get(episode.id) ?? null
    });
  }
  const next = nextUp(db, identity.id, id);
  return {
    id: show.id as string,
    libraryId: show.library_id as string,
    title: show.title as string,
    originalTitle: (show.original_title as string | null) ?? null,
    year: filled(show.year as number | null, showMeta?.year),
    plot: filled(show.plot as string | null, showMeta?.plot),
    premiered: filled(show.premiered as string | null, showMeta?.aired),
    status: filled(show.status as string | null, showMeta?.status),
    genres: genresOf(show.genres, showMeta),
    imdbId: (show.imdb_id as string | null) ?? null,
    tmdbId: filled(showMeta?.locked ? showMeta.tmdb_id : (show.tmdb_id as string | null), showMeta?.tmdb_id),
    source: show.source as "nfo" | "folder",
    ...art(showMeta),
    backdrop: artUrl(API, showMeta, "backdrop"),
    ...matchOf(showMeta),
    seasons: [...seasons.values()],
    /** What Play on the show starts: null once every episode is watched. */
    nextUp: next ? { id: next.id, season: next.season, episode: next.episode, title: next.title, position: resumeAt(progress.get(next.id)) } : null
  };
}

export function getMovie(db: Db, identity: Identity, id: string) {
  const movie = db.prepare(`
    SELECT m.* FROM movies m JOIN libraries l ON l.id = m.library_id
    WHERE m.id = ? AND l.state = 'active'
  `).get(id) as Record<string, unknown> | undefined;
  if (!movie || !canSee(identity, movie.library_id as string)) return null;
  const meta = metaFor(db, [id]).get(id);
  return {
    id: movie.id as string,
    libraryId: movie.library_id as string,
    title: movie.title as string,
    originalTitle: (movie.original_title as string | null) ?? null,
    year: filled(movie.year as number | null, meta?.year),
    plot: filled(movie.plot as string | null, meta?.plot),
    genres: genresOf(movie.genres, meta),
    runtimeMinutes: (movie.runtime_minutes as number | null) ?? null,
    imdbId: (movie.imdb_id as string | null) ?? null,
    tmdbId: filled(meta?.locked ? meta.tmdb_id : (movie.tmdb_id as string | null), meta?.tmdb_id),
    source: movie.source as "nfo" | "folder",
    ...art(meta),
    backdrop: artUrl(API, meta, "backdrop"),
    ...matchOf(meta),
    direct: browserPlayability(movie.file as string).direct,
    progress: progressFor(db, identity.id, [movie.id as string]).get(movie.id as string) ?? null
  };
}
