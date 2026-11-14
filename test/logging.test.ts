// How much the engine logs, for a while (logging.ts): Detailed or Everything for a
// set time from home's Diagnostics, then back to Normal by itself; the buffer
// grows while it's on, and home's report gets every line.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createLogBuffer, type LogBuffer } from "../src/log-buffer.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";
const as = (id: string, role: string) => ({
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": id,
  "x-isputnik-user-role": role,
  "x-isputnik-client-ip": "192.168.2.10",
  "x-isputnik-request-id": `home-${id}`
});
const admin = as("admin", "admin");
const mum = as("mum", "member");

describe("the log buffer", () => {
  it("makes room for more lines, and keeps the newest when it shrinks", () => {
    const buffer = createLogBuffer(3, { write: () => undefined });
    buffer.write("a\nb\nc\nd\n");
    expect(buffer.tail(10)).toEqual(["b", "c", "d"]);
    buffer.resize(5);
    buffer.write("e\nf\n");
    expect(buffer.tail(10)).toEqual(["b", "c", "d", "e", "f"]);
    buffer.resize(2);
    expect(buffer.capacity).toBe(2);
    expect(buffer.tail(10)).toEqual(["e", "f"]);
    buffer.write("g\n");
    expect(buffer.tail(10)).toEqual(["f", "g"]);
  });
});

describe("/admin/logging", () => {
  let fixture: Fixture;
  let app: FastifyInstance;
  let logBuffer: LogBuffer;

  beforeEach(async () => {
    fixture = makeFixture();
    logBuffer = createLogBuffer(500, { write: () => undefined });
    app = await buildApp({
      gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
      tools: null, logBuffer,
      fastify: { logger: { level: "info", stream: logBuffer } }
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
    fixture.cleanup();
  });

  const put = (body: object, headers = admin) => app.inject({ method: "PUT", url: "/video/api/admin/logging", headers, payload: body });

  it("is for an admin, starts at Normal, and offers the short lengths", async () => {
    expect((await app.inject({ method: "GET", url: "/video/api/admin/logging", headers: mum })).statusCode).toBe(403);
    const state = (await app.inject({ method: "GET", url: "/video/api/admin/logging", headers: admin })).json();
    expect(state).toMatchObject({ level: "normal", until: null, minutes: [15, 60, 240] });
    expect((await put({ level: "loud" })).statusCode).toBe(400);
  });

  it("raises the level for the time chosen, grows the buffer, and the report gets every line", async () => {
    const response = await put({ level: "detailed", minutes: 15 });
    expect(response.statusCode).toBe(200);
    const state = response.json();
    expect(state.level).toBe("detailed");
    expect(Date.parse(state.until) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(app.log.level).toBe("debug");
    expect(logBuffer.capacity).toBe(2000);
    app.log.debug({ step: "probe" }, "a detail only Detailed keeps");
    const report = (await app.inject({ method: "GET", url: "/video/api/admin/diagnostics", headers: admin })).json();
    expect(report.logging).toMatchObject({ level: "detailed" });
    expect((report.log as string[]).some((line) => line.includes("a detail only Detailed keeps"))).toBe(true);
    // Who turned it on is in the events.
    const events = (await app.inject({ method: "GET", url: "/video/api/admin/events?event=logging.level.changed", headers: admin })).json();
    expect(JSON.stringify(events)).toContain("logging.level.changed");

    // Back to Normal now: the problems only, after the hour the report keeps every line.
    expect((await put({ level: "normal" })).json()).toMatchObject({ level: "normal", until: null });
    expect(app.log.level).toBe("info");
    expect(logBuffer.capacity).toBe(500);
  });

  it("goes back to Normal by itself when the time is up", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-14T10:00:00Z"), toFake: ["setTimeout", "clearTimeout", "Date"] });
    expect((await put({ level: "everything", minutes: 15 })).json().until).toBe("2026-11-14T10:15:00.000Z");
    expect(app.log.level).toBe("trace");
    vi.advanceTimersByTime(15 * 60_000 + 1);
    const state = (await app.inject({ method: "GET", url: "/video/api/admin/logging", headers: admin })).json();
    expect(state.level).toBe("normal");
    expect(state.endedAt).not.toBeNull();
    expect(app.log.level).toBe("info");
  });
});
