/*
  app3d.js: the shared app layer for prototypes 11 to 20.
  Owns the scene (Moon, Earth, Sun), picking, the list of picked places, time, and relief views.
  Each prototype supplies its own look (shader style, colours) and its own layout.
*/
import { THREE, OrbitControls, loadMoonData, createGlobe, createEarth, createSun, createStars, createRelief, createSkylineRing,
  Stage, pickGlobe, onTap, sunDir, earthDir, llToVec, placeName, siteStats, earthBlocksSun } from './moon3d.js';
export * from './moon3d.js';
const L = window.Lunar;

export const DEFAULT_DATE = new Date(Date.UTC(2027, 9, 25, 6)); // a lunar day with the Sun above the south pole's horizon

/**
 options:
   globeEl       element that hosts the globe view
   style         shader style for globe and reliefs ('photo', 'silver', 'plaster', 'chalk', 'binary', 'negative', 'topo', 'polar')
   reliefStyle   override style for reliefs
   clear         background colour of 3D views, or 'transparent'
   maxPlaces     how many places can be open at once (oldest is replaced)
   stars         show a faint star field
   earthDist     distance of Earth from the Moon in Moon radii (direction is true)
   start         initial places [{lat, lon, name}]
   onChange      called with (app) whenever places or time change
   onRender      called every globe frame with (app), for DOM overlays
*/
export async function createApp(o) {
  const opt = Object.assign({ style: 'photo', clear: 0x000000, maxPlaces: 3, stars: true, earthDist: 60, start: [], date: DEFAULT_DATE }, o);
  await Promise.all([loadMoonData(), L.loadEphemeris(opt.ephemeris || 'data/ephemeris.json')]);
  // the stats look up to 60 days ahead, so the last date we accept is 61 days before the table ends
  const dateRange = { start: L.RANGE.start, end: new Date(L.RANGE.end.getTime() - 61 * 864e5) };
  const clampDate = d => new Date(Math.min(Math.max(new Date(d).getTime(), dateRange.start.getTime()), dateRange.end.getTime()));
  const stage = new Stage({ background: opt.clear });
  const scene = new THREE.Scene();
  const globe = createGlobe(opt.style); scene.add(globe.mesh);
  const earthR = opt.earthDist * Math.tan(0.95 * Math.PI / 180);
  const earth = createEarth({ radius: earthR, style: opt.earthStyle || (opt.style === 'photo' || opt.style === 'silver' ? 'photo' : opt.style) }); scene.add(earth.mesh);
  const sun = createSun(500, { color: opt.sunColor ?? 0xffffff }); scene.add(sun.mesh);
  if (opt.stars) scene.add(createStars(1400, 800));
  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 2000);
  const controls = new OrbitControls(camera, opt.globeEl);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, minDistance: 1.18, maxDistance: 12, rotateSpeed: 0.6, enablePan: false });
  const app = {
    THREE, stage, scene, globe, earth, sun, camera, controls, opt, dateRange,
    date: clampDate(opt.date), places: [], playing: false,
    onChange: opt.onChange || (() => {}), onRender: opt.onRender || (() => {}),
  };
  app.globeView = stage.add(opt.globeEl, scene, camera, { controls, clear: opt.clear, before: () => { sun.place(sunDir(app.date), camera); app.onRender(app); } });

  // camera: keep target locked on the Moon's center (0, 0, 0) so rotation stays centered
  app.focus = (lat = -89.5, lon = 0, dist = 4.4) => {
    const s = L.subSolar(app.date);
    const camLat = lat <= -82 ? -42 : lat >= 82 ? 42 : Math.max(-65, Math.min(65, lat));
    const camLon = (lat <= -82 || lat >= 82) ? s.lon + 75 : lon;
    const side = llToVec(camLat, camLon);
    camera.position.copy(side.multiplyScalar(dist));
    controls.target.set(0, 0, 0);
    controls.update();
    stage.request();
  };

  app.setDate = (d, { fast = false } = {}) => {
    app.date = clampDate(d);
    if (app.playing && app.date.getTime() === dateRange.end.getTime()) app.playing = false; // ran off the end of the table
    const sd = sunDir(app.date), ed = earthDir(app.date);
    globe.setSun(sd); earth.setSun(sd); earth.mesh.position.copy(ed).multiplyScalar(opt.earthDist);
    earth.setSpin(app.date.getUTCHours() + app.date.getUTCMinutes() / 60);
    for (const p of app.places) app._updatePlace(p, fast);
    app.onChange(app, { fast }); stage.request();
  };

  app._updatePlace = (p, fast = false) => {
    p.relief.setDate(app.date);
    if (p.skyObjs) { const s = p.relief.sunLocal, e = p.relief.earthLocal; p.skyObjs.sun.position.copy(s).multiplyScalar(4000); p.skyObjs.earth.position.copy(e).multiplyScalar(4000); p.skyObjs.earthMesh.setSun(s); p.skyObjs.sun.lookAt(0, 0, 0); }
    // stats scan a whole lunar day: while playing or scrubbing, refresh them on a short throttle, not every frame
    const now = performance.now();
    if (!p.stats || (!app.playing && !fast) || now - (p.statsAt || 0) > (fast ? 120 : 300)) { p.stats = siteStats(p.relief.site, app.date); p.statsAt = now; }
    p.eclipse = earthBlocksSun(app.date);
  };

  /** Add a place. Returns the place. The page mounts its relief with mountRelief(place, el). */
  app.addPlace = (lat, lon, name) => {
    if (app.places.length >= opt.maxPlaces) app.removePlace(app.places[0]);
    const nm = placeName(lat, lon);
    const relief = createRelief(lat, lon, { style: opt.reliefStyle || opt.style, sizeKm: opt.reliefKm || 40, n: opt.reliefN || 256, walls: opt.walls ?? true, wallColor: opt.wallColor ?? 0x2a2a2c, name: name || nm.near || nm.coords, study: !!opt.study, studyInk: opt.studyInk });
    const p = { id: Math.random().toString(36).slice(2, 8), lat, lon, name: name || nm.nearSite?.name || nm.near || 'Picked point', coords: nm.coords, near: nm.near, relief, view: null, stats: null, index: 0 };
    app.places.push(p); app.places.forEach((q, i) => q.index = i);
    app._updatePlace(p); app.onChange(app); stage.request();
    return p;
  };
  app.removePlace = p => {
    if (p.view) stage.remove(p.view); p.relief.dispose();
    app.places = app.places.filter(q => q !== p); app.places.forEach((q, i) => q.index = i);
    app.onChange(app); stage.request();
  };

  /**
   Mount a relief view for a place into an element.
   view: 'orbit' (default, look at the block) or 'ground' (stand at the centre, 2 m eye height)
  */
  app.mountRelief = (p, el, { view = 'orbit', clear = opt.clear, sky = true, fov = 38, height = null, aim = 'sun' } = {}) => {
    if (p.view) stage.remove(p.view);
    app._updatePlace(p); // sun and earth vectors are needed to aim the camera
    const sc = new THREE.Scene(); sc.add(p.relief.group);
    const size = p.relief.tile.sizeKm, mid = (p.relief.tile.max - p.relief.tile.min) * 0.5;
    const cam = new THREE.PerspectiveCamera(fov, 1, view === 'ground' ? 0.001 : 0.5, 20000);
    const ctl = new OrbitControls(cam, el); Object.assign(ctl, { enableDamping: true, dampingFactor: 0.08, enablePan: false });
    if (view === 'ground') {
      const h0 = p.relief.tile.km[(p.relief.tile.n >> 1) * p.relief.tile.n + (p.relief.tile.n >> 1)] - p.relief.tile.min + (opt.eyeKm ?? 0.05);
      // terrain beyond the block, drawn as a ring at 70 km from the LOLA skyline
      sc.add(createSkylineRing(p.relief.far, 70, h0, opt.ringColor ?? 0x2e2e2e));
      const s = aim === 'earth' ? p.relief.earthLocal : p.relief.sunLocal; const az = Math.atan2(s.x, -s.z);
      ctl.target.set(Math.sin(az) * 0.01, h0, -Math.cos(az) * 0.01); cam.position.set(0, h0, 0);
      cam.position.set(-Math.sin(az) * 0.0001, h0, Math.cos(az) * 0.0001);
      Object.assign(ctl, { enableZoom: false, rotateSpeed: -0.35, minPolarAngle: Math.PI * 0.3, maxPolarAngle: Math.PI * 0.62 });
    } else {
      const s = p.relief.sunLocal; const az = Math.atan2(s.x, -s.z) + Math.PI * 0.72;
      const box = el.getBoundingClientRect(), aspect = box.width / Math.max(1, box.height), k = aspect < 1.2 ? Math.pow(1.2 / aspect, 0.85) : 1;
      const size0 = size; { const size = size0 * k;
      cam.position.set(Math.sin(az) * size * 0.95, height ?? size * 0.78, -Math.cos(az) * size * 0.95); ctl.target.set(0, mid * 0.4, 0);
      Object.assign(ctl, { minDistance: size0 * 0.25, maxDistance: size0 * 3, maxPolarAngle: Math.PI * 0.47 }); }
    }
    if (sky) {
      const sunM = new THREE.Mesh(new THREE.CircleGeometry(4000 * Math.tan(0.27 * Math.PI / 180), 40), new THREE.MeshBasicMaterial({ color: opt.sunColor ?? 0xffffff, toneMapped: false }));
      const em = createEarth({ radius: 4000 * Math.tan(0.95 * Math.PI / 180), style: opt.earthStyle || (opt.style === 'photo' || opt.style === 'silver' ? 'photo' : opt.style) });
      em.mesh.material.uniforms.uMap.value = app.earth.mesh.material.uniforms.uMap.value;
      sc.add(sunM, em.mesh); if (opt.stars) sc.add(createStars(900, 6000, 3));
      p.skyObjs = { sun: sunM, earth: em.mesh, earthMesh: em };
    }
    p.camera = cam; p.controls = ctl; p.scene = sc;
    p.view = stage.add(el, sc, cam, { controls: ctl, clear });
    app._updatePlace(p); stage.request();
    return p.view;
  };

  /** Screen position of a lat/lon on the globe view, relative to the globe element. hidden when on the far side. */
  app.project = (lat, lon) => {
    const v = llToVec(lat, lon), w = v.clone().project(camera), b = opt.globeEl.getBoundingClientRect();
    const facing = v.dot(camera.position.clone().sub(v)) > 0;
    return { x: (w.x + 1) / 2 * b.width, y: (1 - w.y) / 2 * b.height, visible: facing };
  };

  // picking
  onTap(opt.globeEl, e => { const ll = pickGlobe(e, opt.globeEl, camera); if (ll) { const p = app.addPlace(ll.lat, ll.lon); opt.onPick?.(p, app); } });

  // playback: advances time only while playing, then stops drawing
  let last = 0;
  app.play = (hoursPerSecond = 12) => {
    app.playing = true; last = performance.now();
    const step = t => { if (!app.playing) return; const dt = (t - last) / 1000; last = t;
      app.setDate(new Date(app.date.getTime() + dt * hoursPerSecond * 36e5)); requestAnimationFrame(step); };
    requestAnimationFrame(step);
  };
  app.pause = () => { app.playing = false; app.onChange(app); };

  window.__moonApp = app; // handy for measuring in devtools
  app.setDate(app.date); app.focus();
  for (const s of opt.start) app.addPlace(s.lat, s.lon, s.name);
  return app;
}

/** "28 Oct 2027, 06:00 UTC" */
export function fmtWhen(d) {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

export const IMPORTS = `<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"}}</script>`;
