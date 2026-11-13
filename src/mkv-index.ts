// The keyframes of a Matroska file (.mkv), read from its index.
//
// A Matroska file carries its own index, Cues: a time and a cluster for the
// picture's keyframes (or, from MakeMKV, its I-frames about once a second).
// ffprobe answers the same question by walking every packet of the file —
// 30 GB for a Blu-ray remux, many minutes on an array disk — and the first play
// of such a film sat on "Getting it ready…" all that time. Here only the head of
// the file, its Tracks and Cues, and the first bytes of each cued frame are
// read: a few hundred KB and one small read per cue.
//
// A cue is not always a keyframe as ffmpeg means it. ffmpeg's H.264 parser, not
// the container's flag, decides — an IDR slice, or a slice after a recovery-
// point SEI — and a copied picture is only cut there; MakeMKV and mkvmerge cue
// (and flag) every I-frame of a Blu-ray's open GOPs. So each cued frame's NAL
// units are looked at, and only ffmpeg's keyframes kept. A cue without the
// block's place in its cluster (MakeMKV writes none) is found by stepping
// through the cluster's first blocks. The kept cues are a subset of the
// keyframes ffprobe finds — every one a place a segment may start. Too sparse to
// cut ~6 s segments on, not reaching the end, anything but H.264, or a file laid
// out some other way: null, and ffprobe is asked as before. Times come out as
// ffprobe prints them: Matroska stores presentation times, in TimestampScale units.
import fs from "node:fs/promises";

const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  info: 0x1549a966,
  timestampScale: 0x2ad7b1,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTime: 0xb3,
  cueTrackPositions: 0xb7,
  cueTrack: 0xf7,
  cueClusterPosition: 0xf1,
  cueRelativePosition: 0xf0,
  cluster: 0x1f43b675,
  clusterTimestamp: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1
} as const;

/** An index bigger than this is not one worth reading into memory. */
const ELEMENT_MAX_BYTES = 64 * 1024 * 1024;
/** Top-level elements looked at before giving up on finding the index. */
const TOP_LEVEL_MAX = 64;
/** The longest stretch without a keyframe an index may have and still be used. */
const GAP_MAX_S = 60;
/** How far from either end of the film the first and last keyframe may sit. */
const EDGE_MAX_S = 30;
/** Cues looked at, at once. */
const CUE_READS = 16;
/** The first read at a cue, and the most read at once as its window grows. */
const WINDOW_FIRST = 4 * 1024;
const WINDOW_MAX = 256 * 1024;
/** Bytes a block or element header is read in. */
const CHUNK = 64;
/** Elements stepped over in a cluster before giving up on finding the cued block. */
const CLUSTER_STEPS = 64;
/** NAL units read through in a frame before giving up on finding its first slice. */
const NAL_STEPS = 32;
/** An SEI bigger than this is not read through for a recovery point. */
const SEI_MAX_BYTES = 64 * 1024;

interface Element {
  id: number;
  /** Where the payload starts, from the start of the buffer or file read. */
  start: number;
  /** Where it ends; null when the size is unknown (a live stream's segment). */
  end: number | null;
}

/** A variable-length integer at `at`: its value and its width. The marker bit is
 *  kept for an ID and dropped for a size; a size of all ones is unknown (null). */
function vint(buffer: Buffer, at: number, keepMarker: boolean): { value: number | null; width: number } | null {
  if (at >= buffer.length) return null;
  const first = buffer[at];
  let width = 1;
  while (width <= 8 && !(first & (0x80 >> (width - 1)))) width++;
  if (width > 8 || at + width > buffer.length) return null;
  let value = keepMarker ? first : first & (0xff >> width);
  let allOnes = value === (0xff >> width);
  for (let i = 1; i < width; i++) {
    value = value * 256 + buffer[at + i];
    if (buffer[at + i] !== 0xff) allOnes = false;
  }
  if (!keepMarker && allOnes) return { value: null, width };
  return value > Number.MAX_SAFE_INTEGER ? null : { value, width };
}

/** The element whose header starts at `at`. */
function header(buffer: Buffer, at: number): Element | null {
  const id = vint(buffer, at, true);
  if (!id || id.width > 4) return null;
  const size = vint(buffer, at + id.width, false);
  if (!size) return null;
  const start = at + id.width + size.width;
  return { id: id.value!, start, end: size.value === null ? null : start + size.value };
}

/** The children of a payload held whole in `buffer`. */
function* children(buffer: Buffer, start: number, end: number): Generator<Element> {
  let at = start;
  while (at < end) {
    const found = header(buffer, at);
    if (!found || found.end === null || found.end > end) return;
    yield found;
    at = found.end;
  }
}

function uint(buffer: Buffer, element: Element): number {
  let value = 0;
  for (let i = element.start; i < element.end!; i++) value = value * 256 + buffer[i];
  return value;
}

