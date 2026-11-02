// The keyframes an MP4's header gives match what ffprobe finds walking the file.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findTools, keyframes, probe } from "../src/ffmpeg.js";
import { mp4Keyframes } from "../src/mp4-index.js";

describe("keyframes from an MP4's header", () => {
  const tools = findTools();
  let dir: string;

  // Twelve seconds of picture with B-frames (a composition offset and an edit
  // list, as every x264 MP4 has), a keyframe every two seconds, and sound.
  const make = (name: string, ...extra: string[]) => {
    const file = path.join(dir, name);
    execFileSync(tools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-bf", "2", "-g", "48", "-pix_fmt", "yuv420p", "-c:a", "aac", ...extra, file]);
    return file;
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-mp4-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the same keyframes ffprobe finds, with the header at the end or the front", async () => {
    for (const file of [make("end.mp4"), make("front.m4v", "-movflags", "+faststart")]) {
      const info = await probe(tools, file);
      const walked = await keyframes(tools, file);
      const read = await mp4Keyframes(file, info.video!);
      expect(read).not.toBeNull();
      expect(read!.length).toBe(walked.length);
      read!.forEach((at, n) => expect(Math.abs(at - walked[n])).toBeLessThan(1e-5));
      expect(read!.length).toBeGreaterThanOrEqual(6);
    }
  }, 60_000);

  it("leaves a fragmented MP4 and anything that is not an MP4 to ffprobe", async () => {
    const fragmented = make("frag.mp4", "-movflags", "frag_keyframe+empty_moov");
    const matroska = make("film.mkv");
    expect(await mp4Keyframes(fragmented, { width: 160, height: 120 })).toBeNull();
    expect(await mp4Keyframes(matroska, { width: 160, height: 120 })).toBeNull();
  }, 60_000);

  it("picks the track whose picture ffprobe described when the file has several", async () => {
    const file = path.join(dir, "two.mp4");
    execFileSync(tools.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24", "-f", "lavfi", "-i", "testsrc2=size=80x60:rate=12",
      "-t", "6", "-map", "0:v", "-map", "1:v", "-c:v", "libx264", "-preset", "ultrafast", "-g", "24", "-pix_fmt", "yuv420p", file]);
    const walked = await keyframes(tools, file);
    const read = await mp4Keyframes(file, { width: 160, height: 120 });
    expect(read).toEqual(walked.map((at) => expect.closeTo(at, 5)));
    expect(await mp4Keyframes(file, { width: 10, height: 10 })).toBeNull();
  }, 60_000);
});
