// How long the engine stops answering while it scans and runs the metadata
// pass after a scan (issues 1, 4 and 7). A timer ticks every 10 ms; a gap in
// its ticks is time in which no request, health check or video segment could
// have been answered.
//
//   npm run bench:scan                         a fake library (fake-library.mjs), made once in the temp folder
//   npm run bench:scan -- <media folder>       a folder holding Movies/ and Shows/ (a NAS share, say)
//   npm run bench:scan -- <media> <engine>     another checkout of the engine (a git worktree of an
//                                              older tag, with this one's node_modules linked in)
//
// Runs without ffmpeg: detection and conversion are not part of it. Nothing in
// the media folder is written to; the catalog goes in a temporary folder.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { makeFakeLibrary } from "./fake-library.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const [mediaArg, engineArg] = process.argv.slice(2);
const engine = path.resolve(engineArg ?? path.join(here, ".."));
let media = mediaArg ? path.resolve(mediaArg) : path.join(os.tmpdir(), "isputnik-video-fake-library");
if (!mediaArg && !fs.existsSync(path.join(media, "Movies"))) {
  const made = makeFakeLibrary(media);
  console.log(`Made a fake library: ${made.films} films, ${made.episodes} episodes, in ${media}`);
}
for (const folder of ["Movies", "Shows"]) {
  if (!fs.existsSync(path.join(media, folder))) {
    console.error(`${media} has no ${folder} folder`);
    process.exit(1);
  }
}
const { buildApp } = await import(pathToFileURL(path.join(engine, "src", "app.ts")).href);
const version = JSON.parse(fs.readFileSync(path.join(engine, "package.json"), "utf8")).version;
let commit = "";
try {
  commit = ` at ${execFileSync("git", ["-C", engine, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()}`;
} catch {
  // Not a git checkout: the version says enough.
}
console.log(`Engine ${version}${commit} (${engine}) on ${media}\n`);

const SECRET = "bench-secret-bench-secret-0123456789";
const admin = {
  "x-isputnik-gateway": SECRET, "x-isputnik-user-id": "admin", "x-isputnik-user-name": "admin",
  "x-isputnik-user-role": "admin", "x-isputnik-libraries": "", "x-isputnik-client-ip": "192.168.2.10"
};

let gaps = [];
let last = performance.now();
const tick = setInterval(() => {
  const now = performance.now();
  if (now - last > 50) gaps.push(now - last);
  last = now;
}, 10);

async function phase(name, work) {
  gaps = [];
  last = performance.now();
  const started = performance.now();
  await work();
  const wall = (performance.now() - started) / 1000;
  const long = gaps.filter((gap) => gap > 200);
  const longest = Math.max(0, ...gaps) / 1000;
  const held = long.reduce((sum, gap) => sum + gap, 0) / 1000;
  console.log(`${name.padEnd(26)} ${wall.toFixed(1).padStart(6)} s in all   longest stall ${longest.toFixed(2).padStart(6)} s   held over 200 ms: ${held.toFixed(1).padStart(5)} s (${long.length} times)`);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-bench-"));
let app;
try {
  await phase("start", async () => {
    app = await buildApp({
      gatewaySecret: SECRET, devUser: null, dbPath: path.join(dataDir, "video.sqlite"), mediaRoot: media, version: "0.0.0-bench", stage: null,
      scan: { settleMs: 60_000 }, tools: null, artDir: path.join(dataDir, "art"), fastify: { logger: false }
    });
  });
  const scanAll = async () => {
    for (const id of ["lib_mov", "lib_tv"]) await app.inject({ method: "POST", url: `/video/api/admin/libraries/${id}/scan`, headers: admin });
    await app.scansSettled();
  };
  await phase("first scan + pass", async () => {
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_mov", headers: admin, payload: { name: "Films", kind: "movies", folder: "Movies" } });
    await app.inject({ method: "PUT", url: "/video/api/admin/libraries/lib_tv", headers: admin, payload: { name: "TV", kind: "shows", folder: "Shows" } });
    await app.scansSettled();
  });
  await phase("rescan, nothing changed", scanAll);
  await phase("rescan again", scanAll);

  // What was built, to compare one engine's catalog with another's.
  const db = new Database(path.join(dataDir, "video.sqlite"), { readonly: true });
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  console.log(`\nCatalog: ${count("movies")} films, ${count("shows")} shows, ${count("episodes")} episodes, ${count("people")} people, ${count("credits")} credits, ${count("metadata")} metadata rows`);
  db.close();
} finally {
  clearInterval(tick);
  await app?.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
