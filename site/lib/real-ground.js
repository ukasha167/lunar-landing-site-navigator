/*
  real-ground.js: the NASA elevation maps cut for the app's built-in sites by tools/build-sites.py
  (site/assets/sites/). Every site has a block patch, a 44 km square for the main page: LOLA 80 m near the south
  pole, LOLA and Kaguya SLDEM2015 59 m or LOLA 118 m elsewhere. Where NASA has one, a site also has a fine patch
  for the rover: 5 m shape-from-shading in the 13 Artemis III candidate regions, 2 m LROC stereo at Apollo 11.

  A patch uses one of two map projections. For a unit vector (x, y, z) in moon3d.js's frame (y to the north pole):
    'sps'  polar stereographic about the south pole, X = -2R z / (1 - y), Y = 2R x / (1 - y) (m);
           pixel (i, j) sits at X = x0 + i dx, Y = y0 - j dy.
    'eqc'  longitude and latitude; pixel (i, j) sits at lon = x0 + i dx, lat = y0 - j dy (deg).
  File: heights stored as 1 + round((h - h0) / q) in uint16 (0 = no data), each row as differences from the
  previous pixel (mod 65536), low bytes then high bytes, gzipped.

  No dependencies.
*/
const R_M = 1737400, R2D = 180 / Math.PI;
let indexPromise = null, indexData = null;
const cache = new Map();

async function bytes(url) { const r = await fetch(url); if (r.ok === false) throw new Error(`${url}: HTTP ${r.status}`); return r.arrayBuffer(); }
async function gunzip(buf) { return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); }

/** site/assets/sites/index.json, loaded once. base: the folder that holds sites/ (default: next to this page). */
export function loadSiteIndex(base = 'assets/') {
  indexPromise ||= bytes(base + 'sites/index.json').then(b => (indexData = JSON.parse(new TextDecoder().decode(b))))
    .catch(e => { indexPromise = null; throw e; });
  return indexPromise;
}
/** The index if it has loaded, else null. */
export const siteIndex = () => indexData;

function decode(meta, buf) {
  const planes = new Uint8Array(buf), n = meta.w * meta.h, h = new Float32Array(n);
  for (let j = 0, k = 0; j < meta.h; j++) {
    let v = 0;
    for (let i = 0; i < meta.w; i++, k++) { v = (v + (planes[k] | planes[n + k] << 8)) & 0xffff; h[k] = v ? meta.h0 + (v - 1) * meta.q : NaN; }
  }
  return h;
}
// pixels from each pixel to the nearest missing one or the patch edge (two-pass chamfer), so blending fades
// out before a hole or an edge instead of stepping
function reachMap(h, w, hh) {
  const d = new Float32Array(w * hh), big = 1e9;
  for (let j = 0, k = 0; j < hh; j++) for (let i = 0; i < w; i++, k++) {
    if (h[k] !== h[k]) { d[k] = 0; continue; }
    let v = Math.min(i + 1, j + 1, big);
    if (i > 0) v = Math.min(v, d[k - 1] + 1); if (j > 0) v = Math.min(v, d[k - w] + 1);
    if (i > 0 && j > 0) v = Math.min(v, d[k - w - 1] + 1.414); if (i < w - 1 && j > 0) v = Math.min(v, d[k - w + 1] + 1.414);
    d[k] = v;
  }
  for (let j = hh - 1, k = w * hh - 1; j >= 0; j--) for (let i = w - 1; i >= 0; i--, k--) {
    if (!d[k]) continue;
    let v = Math.min(d[k], w - i, hh - j);
    if (i < w - 1) v = Math.min(v, d[k + 1] + 1); if (j < hh - 1) v = Math.min(v, d[k + w] + 1);
    if (i < w - 1 && j < hh - 1) v = Math.min(v, d[k + w + 1] + 1.414); if (i > 0 && j < hh - 1) v = Math.min(v, d[k + w - 1] + 1.414);
    d[k] = v;
  }
  return d;
}
// levels of 2 x 2 averages (of the pixels that have data) down to 16 pixels
function pyramid(h, w, hh) {
  const levels = [{ h, w, hh }];
  while (Math.min(levels.at(-1).w, levels.at(-1).hh) > 16) {
    const { h: a, w: W, hh: H } = levels.at(-1), v = W >> 1, u = H >> 1, o = new Float32Array(v * u);
    for (let j = 0; j < u; j++) for (let i = 0; i < v; i++) {
      let s = 0, c = 0;
      for (const k of [2 * j * W + 2 * i, 2 * j * W + 2 * i + 1, (2 * j + 1) * W + 2 * i, (2 * j + 1) * W + 2 * i + 1]) if (a[k] === a[k]) { s += a[k]; c++; }
      o[j * v + i] = c ? s / c : NaN;
    }
    levels.push({ h: o, w: v, hh: u });
  }
  return levels;
}
function clampi(i, m) { return i < 0 ? 0 : i > m ? m : i; }
// Catmull-Rom on a w x hh grid at pixel (fx, fy), clamped to the grid
function bicubic(a, w, hh, fx, fy) {
  const x1 = Math.floor(fx), y1 = Math.floor(fy), tx = fx - x1, ty = fy - y1, mx = w - 1, my = hh - 1;
  let out = 0;
  for (let k = -1; k <= 2; k++) {
    const j = clampi(y1 + k, my) * w;
    const p0 = a[j + clampi(x1 - 1, mx)], p1 = a[j + clampi(x1, mx)], p2 = a[j + clampi(x1 + 1, mx)], p3 = a[j + clampi(x1 + 2, mx)];
    const row = p1 + 0.5 * tx * (p2 - p0 + tx * (2 * p0 - 5 * p1 + 4 * p2 - p3 + tx * (3 * (p1 - p2) + p3 - p0)));
    const wy = k === -1 ? ((-0.5 * ty + 1) * ty - 0.5) * ty : k === 0 ? (1.5 * ty - 2.5) * ty * ty + 1 : k === 1 ? ((-1.5 * ty + 2) * ty + 0.5) * ty : (0.5 * ty - 0.5) * ty * ty;
    out += row * wy;
  }
  return out;
}
function bilinear(a, w, hh, fx, fy) {
  fx = Math.max(0, Math.min(w - 1.001, fx)); fy = Math.max(0, Math.min(hh - 1.001, fy));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, k = y0 * w + x0;
  return (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - ty) + (a[k + w] * (1 - tx) + a[k + w + 1] * tx) * ty;
}

