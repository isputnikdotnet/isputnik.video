// Reading a library's folders into the catalog (home's docs/video-architecture.md).
//
// Shows: every top-level folder is a show; its video files, in season folders or
// not, are episodes numbered from their names (S01E02). Movies: a loose video file
// is a film, and a top-level folder is usually one too (its largest video file,
// trailers and extras aside). A folder may also hold a set of films, which become
// a set named after it, and a film may be split across files (filmsIn).
// .nfo files describe what they sit beside and win over the names.
//
// Ids survive a rescan — a show is found again by its folder, an episode by its
// file — because home's tags and the family's watch progress point at them.
//
// A file still being written (a copy in progress) is left out until it has been
// still for a while, so a half-copied season is never catalogued as something
// else. A file already in the catalog that is being replaced stays as it was.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
import { isIgnoredName, isVideoFile, normalizeRelative, resolveInside } from "./media.js";
import { episodeFromFile, episodeTitleFromFile, isExtraFile, isPartFolder, parseFolderName, partFromName, seasonFromFolder, sortTitle, type NameFacts } from "./names.js";
import { readNfo } from "./nfo.js";

/** How long a file must have been left alone before it counts as copied. */
export const SETTLE_MS = 2 * 60 * 1000;
/** Deep enough for Show/Season/Extras/file; a deeper tree is not a show. */
const MAX_DEPTH = 4;

export interface ScanOptions {
  now?: number;
  settleMs?: number;
}

export interface ScanSummary {
  /** Shows or movies in the catalog after the scan. */
  titles: number;
  episodes: number;
  added: number;
  removed: number;
  /** Video files left out because they are still being written. */
  growing: number;
  /** Video files in a show whose season and episode could not be read. */
  unnumbered: number;
}

export class ScanError extends Error {}

interface LibraryRow {
  id: string;
  kind: "shows" | "movies";
  folder: string;
}

interface FoundFile {
  /** Relative to the show or movie folder. */
  relative: string;
  absolute: string;
  size: number;
  modifiedAt: string;
  growing: boolean;
}

const newId = () => crypto.randomBytes(12).toString("base64url");

function videoFiles(dir: string, settleBefore: number, depth = 0, prefix = ""): FoundFile[] {
  if (depth > MAX_DEPTH) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: FoundFile[] = [];
  for (const entry of entries) {
    if (isIgnoredName(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...videoFiles(absolute, settleBefore, depth + 1, relative));
    } else if (entry.isFile() && isVideoFile(entry.name)) {
      const stat = fs.statSync(absolute);
      found.push({ relative, absolute, size: stat.size, modifiedAt: stat.mtime.toISOString(), growing: stat.mtimeMs > settleBefore });
    }
  }
  return found;
}

/** The .nfo beside a video file: same name, .nfo. */
function nfoBeside(file: string): string {
  return file.replace(/\.[^.\\/]+$/, ".nfo");
}

/** A file this much smaller than the biggest beside it is not a film of its own:
 *  a making-of nobody named as one. */
const SMALLEST_FILM = 1 / 5;
/** A disc copied as it is: its many files are one film. */
const DISC_FOLDER = /(?:^|\/)(?:BDMV|VIDEO_TS)\//i;

interface Film {
  /** The whole film's file, or its first part. */
  main: FoundFile;
  /** The parts after the first, in order. */
  parts: { part: number; file: FoundFile }[];
  named: NameFacts;
  /** Where the name puts it among the films beside it. */
  order: number | null;
}

const biggest = (files: FoundFile[]) => files.reduce((best, file) => (file.size > best.size ? file : best));
const stemOf = (file: string) => path.basename(file).replace(/\.[^.]+$/, "");

/** What a file's film is called: a film in a sub-folder of its own goes by that
 *  folder, and a "CD1" folder only adds which part it is. */
function nameOf(file: FoundFile, features: FoundFile[], folderName: string): string {
  const parts = file.relative.split("/");
  if (parts.length === 1) return stemOf(file.relative);
  const parent = parts[parts.length - 2];
  if (isPartFolder(parent)) return `${parts.length > 2 ? parts[parts.length - 3] : folderName} ${parent}`;
  const dir = `${parts.slice(0, -1).join("/")}/`;
  return features.filter((other) => other.relative.startsWith(dir)).length === 1 ? parent : stemOf(file.relative);
}

/** Two .nfo files that name a film differently: separate films, whatever the file names say. */
function nfosDisagree(files: FoundFile[]): boolean {
  const titles = files.map((file) => readNfo(nfoBeside(file.absolute), "movie")?.title).filter(Boolean);
  return new Set(titles).size > 1;
}

