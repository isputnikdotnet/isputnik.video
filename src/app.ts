// The video engine: no pages of its own. Home draws every screen and manages
// every library; this server scans the folders, keeps the catalog and answers
// for both (home's docs/video-architecture.md). Reached only through home's
// gateway, under /video, with the person's identity in signed headers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { WATCH_STATES, getMovie, getShow, listMovies, listShows, listTitles, visibleGenres, visibleLibraries, type WatchState } from "./catalog.js";
import { browserPlayability, continueWatching, dismissContinue, fileOfAsync, findItem, forgetHistory, markAllWatched, movieIdOf, nextEpisode, nextPart, progressFor, purgeOrphanProgress, resumeAt, saveProgress, type PlayableItem } from "./playback.js";
import { RUNGS, decideDelivery, rungOf, type Delivery, type DeliveryMode, type DeliveryReason, type Rung } from "./delivery.js";
import { findTools, toolsWork, type AudioStream, type MediaInfo, type Tools } from "./ffmpeg.js";
import { SubtitleCache, burnIndexOf, listSubtitles, type SubtitleTrack } from "./subtitles.js";
import { MarkError, clearMark, detectedMarkers, findMarkers, purgeOrphanMarkers, readMarks, setMark } from "./markers.js";
import { DetectRunner, purgeOrphanDetected, readDetected } from "./detect.js";
import { MetadataRunner, artFileAsync, keyHint, metaFor, partOfKey, posterStateOf, purgeOrphanMetadata, readTmdbKey, removePosterUpload, savePosterUpload, saveTmdbKey, setBackdropChoice, setMatch, setPosterChoice, tmdbKeySchema, tmdbMatchOf, type ArtKind } from "./metadata.js";
import { IMAGE_SIZES, Tmdb, TmdbError, imagePathSchema, type Fetch } from "./tmdb.js";
import { Hardware, detectGpu, type GpuCapabilities } from "./hardware.js";
import { HlsBusyError, HlsError, HlsSessions, HlsSupersededError, buildPlan, fileStamp, legacyOf, playlist, variantOf, type HlsPlan, type HlsRefusal, type SegmentData } from "./hls.js";
import { isInside, isMapped } from "./mounts.js";
import { detectionSchema, mergeConversion, readConversion, readCopies, readDetection, readJobs, saveConversion, saveCopies, saveDetection, saveJobs } from "./settings.js";
import { COPY_LIMITS, Copies, copySettingsSchema, estimateCopySeconds, jobSettingsSchema, type CopyKey } from "./copies.js";
import { Bucket, throttled } from "./throttle.js";
import { KeepReady, keepReadySchema, type KeepReadyRow } from "./keep-ready.js";
import { overLimit, type KeptThing } from "./cache.js";
import { MediaProbe, purgeOrphanProbes, type ProbedFile } from "./media-probe.js";
import { KeyframeWarmer } from "./keyframe-warmer.js";
import { ffmpegVersionOf, problemLines, systemFacts } from "./diagnostics.js";
import { HardwareTester, fingerprintOf, listChanges, listTests, noteHardware, type HardwareTest, type Scenario, type TestLimits } from "./hardware-test.js";
import { DiskChecker, listDiskChecks, type DiskCheck, type DiskLimits } from "./disk-check.js";
import { BASE_PATH } from "./config.js";
import { groupByDisk, type DiskHolding } from "./disks.js";
import { openDatabase, upgradeDatabase } from "./db.js";
import { RESTORE_BODY_LIMIT, RestoreError, SQLITE_CONTENT_TYPE, restoreDatabase, undoInfo, undoRestore, type RestoreTarget } from "./restore.js";
import { EVENT_LEVELS, EVENT_RETENTION_DAYS, countEventsSince, listEvents, pruneEvents, recordEvent, type EventLevel } from "./events.js";
import { canSee, clientIpFrom, devIdentity, forwardedRequestId, historyIdFor, identityFrom, rejectionReason, type Identity } from "./identity.js";
import { LibraryError, getLibrary, listLibraries, purgeDetached, purgeLibrary, putLibrary, setScanState, syncLibraries } from "./libraries.js";
import type { LogBuffer } from "./log-buffer.js";
import { listFolders, resolveInside } from "./media.js";
import { ScanError, scanLibrary, type ScanOptions } from "./scan.js";
import { getSet, listSets, nextInSet, rebuildSets, setArtRow } from "./sets.js";
import { editState, saveEdit, setNames } from "./edits.js";
import { getPerson, keepPhoto, personVisible, photoFile, rebuildAllCredits, rebuildCredits, searchPeople } from "./credits.js";
import { resolveGenres } from "./genres.js";
import { GenreError, addKeyword, createGenre, deleteGenre, reloadGenres, genreOverview, hideWord, mergeGenre, removeKeyword, renameGenre, seedGenres, showWord } from "./genres.js";

declare module "fastify" {
  interface FastifyRequest {
    identity: Identity | null;
    /** The browser's address as the gateway saw it; the socket's otherwise. */
    clientIp: string;
  }
  interface FastifyInstance {
    /** Resolves once every scan asked for so far has finished — for tests and shutdown. */
    scansSettled(): Promise<void>;
    /** …and the intros and credits looked for after them (detect.ts). */
    detectionSettled(): Promise<void>;
    /** …and the keyframes read ahead of the first play after them (keyframe-warmer.ts). */
    keyframesSettled(): Promise<void>;
  }
}

export interface AppOptions {
  gatewaySecret: string | null;
  /** Used when no secret is configured — development only. */
  devUser: string | null;
  /** The SQLite file; ":memory:" in tests. */
  dbPath: string;
  /** Where the video folders are mounted. */
  mediaRoot: string;
  version: string;
  stage: string | null;
  logBuffer?: LogBuffer;
  /** ffmpeg and ffprobe, for converting what a browser can't play; found on
   *  PATH (or the dev dependencies) when left out, none at all when null. */
  tools?: Tools | null;
  /** Finds out what the GPU can do (hardware.ts); tests hand in their own. */
  detectGpu?: (tools: Tools) => Promise<GpuCapabilities>;
  /** Where segments are made while someone watches (TRANSCODE_PATH); emptied on
   *  start and removed on close. A fresh temporary folder when left out. */
  transcodeDir?: string;
  /** Whether a folder is a disk mapped into the container (mounts.ts); tests
   *  hand in their own. Without one, conversion is in memory only and no copies
   *  are made inside the conversion folder. */
  isMapped?: (folder: string) => boolean;
  /** Where TMDB's posters and backdrops are kept (ART_PATH); a fresh temporary
   *  folder when left out. */
  artDir?: string;
  /** Where copies made for download are kept (copies.ts); a fresh temporary
   *  folder, removed on close, when left out. */
  copiesDir?: string;
  /** Where the hardware test keeps its clips (hardware-test.ts); beside the
   *  catalog when left out, or a temporary folder for one in memory. */
  samplesDir?: string;
  /** Tests run the hardware test on small clips, quickly. */
  hardwareTest?: { scenarios?: readonly Scenario[]; limits?: Partial<TestLimits> };
  /** Tests read less in the disk check. */
  diskCheck?: Partial<DiskLimits>;
  /** How TMDB is reached; tests hand in their own. */
  fetch?: Fetch;
  /** Tests settle files at once instead of waiting out a copy. */
  scan?: ScanOptions;
  /** Find intros, recaps and credits by itself (detect.ts) after each scan and on
   *  start, while the admin's setting allows. The server turns it on; tests ask for it. */
  detect?: boolean;
  /** Read the keyframes of titles whose picture is copied as it is ahead of
   *  their first play (keyframe-warmer.ts), after each scan and on start. The
   *  server turns it on; tests ask for it. */
  warmKeyframes?: boolean;
  fastify?: FastifyServerOptions;
}

const API = `${BASE_PATH}/api`;

/** Requests here are small JSON; nothing posts a file to the engine. */
export const BODY_LIMIT = 64 * 1024;
const LOG_LINES_MAX = 500;
/** How often a detection pass waiting for viewers looks again. */
const VIEWER_CHECK_MS = 15_000;

const eventsQuerySchema = z.object({
  level: z.enum(EVENT_LEVELS as [EventLevel, ...EventLevel[]]).optional(),
  event: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25)
});

const logQuerySchema = z.object({
  lines: z.coerce.number().int().min(10).max(LOG_LINES_MAX).default(200)
});

const libraryIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const libraryBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["shows", "movies"]),
  folder: z.string().trim().min(1).max(1024),
  language: z.string().trim().regex(/^[a-z]{2}(-[A-Za-z]{2})?$/).default("en")
});

const syncBodySchema = z.object({ ids: z.array(libraryIdSchema).max(1000) });

const foldersQuerySchema = z.object({ path: z.string().max(1024).default("") });

