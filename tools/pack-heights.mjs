// Packs the raw uint16 height grids into site/assets/*.pack (see site/lib/height-pack.js).
// Run: node tools/pack-heights.mjs   Exits 1 if any file does not round-trip byte for byte.
// Written with Claude Code (an AI coding agent) at the team's direction. See README.md, "Use of AI".
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { unpackHeights } from '../site/lib/height-pack.js';

const assets = fileURLToPath(new URL('../site/assets/', import.meta.url));
const inputs = [
  ['moon_height_8ppd', 2880, 1440],
  ['south_pole_625m', 1024, 1024],
];

function encode(src, w, h) {
  const n = w * h;
  const out = Buffer.alloc(12 + 2 * n);
  out.write('HPK1', 0, 'ascii');
  out.writeUInt32LE(w, 4);
  out.writeUInt32LE(h, 8);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      let p;
      if (x > 0 && y > 0) p = src[i - 1] + src[i - w] - src[i - w - 1];
      else if (y === 0 && x > 0) p = src[i - 1];
      else if (x === 0 && y > 0) p = src[i - w];
      else p = 0;
      const r = (src[i] - p) & 0xffff;
      const s = r >= 32768 ? r - 65536 : r;
      const z = s >= 0 ? 2 * s : -2 * s - 1;
      out[12 + i] = z >>> 8;
      out[12 + n + i] = z & 255;
    }
  }
  return gzipSync(out, { level: 9 });
}

let failed = false;
for (const [name, w, h] of inputs) {
  const raw = readFileSync(assets + name + '.u16');
  if (raw.length !== w * h * 2) throw new Error(`${name}: expected ${w * h * 2} bytes, got ${raw.length}`);
  const src = new Uint16Array(raw.buffer, raw.byteOffset, w * h);
  const t0 = performance.now();
  const packed = encode(src, w, h);
  const encMs = performance.now() - t0;
  writeFileSync(assets + name + '.pack', packed);

  const ab = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.length);
  const times = [];
  let res;
  for (let k = 0; k < 5; k++) {
    const t = performance.now();
    res = await unpackHeights(ab);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const back = Buffer.from(res.u16.buffer, res.u16.byteOffset, res.u16.byteLength);
  const same = res.w === w && res.h === h && back.equals(raw);
  if (!same) failed = true;
  console.log(`${name}: input ${raw.length} B, packed ${packed.length} B, encode ${encMs.toFixed(0)} ms, decode ${times[2].toFixed(1)} ms, bytes identical: ${same ? 'yes' : 'no'}`);
}
process.exit(failed ? 1 : 0);
