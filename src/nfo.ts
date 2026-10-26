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
  isArray: (name) => ["genre", "uniqueid", "actor"].includes(name)
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
    tmdbId: tmdb && /^\d{1,10}$/.test(tmdb) ? tmdb : null
  };
}
