// Finding intros and credits by itself: the pieces on their own, then a season of
// three generated episodes — a shared intro after cold opens of different lengths,
// credits on black — scanned, looked at, and played.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { findTools } from "../src/ffmpeg.js";
import { STEP_S, creditsFromBlack, fingerprint, hashFrames, neighbourPairs, recapFromPieces, sharedStretch, stretchesFromPairs } from "../src/detect.js";

/** Deterministic noise, so two arrays can share a stretch exactly. */
function noise(seed: number, seconds: number): Int16Array {
  let state = seed >>> 0 || 1;
  const out = new Int16Array(Math.round(seconds * 8000));
  for (let i = 0; i < out.length; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    out[i] = ((state >>> 0) % 20000) - 10000;
  }
  return out;
}

const join = (...parts: Int16Array[]) => {
  const out = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

describe("the pieces", () => {
  it("finds the stretch two recordings share, wherever each has it", async () => {
    // White noise only matches itself frame for frame, so the offsets are whole
    // frames here (40 and 100); the generated season below tries any offset.
    const intro = noise(42, 20);
    const a = await fingerprint(join(noise(1, 40 * STEP_S), intro, noise(2, 30)));
    const b = await fingerprint(join(noise(3, 100 * STEP_S), intro, noise(4, 30)));
    const shared = (await sharedStretch(a, b))!;
    // Within 6 frames (0.8 s): stray matches just outside it can stay on a run's ends.
    expect(Math.abs(shared.aStart - 40)).toBeLessThanOrEqual(6);
    expect(shared.bStart - shared.aStart).toBe(60);
    expect(shared.length * STEP_S).toBeGreaterThan(19);
    expect(shared.length * STEP_S).toBeLessThan(21.6);
  });

  it("finds nothing in two recordings with nothing in common, nor in silence", async () => {
    expect(await sharedStretch(await fingerprint(noise(5, 40)), await fingerprint(noise(6, 40)))).toBeNull();
    const silence = await fingerprint(new Int16Array(8000 * 40));
    expect(await sharedStretch(silence, silence)).toBeNull();
  });

  it("compares each episode with a few around it, not every pair of a long season", () => {
    expect(neighbourPairs(3)).toEqual([[0, 1], [0, 2], [1, 2]]);
    expect(neighbourPairs(100)).toHaveLength(600);
  });

  it("takes the start most pairs agree on, and drops a partial match far off the usual length", () => {
    const shared = (aStart: number, bStart: number, seconds: number) => ({ aStart: aStart / STEP_S, bStart: bStart / STEP_S, length: seconds / STEP_S });
    const found = [
      { a: 0, b: 1, shared: shared(60, 90, 70) },
      { a: 0, b: 2, shared: shared(60, 30, 71) },
      { a: 1, b: 2, shared: shared(90, 30, 70) },
      { a: 0, b: 3, shared: shared(60, 200, 70) },
      { a: 1, b: 3, shared: shared(90, 200, 70) },
      { a: 2, b: 3, shared: shared(30, 200, 70) },
      // Episode 4's opening differs: only a piece of it matches.
      { a: 0, b: 4, shared: shared(70, 10, 12) },
      { a: 1, b: 4, shared: shared(100, 10, 12) },
      { a: 2, b: 4, shared: shared(40, 10, 12) },
      { a: 3, b: 4, shared: shared(210, 10, 12) }
    ];
    const result = stretchesFromPairs(5, found);
    expect(result[0]).toEqual({ start: 60, end: 130 });
    expect(result[2]!.start).toBeCloseTo(30);
    expect(result[4]).toBeNull();
  });

  it("takes a recap from where the shared opening ends through pieces close together, and never into the intro", () => {
    const pieces = [20, 26, 33, 40, 47, 60].map((from) => ({ from, to: from + 2 }));
    expect(recapFromPieces(pieces, 18, null)).toEqual({ start: 18, end: 62 });
    // The intro starts at 48, inside the piece 47-49: the recap stops at it.
    expect(recapFromPieces(pieces, 18, 48)).toEqual({ start: 18, end: 48 });
    // Too few pieces is a cold open picking up last week's scene, not a recap.
    expect(recapFromPieces(pieces.slice(0, 3), 18, null)).toBeNull();
    // Nothing near the "Previously on" card: no recap.
    expect(recapFromPieces(pieces.map((p) => ({ from: p.from + 60, to: p.to + 60 })), 18, null)).toBeNull();
  });

  it("hashes a frame by its gradients, and a frame with no contrast to nothing", () => {
    const frame = (value: (x: number, y: number) => number) => Buffer.from(Array.from({ length: 72 }, (_, i) => value(i % 9, Math.floor(i / 9))));
    const ramp = hashFrames(frame((x) => 200 - x * 20));
    expect([ramp[0], ramp[1]]).toEqual([0xffffffff, 0xffffffff]);
    // The same picture brighter: the same hash.
    expect([...hashFrames(frame((x) => 230 - x * 20))]).toEqual([...ramp]);
    expect([...hashFrames(frame(() => 16))]).toEqual([0, 0]);
  });

  it("finds the credits at the first long black stretch, cards close together counted as one", () => {
    expect(creditsFromBlack([{ start: 100, end: 104 }, { start: 200, end: 212 }, { start: 214, end: 230 }])).toBe(200);
    expect(creditsFromBlack([{ start: 100, end: 110 }, { start: 300, end: 310 }])).toBeNull();
  });
});

describe("a season looked at", () => {
  const SECRET = "video-secret-video-secret-0123456789";
  const headers = {
    "x-isputnik-gateway": SECRET,
    "x-isputnik-user-id": "admin",
    "x-isputnik-user-name": "admin",
    "x-isputnik-user-role": "admin",
    "x-isputnik-libraries": "lib_shows"
  };
  const tools = findTools();
  const coldOpens = [4, 7, 10];
  let root: string;
  let app: FastifyInstance;
  let ids: string[];

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-detect-"));
    const dir = path.join(root, "Shows", "Show (2020)", "Season 1");
    fs.mkdirSync(dir, { recursive: true });
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    coldOpens.forEach((cold, i) => {
      const file = path.join(dir, `Show (2020) S01E0${i + 1}.mkv`);
      const body = 95 - cold - 20;
      // Picture for 95 s, then 25 s of black for the credits; the sound: a cold open
      // of its own, the intro all three share, then its own again.
      execFileSync(tools.ffmpeg, ["-v", "error",
        "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=10:duration=95",
        "-f", "lavfi", "-i", "color=black:size=160x120:rate=10:duration=25",
        "-f", "lavfi", "-i", `anoisesrc=color=pink:seed=${i + 1}:duration=${cold}:sample_rate=48000`,
        // A tune rather than noise: what an intro is, and what the fingerprint is for.
        "-f", "lavfi", "-i", "aevalsrc=0.4*sin(2*PI*t*(300+60*mod(floor(t/0.3)*7\\,13)))+0.25*sin(2*PI*t*(900+120*mod(floor(t/0.3)*5\\,11)))+0.15*sin(2*PI*t*(1800+150*mod(floor(t/0.6)*3\\,7))):s=48000:d=20",
        "-f", "lavfi", "-i", `anoisesrc=color=pink:seed=${i + 100}:duration=${body + 25}:sample_rate=48000`,
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a][4:a]concat=n=3:v=0:a=1[a]",
        "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-g", "10", "-c:a", "aac", file]);
      fs.utimesSync(file, hourAgo, hourAgo);
    });
    app = await buildApp({
      gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: root, version: "0.0.0-test", stage: null,
      scan: { settleMs: 60_000 }, tools, detect: true, fastify: { logger: false }
    });
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_shows", headers, payload: { name: "Shows", kind: "shows", folder: "Shows" } });
    await app.detectionSettled();
    const show = (await app.inject({ method: "GET", url: "/video/api/shows", headers })).json().items[0];
    const detail = (await app.inject({ method: "GET", url: `/video/api/shows/${show.id}`, headers })).json();
    ids = detail.seasons[0].episodes.map((episode: { id: string }) => episode.id);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    // On Windows a file ffprobe still has open can't go yet: try again for a moment.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const markersOf = async (id: string) => (await app.inject({ method: "GET", url: `/video/api/play/${id}`, headers })).json().markers;

  it("finds each episode's intro after its own cold open, and its credits on the black", async () => {
    for (const [i, cold] of coldOpens.entries()) {
      const { intro, credits } = await markersOf(ids[i]);
      expect(intro.source).toBe("detected");
      // Within 2 s each end: how far stray matches carry a run's edges differs with
      // the ffmpeg build that encoded the files (1.3 s early on CI's, at 0.16.0).
      expect(intro.start).toBeGreaterThan(cold - 2);
      expect(intro.start).toBeLessThan(cold + 2);
      expect(intro.end).toBeGreaterThan(cold + 18);
      expect(intro.end).toBeLessThan(cold + 22);
      expect(credits.source).toBe("detected");
      expect(credits.start).toBeGreaterThan(93);
      expect(credits.start).toBeLessThan(97);
    }
  });

  it("gives way to an admin's mark", async () => {
    await app.inject({ method: "PUT", url: `/video/api/admin/markers/${ids[0]}`, headers, payload: { kind: "intro", scope: "episode", start: 1, end: 3 } });
    expect((await markersOf(ids[0])).intro).toEqual({ start: 1, end: 3, source: "manual", scope: "episode" });
    expect((await markersOf(ids[0])).credits.source).toBe("detected");
  });

  it("is turned off and on by the admin's setting, which Find again respects", async () => {
    expect((await app.inject({ method: "GET", url: "/video/api/admin/detection", headers })).json()).toEqual({ enabled: true, available: true });
    expect((await app.inject({ method: "PUT", url: "/video/api/admin/detection", headers, payload: { enabled: false } })).json().enabled).toBe(false);
    const refused = await app.inject({ method: "POST", url: `/video/api/admin/markers/${ids[1]}/detect`, headers });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("video.detection_off");
    await app.inject({ method: "PUT", url: "/video/api/admin/detection", headers, payload: { enabled: true } });
    await app.detectionSettled();
  });

  it("looks again when an admin asks, and only an admin", async () => {
    const asked = await app.inject({ method: "POST", url: `/video/api/admin/markers/${ids[1]}/detect`, headers });
    expect(asked.statusCode).toBe(202);
    await app.detectionSettled();
    expect((await markersOf(ids[1])).intro.source).toBe("detected");
    const member = await app.inject({ method: "POST", url: `/video/api/admin/markers/${ids[1]}/detect`, headers: { ...headers, "x-isputnik-user-role": "member" } });
    expect(member.statusCode).toBe(403);
  });
});
