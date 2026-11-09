// Finding a title's intro and credits by itself (home's docs/video-skip-plan.md →
// K3), for the files that say nothing of them (no named chapters, no .edl) and
// that no admin has marked: most downloaded shows. Kept apart from the marks, in
// detected_markers, and the last thing findMarkers turns to.
//
// - The intro, by sound: the episodes of a season share it. The first stretch of
//   each is decoded (8 kHz mono), fingerprinted, and compared with its neighbours'
//   at every alignment; the stretch most of them agree on, near the season's usual
//   length, is the intro. A season of fewer than three, or one with no agreement,
//   gets none — nothing is better than half an intro.
// - The credits, by picture: text on near-pure black. ffmpeg's blackdetect over the
//   keyframes of the file's last minutes; the first long black stretch is where they
//   start. Failing that, by sound: a closing tune the season's episodes share that
//   runs to the end. Films get the picture's answer too.
//
// The spike that chose every number here is in the plan. Long work, so it yields to
// the event loop between pieces: a season's comparisons must not hold up a film
// being cut into segments.
import { spawn } from "node:child_process";
import type { Db } from "./db.js";
import type { Tools } from "./ffmpeg.js";
import type { Identity } from "./identity.js";
import type { MediaProbe } from "./media-probe.js";
import { fileOf, findItem } from "./playback.js";

const RATE = 8000;
const FRAME = 2048;
const HOP = 1024;
/** Seconds between fingerprint frames. */
export const STEP_S = HOP / RATE;
const BANDS = 33;
/** Band energy below which a frame is silence; silence never matches silence. */
const SILENCE = 1e9;
/** A frame matches with at most this many of its 32 bits differing. */
const MAX_BITS = 10;
/** Frames of mismatch a shared run may bridge (~1.5 s). */
const MAX_GAP = 12;
/** A shared run's ends are trimmed until a quarter of the frames over this many
 *  (~2 s) match: ten times the rate unrelated sound matches at by chance. */
const EDGE_FRAMES = 16;
/** Shorter than this is a sting, not an intro. */
const MIN_SHARED_S = 10;
/** Each episode is compared with this many after it (and as many before). */
const NEIGHBOURS = 6;
/** Two pairs agree on where an episode's intro starts within this. */
const AGREE_S = 3;
/** An episode's intro this far off the season's usual length is a partial match. */
const LENGTH_SLACK = 0.25;

const INTRO_WINDOW_S = 15 * 60;
const END_WINDOW_S = 10 * 60;
const END_SOUND_WINDOW_S = 6 * 60;
/** A shared closing tune counts as the credits when it ends this close to the end. */
const END_SLACK_S = 5;
/** Black stretches this close together are one: credits come in cards. */
const BLACK_JOIN_S = 6;
const MIN_BLACK_S = 20;

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

// ── Sound ───────────────────────────────────────────────────────────────────

/** `seconds` of a file's sound from `from`, as 8 kHz mono samples. */
export function decodeSound(tools: Tools, file: string, from: number, seconds: number, signal?: AbortSignal): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ffmpeg, ["-v", "error", "-ss", String(from), "-t", String(seconds), "-i", file,
      "-vn", "-sn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"], { windowsHide: true, signal });
    const chunks: Buffer[] = [];
    let errText = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { errText = (errText + chunk.toString()).slice(-500); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(errText.trim().split("\n").pop() || `ffmpeg exited with ${code}`));
      const all = Buffer.concat(chunks);
      // A copy, so the samples sit on an aligned buffer of their own.
      resolve(new Int16Array(all.buffer.slice(all.byteOffset, all.byteOffset + all.length - (all.length % 2))));
    });
  });
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = len / 2;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k + half];
        const ai = im[i + k + half];
        const tr = ar * cr - ai * ci;
        const ti = ar * ci + ai * cr;
        re[i + k + half] = re[i + k] - tr;
        im[i + k + half] = im[i + k] - ti;
        re[i + k] += tr;
        im[i + k] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

const HANN = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FRAME - 1)));
/** FFT bins of 33 bands, 300-3000 Hz, log spaced. */
const EDGES = Array.from({ length: BANDS + 1 }, (_, b) => Math.round(300 * Math.pow(10, b / BANDS) * FRAME / RATE));

