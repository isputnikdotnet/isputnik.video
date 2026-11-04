// A film's or show's details as the admin wrote them (home's Edit dialog), over
// what the scan found (.nfo, folder name). Kept in title_edits beside the scan's
// own values (auto_*), and written into the shows/movies row itself, so every
// reader — cards, search, sort, sets, Stremio, the TV app — sees them with no
// change of its own:
//
//   * a scan writes the found values into the row, then afterScan() takes them
//     as the new automatic ones and puts the edits back over them;
//   * a save writes edit ?? automatic into the row.
//
// A field set back to automatic (null) is the scan's again; a title with no
// edit left loses its row here.
import type { Db } from "./db.js";
import { parseGenres, resolveGenres } from "./genres.js";
import { metaFor, metaGenres } from "./metadata.js";
import { sortTitle } from "./names.js";

export type EditKind = "shows" | "movies";

interface EditRow {
  item_id: string;
  kind: EditKind;
  title: string | null;
  original_title: string | null;
  sort_title: string | null;
  year: number | null;
  plot: string | null;
  genres: string | null;
  auto_title: string;
  auto_original_title: string | null;
  auto_year: number | null;
  auto_plot: string | null;
  auto_genres: string;
}

export interface TitleEdit {
  title?: string | null;
  originalTitle?: string | null;
  sortTitle?: string | null;
  year?: number | null;
  plot?: string | null;
  genres?: string[] | null;
}

const FIELDS = ["title", "original_title", "sort_title", "year", "plot", "genres"] as const;

function kindOf(db: Db, id: string): EditKind | null {
  if (db.prepare("SELECT 1 FROM shows WHERE id = ?").get(id)) return "shows";
  if (db.prepare("SELECT 1 FROM movies WHERE id = ?").get(id)) return "movies";
  return null;
}

/** The row's values as they stand: edit over automatic. */
function writeRow(db: Db, edit: EditRow): void {
  const title = edit.title ?? edit.auto_title;
  db.prepare(`
    UPDATE ${edit.kind} SET title = ?, sort_title = ?, original_title = ?, year = ?, plot = ?, genres = ? WHERE id = ?
  `).run(
    title,
    edit.sort_title ? edit.sort_title.toLocaleLowerCase() : sortTitle(title),
    edit.original_title ?? edit.auto_original_title,
    edit.year ?? edit.auto_year,
    edit.plot ?? edit.auto_plot,
    edit.genres ?? edit.auto_genres,
    edit.item_id
  );
}

/** After a library's scan: what it found is the new automatic, the edits go back over it. */
export function afterScan(db: Db, libraryId: string): void {
  db.transaction(() => {
    for (const kind of ["shows", "movies"] as const) {
      db.prepare(`
        UPDATE title_edits SET auto_title = t.title, auto_original_title = t.original_title, auto_year = t.year,
          auto_plot = t.plot, auto_genres = t.genres
        FROM ${kind} t WHERE t.id = title_edits.item_id AND t.library_id = ?
      `).run(libraryId);
      const rows = db.prepare(`
        SELECT e.* FROM title_edits e JOIN ${kind} t ON t.id = e.item_id WHERE t.library_id = ?
      `).all(libraryId) as EditRow[];
      for (const row of rows) writeRow(db, row);
    }
    // A title the scan let go (its folder is gone) takes its edits with it.
    db.prepare(`
      DELETE FROM title_edits WHERE item_id NOT IN (SELECT id FROM shows) AND item_id NOT IN (SELECT id FROM movies)
    `).run();
  })();
}

function editRowOf(db: Db, id: string): EditRow | undefined {
  return db.prepare("SELECT * FROM title_edits WHERE item_id = ?").get(id) as EditRow | undefined;
}

const clean = (value: string | null | undefined) => {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text : null;
};
const cleanPlot = (value: string | null | undefined) => {
  const text = value?.trim();
  return text ? text : null;
};

