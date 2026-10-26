// Reading a library's folders into the catalog (home's docs/video-architecture.md).
//
// Shows: every top-level folder is a show; its video files, in season folders or
// not, are episodes numbered from their names (S01E02). Movies: every top-level
// folder is a movie (its largest video file), and a loose video file is one too.
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
import { episodeFromFile, episodeTitleFromFile, parseFolderName, seasonFromFolder, sortTitle } from "./names.js";
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
    INSERT INTO shows (id, library_id, folder, title, sort_title, original_title, year, plot, premiered, status, genres, imdb_id, tmdb_id, source)
    VALUES (@id, @library, @folder, @title, @sortTitle, @originalTitle, @year, @plot, @premiered, @status, @genres, @imdbId, @tmdbId, @source)
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
  const upsertMovie = db.prepare(`
    INSERT INTO movies (id, library_id, folder, file, title, sort_title, original_title, year, plot, genres, imdb_id, tmdb_id, runtime_minutes, source, size_bytes, modified_at)
    VALUES (@id, @library, @folder, @file, @title, @sortTitle, @originalTitle, @year, @plot, @genres, @imdbId, @tmdbId, @runtime, @source, @size, @modifiedAt)
    ON CONFLICT (library_id, folder) DO UPDATE SET
      file = excluded.file, title = excluded.title, sort_title = excluded.sort_title, original_title = excluded.original_title,
      year = excluded.year, plot = excluded.plot, genres = excluded.genres, imdb_id = excluded.imdb_id, tmdb_id = excluded.tmdb_id,
      runtime_minutes = excluded.runtime_minutes, source = excluded.source, size_bytes = excluded.size_bytes,
      modified_at = excluded.modified_at, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);

  const write = db.transaction(() => {
    const seen = new Set<string>();
    for (const entry of entries) {
      let files: FoundFile[];
      let folderName: string;
      let movieDir: string;
      if (entry.isDirectory()) {
        movieDir = path.join(root, entry.name);
        files = videoFiles(movieDir, settleBefore);
        folderName = entry.name;
      } else if (entry.isFile() && isVideoFile(entry.name)) {
        movieDir = root;
        const stat = fs.statSync(path.join(root, entry.name));
        files = [{ relative: entry.name, absolute: path.join(root, entry.name), size: stat.size, modifiedAt: stat.mtime.toISOString(), growing: stat.mtimeMs > settleBefore }];
        folderName = entry.name.replace(/\.[^.]+$/, "");
      } else continue;

      const key = entry.name;
      const existing = findMovie.get(library.id, key) as { id: string } | undefined;
      const settled = files.filter((file) => !file.growing);
      summary.growing += files.length - settled.length;
      if (settled.length === 0) {
        // Still arriving: leave a catalogued one as it was, add a new one later.
        if (existing) seen.add(key);
        continue;
      }
      // The film is the biggest file; trailers and extras are smaller.
      const main = settled.reduce((best, file) => (file.size > best.size ? file : best));
      const named = parseFolderName(folderName);
      // movie.nfo in the movie's folder, else the .nfo named like the film's file.
      const nfo = (entry.isDirectory() ? readNfo(path.join(movieDir, "movie.nfo"), "movie") : null) ?? readNfo(nfoBeside(main.absolute), "movie");
      const title = nfo?.title ?? named.title;
      upsertMovie.run({
        id: existing?.id ?? newId(),
        library: library.id,
        folder: key,
        file: normalizeRelative(main.relative),
        title,
        sortTitle: sortTitle(title),
        originalTitle: nfo?.originalTitle ?? null,
        year: nfo?.year ?? named.year,
        plot: nfo?.plot ?? null,
        genres: JSON.stringify(nfo?.genres ?? []),
        imdbId: nfo?.imdbId ?? named.imdbId,
        tmdbId: nfo?.tmdbId ?? named.tmdbId,
        runtime: nfo?.runtimeMinutes ?? null,
        source: nfo ? "nfo" : "folder",
        size: main.size,
        modifiedAt: main.modifiedAt
      });
      if (!existing) summary.added++;
      seen.add(key);
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
