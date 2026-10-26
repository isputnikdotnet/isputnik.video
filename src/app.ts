// The video engine: no pages of its own. Home draws every screen and manages
// every library; this server scans the folders, keeps the catalog and answers
// for both (home's docs/video-architecture.md). Reached only through home's
// gateway, under /video, with the person's identity in signed headers.
import fs from "node:fs";
import path from "node:path";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { getMovie, getShow, listMovies, listShows, visibleLibraries } from "./catalog.js";
import { browserPlayability, continueWatching, fileOf, findItem, nextEpisode, progressFor, purgeOrphanProgress, resumeAt, saveProgress, type PlayableItem } from "./playback.js";
import { decideDelivery, type Delivery, type DeliveryMode, type DeliveryReason } from "./delivery.js";
import { findTools, toolsWork, type AudioStream, type MediaInfo, type Tools } from "./ffmpeg.js";
import { HlsError, HlsSessions, buildPlan, playlist, type HlsPlan } from "./hls.js";
import { MediaProbe, purgeOrphanProbes, type ProbedFile } from "./media-probe.js";
import { BASE_PATH } from "./config.js";
import { openDatabase } from "./db.js";
import { EVENT_LEVELS, EVENT_RETENTION_DAYS, countEventsSince, listEvents, pruneEvents, recordEvent, type EventLevel } from "./events.js";
import { clientIpFrom, devIdentity, forwardedRequestId, identityFrom, rejectionReason, type Identity } from "./identity.js";
import { LibraryError, getLibrary, listLibraries, purgeDetached, purgeLibrary, putLibrary, setScanState, syncLibraries } from "./libraries.js";
import type { LogBuffer } from "./log-buffer.js";
import { listFolders } from "./media.js";
import { ScanError, scanLibrary, type ScanOptions } from "./scan.js";

declare module "fastify" {
  interface FastifyRequest {
    identity: Identity | null;
    /** The browser's address as the gateway saw it; the socket's otherwise. */
    clientIp: string;
  }
  interface FastifyInstance {
    /** Resolves once every scan asked for so far has finished — for tests and shutdown. */
    scansSettled(): Promise<void>;
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
  /** Where segments are made while someone watches (TRANSCODE_PATH); emptied on
   *  start and removed on close. A fresh temporary folder when left out. */
  transcodeDir?: string;
  /** Tests settle files at once instead of waiting out a copy. */
  scan?: ScanOptions;
  fastify?: FastifyServerOptions;
}

const API = `${BASE_PATH}/api`;

/** Requests here are small JSON; nothing posts a file to the engine. */
export const BODY_LIMIT = 64 * 1024;
const LOG_LINES_MAX = 500;

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

const progressBodySchema = z.object({
  position: z.number().min(0).max(1e6),
  duration: z.number().positive().max(1e6).nullable().default(null),
  watched: z.boolean().optional()
});

/** The sound track chosen, by ffprobe stream index. */
const playQuerySchema = z.object({ audio: z.coerce.number().int().min(0).max(999).optional() });

/** The HLS address of one sound track: t<index>, or t- for a silent film. */
const trackSegment = (delivery: Delivery) => (delivery.audio ? `t${delivery.audio.index}` : "t-");

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
  const hls = tools
    ? new HlsSessions(tools, options.transcodeDir ?? null, {
      info: (obj, msg) => app.log.info(obj, msg),
      warn: (obj, msg) => app.log.warn(obj, msg)
    })
    : null;

  /** How the file reaches the browser, from what ffprobe finds inside it; null
   *  when ffmpeg is missing or can't read the file. */
  const deliveryFor = async (item: PlayableItem, file: ProbedFile, audioIndex?: number | null): Promise<{ info: MediaInfo; delivery: Delivery } | null> => {
    if (!mediaProbe || !(await toolsReady)) return null;
    try {
      const info = await mediaProbe.info(item.id, file);
      return { info, delivery: decideDelivery(info, path.extname(item.relative), audioIndex) };
    } catch (err) {
      app.log.warn({ err, item: item.id }, "ffprobe could not read a video file");
      return null;
    }
  };

  // One scan at a time: scans read a whole disk, and two would only fight over it.
  let scanChain: Promise<void> = Promise.resolve();
  const queued = new Set<string>();
  app.decorate("scansSettled", () => scanChain);

  app.addHook("onClose", async () => {
    clearInterval(daily);
    hls?.close();
    await scanChain.catch(() => undefined);
    db.close();
  });

  // Old events and long-detached libraries go on start and once a day after.
  const sweep = () => {
    pruneEvents(db, EVENT_RETENTION_DAYS);
    const purged = purgeDetached(db);
    if (purged > 0) recordEvent(db, { level: "info", event: "library.purged", detail: `${purged} library(ies) detached for over 30 days were removed` });
    purgeOrphanProgress(db);
    purgeOrphanProbes(db);
  };
  sweep();
  const daily = setInterval(sweep, 24 * 60 * 60 * 1000);
  daily.unref();

