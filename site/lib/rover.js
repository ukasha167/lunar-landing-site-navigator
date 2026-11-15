/*
  rover.js: drive a rover over one site's terrain, full screen. Loaded on the first click, so it costs
  nothing at page load.

  Ground: NASA maps only, Moon curvature throughout. The rover opens only where a map with 5 m pixels or finer
  holds the place (real-ground.js): NASA's 5 m shape-from-shading maps of the 13 Artemis III candidate regions,
  or the 2 m LROC stereo map of Apollo 11. It drives inside that map; beyond it the ground is the site's NASA block
  map (59 to 118 m), then LOLA's 625 m or 3.8 km grid. The one thing made up: craters under 4 m across and rocks
  under 1.3 m, which no map shows; the screen says so. The surface grain texture, the wheel tracks and the dust are
  visual effects, not map data.

  Terrain drawing (a geometry clipmap). 14 square grids of 128 x 128 points, all centred on the rover. Level 0
  has 0.5 m cells; each next level doubles the cell, so level 13 has 4 km cells and reaches 262 km, all of it
  NASA heights, so the distant mountains are real. Every level
  shows a cell at about 1 degree of view. Heights live
  in one float texture array, filled on the CPU. A grid wraps around inside its texture, so when the rover moves
  only the rows and columns it gains are computed. Near its outer edge each level slides its points onto the
  next level's grid and blends to its heights, so levels meet without cracks. Each level leaves out detail finer
  than 4 of its cells, which would only flicker. Physics reads every detail.

  Light. Each terrain point marches toward the Sun through the levels (in the vertex shader, so the cost follows
  the number of points, not pixels). The rover and the rocks cast shadows from a depth map seen from the Sun,
  redrawn only when something moved. Its edges blur by the width of the Sun's disc (0.53 degrees), so a shadow
  is sharp where it touches the rock and soft 20 m away, as on the Moon.

  Drawing in 3 depth ranges (sky, far ground, near ground) keeps depth precise from 0.25 m to 370 km.
  Frame cost: draw calls are batched (the rover is 4, the rocks 1), the screen is drawn only when something
  changed, and the pixel count drops when frames run late (dynamic resolution).

  Physics: rover-physics.js (a raycast vehicle in lunar gravity), tested by verify/rover.mjs. It costs 0.05 ms of a
  frame. Model: rover-model.js. Wheel tracks, dust and dynamic resolution: rover-fx.js.
  Written with Claude Code (an AI coding agent) at the team's direction. See README.md, "Use of AI".
*/
// No import of moon3d.js: openRover() takes the page's own copy (app.lib). A second copy, loaded under another
// version number by a cached page, would have no terrain data.
let THREE, OrbitControls, createEarth, createStars, createSkylineRing;
import { createVehicle, WHEELS, REST, COM } from './rover-physics.js?v=4';
import { buildRover } from './rover-model.js?v=2';
import { loadRealGround } from './real-ground.js?v=6';
import { createTracks, createDust, createDynamicResolution, TRK_M } from './rover-fx.js?v=4';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const N = 128, NL = 14, S0 = 0.5;                 // points per grid side, levels, level-0 cell (m)
// in cells of a level, from the rover: the finer level is drawn inside HOLE of the next one; points slide onto
// the next level's grid between MORPH0 and MORPH1
const HOLE = 0.45 * N, MORPH0 = 0.34375 * N, MORPH1 = 0.4375 * N;
// Both grids snap to even cells around the rover, so the finer grid starts N/4 or N/4 + 1 cells into the next
// one and the hole's edge lands within 2 cells of N/2 - HOLE/2: quads [HQ0, HQ1) are always covered by the finer level
const HQ0 = Math.ceil(N / 2 + 2 - HOLE / 2), HQ1 = Math.floor(N / 2 + HOLE / 2);
const SPLIT = 150;                                // near / far depth split (m)

// ---------- ground ----------
/**
  F: the relief block's field (moon3d.js tileField). lib: moon3d.js. real: patches from real-ground.js, finest first
  ([fine, block]). Returns { height(x, z, s), dataCell(x, z), outlines(), reach, rockAt, rocks }.
  reach: half-width (m) of the square around the site where the fine map covers every point fully.
*/
export function makeGround(F, { fieldHeight }, real) {
  const R = 1737400, seed = Math.round((F.lat + 90) * 1000) * 7919 + Math.round((F.lon + 180) * 1000);
  const { up, east, north } = F.frame, fine = real[0];
  let cellEff = 625; // pixel size (m) of the data under the last point sampled
  // height (m) from NASA data alone: the patches, finest last, over the block's own lookup (moon3d.js fieldHeight,
  // which already has the block patch and the 625 m or 3.8 km grid); Moon curvature included
  function data(x, z, s) {
    let h = 1000 * fieldHeight(F, x / 1000, -z / 1000, s / 1000), cell = 625;
    // the point on the sphere, as fieldHeight() places it
    const sx = x / R, sy = -z / R;
    let vx = up.x + east.x * sx + north.x * sy, vy = up.y + east.y * sx + north.y * sy, vz = up.z + east.z * sx + north.z * sy;
    const k = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz); vx *= k; vy *= k; vz *= k;
    const curv = (x * x + z * z) / (2 * R);
    for (let i = real.length - 1; i >= 0; i--) {
      const p = real[i], v = p.sample(vx, vy, vz, s) - curv;
      if (p.w > 0) { h += (v - h) * p.w; cell += (p.scale - cell) * p.w; }
    }
    cellEff = cell; return h;
  }
  const H0 = data(0, 0, 0);
  const hash = (i, j, k) => {
    let h = (Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(k, 0x9e3779b1) ^ seed) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  // made-up small craters, under 4 m across: one in 10 m cells half the time, radius 0.6 to 2 m (rim included)
  const CR_CELL = 10, CR_P = 0.5;
  function craters(x, z) {
    const ci = Math.floor(x / CR_CELL), cj = Math.floor(z / CR_CELL), b = 16; let h = 0;
    for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) {
      if (hash(i, j, b) >= CR_P) continue;
      const r = 0.6 + 1.0 * hash(i, j, b + 1), dx = x - (i + hash(i, j, b + 2)) * CR_CELL, dz = z - (j + hash(i, j, b + 3)) * CR_CELL;
      const dd = Math.sqrt(dx * dx + dz * dz) / r; if (dd >= 1.25) continue;
      // depth 7% to 18% of the width: most small lunar craters are worn shallow, a few are fresh and steep
      const u = hash(i, j, b + 4), depth = 2 * r * (0.07 + 0.11 * u * u);
      h += (dd < 1 ? -depth * (1 - dd * dd) : 0) + 0.22 * depth * Math.exp(-(((dd - 1) / 0.2) ** 2));
    }
    return h;
  }
  // made-up rocks: half-buried domes, radius 8 cm to 63 cm, about one per 11 m²
  function rockAt(i, j) {
    if (hash(i, j, 90) >= 0.22) return null;
    return { r: 0.08 + 0.55 * hash(i, j, 91) ** 3, x: (i + 0.2 + 0.6 * hash(i, j, 92)) * 2.5, z: (j + 0.2 + 0.6 * hash(i, j, 93)) * 2.5, spin: hash(i, j, 94) * 6.283 };
  }
  function rocks(x, z) {
    const ci = Math.floor(x / 2.5), cj = Math.floor(z / 2.5); let h = 0;
    for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) {
      if (hash(i, j, 90) >= 0.22) continue;
      const r = 0.08 + 0.55 * hash(i, j, 91) ** 3, dx = x - (i + 0.2 + 0.6 * hash(i, j, 92)) * 2.5, dz = z - (j + 0.2 + 0.6 * hash(i, j, 93)) * 2.5;
      const q = (dx * dx + dz * dz) / (r * r); if (q < 1) h = Math.max(h, 0.55 * r * (1 - q));
    }
    return h;
  }
  /** Height (m) above the site's centre at (x east, z south) m. s: cell size it will be sampled at (0 = all detail). */
  function height(x, z, s = 0) {
    let h = data(x, z, s) - H0;
    // the made-up craters and rocks only on the fine map, and only on grids fine enough to show them
    if (cellEff <= fine.scale + 0.01) {
      if (s <= 0.4) h += craters(x, z);
      if (s <= 0.5) h += rocks(x, z);
    }
    return h;
  }
  /** pixel size (m) of the NASA data under (x, z) */
  function dataCell(x, z) { data(x, z, 0); return cellEff; }
  // local x, z (m) of a unit vector, on the site's tangent plane
  const local = v => { const u = v[0] * up.x + v[1] * up.y + v[2] * up.z; return [R * (v[0] * east.x + v[1] * east.y + v[2] * east.z) / u, -R * (v[0] * north.x + v[1] * north.y + v[2] * north.z) / u]; };
  /** each NASA patch's outline in local x, z (m): [{ scale, pts: [[x, z] x 4] }] */
  const outlines = () => real.map(p => ({ scale: p.scale, pts: p.corners.map(local) }));
  // the largest square around the site that the fine map covers fully (checked every 20 m along its edge)
  function fullAt(x, z) { data(x, z, 0); return cellEff <= fine.scale + 0.01; }
  let lo = 0, hi = 8000;
  while (hi - lo > 20) {
    const m = (lo + hi) / 2; let ok = true;
    for (let t = -m; t <= m && ok; t += 20) ok = fullAt(t, -m) && fullAt(t, m) && fullAt(-m, t) && fullAt(m, t);
    if (ok) lo = m; else hi = m;
  }
  return { height, dataCell, outlines, reach: lo, rockAt, rocks, fineScale: fine.scale };
}

