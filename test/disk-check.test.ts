// The disk check (disk-check.ts; home's docs/video-hardware-tests-plan.md, H3):
// each library's wake-up and reading speed against its heaviest film, through the
// API, on the test fixture's folders.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { diskVerdict } from "../src/disk-check.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";
const admin = {
  "x-isputnik-gateway": SECRET, "x-isputnik-user-id": "admin", "x-isputnik-user-name": "admin",
  "x-isputnik-user-role": "admin", "x-isputnik-libraries": "", "x-isputnik-client-ip": "192.168.2.10"
};

describe("what a disk's speed means", () => {
  it("is plenty at twice the heaviest film, enough at once, short below, and unknown with nothing to compare", () => {
    expect([diskVerdict(900, 80), diskVerdict(160, 80), diskVerdict(100, 80), diskVerdict(60, 80), diskVerdict(900, null), diskVerdict(null, 80)])
      .toEqual(["plenty", "plenty", "enough", "short", "unknown", "unknown"]);
  });
});

describe("a disk check, through the API", () => {
  let fixture: Fixture;
  let app: FastifyInstance;

  beforeAll(async () => {
    fixture = makeFixture();
    app = await buildApp({
      gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
      tools: null, scan: { settleMs: 60_000 }, diskCheck: { samples: 3, readMs: 2000 }, fastify: { logger: false }
    });
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_tv", headers: admin, payload: { name: "TV", kind: "shows", folder: "Shows" } });
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_mov", headers: admin, payload: { name: "Films", kind: "movies", folder: "Movies" } });
    await app.scansSettled();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    fixture?.cleanup();
  });

  const state = async () => (await app.inject({ method: "GET", url: "/video/api/admin/hardware/disks", headers: admin })).json();

  it("times each library's first answers and a read of its largest file, and keeps the result", async () => {
    const started = await app.inject({ method: "POST", url: "/video/api/admin/hardware/disks", headers: admin });
    expect(started.statusCode).toBe(202);

    let now = await state();
    const until = Date.now() + 30_000;
    while (now.running && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      now = await state();
    }
    const check = now.last;
    expect(check.phase).toBe("done");
    expect(check.libraries.map((entry: { name: string }) => entry.name).sort()).toEqual(["Films", "TV"]);
    for (const entry of check.libraries) {
      expect(entry.error).toBeNull();
      expect(entry.wake.samples.length).toBeGreaterThan(0);
      expect(entry.wake.slowestMs).toBeGreaterThanOrEqual(0);
      // A local temp folder answers at once.
      expect(entry.wake.asleep).toBe(false);
      // The fixture's files are a few kilobytes: read whole.
      expect(entry.read.bytes).toBeGreaterThan(0);
      expect(entry.read.file).toMatch(/\.(mkv|mp4)$/);
      // Nothing probed yet: nothing to compare with.
      expect(entry.heaviestMbit).toBeNull();
      expect(entry.verdict).toBe("unknown");
    }
    const history = (await app.inject({ method: "GET", url: "/video/api/admin/hardware/history", headers: admin })).json();
    expect(history.diskChecks).toHaveLength(1);
    const report = (await app.inject({ method: "GET", url: "/video/api/admin/diagnostics", headers: admin })).json();
    expect(report.diskCheck.libraries.some((line: string) => line.startsWith("Films: first answer"))).toBe(true);
  }, 60_000);

  it("is one at a time, and stops when asked", async () => {
    expect((await app.inject({ method: "POST", url: "/video/api/admin/hardware/disks", headers: admin })).statusCode).toBe(202);
    const again = await app.inject({ method: "POST", url: "/video/api/admin/hardware/disks", headers: admin });
    // Either it is still running, or it already finished on these tiny files.
    if (again.statusCode === 409) {
      expect(again.json().code).toBe("running");
      const stopped = await app.inject({ method: "DELETE", url: "/video/api/admin/hardware/disks", headers: admin });
      expect([200, 404]).toContain(stopped.statusCode);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await state()).running).toBeNull();
  }, 60_000);
});
