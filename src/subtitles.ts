// Subtitles (home's docs/apps-platform-plan.md → V2): the tracks inside a file
// and the subtitle files beside it, offered to the player.
//
// - Text (SRT, ASS, WebVTT, MP4's mov_text) is converted to WebVTT and shown by
//   the browser over whatever plays — direct or HLS, nothing re-encoded.
// - Images (Blu-ray PGS, DVD, DVB) no browser can show: they are drawn onto the
//   picture, which is then re-encoded (delivery.ts → burn, hls.ts).
//
// A file beside the film counts when its name is the film's plus a dot:
// "Film (2010).srt", "Film (2010).ru.srt", "Film (2010).en.forced.srt". A Russian
// family's SRT is as often Windows-1251 as UTF-8; what isn't UTF-8 is read as
// that.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { toWebVtt, type MediaInfo, type SubtitleStream, type Tools } from "./ffmpeg.js";

const TEXT_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"]);
const IMAGE_CODECS = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"]);

/** Subtitle files beside a film, by extension: ffmpeg's name for the format. */
const SIDECAR_FORMATS: Record<string, string> = { ".srt": "srt", ".ass": "ass", ".ssa": "ass", ".vtt": "webvtt" };

export const isTextSubtitle = (codec: string) => TEXT_CODECS.has(codec);
export const isImageSubtitle = (codec: string) => IMAGE_CODECS.has(codec);

export interface SubtitleTrack {
  /** s<stream index> inside the file, x<hash> for a file beside it. */
  id: string;
  kind: "text" | "image";
  codec: string;
  /** ISO 639 as the file or the file name gives it; null when neither does. */
  language: string | null;
  title: string | null;
  default: boolean;
  forced: boolean;
  external: boolean;
}

interface Sidecar {
  track: SubtitleTrack;
  file: string;
  format: string;
}

const FORCED = new Set(["forced", "foreign"]);
const SDH = new Set(["sdh", "cc", "hi"]);

/** The subtitle files beside a video file. */
function sidecars(videoFile: string): Sidecar[] {
  const dir = path.dirname(videoFile);
  const base = path.basename(videoFile, path.extname(videoFile)).toLowerCase();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const found: Sidecar[] = [];
  for (const name of names.sort()) {
    const ext = path.extname(name).toLowerCase();
    const format = SIDECAR_FORMATS[ext];
    const stem = name.slice(0, name.length - ext.length);
    if (!format || !(stem.toLowerCase() === base || stem.toLowerCase().startsWith(`${base}.`))) continue;
    // What lies between the film's name and the extension: language, forced, SDH.
    const parts = stem.slice(base.length).split(".").filter(Boolean);
    let language: string | null = null;
    let forced = false;
    const words: string[] = [];
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (FORCED.has(lower)) forced = true;
      else if (!language && /^[a-z]{2,3}(-[a-z]{2})?$/i.test(part) && !SDH.has(lower)) language = lower.split("-")[0];
      else words.push(SDH.has(lower) ? part.toUpperCase() : part);
    }
    found.push({
      file: path.join(dir, name),
      format,
      track: {
        id: `x${crypto.createHash("sha1").update(name).digest("hex").slice(0, 10)}`,
        kind: "text",
        codec: format,
        language,
        title: words.length > 0 ? words.join(" ") : null,
        default: false,
        forced,
        external: true
      }
    });
  }
  return found;
}

const embeddedTrack = (stream: SubtitleStream): SubtitleTrack | null => {
  const kind = isTextSubtitle(stream.codec) ? "text" : isImageSubtitle(stream.codec) ? "image" : null;
  if (!kind) return null;
  return {
    id: `s${stream.index}`,
    kind,
    codec: stream.codec,
    language: stream.language && stream.language !== "und" ? stream.language : null,
    title: stream.title,
    default: stream.default,
    forced: stream.forced,
    external: false
  };
};

/** Every subtitle the player can offer for a file: inside it first, then beside it. */
export function listSubtitles(info: MediaInfo | null, videoFile: string): SubtitleTrack[] {
  const inside = (info?.subtitles ?? []).map(embeddedTrack).filter((track): track is SubtitleTrack => track !== null);
  // An image subtitle is drawn onto the picture: a file without one has nothing to draw on.
  const drawable = inside.filter((track) => track.kind === "text" || info?.video);
  return [...drawable, ...sidecars(videoFile).map((sidecar) => sidecar.track)];
}

/** The stream index of an image track id ("s4" → 4); null for anything else. */
export function burnIndexOf(tracks: SubtitleTrack[], id: string | null | undefined): number | null {
  const track = id ? tracks.find((candidate) => candidate.id === id) : undefined;
  return track?.kind === "image" ? Number(track.id.slice(1)) : null;
}

/** A subtitle file's text as UTF-8: as it is when it is UTF-8, else read as Windows-1251. */
export function decodeSubtitleText(raw: Buffer): Buffer {
  const bomless = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.subarray(3) : raw;
  if (raw[0] === 0xff && raw[1] === 0xfe) return Buffer.from(new TextDecoder("utf-16le").decode(raw.subarray(2)), "utf8");
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bomless);
    return bomless;
  } catch {
    return Buffer.from(new TextDecoder("windows-1251").decode(bomless), "utf8");
  }
}

/** How many converted tracks are kept: a season's worth, a few hundred KB each. */
const CACHE_SIZE = 40;

/** Text subtitles as WebVTT, converted once and kept while the file is unchanged.
 *  Two requests for the same track share one conversion. */
export class SubtitleCache {
  private done = new Map<string, string>();
  private running = new Map<string, Promise<string>>();

  constructor(private tools: Tools) {}

  /** The WebVTT for `trackId`; null when the file has no such text track. */
  async webVtt(info: MediaInfo | null, file: { absolute: string; size: number; modified: Date }, trackId: string): Promise<string | null> {
    const track = listSubtitles(info, file.absolute).find((candidate) => candidate.id === trackId);
    if (!track || track.kind !== "text") return null;
    const sidecar = track.external ? sidecars(file.absolute).find((candidate) => candidate.track.id === trackId) : undefined;
    let stamp = `${file.size}:${file.modified.getTime()}`;
    if (sidecar) {
      const stat = fs.statSync(sidecar.file);
      stamp = `${stat.size}:${stat.mtimeMs}`;
    }
    const key = `${file.absolute}\n${trackId}\n${stamp}`;
    const cached = this.done.get(key);
    if (cached !== undefined) {
      // Most recently used goes to the back of the line.
      this.done.delete(key);
      this.done.set(key, cached);
      return cached;
    }
    const running = this.running.get(key);
    if (running) return running;
    const work = (sidecar
      ? toWebVtt(this.tools, { text: decodeSubtitleText(fs.readFileSync(sidecar.file)), format: sidecar.format })
      : toWebVtt(this.tools, { file: file.absolute, index: Number(trackId.slice(1)) })
    ).then((vtt) => {
      this.done.set(key, vtt);
      while (this.done.size > CACHE_SIZE) this.done.delete(this.done.keys().next().value!);
      return vtt;
    }).finally(() => this.running.delete(key));
    this.running.set(key, work);
    return work;
  }
}
