// Copies made for download (copies.ts): asked for, made on a queue by ffmpeg,
// fetched with byte ranges, kept for the next person and under the admin's size.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { decideDelivery } from "../src/delivery.js";
import { findTools, probe } from "../src/ffmpeg.js";
import { COPIES_FOLDER, buildPlan, ffmpegArgs, prepareRoot } from "../src/hls.js";
import { COPY_LIMITS } from "../src/copies.js";
import { makeFixture, type Fixture } from "./helpers/fixture.js";

const SECRET = "video-secret-video-secret-0123456789";
const tools = findTools();

const as = (id: string, extra: Record<string, string> = {}) => ({
  "x-isputnik-gateway": SECRET,
  "x-isputnik-user-id": id,
  "x-isputnik-user-name": id,
  "x-isputnik-user-role": id === "admin" ? "admin" : "member",
  "x-isputnik-libraries": "lib_mov",
  ...extra
});

interface Answer {
  state: string;
  progress?: number;
  url?: string | null;
  sizeBytes?: number | null;
  estimateSeconds?: number;
  error?: string | null;
}

let fixture: Fixture;
let app: FastifyInstance;
let copiesDir: string;

/** A real film in the library: `video` and `audio` are ffmpeg's codec arguments. */
function film(name: string, size: string, codecs: string[]): void {
  const file = path.join(fixture.root, "Movies", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(tools.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=12`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "3", "-pix_fmt", "yuv420p", ...codecs, file]);
  // Settled an hour ago: a file still being copied is left for the next scan.
  const hourAgo = new Date(Date.now() - 3_600_000);
  fs.utimesSync(file, hourAgo, hourAgo);
}

const get = (url: string, who = "mum", headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers: { ...as(who), ...headers } });
const put = (url: string, body: Record<string, unknown>, who = "mum") => app.inject({ method: "PUT", url, headers: as(who), payload: body });
const idOf = async (title: string) => ((await get("/video/api/movies")).json() as { items: { id: string; title: string }[] }).items.find((item) => item.title === title)!.id;

/** Looks in on a copy until it is in `state`. */
async function reaches(id: string, quality: number, state: string, who = "mum"): Promise<Answer> {
  for (let tries = 0; tries < 300; tries++) {
    const answer = (await get(`/video/api/copies/${id}?quality=${quality}`, who)).json() as Answer;
    if (answer.state === state) return answer;
    if (answer.state === "failed" && state !== "failed") throw new Error(`The copy failed: ${answer.error}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The copy never became ${state}`);
}

beforeEach(async () => {
  fixture = makeFixture();
  // Taller than 480p in a container no browser plays; and one every browser plays as it is.
  film("Tall Film (2020).mkv", "320x540", ["-c:v", "libx264", "-c:a", "ac3"]);
  film("Plain Film (2021).mp4", "160x120", ["-c:v", "libx264", "-c:a", "aac"]);
  copiesDir = path.join(fixture.root, "copies-kept");
  app = await buildApp({
    gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
    scan: { settleMs: 60_000 }, copiesDir,
    fastify: { logger: false }
  });
  await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_mov", headers: as("admin"), payload: { name: "Films", kind: "movies", folder: "Movies" } });
  await app.scansSettled();
});

afterEach(async () => {
  await app.close();
  fixture.cleanup();
});

describe("ffmpeg's arguments for a whole file", () => {
  it("make one MP4 from the start, within the copy's own limits, saying how far it is", async () => {
    const file = path.join(fixture.root, "Movies", "Tall Film (2020).mkv");
    const info = await probe(tools, file);
    const plan = buildPlan("tall", file, info, decideDelivery(info, ".mkv", null, null, 480), null);
    const args = ffmpegArgs(plan, 0, "/tmp/s", null, { path: "/tmp/out.mp4.part", limits: COPY_LIMITS[480], threads: 2 });
    expect(args.slice(-5)).toEqual(["-movflags", "+faststart", "-f", "mp4", "/tmp/out.mp4.part"]);
    expect(args).toEqual(expect.arrayContaining(["-progress", "pipe:1", "scale=-2:480", "-maxrate", "2M", "-threads", "2"]));
    // Segments keep the file's clock and a keyframe on every cut; one file needs neither.
    expect(args).not.toContain("-copyts");
    expect(args).not.toContain("-force_key_frames");
    expect(args).not.toContain("segment");
    // The segments' own arguments are as they were.
    expect(ffmpegArgs(plan, 0, "/tmp/s")).toEqual(expect.arrayContaining(["-copyts", "-force_key_frames", "-f", "segment"]));
  });

  it("holds a 1080p copy lower than a 1080p stream", () => {
    expect(COPY_LIMITS[1080].maxRate).toBeLessThan(10_000_000);
  });
});

describe("a copy to download", () => {
  it("is made when asked for, then fetched in ranges as an MP4 no taller than asked", async () => {
    const id = await idOf("Tall Film");
    const before = (await get(`/video/api/copies/${id}?quality=480`)).json() as Answer;
    expect(before.state).toBe("none");
    expect(before.estimateSeconds).toBeGreaterThan(0);

    const asked = (await put(`/video/api/copies/${id}`, { quality: 480 })).json() as Answer;
    expect(["queued", "running", "ready"]).toContain(asked.state);
    const ready = await reaches(id, 480, "ready");
    expect(ready.sizeBytes).toBeGreaterThan(1000);
    expect(ready.url).toMatch(new RegExp(`^/video/api/copies/${id}/file\\?quality=480&audio=\\d+$`));

    const whole = await get(ready.url!);
    expect(whole.statusCode).toBe(200);
    expect(whole.headers["content-type"]).toBe("video/mp4");
    expect(whole.rawPayload.length).toBe(ready.sizeBytes);
    const part = await get(ready.url!, "mum", { range: "bytes=0-99" });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 0-99/${ready.sizeBytes}`);

    const made = path.join(copiesDir, fs.readdirSync(copiesDir).find((name) => name.endsWith(".mp4"))!);
    const info = await probe(tools, made);
    expect(info.container).toContain("mp4");
    expect(info.video).toMatchObject({ codec: "h264", height: 480 });
    expect(info.audio[0].codec).toBe("aac");
    expect(Math.round(info.duration)).toBe(3);
  }, 60_000);

  it("is kept for the next person, and asked for twice is made once", async () => {
    const id = await idOf("Tall Film");
    await put(`/video/api/copies/${id}`, { quality: 480 });
    await put(`/video/api/copies/${id}`, { quality: 480 });
    await reaches(id, 480, "ready");
    // Dad never asked: it is there for him.
    expect(((await get(`/video/api/copies/${id}?quality=480`, "dad")).json() as Answer).state).toBe("ready");
    const list = (await get("/video/api/admin/copies", "admin")).json() as { copies: { title: string; state: string; quality: number }[]; usedBytes: number; settings: { limitGb: number } };
    expect(list.copies).toHaveLength(1);
    expect(list.copies[0]).toMatchObject({ title: "Tall Film", state: "ready", quality: 480 });
    expect(list.usedBytes).toBeGreaterThan(0);
    expect(list.settings.limitGb).toBe(20);
  }, 60_000);

  it("copies the picture as it is when it already fits, and says a plain file needs none", async () => {
    const tall = await idOf("Tall Film");
    await put(`/video/api/copies/${tall}`, { quality: 720 });
    await reaches(tall, 720, "ready");
    const made = path.join(copiesDir, fs.readdirSync(copiesDir).find((name) => name.includes("-720-"))!);
    expect((await probe(tools, made)).video).toMatchObject({ codec: "h264", height: 540 });

    const plain = await idOf("Plain Film");
    const answer = (await put(`/video/api/copies/${plain}`, { quality: 480 })).json() as Answer;
    expect(answer).toEqual({ state: "unneeded", url: `/video/api/stream/${plain}` });
  }, 60_000);

  it("is made again once the film has changed", async () => {
    const id = await idOf("Tall Film");
    await put(`/video/api/copies/${id}`, { quality: 720 });
    await reaches(id, 720, "ready");
    const file = path.join(fixture.root, "Movies", "Tall Film (2020).mkv");
    const earlier = new Date(Date.now() - 7_200_000);
    fs.utimesSync(file, earlier, earlier);
    expect(((await get(`/video/api/copies/${id}?quality=720`)).json() as Answer).state).toBe("none");
    expect(fs.readdirSync(copiesDir).filter((name) => name.endsWith(".mp4"))).toHaveLength(0);
  }, 60_000);

  it("is refused for a title a person may not see, a quality that is none, or above the cap away from home", async () => {
    const id = await idOf("Tall Film");
    const outsider = await app.inject({ method: "PUT", url: `/video/api/copies/${id}`, headers: as("kid", { "x-isputnik-libraries": "lib_tv" }), payload: { quality: 480 } });
    expect(outsider.statusCode).toBe(404);
    expect((await put(`/video/api/copies/${id}`, { quality: 999 })).statusCode).toBe(404);
    expect((await get(`/video/api/copies/${id}/file?quality=480`)).statusCode).toBe(404);
    // Away from home the admin's cap (720p to start with) holds for copies too.
    const away = { "x-isputnik-network": "internet" };
    const capped = await app.inject({ method: "PUT", url: `/video/api/copies/${id}`, headers: as("mum", away), payload: { quality: 1080 } });
    expect(capped.statusCode).toBe(404);
  });
});