/** Save some fields (null: back to automatic); the others stay as they are. */
export function saveEdit(db: Db, id: string, edit: TitleEdit): boolean {
  const kind = kindOf(db, id);
  if (!kind) return false;
  db.transaction(() => {
    let row = editRowOf(db, id);
    if (!row) {
      // No edit yet, so the row holds the scan's own values: those are automatic.
      const current = db.prepare(`SELECT title, original_title, year, plot, genres FROM ${kind} WHERE id = ?`).get(id) as
        { title: string; original_title: string | null; year: number | null; plot: string | null; genres: string };
      row = {
        item_id: id, kind, title: null, original_title: null, sort_title: null, year: null, plot: null, genres: null,
        auto_title: current.title, auto_original_title: current.original_title, auto_year: current.year,
        auto_plot: current.plot, auto_genres: current.genres
      };
    }
    const next: EditRow = { ...row };
    if (edit.title !== undefined) next.title = clean(edit.title);
    if (edit.originalTitle !== undefined) next.original_title = clean(edit.originalTitle);
    if (edit.sortTitle !== undefined) next.sort_title = clean(edit.sortTitle);
    if (edit.year !== undefined) next.year = edit.year ?? null;
    if (edit.plot !== undefined) next.plot = cleanPlot(edit.plot);
    if (edit.genres !== undefined) {
      const genres = [...new Set((edit.genres ?? []).map((genre) => genre.replace(/\s+/g, " ").trim()).filter(Boolean))];
      // None at all is "automatic": an empty list would only let TMDB's back in.
      next.genres = genres.length > 0 ? JSON.stringify(genres) : null;
    }
    writeRow(db, next);
    if (FIELDS.every((field) => next[field] === null)) {
      db.prepare("DELETE FROM title_edits WHERE item_id = ?").run(id);
      return;
    }
    db.prepare(`
      INSERT INTO title_edits (item_id, kind, title, original_title, sort_title, year, plot, genres,
        auto_title, auto_original_title, auto_year, auto_plot, auto_genres)
      VALUES (@item_id, @kind, @title, @original_title, @sort_title, @year, @plot, @genres,
        @auto_title, @auto_original_title, @auto_year, @auto_plot, @auto_genres)
      ON CONFLICT (item_id) DO UPDATE SET title = excluded.title, original_title = excluded.original_title,
        sort_title = excluded.sort_title, year = excluded.year, plot = excluded.plot, genres = excluded.genres,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `).run(next);
  })();
  return true;
}

interface Field<T> {
  /** What the admin wrote, or null when it is automatic. */
  edited: T | null;
  /** What it is without an edit. */
  automatic: T | null;
}

/** For the Edit dialog: each field, edited and automatic. */
export function editState(db: Db, id: string): {
  kind: EditKind;
  title: Field<string>;
  originalTitle: Field<string>;
  sortTitle: Field<string>;
  year: Field<number>;
  plot: Field<string>;
  genres: Field<string[]>;
} | null {
  const kind = kindOf(db, id);
  if (!kind) return null;
  const current = db.prepare(`SELECT title, original_title, year, plot, genres FROM ${kind} WHERE id = ?`).get(id) as
    { title: string; original_title: string | null; year: number | null; plot: string | null; genres: string };
  const row = editRowOf(db, id);
  const meta = metaFor(db, [id]).get(id);
  const autoTitle = row?.auto_title ?? current.title;
  const autoGenres = parseGenres(row?.auto_genres ?? current.genres);
  return {
    kind,
    title: { edited: row?.title ?? null, automatic: autoTitle },
    originalTitle: { edited: row?.original_title ?? null, automatic: row ? row.auto_original_title : current.original_title },
    sortTitle: { edited: row?.sort_title ?? null, automatic: sortTitle(row?.title ?? autoTitle) },
    // The scan's, else TMDB's: what the page shows without an edit.
    year: { edited: row?.year ?? null, automatic: (row ? row.auto_year : current.year) ?? meta?.year ?? null },
    plot: { edited: row?.plot ?? null, automatic: (row ? row.auto_plot : current.plot) ?? meta?.plot ?? null },
    genres: {
      edited: row?.genres ? parseGenres(row.genres) : null,
      automatic: resolveGenres(db, autoGenres.length > 0 ? autoGenres : metaGenres(meta))
    }
  };
}