  app.setChildLoggerFactory(function (logger, bindings, loggerOptions, raw) {
    const identity = secret ? identityFrom(raw.headers, secret) : dev;
    return logger.child({ ...bindings, user: identity?.id ?? null, ip: clientIpFrom(raw.headers, secret, raw.socket?.remoteAddress) }, loggerOptions);
  });

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
    scanChain = scanChain.then(async () => {
      queued.delete(libraryId);
      if (!getLibrary(db, libraryId)) return;
      setScanState(db, libraryId, "scanning");
      // Let the queued answer go out before the disk is read.
      await new Promise((resolve) => setImmediate(resolve));
      try {
        const summary = scanLibrary(db, options.mediaRoot, libraryId, options.scan);
        setScanState(db, libraryId, "idle");
        const growing = summary.growing > 0 ? `, ${summary.growing} file(s) still being copied left for later` : "";
        const unnumbered = summary.unnumbered > 0 ? `, ${summary.unnumbered} file(s) without a season and episode in the name` : "";
        note(request, summary.unnumbered > 0 ? "warn" : "info", "scan.finished", {
          libraryId,
          detail: `${summary.titles} title(s), ${summary.episodes} episode(s); ${summary.added} added, ${summary.removed} removed${growing}${unnumbered}`
        });
      } catch (err) {
        const message = err instanceof ScanError ? err.message : `The scan failed: ${(err as Error).message}`;
        setScanState(db, libraryId, "error", message);
        note(request, "error", "scan.failed", { libraryId, detail: message });
        if (!(err instanceof ScanError)) app.log.error({ err, libraryId }, "Scan failed");
      }
    });
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

  // ── Watching ─────────────────────────────────────────────────────────────

