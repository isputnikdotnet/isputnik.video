// Cast and crew (home's docs/video-people-plan.md): who is in each film and show,
// found rather than made, the way sets are — a title's .nfo first (<actor>,
// <director>, <credits>: what a family wrote down wins), TMDB's credits where
// the .nfo has none, cast and crew each on its own.
//
// The raw lists stay with their sources (movies/shows.nfo_people,
// metadata.people); `people` and `credits` are worked out from them again after
// every scan and metadata pass, so they never drift from what those say.
//
// One person is one row across the library: TMDB's id names them where it is
// known ("t123"); an .nfo name without one takes the TMDB person of that name in
// the same title, else any one person in the library of that name, else a row
// of its own made from the name ("n…"). Ids are made, never drawn at random, so
// a person's page keeps its address through every rebuild.
//
// A person is only ever shown with the titles in libraries this person may see.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
import { canSee, type Identity } from "./identity.js";
import { artUrl, metaFor } from "./metadata.js";
import { BASE_PATH } from "./config.js";

const API = `${BASE_PATH}/api`;

interface RawPerson {
  tmdbId: string | null;
  name: string;
  kind: "cast" | "crew";
  role: string | null;
  profilePath: string | null;
}

/** A name as a key: case, spacing, ё and punctuation aside. */
export const personKey = (name: string) =>
  name.normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();

const parse = (raw: unknown): RawPerson[] => {
  try {
    const parsed = JSON.parse(String(raw ?? "[]")) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is RawPerson => typeof entry === "object" && entry !== null && typeof (entry as RawPerson).name === "string" && ["cast", "crew"].includes((entry as RawPerson).kind))
      : [];
  } catch {
    return [];
  }
};

const nameId = (key: string) => `n${crypto.createHash("sha1").update(key).digest("base64url").slice(0, 15)}`;

/** How many titles one slice of a whole rebuild works out before giving way. */
const SLICE = 100;

/** Work out every title's cast and crew again, a slice at a time so the engine
 *  keeps answering (a big library is tens of thousands of credits), then let go
 *  of what no title has any more. */