/** The films among some video files, in the order of their files.
 *
 *  Files whose names differ only by a part number, counting from 1, are one film
 *  in parts. Files that come down to the same name without one are copies of a
 *  film, and the biggest is kept. Any others are films of their own. */
function filmsIn(files: FoundFile[], options: { folderName: string; beside: boolean }): Film[] {
  if (files.length === 0) return [];
  const whole = (main: FoundFile, named: NameFacts, order: number | null = null): Film => ({ main, parts: [], named, order });
  if (options.beside && files.some((file) => DISC_FOLDER.test(file.relative))) {
    return [whole(biggest(files), parseFolderName(options.folderName))];
  }
  let features = options.beside ? files.filter((file) => !isExtraFile(file.relative)) : files;
  if (features.length === 0) features = [biggest(files)];
  if (options.beside) {
    const limit = biggest(features).size * SMALLEST_FILM;
    features = features.filter((file) => file.size >= limit);
  }

  const groups = new Map<string, { source: string; file: FoundFile; part: number | null; named: NameFacts }[]>();
  for (const file of [...features].sort((a, b) => a.relative.localeCompare(b.relative, undefined, { numeric: true }))) {
    const source = nameOf(file, features, options.folderName);
    const part = partFromName(source);
    // "Part 1.mkv" is a part of whatever its folder is called.
    const bare = part !== null && !part.title;
    const named: NameFacts = part && !bare ? part : parseFolderName(bare && options.folderName ? options.folderName : source);
    const key = `${named.title.normalize("NFC").toLocaleLowerCase()}|${named.year ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), { source, file, part: part && (!bare || options.folderName) ? part.part : null, named }]);
  }

  const films: Film[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      // Two films of one name but for their years ("Deathly Hallows Part 1 (2010)", "… Part 2 (2011)") keep their whole names.
      const { source, file, part, named } = group[0];
      const twin = part !== null && [...groups.values()].some((other) => other !== group && other[0].named.title === named.title);
      films.push(whole(file, twin ? parseFolderName(source) : named, part));
      continue;
    }
    const numbered = new Map<number, FoundFile>();
    for (const { file, part } of group) {
      if (part === null) continue;
      const taken = numbered.get(part);
      if (!taken || file.size > taken.size) numbered.set(part, file);
    }
    const order = [...numbered.keys()].sort((a, b) => a - b);
    const consecutive = order.length >= 2 && order.every((part, at) => part === at + 1);
    if (consecutive && !nfosDisagree([...numbered.values()])) {
      films.push({
        main: numbered.get(1)!,
        parts: order.slice(1).map((part) => ({ part, file: numbered.get(part)! })),
        named: group[0].named,
        order: null
      });
      continue;
    }
    // Not parts of one film ("The Godfather", "The Godfather Part 2"): each keeps its whole name.
    const copies = group.filter((entry) => entry.part === null);
    if (copies.length > 0) films.push(whole(biggest(copies.map((entry) => entry.file)), copies[0].named));
    for (const { source, file, part } of group) {
      if (part !== null) films.push(whole(file, parseFolderName(source), part));
    }
  }
  return films;
}

export function scanLibrary(db: Db, mediaRoot: string, libraryId: string, options: ScanOptions = {}): ScanSummary {
  const library = db.prepare("SELECT id, kind, folder FROM libraries WHERE id = ?").get(libraryId) as LibraryRow | undefined;
  if (!library) throw new ScanError("No such library");
  const root = resolveInside(mediaRoot, library.folder);
  if (!root || !fs.statSync(root).isDirectory()) throw new ScanError(`The folder "${library.folder}" is not there on the video app`);
  const settleBefore = (options.now ?? Date.now()) - (options.settleMs ?? SETTLE_MS);
  return library.kind === "shows" ? scanShows(db, library, root, settleBefore) : scanMovies(db, library, root, settleBefore);
}

function scanShows(db: Db, library: LibraryRow, root: string, settleBefore: number): ScanSummary {
  const summary: ScanSummary = { titles: 0, episodes: 0, added: 0, removed: 0, growing: 0, unnumbered: 0 };
  const folders = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !isIgnoredName(entry.name)).map((entry) => entry.name);

  const findShow = db.prepare("SELECT id FROM shows WHERE library_id = ? AND folder = ?");
  const insertShow = db.prepare(`
    INSERT INTO shows (id, library_id, folder, title, sort_title, original_title, year, plot, premiered, status, genres, imdb_id, tmdb_id, source, added_at)
    VALUES (@id, @library, @folder, @title, @sortTitle, @originalTitle, @year, @plot, @premiered, @status, @genres, @imdbId, @tmdbId, @source, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `);
  const updateShow = db.prepare(`
    UPDATE shows SET title = @title, sort_title = @sortTitle, original_title = @originalTitle, year = @year, plot = @plot,
      premiered = @premiered, status = @status, genres = @genres, imdb_id = @imdbId, tmdb_id = @tmdbId, source = @source,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = @id
  `);
  const findEpisode = db.prepare("SELECT id FROM episodes WHERE show_id = ? AND file = ?");
  const upsertEpisode = db.prepare(`
    INSERT INTO episodes (id, show_id, season, episode, file, title, plot, aired, runtime_minutes, size_bytes, modified_at)
    VALUES (@id, @show, @season, @episode, @file, @title, @plot, @aired, @runtime, @size, @modifiedAt)
    ON CONFLICT (show_id, file) DO UPDATE SET
      season = excluded.season, episode = excluded.episode, title = excluded.title, plot = excluded.plot,
      aired = excluded.aired, runtime_minutes = excluded.runtime_minutes, size_bytes = excluded.size_bytes,
      modified_at = excluded.modified_at, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);

  const write = db.transaction(() => {
    const kept = new Set<string>();
    for (const folder of folders) {
      const showDir = path.join(root, folder);
      const files = videoFiles(showDir, settleBefore);
      const settled = files.filter((file) => !file.growing);
      summary.growing += files.length - settled.length;
      const existing = findShow.get(library.id, folder) as { id: string } | undefined;
      // A show still arriving, not yet in the catalog: next scan.
      if (!existing && settled.length === 0) continue;

      const named = parseFolderName(folder);
      const nfo = readNfo(path.join(showDir, "tvshow.nfo"), "tvshow");
      const title = nfo?.title ?? named.title;
      const row = {
        id: existing?.id ?? newId(),
        library: library.id,
        folder,
        title,
        sortTitle: sortTitle(title),
        originalTitle: nfo?.originalTitle ?? null,
        year: nfo?.year ?? named.year,
        plot: nfo?.plot ?? null,
        premiered: nfo?.premiered ?? null,
        status: nfo?.status ?? null,
        genres: JSON.stringify(nfo?.genres ?? []),
        imdbId: nfo?.imdbId ?? named.imdbId,
        tmdbId: nfo?.tmdbId ?? named.tmdbId,
        source: nfo ? "nfo" : "folder"
      };
      if (existing) updateShow.run(row);
      else {
        insertShow.run(row);
        summary.added++;
      }
      kept.add(row.id);

      const keepFiles = new Set(files.map((file) => normalizeRelative(file.relative)));
      for (const file of settled) {
        const relative = normalizeRelative(file.relative);
        const parts = relative.split("/");
        const folderSeason = parts.length > 1 ? seasonFromFolder(parts[parts.length - 2]) : null;
        const fromName = episodeFromFile(parts[parts.length - 1]);
        const epNfo = readNfo(nfoBeside(file.absolute), "episodedetails");
        const season = epNfo?.season ?? fromName?.season ?? folderSeason;
        const episode = epNfo?.episode ?? fromName?.episode ?? null;
        if (season === null || episode === null) {
          summary.unnumbered++;
          keepFiles.delete(relative);
          continue;
        }
        const known = findEpisode.get(row.id, relative) as { id: string } | undefined;
        upsertEpisode.run({
          id: known?.id ?? newId(),
          show: row.id,
          season,
          episode,
          file: relative,
          title: epNfo?.title ?? episodeTitleFromFile(parts[parts.length - 1]),
          plot: epNfo?.plot ?? null,
          aired: epNfo?.aired ?? null,
          runtime: epNfo?.runtimeMinutes ?? null,
          size: file.size,
          modifiedAt: file.modifiedAt
        });
      }
      // Episodes whose file is gone. One still being rewritten keeps its row.
      const rows = db.prepare("SELECT id, file FROM episodes WHERE show_id = ?").all(row.id) as { id: string; file: string }[];
      for (const episodeRow of rows) {
        if (!keepFiles.has(episodeRow.file)) db.prepare("DELETE FROM episodes WHERE id = ?").run(episodeRow.id);
      }
    }
    // Shows whose folder is gone.
    const all = db.prepare("SELECT id FROM shows WHERE library_id = ?").all(library.id) as { id: string }[];
    for (const show of all) {
      if (!kept.has(show.id)) {
        db.prepare("DELETE FROM shows WHERE id = ?").run(show.id);
        summary.removed++;
      }
    }
  });
  write();

  summary.titles = (db.prepare("SELECT COUNT(*) AS n FROM shows WHERE library_id = ?").get(library.id) as { n: number }).n;
  summary.episodes = (db.prepare("SELECT COUNT(*) AS n FROM episodes e JOIN shows s ON s.id = e.show_id WHERE s.library_id = ?").get(library.id) as { n: number }).n;
  return summary;
}

function scanMovies(db: Db, library: LibraryRow, root: string, settleBefore: number): ScanSummary {
  const summary: ScanSummary = { titles: 0, episodes: 0, added: 0, removed: 0, growing: 0, unnumbered: 0 };
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => !isIgnoredName(entry.name));

  const findMovie = db.prepare("SELECT id FROM movies WHERE library_id = ? AND folder = ?");
  const moveMovie = db.prepare("UPDATE movies SET folder = ? WHERE id = ?");
  const upsertMovie = db.prepare(`
    INSERT INTO movies (id, library_id, folder, file, title, sort_title, original_title, year, plot, genres, imdb_id, tmdb_id, runtime_minutes, set_name, set_overview, set_tmdb_id, set_order, source, size_bytes, modified_at, added_at)
    VALUES (@id, @library, @folder, @file, @title, @sortTitle, @originalTitle, @year, @plot, @genres, @imdbId, @tmdbId, @runtime, @setName, @setOverview, @setTmdbId, @setOrder, @source, @size, @modifiedAt, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT (library_id, folder) DO UPDATE SET
      file = excluded.file, title = excluded.title, sort_title = excluded.sort_title, original_title = excluded.original_title,
      year = excluded.year, plot = excluded.plot, genres = excluded.genres, imdb_id = excluded.imdb_id, tmdb_id = excluded.tmdb_id,
      runtime_minutes = excluded.runtime_minutes, set_name = excluded.set_name, set_overview = excluded.set_overview,
      set_tmdb_id = excluded.set_tmdb_id, set_order = excluded.set_order, source = excluded.source, size_bytes = excluded.size_bytes,
      modified_at = excluded.modified_at, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);
  const findPart = db.prepare("SELECT id FROM movie_parts WHERE movie_id = ? AND file = ?");
  const upsertPart = db.prepare(`
    INSERT INTO movie_parts (id, movie_id, part, file, size_bytes, modified_at)
    VALUES (@id, @movie, @part, @file, @size, @modifiedAt)
    ON CONFLICT (movie_id, file) DO UPDATE SET part = excluded.part, size_bytes = excluded.size_bytes, modified_at = excluded.modified_at
  `);

  const write = db.transaction(() => {
    const seen = new Set<string>();
    // Each film by where its file is, so one found again under another `folder`
    // (its folder has gained a film, or lost one) keeps its id, and with it everyone's place.
    const catalogued = db.prepare("SELECT id, folder, file FROM movies WHERE library_id = ?").all(library.id) as { id: string; folder: string; file: string }[];
    const atPath = new Map(catalogued.map((movie) => [movie.folder === movie.file ? movie.file : `${movie.folder}/${movie.file}`, movie]));

    const place = (film: Film, facts: { folder: string; prefix: string; ownFolder: string | null; setName: string | null; named: NameFacts }, growing: Set<string>) => {
      const file = `${facts.prefix}${normalizeRelative(film.main.relative)}`;
      const existing = (findMovie.get(library.id, facts.folder) as { id: string } | undefined) ?? atPath.get(facts.folder === file ? file : `${facts.folder}/${file}`);
      if (existing) moveMovie.run(facts.folder, existing.id);
      const nfo = (facts.ownFolder ? readNfo(path.join(facts.ownFolder, "movie.nfo"), "movie") : null) ?? readNfo(nfoBeside(film.main.absolute), "movie");
      const title = nfo?.title ?? facts.named.title;
      const id = existing?.id ?? newId();
      upsertMovie.run({
        id,
        library: library.id,
        folder: facts.folder,
        file,
        title,
        sortTitle: sortTitle(title),
        originalTitle: nfo?.originalTitle ?? null,
        year: nfo?.year ?? facts.named.year,
        plot: nfo?.plot ?? null,
        genres: JSON.stringify(nfo?.genres ?? []),
        imdbId: nfo?.imdbId ?? facts.named.imdbId,
        tmdbId: nfo?.tmdbId ?? facts.named.tmdbId,
        runtime: nfo?.runtimeMinutes ?? null,
        setName: nfo?.set?.name ?? facts.setName,
        setOverview: nfo?.set?.overview ?? null,
        setTmdbId: nfo?.set?.tmdbId ?? null,
        setOrder: film.order,
        source: nfo ? "nfo" : "folder",
        size: film.parts.reduce((sum, { file: part }) => sum + part.size, film.main.size),
        modifiedAt: film.main.modifiedAt
      });
      if (!existing) summary.added++;
      seen.add(facts.folder);

      // Its parts. One gone goes; one still being rewritten keeps its row.
      const keepParts = new Set(growing);
      for (const { part, file: found } of film.parts) {
        const partFile = `${facts.prefix}${normalizeRelative(found.relative)}`;
        keepParts.add(partFile);
        const known = findPart.get(id, partFile) as { id: string } | undefined;
        upsertPart.run({ id: known?.id ?? newId(), movie: id, part, file: partFile, size: found.size, modifiedAt: found.modifiedAt });
      }
      const parts = db.prepare("SELECT id, file FROM movie_parts WHERE movie_id = ?").all(id) as { id: string; file: string }[];
      for (const row of parts) {
        if (!keepParts.has(row.file)) db.prepare("DELETE FROM movie_parts WHERE id = ?").run(row.id);
      }
    };

    /** A file on its way that is already catalogued: its film stays as it was.
     *  Returns those files, relative to the folder they were found in. */
    const keepGrowing = (files: FoundFile[], prefix: string): Set<string> => {
      const growing = new Set<string>();
      for (const file of files) {
        if (!file.growing) continue;
        const relative = normalizeRelative(file.relative);
        growing.add(relative);
        const movie = atPath.get(`${prefix}${relative}`);
        if (movie) seen.add(movie.folder);
      }
      summary.growing += growing.size;
      return growing;
    };

    const loose: FoundFile[] = [];
    for (const entry of entries) {
      if (entry.isFile() && isVideoFile(entry.name)) {
        const absolute = path.join(root, entry.name);
        const stat = fs.statSync(absolute);
        loose.push({ relative: entry.name, absolute, size: stat.size, modifiedAt: stat.mtime.toISOString(), growing: stat.mtimeMs > settleBefore });
      }
      if (!entry.isDirectory()) continue;

      const movieDir = path.join(root, entry.name);
      const files = videoFiles(movieDir, settleBefore);
      const settled = files.filter((file) => !file.growing);
      const growing = keepGrowing(files, `${entry.name}/`);
      if (settled.length === 0) {
        // Still arriving: leave what is catalogued as it was, add a new one later.
        for (const movie of catalogued) {
          if (movie.folder === entry.name || movie.folder.startsWith(`${entry.name}/`)) seen.add(movie.folder);
        }
        continue;
      }
      let films = filmsIn(settled, { folderName: entry.name, beside: true });
      // movie.nfo in the folder says the folder is one film: the one with the biggest file.
      if (films.length > 1 && readNfo(path.join(movieDir, "movie.nfo"), "movie")) {
        const top = biggest(settled);
        const film = films.find((candidate) => candidate.main === top || candidate.parts.some(({ file }) => file === top));
        films = [film ?? films[0]];
      }
      if (films.length === 1) {
        place(films[0], { folder: entry.name, prefix: "", ownFolder: movieDir, setName: null, named: parseFolderName(entry.name) }, growing);
        continue;
      }
      // A folder of films: a set named after it, each film under its own path.
      const prefix = `${entry.name}/`;
      const prefixed = new Set([...growing].map((file) => `${prefix}${file}`));
      for (const film of films) {
        const relative = normalizeRelative(film.main.relative);
        const nested = relative.includes("/") ? path.dirname(film.main.absolute) : null;
        place(film, { folder: `${prefix}${relative}`, prefix, ownFolder: nested, setName: parseFolderName(entry.name).title, named: film.named }, prefixed);
      }
    }

    // Loose files, which may be the parts of one film; never a set: they share only the library.
    const settledLoose = loose.filter((file) => !file.growing);
    const growingLoose = keepGrowing(loose, "");
    for (const film of filmsIn(settledLoose, { folderName: "", beside: false })) {
      const relative = normalizeRelative(film.main.relative);
      place(film, { folder: relative, prefix: "", ownFolder: null, setName: null, named: film.named }, growingLoose);
    }

    const all = db.prepare("SELECT id, folder FROM movies WHERE library_id = ?").all(library.id) as { id: string; folder: string }[];
    for (const movie of all) {
      if (!seen.has(movie.folder)) {
        db.prepare("DELETE FROM movies WHERE id = ?").run(movie.id);
        summary.removed++;
      }
    }
  });
  write();

  summary.titles = (db.prepare("SELECT COUNT(*) AS n FROM movies WHERE library_id = ?").get(library.id) as { n: number }).n;
  return summary;
}