describe("the room copies take", () => {
  it("is set by the admin, and clearing removes every copy", async () => {
    const id = await idOf("Tall Film");
    await put(`/video/api/copies/${id}`, { quality: 480 });
    await reaches(id, 480, "ready");
    const changed = await app.inject({ method: "PUT", url: "/video/api/admin/copies", headers: as("admin"), payload: { limitGb: 5 } });
    expect((changed.json() as { settings: { limitGb: number } }).settings.limitGb).toBe(5);
    expect((await app.inject({ method: "PUT", url: "/video/api/admin/copies", headers: as("admin"), payload: { limitGb: 0 } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({ method: "PUT", url: "/video/api/admin/copies", headers: as("mum"), payload: { limitGb: 5 } })).statusCode).toBe(403);

    const cleared = await app.inject({ method: "DELETE", url: "/video/api/admin/copies", headers: as("admin") });
    expect((cleared.json() as { copies: unknown[]; usedBytes: number })).toMatchObject({ copies: [], usedBytes: 0 });
    expect(((await get(`/video/api/copies/${id}?quality=480`)).json() as Answer).state).toBe("none");
  }, 60_000);

  it("is left alone when the conversion folder is emptied on start", () => {
    const root = path.join(fixture.root, "transcode");
    fs.mkdirSync(path.join(root, COPIES_FOLDER), { recursive: true });
    fs.writeFileSync(path.join(root, COPIES_FOLDER, "kept.mp4"), "x");
    fs.mkdirSync(path.join(root, "s-old"));
    expect(prepareRoot(root, { warn: () => undefined })).toBe(root);
    expect(fs.readdirSync(root)).toEqual([COPIES_FOLDER]);
    expect(fs.existsSync(path.join(root, COPIES_FOLDER, "kept.mp4"))).toBe(true);
  });
});

describe("a conversion folder that is no disk of its own", () => {
  it("converts in memory only and makes no copies there, saying why", async () => {
    // As in the image with the Transcode path left empty: /transcode is inside the container.
    await app.close();
    const transcode = path.join(fixture.root, "transcode");
    app = await buildApp({
      gatewaySecret: SECRET, devUser: null, dbPath: ":memory:", mediaRoot: fixture.root, version: "0.0.0-test", stage: null,
      scan: { settleMs: 60_000 }, transcodeDir: transcode, copiesDir: path.join(transcode, COPIES_FOLDER), isMapped: () => false,
      fastify: { logger: false }
    });
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_mov", headers: as("admin"), payload: { name: "Films", kind: "movies", folder: "Movies" } });
    await app.scansSettled();

    const conversion = (await get("/video/api/admin/conversion", "admin")).json();
    expect(conversion.disk).toMatchObject({ mapped: false, folder: transcode });
    // What the admin chose is kept, but memory only is what is in force.
    expect(conversion.settings.storage).toBe("memory-disk");
    expect(conversion.storage).toBe("memory");

    const id = await idOf("Tall Film");
    const asked = (await put(`/video/api/copies/${id}`, { quality: 480 })).json() as Answer & { unavailable?: string };
    expect(asked).toMatchObject({ state: "none", unavailable: "no-disk" });
    expect((await get("/video/api/admin/copies", "admin")).json()).toMatchObject({ insideContainer: true, copies: [] });
  }, 60_000);
});
