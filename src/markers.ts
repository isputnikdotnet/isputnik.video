// Where a title's intro and credits are (home's docs/video-skip-plan.md), so the
// player can offer Skip intro and bring its next-episode card up when the credits
// start. In this order, each kind on its own:
//
// - a mark an admin set in home's player (the markers table): the episode's or
//   film's own, else its season's;
// - an .edl beside the video: Kodi's edit list, which intro-skipper tools write;
// - chapters inside the file, by their names. An unnamed "Chapter 3" says nothing;
// - what the engine found by itself (detect.ts, the detected_markers table).
//
// The files' are worked out when asked, never stored: reading both is cheap (the
// chapters come with the probe media_probe keeps) and a new .edl counts at once.
// All times are seconds from the start of the file, the clock the player runs on.
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
import type { MediaChapter, MediaInfo } from "./ffmpeg.js";

export type MarkerSource = "manual" | "edl" | "chapter" | "detected";
/** A mark for this episode or film alone, or for every episode of its season. */
export type MarkScope = "episode" | "season";
export type MarkerKind = "intro" | "credits" | "recap";

export interface Markers {
  /** "Previously on": an episode's own, never a season's (each is its own length). */
  recap: { start: number; end: number; source: MarkerSource; scope?: MarkScope } | null;
  /** `scope` says where a mark by hand is kept, so it can be cleared there. */
  intro: { start: number; end: number; source: MarkerSource; scope?: MarkScope } | null;
  /** To the end of the file. */
  credits: { start: number; source: MarkerSource; scope?: MarkScope } | null;
}

export const NO_MARKERS: Markers = { recap: null, intro: null, credits: null };

/** An .edl is a few lines; anything bigger is not one. */
const MAX_EDL_BYTES = 64 * 1024;
/** Shorter than this is a glitch, not something to skip. */
const MIN_INTRO_S = 3;
/** An .edl's last cut counts as reaching the end from this close to it. */
const END_SLACK_S = 5;

const INTRO_NAMES = new Set([
  "intro", "introduction", "opening", "op", "opening credits", "opening theme", "opening titles", "title sequence",
  "вступление", "заставка", "начальные титры", "интро", "опенинг"
]);
const CREDITS_NAMES = new Set([
  "credits", "end credits", "closing credits", "ending", "ed", "ending theme", "ending credits", "outro",
  "титры", "финальные титры", "конечные титры", "аутро", "эндинг"
]);
const RECAP_NAMES = new Set([
  "recap", "previously", "previously on", "last time", "last time on", "story so far", "the story so far",
  "ранее", "ранее в сериале", "в предыдущих сериях", "в предыдущей серии", "previously in", "краткое содержание"
]);

/** "OP 1", "Ending:", " End  Credits " read as the name they are. */
const chapterName = (title: string) => title
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim()
  .replace(/ ?\d+$/, "");

/** What a chapter is, by its name alone. */
export function chapterKind(title: string | null): MarkerKind | null {
  if (!title) return null;
  const name = chapterName(title);
  if (INTRO_NAMES.has(name)) return "intro";
  if (RECAP_NAMES.has(name)) return "recap";
  return CREDITS_NAMES.has(name) ? "credits" : null;
}

/** A recap and an intro in the first half of the file, the credits in the second.
 *  A "Credits" chapter a few minutes in is the opening's, and says nothing here. */
export function markersFromChapters(chapters: MediaChapter[], start: number, duration: number): Markers {
  const found: Markers = { recap: null, intro: null, credits: null };
  if (duration <= 0) return found;
  const half = duration / 2;
  // A clock a hair below 0 is sound's encoder delay, not a late start.
  const offset = Math.max(0, start);
  for (const chapter of [...chapters].sort((a, b) => a.start - b.start)) {
    const kind = chapterKind(chapter.title);
    const from = Math.max(0, chapter.start - offset);
    const to = chapter.end - offset;
    if (kind === "intro" && !found.intro && from < half && to - from >= MIN_INTRO_S) {
      found.intro = { start: from, end: to, source: "chapter" };
    } else if (kind === "recap" && !found.recap && from < half && to - from >= MIN_INTRO_S) {
      found.recap = { start: from, end: to, source: "chapter" };
    } else if (kind === "credits" && !found.credits && from >= half) {
      found.credits = { start: from, source: "chapter" };
    }
  }
  return found;
}