// ---------- terrain shaders ----------
const TERRAIN_VS = /* glsl */`
  precision highp float; precision highp int; precision highp sampler2DArray;
  uniform sampler2DArray uH;
  uniform int uL, uNL; uniform float uS, uS0, uFarM; uniform ivec2 uO; uniform vec2 uC; uniform vec3 uSun;
  varying vec3 vW; varying vec3 vN; varying float vSh; varying float vK;
  const int N = ${N};
  float hAt(int l, ivec2 i) { return texelFetch(uH, ivec3(i & (N - 1), l), 0).r; }
  float bil(int l, vec2 f) {
    vec2 f0 = floor(f), t = f - f0; ivec2 i = ivec2(f0);
    return mix(mix(hAt(l, i), hAt(l, i + ivec2(1, 0)), t.x), mix(hAt(l, i + ivec2(0, 1)), hAt(l, i + ivec2(1, 1)), t.x), t.y);
  }
  vec3 nrm(int l, ivec2 i, float s) {
    return normalize(vec3(hAt(l, i - ivec2(1, 0)) - hAt(l, i + ivec2(1, 0)), 2. * s, hAt(l, i - ivec2(0, 1)) - hAt(l, i + ivec2(0, 1))));
  }
  // Sunlight reaching P: march toward the Sun, each step read from the finest level that holds it.
  // 0.0047 rad is the Sun's radius, so the edge of a shadow is a soft penumbra, as on the Moon.
  float sunVis(vec3 P) {
    if (uSun.y < -0.03) return 0.;
    float hs = length(uSun.xz); vec2 dir = uSun.xz / max(hs, 1e-5);
    float tanEl = uSun.y / max(hs, 1e-5), minM = 1., d = 2.5 * uS, reach = ${HOLE.toFixed(1)} * uS0 * exp2(float(uNL - 1));
    bool edge = false;
    for (int i = 0; i < 22; i++) {
      vec2 q = P.xz + dir * d;
      float c = max(abs(q.x - uC.x), abs(q.y - uC.y));
      if (c > reach) { edge = true; break; }
      int l = clamp(int(ceil(log2(max(c, 1e-3) / (${HOLE.toFixed(1)} * uS0)))), 0, uNL - 1);
      float s = uS0 * exp2(float(l));
      // smooth heights for the first 8 steps, where neighbouring points must agree or a ridge wall stripes;
      // the nearest cell after that
      float hq = i < 8 ? bil(l, q / s) : hAt(l, ivec2(floor(q / s + .5)));
      minM = min(minM, (P.y + 0.05 + d * tanEl - hq) / d);
      if (minM < -0.006) break;
      d *= 1.6;
    }
    // a march that stopped short of the terrain's edge: the site's LOLA skyline stands in for the rest
    if (!edge) minM = min(minM, uFarM);
    float soft = 0.0047 + min(uS, 256.) * 0.00006; // the Sun's radius, widened by the cell size so coarse levels do not stripe
    return smoothstep(-soft, soft, minM);
  }
  void main() {
    ivec2 wi = uO + ivec2(position.xz + .5);
    vec2 pw = vec2(wi) * uS;
    float dist = max(abs(pw.x - uC.x), abs(pw.y - uC.y)) / uS;
    float k = uL < uNL - 1 ? clamp((dist - ${MORPH0.toFixed(2)}) / ${(MORPH1 - MORPH0).toFixed(2)}, 0., 1.) : 0.;
    // odd points slide onto the even ones below them: at k = 1 this grid is the next level's grid
    vec2 m = vec2(wi) - vec2(wi & 1) * k;
    float h = bil(uL, m); vec3 n = nrm(uL, wi, uS);
    if (k > 0.) { h = mix(h, bil(uL + 1, m * .5), k); n = normalize(mix(n, nrm(uL + 1, ivec2(floor(m * .5 + .25)), 2. * uS), k)); }
    vec3 P = vec3(m.x * uS, h, m.y * uS);
    vW = P; vN = n; vSh = sunVis(P); vK = k;
    gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.);
  }
`;
// The Sun's shadow of the rover and the rocks, read from a depth map seen from the Sun. Its edge is as soft as
// the Sun's disc makes it: the blur widens by 0.0093 m for every metre between the shadow and what casts it
// (the Sun is 0.53 degrees across), the way percentage-closer soft shadows estimate it.
const SMW = 2048, SMH = 1024;                     // shadow map texels: across the sunlight, and up it
const SHADOW_GLSL = /* glsl */`
  uniform sampler2D uSM; uniform mat4 uSMMat; uniform vec4 uSMInfo; // near (m), depth range (m), map width and height (m)
  const vec2 SM_DISK[12] = vec2[](vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621),
    vec2(0.962, -0.195), vec2(0.473, -0.480), vec2(0.519, 0.767), vec2(0.185, -0.893), vec2(0.507, 0.064), vec2(0.896, 0.412),
    vec2(-0.322, -0.933), vec2(-0.792, -0.598));
  float smDist(vec2 uv) { return uSMInfo.x + texture(uSM, uv).r * uSMInfo.y; }
  float sunShadowAt(vec3 P) {
    vec3 q = (uSMMat * vec4(P, 1.)).xyz; // place on the map (0 to 1) and distance along the sunlight (m)
    if (q.x <= 0. || q.y <= 0. || q.x >= 1. || q.y >= 1. || q.z < uSMInfo.x) return 1.;
    float a = fract(sin(dot(P.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2832;
    mat2 R = mat2(cos(a), sin(a), -sin(a), cos(a)); vec2 toUV = 1. / uSMInfo.zw;
    // never blur less than 1.5 map texels: with the Sun 1 degree up one texel stretches about 1 m along the ground,
    // and a sharper edge would show it as steps
    float minR = 1.5 * max(uSMInfo.z / ${SMW}., uSMInfo.w / ${SMH}.);
    // 1. anything between this point and the Sun's disc, and how far from the point it stands
    float rs = clamp((q.z - uSMInfo.x) * 0.00465, max(0.04, minR), 0.3), sum = 0., n = 0.;
    float d0 = smDist(q.xy); if (d0 < q.z - 0.03) { sum += d0; n += 1.; }
    for (int i = 0; i < 12; i++) { float d = smDist(q.xy + R * SM_DISK[i] * rs * toUV); if (d < q.z - 0.03) { sum += d; n += 1.; } }
    if (n == 0.) return 1.;
    // 2. the share of the Sun's disc those blockers leave in view
    float pr = clamp((q.z - sum / n) * 0.00465, minR, 0.3), lit = 0.;
    for (int i = 0; i < 12; i++) lit += smDist(q.xy + R * SM_DISK[i] * pr * toUV) < q.z - 0.03 ? 0. : 1.;
    return lit / 12.;
  }
`;
const TERRAIN_FS = /* glsl */`
  precision highp float; precision highp int; precision highp sampler2DArray;
  uniform sampler2DArray uH; uniform int uL; uniform float uS;
  uniform vec3 uSun; uniform float uBlock, uHasHole, uHead, uBounce, uExpo; uniform vec4 uHole;
  uniform vec3 uLampPos, uLampDir; uniform sampler2D uTrk; uniform vec4 uTrkWin;
  varying vec3 vW; varying vec3 vN; varying float vSh; varying float vK;
  ${SHADOW_GLSL}
  float trk(vec2 p) { return texture(uTrk, p / ${TRK_M}.).r; } // wheel-track depth, 0 to 1 (rover-fx.js)
  const int N = ${N};
  float hAt(int l, ivec2 i) { return texelFetch(uH, ivec3(i & (N - 1), l), 0).r; }
  float bil(int l, vec2 f) {
    vec2 f0 = floor(f), t = f - f0; ivec2 i = ivec2(f0);
    return mix(mix(hAt(l, i), hAt(l, i + ivec2(1, 0)), t.x), mix(hAt(l, i + ivec2(0, 1)), hAt(l, i + ivec2(1, 1)), t.x), t.y);
  }
  // normal at this pixel from the height grid: with the Sun 2 degrees up, brightness follows the normal so
  // closely that normals blended across each triangle pair paint stripes on steep walls far away
  vec3 pixelNormal() {
    int l = vK > .5 ? uL + 1 : uL; float s = vK > .5 ? 2. * uS : uS; vec2 f = vW.xz / s;
    return normalize(vec3(bil(l, f - vec2(1, 0)) - bil(l, f + vec2(1, 0)), 2. * s, bil(l, f - vec2(0, 1)) - bil(l, f + vec2(0, 1))));
  }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float vnoise(vec2 p) { vec2 i = floor(p), f = p - i; f = f * f * (3. - 2. * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
  void main() {
    if (uHasHole > .5 && vW.x > uHole.x && vW.x < uHole.z && vW.z > uHole.y && vW.z < uHole.w) discard;
    vec3 n = uL >= 2 ? pixelNormal() : normalize(vN), V = normalize(cameraPosition - vW); // near levels have points every 0.5 to 1 m
    // wheel tracks: a groove 1.5 cm deep. Its walls tilt the normal, and with the Sun low its floor lies in the
    // shadow of its own rim, still lit at about half strength by the sunlit wall facing it (that wall gets far
    // more light than flat ground when the Sun is this low). Faded where a pixel spans more than about 4 texels.
    float tk = 0., tkSh = 1.;
    vec2 tp = vW.xz - uTrkWin.xy;
    if (uL <= 2 && tp.x > 0. && tp.y > 0. && tp.x < uTrkWin.z && tp.y < uTrkWin.z) {
      float e = uTrkWin.w, fade = clamp(1.6 - length(fwidth(vW.xz)) * 4.5, 0., 1.);
      if (fade > 0.) {
        tk = trk(vW.xz) * fade;
        vec2 g = vec2(trk(vW.xz + vec2(e, 0.)) - trk(vW.xz - vec2(e, 0.)), trk(vW.xz + vec2(0., e)) - trk(vW.xz - vec2(0., e))) * fade * (0.015 / (2. * e));
        n = normalize(n + vec3(g.x, 0., g.y));
        vec2 sd = normalize(uSun.xz + 1e-6); float tanE = uSun.y / max(length(uSun.xz), 1e-4);
        for (int i = 1; i <= 4; i++) {
          float d = float(i) * 0.05, rise = 0.015 * (tk - trk(vW.xz + sd * d) * fade) - d * tanE;
          tkSh = min(tkSh, clamp(1. - rise / 0.004, 0., 1.));
        }
        tkSh = mix(0.5, 1., tkSh);
      }
    }
    float mu0 = dot(n, uSun), mu = max(dot(n, V), 1e-3);
    float lit = mu0 > 0. ? mu0 / (mu0 + mu) * 2. : 0.;   // Lommel-Seeliger, the law the relief block uses
    lit *= vSh * (1. - uBlock);
    if (lit > 0.) lit *= sunShadowAt(vW) * tkSh;
    // regolith grain, faded out where a pixel covers more than a few grains
    float px = length(fwidth(vW.xz)), fade = clamp(1. - px * 2., 0., 1.);
    float grain = mix(.5, vnoise(vW.xz * 3.1) * .45 + vnoise(vW.xz * .37 + 17.) * .55, fade);
    // pressed soil is darker: orbiting cameras see the Apollo rovers' tracks as dark lines
    vec3 albedo = vec3(.16, .155, .15) * (.84 + .32 * grain) * (1. - .18 * tk);
    // uBounce: sunlight reflected off lit ground nearby. It is what lets NASA's ShadowCam see into craters that
    // the Sun never reaches; here it keeps shadowed ground a very dark grey instead of black
    vec3 col = albedo * (lit * 2.4 + uBounce);
    if (uHead > 0.) { // headlights: a cone of about 25 degrees, falling off with distance squared
      vec3 Lv = uLampPos - vW; float dl = length(Lv); Lv /= dl;
      col += albedo * uHead * smoothstep(.88, .95, dot(-Lv, uLampDir)) * max(dot(n, Lv), 0.) * 30. / (dl * dl + 6.);
    }
    // the map (uExpo > 1, looking straight down): sunlight with a soft roll-off so sunlit slopes do not all turn
    // white, over a faint relief shading lit from the north-west (the map convention) so shadowed ground keeps its shape
    if (uExpo > 1.) {
      float nw = max(dot(n, normalize(vec3(-1., 1.6, -1.))), 0.), relief = .006 + .03 * nw;
      col = (vec3(1.) - exp(-albedo * lit * 2.4 * uExpo)) * (.3 + .7 * nw); // sunlight, still showing the slopes
      col = vec3(1.) - (vec3(1.) - col) * (1. - relief);
    }
    gl_FragColor = vec4(col, 1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ---------- page furniture ----------
const CSS = `
  body.rover-on .layout { visibility: hidden; }
  .rover-view { position: fixed; inset: 0; cursor: grab; touch-action: none; }
  .rover-view:active { cursor: grabbing; }
  .rover-hud { position: fixed; inset: 0; z-index: 6; pointer-events: none; color: var(--text); font: 400 14px/1.4 Archivo, system-ui, sans-serif; }
  .rover-hud .card { pointer-events: auto; background: rgba(17, 18, 20, 0.84); border: 1px solid var(--line-strong); border-radius: 12px; }
  /* glass: the quiet pill look shared by the corner controls, so the ground stays the main thing on screen */
  .rv-glass { pointer-events: auto; background: rgba(14, 15, 18, 0.48); border: 1px solid rgba(238, 240, 245, 0.13); border-radius: 999px; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
  .rv-top { position: absolute; top: 22px; left: 24px; right: 24px; display: flex; align-items: center; gap: 10px; }
  .rv-id { display: inline-flex; align-items: center; gap: 8px; padding: 5px 7px; min-width: 0; }
  .rv-id .letter { width: 22px; height: 22px; font-size: 11px; line-height: 22px; }
  .rv-name { font-weight: 500; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rover-hud .rv-dot { width: 22px; height: 22px; padding: 0; border-radius: 50%; flex: none; color: var(--text-2); background: rgba(255, 255, 255, 0.06); border-color: rgba(238, 240, 245, 0.14); }
  .rover-hud .rv-dot .ic { width: 14px; height: 14px; }
  .rv-time { display: inline-flex; align-items: center; gap: 3px; padding: 3px; margin-left: auto; font: 500 12.5px 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; }
  .rv-time span { padding: 0 5px; }
  .rover-hud .rv-time button, .rover-hud .rv-exit { height: 26px; padding: 0 9px; border-radius: 999px; font-size: 12px; color: var(--text-2); background: rgba(255, 255, 255, 0.04); border-color: rgba(238, 240, 245, 0.12); }
  .rover-hud .rv-exit { height: 32px; padding: 0 12px; }
  .rover-hud .rv-time button:hover, .rover-hud .rv-exit:hover, .rover-hud .rv-dot:hover, .rover-hud .rv-dot[aria-expanded="true"] { color: var(--text); background: rgba(255, 255, 255, 0.14); }
  .rv-bottom { position: absolute; left: 24px; bottom: 24px; display: flex; align-items: flex-end; gap: 14px; }
  /* fixed size: a status turning red changes a colour and a word, never the panel's shape */
  .rv-panel { width: 260px; padding: 10px 12px; display: grid; gap: 8px; }
  .rv-pills { display: flex; align-items: center; gap: 6px; }
  .rv-pill { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px; border-radius: 999px; font-size: 12px; white-space: nowrap; color: var(--text-2); background: rgba(255, 255, 255, 0.04); border: 1px solid var(--line); transition: color 160ms, background-color 160ms, border-color 160ms; }
  .rv-pill i { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--ok); }
  .rv-pill.bad { color: var(--void); background: rgba(240, 101, 104, 0.10); border-color: rgba(240, 101, 104, 0.40); }
  .rv-pill.bad i { background: var(--void); }
  .rover-hud .rv-specs { height: 24px; padding: 0 9px; margin-left: auto; border-radius: 999px; font-size: 12px; color: var(--text-2); background: transparent; border-color: var(--line-strong); }
  .rover-hud .rv-specs:hover, .rover-hud .rv-specs[aria-expanded="true"] { color: var(--text); background: rgba(255, 255, 255, 0.08); }
  .rv-stats { font: 400 12.5px 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rv-stats .warn { color: var(--warn); }
  .rover-hud .rv-map { position: relative; width: 192px; height: 192px; flex: none; background: transparent; overflow: hidden; border-radius: 14px; }
  .rv-map-gl { position: absolute; inset: 0; }
  .rv-map svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .rv-map-n { font: 600 11px Archivo, system-ui, sans-serif; fill: var(--text); paint-order: stroke; stroke: #000; stroke-width: 3px; }
  .rv-map-zoom { position: absolute; right: 6px; top: 6px; display: grid; gap: 4px; }
  .rv-map-zoom button { width: 24px; height: 24px; padding: 0; justify-content: center; background: rgba(24, 25, 28, 0.88); }
  .rv-map-scale { position: absolute; left: 8px; bottom: 14px; font: 500 11px 'IBM Plex Mono', monospace; color: var(--text); text-shadow: 0 0 3px #000, 0 0 3px #000; }
  .rv-map-mark { position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px; color: var(--text); filter: drop-shadow(0 0 2px #000); display: grid; place-items: center; }
  .rv-map-mark .ic { width: 16px; height: 16px; }
  .rv-map-mark.off { opacity: 0.35; }
  .rover-hud .rv-keys-btn { position: absolute; right: 24px; bottom: 24px; width: 32px; height: 32px; padding: 0; color: var(--text-2); }
  .rover-hud .rv-keys-btn:hover, .rover-hud .rv-keys-btn[aria-expanded="true"] { color: var(--text); }
  /* popovers sit in the top layer, placed by script next to their button */
  .rv-pop { pointer-events: auto; position: fixed; inset: auto; margin: 0; width: 300px; max-width: calc(100vw - 16px); padding: 12px 14px; border-radius: 10px; background: #1b1d22; border: 1px solid var(--line-strong); color: var(--text-2); font: 400 12.5px/1.45 Archivo, system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5); }
  .rv-pop strong { color: var(--text); font-weight: 500; }
  .rv-rows { display: grid; gap: 6px; }
  .rv-row { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 8px; align-items: baseline; }
  .rv-row > span { color: var(--muted); }
  .rv-row > strong { font-variant-numeric: tabular-nums; }
  .rv-keys-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; margin-top: 8px; align-items: center; }
  .rv-pop kbd { font: 500 11.5px 'IBM Plex Mono', monospace; padding: 1px 5px; border: 1px solid var(--line-strong); border-radius: 4px; color: var(--text); white-space: nowrap; }
  .rv-msg { position: absolute; top: 64px; left: 50%; transform: translateX(-50%); max-width: calc(100vw - 32px); padding: 5px 14px; border-radius: 999px !important; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--warn); border-color: var(--warn-border) !important; pointer-events: none !important; }
  .rv-wait { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); padding: 10px 14px; color: var(--text-2); }
  @media (max-width: 760px) { .rv-top { left: 12px; right: 12px; } .rv-bottom { left: 12px; bottom: 12px; gap: 8px; } .rover-hud .rv-map { width: 132px; height: 132px; } .rv-panel { width: 220px; } .rover-hud .rv-keys-btn { display: none; } }
`;
const MIN_ICON = '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>';

let current = null;
/** The open rover, for measuring in devtools: { state, vehicle, debug: { data, levels, H, N, dyn, rover, sm, smRT }, close() } or null. */
export const activeRover = () => current;

/**
  Open the rover on a place's terrain. app: from createApp(). place: one of app.places.
  options.letter: the site's letter; options.icon(name): the page's icon helper; options.fmtWhen(date).
  Returns { close }.
*/
export function openRover(app, place, opts) {
  // a throw during setup must not leave the page blank: undo what the setup did, warn, and rethrow
  const views = app.stage.views.map(v => [v, v.hidden]), dpr = app.stage.maxDpr;
  try { return build(app, place, opts); } catch (e) {
    console.warn('Rover setup failed:', e);
    if (current) current.close();
    else { document.querySelectorAll('.rover-view, .rover-hud').forEach(n => n.remove()); }
    document.body.classList.remove('rover-on');
    for (const [v, h] of views) v.hidden = h;
    app.stage.maxDpr = dpr; app.stage.request();
    throw e;
  }
}
function build(app, place, { letter = '', icon = () => '', fmtWhen = d => d.toISOString() } = {}) {
  if (current) current.close();
  if (!document.getElementById('rover-css')) { const st = document.createElement('style'); st.id = 'rover-css'; st.textContent = CSS; document.head.append(st); }
  ({ THREE, OrbitControls, createEarth, createStars } = app.lib);
  const relief = place.relief, stage = app.stage;
  // the ground is built once the NASA heights for this place have loaded (see the start, at the end)
  let ground = null; const H = (x, z, s) => ground.height(x, z, s);

  // --- DOM: the view element the Stage draws into, and the HUD over it ---
  const viewEl = document.createElement('div'); viewEl.className = 'rover-view';
  viewEl.setAttribute('role', 'application'); viewEl.setAttribute('aria-label', `Rover at ${place.name}. Drag to look around. W and S drive, A and D steer.`);
  const hud = document.createElement('div'); hud.className = 'rover-hud';
  const svg = (paths, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const INFO_ICON = '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>';
  const KEY_LIST = [[['W', 'S'], 'drive'], [['A', 'D'], 'steer'], [['Space'], 'brake'], [['Shift'], 'fast travel'], [['R'], 'put upright'], [['C'], 'camera'], [['L'], 'lights'], [['M'], 'map scale'], [['?'], 'this list'], [['Esc'], 'exit']];
  hud.innerHTML = `
    <div class="rv-top">
      <div class="rv-glass rv-id"><span class="letter" aria-hidden="true">${letter}</span><span class="rv-name"></span>
        <button type="button" class="rv-dot rv-about-btn" aria-expanded="false" aria-label="Where this ground comes from">${svg(INFO_ICON)}</button></div>
      <div class="rv-glass rv-time" role="group" aria-label="Time">
        <button type="button" class="sm rv-back" aria-label="One hour earlier">&minus;1 h</button><span class="rv-when"></span>
        <button type="button" class="sm rv-fwd" aria-label="One hour later">+1 h</button></div>
      <button type="button" class="rv-glass rv-exit">Exit</button>
    </div>
    <div class="rv-bottom">
      <div class="card rv-map" role="img" aria-label="Map of the ground around the rover, north up. Your trail is the orange line.">
        <div class="rv-map-gl"></div>
        <svg viewBox="0 0 220 220" aria-hidden="true">
          <path class="rv-map-data" fill="none" stroke="rgba(238,240,245,0.6)" stroke-width="1" stroke-dasharray="4 3"/>
          <polyline class="rv-map-trail" fill="none" stroke="#f5b841" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
          <circle class="rv-map-site" r="4.5" fill="#111214" stroke="#eef0f5" stroke-width="1.5"/>
          <path class="rv-map-rover" d="M0 -8 L5.5 6 L0 3 L-5.5 6 Z" fill="#eef0f5" stroke="#111214" stroke-width="1.2" stroke-linejoin="round"/>
          <text class="rv-map-n" x="110" y="15" text-anchor="middle">N</text>
          <line class="rv-map-bar" x1="8" y1="208" x2="60" y2="208" stroke="#eef0f5" stroke-width="2"/>
        </svg>
        <span class="rv-map-mark rv-map-sun" title="Direction of the Sun">${icon('sun')}</span>
        <span class="rv-map-mark rv-map-earth" title="Direction of Earth">${icon('earth')}</span>
        <span class="rv-map-scale"></span>
        <div class="rv-map-zoom"><button type="button" class="sm rv-zin" aria-label="Zoom the map in">+</button><button type="button" class="sm rv-zout" aria-label="Zoom the map out">&minus;</button></div>
      </div>
      <div class="card rv-panel" aria-live="off">
        <div class="rv-pills">
          <span class="rv-pill rv-sun"><i></i><span>Sun</span></span>
          <span class="rv-pill rv-earth"><i></i><span>Earth</span></span>
          <button type="button" class="rv-specs" aria-expanded="false">Specs</button>
        </div>
        <p class="rv-stats"></p>
      </div>
    </div>
    <button type="button" class="rv-glass rv-keys-btn" aria-expanded="false" aria-label="Rover controls">?</button>
    <div class="rv-pop rv-about-pop" popover="manual" role="tooltip"><span class="rv-note">Loading NASA's map of this place…</span></div>
    <div class="rv-pop rv-specs-pop" popover="manual" role="tooltip"><div class="rv-rows">${['Sun', 'Earth', 'Ground', 'Distance', 'Slope', 'Camera', 'Time'].map(k => `<div class="rv-row"><span>${k}</span><strong></strong></div>`).join('')}</div></div>
    <div class="rv-pop rv-keys-pop" popover="manual" role="tooltip"><strong>Rover controls</strong>
      <div class="rv-keys-grid">${KEY_LIST.map(([ks, act]) => `<span>${ks.map(k => `<kbd>${k}</kbd>`).join(' ')}</span><span>${act}</span>`).join('')}</div></div>
    <div class="card rv-msg" role="status" hidden></div>
    <div class="card rv-wait">Loading NASA heights…</div>`;
  const $ = s => hud.querySelector(s);
  $('.rv-name').textContent = place.name; $('.rv-name').title = place.name;
  document.body.append(viewEl, hud); document.body.classList.add('rover-on');

  // --- scenes and cameras ---
  const world = new THREE.Scene(), sky = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.25, 90000);
  const farCam = new THREE.PerspectiveCamera(55, 1, SPLIT - 5, 4e5), nearCam = new THREE.PerspectiveCamera(55, 1, 0.25, SPLIT + 5), skyCam = new THREE.PerspectiveCamera(55, 1, 1000, 3e7);
  const controls = new OrbitControls(camera, viewEl);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.1, enablePan: false, minDistance: 4, maxDistance: 80, rotateSpeed: 0.5, maxPolarAngle: Math.PI * 0.53 });

  // sky: Sun disc, Earth and stars, drawn from the origin so they keep their directions
  const sunDisc = new THREE.Mesh(new THREE.CircleGeometry(1e6 * Math.tan(0.27 * D2R), 48), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  const earth = createEarth({ radius: 1e6 * Math.tan(0.95 * D2R) });
  const stars = createStars(1600, 8e6, 11);
  sky.add(sunDisc, earth.mesh, stars);

  // --- the Sun's shadow map: rover and rocks seen from the Sun, 96 m across, redrawn only when something moved.
  // The map lies across the sunlight, so a shadow 60 m long costs no more map than the rock that casts it.
  const SM_HALF = 48, SM_BACK = 200, SM_DEPTH = 90;
  const smRT = new THREE.WebGLRenderTarget(SMW, SMH, { format: THREE.RedFormat, type: THREE.UnsignedByteType, depthTexture: new THREE.DepthTexture(SMW, SMH) });
  const smCam = new THREE.OrthographicCamera(-SM_HALF, SM_HALF, 1, -1, SM_BACK - SM_DEPTH, SM_BACK + SM_DEPTH); smCam.layers.set(1);
  const smMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
  const sm = { uSM: { value: smRT.depthTexture }, uSMMat: { value: new THREE.Matrix4() }, uSMInfo: { value: new THREE.Vector4() } };
  const smR = new THREE.Vector3(), smU = new THREE.Vector3(), smF = new THREE.Vector3(), smC = new THREE.Vector3(), smUp = new THREE.Vector3();
  let smDirty = true;
  // centre the map on (cx, cz): its height covers what can cast a shadow there, the ground within 44 m and 3 m above it
  function aimShadow(cx, cz) {
    smF.copy(sunDir).negate();
    smR.crossVectors(smF, smUp.set(0, Math.abs(sunDir.y) > 0.95 ? 0 : 1, Math.abs(sunDir.y) > 0.95 ? -1 : 0)).normalize(); smU.crossVectors(smR, smF);
    smC.set(cx, H(cx, cz, 2), cz).addScaledVector(sunDir, SM_BACK);
    let y0 = Infinity, y1 = -Infinity;
    for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) {
      const x = cx + i * 11, z = cz + j * 11, h = H(x, z, 2);
      for (const dy of [-3, 3]) { const v = (x - smC.x) * smU.x + (h + dy - smC.y) * smU.y + (z - smC.z) * smU.z; if (v < y0) y0 = v; if (v > y1) y1 = v; }
    }
    Object.assign(smCam, { top: y1, bottom: y0 }); smCam.updateProjectionMatrix();
    smCam.position.copy(smC); smCam.up.copy(smU); smCam.lookAt(smUp.copy(smC).add(smF)); smCam.updateMatrixWorld();
    const W = 2 * SM_HALF, Hm = y1 - y0;
    sm.uSMMat.value.set(smR.x / W, smR.y / W, smR.z / W, -smC.dot(smR) / W + 0.5, smU.x / Hm, smU.y / Hm, smU.z / Hm, (-smC.dot(smU) - y0) / Hm,
      smF.x, smF.y, smF.z, -smC.dot(smF), 0, 0, 0, 1);
    sm.uSMInfo.value.set(SM_BACK - SM_DEPTH, 2 * SM_DEPTH, W, Hm);
    smDirty = true;
  }
  // the rover and the rocks receive these shadows too: patch three's light loop so the Sun's light is multiplied by it
  function receiveSunShadow(shader) {
    Object.assign(shader.uniforms, sm, { uSunW: shared.uSun });
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vSMW;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        { vec4 wp = vec4(transformed, 1.);
          #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
          #endif
          vSMW = (modelMatrix * wp).xyz; }`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vSMW; uniform vec3 uSunW;\n' + SHADOW_GLSL)
      .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace('getDirectionalLightInfo( directionalLight, directLight );',
        // pushed off the surface along its normal and toward the Sun, so a face does not shadow itself
        'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= sunShadowAt(vSMW + inverseTransformDirection(normal, viewMatrix) * 0.05 + uSunW * 0.05);'));
  }

  // terrain: one float texture array, 11 materials (one per level) over shared grid geometry in 16 chunks
  const data = new Float32Array(N * N * NL), tex = new THREE.DataArrayTexture(data, N, N, NL);
  Object.assign(tex, { format: THREE.RedFormat, type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, needsUpdate: true });
  const pos = new Float32Array(N * N * 3); for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) pos.set([i, 0, k], (k * N + i) * 3);
  const posAttr = new THREE.BufferAttribute(pos, 3), CH = 4, CQ = (N - 1) / CH;
  // Levels 1 and up leave out the middle quads their finer level always covers (HQ0 to HQ1). Drawing them
  // would shade the ground near the rover once per level, 10 times over.
  const chunkIdx = [false, true].map(hole => {
    const out = [];
    for (let cz = 0; cz < CH; cz++) for (let cx = 0; cx < CH; cx++) {
      const idx = [], i0 = Math.round(cx * CQ), i1 = Math.round((cx + 1) * CQ), k0 = Math.round(cz * CQ), k1 = Math.round((cz + 1) * CQ);
      for (let k = k0; k < k1; k++) for (let i = i0; i < i1; i++) {
        if (hole && i >= HQ0 && i < HQ1 && k >= HQ0 && k < HQ1) continue;
        const a = k * N + i, b = a + N, c = b + 1, d = a + 1; idx.push(a, b, d, b, c, d);
      }
      if (idx.length) out.push({ attr: new THREE.BufferAttribute(new Uint16Array(idx), 1), i0, i1, k0, k1 });
    }
    return out;
  });
  const tracks = createTracks(THREE), dust = createDust(THREE);
  const shared = {
    uH: { value: tex }, uNL: { value: NL }, uS0: { value: S0 }, uC: { value: new THREE.Vector2() }, uSun: { value: new THREE.Vector3(0, 1, 0) },
    uFarM: { value: 1 }, uBlock: { value: 0 }, uHead: { value: 0 }, uBounce: { value: 0.03 }, uExpo: { value: 1 }, uLampPos: { value: new THREE.Vector3() }, uLampDir: { value: new THREE.Vector3(0, 0, -1) },
    ...sm, uTrk: { value: tracks.texture }, uTrkWin: { value: tracks.window },
  };
  const levels = [];
  for (let l = 0; l < NL; l++) {
    const u = { ...shared, uL: { value: l }, uS: { value: S0 * 2 ** l }, uO: { value: new Int32Array(2) }, uHole: { value: new THREE.Vector4() }, uHasHole: { value: l > 0 ? 1 : 0 } };
    const mat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: TERRAIN_VS, fragmentShader: TERRAIN_FS });
    const chunks = chunkIdx[l > 0 ? 1 : 0].map(c => {
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', posAttr); geo.setIndex(c.attr); geo.boundingSphere = new THREE.Sphere();
      const mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = l; mesh.matrixAutoUpdate = false; mesh.layers.enable(2); world.add(mesh); return { mesh, c };
    });
    levels.push({ l, s: S0 * 2 ** l, oi: 0, ok: 0, valid: false, min: Infinity, max: -Infinity, u, mat, chunks });
  }
  const canLayer = typeof tex.addLayerUpdate === 'function';

  // fill the rows and columns a level gains; the grid wraps inside its layer, so nothing else moves
  function fillLevel(L, cx, cz) {
    const s = L.s, oi = 2 * Math.floor((cx / s - N / 2) / 2), ok = 2 * Math.floor((cz / s - N / 2) / 2);
    if (L.valid && oi === L.oi && ok === L.ok) return false;
    const full = !L.valid || Math.abs(oi - L.oi) >= N || Math.abs(ok - L.ok) >= N, base = L.l * N * N;
    for (let k = ok; k < ok + N; k++) {
      const newRow = full || k < L.ok || k >= L.ok + N, row = base + (k & (N - 1)) * N;
      for (let i = oi; i < oi + N; i++) {
        if (!newRow && i >= L.oi && i < L.oi + N) continue;
        const h = H(i * s, k * s, s); data[row + (i & (N - 1))] = h;
        if (h < L.min) L.min = h; if (h > L.max) L.max = h;
      }
    }
    L.oi = oi; L.ok = ok; L.valid = true; return true;
  }
  function updateTerrain(cx, cz) {
    let any = false;
    for (let l = NL - 1; l >= 0; l--) {
      const L = levels[l];
      if (fillLevel(L, cx, cz)) { any = true; if (canLayer) tex.addLayerUpdate(l); }
      L.u.uO.value[0] = L.oi; L.u.uO.value[1] = L.ok;
      if (l > 0) { const r = HOLE * levels[l - 1].s; L.u.uHole.value.set(cx - r, cz - r, cx + r, cz + r); }
      // bounding sphere per chunk, so the near and far passes each skip what their frustum can't see
      const mid = (L.min + L.max) / 2, hy = (L.max - L.min) / 2 + 1;
      for (const { mesh, c } of L.chunks) {
        const x0 = (L.oi + c.i0) * L.s, x1 = (L.oi + c.i1) * L.s, z0 = (L.ok + c.k0) * L.s, z1 = (L.ok + c.k1) * L.s;
        mesh.geometry.boundingSphere.center.set((x0 + x1) / 2, mid, (z0 + z1) / 2);
        mesh.geometry.boundingSphere.radius = Math.hypot((x1 - x0) / 2, hy, (z1 - z0) / 2);
      }
    }
    shared.uC.value.set(cx, cz);
    if (any) tex.needsUpdate = true;
  }

  // rocks: one instanced mesh (one draw call for up to 600), refilled from the same rock field when the rover
  // has moved 3 m. A rounded, dented shape; each rock turned and tilted its own way.
  const rockGeo = new THREE.IcosahedronGeometry(1, 1), ra = rockGeo.attributes.position;
  for (let i = 0; i < ra.count; i++) {
    const x = ra.getX(i), y = ra.getY(i), z = ra.getZ(i), h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453, k = 0.82 + 0.3 * (h - Math.floor(h));
    ra.setXYZ(i, x * k, y * k, z * k);
  }
  rockGeo.computeVertexNormals();
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8f8b84, roughness: 0.95, metalness: 0, flatShading: true }); rockMat.onBeforeCompile = receiveSunShadow;
  const ROCKS = 600, rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, ROCKS);
  rockMesh.frustumCulled = false; rockMesh.layers.enable(1); world.add(rockMesh);
  const rockAt = new THREE.Vector2(1e9, 1e9), m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), s4 = new THREE.Vector3(), p4 = new THREE.Vector3(), col4 = new THREE.Color(), e4 = new THREE.Euler();
  // sunlight on each rock from the terrain around it (big shadows), kept until the Sun moves: most rocks stay
  // in range from one refill to the next, so only the new ones are marched
  const rockSun = new Map();
  function placeRocks(cx, cz) {
    rockAt.set(cx, cz); let n = 0;
    if (rockSun.size > 20000) rockSun.clear();
    const R = 36, i0 = Math.floor((cx - R) / 2.5), i1 = Math.floor((cx + R) / 2.5), j0 = Math.floor((cz - R) / 2.5), j1 = Math.floor((cz + R) / 2.5);
    for (let j = j0; j <= j1 && n < ROCKS; j++) for (let i = i0; i <= i1 && n < ROCKS; i++) {
      const r = ground.rockAt(i, j); if (!r) continue;
      const base = H(r.x, r.z, 0.5) - ground.rocks(r.x, r.z), key = i * 65536 + j;
      let sun = rockSun.get(key); if (sun === undefined) { sun = marchSun(r.x, base + r.r * 0.5, r.z, sunDir, 20); rockSun.set(key, sun); }
      m4.compose(p4.set(r.x, base, r.z), q4.setFromEuler(e4.set(Math.sin(r.spin * 7) * 0.35, r.spin, Math.cos(r.spin * 5) * 0.35)), s4.set(r.r, r.r * 0.62, r.r * 0.9));
      rockMesh.setMatrixAt(n, m4);
      rockMesh.setColorAt(n, col4.setScalar(0.1 + 0.9 * sun));
      n++;
    }
    rockMesh.count = n; rockMesh.instanceMatrix.needsUpdate = true; if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true;
    aimShadow(cx, cz);
  }

  // lights for the rover and the rocks (the terrain lights itself in its shader). The black sky gives no light;
  // the ground does: an environment that is regolith grey below the horizon and black above, so the rover's
  // shaded side and its metal pick up the lit ground, as in Apollo photos
  const sunLight = new THREE.DirectionalLight(0xffffff, 3.2);
  const lampLight = new THREE.SpotLight(0xfff3dc, 0, 70, 0.45, 0.5, 2);
  world.add(sunLight, sunLight.target, lampLight, lampLight.target);
  // 128 x 64: three.js blurs an environment into levels down to 16 pixels, so a smaller map gives no light at all
  const envPx = new Uint8Array(128 * 64 * 4);
  for (let j = 0; j < 64; j++) for (let i = 0; i < 128; i++) { const g = j < 31 ? 96 : j < 33 ? 30 : 0; envPx.set([g, g, Math.round(g * 0.97), 255], (j * 128 + i) * 4); }
  const env = new THREE.DataTexture(envPx, 128, 64); Object.assign(env, { mapping: THREE.EquirectangularReflectionMapping, colorSpace: THREE.SRGBColorSpace, magFilter: THREE.LinearFilter, needsUpdate: true });
  world.environment = env;

  const rover = buildRover(THREE, receiveSunShadow); world.add(rover.group, rover.wheelMesh, rover.forkMesh, dust.points);
  for (const m of rover.meshes) m.layers.enable(1);

  // --- minimap: the lit ground seen from straight above, north up. Drawn into a 512 x 512 texture only when the
  // rover has moved 2 texels or the Sun has moved; every other frame shows that texture on one quad ---
  const MAP_W = [500, 2000, 8000]; let mapZoom = 1;     // metres across
  const mapRT = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType });
  const mapCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 20000); mapCam.layers.set(2); mapCam.up.set(0, 0, -1);
  const mapScene = new THREE.Scene(), quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mapQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: mapRT.texture, depthTest: false, depthWrite: false }));
  mapScene.add(mapQuad);
  const mapC = new THREE.Vector2(1e9, 1e9), trail = [];
  let mapDirty = true, mapView = null, mapExpo = 1, trailDrawn = -1;
  function drawMap(r) {
    if (mapDirty) {
      mapDirty = false; const W = MAP_W[mapZoom];
      mapC.set(pos3.x, pos3.z);
      Object.assign(mapCam, { left: -W / 2, right: W / 2, top: W / 2, bottom: -W / 2 }); mapCam.updateProjectionMatrix();
      mapCam.position.set(pos3.x, pos3.y + 8000, pos3.z); mapCam.lookAt(pos3.x, pos3.y, pos3.z); mapCam.updateMatrixWorld();
      const head = shared.uHead.value; shared.uHead.value = 0; shared.uExpo.value = mapExpo;
      r.setRenderTarget(mapRT); r.setClearColor(0x000000, 1); r.clear(); r.render(world, mapCam); r.setRenderTarget(null);
      shared.uHead.value = head; shared.uExpo.value = 1;
      mapOverlay(true);
    }
    r.render(mapScene, quadCam);
  }
  const toMap = (x, z) => { const W = MAP_W[mapZoom]; return [((x - mapC.x) / W + 0.5) * 220, ((z - mapC.y) / W + 0.5) * 220]; };
  function mapOverlay(full) {
    const [rx, ry] = toMap(pos3.x, pos3.z);
    $('.rv-map-rover').setAttribute('transform', `translate(${rx.toFixed(1)} ${ry.toFixed(1)}) rotate(${(Math.atan2(vF.x, -vF.z) * R2D).toFixed(1)})`);
    if (full || trailDrawn !== trail.length) {
      trailDrawn = trail.length; const pts = []; let lx = -1e9, ly = -1e9;
      for (const [x, z] of trail) { const [px, py] = toMap(x, z); if (Math.abs(px - lx) + Math.abs(py - ly) >= 1) { pts.push(px.toFixed(1) + ',' + py.toFixed(1)); lx = px; ly = py; } }
      pts.push(rx.toFixed(1) + ',' + ry.toFixed(1));
      $('.rv-map-trail').setAttribute('points', pts.join(' '));
    }
    if (!full) return;
    const [sx, sy] = toMap(0, 0); $('.rv-map-site').setAttribute('cx', sx.toFixed(1)); $('.rv-map-site').setAttribute('cy', sy.toFixed(1));
    $('.rv-map-data').setAttribute('d', ground.outlines().map(o => 'M' + o.pts.map(([x, z]) => toMap(x, z).map(v => v.toFixed(1)).join(' ')).join(' L') + ' Z').join(' '));
    // Sun and Earth on the rim, in the direction they stand; Earth faded when the skyline hides it
    // (Earth on an inner ring: near the pole the two often stand in nearly the same direction)
    for (const [cls, d, up, ring] of [['.rv-map-sun', sunDir, sunInfo.up, 42], ['.rv-map-earth', earthDir, earthInfo.up, 31]]) {
      const az = Math.atan2(d.x, -d.z), el = $(cls);
      el.style.left = `${(50 + Math.sin(az) * ring).toFixed(1)}%`; el.style.top = `${(50 - Math.cos(az) * ring).toFixed(1)}%`; el.classList.toggle('off', !up);
    }
    // scale bar: a round length near a quarter of the map
    const W = MAP_W[mapZoom], len = [50, 100, 200, 500, 1000, 2000].reduce((a, b) => Math.abs(b - W / 4) < Math.abs(a - W / 4) ? b : a);
    $('.rv-map-bar').setAttribute('x2', (8 + len / W * 220).toFixed(1)); $('.rv-map-scale').textContent = len >= 1000 ? `${len / 1000} km` : `${len} m`;
  }
  function zoomMap(z) { mapZoom = Math.max(0, Math.min(MAP_W.length - 1, z)); mapDirty = true; stage.request(); }

  // --- state ---
  const sunDir = new THREE.Vector3(), earthDir = new THREE.Vector3();
  const veh = createVehicle(H, { edge: 0 }), S = veh.state; // the edge is set once the ground has loaded
  const pos3 = new THREE.Vector3(), quat = new THREE.Quaternion(), vF = new THREE.Vector3(), vN = new THREE.Vector3();
  let lastT = performance.now(), lightsMode = 'auto', camMode = 'chase', lastDrag = -1e9;
  const keys = new Set();
  const sunInfo = { margin: 0, up: true }, earthInfo = { margin: 0, up: true };
  let hudAt = 0, msg = '', msgUntil = 0, slopeDeg = 0;

  function readSky() {
    sunDir.copy(relief.sunLocal).normalize(); earthDir.copy(relief.earthLocal).normalize();
    shared.uSun.value.copy(sunDir); shared.uBlock.value = relief.uniforms.uBlock.value;
    const az = (Math.atan2(sunDir.x, -sunDir.z) * R2D + 360) % 360, i = Math.floor(az), f = az - i;
    const farDeg = relief.far[i % 360] * (1 - f) + relief.far[(i + 1) % 360] * f;
    shared.uFarM.value = Math.asin(sunDir.y) - farDeg * D2R;
    sunDisc.position.copy(sunDir).multiplyScalar(1e6); earth.mesh.position.copy(earthDir).multiplyScalar(1e6); earth.setSun(sunDir);
    sunLight.position.copy(sunDir).multiplyScalar(50);
    // the map looks straight down, where low sunlight is dim (Lommel-Seeliger): scale flat sunlit ground to 15% (linear), so slopes facing the Sun still show shape
    const mu0 = Math.max(sunDir.y, 0.005); mapExpo = Math.min(40, 0.15 / (0.16 * 2.4 * 2 * mu0 / (mu0 + 1)));
    mapDirty = true;
  }
  // fraction of the Sun above the terrain seen from (x, y, z), by marching the ground: used for rocks and the rover
  function marchSun(x, y, z, dir, steps = 40) {
    if (dir.y < -0.03) return 0;
    const hs = Math.hypot(dir.x, dir.z), ux = dir.x / hs, uz = dir.z / hs, tanEl = dir.y / hs;
    let minM = Math.min(1, shared.uFarM.value), d = 1;
    for (let i = 0; i < steps && d < 30000; i++, d *= 1.38) minM = Math.min(minM, (y + 0.05 + d * tanEl - H(x + ux * d, z + uz * d, d / 12)) / d);
    return Math.min(1, Math.max(0, (minM + 0.0047) / 0.0094));
  }
  // angle (deg) of a body above the skyline seen from the rover: positive means in view
  function skyMargin(dir, x, y, z) {
    const hs = Math.hypot(dir.x, dir.z), ux = dir.x / hs, uz = dir.z / hs, el = Math.atan2(dir.y, hs);
    const az = (Math.atan2(dir.x, -dir.z) * R2D + 360) % 360, i = Math.floor(az), f = az - i;
    let top = (relief.far[i % 360] * (1 - f) + relief.far[(i + 1) % 360] * f) * D2R;
    for (let d = 2; d < 30000; d *= 1.15) top = Math.max(top, Math.atan2(H(x + ux * d, z + uz * d, d / 16) - y, d));
    return (el - top) * R2D;
  }

  function spawn(x, z, keepYaw) {
    // facing across the sunlight, so slopes show light and shadow
    veh.spawn(x, z, keepYaw ? veh.yaw() : Math.atan2(-sunDir.z, sunDir.x)); syncPose();
  }
  // the flattest spot within 40 m, sampled every 10 m: the site's own point can sit on a crater wall
  function flattest(x0, z0) {
    let best = [x0, z0], bestSlope = Infinity;
    for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) {
      const x = x0 + i * 10, z = z0 + j * 10, e = 2, hx = H(x + e, z) - H(x - e, z), hz = H(x, z + e) - H(x, z - e);
      const slope = Math.hypot(hx, hz) + Math.hypot(i, j) * 0.004; // a slight pull toward the site itself
      if (slope < bestSlope) { bestSlope = slope; best = [x, z]; }
    }
    return best;
  }
  function syncPose() { pos3.set(S.x, S.y, S.z); quat.set(S.qx, S.qy, S.qz, S.qw); vF.set(0, 0, -1).applyQuaternion(quat); }
  function normalAt(x, z, out) { const e = 0.2, hx = H(x + e, z) - H(x - e, z), hz = H(x, z + e) - H(x, z - e); return out.set(-hx, 2 * e, -hz).normalize(); }

  // --- camera ---
  const target = new THREE.Vector3(), lastTarget = new THREE.Vector3(), off = new THREE.Vector3(), sph = new THREE.Spherical();
  function placeCamera(dt) {
    target.copy(pos3); target.y += 0.7;
    if (camMode === 'mast') {
      controls.enabled = false;
      camera.position.set(-0.32, 1.72, -0.93).applyQuaternion(quat).add(pos3); // the mast's camera head
      camera.quaternion.copy(quat); return false;
    }
    controls.enabled = true;
    camera.position.add(off.subVectors(target, lastTarget)); controls.target.copy(target); lastTarget.copy(target);
    // swing round behind the rover while driving, unless the user turned the camera in the last 2 s
    if (performance.now() - lastDrag > 2000 && Math.abs(veh.speed()) > 0.5) {
      off.subVectors(camera.position, target); sph.setFromVector3(off);
      const behind = Math.atan2(-vF.x, -vF.z), dA = Math.atan2(Math.sin(behind - sph.theta), Math.cos(behind - sph.theta));
      sph.theta += dA * (1 - Math.exp(-1.5 * dt)); off.setFromSpherical(sph); camera.position.copy(target).add(off);
    }
    const moving = controls.update();
    const floor = H(camera.position.x, camera.position.z, 0.5) + 0.6; if (camera.position.y < floor) camera.position.y = floor;
    return moving;
  }

  // --- HUD ---
  function say(text, ms = 2500) { msg = text; msgUntil = performance.now() + ms; }
  function updateHud(now) {
    const eyeY = pos3.y + 1.2;
    sunInfo.margin = skyMargin(sunDir, pos3.x, eyeY, pos3.z); sunInfo.up = sunInfo.margin > 0 && shared.uBlock.value < 0.99;
    earthInfo.margin = skyMargin(earthDir, pos3.x, eyeY, pos3.z); earthInfo.up = earthInfo.margin > 0;
    const a = (v) => `${Math.abs(v).toFixed(1)}°`, eclipse = shared.uBlock.value >= 0.99;
    const sunEl = Math.asin(sunDir.y) * R2D, earthEl = Math.asin(earthDir.y) * R2D;
    const sunLine = eclipse ? 'Earth is hiding the Sun' : sunInfo.up ? `Sunlit · Sun ${a(sunEl)} high, ${a(sunInfo.margin)} above the skyline` : `In shadow · Sun ${a(sunInfo.margin)} below the skyline`;
    const earthLine = earthInfo.up ? `Earth in view · ${a(earthEl)} high, ${a(earthInfo.margin)} above the skyline` : `No radio link · Earth ${a(earthInfo.margin)} below the skyline`;
    // the pills only change colour and one word; the full sentence is in Specs and the pill's tooltip
    setPill('.rv-sun', !sunInfo.up, eclipse ? 'Eclipse' : sunInfo.up ? 'Sun' : 'Shadow', sunLine);
    setPill('.rv-earth', !earthInfo.up, earthInfo.up ? 'Earth' : 'No radio', earthLine);
    const kmh = Math.abs(veh.speed()) * 3.6, dist = Math.hypot(pos3.x, pos3.z), odometer = S.odometer;
    const len = m => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
    const slope = Math.round(slopeDeg), steep = slope > 25;
    const statsKey = `${kmh.toFixed(1)}|${slope}|${len(dist)}`;
    if (statsKey !== lastStats) {
      lastStats = statsKey;
      $('.rv-stats').innerHTML = `${kmh.toFixed(1)} km/h · <span class="${steep ? 'warn' : ''}">${slope}°</span> · ${len(dist)} out`;
    }
    if (S.atEdge) say('End of the detailed NASA map. Turn back.');
    if (steep && !S.settled && keys.size) say(`Too steep: ${slope}°. This rover climbs up to about 25°.`, 1500);
    if (keys.has('shift')) say('Fast travel: 4× power, 14 m/s. A real rover cannot do this.', 600);
    const cell = ground.dataCell(pos3.x, pos3.z), coarse = cell > 5.01;
    if (coarse && !wasCoarse) say(`Coarser map here: ${Math.round(cell)} m per pixel`, 3000);
    wasCoarse = coarse;
    const m = $('.rv-msg'); if (now < msgUntil) { if (m.textContent !== msg) m.textContent = msg; m.hidden = false; } else m.hidden = true;
    const t = app.date, hhmm = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')} UTC`;
    const when = $('.rv-when'); if (when.textContent !== hhmm) { when.textContent = hhmm; when.title = fmtWhen(t); }
    const specs = [sunLine, earthLine, `NASA map, ${cell < 10 ? cell.toFixed(0) : Math.round(cell)} m per pixel`,
      `${len(dist)} from the site · ${len(odometer)} driven`, `${slope}°${steep ? ', steeper than this rover can climb (about 25°)' : ''}`,
      `${camMode === 'mast' ? 'Mast, 2.2 m above the ground' : 'Chase'} · lights ${lightsMode === 'auto' ? 'on in shadow' : lightsMode}`, fmtWhen(t)];
    specRows.forEach((el, i) => { if (el.textContent !== specs[i]) el.textContent = specs[i]; });
    for (const p of pops) if (p.open()) p.place();
  }
  function setPill(sel, bad, word, tip) {
    const el = $(sel); el.classList.toggle('bad', bad);
    if (el.lastChild.textContent !== word) el.lastChild.textContent = word;
    if (el.title !== tip) el.title = tip;
  }
  let lastStats = '', wasCoarse = false;
  const specRows = [...hud.querySelectorAll('.rv-specs-pop strong')];

  // --- popovers: hover (mouse) or click to open, click again, click outside or Esc to close; placed by hand so they never move the HUD ---
  function bindPop(btn, pop, below) {
    let pinned = false, timer = 0;
    const open = () => pop.matches(':popover-open');
    const place = () => {
      const r = btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
      const left = Math.max(8, Math.min(innerWidth - w - 8, r.left + w > innerWidth - 8 ? r.right - w : r.left));
      const top = below ? r.bottom + 8 : Math.max(8, r.top - h - 8);
      pop.style.left = `${left.toFixed(0)}px`; pop.style.top = `${top.toFixed(0)}px`;
    };
    const show = () => { clearTimeout(timer); if (!open()) pop.showPopover(); btn.setAttribute('aria-expanded', 'true'); place(); };
    const hide = () => { clearTimeout(timer); pinned = false; if (open()) pop.hidePopover(); btn.setAttribute('aria-expanded', 'false'); };
    const hideSoon = () => { clearTimeout(timer); if (!pinned) timer = setTimeout(hide, 150); };
    btn.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') { clearTimeout(timer); timer = setTimeout(show, 250); } });
    btn.addEventListener('pointerleave', hideSoon);
    pop.addEventListener('pointerenter', () => clearTimeout(timer));
    pop.addEventListener('pointerleave', hideSoon);
    btn.addEventListener('click', () => { if (pinned) hide(); else { pinned = true; show(); } });
    return { open, place, hide, toggle: () => btn.click(), owns: el => btn.contains(el) || pop.contains(el) };
  }
  const pops = [bindPop($('.rv-about-btn'), $('.rv-about-pop'), true), bindPop($('.rv-specs'), $('.rv-specs-pop'), false)];
  const keysPop = bindPop($('.rv-keys-btn'), $('.rv-keys-pop'), false); pops.push(keysPop);
  const onPopDown = e => { for (const p of pops) if (p.open() && !p.owns(e.target)) p.hide(); };
  document.addEventListener('pointerdown', onPopDown);

  // --- dynamic resolution (rover-fx.js): while frames run back to back, fewer pixels when they come late ---
  const DPR_TOP = Math.min(1.5, devicePixelRatio || 1), dyn = createDynamicResolution(DPR_TOP, Math.min(DPR_TOP, 0.6));

  // --- one frame ---
  const lampDir = new THREE.Vector3(), vSide = new THREE.Vector3(), vVel = new THREE.Vector3(), t0 = performance.now(), bufSize = new THREE.Vector2();
  let sunAtRover = 1, lastSunKey = '', animating = false;
  function frame() {
    const now = performance.now(), gap = (now - lastT) / 1000, dt = Math.min(0.05, gap); lastT = now;
    if (animating && !document.hidden) { const d = dyn.frame(now, gap); if (d) stage.maxDpr = d; }
    const sunKey = `${relief.sunLocal.x},${relief.sunLocal.y},${relief.sunLocal.z},${relief.uniforms.uBlock.value}`;
    if (sunKey !== lastSunKey) { lastSunKey = sunKey; readSky(); rockSun.clear(); rockAt.set(1e9, 1e9); hudAt = 0; }
    const wasSettled = S.settled;
    veh.advance(dt, input()); syncPose();
    if (!wasSettled) smDirty = true; // the rover moved: its shadow did too
    // rover pose into the model
    rover.group.position.copy(pos3); rover.group.quaternion.copy(quat);
    veh.wheels.forEach((w, k) => {
      const W = rover.wheels[k]; W.pivot.position.y = WHEELS[k][1] - (w.contact ? w.len : REST);
      W.pivot.rotation.y = WHEELS[k][3] ? S.steer : 0; W.spin.rotation.x = -w.spin;
    });
    rover.group.updateMatrixWorld(true);
    rover.dish.lookAt(rover.group.position.x + earthDir.x * 1e6, rover.group.position.y + earthDir.y * 1e6, rover.group.position.z + earthDir.z * 1e6);
    rover.syncWheels();
    updateTerrain(pos3.x, pos3.z);
    if (Math.hypot(pos3.x - rockAt.x, pos3.z - rockAt.y) > 3) placeRocks(pos3.x, pos3.z);
    tracks.update(pos3.x, pos3.z, veh.wheels);
    const last = trail.at(-1); if (!last || Math.hypot(pos3.x - last[0], pos3.z - last[1]) >= 1) { trail.push([pos3.x, pos3.z]); if (trail.length > 6000) trail.splice(0, 2000); }
    if (Math.hypot(pos3.x - mapC.x, pos3.z - mapC.y) > MAP_W[mapZoom] / 256) mapDirty = true; else if (!S.settled) mapOverlay(false);
    vSide.set(1, 0, 0).applyQuaternion(quat); vVel.set(S.vx, S.vy, S.vz);
    const dustFlying = dust.update((now - t0) / 1000, dt, veh.wheels, vF, vSide, vVel, veh.speed());
    dust.uniforms.uLight.value = (0.12 + 0.88 * sunAtRover) * (1 - shared.uBlock.value);
    // lamps for the terrain shader: the front headlamps, 0.18 m above the centre of mass
    shared.uLampPos.value.set(0, 0.18, -1.07).applyQuaternion(quat).add(pos3);
    lampDir.set(0, -0.14, -1).normalize().applyQuaternion(quat); shared.uLampDir.value.copy(lampDir);
    slopeDeg = Math.acos(Math.min(1, normalAt(pos3.x, pos3.z, vN).y)) * R2D;
    if (now - hudAt > 120) {
      hudAt = now; updateHud(now);
      sunAtRover = shared.uBlock.value >= 0.99 ? 0 : marchSun(pos3.x, pos3.y + 0.6, pos3.z, sunDir, 50);
    }
    const lamps = lightsMode === 'on' || (lightsMode === 'auto' && sunAtRover < 0.5);
    shared.uHead.value = lamps ? 1 : 0; rover.setLamps(lamps);
    lampLight.intensity = lamps ? 25 : 0; lampLight.position.copy(shared.uLampPos.value); lampLight.target.position.copy(shared.uLampPos.value).addScaledVector(lampDir, 10);
    const day = 1 - shared.uBlock.value;
    sunLight.intensity = 3.2 * sunAtRover * day; sunLight.target.position.copy(pos3); sunLight.position.copy(sunDir).multiplyScalar(50).add(pos3);
    // light from the ground: strong while the ground around the rover is sunlit, faint (bounced from far) when not
    world.environmentIntensity = (0.4 + 1.8 * sunAtRover) * day; shared.uBounce.value = 0.03 * day;
    const camMoving = placeCamera(dt);
    sunDisc.quaternion.copy(camera.quaternion);
    animating = !S.settled || camMoving || keys.size > 0 || dustFlying;
    if (animating) stage.request();
  }
  function draw(r) {
    camera.updateMatrixWorld();
    for (const c of [skyCam, farCam, nearCam]) { c.position.copy(camera.position); c.quaternion.copy(camera.quaternion); c.fov = camera.fov; c.aspect = camera.aspect; c.updateProjectionMatrix(); c.updateMatrixWorld(); }
    skyCam.position.set(0, 0, 0); skyCam.updateMatrixWorld(); // Sun, Earth and stars are directions: no parallax
    const auto = r.autoClear; r.autoClear = false;
    tracks.draw(r);
    dust.uniforms.uPx.value = r.getDrawingBufferSize(bufSize).y / (2 * Math.tan(camera.fov * D2R / 2));
    // the Sun's view of the rover and the rocks, only when one of them or the Sun moved
    if (smDirty) {
      smDirty = false; world.overrideMaterial = smMat;
      r.setRenderTarget(smRT); r.clear(false, true, false); r.render(world, smCam);
      r.setRenderTarget(null); world.overrideMaterial = null;
    }
    r.render(sky, skyCam); r.clearDepth();
    r.render(world, farCam); r.clearDepth();
    r.render(world, nearCam);
    r.autoClear = auto;
  }

  // --- input ---
  const KEYS = ['w', 'a', 's', 'd', ' ', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
  const typing = e => e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName));
  const onControl = e => e.target instanceof HTMLElement && /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(e.target.tagName);
  function onKeyDown(e) {
    if (typing(e) || (onControl(e) && (e.key === ' ' || e.key.startsWith('Arrow'))) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (KEYS.includes(k)) { e.preventDefault(); keys.add(k); }
    else if (k === 'r') { spawn(pos3.x, pos3.z, true); say('Rover put upright'); }
    else if (k === 'c') {
      camMode = camMode === 'chase' ? 'mast' : 'chase';
      if (camMode === 'chase') { camera.position.copy(pos3).addScaledVector(vF.set(0, 0, 1).applyQuaternion(quat), 9); camera.position.y += 3.2; lastTarget.copy(pos3); lastTarget.y += 0.7; }
      say(camMode === 'mast' ? 'Mast camera, 2.2 m above the ground' : 'Chase camera');
    }
    else if (k === 'm') { zoomMap((mapZoom + 1) % MAP_W.length); say(`Map: ${MAP_W[mapZoom] >= 1000 ? MAP_W[mapZoom] / 1000 + ' km' : MAP_W[mapZoom] + ' m'} across`); }
    else if (k === 'l') { lightsMode = lightsMode === 'auto' ? 'on' : lightsMode === 'on' ? 'off' : 'auto'; say(`Lights: ${lightsMode === 'auto' ? 'on in shadow' : lightsMode}`); }
    else if (k === '?') { keysPop.toggle(); return; }
    else if (k === 'escape' && pops.some(p => p.open())) { e.preventDefault(); for (const p of pops) p.hide(); return; }
    else if (k === 'escape' && !document.fullscreenElement) { e.preventDefault(); api.close(); return; }
    else return;
    wake();
  }
  function input() {
    const k = keys;
    return { thr: (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0),
      steer: (k.has('a') || k.has('arrowleft') ? 1 : 0) - (k.has('d') || k.has('arrowright') ? 1 : 0), brake: k.has(' '), fast: k.has('shift') };
  }
  function onKeyUp(e) { keys.delete(e.key.toLowerCase()); if (e.key === 'Shift') keys.delete('shift'); wake(); }
  function onBlur() { keys.clear(); }
  function wake() { if (S.settled) { veh.wake(); lastT = performance.now(); } stage.request(); }
  let wasFull = !!document.fullscreenElement;
  function onFullscreen() { if (document.fullscreenElement) wasFull = true; else if (wasFull) api.close(); }
  controls.addEventListener('start', () => { lastDrag = performance.now(); wake(); });
  controls.addEventListener('change', () => stage.request());
  addEventListener('keydown', onKeyDown); addEventListener('keyup', onKeyUp); addEventListener('blur', onBlur);
  document.addEventListener('fullscreenchange', onFullscreen);
  $('.rv-exit').onclick = () => api.close();
  $('.rv-zin').onclick = () => zoomMap(mapZoom - 1); $('.rv-zout').onclick = () => zoomMap(mapZoom + 1);
  $('.rv-back').onclick = () => { app.setDate(new Date(app.date.getTime() - 36e5)); wake(); };
  $('.rv-fwd').onclick = () => { app.setDate(new Date(app.date.getTime() + 36e5)); wake(); };

  // --- start: hide the page's other views, build the ground, place the rover and the camera ---
  const hidden = stage.views.map(v => [v, v.hidden]); for (const [v] of hidden) v.hidden = true;
  // a full-screen moving view: 1.5 pixels per CSS pixel is sharp enough and draws 44% fewer pixels than 2;
  // dynamic resolution lowers it further on a slow GPU
  const keepDpr = stage.maxDpr; stage.maxDpr = DPR_TOP;
  let view = null;
  const api = {
    state: S, vehicle: veh, debug: { data, levels, H, N, dyn, rover, sm, smRT },
    close() {
      if (current !== api) return; current = null;
      removeEventListener('keydown', onKeyDown); removeEventListener('keyup', onKeyUp); removeEventListener('blur', onBlur);
      document.removeEventListener('fullscreenchange', onFullscreen); document.removeEventListener('pointerdown', onPopDown);
      for (const p of pops) p.hide();
      if (view) stage.remove(view); if (mapView) stage.remove(mapView); controls.dispose();
      for (const [v, h] of hidden) v.hidden = h;
      stage.maxDpr = keepDpr;
      document.body.classList.remove('rover-on'); viewEl.remove(); hud.remove();
      for (const L of levels) { L.mat.dispose(); for (const { mesh } of L.chunks) mesh.geometry.dispose(); }
      tex.dispose(); rockMesh.geometry.dispose(); rockMesh.material.dispose(); rockMesh.dispose(); rover.dispose();
      smRT.depthTexture.dispose(); smRT.dispose(); smMat.dispose(); env.dispose(); tracks.dispose(); dust.dispose();
      mapRT.dispose(); mapQuad.geometry.dispose(); mapQuad.material.dispose();
      sunDisc.geometry.dispose(); sunDisc.material.dispose(); earth.mesh.geometry.dispose(); earth.mesh.material.dispose(); stars.geometry.dispose(); stars.material.dispose();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      stage.request();
    },
  };
  current = api;
  readSky(); lastSunKey = `${relief.sunLocal.x},${relief.sunLocal.y},${relief.sunLocal.z},${relief.uniforms.uBlock.value}`;
  // load the NASA heights for this place, let the "Building the ground" note paint, then build
  (async () => {
    let netFail = false;
    const real = await loadRealGround(place.lat, place.lon).catch(e => { console.warn('NASA map did not load:', e.message); netFail = true; return null; });
    if (current !== api) return;
    if (netFail) { $('.rv-wait').textContent = 'Could not download the NASA map. Check the connection and press Exit.'; return; }
    if (!real) { $('.rv-wait').textContent = 'Not enough detail for the rover here: it needs a NASA map with 5 m pixels or finer.'; return; }
    try {
    ground = makeGround(relief.tile.field, app.lib, real);
    veh.setEdge(ground.reach);
    const f = real[0], km = v => (v / 1000).toFixed(1).replace(/\.0$/, '');
    const what = f.source === 'nac' ? `LROC stereo map (${f.scale} m per pixel)` : `${f.scale} m map made from LROC photos and LOLA laser heights`;
    $('.rv-note').innerHTML = `<strong>Ground:</strong> NASA's ${what}, ${km(2 * ground.reach)} km square.<br>Rocks and craters under 4 m are made up: no map shows them. Sun and Earth positions from JPL Horizons.`;
    $('.rv-wait').textContent = 'Building the ground…';
    await new Promise(r => setTimeout(r, 30));
    if (current !== api) return;
    const [sx, sz] = flattest(0, 0); spawn(sx, sz, false); updateTerrain(pos3.x, pos3.z);
    } catch (e) { console.warn('Rover ground failed:', e); const w = $('.rv-wait'); if (w) w.textContent = 'Could not build the ground here. Press Exit.'; return; }
    camera.position.copy(pos3).addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(quat), 9).add(new THREE.Vector3(0, 3.2, 0));
    lastTarget.copy(pos3).add(new THREE.Vector3(0, 0.7, 0)); controls.target.copy(lastTarget); controls.update();
    $('.rv-wait').remove();
    view = stage.add(viewEl, world, camera, { clear: 0x000000, before: frame, render: draw });
    mapView = stage.add($('.rv-map-gl'), mapScene, quadCam, { clear: 0x000000, render: drawMap });
    lastT = performance.now();
  })();
  return api;
}
