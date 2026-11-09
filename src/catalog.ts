// What the family browses: shows with their seasons and episodes, and movies —
// only ever from active libraries the person may see (X-Isputnik-Libraries, as
// home worked it out). Home's screens draw it; this answers in plain JSON.
import type { Db } from "./db.js";
import { canSee, type Identity } from "./identity.js";
import { browserPlayability, movieIdOf, nextUp, partsOfMovie, placeInFilm, progressFor, resumeAt } from "./playback.js";
import { BASE_PATH } from "./config.js";
import { artUrl, metaFor, metaGenres, partKey, type MetaRow } from "./metadata.js";
import { parseGenres, rawGenresSql, resolveGenres, widenGenres } from "./genres.js";
import { setOfMovie } from "./sets.js";
import { creditsOf } from "./credits.js";

const API = `${BASE_PATH}/api`;

/** The scan's words first (an .nfo, a folder name), TMDB's where it had none. */
const filled = <T>(own: T | null | undefined, meta: T | null | undefined): T | null => own ?? meta ?? null;
/** A title's genres as the admin's list maps them (genres.ts). */
const genresOf = (db: Db, raw: unknown, meta: MetaRow | undefined) => {
  const own = parseGenres(raw);
  return resolveGenres(db, own.length > 0 ? own : metaGenres(meta));
};
/** What a card shows besides the title: the poster, the year, the rating. */
const art = (meta: MetaRow | undefined) => ({ poster: artUrl(API, meta, "poster"), rating: meta?.rating ?? null });

export interface ListQuery {
  library?: string;
  q?: string;
  sort: "title" | "year" | "added";
  page: number;
  pageSize: number;
  /** Only titles of this genre, as the card shows them (the scan's, else TMDB's). */
  genre?: string;
}

/** Films and shows in one list (home's one video page): each facet is "any of",
 *  empty is everything this person may see. */
export interface TitleQuery {
  kind?: "shows" | "movies";
  libraries: string[];
  genres: string[];
  q?: string;
  sort: ListQuery["sort"];
  page: number;
  pageSize: number;
}

/** A title's genres as its card shows them: the scan's own, TMDB's when it had
 *  none, through the admin's list (genre_names, genres.ts). */
const effectiveGenres = (table: "shows" | "movies") => `genre_names(${rawGenresSql(table)})`;

/** Every genre in some libraries of one kind. */
function genresIn(db: Db, libraryIds: string[], kind: "shows" | "movies"): string[] {
  if (libraryIds.length === 0) return [];
  return (db.prepare(`
    SELECT DISTINCT g.value AS genre FROM ${kind}, json_each(${effectiveGenres(kind)}) g
    WHERE ${kind}.library_id IN (${libraryIds.map(() => "?").join(", ")}) AND g.type = 'text' AND trim(g.value) != ''
    ORDER BY g.value COLLATE NOCASE
  `).all(...libraryIds) as { genre: string }[]).map((row) => row.genre);
}

/** Every genre a person can find, in films, shows or both: the Genre facet. */
export function visibleGenres(db: Db, identity: Identity, kind?: "shows" | "movies"): string[] {
  const all = new Set<string>();
  for (const each of kind ? [kind] : (["movies", "shows"] as const)) {
    for (const genre of genresIn(db, visibleLibraries(db, identity, each).map((row) => row.id), each)) all.add(genre);
  }
  return [...all].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
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
  added: "added_at DESC, rowid DESC"
};
/** The same over films and shows together, where rowid means nothing across tables. */
const TITLE_ORDER: Record<ListQuery["sort"], string> = {
  title: "sort_title COLLATE NOCASE, year, kind",
  year: "year DESC, sort_title COLLATE NOCASE, kind",
  added: "added_at DESC, kind, rid DESC"
};

function scope(db: Db, identity: Identity, kind: "shows" | "movies", query: ListQuery): string[] {
  const ids = visibleLibraries(db, identity, kind).map((row) => row.id);
  return query.library ? ids.filter((id) => id === query.library) : ids;
}

/** Which rows of a table a list takes: in these libraries, matching the search,
 *  of any of these genres. */
function where(db: Db, table: "shows" | "movies", libraries: string[], q: string | undefined, genres: string[]) {
  let sql = `library_id IN (${libraries.map(() => "?").join(", ")})`;
  const params: string[] = [...libraries];
  // The scan's title or TMDB's, either in the original too: a show filed as
  // «Радар» is found by "Radar".
  if (q?.trim()) {
    sql += " AND (title LIKE ? OR original_title LIKE ? OR id IN (SELECT m.item_id FROM metadata m WHERE m.title LIKE ? OR m.original_title LIKE ?))";
    params.push(...Array<string>(4).fill(`%${q.trim()}%`));
  }
  const wanted = widenGenres(db, genres.map((genre) => genre.trim()).filter(Boolean));
  if (wanted.length > 0) {
    sql += ` AND EXISTS (SELECT 1 FROM json_each(${effectiveGenres(table)}) g WHERE g.value IN (${wanted.map(() => "?").join(", ")}))`;
    params.push(...wanted);
  }
  return { sql, params };
}

