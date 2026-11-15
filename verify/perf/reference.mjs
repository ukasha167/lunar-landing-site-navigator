// The terrain code as it was before the 14 Nov 2026 speed-up, copied from site/lib/moon3d.js. One change: the
// crater rim fix made the same day (marked below), so the comparison checks the speed-up alone.
// verify/perf.mjs runs it next to the current code and fails if their outputs drift apart.
// Written with Claude Code (an AI coding agent) at the team's direction. See README.md, "Use of AI".
import * as THREE from './three-stub.mjs';
const R_KM = 1737.4;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// ---------- data ----------
const POLAR_N = 1024, POLAR_HALF = 320;
let DATA = null;
/** loadMoonData() without the textures: returns the km arrays and the half-float arrays it uploaded */
export function load(gBuf, pBuf) {
  const toKm = u => { const f = new Float32Array(u.length); for (let i = 0; i < u.length; i++) f[i] = (u[i] - 20000) / 2000; return f; };
  const global = { w: 2880, h: 1440, km: toKm(new Uint16Array(gBuf)) };
  const polar = { n: POLAR_N, half: POLAR_HALF, km: toKm(new Uint16Array(pBuf)) };
  const half = f => { const d = new Uint16Array(f.length); for (let i = 0; i < f.length; i++) d[i] = THREE.DataUtils.toHalfFloat(f[i]); return d; };
  DATA = { global, polar, globalHalf: half(global.km), polarHalf: half(polar.km) };
  return DATA;
}

