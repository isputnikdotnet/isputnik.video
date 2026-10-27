import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSecret } from "./identity.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageInfo = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as {
  version: string;
  stage?: string;
  description: string;
};

/** Everything this engine answers lives under this prefix on the home origin. */
export const BASE_PATH = "/video";

const production = process.env.NODE_ENV === "production";
const gatewaySecret = process.env.GATEWAY_SECRET?.trim() || null;

// The gateway secret is the only thing standing between this server and anyone
// who can reach its port, so the image refuses to run without a good one; a
// source checkout without one is development and gets the developer identity.
const secretProblem = checkSecret(gatewaySecret, production);
if (secretProblem) throw new Error(secretProblem);

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 4300),
  /** The catalog (the image sets /config/video.sqlite). */
  dbPath: process.env.DB_PATH ?? path.join(rootDir, "data", "video.sqlite"),
  /** Where the video folders are mounted, read-only (the image: /media). Every
   *  library folder is a path under it. */
  mediaRoot: process.env.MEDIA_ROOT ?? path.join(rootDir, "data", "media"),
  /** Where segments are made while someone watches; emptied on start. Fast
   *  local disk or RAM is best (the image: /transcode). */
  transcodeDir: process.env.TRANSCODE_PATH?.trim() || path.join(os.tmpdir(), "isputnik-video-hls"),
  /** Posters and backdrops fetched from TMDB; beside the catalog unless ART_PATH
   *  says otherwise (the image: /config/art). Not backed up: fetched again. */
  artDir: process.env.ART_PATH?.trim() || path.join(path.dirname(process.env.DB_PATH ?? path.join(rootDir, "data", "video.sqlite")), "art"),
  gatewaySecret,
  /** Development only: who the server pretends is signed in when no secret is set, "id:name". */
  devUser: process.env.DEV_USER ?? "dev:Developer",
  production,
  version: packageInfo.version,
  stage: packageInfo.stage ?? null
};
