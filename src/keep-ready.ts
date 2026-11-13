// Keep ready (home's docs/video-cache-plan.md C3): titles an admin wants
// converted ahead of time and kept, so they play with nothing converted and
// download at once. A film (every part of it), a show, or one season; at one
// or more qualities. Only an admin sets it. The app turns each title into its
// episodes or parts and asks the queue (copies.ts) to fill the versions that
// need it; one that plays as it is at a quality needs nothing. Kept versions
// of these titles are never removed by the limit (cache.ts) while marked.
import { z } from "zod";
import type { Db } from "./db.js";
import type { Rung } from "./delivery.js";

const rungSchema = z.union([z.literal(1080), z.literal(720), z.literal(480)]);

export const keepReadySchema = z.object({
  kind: z.enum(["movie", "show", "season"]),
  /** The film or the show. */
  id: z.string().min(1).max(64),
  /** For a season. */
  season: z.number().int().min(0).max(9999).nullable().optional(),
  rungs: z.array(rungSchema).min(1).max(3),
  /** A show or season: episodes added later are kept ready too. */
  newEpisodes: z.boolean().optional()
});
export type KeepReadyInput = z.infer<typeof keepReadySchema>;

export interface KeepReadyRow {
  id: string;
  kind: "movie" | "show" | "season";
  targetId: string;
  season: number | null;
  rungs: Rung[];
  newEpisodes: boolean;
  title: string;
  createdAt: string;
}

/** One episode or part a marked title stands for. */
export interface KeepItem {
  itemId: string;
  title: string;
}

interface Row {
  id: string;
  kind: KeepReadyRow["kind"];
  target_id: string;
  season: number | null;
  rungs: string;
  items: string | null;
  title: string;
  created_at: string;
}

const episodeTitle = (show: string, season: number, episode: number) =>
  `${show} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;

export class KeepReady {
  constructor(private db: Db) {}

  list(): KeepReadyRow[] {
    return (this.db.prepare("SELECT * FROM keep_ready ORDER BY created_at").all() as Row[]).map((row) => this.toRow(row));
  }

  get(id: string): KeepReadyRow | null {
    const row = this.db.prepare("SELECT * FROM keep_ready WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toRow(row) : null;
  }

  /** Marks a title (or changes its qualities); null when there is no such title. */
  set(input: KeepReadyInput): KeepReadyRow | null {
    const season = input.kind === "season" ? input.season ?? null : null;
    if (input.kind === "season" && season === null) return null;
    const title = this.titleOf(input.kind, input.id, season);
    if (title === null) return null;
    const id = input.kind === "season" ? `season:${input.id}:${season}` : `${input.kind}:${input.id}`;
    const follows = input.kind === "movie" || input.newEpisodes !== false;
    const items = follows ? null : JSON.stringify(this.expand(input.kind, input.id, season).map((item) => item.itemId));
    const rungs = JSON.stringify([...new Set(input.rungs)].sort((a, b) => b - a));
    this.db.prepare(`
      INSERT INTO keep_ready (id, kind, target_id, season, rungs, items, title) VALUES (@id, @kind, @target, @season, @rungs, @items, @title)
      ON CONFLICT (id) DO UPDATE SET rungs = excluded.rungs, items = excluded.items, title = excluded.title
    `).run({ id, kind: input.kind, target: input.id, season, rungs, items, title });
    return this.get(id);
  }

  remove(id: string): KeepReadyRow | null {
    const row = this.get(id);
    if (row) this.db.prepare("DELETE FROM keep_ready WHERE id = ?").run(id);
    return row;
  }

  /** The episodes or parts a marked title stands for now. */
  itemsOf(row: KeepReadyRow): KeepItem[] {
    const all = this.expand(row.kind, row.targetId, row.season);
    const stored = this.db.prepare("SELECT items FROM keep_ready WHERE id = ?").get(row.id) as { items: string | null } | undefined;
    if (!stored?.items) return all;
    const taken = new Set(JSON.parse(stored.items) as string[]);
    return all.filter((item) => taken.has(item.itemId));
  }

  /** `<item>:<rung>` of every version marked: the limit leaves these be. */
  pinned(): Set<string> {
    const pins = new Set<string>();
    for (const row of this.list()) {
      for (const item of this.itemsOf(row)) for (const rung of row.rungs) pins.add(`${item.itemId}:${rung}`);
    }
    return pins;
  }

  private toRow(row: Row): KeepReadyRow {
    return {
      id: row.id, kind: row.kind, targetId: row.target_id, season: row.season,
      rungs: JSON.parse(row.rungs) as Rung[], newEpisodes: row.items === null, title: row.title, createdAt: row.created_at
    };
  }

  private titleOf(kind: KeepReadyRow["kind"], id: string, season: number | null): string | null {
    if (kind === "movie") {
      const movie = this.db.prepare("SELECT title, year FROM movies WHERE id = ?").get(id) as { title: string; year: number | null } | undefined;
      return movie ? (movie.year ? `${movie.title} (${movie.year})` : movie.title) : null;
    }
    const show = this.db.prepare("SELECT title FROM shows WHERE id = ?").get(id) as { title: string } | undefined;
    if (!show) return null;
    return kind === "season" ? `${show.title} · ${season === 0 ? "Specials" : `Season ${season}`}` : show.title;
  }

  private expand(kind: KeepReadyRow["kind"], id: string, season: number | null): KeepItem[] {
    if (kind === "movie") {
      const movie = this.db.prepare("SELECT title FROM movies WHERE id = ?").get(id) as { title: string } | undefined;
      if (!movie) return [];
      // The film's own id is its first part (playback.ts partsOfMovie).
      const later = this.db.prepare("SELECT id, part FROM movie_parts WHERE movie_id = ? ORDER BY part").all(id) as { id: string; part: number }[];
      if (later.length === 0) return [{ itemId: id, title: movie.title }];
      return [{ itemId: id, title: `${movie.title} · 1` }, ...later.map((part) => ({ itemId: part.id, title: `${movie.title} · ${part.part}` }))];
    }
    const show = this.db.prepare("SELECT title FROM shows WHERE id = ?").get(id) as { title: string } | undefined;
    if (!show) return [];
    const episodes = (kind === "season"
      ? this.db.prepare("SELECT id, season, episode FROM episodes WHERE show_id = ? AND season = ? ORDER BY season, episode").all(id, season)
      : this.db.prepare("SELECT id, season, episode FROM episodes WHERE show_id = ? ORDER BY season, episode").all(id)) as { id: string; season: number; episode: number }[];
    return episodes.map((episode) => ({ itemId: episode.id, title: episodeTitle(show.title, episode.season, episode.episode) }));
  }
}