async function readAt(handle: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

/** The payload of the top-level element at `position` in the file, when it is `id`. */
async function readElement(handle: fs.FileHandle, position: number, id: number): Promise<Buffer | null> {
  const head = await readAt(handle, position, 12);
  const found = header(head, 0);
  if (!found || found.id !== id || found.end === null || found.end - found.start > ELEMENT_MAX_BYTES) return null;
  const payload = await readAt(handle, position + found.start, found.end - found.start);
  return payload.length === found.end - found.start ? payload : null;
}

interface Layout {
  /** Where the Segment's payload starts: what SeekPosition counts from. */
  base: number;
  /** Each top-level element's position in the file, by ID. */
  at: Map<number, number>;
}

/** Where Info, Tracks and Cues sit: walked from the front up to the first
 *  Cluster, then the SeekHead (and one it points to) fills in the rest. */
async function layoutOf(handle: fs.FileHandle, size: number): Promise<Layout | null> {
  const head = await readAt(handle, 0, Math.min(size, 64));
  const ebml = header(head, 0);
  if (!ebml || ebml.id !== ID.ebml || ebml.end === null) return null;
  const segmentHead = await readAt(handle, ebml.end, 12);
  const segment = header(segmentHead, 0);
  if (!segment || segment.id !== ID.segment) return null;
  const base = ebml.end + segment.start;
  const segmentEnd = segment.end === null ? size : Math.min(size, ebml.end + segment.end);

  const at = new Map<number, number>();
  const seekHeads: number[] = [];
  let position = base;
  for (let n = 0; n < TOP_LEVEL_MAX && position < segmentEnd; n++) {
    const found = header(await readAt(handle, position, 12), 0);
    if (!found) break;
    if (!at.has(found.id)) at.set(found.id, position);
    if (found.id === ID.seekHead) seekHeads.push(position);
    if (found.id === ID.cluster || found.end === null) break;
    position += found.end;
  }
  for (let n = 0; n < seekHeads.length && n < 2; n++) {
    const payload = await readElement(handle, seekHeads[n], ID.seekHead);
    if (!payload) continue;
    for (const seek of children(payload, 0, payload.length)) {
      if (seek.id !== ID.seek) continue;
      let target: number | null = null;
      let offset: number | null = null;
      for (const field of children(payload, seek.start, seek.end!)) {
        // A SeekID holds an element ID's bytes as they are written, marker included.
        if (field.id === ID.seekId) target = uint(payload, field);
        if (field.id === ID.seekPosition) offset = uint(payload, field);
      }
      if (target === null || offset === null || base + offset >= size) continue;
      // A SeekHead may hand on to a second one, at the end of the file.
      if (target === ID.seekHead && !seekHeads.includes(base + offset)) seekHeads.push(base + offset);
      else if (!at.has(target)) at.set(target, base + offset);
    }
  }
  return { base, at };
}

interface VideoTrack {
  number: number;
  width: number;
  height: number;
  codec: string;
  /** Bytes in each NAL unit's length prefix (from the avcC), for H.264. */
  nalLength: number;
}

function videoTracks(tracks: Buffer): VideoTrack[] {
  const found: VideoTrack[] = [];
  for (const entry of children(tracks, 0, tracks.length)) {
    if (entry.id !== ID.trackEntry) continue;
    const track: VideoTrack = { number: 0, width: 0, height: 0, codec: "", nalLength: 0 };
    let type = 0;
    for (const field of children(tracks, entry.start, entry.end!)) {
      if (field.id === ID.trackNumber) track.number = uint(tracks, field);
      if (field.id === ID.trackType) type = uint(tracks, field);
      if (field.id === ID.codecId) track.codec = tracks.toString("latin1", field.start, field.end!).replace(/\0+$/, "");
      // avcC: version, profile, compatibility, level, then the prefix length less one.
      if (field.id === ID.codecPrivate && field.end! - field.start >= 5) track.nalLength = (tracks[field.start + 4] & 0x03) + 1;
      if (field.id === ID.video) {
        for (const size of children(tracks, field.start, field.end!)) {
          if (size.id === ID.pixelWidth) track.width = uint(tracks, size);
          if (size.id === ID.pixelHeight) track.height = uint(tracks, size);
        }
      }
    }
    if (type === 1 && track.number > 0) found.push(track);
  }
  return found;
}

interface Cue {
  /** In TimestampScale units. */
  time: number;
  /** The cluster's position in the file. */
  cluster: number;
  /** The block's, from the cluster's payload; null when the muxer didn't say. */
  relative: number | null;
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** Where the keyframes of the film's picture are, in seconds as ffprobe would
 *  print them; null when the index can't say and ffprobe must be asked. `info`
 *  is what ffprobe found: the picture (to pick the same track) and the film's
 *  span (to tell an index that covers it from one that doesn't). H.264 only:
 *  the one picture a browser is given copied as it is. */
export async function mkvKeyframes(
  file: string,
  info: { start: number; duration: number; video: { width: number; height: number } }
): Promise<number[] | null> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const layout = await layoutOf(handle, size);
    if (!layout) return null;
    const infoAt = layout.at.get(ID.info);
    const tracksAt = layout.at.get(ID.tracks);
    const cuesAt = layout.at.get(ID.cues);
    if (tracksAt === undefined || cuesAt === undefined) return null;

    let scale = 1_000_000;
    const segmentInfo = infoAt === undefined ? null : await readElement(handle, infoAt, ID.info);
    if (segmentInfo) {
      for (const field of children(segmentInfo, 0, segmentInfo.length)) {
        if (field.id === ID.timestampScale) scale = uint(segmentInfo, field);
      }
    }
    if (!(scale > 0)) return null;

    const tracks = await readElement(handle, tracksAt, ID.tracks);
    if (!tracks) return null;
    const pictures = videoTracks(tracks);
    const track = pictures.length === 1 ? pictures[0]
      : pictures.find((candidate) => candidate.width === info.video.width && candidate.height === info.video.height);
    if (!track || track.codec !== "V_MPEG4/ISO/AVC" || track.nalLength === 0) return null;

    const cues = await readElement(handle, cuesAt, ID.cues);
    if (!cues) return null;
    const points: Cue[] = [];
    for (const point of children(cues, 0, cues.length)) {
      if (point.id !== ID.cuePoint) continue;
      let time: number | null = null;
      let cluster: number | null = null;
      let relative: number | null = null;
      for (const field of children(cues, point.start, point.end!)) {
        if (field.id === ID.cueTime) time = uint(cues, field);
        if (field.id !== ID.cueTrackPositions) continue;
        let ours = false;
        let at: number | null = null;
        let inside: number | null = null;
        for (const position of children(cues, field.start, field.end!)) {
          if (position.id === ID.cueTrack) ours = uint(cues, position) === track.number;
          if (position.id === ID.cueClusterPosition) at = uint(cues, position);
          if (position.id === ID.cueRelativePosition) inside = uint(cues, position);
        }
        if (ours) {
          cluster = at;
          relative = inside;
        }
      }
      if (time !== null && cluster !== null) points.push({ time, cluster: layout.base + cluster, relative });
    }

    // Each cued frame, a few at a time: kept when ffmpeg would call it a keyframe.
    const keyframe = await mapLimit(points, CUE_READS, (point) => keyframeAt(handle, point, track));
    if (keyframe.includes(null)) return null;
    const times = new Set<number>();
    points.forEach((point, n) => { if (keyframe[n]) times.add(round6((point.time * scale) / 1e9)); });
    const sorted = [...times].sort((a, b) => a - b);
    return covers(sorted, info) ? sorted : null;
  } finally {
    await handle.close();
  }
}

/** Reads one cue's bytes through a window that moves forward and grows: walking a
 *  cluster to its block, then the frame's first NAL units, is a handful of reads
 *  rather than one round trip per header (which on a network share is the cost). */
class Window {
  private start = 0;
  private buffer: Buffer = Buffer.alloc(0);
  private size = WINDOW_FIRST;

  constructor(private handle: fs.FileHandle) {}

  async bytes(position: number, length: number): Promise<Buffer> {
    const from = position - this.start;
    if (from >= 0 && from + length <= this.buffer.length) return this.buffer.subarray(from, from + length);
    if (this.buffer.length > 0) this.size = Math.min(this.size * 2, WINDOW_MAX);
    this.buffer = await readAt(this.handle, position, Math.max(length, this.size));
    this.start = position;
    return this.buffer.subarray(0, Math.min(length, this.buffer.length));
  }
}

/** A block's track, its time from the cluster's, and where its frame lies. */
interface BlockHead {
  track: number;
  offset: number;
  /** Several frames in one block (sound, never the picture): no frame to read. */
  laced: boolean;
  frame: number;
  end: number;
}

/** The SimpleBlock, or the Block inside the BlockGroup, at `position`, whose
 *  first bytes are `head`. `block` is null for any other element (`end` is where
 *  it ends); the whole answer is null for what can't be read. */
async function blockAt(window: Window, position: number, head: Buffer): Promise<{ block: BlockHead | null; end: number } | null> {
  let element = header(head, 0);
  if (!element || element.end === null) return null;
  const end = position + element.end;
  let at = position;
  let bytes = head;
  if (element.id === ID.blockGroup) {
    // Its Block comes first, in practice; anything before it is stepped over.
    at = position + element.start;
    for (let n = 0; n < 4; n++) {
      bytes = await window.bytes(at, CHUNK);
      element = header(bytes, 0);
      if (!element || element.end === null) return null;
      if (element.id === ID.block) break;
      at += element.end;
    }
    if (element.id !== ID.block) return null;
  } else if (element.id !== ID.simpleBlock) {
    return { block: null, end };
  }
  const number = vint(bytes, element.start, false);
  if (!number || number.value === null || element.start + number.width + 3 > bytes.length) return null;
  return {
    block: {
      track: number.value,
      offset: bytes.readInt16BE(element.start + number.width),
      laced: (bytes[element.start + number.width + 2] & 0x06) !== 0,
      frame: at + element.start + number.width + 3,
      end: at + element.end!
    },
    end
  };
}

/** Whether the cued frame is one of ffmpeg's keyframes; null when it can't be found or read. */
async function keyframeAt(handle: fs.FileHandle, cue: Cue, track: VideoTrack): Promise<boolean | null> {
  const window = new Window(handle);
  const clusterHead = header(await window.bytes(cue.cluster, 12), 0);
  if (!clusterHead || clusterHead.id !== ID.cluster) return null;
  const payload = cue.cluster + clusterHead.start;
  let block: BlockHead | null = null;
  if (cue.relative !== null) {
    const position = payload + cue.relative;
    block = (await blockAt(window, position, await window.bytes(position, CHUNK)))?.block ?? null;
    if (!block || block.track !== track.number) return null;
  } else {
    // The cluster's timestamp, then its blocks in turn, to the one at the cue's time.
    const clusterEnd = clusterHead.end === null ? Infinity : cue.cluster + clusterHead.end;
    let clusterTime: number | null = null;
    let at = payload;
    for (let n = 0; n < CLUSTER_STEPS && at < clusterEnd && !block; n++) {
      const bytes = await window.bytes(at, CHUNK);
      const element = header(bytes, 0);
      if (!element || element.end === null) return null;
      if (element.id === ID.clusterTimestamp) clusterTime = uint(bytes, element);
      if (element.id === ID.simpleBlock || element.id === ID.blockGroup) {
        if (clusterTime === null) return null;
        const found = await blockAt(window, at, bytes);
        if (!found) return null;
        if (found.block && found.block.track === track.number && clusterTime + found.block.offset === cue.time) block = found.block;
      }
      at += element.end;
    }
    if (!block) return null;
  }
  if (block.laced) return null;
  return avcKeyframe(window, block, track.nalLength);
}

/** ffmpeg's H.264 parser's verdict on a frame (what ffprobe prints, and where
 *  ffmpeg cuts a copied picture): an IDR slice, or a slice after a recovery-point
 *  SEI. Its NAL units are read in turn, up to the first slice. */
async function avcKeyframe(window: Window, block: BlockHead, nalLength: number): Promise<boolean | null> {
  let at = block.frame;
  let recovery = false;
  for (let n = 0; n < NAL_STEPS && at + nalLength < block.end; n++) {
    const head = await window.bytes(at, nalLength + 1);
    if (head.length < nalLength + 1) return null;
    const length = head.readUIntBE(0, nalLength);
    if (length === 0) return null;
    const type = head[nalLength] & 0x1f;
    if (type === 5) return true;
    if (type === 1) return recovery;
    if (type === 6 && length <= SEI_MAX_BYTES && seiHasRecoveryPoint(await window.bytes(at + nalLength + 1, length - 1))) recovery = true;
    at += nalLength + length;
  }
  return null;
}

/** Whether an SEI's messages include a recovery point (payload type 6). */
function seiHasRecoveryPoint(escaped: Buffer): boolean {
  // The raw bytes, without the 0x03 that keeps 00 00 0x from looking like a start code.
  const raw: number[] = [];
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] === 3 && raw.length >= 2 && raw[raw.length - 1] === 0 && raw[raw.length - 2] === 0) continue;
    raw.push(escaped[i]);
  }
  let at = 0;
  while (at < raw.length && raw[at] !== 0x80) {
    let type = 0;
    while (raw[at] === 0xff) { type += 255; at++; }
    type += raw[at++] ?? 0;
    let size = 0;
    while (raw[at] === 0xff) { size += 255; at++; }
    size += raw[at++] ?? 0;
    if (type === 6) return true;
    at += size;
  }
  return false;
}

/** `work` over every item, `limit` at a time, answers in order. */
async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const n = next++;
      out[n] = await work(items[n]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Whether the keyframes reach both ends of the film with no long stretch between two. */
function covers(times: number[], span: { start: number; duration: number }): boolean {
  if (times.length < 2 || !(span.duration > 0)) return false;
  if (times[0] - span.start > EDGE_MAX_S) return false;
  if (span.start + span.duration - times[times.length - 1] > EDGE_MAX_S) return false;
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > GAP_MAX_S) return false;
  return true;
}
