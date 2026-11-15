/*
  app3d.js: the shared app layer for prototypes 11 to 20.
  Owns the scene (Moon, Earth, Sun), picking, the list of picked places, time, and relief views.
  Each prototype supplies its own look (shader style, colours) and its own layout.
  Written with Claude Code (an AI coding agent) at the team's direction. See README.md, "Use of AI".
*/
import { THREE, OrbitControls, loadMoonData, createGlobe, createEarth, createSun, createStars, createRelief, createSkylineRing,
  Stage, pickGlobe, onTap, sunDir, earthDir, llToVec, placeName, siteStats, earthBlocksSun, addDetail, removeDetail } from './moon3d.js?v=10';
export * from './moon3d.js?v=10';
import * as M3 from './moon3d.js?v=10';
import { loadSiteIndex, dataAt, loadPatch, dropPatch, patchHolds } from './real-ground.js?v=6';
export { dataAt };
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
  const loaded = new Map(); // file -> { meta, P }
  const loadBlock = (lat, lon) => {
    const d = dataAt(lat, lon);
    if (!d.block || loaded.has(d.block.file)) return null;
    return loadPatch(d.block, 'block').then(P => { addDetail(P); loaded.set(d.block.file, { meta: d.block, P }); return P; });
  };
  // the built-in sites' skylines come with the index of their NASA maps (site/assets/sites, tools/build-sites.py);
  // load the start sites' blocks in parallel with the global height packs instead of waiting a second round trip.
  const startReady = Promise.all([
    L.loadEphemeris(opt.ephemeris || 'data/ephemeris.json'),
    loadSiteIndex().then(j => L.useSkylines(j)),
  ]).then(() => {
    opt.onDataReady?.();
    return Promise.all(opt.start.map(s => loadBlock(s.lat, s.lon)).filter(Boolean)).catch(e => console.warn('NASA map did not load:', e.message));
  });
  await Promise.all([loadMoonData(), startReady]);
  // the stats look up to 60 days ahead, so the last date we accept is 61 days before the table ends
  const dateRange = { start: L.RANGE.start, end: new Date(L.RANGE.end.getTime() - 61 * 864e5) };
  const clampDate = d => new Date(Math.min(Math.max(new Date(d).getTime(), dateRange.start.getTime()), dateRange.end.getTime()));
  const stage = new Stage({ background: opt.clear });
  const scene = new THREE.Scene();
  const globe = createGlobe(opt.style); scene.add(globe.mesh);
  // a GPU that needs over 12 ms for its first frames gets the Moon's coarse shadows (the shadow loop is 70% of its cost)
  stage.onSlow = () => { globe.setCoarseShadows(true); stage.request(); };
  M3.whenFullColor()?.then(() => stage.request()); // the 4096 px colour map replaced the 1024 px one
  const earthR = opt.earthDist * Math.tan(0.95 * Math.PI / 180);
  const earth = createEarth({ radius: earthR, style: opt.earthStyle || (opt.style === 'photo' || opt.style === 'silver' ? 'photo' : opt.style) }); scene.add(earth.mesh);
  const sun = createSun(500, { color: opt.sunColor ?? 0xffffff }); scene.add(sun.mesh);
  if (opt.stars) scene.add(createStars(1400, 800));
  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 2000);
  const controls = new OrbitControls(camera, opt.globeEl);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, minDistance: 1.18, maxDistance: 12, rotateSpeed: 0.6, enablePan: false });
  const app = {
    THREE, stage, scene, globe, earth, sun, camera, controls, opt, dateRange,
    lib: M3, // moon3d.js as this page loaded it: modules loaded later use this copy and its terrain data
    date: clampDate(opt.date), places: [], playing: false,
    onChange: opt.onChange || (() => {}), onRender: opt.onRender || (() => {}),
  };
  app.globeView = stage.add(opt.globeEl, scene, camera, { controls, clear: opt.clear, before: () => { sun.place(sunDir(app.date), camera); app.onRender(app); } });

  // camera: keep target locked on the Moon's center (0, 0, 0) so rotation stays centered.
  // A polar site is seen from straight below (or above) its pole, far enough that the whole disc fits the view,
  // with 0 deg longitude (the Earth-facing side) at the top.
  // opt.globeMargin: pixels left between the Moon's edge and the view's nearest side (default 8% of the half size)
  app.focus = (lat = -89.5, lon = 0, dist = null) => {
    // spend what is left of a drag's damped spin first, so it does not turn the new view
    const damping = controls.enableDamping;
    controls.enableDamping = false; controls.update();
    if (lat <= -80 || lat >= 80) {
      const b = opt.globeEl.getBoundingClientRect(), aspect = b.width / Math.max(1, b.height);
      const halfV = camera.fov / 2 * Math.PI / 180, halfH = Math.atan(Math.tan(halfV) * aspect);
      const S = Math.max(1, Math.min(b.width, b.height) / 2), margin = opt.globeMargin ?? S * 0.08;
      const fit = 1 / Math.sin(Math.atan(Math.max(0.5, (S - margin) / S) * Math.tan(Math.min(halfV, halfH))));
      camera.position.copy(llToVec(lat < 0 ? -89 : 89, 0).multiplyScalar(dist ?? fit));
    } else {
      camera.position.copy(llToVec(Math.max(-65, Math.min(65, lat)), lon).multiplyScalar(dist ?? 3.0));
    }
    controls.target.set(0, 0, 0);
    controls.update();
    controls.enableDamping = damping;
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

  /*
    NASA block patch (44 km, 59 to 118 m per pixel) for a place, if a built-in site's patch holds it. Once loaded it joins
    every height lookup (addDetail), so the block and skyline of any place inside it use it too.
  */
  // Drop block patches that no open place lies inside. The open places' own heights never change: each keeps
  // every patch that covers it. Without this, every site ever opened keeps its patch for the life of the page.
  const releaseBlocks = () => {
    for (const [file, { meta, P }] of loaded) {
      if (app.places.some(q => patchHolds(meta, q.lat, q.lon))) continue;
      removeDetail(P); dropPatch(file); loaded.delete(file);
    }
  };

  /** Add a place. Returns the place. The page mounts its relief with mountRelief(place, el). */
  app.addPlace = (lat, lon, name) => {
    if (app.places.length >= opt.maxPlaces) {
      if (opt.onLimit) { opt.onLimit(app); return null; }
      app.removePlace(app.places[0]);
    }
    const nm = placeName(lat, lon);
    const relief = createRelief(lat, lon, { style: opt.reliefStyle || opt.style, sizeKm: opt.reliefKm || 40, n: opt.reliefN || 256, walls: opt.walls ?? true, wallColor: opt.wallColor ?? 0x2a2a2c, name: name || nm.near || nm.coords, study: !!opt.study, studyInk: opt.studyInk });
    const p = { id: Math.random().toString(36).slice(2, 8), lat, lon, name: name || nm.nearSite?.name || nm.near || 'Picked point', coords: nm.coords, near: nm.near, relief, view: null, stats: null, index: 0, data: dataAt(lat, lon), loading: false, dataVersion: 0 };
    app.places.push(p); app.places.forEach((q, i) => q.index = i);
    app._updatePlace(p); app.onChange(app); stage.request();
    // the place's NASA block patch: rebuild the block and its numbers when it arrives
    const wait = loadBlock(lat, lon);
    if (wait) {
      p.loading = true;
      wait.then(() => { if (!app.places.includes(p)) return; relief.refresh(); p.stats = null; p.dataVersion++; }, e => console.warn('NASA map did not load:', e.message))
        .finally(() => { p.loading = false; if (!app.places.includes(p)) return; app._updatePlace(p); app.onChange(app); stage.request(); });
    }
    return p;
  };
  // Sky objects and the skyline ring belong to one mounted view. Free their GPU buffers when the view goes,
  // or every removed card leaves its stars, Sun disc and Earth in the renderer. The Earth texture is shared: keep it.
  const freeOwn = p => { for (const o of p.own || []) { o.geometry.dispose(); o.material.dispose(); } p.own = null; };
  app.removePlace = p => {
    if (p.view) stage.remove(p.view); freeOwn(p); p.relief.dispose();
    app.places = app.places.filter(q => q !== p); app.places.forEach((q, i) => q.index = i);
    releaseBlocks();
    app.onChange(app); stage.request();
  };

  /**
   Mount a relief view for a place into an element.
   view: 'orbit' (default, look at the block) or 'ground' (stand at the centre, 2 m eye height)
  */
  app.mountRelief = (p, el, { view = 'orbit', clear = opt.clear, sky = true, fov = 38, height = null, aim = 'sun' } = {}) => {
    if (p.view) stage.remove(p.view); freeOwn(p);
    p.viewMode = view; p.own = [];
    app._updatePlace(p); // sun and earth vectors are needed to aim the camera
    const sc = new THREE.Scene(); sc.add(p.relief.group);
    const size = p.relief.tile.sizeKm, mid = (p.relief.tile.max - p.relief.tile.min) * 0.5;
    const cam = new THREE.PerspectiveCamera(fov, 1, view === 'ground' ? 0.001 : 0.5, 20000);
    const ctl = new OrbitControls(cam, el); Object.assign(ctl, { enableDamping: true, dampingFactor: 0.08, enablePan: false });
    if (view === 'ground') {
      const h0 = p.relief.tile.km[(p.relief.tile.n >> 1) * p.relief.tile.n + (p.relief.tile.n >> 1)] - p.relief.tile.min + (opt.eyeKm ?? 0.05);
      // terrain beyond the block, drawn as a ring at 70 km from the LOLA skyline
      const ring = createSkylineRing(p.relief.far, 70, h0, opt.ringColor ?? 0x2e2e2e); sc.add(ring); p.own.push(ring);
      const s = aim === 'earth' ? p.relief.earthLocal : p.relief.sunLocal; const az = Math.atan2(s.x, -s.z);
      ctl.target.set(Math.sin(az) * 0.01, h0, -Math.cos(az) * 0.01); cam.position.set(0, h0, 0);
      cam.position.set(-Math.sin(az) * 0.0001, h0, Math.cos(az) * 0.0001);
      Object.assign(ctl, { enableZoom: false, rotateSpeed: -0.35, minPolarAngle: Math.PI * 0.3, maxPolarAngle: Math.PI * 0.62 });
    } else {
      // Light from the side: at the pole the Sun is a degree or two up, so a camera facing it sees only
      // the shadowed side of every slope. Looking across the light shows lit slopes and long shadows.
      const s = p.relief.sunLocal;
      const az = Math.atan2(s.x, -s.z) + Math.PI * 0.5;
      const box = el.getBoundingClientRect(), aspect = box.width / Math.max(1, box.height), k = aspect < 1.2 ? Math.pow(1.2 / aspect, 0.85) : 1;
      const size0 = size; {
        const size = size0 * k;
        cam.position.set(Math.sin(az) * size * 1.05, height ?? (mid + size * 0.55), -Math.cos(az) * size * 1.05);
        ctl.target.set(0, mid * 0.6, 0);
        Object.assign(ctl, { minDistance: size0 * 0.25, maxDistance: size0 * 3, maxPolarAngle: Math.PI * 0.47 });
      }
    }
    if (sky) {
      const sunM = new THREE.Mesh(new THREE.CircleGeometry(4000 * Math.tan(0.27 * Math.PI / 180), 40), new THREE.MeshBasicMaterial({ color: opt.sunColor ?? 0xffffff, toneMapped: false }));
      const em = createEarth({ radius: 4000 * Math.tan(0.95 * Math.PI / 180), style: opt.earthStyle || (opt.style === 'photo' || opt.style === 'silver' ? 'photo' : opt.style) });
      em.mesh.material.uniforms.uMap.value = app.earth.mesh.material.uniforms.uMap.value;
      sc.add(sunM, em.mesh); p.own.push(sunM, em.mesh);
      if (opt.stars) { const st = createStars(900, 6000, 3); sc.add(st); p.own.push(st); }
      p.skyObjs = { sun: sunM, earth: em.mesh, earthMesh: em };
    }
    p.camera = cam; p.controls = ctl; p.scene = sc;
    p.view = stage.add(el, sc, cam, { controls: ctl, clear, before: v => p.onReliefFrame?.(p, v) });
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
  onTap(opt.globeEl, e => { const ll = pickGlobe(e, opt.globeEl, camera); if (ll) { const p = app.addPlace(ll.lat, ll.lon); if (p) opt.onPick?.(p, app); } });

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

export const IMPORTS = `<script type="importmap">{"imports":{"three":"./vendor/three-0.169.0/three.module.min.js","three/addons/":"./vendor/three-0.169.0/"}}</script>`;
