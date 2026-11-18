// Live sessions (home's Diagnostics › Video): what a play is made of — the file,
// and what reaches the player (media-summary.ts).
import { describe, expect, it } from "vitest";
import { decideDelivery } from "../src/delivery.js";
import type { MediaInfo } from "../src/ffmpeg.js";
import { containerOf, describeMedia } from "../src/media-summary.js";

const uhd: MediaInfo = {
  container: "matroska,webm",
  start: 0,
  duration: 8888,
  bitRate: 60_000_000,
  video: { index: 0, codec: "hevc", profile: "Main 10", pixelFormat: "yuv420p10le", width: 3840, height: 2160, colorTransfer: "smpte2084", colorPrimaries: "bt2020" },
  audio: [
    { index: 1, codec: "truehd", channels: 8, language: "eng", title: null, default: true },
    { index: 2, codec: "ac3", channels: 6, language: "rus", title: null, default: false }
  ],
  subtitles: [],
  chapters: []
};

describe("what a play is made of", () => {
  it("names containers in a word", () => {
    expect(containerOf("matroska,webm")).toBe("mkv");
    expect(containerOf("mov,mp4,m4a,3gp,3g2,mj2")).toBe("mp4");
    expect(containerOf("mpegts")).toBe("ts");
    expect(containerOf("avi")).toBe("avi");
  });

  it("tells a 4K HDR film from the 1080p H.264 stereo a conversion sends of it", () => {
    const media = describeMedia(uhd, decideDelivery(uhd, ".mkv"));
    expect(media.source).toEqual({
      container: "mkv",
      video: { codec: "hevc", profile: "Main 10", width: 3840, height: 2160, bitDepth: 10, hdr: "pq" },
      audio: { codec: "truehd", channels: 8, language: "eng" },
      bitRate: 60_000_000
    });
    expect(media.sent).toEqual({
      container: "hls",
      video: { codec: "h264", profile: "High", width: 1920, height: 1080, bitDepth: 8, hdr: null },
      audio: { codec: "aac", channels: 2, language: "eng" },
      bitRate: null
    });
    expect(media).toMatchObject({ videoCopied: false, audioCopied: false, subtitlesBurned: false });
    expect(media.reasons).toEqual(expect.arrayContaining(["container", "audio", "video"]));
  });

  it("holds the picture under the rung asked, and follows the sound chosen", () => {
    const media = describeMedia(uhd, decideDelivery(uhd, ".mkv", 2, null, 720));
    expect(media.sent.video).toMatchObject({ width: 1280, height: 720 });
    expect(media.source.audio).toMatchObject({ codec: "ac3", language: "rus" });
  });

  it("sends a file played as it is just as it is", () => {
    const mp4: MediaInfo = {
      ...uhd,
      container: "mov,mp4,m4a,3gp,3g2,mj2",
      bitRate: 5_000_000,
      video: { index: 0, codec: "h264", profile: "High", pixelFormat: "yuv420p", width: 1920, height: 800, colorTransfer: null, colorPrimaries: null },
      audio: [{ index: 1, codec: "aac", channels: 2, language: null, title: null, default: true }]
    };
    const media = describeMedia(mp4, null);
    expect(media.sent).toBe(media.source);
    expect(media.source.video).toMatchObject({ codec: "h264", width: 1920, height: 800, bitDepth: 8, hdr: null });
    expect(media.reasons).toEqual([]);
  });
});
