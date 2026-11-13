// How fast copies go to people away from home (home's docs/video-cache-plan.md
// C4): one bucket for every such download together, so a family member fetching
// films on holiday can't take the whole upload link from someone streaming.
// Streams themselves are never held back by it.
import { Transform } from "node:stream";

export class Bucket {
  private tokens = 0;
  private last = Date.now();

  /** `rate`: bytes a second now (the admin may change it); 0 lets everything through. */
  constructor(private rate: () => number) {}

  /** Waits until `bytes` may go. */
  async take(bytes: number): Promise<void> {
    for (;;) {
      const rate = this.rate();
      if (rate <= 0) return;
      const now = Date.now();
      this.tokens = Math.min(rate, this.tokens + ((now - this.last) / 1000) * rate);
      this.last = now;
      // A chunk larger than a second's worth goes once the bucket is full.
      if (this.tokens >= Math.min(bytes, rate)) {
        this.tokens -= bytes;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(10, Math.ceil(((Math.min(bytes, rate) - this.tokens) / rate) * 1000))));
    }
  }
}

/** A stream that lets bytes through no faster than the bucket allows. */
export function throttled(bucket: Bucket): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bucket.take(chunk.length).then(() => done(null, chunk), done);
    }
  });
}
