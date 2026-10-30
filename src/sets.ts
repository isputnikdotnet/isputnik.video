// Film sets (home's docs/video-sets-plan.md): films that belong together, found
// rather than made — the .nfo's <set> first (what a family wrote down wins),
// else TMDB's collection (belongs_to_collection on the film).
//
// `sets` and `set_members` are rebuilt from movies + metadata after every scan
// and metadata pass, so they never drift from what those say; a set keeps its id
// while it has films. TMDB's words, art and order for a collection are kept on
// the set itself and survive the rebuild.
//
// A person only ever sees the films of a set that are in libraries they may see:
// a set split across two libraries is one set, and each member sees their part.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Db } from "./db.js";
import { BASE_PATH } from "./config.js";
import { canSee, type Identity } from "./identity.js";
import { artUrl, metaFor, versionedArtUrl } from "./metadata.js";
import { sortTitle } from "./names.js";
import { progressFor, resumeAt, type Progress } from "./playback.js";

const API = `${BASE_PATH}/api`;

export interface SetRow {
  id: string;
  tmdb_id: string | null;
  name_key: string | null;
  name: string;
  sort_name: string;
  overview: string | null;
  tmdb_name: string | null;
  tmdb_overview: string | null;
  parts: string;
  poster: string | null;
  backdrop: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  checked_at: string | null;
}

/** A name as a key: two .nfo files that spell a set differently in case or spacing are one set. */
export const nameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLocaleLowerCase();

const newId = () => crypto.randomBytes(12).toString("base64url");

