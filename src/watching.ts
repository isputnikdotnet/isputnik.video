// What is being played and downloaded right now, for home's Diagnostics › Video
// "Watching now" (GET /admin/watching). Converted video has its viewers in
// hls.ts already; a file played as it is (GET /stream/:id) and a copy fetched
// for offline (GET /copies/:id/file) are only byte ranges, so they are counted
// here: one play per person, title and device, alive while a request is open or
// for a little after the last one (a player reads ahead, then pauses).
//
// In memory only, and nothing about a play outlives it: who watched what stays
// the watch history's business (progress), not this.

/** A play with no request open is still on for this long after its last one. */
const IDLE_MS = 60_000;

export type PlayKind = "direct" | "download";

export interface DirectPlay {
  kind: PlayKind;
  user: string;
  userId: string;
  itemId: string;
  title: string;
  network: string;
  device: string;
  since: string;
  lastSeen: string;
  /** Bytes sent so far in this play. */
  bytes: number;
}

interface Tracked extends Omit<DirectPlay, "since" | "lastSeen"> {
  since: number;
  lastSeen: number;
  open: number;
}

/** A device in a word, from its User-Agent: enough to tell the TV from a phone. */
export function deviceOf(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  if (/isputnik-tv|Android TV|AFT[A-Z]|BRAVIA|SMART-TV|Tizen|Web0S/i.test(ua)) return "TV";
  if (/iPad|Tablet/i.test(ua)) return "Tablet";
  if (/iPhone|Android.*Mobile|Mobile Safari/i.test(ua)) return "Phone";
  if (/Android/i.test(ua)) return "Tablet";
  if (ua) return "Browser";
  return "Unknown";
}

export class Watching {
  private plays = new Map<string, Tracked>();

  constructor(private now: () => number = Date.now) {}

  /** A request for a range of a file began; call the returned function when it ends. */
  begin(play: Omit<DirectPlay, "since" | "lastSeen" | "bytes">): { sent(bytes: number): void; end(): void } {
    const key = `${play.kind}|${play.userId}|${play.itemId}|${play.device}`;
    const at = this.now();
    let tracked = this.plays.get(key);
    if (!tracked || (tracked.open === 0 && at - tracked.lastSeen > IDLE_MS)) {
      tracked = { ...play, since: at, lastSeen: at, bytes: 0, open: 0 };
      this.plays.set(key, tracked);
    }
    tracked.open += 1;
    tracked.lastSeen = at;
    const mine = tracked;
    let ended = false;
    return {
      sent: (bytes) => { mine.bytes += bytes; mine.lastSeen = this.now(); },
      end: () => {
        if (ended) return;
        ended = true;
        mine.open = Math.max(0, mine.open - 1);
        mine.lastSeen = this.now();
      }
    };
  }

  /** The plays going on now, newest first; finished ones are forgotten. */
  current(): DirectPlay[] {
    const at = this.now();
    const out: DirectPlay[] = [];
    for (const [key, play] of this.plays) {
      if (play.open === 0 && at - play.lastSeen > IDLE_MS) {
        this.plays.delete(key);
        continue;
      }
      const { open: _open, since, lastSeen, ...rest } = play;
      out.push({ ...rest, since: new Date(since).toISOString(), lastSeen: new Date(lastSeen).toISOString() });
    }
    return out.sort((a, b) => b.since.localeCompare(a.since));
  }
}
