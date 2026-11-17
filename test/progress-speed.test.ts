// How fast a conversion is going right now (hls.ts progressSpeed, from ffmpeg's
// -progress), and what the GPU encodes as vainfo lists it (hardware.ts) — both for
// home's Diagnostics › Video page.
import { describe, expect, it } from "vitest";
import { addProgress, ffmpegArgs, progressSpeed, SPEED_WINDOW_MS, type ProgressSample } from "../src/hls.js";
import { encodeFormatsOf } from "../src/hardware.js";

describe("a run's speed", () => {
  it("is film written over the time it took, across the last few seconds", () => {
    // 3 s of film in 2 s: 1.5× real time.
    expect(progressSpeed([{ at: 0, out: 0 }, { at: 2000, out: 3_000_000 }])).toBe(1.5);
    expect(progressSpeed([{ at: 0, out: 0 }])).toBeNull();
    // Too short a stretch to say.
    expect(progressSpeed([{ at: 0, out: 0 }, { at: 400, out: 900_000 }])).toBeNull();
  });

  it("forgets a slow start: only the last window counts", () => {
    let samples: ProgressSample[] = [];
    // Ten seconds at a crawl (0.2×), then twenty at 2×.
    for (let at = 0; at <= 10_000; at += 1000) samples = addProgress(samples, { at, out: at * 200 });
    for (let at = 11_000; at <= 30_000; at += 1000) samples = addProgress(samples, { at, out: 2_000_000 + (at - 10_000) * 2000 });
    expect(samples[samples.length - 1].at - samples[1].at).toBeLessThan(SPEED_WINDOW_MS);
    expect(progressSpeed(samples)).toBe(2);
  });

  it("asks ffmpeg for its progress on a viewer's run", () => {
    const plan = {
      itemId: "m1", file: "/films/a.mkv", starts: [0, 6], segmentSeconds: 6,
      info: { start: 0, duration: 12, video: { index: 0, codec: "h264", pixFmt: "yuv420p", width: 1920, height: 1080, profile: "High", transfer: null }, audio: [], subtitles: [] },
      delivery: { mode: "convert", reasons: [], videoCopy: false, audioCopy: false, audioIndex: null, burn: null, rung: null }
    } as unknown as Parameters<typeof ffmpegArgs>[0];
    expect(ffmpegArgs(plan, 0, "/tmp/s", null, null, null, true)).toEqual(expect.arrayContaining(["-progress", "pipe:1"]));
    expect(ffmpegArgs(plan, 0, "/tmp/s")).not.toContain("-progress");
  });
});

describe("what the GPU encodes", () => {
  it("reads the encode entrypoints vainfo lists", () => {
    const vainfo = [
      "vainfo: Driver version: Intel iHD driver for Intel(R) Gen Graphics - 24.1.0 ()",
      "      VAProfileH264Main               :	VAEntrypointVLD",
      "      VAProfileH264Main               :	VAEntrypointEncSlice",
      "      VAProfileHEVCMain               :	VAEntrypointVLD",
      "      VAProfileHEVCMain               :	VAEntrypointEncSliceLP",
      "      VAProfileHEVCMain10             :	VAEntrypointVLD",
      "      VAProfileVP9Profile0            :	VAEntrypointVLD",
      "      VAProfileAV1Profile0            :	VAEntrypointVLD"
    ].join("\n");
    expect(encodeFormatsOf(vainfo)).toEqual(["h264", "hevc"]);
    expect(encodeFormatsOf("")).toEqual([]);
  });
});
