// Kodi/Jellyfin .nfo files: tvshow.nfo beside a show's seasons, one .nfo per
// episode file, movie.nfo (or <file>.nfo) beside a movie. They come first: what
// a family wrote down about their own files wins over anything looked up later.
import fs from "node:fs";
import { XMLParser } from "fast-xml-parser";

/** An .nfo is a page of XML; anything bigger is not one. */
const MAX_BYTES = 1024 * 1024;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
  trimValues: true,
  // Genres, ids and actors repeat; read them as lists even when there is one.
  isArray: (name) => ["genre", "uniqueid", "actor", "director", "credits"].includes(name)
});

export interface NfoFacts {
  title: string | null;
  originalTitle: string | null;
  year: number | null;
  plot: string | null;
  premiered: string | null;
  aired: string | null;
  status: string | null;
  genres: string[];
  runtimeMinutes: number | null;
  season: number | null;
  episode: number | null;
  imdbId: string | null;
  tmdbId: string | null;
  /** The film's set (<set>), as Kodi and Emby write it; null when it has none. */
  set: { name: string; overview: string | null; tmdbId: string | null } | null;
  /** <actor> in its order, then <director> and <credits> (writers): credits.ts. */
  people: NfoPerson[];
}

export interface NfoPerson {
  name: string;
  kind: "cast" | "crew";
  /** The character, for the cast; "director" or "writer", for the crew. */
  role: string | null;
  tmdbId: string | null;
  /** A TMDB picture's path when <thumb> is one of TMDB's (image.tmdb.org/t/p/…/x.jpg). */
  profilePath: string | null;
}

const TMDB_IMAGE = /^https?:\/\/image\.tmdb\.org\/t\/p\/[a-z0-9]+(\/[A-Za-z0-9_-]{1,64}\.(?:jpg|jpeg|png|webp))$/;

function peopleOf(node: Record<string, unknown>): NfoPerson[] {
  const actors = ((node.actor as unknown[] | undefined) ?? [])
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry, at) => ({ entry, at, order: int(entry.order) }))
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.at - b.at)
    .flatMap(({ entry }): NfoPerson[] => {
      const name = text(entry.name);
      if (!name) return [];
      const tmdbId = text(entry.tmdbid);
      const thumb = TMDB_IMAGE.exec(text(entry.thumb) ?? "");
      return [{ name, kind: "cast", role: text(entry.role), tmdbId: tmdbId && TMDB_ID.test(tmdbId) ? tmdbId : null, profilePath: thumb ? thumb[1] : null }];
    });
  const crew = (tag: "director" | "credits", role: "director" | "writer"): NfoPerson[] =>
    ((node[tag] as unknown[] | undefined) ?? []).flatMap((entry) => {
      const name = text(entry);
      if (!name) return [];
      const tmdbId = typeof entry === "object" && entry ? text((entry as Record<string, unknown>)["@tmdbid"]) : null;
      return [{ name, kind: "crew" as const, role, tmdbId: tmdbId && TMDB_ID.test(tmdbId) ? tmdbId : null, profilePath: null }];
    });
  return [...actors, ...crew("director", "director"), ...crew("credits", "writer")];
}

const TMDB_ID = /^\d{1,10}$/;

/** <set>Name</set>, <set tmdbcolid="119">Name</set> or <set><name>…</name><overview>…</overview></set>,
 *  with TMDB's collection id from the set itself or the film's own tags. */
function setOf(node: Record<string, unknown>, idOf: (type: string) => string | null): NfoFacts["set"] {
  const raw = node.set;
  if (raw === undefined || raw === null) return null;
  const inner = typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const name = inner && inner.name !== undefined ? text(inner.name) : text(raw);
  if (!name) return null;
  const tmdbId = (inner ? text(inner["@tmdbcolid"]) : null) ?? text(node.tmdbcollectionid) ?? idOf("tmdbcol") ?? idOf("tmdbcollection") ?? idOf("tmdbset");
  return {
    name,
    overview: inner ? text(inner.overview) : null,
    tmdbId: tmdbId && TMDB_ID.test(tmdbId) ? tmdbId : null
  };
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") {
    const inner = (value as Record<string, unknown>)["#text"];
    return inner === undefined ? null : text(inner);
  }
  const out = String(value).trim();
  return out || null;
}

function int(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  const number = Number.parseInt(raw, 10);
  return Number.isFinite(number) ? number : null;
}

function date(value: unknown): string | null {
  const raw = text(value);
  return raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
}

/** The facts in an .nfo, or null when the file is missing, too big or not XML. */
export function readNfo(file: string, root: "tvshow" | "episodedetails" | "movie"): NfoFacts | null {
  let raw: string;
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null;
    raw = fs.readFileSync(file, "utf8");
    // A byte-order mark in front of the XML declaration (Windows editors add one).
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  } catch {
    return null;
  }
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const node = doc[root] as Record<string, unknown> | undefined;
  if (!node || typeof node !== "object") return null;

  const ids = (node.uniqueid as unknown[] | undefined) ?? [];
  const idOf = (type: string) => {
    const found = ids.find((entry) => typeof entry === "object" && entry && String((entry as Record<string, unknown>)["@type"] ?? "").toLowerCase() === type);
    return found ? text(found) : null;
  };
  const imdb = idOf("imdb") ?? text(node.imdb_id) ?? text(node.imdbid);
  const tmdb = idOf("tmdb") ?? text(node.tmdbid);
  const premiered = date(node.premiered);
  const year = int(node.year) ?? (premiered ? Number(premiered.slice(0, 4)) : null);

  return {
    title: text(node.title),
    originalTitle: text(node.originaltitle),
    year,
    plot: text(node.plot) ?? text(node.outline),
    premiered,
    aired: date(node.aired),
    status: text(node.status),
    genres: ((node.genre as unknown[] | undefined) ?? []).map(text).filter((genre): genre is string => Boolean(genre)),
    runtimeMinutes: int(node.runtime),
    season: int(node.season),
    episode: int(node.episode),
    imdbId: imdb && /^tt\d{5,10}$/.test(imdb) ? imdb : null,
    tmdbId: tmdb && TMDB_ID.test(tmdb) ? tmdb : null,
    set: root === "movie" ? setOf(node, idOf) : null,
    people: root === "episodedetails" ? [] : peopleOf(node)
  };
}