/**
  A decoded patch: { meta, source, scale (m per pixel), w, hh, kind, sample(vx, vy, vz, cell, smooth) -> height (m) or NaN,
  corners (4 unit vectors) }. sample() also sets .w: 1 well inside the patch, falling to 0 at its edge and next to
  missing pixels (no object per call: the rover samples 180,000 points at once). cell: the grid it will be drawn on
  (m); detail finer than that comes from a coarser level.
*/
function makePatch(meta, kind, h) {
  const { w, h: hh, proj, x0, y0, dx, dy } = meta, levels = pyramid(h, w, hh), reach = reachMap(h, w, hh);
  // fade to the coarser map over the outer 6 percent, at most 1.5 km (a block patch has 2 km to spare around the block)
  const blend = Math.max(3, Math.min(0.06 * Math.min(w, hh), 1500 / meta.scale));
  let fi = 0, fj = 0;
  const toPix = proj === 'sps'
    ? (vx, vy, vz) => { const k = 2 * R_M / (1 - vy); fi = (-vz * k - x0) / dx; fj = (y0 - vx * k) / dy; }
    : (vx, vy, vz) => { let lon = Math.atan2(-vz, vx) * R2D; const lat = Math.asin(vy) * R2D;
      if (lon - x0 > 180) lon -= 360; else if (lon - x0 < -180) lon += 360; fi = (lon - x0) / dx; fj = (y0 - lat) / dy; };
  const toVec = (i, j) => {
    if (proj === 'sps') { const X = x0 + i * dx, Y = y0 - j * dy, a = X / (2 * R_M), b = Y / (2 * R_M), q = 2 / (a * a + b * b + 1); return [b * q, 1 - q, -a * q]; }
    const lon = (x0 + i * dx) / R2D, lat = (y0 - j * dy) / R2D; return [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)];
  };
  // a cap around the patch for a quick "not here" (cos of its angular radius, with 2 percent spare)
  const c = toVec((w - 1) / 2, (hh - 1) / 2), corners = [[0, 0], [w - 1, 0], [w - 1, hh - 1], [0, hh - 1]].map(([i, j]) => toVec(i, j));
  const cosCap = Math.min(...corners.map(v => v[0] * c[0] + v[1] * c[1] + v[2] * c[2])) - 0.02 * (1 - Math.min(...corners.map(v => v[0] * c[0] + v[1] * c[1] + v[2] * c[2])));
  const P = {
    meta, kind, source: meta.source, scale: meta.scale, w: 0, px: w, py: hh, corners, centre: c,
    sample(vx, vy, vz, cell = 0, smooth = true) {
      if (vx * c[0] + vy * c[1] + vz * c[2] < cosCap) { P.w = 0; return NaN; }
      toPix(vx, vy, vz);
      if (fi < 0 || fj < 0 || fi > w - 1 || fj > hh - 1) { P.w = 0; return NaN; }
      const e = reach[Math.round(fj) * w + Math.round(fi)] - 1.5;
      if (e <= 0) { P.w = 0; return NaN; }
      const L = Math.min(levels.length - 1, Math.max(0, Math.floor(Math.log2(Math.max(1, cell / meta.scale))))), lv = levels[L], k = 1 << L;
      const v = (smooth ? bicubic : bilinear)(lv.h, lv.w, lv.hh, (fi + 0.5) / k - 0.5, (fj + 0.5) / k - 0.5);
      if (v !== v) { P.w = 0; return NaN; }
      const t = Math.min(1, e / blend); P.w = t * t * (3 - 2 * t);
      return v;
    },
  };
  return P;
}