/** 90.5, 1:30.5 or 0:01:30.5, in seconds; null for what isn't a time (Kodi's "#1234" frames). */
function edlTime(text: string): number | null {
  if (!/^\d+(:\d+){0,2}(\.\d+)?$/.test(text)) return null;
  return text.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

/** The stretches an .edl says to pass over: Kodi's cuts (0) and commercial
 *  breaks (3). Its mutes (1) and scene markers (2) don't skip anything. */
export function parseEdl(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [from, to, action = "0"] = line.trim().split(/\s+/);
    if (!from || !to || (action !== "0" && action !== "3")) continue;
    const start = edlTime(from);
    const end = edlTime(to);
    if (start !== null && end !== null && end > start) out.push({ start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** An .edl says nothing of what a stretch is: an intro starts in the first third
 *  of the file, the credits run to its end from somewhere in the second half. A
 *  recap can't be told from an intro there, so an .edl gives none. */
export function markersFromEdl(stretches: { start: number; end: number }[], duration: number): Markers {
  const found: Markers = { recap: null, intro: null, credits: null };
  if (duration <= 0) return found;
  for (const { start, end } of stretches) {
    if (!found.credits && start >= duration / 2 && end >= duration - END_SLACK_S) found.credits = { start, source: "edl" };
    else if (!found.intro && start < duration / 3 && end <= duration / 2 && end - start >= MIN_INTRO_S) found.intro = { start, end, source: "edl" };
  }
  return found;
}

function readEdl(videoFile: string): { start: number; end: number }[] {
  const file = path.join(path.dirname(videoFile), `${path.basename(videoFile, path.extname(videoFile))}.edl`);
  try {
    if (fs.statSync(file).size > MAX_EDL_BYTES) return [];
    return parseEdl(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

/** A title's intro and credits: the marks by hand, else the .edl's, else its
 *  chapters', else what the engine found by itself (detect.ts), each kind on its
 *  own. Without the probe only the marks and what was found: an .edl means
 *  nothing without the file's length. */
export function findMarkers(info: MediaInfo | null, videoFile: string, marks: Markers = NO_MARKERS, detected: Markers = NO_MARKERS): Markers {
  if (!info) return { recap: marks.recap ?? detected.recap, intro: marks.intro ?? detected.intro, credits: marks.credits ?? detected.credits };
  const edl = markersFromEdl(readEdl(videoFile), info.duration);
  const chapters = markersFromChapters(info.chapters, info.start, info.duration);
  return {
    recap: marks.recap ?? chapters.recap ?? detected.recap,
    intro: marks.intro ?? edl.intro ?? chapters.intro ?? detected.intro,
    credits: marks.credits ?? edl.credits ?? chapters.credits ?? detected.credits
  };
}

/** What detect.ts found, as markers. */
export function detectedMarkers(row: {
  recap_start: number | null; recap_end: number | null; intro_start: number | null; intro_end: number | null; credits_start: number | null;
} | null): Markers {
  if (!row) return NO_MARKERS;
  return {
    recap: row.recap_start !== null && row.recap_end !== null ? { start: row.recap_start, end: row.recap_end, source: "detected" } : null,
    intro: row.intro_start !== null && row.intro_end !== null ? { start: row.intro_start, end: row.intro_end, source: "detected" } : null,
    credits: row.credits_start !== null ? { start: row.credits_start, source: "detected" } : null
  };
}

// ── Marks by hand ───────────────────────────────────────────────────────────

/** What a mark is kept against: an episode (with its show and season) or a film. */
export interface Markable {
  id: string;
  show: { id: string } | null;
  season: number | null;
}

export class MarkError extends Error {}

/** A season's mark lives on the show, under the season's number. */
function keyOf(item: Markable, scope: MarkScope): { itemId: string; season: number } {
  if (scope === "season") {
    if (!item.show || item.season === null) throw new MarkError("Only an episode has a season to mark");
    return { itemId: item.show.id, season: item.season };
  }
  return { itemId: item.id, season: -1 };
}

/** The marks an admin set for this title: its own, else its season's, per kind. */
export function readMarks(db: Db, item: Markable): Markers {
  const rows = db.prepare(`
    SELECT kind, start_s, end_s, season FROM markers
    WHERE (item_id = @id AND season = -1) OR (item_id = @show AND season = @season)
    ORDER BY season = -1 DESC
  `).all({ id: item.id, show: item.show?.id ?? null, season: item.season ?? -2 }) as { kind: MarkerKind; start_s: number; end_s: number | null; season: number }[];
  const found: Markers = { recap: null, intro: null, credits: null };
  for (const row of rows) {
    const scope: MarkScope = row.season === -1 ? "episode" : "season";
    if (row.kind === "intro" && !found.intro && row.end_s !== null) found.intro = { start: row.start_s, end: row.end_s, source: "manual", scope };
    else if (row.kind === "recap" && !found.recap && row.end_s !== null && scope === "episode") found.recap = { start: row.start_s, end: row.end_s, source: "manual", scope };
    else if (row.kind === "credits" && !found.credits) found.credits = { start: row.start_s, source: "manual", scope };
  }
  return found;
}

/** Mark the recap or the intro (start and end) or where the credits start;
 *  `duration`, when known, keeps a mark inside the file. */
export function setMark(db: Db, item: Markable, mark: { kind: MarkerKind; scope: MarkScope; start: number; end: number | null }, duration: number | null): void {
  if (mark.kind === "recap" && mark.scope === "season") throw new MarkError("A recap is marked for its own episode: each is its own length");
  const { itemId, season } = keyOf(item, mark.scope);
  const { kind, start } = mark;
  const end = kind === "credits" ? null : mark.end;
  if (kind !== "credits" && (end === null || end - start < 1)) throw new MarkError(`The ${kind} must end after it starts`);
  if (duration !== null && duration > 0 && (start >= duration || (end !== null && end > duration + 1))) {
    throw new MarkError("That mark is past the end of the file");
  }
  db.prepare(`
    INSERT INTO markers (item_id, season, kind, start_s, end_s, source) VALUES (?, ?, ?, ?, ?, 'manual')
    ON CONFLICT (item_id, season, kind) DO UPDATE SET start_s = excluded.start_s, end_s = excluded.end_s, source = 'manual',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(itemId, season, kind, start, end);
}

/** Back to what the files say (or the season's mark, for an episode's own). */
export function clearMark(db: Db, item: Markable, kind: MarkerKind, scope: MarkScope): boolean {
  const { itemId, season } = keyOf(item, scope);
  return db.prepare("DELETE FROM markers WHERE item_id = ? AND season = ? AND kind = ?").run(itemId, season, kind).changes > 0;
}

/** Marks whose episode, film or show is gone; for the daily sweep. */
export function purgeOrphanMarkers(db: Db): number {
  return db.prepare(`
    DELETE FROM markers WHERE item_id NOT IN (SELECT id FROM episodes) AND item_id NOT IN (SELECT id FROM movies)
      AND item_id NOT IN (SELECT id FROM movie_parts) AND item_id NOT IN (SELECT id FROM shows)
  `).run().changes;
}
