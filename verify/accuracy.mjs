// Checks our Sun and Earth positions against JPL Horizons, the reference the challenge names.
// Horizons reports positions above the smooth Moon, before terrain, so both parts use a flat horizon.
// Terrain is checked separately against Quickmap (VERIFY.md, step 4).
//
// Part 1, sky position. Every site in our list (south pole, mid-latitude, equator, far side) on 12 dates
//   from 2026 to 2030. We compare the whole direction (the angle between our Sun and Horizons' Sun),
//   not only the elevation: azimuth decides which ridge the Sun hides behind. Sites away from the pole
//   matter here. At the pole the Sun's height barely depends on its longitude, so a polar-only test
//   misses longitude errors.
//   PASS if the direction is within 0.01 deg. The Sun never climbs more than 1.9 deg above flat ground
//   at Shackleton rim, so 0.01 deg is about half of 1 percent of that.
//
// Part 2, the numbers on screen. For 4 polar sites over two lunar days (29.5 days each), our own summary()
//   and hoursUntilChange() against Horizons elevations every 10 minutes. The first starts on the app's
//   default date. The second starts on 25 Jul 2027, when the Sun crosses the Moon's equator, so it rises
//   and sets at the pole, which is the slowest crossing and the hardest to time:
//   - share of the time the Sun is up, Earth is up, and both. PASS if within 1 percentage point.
//   - every sunrise, sunset, Earthrise and Earthset. PASS if the time is within 1 percent of the time
//     from the start date ("Dark in 31 h" may be off by 0.31 h at most), or within 1 minute.
//
// Run: node verify/accuracy.mjs        Needs internet. Exits with code 1 if any row fails.
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

const DIRECTION_TOL_DEG = 0.01, SHARE_TOL_PTS = 1, EVENT_TOL_FRAC = 0.01, EVENT_TOL_MIN_H = 1 / 60;
const DATES = ['2026-02-03 00:00', '2026-06-17 13:30', '2026-11-14 09:00', '2027-01-10 06:00', '2027-04-15 06:00', '2027-07-01 06:00',
  '2027-10-25 06:00', '2027-12-20 06:00', '2028-05-08 21:15', '2029-03-22 04:45', '2030-08-30 17:00', '2030-12-30 23:00'];
const BODIES = [{ key: 'sun', name: 'Sun', id: '10' }, { key: 'earth', name: 'Earth', id: '399' }];
const TIMING_SITES = ['shk-a', 'ridge', 'degerl', 'malap'];
const TIMING_STARTS = ['2027-10-25 06:00', '2027-07-25 00:00']; // DEFAULT_DATE in site/lib/app3d.js; Sun at the Moon's equator on 4 Aug 2027

// lunar.js is a browser script that sets window.Lunar. Run it in a sandbox with a fake window.
const sandbox = { window: {} };
vm.runInNewContext(readFileSync(new URL('../site/lib/lunar.js', import.meta.url), 'utf8'), sandbox);
const L = sandbox.window.Lunar;
L.useEphemeris(JSON.parse(readFileSync(new URL('../site/data/ephemeris.json', import.meta.url), 'utf8')));

const D2R = Math.PI / 180;
const utc = s => new Date(s.replace(' ', 'T') + 'Z');
const MONTHS = 'JanFebMarAprMayJunJulAugSepOctNovDec';
const parseTime = s => { const [, y, m, d, hh, mm, ss] = s.match(/(\d{4})-(\w{3})-(\d{2}) (\d{2}):(\d{2}):?(\d{2})?/); return Date.UTC(+y, MONTHS.indexOf(m) / 3, +d, +hh, +mm, +(ss || 0)); };

// Horizons apparent azimuth and elevation of a body from a site on the Moon. Returns Map(time ms -> {az, el}).
async function horizons(body, site, times) {
  const q = new URLSearchParams({
    format: 'json', COMMAND: `'${body.id}'`, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'", EPHEM_TYPE: "'OBSERVER'",
    CENTER: "'coord@301'", COORD_TYPE: "'GEODETIC'", SITE_COORD: `'${site.lon},${site.lat},0'`,
    QUANTITIES: "'4'", CSV_FORMAT: "'YES'", ANG_FORMAT: "'DEG'", EXTRA_PREC: "'YES'",
    ...(Array.isArray(times) ? { TLIST: times.map(d => `'${d}'`).join(' '), TLIST_TYPE: "'CAL'" } : times),
  });
  let text = '';
  for (let attempt = 1; attempt <= 3 && !text.includes('$$SOE'); attempt++) {
    const res = await fetch('https://ssd.jpl.nasa.gov/api/horizons.api?' + q);
    if (res.ok) { const json = await res.json(); text = json.result ?? json.error ?? ''; }
    else text = `HTTP ${res.status}`;
  }
  const [head, rest] = text.split('$$SOE');
  if (!rest) throw new Error('Horizons returned no data:\n' + text.slice(-600));
  // read columns by name: Horizons sorts the time list, and its layout can change
  const cols = head.trim().split('\n').filter(l => l.includes('Date__')).pop().split(',').map(s => s.trim());
  if (!cols[0].includes('(UT)')) throw new Error('Expected times in UT, got ' + cols[0]);
  const iAz = cols.findIndex(c => c.startsWith('Azimuth')), iEl = cols.findIndex(c => c.startsWith('Elevation'));
  const out = new Map();
  for (const line of rest.split('$$EOE')[0].trim().split('\n')) { const c = line.split(','); out.set(parseTime(c[0]), { az: Number(c[iAz]), el: Number(c[iEl]) }); }
  return out;
}

