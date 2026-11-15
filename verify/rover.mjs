// Drives the rover physics (site/lib/rover-physics.js) with no browser and checks it behaves like a real
// lunar rover: top speed, braking, turning without tipping, holding and climbing slopes, and 5 minutes of
// random driving on NASA's 5 m Connecting Ridge map; also the physics' cost per frame and the dynamic
// resolution rule (rover-fx.js). Exits 1 if any check fails.
//
// Run: node verify/rover.mjs        No internet needed. About 5 s on an M1.
// Written with Claude Code (an AI coding agent) at the team's direction. See README.md, "Use of AI".
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import vm from 'node:vm';

const here = p => new URL(p, import.meta.url);
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
globalThis.fetch = async url => ({ ok: true, arrayBuffer: async () => file(url.split('?')[0]) });

const P = await import('../site/lib/rover-physics.js');
const M = await import('../site/lib/moon3d.js');
const R = await import('../site/lib/rover.js');
await M.loadMoonData('assets/');

const D2R = Math.PI / 180, IDLE = { thr: 0, steer: 0, brake: false, fast: false };
const rows = []; let fails = 0;
function check(name, value, ok, limit) { if (!ok) fails++; rows.push({ check: name, measured: value, limit, result: ok ? 'PASS' : 'FAIL' }); }
// run `seconds` of simulated time in exact 1/120 s steps; track how upright the body stays
function drive(v, input, seconds, track) {
  const n = Math.round(seconds * 120);
  for (let i = 0; i < n; i++) { v.state.settled = false; v.advance(1 / 120, input); track?.(v); }
}
const upright = v => v.axes()[4]; // y of the body's up axis: 1 level, 0 on its side, -1 upside down