export async function rebuildAllCredits(db: Db, artDir: string, signal?: AbortSignal): Promise<void> {
  const ids = (db.prepare("SELECT id FROM shows UNION ALL SELECT id FROM movies").all() as { id: string }[]).map((row) => row.id);
  for (let at = 0; at < ids.length; at += SLICE) {
    if (signal?.aborted || !db.open) return;
    rebuildCredits(db, artDir, ids.slice(at, at + SLICE));
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (signal?.aborted || !db.open) return;
  rebuildCredits(db, artDir);
}

/** The titles that credit someone by name only, whose name TMDB has since given
 *  a person of (another title's cast): worked out again, so it is that person.
 *  For after a metadata pass, which works out only the titles TMDB told it new
 *  people of. */
export function relinkNamedPeople(db: Db, artDir: string): void {
  const ids = (db.prepare(`
    SELECT DISTINCT c.item_id FROM credits c JOIN people p ON p.id = c.person_id
    WHERE p.tmdb_id IS NULL AND EXISTS (SELECT 1 FROM people q WHERE q.name_key = p.name_key AND q.tmdb_id IS NOT NULL)
  `).all() as { item_id: string }[]).map((row) => row.item_id);
  rebuildCredits(db, artDir, ids);
}

/** Work out some titles' cast and crew again — or, with no ids, every title's
 *  — and let go of people none has any more, with their kept pictures. An id
 *  whose title is gone loses its credits. */
export function rebuildCredits(db: Db, artDir: string, itemIds: string[] | null = null): void {
  if (itemIds && itemIds.length === 0) return;
  // SQLite takes a few hundred parameters at once; a long list goes in slices.
  if (itemIds && itemIds.length > SLICE * 4) {
    for (let at = 0; at < itemIds.length; at += SLICE * 4) rebuildCredits(db, artDir, itemIds.slice(at, at + SLICE * 4));
    return;
  }
  const titles = (["shows", "movies"] as const).flatMap((table) => {
    const filter = itemIds ? `WHERE t.id IN (${itemIds.map(() => "?").join(", ")})` : "";
    return db.prepare(`
      SELECT t.id, t.nfo_people, COALESCE(m.people, '[]') AS tmdb_people FROM ${table} t
      LEFT JOIN metadata m ON m.item_id = t.id ${filter}
    `).all(...(itemIds ?? [])) as { id: string; nfo_people: string; tmdb_people: string }[];
  });

  const write = db.transaction(() => {
    // Who the titles being worked out credited before: those left with no title
    // after are let go. (A rebuild of every title looks at everyone.)
    const marks = itemIds ? itemIds.map(() => "?").join(", ") : "";
    const before = itemIds
      ? (db.prepare(`SELECT DISTINCT person_id FROM credits WHERE item_id IN (${marks})`).all(...itemIds) as { person_id: string }[]).map((row) => row.person_id)
      : null;
    const parsed = new Map(titles.map((title) => [title.id, { nfo: parse(title.nfo_people), tmdb: parse(title.tmdb_people) }]));

    // Names that belong to exactly one TMDB person in the library: an .nfo name
    // without an id is that person. Only the names these titles use are looked up.
    const byName = new Map<string, string | null>();
    const known = (key: string, tmdbId: string) => byName.set(key, byName.has(key) && byName.get(key) !== tmdbId ? null : tmdbId);
    if (itemIds) {
      const keys = [...new Set([...parsed.values()].flatMap(({ nfo, tmdb }) => [...nfo, ...tmdb].map((entry) => personKey(entry.name)).filter(Boolean)))];
      const lookup = db.prepare(`SELECT tmdb_id, name_key FROM people WHERE tmdb_id IS NOT NULL AND name_key IN (${Array.from({ length: SLICE }, () => "?").join(", ")})`);
      for (let at = 0; at < keys.length; at += SLICE) {
        const chunk = keys.slice(at, at + SLICE);
        while (chunk.length < SLICE) chunk.push("");
        for (const row of lookup.all(...chunk) as { tmdb_id: string; name_key: string }[]) known(row.name_key, row.tmdb_id);
      }
    } else {
      for (const row of db.prepare("SELECT tmdb_id, name_key FROM people WHERE tmdb_id IS NOT NULL").all() as { tmdb_id: string; name_key: string }[]) known(row.name_key, row.tmdb_id);
    }
    // …and those the titles being worked out name, so the first rebuild links them too.
    for (const { nfo, tmdb } of parsed.values()) {
      for (const entry of [...nfo, ...tmdb]) if (entry.tmdbId) known(personKey(entry.name), entry.tmdbId);
    }
    const upsert = db.prepare(`
      INSERT INTO people (id, tmdb_id, name, name_key, profile_path) VALUES (@id, @tmdbId, @name, @key, @profilePath)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key,
        profile_path = COALESCE(excluded.profile_path, people.profile_path)
    `);
    const insert = db.prepare("INSERT OR IGNORE INTO credits (item_id, person_id, kind, role, position, source) VALUES (?, ?, ?, ?, ?, ?)");
    const clear = db.prepare("DELETE FROM credits WHERE item_id = ?");

    // Titles asked about that are gone: their credits go with them.
    if (itemIds) for (const id of itemIds) if (!parsed.has(id)) clear.run(id);
    for (const title of titles) {
      clear.run(title.id);
      const { nfo, tmdb } = parsed.get(title.id)!;
      const tmdbByName = new Map(tmdb.filter((entry) => entry.tmdbId).map((entry) => [personKey(entry.name), entry]));
      for (const kind of ["cast", "crew"] as const) {
        const own = nfo.filter((entry) => entry.kind === kind);
        const source = own.length > 0 ? "nfo" : "tmdb";
        const list = own.length > 0 ? own : tmdb.filter((entry) => entry.kind === kind);
        list.forEach((entry, position) => {
          const key = personKey(entry.name);
          if (!key) return;
          const known = entry.tmdbId ? null : tmdbByName.get(key);
          const tmdbId = entry.tmdbId ?? known?.tmdbId ?? byName.get(key) ?? null;
          const id = tmdbId ? `t${tmdbId}` : nameId(key);
          upsert.run({ id, tmdbId, name: entry.name.trim(), key, profilePath: entry.profilePath ?? known?.profilePath ?? null });
          insert.run(title.id, id, kind, (entry.role ?? "").trim(), position, source);
        });
      }
    }

    // Credits of titles gone (a rebuild of all of them only), then people with none.
    if (!itemIds) {
      db.prepare("DELETE FROM credits WHERE item_id NOT IN (SELECT id FROM shows) AND item_id NOT IN (SELECT id FROM movies)").run();
    }
    const gone = before
      ? before.flatMap((id) => (db.prepare("SELECT p.id, p.photo FROM people p WHERE p.id = ? AND NOT EXISTS (SELECT 1 FROM credits c WHERE c.person_id = p.id)").all(id) as { id: string; photo: string | null }[]))
      : db.prepare("SELECT id, photo FROM people WHERE id NOT IN (SELECT DISTINCT person_id FROM credits)").all() as { id: string; photo: string | null }[];
    for (const person of gone) {
      if (person.photo?.startsWith("cache:")) fs.rmSync(path.join(artDir, path.basename(person.photo.slice(6))), { force: true });
      db.prepare("DELETE FROM people WHERE id = ?").run(person.id);
    }
  });
  write();
}

// ── Reading them back ──────────────────────────────────────────────────────

interface PersonRow {
  id: string;
  tmdb_id: string | null;
  name: string;
  profile_path: string | null;
  photo: string | null;
}

/** A person's picture's address, changing with the picture; null for none. */
const photoUrl = (person: Pick<PersonRow, "id" | "profile_path" | "photo">) => {
  const source = person.photo ?? person.profile_path;
  if (!source) return null;
  const version = crypto.createHash("sha1").update(source).digest("hex").slice(0, 8);
  return `${API}/people/${encodeURIComponent(person.id)}/photo?v=${version}`;
};

export interface TitleCredit {
  id: string;
  name: string;
  role: string | null;
  photo: string | null;
}

/** A title's cast in billing order, and its crew by job. */
export function creditsOf(db: Db, itemId: string): { cast: TitleCredit[]; crew: TitleCredit[] } {
  const rows = db.prepare(`
    SELECT c.kind, c.role, p.id, p.name, p.profile_path, p.photo FROM credits c JOIN people p ON p.id = c.person_id
    WHERE c.item_id = ? ORDER BY c.kind, c.position
  `).all(itemId) as (PersonRow & { kind: "cast" | "crew"; role: string })[];
  const credit = (row: (typeof rows)[number]): TitleCredit => ({ id: row.id, name: row.name, role: row.role || null, photo: photoUrl(row) });
  return {
    cast: rows.filter((row) => row.kind === "cast").map(credit),
    crew: rows.filter((row) => row.kind === "crew").map(credit)
  };
}

interface VisibleTitle {
  kind: "shows" | "movies";
  id: string;
  title: string;
  year: number | null;
  library_id: string;
}

/** The titles a person is in that this person may see, newest first. */
function titlesOf(db: Db, identity: Identity, personId: string) {
  const rows = db.prepare(`
    SELECT 'movies' AS kind, m.id, m.title, COALESCE(m.year, md.year) AS year, m.library_id, c.kind AS credit, c.role
    FROM credits c JOIN movies m ON m.id = c.item_id JOIN libraries l ON l.id = m.library_id LEFT JOIN metadata md ON md.item_id = m.id
    WHERE c.person_id = ? AND l.state = 'active'
    UNION ALL
    SELECT 'shows', s.id, s.title, COALESCE(s.year, md.year), s.library_id, c.kind, c.role
    FROM credits c JOIN shows s ON s.id = c.item_id JOIN libraries l ON l.id = s.library_id LEFT JOIN metadata md ON md.item_id = s.id
    WHERE c.person_id = ? AND l.state = 'active'
  `).all(personId, personId) as (VisibleTitle & { credit: "cast" | "crew"; role: string })[];
  const byTitle = new Map<string, VisibleTitle & { cast: string[]; crew: string[] }>();
  for (const row of rows) {
    if (!canSee(identity, row.library_id)) continue;
    const entry = byTitle.get(row.id) ?? { kind: row.kind, id: row.id, title: row.title, year: row.year, library_id: row.library_id, cast: [], crew: [] };
    entry[row.credit].push(row.role);
    byTitle.set(row.id, entry);
  }
  return [...byTitle.values()].sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title));
}

