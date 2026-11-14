// Packed height grid format (.pack), read by unpackHeights().
// The whole file is one gzip stream. Inside it:
//   4 bytes   ASCII "HPK1"
//   4 bytes   width,  uint32 little-endian
//   4 bytes   height, uint32 little-endian
//   w*h bytes high byte of every residual, row by row
//   w*h bytes low byte of every residual, row by row
// A residual is the sample minus a prediction, zigzag coded so small errors
// give small numbers. The prediction is left + up - upleft. On row 0 it is
// the left sample, on column 0 it is the sample above, at (0,0) it is 0.
// All arithmetic is mod 65536, so the result is lossless for any input.
//
// src is the file as an ArrayBuffer, or a fetch response's body stream. A stream is unzipped while it downloads,
// which takes about 28 ms of the global grid's decode off the wait after the last byte (M1).

export async function unpackHeights(src) {
  const stream = (src instanceof ArrayBuffer ? new Blob([src]).stream() : src).pipeThrough(new DecompressionStream('gzip'));
  const d = new Uint8Array(await new Response(stream).arrayBuffer());
  if (d[0] !== 0x48 || d[1] !== 0x50 || d[2] !== 0x4b || d[3] !== 0x31) {
    throw new Error('height-pack: bad magic, expected HPK1');
  }
  const dv = new DataView(d.buffer, d.byteOffset);
  const w = dv.getUint32(4, true);
  const h = dv.getUint32(8, true);
  const n = w * h;
  if (d.length !== 12 + 2 * n) throw new Error('height-pack: size mismatch');

  const u16 = new Uint16Array(n);
  let hi = 12, lo = 12 + n, i = 0, z, s, prev = 0;
  // Row 0: predict from the left sample.
  for (let x = 0; x < w; x++, i++) {
    z = (d[hi + i] << 8) | d[lo + i];
    s = (z >>> 1) ^ -(z & 1);
    prev = u16[i] = prev + s;
  }
  // Other rows: column 0 predicts from above, the rest from left + up - upleft.
  for (let y = 1; y < h; y++) {
    z = (d[hi + i] << 8) | d[lo + i];
    s = (z >>> 1) ^ -(z & 1);
    let left = u16[i] = u16[i - w] + s;
    i++;
    for (let x = 1; x < w; x++, i++) {
      z = (d[hi + i] << 8) | d[lo + i];
      s = (z >>> 1) ^ -(z & 1);
      left = u16[i] = left + u16[i - w] - u16[i - w - 1] + s;
    }
  }
  return { w, h, u16 };
}
