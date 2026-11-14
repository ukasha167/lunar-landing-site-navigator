// Times the terrain code in site/lib/moon3d.js against the code it replaced (verify/perf/reference.mjs)
// and checks that both give the same answers. Exits 1 if any output drifts past its limit.
//
// Limits: decoded heights, elevations and skylines must match exactly. Relief block heights may differ by
// 0.5 mm, because the new code finds a point on the polar map without trig, which can move the last bit.
//
// Run: node verify/perf.mjs        No internet needed. About 15 s on an M1.
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import vm from 'node:vm';

const here = p => new URL(p, import.meta.url);
// In the browser 'three' comes from a CDN. In Node, point it at a stand-in.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'three') return { url: here('./perf/three-stub.mjs').href, shortCircuit: true };
    if (spec.startsWith('three/addons/')) return { url: here('./perf/addons-stub.mjs').href, shortCircuit: true };
    return next(spec, ctx);
  },
});
globalThis.window = {};
vm.runInThisContext(readFileSync(here('../site/lib/lunar.js'), 'utf8'));
const file = p => { const b = readFileSync(here('../site/' + p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
globalThis.fetch = async url => ({ ok: true, arrayBuffer: async () => file(url) });

const M = await import('../site/lib/moon3d.js');
const REF = await import('./perf/reference.mjs');

const now = () => performance.now();
function median(fn, { min = 5, ms = 400 } = {}) {
  fn(); fn(); // let the JIT compile it first
  const ts = []; const t0 = now();
  while (ts.length < min || now() - t0 < ms) { const a = now(); fn(); ts.push(now() - a); }
  return ts.sort((a, b) => a - b)[Math.floor(ts.length / 2)];
}
const rows = []; let fails = 0;
function check(step, before, after, diff, limit, unit) {
  const ok = diff <= limit; if (!ok) fails++;
  rows.push({ step, before_ms: before == null ? '' : +before.toFixed(2), after_ms: after == null ? '' : +after.toFixed(2),
    faster: before == null ? '' : (before / after).toFixed(1) + 'x', max_diff: `${diff.toPrecision(2)} ${unit}`, limit: `${limit} ${unit}`, result: ok ? 'PASS' : 'FAIL' });
}

// 1. Height decode. Each runs once: loadMoonData() keeps its result.
const gBuf = file('assets/moon_height_8ppd.u16'), pBuf = file('assets/south_pole_625m.u16');
let a = now(); const ref = REF.load(gBuf, pBuf); const tRef = now() - a;
a = now(); const D = await M.loadMoonData('assets/'); const tNew = now() - a;
let bad = 0;
for (const [x, y] of [[ref.globalHalf, D.globalTex.image.data], [ref.polarHalf, D.polarTex.image.data]]) for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) bad++;
check('decode heights (one cold run each)', tRef, tNew, bad, 0, 'samples differ');

// 2. Elevation lookups at 20,000 places
let r = 12345; const rnd = () => (r = (r * 1664525 + 1013904223) >>> 0) / 4294967296;
let d = 0;
for (let i = 0; i < 20000; i++) {
  const lat = i % 2 ? -75 - rnd() * 15 : rnd() * 180 - 90, lon = rnd() * 360 - 180, smooth = i % 3 === 0;
  d = Math.max(d, Math.abs(REF.elevKm(lat, lon, smooth) - M.elevKm(lat, lon, smooth)));
}
check('elevation, 20,000 places', null, null, d * 1e6, 0, 'mm');

// 3. Skylines
const SITES = [['Connecting ridge', -89.45, -137.3], ['de Gerlache rim', -88.71, -68.7], ['Malapert', -85.99, 2.9], ['Apollo 11', 0.674, 23.473]];
for (const [name, lat, lon] of SITES) {
  let s0, s1;
  const t0 = median(() => { s0 = REF.realSkyline(lat, lon, { beyondKm: 22 }); }, { min: 3 });
  const t1 = median(() => { s1 = M.realSkyline(lat, lon, { beyondKm: 22 }); }, { min: 3 });
  let m = 0; for (let i = 0; i < 360; i++) m = Math.max(m, Math.abs(s0[i] - s1[i]), Math.abs(s0.beyond[i] - s1.beyond[i]));
  check(`skyline, ${name}`, t0, t1, m, 0, 'deg');
}

// 4. Relief blocks, and fieldHeight() at the block's own grid points
for (const [name, lat, lon] of SITES.slice(0, 2)) {
  let b0, b1;
  const t0 = median(() => { b0 = REF.buildTile(lat, lon, { detail: 0 }); }, { min: 3, ms: 1500 }); // the app draws no made-up detail since 15 Nov 2026
  const t1 = median(() => { b1 = M.buildTile(lat, lon); }, { min: 5 });
  let m = 0; for (let i = 0; i < b0.km.length; i++) m = Math.max(m, Math.abs(b0.km[i] - b1.km[i]));
  check(`relief block 256 x 256, ${name}`, t0, t1, m * 1e6, 0.5, 'mm');
  const n = b1.n, cell = b1.sizeKm / (n - 1); let f = 0;
  for (let k = 0; k < n * n; k += 7) { const i = k % n, j = (k / n) | 0; f = Math.max(f, Math.abs(Math.fround(M.fieldHeight(b1.field, -b1.sizeKm / 2 + i * cell, b1.sizeKm / 2 - j * cell)) - b1.km[k])); }
  check(`fieldHeight() on the block grid, ${name}`, null, null, f * 1e6, 0, 'mm');
}

console.table(rows);
console.log(`${rows.length - fails} PASS, ${fails} FAIL (node ${process.version})`);
process.exit(fails ? 1 : 0);