/** 32 bits every STEP_S: each the sign of how the energy difference between two
 *  neighbouring bands changed since the frame before — the same tune gives the
 *  same bits whatever its volume or codec. 0 marks silence. */
export async function fingerprint(samples: Int16Array): Promise<Uint32Array> {
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP));
  const out = new Uint32Array(frames);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let previous: Float64Array | null = null;
  for (let f = 0; f < frames; f++) {
    if (f % 500 === 499) await yieldNow();
    for (let i = 0; i < FRAME; i++) {
      re[i] = samples[f * HOP + i] * HANN[i];
      im[i] = 0;
    }
    fft(re, im);
    const energy = new Float64Array(BANDS);
    let total = 0;
    for (let b = 0; b < BANDS; b++) {
      let sum = 0;
      for (let k = EDGES[b]; k < Math.max(EDGES[b + 1], EDGES[b] + 1); k++) sum += re[k] * re[k] + im[k] * im[k];
      energy[b] = sum;
      total += sum;
    }
    let bits = 0;
    if (previous && total > SILENCE) {
      for (let b = 0; b < 32; b++) {
        if ((energy[b] - energy[b + 1]) - (previous[b] - previous[b + 1]) > 0) bits |= 1 << b;
      }
    }
    out[f] = bits >>> 0;
    previous = energy;
  }
  return out;
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export interface Shared {
  /** Frame indexes where the stretch starts in each. */
  aStart: number;
  bStart: number;
  /** In frames. */
  length: number;
}

const matches = (x: number, y: number) => x !== 0 && y !== 0 && popcount(x ^ y) <= MAX_BITS;

/** The longest stretch two fingerprints share, at any alignment. */
export async function sharedStretch(a: Uint32Array, b: Uint32Array): Promise<Shared | null> {
  const minFrames = MIN_SHARED_S / STEP_S;
  let best: (Shared & { shift: number }) | null = null;
  for (let shift = -(b.length - 1); shift < a.length; shift++) {
    if (shift % 400 === 0) await yieldNow();
    // a[i] lines up with b[i - shift].
    const from = Math.max(0, shift);
    const to = Math.min(a.length, b.length + shift);
    if (to - from < minFrames) continue;
    let runStart = -1;
    let lastMatch = -1;
    for (let i = from; i < to; i++) {
      if (!matches(a[i], b[i - shift])) continue;
      if (runStart < 0 || i - lastMatch > MAX_GAP) runStart = i;
      lastMatch = i;
      const length = lastMatch - runStart + 1;
      if (!best || length > best.length) best = { aStart: runStart, bStart: runStart - shift, length, shift };
    }
  }
  if (!best) return null;
  // Unrelated sound matches by chance now and then (a frame in 40 or so), and the
  // gaps a run may bridge let one stray match stretch it: trim each end until the
  // matches around it are dense.
  const { shift } = best;
  const dense = (i: number, direction: 1 | -1) => {
    let hits = 0;
    for (let k = 0; k < EDGE_FRAMES; k++) {
      const at = i + k * direction;
      if (at - shift >= 0 && at - shift < b.length && at >= 0 && at < a.length && matches(a[at], b[at - shift])) hits++;
    }
    return hits * 4 >= EDGE_FRAMES;
  };
  let start = best.aStart;
  let end = best.aStart + best.length - 1;
  while (start < end && !dense(start, 1)) start++;
  while (end > start && !dense(end, -1)) end--;
  const length = end - start + 1;
  return length >= minFrames ? { aStart: start, bStart: start - shift, length } : null;
}

/** Which pairs of a season to compare: each episode with its next few, round the
 *  season — all of a short season, a fixed number per episode of a long one. */
export function neighbourPairs(count: number): [number, number][] {
  const pairs = new Map<string, [number, number]>();
  for (let i = 0; i < count; i++) {
    for (let d = 1; d <= Math.min(NEIGHBOURS, count - 1); d++) {
      const j = (i + d) % count;
      const pair: [number, number] = i < j ? [i, j] : [j, i];
      pairs.set(pair.join(":"), pair);
    }
  }
  return [...pairs.values()];
}

