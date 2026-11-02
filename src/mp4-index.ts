// The keyframes of an MP4, read from its header alone.
//
// An MP4 keeps its table of contents in one box, moov: for every track the
// length of each sample (stts), the picture's reordering (ctts) and which
// samples are keyframes (stss). ffprobe answers the same question by walking
// every packet in the file — the whole film, 6 GB for a Blu-ray rip — which on
// a slow disk outlasts the player's patience and failed the first play of such
// a film (its answer was kept, so the second play worked, which looked like
// luck). Here only the moov is read, a few MB wherever it sits, and the times
// come out the way ffprobe prints them, so the plan built on them cuts the
// same segments: pts = dts + composition offset, shifted as ffmpeg applies the
// edit list. Anything unusual (a fragmented file, more than one edit, negative
// composition offsets, a track that doesn't match the probe) answers null and
// ffprobe is asked as before.
import fs from "node:fs/promises";

/** A box's payload: `start` to `end` inside the buffer it was read from. */
interface Box {
  type: string;
  start: number;
  end: number;
}

/** A moov bigger than this is not a header worth reading into memory. */
const MOOV_MAX_BYTES = 256 * 1024 * 1024;
/** More samples than this is not a film. */
const SAMPLES_MAX = 50_000_000;
/** Boxes an MP4 may start with; anything else is another kind of file. */
const LEADING_BOXES = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pdin", "uuid", "junk", "pnot", "prfl", "styp", "moof"]);
/** Picture formats that are stills (cover art, timed thumbnails), not the film. */
const STILL_FORMATS = new Set(["jpeg", "mjpa", "mjpb", "png ", "gif ", "tiff"]);

