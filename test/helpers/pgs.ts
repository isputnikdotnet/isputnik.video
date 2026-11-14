// A Blu-ray (PGS) subtitle track written by hand, as ffmpeg can't make one: a
// white box with a black border near the bottom of a 1920×1080 canvas, shown
// at each `[from, to]` second pair and taken away after.
import fs from "node:fs";

const WIDTH = 1920;
const HEIGHT = 1080;

function segment(kind: number, pts: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(13);
  head.write("PG", 0, "latin1");
  head.writeUInt32BE(pts, 2);
  head.writeUInt32BE(0, 6);
  head.writeUInt8(kind, 10);
  head.writeUInt16BE(payload.length, 11);
  return Buffer.concat([head, payload]);
}

/** The picture's run-length encoding, row by row, as PGS stores it. */
function runLengths(rows: number[][]): Buffer {
  const out: number[] = [];
  for (const row of rows) {
    for (let x = 0; x < row.length;) {
      const colour = row[x];
      let n = 1;
      while (x + n < row.length && row[x + n] === colour && n < 16383) n++;
      if (colour === 0) out.push(0, ...(n < 64 ? [n] : [0x40 | (n >> 8), n & 0xff]));
      else if (n < 3) for (let i = 0; i < n; i++) out.push(colour);
      else out.push(0, ...(n < 64 ? [0x80 | n] : [0xc0 | (n >> 8), n & 0xff]), colour);
      x += n;
    }
    out.push(0, 0);
  }
  return Buffer.from(out);
}

function displaySet(seconds: number, composition: number, shown: boolean): Buffer {
  const pts = Math.round(seconds * 90_000);
  const [w, h] = [800, 100];
  const [x, y] = [(WIDTH - w) / 2, HEIGHT - h - 80];
  const pcs = Buffer.alloc(shown ? 19 : 11);
  pcs.writeUInt16BE(WIDTH, 0);
  pcs.writeUInt16BE(HEIGHT, 2);
  pcs.writeUInt8(0x10, 4);
  pcs.writeUInt16BE(composition, 5);
  pcs.writeUInt8(shown ? 0x80 : 0, 7);
  pcs.writeUInt8(0, 8);
  pcs.writeUInt8(0, 9);
  pcs.writeUInt8(shown ? 1 : 0, 10);
  if (shown) {
    pcs.writeUInt16BE(0, 11);
    pcs.writeUInt8(0, 13);
    pcs.writeUInt8(0, 14);
    pcs.writeUInt16BE(x, 15);
    pcs.writeUInt16BE(y, 17);
  }
  const wds = Buffer.alloc(10);
  wds.writeUInt8(1, 0);
  wds.writeUInt8(0, 1);
  wds.writeUInt16BE(x, 2);
  wds.writeUInt16BE(y, 4);
  wds.writeUInt16BE(w, 6);
  wds.writeUInt16BE(h, 8);
  const parts = [segment(0x16, pts, pcs), segment(0x17, pts, wds)];
  if (shown) {
    // Colour 0 is see-through; 1 white and 2 black, both opaque (Y, Cr, Cb, alpha).
    const pds = Buffer.from([0, 0, 1, 235, 128, 128, 255, 2, 16, 128, 128, 255]);
    const rows = Array.from({ length: h }, (_, yy) =>
      Array.from({ length: w }, (_, xx) => (yy < 6 || yy >= h - 6 || xx < 6 || xx >= w - 6 ? 2 : 1)));
    const data = runLengths(rows);
    const ods = Buffer.alloc(11);
    ods.writeUInt16BE(0, 0);
    ods.writeUInt8(0, 2);
    ods.writeUInt8(0xc0, 3);
    ods.writeUIntBE(data.length + 4, 4, 3);
    ods.writeUInt16BE(w, 7);
    ods.writeUInt16BE(h, 9);
    parts.push(segment(0x14, pts, pds), segment(0x15, pts, Buffer.concat([ods, data])));
  }
  parts.push(segment(0x80, pts, Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** Writes a .sup file showing the box over each `[from, to]` stretch. */
export function writePgs(file: string, shown: [number, number][]): void {
  let composition = 0;
  fs.writeFileSync(file, Buffer.concat(shown.flatMap(([from, to]) => [displaySet(from, composition++, true), displaySet(to, composition++, false)])));
}