/** A person and what they are in, of what this person may see; null when nothing. */
export function getPerson(db: Db, identity: Identity, id: string) {
  const person = db.prepare("SELECT id, tmdb_id, name, profile_path, photo FROM people WHERE id = ?").get(id) as PersonRow | undefined;
  if (!person) return null;
  const titles = titlesOf(db, identity, id);
  if (titles.length === 0) return null;
  const meta = metaFor(db, titles.map((title) => title.id));
  return {
    id: person.id,
    name: person.name,
    tmdbId: person.tmdb_id,
    photo: photoUrl(person),
    titles: titles.map((title) => ({
      kind: title.kind,
      id: title.id,
      title: title.title,
      year: title.year,
      poster: artUrl(API, meta.get(title.id), "poster"),
      /** The characters played, for the cast. */
      characters: title.cast.filter(Boolean),
      /** director, writer, composer, creator. */
      jobs: title.crew.filter(Boolean),
      actor: title.cast.length > 0
    }))
  };
}

/** People whose name has these words, who are in something this person may see. */
export function searchPeople(db: Db, identity: Identity, q: string, limit: number) {
  const needle = personKey(q);
  if (!needle) return [];
  const rows = db.prepare(`
    SELECT p.id, p.tmdb_id, p.name, p.profile_path, p.photo, COUNT(DISTINCT c.item_id) AS titles,
      GROUP_CONCAT(DISTINCT COALESCE(m.library_id, s.library_id)) AS libraries
    FROM people p JOIN credits c ON c.person_id = p.id
    LEFT JOIN movies m ON m.id = c.item_id LEFT JOIN shows s ON s.id = c.item_id
    JOIN libraries l ON l.id = COALESCE(m.library_id, s.library_id) AND l.state = 'active'
    WHERE instr(p.name_key, ?) > 0
    GROUP BY p.id ORDER BY titles DESC, p.name COLLATE NOCASE LIMIT 200
  `).all(needle) as (PersonRow & { titles: number; libraries: string })[];
  return rows
    .filter((row) => row.libraries.split(",").some((library) => canSee(identity, library)))
    .slice(0, limit)
    .map((row) => ({ id: row.id, name: row.name, photo: photoUrl(row), titles: row.titles }));
}

