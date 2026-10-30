// The Movie Database (themoviedb.org): descriptions, posters, backdrops and
// episode stills for what the scan found (metadata.ts). The admin gives the
// engine a key from their own TMDB account in home (Control panel → Apps); the
// engine asks nothing of TMDB without one.
//
// A v3 "API key" (32 hex characters) goes in the query; a v4 "read access
// token" (a long JWT) as a bearer token. Either works for everything here.
import { z } from "zod";

const API = "https://api.themoviedb.org/3";
const IMAGES = "https://image.tmdb.org/t/p";
const TIMEOUT_MS = 15_000;

export type Fetch = typeof fetch;

export class TmdbError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
  }
}

/** Sizes asked for: a poster for cards, a backdrop for the title page, a still for an episode row. */
export const IMAGE_SIZES = { poster: "w500", backdrop: "w1280", still: "w300", thumb: "w185" } as const;

/** An image path as TMDB gives it: "/abc123.jpg". */
export const imagePathSchema = z.string().regex(/^\/[A-Za-z0-9_-]{1,64}\.(jpg|jpeg|png|webp)$/);

const searchSchema = z.object({
  results: z.array(z.object({
    id: z.number(),
    title: z.string().optional(),
    name: z.string().optional(),
    original_title: z.string().optional(),
    original_name: z.string().optional(),
    release_date: z.string().optional().nullable(),
    first_air_date: z.string().optional().nullable(),
    overview: z.string().optional().nullable(),
    poster_path: z.string().nullable().optional()
  }).passthrough())
});

const genreList = z.array(z.object({ name: z.string() })).optional();

const movieSchema = z.object({
  id: z.number(),
  title: z.string().optional(),
  original_title: z.string().optional(),
  overview: z.string().nullable().optional(),
  release_date: z.string().nullable().optional(),
  genres: genreList,
  vote_average: z.number().nullable().optional(),
  runtime: z.number().nullable().optional(),
  poster_path: z.string().nullable().optional(),
  backdrop_path: z.string().nullable().optional(),
  belongs_to_collection: z.object({ id: z.number(), name: z.string().optional() }).passthrough().nullable().optional()
}).passthrough();

const collectionSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  overview: z.string().nullable().optional(),
  poster_path: z.string().nullable().optional(),
  backdrop_path: z.string().nullable().optional(),
  parts: z.array(z.object({ id: z.number(), release_date: z.string().nullable().optional() }).passthrough()).default([])
}).passthrough();

const showSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  original_name: z.string().optional(),
  overview: z.string().nullable().optional(),
  first_air_date: z.string().nullable().optional(),
  genres: genreList,
  vote_average: z.number().nullable().optional(),
  status: z.string().nullable().optional(),
  poster_path: z.string().nullable().optional(),
  backdrop_path: z.string().nullable().optional()
}).passthrough();

const seasonSchema = z.object({
  episodes: z.array(z.object({
    episode_number: z.number(),
    name: z.string().nullable().optional(),
    overview: z.string().nullable().optional(),
    air_date: z.string().nullable().optional(),
    still_path: z.string().nullable().optional(),
    runtime: z.number().nullable().optional()
  }).passthrough()).default([])
}).passthrough();

const findSchema = z.object({
  movie_results: z.array(z.object({ id: z.number() }).passthrough()).default([]),
  tv_results: z.array(z.object({ id: z.number() }).passthrough()).default([])
}).passthrough();

export type TmdbKind = "movie" | "tv";

export interface TmdbSearchResult {
  tmdbId: string;
  title: string;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
}

export interface TmdbDetails {
  tmdbId: string;
  title: string | null;
  originalTitle: string | null;
  plot: string | null;
  year: number | null;
  aired: string | null;
  genres: string[];
  rating: number | null;
  status: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  /** The collection a film belongs to (sets.ts); always null for a show. */
  collection: { tmdbId: string; name: string | null } | null;
}

export interface TmdbCollection {
  tmdbId: string;
  name: string | null;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  /** Every film of it, with its release date: the set's order. */
  parts: { tmdbId: string; released: string | null }[];
}

export interface TmdbEpisode {
  episode: number;
  title: string | null;
  plot: string | null;
  aired: string | null;
  stillPath: string | null;
}

const yearOf = (date: string | null | undefined): number | null => {
  const year = date ? Number(date.slice(0, 4)) : NaN;
  return Number.isInteger(year) && year > 1800 ? year : null;
};
const text = (value: string | null | undefined): string | null => (value && value.trim() ? value.trim() : null);

/** Whether `key` reads as a v4 read access token rather than a v3 key. */
const isBearer = (key: string) => key.length > 40 && key.split(".").length === 3;

export class Tmdb {
  constructor(private key: string, private fetchImpl: Fetch = fetch) {}

