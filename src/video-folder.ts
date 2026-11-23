// The folder for video, chosen in home instead of in the container's settings
// (home's Videos › Settings › Disk & memory › Change). Until one is chosen it is
// TRANSCODE_PATH — the Unraid template's Transcode mapping — as before.
//
// The admin names a PLACE the container can already see — a disk mapped into
// it: beside the libraries, or on the cache drive — and the engine works in a
// folder of its own inside it, VIDEO_FOLDER. Its own, because the conversion
// folder is emptied on every start (hls.ts prepareRoot), and because inside a
// library it is the one folder the scanner passes over (media.ts IGNORED).
//
// Never the catalog's folder (the image's /config): what is kept there is
// backed up with the catalog, and tens of GB of video that can be made again
// have no place in a backup (owner, 2026-11-22). Nothing is offered by default
// either: the admin says where.
//
// A choice is in force from the next start: the folder is handed to everything
// that keeps video (hls.ts, copies.ts, cache.ts) once, while the app is built.
import fs from "node:fs";
import path from "node:path";
import { isInside, mountOf, parseMountinfo, type MountEntry } from "./mounts.js";

/** The engine's own folder inside the place the admin chose; media.ts IGNORED names it too. */
export const VIDEO_FOLDER = "video-cache";

/** Where video is kept when `place` is chosen. */
export const videoRootIn = (place: string) => path.join(place, VIDEO_FOLDER);

/** Mounts that are no disk: the kernel's own, and memory. */
const NOT_DISKS = new Set(["proc", "sysfs", "devpts", "devtmpfs", "tmpfs", "mqueue", "cgroup", "cgroup2", "overlay", "shm", "nsfs", "securityfs", "debugfs", "tracefs", "pstore", "bpf", "autofs", "hugetlbfs", "fusectl", "configfs", "binfmt_misc"]);
const SYSTEM_FOLDERS = ["/proc", "/sys", "/dev", "/etc", "/run", "/usr", "/var/run"];

/** The disks mapped into a container, from its mountinfo: every mount that is
 *  a real filesystem, outside the system's own folders and the catalog's. */
export function diskMounts(entries: MountEntry[], catalogDir: string | null): string[] {
  const found: string[] = [];
  for (const entry of entries) {
    const point = entry.mountPoint;
    if (point === "/" || NOT_DISKS.has(entry.fsType)) continue;
    if (SYSTEM_FOLDERS.some((folder) => point === folder || point.startsWith(`${folder}/`))) continue;
    if (catalogDir && isInside(point, catalogDir)) continue;
    if (!found.includes(point)) found.push(point);
  }
  return found;
}

function writable(folder: string): boolean {
  try {
    if (!fs.statSync(folder).isDirectory()) return false;
    fs.accessSync(folder, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** A location home's folder picker opens on (as Add library opens on a storage
 *  container): the libraries' folder, the container's cache folder, or another
 *  disk mapped into it. */
export interface FolderPlace {
  /** Its name in the picker's addresses: "libraries", "cache", "disk-1"… */
  id: string;
  kind: "libraries" | "cache" | "disk";
  path: string;
  /** Whether the engine may write there; the template maps the libraries read-only. */
  writable: boolean;
}

/** The locations to offer, in the order people think of them: where the libraries
 *  are, the cache folder the container was given (its Video Cache mapping), then
 *  any other disk mapped into it. Never the catalog's folder. */
export function folderPlaces(options: { mediaRoot: string; containerFolder: string | null; catalogDir: string | null; mountinfo: string | null; isMapped: (folder: string) => boolean }): FolderPlace[] {
  const places: FolderPlace[] = [];
  const has = (folder: string) => places.some((place) => isInside(folder, place.path));
  const isFolder = (folder: string) => { try { return fs.statSync(folder).isDirectory(); } catch { return false; } };
  if (isFolder(options.mediaRoot)) places.push({ id: "libraries", kind: "libraries", path: options.mediaRoot, writable: writable(options.mediaRoot) });
  if (options.containerFolder && isFolder(options.containerFolder) && options.isMapped(options.containerFolder) && !has(options.containerFolder)) {
    places.push({ id: "cache", kind: "cache", path: options.containerFolder, writable: writable(options.containerFolder) });
  }
  let extra = 0;
  for (const mount of options.mountinfo ? diskMounts(parseMountinfo(options.mountinfo), options.catalogDir) : []) {
    if (has(mount) || !isFolder(mount) || !options.isMapped(mount)) continue;
    extra += 1;
    places.push({ id: `disk-${extra}`, kind: "disk", path: mount, writable: writable(mount) });
  }
  return places;
}

/** This container's mountinfo; null outside Linux. */
export function readMountinfo(): string | null {
  try {
    return process.platform === "linux" ? fs.readFileSync("/proc/self/mountinfo", "utf8") : null;
  } catch {
    return null;
  }
}

/** The mount a folder is on, for telling the admin which disk they chose. */
export function mountPointOf(folder: string, mountinfo: string | null): string | null {
  return mountinfo ? mountOf(folder, parseMountinfo(mountinfo))?.mountPoint ?? null : null;
}

/** Why `place` can't hold video, in words for the admin; null when it can.
 *  Makes the engine's folder inside it, which proves it can be written to. */
export function folderProblem(place: string, options: { mediaRoot: string; catalogDir: string | null; isMapped: (folder: string) => boolean }): string | null {
  if (!path.isAbsolute(place)) return "Give the folder's full path, starting from the root.";
  if (options.catalogDir && isInside(place, options.catalogDir)) return "That is the video container's Config & Data folder, which is backed up. Choose a folder with your libraries or on the cache drive instead.";
  try {
    if (!fs.statSync(place).isDirectory()) return "That is a file, not a folder.";
  } catch {
    return "The video container can't see that folder. It can only use folders mapped into it.";
  }
  if (!options.isMapped(place)) return "That folder is inside the container itself, not on a disk mapped into it. Video kept there would fill the container.";
  const root = videoRootIn(place);
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.rmdirSync(fs.mkdtempSync(path.join(root, "check-")));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "refused";
    // The template maps the libraries read-only: the engine can't keep video among them as it is.
    if (isInside(place, options.mediaRoot)) return `The video container can't write to its Video Folders (${code}): they are mapped read-only. Map a folder beside your libraries to the container's Video Cache field instead.`;
    return `The video container can't write to that folder (${code}).`;
  }
  return null;
}
