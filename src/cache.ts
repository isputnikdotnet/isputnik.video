// One limit for everything the engine keeps on its disk (home's
// docs/video-cache-plan.md → One limit): the copies made for download
// (copies.ts) and the films converted all the way through while someone
// watched (hls.ts, cache/). Past the limit, whatever was used longest ago
// goes first — never something being watched or just made.

export interface KeptThing {
  kind: "copy" | "film";
  id: string;
  sizeBytes: number;
  /** ISO time it was last wanted. */
  usedAt: string;
  /** Being watched, or just made: never removed. */
  held: boolean;
}

/** What to remove so the rest fit under `limitBytes`, oldest first. */
export function overLimit(things: KeptThing[], limitBytes: number): KeptThing[] {
  let used = things.reduce((sum, thing) => sum + thing.sizeBytes, 0);
  const going: KeptThing[] = [];
  for (const thing of [...things].sort((a, b) => a.usedAt.localeCompare(b.usedAt))) {
    if (used <= limitBytes) break;
    if (thing.held) continue;
    going.push(thing);
    used -= thing.sizeBytes;
  }
  return going;
}
