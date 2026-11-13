// What home's diagnostics report asks of this engine (GET /admin/diagnostics):
// the facts that make a bug report answerable without a shell on the host —
// versions, the machine, ffmpeg, what the GPU check found and the GPU's recent
// failures, how conversion is set up, the libraries' counts and states, and the
// recent warnings and errors in the log.
//
// Everything is sent as it is, names and paths included: home is the one place
// that hides them (its report redacts unless the admin opts in), so the rules
// for what is private live in one repository. Only an admin gets here, and
// nothing leaves home unless the admin copies the report out.
import { execFile } from "node:child_process";
import os from "node:os";
import type { Tools } from "./ffmpeg.js";
import type { LogBuffer } from "./log-buffer.js";

/** How many of the log's warnings and errors go in. */
export const LOG_LINES = 60;

/** The machine this engine runs on. */
export function systemFacts(): Record<string, unknown> {
  const cpus = os.cpus();
  return {
    node: process.version,
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpus: cpus.length,
    cpuModel: cpus[0]?.model?.trim() ?? null,
    memoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    rssBytes: process.memoryUsage().rss,
    uptimeSeconds: Math.floor(process.uptime()),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  };
}

let ffmpegVersion: Promise<string | null> | null = null;

/** ffmpeg's first line of -version ("ffmpeg version 7.1.1-1 Copyright …"), asked once. */
export function ffmpegVersionOf(tools: Tools | null): Promise<string | null> {
  if (!tools) return Promise.resolve(null);
  ffmpegVersion ??= new Promise((resolve) => {
    execFile(tools.ffmpeg, ["-hide_banner", "-version"], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).split(/\r?\n/)[0]?.replace(/\s+Copyright.*$/, "").trim() || null);
    });
  });
  return ffmpegVersion;
}

/** The log's warnings and errors (pino level 40 and up), newest last. */
export function problemLines(buffer: LogBuffer | undefined, count = LOG_LINES): string[] {
  if (!buffer) return [];
  return buffer.tail(buffer.capacity).filter((line) => {
    try {
      return Number((JSON.parse(line) as { level?: number }).level) >= 40;
    } catch {
      return false;
    }
  }).slice(-count);
}