// angle between two sky directions, deg (haversine form, exact for tiny angles)
function separation(a, b) {
  const s = Math.sin((b.el - a.el) * D2R / 2) ** 2 + Math.cos(a.el * D2R) * Math.cos(b.el * D2R) * Math.sin((b.az - a.az) * D2R / 2) ** 2;
  return 2 * Math.asin(Math.sqrt(s)) / D2R;
}
const f = (x, n = 4) => (x >= 0 ? ' ' : '') + x.toFixed(n);
const flat = site => ({ ...site, horizon: new Float32Array(360) }); // smooth Moon, as Horizons sees it

// ---------- part 1: sky position ----------
const rows = [];
for (const site of L.SITES) {
  for (const body of BODIES) {
    const truth = await horizons(body, site, DATES);
    for (const d of DATES) {
      const h = truth.get(utc(d).getTime());
      if (!h) throw new Error(`Horizons gave no row for ${d}`);
      const o = L[body.key](site, utc(d));
      const sky = separation(o, h);
      rows.push({ site: site.short, body: body.name, date: d, hEl: h.el, oEl: o.el, hAz: h.az, oAz: o.az, elErr: o.el - h.el, sky, pass: sky <= DIRECTION_TOL_DEG });
    }
  }
}
console.log(`PART 1. Sky position, ${L.SITES.length} sites x ${DATES.length} dates x Sun and Earth. PASS if within ${DIRECTION_TOL_DEG} deg of Horizons.\n`);
console.log('Site            Body    Rows  Pass  Worst elevation error  Worst direction error');
for (const site of L.SITES) for (const body of BODIES) {
  const g = rows.filter(r => r.site === site.short && r.body === body.name);
  const wEl = g.reduce((a, r) => Math.abs(r.elErr) > Math.abs(a) ? r.elErr : a, 0), wSky = Math.max(...g.map(r => r.sky));
  console.log(`${site.short.padEnd(15)} ${body.name.padEnd(6)} ${String(g.length).padStart(5)} ${String(g.filter(r => r.pass).length).padStart(5)}  ${f(wEl, 6)} deg            ${wSky.toFixed(6)} deg`);
}
const fail1 = rows.filter(r => !r.pass).length, worst1 = Math.max(...rows.map(r => r.sky));
console.log(`\n${rows.length - fail1} of ${rows.length} pass. Largest direction error ${worst1.toFixed(6)} deg (${(worst1 / 1.86 * 100).toFixed(3)} percent of the Sun's highest point at Shackleton rim).\n`);

