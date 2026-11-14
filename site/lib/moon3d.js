/*
  moon3d.js: shared 3D engine for prototypes 11 to 20.

  Data (prototypes/assets, from the NASA SVS CGI Moon Kit, public domain):
    moon_color_4k.jpg      LROC colour mosaic, equirectangular, centred on 0 deg longitude
    moon_height_8ppd.u16   LOLA elevation, 2880 x 1440, uint16 half-metres + 20000
    south_pole_625m.u16    LOLA elevation resampled to a polar stereographic grid,
                           1024 x 1024 over +/-320 km around the south pole
    earth_2k.jpg           Earth day map (Three.js examples copy of NASA Blue Marble)

  Frame: the Moon sits at the origin with radius 1. A point at (lat, lon) is
  (cos lat cos lon, sin lat, -cos lat sin lon). Sun and Earth directions come
  from window.Lunar (JPL Horizons table, see lunar.js).

  Rendering is on demand: nothing draws unless something changed.
*/
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export { THREE, OrbitControls };
const L = window.Lunar;
export const R_KM = 1737.4;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// ---------- data ----------
const POLAR_N = 1024, POLAR_HALF = 320;
let DATA = null;
export async function loadMoonData(base = 'assets/') {
  if (DATA) return DATA;
  const [gBuf, pBuf] = await Promise.all([
    fetch(base + 'moon_height_8ppd.u16').then(r => r.arrayBuffer()),
    fetch(base + 'south_pole_625m.u16').then(r => r.arrayBuffer()),
  ]);
  const toKm = u => { const f = new Float32Array(u.length); for (let i = 0; i < u.length; i++) f[i] = (u[i] - 20000) / 2000; return f; };
  const global = { w: 2880, h: 1440, km: toKm(new Uint16Array(gBuf)) };
  const polar = { n: POLAR_N, half: POLAR_HALF, km: toKm(new Uint16Array(pBuf)) };
  const tl = new THREE.TextureLoader();
  const [color, earth] = await Promise.all([tl.loadAsync(base + 'moon_color_4k.jpg'), tl.loadAsync(base + 'earth_2k.jpg')]);
  for (const t of [color, earth]) { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; }
  const halfTex = (f, w, h, wrap) => {
    const d = new Uint16Array(f.length); for (let i = 0; i < f.length; i++) d[i] = THREE.DataUtils.toHalfFloat(f[i]);
    const t = new THREE.DataTexture(d, w, h, THREE.RedFormat, THREE.HalfFloatType);
    t.magFilter = t.minFilter = THREE.LinearFilter; if (wrap) t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true; return t;
  };
  DATA = { global, polar, color, earth, globalTex: halfTex(global.km, global.w, global.h, true), polarTex: halfTex(polar.km, POLAR_N, POLAR_N, false) };
  return DATA;
}

