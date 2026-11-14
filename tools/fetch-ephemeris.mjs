// Downloads Sun and Earth positions from JPL Horizons into site/data/ephemeris.json.
//
// How: Horizons gives the apparent azimuth, elevation and distance of the Sun and of Earth as seen from
// one reference point on the Moon (0 N, 0 E, on the 1737.4 km sphere). From those three numbers we
// rebuild each body's position as a vector from the Moon's centre, in the Moon's mean-Earth frame
// (MOON_ME, the frame LOLA maps use). lunar.js turns that vector back into elevation and azimuth for
// any other site, so it reproduces the corrections Horizons applies (light travel time, aberration,
// light bending) and Earth's parallax.
//
// Run: node tools/fetch-ephemeris.mjs [start] [stop] [step hours] [out file]
// Defaults cover 2026 to 2030 plus 60 days, every 6 hours.
import { writeFileSync } from 'node:fs';

const [START = '2026-01-01 00:00', STOP = '2031-03-05 00:00', STEP_H = '6', OUT = new URL('../site/data/ephemeris.json', import.meta.url).pathname] = process.argv.slice(2);
const R_MOON = 1737.4; // km, the sphere Horizons uses for the Moon
const D2R = Math.PI / 180;

function horizonsQuery(command, extra = {}) {
  return {
    format: 'json', COMMAND: `'${command}'`, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'", EPHEM_TYPE: "'OBSERVER'",
    CENTER: "'coord@301'", COORD_TYPE: "'GEODETIC'", SITE_COORD: "'0,0,0'",
    QUANTITIES: "'4,20'", ANG_FORMAT: "'DEG'", CSV_FORMAT: "'YES'", RANGE_UNITS: "'KM'", EXTRA_PREC: "'YES'", ...extra,
  };
}

async function fetchBody(command) {
  const q = horizonsQuery(command, { START_TIME: `'${START}'`, STOP_TIME: `'${STOP}'`, STEP_SIZE: `'${STEP_H} h'` });
  const res = await fetch('https://ssd.jpl.nasa.gov/api/horizons.api?' + new URLSearchParams(q));
  if (!res.ok) throw new Error(`Horizons answered HTTP ${res.status}`);
  const text = (await res.json()).result ?? '';
  const [head, rest] = text.split('$$SOE');
  if (!rest) throw new Error('Horizons returned no data:\n' + text.slice(-800));
  if (!/Center pole\/equ\s*:\s*MEAN_ME/.test(head)) throw new Error('Expected the Moon mean-Earth frame (MEAN_ME) in the Horizons header');
  // find columns by name so a change in Horizons' layout fails loudly instead of reading the wrong column
  const cols = head.trim().split('\n').filter(l => l.includes('Date__')).pop().split(',').map(s => s.trim());
  const iAz = cols.findIndex(c => c.startsWith('Azimuth')), iEl = cols.findIndex(c => c.startsWith('Elevation')), iD = cols.indexOf('delta');
  if (iAz < 0 || iEl < 0 || iD < 0) throw new Error('Unexpected Horizons columns: ' + cols.join(' | '));
  return rest.split('$$EOE')[0].trim().split('\n').map(line => {
    const c = line.split(',');
    const az = Number(c[iAz]) * D2R, el = Number(c[iEl]) * D2R, d = Number(c[iD]);
    // at 0 N 0 E: up is +x, east is +y, north is +z
    return { t: c[0].trim(), v: [R_MOON + d * Math.sin(el), d * Math.cos(el) * Math.sin(az), d * Math.cos(el) * Math.cos(az)] };
  });
}

const [sun, earth] = [await fetchBody('10'), await fetchBody('399')];
if (sun.length !== earth.length || sun.some((r, i) => r.t !== earth[i].t)) throw new Error('Sun and Earth rows do not line up');
const MONTHS = 'JanFebMarAprMayJunJulAugSepOctNovDec';
const toIso = t => { const [, y, m, d, hh, mm] = t.match(/(\d{4})-(\w{3})-(\d{2}) (\d{2}):(\d{2})/); return new Date(Date.UTC(+y, MONTHS.indexOf(m) / 3, +d, +hh, +mm)).toISOString(); };
const flat = (rows, digits) => rows.flatMap(r => r.v.map(x => Number(x.toFixed(digits))));

const out = {
  about: 'Sun and Earth positions from JPL Horizons (DE441), as vectors from the Moon centre in km, Moon mean-Earth frame (MOON_ME): x to 0 N 0 E, y to 0 N 90 E, z to the north pole. Built by tools/fetch-ephemeris.mjs.',
  query: { url: 'https://ssd.jpl.nasa.gov/api/horizons.api', sun: horizonsQuery('10', { START_TIME: `'${START}'`, STOP_TIME: `'${STOP}'`, STEP_SIZE: `'${STEP_H} h'` }), earthCommand: "'399'" },
  fetched: new Date().toISOString(),
  start: toIso(sun[0].t), stepHours: Number(STEP_H), count: sun.length,
  sun: flat(sun, 0),   // 1 km in 150 million km is 0.0000004 deg
  earth: flat(earth, 2),
};
writeFileSync(OUT, JSON.stringify(out));
console.log(`Wrote ${out.count} rows from ${out.start}, every ${STEP_H} h, to ${OUT}`);
