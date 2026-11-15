// sky-chart.js
// Horizon chart for one landing site: x = azimuth (0 to 360), y = elevation.
// Draws the skyline, the Sun and Earth tracks for the next ~30 days, and two
// markers for the current Sun and Earth. setNow() only moves the markers.
// Written with Claude Code (an AI coding agent).

const NS = 'http://www.w3.org/2000/svg';
const PAD = { l: 34, r: 10, t: 44, b: 20 };
const MAX_POINTS = 720;
const STYLE_ID = 'sky-chart-style';

const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  earth: '<path d="M21.54 15H17a2 2 0 0 0-2 2v4.54"/><path d="M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17"/><path d="M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05"/><circle cx="12" cy="12" r="10"/>',
};

const CSS = `
.sky-svg{display:block;width:100%;height:100%;background:#141518}
.sky-label{font:11px 'IBM Plex Mono',monospace;fill:#8b92a2}
.sky-level{stroke:rgba(238,240,245,0.16);stroke-width:1;stroke-dasharray:4 4;fill:none}
.sky-fill{fill:rgba(238,240,245,0.07);stroke:none}
.sky-edge{fill:none;stroke:rgba(238,240,245,0.45);stroke-width:1}
.sky-sun-all{fill:none;stroke:rgba(238,240,245,0.22);stroke-width:1}
.sky-sun-up{fill:none;stroke:rgba(238,240,245,0.85);stroke-width:1.5}
.sky-earth-all{fill:none;stroke:rgba(238,240,245,0.16);stroke-width:1;stroke-dasharray:3 3}
.sky-earth-up{fill:none;stroke:rgba(238,240,245,0.55);stroke-width:1.5;stroke-dasharray:3 3}
.sky-back{fill:#141518;stroke:none}
.sky-icon{fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.sky-body{color:#8b92a2}
.sky-body.sky-is-up{color:#eef0f5}
`;

let clipCounter = 0;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

const f = (n) => (Math.round(n * 10) / 10).toString();
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Y range from the skyline and the tracks, as described in the spec.
export function computeRange(horizon, track) {
  let minSky = 0, maxSky = -Infinity;
  for (let i = 0; i < horizon.length; i++) {
    const v = horizon[i];
    if (v < minSky) minSky = v;
    if (v > maxSky) maxSky = v;
  }
  const lo = Math.max(-10, Math.floor(Math.min(0, minSky) - 1));
  let top = Math.max(maxSky, lo);
  for (const s of track) {
    for (const b of [s.sun, s.earth]) {
      if (b && finite(b.el) && b.el > lo && b.el > top) top = b.el;
    }
  }
  let hi = Math.min(90, Math.ceil(top + 1));
  if (hi - lo < 4) hi = Math.min(90, lo + 4);
  return { lo, hi };
}

// 2 to 4 round-number ticks inside [lo, hi].
export function niceTicks(lo, hi) {
  for (const step of [1, 2, 5, 10, 15, 20, 30, 45, 90]) {
    const ticks = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
    if (ticks.length <= 4) return ticks.length >= 2 ? ticks : [lo, hi];
  }
  return [lo, hi];
}

// Split a track into polylines. Breaks at azimuth wraps and, when onlyUp is
// set, wherever the body is below the skyline.
function trackPaths(track, key, onlyUp, X, Y) {
  const parts = [];
  let cur = [], prevAz = null;
  const flush = () => { if (cur.length > 1) parts.push(cur); cur = []; };
  for (const s of track) {
    const b = s[key];
    if (!b || !finite(b.az) || !finite(b.el) || (onlyUp && !b.up)) { flush(); prevAz = null; continue; }
    if (prevAz !== null && Math.abs(b.az - prevAz) > 180) flush();
    cur.push(`${f(X(b.az))},${f(Y(b.el))}`);
    prevAz = b.az;
  }
  flush();
  return parts.map((p) => 'M' + p.join('L')).join('');
}

// Skyline polyline points, reduced to at most MAX_POINTS by taking the group max.
function skylinePoints(horizon, X, Y) {
  const n = horizon.length;
  const m = Math.min(n, MAX_POINTS);
  const pts = [];
  for (let j = 0; j < m; j++) {
    const a = Math.floor((j * n) / m), b = Math.floor(((j + 1) * n) / m);
    let mx = -Infinity;
    for (let k = a; k < Math.max(b, a + 1); k++) if (horizon[k] > mx) mx = horizon[k];
    pts.push([X((a * 360) / n), Y(mx)]);
  }
  pts.push([X(360), Y(horizon[0])]);
  return pts;
}

function ticksMarkup(lo, hi, X, Y, w, bottom) {
  let out = '';
  [['N', 0], ['E', 90], ['S', 180], ['W', 270], ['N', 360]].forEach(([t, az], i) => {
    const anchor = i === 0 ? 'start' : i === 4 ? 'end' : 'middle';
    out += `<text class="sky-label" x="${f(X(az))}" y="${bottom + 14}" text-anchor="${anchor}">${t}</text>`;
  });
  for (const v of niceTicks(lo, hi)) {
    out += `<text class="sky-label" x="${PAD.l - 6}" y="${f(Y(v) + 4)}" text-anchor="end">${v}°</text>`;
  }
  return out;
}

