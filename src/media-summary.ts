// What a play is made of, for home's Diagnostics › Video, Live sessions: the
// file's picture, sound and container, and what actually goes to the player —
// the same when it is played as it is, otherwise what the conversion makes of
// it (hls.ts's encode: H.264 held under the rung, AAC stereo, MPEG-TS segments).

import { chooseAudio, type Delivery, type DeliveryReason } from "./delivery.js";
import { hdrOf, type AudioStream, type MediaInfo, type SubtitleStream } from "./ffmpeg.js";
import type { GpuRun } from "./hardware.js";

/** The tallest picture a conversion makes with no rung asked (hls.ts). */
export const MAX_HEIGHT = 1080;

export interface MediaVideo {
  codec: string;
  profile: string | null;
  width: number;
  height: number;
  /** 8, 10 or 12, from the pixel format; null when the file doesn't say. */
  bitDepth: number | null;
  hdr: "pq" | "hlg" | null;
}

export interface MediaAudio {
  codec: string;
  channels: number;
  language: string | null;
  title: string | null;
}

export interface MediaSubtitle {
  codec: string;
  language: string | null;
  title: string | null;
  forced: boolean;
}

export interface MediaSide {
  /** A short name: "mkv", "mp4", "webm", "ts", "avi", or "hls" for segments. */
  container: string;
  video: MediaVideo | null;
  audio: MediaAudio | null;
  /** The whole file's bits per second; null for what a conversion makes. */
  bitRate: number | null;
}

export interface PlayMedia {
  source: MediaSide;
  sent: MediaSide;
  /** Why it is not played as it is (delivery.ts); empty when it is. */
  reasons: DeliveryReason[];
  videoCopied: boolean;
  audioCopied: boolean;
  /** An image subtitle drawn onto the picture. */
  subtitlesBurned: boolean;
  /** The subtitle drawn onto the picture; null when none is. */
  subtitle: MediaSubtitle | null;
}

/** Where each step of a conversion's picture runs: null for a step it doesn't take. */
export type Where = "gpu" | "cpu" | null;
export interface Pipeline {
  decode: Where;
  /** HDR to SDR. */
  tonemap: Where;
  /** Down to the rung. */
  scale: Where;
  /** The subtitle drawn in. */
  overlay: Where;
  encode: Where;
}

/** ffprobe's format names in a word. */
export function containerOf(formats: string): string {
  const names = formats.split(",");
  // ffprobe says "matroska,webm" for both: the extension tells them apart (describeMedia).
  if (names.includes("matroska")) return "mkv";
  if (names.includes("webm")) return "webm";
  if (names.includes("mov") || names.includes("mp4")) return "mp4";
  if (names.includes("mpegts")) return "ts";
  return names[0] || "unknown";
}

function bitDepthOf(pixelFormat: string | null): number | null {
  if (!pixelFormat) return null;
  const deep = /p(10|12)(le|be)?$/.exec(pixelFormat);
  return deep ? Number(deep[1]) : 8;
}

const audioOf = (stream: AudioStream | null): MediaAudio | null =>
  stream ? { codec: stream.codec, channels: stream.channels, language: stream.language, title: stream.title } : null;

const subtitleOf = (stream: SubtitleStream | null): MediaSubtitle | null =>
  stream ? { codec: stream.codec, language: stream.language, title: stream.title, forced: stream.forced } : null;

/** Where a run's picture is decoded, tone-mapped, scaled, drawn on and encoded,
 *  as hls.ts's encode arguments place them; null when the picture is copied. */
export function pipelineOf(info: MediaInfo, delivery: Delivery, gpu: GpuRun | null): Pipeline | null {
  if (!info.video || delivery.videoCopy) return null;
  const on = (yes: boolean | undefined): Where => (yes ? "gpu" : "cpu");
  const burn = delivery.burn !== null;
  const shrink = info.video.height > (delivery.rung ?? MAX_HEIGHT);
  return {
    decode: on(gpu?.decode),
    tonemap: hdrOf(info.video) ? on(gpu?.tonemap) : null,
    // The GPU scales a picture it decoded (or overlays on); otherwise the CPU does, then uploads.
    scale: shrink ? on(Boolean(gpu && (burn ? gpu.overlay : gpu.decode))) : null,
    overlay: burn ? on(gpu?.overlay) : null,
    encode: on(Boolean(gpu))
  };
}

/** The file and what reaches the player; `delivery` null for a file played as it is. */
export function describeMedia(info: MediaInfo, delivery: Delivery | null, extension?: string): PlayMedia {
  const video: MediaVideo | null = info.video
    ? { codec: info.video.codec, profile: info.video.profile, width: info.video.width, height: info.video.height, bitDepth: bitDepthOf(info.video.pixelFormat), hdr: hdrOf(info.video) }
    : null;
  const chosen = delivery ? delivery.audio : chooseAudio(info);
  const container = extension === ".webm" ? "webm" : containerOf(info.container);
  const source: MediaSide = { container, video, audio: audioOf(chosen), bitRate: info.bitRate };
  if (!delivery || delivery.mode === "direct") {
    return { source, sent: source, reasons: [], videoCopied: true, audioCopied: true, subtitlesBurned: false, subtitle: null };
  }

  let sentVideo = video;
  if (video && !delivery.videoCopy) {
    const maxHeight = delivery.rung ?? MAX_HEIGHT;
    const shrink = video.height > maxHeight;
    sentVideo = {
      codec: "h264",
      profile: "High",
      width: shrink ? Math.max(2, Math.round((video.width * maxHeight) / video.height / 2) * 2) : video.width,
      height: shrink ? maxHeight : video.height,
      bitDepth: 8,
      hdr: null
    };
  }
  const sentAudio = !chosen ? null : delivery.audioCopy ? audioOf(chosen) : { codec: "aac", channels: 2, language: chosen.language, title: chosen.title };
  return {
    source,
    sent: { container: "hls", video: sentVideo, audio: sentAudio, bitRate: null },
    reasons: delivery.reasons,
    videoCopied: delivery.videoCopy,
    audioCopied: delivery.audioCopy,
    subtitlesBurned: Boolean(delivery.burn),
    subtitle: subtitleOf(info.video ? delivery.burn : null)
  };
}