const median = (values: number[]) => {
  const sorted = [...values].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Each episode's stretch from what its pairs found: where most of them put its
 *  start, ending where they end (medians), and only when at least half its pairs
 *  agree and its length is near the season's usual one. In seconds. */
export function stretchesFromPairs(count: number, found: { a: number; b: number; shared: Shared }[]): ({ start: number; end: number } | null)[] {
  const per: { start: number; end: number }[][] = Array.from({ length: count }, () => []);
  for (const { a, b, shared } of found) {
    per[a].push({ start: shared.aStart * STEP_S, end: (shared.aStart + shared.length) * STEP_S });
    per[b].push({ start: shared.bStart * STEP_S, end: (shared.bStart + shared.length) * STEP_S });
  }
  const chosen = per.map((list) => {
    let group: { start: number; end: number }[] = [];
    for (const candidate of list) {
      const agreeing = list.filter((other) => Math.abs(other.start - candidate.start) <= AGREE_S);
      if (agreeing.length > group.length) group = agreeing;
    }
    return group.length === 0 ? null : { start: median(group.map((g) => g.start)), end: median(group.map((g) => g.end)), agree: group.length };
  });
  // How many pairs each episode is in (neighbourPairs).
  const pairsEach = Math.min(2 * NEIGHBOURS, count - 1);
  const lengths = chosen.filter((c) => c !== null).map((c) => c!.end - c!.start);
  if (lengths.length === 0) return chosen.map(() => null);
  const usual = median(lengths);
  return chosen.map((c) => {
    if (!c) return null;
    if (c.agree * 2 < pairsEach) return null;
    if (Math.abs(c.end - c.start - usual) > usual * LENGTH_SLACK) return null;
    return { start: c.start, end: c.end };
  });
}

// ── Picture ─────────────────────────────────────────────────────────────────

/** The stretches of near-pure black (text on black counts) in a file from
 *  `from`, on its keyframes only: a few seconds for ten minutes of film. */
export function blackStretches(tools: Tools, file: string, from: number, signal?: AbortSignal): Promise<{ start: number; end: number }[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ffmpeg, ["-hide_banner", "-skip_frame", "nokey", "-ss", String(from), "-i", file, "-an", "-sn", "-dn",
      "-vf", "scale=320:-2,blackdetect=d=3:pic_th=0.80:pix_th=0.03", "-f", "null", "-"], { windowsHide: true, signal });
    let text = "";
    child.stderr.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(text.trim().split("\n").pop() || `ffmpeg exited with ${code}`));
      resolve([...text.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({ start: from + Number(m[1]), end: from + Number(m[2]) })));
    });
  });
}

/** Where the credits start: the first long black stretch, cards close together
 *  counted as one. */
export function creditsFromBlack(stretches: { start: number; end: number }[]): number | null {
  const joined: { start: number; end: number }[] = [];
  for (const stretch of stretches) {
    const last = joined[joined.length - 1];
    if (last && stretch.start - last.end < BLACK_JOIN_S) last.end = stretch.end;
    else joined.push({ ...stretch });
  }
  return joined.find((s) => s.end - s.start >= MIN_BLACK_S)?.start ?? null;
}

// ── Recaps, by picture ──────────────────────────────────────────────────────
//
// A "Previously on" is pieces of the episodes before it, re-cut, with new music
// over them — so its sound is no help, but its picture is the old frames. Every
// episode's whole picture is hashed once (4 frames a second, 64 bits each) and
// kept; an episode's first minutes are then matched against the earlier ones'.

const PRINT_FPS = 4;
/** Frame hashes differing in at most this many of 64 bits are the same picture. */
const PRINT_MAX_BITS = 6;
/** A piece is at least this many frames matching consecutive frames (1 s). */
const PIECE_FRAMES = 4;
/** A recap is looked for in the first this many seconds. */
const RECAP_WINDOW_S = 240;
/** What an earlier episode shows in its own first seconds is the opening every
 *  episode shares (rating card, studio card, "Previously on"), not the recap. */
const OPENING_S = 30;
/** Pieces this far apart are one recap: clips from older episodes not compared fall between. */
const RECAP_GAP_S = 25;
const MIN_RECAP_PIECES = 5;