/** Whether this person may see someone: they are in a title this person may see. */
export function personVisible(db: Db, identity: Identity, id: string): PersonRow | null {
  const person = db.prepare("SELECT id, tmdb_id, name, profile_path, photo FROM people WHERE id = ?").get(id) as PersonRow | undefined;
  return person && titlesOf(db, identity, id).length > 0 ? person : null;
}

/** A person's picture kept in the art folder, once fetched. */
export function keepPhoto(db: Db, artDir: string, person: PersonRow, bytes: Buffer): string {
  const ext = path.extname(person.profile_path ?? ".jpg").toLowerCase() || ".jpg";
  const which = crypto.createHash("sha1").update(person.profile_path ?? "").digest("hex").slice(0, 8);
  const file = `person-${person.id}-${which}${ext}`;
  fs.mkdirSync(artDir, { recursive: true });
  fs.writeFileSync(path.join(artDir, file), bytes);
  if (person.photo?.startsWith("cache:") && person.photo.slice(6) !== file) fs.rmSync(path.join(artDir, path.basename(person.photo.slice(6))), { force: true });
  db.prepare("UPDATE people SET photo = ? WHERE id = ?").run(`cache:${file}`, person.id);
  return path.join(artDir, file);
}

/** The kept picture's file, when it is still the one TMDB names. */
export function photoFile(artDir: string, person: PersonRow): string | null {
  if (!person.photo?.startsWith("cache:")) return null;
  const name = path.basename(person.photo.slice(6));
  const which = crypto.createHash("sha1").update(person.profile_path ?? "").digest("hex").slice(0, 8);
  if (person.profile_path && !name.includes(`-${which}`)) return null;
  const file = path.join(artDir, name);
  return fs.existsSync(file) ? file : null;
}

export type { PersonRow };