function markerMarkup(kind) {
  return `<g class="sky-body" data-body="${kind}" opacity="0"><circle class="sky-back" r="9"/>` +
    `<g class="sky-icon" transform="translate(-8 -8) scale(0.6667)">${ICONS[kind]}</g></g>`;
}

function describe(name, b) {
  if (!b || !finite(b.el)) return `${name} position unknown.`;
  const state = b.up ? 'above the skyline' : 'below the skyline';
  return `${name} ${f(Math.abs(b.el))} degrees ${b.el < 0 ? 'below the horizon' : 'high'}, ${state}.`;
}

export function createSkyChart(container) {
  ensureStyle();
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'sky-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  container.appendChild(svg);

  const clipId = 'sky-clip-' + (++clipCounter);
  let data = null, now = null, geo = null, markers = {};
  let size = { w: 0, h: 0 };

  function draw() {
    const w = container.clientWidth || 320, h = container.clientHeight || 300;
    size = { w, h };
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    if (!data) { svg.innerHTML = ''; geo = null; return; }
    const { horizon, track } = data;
    const { lo, hi } = computeRange(horizon, track);
    const pw = Math.max(1, w - PAD.l - PAD.r), ph = Math.max(1, h - PAD.t - PAD.b);
    const bottom = PAD.t + ph;
    const X = (az) => PAD.l + (az / 360) * pw;
    const Y = (el) => PAD.t + (1 - (el - lo) / (hi - lo)) * ph;
    geo = { X, Y, lo, bottom };

    const pts = skylinePoints(horizon, X, Y);
    const edge = 'M' + pts.map((p) => `${f(p[0])},${f(p[1])}`).join('L');
    const area = `${edge}L${f(X(360))},${bottom}L${f(X(0))},${bottom}Z`;
    const y0 = f(Y(0));
    const path = (cls, key, up) => `<path class="${cls}" d="${trackPaths(track, key, up, X, Y)}"/>`;

    svg.innerHTML =
      `<defs><clipPath id="${clipId}"><rect x="${PAD.l}" y="${PAD.t}" width="${pw}" height="${ph}"/></clipPath></defs>` +
      `<g clip-path="url(#${clipId})">` +
      `<line class="sky-level" x1="${PAD.l}" x2="${PAD.l + pw}" y1="${y0}" y2="${y0}"/>` +
      `<path class="sky-fill" d="${area}"/><path class="sky-edge" d="${edge}"/>` +
      path('sky-earth-all', 'earth', false) + path('sky-sun-all', 'sun', false) +
      path('sky-earth-up', 'earth', true) + path('sky-sun-up', 'sun', true) +
      markerMarkup('earth') + markerMarkup('sun') + `</g>` +
      ticksMarkup(lo, hi, X, Y, pw, bottom);
    markers = {
      sun: svg.querySelector('[data-body="sun"]'),
      earth: svg.querySelector('[data-body="earth"]'),
    };
    if (now) place();
  }

  function placeOne(kind, b) {
    const g = markers[kind];
    if (!g) return;
    if (!b || !finite(b.az) || !finite(b.el)) { g.setAttribute('opacity', '0'); return; }
    const below = b.el < geo.lo;
    const y = below ? geo.bottom - 8 : geo.Y(b.el);
    g.setAttribute('transform', `translate(${f(geo.X(((b.az % 360) + 360) % 360))} ${f(y)})`);
    g.setAttribute('opacity', below ? '0.5' : '1');
    g.setAttribute('class', b.up ? 'sky-body sky-is-up' : 'sky-body');
  }

  function place() {
    if (!geo || !now) return;
    placeOne('sun', now.sun);
    placeOne('earth', now.earth);
  }

  function setLabel() {
    if (!now) { svg.setAttribute('aria-label', 'Skyline with the paths of the Sun and Earth over the next 30 days.'); return; }
    svg.setAttribute('aria-label',
      'Skyline with the paths of the Sun and Earth over the next 30 days. ' +
      describe('Sun', now.sun) + ' ' + describe('Earth', now.earth));
  }

  function setNow(n) {
    now = n;
    place();
    setLabel();
  }

  function setData(d) {
    data = d && d.horizon && d.horizon.length ? { horizon: d.horizon, track: d.track || [] } : null;
    draw();
  }

  function resize() {
    draw();
  }

  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      if (container.clientWidth !== size.w || container.clientHeight !== size.h) draw();
    });
    ro.observe(container);
  }
  setLabel();

  function destroy() {
    if (ro) ro.disconnect();
    svg.remove();
  }

  return { setData, setNow, resize, destroy };
}