function bilinear(arr, w, h, x, y, wrapX) {
  if (wrapX) x = ((x % w) + w) % w; else x = Math.max(0, Math.min(w - 1.001, x));
  y = Math.max(0, Math.min(h - 1.001, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, x1 = wrapX ? (x0 + 1) % w : x0 + 1;
  return arr[y0 * w + x0] * (1 - fx) * (1 - fy) + arr[y0 * w + x1] * fx * (1 - fy) + arr[(y0 + 1) * w + x0] * (1 - fx) * fy + arr[(y0 + 1) * w + x1] * fx * fy;
}
export function polarXY(lat, lon) { const rho = 2 * R_KM * Math.tan((90 + lat) * D2R / 2); return [rho * Math.sin(lon * D2R), rho * Math.cos(lon * D2R)]; }
function bicubic(arr, w, h, x, y, wrapX) {
  const x1 = Math.floor(x), y1 = Math.floor(y), fx = x - x1, fy = y - y1;
  const cr = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  const at = (i, j) => { i = wrapX ? ((i % w) + w) % w : Math.max(0, Math.min(w - 1, i)); j = Math.max(0, Math.min(h - 1, j)); return arr[j * w + i]; };
  const row = j => cr(at(x1 - 1, j), at(x1, j), at(x1 + 1, j), at(x1 + 2, j), fx);
  return cr(row(y1 - 1), row(y1), row(y1 + 1), row(y1 + 2), fy);
}
export function elevKm(lat, lon, smooth = false) {
  const d = DATA, f = smooth ? bicubic : bilinear;
  if (lat < -75) {
    const [x, y] = polarXY(lat, lon);
    if (Math.max(Math.abs(x), Math.abs(y)) < POLAR_HALF - 1)
      return f(d.polar.km, POLAR_N, POLAR_N, (x + POLAR_HALF) / (2 * POLAR_HALF) * POLAR_N - 0.5, (POLAR_HALF - y) / (2 * POLAR_HALF) * POLAR_N - 0.5, false);
  }
  return f(d.global.km, d.global.w, d.global.h, (lon + 180) * 8 - 0.5, (90 - lat) * 8 - 0.5, true);
}

// ---------- frames ----------
function llToVec(lat, lon, out = new THREE.Vector3()) {
  const a = lat * D2R, b = lon * D2R; return out.set(Math.cos(a) * Math.cos(b), Math.sin(a), -Math.cos(a) * Math.sin(b));
}
function vecToLL(v) { const n = v.clone().normalize(); return { lat: Math.asin(n.y) * R2D, lon: Math.atan2(-n.z, n.x) * R2D }; }
function localFrame(lat, lon) {
  const up = llToVec(lat, lon);
  let east = new THREE.Vector3(0, 1, 0).cross(up); if (east.lengthSq() < 1e-10) east.set(0, 0, -1); east.normalize();
  const north = up.clone().cross(east).normalize();
  return { up, east, north };
}
function offsetLL(f, dx, dy) {
  const v = f.up.clone().addScaledVector(f.east, dx / R_KM).addScaledVector(f.north, dy / R_KM);
  return vecToLL(v);
}

// ---------- real skyline ----------
export function realSkyline(lat, lon, { fromKm = 0.6, toKm = 260, eye = 0.002, beyondKm = Infinity } = {}) {
  const f = localFrame(lat, lon), r0 = R_KM + elevKm(lat, lon) + eye, out = new Float32Array(360), beyond = new Float32Array(360);
  const cap = lat < -75 ? 0.3 : 1.5;
  for (let az = 0; az < 360; az++) {
    const s = Math.sin(az * D2R), c = Math.cos(az * D2R); let best = -90, far = -90;
    for (let d = fromKm; d < toKm; d += Math.min(0.02 * d, cap)) {
      const g = d / R_KM, t = R_KM * Math.tan(g), ll = offsetLL(f, s * t, c * t), r = R_KM + elevKm(ll.lat, ll.lon);
      const e = Math.atan2(r * Math.cos(g) - r0, r * Math.sin(g)) * R2D;
      if (e > best) best = e; if (d >= beyondKm && e > far) far = e;
    }
    out[az] = best; beyond[az] = far;
  }
  out.beyond = beyond;
  return out;
}

// ---------- relief tiles ----------
function noise2(seed) {
  const p = new Float32Array(256 * 256); let s = seed >>> 0 || 1;
  for (let i = 0; i < p.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; p[i] = s / 4294967296; }
  return (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, g = (a, b) => p[((b & 255) << 8) | (a & 255)];
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return g(xi, yi) * (1 - u) * (1 - v) + g(xi + 1, yi) * u * (1 - v) + g(xi, yi + 1) * (1 - u) * v + g(xi + 1, yi + 1) * u * v; };
}
export function buildTile(lat, lon, { sizeKm = 40, n = 256, detail = 1 } = {}) {
  const f = localFrame(lat, lon), km = new Float32Array(n * n), seed = Math.round((lat + 90) * 1000) * 7919 + Math.round((lon + 180) * 1000);
  const nz = noise2(seed), cell = sizeKm / (n - 1);
  let r = seed >>> 0; const rnd = () => (r = (r * 1664525 + 1013904223) >>> 0) / 4294967296;
  const craters = []; for (let i = 0; i < 220 * detail; i++) { const rad = 0.12 + Math.pow(rnd(), 3) * 1.8; craters.push({ x: (rnd() - .5) * sizeKm, y: (rnd() - .5) * sizeKm, r: rad, d: rad * (.16 + rnd() * .06) }); }
  let mn = 1e9, mx = -1e9;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = -sizeKm / 2 + i * cell, y = sizeKm / 2 - j * cell;
    const ll = offsetLL(f, x, y);
    let h = elevKm(ll.lat, ll.lon, true) - (x * x + y * y) / (2 * R_KM);
    if (detail) {
      let a = .09, fr = 1 / 3.2; for (let o = 0; o < 5; o++) { h += (nz(x * fr + 31, y * fr + 17) - .5) * a; a *= .5; fr *= 2; }
      // the rim fix of 14 Nov 2026, applied here too so this file checks the speed-up only (see craterAdd in moon3d.js)
      for (const c of craters) { const dd = Math.hypot(x - c.x, y - c.y) / c.r; if (dd < 1.35) h += (dd < 1 ? -c.d * (1 - dd * dd) : 0) + c.d * .25 * Math.exp(-((dd - 1) ** 2) / .02); }
    }
    km[j * n + i] = h; mn = Math.min(mn, h); mx = Math.max(mx, h);
  }
  return { n, sizeKm, km, min: mn, max: mx, lat, lon };
}