const listQuerySchema = z.object({
  library: libraryIdSchema.optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(["title", "year", "added"]).default("title"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(60)
});

const itemIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** A comma-separated list in a query string, each value checked. */
const listParam = (each: z.ZodString) =>
  z.string().max(4000).optional()
    .transform((value) => (value ?? "").split(",").map((part) => part.trim()).filter(Boolean))
    .pipe(z.array(each).max(100));

const kindSchema = z.enum(["shows", "movies"]);

const titleQuerySchema = z.object({
  kind: kindSchema.optional(),
  libraries: listParam(libraryIdSchema),
  genres: listParam(z.string().max(100)),
  // unwatched, progress, watched — any of; a word it doesn't know is not asked.
  watch: z.string().max(100).optional()
    .transform((value) => (value ?? "").split(",").map((part) => part.trim()).filter((part): part is WatchState => (WATCH_STATES as readonly string[]).includes(part))),
  q: z.string().max(200).optional(),
  sort: z.enum(["title", "year", "added"]).default("title"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(60)
});

/** PUT /watched: all of a show, one season of it, or every part of a film. */
const watchedBodySchema = z.object({
  watched: z.boolean(),
  season: z.number().int().min(0).max(10_000).optional()
});

const setListQuerySchema = z.object({
  library: libraryIdSchema.optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(60)
});

const progressBodySchema = z.object({
  position: z.number().min(0).max(1e6),
  duration: z.number().positive().max(1e6).nullable().default(null),
  watched: z.boolean().optional()
});

const subtitleIdSchema = z.string().regex(/^(s\d{1,3}|x[0-9a-f]{10})$/);

/** The sound track chosen, by ffprobe stream index; the subtitle chosen, by track id
 *  (only an image one changes how the film plays: it is burned in). */
const playQuerySchema = z.object({
  audio: z.coerce.number().int().min(0).max(999).optional(),
  subtitle: subtitleIdSchema.optional(),
  /** A quality rung by height, or "original" (docs/video-quality-plan.md). */
  quality: z.enum(["original", "1080", "720", "480"]).optional()
});

/** The HLS address of one sound track: t<index>, or t- for a silent film; with
 *  b<index> after it when an image subtitle is burned in, and q<height> when
 *  the picture is held under a quality rung. */
const trackSegment = (delivery: Delivery) =>
  `${delivery.audio ? `t${delivery.audio.index}` : "t-"}${delivery.burn ? `b${delivery.burn.index}` : ""}${delivery.rung ? `q${delivery.rung}` : ""}`;

const artKindSchema = z.enum(["poster", "backdrop", "still"]);

const metadataBodySchema = z.object({ tmdbKey: tmdbKeySchema.nullable() });

const matchSearchSchema = z.object({
  kind: z.enum(["movie", "tv"]),
  q: z.string().trim().min(1).max(200),
  year: z.coerce.number().int().min(1800).max(2200).optional(),
  language: z.string().trim().regex(/^[a-z]{2}(-[A-Za-z]{2})?$/).default("en")
});

// tmdbKind: where on TMDB the id is (a film kept here may be a TV show there); the title's own kind when left out.
const matchBodySchema = z.object({ tmdbId: z.string().regex(/^\d{1,10}$/).nullable(), tmdbKind: z.enum(["movie", "tv"]).optional() });
const backdropBodySchema = z.object({ path: imagePathSchema.nullable() });
/** An uploaded poster: a big phone photo fits. */
const POSTER_UPLOAD_LIMIT = 15 * 1024 * 1024;
// A mark by hand (markers.ts); a null start clears it.
const markBodySchema = z.object({
  kind: z.enum(["intro", "credits", "recap"]),
  scope: z.enum(["episode", "season"]),
  start: z.number().min(0).max(24 * 3600).nullable(),
  end: z.number().min(0).max(24 * 3600).nullable().default(null)
});

/** Video a device player can't be trusted with as it is (`original` in /play): MPEG-4 Part 2
 *  (DivX, XviD) and Microsoft's MPEG-4 v1–v3. */
const ORIGINAL_UNSAFE = new Set(["mpeg4", "msmpeg4v1", "msmpeg4v2", "msmpeg4v3"]);
const originalUnsafe = (codec: string | null) => codec !== null && ORIGINAL_UNSAFE.has(codec);

/** Room on the disk a folder is on; nulls where it can't be read. */
function freeSpace(folder: string): { freeBytes: number | null; totalBytes: number | null } {
  try {
    const stats = fs.statfsSync(folder);
    return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
}

const ART_TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

const continueQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });

/** A single byte range from a Range header; null for none (the whole file),
 *  "invalid" for one that cannot be served. Several ranges get the whole file,
 *  which every player accepts. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return header.includes(",") ? null : "invalid";
  const [, from, to] = match;
  if (from === "" && to === "") return "invalid";
  let start: number;
  let end: number;
  if (from === "") {
    // The last N bytes.
    const suffix = Number(to);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const secret = options.gatewaySecret;
  const dev = secret ? null : options.devUser ? devIdentity(options.devUser) : null;
  let requestCounter = 0;
  const app = fastify({
    bodyLimit: BODY_LIMIT,
    ...options.fastify,
    genReqId: (raw) => forwardedRequestId(raw.headers, secret) ?? `req-${(++requestCounter).toString(36)}`
  });
  const db = openDatabase(options.dbPath);

  // ffmpeg converts what a browser can't play (delivery.ts, hls.ts); without it
  // a file plays as it is or not at all.
  const tools = options.tools === undefined ? findTools() : options.tools;
  const toolsReady = tools ? toolsWork(tools) : Promise.resolve(false);
  void toolsReady.then((ok) => {
    if (!ok) app.log.warn("ffmpeg or ffprobe not found: only files a browser plays as they are will play");
  });
  const mediaProbe = tools ? new MediaProbe(db, tools) : null;
  const engineLog = {
    info: (obj: object, msg: string) => app.log.info(obj, msg),
    warn: (obj: object, msg: string) => app.log.warn(obj, msg)
  };
  // The GPU (hardware.ts): found out once ffmpeg answers, and on Check again.
  const hardware = tools ? new Hardware(() => (options.detectGpu ?? detectGpu)(tools), engineLog) : null;
  const hls = tools ? new HlsSessions(tools, options.transcodeDir ?? null, engineLog, hardware) : null;
  hls?.configure(readConversion(db));
  hls?.setMapped((options.isMapped ?? isMapped)(hls.folder));
  // Not once the app has closed (a short test can close before ffmpeg answers).
  let closed = false;
  void toolsReady.then((ok) => { if (ok && !closed) hardware?.configure(readConversion(db).hardware); });
  const subtitleCache = tools ? new SubtitleCache(tools) : null;
  // The hardware test (hardware-test.ts): only when an admin asks, never while
  // someone watches converted video; the work below waits while it runs.
  const samplesDir = options.samplesDir ?? (options.dbPath === ":memory:"
    ? path.join(os.tmpdir(), "isputnik-video-samples")
    : path.join(path.dirname(path.resolve(options.dbPath)), "samples"));
  const tester = tools && hardware ? new HardwareTester({
    db,
    tools,
    samplesDir,
    ffmpegVersion: () => ffmpegVersionOf(tools),
    gpuFor: (info, delivery) => hardware.gpuFor(info, delivery),
    gpuState: () => {
      const state = hardware.state();
      return { device: state.device, driver: state.driver, decode: state.decode, tonemap: state.tonemap, overlay: state.overlay, error: state.error };
    },
    maxViewers: () => readConversion(db).maxViewers,
    log: engineLog,
    ...options.hardwareTest
  }) : null;
  // The disk check (disk-check.ts): the same rules as the hardware test.
  const disks = new DiskChecker({ db, mediaRoot: options.mediaRoot, log: engineLog, limits: options.diskCheck });
  /** Someone watches converted video, or a test or disk check runs: background work waits. */
  const busyConverting = () => (hls?.watching() ?? 0) > 0 || (tester?.running() ?? false) || disks.running();
  // A GPU, driver or ffmpeg different from the last start's is noted (H2).
  if (hardware && tools) {
    hardware.onChecked = (caps) => {
      void ffmpegVersionOf(tools).then((version) => {
        if (closed || !db.open) return;
        const change = noteHardware(db, fingerprintOf(caps, version));
        if (!change) return;
        recordEvent(db, { level: "info", event: "hardware.changed", detail: change.summary });
        app.log.info({ change: change.summary }, "The hardware changed since the last check");
      });
    };
  }
  // Copies made for download: a queue of its own, which waits while anyone watches.
  const copiesDir = options.copiesDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-copies-"));
  const copies = tools ? new Copies(db, tools, copiesDir, engineLog, hardware, busyConverting, hls) : null;
  // When the queue works, and how much (C4): home's Settings › Video › Downloads and Keep ready.
  copies?.configureJobs(readJobs(db));
  // One bucket for every copy going to someone away from home (throttle.ts).
  const remoteBucket = new Bucket(() => copies?.remoteBytesPerSecond ?? 0);
  // Titles an admin keeps ready (keep-ready.ts): their kept versions are never trimmed.
  const keepReady = new KeepReady(db);
  copies?.configure(readCopies(db));
  // Copies kept inside a conversion folder that is no disk of its own would fill
  // the container (on Unraid, docker.img): none are made there. Ones made before
  // are still handed out until the admin deletes them.
  const copiesInsideContainer = Boolean(hls && isInside(copiesDir, hls.folder) && !hls.mapped);
  // One limit (Room for kept video) for the copies and the films kept whole once
  // converted all through (cache.ts): past it, what was used longest ago goes.
  const copyId = (key: CopyKey) => `${key.itemId}:${key.rung}:${key.audio}`;
  const trimCache = (justMade: string | null = null) => {
    if (!copies) return;
    const pinned = keepReady.pinned();
    const things: KeptThing[] = [
      ...copies.readyItems().map((copy) => ({ kind: "copy" as const, id: copyId(copy.key), sizeBytes: copy.sizeBytes, usedAt: copy.usedAt, held: copyId(copy.key) === justMade })),
      ...(hls?.keptFilms() ?? []).map((film) => ({ kind: "film" as const, id: film.variant, sizeBytes: film.sizeBytes, usedAt: film.usedAt, held: Boolean(film.inUse) || film.variant === justMade || pinned.has(`${film.itemId}:${film.rung}`) }))
    ];
    const ready = new Map(copies.readyItems().map((copy) => [copyId(copy.key), copy.key]));
    for (const thing of overLimit(things, readCopies(db).limitGb * 1024 ** 3)) {
      if (thing.kind === "film") hls?.removeKept(thing.id);
      else if (ready.has(thing.id)) copies.remove(ready.get(thing.id)!);
    }
  };
  if (hls) hls.onKept = () => trimCache();
  if (copies) copies.onReady = (key) => trimCache(copyId(key));
  trimCache();

  // Posters and TMDB (metadata.ts): after each scan, one library at a time.
  const artDir = options.artDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-video-art-"));
  const ownsArtDir = options.artDir === undefined;
  const metadata = new MetadataRunner({ db, mediaRoot: options.mediaRoot, artDir, fetch: options.fetch, tools, log: { warn: (obj, msg) => app.log.warn(obj, msg) } });
  let metadataChain: Promise<void> = Promise.resolve();
  const metadataQueued = new Set<string>();

  /** How the file reaches the browser, from what ffprobe finds inside it; null
   *  when ffmpeg is missing or can't read the file. */
  const deliveryFor = async (item: PlayableItem, file: ProbedFile, audioIndex?: number | null, burnIndex?: number | null, rung: Rung | null = null): Promise<{ info: MediaInfo; delivery: Delivery } | null> => {
    if (!mediaProbe || !(await toolsReady)) return null;
    try {
      const info = await mediaProbe.info(item.id, file);
      return { info, delivery: decideDelivery(info, path.extname(item.relative), audioIndex, burnIndex, rung) };
    } catch (err) {
      app.log.warn({ err, item: item.id }, "ffprobe could not read a video file");
      return null;
    }
  };

  // ── Background work on the shared cache (home's docs/video-cache-plan.md C3) ──
  // Whoever asked, the engine finds the files itself: every library is its own.
  const engineIdentity = devIdentity("engine:Engine");
  /** Whether versions can be kept here at all: a disk of its own, and not memory only. */
  const canKeep = () => Boolean(copies && hls && !copiesInsideContainer && hls.canKeep);

  /** An episode or film at a quality: its version's plan when its picture has to
   *  be re-encoded there; `plan` null when it plays as it is (or only its
   *  container or sound changes); null when the file can't be found or read. */
  const versionAt = async (itemId: string, rung: Rung): Promise<{ plan: HlsPlan | null; title: string; duration: number } | null> => {
    const item = findItem(db, engineIdentity, itemId);
    const file = item ? await fileOfAsync(options.mediaRoot, item) : null;
    if (!item || !file) return null;
    const decided = await deliveryFor(item, file, null, null, rung);
    if (!decided) return null;
    const title = item.show ? `${item.show.title} S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}` : item.title;
    if (decided.delivery.mode === "direct" || decided.delivery.videoCopy) return { plan: null, title, duration: decided.info.duration };
    return { plan: buildPlan(item.id, file.absolute, decided.info, decided.delivery, null, fileStamp(file)), title, duration: decided.info.duration };
  };
  const keepJobId = (plan: HlsPlan) => `keep:${variantOf(plan)}`;

  /** Every marked version not yet kept goes on the queue (once): on start, after
   *  each scan (new episodes), and when a title is marked. */
  let keepQueuing: Promise<void> = Promise.resolve();
  const queueKeepReady = () => {
    keepQueuing = keepQueuing.then(async () => {
      if (!canKeep() || closed) return;
      for (const row of keepReady.list()) {
        for (const item of keepReady.itemsOf(row)) {
          for (const rung of row.rungs) {
            const version = await versionAt(item.itemId, rung);
            if (!version?.plan || hls!.isKept(version.plan)) continue;
            copies!.queueFill({ id: keepJobId(version.plan), kind: "keep", itemId: item.itemId, title: version.title, plan: version.plan });
          }
        }
      }
    }).catch((err) => app.log.warn({ err }, "Could not queue the titles kept ready"));
    return keepQueuing;
  };

  /** How a marked title stands: how many of its versions are kept, play as they
   *  are, wait or are being made, what they take and about what the rest will. */
  const keepStatus = async (row: KeepReadyRow) => {
    const sizes = new Map((hls?.keptFilms() ?? []).map((film) => [film.variant, film.sizeBytes]));
    let total = 0, ready = 0, asIs = 0, waiting = 0, missing = 0, sizeBytes = 0, estimateBytes = 0;
    let making: { title: string; rung: Rung; progress: number } | null = null;
    for (const item of keepReady.itemsOf(row)) {
      for (const rung of row.rungs) {
        total += 1;
        const version = await versionAt(item.itemId, rung);
        if (!version) { missing += 1; continue; }
        if (!version.plan) { asIs += 1; continue; }
        const size = sizes.get(variantOf(version.plan));
        if (size !== undefined) { ready += 1; sizeBytes += size; continue; }
        waiting += 1;
        const limits = COPY_LIMITS[rung];
        estimateBytes += Math.round((version.duration * (limits.bitRate + limits.audioRate)) / 8);
        const queued = copies?.fillStatus(keepJobId(version.plan));
        if (queued?.state === "running") making = { title: version.title, rung, progress: queued.progress };
      }
    }
    return { ...row, total, ready, asIs, waiting, missing, sizeBytes, estimateBytes, making };
  };

  // A version a viewer left mostly made is finished off, so it is kept.
  if (hls) {
    hls.onUnfinished = (plan, title) => {
      if (canKeep()) copies!.queueFill({ id: `finish:${variantOf(plan)}`, kind: "finish", itemId: plan.itemId, title, plan });
    };
  }

  /** Copies asked for before a restart are asked for again; ones whose film has
   *  gone are forgotten. */
  const resumeCopies = async () => {
    if (!copies) return;
    for (const key of copies.pendingCopies()) {
      const item = findItem(db, engineIdentity, key.itemId);
      const file = item ? await fileOfAsync(options.mediaRoot, item) : null;
      const decided = item && file ? await deliveryFor(item, file, key.audio >= 0 ? key.audio : null, null, key.rung) : null;
      if (!item || !file || !decided || decided.delivery.mode === "direct" || copiesInsideContainer) {
        copies.remove(key);
        continue;
      }
      const title = item.show ? `${item.show.title} S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}` : item.title;
      copies.resume({ ...key, title, file, info: decided.info, delivery: decided.delivery });
    }
  };
  void toolsReady.then((ok) => {
    if (!ok || closed) return;
    void resumeCopies().then(() => queueKeepReady());
  });

  // Keyframes read ahead of the first play (keyframe-warmer.ts): the films a
  // browser gets with their picture copied as it is, as planFor() cuts them.
  const warmStop = new AbortController();
  const warmer = mediaProbe && options.warmKeyframes ? new KeyframeWarmer({
    db,
    mediaRoot: options.mediaRoot,
    probe: mediaProbe,
    copiesPicture: (item, info) => {
      const delivery = decideDelivery(info, path.extname(item.relative));
      return delivery.mode !== "direct" && delivery.videoCopy;
    },
    busy: () => (hls?.active() ?? 0) > 0 || (tester?.running() ?? false) || disks.running(),
    log: engineLog
  }) : null;
  const warmKeyframes = () => {
    if (warmer && !warmStop.signal.aborted) void toolsReady.then((ok) => { if (ok) void warmer.queue(warmStop.signal); });
  };
  app.decorate("keyframesSettled", async () => {
    await scanChain;
    await toolsReady;
    await warmer?.settled();
  });
  warmKeyframes();

  // One scan at a time: scans read a whole disk, and two would only fight over it.
  let scanChain: Promise<void> = Promise.resolve();
  // A scan the engine was stopped in the middle of (docker stop, a crash) left
  // its library queued or scanning; nothing is either on start.
  db.prepare("UPDATE libraries SET scan_state = 'idle' WHERE scan_state IN ('queued', 'scanning')").run();
  const queued = new Set<string>();
  // Scans and metadata passes queued or running. A restore waits for none: it is
  // refused while there are any, since they would carry on writing into a catalog
  // that had just been replaced under them.
  let catalogWork = 0;
  // A scan queues the library's metadata pass, so both are settled once the
  // scans and then the passes are.
  app.decorate("scansSettled", async () => {
    await scanChain;
    await metadataChain;
  });

  // Intros and credits found by sound and picture (detect.ts): one library, show
  // or title at a time, after the scans, never counted as catalog work — it only
  // writes rows of its own, keyed by the file it read, which a restore can't undo.
  // The admin turns it on and off on home's Settings → Video (readDetection);
  // turned off, what runs stops and nothing more is queued.
  const detector = tools && mediaProbe && options.detect ? new DetectRunner({ db, tools, mediaRoot: options.mediaRoot, probe: mediaProbe }) : null;
  const detectStop = new AbortController();
  let detectPause = new AbortController();
  let detectChain: Promise<void> = Promise.resolve();
  const detectQueued = new Set<string>();
  type DetectScope = Parameters<DetectRunner["run"]>[0];
  /** What an admin asked for (Find again): run at the next season boundary of
   *  whatever long pass is going, not after it — a first pass takes hours. */
  const detectUrgent: { scope: DetectScope; request: FastifyRequest | null }[] = [];
  /** While someone watches converted video, a pass waits before its next file
   *  (as copies do), inside a season too: its ffmpeg would take the cores and
   *  the disk from them, and a season of 2160p episodes runs for an hour. */
  const whileWatching = async (signal: AbortSignal) => {
    while (busyConverting() && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, VIEWER_CHECK_MS);
        function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
        signal.addEventListener("abort", done, { once: true });
      });
    }
  };
  const runDetect = async (scope: DetectScope, force: boolean, request: FastifyRequest | null, between?: () => Promise<void>) => {
    if (!detector || detectStop.signal.aborted || !readDetection(db).enabled || !(await toolsReady)) return;
    const started = Date.now();
    const signal = AbortSignal.any([detectStop.signal, detectPause.signal]);
    // Only the passes queued by scans and on start wait; what an admin asked for runs now.
    const gate = between ? async () => { await whileWatching(signal); await between(); } : undefined;
    const hold = between ? () => whileWatching(signal) : undefined;
    try {
      const done = await detector.run(scope, force, signal, gate, hold);
      if (done.seasons + done.films === 0) return;
      note(request, "info", "detect.finished", {
        libraryId: "library" in scope ? scope.library : null,
        detail: `${done.seasons} season(s), ${done.films} film(s): ${done.recaps} recap(s), ${done.intros} intro(s), ${done.credits} credits found in ${Math.round((Date.now() - started) / 1000)} s`
      });
    } catch (err) {
      if (signal.aborted) return;
      note(request, "error", "detect.failed", { detail: (err as Error).message });
      app.log.error({ err, scope }, "Finding intros and credits failed");
    }
  };
  const drainUrgent = async () => {
    while (detectUrgent.length > 0) {
      const job = detectUrgent.shift()!;
      await runDetect(job.scope, true, job.request);
    }
  };
  const queueDetect = (scope: DetectScope, force: boolean, request: FastifyRequest | null, urgent = false) => {
    if (!detector || !readDetection(db).enabled) return;
    if (urgent) {
      detectUrgent.push({ scope, request });
      // Taken up by the pass going on now, between two seasons, or else at once.
      detectChain = detectChain.then(drainUrgent);
      return;
    }
    const key = `${JSON.stringify(scope)}:${force}`;
    if (detectQueued.has(key)) return;
    detectQueued.add(key);
    detectChain = detectChain.then(async () => {
      detectQueued.delete(key);
      await runDetect(scope, force, request, drainUrgent);
    }).finally(() => { detector.working = null; });
  };
  app.decorate("detectionSettled", async () => {
    await scanChain;
    await metadataChain;
    await detectChain;
  });
  /** Every title not looked at yet, in one pass over all the libraries, what is
   *  being watched first (so a big kids' library doesn't keep the show on now waiting for hours). */
  const detectEverything = (request: FastifyRequest | null) => queueDetect({ all: true }, false, request);
  // 0.17.0 compared a recap only with the earlier episodes of its own season, so
  // one made of the season before (Counterpart S2E02) was missed: those without
  // one are looked at once more, their pictures already kept.
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'recaps-reach-back'").get()) {
    db.transaction(() => {
      db.prepare("UPDATE detected_markers SET recap_checked = 0 WHERE recap_start IS NULL AND recap_checked = 1 AND intro_checked = 1 AND item_id IN (SELECT id FROM episodes)").run();
      db.prepare("INSERT INTO settings (key, value) VALUES ('recaps-reach-back', 'true')").run();
    })();
  }
  // On start, whatever wasn't looked at before (an engine older than 0.16.0 never did).
  if (detector) {
    void toolsReady.then((ok) => {
      if (ok && !detectStop.signal.aborted) detectEverything(null);
    });
  }

  app.addHook("onClose", async () => {
    closed = true;
    clearInterval(daily);
    hls?.close();
    copies?.close();
    if (options.copiesDir === undefined) fs.rmSync(copiesDir, { recursive: true, force: true });
    detectStop.abort();
    tester?.stop("The engine is stopping");
    disks.stop("The engine is stopping");
    await tester?.settled();
    await disks.settled();
    warmStop.abort();
    await detectChain.catch(() => undefined);
    await warmer?.settled();
    await mediaProbe?.close();
    await scanChain.catch(() => undefined);
    await metadataChain.catch(() => undefined);
    db.close();
    if (ownsArtDir) fs.rmSync(artDir, { recursive: true, force: true });
  });

  // Old events and long-detached libraries go on start and once a day after.
  const sweep = () => {
    pruneEvents(db, EVENT_RETENTION_DAYS);
    const purged = purgeDetached(db);
    if (purged > 0) recordEvent(db, { level: "info", event: "library.purged", detail: `${purged} library(ies) detached for over 30 days were removed` });
    purgeOrphanProgress(db);
    copies?.purgeOrphans();
    purgeOrphanProbes(db);
    purgeOrphanMarkers(db);
    purgeOrphanDetected(db);
    purgeOrphanMetadata(db, artDir);
    rebuildSets(db, artDir);
    // In slices: on a big library the whole cast is seconds of work.
    void rebuildAllCredits(db, artDir).catch((err) => app.log.warn({ err }, "Could not work out the cast and crew again"));
  };
  sweep();
  const daily = setInterval(sweep, 24 * 60 * 60 * 1000);
  daily.unref();

  app.setChildLoggerFactory(function (logger, bindings, loggerOptions, raw) {
    const identity = secret ? identityFrom(raw.headers, secret) : dev;
    return logger.child({ ...bindings, user: identity?.id ?? null, ip: clientIpFrom(raw.headers, secret, raw.socket?.remoteAddress) }, loggerOptions);
  });

  // A poster the admin uploads arrives as the picture itself.
  app.addContentTypeParser(["image/jpeg", "image/png", "image/webp"], { parseAs: "buffer", bodyLimit: POSTER_UPLOAD_LIMIT }, (_request, body, done) => done(null, body));

  app.decorateRequest("identity", null);
  app.decorateRequest("clientIp", "");
  app.addHook("onRequest", async (request) => {
    request.identity = secret ? identityFrom(request.headers, secret) : dev;
    request.clientIp = clientIpFrom(request.headers, secret, request.ip);
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Robots-Tag", "noindex, nofollow");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
  });

  const note = (request: FastifyRequest | null, level: EventLevel, event: string, fields: { libraryId?: string | null; detail: string }) => {
    recordEvent(db, {
      level,
      event,
      actorId: request?.identity?.id ?? null,
      actorName: request?.identity?.name ?? null,
      libraryId: fields.libraryId ?? null,
      ip: request?.clientIp || null,
      requestId: request ? String(request.id) : null,
      detail: fields.detail
    });
  };
  const pathOf = (request: FastifyRequest) => request.url.split("?")[0];

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof LibraryError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof MarkError) return reply.code(400).send({ error: error.message });
    if (error instanceof GenreError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof RestoreError) {
      note(request, "warn", "restore.refused", { detail: error.message });
      return reply.code(error.status).send({ error: error.message });
    }
    if (error instanceof z.ZodError) {
      const fields = [...new Set(error.issues.map((issue) => issue.path.join(".") || "(body)"))].join(", ");
      note(request, "warn", "request.invalid", { detail: `${request.method} ${pathOf(request)}: ${fields}` });
      return reply.code(400).send({ error: "Invalid request", details: error.issues });
    }
    const status = typeof (error as { statusCode?: number }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, "Unhandled error");
      note(request, "error", "request.error", { detail: `${request.method} ${pathOf(request)}: ${(error as Error).message}` });
    }
    return reply.code(status).send({ error: status >= 500 ? "Something went wrong" : (error as Error).message });
  });

  const requireIdentity = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.identity) return;
    if (secret) {
      const reason = rejectionReason(request.headers, secret);
      request.log.warn({ reason }, "Request refused at the gateway check");
      note(request, "warn", "gateway.rejected", { detail: `${request.method} ${pathOf(request)}: ${reason}` });
    }
    return reply.code(401).send({ error: "Not signed in" });
  };
  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    await requireIdentity(request, reply);
    if (reply.sent) return;
    if (request.identity!.role !== "admin") return reply.code(403).send({ error: "Admins only" });
  };

  /** Queue a library's scan; a library already waiting is not queued twice. */
  const queueScan = (libraryId: string, request: FastifyRequest | null) => {
    if (queued.has(libraryId)) return;
    queued.add(libraryId);
    setScanState(db, libraryId, "queued");
    catalogWork += 1;
    scanChain = scanChain.then(async () => {
      queued.delete(libraryId);
      if (!getLibrary(db, libraryId)) return;
      setScanState(db, libraryId, "scanning");
      try {
        // The disk is read without holding the engine; only the catalog write is one stretch.
        const summary = await scanLibrary(db, options.mediaRoot, libraryId, options.scan);
        // Sets the .nfo files name show at once; TMDB's follow with the metadata pass.
        rebuildSets(db, artDir);
        // So does the cast an .nfo names: of the titles whose .nfo changed, added or gone.
        rebuildCredits(db, artDir, summary.peopleChanged);
        setScanState(db, libraryId, "idle");
        const growing = summary.growing > 0 ? `, ${summary.growing} file(s) still being copied left for later` : "";
        const unnumbered = summary.unnumbered > 0 ? `, ${summary.unnumbered} file(s) without a season and episode in the name` : "";
        note(request, summary.unnumbered > 0 ? "warn" : "info", "scan.finished", {
          libraryId,
          detail: `${summary.titles} title(s), ${summary.episodes} episode(s); ${summary.added} added, ${summary.removed} removed${growing}${unnumbered}`
        });
        queueMetadata(libraryId, null, false);
        queueDetect({ library: libraryId }, false, null);
        void queueKeepReady();
        warmKeyframes();
      } catch (err) {
        const message = err instanceof ScanError ? err.message : `The scan failed: ${(err as Error).message}`;
        setScanState(db, libraryId, "error", message);
        note(request, "error", "scan.failed", { libraryId, detail: message });
        if (!(err instanceof ScanError)) app.log.error({ err, libraryId }, "Scan failed");
      }
    }).finally(() => { catalogWork -= 1; });
  };

  /** Queue a library's metadata pass; `force` asks TMDB again about every title. */
  const queueMetadata = (libraryId: string, request: FastifyRequest | null, force: boolean) => {
    const key = `${libraryId}:${force}`;
    if (metadataQueued.has(key)) return;
    metadataQueued.add(key);
    catalogWork += 1;
    metadataChain = metadataChain.then(async () => {
      metadataQueued.delete(key);
      try {
        const summary = await metadata.refreshLibrary(libraryId, force);
        if (!summary) return;
        const asked = readTmdbKey(db) ? `; TMDB: ${summary.matched} matched, ${summary.unmatched} not found, ${summary.failed} failed` : "; no TMDB key";
        note(request, summary.error ? "warn" : "info", "metadata.finished", {
          libraryId,
          detail: `${summary.titles} title(s), ${summary.posters} with a poster${summary.sets > 0 ? `, ${summary.sets} set(s)` : ""}${asked}${summary.error ? ` — ${summary.error}` : ""}`
        });
      } catch (err) {
        note(request, "error", "metadata.failed", { libraryId, detail: (err as Error).message });
        app.log.error({ err, libraryId }, "Metadata pass failed");
      }
    }).finally(() => { catalogWork -= 1; });
  };

  // ── Open to the gateway's probes ─────────────────────────────────────────

  app.get(`${API}/health`, async () => ({ ok: true, version: options.version }));

  // Who home says this is: the signed probe Apps → Installed uses to tell a
  // wrong secret from a working one.
  app.get(`${API}/me`, { preHandler: requireIdentity }, async (request) => {
    const identity = request.identity!;
    return {
      user: { id: identity.id, name: identity.name, role: identity.role, appRole: identity.appRole, lang: identity.lang, theme: identity.theme },
      libraries: identity.libraries === "all" ? "all" : [...identity.libraries],
      version: options.version,
      stage: options.stage
    };
  });

  // ── The catalog, for home's screens ──────────────────────────────────────

  app.get(`${API}/libraries`, { preHandler: requireIdentity }, async (request) => ({
    libraries: visibleLibraries(db, request.identity!)
  }));

  // Films and shows in one list, and the genres to narrow it by: home's one video page.
  app.get(`${API}/titles`, { preHandler: requireIdentity }, async (request) => listTitles(db, request.identity!, titleQuerySchema.parse(request.query ?? {})));

  app.get(`${API}/genres`, { preHandler: requireIdentity }, async (request) => ({
    genres: visibleGenres(db, request.identity!, z.object({ kind: kindSchema.optional() }).parse(request.query ?? {}).kind)
  }));

  app.get(`${API}/shows`, { preHandler: requireIdentity }, async (request) => listShows(db, request.identity!, listQuerySchema.parse(request.query ?? {})));

  app.get(`${API}/shows/:id`, { preHandler: requireIdentity }, async (request, reply) => {
    const show = getShow(db, request.identity!, itemIdSchema.parse((request.params as { id: string }).id));
    return show ?? reply.code(404).send({ error: "No such show" });
  });

  app.get(`${API}/movies`, { preHandler: requireIdentity }, async (request) => listMovies(db, request.identity!, listQuerySchema.parse(request.query ?? {})));

  app.get(`${API}/movies/:id`, { preHandler: requireIdentity }, async (request, reply) => {
    const movie = getMovie(db, request.identity!, itemIdSchema.parse((request.params as { id: string }).id));
    return movie ?? reply.code(404).send({ error: "No such movie" });
  });

  // Film sets (sets.ts): those the person sees two or more films of, and one set in order.
  app.get(`${API}/sets`, { preHandler: requireIdentity }, async (request) => listSets(db, request.identity!, setListQuerySchema.parse(request.query ?? {})));

  // Cast and crew (credits.ts): a person with what they are in, people found by
  // name, and their picture — each only through titles this person may see.
  const personIdSchema = z.string().regex(/^[tn][A-Za-z0-9_-]{1,40}$/);

  app.get(`${API}/people`, { preHandler: requireIdentity }, async (request) => {
    const query = z.object({ q: z.string().max(100).default(""), limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(request.query ?? {});
    return { people: searchPeople(db, request.identity!, query.q, query.limit) };
  });

  app.get(`${API}/people/:id`, { preHandler: requireIdentity }, async (request, reply) => {
    const person = getPerson(db, request.identity!, personIdSchema.parse((request.params as { id: string }).id));
    return person ?? reply.code(404).send({ error: "No such person" });
  });

  // Fetched from TMDB the first time someone looks, then kept: a library's
  // cast runs to thousands of people, most never looked at.
  app.get(`${API}/people/:id/photo`, { preHandler: requireIdentity }, async (request, reply) => {
    const person = personVisible(db, request.identity!, personIdSchema.parse((request.params as { id: string }).id));
    if (!person) return reply.code(404).send({ error: "Not found" });
    let file = photoFile(artDir, person);
    if (!file) {
      const key = readTmdbKey(db);
      if (!key || !person.profile_path || !imagePathSchema.safeParse(person.profile_path).success) return reply.code(404).send({ error: "Not found" });
      try {
        file = keepPhoto(db, artDir, person, await new Tmdb(key, options.fetch).image(person.profile_path, IMAGE_SIZES.thumb));
      } catch {
        return reply.code(404).send({ error: "Not found" });
      }
    }
    const type = ART_TYPES[path.extname(file).toLowerCase()] ?? "image/jpeg";
    return reply.header("Content-Type", type).header("Cache-Control", "private, max-age=86400").send(await fs.promises.readFile(file));
  });

  app.get(`${API}/sets/:id`, { preHandler: requireIdentity }, async (request, reply) => {
    const set = getSet(db, request.identity!, itemIdSchema.parse((request.params as { id: string }).id));
    return set ?? reply.code(404).send({ error: "No such set" });
  });

  // ── Watching ─────────────────────────────────────────────────────────────

  // What home's player needs to start: the item, how it plays (with the sound
  // track asked for, ?audio=<index>), its sound tracks, where to resume, and
  // what comes next.
  /** The picture's ceiling for this person (docs/video-quality-plan.md): what they
   *  asked for, held under the admin's cap for anyone on the internet; with no
   *  request, the file as it is at home and the cap away. `allowed` is what the
   *  player may offer them. */
  const qualityFor = (identity: Identity, asked: string | undefined): { current: Rung | null; allowed: (Rung | null)[] } => {
    const cap = identity.network === "internet" ? readConversion(db).remoteQuality : null;
    const allowed: (Rung | null)[] = cap === null ? [null, ...RUNGS] : RUNGS.filter((rung) => rung <= cap);
    const wanted = asked === undefined ? cap : rungOf(asked);
    return { current: cap !== null && (wanted === null || wanted > cap) ? cap : wanted, allowed };
  };

  app.get(`${API}/play/:id`, { preHandler: requireIdentity }, async (request, reply) => {
    const identity = request.identity!;
    const item = findItem(db, identity, itemIdSchema.parse((request.params as { id: string }).id));
    if (!item) return reply.code(404).send({ error: "Not found" });
    const file = await fileOfAsync(options.mediaRoot, item);
    const progress = progressFor(db, identity.historyId, [item.id]).get(item.id) ?? null;
    // After an episode the next one; after a film its next part, else the next of its set.
    const next = item.type === "episode" ? nextEpisode(db, item.show!.id, item.id) : nextPart(db, item) ?? nextInSet(db, identity, item.id);
    const { audio: audioIndex, subtitle, quality: qualityAsked } = playQuerySchema.parse(request.query ?? {});
    const quality = { ...qualityFor(identity, qualityAsked), network: identity.network };
    const stream = `${API}/stream/${item.id}`;
    let markers = readMarks(db, item);
    let probedVideoCodec: string | null = null;
    let audioTracks: (AudioStream & { selected: boolean })[] = [];
    let subtitleTracks: (SubtitleTrack & { url: string | null; burned: boolean })[] = [];
    let playback: { mode: DeliveryMode | "none"; reasons: DeliveryReason[]; url: string | null; duration: number | null; busy: HlsRefusal | null; quality: typeof quality } =
      { mode: "none", reasons: [], url: null, duration: null, busy: null, quality };
    if (file) {
      const probed = mediaProbe && (await toolsReady) ? await mediaProbe.info(item.id, file).catch(() => null) : null;
      probedVideoCodec = probed?.video?.codec ?? null;
      markers = await findMarkers(probed, file.absolute, markers, detectedMarkers(readDetected(db, item.id, file)));
      const tracks = probed ? await listSubtitles(probed, file.absolute) : [];
      const decided = await deliveryFor(item, file, audioIndex, burnIndexOf(tracks, subtitle), quality.current);
      subtitleTracks = tracks.map((track) => ({
        ...track,
        // Text goes to the browser as WebVTT; an image one is burned in when chosen.
        url: track.kind === "text" ? `${API}/subtitles/${item.id}/${track.id}.vtt` : null,
        burned: track.kind === "image" && decided?.delivery.burn?.index === Number(track.id.slice(1))
      }));
      if (decided) {
        const { mode, reasons, videoCopy } = decided.delivery;
        const hlsUrl = `${API}/hls/${item.id}/${trackSegment(decided.delivery)}/index.m3u8`;
        // Every place to watch converted video taken: the player says so instead.
        // A version already being watched, or kept whole, takes no place; its plan
        // is cheap to know unless its picture is copied (that needs the keyframes).
        const shareable = videoCopy ? item.id : buildPlan(item.id, file.absolute, decided.info, decided.delivery, null, `${file.size}:${file.modified.getTime()}`);
        const busy = mode !== "direct" && hls ? hls.refusal(`${identity.id}:${item.id}`, shareable) : null;
        playback = { mode, reasons, url: mode === "direct" ? stream : hlsUrl, duration: decided.info.duration || null, busy, quality };
        audioTracks = decided.info.audio.map((track) => ({ ...track, selected: track.index === decided.delivery.audio?.index }));
        // The playlist of a picture copied as it is needs its keyframes: start
        // reading them now, while the page opens.
        if (mode === "remux" && videoCopy) void mediaProbe!.keyframes(item.id, file).catch(() => undefined);
      } else if (browserPlayability(item.relative).direct !== "no") {
        // Nothing to look inside it with: offered as it is, and the browser decides.
        playback = { mode: "direct", reasons: [], url: stream, duration: null, busy: null, quality };
      }
    }
    return {
      id: item.id,
      type: item.type,
      title: item.title,
      show: item.show,
      season: item.season,
      episode: item.episode,
      runtimeMinutes: item.runtimeMinutes,
      available: Boolean(file),
      sizeBytes: file?.size ?? null,
      // `original` is for a player that decides for itself what its device decodes
      // (home's TV app): it tries the file as it is, and `url` is its way out.
      // Not for DivX/XviD and Microsoft's older MPEG-4: Android's decoders get them wrong,
      // often without an error to fall back on (XviD's "packed" B-frames come out late or
      // twice, and the picture judders), so such a player is sent to the converted copy.
      playback: { ...playback, original: file && !originalUnsafe(probedVideoCodec) ? stream : null },
      audioTracks,
      subtitleTracks,
      markers,
      progress,
      resumeAt: resumeAt(progress),
      next: next ? { id: next.id, season: "season" in next ? next.season : null, episode: "episode" in next ? next.episode : null, title: next.title } : null
    };
  });

  // The file itself, with byte ranges so the player can seek. Streamed straight
  // from disk; the reply is written by hand so nothing buffers a film.
  const serveStream = async (request: FastifyRequest, reply: FastifyReply) => {
    const item = findItem(db, request.identity!, itemIdSchema.parse((request.params as { id: string }).id));
    const file = item ? await fileOfAsync(options.mediaRoot, item) : null;
    if (!item || !file) return reply.code(404).send({ error: "Not found" });
    const range = parseRange(request.headers.range, file.size);
    if (range === "invalid") {
      return reply.code(416).header("Content-Range", `bytes */${file.size}`).send({ error: "Range not satisfiable" });
    }
    const { start, end } = range ?? { start: 0, end: file.size - 1 };
    const headers: Record<string, string | number> = {
      "Content-Type": browserPlayability(item.relative).mime,
      "Content-Length": file.size === 0 ? 0 : end - start + 1,
      "Accept-Ranges": "bytes",
      "Last-Modified": file.modified.toUTCString(),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow"
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${file.size}`;
    reply.hijack();
    reply.raw.writeHead(range ? 206 : 200, headers);
    if (request.method === "HEAD" || file.size === 0) {
      reply.raw.end();
      return;
    }
    const stream = fs.createReadStream(file.absolute, { start, end });
    stream.on("error", (err) => {
      request.log.warn({ err, item: item.id }, "Reading a video file failed mid-stream");
      reply.raw.destroy(err);
    });
    // A player that seeks closes the connection: stop reading the disk too.
    reply.raw.on("close", () => stream.destroy());
    stream.pipe(reply.raw);
  };
  app.get(`${API}/stream/:id`, { preHandler: requireIdentity }, serveStream);

  // HLS, for what the browser can't play as it is: the playlist of the whole
  // film, then each segment, made as it is asked for (hls.ts).
  const planFor = async (request: FastifyRequest): Promise<{ key: string; plan: HlsPlan; who: { user: string; title: string } } | null> => {
    const identity = request.identity!;
    const { id, track } = request.params as { id: string; track?: string };
    const item = findItem(db, identity, itemIdSchema.parse(id));
    const file = item ? await fileOfAsync(options.mediaRoot, item) : null;
    if (!item || !file || !hls || !mediaProbe) return null;
    // No track in the address (home 4.40.0): the default sound.
    const chosen = track === undefined ? null : /^t(\d{1,3}|-)(?:b(\d{1,3}))?(?:q(\d{3,4}))?$/.exec(track);
    if (track !== undefined && !chosen) return null;
    const audioIndex = chosen && chosen[1] !== "-" ? Number(chosen[1]) : null;
    // No rung in the address is the file as it is — which a viewer away from home
    // is held under the admin's cap for, so that address isn't theirs (404 below).
    if (chosen?.[3] && rungOf(chosen[3]) === null) return null;
    const rung = qualityFor(identity, chosen?.[3] ?? "original").current;
    const decided = await deliveryFor(item, file, audioIndex, chosen?.[2] ? Number(chosen[2]) : null, rung);
    if (!decided) return null;
    // An address for a track the file doesn't have is not this film.
    if (track !== undefined && trackSegment(decided.delivery) !== track) return null;
    const keyframes = decided.delivery.videoCopy ? await mediaProbe.keyframes(item.id, file) : null;
    const title = item.show ? `${item.show.title} S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}` : item.title;
    return {
      key: `${identity.id}:${item.id}`,
      plan: buildPlan(item.id, file.absolute, decided.info, decided.delivery, keyframes, `${file.size}:${file.modified.getTime()}`),
      who: { user: identity.name || identity.id, title }
    };
  };

  const serveHls = async (request: FastifyRequest, reply: FastifyReply) => {
    const { name } = request.params as { name: string };
    const segment = /^(\d{1,6})\.ts$/.exec(name);
    if (name !== "index.m3u8" && !segment) return reply.code(404).send({ error: "Not found" });
    const asked = Date.now();
    // The player cancels the segment it was loading when someone seeks or leaves:
    // stop waiting for it then, or the wait outlives the seek and fights it. Heard
    // from the start, since working out the plan can take a while (the keyframes).
    const hungUp = new AbortController();
    reply.raw.on("close", () => { if (!reply.raw.writableEnded) hungUp.abort(); });
    const found = await planFor(request);
    if (!found) return reply.code(404).send({ error: "Not found" });
    // Every place taken: refused before the player waits on a segment.
    const refused = hls!.refusal(found.key, found.plan);
    if (refused) return busyReply(reply, refused);
    if (!segment) {
      hls!.choose(found.key, found.plan);
      return reply.header("Content-Type", "application/vnd.apple.mpegurl").header("Cache-Control", "private, no-store").send(playlist(found.plan));
    }
    const n = Number(segment[1]);
    if (n >= found.plan.starts.length) return reply.code(404).send({ error: "Not found" });
    let made: SegmentData;
    try {
      made = await hls!.segment(found.key, found.plan, n, { who: found.who, signal: hungUp.signal, asked });
    } catch (err) {
      if (err instanceof HlsBusyError) return busyReply(reply, err.refusal);
      // The player has moved on (a seek, another quality): a 4xx, which neither
      // a player nor a proxy asks again, so it can't drag the run back.
      if (err instanceof HlsSupersededError) return reply.code(409).send({ error: err.message, code: "superseded" });
      if (!(err instanceof HlsError)) throw err;
      return reply.code(503).header("Retry-After", "2").send({ error: err.message });
    }
    const headers = { "Content-Type": "video/mp2t", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    if ("data" in made) return reply.headers(headers).send(made.data);
    const file = made.file;
    if (!fs.existsSync(file)) return reply.code(503).header("Retry-After", "1").send({ error: "The segment went missing" });
    reply.hijack();
    reply.raw.writeHead(200, { ...headers, "Content-Length": made.size || fs.statSync(file).size });
    const stream = fs.createReadStream(file);
    stream.on("error", (err) => reply.raw.destroy(err));
    reply.raw.on("close", () => stream.destroy());
    stream.pipe(reply.raw);
  };
  /** Every place to watch converted video is taken, or this person converts another film. */
  const busyReply = (reply: FastifyReply, refusal: HlsRefusal) =>
    reply.code(503).send({ error: new HlsBusyError(refusal).message, code: "busy", ...refusal });

  app.get(`${API}/hls/:id/:track/:name`, { preHandler: requireIdentity }, serveHls);
  app.get(`${API}/hls/:id/:name`, { preHandler: requireIdentity }, serveHls);

  // The player has gone: stop converting for it now rather than after a minute.
  app.delete(`${API}/hls/:id`, { preHandler: requireIdentity }, async (request, reply) => {
    const id = itemIdSchema.parse((request.params as { id: string }).id);
    hls?.leave(`${request.identity!.id}:${id}`);
    return reply.code(204).send();
  });

  // A poster, backdrop or episode still (metadata.ts): from beside the video, or
  // TMDB's kept in the art folder. Only for someone who may see the title.
  const serveArt = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, kind } = request.params as { id: string; kind: string };
    // A film's parts share its pictures; a part's still (an episode's, from TMDB) is under its own key.
    const askedId = itemIdSchema.parse(id);
    const partOf = partOfKey(askedId);
    const itemId = partOf ? partOf.movieId : movieIdOf(db, askedId);
    const artKind = artKindSchema.safeParse(kind);
    const owner = db.prepare(`
      SELECT library_id FROM shows WHERE id = @id
      UNION ALL SELECT library_id FROM movies WHERE id = @id
      UNION ALL SELECT s.library_id FROM episodes e JOIN shows s ON s.id = e.show_id WHERE e.id = @id
    `).get({ id: itemId }) as { library_id: string } | undefined;
    const library = owner ? getLibrary(db, owner.library_id) : null;
    // Not a title: a set's own picture, for someone who sees one of its films.
    const set = owner ? null : setArtRow(db, request.identity!, itemId);
    if (!artKind.success || (!set && (!library || library.state !== "active" || !canSee(request.identity!, library.id)))) return reply.code(404).send({ error: "Not found" });
    const file = await artFileAsync(set ?? metaFor(db, [partOf ? askedId : itemId]).get(partOf ? askedId : itemId), artKind.data as ArtKind, options.mediaRoot, artDir);
    if (!file) return reply.code(404).send({ error: "Not found" });
    const type = ART_TYPES[path.extname(file).toLowerCase()];
    if (!type) return reply.code(404).send({ error: "Not found" });
    // Gone from beside the film since it was found: as if it had never been there.
    const bytes = await fs.promises.readFile(file).catch(() => null);
    if (!bytes) return reply.code(404).send({ error: "Not found" });
    // The address carries a version, so it can be kept a while.
    return reply.header("Content-Type", type).header("Cache-Control", "private, max-age=86400").send(bytes);
  };
  app.get(`${API}/art/:id/:kind`, { preHandler: requireIdentity }, serveArt);

  // A text subtitle as WebVTT, from inside the file or beside it (subtitles.ts).
  const serveSubtitle = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id, name } = request.params as { id: string; name: string };
    const parsedId = subtitleIdSchema.safeParse(/^(.+)\.vtt$/.exec(name)?.[1]);
    const item = findItem(db, request.identity!, itemIdSchema.parse(id));
    const file = item ? await fileOfAsync(options.mediaRoot, item) : null;
    if (!parsedId.success || !item || !file || !subtitleCache || !mediaProbe || !(await toolsReady)) return reply.code(404).send({ error: "Not found" });
    let vtt: string | null;
    try {
      vtt = await subtitleCache.webVtt(await mediaProbe.info(item.id, file), file, parsedId.data);
    } catch (err) {
      request.log.warn({ err, item: item.id, track: parsedId.data }, "A subtitle could not be converted");
      return reply.code(422).send({ error: "This subtitle could not be read" });
    }
    if (vtt === null) return reply.code(404).send({ error: "Not found" });
    return reply
      .header("Content-Type", "text/vtt; charset=utf-8")
      .header("Cache-Control", "private, max-age=600")
      .header("X-Content-Type-Options", "nosniff")
      .send(vtt);
  };
  app.get(`${API}/subtitles/:id/:name`, { preHandler: requireIdentity }, serveSubtitle);

  /** Where a title's credits start, when a mark or the file says; not asked when
   *  the player already knows it is watched. */
  const creditsAt = async (item: PlayableItem, watched: boolean | undefined): Promise<number | null> => {
    if (watched !== undefined) return null;
    const marks = readMarks(db, item);
    if (marks.credits) return marks.credits.start;
    const file = await fileOfAsync(options.mediaRoot, item);
    if (!file || !mediaProbe || !(await toolsReady)) return null;
    const info = await mediaProbe.info(item.id, file).catch(() => null);
    return (await findMarkers(info, file.absolute, marks, detectedMarkers(readDetected(db, item.id, file)))).credits?.start ?? null;
  };

  /** A title's markers as /play gives them. */
  const markersOf = async (item: PlayableItem) => {
    const marks = readMarks(db, item);
    const file = await fileOfAsync(options.mediaRoot, item);
    if (!file || !mediaProbe || !(await toolsReady)) return { markers: marks, duration: null };
    const info = await mediaProbe.info(item.id, file).catch(() => null);
    return { markers: await findMarkers(info, file.absolute, marks, detectedMarkers(readDetected(db, item.id, file))), duration: info?.duration ?? null };
  };

  // Look for this episode's season's intros and credits again (or the film's),
  // whatever was found before: the admin's "Find again" in home's player.
  app.post(`${API}/admin/markers/:id/detect`, { preHandler: requireAdmin }, async (request, reply) => {
    const item = findItem(db, request.identity!, itemIdSchema.parse((request.params as { id: string }).id));
    if (!item) return reply.code(404).send({ error: "Not found" });
    if (!detector) return reply.code(409).send({ error: "ffmpeg is missing: nothing can be found by itself" });
    if (!readDetection(db).enabled) return reply.code(409).send({ error: "Finding intros, recaps and credits is turned off on Settings → Video", code: "video.detection_off" });
    queueDetect({ item: item.id }, true, request, true);
    return reply.code(202).send({ queued: true });
  });

  // An admin marks where the intro or the credits are, in home's player, for this
  // episode or film or for its whole season; a null start puts back what was there
  // before (the season's, the .edl's, the chapters'). Answers the markers anew.
  app.put(`${API}/admin/markers/:id`, { preHandler: requireAdmin }, async (request, reply) => {
    const item = findItem(db, request.identity!, itemIdSchema.parse((request.params as { id: string }).id));
    if (!item) return reply.code(404).send({ error: "Not found" });
    const body = markBodySchema.parse(request.body);
    const label = item.show ? `${item.show.title} ${item.title}` : item.title;
    if (body.start === null) {
      clearMark(db, item, body.kind, body.scope);
      note(request, "info", "markers.cleared", { libraryId: item.libraryId, detail: `${label}: ${body.kind} (${body.scope})` });
    } else {
      setMark(db, item, { kind: body.kind, scope: body.scope, start: body.start, end: body.end }, (await markersOf(item)).duration);
      note(request, "info", "markers.set", { libraryId: item.libraryId, detail: `${label}: ${body.kind} (${body.scope})` });
    }
    return { markers: (await markersOf(item)).markers };
  });

  // How far the person got; the player sends it every few seconds and on pause.
  app.put(`${API}/progress/:id`, { preHandler: requireIdentity }, async (request, reply) => {
    const identity = request.identity!;
    const item = findItem(db, identity, itemIdSchema.parse((request.params as { id: string }).id));
    if (!item) return reply.code(404).send({ error: "Not found" });
    const body = progressBodySchema.parse(request.body);
    return { progress: saveProgress(db, identity.historyId, item, body, await creditsAt(item, body.watched)) };
  });

  // ── Copies to download (copies.ts) ──────────────────────────────────────
  //
  // A smaller MP4 of a film or episode, made once on a queue and kept: asked
  // for with PUT, looked in on with GET, fetched from /file once ready. "none":
  // never asked for. "unneeded": the file already fits and plays as it is —
  // download /stream instead.
  const copyQuerySchema = z.object({
    quality: z.coerce.number().refine((value) => rungOf(value) !== null),
    audio: z.coerce.number().int().min(0).max(999).optional()
  });

  /** What a copy request is about, for someone who may see the title and have this quality. */
  const copyTarget = async (request: FastifyRequest, raw: unknown) => {
    const identity = request.identity!;
    const asked = copyQuerySchema.safeParse(raw ?? {});
    const item = findItem(db, identity, itemIdSchema.parse((request.params as { id: string }).id));
    const file = item ? await fileOfAsync(options.mediaRoot, item) : null;
    if (!asked.success || !item || !file || !copies) return null;
    const rung = rungOf(asked.data.quality)!;
    // A viewer away from home is held under the admin's cap for copies too.
    if (qualityFor(identity, String(rung)).current !== rung) return null;
    const decided = await deliveryFor(item, file, asked.data.audio ?? null, null, rung);
    if (!decided) return null;
    const key: CopyKey = { itemId: item.id, rung, audio: decided.delivery.audio?.index ?? -1 };
    const title = item.show ? `${item.show.title} S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}` : item.title;
    return { item, file, key, title, ...decided };
  };

  const copyAnswer = (target: NonNullable<Awaited<ReturnType<typeof copyTarget>>>) => {
    const { key, file, info, delivery, item } = target;
    if (delivery.mode === "direct") return { state: "unneeded" as const, url: `${API}/stream/${item.id}` };
    const status = copies!.status(key, file);
    const estimateSeconds = estimateCopySeconds(info, delivery, Boolean(hardware?.choose(info, delivery)));
    // No disk for copies (copiesInsideContainer): home's downloader converts as it
    // downloads instead, as it did before copies were made.
    if (!status || (copiesInsideContainer && status.state !== "ready")) {
      return { state: "none" as const, estimateSeconds, ...(copiesInsideContainer ? { unavailable: "no-disk" as const } : {}) };
    }
    return { ...status, estimateSeconds, url: status.state === "ready" ? `${API}/copies/${item.id}/file?quality=${key.rung}&audio=${key.audio}` : null };
  };

  app.get(`${API}/copies/:id`, { preHandler: requireIdentity }, async (request, reply) => {
    const target = await copyTarget(request, request.query);
    return target ? copyAnswer(target) : reply.code(404).send({ error: "Not found" });
  });

  app.put(`${API}/copies/:id`, { preHandler: requireIdentity }, async (request, reply) => {
    const target = await copyTarget(request, request.body);
    if (!target) return reply.code(404).send({ error: "Not found" });
    if (target.delivery.mode !== "direct" && !copiesInsideContainer) {
      const identity = request.identity!;
      const existing = copies!.status(target.key, target.file);
      // A member has only so many copies waiting at once; an admin any number.
      if ((!existing || existing.state === "failed") && identity.role !== "admin" && copies!.waitingFor(identity.id) >= copies!.perPerson) {
        return { ...copyAnswer(target), state: "failed" as const, code: "limit", error: `You already have ${copies!.perPerson} downloads being prepared; this one can be asked for once one of them is ready` };
      }
      copies!.request({ ...target.key, title: target.title, file: target.file, info: target.info, delivery: target.delivery, by: identity.id });
    }
    return copyAnswer(target);
  });

  // The finished copy, with byte ranges: a download picks up where it stopped.
  app.get(`${API}/copies/:id/file`, { preHandler: requireIdentity }, async (request, reply) => {
    const target = await copyTarget(request, request.query);
    const made = target ? copies!.ready(target.key, target.file) : null;
    if (!made) return reply.code(404).send({ error: "Not found" });
    const range = parseRange(request.headers.range, made.size);
    if (range === "invalid") return reply.code(416).header("Content-Range", `bytes */${made.size}`).send({ error: "Range not satisfiable" });
    const { start, end } = range ?? { start: 0, end: made.size - 1 };
    const headers: Record<string, string | number> = {
      "Content-Type": "video/mp4",
      "Content-Length": made.size === 0 ? 0 : end - start + 1,
      "Accept-Ranges": "bytes",
      "Last-Modified": made.modified.toUTCString(),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow"
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${made.size}`;
    reply.hijack();
    reply.raw.writeHead(range ? 206 : 200, headers);
    if (request.method === "HEAD" || made.size === 0) {
      reply.raw.end();
      return;
    }
    const stream = fs.createReadStream(made.path, { start, end });
    stream.on("error", (err) => reply.raw.destroy(err));
    // Away from home, held to the admin's speed (all such copies together).
    const slow = request.identity!.network === "internet" && (copies?.remoteBytesPerSecond ?? 0) > 0 ? throttled(remoteBucket) : null;
    reply.raw.on("close", () => { stream.destroy(); slow?.destroy(); });
    if (slow) stream.pipe(slow).pipe(reply.raw);
    else stream.pipe(reply.raw);
  });

  // The queue of copies and fills (C4): when it works, what runs and waits, and
  // the admin's hand on it — first in line, run now, take off.
  app.get(`${API}/admin/jobs`, { preHandler: requireAdmin }, async (_request, reply) =>
    (copies ? copies.jobs() : reply.code(404).send({ error: "ffmpeg is missing: nothing is made" })));

  app.put(`${API}/admin/jobs`, { preHandler: requireAdmin }, async (request, reply) => {
    if (!copies) return reply.code(404).send({ error: "ffmpeg is missing: nothing is made" });
    const settings = jobSettingsSchema.parse({ ...readJobs(db), ...(request.body as object) });
    saveJobs(db, settings);
    copies.configureJobs(settings);
    const when = { now: "right away", idle: "when the server is idle", night: `between ${settings.nightStart} and ${settings.nightEnd}` }[settings.when];
    note(request, "info", "jobs.changed", { detail: `Prepared ${when}, ${settings.atOnce} at once, ${settings.perPerson} waiting per member${settings.remoteMbps > 0 ? `, ${settings.remoteMbps} Mbit/s away from home` : ""}` });
    return copies.jobs();
  });

  const jobIdSchema = z.object({ id: z.string().min(1).max(300) });
  app.post(`${API}/admin/jobs/top`, { preHandler: requireAdmin }, async (request, reply) => {
    if (!copies?.moveToTop(jobIdSchema.parse(request.body).id)) return reply.code(404).send({ error: "Not waiting" });
    return copies.jobs();
  });
  app.post(`${API}/admin/jobs/run`, { preHandler: requireAdmin }, async (request, reply) => {
    if (!copies?.runNow(jobIdSchema.parse(request.body).id)) return reply.code(404).send({ error: "Not waiting" });
    return copies.jobs();
  });
  app.delete(`${API}/admin/jobs`, { preHandler: requireAdmin }, async (request, reply) => {
    if (!copies?.cancel(jobIdSchema.parse(request.query).id)) return reply.code(404).send({ error: "Not found" });
    return copies.jobs();
  });

  // Keep ready (keep-ready.ts): the titles an admin keeps converted ahead of time.
  // `available` is false where nothing can be kept (no disk of its own, or memory only).
  const keepAnswer = async () => ({
    available: canKeep(),
    titles: await Promise.all(keepReady.list().map((row) => keepStatus(row)))
  });
  app.get(`${API}/admin/keep-ready`, { preHandler: requireAdmin }, async () => keepAnswer());

  app.put(`${API}/admin/keep-ready`, { preHandler: requireAdmin }, async (request, reply) => {
    if (!canKeep()) return reply.code(409).send({ error: "Nothing can be kept ready: the video container's Transcode folder is not a disk of its own, or memory only is chosen" });
    const input = keepReadySchema.parse(request.body);
    const before = keepReady.list().find((row) => row.targetId === input.id && row.kind === input.kind && (input.kind !== "season" || row.season === input.season));
    const row = keepReady.set(input);
    if (!row) return reply.code(404).send({ error: "Not found" });
    // What everything kept ready takes and will take, against the room for kept video.
    const all = await keepAnswer();
    const needed = all.titles.reduce((sum, title) => sum + title.sizeBytes + title.estimateBytes, 0);
    const limit = readCopies(db).limitGb * 1024 ** 3;
    if (needed > limit * 0.8) {
      if (before) keepReady.set({ kind: before.kind, id: before.targetId, season: before.season, rungs: before.rungs, newEpisodes: before.newEpisodes });
      else keepReady.remove(row.id);
      return reply.code(409).send({ error: "Not enough room for kept video", code: "room", neededBytes: needed, limitBytes: limit });
    }
    note(request, "info", "keep.changed", { detail: `${row.title} kept ready at ${row.rungs.map((rung) => `${rung}p`).join(", ")}` });
    void queueKeepReady();
    return keepAnswer();
  });

  app.delete(`${API}/admin/keep-ready`, { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.query);
    const row = keepReady.remove(id);
    if (!row) return reply.code(404).send({ error: "Not found" });
    const items = new Set(keepReady.itemsOf(row).map((item) => item.itemId));
    copies?.cancelFills((job) => job.kind === "keep" && items.has(job.itemId));
    note(request, "info", "keep.removed", { detail: `${row.title} no longer kept ready` });
    // Another marked title may want some of the same versions.
    void queueKeepReady();
    return keepAnswer();
  });

  // The copies kept, what they take and how much they may: home's Settings → Video.
  // Engine 0.35+: insideContainer — the copies' folder is no disk of its own, so
  // no new ones are made; those there are handed out until deleted.
  // Engine 0.35+: the films kept whole once converted all through, under the same limit.
  const copiesList = (made: Copies) => {
    const kept = hls?.keptFilms() ?? [];
    return { ...made.list(), insideContainer: copiesInsideContainer, kept, keptBytes: kept.reduce((sum, film) => sum + film.sizeBytes, 0) };
  };
  app.get(`${API}/admin/copies`, { preHandler: requireAdmin }, async (_request, reply) =>
    (copies ? copiesList(copies) : reply.code(404).send({ error: "ffmpeg is missing: no copies can be made" })));

  app.put(`${API}/admin/copies`, { preHandler: requireAdmin }, async (request, reply) => {
    if (!copies) return reply.code(404).send({ error: "ffmpeg is missing: no copies can be made" });
    const settings = copySettingsSchema.parse({ ...readCopies(db), ...(request.body as object) });
    saveCopies(db, settings);
    copies.configure(settings);
    trimCache();
    note(request, "info", "copies.changed", { detail: `Copies to download may take ${settings.limitGb} GB` });
    return copiesList(copies);
  });

  app.delete(`${API}/admin/copies`, { preHandler: requireAdmin }, async (request, reply) => {
    if (!copies) return reply.code(404).send({ error: "ffmpeg is missing: no copies can be made" });
    let removed = copies.clear();
    for (const film of hls?.keptFilms() ?? []) if (!film.inUse && hls?.removeKept(film.variant)) removed += 1;
    note(request, "info", "copies.cleared", { detail: `${removed} copies to download removed` });
    return copiesList(copies);
  });

  // Marked by hand, several at once (home's issue #101): a whole show, one season
  // of it, or a film with every part — watched, or never seen. For the person
  // asking only; the title must be one they may see.
  app.put(`${API}/watched/:kind/:id`, { preHandler: requireIdentity }, async (request, reply) => {
    const identity = request.identity!;
    const params = request.params as { kind: string; id: string };
    const kind = kindSchema.safeParse(params.kind);
    const id = itemIdSchema.parse(params.id);
    const body = watchedBodySchema.parse(request.body);
    const title = !kind.success ? null : kind.data === "shows" ? getShow(db, identity, id) : getMovie(db, identity, id);
    if (!kind.success || !title) return reply.code(404).send({ error: "Not found" });
    const target = kind.data === "shows" ? { kind: "shows" as const, id: title.id, season: body.season } : { kind: "movies" as const, id: title.id };
    return { marked: markAllWatched(db, identity.historyId, target, body.watched) };
  });

  app.get(`${API}/continue`, { preHandler: requireIdentity }, async (request) => {
    const { limit } = continueQuerySchema.parse(request.query ?? {});
    return { items: continueWatching(db, request.identity!, limit) };
  });

  // "Remove from Continue watching": the show or film this item belongs to leaves
  // the row for the person asking, with their place in it kept.
  app.delete(`${API}/continue/:id`, { preHandler: requireIdentity }, async (request, reply) => {
    const identity = request.identity!;
    const item = findItem(db, identity, itemIdSchema.parse((request.params as { id: string }).id));
    if (!item) return reply.code(404).send({ error: "Not found" });
    return { removed: dismissContinue(db, identity.historyId, item) };
  });

  // ── Libraries, as home manages them (home's server calls these) ─────────

  app.get(`${API}/admin/libraries`, { preHandler: requireAdmin }, async () => ({ libraries: listLibraries(db) }));

  // The disks this engine's files sit on, for home's Dashboard (disks.ts): each
  // library folder, the catalog, the posters and the conversion folder.
  app.get(`${API}/admin/disks`, { preHandler: requireAdmin }, async () => {
    const holds: DiskHolding[] = listLibraries(db)
      .filter((library) => library.state === "active")
      .flatMap((library) => {
        const dir = resolveInside(options.mediaRoot, library.folder);
        return dir ? [{ kind: "library" as const, name: library.name, path: dir }] : [];
      });
    if (options.dbPath !== ":memory:") holds.push({ kind: "database", path: path.dirname(path.resolve(options.dbPath)) });
    holds.push({ kind: "artwork", path: artDir });
    if (hls) holds.push({ kind: "transcode", path: hls.folder });
    return { disks: groupByDisk(holds) };
  });

  app.put(`${API}/admin/libraries/:id`, { preHandler: requireAdmin }, async (request, reply) => {
    const id = libraryIdSchema.parse((request.params as { id: string }).id);
    const body = libraryBodySchema.parse(request.body);
    const { created, rescan, relanguage } = putLibrary(db, options.mediaRoot, id, body);
    note(request, "info", created ? "library.added" : "library.changed", { libraryId: id, detail: `${body.name} (${body.kind}) at "${body.folder}", ${body.language}` });
    if (rescan) queueScan(id, request);
    // Every title's words again, in the new language.
    if (relanguage) queueMetadata(id, request, true);
    return reply.code(created ? 201 : 200).send({ library: getLibrary(db, id) });
  });

  app.delete(`${API}/admin/libraries/:id`, { preHandler: requireAdmin }, async (request, reply) => {
    const id = libraryIdSchema.parse((request.params as { id: string }).id);
    const library = getLibrary(db, id);
    if (!purgeLibrary(db, id)) return reply.code(404).send({ error: "No such library" });
    note(request, "info", "library.deleted", { libraryId: id, detail: `${library?.name ?? id} and everything catalogued in it` });
    return { deleted: true };
  });

  // Home's whole list now and then: a library missing from it is detached, never dropped.
  app.post(`${API}/admin/libraries/sync`, { preHandler: requireAdmin }, async (request) => {
    const { ids } = syncBodySchema.parse(request.body);
    const result = syncLibraries(db, ids);
    if (result.detached.length > 0 || result.reattached.length > 0) {
      note(request, "info", "library.synced", { detail: `detached ${result.detached.join(", ") || "none"}; reattached ${result.reattached.join(", ") || "none"}` });
    }
    return result;
  });

  // A household viewing profile was deleted in home: forget its watch history.
  app.delete(`${API}/admin/history/profiles/:id`, { preHandler: requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return reply.code(400).send({ error: "Invalid profile" });
    const removed = forgetHistory(db, historyIdFor("", id));
    if (removed > 0) note(request, "info", "history.forgotten", { detail: `${removed} progress row(s) of a deleted viewing profile` });
    return { removed };
  });

  app.post(`${API}/admin/libraries/:id/scan`, { preHandler: requireAdmin }, async (request, reply) => {
    const id = libraryIdSchema.parse((request.params as { id: string }).id);
    if (!getLibrary(db, id)) return reply.code(404).send({ error: "No such library" });
    queueScan(id, request);
    return reply.code(202).send({ library: getLibrary(db, id) });
  });

  // The folder picker in home's Add library: this engine's folders, under MEDIA_ROOT.
  app.get(`${API}/admin/folders`, { preHandler: requireAdmin }, async (request, reply) => {
    const { path: relative } = foldersQuerySchema.parse(request.query ?? {});
    const listed = await listFolders(options.mediaRoot, relative);
    return listed ?? reply.code(404).send({ error: "No such folder" });
  });

  // ── The admin's window, read by home through the gateway ─────────────────

  // Watching converted video: the admin's limits, and who is using what now.
  const conversion = () => {
    const settings = readConversion(db);
    return {
      available: Boolean(hls),
      // The old words beside the new ones, for a home from before engine 0.35.
      settings: { ...settings, ...legacyOf(settings) },
      // Engine 0.35+: whether the conversion folder is a disk of its own, and the
      // storage in force (memory only without one, whatever was chosen).
      disk: hls ? { mapped: hls.mapped, folder: hls.folder, ...freeSpace(hls.folder) } : null,
      storage: hls?.storage ?? null,
      usage: hls?.usage() ?? { viewers: [], memoryBytes: 0, diskBytes: 0 },
      // What the GPU does here (engine 0.20+); null without ffmpeg.
      hardware: hardware?.state() ?? null
    };
  };

  app.get(`${API}/admin/conversion`, { preHandler: requireAdmin }, async () => conversion());

  app.put(`${API}/admin/conversion`, { preHandler: requireAdmin }, async (request) => {
    // A home from before 0.20 sends no `hardware`: what was chosen stays. One
    // from before 0.35 speaks of memory per viewer (mergeConversion).
    const settings = mergeConversion(readConversion(db), request.body);
    saveConversion(db, settings);
    hls?.configure(settings);
    hardware?.configure(settings.hardware);
    const memory = { memory: `${settings.memoryMb} MB of memory, then waiting`, "memory-disk": `${settings.memoryMb} MB of memory, then the disk`, disk: "the disk only" }[settings.storage];
    const where = { auto: "on the GPU where it can", cpu: "on the CPU only", gpu: "on the GPU only" }[settings.hardware];
    const away = settings.remoteQuality === null ? "the original" : `${settings.remoteQuality}p`;
    note(request, "info", "conversion.changed", { detail: `Up to ${settings.maxViewers} viewer(s) converting ${where}, ${memory}; away from home up to ${away}` });
    return conversion();
  });

  // Check again: what the GPU does, found out afresh (and its failures forgotten).
  app.post(`${API}/admin/conversion/check`, { preHandler: requireAdmin }, async () => {
    await hardware?.check();
    return conversion();
  });


  /** A show or film by id, with what its library says. */
  const titleKindOf = (id: string): { kind: "show" | "movie"; title: string; libraryId: string; language: string } | null => {
    const row = db.prepare(`
      SELECT 'show' AS kind, s.title, s.library_id, l.language FROM shows s JOIN libraries l ON l.id = s.library_id WHERE s.id = @id
      UNION ALL SELECT 'movie', m.title, m.library_id, l.language FROM movies m JOIN libraries l ON l.id = m.library_id WHERE m.id = @id
    `).get({ id }) as { kind: "show" | "movie"; title: string; library_id: string; language: string } | undefined;
    return row ? { kind: row.kind, title: row.title, libraryId: row.library_id, language: row.language } : null;
  };

  // Finding intros, recaps and credits by itself: on or off (settings.ts).
  // `available` is false where the engine can't (no ffmpeg).
  // `working` says what it is on now ("Counterpart · season 2"), null when idle.
  const detectionState = () => ({ ...readDetection(db), available: Boolean(detector), working: detector?.working ?? null });

  app.get(`${API}/admin/detection`, { preHandler: requireAdmin }, async () => detectionState());

  app.put(`${API}/admin/detection`, { preHandler: requireAdmin }, async (request) => {
    const settings = detectionSchema.parse(request.body);
    const was = readDetection(db).enabled;
    saveDetection(db, settings);
    if (was && !settings.enabled) {
      // What runs stops; what it finished so far is kept.
      detectPause.abort();
      detectPause = new AbortController();
    } else if (!was && settings.enabled) {
      detectEverything(request);
    }
    if (was !== settings.enabled) note(request, "info", "detect.changed", { detail: settings.enabled ? "Finding intros, recaps and credits turned on" : "Finding intros, recaps and credits turned off" });
    return detectionState();
  });

  // TMDB (metadata.ts): the admin's key — never sent back, only whether there
  // is one and its last characters — and what the engine made of it.
  const metadataState = () => {
    const key = readTmdbKey(db);
    return { hasKey: Boolean(key), keyHint: keyHint(key) };
  };

  app.get(`${API}/admin/metadata`, { preHandler: requireAdmin }, async () => metadataState());

  app.put(`${API}/admin/metadata`, { preHandler: requireAdmin }, async (request, reply) => {
    const { tmdbKey } = metadataBodySchema.parse(request.body);
    if (tmdbKey) {
      try {
        await new Tmdb(tmdbKey, options.fetch).check();
      } catch (err) {
        const refused = err instanceof TmdbError && err.status === 401;
        return reply.code(refused ? 400 : 502).send({ error: refused ? "TMDB refused this key" : (err as Error).message, code: refused ? "video.tmdb_refused" : "video.tmdb_unreachable" });
      }
    }
    saveTmdbKey(db, tmdbKey);
    note(request, "info", "metadata.key", { detail: tmdbKey ? `TMDB key set (${keyHint(tmdbKey)})` : "TMDB key removed" });
    // Titles never asked of TMDB are now due.
    if (tmdbKey) for (const library of listLibraries(db)) if (library.state === "active") queueMetadata(library.id, request, false);
    return metadataState();
  });

  // Fix match: TMDB's candidates for a title, with their posters through here.
  // `kind` is the title's own; TMDB's other kind is searched after it, since a
  // film kept here may be a TV show there, and each result says which it is.
  app.get(`${API}/admin/metadata/search`, { preHandler: requireAdmin }, async (request, reply) => {
    const query = matchSearchSchema.parse(request.query ?? {});
    const key = readTmdbKey(db);
    if (!key) return reply.code(409).send({ error: "No TMDB key", code: "video.tmdb_no_key" });
    const poster = (posterPath: string | null) => (posterPath && imagePathSchema.safeParse(posterPath).success ? `${API}/admin/metadata/image${posterPath}` : null);
    try {
      const tmdb = new Tmdb(key, options.fetch);
      // An IMDb id or link ("tt4238994", imdb.com/title/tt4238994/): what TMDB has under it,
      // for a title its name doesn't find. A TMDB link (themoviedb.org/tv/76829): that title.
      const imdb = /(?:^|[^a-z0-9])(tt\d{5,10})(?![0-9])/i.exec(query.q)?.[1]?.toLowerCase();
      if (imdb) {
        return { results: (await tmdb.findImdb(imdb, query.language)).map(({ posterPath, ...result }) => ({ ...result, poster: poster(posterPath) })) };
      }
      const link = /themoviedb\.org\/(movie|tv)\/(\d{1,10})/i.exec(query.q);
      if (link) {
        const kind = link[1].toLowerCase() as "movie" | "tv";
        try {
          const found = await tmdb.details(kind, link[2], query.language);
          return { results: [{ tmdbId: found.tmdbId, kind, title: found.title ?? "", originalTitle: found.originalTitle, year: found.year, overview: found.plot, poster: poster(found.posterPath) }] };
        } catch (err) {
          if (err instanceof TmdbError && err.status === 404) return { results: [] };
          throw err;
        }
      }
      const results = [];
      for (const kind of [query.kind, query.kind === "movie" ? "tv" : "movie"] as const) {
        for (const { posterPath, ...result } of await tmdb.search(kind, query.q, query.year ?? null, query.language)) {
          results.push({ ...result, kind, poster: posterPath && imagePathSchema.safeParse(posterPath).success ? `${API}/admin/metadata/image${posterPath}` : null });
        }
      }
      return { results };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get(`${API}/admin/metadata/image/:file`, { preHandler: requireAdmin }, async (request, reply) => {
    const imagePath = `/${(request.params as { file: string }).file}`;
    // ?wide: a backdrop to choose from, at a still's size; else a poster thumb.
    const wide = (request.query as { wide?: string } | undefined)?.wide !== undefined;
    const key = readTmdbKey(db);
    if (!key || !imagePathSchema.safeParse(imagePath).success) return reply.code(404).send({ error: "Not found" });
    try {
      const bytes = await new Tmdb(key, options.fetch).image(imagePath, wide ? IMAGE_SIZES.still : IMAGE_SIZES.thumb);
      return reply.header("Content-Type", ART_TYPES[path.extname(imagePath).toLowerCase()]).header("Cache-Control", "private, max-age=86400").send(bytes);
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
  });

  // A title's backdrops on TMDB, for the admin to choose from (Fix match): those
  // with no words first; `current` is the one shown now.
  app.get(`${API}/admin/metadata/items/:id/backdrops`, { preHandler: requireAdmin }, async (request, reply) => {
    const id = itemIdSchema.parse((request.params as { id: string }).id);
    const found = titleKindOf(id);
    if (!found) return reply.code(404).send({ error: "Not found" });
    const key = readTmdbKey(db);
    if (!key) return reply.code(409).send({ error: "No TMDB key", code: "video.tmdb_no_key" });
    const match = tmdbMatchOf(db, id);
    if (!match) return { backdrops: [], current: null, chosen: false };
    try {
      const backdrops = await new Tmdb(key, options.fetch).backdrops(match.tmdbKind, match.tmdbId, found.language);
      return {
        backdrops: backdrops.map(({ path: imagePath, ...rest }) => ({ ...rest, path: imagePath, preview: `${API}/admin/metadata/image${imagePath}?wide` })),
        current: match.current,
        chosen: match.choice !== null
      };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // The admin's choice of backdrop, or back to the best by votes (null): fetched
  // at once, and the title answered as the family now sees it.
  app.put(`${API}/admin/metadata/items/:id/backdrop`, { preHandler: requireAdmin }, async (request, reply) => {
    const id = itemIdSchema.parse((request.params as { id: string }).id);
    const { path: imagePath } = backdropBodySchema.parse(request.body);
    const found = titleKindOf(id);
    if (!found) return reply.code(404).send({ error: "Not found" });
    setBackdropChoice(db, id, found.kind, imagePath);
    await metadata.refreshOne(id);
    note(request, "info", "metadata.backdrop", { libraryId: found.libraryId, detail: imagePath ? `${found.title}: backdrop chosen by hand` : `${found.title}: backdrop picked automatically again` });
    return found.kind === "show" ? { show: getShow(db, request.identity!, id) } : { movie: getMovie(db, request.identity!, id) };
  });

  // Lookup (the Edit dialog): one TMDB candidate's words, to compare with the
  // title's and take field by field; its genres as this list maps them.
  app.get(`${API}/admin/metadata/details`, { preHandler: requireAdmin }, async (request, reply) => {
    const query = z.object({
      kind: z.enum(["movie", "tv"]),
      id: z.string().regex(/^\d{1,12}$/),
      language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default("en")
    }).parse(request.query ?? {});
    const key = readTmdbKey(db);
    if (!key) return reply.code(409).send({ error: "No TMDB key", code: "video.tmdb_no_key" });
    try {
      const details = await new Tmdb(key, options.fetch).details(query.kind, query.id, query.language);
      const poster = details.posterPath && imagePathSchema.safeParse(details.posterPath).success ? `${API}/admin/metadata/image${details.posterPath}` : null;
      return {
        tmdbId: details.tmdbId,
        kind: query.kind,
        title: details.title,
        originalTitle: details.originalTitle,
        year: details.year,
        plot: details.plot,
        genres: resolveGenres(db, details.genres),
        poster
      };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Pictures (the Edit dialog): TMDB's posters for a title, where its poster
  // comes from now, a choice among them, or one of the admin's own.
  app.get(`${API}/admin/metadata/items/:id/posters`, { preHandler: requireAdmin }, async (request, reply) => {
    const id = itemIdSchema.parse((request.params as { id: string }).id);
    const found = titleKindOf(id);
    if (!found) return reply.code(404).send({ error: "Not found" });
    const state = posterStateOf(db, id);
    const key = readTmdbKey(db);
    const match = tmdbMatchOf(db, id);
    if (!key || !match) return { posters: [], ...state, tmdb: Boolean(key) };
    try {
      const posters = await new Tmdb(key, options.fetch).posters(match.tmdbKind, match.tmdbId, found.language);
      return {
        posters: posters.map(({ path: imagePath, language }) => ({ path: imagePath, language, preview: `${API}/admin/metadata/image${imagePath}` })),
        ...state,
        tmdb: true
      };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  const titleAnswer = (request: FastifyRequest, id: string, kind: "show" | "movie") =>
    kind === "show" ? { show: getShow(db, request.identity!, id) } : { movie: getMovie(db, request.identity!, id) };

  app.put(`${API}/admin/metadata/items/:id/poster`, { preHandler: requireAdmin }, async (request, reply) => {
    const id = itemIdSchema.parse((request.params as { id: string }).id);
    const { path: imagePath } = backdropBodySchema.parse(request.body);
    const found = titleKindOf(id);
    if (!found) return reply.code(404).send({ error: "Not found" });
    setPosterChoice(db, id, found.kind, imagePath);
    await metadata.refreshOne(id);
    note(request, "info", "metadata.poster", { libraryId: found.libraryId, detail: imagePath ? `${found.title}: poster chosen by hand` : `${found.title}: TMDB's poster again` });
    return titleAnswer(request, id, found.kind);
  });

  app.put(`${API}/admin/metadata/items/:id/poster/upload`, { preHandler: requireAdmin, bodyLimit: POSTER_UPLOAD_LIMIT }, async (request, reply) => {
    const id = itemIdSchema.parse((request.params as { id: string }).id);
    const found = titleKindOf(id);
    if (!found) return reply.code(404).send({ error: "Not found" });
    if (!Buffer.isBuffer(request.body) || !savePosterUpload(db, artDir, id, found.kind, request.body)) {
      return reply.code(400).send({ error: "Send a JPEG, PNG or WebP picture" });
    }
    note(request, "info", "metadata.poster", { libraryId: found.libraryId, detail: `${found.title}: poster uploaded (${request.body.length} bytes)` });
    return titleAnswer(request, id, found.kind);
  });

  app.delete(`${API}/admin/metadata/items/:id/poster/upload`, { preHandler: requireAdmin }, async (request, reply) => {
    const id = itemIdSchema.parse((request.params as { id: string }).id);
    const found = titleKindOf(id);
    if (!found) return reply.code(404).send({ error: "Not found" });
    removePosterUpload(db, artDir, id);
    await metadata.refreshOne(id);
    note(request, "info", "metadata.poster", { libraryId: found.libraryId, detail: `${found.title}: uploaded poster removed` });
    return titleAnswer(request, id, found.kind);
  });

  // A match fixed by hand (a TMDB id), or handed back to the automatic one (null):
  // asked of TMDB at once, and the title answered as the family now sees it.
  app.put(`${API}/admin/metadata/items/:id`, { preHandler: requireAdmin }, async (request, reply) => {
    const id = itemIdSchema.parse((request.params as { id: string }).id);
    const { tmdbId, tmdbKind } = matchBodySchema.parse(request.body);
    const show = db.prepare("SELECT title, library_id FROM shows WHERE id = ?").get(id) as { title: string; library_id: string } | undefined;
    const movie = show ? undefined : db.prepare("SELECT title, library_id FROM movies WHERE id = ?").get(id) as { title: string; library_id: string } | undefined;
    const found = show ?? movie;
    if (!found) return reply.code(404).send({ error: "Not found" });
    setMatch(db, id, show ? "show" : "movie", tmdbId, tmdbKind ?? null);
    await metadata.refreshOne(id);
    const where = tmdbKind && tmdbKind !== (show ? "tv" : "movie") ? (tmdbKind === "tv" ? " (a TV show there)" : " (a film there)") : "";
    note(request, "info", "metadata.matched", { libraryId: found.library_id, detail: tmdbId ? `${found.title} matched by hand to TMDB ${tmdbId}${where}` : `${found.title} matched automatically again` });
    return show ? { show: getShow(db, request.identity!, id) } : { movie: getMovie(db, request.identity!, id) };
  });

  // A title's details as the admin edits them (edits.ts): each field and what it
  // is without the edit; a save answers with the title as the family now sees it.
  const editBodySchema = z.object({
    title: z.string().max(300).nullable().optional(),
    originalTitle: z.string().max(300).nullable().optional(),
    sortTitle: z.string().max(300).nullable().optional(),
    year: z.number().int().min(1870).max(2200).nullable().optional(),
    plot: z.string().max(10_000).nullable().optional(),
    genres: z.array(z.string().max(100)).max(30).nullable().optional(),
    set: z.union([
      z.object({ mode: z.literal("none") }),
      z.object({ mode: z.literal("named"), name: z.string().trim().min(1).max(200), order: z.number().int().min(0).max(999).nullable().optional() })
    ]).nullable().optional()
  });

  app.get(`${API}/admin/sets/names`, { preHandler: requireAdmin }, async () => ({ sets: setNames(db) }));

  app.get(`${API}/admin/titles/:id/edit`, { preHandler: requireAdmin }, async (request, reply) => {
    const state = editState(db, itemIdSchema.parse((request.params as { id: string }).id));
    return state ?? reply.code(404).send({ error: "Not found" });
  });

  app.put(`${API}/admin/titles/:id/edit`, { preHandler: requireAdmin }, async (request, reply) => {
    const id = itemIdSchema.parse((request.params as { id: string }).id);
    const body = editBodySchema.parse(request.body);
    const before = db.prepare("SELECT title, library_id, 'shows' AS kind FROM shows WHERE id = ? UNION ALL SELECT title, library_id, 'movies' FROM movies WHERE id = ?")
      .get(id, id) as { title: string; library_id: string; kind: "shows" | "movies" } | undefined;
    if (!before || !saveEdit(db, id, body)) return reply.code(404).send({ error: "Not found" });
    // A film put into a set, moved in one or taken out: the sets are worked out again at once.
    if (body.set !== undefined) rebuildSets(db, artDir);
    const fields = Object.keys(body).join(", ") || "nothing";
    note(request, "info", "title.edited", { libraryId: before.library_id, detail: `${before.title}: ${fields} edited` });
    const title = before.kind === "shows" ? getShow(db, request.identity!, id) : getMovie(db, request.identity!, id);
    return { [before.kind === "shows" ? "show" : "movie"]: title, edit: editState(db, id) };
  });

  // Genres (genres.ts): the admin's list, the keywords that lead to it, the words
  // hidden from every card. Each answer is the whole page again.
  const genreName = z.object({ name: z.string().trim().min(1).max(80) });
  const genreWord = z.object({ word: z.string().trim().min(1).max(100) });
  const genreIdOf = (request: FastifyRequest) => z.string().min(1).max(100).parse((request.params as { id: string }).id);
  const genresChanged = (request: FastifyRequest, detail: string) => {
    note(request, "info", "genres.changed", { detail });
    return genreOverview(db);
  };
  const genreNameOf = (id: string) => (db.prepare("SELECT name FROM genres WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? id;

  app.get(`${API}/admin/genres`, { preHandler: requireAdmin }, async () => genreOverview(db));

  app.post(`${API}/admin/genres`, { preHandler: requireAdmin }, async (request) => {
    const { name } = genreName.parse(request.body);
    createGenre(db, name);
    return genresChanged(request, `Genre "${name}" created`);
  });

  app.post(`${API}/admin/genres/seed`, { preHandler: requireAdmin }, async (request) => {
    const { language } = z.object({ language: z.enum(["en", "ru"]) }).parse(request.body);
    const count = seedGenres(db, language);
    return genresChanged(request, `${count} genres added from TMDB's list (${language})`);
  });

  app.patch(`${API}/admin/genres/:id`, { preHandler: requireAdmin }, async (request) => {
    const id = genreIdOf(request);
    const before = genreNameOf(id);
    const { name } = genreName.parse(request.body);
    renameGenre(db, id, name);
    return genresChanged(request, `Genre "${before}" renamed to "${name}"`);
  });

  app.delete(`${API}/admin/genres/:id`, { preHandler: requireAdmin }, async (request) => {
    const id = genreIdOf(request);
    const name = genreNameOf(id);
    deleteGenre(db, id);
    return genresChanged(request, `Genre "${name}" deleted; its words are hidden`);
  });

  app.post(`${API}/admin/genres/:id/merge`, { preHandler: requireAdmin }, async (request) => {
    const id = genreIdOf(request);
    const { into } = z.object({ into: z.string().min(1).max(100) }).parse(request.body);
    const name = genreNameOf(id);
    mergeGenre(db, id, into);
    return genresChanged(request, `Genre "${name}" merged into "${genreNameOf(into)}"`);
  });

  app.post(`${API}/admin/genres/:id/keywords`, { preHandler: requireAdmin }, async (request) => {
    const id = genreIdOf(request);
    const { word } = genreWord.parse(request.body);
    addKeyword(db, id, word);
    return genresChanged(request, `"${word}" now leads to genre "${genreNameOf(id)}"`);
  });

  app.post(`${API}/admin/genres/:id/keywords/remove`, { preHandler: requireAdmin }, async (request) => {
    const id = genreIdOf(request);
    const { word } = genreWord.parse(request.body);
    removeKeyword(db, id, word);
    return genresChanged(request, `"${word}" no longer leads to genre "${genreNameOf(id)}"`);
  });

  app.post(`${API}/admin/genres/hidden`, { preHandler: requireAdmin }, async (request) => {
    const { word } = genreWord.parse(request.body);
    hideWord(db, word);
    return genresChanged(request, `Genre word "${word}" hidden`);
  });

  app.post(`${API}/admin/genres/hidden/remove`, { preHandler: requireAdmin }, async (request) => {
    const { word } = genreWord.parse(request.body);
    showWord(db, word);
    return genresChanged(request, `Genre word "${word}" shown again`);
  });

  app.post(`${API}/admin/libraries/:id/metadata`, { preHandler: requireAdmin }, async (request, reply) => {
    const id = libraryIdSchema.parse((request.params as { id: string }).id);
    if (!getLibrary(db, id)) return reply.code(404).send({ error: "No such library" });
    queueMetadata(id, request, true);
    return reply.code(202).send({ library: getLibrary(db, id) });
  });

  app.get(`${API}/admin/events`, { preHandler: requireAdmin }, async (request) => {
    const query = eventsQuerySchema.parse(request.query ?? {});
    return {
      ...listEvents(db, { level: query.level ?? null, event: query.event || null, page: query.page, pageSize: query.pageSize }),
      retentionDays: EVENT_RETENTION_DAYS,
      rejected24h: countEventsSince(db, "gateway.rejected", 24)
    };
  });

  app.get(`${API}/admin/log`, { preHandler: requireAdmin }, async (request) => {
    const query = logQuerySchema.parse(request.query ?? {});
    return {
      lines: options.logBuffer?.tail(query.lines) ?? [],
      capacity: options.logBuffer?.capacity ?? 0,
      available: Boolean(options.logBuffer)
    };
  });

  // For home's diagnostics report (diagnostics.ts): what a bug report needs to be
  // answered. Sent as it is; home hides the names and paths unless the admin opts in.
  app.get(`${API}/admin/diagnostics`, { preHandler: requireAdmin }, async () => ({
    engine: { name: "isputnik.video", version: options.version, stage: options.stage, ...systemFacts() },
    ffmpeg: { found: Boolean(tools) && (await toolsReady), version: await ffmpegVersionOf(tools) },
    gpu: hardware ? { ...hardware.state(), recentFailures: hardware.recentFailures() } : null,
    conversion: {
      settings: readConversion(db),
      storage: hls?.storage ?? null,
      diskMapped: hls?.mapped ?? false,
      watching: hls?.watching() ?? 0,
      runs: hls?.active() ?? 0,
      memoryBytes: hls?.usage().memoryBytes ?? 0,
      diskBytes: hls?.usage().diskBytes ?? 0
    },
    detection: detectionState(),
    metadata: { tmdbKey: Boolean(readTmdbKey(db)) },
    libraries: listLibraries(db).map((library) => ({
      name: library.name, kind: library.kind, folder: library.folder, language: library.language, state: library.state,
      scanState: library.scanState, scanError: library.scanError, lastScanAt: library.lastScanAt,
      titles: library.titles, episodes: library.episodes, sizeBytes: library.sizeBytes
    })),
    paths: { media: options.mediaRoot, database: options.dbPath, art: artDir, transcode: hls?.folder ?? null },
    log: problemLines(options.logBuffer),
    hardwareTest: testSummary(listTests(db, 1)[0] ?? null),
    hardwareChanges: listChanges(db, 5).map((change) => `${change.at.slice(0, 16).replace("T", " ")} ${change.summary}`),
    diskCheck: diskSummary(listDiskChecks(db, 1)[0] ?? null)
  }));

  /** The last disk check, a line a library, for the diagnostics report. */
  function diskSummary(check: DiskCheck | null) {
    if (!check) return null;
    return {
      at: check.startedAt,
      phase: check.phase,
      ...(check.reason ? { reason: check.reason } : {}),
      libraries: check.libraries.map((entry) => entry.error
        ? `${entry.name}: failed (${entry.error})`
        : `${entry.name}: first answer ${entry.wake.slowestMs ?? "?"} ms at the slowest${entry.wake.asleep ? " (a disk was asleep)" : ""}; reads ${entry.read?.mbitPerSecond != null ? `${entry.read.mbitPerSecond} Mbit/s` : "?"}; heaviest film ${entry.heaviestMbit ?? "?"} Mbit/s; ${entry.verdict}`)
    };
  }

  // ── The hardware test (hardware-test.ts) ─────────────────────────────────

  /** The last test in a few lines, for the diagnostics report. */
  function testSummary(test: HardwareTest | null) {
    if (!test) return null;
    const speed = (run: HardwareTest["scenarios"][number]["gpuRun"]) => (run ? (run.speed === null ? `failed (${run.error ?? "?"})` : `${run.speed}x ${run.verdict}`) : "-");
    return {
      at: test.startedAt,
      phase: test.phase,
      ...(test.reason ? { reason: test.reason } : {}),
      scenarios: test.scenarios.map((entry) => entry.skipped ? `${entry.label}: skipped (${entry.skipped})` : `${entry.label}: GPU ${speed(entry.gpuRun)}, CPU ${speed(entry.cpuRun)}`),
      atOnce: test.together.map((entry) => `${entry.label} on the ${entry.converter.toUpperCase()}: ${entry.atOnce}${entry.atLeast ? " or more" : ""}`),
      suggestedViewers: test.suggestedViewers
    };
  }

  // While a test or a disk check runs, someone starting to watch converted video
  // stops it: they come first.
  let testWatch: NodeJS.Timeout | null = null;
  const watchTest = () => {
    if (testWatch) clearInterval(testWatch);
    testWatch = setInterval(() => {
      if (!tester?.running() && !disks.running()) {
        clearInterval(testWatch!);
        testWatch = null;
        return;
      }
      if ((hls?.watching() ?? 0) > 0) {
        tester?.stop("Someone started watching converted video");
        disks.stop("Someone started watching converted video");
      }
    }, 1000);
    testWatch.unref();
  };

  app.post(`${API}/admin/hardware/test`, { preHandler: requireAdmin }, async (request, reply) => {
    if (!tester || !(await toolsReady)) return reply.code(404).send({ error: "ffmpeg is missing: nothing can be tested" });
    if ((hls?.watching() ?? 0) > 0) return reply.code(409).send({ error: "Someone is watching converted video. Try again when they've finished.", code: "watching" });
    if (tester.running()) return reply.code(409).send({ error: "A test is running already", code: "running" });
    if (disks.running()) return reply.code(409).send({ error: "A disk check is running", code: "disks" });
    const test = tester.start();
    watchTest();
    note(request, "info", "hardware.test", { detail: "Hardware test started" });
    return reply.code(202).send({ test });
  });

  app.get(`${API}/admin/hardware/test`, { preHandler: requireAdmin }, async () => ({
    running: tester?.progress() ?? null,
    last: listTests(db, 1)[0] ?? null,
    available: Boolean(tester)
  }));

  app.delete(`${API}/admin/hardware/test`, { preHandler: requireAdmin }, async (request, reply) => {
    if (!tester?.running()) return reply.code(404).send({ error: "No test is running" });
    tester.stop(`Stopped by ${request.identity?.name || "an admin"}`);
    await tester.settled();
    return { last: listTests(db, 1)[0] ?? null };
  });

  app.get(`${API}/admin/hardware/history`, { preHandler: requireAdmin }, async () => ({
    tests: listTests(db),
    changes: listChanges(db),
    diskChecks: listDiskChecks(db)
  }));

  // The disk check (disk-check.ts): each library's wake-up and reading speed.
  app.post(`${API}/admin/hardware/disks`, { preHandler: requireAdmin }, async (request, reply) => {
    if ((hls?.watching() ?? 0) > 0) return reply.code(409).send({ error: "Someone is watching converted video. Try again when they've finished.", code: "watching" });
    if (disks.running()) return reply.code(409).send({ error: "A disk check is running already", code: "running" });
    if (tester?.running()) return reply.code(409).send({ error: "A hardware test is running", code: "test" });
    const check = disks.start();
    watchTest();
    note(request, "info", "hardware.disks", { detail: "Disk check started" });
    return reply.code(202).send({ check });
  });

  app.get(`${API}/admin/hardware/disks`, { preHandler: requireAdmin }, async () => ({
    running: disks.progress(),
    last: listDiskChecks(db, 1)[0] ?? null
  }));

  app.delete(`${API}/admin/hardware/disks`, { preHandler: requireAdmin }, async (request, reply) => {
    if (!disks.running()) return reply.code(404).send({ error: "No disk check is running" });
    disks.stop(`Stopped by ${request.identity?.name || "an admin"}`);
    await disks.settled();
    return { last: listDiskChecks(db, 1)[0] ?? null };
  });

  // The whole catalog for home's backups (home's docs/apps-platform-plan.md →
  // Backups): one consistent copy; the event about it is written after it.
  // Copied with SQLite's online backup, a few pages at a time between other
  // work (the picture hashes kept for recaps make the catalog large), into a
  // file of its own that is then streamed and let go.
  app.get(`${API}/admin/backup`, { preHandler: requireAdmin }, async (request, reply) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "isputnik-video-backup-"));
    const file = path.join(dir, "video.sqlite");
    const letGo = () => fs.rm(dir, { recursive: true, force: true }, () => undefined);
    let size: number;
    try {
      await db.backup(file);
      size = (await fs.promises.stat(file)).size;
    } catch (err) {
      letGo();
      throw err;
    }
    note(request, "info", "backup.taken", { detail: `Catalog handed over for a backup (${size} bytes)` });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/vnd.sqlite3",
      "Content-Length": size,
      "Cache-Control": "no-store",
      "X-Isputnik-Backup-Version": options.version
    });
    const stream = fs.createReadStream(file);
    stream.on("error", (err) => reply.raw.destroy(err));
    // Gone once read, or once home stops reading.
    stream.on("close", letGo);
    reply.raw.on("close", () => stream.destroy());
    stream.pipe(reply.raw);
  });

  // And back (restore.ts): home sends a backup it holds, and it is in place when
  // this answers. onRequest, so nobody but an admin gets as far as sending a file.
  const restoreTarget: RestoreTarget = {
    db,
    dbPath: options.dbPath,
    version: options.version,
    tables: ["libraries", "shows", "movies"],
    name: "the video catalog",
    upgrade: upgradeDatabase
  };
  const refuseWhileWorking = () => {
    if (catalogWork > 0) throw new RestoreError(409, "A scan or a metadata pass is running. Try again when it has finished.");
  };
  /** What the restored rows say that only this process can know the truth of. */
  const afterRestore = () => {
    // A copy taken during a scan says it is scanning, and nothing here is.
    db.prepare("UPDATE libraries SET scan_state = 'idle' WHERE scan_state IN ('queued', 'scanning')").run();
    hls?.configure(readConversion(db));
    reloadGenres(db);
  };
  app.addContentTypeParser(SQLITE_CONTENT_TYPE, { parseAs: "buffer", bodyLimit: RESTORE_BODY_LIMIT }, (_request, body, done) => done(null, body));

  app.post(`${API}/admin/restore`, { onRequest: requireAdmin, bodyLimit: RESTORE_BODY_LIMIT }, async (request) => {
    if (!Buffer.isBuffer(request.body)) throw new RestoreError(400, "Send the database itself.");
    refuseWhileWorking();
    const from = request.headers["x-isputnik-backup-version"];
    const fromVersion = typeof from === "string" && from ? from : null;
    const { kept } = await restoreDatabase(restoreTarget, request.body, fromVersion);
    afterRestore();
    note(request, "info", "backup.restored", {
      detail: `Catalog restored from a backup${fromVersion ? ` of version ${fromVersion}` : ""} (${request.body.length} bytes)${kept ? "; the one it replaced is kept to undo this" : ""}`
    });
    return { restored: true, version: options.version };
  });

  app.get(`${API}/admin/restore/undo`, { preHandler: requireAdmin }, async () => ({ undo: undoInfo(restoreTarget) }));

  app.post(`${API}/admin/restore/undo`, { preHandler: requireAdmin }, async (request) => {
    refuseWhileWorking();
    undoRestore(restoreTarget);
    afterRestore();
    note(request, "info", "backup.undone", { detail: "The last restore was undone: the catalog it replaced is back" });
    return { undone: true, version: options.version };
  });

  // Everything else under the prefix is this API's own 404, never a page.
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: "Not found" }));

  return app;
}