/** A file's picture as frame hashes: two words a frame, 0 0 for one with no contrast. */
export function pictureHashes(tools: Tools, file: string, signal?: AbortSignal): Promise<Uint32Array> {
  return new Promise((resolve, reject) => {
    // Two threads: this runs in the background, beside films being converted. B
    // frames skipped: four frames a second don't need them, and it halves the work.
    const child = spawn(tools.ffmpeg, ["-v", "error", "-threads", "2", "-skip_frame", "bidir", "-i", file, "-an", "-sn", "-dn",
      "-vf", `fps=${PRINT_FPS},scale=9:8:flags=area,format=gray`, "-f", "rawvideo", "-"], { windowsHide: true, signal });
    const chunks: Buffer[] = [];
    let errText = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { errText = (errText + chunk.toString()).slice(-500); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(errText.trim().split("\n").pop() || `ffmpeg exited with ${code}`));
      resolve(hashFrames(Buffer.concat(chunks)));
    });
  });
}

/** 9×8 grey frames to hashes: each bit says whether a pixel is brighter than the
 *  one to its right, so a regraded or re-encoded copy keeps its hash. */
export function hashFrames(raw: Buffer): Uint32Array {
  const size = 72;
  const frames = Math.floor(raw.length / size);
  const out = new Uint32Array(frames * 2);
  for (let f = 0; f < frames; f++) {
    let lo = 0;
    let hi = 0;
    let min = 255;
    let max = 0;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const a = raw[f * size + y * 9 + x];
        const b = raw[f * size + y * 9 + x + 1];
        if (a < min) min = a;
        if (a > max) max = a;
        if (a > b) {
          const k = y * 8 + x;
          if (k < 32) lo |= 1 << k;
          else hi |= 1 << (k - 32);
        }
      }
    }
    // Black, a fade, a plain card: nothing to tell one from another.
    if (max - min >= 12) {
      out[f * 2] = lo >>> 0;
      out[f * 2 + 1] = hi >>> 0;
    }
  }
  return out;
}

export function readPrints(db: Db, itemId: string, file: DetectFile): Uint32Array | null {
  const row = db.prepare("SELECT size, modified_ms, prints FROM picture_prints WHERE item_id = ?").get(itemId) as { size: number; modified_ms: number; prints: Buffer } | undefined;
  if (!row || row.size !== file.size || row.modified_ms !== file.modified.getTime()) return null;
  const copy = Buffer.from(row.prints);
  return new Uint32Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / 4));
}

