// Compares the app's "share of time the Sun is up" at the south pole sites with NASA's own map of it
// (Mazarico et al. 2011, LOLA team, PDS: AVGVISIB_85S_060M_201608.IMG at 60 m per pixel, and the 120 m map to 75 S;
// share of hourly steps over 18.6 years where any part of the Sun's disc was above the skyline).
// The app's number: same rule, hourly from 1 Jan 2026 to the end of the app's JPL Horizons table (Mar 2031; the
// table itself starts in 2023, see FROM below), with each site's skyline
// from site/assets/sites/index.json (tools/build-sites.py). The two cover different years, so a few points of
// difference are expected even with identical terrain.
//
// PASS if within 5 percentage points. Exits 1 on any FAIL.
// Run: node verify/sunlight-vs-nasa.mjs        Needs internet (reads 1 pixel per site from each NASA map).
// Written with Claude Code (an AI coding agent) at the team's direction. See README.md, "Use of AI".
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const here = p => new URL(p, import.meta.url);
globalThis.window = {};
vm.runInThisContext(readFileSync(here('../site/lib/lunar.js'), 'utf8'));
const L = window.Lunar;
L.useEphemeris(JSON.parse(readFileSync(here('../site/data/ephemeris.json'), 'utf8')));
L.useSkylines(JSON.parse(readFileSync(process.env.SITES_INDEX || here('../site/assets/sites/index.json'), 'utf8')));

const R_M = 1737400, TOL = 5;
const MAPS = [ // finest first: file, pixels across, centre pixel, metres per pixel
  { url: 'http://imbrium.mit.edu/EXTRAS/ILLUMINATION/IMG/AVGVISIB_85S_060M_201608.IMG', n: 5058, off: 2528.5, m: 60 },
  { url: 'http://imbrium.mit.edu/EXTRAS/ILLUMINATION/IMG/AVGVISIB_75S_120M_201608.IMG', n: 7624, off: 3811.5, m: 120 },
];
async function nasa(lat, lon) {
  const rho = 2 * R_M * Math.tan((90 + lat) * Math.PI / 360), x = rho * Math.sin(lon * Math.PI / 180), y = rho * Math.cos(lon * Math.PI / 180);
  for (const M of MAPS) {
    const i = Math.round(x / M.m + M.off), j = Math.round(M.off - y / M.m);
    if (i < 0 || j < 0 || i >= M.n || j >= M.n) continue;
    const a = (j * M.n + i) * 2, r = await fetch(M.url, { headers: { Range: `bytes=${a}-${a + 1}` } });
    return { v: Buffer.from(await r.arrayBuffer()).readInt16LE(0) * 0.00004, m: M.m };
  }
  return null;
}
// The table now starts in 2023 so past landings can be replayed, but this check keeps the window it was set up
// with: 1 Jan 2026 06:00 UTC to the table's end. SUN_FROM=2023-01-01 compares over the longer window instead.
const FROM = Math.max(L.RANGE.start.getTime(), Date.parse(process.env.SUN_FROM || '2026-01-01T06:00Z'));
function appShare(site) {
  let lit = 0, n = 0;
  for (let t = FROM; t < L.RANGE.end.getTime(); t += 36e5) { n++; if (L.sun(site, new Date(t)).visibleFrac > 0) lit++; }
  return lit / n;
}
const pct = v => (100 * v).toFixed(1).padStart(5) + ' %';
const rows = []; let fails = 0, worst = 0;
for (const s of L.SITES.filter(s => s.lat < -75)) {
  const N = await nasa(s.lat, s.lon), app = appShare(s), diff = (app - N.v) * 100, ok = Math.abs(diff) <= TOL;
  if (!ok) fails++; worst = Math.max(worst, Math.abs(diff));
  rows.push({ site: s.short, 'NASA map': `${pct(N.v)} (${N.m} m)`, app: pct(app), diff: `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} pts`, result: ok ? 'PASS' : 'FAIL' });
}
console.table(rows);
console.log(`${rows.length - fails} of ${rows.length} within ${TOL} points of NASA. Largest difference ${worst.toFixed(1)} points.`);
process.exit(fails ? 1 : 0);