function bilinear(arr, w, h, x, y, wrapX) {
  if (wrapX) x = ((x % w) + w) % w; else x = Math.max(0, Math.min(w - 1.001, x));
  y = Math.max(0, Math.min(h - 1.001, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, x1 = wrapX ? (x0 + 1) % w : x0 + 1;
  return arr[y0 * w + x0] * (1 - fx) * (1 - fy) + arr[y0 * w + x1] * fx * (1 - fy) + arr[(y0 + 1) * w + x0] * (1 - fx) * fy + arr[(y0 + 1) * w + x1] * fx * fy;
}
export function polarXY(lat, lon) { const rho = 2 * R_KM * Math.tan((90 + lat) * D2R / 2); return [rho * Math.sin(lon * D2R), rho * Math.cos(lon * D2R)]; }
// Catmull-Rom: smooth enough that slopes do not facet when a 625 m grid is stretched over a 40 km block
function bicubic(arr, w, h, x, y, wrapX) {
  const x1 = Math.floor(x), y1 = Math.floor(y), fx = x - x1, fy = y - y1;
  const cr = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  const at = (i, j) => { i = wrapX ? ((i % w) + w) % w : Math.max(0, Math.min(w - 1, i)); j = Math.max(0, Math.min(h - 1, j)); return arr[j * w + i]; };
  const row = j => cr(at(x1 - 1, j), at(x1, j), at(x1 + 1, j), at(x1 + 2, j), fx);
  return cr(row(y1 - 1), row(y1), row(y1 + 1), row(y1 + 2), fy);
}
/**
  Elevation in km. Uses the 625 m polar grid wherever it has data, else the global grid. smooth: bicubic.
  The polar grid is a 640 km square, so it reaches 75.3 S at its corners but only 79.48 S at 0, 90, 180 and 270 E.
*/
export function elevKm(lat, lon, smooth = false) {
  const d = DATA, f = smooth ? bicubic : bilinear;
  if (lat < -75) {
    const [x, y] = polarXY(lat, lon);
    if (Math.max(Math.abs(x), Math.abs(y)) < POLAR_HALF - 1)
      return f(d.polar.km, POLAR_N, POLAR_N, (x + POLAR_HALF) / (2 * POLAR_HALF) * POLAR_N - 0.5, (POLAR_HALF - y) / (2 * POLAR_HALF) * POLAR_N - 0.5, false);
  }
  return f(d.global.km, d.global.w, d.global.h, (lon + 180) * 8 - 0.5, (90 - lat) * 8 - 0.5, true);
}
export const hasDetailedData = lat => lat < -79.4;

// ---------- frames ----------
export function llToVec(lat, lon, out = new THREE.Vector3()) {
  const a = lat * D2R, b = lon * D2R; return out.set(Math.cos(a) * Math.cos(b), Math.sin(a), -Math.cos(a) * Math.sin(b));
}
export function vecToLL(v) { const n = v.clone().normalize(); return { lat: Math.asin(n.y) * R2D, lon: Math.atan2(-n.z, n.x) * R2D }; }
/** east, north, up unit vectors at a point */
export function localFrame(lat, lon) {
  const up = llToVec(lat, lon);
  let east = new THREE.Vector3(0, 1, 0).cross(up); if (east.lengthSq() < 1e-10) east.set(0, 0, -1); east.normalize();
  const north = up.clone().cross(east).normalize();
  return { up, east, north };
}
/** walk dx km east and dy km north along the surface, return lat/lon */
export function offsetLL(f, dx, dy) {
  const v = f.up.clone().addScaledVector(f.east, dx / R_KM).addScaledVector(f.north, dy / R_KM);
  return vecToLL(v);
}
export const sunDir = d => { const s = L.subSolar(d); return llToVec(s.lat, s.lon); };
export const earthDir = d => { const s = L.subEarth(d); return llToVec(s.lat, s.lon); };
/** Share of the Sun's disc hidden by Earth, seen from the Moon's centre (a lunar eclipse). Area, not width. */
export function earthBlocksSun(d) {
  const s = L.subSolar(d), e = L.subEarth(d);
  const a = Math.acos(Math.min(1, sunDir(d).dot(earthDir(d)))), rs = Math.asin(L.SUN_RADIUS_KM / s.km), re = Math.asin(L.EARTH_RADIUS_KM / e.km);
  if (a >= rs + re) return 0; if (a <= re - rs) return 1;
  // overlap of two circles (small angles, so flat geometry is exact to well under 1 percent)
  const cs = Math.acos((a * a + rs * rs - re * re) / (2 * a * rs)), ce = Math.acos((a * a + re * re - rs * rs) / (2 * a * re));
  const lens = rs * rs * (cs - Math.sin(2 * cs) / 2) + re * re * (ce - Math.sin(2 * ce) / 2);
  return Math.min(1, lens / (Math.PI * rs * rs));
}

// ---------- real skyline ----------
/**
  Skyline elevation (deg) in 360 one-degree bins, ray-cast over LOLA heights on a round Moon.
  The result also carries .beyond: the skyline of terrain farther than beyondKm only, for the relief
  block, which draws the nearer ground itself. One pass fills both.
*/
export function realSkyline(lat, lon, { fromKm = 0.6, toKm = 260, eye = 0.002, beyondKm = Infinity } = {}) {
  const f = localFrame(lat, lon), r0 = R_KM + elevKm(lat, lon) + eye, out = new Float32Array(360), beyond = new Float32Array(360);
  // Step 2% of the distance: near the observer the angle changes fast, so steps must be short there.
  // Cap at half a grid cell so no peak falls between samples (625 m polar grid, about 3.8 km global grid).
  const cap = lat < -75 ? 0.3 : 1.5;
  for (let az = 0; az < 360; az++) {
    const s = Math.sin(az * D2R), c = Math.cos(az * D2R); let best = -90, far = -90;
    for (let d = fromKm; d < toKm; d += Math.min(0.02 * d, cap)) {
      // g: angle at the Moon's centre for d km along the surface. offsetLL steps along the level plane,
      // so a step of R tan(g) lands exactly d km away.
      const g = d / R_KM, t = R_KM * Math.tan(g), ll = offsetLL(f, s * t, c * t), r = R_KM + elevKm(ll.lat, ll.lon);
      // the point's height above, and distance along, the observer's level plane
      const e = Math.atan2(r * Math.cos(g) - r0, r * Math.sin(g)) * R2D;
      if (e > best) best = e; if (d >= beyondKm && e > far) far = e;
    }
    out[az] = best; beyond[az] = far;
  }
  out.beyond = beyond;
  return out;
}
/** A Lunar site object whose skyline comes from LOLA instead of the synthetic one. */
export function realSite(name, lat, lon, horizon = realSkyline(lat, lon)) {
  return { id: `r${lat.toFixed(3)}_${lon.toFixed(3)}`, name, short: name, lat, lon, h: 0, rough: 0, group: 'Picked', horizon, elevKm: elevKm(lat, lon) };
}
export function placeName(lat, lon) {
  let best = null, bd = 1e9;
  for (const s of L.SITES) { const d = Math.acos(Math.min(1, llToVec(lat, lon).dot(llToVec(s.lat, s.lon)))) * R_KM; if (d < bd) { bd = d; best = s; } }
  const latS = `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}`, lonS = `${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;
  return { coords: `${latS} ${lonS}`, near: bd < 25 ? best.short : bd < 150 ? `${Math.round(bd)} km from ${best.short}` : null, nearSite: bd < 25 ? best : null };
}

// ---------- shaders ----------
const STYLES = ['photo', 'silver', 'plaster', 'chalk', 'binary', 'negative', 'topo', 'polar'];
const COMMON = /* glsl */`
  const float PI = 3.14159265, RK = 1737.4;
  vec3 S(vec3 c) { return pow(c, vec3(2.2)); } // palette colours are written in sRGB, shading runs in linear
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  vec3 styleColor(vec3 albedo, float lit, float h, vec2 frag, vec3 tint) {
  #if STYLE == 0  /* photo: LROC colour, linear light */
    return albedo * lit * 2.4;
  #elif STYLE == 1 /* silver: Hasselblad print, neutral and contrasty */
    float g = dot(albedo, vec3(.33)) * lit * 2.6; g = g / (g + .16) * 1.1; return S(vec3(.012)) + vec3(g * .98, g, g * 1.02);
  #elif STYLE == 2 /* plaster: white study model, shadow is the studio's cool grey */
    float amb = tint.x < .999 ? .62 + .38 * pow(clamp(tint.x, 0., 1.), 6.) : 1.; // studio fill keeps form inside shadow
    return mix(S(vec3(.56, .59, .64)) * amb, S(vec3(.97, .96, .94)), smoothstep(0., 1., pow(clamp(lit, 0., 1.), .6)));
  #elif STYLE == 3 /* chalk: pastel grains on black paper */
    float n = hash(floor(frag * .8)); float k = pow(clamp(lit, 0., 1.), .5);
    return mix(S(vec3(.07, .072, .08)), S(vec3(.93, .92, .88)), step(n, k * .95));
  #elif STYLE == 4 /* binary: pure black or white */
    return vec3(step(.05 + hash(floor(frag)) * .05, lit));
  #elif STYLE == 5 /* negative: glass plate, lit ground prints dark */
    float g = dot(albedo, vec3(.33)) * lit * 2.6; g = g / (g + .16); return S(vec3(.93, .95, .96)) * (1. - g * .96);
  #elif STYLE == 6 /* topo: hillshade on white with 250 m contours, index line every 1 km */
    float fw = fwidth(h / .25), fm = fwidth(h);
    float c = abs(fract(h / .25) - .5) / fw; float line = (1. - clamp(c - .5, 0., 1.)) * (1. - smoothstep(.12, .35, fw)); // fade where lines would crowd
    float idx = abs(fract(h) - .5) / fm; float major = (1. - clamp(idx - .8, 0., 1.)) * (1. - smoothstep(.12, .35, fm));
    vec3 base = mix(S(vec3(.68, .7, .73)), S(vec3(.97, .97, .96)), smoothstep(0., 1., pow(clamp(lit, 0., 1.), .5)));
    return mix(base, S(vec3(.55, .36, .22)), max(line * .4, major * .8));
  #else /* polar: survey white, deep ice-blue shadow */
    float k = smoothstep(0., 1., pow(clamp(lit, 0., 1.), .55));
    return mix(S(vec3(.10, .17, .27)), S(vec3(.95, .96, .97)) * (.6 + .5 * dot(albedo, vec3(.33)) * 2.), k);
  #endif
  }
`;

const GLOBE_VS = /* glsl */`
  varying vec3 vPos; varying vec3 vWorld;
  void main() { vPos = position; vec4 w = modelMatrix * vec4(position, 1.); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
`;
const GLOBE_FS = /* glsl */`
  precision highp float;
  uniform sampler2D uColor, uHeight, uPolar; uniform vec3 uSun; uniform float uExag, uShadows, uSel; uniform vec3 uSelA, uSelB;
  varying vec3 vPos; varying vec3 vWorld;
  ${COMMON}
  vec2 toLL(vec3 p) { return vec2(asin(clamp(p.y, -1., 1.)), atan(-p.z, p.x)); }
  float H(vec3 p) {
    vec2 ll = toLL(normalize(p)); float lat = degrees(ll.x);
    float g = texture2D(uHeight, vec2(ll.y / (2. * PI) + .5, .5 - ll.x / PI)).r;
    if (lat < -75.) {
      // blend in the 625 m polar grid by distance to its square edge (it ends at 79.48 S on the axes)
      float rho = 2. * RK * tan((ll.x + PI * .5) * .5); vec2 xy = rho * vec2(sin(ll.y), cos(ll.y));
      float pl = texture2D(uPolar, vec2((xy.x + 320.) / 640., (320. - xy.y) / 640.)).r;
      g = mix(g, pl, smoothstep(319., 300., max(abs(xy.x), abs(xy.y))));
    }
    return g;
  }
  void main() {
    vec3 p = normalize(vPos); vec2 ll = toLL(p); float lat = degrees(ll.x);
    vec3 east = cross(vec3(0., 1., 0.), p); east = length(east) < 1e-5 ? vec3(0., 0., -1.) : normalize(east);
    vec3 north = normalize(cross(p, east));
    float s = lat < -79.5 ? .7 : 3.8; float k = s / RK;
    float h0 = H(p);
    float gE = (H(p + east * k) - H(p - east * k)) / (2. * s), gN = (H(p + north * k) - H(p - north * k)) / (2. * s);
    vec3 n = normalize(p - uExag * (gE * east + gN * north));
    float mu0 = dot(n, uSun), su = dot(p, uSun);
    vec3 V = normalize(cameraPosition - vWorld); float mu = max(dot(n, V), 1e-3);
    float lit = mu0 > 0. ? mu0 / (mu0 + mu) * 2. : 0.;
    // cast shadows near the terminator, marched over the height maps
    if (uShadows > .5 && su > -.02 && su < .3 && lit > 0.) {
      vec2 sd = vec2(dot(uSun, east), dot(uSun, north)); float hl = length(sd); sd /= max(hl, 1e-5);
      float tanEl = su / max(hl, 1e-5), minM = 1.;
      float fine = lat < -79.5 ? 1. : 5.;
      for (int i = 1; i <= 56; i++) {
        float fi = float(i); float d = fine * (.7 * fi + .09 * fi * fi);
        vec3 q = normalize(p + (sd.x * east + sd.y * north) * (d / RK));
        float m = (H(q) - d * d / (2. * RK) - h0 - d * tanEl) / d; // >0 means terrain above the ray
        minM = min(minM, -m);
        if (minM < -.006) break;
      }
      lit *= smoothstep(-.0047, .0047, minM); // the Sun is a 0.54 deg disc: soft penumbra
    }
    vec3 albedo = texture2D(uColor, vec2(ll.y / (2. * PI) + .5, .5 + ll.x / PI)).rgb;
    vec3 col = styleColor(albedo, lit, h0, gl_FragCoord.xy, vec3(1.));
    gl_FragColor = vec4(col, 1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createGlobe(style = 'photo', { exag = 1.6, segments = 192 } = {}) {
  const d = DATA;
  const mat = new THREE.ShaderMaterial({
    defines: { STYLE: STYLES.indexOf(style) },
    uniforms: { uColor: { value: d.color }, uHeight: { value: d.globalTex }, uPolar: { value: d.polarTex }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uExag: { value: exag }, uShadows: { value: 1 }, uSel: { value: 0 }, uSelA: { value: new THREE.Vector3() }, uSelB: { value: new THREE.Vector3() } },
    vertexShader: GLOBE_VS, fragmentShader: GLOBE_FS,
  });
  mat.extensions = { derivatives: true };
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, segments, segments / 2), mat);
  return { mesh, material: mat, setSun: v => mat.uniforms.uSun.value.copy(v) };
}

export function createEarth({ radius = 1, style = 'photo' } = {}) {
  const mat = new THREE.ShaderMaterial({
    defines: { STYLE: STYLES.indexOf(style) },
    uniforms: { uMap: { value: DATA.earth }, uSun: { value: new THREE.Vector3(1, 0, 0) } },
    vertexShader: `varying vec2 vUv; varying vec3 vN; void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `uniform sampler2D uMap; uniform vec3 uSun; varying vec2 vUv; varying vec3 vN; ${COMMON}
      void main(){ vec3 a = texture2D(uMap, vUv).rgb; float l = max(0., dot(normalize(vN), uSun));
        #if STYLE == 0
          vec3 c = a * (l * 1.6 + .015);
        #else
          vec3 c = styleColor(a, l, 0., gl_FragCoord.xy, vec3(1.));
        #endif
        gl_FragColor = vec4(c, 1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 32), mat);
  return { mesh, setSun: v => mat.uniforms.uSun.value.copy(v), setSpin: hours => { mesh.rotation.y = hours / 24 * Math.PI * 2; } };
}

/** Sun as a hard white disc of true angular size. No glow: in vacuum the disc has a sharp edge. */
export function createSun(distance, { color = 0xffffff } = {}) {
  const r = distance * Math.tan(0.27 * D2R);
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(r, 48), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
  mesh.userData.distance = distance;
  return { mesh, place: (dir, camera) => { mesh.position.copy(dir).multiplyScalar(distance); mesh.lookAt(camera ? camera.position : new THREE.Vector3()); } };
}

export function createStars(n = 1600, radius = 900, seed = 7) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const z = rnd() * 2 - 1, t = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    pos.set([r * Math.cos(t) * radius, z * radius, r * Math.sin(t) * radius], i * 3);
    const b = Math.pow(rnd(), 3) * .7 + .08; col.set([b, b, b * 1.04], i * 3);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, vertexColors: true, toneMapped: false }));
}

// ---------- relief tiles ----------
function noise2(seed) {
  const p = new Float32Array(256 * 256); let s = seed >>> 0 || 1;
  for (let i = 0; i < p.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; p[i] = s / 4294967296; }
  return (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, g = (a, b) => p[((b & 255) << 8) | (a & 255)];
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return g(xi, yi) * (1 - u) * (1 - v) + g(xi + 1, yi) * u * (1 - v) + g(xi, yi + 1) * (1 - u) * v + g(xi + 1, yi + 1) * u * v; };
}
/**
  Height grid around (lat, lon). Large shapes from LOLA, detail under ~2 km synthetic
  (seeded fBm plus small craters), Moon curvature included.
  Returns { n, sizeKm, km: Float32Array, min, max, frame }.
*/
export function buildTile(lat, lon, { sizeKm = 40, n = 256, detail = 1 } = {}) {
  const f = localFrame(lat, lon), km = new Float32Array(n * n), seed = Math.round((lat + 90) * 1000) * 7919 + Math.round((lon + 180) * 1000);
  const nz = noise2(seed), cell = sizeKm / (n - 1);
  let r = seed >>> 0; const rnd = () => (r = (r * 1664525 + 1013904223) >>> 0) / 4294967296;
  const craters = []; for (let i = 0; i < 220 * detail; i++) { const rad = 0.12 + Math.pow(rnd(), 3) * 1.8; craters.push({ x: (rnd() - .5) * sizeKm, y: (rnd() - .5) * sizeKm, r: rad, d: rad * (.16 + rnd() * .06) }); }
  let mn = 1e9, mx = -1e9;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = -sizeKm / 2 + i * cell, y = sizeKm / 2 - j * cell; // +x east, +y north, row 0 at north
    const ll = offsetLL(f, x, y);
    let h = elevKm(ll.lat, ll.lon, true) - (x * x + y * y) / (2 * R_KM);
    if (detail) {
      let a = .09, fr = 1 / 3.2; for (let o = 0; o < 5; o++) { h += (nz(x * fr + 31, y * fr + 17) - .5) * a; a *= .5; fr *= 2; }
      for (const c of craters) { const dd = Math.hypot(x - c.x, y - c.y) / c.r; if (dd < 1.35) h += dd < 1 ? -c.d * (1 - dd * dd) : c.d * .25 * Math.exp(-((dd - 1) ** 2) / .02); }
    }
    km[j * n + i] = h; mn = Math.min(mn, h); mx = Math.max(mx, h);
  }
  return { n, sizeKm, km, min: mn, max: mx, frame: f, lat, lon };
}

const TILE_VS = /* glsl */`
  uniform sampler2D uH; uniform float uSize, uExag, uBase; attribute float aTop;
  varying vec2 vUv; varying float vH; varying vec3 vWorld; varying float vWall;
  void main() {
    vUv = uv; float h = texture2D(uH, uv).r * uExag; vH = h / uExag; vWall = 1. - aTop;
    vec3 p = position; p.y = aTop > .5 ? h : uBase;
    vec4 w = modelMatrix * vec4(p, 1.); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const TILE_FS = /* glsl */`
  precision highp float;
  uniform sampler2D uH, uFar, uStudy, uStudy2; uniform vec3 uSun; uniform float uSize, uN, uExag, uBlock; uniform vec3 uWall, uStudyInk;
  varying vec2 vUv; varying float vH; varying vec3 vWorld; varying float vWall;
  ${COMMON}
  float Ht(vec2 uv) { return texture2D(uH, uv).r * uExag; }
  void main() {
  #ifdef WALL
    gl_FragColor = vec4(uWall * (1. - .45 * vWall), 1.);
    #include <colorspace_fragment>
    return;
  #endif
    float t = 1. / uN, cell = uSize / (uN - 1.);
    // +u is east (+x), +v is south (+z)
    vec3 n = normalize(vec3(-(Ht(vUv + vec2(t, 0.)) - Ht(vUv - vec2(t, 0.))) / (2. * cell), 1., -(Ht(vUv + vec2(0., t)) - Ht(vUv - vec2(0., t))) / (2. * cell)));
    // uSun is in tile space: x east, y up, z south
    float mu0 = dot(n, uSun); vec3 V = normalize(cameraPosition - vWorld); float mu = max(dot(n, V), 1e-3);
    float lit = mu0 > 0. ? mu0 / (mu0 + mu) * 2. : 0.;
    float hs = length(uSun.xz); vec2 dir = vec2(uSun.x, -uSun.z) / max(hs, 1e-5); // in uv: +u east, +v north? v grows south
    float tanEl = uSun.y / max(hs, 1e-5), h0 = Ht(vUv) + .002, minM = 1.;
    if (lit > 0.) {
      for (int i = 1; i <= 96; i++) {
        float d = cell * (1.2 * float(i) + .02 * float(i * i));
        vec2 q = vUv + vec2(dir.x, -dir.y) * d / uSize;
        if (q.x < 0. || q.y < 0. || q.x > 1. || q.y > 1.) break;
        float m = (Ht(q) - h0 - d * tanEl) / d; minM = min(minM, -m);
        if (minM < -.006) break;
      }
      // far terrain beyond the tile: skyline at the tile centre, one value per degree
      float az = atan(uSun.x, -uSun.z); float far = texture2D(uFar, vec2(fract(az / (2. * PI)), .5)).r;
      float el = atan(uSun.y, hs);
      minM = min(minM, el - far);
      lit *= smoothstep(-.0047, .0047, minM) * (1. - uBlock);
    }
    float grain = hash(floor(vUv * 1400.)) * .5 + hash(floor(vUv * 220.)) * .5;
    vec3 albedo = vec3(.16, .155, .15) * (.8 + .4 * grain);
    vec3 col = styleColor(albedo, lit, vH, gl_FragCoord.xy, vec3(n.y, 0., 0.));
  #ifdef STUDY
    // shadow study: each channel of uStudy/uStudy2 is "lit" (1) or "shadow" (0) at one future step,
    // linearly filtered, so its 0.5 contour is a smooth shadow edge. Later steps draw darker,
    // the way an architect stacks hourly shadow outlines.
    vec4 sa = texture2D(uStudy, vUv), sb = texture2D(uStudy2, vUv);
    float vals[8]; vals[0] = sa.r; vals[1] = sa.g; vals[2] = sa.b; vals[3] = sa.a; vals[4] = sb.r; vals[5] = sb.g; vals[6] = sb.b; vals[7] = sb.a;
    for (int k = 0; k < 8; k++) {
      float v = vals[k]; float w = fwidth(v) * 1.1 + 1e-4;
      float line = 1. - smoothstep(0., w, abs(v - .5));
      col = mix(col, S(uStudyInk) * (1. - float(k) * .08), line * (.5 + float(k) * .06));
    }
  #endif
    gl_FragColor = vec4(col, 1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** CPU shadow mask for a tile and a sun vector in tile space. Returns Uint8Array 0/1. */
export function tileShadowMask(tile, farDeg, sun) {
  const n = tile.n, km = tile.km, cell = tile.sizeKm / (n - 1), out = new Uint8Array(n * n);
  const hs = Math.hypot(sun.x, sun.z); if (sun.y <= -0.02) return out;
  const de = sun.x / hs, ds = sun.z / hs, tanEl = sun.y / hs, el = Math.atan2(sun.y, hs);
  const az = (Math.atan2(sun.x, -sun.z) * R2D + 360) % 360; if (el < farDeg[Math.floor(az) % 360] * D2R) return out;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const h0 = km[j * n + i] + 0.002; let lit = 1;
    for (let k = 1; k < 96; k++) {
      const d = cell * (1.2 * k + 0.02 * k * k), x = i + de * d / cell, y = j + ds * d / cell;
      if (x < 0 || y < 0 || x > n - 1 || y > n - 1) break;
      if (km[Math.round(y) * n + Math.round(x)] > h0 + d * tanEl) { lit = 0; break; }
    }
    out[j * n + i] = lit;
  }
  return out;
}

/** Far skyline as a ring of terrain at radius rKm around a ground view (for 'ground' cameras). */
export function createSkylineRing(farDeg, rKm, baseY, color = 0x3a3a3a) {
  const pos = [], idx = [];
  for (let a = 0; a <= 360; a++) {
    const t = a * D2R, x = Math.sin(t) * rKm, z = -Math.cos(t) * rKm, top = baseY + Math.tan(Math.max(-5, farDeg[a % 360]) * D2R) * rKm;
    pos.push(x, baseY - rKm * 0.2, z, x, top, z);
    if (a < 360) { const v = a * 2; idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
}

function tileGeometry(n, size, base = true) {
  const g = new THREE.PlaneGeometry(size, size, n - 1, n - 1); g.rotateX(-Math.PI / 2);
  // PlaneGeometry uv.y = 1 at north (-z after rotation). Our texture row 0 is north, so flip v.
  const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  const top = new Float32Array(g.attributes.position.count).fill(1); g.setAttribute('aTop', new THREE.BufferAttribute(top, 1));
  if (!base) return g;
  // four skirt walls so the tile reads as a cut block of ground
  const pos = [], uvs = [], tops = [], idx = []; const h = size / 2; let v = 0;
  const edge = (pts) => { for (let k = 0; k < pts.length - 1; k++) { const [a, b] = [pts[k], pts[k + 1]];
    for (const [p, tp] of [[a, 1], [b, 1], [a, 0], [b, 0]]) { pos.push(p[0], 0, p[1]); uvs.push(p[2], p[3]); tops.push(tp); }
    idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3); v += 4; } };
  const S = 64, line = (f) => [...Array(S + 1)].map((_, i) => f(i / S));
  edge(line(t => [-h + t * size, h, t, 1]));          // south edge (z = +h, v = 1)
  edge(line(t => [h, h - t * size, 1, 1 - t]));       // east
  edge(line(t => [h - t * size, -h, 1 - t, 0]));      // north
  edge(line(t => [-h, -h + t * size, 0, t]));         // west
  const w = new THREE.BufferGeometry(); w.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); w.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); w.setAttribute('aTop', new THREE.Float32BufferAttribute(tops, 1)); w.setIndex(idx);
  return [g, w];
}

/**
  A relief block for one point. Returns { group, tile, site, setDate(d), sunLocal, dispose }.
  style: one of STYLES. sizeKm: block width. walls: draw cut sides.
*/
export function createRelief(lat, lon, { style = 'photo', sizeKm = 40, n = 256, exag = 1, walls = true, wallColor = 0x2a2a2c, name, study = false, studyInk = [0.42, 0.2, 0.16] } = {}) {
  const tile = buildTile(lat, lon, { sizeKm, n });
  const hd = new Uint16Array(n * n); for (let i = 0; i < hd.length; i++) hd[i] = THREE.DataUtils.toHalfFloat(tile.km[i] - tile.min);
  const hTex = new THREE.DataTexture(hd, n, n, THREE.RedFormat, THREE.HalfFloatType); hTex.magFilter = hTex.minFilter = THREE.LinearFilter; hTex.needsUpdate = true;
  const sky = realSkyline(lat, lon, { beyondKm: sizeKm * 0.55 }), far = sky.beyond;
  const fd = new Uint16Array(360); for (let i = 0; i < 360; i++) fd[i] = THREE.DataUtils.toHalfFloat(far[i] * D2R);
  const farTex = new THREE.DataTexture(fd, 360, 1, THREE.RedFormat, THREE.HalfFloatType); farTex.magFilter = farTex.minFilter = THREE.LinearFilter; farTex.wrapS = THREE.RepeatWrapping; farTex.needsUpdate = true;
  const base = -1.2 - (tile.max - tile.min) * 0.15;
  const mkStudy = () => { const t = new THREE.DataTexture(new Uint8Array(n * n * 4).fill(255), n, n, THREE.RGBAFormat, THREE.UnsignedByteType); t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true; return t; };
  const studyTex = mkStudy(), studyTex2 = mkStudy();
  const uniforms = { uH: { value: hTex }, uFar: { value: farTex }, uStudy: { value: studyTex }, uStudy2: { value: studyTex2 }, uStudyInk: { value: new THREE.Vector3(...studyInk) }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uSize: { value: sizeKm }, uN: { value: n }, uExag: { value: exag }, uBase: { value: base }, uBlock: { value: 0 }, uWall: { value: new THREE.Color(wallColor) } };
  const defs = { STYLE: STYLES.indexOf(style) }; if (study) defs.STUDY = 1;
  const mat = new THREE.ShaderMaterial({ defines: defs, uniforms, vertexShader: TILE_VS, fragmentShader: TILE_FS, side: THREE.DoubleSide });
  mat.extensions = { derivatives: true };
  const [gTop, gWall] = tileGeometry(n, sizeKm, true);
  const wallMat = new THREE.ShaderMaterial({ defines: { STYLE: STYLES.indexOf(style), WALL: 1 }, uniforms, vertexShader: TILE_VS, fragmentShader: TILE_FS, side: THREE.DoubleSide });
  const group = new THREE.Group(); group.add(new THREE.Mesh(gTop, mat)); if (walls) group.add(new THREE.Mesh(gWall, wallMat));
  const site = realSite(name || placeName(lat, lon).coords, lat, lon, sky);
  const api = {
    group, tile, site, uniforms, sunLocal: new THREE.Vector3(), earthLocal: new THREE.Vector3(),
    far, studyTex,
    /** fill the shadow-study texture: one bit per date, up to 8 dates */
    computeStudy(dates) {
      const masks = dates.slice(0, 8).map(d => tileShadowMask(tile, far, api.toLocal(sunDir(d), new THREE.Vector3())));
      const a = studyTex.image.data, b = studyTex2.image.data; a.fill(255); b.fill(255);
      masks.forEach((m, k) => { const dst = k < 4 ? a : b, c = k % 4; for (let i = 0; i < m.length; i++) dst[i * 4 + c] = m[i] * 255; });
      studyTex.needsUpdate = studyTex2.needsUpdate = true;
    },
    toLocal(dirMoon, out) { const f = tile.frame; return out.set(dirMoon.dot(f.east), dirMoon.dot(f.up), -dirMoon.dot(f.north)); },
    setDate(d) {
      api.toLocal(sunDir(d), api.sunLocal);
      // Earth from the site itself, not the Moon's centre: parallax moves it up to 0.27 deg
      const e = L.earth(site, d), ce = Math.cos(e.el * D2R);
      api.earthLocal.set(ce * Math.sin(e.az * D2R), Math.sin(e.el * D2R), -ce * Math.cos(e.az * D2R));
      uniforms.uSun.value.copy(api.sunLocal); uniforms.uBlock.value = earthBlocksSun(d);
    },
    dispose() { hTex.dispose(); farTex.dispose(); mat.dispose(); wallMat.dispose(); gTop.dispose(); gWall.dispose(); },
  };
  return api;
}

// ---------- stage: one WebGL canvas, many views ----------
export class Stage {
  constructor({ background = 0x000000, antialias = true } = {}) {
    this.canvas = document.createElement('canvas');
    // The canvas sits above the page (pointer events pass through) so opaque panels cannot hide a view.
    // Anything that must draw over a 3D view (pins, labels, buttons) needs z-index 3 or more.
    Object.assign(this.canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '2' });
    document.body.prepend(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    this.renderer.setScissorTest(true);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.views = []; this.pending = false; this.bg = background; this._w = 0; this._h = 0; this._dpr = 0;
    const syncSize = () => {
      const w = innerWidth, h = innerHeight, dpr = Math.min(2, devicePixelRatio || 1);
      if (this._w !== w || this._h !== h || this._dpr !== dpr) {
        this._w = w; this._h = h; this._dpr = dpr;
        this.renderer.setPixelRatio(dpr);
        this.renderer.setSize(w, h, false);
      }
    };
    this._syncSize = syncSize;
    addEventListener('resize', () => { syncSize(); this.request(); }); syncSize();
    // any scroll (window or an inner panel) or layout change moves view boxes
    document.addEventListener('scroll', () => this.request(), { passive: true, capture: true });
    this.ro = new ResizeObserver(() => this.request());
    new MutationObserver(() => this.request()).observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  /** el: DOM element whose box is the viewport. controls: optional OrbitControls bound to el. */
  /** crop: optional () => [x0, x1] fractions of the element width to draw (for wipes). hidden views are skipped. */
  add(el, scene, camera, { controls = null, clear = null, before = null, crop = null } = {}) {
    const v = { el, scene, camera, controls, clear, before, crop, hidden: false }; this.views.push(v); this.ro.observe(el);
    if (controls) controls.addEventListener('change', () => this.request());
    this.request(); return v;
  }
  remove(v) { this.views = this.views.filter(x => x !== v); this.ro.unobserve(v.el); v.controls?.dispose(); this.request(); }
  request() { if (!this.pending) { this.pending = true; requestAnimationFrame(() => this.render()); } }
  render() {
    this.pending = false; this._syncSize(); const r = this.renderer, H = innerHeight; let moving = false;
    r.setScissor(0, 0, innerWidth, H); r.setClearColor(0, 0); r.clear();
    for (const v of this.views) {
      const b = v.el.getBoundingClientRect();
      if (v.hidden || b.bottom < 0 || b.top > H || b.width < 2 || b.height < 2) continue;
      if (v.controls && v.controls.update()) moving = true;
      v.camera.aspect = b.width / b.height; v.camera.updateProjectionMatrix();
      v.before?.(v);
      const [c0, c1] = v.crop ? v.crop() : [0, 1];
      r.setViewport(b.left, H - b.bottom, b.width, b.height); r.setScissor(b.left + b.width * c0, H - b.bottom, b.width * (c1 - c0), b.height);
      const c = v.clear ?? this.bg; if (c === 'transparent') r.setClearColor(0, 0); else r.setClearColor(c, 1); r.clear();
      r.render(v.scene, v.camera);
    }
    if (moving) this.request();
  }
}

/** Raycast a click on a view element against a sphere of radius 1 at the origin. Returns {lat, lon} or null. */
export function pickGlobe(ev, el, camera) {
  const b = el.getBoundingClientRect();
  const nd = new THREE.Vector2(((ev.clientX - b.left) / b.width) * 2 - 1, -((ev.clientY - b.top) / b.height) * 2 + 1);
  const rc = new THREE.Raycaster(); rc.setFromCamera(nd, camera);
  const o = rc.ray.origin, dd = rc.ray.direction, bq = o.dot(dd), c = o.lengthSq() - 1, disc = bq * bq - c;
  if (disc < 0) return null; const t = -bq - Math.sqrt(disc); if (t < 0) return null;
  return vecToLL(o.clone().addScaledVector(dd, t));
}

/** Detect a click (not a drag) on an element. */
export function onTap(el, fn) {
  let sx = 0, sy = 0, t = 0;
  el.addEventListener('pointerdown', e => { sx = e.clientX; sy = e.clientY; t = performance.now(); });
  el.addEventListener('pointerup', e => { if (Math.hypot(e.clientX - sx, e.clientY - sy) < 5 && performance.now() - t < 500) fn(e); });
}

/** Plain-language stats for a picked site and date. */
export function siteStats(site, date) {
  const s = L.summary(site, date);
  const sc = s.sunChange, ec = s.earthChange;
  return {
    sunUp: s.sun.up, earthUp: s.earth.up,
    sunText: !isFinite(sc.hours)
      ? (sc.nowUp ? 'Lit for 60+ d' : 'Dark for 60+ d')
      : (sc.nowUp ? `Dark in ${L.fmtHours(sc.hours)}` : `Light in ${L.fmtHours(sc.hours)}`),
    earthText: !isFinite(ec.hours)
      ? (ec.nowUp ? 'In view for 60+ d' : 'No signal for 60+ d')
      : (ec.nowUp ? `Signal lost in ${L.fmtHours(ec.hours)}` : `Signal back in ${L.fmtHours(ec.hours)}`),
    sunShare: Math.round(s.sunFrac * 100), earthShare: Math.round(s.earthFrac * 100), bothShare: Math.round(s.bothFrac * 100),
    longestDark: L.fmtHours(s.longestDark), sunMargin: s.sun.margin, earthMargin: s.earth.margin, summary: s,
  };
}

export const IMPORTMAP = 'three@0.169.0';
