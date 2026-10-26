// What the family browses: shows with their seasons and episodes, and movies —
// only ever from active libraries the person may see (X-Isputnik-Libraries, as
// home worked it out). Home's screens draw it; this answers in plain JSON.
import type { Db } from "./db.js";
import { canSee, type Identity } from "./identity.js";

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
function page<T>(db: Db, table: "shows" | "movies", columns: string, libraries: string[], query: ListQuery, map: (row: Record<string, unknown>) => T) {
  if (libraries.length === 0) return { items: [] as T[], total: 0, page: 1, pageSize: query.pageSize };
  const marks = libraries.map(() => "?").join(", ");
  const search = query.q?.trim() ? "AND (title LIKE ? OR original_title LIKE ?)" : "";
  const params: (string | number)[] = [...libraries];
  if (search) params.push(`%${query.q!.trim()}%`, `%${query.q!.trim()}%`);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE library_id IN (${marks}) ${search}`).get(...params) as { n: number }).n;
  const rows = db.prepare(`SELECT ${columns} FROM ${table} WHERE library_id IN (${marks}) ${search} ORDER BY ${ORDER[query.sort]} LIMIT ? OFFSET ?`)
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as Record<string, unknown>[];
  return { items: rows.map(map), total, page: query.page, pageSize: query.pageSize };
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
    `, scope(db, identity, "shows", query), query, (row) => ({
    id: row.id as string,
    libraryId: row.library_id as string,
    title: row.title as string,
    year: (row.year as number | null) ?? null,
    imdbId: (row.imdb_id as string | null) ?? null,
    genres: genres(row.genres),
    seasons: row.seasons as number,
    episodes: row.episodes as number
  }));
}

export function listMovies(db: Db, identity: Identity, query: ListQuery) {
  return page(db, "movies", "id, library_id, title, year, imdb_id, genres, runtime_minutes", scope(db, identity, "movies", query), query, (row) => ({
    id: row.id as string,
    libraryId: row.library_id as string,
    title: row.title as string,
    year: (row.year as number | null) ?? null,
    imdbId: (row.imdb_id as string | null) ?? null,
    genres: genres(row.genres),
    runtimeMinutes: (row.runtime_minutes as number | null) ?? null
  }));
}

/** A show with its seasons and episodes, or null when it is not there for this person. */
export function getShow(db: Db, identity: Identity, id: string) {
  const show = db.prepare(`
    SELECT s.* FROM shows s JOIN libraries l ON l.id = s.library_id
    WHERE s.id = ? AND l.state = 'active'
  `).get(id) as Record<string, unknown> | undefined;
  if (!show || !canSee(identity, show.library_id as string)) return null;
  const episodes = db.prepare("SELECT id, season, episode, title, plot, aired, runtime_minutes FROM episodes WHERE show_id = ? ORDER BY season, episode, file")
    .all(id) as { id: string; season: number; episode: number; title: string | null; plot: string | null; aired: string | null; runtime_minutes: number | null }[];
  const seasons = new Map<number, { number: number; episodes: unknown[] }>();
  for (const episode of episodes) {
    if (!seasons.has(episode.season)) seasons.set(episode.season, { number: episode.season, episodes: [] });
    seasons.get(episode.season)!.episodes.push({
      id: episode.id,
      episode: episode.episode,
      title: episode.title,
      plot: episode.plot,
      aired: episode.aired,
      runtimeMinutes: episode.runtime_minutes
    });
  }
  return {
    id: show.id as string,
    libraryId: show.library_id as string,
    title: show.title as string,
    originalTitle: (show.original_title as string | null) ?? null,
    year: (show.year as number | null) ?? null,
    plot: (show.plot as string | null) ?? null,
    premiered: (show.premiered as string | null) ?? null,
    status: (show.status as string | null) ?? null,
    genres: genres(show.genres),
    imdbId: (show.imdb_id as string | null) ?? null,
    tmdbId: (show.tmdb_id as string | null) ?? null,
    source: show.source as "nfo" | "folder",
    seasons: [...seasons.values()]
  };
}

export function getMovie(db: Db, identity: Identity, id: string) {
  const movie = db.prepare(`
    SELECT m.* FROM movies m JOIN libraries l ON l.id = m.library_id
    WHERE m.id = ? AND l.state = 'active'
  `).get(id) as Record<string, unknown> | undefined;
  if (!movie || !canSee(identity, movie.library_id as string)) return null;
  return {
    id: movie.id as string,
    libraryId: movie.library_id as string,
    title: movie.title as string,
    originalTitle: (movie.original_title as string | null) ?? null,
    year: (movie.year as number | null) ?? null,
    plot: (movie.plot as string | null) ?? null,
    genres: genres(movie.genres),
    runtimeMinutes: (movie.runtime_minutes as number | null) ?? null,
    imdbId: (movie.imdb_id as string | null) ?? null,
    tmdbId: (movie.tmdb_id as string | null) ?? null,
    source: movie.source as "nfo" | "folder"
  };
}