function* boxes(buffer: Buffer, start: number, end: number): Generator<Box> {
  let at = start;
  while (at + 8 <= end) {
    let length = buffer.readUInt32BE(at);
    let header = 8;
    if (length === 1) {
      if (at + 16 > end) return;
      const big = buffer.readBigUInt64BE(at + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return;
      length = Number(big);
      header = 16;
    } else if (length === 0) {
      length = end - at;
    }
    if (length < header || at + length > end) return;
    yield { type: buffer.toString("latin1", at + 4, at + 8), start: at + header, end: at + length };
    at += length;
  }
}

const child = (buffer: Buffer, box: Box, type: string): Box | null => {
  for (const found of boxes(buffer, box.start, box.end)) if (found.type === type) return found;
  return null;
};

const children = (buffer: Buffer, box: Box, type: string): Box[] =>
  [...boxes(buffer, box.start, box.end)].filter((found) => found.type === type);

async function readAt(handle: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

/** The moov box's payload; null when this is no MP4 or the box isn't there. */
async function readMoov(file: string): Promise<Buffer | null> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    let at = 0;
    let first = true;
    while (at + 8 <= size) {
      const head = await readAt(handle, at, 16);
      if (head.length < 8) return null;
      const type = head.toString("latin1", 4, 8);
      if (first && !LEADING_BOXES.has(type)) return null;
      first = false;
      let length = head.readUInt32BE(0);
      let header = 8;
      if (length === 1) {
        if (head.length < 16) return null;
        const big = head.readBigUInt64BE(8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        length = Number(big);
        header = 16;
      } else if (length === 0) {
        length = size - at;
      }
      if (length < header) return null;
      if (type === "moov") {
        if (length - header > MOOV_MAX_BYTES) return null;
        const payload = await readAt(handle, at + header, length - header);
        return payload.length === length - header ? payload : null;
      }
      at += length;
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** The timescale of an mvhd or mdhd box (version 0 or 1). */
function timescaleOf(buffer: Buffer, box: Box | null): number | null {
  if (!box) return null;
  const version = buffer.readUInt8(box.start);
  const at = box.start + (version === 1 ? 20 : 12);
  if (version > 1 || at + 4 > box.end) return null;
  const scale = buffer.readUInt32BE(at);
  return scale > 0 ? scale : null;
}

interface Entry {
  count: number;
  value: number;
}

/** stts (count, delta) or ctts (count, offset) entries. */
function entriesOf(buffer: Buffer, box: Box | null, signed: boolean): Entry[] | null {
  if (!box) return null;
  const count = buffer.readUInt32BE(box.start + 4);
  if (box.start + 8 + count * 8 > box.end) return null;
  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const at = box.start + 8 + i * 8;
    entries.push({ count: buffer.readUInt32BE(at), value: signed ? buffer.readInt32BE(at + 4) : buffer.readUInt32BE(at + 4) });
  }
  return entries;
}

/** stss: the keyframes' sample numbers, 1-based and ascending. */
function syncSamplesOf(buffer: Buffer, box: Box | null): Uint32Array | null {
  if (!box) return null;
  const count = buffer.readUInt32BE(box.start + 4);
  if (box.start + 8 + count * 4 > box.end) return null;
  const numbers = new Uint32Array(count);
  for (let i = 0; i < count; i++) numbers[i] = buffer.readUInt32BE(box.start + 8 + i * 4);
  return numbers;
}

interface Edit {
  duration: number;
  mediaTime: number;
}

function editsOf(buffer: Buffer, box: Box | null): Edit[] | null {
  if (!box) return [];
  const version = buffer.readUInt8(box.start);
  const count = buffer.readUInt32BE(box.start + 4);
  const width = version === 1 ? 20 : 12;
  if (version > 1 || box.start + 8 + count * width > box.end) return null;
  const edits: Edit[] = [];
  for (let i = 0; i < count; i++) {
    const at = box.start + 8 + i * width;
    edits.push(version === 1
      ? { duration: Number(buffer.readBigUInt64BE(at)), mediaTime: Number(buffer.readBigInt64BE(at + 8)) }
      : { duration: buffer.readUInt32BE(at), mediaTime: buffer.readInt32BE(at + 4) });
  }
  return edits;
}

interface VideoTrack {
  box: Box;
  format: string;
  width: number;
  height: number;
}

/** The trak boxes carrying a moving picture, in file order. */
function videoTracks(buffer: Buffer, moov: Box): VideoTrack[] {
  const found: VideoTrack[] = [];
  for (const trak of children(buffer, moov, "trak")) {
    const mdia = child(buffer, trak, "mdia");
    const hdlr = mdia && child(buffer, mdia, "hdlr");
    if (!mdia || !hdlr || buffer.toString("latin1", hdlr.start + 8, hdlr.start + 12) !== "vide") continue;
    const minf = child(buffer, mdia, "minf");
    const stbl = minf && child(buffer, minf, "stbl");
    const stsd = stbl && child(buffer, stbl, "stsd");
    if (!stsd || buffer.readUInt32BE(stsd.start + 4) < 1 || stsd.start + 8 + 36 > stsd.end) continue;
    // The first sample entry: its format, and the picture's size (a visual
    // sample entry keeps them 24 bytes past its own 8-byte header).
    const entry = stsd.start + 8;
    const format = buffer.toString("latin1", entry + 4, entry + 8);
    if (STILL_FORMATS.has(format)) continue;
    found.push({ box: trak, format, width: buffer.readUInt16BE(entry + 32), height: buffer.readUInt16BE(entry + 34) });
  }
  return found;
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** Where the keyframes of the film's picture are, in seconds as ffprobe would
 *  print them; null when the header can't say and ffprobe must be asked. `video`
 *  is the picture ffprobe found, to pick the same track. */
export async function mp4Keyframes(file: string, video: { width: number; height: number }): Promise<number[] | null> {
  const buffer = await readMoov(file);
  if (!buffer) return null;
  const moov: Box = { type: "moov", start: 0, end: buffer.length };
  // A fragmented file keeps its samples in moof boxes the moov knows nothing about.
  if (child(buffer, moov, "mvex")) return null;
  const movieScale = timescaleOf(buffer, child(buffer, moov, "mvhd"));
  if (!movieScale) return null;

  const tracks = videoTracks(buffer, moov);
  const track = tracks.length === 1 ? tracks[0] : tracks.find((candidate) => candidate.width === video.width && candidate.height === video.height);
  if (!track) return null;

  const mdia = child(buffer, track.box, "mdia")!;
  const scale = timescaleOf(buffer, child(buffer, mdia, "mdhd"));
  const stbl = child(buffer, child(buffer, mdia, "minf")!, "stbl")!;
  const stts = entriesOf(buffer, child(buffer, stbl, "stts"), false);
  const ctts = child(buffer, stbl, "ctts") ? entriesOf(buffer, child(buffer, stbl, "ctts"), true) : [];
  const sync = child(buffer, stbl, "stss") ? syncSamplesOf(buffer, child(buffer, stbl, "stss")) : null;
  const edts = child(buffer, track.box, "edts");
  const edits = edts ? editsOf(buffer, child(buffer, edts, "elst")) : [];
  if (!scale || !stts || !ctts || !edits || (child(buffer, stbl, "stss") && !sync)) return null;
  const total = stts.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0 || total > SAMPLES_MAX) return null;
  // ffmpeg moves the clock for negative offsets; those files are left to it.
  if (ctts.some((entry) => entry.value < 0)) return null;

  // The edit list, as ffmpeg applies it: an empty edit (media time -1) delays
  // the track by its length; the one real edit starts the clock at its media
  // time. More than one real edit is left to ffprobe.
  let shift = 0;
  let editStart = 0;
  let edited = false;
  for (const edit of edits) {
    if (edit.mediaTime === -1) {
      shift += (edit.duration * scale) / movieScale;
    } else if (edited) {
      return null;
    } else {
      edited = true;
      editStart = edit.mediaTime;
      shift -= edit.mediaTime;
    }
  }

  // Every sample in turn: its decode time from stts, its presentation offset
  // from ctts, whether stss names it (no stss: every sample is a keyframe).
  // The keyframe at or before the edit's start is kept, as ffmpeg keeps it, so a
  // picture that starts between keyframes can be decoded from the one before.
  const times: number[] = [];
  let before: number | null = null;
  let met = false;
  let dts = 0;
  let sample = 1;
  let offsetAt = 0;
  let offsetLeft = ctts[0]?.count ?? 0;
  let syncAt = 0;
  for (const { count, value: delta } of stts) {
    for (let k = 0; k < count; k++, sample++) {
      let offset = 0;
      if (offsetAt < ctts.length) {
        offset = ctts[offsetAt].value;
        if (--offsetLeft <= 0) {
          offsetAt++;
          offsetLeft = ctts[offsetAt]?.count ?? 0;
        }
      }
      const isSync = sync ? syncAt < sync.length && sync[syncAt] === sample : true;
      if (isSync && sync) syncAt++;
      const pts = round6((dts + offset + shift) / scale);
      if (dts + delta <= editStart) {
        if (isSync) before = pts;
      } else {
        if (!met) {
          met = true;
          if (!isSync && before !== null) times.push(before);
        }
        if (isSync) times.push(pts);
      }
      dts += delta;
    }
  }
  return times.sort((a, b) => a - b);
}
