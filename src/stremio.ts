// The Stremio add-on (home's docs/stremio-plan.md): the same catalog home's
// screens show, in Stremio's add-on protocol, for one member on a TV.
//
// Home's gateway admits /video/stremio/<token>/… by a member's personal token and
// forwards the owner's identity as for any request (X-Isputnik-Via: token) — so
// everything here filters by X-Isputnik-Libraries like every other route, and
// never sees or checks the token itself. Beside who, home says which install this
// is (X-Isputnik-Site-Id, -Site-Name) and the address to build every link on
// (X-Isputnik-Base-Url, from its APP_URL): Stremio fetches stream, poster and
// subtitle addresses as given, so they must be absolute.
//
// Every install is its own add-on: the manifest id and every item id carry the
// site id ("isp-<site>:<id>"), so a member of two servers can install both and
// Stremio never mixes their Continue watching.
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";
import { z } from "zod";
import type { Db } from "./db.js";
import { libraryGenres, listMovies, listShows, getMovie, getShow, visibleLibraries } from "./catalog.js";
import { BASE_PATH } from "./config.js";
import { decideDelivery, type Delivery } from "./delivery.js";
import type { MediaInfo } from "./ffmpeg.js";
import { fromGateway, single, type Identity } from "./identity.js";
import { artUrl, metaFor } from "./metadata.js";
import type { MediaProbe } from "./media-probe.js";
import { continueWatching, fileOf, findItem } from "./playback.js";
import { listSubtitles } from "./subtitles.js";

export const STREMIO_PATH = `${BASE_PATH}/stremio`;
const API = `${BASE_PATH}/api`;

export const SITE_ID_HEADER = "x-isputnik-site-id";
export const SITE_NAME_HEADER = "x-isputnik-site-name";
export const BASE_URL_HEADER = "x-isputnik-base-url";

/** A catalog page: Stremio asks for the next with skip=<how many it has>. */
export const CATALOG_PAGE = 100;
const CONTINUE_CATALOG = "isp-continue";
const LIBRARY_CATALOG = "isp-lib-";

/** Which install, what it is called, and where its add-on lives. */
export interface Site {
  id: string;
  name: string;
  base: string;
}

const SITE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The install home says this is; null when the request is not a token request
 *  from the gateway. Without a secret (a source checkout) the add-on answers
 *  as "dev" on the address it was reached at, so it can be tried in Stremio
 *  on this machine. */
export function siteFrom(request: FastifyRequest, secret: string | null): Site | null {
  const token = (request.params as { token?: string }).token ?? "";
  if (!secret) {
    return { id: "dev", name: "iSputnik (dev)", base: `${request.protocol}://${request.headers.host}${STREMIO_PATH}/${encodeURIComponent(token)}` };
  }
  if (!fromGateway(request.headers, secret)) return null;
  const id = single(request.headers[SITE_ID_HEADER])?.trim() ?? "";
  const base = single(request.headers[BASE_URL_HEADER])?.trim() ?? "";
  if (!SITE_ID.test(id) || !/^https?:\/\/[^/]+\/.*\/stremio\/[^/]+$/.test(base)) return null;
  let name = "iSputnik";
  try {
    name = decodeURIComponent(single(request.headers[SITE_NAME_HEADER]) ?? "").trim().slice(0, 80) || name;
  } catch {
    /* a name that isn't percent-encoding: keep the default */
  }
  return { id, name, base };
}