/** Load and decode one patch (cached). kind: 'block' or 'fine'. */
export function loadPatch(meta, kind, base = 'assets/') {
  let p = cache.get(meta.file);
  if (!p) { p = bytes(base + 'sites/' + meta.file).then(gunzip).then(buf => makePatch(meta, kind, decode(meta, buf))); cache.set(meta.file, p); p.catch(() => cache.delete(meta.file)); }
  return p;
}

// is (lat, lon) inside the patch, at least marginM from its edge? (from the index alone, nothing loaded)
function holds(meta, lat, lon, marginM) {
  const a = lat / R2D, b = lon / R2D, vx = Math.cos(a) * Math.cos(b), vy = Math.sin(a), vz = -Math.cos(a) * Math.sin(b);
  let fi, fj;
  if (meta.proj === 'sps') { const k = 2 * R_M / (1 - vy); fi = (-vz * k - meta.x0) / meta.dx; fj = (meta.y0 - vx * k) / meta.dy; }
  else { let L = lon; if (L - meta.x0 > 180) L -= 360; else if (L - meta.x0 < -180) L += 360; fi = (L - meta.x0) / meta.dx; fj = (meta.y0 - lat) / meta.dy; }
  const m = marginM / meta.scale;
  return fi >= m && fj >= m && fi <= meta.w - 1 - m && fj <= meta.h - 1 - m;
}
const dist = (lat, lon, s) => { const a = lat / R2D, b = s.lat / R2D; return Math.acos(Math.min(1, Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos((lon - s.lon) / R2D))) * R_M; };

/**
  Data for a place from the index (call after loadSiteIndex()): { block, fine, site } where block and fine are
  patch descriptions (or null) from the nearest built-in sites whose patches hold the place.
  fine needs 300 m to spare from the patch edge, so the rover has room to drive.
*/
export function dataAt(lat, lon) {
  const out = { block: null, fine: null, site: null };
  if (!indexData) return out;
  let bd = Infinity, fd = Infinity;
  for (const [id, s] of Object.entries(indexData.sites)) {
    const d = dist(lat, lon, s);
    if (s.block && d < bd && holds(s.block, lat, lon, 2000)) { bd = d; out.block = s.block; }
    if (s.fine && d < fd && holds(s.fine, lat, lon, 300)) { fd = d; out.fine = s.fine; out.site = { id, ...s }; }
  }
  return out;
}

/** The rover's ground for a place: [fine patch, block patch], or null when no 5 m (or finer) map holds the place. */
export async function loadRealGround(lat, lon, base = 'assets/') {
  await loadSiteIndex(base);
  const d = dataAt(lat, lon);
  if (!d.fine || d.fine.scale > 5.01) return null;
  return Promise.all([loadPatch(d.fine, 'fine', base), d.block ? loadPatch(d.block, 'block', base) : null]).then(a => a.filter(Boolean));
}