export function writePrints(db: Db, itemId: string, file: DetectFile, prints: Uint32Array): void {
  db.prepare(`
    INSERT INTO picture_prints (item_id, size, modified_ms, prints) VALUES (?, ?, ?, ?)
    ON CONFLICT (item_id) DO UPDATE SET size = excluded.size, modified_ms = excluded.modified_ms, prints = excluded.prints,
      made_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(itemId, file.size, file.modified.getTime(), Buffer.from(prints.buffer, prints.byteOffset, prints.byteLength));
}

/** Pieces of `head` found in `body`, in seconds of the head and of the body. */
async function piecesOf(head: Uint32Array, body: Uint32Array): Promise<{ from: number; to: number; at: number }[]> {
  const frames = head.length / 2;
  const bodyFrames = body.length / 2;
  const best = new Int32Array(frames).fill(-1);
  for (let i = 0; i < frames; i++) {
    if (i % 40 === 39) await yieldNow();
    const lo = head[i * 2];
    const hi = head[i * 2 + 1];
    if (lo === 0 && hi === 0) continue;
    let bestBits = PRINT_MAX_BITS + 1;
    for (let j = 0; j < bodyFrames; j++) {
      const bl = body[j * 2];
      const bh = body[j * 2 + 1];
      if (bl === 0 && bh === 0) continue;
      const bits = popcount(lo ^ bl) + popcount(hi ^ bh);
      if (bits < bestBits) {
        bestBits = bits;
        best[i] = j;
      }
    }
  }
  const pieces: { from: number; to: number; at: number }[] = [];
  let i = 0;
  while (i < frames) {
    if (best[i] < 0) {
      i++;
      continue;
    }
    // Head frames whose matches follow each other in the body: one piece of it.
    let j = i;
    while (j + 1 < frames && best[j + 1] >= 0 && Math.abs(best[j + 1] - best[j] - 1) <= 1) j++;
    if (j - i + 1 >= PIECE_FRAMES) pieces.push({ from: i / PRINT_FPS, to: (j + 1) / PRINT_FPS, at: best[i] / PRINT_FPS });
    i = j + 1;
  }
  return pieces;
}

/** An episode's recap from its picture and the earlier episodes': from where the
 *  shared opening ends (or its first piece) through pieces no more than
 *  RECAP_GAP_S apart; none from fewer than MIN_RECAP_PIECES. Never into the intro. */
export async function recapFromPrints(prints: Uint32Array, earlier: Uint32Array[], introStart: number | null): Promise<{ start: number; end: number } | null> {
  const head = prints.subarray(0, Math.min(prints.length, RECAP_WINDOW_S * PRINT_FPS * 2));
  let openingEnd = 0;
  const pieces: { from: number; to: number }[] = [];
  for (const body of earlier) {
    for (const piece of await piecesOf(head, body)) {
      if (piece.at < OPENING_S && piece.from < 2 * OPENING_S) openingEnd = Math.max(openingEnd, piece.to);
      else pieces.push(piece);
    }
  }
  return recapFromPieces(pieces, openingEnd, introStart);
}

export function recapFromPieces(pieces: { from: number; to: number }[], openingEnd: number, introStart: number | null): { start: number; end: number } | null {
  const after = pieces.filter((piece) => piece.from >= openingEnd - 1).sort((a, b) => a.from - b.from);
  let span: { start: number; end: number; count: number } | null = null;
  for (const piece of after) {
    if (introStart !== null && piece.from >= introStart) break;
    if (!span) {
      // A recap follows its "Previously on" card closely, if there is one.
      if (openingEnd > 0 && piece.from - openingEnd > RECAP_GAP_S) break;
      span = { start: openingEnd > 0 ? openingEnd : piece.from, end: piece.to, count: 1 };
    } else if (piece.from - span.end <= RECAP_GAP_S) {
      span.end = Math.max(span.end, piece.to);
      span.count++;
    } else {
      break;
    }
  }
  if (!span || span.count < MIN_RECAP_PIECES) return null;
  const end = introStart !== null ? Math.min(span.end, introStart) : span.end;
  return end - span.start >= MIN_SHARED_S ? { start: round(span.start), end: round(end) } : null;
}

// ── Kept ────────────────────────────────────────────────────────────────────

export interface DetectedRow {
  item_id: string;
  size: number;
  modified_ms: number;
  intro_start: number | null;
  intro_end: number | null;
  /** 1 once the item's season was compared with it in it (a film: always). */
  intro_checked: number;
  credits_start: number | null;
  recap_start: number | null;
  recap_end: number | null;
  /** 1 once a recap was looked for (a film: always). */
  recap_checked: number;
}

export interface DetectFile {
  size: number;
  modified: Date;
}

/** What was found for this file; null when it hasn't been looked at, or the file
 *  has changed since. */
export function readDetected(db: Db, itemId: string, file: DetectFile): DetectedRow | null {
  const row = db.prepare("SELECT * FROM detected_markers WHERE item_id = ?").get(itemId) as DetectedRow | undefined;
  return row && row.size === file.size && row.modified_ms === file.modified.getTime() ? row : null;
}

export function writeDetected(db: Db, row: DetectedRow): void {
  db.prepare(`
    INSERT INTO detected_markers (item_id, size, modified_ms, intro_start, intro_end, intro_checked, credits_start, recap_start, recap_end, recap_checked)
    VALUES (@item_id, @size, @modified_ms, @intro_start, @intro_end, @intro_checked, @credits_start, @recap_start, @recap_end, @recap_checked)
    ON CONFLICT (item_id) DO UPDATE SET size = excluded.size, modified_ms = excluded.modified_ms,
      intro_start = excluded.intro_start, intro_end = excluded.intro_end, intro_checked = excluded.intro_checked,
      credits_start = excluded.credits_start, recap_start = excluded.recap_start, recap_end = excluded.recap_end,
      recap_checked = excluded.recap_checked, detected_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(row);
}

export function forgetDetected(db: Db, itemIds: string[]): void {
  const drop = db.prepare("DELETE FROM detected_markers WHERE item_id = ?");
  db.transaction(() => { for (const id of itemIds) drop.run(id); })();
}

/** Rows (and kept pictures) whose episode or film is gone; for the daily sweep. */
export function purgeOrphanDetected(db: Db): number {
  const orphan = "item_id NOT IN (SELECT id FROM episodes) AND item_id NOT IN (SELECT id FROM movies) AND item_id NOT IN (SELECT id FROM movie_parts)";
  return db.prepare(`DELETE FROM detected_markers WHERE ${orphan}`).run().changes
    + db.prepare(`DELETE FROM picture_prints WHERE ${orphan}`).run().changes;
}

// ── One season, one film ────────────────────────────────────────────────────

export interface DetectTarget {
  id: string;
  absolute: string;
  size: number;
  modified: Date;
  duration: number;
}

/** A season's episodes, in order: intros by sound, credits by picture then by
 *  sound. Answers a row per episode. */
export async function detectSeason(tools: Tools, episodes: DetectTarget[], signal?: AbortSignal): Promise<DetectedRow[]> {
  const heads: (Uint32Array | null)[] = [];
  const tails: (Uint32Array | null)[] = [];
  const tailFrom: number[] = [];
  for (const episode of episodes) {
    signal?.throwIfAborted();
    try {
      heads.push(await fingerprint(await decodeSound(tools, episode.absolute, 0, Math.min(INTRO_WINDOW_S, episode.duration / 3), signal)));
      const from = Math.max(0, episode.duration - Math.min(END_SOUND_WINDOW_S, episode.duration / 4));
      tails.push(await fingerprint(await decodeSound(tools, episode.absolute, from, episode.duration - from, signal)));
      tailFrom.push(from);
    } catch (err) {
      if (signal?.aborted) throw err;
      heads.push(null);
      tails.push(null);
      tailFrom.push(0);
    }
  }
  const compare = async (prints: (Uint32Array | null)[]) => {
    const found: { a: number; b: number; shared: Shared }[] = [];
    if (episodes.length < 3) return found;
    for (const [a, b] of neighbourPairs(episodes.length)) {
      signal?.throwIfAborted();
      const pa = prints[a];
      const pb = prints[b];
      if (!pa || !pb) continue;
      const shared = await sharedStretch(pa, pb);
      if (shared) found.push({ a, b, shared });
    }
    return found;
  };
  const intros = stretchesFromPairs(episodes.length, await compare(heads));
  const tunes = stretchesFromPairs(episodes.length, await compare(tails));

  const rows: DetectedRow[] = [];
  for (let i = 0; i < episodes.length; i++) {
    const episode = episodes[i];
    // A file ffmpeg can't read is noted as looked at, or every pass would decode
    // its whole season again; Find again asks anew.
    let credits = heads[i] ? await creditsByPicture(tools, episode, signal) : null;
    const tune = tunes[i];
    if (credits === null && tune && tailFrom[i] + tune.end >= episode.duration - END_SLACK_S) credits = tailFrom[i] + tune.start;
    const intro = intros[i];
    rows.push({
      item_id: episode.id,
      size: episode.size,
      modified_ms: episode.modified.getTime(),
      intro_start: intro ? round(intro.start) : null,
      intro_end: intro ? round(intro.end) : null,
      intro_checked: 1,
      credits_start: credits === null ? null : round(credits),
      // The runner fills these in from the season's pictures.
      recap_start: null,
      recap_end: null,
      recap_checked: 0
    });
  }
  return rows;
}

/** A film (or one part of one): its credits by picture. */
export async function detectFilm(tools: Tools, film: DetectTarget, signal?: AbortSignal): Promise<DetectedRow> {
  const credits = await creditsByPicture(tools, film, signal);
  return {
    item_id: film.id,
    size: film.size,
    modified_ms: film.modified.getTime(),
    intro_start: null,
    intro_end: null,
    intro_checked: 1,
    credits_start: credits === null ? null : round(credits),
    recap_start: null,
    recap_end: null,
    recap_checked: 1
  };
}

async function creditsByPicture(tools: Tools, target: DetectTarget, signal?: AbortSignal): Promise<number | null> {
  // Credits sit in the last part; a short film's last quarter at most.
  const from = Math.max(0, target.duration - Math.min(END_WINDOW_S, target.duration / 4));
  try {
    const start = creditsFromBlack(await blackStretches(tools, target.absolute, from, signal));
    // A film that ends on a long black screen has no credits to skip to.
    return start !== null && start < target.duration - MIN_BLACK_S / 2 ? start : null;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

const round = (seconds: number) => Math.round(seconds * 10) / 10;

// ── What needs looking at ───────────────────────────────────────────────────

/** Sees every library: the engine's own work, not anyone's request. */
const ENGINE: Identity = { id: "engine", name: "engine", role: "admin", appRole: "manager", libraries: "all", lang: "en", theme: "", historyId: "engine" };

export interface DetectSummary {
  seasons: number;
  films: number;
  recaps: number;
  intros: number;
  credits: number;
}

/** Runs detection for a library, a show or a single title, looking only at what
 *  has not been looked at since its file last changed (or at all of it, forced). */
export class DetectRunner {
  constructor(private options: { db: Db; tools: Tools; mediaRoot: string; probe: MediaProbe }) {}

  private async target(itemId: string): Promise<DetectTarget | null> {
    const item = findItem(this.options.db, ENGINE, itemId);
    const file = item ? fileOf(this.options.mediaRoot, item) : null;
    if (!file) return null;
    const info = await this.options.probe.info(itemId, file).catch(() => null);
    if (!info || !(info.duration > 0)) return null;
    return { id: itemId, absolute: file.absolute, size: file.size, modified: file.modified, duration: info.duration };
  }

  private fresh(target: DetectTarget): boolean {
    const row = readDetected(this.options.db, target.id, target);
    return row?.intro_checked === 1 && row.recap_checked === 1;
  }

  /** An episode's picture as hashes: kept from before, or made now and kept. */
  private async printsOf(target: DetectTarget, signal?: AbortSignal): Promise<Uint32Array | null> {
    const kept = readPrints(this.options.db, target.id, target);
    if (kept) return kept;
    try {
      const prints = await pictureHashes(this.options.tools, target.absolute, signal);
      writePrints(this.options.db, target.id, target, prints);
      return prints;
    } catch (err) {
      if (signal?.aborted) throw err;
      return null;
    }
  }

  /** The last episodes of the season before, which a premiere's recap is made of. */
  private async previousSeason(showId: string, season: number, signal?: AbortSignal): Promise<Uint32Array[]> {
    const ids = (this.options.db.prepare(`
      SELECT id FROM episodes WHERE show_id = ? AND season = (SELECT MAX(season) FROM episodes WHERE show_id = ? AND season < ?)
      ORDER BY episode DESC LIMIT 2
    `).all(showId, showId, season) as { id: string }[]).map((row) => row.id);
    const out: Uint32Array[] = [];
    for (const id of ids) {
      const target = await this.target(id);
      const prints = target ? await this.printsOf(target, signal) : null;
      if (prints) out.push(prints);
    }
    return out;
  }

  /** What is being looked at now ("Counterpart · season 2"), for the admin; null when idle. */
  working: string | null = null;

  /** `all` (every library, what was watched lately first), a `library`, a
   *  `show`/`movie` (a title), or one `item` (its season, or the film).
   *  `between` runs before each season or film: where more urgent work cuts in. */
  async run(
    scope: { all: true } | { library: string } | { show: string } | { movie: string } | { item: string },
    force: boolean,
    signal?: AbortSignal,
    between?: () => Promise<void>
  ): Promise<DetectSummary> {
    const { db } = this.options;
    const summary: DetectSummary = { seasons: 0, films: 0, recaps: 0, intros: 0, credits: 0 };
    let seasons: { show_id: string; season: number }[] = [];
    let films: string[] = [];
    if ("all" in scope) {
      // A whole library's first pass takes hours: the shows and films someone is
      // watching are looked at first, then the rest by name.
      seasons = db.prepare(`
        SELECT e.show_id, e.season FROM episodes e JOIN shows s ON s.id = e.show_id JOIN libraries l ON l.id = s.library_id
        WHERE l.state = 'active'
        GROUP BY e.show_id, e.season
        ORDER BY (SELECT MAX(p.updated_at) FROM progress p JOIN episodes w ON w.id = p.item_id WHERE w.show_id = e.show_id) IS NULL,
          (SELECT MAX(p.updated_at) FROM progress p JOIN episodes w ON w.id = p.item_id WHERE w.show_id = e.show_id) DESC,
          MIN(s.sort_title), e.season
      `).all() as typeof seasons;
      films = (db.prepare(`
        SELECT f.id FROM (
          SELECT m.id, m.id AS movie_id, m.sort_title FROM movies m JOIN libraries l ON l.id = m.library_id WHERE l.state = 'active'
          UNION ALL SELECT p.id, m.id, m.sort_title FROM movie_parts p JOIN movies m ON m.id = p.movie_id JOIN libraries l ON l.id = m.library_id WHERE l.state = 'active'
        ) f
        ORDER BY (SELECT MAX(updated_at) FROM progress WHERE item_id = f.id) IS NULL, (SELECT MAX(updated_at) FROM progress WHERE item_id = f.id) DESC, f.sort_title
      `).all() as { id: string }[]).map((row) => row.id);
    } else if ("library" in scope) {
      seasons = db.prepare("SELECT e.show_id, e.season FROM episodes e JOIN shows s ON s.id = e.show_id WHERE s.library_id = ? GROUP BY e.show_id, e.season ORDER BY MIN(s.sort_title), e.season").all(scope.library) as typeof seasons;
      films = filmsWhere(db, "m.library_id = ?", scope.library);
    } else if ("show" in scope) {
      seasons = db.prepare("SELECT DISTINCT show_id, season FROM episodes WHERE show_id = ? ORDER BY season").all(scope.show) as typeof seasons;
    } else if ("movie" in scope) {
      films = filmsWhere(db, "m.id = ?", scope.movie);
    } else {
      const episode = db.prepare("SELECT show_id, season FROM episodes WHERE id = ?").get(scope.item) as { show_id: string; season: number } | undefined;
      if (episode) seasons = [episode];
      else films = [scope.item];
    }
    for (const { show_id, season } of seasons) {
      signal?.throwIfAborted();
      await between?.();
      const ids = (db.prepare("SELECT id FROM episodes WHERE show_id = ? AND season = ? ORDER BY episode").all(show_id, season) as { id: string }[]).map((row) => row.id);
      const targets: DetectTarget[] = [];
      for (const id of ids) {
        const target = await this.target(id);
        if (target) targets.push(target);
      }
      if (targets.length === 0 || (!force && targets.every((target) => this.fresh(target)))) continue;
      const title = (db.prepare("SELECT title FROM shows WHERE id = ?").get(show_id) as { title: string } | undefined)?.title ?? show_id;
      this.working = `${title} · season ${season}`;
      const rows = await detectSeason(this.options.tools, targets, signal);
      // Recaps: each episode's opening against every episode before it this
      // season and the end of the season before — an episode's recap may reach
      // back past the premiere (Counterpart S2E02 is all season 1).
      const prints: (Uint32Array | null)[] = [];
      for (const target of targets) prints.push(await this.printsOf(target, signal));
      const before = await this.previousSeason(show_id, season, signal);
      for (const [i, row] of rows.entries()) {
        signal?.throwIfAborted();
        const own = prints[i];
        const earlier = [...before, ...prints.slice(0, i).filter((p): p is Uint32Array => p !== null)];
        const recap = own && earlier.length > 0 ? await recapFromPrints(own, earlier, row.intro_start) : null;
        row.recap_start = recap?.start ?? null;
        row.recap_end = recap?.end ?? null;
        row.recap_checked = 1;
      }
      db.transaction(() => { for (const row of rows) writeDetected(db, row); })();
      summary.seasons += 1;
      summary.recaps += rows.filter((row) => row.recap_start !== null).length;
      summary.intros += rows.filter((row) => row.intro_start !== null).length;
      summary.credits += rows.filter((row) => row.credits_start !== null).length;
    }
    for (const id of films) {
      signal?.throwIfAborted();
      await between?.();
      const target = await this.target(id);
      if (!target || (!force && this.fresh(target))) continue;
      this.working = (db.prepare("SELECT m.title FROM movies m LEFT JOIN movie_parts p ON p.movie_id = m.id WHERE m.id = ? OR p.id = ?").get(id, id) as { title: string } | undefined)?.title ?? id;
      const row = await detectFilm(this.options.tools, target, signal);
      writeDetected(db, row);
      summary.films += 1;
      if (row.credits_start !== null) summary.credits += 1;
    }
    return summary;
  }
}

/** Every file of the films matching: each part of a film in several. */
function filmsWhere(db: Db, where: string, value: string): string[] {
  return (db.prepare(`
    SELECT m.id FROM movies m WHERE ${where}
    UNION ALL SELECT p.id FROM movie_parts p JOIN movies m ON m.id = p.movie_id WHERE ${where}
  `).all(value, value) as { id: string }[]).map((row) => row.id);
}
