// Stand-in for the parts of three@0.169.0 that moon3d.js touches on the CPU, so Node can load it.
// Vector3 and DataUtils.toHalfFloat copy three's arithmetic, so results match the browser bit for bit.
// Written with Claude Code (an AI coding agent) at the team's direction. See README.md, "Use of AI".
export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  divideScalar(s) { return this.multiplyScalar(1 / s); }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
  normalize() { return this.divideScalar(this.length() || 1); }
  cross(v) { const ax = this.x, ay = this.y, az = this.z, bx = v.x, by = v.y, bz = v.z;
    this.x = ay * bz - az * by; this.y = az * bx - ax * bz; this.z = ax * by - ay * bx; return this; }
}
const T = (() => {
  const buffer = new ArrayBuffer(4), floatView = new Float32Array(buffer), uint32View = new Uint32Array(buffer);
  const baseTable = new Uint32Array(512), shiftTable = new Uint32Array(512);
  for (let i = 0; i < 256; ++i) {
    const e = i - 127;
    if (e < -27) { baseTable[i] = 0; baseTable[i | 0x100] = 0x8000; shiftTable[i] = 24; shiftTable[i | 0x100] = 24; }
    else if (e < -14) { baseTable[i] = 0x0400 >> (-e - 14); baseTable[i | 0x100] = (0x0400 >> (-e - 14)) | 0x8000; shiftTable[i] = -e - 1; shiftTable[i | 0x100] = -e - 1; }
    else if (e <= 15) { baseTable[i] = (e + 15) << 10; baseTable[i | 0x100] = ((e + 15) << 10) | 0x8000; shiftTable[i] = 13; shiftTable[i | 0x100] = 13; }
    else if (e < 128) { baseTable[i] = 0x7c00; baseTable[i | 0x100] = 0xfc00; shiftTable[i] = 24; shiftTable[i | 0x100] = 24; }
    else { baseTable[i] = 0x7c00; baseTable[i | 0x100] = 0xfc00; shiftTable[i] = 13; shiftTable[i | 0x100] = 13; }
  }
  return { floatView, uint32View, baseTable, shiftTable };
})();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const DataUtils = {
  toHalfFloat(val) {
    if (Math.abs(val) > 65504) console.warn('toHalfFloat out of range');
    val = clamp(val, -65504, 65504);
    T.floatView[0] = val; const f = T.uint32View[0], e = (f >> 23) & 0x1ff;
    return T.baseTable[e] + ((f & 0x007fffff) >> T.shiftTable[e]);
  },
};
class Stub { constructor(...a) { this.args = a; this.image = { data: a[0] }; } dispose() {} }
export class DataTexture extends Stub {}
export class TextureLoader { async loadAsync() { return new Stub(); } }
export const RedFormat = 0, HalfFloatType = 0, LinearFilter = 0, RepeatWrapping = 0, SRGBColorSpace = '', RGBAFormat = 0, UnsignedByteType = 0;
