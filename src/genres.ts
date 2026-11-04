// Genres the admin keeps: a list of their own, and the words the .nfo files and
// TMDB use mapped onto it, the way home maps a book's tags onto categories. A
// title's genres are its raw ones (the scan's, else TMDB's) passed through that
// map, in one place — resolveGenres() — which SQL reaches as genre_names(), so the
// cards, the filters, the Genre facet and Stremio all say the same.
//
// One raw word becomes:
//   1. nothing, when it is hidden ("TV Movie");
//   2. the genres it is a keyword of — one or several ("Sci-Fi & Fantasy");
//   3. the genre of that name, whatever its case;
//   4. else itself, as it came: "unsorted" until the admin places it, so nothing
//      vanishes from a card because nobody has looked at the list yet.
import crypto from "node:crypto";
import type { Db } from "./db.js";

export class GenreError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** What two spellings of one word share: case, spacing and ё don't count. */
export function genreKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

interface Mapping {
  hidden: Set<string>;
  /** keyword key → the names of its genres. */
  keywords: Map<string, string[]>;
  /** name key → the genre's name. */
  names: Map<string, string>;
}

const mappings = new WeakMap<Db, Mapping>();

function mappingOf(db: Db): Mapping {
  const cached = mappings.get(db);
  if (cached) return cached;
  const mapping: Mapping = { hidden: new Set(), keywords: new Map(), names: new Map() };
  for (const row of db.prepare("SELECT name, name_key FROM genres").all() as { name: string; name_key: string }[]) {
    mapping.names.set(row.name_key, row.name);
  }
  for (const row of db.prepare(`
    SELECT k.keyword_key, g.name FROM genre_keywords k JOIN genres g ON g.id = k.genre_id ORDER BY g.name COLLATE NOCASE
  `).all() as { keyword_key: string; name: string }[]) {
    mapping.keywords.set(row.keyword_key, [...(mapping.keywords.get(row.keyword_key) ?? []), row.name]);
  }
  for (const row of db.prepare("SELECT keyword_key FROM genre_hidden").all() as { keyword_key: string }[]) {
    mapping.hidden.add(row.keyword_key);
  }
  mappings.set(db, mapping);
  return mapping;
}

/** Read again after the list changed, or a restore replaced it. Read here and
 *  not on first use: genre_names() runs inside another query, where this
 *  connection can't run one of its own. */
export function reloadGenres(db: Db): void {
  mappings.delete(db);
  mappingOf(db);
}

type WordState = "hidden" | "keyword" | "genre" | "unsorted";

function place(mapping: Mapping, word: string): { state: WordState; genres: string[] } {
  const key = genreKey(word);
  if (!key || mapping.hidden.has(key)) return { state: "hidden", genres: [] };
  const mapped = mapping.keywords.get(key);
  if (mapped) return { state: "keyword", genres: mapped };
  const named = mapping.names.get(key);
  if (named) return { state: "genre", genres: [named] };
  return { state: "unsorted", genres: [word.trim()] };
}

/** A title's genres, from its raw ones: in their order, each once. */
export function resolveGenres(db: Db, raw: string[]): string[] {
  return resolveWith(mappingOf(db), raw);
}

function resolveWith(mapping: Mapping, raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of raw) {
    for (const genre of place(mapping, word).genres) {
      const key = genreKey(genre);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(genre);
    }
  }
  return out;
}

/** What a filter asks for, with what those words now mean: a saved row asking
 *  for "Sci-Fi" finds the films now called "Фантастика". */
export function widenGenres(db: Db, wanted: string[]): string[] {
  return [...new Set([...wanted, ...resolveGenres(db, wanted)])];
}

export const parseGenres = (raw: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
};

/** genre_names(json) in SQL: resolveGenres over a JSON array, as a JSON array. */
export function installGenreFunction(db: Db): void {
  reloadGenres(db);
  db.function("genre_names", { deterministic: false }, (raw: unknown) => {
    const mapping = mappings.get(db);
    return mapping ? JSON.stringify(resolveWith(mapping, parseGenres(raw))) : String(raw ?? "[]");
  });
}

/** A title's raw genres in SQL: the scan's own, TMDB's when it had none. */
export const rawGenresSql = (table: "shows" | "movies") =>
  `(CASE WHEN ${table}.genres != '[]' THEN ${table}.genres ELSE COALESCE((SELECT m.genres FROM metadata m WHERE m.item_id = ${table}.id), '[]') END)`;

// ── The admin's page ───────────────────────────────────────────────────────

export interface GenreSummary {
  id: string;
  name: string;
  keywords: string[];
  /** Films and shows with it, in active libraries. */
  titles: number;
}