  private async get<T>(path: string, params: Record<string, string | number | undefined>, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(`${API}${path}`);
    for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
    const headers: Record<string, string> = { accept: "application/json" };
    if (isBearer(this.key)) headers.authorization = `Bearer ${this.key}`;
    else url.searchParams.set("api_key", this.key);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new TmdbError(`TMDB did not answer: ${(err as Error).message}`);
    }
    if (response.status === 401) throw new TmdbError("TMDB refused the key", 401);
    if (response.status === 404) throw new TmdbError("Not on TMDB", 404);
    if (response.status === 429) throw new TmdbError("TMDB asked to slow down", 429);
    if (!response.ok) throw new TmdbError(`TMDB answered ${response.status}`, response.status);
    return schema.parse(await response.json());
  }

  /** Whether the key works: TMDB's own check. */
  async check(): Promise<void> {
    await this.get("/configuration", {}, z.object({}).passthrough());
  }

  async search(kind: TmdbKind, query: string, year: number | null, language: string): Promise<TmdbSearchResult[]> {
    const yearParam = kind === "movie" ? { year: year ?? undefined } : { first_air_date_year: year ?? undefined };
    const found = await this.get(`/search/${kind}`, { query, language, include_adult: "false", ...yearParam }, searchSchema);
    return found.results.slice(0, 20).map((result) => ({
      tmdbId: String(result.id),
      title: result.title ?? result.name ?? "",
      originalTitle: result.original_title ?? result.original_name ?? null,
      year: yearOf(result.release_date ?? result.first_air_date),
      overview: text(result.overview),
      posterPath: result.poster_path ?? null
    }));
  }

  /** The TMDB id of an IMDb id, for a movie or a show; null when TMDB doesn't know it. */
  async findByImdb(kind: TmdbKind, imdbId: string): Promise<string | null> {
    const found = await this.get(`/find/${encodeURIComponent(imdbId)}`, { external_source: "imdb_id" }, findSchema);
    const hit = kind === "movie" ? found.movie_results[0] : found.tv_results[0];
    return hit ? String(hit.id) : null;
  }

  async details(kind: TmdbKind, tmdbId: string, language: string): Promise<TmdbDetails> {
    if (kind === "movie") {
      const movie = await this.get(`/movie/${encodeURIComponent(tmdbId)}`, { language }, movieSchema);
      return {
        tmdbId: String(movie.id),
        title: text(movie.title),
        originalTitle: text(movie.original_title),
        plot: text(movie.overview),
        year: yearOf(movie.release_date),
        aired: text(movie.release_date),
        genres: (movie.genres ?? []).map((genre) => genre.name),
        rating: movie.vote_average ?? null,
        status: null,
        posterPath: movie.poster_path ?? null,
        backdropPath: movie.backdrop_path ?? null,
        collection: movie.belongs_to_collection
          ? { tmdbId: String(movie.belongs_to_collection.id), name: text(movie.belongs_to_collection.name) }
          : null
      };
    }
    const show = await this.get(`/tv/${encodeURIComponent(tmdbId)}`, { language }, showSchema);
    return {
      tmdbId: String(show.id),
      title: text(show.name),
      originalTitle: text(show.original_name),
      plot: text(show.overview),
      year: yearOf(show.first_air_date),
      aired: text(show.first_air_date),
      genres: (show.genres ?? []).map((genre) => genre.name),
      rating: show.vote_average ?? null,
      status: text(show.status),
      posterPath: show.poster_path ?? null,
      backdropPath: show.backdrop_path ?? null,
      collection: null
    };
  }

  /** A collection of films: its words, its art and its parts. */
  async collection(tmdbId: string, language: string): Promise<TmdbCollection> {
    const found = await this.get(`/collection/${encodeURIComponent(tmdbId)}`, { language }, collectionSchema);
    return {
      tmdbId: String(found.id),
      name: text(found.name),
      overview: text(found.overview),
      posterPath: found.poster_path ?? null,
      backdropPath: found.backdrop_path ?? null,
      parts: found.parts.map((part) => ({ tmdbId: String(part.id), released: text(part.release_date) }))
    };
  }

  /** A season's episodes; empty when TMDB has no such season. */
  async season(tmdbId: string, season: number, language: string): Promise<TmdbEpisode[]> {
    try {
      const found = await this.get(`/tv/${encodeURIComponent(tmdbId)}/season/${season}`, { language }, seasonSchema);
      return found.episodes.map((episode) => ({
        episode: episode.episode_number,
        title: text(episode.name),
        plot: text(episode.overview),
        aired: text(episode.air_date),
        stillPath: episode.still_path ?? null
      }));
    } catch (err) {
      if (err instanceof TmdbError && err.status === 404) return [];
      throw err;
    }
  }

  /** An image's bytes. TMDB's image host needs no key. */
  async image(imagePath: string, size: string): Promise<Buffer> {
    if (!imagePathSchema.safeParse(imagePath).success) throw new TmdbError("Not a TMDB image");
    let response: Response;
    try {
      response = await this.fetchImpl(`${IMAGES}/${size}${imagePath}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new TmdbError(`TMDB's images did not answer: ${(err as Error).message}`);
    }
    if (!response.ok) throw new TmdbError(`TMDB's images answered ${response.status}`, response.status);
    return Buffer.from(await response.arrayBuffer());
  }
}