// ---------- part 2: the numbers on screen ----------
const spanH = L.SYNODIC * 24, shares = [], events = [];
for (const start of TIMING_STARTS) {
const t0 = utc(start).getTime(), stop = new Date(t0 + Math.ceil(spanH + 1) * 36e5).toISOString().slice(0, 16).replace('T', ' ');
for (const id of TIMING_SITES) {
  const site = flat(L.site(id)), sum = L.summary(site, new Date(t0));
  const truth = {};
  for (const body of BODIES) truth[body.key] = await horizons(body, site, { START_TIME: `'${start}'`, STOP_TIME: `'${stop}'`, STEP_SIZE: "'10 m'" });

  // shares on the same hourly instants summary() uses
  const hourly = sum.samples.map(s => s.t.getTime());
  const upAt = (key, t) => truth[key].get(t).el > 0;
  const share = pick => 100 * hourly.filter(pick).length / hourly.length;
  const pairs = [
    ['Sun up', 100 * sum.sunFrac, share(t => upAt('sun', t))],
    ['Earth up', 100 * sum.earthFrac, share(t => upAt('earth', t))],
    ['Both up', 100 * sum.bothFrac, share(t => upAt('sun', t) && upAt('earth', t))],
  ];
  for (const [what, ours, hz] of pairs) shares.push({ start, site: site.short, what, hz, ours, err: ours - hz, pass: Math.abs(ours - hz) <= SHARE_TOL_PTS });

  for (const body of BODIES) {
    // Horizons crossings of flat ground, interpolated between 10-minute rows
    const series = [...truth[body.key]].sort((a, b) => a[0] - b[0]), hzEvents = [];
    for (let i = 1; i < series.length; i++) {
      const [ta, a] = series[i - 1], [tb, b] = series[i];
      if ((a.el > 0) !== (b.el > 0) && tb - t0 <= spanH * 36e5) hzEvents.push({ h: (ta + (tb - ta) * a.el / (a.el - b.el) - t0) / 36e5, rise: b.el > 0 });
    }
    // ours: chain hoursUntilChange() the way the app asks "Dark in ..." again after each change
    const ourEvents = [];
    for (let h = 0; ;) {
      const r = L.hoursUntilChange(site, new Date(t0 + h * 36e5), body.key, spanH - h);
      if (!isFinite(r.hours)) break;
      h += r.hours; ourEvents.push({ h, rise: !r.nowUp });
      h += 2 / 60; // step past the crossing before asking again
    }
    const n = Math.max(hzEvents.length, ourEvents.length);
    for (let i = 0; i < n; i++) {
      const a = hzEvents[i], b = ourEvents[i];
      const label = (a || b).rise ? (body.key === 'sun' ? 'Sunrise' : 'Earthrise') : (body.key === 'sun' ? 'Sunset' : 'Earthset');
      const tol = a ? Math.max(EVENT_TOL_FRAC * a.h, EVENT_TOL_MIN_H) : 0;
      const err = a && b ? b.h - a.h : NaN;
      events.push({ start, site: site.short, what: label, hz: a?.h, ours: b?.h, err, tol, pass: !!(a && b) && a.rise === b.rise && Math.abs(err) <= tol });
    }
  }
}
}
console.log(`PART 2. Numbers on screen, flat horizon, one lunar day from each of ${TIMING_STARTS.join(' and ')} UTC.\n`);
console.log(`Share of the time (PASS if within ${SHARE_TOL_PTS} percentage point)`);
console.log('Start             Site            What       Horizons   Ours     Error    Result');
for (const s of shares) console.log(`${s.start}  ${s.site.padEnd(15)} ${s.what.padEnd(9)} ${s.hz.toFixed(2).padStart(7)} %  ${s.ours.toFixed(2).padStart(6)} %  ${f(s.err, 2)}    ${s.pass ? 'PASS' : 'FAIL'}`);
console.log('\nRise and set times, hours after the start (PASS if within 1 percent of that time, or 1 minute)');
console.log('Start             Site            Event       Horizons      Ours        Error     Allowed   Result');
const hh = x => x === undefined ? '      none' : x.toFixed(3).padStart(10);
for (const e of events) console.log(`${e.start}  ${e.site.padEnd(15)} ${e.what.padEnd(10)} ${hh(e.hz)} h ${hh(e.ours)} h  ${isNaN(e.err) ? '     -  ' : f(e.err * 60, 2) + ' min'}  ${(e.tol * 60).toFixed(1).padStart(6)} min   ${e.pass ? 'PASS' : 'FAIL'}`);
const fail2 = shares.filter(s => !s.pass).length + events.filter(e => !e.pass).length;
const worstPct = Math.max(...events.filter(e => !isNaN(e.err)).map(e => Math.abs(e.err) / e.hz * 100));
console.log(`\n${shares.length + events.length - fail2} of ${shares.length + events.length} pass. Largest rise or set error ${worstPct.toFixed(3)} percent of the time until it.`);

// ---------- files for the validator ----------
writeFileSync(new URL('./out/accuracy.csv', import.meta.url),
  'site,body,date_utc,horizons_deg,ours_deg,error_deg,result,horizons_az_deg,ours_az_deg,direction_error_deg\n' +
  rows.map(r => [r.site, r.body, r.date, r.hEl, r.oEl.toFixed(6), r.elErr.toFixed(6), r.pass ? 'PASS' : 'FAIL', r.hAz, r.oAz.toFixed(6), r.sky.toFixed(6)].join(',')).join('\n') + '\n');
writeFileSync(new URL('./out/accuracy-timing.csv', import.meta.url),
  'start_utc,site,what,horizons,ours,error,allowed,unit,result\n' +
  shares.map(s => [s.start, s.site, s.what, s.hz.toFixed(3), s.ours.toFixed(3), s.err.toFixed(3), SHARE_TOL_PTS, 'percent of time', s.pass ? 'PASS' : 'FAIL'].join(',')).join('\n') + '\n' +
  events.map(e => [e.start, e.site, e.what, e.hz?.toFixed(4) ?? '', e.ours?.toFixed(4) ?? '', isNaN(e.err) ? '' : e.err.toFixed(4), e.tol.toFixed(4), 'hours after start', e.pass ? 'PASS' : 'FAIL'].join(',')).join('\n') + '\n');
console.log('Saved verify/out/accuracy.csv and verify/out/accuracy-timing.csv for the validator\'s sheet.');

const fails = fail1 + fail2;
console.log(`\nTOTAL: ${rows.length + shares.length + events.length - fails} of ${rows.length + shares.length + events.length} pass.`);
process.exit(fails ? 1 : 0);