/** One page of a list, and how many there are. A person who may see nothing gets an empty page. */
function page<T>(db: Db, table: "shows" | "movies", columns: string, libraries: string[], query: ListQuery, map: (row: Record<string, unknown>, meta: MetaRow | undefined) => T) {
  if (libraries.length === 0) return { items: [] as T[], total: 0, page: 1, pageSize: query.pageSize };
  const filter = where(db, table, libraries, query.q, query.genre ? [query.genre] : []);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${filter.sql}`).get(...filter.params) as { n: number }).n;
  const rows = db.prepare(`SELECT ${columns} FROM ${table} WHERE ${filter.sql} ORDER BY ${ORDER[query.sort]} LIMIT ? OFFSET ?`)
    .all(...filter.params, query.pageSize, (query.page - 1) * query.pageSize) as Record<string, unknown>[];
  const meta = metaFor(db, rows.map((row) => row.id as string));
  return { items: rows.map((row) => map(row, meta.get(row.id as string))), total, page: query.page, pageSize: query.pageSize };
}

const SHOW_COLUMNS = `
  id, library_id, title, year, imdb_id, ${effectiveGenres("shows")} AS genres,
  (SELECT COUNT(DISTINCT season) FROM episodes WHERE show_id = shows.id) AS seasons,
  (SELECT COUNT(*) FROM episodes WHERE show_id = shows.id) AS episodes
`;
const showCard = (row: Record<string, unknown>, meta: MetaRow | undefined) => ({
  id: row.id as string,
  libraryId: row.library_id as string,
  title: row.title as string,
  year: filled(row.year as number | null, meta?.year),
  imdbId: (row.imdb_id as string | null) ?? null,
  genres: parseGenres(row.genres),
  seasons: row.seasons as number,
  episodes: row.episodes as number,
  ...art(meta)
});

const MOVIE_COLUMNS = `id, library_id, title, year, imdb_id, ${effectiveGenres("movies")} AS genres, runtime_minutes`;
const movieCard = (row: Record<string, unknown>, meta: MetaRow | undefined) => ({
  id: row.id as string,
  libraryId: row.library_id as string,
  title: row.title as string,
  year: filled(row.year as number | null, meta?.year),
  imdbId: (row.imdb_id as string | null) ?? null,
  genres: parseGenres(row.genres),
  runtimeMinutes: (row.runtime_minutes as number | null) ?? null,
  ...art(meta)
});

export function listShows(db: Db, identity: Identity, query: ListQuery) {
  return page(db, "shows", SHOW_COLUMNS, scope(db, identity, "shows", query), query, showCard);
}

export function listMovies(db: Db, identity: Identity, query: ListQuery) {
  return page(db, "movies", MOVIE_COLUMNS, scope(db, identity, "movies", query), query, movieCard);
}

/** Cards for some titles of one table, by id. */
function cardsOf<T>(db: Db, table: "shows" | "movies", columns: string, ids: string[], map: (row: Record<string, unknown>, meta: MetaRow | undefined) => T) {
  if (ids.length === 0) return new Map<string, T>();
  const rows = db.prepare(`SELECT ${columns} FROM ${table} WHERE id IN (${ids.map(() => "?").join(", ")})`).all(...ids) as Record<string, unknown>[];
  const meta = metaFor(db, ids);
  return new Map(rows.map((row) => [row.id as string, map(row, meta.get(row.id as string))]));
}

/** Films and shows in one page, each card saying which it is: home's one video
 *  page. The two tables are paged together, so page 2 follows page 1 in any sort. */
export function listTitles(db: Db, identity: Identity, query: TitleQuery) {
  const parts = (["movies", "shows"] as const)
    .filter((kind) => !query.kind || query.kind === kind)
    .flatMap((kind) => {
      const libraries = visibleLibraries(db, identity, kind).map((row) => row.id)
        .filter((id) => query.libraries.length === 0 || query.libraries.includes(id));
      if (libraries.length === 0) return [];
      const filter = where(db, kind, libraries, query.q, query.genres);
      return [{ sql: `SELECT '${kind}' AS kind, id, sort_title, year, added_at, rowid AS rid FROM ${kind} WHERE ${filter.sql}`, params: filter.params }];
    });
  if (parts.length === 0) return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
  const union = parts.map((part) => part.sql).join(" UNION ALL ");
  const params = parts.flatMap((part) => part.params);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${union})`).get(...params) as { n: number }).n;
  const rows = db.prepare(`SELECT kind, id FROM (${union}) ORDER BY ${TITLE_ORDER[query.sort]} LIMIT ? OFFSET ?`)
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as { kind: "shows" | "movies"; id: string }[];
  const idsOf = (kind: "shows" | "movies") => rows.filter((row) => row.kind === kind).map((row) => row.id);
  const shows = cardsOf(db, "shows", SHOW_COLUMNS, idsOf("shows"), showCard);
  const movies = cardsOf(db, "movies", MOVIE_COLUMNS, idsOf("movies"), movieCard);
  return {
    items: rows.flatMap((row) => {
      const card = row.kind === "shows" ? shows.get(row.id) : movies.get(row.id);
      return card ? [{ kind: row.kind, ...card }] : [];
    }),
    total,
    page: query.page,
    pageSize: query.pageSize
  };
}

