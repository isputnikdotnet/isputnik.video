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
import type { AudioStream, MediaInfo } from "./ffmpeg.js";

export type DeliveryMode = "direct" | "remux" | "transcode";

/** Why the file is not sent as it is. */
export type DeliveryReason = "container" | "audio" | "video";

export interface Delivery {
  mode: DeliveryMode;
  reasons: DeliveryReason[];
  /** The audio stream played, by ffprobe index; null for a silent file. */
  audio: AudioStream | null;
  /** HLS only: whether the sound is converted, and the picture. */
  audioCopy: boolean;
  videoCopy: boolean;
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

export function decideDelivery(info: MediaInfo, extension: string): Delivery {
  const audio = chooseAudio(info);
  const reasons: DeliveryReason[] = [];
  const ext = extension.toLowerCase();

  // Direct: an MP4 with H.264, or a real WebM (VP8/VP9/AV1), with sound to match.
  const directContainer = (isMp4(info.container) && [".mp4", ".m4v", ".mov"].includes(ext)) || (ext === ".webm" && isWebm(info.container));
  const directVideo = !info.video || (isMp4(info.container) ? browserH264(info) : ["vp8", "vp9", "av1"].includes(info.video.codec));
  const directAudio = !audio || DIRECT_AUDIO.has(audio.codec);
  if (directContainer && directVideo && directAudio) {
    return { mode: "direct", reasons, audio, audioCopy: true, videoCopy: true };
  }

  if (!directContainer) reasons.push("container");
  const videoCopy = !info.video || browserH264(info);
  const audioCopy = !audio || SEGMENT_AUDIO.has(audio.codec);
  if (!audioCopy || !directAudio) reasons.push("audio");
  if (!videoCopy) reasons.push("video");
  return { mode: videoCopy ? "remux" : "transcode", reasons: [...new Set(reasons)], audio, audioCopy, videoCopy };
}