export interface GenreWord {
  /** As a title has it (a capitalised spelling over a lower-case one). */
  value: string;
  titles: number;
  state: WordState;
  /** What it becomes on a card. */
  genres: string[];
}

/** The list, and every raw word in the libraries with what it becomes. */
export function genreOverview(db: Db): { genres: GenreSummary[]; words: GenreWord[] } {
  const mapping = mappingOf(db);
  const raws = (["shows", "movies"] as const).flatMap((table) => (db.prepare(`
    SELECT ${rawGenresSql(table)} AS raw FROM ${table} JOIN libraries l ON l.id = ${table}.library_id WHERE l.state = 'active'
  `).all() as { raw: string }[]).map((row) => parseGenres(row.raw)));

  const wordCounts = new Map<string, { value: string; titles: number }>();
  const genreCounts = new Map<string, number>();
  for (const raw of raws) {
    for (const key of new Set(raw.map(genreKey).filter(Boolean))) {
      const value = raw.find((word) => genreKey(word) === key)!.trim();
      const entry = wordCounts.get(key) ?? { value, titles: 0 };
      // "Comedy" over "comedy", whichever title came first.
      if (entry.value === entry.value.toLowerCase() && value !== value.toLowerCase()) entry.value = value;
      entry.titles += 1;
      wordCounts.set(key, entry);
    }
    for (const genre of resolveGenres(db, raw)) genreCounts.set(genreKey(genre), (genreCounts.get(genreKey(genre)) ?? 0) + 1);
  }

  const keywordRows = db.prepare(`
    SELECT genre_id, keyword FROM genre_keywords ORDER BY keyword COLLATE NOCASE
  `).all() as { genre_id: string; keyword: string }[];
  const genres = (db.prepare("SELECT id, name, name_key FROM genres ORDER BY name COLLATE NOCASE").all() as { id: string; name: string; name_key: string }[])
    .map((row) => ({
      id: row.id,
      name: row.name,
      keywords: keywordRows.filter((keyword) => keyword.genre_id === row.id).map((keyword) => keyword.keyword),
      titles: genreCounts.get(row.name_key) ?? 0
    }));

  // Hidden words show even when no title has them now, so they can be shown again.
  for (const row of db.prepare("SELECT keyword, keyword_key FROM genre_hidden").all() as { keyword: string; keyword_key: string }[]) {
    if (!wordCounts.has(row.keyword_key)) wordCounts.set(row.keyword_key, { value: row.keyword, titles: 0 });
  }
  const words = [...wordCounts.values()]
    .map((word) => ({ ...word, ...place(mapping, word.value) }))
    .sort((a, b) => a.value.localeCompare(b.value, undefined, { sensitivity: "base" }));
  return { genres, words };
}

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

function genreRow(db: Db, id: string): { id: string; name: string; name_key: string } {
  const row = db.prepare("SELECT id, name, name_key FROM genres WHERE id = ?").get(id) as { id: string; name: string; name_key: string } | undefined;
  if (!row) throw new GenreError(404, "No such genre");
  return row;
}

/** A name a genre may take: not another genre's, not a keyword of one. */
function claimName(db: Db, name: string, self: string | null): string {
  const key = genreKey(name);
  if (!key) throw new GenreError(400, "A genre needs a name");
  const other = db.prepare("SELECT name FROM genres WHERE name_key = ? AND id IS NOT ?").get(key, self) as { name: string } | undefined;
  if (other) throw new GenreError(409, `There is already a genre called "${other.name}"`);
  const keyword = db.prepare(`
    SELECT g.name FROM genre_keywords k JOIN genres g ON g.id = k.genre_id WHERE k.keyword_key = ? AND g.id IS NOT ?
  `).get(key, self) as { name: string } | undefined;
  if (keyword) throw new GenreError(409, `"${clean(name)}" is already a keyword of "${keyword.name}"`);
  return key;
}

function changed<T>(db: Db, work: () => T): T {
  try {
    return db.transaction(work)();
  } finally {
    reloadGenres(db);
  }
}

export function createGenre(db: Db, name: string): GenreSummary {
  return changed(db, () => {
    const key = claimName(db, name, null);
    const id = `genre_${crypto.randomUUID()}`;
    db.prepare("INSERT INTO genres (id, name, name_key) VALUES (?, ?, ?)").run(id, clean(name), key);
    // Named after a hidden word: it is wanted after all.
    db.prepare("DELETE FROM genre_hidden WHERE keyword_key = ?").run(key);
    // Its own name as a keyword would say nothing more.
    db.prepare("DELETE FROM genre_keywords WHERE genre_id = ? AND keyword_key = ?").run(id, key);
    return { id, name: clean(name), keywords: [], titles: 0 };
  });
}

