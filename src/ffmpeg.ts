// ffmpeg and ffprobe: what is inside a file (its streams, its keyframes), for
// deciding how it reaches a browser (delivery.ts) and for cutting it into
// segments (hls.ts). The image installs both on PATH; a source checkout uses the
// ffmpeg-static and ffprobe-static dev dependencies; FFMPEG_PATH / FFPROBE_PATH
// override either.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function devBinary(name: "ffmpeg-static" | "ffprobe-static"): string | null {
  try {
    const found = require(name) as string | { path: string } | null;
    return typeof found === "string" ? found : found?.path ?? null;
  } catch {
    return null;
  }
}

export interface Tools {
  ffmpeg: string;
  ffprobe: string;
}

export function findTools(env: NodeJS.ProcessEnv = process.env): Tools {
  return {
    ffmpeg: env.FFMPEG_PATH?.trim() || devBinary("ffmpeg-static") || "ffmpeg",
    ffprobe: env.FFPROBE_PATH?.trim() || devBinary("ffprobe-static") || "ffprobe"
  };
}

function run(binary: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${String(stderr).trim().split("\n").pop() || err.message}`));
      else resolve(stdout);
    });
  });
}

/** Whether ffprobe answers at all: without it every file is played as it is or not at all. */
export async function toolsWork(tools: Tools): Promise<boolean> {
  try {
    await run(tools.ffprobe, ["-version"], 10_000);
    await run(tools.ffmpeg, ["-version"], 10_000);
    return true;
  } catch {
    return false;
  }
}

export interface VideoStream {
  index: number;
  codec: string;
  profile: string | null;
  pixelFormat: string | null;
  width: number;
  height: number;
}

export interface AudioStream {
  index: number;
  codec: string;
  channels: number;
  language: string | null;
  title: string | null;
  default: boolean;
}

export interface MediaInfo {
  /** ffprobe's format names, e.g. "matroska,webm" or "mov,mp4,m4a,3gp,3g2,mj2". */
  container: string;
  /** When the file's clock starts (an MPEG-TS recording seldom starts at 0). */
  start: number;
  duration: number;
  video: VideoStream | null;
  audio: AudioStream[];
}

interface ProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  channels?: number;
  tags?: Record<string, string>;
  disposition?: { default?: number; attached_pic?: number };
  duration?: string;
}

/** The file's streams and length; reads only its header. */
export async function probe(tools: Tools, file: string): Promise<MediaInfo> {
  const out = await run(tools.ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], 60_000);
  const parsed = JSON.parse(out) as { format?: { format_name?: string; duration?: string; start_time?: string }; streams?: ProbeStream[] };
  const streams = parsed.streams ?? [];
  // A cover picture is a "video" stream too; the film is the first real one.
  const video = streams.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  const duration = Number(parsed.format?.duration ?? video?.duration ?? 0);
  const start = Number(parsed.format?.start_time ?? 0);
  return {
    container: parsed.format?.format_name ?? "",
    start: Number.isFinite(start) ? start : 0,
    duration: Number.isFinite(duration) ? duration : 0,
    video: video ? {
      index: video.index,
      codec: video.codec_name ?? "",
      profile: video.profile ?? null,
      pixelFormat: video.pix_fmt ?? null,
      width: video.width ?? 0,
      height: video.height ?? 0
    } : null,
    audio: streams.filter((stream) => stream.codec_type === "audio").map((stream) => ({
      index: stream.index,
      codec: stream.codec_name ?? "",
      channels: stream.channels ?? 2,
      language: stream.tags?.language ?? null,
      title: stream.tags?.title ?? null,
      default: stream.disposition?.default === 1
    }))
  };
}

/** Where the video's keyframes are, in seconds. Reads the whole file (packets
 *  only, nothing decoded): seconds for an episode, longer for a film on a slow disk. */
export async function keyframes(tools: Tools, file: string): Promise<number[]> {
  const out = await run(tools.ffprobe, [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", file
  ], 10 * 60_000);
  const times: number[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [time, flags] = line.split(",");
    if (!flags?.includes("K")) continue;
    const at = Number(time);
    if (Number.isFinite(at)) times.push(at);
  }
  return times.sort((a, b) => a - b);
}
