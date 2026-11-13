// The video folders, mounted read-only at MEDIA_ROOT. Every path the engine is
// given — a library's folder from home, a folder the picker asks to open — is
// relative to it, and must stay inside it once resolved, symlinks included.
// This server never writes there.
import fs from "node:fs";
import path from "node:path";

export const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".m4v", ".avi", ".mov", ".ts", ".m2ts", ".webm", ".wmv", ".mpg", ".mpeg"]);

/** Folders a NAS or a desktop leaves behind that are never media. */
const IGNORED = /^(\.|@eaDir$|#recycle$|\$RECYCLE\.BIN$|System Volume Information$|lost\+found$)/i;

export function isIgnoredName(name: string): boolean {
  return IGNORED.test(name);
}

export function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/** A relative path as stored and sent: forward slashes, no leading or trailing slash. */
export function normalizeRelative(relative: string): string {
  return relative.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".").join("/");
}

/** The absolute path of `relative` under the root, or null when it would leave
 *  the root (`..`, an absolute path, a symlink pointing out) or does not exist. */
export function resolveInside(root: string, relative: string): string | null {
  const clean = normalizeRelative(relative);
  if (clean.split("/").some((part) => part === "..")) return null;
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  const candidate = path.resolve(realRoot, clean);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  const inside = real === realRoot || real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);
  return inside ? real : null;
}

export interface FolderEntry {
  name: string;
  /** Relative to the media root. */
  path: string;
  /** Sub-folders inside it, for the picker's hint ("42 folders"). */
  folders: number;
}

/** resolveInside without holding the engine: a disk that has spun down answers
 *  a lookup only once it is up again, and everyone else would wait for it. */
export async function resolveInsideAsync(root: string, relative: string): Promise<string | null> {
  const clean = normalizeRelative(relative);
  if (clean.split("/").some((part) => part === "..")) return null;
  let realRoot: string;
  let real: string;
  try {
    realRoot = await fs.promises.realpath(root);
    real = await fs.promises.realpath(path.resolve(realRoot, clean));
  } catch {
    return null;
  }
  const inside = real === realRoot || real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);
  return inside ? real : null;
}

/** Runs `work` over the items at most `width` at a time, in their order. */
export async function inTurns<T, R>(items: readonly T[], width: number, work: (item: T, at: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await work(items[at], at);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
  return results;
}

/** The sub-folders of a folder under the root, for Add library's folder picker.
 *  A folder of 2000 films is 2000 listings, so they are made a few at a time
 *  without holding the engine. */
export async function listFolders(root: string, relative: string): Promise<{ path: string; folders: FolderEntry[] } | null> {
  const dir = await resolveInsideAsync(root, relative);
  if (!dir) return null;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const base = normalizeRelative(relative);
  const subfolders = entries.filter((entry) => entry.isDirectory() && !isIgnoredName(entry.name));
  const folders = await inTurns(subfolders, 8, async (entry) => {
    let count = 0;
    try {
      count = (await fs.promises.readdir(path.join(dir, entry.name), { withFileTypes: true })).filter((child) => child.isDirectory() && !isIgnoredName(child.name)).length;
    } catch {
      // Unreadable: listed, with nothing inside it known.
    }
    return { name: entry.name, path: base ? `${base}/${entry.name}` : entry.name, folders: count };
  });
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  return { path: base, folders };
}