// 1. Flat ground: top speed and how long it takes
{
  const v = P.createVehicle(() => 0); v.spawn(0, 0, 0); drive(v, IDLE, 2);
  let t3 = null, minUp = 1, t = 0;
  drive(v, { ...IDLE, thr: 1 }, 30, v => { t += 1 / 120; minUp = Math.min(minUp, upright(v)); if (t3 === null && v.speed() >= 3) t3 = t; });
  const top = v.speed() * 3.6;
  check('flat: top speed', `${top.toFixed(1)} km/h`, top > 12.2 && top < 13.4, '12.2 to 13.4 km/h (3.6 m/s)');
  check('flat: 0 to 10.8 km/h', `${t3?.toFixed(1)} s`, t3 > 3 && t3 < 15, '3 to 15 s');
  check('flat: body stays level while accelerating', minUp.toFixed(3), minUp > 0.97, 'upright > 0.97');
  // 2. Braking from top speed
  const x0 = v.state.x, z0 = v.state.z; let minUpB = 1, tb = 0;
  drive(v, { ...IDLE, brake: true }, 12, v => { minUpB = Math.min(minUpB, upright(v)); if (Math.abs(v.speed()) > 0.05) tb += 1 / 120; });
  const dist = Math.hypot(v.state.x - x0, v.state.z - z0);
  check('flat: braking distance from 13 km/h', `${dist.toFixed(1)} m in ${tb.toFixed(1)} s`, dist < 15 && minUpB > 0.9, '< 15 m, no tip');
}
// 3. Full steering lock at top speed: it should turn, not roll over
{
  const v = P.createVehicle(() => 0); v.spawn(0, 0, 0); drive(v, { ...IDLE, thr: 1 }, 20);
  let minUp = 1, yaw0 = v.yaw(), turned = 0, last = yaw0;
  drive(v, { ...IDLE, thr: 1, steer: 1 }, 15, v => { minUp = Math.min(minUp, upright(v)); const y = v.yaw(); turned += Math.atan2(Math.sin(y - last), Math.cos(y - last)); last = y; });
  // In 1/6 g the tyres give at most 0.6 x 1.62 = 0.97 m/s² sideways, so at 13 km/h no turn is tighter than about 13 m
  check('flat: 15 s full lock at top speed', `upright ${minUp.toFixed(2)}, turned ${(turned / D2R).toFixed(0)}°`, minUp > 0.85 && Math.abs(turned / D2R) > 90, 'upright > 0.85, turns > 90°');
}
// 4. Parked on a slope facing uphill: the motors hold it
for (const deg of [10, 20, 25]) {
  const v = P.createVehicle((x, z) => -z * Math.tan(deg * D2R)); v.spawn(0, 0, 0); drive(v, IDLE, 12);
  const d = Math.hypot(v.state.x, v.state.z);
  check(`parked on ${deg}°`, `moved ${d.toFixed(2)} m`, d < (deg < 25 ? 0.2 : 0.5), deg < 25 ? '< 0.2 m' : '< 0.5 m');
}
// 5. Climbing: full throttle uphill for 20 s. Apollo's rover was rated for 25°.
for (const deg of [15, 20, 24, 32]) {
  const v = P.createVehicle((x, z) => -z * Math.tan(deg * D2R)); v.spawn(0, 0, 0); drive(v, IDLE, 2);
  const z0 = v.state.z; drive(v, { ...IDLE, thr: 1 }, 20); const up = z0 - v.state.z;
  const ok = deg <= 24 ? up > 3 : up < 1;
  check(`climb ${deg}° for 20 s`, `${up.toFixed(1)} m uphill`, ok, deg <= 24 ? '> 3 m' : '< 1 m (too steep)');
}
// 6. Driving across a 20° side slope
{
  const v = P.createVehicle((x, z) => -z * Math.tan(20 * D2R)); v.spawn(0, 0, -Math.PI / 2); drive(v, IDLE, 2);
  // sideways slide measured across the rover's own heading: the heading itself creeps uphill, because the
  // downhill wheels carry more load and push harder, as on any vehicle (a driver steers against it)
  let slip = 0, minUp = 1;
  drive(v, { ...IDLE, thr: 1 }, 15, v => { const a = v.axes(), s = v.state; slip += (s.vx * a[0] + s.vy * a[1] + s.vz * a[2]) / 120; minUp = Math.min(minUp, upright(v)); });
  check('across a 20° side slope for 15 s', `slid ${slip.toFixed(2)} m sideways, upright ${minUp.toFixed(2)}`, Math.abs(slip) < 1 && minUp > 0.8, '< 1 m, upright > 0.8');
}
// 7. NASA's 5 m Connecting Ridge map (tools/build-sites.py): 5 minutes of random driving, then 1 minute of fast travel.
// Random keys over polar ground will reach 30° to 45° crater walls, where a real rover can tip too. So the
// checks are: it never launches (faster than 4 m/s upward; 3.6 m/s up a 45° wall is 3.6 m/s upward), and every
// tip has a cause a real rover shares: ground steeper than 25°, or a jump (all wheels off the ground for 0.3 s),
// in the 3 s before it.
const RG = await import('../site/lib/real-ground.js');
const index = await RG.loadSiteIndex('assets/');
async function groundAt(lat, lon) {
  const real = await RG.loadRealGround(lat, lon, 'assets/'); if (real[1]) M.addDetail(real[1]);
  const tile = M.buildTile(lat, lon); return { real, tile, G: R.makeGround(tile.field, M, real) };
}
const RIDGE = index.sites.ridge, { G, tile } = await groundAt(RIDGE.lat, RIDGE.lon);
check('Connecting Ridge: rover square on the 5 m map', `${(2 * G.reach / 1000).toFixed(1)} km, data under the site ${G.dataCell(0, 0)} m`, G.reach > 2000 && G.dataCell(0, 0) === 5, 'square > 4 km, 5 m data');
const slopeAt = (x, z) => { const e = 1, hx = G.height(x + e, z) - G.height(x - e, z), hz = G.height(x, z + e) - G.height(x, z - e); return Math.atan(Math.hypot(hx, hz) / (2 * e)) / D2R; };
for (const [label, fast, seconds] of [['5 m map: 5 min random driving', false, 300], ['5 m map: 1 min fast travel', true, 60]]) {
  const v = P.createVehicle(G.height, { edge: G.reach }); v.spawn(0, 0, 0.7); drive(v, IDLE, 2);
  let r = 99, flips = 0, unexplained = 0, onSide = false, minUp = 1, t = 0, inp = IDLE, maxUpV = 0, steepest = 0, lastSteep = -1e9, lastJump = -1e9, air = 0, clock = 0, maxData = 0;
  const rnd = () => (r = (r * 1664525 + 1013904223) >>> 0) / 4294967296;
  const t0 = performance.now();
  for (let next = 0; t < seconds;) {
    if (t >= next) { inp = { thr: rnd() < 0.85 ? 1 : -1, steer: [-1, 0, 0, 1][Math.floor(rnd() * 4)], brake: rnd() < 0.08, fast }; next = t + 1.5 + rnd() * 2.5; }
    drive(v, inp, 0.5, v => {
      clock += 1 / 120;
      const u = upright(v), s = v.state, g = slopeAt(s.x, s.z); minUp = Math.min(minUp, u); maxUpV = Math.max(maxUpV, s.vy);
      steepest = Math.max(steepest, g); if (g > 25) lastSteep = clock;
      air = v.wheels.some(w => w.contact) ? 0 : air + 1 / 120; if (air >= 0.3) lastJump = clock;
      if (u < 0.3 && !onSide) { flips++; onSide = true; if (clock - lastSteep > 3 && clock - lastJump > 3) unexplained++; } if (u > 0.8) onSide = false;
    });
    maxData = Math.max(maxData, G.dataCell(v.state.x, v.state.z));
    if (onSide) v.spawn(v.state.x, v.state.z, v.yaw()); // what the R key does
    t += 0.5;
  }
  const ms = performance.now() - t0;
  check(label, `${Math.round(v.state.odometer)} m driven, steepest ground ${steepest.toFixed(0)}°, ${flips} times on its side (${unexplained} without steep ground or a jump), fastest upward ${maxUpV.toFixed(1)} m/s, coarsest data driven on ${maxData} m, ${ms.toFixed(0)} ms to simulate`,
    maxUpV < 4 && (fast || unexplained === 0) && maxData <= 5.01, fast ? 'upward < 4 m/s, stays on the 5 m map' : 'upward < 4 m/s, no tip without steep ground or a jump, stays on the 5 m map');
}
// 8. Coming to rest on that ground
{
  const v = P.createVehicle(G.height); v.spawn(0, 0, 0.7);
  let tSettle = null; for (let i = 0; i < 600 && tSettle === null; i++) { v.advance(1 / 120, IDLE); if (v.state.settled) tSettle = i / 120; }
  const d = Math.hypot(v.state.x, v.state.z);
  check('5 m map: settles after spawning', `${tSettle?.toFixed(1)} s, moved ${d.toFixed(2)} m`, tSettle !== null && tSettle < 5 && d < 0.1, '< 5 s, < 0.1 m');
}
// 9. Physics cost: the share of a 60 fps frame (16.7 ms) the physics takes on real ground (2 steps per frame)
{
  const v = P.createVehicle(G.height, { edge: G.reach }); v.spawn(0, 0, 0.7); const inp = { thr: 1, steer: 0, brake: false, fast: false };
  drive(v, inp, 5); const n = 120 * 30, a = performance.now();
  for (let i = 0; i < n; i++) { inp.steer = Math.sin(i / 300); v.state.settled = false; v.advance(1 / 120, inp); }
  const perFrame = 2 * (performance.now() - a) / n;
  check('physics cost per 60 fps frame', `${perFrame.toFixed(3)} ms (${(perFrame / 16.7 * 100).toFixed(2)}% of the frame)`, perFrame < 0.5, '< 0.5 ms (3% of a frame)');
}
// 10. Dynamic resolution (rover-fx.js): late frames lower the pixel count; on-time frames raise it back; a slow
// screen that is never late (50 Hz) keeps full resolution
{
  const FX = await import('../site/lib/rover-fx.js');
  const run = (dyn, gap, seconds, t0) => { let now = t0, last = dyn.dpr; for (let t = 0; t < seconds; t += gap) { now += gap * 1000; const d = dyn.frame(now, gap); if (d) last = d; } return [last, now]; };
  const d1 = FX.createDynamicResolution(1.5, 0.6);
  // a 60 Hz screen where every other frame misses the refresh (gaps of 16.7 and 33.3 ms)
  let now = 0, low = 1.5, tLow = null;
  for (let i = 0; i < 600; i++) { const gap = i % 2 ? 1 / 30 : 1 / 60; now += gap * 1000; const d = d1.frame(now, gap); if (d) low = d; if (tLow === null && d1.dpr <= 0.61) tLow = now / 1000; }
  const [back] = run(d1, 1 / 60, 40, now);
  const d2 = FX.createDynamicResolution(1.5, 0.6), [steady] = run(d2, 1 / 50, 20, 0);
  check('dynamic resolution', `late frames: 1.5 -> ${low} in ${tLow?.toFixed(0)} s; on time again: back to ${back}; steady 50 Hz: stays ${steady}`,
    low <= 0.6 && tLow < 10 && back === 1.5 && steady === 1.5, 'down to 0.6 within 10 s, back to 1.5, 50 Hz stays 1.5');
}
// 11. Each fine NASA patch (5 m or 2 m, tools/build-sites.py, site/lib/real-ground.js), averaged to the block's pixel
// size, against the site's block patch (59 to 118 m): the fit must be best with no shift (a window cut in the wrong
// place, or an axis flipped, fits better shifted) and the mean offset small. The RMS is reported, not tested: a
// coarse map smooths cliffs.
{
  const unit = (lat, lon) => [Math.cos(lat * D2R) * Math.cos(lon * D2R), Math.sin(lat * D2R), -Math.cos(lat * D2R) * Math.sin(lon * D2R)];
  // the point x east, y north (m) from (lat, lon), on the sphere
  const at = (lat, lon, x, y) => { const f = M.localFrame(lat, lon); const v = f.up.clone().addScaledVector(f.east, x / 1737400).addScaledVector(f.north, y / 1737400).normalize(); return [v.x, v.y, v.z]; };
  const fit = (A, B, lat, lon, half, step, cellA, cellB, dx = 0, dy = 0) => { let n = 0, sum = 0, sq = 0;
    for (let y = -half; y <= half; y += step) for (let x = -half; x <= half; x += step) {
      const a = A(at(lat, lon, x + dx, y + dy), cellA); if (!(a === a)) continue; const b = B(at(lat, lon, x, y), cellB); if (!(b === b)) continue;
      n++; sum += a - b; sq += (a - b) ** 2; }
    return { n, mean: sum / n, rms: Math.sqrt(sq / n) }; };
  const patchFn = P => (v, cell) => { const h = P.sample(v[0], v[1], v[2], cell); return P.w >= 0.999 ? h : NaN; };
  let shiftOK = true;
  for (const [id, s] of Object.entries(index.sites)) {
    const block = await RG.loadPatch(s.block, 'block', 'assets/');
    const sh = s.lat < -75 ? 700 : 4000;
    let row = `block ${s.block.scale} m`;
    // the fine patch against the block patch
    if (s.fine) {
      const fine = await RG.loadPatch(s.fine, 'fine', 'assets/'), cell = s.block.scale;
      const f0 = fit(patchFn(fine), patchFn(block), s.lat, s.lon, 2000, 200, cell, 0);
      const shifts = [[sh / 7, 0], [-sh / 7, 0], [0, sh / 7], [0, -sh / 7]].map(([dx, dy]) => fit(patchFn(fine), patchFn(block), s.lat, s.lon, 2000, 200, cell, 0, dx, dy).rms);
      const best = shifts.every(r => r > f0.rms); if (!best) shiftOK = false;
      row += `; ${s.fine.scale} m vs ${s.block.scale} m: mean ${f0.mean.toFixed(1)} m, RMS ${f0.rms.toFixed(1)} m, ${f0.n} points, best with no ${Math.round(sh / 7)} m shift: ${best ? 'yes' : 'NO'}`;
      check(`NASA patches ${id}: fine map lines up with the block map`, row, f0.n > 50 && Math.abs(f0.mean) < 10 && best, `|mean| < 10 m, every ${Math.round(sh / 7)} m shift fits worse`);
    }
  }
}
// 12. Cost of the first terrain build: 180,224 points of ground on the 5 m map
{
  const a = performance.now(); for (let i = 0; i < 180224; i++) G.height((i % 431) * 3.1 - 650, Math.floor(i / 431) * 3.1 - 650, 2); const build = performance.now() - a;
  check('first terrain build, 180,224 points', `${build.toFixed(0)} ms`, build < 1500, '< 1.5 s');
}

console.table(rows);
console.log(`${rows.length - fails} PASS, ${fails} FAIL`);
process.exit(fails ? 1 : 0);
