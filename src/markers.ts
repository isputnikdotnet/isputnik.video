// Where a title's intro and credits are (home's docs/video-skip-plan.md), so the
// player can offer Skip intro and bring its next-episode card up when the credits
// start. Only ever what the files say, the family's own first:
//
// - an .edl beside the video: Kodi's edit list, which intro-skipper tools write;
// - chapters inside the file, by their names. An unnamed "Chapter 3" says nothing.
//
// Worked out when asked, never stored: reading both is cheap (the chapters come
// with the probe media_probe keeps) and a new .edl counts at once. All times are
// seconds from the start of the file, the clock the player runs on.
import fs from "node:fs";
import path from "node:path";
import type { MediaChapter, MediaInfo } from "./ffmpeg.js";

export type MarkerSource = "edl" | "chapter";

export interface Markers {
  intro: { start: number; end: number; source: MarkerSource } | null;
  /** To the end of the file. */
  credits: { start: number; source: MarkerSource } | null;
}

export const NO_MARKERS: Markers = { intro: null, credits: null };

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

/** "OP 1", "Ending:", " End  Credits " read as the name they are. */
const chapterName = (title: string) => title
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim()
  .replace(/ ?\d+$/, "");

/** What a chapter is, by its name alone. */
export function chapterKind(title: string | null): "intro" | "credits" | null {
  if (!title) return null;
  const name = chapterName(title);
  if (INTRO_NAMES.has(name)) return "intro";
  return CREDITS_NAMES.has(name) ? "credits" : null;
}

/** An intro in the first half of the file, the credits in the second. A
 *  "Credits" chapter a few minutes in is the opening's, and says nothing here. */
export function markersFromChapters(chapters: MediaChapter[], start: number, duration: number): Markers {
  const found: Markers = { intro: null, credits: null };
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
 *  of the file, the credits run to its end from somewhere in the second half. */
export function markersFromEdl(stretches: { start: number; end: number }[], duration: number): Markers {
  const found: Markers = { intro: null, credits: null };
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

/** A title's intro and credits: the .edl's, else its chapters', each on its own.
 *  Nothing without the probe: an .edl means nothing without the file's length. */
export function findMarkers(info: MediaInfo | null, videoFile: string): Markers {
  if (!info) return NO_MARKERS;
  const edl = markersFromEdl(readEdl(videoFile), info.duration);
  const chapters = markersFromChapters(info.chapters, info.start, info.duration);
  return { intro: edl.intro ?? chapters.intro, credits: edl.credits ?? chapters.credits };
}