/** How the title is matched on TMDB, for the admin's Fix match. */
const matchOf = (meta: MetaRow | undefined) => ({
  tmdbMatch: meta ? { id: meta.tmdb_id, kind: meta.tmdb_kind, state: meta.tmdb_state, locked: meta.locked === 1, error: meta.error } : null
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
    genres: genresOf(db, show.genres, showMeta),
    imdbId: (show.imdb_id as string | null) ?? null,
    tmdbId: filled(showMeta?.locked ? showMeta.tmdb_id : (show.tmdb_id as string | null), showMeta?.tmdb_id),
    source: show.source as "nfo" | "folder",
    ...art(showMeta),
    backdrop: artUrl(API, showMeta, "backdrop"),
    ...matchOf(showMeta),
    seasons: [...seasons.values()],
    /** The show's regulars, and who made it (credits.ts). */
    ...creditsOf(db, id),
    /** What Play on the show starts: null once every episode is watched. */
    nextUp: next ? { id: next.id, season: next.season, episode: next.episode, title: next.title, position: resumeAt(progress.get(next.id)) } : null
  };
}

/** A film, asked for by its own id or by a part's (the player's way back). */
export function getMovie(db: Db, identity: Identity, askedId: string) {
  const id = movieIdOf(db, askedId);
  const movie = db.prepare(`
    SELECT m.* FROM movies m JOIN libraries l ON l.id = m.library_id
    WHERE m.id = ? AND l.state = 'active'
  `).get(id) as Record<string, unknown> | undefined;
  if (!movie || !canSee(identity, movie.library_id as string)) return null;
  const meta = metaFor(db, [id]).get(id);
  const parts = partsOfMovie(db, { id, file: movie.file as string });
  const place = placeInFilm(db, identity.id, parts);
  const partProgress = progressFor(db, identity.id, parts.map((part) => part.id));
  // A film TMDB has as a TV show: each part is one of its episodes (metadata.ts).
  const partMeta = parts.length < 2 ? new Map<string, MetaRow>() : metaFor(db, parts.map((part) => partKey(id, part.part)));
  return {
    id: movie.id as string,
    libraryId: movie.library_id as string,
    title: movie.title as string,
    originalTitle: (movie.original_title as string | null) ?? null,
    year: filled(movie.year as number | null, meta?.year),
    plot: filled(movie.plot as string | null, meta?.plot),
    genres: genresOf(db, movie.genres, meta),
    runtimeMinutes: (movie.runtime_minutes as number | null) ?? null,
    imdbId: (movie.imdb_id as string | null) ?? null,
    tmdbId: filled(meta?.locked ? meta.tmdb_id : (movie.tmdb_id as string | null), meta?.tmdb_id),
    source: movie.source as "nfo" | "folder",
    ...art(meta),
    backdrop: artUrl(API, meta, "backdrop"),
    ...matchOf(meta),
    direct: browserPlayability(movie.file as string).direct,
    /** What Play starts: the film, or the part this person has got to. */
    playId: place.id,
    progress: place.progress && { ...place.progress, watched: place.watched },
    /** Its files, when it is in several; empty when it is in one. */
    parts: parts.length < 2 ? [] : parts.map((part) => ({
      id: part.id,
      part: part.part,
      title: partMeta.get(partKey(id, part.part))?.title ?? null,
      plot: partMeta.get(partKey(id, part.part))?.plot ?? null,
      aired: partMeta.get(partKey(id, part.part))?.aired ?? null,
      still: artUrl(API, partMeta.get(partKey(id, part.part)), "still"),
      direct: browserPlayability(part.file).direct,
      progress: partProgress.get(part.id) ?? null
    })),
    /** The set it is in, with the films of it this person may see. */
    set: setOfMovie(db, identity, movie.id as string),
    /** Cast in billing order, crew by job (credits.ts). */
    ...creditsOf(db, movie.id as string)
  };
}