/** Masks a Stremio link's token wherever it is written down (the log). */
export function maskStremioToken(text: string): string {
  return text.replace(/(\/video\/stremio\/)[^/?"\s\\]+/g, "$1<token>");
}

const prefixOf = (site: Site) => `isp-${site.id}:`;

/** An engine id from a Stremio id of this install; null for anyone else's. */
export function engineIdOf(site: Site, stremioId: string): string | null {
  const prefix = prefixOf(site);
  if (!stremioId.startsWith(prefix)) return null;
  const id = stremioId.slice(prefix.length);
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

/** The engine's own address for a picture, on the add-on's base instead. */
const absoluteArt = (site: Site, url: string | null) => (url && url.startsWith(`${API}/`) ? `${site.base}/${url.slice(API.length + 1)}` : url);

// ── Formats a TV is known to refuse ─────────────────────────────────────────

/** Pictures every Stremio player on a TV was seen to decode (S0): H.264 in
 *  8-bit 4:2:0, HEVC (10-bit included), VP9, AV1. */
const TV_PIXELS = new Set(["yuv420p", "yuvj420p"]);
const TV_SAFE_CODECS = new Set(["hevc", "vp9", "av1"]);

/** Why this file should be offered converted first, or null when the original
 *  is safe. A file a TV cannot decode crashes Stremio instead of failing
 *  politely, so anything unknown counts as unsafe. */
export function tvRisk(info: MediaInfo | null): string | null {
  if (!info) return "unread";
  const video = info.video;
  if (!video) return null;
  if (video.codec === "h264") {
    if (video.pixelFormat && !TV_PIXELS.has(video.pixelFormat)) return `h264 ${video.pixelFormat}`;
    if (video.profile && /high 10|high 4:2:2|high 4:4:4/i.test(video.profile)) return `h264 ${video.profile}`;
    return null;
  }
  return TV_SAFE_CODECS.has(video.codec) ? null : video.codec;
}

/** ISO 639-2 for Stremio's subtitle menu, which names "eng", not "en". */
const ISO2_TO_3: Record<string, string> = {
  en: "eng", ru: "rus", uk: "ukr", be: "bel", de: "ger", fr: "fre", es: "spa", it: "ita", pt: "por", pl: "pol",
  cs: "cze", nl: "dut", sv: "swe", fi: "fin", no: "nor", da: "dan", he: "heb", ar: "ara", tr: "tur", ja: "jpn",
  zh: "chi", ko: "kor", el: "gre", hu: "hun", ro: "rum", bg: "bul", sr: "srp", hr: "hrv", lt: "lit", lv: "lav", et: "est", ka: "geo", hy: "arm"
};
export function stremioLanguage(language: string | null): string {
  if (!language) return "und";
  const code = language.toLowerCase();
  return ISO2_TO_3[code] ?? code;
}

// ── The protocol ────────────────────────────────────────────────────────────

const extraSchema = z.object({
  search: z.string().trim().max(200).optional(),
  genre: z.string().trim().max(100).optional(),
  skip: z.coerce.number().int().min(0).max(100_000).default(0)
});

/** "search=x&skip=100" from the path's last segment, before ".json". */
function parseExtra(raw: string | undefined) {
  return extraSchema.parse(Object.fromEntries(new URLSearchParams(raw ?? "")));
}

export interface StremioDeps {
  db: Db;
  secret: string | null;
  mediaRoot: string;
  version: string;
  /** null when ffmpeg is missing: then every file is offered as it is. */
  probe: () => Promise<MediaProbe | null>;
  /** Whether conversion is available at all (HLS sessions). */
  canConvert: boolean;
  requireIdentity: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /** The engine's own byte handlers, answered here under the token prefix too. */
  handlers: { stream: RouteHandlerMethod; hls: RouteHandlerMethod; art: RouteHandlerMethod; subtitle: RouteHandlerMethod };
  /** The HLS address segment for a delivery (t<audio>[b<burn>]). */
  trackSegment: (delivery: Delivery) => string;
}

export function registerStremio(app: FastifyInstance, deps: StremioDeps): void {
  const { db } = deps;
  const ROOT = `${STREMIO_PATH}/:token`;

  // Stremio's web and desktop apps read the JSON from another origin.
  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith(`${STREMIO_PATH}/`)) reply.header("Access-Control-Allow-Origin", "*");
  });
  app.options(`${ROOT}/*`, async (_request, reply) =>
    reply.code(204).header("Access-Control-Allow-Origin", "*").header("Access-Control-Allow-Headers", "*").send());

  /** Who and which install, or the reply already sent. */
  const context = async (request: FastifyRequest, reply: FastifyReply): Promise<{ identity: Identity; site: Site } | null> => {
    await deps.requireIdentity(request, reply);
    if (reply.sent) return null;
    const site = siteFrom(request, deps.secret);
    if (!site) {
      void reply.code(400).send({ error: "Not a Stremio request from the home server" });
      return null;
    }
    return { identity: request.identity!, site };
  };

  /** The rest of the path after the route's fixed part, without ".json". */
  const tail = (request: FastifyRequest) => String((request.params as { "*"?: string })["*"] ?? "").replace(/\.json$/, "");

  const posterOf = (site: Site, id: string) => absoluteArt(site, artUrl(API, metaFor(db, [id]).get(id), "poster"));

  app.get(`${ROOT}/manifest.json`, async (request, reply) => {
    const found = await context(request, reply);
    if (!found) return;
    const { identity, site } = found;
    const libraries = visibleLibraries(db, identity);
    const kinds = new Set(libraries.map((library) => library.kind));
    return {
      id: `net.isputnik.home.${site.id}`,
      version: deps.version.replace(/[^0-9.]/g, "") || "0.0.0",
      name: site.name,
      description: "Shows and films from this iSputnik's video libraries.",
      resources: ["catalog", "meta", "stream", "subtitles"],
      types: ["movie", "series"],
      idPrefixes: [prefixOf(site)],
      catalogs: [
        // One row per kind the member has, so each holds what its type says.
        ...(kinds.has("movies") ? [{ type: "movie", id: CONTINUE_CATALOG, name: "Continue watching" }] : []),
        ...(kinds.has("shows") ? [{ type: "series", id: CONTINUE_CATALOG, name: "Continue watching" }] : []),
        ...libraries.map((library) => {
          const genres = libraryGenres(db, library.id, library.kind);
          return {
            type: library.kind === "movies" ? "movie" : "series",
            id: `${LIBRARY_CATALOG}${library.id}`,
            name: library.name,
            extra: [{ name: "search" }, { name: "skip" }, ...(genres.length > 0 ? [{ name: "genre", options: genres }] : [])]
          };
        })
      ],
      behaviorHints: { configurable: false, configurationRequired: false }
    };
  });

  app.get(`${ROOT}/catalog/*`, async (request, reply) => {
    const found = await context(request, reply);
    if (!found) return;
    const { identity, site } = found;
    const [type, catalogId, extraRaw] = tail(request).split("/");
    const extra = parseExtra(extraRaw);
    const prefix = prefixOf(site);

    if (catalogId === CONTINUE_CATALOG) {
      if (extra.skip > 0 || extra.search) return { metas: [] };
      const seen = new Set<string>();
      const metas = continueWatching(db, identity, 20).flatMap((item) => {
        if ((type === "series") !== Boolean(item.show)) return [];
        const id = item.show ? item.show.id : item.id;
        if (seen.has(id)) return [];
        seen.add(id);
        return [{ id: `${prefix}${id}`, type: item.show ? "series" : "movie", name: item.show ? item.show.title : item.title, poster: posterOf(site, id) }];
      });
      return { metas };
    }

    const libraryId = catalogId?.startsWith(LIBRARY_CATALOG) ? catalogId.slice(LIBRARY_CATALOG.length) : null;
    const library = libraryId ? visibleLibraries(db, identity).find((candidate) => candidate.id === libraryId) : undefined;
    if (!library || type !== (library.kind === "movies" ? "movie" : "series")) return { metas: [] };
    const query = { library: library.id, q: extra.search, genre: extra.genre, sort: "title" as const, page: 1, pageSize: CATALOG_PAGE, offset: extra.skip };
    const listed = library.kind === "movies" ? listMovies(db, identity, query) : listShows(db, identity, query);
    return {
      metas: listed.items.map((item) => ({
        id: `${prefix}${item.id}`,
        type,
        name: item.title,
        poster: absoluteArt(site, item.poster),
        posterShape: "poster",
        releaseInfo: item.year ? String(item.year) : undefined,
        genres: item.genres.length > 0 ? item.genres : undefined
      }))
    };
  });

  app.get(`${ROOT}/meta/*`, async (request, reply) => {
    const found = await context(request, reply);
    if (!found) return;
    const { identity, site } = found;
    const [type, stremioId] = tail(request).split("/");
    const id = engineIdOf(site, decodeURIComponent(stremioId ?? ""));
    if (!id) return { meta: null };
    const prefix = prefixOf(site);
    if (type === "movie") {
      const movie = getMovie(db, identity, id);
      if (!movie) return { meta: null };
      return {
        meta: {
          id: `${prefix}${movie.id}`,
          type: "movie",
          name: movie.title,
          poster: absoluteArt(site, movie.poster),
          background: absoluteArt(site, movie.backdrop),
          description: movie.plot ?? undefined,
          releaseInfo: movie.year ? String(movie.year) : undefined,
          runtime: movie.runtimeMinutes ? `${movie.runtimeMinutes} min` : undefined,
          genres: movie.genres
        }
      };
    }
    if (type === "series") {
      const show = getShow(db, identity, id);
      if (!show) return { meta: null };
      // Stremio sorts and dates episodes by `released`; one the files and TMDB
      // say nothing about still needs one.
      const undated = new Date(Date.UTC(1970, 0, 1)).toISOString();
      const videos = show.seasons.flatMap((season) => (season.episodes as { id: string; episode: number; title: string | null; plot: string | null; aired: string | null; still: string | null }[])
        .map((episode) => ({
          id: `${prefix}${episode.id}`,
          title: episode.title ?? `S${String(season.number).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")}`,
          season: season.number,
          episode: episode.episode,
          released: episode.aired && !Number.isNaN(Date.parse(episode.aired)) ? new Date(episode.aired).toISOString() : undated,
          overview: episode.plot ?? undefined,
          thumbnail: absoluteArt(site, episode.still) ?? undefined
        })));
      return {
        meta: {
          id: `${prefix}${show.id}`,
          type: "series",
          name: show.title,
          poster: absoluteArt(site, show.poster),
          background: absoluteArt(site, show.backdrop),
          description: show.plot ?? undefined,
          releaseInfo: show.year ? String(show.year) : undefined,
          genres: show.genres,
          videos
        }
      };
    }
    return { meta: null };
  });

  /** What Stremio needs about one film or episode: the file, and what is inside. */
  const lookUp = async (identity: Identity, site: Site, stremioId: string) => {
    const id = engineIdOf(site, stremioId);
    const item = id ? findItem(db, identity, id) : null;
    const file = item ? fileOf(deps.mediaRoot, item) : null;
    if (!item || !file) return null;
    const probe = await deps.probe();
    const info = probe ? await probe.info(item.id, file).catch(() => null) : null;
    return { item, file, info };
  };

  app.get(`${ROOT}/stream/*`, async (request, reply) => {
    const found = await context(request, reply);
    if (!found) return;
    const { identity, site } = found;
    const [, stremioId] = tail(request).split("/");
    const looked = await lookUp(identity, site, decodeURIComponent(stremioId ?? ""));
    if (!looked) return { streams: [] };
    const { item, file, info } = looked;
    const extension = path.extname(item.relative).toLowerCase();
    const binge = item.show ? { bingeGroup: `isputnik-${site.id}-${item.show.id}` } : {};
    const original = {
      name: "iSputnik",
      description: `Original · ${extension.slice(1).toUpperCase()}${info?.video ? ` · ${info.video.codec.toUpperCase()} ${info.video.height}p` : ""}`,
      url: `${site.base}/play/${item.id}`,
      behaviorHints: { notWebReady: extension !== ".mp4" && extension !== ".m4v", filename: path.basename(item.relative), videoSize: file.size, ...binge }
    };
    // A TV crashes on what it cannot decode: offer the converted picture first then.
    // ffmpeg has to have read the file for that; one it could not read plays as it is.
    const risk = deps.canConvert && info ? tvRisk(info) : null;
    if (!risk || !info) return { streams: [original] };
    const delivery = decideDelivery(info, extension);
    if (delivery.mode === "direct") return { streams: [original] };
    const converted = {
      name: "iSputnik",
      description: "Converted · H.264 for TVs",
      url: `${site.base}/hls/${item.id}/${deps.trackSegment(delivery)}/index.m3u8`,
      behaviorHints: { notWebReady: false, ...binge }
    };
    return { streams: [converted, original] };
  });

  app.get(`${ROOT}/subtitles/*`, async (request, reply) => {
    const found = await context(request, reply);
    if (!found) return;
    const { identity, site } = found;
    // The filename, videoSize and videoHash extras Stremio adds are not needed.
    const [, stremioId] = tail(request).split("/");
    const looked = await lookUp(identity, site, decodeURIComponent(stremioId ?? ""));
    if (!looked) return { subtitles: [] };
    // The files beside the video: the player shows the text tracks inside it itself.
    const tracks = listSubtitles(looked.info, looked.file.absolute).filter((track) => track.external && track.kind === "text");
    return {
      subtitles: tracks.map((track) => ({
        id: `${prefixOf(site)}${looked.item.id}:${track.id}`,
        lang: stremioLanguage(track.language),
        url: `${site.base}/subs/${looked.item.id}/${track.id}.vtt`
      }))
    };
  });

  // The bytes: the same handlers as home's player, under the token prefix.
  const guarded = (handler: RouteHandlerMethod): { preHandler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>; handler: RouteHandlerMethod } =>
    ({ preHandler: deps.requireIdentity, handler });
  app.get(`${ROOT}/play/:id`, guarded(deps.handlers.stream));
  app.get(`${ROOT}/hls/:id/:track/:name`, guarded(deps.handlers.hls));
  app.get(`${ROOT}/art/:id/:kind`, guarded(deps.handlers.art));
  app.get(`${ROOT}/subs/:id/:name`, guarded(deps.handlers.subtitle));
}