  // What home's player needs to start: the item, how it plays (with the sound
  // track asked for, ?audio=<index>), its sound tracks, where to resume, and
  // what comes next.
  app.get(`${API}/play/:id`, { preHandler: requireIdentity }, async (request, reply) => {
    const identity = request.identity!;
    const item = findItem(db, identity, itemIdSchema.parse((request.params as { id: string }).id));
    if (!item) return reply.code(404).send({ error: "Not found" });
    const file = fileOf(options.mediaRoot, item);
    const progress = progressFor(db, identity.id, [item.id]).get(item.id) ?? null;
    const next = item.type === "episode" ? nextEpisode(db, item.show!.id, item.id) : null;
    const { audio: audioIndex } = playQuerySchema.parse(request.query ?? {});
    const stream = `${API}/stream/${item.id}`;
    let audioTracks: (AudioStream & { selected: boolean })[] = [];
    let playback: { mode: DeliveryMode | "none"; reasons: DeliveryReason[]; url: string | null; duration: number | null } =
      { mode: "none", reasons: [], url: null, duration: null };
    if (file) {
      const decided = await deliveryFor(item, file, audioIndex);
      if (decided) {
        const { mode, reasons, videoCopy } = decided.delivery;
        const hlsUrl = `${API}/hls/${item.id}/${trackSegment(decided.delivery)}/index.m3u8`;
        playback = { mode, reasons, url: mode === "direct" ? stream : hlsUrl, duration: decided.info.duration || null };
        audioTracks = decided.info.audio.map((track) => ({ ...track, selected: track.index === decided.delivery.audio?.index }));
        // The playlist of a picture copied as it is needs its keyframes: start
        // reading them now, while the page opens.
        if (mode === "remux" && videoCopy) void mediaProbe!.keyframes(item.id, file).catch(() => undefined);
      } else if (browserPlayability(item.relative).direct !== "no") {
        // Nothing to look inside it with: offered as it is, and the browser decides.
        playback = { mode: "direct", reasons: [], url: stream, duration: null };
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
      playback,
      audioTracks,
      progress,
      resumeAt: resumeAt(progress),
      next: next ? { id: next.id, season: next.season, episode: next.episode, title: next.title } : null
    };
  });

  // The file itself, with byte ranges so the player can seek. Streamed straight
  // from disk; the reply is written by hand so nothing buffers a film.
  app.get(`${API}/stream/:id`, { preHandler: requireIdentity }, async (request, reply) => {
    const item = findItem(db, request.identity!, itemIdSchema.parse((request.params as { id: string }).id));
    const file = item ? fileOf(options.mediaRoot, item) : null;
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
  });

  // HLS, for what the browser can't play as it is: the playlist of the whole
  // film, then each segment, made as it is asked for (hls.ts).
  const planFor = async (request: FastifyRequest): Promise<{ key: string; plan: HlsPlan } | null> => {
    const identity = request.identity!;
    const { id, track } = request.params as { id: string; track?: string };
    const item = findItem(db, identity, itemIdSchema.parse(id));
    const file = item ? fileOf(options.mediaRoot, item) : null;
    if (!item || !file || !hls || !mediaProbe) return null;
    // No track in the address (home 4.40.0): the default sound.
    const chosen = track === undefined ? null : /^t(\d{1,3})$/.exec(track);
    if (track !== undefined && track !== "t-" && !chosen) return null;
    const decided = await deliveryFor(item, file, chosen ? Number(chosen[1]) : null);
    if (!decided) return null;
    // An address for a track the file doesn't have is not this film.
    if (track !== undefined && trackSegment(decided.delivery) !== track) return null;
    const keyframes = decided.delivery.videoCopy ? await mediaProbe.keyframes(item.id, file) : null;
    return { key: `${identity.id}:${item.id}`, plan: buildPlan(item.id, file.absolute, decided.info, decided.delivery, keyframes) };
  };

  const serveHls = async (request: FastifyRequest, reply: FastifyReply) => {
    const { name } = request.params as { name: string };
    const segment = /^(\d{1,6})\.ts$/.exec(name);
    if (name !== "index.m3u8" && !segment) return reply.code(404).send({ error: "Not found" });
    const found = await planFor(request);
    if (!found) return reply.code(404).send({ error: "Not found" });
    if (!segment) {
      return reply.header("Content-Type", "application/vnd.apple.mpegurl").header("Cache-Control", "private, no-store").send(playlist(found.plan));
    }
    const n = Number(segment[1]);
    if (n >= found.plan.starts.length) return reply.code(404).send({ error: "Not found" });
    let file: string;
    try {
      file = await hls!.segment(found.key, found.plan, n);
    } catch (err) {
      if (!(err instanceof HlsError)) throw err;
      return reply.code(503).header("Retry-After", "2").send({ error: err.message });
    }
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return reply.code(503).header("Retry-After", "1").send({ error: "The segment went missing" });
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "video/mp2t",
      "Content-Length": size,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    });
    const stream = fs.createReadStream(file);
    stream.on("error", (err) => reply.raw.destroy(err));
    reply.raw.on("close", () => stream.destroy());
    stream.pipe(reply.raw);
  };
  app.get(`${API}/hls/:id/:track/:name`, { preHandler: requireIdentity }, serveHls);
  app.get(`${API}/hls/:id/:name`, { preHandler: requireIdentity }, serveHls);

  // The player has gone: stop converting for it now rather than after a minute.
  app.delete(`${API}/hls/:id`, { preHandler: requireIdentity }, async (request, reply) => {
    const id = itemIdSchema.parse((request.params as { id: string }).id);
    hls?.stop(`${request.identity!.id}:${id}`);
    return reply.code(204).send();
  });

  // How far the person got; the player sends it every few seconds and on pause.
  app.put(`${API}/progress/:id`, { preHandler: requireIdentity }, async (request, reply) => {
    const identity = request.identity!;
    const item = findItem(db, identity, itemIdSchema.parse((request.params as { id: string }).id));
    if (!item) return reply.code(404).send({ error: "Not found" });
    const body = progressBodySchema.parse(request.body);
    return { progress: saveProgress(db, identity.id, item, body) };
  });

  app.get(`${API}/continue`, { preHandler: requireIdentity }, async (request) => {
    const { limit } = continueQuerySchema.parse(request.query ?? {});
    return { items: continueWatching(db, request.identity!, limit) };
  });

  // ── Libraries, as home manages them (home's server calls these) ─────────

  app.get(`${API}/admin/libraries`, { preHandler: requireAdmin }, async () => ({ libraries: listLibraries(db) }));

  app.put(`${API}/admin/libraries/:id`, { preHandler: requireAdmin }, async (request, reply) => {
    const id = libraryIdSchema.parse((request.params as { id: string }).id);
    const body = libraryBodySchema.parse(request.body);
    const { created, rescan } = putLibrary(db, options.mediaRoot, id, body);
    note(request, "info", created ? "library.added" : "library.changed", { libraryId: id, detail: `${body.name} (${body.kind}) at "${body.folder}"` });
    if (rescan) queueScan(id, request);
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

  app.post(`${API}/admin/libraries/:id/scan`, { preHandler: requireAdmin }, async (request, reply) => {
    const id = libraryIdSchema.parse((request.params as { id: string }).id);
    if (!getLibrary(db, id)) return reply.code(404).send({ error: "No such library" });
    queueScan(id, request);
    return reply.code(202).send({ library: getLibrary(db, id) });
  });

  // The folder picker in home's Add library: this engine's folders, under MEDIA_ROOT.
  app.get(`${API}/admin/folders`, { preHandler: requireAdmin }, async (request, reply) => {
    const { path: relative } = foldersQuerySchema.parse(request.query ?? {});
    const listed = listFolders(options.mediaRoot, relative);
    return listed ?? reply.code(404).send({ error: "No such folder" });
  });

  // ── The admin's window, read by home through the gateway ─────────────────

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

  // The whole catalog for home's backups (home's docs/apps-platform-plan.md →
  // Backups): one consistent copy; the event about it is written after it.
  app.get(`${API}/admin/backup`, { preHandler: requireAdmin }, async (request, reply) => {
    const bytes = db.serialize();
    note(request, "info", "backup.taken", { detail: `Catalog handed over for a backup (${bytes.length} bytes)` });
    return reply
      .type("application/vnd.sqlite3")
      .header("Cache-Control", "no-store")
      .header("X-Isputnik-Backup-Version", options.version)
      .send(bytes);
  });

  // Everything else under the prefix is this API's own 404, never a page.
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: "Not found" }));

  return app;
}
