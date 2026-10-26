// The last lines of the server log, in memory, for the admin to read from the
// home app (GET /video/api/admin/log). pino writes every line here; the buffer
// passes it on to stdout — where Docker collects it as before — and keeps the
// newest few hundred. A container that is misbehaving right now can then be
// looked at from Control panel → Apps → Logs, without a shell on the host.
// Lost on restart, by design: the durable record is the events table.

export interface LogBuffer {
  readonly capacity: number;
  /** pino calls this with one or more newline-terminated JSON lines. */
  write(chunk: string): void;
  /** The newest `count` lines, oldest first. */
  tail(count: number): string[];
}

interface Sink {
  write(chunk: string): unknown;
}

export function createLogBuffer(capacity = 500, sink: Sink = process.stdout): LogBuffer {
  const lines: string[] = new Array<string>(capacity);
  let next = 0;
  let stored = 0;
  return {
    capacity,
    write(chunk) {
      sink.write(chunk);
      for (const line of String(chunk).split("\n")) {
        if (!line) continue;
        lines[next] = line;
        next = (next + 1) % capacity;
        if (stored < capacity) stored++;
      }
    },
    tail(count) {
      const take = Math.max(0, Math.min(count, stored));
      const out: string[] = [];
      for (let i = stored - take; i < stored; i++) out.push(lines[(next - stored + i + capacity) % capacity]);
      return out;
    }
  };
}