const partsOf = (row: Pick<SetRow, "parts"> | undefined): { tmdbId: string; released: string | null }[] => {
  try {
    const parsed = JSON.parse(row?.parts ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// ── Rebuilding ─────────────────────────────────────────────────────────────

interface FilmFacts {
  id: string;
  set_name: string | null;
  set_overview: string | null;
  set_tmdb_id: string | null;
  film_tmdb_id: string | null;
  tmdb_set_id: string | null;
  tmdb_set_name: string | null;
}

interface Group {
  tmdbId: string | null;
  key: string | null;
  films: { id: string; source: "nfo" | "tmdb"; tmdbId: string | null }[];
  nfoNames: string[];
  nfoOverview: string | null;
  tmdbName: string | null;
}

/** Work out every film's set again from what the scan and TMDB say. */
export function rebuildSets(db: Db, artDir: string): void {
  const films = db.prepare(`
    SELECT m.id, m.set_name, m.set_overview, m.set_tmdb_id,
           md.tmdb_id AS film_tmdb_id, md.set_tmdb_id AS tmdb_set_id, md.set_name AS tmdb_set_name
    FROM movies m LEFT JOIN metadata md ON md.item_id = m.id
  `).all() as FilmFacts[];

  const byTmdb = new Map<string, Group>();
  const byName = new Map<string, Group>();
  const group = (tmdbId: string | null, name: string | null): Group => {
    const map = tmdbId ? byTmdb : byName;
    const id = tmdbId ?? nameKey(name!);
    let found = map.get(id);
    if (!found) {
      found = { tmdbId, key: tmdbId ? null : id, films: [], nfoNames: [], nfoOverview: null, tmdbName: null };
      map.set(id, found);
    }
    return found;
  };
  for (const film of films) {
    if (film.set_name) {
      const found = group(film.set_tmdb_id, film.set_name);
      found.films.push({ id: film.id, source: "nfo", tmdbId: film.film_tmdb_id });
      found.nfoNames.push(film.set_name);
      found.nfoOverview ??= film.set_overview;
    } else if (film.tmdb_set_id) {
      const found = group(film.tmdb_set_id, null);
      found.films.push({ id: film.id, source: "tmdb", tmdbId: film.film_tmdb_id });
      found.tmdbName ??= film.tmdb_set_name;
    }
  }

  const existing = db.prepare("SELECT * FROM sets").all() as SetRow[];
  const setByTmdb = new Map(existing.filter((row) => row.tmdb_id).map((row) => [row.tmdb_id!, row]));
  const setByKey = new Map(existing.filter((row) => row.name_key).map((row) => [row.name_key!, row]));

  // An .nfo set with no TMDB id that is named like a TMDB set is that set.
  for (const tmdbGroup of byTmdb.values()) {
    const names = [...tmdbGroup.nfoNames, tmdbGroup.tmdbName, setByTmdb.get(tmdbGroup.tmdbId!)?.tmdb_name].filter((name): name is string => Boolean(name));
    for (const key of new Set(names.map(nameKey))) {
      const named = byName.get(key);
      if (!named) continue;
      tmdbGroup.films.push(...named.films);
      tmdbGroup.nfoNames.push(...named.nfoNames);
      tmdbGroup.nfoOverview ??= named.nfoOverview;
      byName.delete(key);
    }
  }

  const insertSet = db.prepare("INSERT INTO sets (id, tmdb_id, name_key, name, sort_name, overview) VALUES (@id, @tmdbId, @key, @name, @sortName, @overview)");
  const updateSet = db.prepare(`UPDATE sets SET tmdb_id = @tmdbId, name_key = @key, name = @name, sort_name = @sortName, overview = @overview,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id`);
  const insertMember = db.prepare("INSERT INTO set_members (movie_id, set_id, source, released) VALUES (?, ?, ?, ?)");

  const write = db.transaction(() => {
    const kept = new Set<string>();
    db.prepare("DELETE FROM set_members").run();
    for (const found of [...byTmdb.values(), ...byName.values()]) {
      // A set that had only a name and has now been given a TMDB id stays the same set.
      const firstKey = found.nfoNames.length > 0 ? nameKey(found.nfoNames[0]) : null;
      const row = (found.tmdbId ? setByTmdb.get(found.tmdbId) : undefined)
        ?? (firstKey && !kept.has(setByKey.get(firstKey)?.id ?? "") ? setByKey.get(firstKey) : undefined);
      const name = found.nfoNames[0] ?? row?.tmdb_name ?? found.tmdbName ?? "?";
      const fields = {
        id: row?.id ?? newId(),
        tmdbId: found.tmdbId,
        key: found.tmdbId ? null : found.key,
        name,
        sortName: sortTitle(name),
        overview: found.nfoOverview ?? row?.tmdb_overview ?? null
      };
      if (row) updateSet.run(fields);
      else insertSet.run(fields);
      kept.add(fields.id);
      const released = new Map(partsOf(row).map((part) => [part.tmdbId, part.released]));
      for (const film of found.films) insertMember.run(film.id, fields.id, film.source, (film.tmdbId && released.get(film.tmdbId)) ?? null);
    }
    for (const row of existing) {
      if (kept.has(row.id)) continue;
      for (const source of [row.poster, row.backdrop]) {
        if (source?.startsWith("cache:")) fs.rmSync(path.join(artDir, path.basename(source.slice(6))), { force: true });
      }
      db.prepare("DELETE FROM sets WHERE id = ?").run(row.id);
    }
  });
  write();
}

// ── TMDB's side, for metadata.ts ───────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const RECHECK = 30 * DAY;

/** Sets with a TMDB id whose words and art are due, with a language to ask in. */
export function setsDueForTmdb(db: Db, now: number, force: boolean): (SetRow & { language: string })[] {
  const rows = db.prepare(`
    SELECT s.*, (SELECT l.language FROM set_members sm JOIN movies m ON m.id = sm.movie_id JOIN libraries l ON l.id = m.library_id
                 WHERE sm.set_id = s.id ORDER BY l.name LIMIT 1) AS language
    FROM sets s WHERE s.tmdb_id IS NOT NULL
  `).all() as (SetRow & { language: string | null })[];
  return rows
    .filter((row) => force || !row.checked_at || now - Date.parse(row.checked_at) > RECHECK)
    .map((row) => ({ ...row, language: row.language ?? "en" }));
}

export function saveSetTmdb(db: Db, id: string, fields: Pick<SetRow, "tmdb_name" | "tmdb_overview" | "parts" | "poster" | "backdrop" | "poster_path" | "backdrop_path" | "checked_at">): void {
  db.prepare(`UPDATE sets SET tmdb_name = @tmdb_name, tmdb_overview = @tmdb_overview, parts = @parts, poster = @poster, backdrop = @backdrop,
    poster_path = @poster_path, backdrop_path = @backdrop_path, checked_at = @checked_at, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id`)
    .run({ id, ...fields });
}

/** How many sets have two or more films, whoever looks; for the pass's event. */
export function countSets(db: Db): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM (SELECT set_id FROM set_members GROUP BY set_id HAVING COUNT(*) >= ${SET_MIN_FILMS})`).get() as { n: number }).n;
}

export function markSetChecked(db: Db, id: string, at: string): void {
  db.prepare("UPDATE sets SET checked_at = ? WHERE id = ?").run(at, id);
}

// ── Reading, for the catalog ───────────────────────────────────────────────

interface Member {
  set_id: string;
  id: string;
  title: string;
  sort_title: string;
  year: number | null;
  released: string | null;
  runtime_minutes: number | null;
}

/** A set shows as a set (in the list) once the person can see this many of its films. */
export const SET_MIN_FILMS = 2;

function movieLibraries(db: Db, identity: Identity, only?: string): string[] {
  const rows = db.prepare("SELECT id FROM libraries WHERE state = 'active' AND kind = 'movies'").all() as { id: string }[];
  return rows.map((row) => row.id).filter((id) => canSee(identity, id) && (!only || id === only));
}

/** The order of a set: release dates (TMDB's), else the year, then the title. */
const orderKey = (member: Member) => member.released ?? (member.year ? `${member.year}-99-99` : "9999");
const byOrder = (a: Member, b: Member) => orderKey(a).localeCompare(orderKey(b)) || a.sort_title.localeCompare(b.sort_title);

/** The films of the given sets (all, when null) this person may see, each set in order. */
function visibleMembers(db: Db, identity: Identity, setIds: string[] | null, library?: string): Map<string, Member[]> {
  const libraries = movieLibraries(db, identity, library);
  const out = new Map<string, Member[]>();
  if (libraries.length === 0 || (setIds && setIds.length === 0)) return out;
  const rows = db.prepare(`
    SELECT sm.set_id, m.id, m.title, m.sort_title, COALESCE(m.year, md.year) AS year, sm.released, m.runtime_minutes
    FROM set_members sm JOIN movies m ON m.id = sm.movie_id LEFT JOIN metadata md ON md.item_id = m.id
    WHERE m.library_id IN (${libraries.map(() => "?").join(", ")}) ${setIds ? `AND sm.set_id IN (${setIds.map(() => "?").join(", ")})` : ""}
  `).all(...libraries, ...(setIds ?? [])) as Member[];
  for (const row of rows) {
    const list = out.get(row.set_id) ?? [];
    list.push(row);
    out.set(row.set_id, list);
  }
  for (const list of out.values()) list.sort(byOrder);
  return out;
}

const setArt = (row: SetRow, kind: "poster" | "backdrop") => (row[kind] ? versionedArtUrl(API, row.id, kind, row[kind]) : null);

export interface SetListQuery {
  library?: string;
  q?: string;
  page: number;
  pageSize: number;
}

/** The sets this person can see two or more films of, by name. */
export function listSets(db: Db, identity: Identity, query: SetListQuery) {
  const members = visibleMembers(db, identity, null, query.library);
  const ids = [...members.entries()].filter(([, list]) => list.length >= SET_MIN_FILMS).map(([id]) => id);
  if (ids.length === 0) return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
  const rows = db.prepare(`SELECT * FROM sets WHERE id IN (${ids.map(() => "?").join(", ")})`).all(...ids) as SetRow[];
  const needle = query.q?.trim().toLocaleLowerCase();
  const matching = rows
    .filter((row) => !needle || row.name.toLocaleLowerCase().includes(needle) || (row.tmdb_name ?? "").toLocaleLowerCase().includes(needle))
    .sort((a, b) => a.sort_name.localeCompare(b.sort_name));
  const pageRows = matching.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
  const filmIds = pageRows.flatMap((row) => members.get(row.id)!.map((member) => member.id));
  const meta = metaFor(db, filmIds);
  const progress = progressFor(db, identity.id, filmIds);
  return {
    items: pageRows.map((row) => {
      const films = members.get(row.id)!;
      const years = films.map((film) => film.year).filter((year): year is number => year !== null);
      return {
        id: row.id,
        name: row.name,
        films: films.length,
        watched: films.filter((film) => progress.get(film.id)?.watched).length,
        firstYear: years.length > 0 ? Math.min(...years) : null,
        lastYear: years.length > 0 ? Math.max(...years) : null,
        // The set's own poster, else its first film's.
        poster: setArt(row, "poster") ?? artUrl(API, meta.get(films[0].id), "poster")
      };
    }),
    total: matching.length,
    page: query.page,
    pageSize: query.pageSize
  };
}

/** What Play on a set starts: the first film not yet watched, in order; null once all are. */
function nextOf(films: Member[], progress: Map<string, Progress>): Member | null {
  return films.find((film) => !progress.get(film.id)?.watched) ?? null;
}

/** A set with its films in order, or null when the person can see none of them. */
export function getSet(db: Db, identity: Identity, id: string) {
  const row = db.prepare("SELECT * FROM sets WHERE id = ?").get(id) as SetRow | undefined;
  const films = row ? visibleMembers(db, identity, [id]).get(id) ?? [] : [];
  if (!row || films.length === 0) return null;
  const ids = films.map((film) => film.id);
  const meta = metaFor(db, ids);
  const progress = progressFor(db, identity.id, ids);
  const next = nextOf(films, progress);
  return {
    id: row.id,
    name: row.name,
    overview: row.overview ?? row.tmdb_overview ?? null,
    poster: setArt(row, "poster") ?? artUrl(API, meta.get(films[0].id), "poster"),
    backdrop: setArt(row, "backdrop") ?? artUrl(API, meta.get(films[0].id), "backdrop"),
    films: films.map((film) => ({
      id: film.id,
      title: film.title,
      year: film.year,
      runtimeMinutes: film.runtime_minutes,
      poster: artUrl(API, meta.get(film.id), "poster"),
      progress: progress.get(film.id) ?? null
    })),
    next: next ? { id: next.id, title: next.title, position: resumeAt(progress.get(next.id)) } : null
  };
}

/** The set a film is in, with the films of it this person may see; null for none. */
export function setOfMovie(db: Db, identity: Identity, movieId: string) {
  const member = db.prepare("SELECT s.id, s.name FROM set_members sm JOIN sets s ON s.id = sm.set_id WHERE sm.movie_id = ?").get(movieId) as { id: string; name: string } | undefined;
  if (!member) return null;
  const films = visibleMembers(db, identity, [member.id]).get(member.id) ?? [];
  const meta = metaFor(db, films.map((film) => film.id));
  return {
    id: member.id,
    name: member.name,
    films: films.map((film) => ({ id: film.id, title: film.title, year: film.year, poster: artUrl(API, meta.get(film.id), "poster") }))
  };
}

/** The film after this one in its set, for the player's "next" card. */
export function nextInSet(db: Db, identity: Identity, movieId: string): { id: string; title: string } | null {
  const member = db.prepare("SELECT set_id FROM set_members WHERE movie_id = ?").get(movieId) as { set_id: string } | undefined;
  if (!member) return null;
  const films = visibleMembers(db, identity, [member.set_id]).get(member.set_id) ?? [];
  const at = films.findIndex((film) => film.id === movieId);
  const next = at >= 0 ? films[at + 1] : undefined;
  return next ? { id: next.id, title: next.title } : null;
}

/** A set's picture row, for the art route: only for someone who can see one of its films. */
export function setArtRow(db: Db, identity: Identity, id: string): Pick<SetRow, "poster" | "backdrop"> | null {
  const row = db.prepare("SELECT poster, backdrop FROM sets WHERE id = ?").get(id) as Pick<SetRow, "poster" | "backdrop"> | undefined;
  if (!row) return null;
  return (visibleMembers(db, identity, [id]).get(id)?.length ?? 0) > 0 ? row : null;
}
