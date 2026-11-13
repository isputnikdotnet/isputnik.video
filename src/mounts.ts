// Whether a folder is a disk the admin mapped into the container, or only the
// container's own filesystem (home's docs/video-cache-plan.md → Storage).
//
// The Unraid template's Transcode path is optional. Left empty, /transcode is a
// folder inside the container — on Unraid that is docker.img — and everything
// written there fills it. So the engine writes video to a folder only when it
// is a mount of its own: in a container, read from /proc/self/mountinfo (the
// mount holding the folder is not the root filesystem). On a Linux host with no
// container every folder is a real disk; elsewhere (development) a
// TRANSCODE_PATH that was set counts as mapped.
import fs from "node:fs";
import path from "node:path";

export interface MountEntry {
  /** Where it is mounted, as this process sees it. */
  mountPoint: string;
  /** ext4, xfs, tmpfs, fuse.shfs, overlay… */
  fsType: string;
}

/** The mounts in a mountinfo text (proc(5)): field 5 is the mount point, the
 *  filesystem type follows the " - " separator. Octal escapes (\040 for a
 *  space) are undone. */
export function parseMountinfo(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const [before, after] = line.split(" - ");
    if (!before || !after) continue;
    const fields = before.trim().split(" ");
    const mountPoint = fields[4];
    const fsType = after.trim().split(" ")[0];
    if (!mountPoint || !fsType) continue;
    entries.push({ mountPoint: mountPoint.replace(/\\([0-7]{3})/g, (_m, octal: string) => String.fromCharCode(parseInt(octal, 8))), fsType });
  }
  return entries;
}

/** The mount a folder lives on: the longest mount point that holds it. The
 *  last of equal mount points wins, as it does in the kernel (mounted over). */
export function mountOf(folder: string, entries: MountEntry[]): MountEntry | null {
  const target = path.posix.normalize(folder.replace(/\\/g, "/"));
  let best: MountEntry | null = null;
  for (const entry of entries) {
    const point = entry.mountPoint;
    const holds = point === "/" || target === point || target.startsWith(point.endsWith("/") ? point : `${point}/`);
    if (holds && (!best || point.length >= best.mountPoint.length)) best = entry;
  }
  return best;
}

/** A disk of its own: a mount other than the container's root. */
export function isMappedIn(folder: string, mountinfo: string): boolean {
  const mount = mountOf(folder, parseMountinfo(mountinfo));
  return mount !== null && mount.mountPoint !== "/";
}

/** Docker (/.dockerenv) or Podman (/run/.containerenv). */
export function inContainer(): boolean {
  return fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv");
}

/** Whether `folder` is a disk mapped into this container (see above). Run
 *  straight on a Linux host, every folder is a real disk. */
export function isMapped(folder: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== "linux") return Boolean(env.TRANSCODE_PATH?.trim());
  if (!inContainer()) return true;
  try {
    return isMappedIn(fs.realpathSync(folder), fs.readFileSync("/proc/self/mountinfo", "utf8"));
  } catch {
    return false;
  }
}

/** `inner` is `outer` or a folder inside it. */
export function isInside(inner: string, outer: string): boolean {
  const relative = path.relative(path.resolve(outer), path.resolve(inner));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
