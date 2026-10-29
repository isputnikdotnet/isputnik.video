// Which disks the engine's files sit on, for home's Dashboard: each library's
// folder, the catalog database, the poster cache and the conversion folder,
// grouped by the folder mapped into this container (docs: isputnik.home
// docs/dashboard-and-backups-plan.md → Disks). Home cannot see these: the
// video folders are mounted here, not on home. Measured when asked, nothing kept.
//
// Grouped by mount rather than by device: on Unraid every folder mapped from
// /mnt/user is one user-share filesystem with one device id, and grouping by
// device would draw them all as one bar named after whichever came first.
// Mounts of the same filesystem name each other in `sharesWith`.
import fs from "node:fs";
import path from "node:path";

export type DiskHolding =
  | { kind: "database" | "artwork" | "transcode"; path: string }
  | { kind: "library"; name: string; path: string };

export interface Disk {
  /** The top folder of the mount as this container sees it (`/media`). */
  mount: string;
  /** Which filesystem it is (the device id): only compared, never shown. */
  filesystem: string;
  freeBytes: number;
  totalBytes: number;
  holds: DiskHolding[];
  sharesWith: string[];
}

/** The path itself, or the nearest folder above it that exists. */
function existingAncestor(candidate: string): { dir: string; dev: number } | null {
  let current = path.resolve(candidate);
  for (;;) {
    try {
      return { dir: current, dev: fs.statSync(current).dev };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** Where a mount starts: climb while the parent is on the same device. */
function mountOf(dir: string, dev: number): string {
  let current = dir;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    try {
      if (fs.statSync(parent).dev !== dev) return current;
    } catch {
      return current;
    }
    current = parent;
  }
}

/** One entry per mount, biggest filesystem first; what cannot be measured is left out. */
export function groupByDisk(holds: DiskHolding[]): Disk[] {
  const byMount = new Map<string, Disk>();
  for (const hold of holds) {
    const where = existingAncestor(hold.path);
    if (!where) continue;
    const mount = mountOf(where.dir, where.dev);
    let disk = byMount.get(mount);
    if (!disk) {
      let stats: fs.StatsFs;
      try {
        stats = fs.statfsSync(where.dir);
      } catch {
        continue;
      }
      disk = {
        mount,
        filesystem: String(where.dev),
        freeBytes: Number(stats.bavail) * Number(stats.bsize),
        totalBytes: Number(stats.blocks) * Number(stats.bsize),
        holds: [],
        sharesWith: []
      };
      byMount.set(mount, disk);
    }
    disk.holds.push(hold);
  }
  const disks = [...byMount.values()];
  for (const disk of disks) {
    disk.sharesWith = disks.filter((other) => other !== disk && other.filesystem === disk.filesystem).map((other) => other.mount);
  }
  return disks.sort((x, y) => y.totalBytes - x.totalBytes || x.filesystem.localeCompare(y.filesystem) || x.mount.localeCompare(y.mount));
}