/** A new name; the old one stays as a keyword, so titles and saved rows that
 *  still say it find their way here. */
export function renameGenre(db: Db, id: string, name: string): void {
  changed(db, () => {
    const row = genreRow(db, id);
    const key = claimName(db, name, id);
    db.prepare("UPDATE genres SET name = ?, name_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(clean(name), key, id);
    db.prepare("DELETE FROM genre_keywords WHERE genre_id = ? AND keyword_key = ?").run(id, key);
    if (row.name_key !== key) {
      db.prepare("INSERT OR IGNORE INTO genre_keywords (keyword_key, keyword, genre_id) VALUES (?, ?, ?)").run(row.name_key, row.name, id);
    }
  });
}

/** Gone, and titles lose it: its name and its keywords are hidden, unless a
 *  keyword still leads to another genre. */
export function deleteGenre(db: Db, id: string): void {
  changed(db, () => {
    const row = genreRow(db, id);
    const keywords = db.prepare(`
      SELECT keyword_key, keyword FROM genre_keywords k
      WHERE genre_id = ? AND NOT EXISTS (SELECT 1 FROM genre_keywords o WHERE o.keyword_key = k.keyword_key AND o.genre_id != k.genre_id)
    `).all(id) as { keyword_key: string; keyword: string }[];
    const hide = db.prepare("INSERT OR IGNORE INTO genre_hidden (keyword_key, keyword) VALUES (?, ?)");
    hide.run(row.name_key, row.name);
    for (const keyword of keywords) hide.run(keyword.keyword_key, keyword.keyword);
    db.prepare("DELETE FROM genres WHERE id = ?").run(id);
  });
}

/** One genre into another: its titles, keywords and name all lead there now. */
export function mergeGenre(db: Db, id: string, intoId: string): void {
  if (id === intoId) throw new GenreError(400, "A genre can't be merged into itself");
  changed(db, () => {
    const row = genreRow(db, id);
    const into = genreRow(db, intoId);
    db.prepare(`
      INSERT OR IGNORE INTO genre_keywords (keyword_key, keyword, genre_id)
      SELECT keyword_key, keyword, ? FROM genre_keywords WHERE genre_id = ? AND keyword_key != ?
    `).run(into.id, id, into.name_key);
    db.prepare("DELETE FROM genres WHERE id = ?").run(id);
    db.prepare("INSERT OR IGNORE INTO genre_keywords (keyword_key, keyword, genre_id) VALUES (?, ?, ?)").run(row.name_key, row.name, into.id);
  });
}

export function addKeyword(db: Db, id: string, keyword: string): void {
  changed(db, () => {
    const genre = genreRow(db, id);
    const key = genreKey(keyword);
    if (!key) throw new GenreError(400, "A keyword needs some letters");
    if (key === genre.name_key) return;
    const named = db.prepare("SELECT name FROM genres WHERE name_key = ?").get(key) as { name: string } | undefined;
    if (named) throw new GenreError(409, `"${named.name}" is a genre of its own. Merge it instead.`);
    db.prepare("DELETE FROM genre_hidden WHERE keyword_key = ?").run(key);
    db.prepare("INSERT OR IGNORE INTO genre_keywords (keyword_key, keyword, genre_id) VALUES (?, ?, ?)").run(key, clean(keyword), id);
  });
}

export function removeKeyword(db: Db, id: string, keyword: string): void {
  changed(db, () => {
    genreRow(db, id);
    db.prepare("DELETE FROM genre_keywords WHERE genre_id = ? AND keyword_key = ?").run(id, genreKey(keyword));
  });
}

/** A word no card should show ("TV Movie"). */
export function hideWord(db: Db, word: string): void {
  changed(db, () => {
    const key = genreKey(word);
    if (!key) throw new GenreError(400, "Nothing to hide");
    const named = db.prepare("SELECT name FROM genres WHERE name_key = ?").get(key) as { name: string } | undefined;
    if (named) throw new GenreError(409, `"${named.name}" is a genre. Delete it instead.`);
    db.prepare("DELETE FROM genre_keywords WHERE keyword_key = ?").run(key);
    db.prepare("INSERT OR IGNORE INTO genre_hidden (keyword_key, keyword) VALUES (?, ?)").run(key, clean(word));
  });
}

export function showWord(db: Db, word: string): void {
  changed(db, () => {
    db.prepare("DELETE FROM genre_hidden WHERE keyword_key = ?").run(genreKey(word));
  });
}

// ── A list to start from ───────────────────────────────────────────────────

// TMDB's own genres, films' and shows', in both languages its answers come in,
// with the spellings .nfo files tend to use. Its TV genres that are two at once
// are split, and "TV Movie" says nothing a family wants to browse by.
const SEED: { en: string; ru: string; also?: string[] }[] = [
  { en: "Action", ru: "Боевик", also: ["Боевики"] },
  { en: "Adventure", ru: "Приключения" },
  { en: "Animation", ru: "Мультфильм", also: ["Анимация", "Мультфильмы", "Мультсериал", "Cartoon", "Anime", "Аниме"] },
  { en: "Comedy", ru: "Комедия", also: ["Комедии"] },
  { en: "Crime", ru: "Криминал" },
  { en: "Documentary", ru: "Документальный", also: ["Документальные", "Документальный фильм", "Документалистика"] },
  { en: "Drama", ru: "Драма", also: ["Драмы"] },
  { en: "Family", ru: "Семейный", also: ["Семейные", "Семейное"] },
  { en: "Fantasy", ru: "Фэнтези" },
  { en: "History", ru: "История", also: ["Исторический", "Исторические"] },
  { en: "Horror", ru: "Ужасы" },
  { en: "Music", ru: "Музыка", also: ["Музыкальный", "Musical", "Мюзикл", "Concert", "Концерт"] },
  { en: "Mystery", ru: "Детектив", also: ["Детективы"] },
  { en: "Romance", ru: "Мелодрама", also: ["Мелодрамы", "Романтика"] },
  { en: "Science Fiction", ru: "Фантастика", also: ["Sci-Fi", "SciFi", "Science-Fiction", "Научная фантастика"] },
  { en: "Thriller", ru: "Триллер", also: ["Триллеры"] },
  { en: "War", ru: "Военный", also: ["Военные", "Военное"] },
  { en: "Western", ru: "Вестерн", also: ["Вестерны"] },
  { en: "Kids", ru: "Детский", also: ["Детские", "Children"] },
  { en: "Reality", ru: "Реалити-шоу", also: ["Реалити"] },
  { en: "News", ru: "Новости" },
  { en: "Talk", ru: "Ток-шоу", also: ["Talk Show"] },
  { en: "Soap", ru: "Мыльная опера", also: ["Soap Opera"] },
  { en: "Politics", ru: "Политика" }
];
const SPLIT: { words: string[]; into: string[] }[] = [
  { words: ["Action & Adventure", "Боевик и Приключения", "Боевик и приключения"], into: ["Action", "Adventure"] },
  { words: ["Sci-Fi & Fantasy", "НФ и Фэнтези", "НФ и фэнтези"], into: ["Science Fiction", "Fantasy"] },
  { words: ["War & Politics", "Война и Политика", "Война и политика"], into: ["War", "Politics"] }
];
const HIDDEN = ["TV Movie", "Телевизионный фильм"];

/** TMDB's genres named in one language, the other's names as keywords: only
 *  onto an empty list, never over the admin's own. */
export function seedGenres(db: Db, language: "en" | "ru"): number {
  return changed(db, () => {
    if ((db.prepare("SELECT COUNT(*) AS n FROM genres").get() as { n: number }).n > 0) {
      throw new GenreError(409, "The genre list isn't empty, so nothing was added");
    }
    const ids = new Map<string, string>();
    const insertGenre = db.prepare("INSERT INTO genres (id, name, name_key) VALUES (?, ?, ?)");
    const insertKeyword = db.prepare("INSERT OR IGNORE INTO genre_keywords (keyword_key, keyword, genre_id) VALUES (?, ?, ?)");
    for (const genre of SEED) {
      const id = `genre_${crypto.randomUUID()}`;
      const name = genre[language];
      ids.set(genre.en, id);
      insertGenre.run(id, name, genreKey(name));
      for (const word of [genre.en, genre.ru, ...(genre.also ?? [])]) {
        if (genreKey(word) !== genreKey(name)) insertKeyword.run(genreKey(word), word, id);
      }
    }
    for (const split of SPLIT) {
      for (const word of split.words) for (const into of split.into) insertKeyword.run(genreKey(word), word, ids.get(into)!);
    }
    db.prepare("DELETE FROM genre_hidden").run();
    const hide = db.prepare("INSERT OR IGNORE INTO genre_hidden (keyword_key, keyword) VALUES (?, ?)");
    for (const word of HIDDEN) hide.run(genreKey(word), word);
    return SEED.length;
  });
}
