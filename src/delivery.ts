// How a file reaches the browser (home's docs/apps-platform-plan.md → V2):
//
// - direct:    the file as it is, with byte ranges — an MP4 or WebM whose
//              picture and sound every browser decodes.
// - remux:     the picture as it is, cut into HLS segments, the sound converted
//              to AAC when the browser can't decode it (AC3, DTS, TrueHD…).
//              Cheap: nothing but the sound is encoded.
// - transcode: the picture re-encoded to H.264 as well, for what browsers can't
//              show (HEVC, 10-bit, MPEG-2, VC-1…). Costs real CPU.
//
// HLS segments are MPEG-TS, which Safari plays natively and every other browser
// through hls.js — so the picture that goes in as is must be 8-bit H.264.
//
// A quality rung (home's docs/video-quality-plan.md) is a ceiling on the picture
// for a viewer on a slow link: the tallest it may be and the most bits per second.
// A file above it is re-encoded even when a browser could play it as it is; one
// under it goes the way it would anyway, since there is nothing to shrink.
import type { AudioStream, MediaInfo, SubtitleStream } from "./ffmpeg.js";
import { isImageSubtitle } from "./subtitles.js";

export type DeliveryMode = "direct" | "remux" | "transcode";

/** Why the file is not sent as it is; "size": it is above the quality rung asked. */
export type DeliveryReason = "container" | "audio" | "video" | "subtitles" | "size";

/** The pictures a conversion may be asked to fit: their height. Null is the file as it is. */
export type Rung = 1080 | 720 | 480;
export const RUNGS: readonly Rung[] = [1080, 720, 480];

/** What each rung makes: the picture's bits per second aimed for and the most
 *  allowed (a file already under the most is left as it is), and the sound's. */
export const RUNG_LIMITS: Record<Rung, { bitRate: number; maxRate: number; audioRate: number }> = {
  1080: { bitRate: 8_000_000, maxRate: 10_000_000, audioRate: 192_000 },
  720: { bitRate: 3_000_000, maxRate: 4_000_000, audioRate: 128_000 },
  480: { bitRate: 1_500_000, maxRate: 2_000_000, audioRate: 96_000 }
};

/** A rung from what a request says ("720"), or null for anything else. */
export function rungOf(value: string | number | null | undefined): Rung | null {
  const height = Number(value);
  return (RUNGS as readonly number[]).includes(height) ? (height as Rung) : null;
}

export interface Delivery {
  mode: DeliveryMode;
  reasons: DeliveryReason[];
  /** The audio stream played, by ffprobe index; null for a silent file. */
  audio: AudioStream | null;
  /** An image subtitle drawn onto the picture (which is then re-encoded). */
  burn: SubtitleStream | null;
  /** HLS only: whether the sound is converted, and the picture. */
  audioCopy: boolean;
  videoCopy: boolean;
  /** The ceiling the picture was held under; null for the file as it is. */
  rung: Rung | null;
}

/** Sound every browser decodes inside MP4 or WebM. */
const DIRECT_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
/** Sound HLS-in-MPEG-TS carries as it is. */
const SEGMENT_AUDIO = new Set(["aac", "mp3"]);
/** 8-bit 4:2:0 — what H.264 decoders in browsers take. */
const BROWSER_PIXELS = new Set(["yuv420p", "yuvj420p"]);

const isMp4 = (container: string) => /(^|,)(mov|mp4)(,|$)/.test(container);
const isWebm = (container: string) => container.split(",").includes("webm") || container === "matroska,webm";

const browserH264 = (info: MediaInfo) =>
  info.video?.codec === "h264" && (info.video.pixelFormat === null || BROWSER_PIXELS.has(info.video.pixelFormat));

/** The sound to play: the one marked default, else the first. */
export function chooseAudio(info: MediaInfo): AudioStream | null {
  return info.audio.find((stream) => stream.default) ?? info.audio[0] ?? null;
}

/** `audioIndex`: the sound the person chose (ffprobe's stream index); the default
 *  one when it is left out or isn't in the file. `burnIndex`: an image subtitle
 *  to draw onto the picture — a browser can't show PGS or DVD subtitles itself,
 *  so the picture is re-encoded with them on it. `rung`: a ceiling on the
 *  picture (height and bitrate); a file above it is re-encoded down to it. */
export function decideDelivery(info: MediaInfo, extension: string, audioIndex?: number | null, burnIndex?: number | null, rung: Rung | null = null): Delivery {
  const audio = info.audio.find((stream) => stream.index === audioIndex) ?? chooseAudio(info);
  const burnable = info.video ? (info.subtitles ?? []).find((stream) => stream.index === burnIndex && isImageSubtitle(stream.codec)) : undefined;
  const burn = burnable ?? null;
  const reasons: DeliveryReason[] = [];
  const ext = extension.toLowerCase();
  // Above the rung: taller than it, or heavier than the most it would make.
  const oversize = rung !== null && info.video !== null && (info.video.height > rung || (info.bitRate ?? 0) > RUNG_LIMITS[rung].maxRate);

  // Direct: an MP4 with H.264, or a real WebM (VP8/VP9/AV1), with sound to match.
  const directContainer = (isMp4(info.container) && [".mp4", ".m4v", ".mov"].includes(ext)) || (ext === ".webm" && isWebm(info.container));
  const directVideo = !info.video || (isMp4(info.container) ? browserH264(info) : ["vp8", "vp9", "av1"].includes(info.video.codec));
  // With more than one sound track the browser picks which it plays, and no
  // browser lets a page choose reliably: those go as HLS, with the one chosen.
  const directAudio = !audio || (DIRECT_AUDIO.has(audio.codec) && info.audio.length <= 1);
  if (directContainer && directVideo && directAudio && !burn && !oversize) {
    return { mode: "direct", reasons, audio, burn, audioCopy: true, videoCopy: true, rung };
  }

  if (!directContainer) reasons.push("container");
  const videoCopy = (!info.video || browserH264(info)) && !burn && !oversize;
  const audioCopy = !audio || SEGMENT_AUDIO.has(audio.codec);
  if (!audioCopy || !directAudio) reasons.push("audio");
  if (info.video && !browserH264(info)) reasons.push("video");
  if (burn) reasons.push("subtitles");
  if (oversize) reasons.push("size");
  return { mode: videoCopy ? "remux" : "transcode", reasons: [...new Set(reasons)], audio, burn, audioCopy, videoCopy, rung };
}
