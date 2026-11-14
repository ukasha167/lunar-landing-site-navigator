/*
  lunar.js: where the Sun and Earth sit in the sky of any point on the Moon, and site stats.

  Sun and Earth positions come from JPL Horizons. tools/fetch-ephemeris.mjs stores them in
  site/data/ephemeris.json as vectors from the Moon's centre (km, Moon mean-Earth frame, the frame
  LOLA maps use), one row every 6 hours. Between rows we fit a cubic through the 4 nearest rows.
  From the vector we compute elevation and azimuth at a site, including Earth's parallax: Earth is
  close enough that moving from the Moon's centre to its surface shifts it by up to 0.27 deg.
  verify/accuracy.mjs checks the result against Horizons.

  Load the table before calling anything: await Lunar.loadEphemeris('data/ephemeris.json'),
  or Lunar.useEphemeris(json) when you already have it.

  Skylines: every built-in site's skyline was ray-cast by tools/build-sites.py over NASA maps, from 5 m pixels near
  the site out to 300 km, and ships in site/assets/sites/index.json. Load it with Lunar.useSkylines(json). Until
  then, and for places that are not built in, a site's skyline is flat; moon3d.js ray-casts one over LOLA heights
  for every picked place.

  No dependencies. Exposes window.Lunar.
*/
(function () {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const MOON_R_KM = 1737.4;        // the sphere Horizons and LOLA heights use
  const SUN_RADIUS_KM = 695700;    // IAU nominal solar radius
  const EARTH_RADIUS_KM = 6371.0;  // Earth mean radius
  const SYNODIC = 29.530589;       // mean days from sunrise to sunrise
  const SUN_R = 0.27, EARTH_R = 0.95; // typical apparent disc radius in deg, for drawing only

  // Landing points chosen by tools/build-sites.py (see its header); past landings as published.
  const SITES = [
    // SITES:BEGIN written by tools/build-sites.py
    { id: 'amundsen', name: "Amundsen Rim", short: "Amundsen rim", lat: -83.95748, lon: 70.39724, group: "Artemis III candidate regions" },
    { id: 'nobile2', name: "Nobile Rim 2", short: "Nobile rim 2", lat: -83.72531, lon: 59.40771, group: "Artemis III candidate regions" },
    { id: 'haworth', name: "Haworth", short: "Haworth", lat: -86.36748, lon: -23.23546, group: "Artemis III candidate regions" },
    { id: 'faustini', name: "Faustini Rim A", short: "Faustini rim", lat: -87.77382, lon: 94.66427, group: "Artemis III candidate regions" },
    { id: 'degerl2', name: "de Gerlache Rim 2", short: "de Gerlache 2", lat: -88.46512, lon: -67.84885, group: "Artemis III candidate regions" },
    { id: 'ridge-ext', name: "Connecting Ridge Extension", short: "Ridge ext.", lat: -89.01041, lon: -94.64472, group: "Artemis III candidate regions" },
    { id: 'ridge', name: "Connecting Ridge", short: "Conn. ridge", lat: -89.47485, lon: -137.44314, group: "Artemis III candidate regions" },
    { id: 'nobile1', name: "Nobile Rim 1", short: "Nobile rim 1", lat: -85.54411, lon: 37.62518, group: "Artemis III candidate regions" },
    { id: 'peak-shk', name: "Peak near Shackleton", short: "Peak nr Shackleton", lat: -88.8089, lon: 123.75606, group: "Artemis III candidate regions" },
    { id: 'degerl', name: "de Gerlache Rim", short: "de Gerlache", lat: -88.6683, lon: -68.33296, group: "Artemis III candidate regions" },
    { id: 'leibnitz', name: "Leibnitz Beta Plateau", short: "Leibnitz beta", lat: -85.41319, lon: 31.69247, group: "Artemis III candidate regions" },
    { id: 'malap', name: "Malapert Massif", short: "Malapert", lat: -86.03359, lon: 3.07285, group: "Artemis III candidate regions" },
    { id: 'kocher', name: "de Gerlache-Kocher Massif", short: "Kocher massif", lat: -85.82646, lon: -116.31613, group: "Artemis III candidate regions" },
    { id: 'mouton', name: "Mons Mouton (IM-2)", short: "Mons Mouton", lat: -84.8, lon: 29.2, group: "Past landings" },
    { id: 'ch3', name: "Shiv Shakti (Chandrayaan-3)", short: "Shiv Shakti", lat: -69.37, lon: 32.32, group: "Past landings" },
    { id: 'ce6', name: "Chang'e-6, Apollo basin", short: "Chang'e-6", lat: -41.64, lon: -153.99, group: "Past landings" },
    { id: 'a11', name: "Tranquility Base (Apollo 11)", short: "Apollo 11", lat: 0.674, lon: 23.473, group: "Past landings" },
    // SITES:END
  ];
  const flat = () => new Float32Array(360);
  SITES.forEach(s => { s.horizon = flat(); });

  /** Skylines from site/assets/sites/index.json: per site, elevation (deg) in equal azimuth steps from north, base64 int16 in 0.01 deg. */
  function useSkylines(json) {
    const dec = b64 => { const bin = atob(b64), a = new Int16Array(bin.length / 2);
      for (let i = 0; i < a.length; i++) a[i] = (bin.charCodeAt(2 * i) | bin.charCodeAt(2 * i + 1) << 8) << 16 >> 16;
      return Float32Array.from(a, v => v / 100); };
    for (const s of SITES) { const e = json.sites[s.id]; if (e) { s.horizon = dec(e.skyline); s.beyond = dec(e.beyond); s.elevKm = e.elev_m / 1000; s.data = e; } }
  }

  function makeSite({ name = 'Custom site', lat, lon }) {
    lat = Math.max(-89.99, Math.min(89.99, lat));
    return { id: 'c' + lat.toFixed(3) + '_' + lon.toFixed(3), name, short: name, lat, lon, group: 'Custom', horizon: flat() };
  }

  // skyline height (deg) at azimuth az, linear between bins; any number of equal bins
  function horizonAt(site, az) {
    const h = site.horizon, n = h.length, a = (((az % 360) + 360) % 360) * n / 360, i = Math.floor(a), f = a - i;
    return h[i % n] * (1 - f) + h[(i + 1) % n] * f;
  }

  // ---------- ephemeris table ----------
  let EPH = null;
  const RANGE = { start: null, end: null }; // first and last moment the table can answer
  function useEphemeris(json) {
    const t0 = Date.parse(json.start), step = json.stepHours * 36e5, n = json.count;
    if (json.sun.length !== n * 3 || json.earth.length !== n * 3) throw new Error('Lunar: ephemeris rows do not match its count');
    EPH = { t0, step, n, sun: Float64Array.from(json.sun), earth: Float64Array.from(json.earth) };
    // the cubic needs one row before and two after the moment asked for
    RANGE.start = new Date(t0 + step); RANGE.end = new Date(t0 + (n - 2) * step - 1);
    return RANGE;
  }
  async function loadEphemeris(url = 'data/ephemeris.json') {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Lunar: could not load ${url} (HTTP ${res.status})`);
    return useEphemeris(await res.json());
  }
  // Cubic through rows i-1, i, i+1, i+2 (Lagrange). With 6-hour rows the error is under 0.0001 deg.
  function interp(arr, d) {
    if (!EPH) throw new Error('Lunar: ephemeris not loaded. Call Lunar.loadEphemeris() first.');
    const x = (d.getTime() - EPH.t0) / EPH.step, i = Math.floor(x), t = x - i;
    if (!(i >= 1 && i <= EPH.n - 3)) throw new RangeError(`Lunar: ${d.toISOString()} is outside the ephemeris, which covers ${RANGE.start.toISOString()} to ${RANGE.end.toISOString()}`);
    const w0 = -t * (t - 1) * (t - 2) / 6, w1 = (t + 1) * (t - 1) * (t - 2) / 2, w2 = -(t + 1) * t * (t - 2) / 2, w3 = (t + 1) * t * (t - 1) / 6;
    const out = [0, 0, 0];
    for (let k = 0; k < 3; k++) out[k] = w0 * arr[(i - 1) * 3 + k] + w1 * arr[i * 3 + k] + w2 * arr[(i + 1) * 3 + k] + w3 * arr[(i + 2) * 3 + k];
    return out;
  }
  /** Sun or Earth position from the Moon's centre, km, Moon mean-Earth frame (x to 0 N 0 E, z to the north pole). */
  const sunVec = d => interp(EPH && EPH.sun, d);
  const earthVec = d => interp(EPH && EPH.earth, d);
  const toLL = v => { const km = Math.hypot(v[0], v[1], v[2]); return { lat: Math.asin(v[2] / km) * R2D, lon: Math.atan2(v[1], v[0]) * R2D, km }; };
  /** Point on the Moon with the Sun (or Earth) straight overhead, seen from the Moon's centre. */
  const subSolar = d => toLL(sunVec(d));
  const subEarth = d => toLL(earthVec(d));

  // Elevation and azimuth (from north, clockwise) of the point v (km, Moon frame) seen from the site.
  // The site stands on the 1737.4 km sphere plus its LOLA height when known.
  function lookAt(site, v) {
    const p = site.lat * D2R, l = site.lon * D2R, cp = Math.cos(p), sp = Math.sin(p), cl = Math.cos(l), sl = Math.sin(l);
    const r = MOON_R_KM + (site.elevKm || 0);
    const x = v[0] - r * cp * cl, y = v[1] - r * cp * sl, z = v[2] - r * sp, km = Math.hypot(x, y, z);
    const up = cp * cl * x + cp * sl * y + sp * z, east = -sl * x + cl * y, north = -sp * cl * x - sp * sl * y + cp * z;
    return { el: Math.asin(up / km) * R2D, az: (Math.atan2(east, north) * R2D + 360) % 360, km };
  }

  // Share of a disc above a straight skyline whose centre sits x radii above it (area, not height).
  const discAbove = x => x >= 1 ? 1 : x <= -1 ? 0 : 1 - (Math.acos(x) - x * Math.sqrt(1 - x * x)) / Math.PI;

  function body(site, v, radiusKm) {
    const { el, az, km } = lookAt(site, v);
    const radius = Math.asin(radiusKm / km) * R2D; // apparent radius, deg
    const hz = horizonAt(site, az);
    const margin = el - hz;
    return { el, az, km, radius, hz, margin, up: margin > 0, visibleFrac: discAbove(margin / radius) };
  }
  const sun = (site, d) => body(site, sunVec(d), SUN_RADIUS_KM);
  const earth = (site, d) => body(site, earthVec(d), EARTH_RADIUS_KM);

  function sample(site, start, hours, stepH = 1) {
    const out = [], t0 = start.getTime();
    for (let h = 0; h <= hours; h += stepH) {
      const d = new Date(t0 + h * 36e5);
      out.push({ t: d, h, sun: sun(site, d), earth: earth(site, d) });
    }
    return out;
  }

  // Contiguous runs where pick(sample) is true. Returns [{start, end, hours}].
  function windows(samples, pick) {
    const out = []; let cur = null;
    for (const s of samples) {
      if (pick(s)) { if (!cur) cur = { start: s.t, end: s.t }; cur.end = s.t; }
      else if (cur) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    out.forEach(w => w.hours = (w.end - w.start) / 36e5);
    return out;
  }

  // The moment between hours lo and hi (from date t0) where up() stops being `was`, to within about 1 minute.
  function refine(up, t0, lo, hi, was) {
    while (hi - lo > 1 / 64) { const mid = (lo + hi) / 2; if (up(new Date(t0 + mid * 36e5)) === was) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }

  // Hours until the Sun (or Earth) crosses the skyline, scanning forward in half-hour steps,
  // then halving the last step down to about 1 minute.
  function hoursUntilChange(site, d, which, maxH = 24 * 60, step = 0.5) {
    const f = which === 'sun' ? sun : earth, up = t => f(site, t).up, t0 = d.getTime();
    const now = up(d);
    for (let h = step; h <= maxH; h += step) if (up(new Date(t0 + h * 36e5)) !== now) return { hours: refine(up, t0, h - step, h, now), nowUp: now };
    return { hours: Infinity, nowUp: now };
  }

  function summary(site, d, spanDays = SYNODIC) {
    const s = sample(site, d, spanDays * 24, 1);
    const n = s.length;
    let sunN = 0, earthN = 0, both = 0, elSum = 0, elMax = -90;
    for (const x of s) {
      if (x.sun.up) { sunN++; elSum += x.sun.el; elMax = Math.max(elMax, x.sun.el); }
      if (x.earth.up) earthN++;
      if (x.sun.up && x.earth.up) both++;
    }
    const nowSun = sun(site, d), nowEarth = earth(site, d);
    // longest dark spell: find it on the hourly samples, then pin both ends down to about 1 minute
    // (a dark spell that runs past either end of the span is cut there)
    let longestDark = 0;
    const dark = windows(s, x => !x.sun.up);
    if (dark.length) {
      const w = dark.reduce((a, b) => b.hours > a.hours ? b : a), t0 = d.getTime(), up = t => sun(site, t).up;
      const h0 = (w.start - t0) / 36e5, h1 = (w.end - t0) / 36e5;
      const from = h0 > 0 ? refine(up, t0, h0 - 1, h0, true) : 0;
      const to = h1 < (n - 1) ? refine(up, t0, h1, h1 + 1, false) : n - 1;
      longestDark = to - from;
    }
    return {
      site, date: d, samples: s,
      sunFrac: sunN / n, earthFrac: earthN / n, bothFrac: both / n,
      meanSunEl: sunN ? elSum / sunN : null, maxSunEl: elMax,
      sun: nowSun, earth: nowEarth,
      sunChange: hoursUntilChange(site, d, 'sun'),
      earthChange: hoursUntilChange(site, d, 'earth'),
      longestDark,
    };
  }

  /*
    verdict(sum) turns a summary into a call a planner can act on.
    Return one of: { level: 'go' | 'marginal' | 'no-go', reason: '<short text>' }
    or null while the rule is not written (prototypes then show "unscored").

    Available on sum: sunFrac, earthFrac, bothFrac (0..1 over the window),
    meanSunEl, maxSunEl (deg), longestDark (hours), sun.up, earth.up,
    sun.margin / earth.margin (deg above local horizon),
    sunChange.hours / earthChange.hours (hours until the current state flips).
  */
  function verdict(sum) {
    // TODO(human): decide what makes a site-date "go", "marginal" or "no-go".
    return null;
  }

  function fmtHours(h) {
    if (!isFinite(h)) return 'none in 60 d';
    if (h < 48) return h.toFixed(h < 10 ? 1 : 0) + ' h';
    return (h / 24).toFixed(1) + ' d';
  }
  const fmtDate = d => d.toISOString().slice(0, 10);
  const fmtDT = d => d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const fmtDeg = (v, p = 2) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(p) + '°';

  window.Lunar = { SITES, makeSite, useSkylines, horizonAt, sun, earth, subSolar, subEarth, sunVec, earthVec, sample, windows, summary, verdict,
    hoursUntilChange, fmtHours, fmtDate, fmtDT, fmtDeg, SYNODIC, SUN_R, EARTH_R, SUN_RADIUS_KM, EARTH_RADIUS_KM, MOON_R_KM,
    loadEphemeris, useEphemeris, RANGE,
    site: id => SITES.find(s => s.id === id) };
})();
