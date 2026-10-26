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

/** The sub-folders of a folder under the root, for Add library's folder picker. */
export function listFolders(root: string, relative: string): { path: string; folders: FolderEntry[] } | null {
  const dir = resolveInside(root, relative);
  if (!dir || !fs.statSync(dir).isDirectory()) return null;
  const base = normalizeRelative(relative);
  const folders = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !isIgnoredName(entry.name))
    .map((entry) => {
      let count = 0;
      try {
        count = fs.readdirSync(path.join(dir, entry.name), { withFileTypes: true }).filter((child) => child.isDirectory() && !isIgnoredName(child.name)).length;
      } catch {
        // Unreadable: listed, with nothing inside it known.
      }
      return { name: entry.name, path: base ? `${base}/${entry.name}` : entry.name, folders: count };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  return { path: base, folders };
}
