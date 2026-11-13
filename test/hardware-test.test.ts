// The hardware test (hardware-test.ts; home's docs/video-hardware-tests-plan.md):
// verdicts, the viewer limit it suggests, the note when the hardware changes, and
// one whole test run through the API on tiny clips, on the CPU (CI has no GPU).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, upgradeDatabase } from "../src/db.js";
import { findTools } from "../src/ffmpeg.js";
import { describeChange, listChanges, noteHardware, suggestViewers, verdictOf, type HardwareFingerprint, type Scenario } from "../src/hardware-test.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

describe("what the numbers mean", () => {
  it("calls 1.5x real time smooth, 1x tight, less too slow, and nothing failed", () => {
    expect([verdictOf(2.4), verdictOf(1.5), verdictOf(1.2), verdictOf(0.93), verdictOf(null)]).toEqual(["smooth", "smooth", "tight", "slow", "failed"]);
  });

  it("suggests as many viewers as the heaviest case measured keeps up with, and nothing without a measure", () => {
    const step = (id: "4k-hdr" | "1080p-hevc", atOnce: number) => ({ id, label: id, converter: "gpu" as const, atOnce, atLeast: false, steps: [] });
    expect(suggestViewers([step("4k-hdr", 2), step("1080p-hevc", 5)])).toBe(2);
    // Too slow for 4K at all: what 1080p allows.
    expect(suggestViewers([step("4k-hdr", 0), step("1080p-hevc", 3)])).toBe(3);
    expect(suggestViewers([step("4k-hdr", 0)])).toBeNull();
  });
});

describe("a note when the hardware changes", () => {
  const base: HardwareFingerprint = { device: "/dev/dri/renderD128", driver: "Intel iHD driver 24.1.0", decode: ["h264", "hevc"], tonemap: false, overlay: true, ffmpeg: "ffmpeg version 7.0" };

  it("says what changed, in a line", () => {
    expect(describeChange(base, { ...base, driver: "Intel iHD driver 25.2.3", decode: ["av1", "h264", "hevc", "hevc10"], tonemap: true }))
      .toBe("driver Intel iHD driver 24.1.0 → Intel iHD driver 25.2.3; now decodes av1, hevc10; now tone-maps HDR");
    expect(describeChange(base, { ...base, device: null, decode: [] })).toBe("GPU gone; no longer decodes h264, hevc");
  });

  it("keeps the first check's fingerprint quietly, then notes a difference once", () => {
    const db = openDatabase(":memory:");
    upgradeDatabase(db);
    expect(noteHardware(db, base)).toBeNull();
    expect(noteHardware(db, base)).toBeNull();
    const change = noteHardware(db, { ...base, ffmpeg: "ffmpeg version 7.1" });
    expect(change?.summary).toBe("ffmpeg ffmpeg version 7.0 → ffmpeg version 7.1");
    expect(noteHardware(db, { ...base, ffmpeg: "ffmpeg version 7.1" })).toBeNull();
    expect(listChanges(db).map((entry) => entry.summary)).toEqual(["ffmpeg ffmpeg version 7.0 → ffmpeg version 7.1"]);
    db.close();
  });
});

describe("a whole test, through the API", () => {
  const SECRET = "video-secret-video-secret-0123456789";
  const admin = {
    "x-isputnik-gateway": SECRET, "x-isputnik-user-id": "admin", "x-isputnik-user-name": "admin",
    "x-isputnik-user-role": "admin", "x-isputnik-libraries": "", "x-isputnik-client-ip": "192.168.2.10"
  };
  // Small clips of two of the real kinds, so a run takes seconds.
  const tiny: Scenario[] = [
    { id: "divx", label: "DivX", width: 320, height: 240, ext: ".avi", rung: null, encoders: [["-c:v", "mpeg4", "-vtag", "XVID", "-q:v", "4"]], audio: ["-c:a", "ac3", "-b:a", "96k"] },
    { id: "1080p-hevc", label: "HEVC", width: 320, height: 240, ext: ".mkv", rung: null, encoders: [["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error"], ["-c:v", "libx264", "-preset", "ultrafast"]], audio: ["-c:a", "aac", "-b:a", "96k"] }
  ];
  let fixture: Fixture;
  let samplesDir: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    fixture = makeFixture();
    samplesDir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-samples-test-"));
    app = await buildApp({
      gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
      tools: findTools(), samplesDir,
      detectGpu: async () => ({ device: null, driver: null, encode: false, decode: [], error: "No GPU: /dev/dri is not passed to the container", checkedAt: new Date().toISOString() }),
      hardwareTest: { scenarios: tiny, limits: { clipSeconds: 4, runMs: 2500, togetherMs: 1500, togetherMax: 3 } },
      fastify: { logger: false }
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    fixture?.cleanup();
    fs.rmSync(samplesDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("makes the clips, times each on the CPU, measures how many at once, and keeps the result", async () => {
    const started = await app.inject({ method: "POST", url: "/video/api/admin/hardware/test", headers: admin });
    expect(started.statusCode).toBe(202);
    // One at a time.
    expect((await app.inject({ method: "POST", url: "/video/api/admin/hardware/test", headers: admin })).json()).toMatchObject({ code: "running" });

    let state = (await app.inject({ method: "GET", url: "/video/api/admin/hardware/test", headers: admin })).json();
    const until = Date.now() + 90_000;
    while (state.running && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      state = (await app.inject({ method: "GET", url: "/video/api/admin/hardware/test", headers: admin })).json();
    }
    expect(state.running).toBeNull();
    const test = state.last;
    expect(test.phase).toBe("done");
    expect(test.ffmpeg).toMatch(/ffmpeg version/);
    expect(test.scenarios.map((entry: { id: string }) => entry.id)).toEqual(["divx", "1080p-hevc"]);
    for (const entry of test.scenarios) {
      // No GPU here: only the CPU was tried.
      expect(entry.gpuRun).toBeNull();
      expect(entry.cpuRun.speed).toBeGreaterThan(0);
      expect(["smooth", "tight", "slow"]).toContain(entry.cpuRun.verdict);
    }
    // HEVC is the one the "how many at once" steps measure, on the CPU.
    expect(test.together).toHaveLength(1);
    expect(test.together[0]).toMatchObject({ id: "1080p-hevc", converter: "cpu" });
    expect(test.together[0].steps[0].count).toBe(1);

    // Kept, and in the diagnostics report.
    const history = (await app.inject({ method: "GET", url: "/video/api/admin/hardware/history", headers: admin })).json();
    expect(history.tests).toHaveLength(1);
    const report = (await app.inject({ method: "GET", url: "/video/api/admin/diagnostics", headers: admin })).json();
    expect(report.hardwareTest.phase).toBe("done");
    expect(report.hardwareTest.scenarios[0]).toMatch(/^DivX: GPU -, CPU \d/);

    // The clips stay for the next test.
    expect(fs.readdirSync(samplesDir).filter((name) => /\.(avi|mkv)$/.test(name))).toHaveLength(2);
  }, 120_000);

  it("stops when asked, and says so", async () => {
    expect((await app.inject({ method: "POST", url: "/video/api/admin/hardware/test", headers: admin })).statusCode).toBe(202);
    const stopped = (await app.inject({ method: "DELETE", url: "/video/api/admin/hardware/test", headers: admin })).json();
    expect(stopped.last).toMatchObject({ phase: "stopped", reason: "Stopped by admin" });
    expect((await app.inject({ method: "DELETE", url: "/video/api/admin/hardware/test", headers: admin })).statusCode).toBe(404);
  }, 60_000);
});
