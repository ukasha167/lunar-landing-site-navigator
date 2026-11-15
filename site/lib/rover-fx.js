/*
  rover-fx.js: wheel tracks and dust for the rover view.

  Tracks. A 2048 x 2048 texture holds groove depth for the 128 x 128 m around the rover (6.25 cm per texel). It is
  tied to the ground and wraps (texel = world position mod 128 m), so nothing is copied as the rover drives:
  when the window moves 16 m, only the 16 m strip of texels it reuses is cleared. Each frame every wheel on the
  ground draws one short quad into it on the GPU. The terrain shader reads the depth: the groove is 3 cm deep,
  its walls turn toward or away from the Sun, its floor lies in its rim's shadow when the Sun is low, and the
  pressed soil is darker, which is how orbiting cameras see Apollo's rover tracks.

  Dynamic resolution. While frames run back to back, it watches the gaps between them and lowers the pixel
  count when frames come late, so a weak GPU keeps a steady frame rate instead of stuttering.

  Dust. No air on the Moon, so dust thrown by a wheel flies a clean arc and falls back as fast as a rock would:
  p = p0 + v t + g t^2 / 2 with g = 1.62 m/s^2, worked out per particle in the vertex shader from where and
  when it was thrown. The CPU only writes new particles into a ring of 2048.
  Written with Claude Code (an AI coding agent) at the team's direction. See README.md, "Use of AI".
*/
import { G } from './rover-physics.js?v=4';

export const TRK_M = 128, TRK_N = 2048;
const STEP = 16, WIDTH = 0.22, MAX_QUADS = 96;

export function createTracks(THREE) {
  const rt = new THREE.WebGLRenderTarget(TRK_N, TRK_N, { format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, generateMipmaps: false });
  // the texture as a 128 x 128 m sheet seen from above: x east, y = world z
  const cam = new THREE.OrthographicCamera(0, TRK_M, TRK_M, 0, -1, 1);
  const pos = new Float32Array(MAX_QUADS * 6 * 3), across = new Float32Array(MAX_QUADS * 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('aS', new THREE.BufferAttribute(across, 1));
  const stampMat = new THREE.ShaderMaterial({
    vertexShader: 'attribute float aS; varying float vS; void main() { vS = aS; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    // a rounded groove: deepest under the middle of the tyre
    fragmentShader: 'varying float vS; void main() { gl_FragColor = vec4(1. - pow(abs(vS), 4.), 0., 0., 1.); }',
    blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  });
  const stamps = new THREE.Mesh(geo, stampMat); stamps.frustumCulled = false;
  const clearGeo = new THREE.PlaneGeometry(1, 1), clearMat = new THREE.MeshBasicMaterial({ color: 0x000000, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  const clears = [0, 1, 2, 3].map(() => { const m = new THREE.Mesh(clearGeo, clearMat); m.frustumCulled = false; m.visible = false; return m; });
  const scene = new THREE.Scene(); scene.add(...clears, stamps);
  const win = new THREE.Vector4(-1e9, -1e9, TRK_M, TRK_M / TRK_N); // window x0, z0 (m), size (m), texel (m)
  const last = [null, null, null, null];
  let quads = 0, nClear = 0, wipeAll = true;
  const mod = v => v - Math.floor(v / TRK_M) * TRK_M;

  // clear the texels of world strip [a, b) along x (axis 0) or z (axis 1), all of the other axis
  function clearStrip(axis, a, b) {
    if (b - a >= TRK_M) { wipeAll = true; return; }
    const lo = mod(a), hi = lo + (b - a);
    for (const [s0, s1] of hi <= TRK_M ? [[lo, hi]] : [[lo, TRK_M], [0, hi - TRK_M]]) {
      if (nClear >= clears.length) { wipeAll = true; return; }
      const m = clears[nClear++]; m.visible = true;
      if (axis === 0) { m.scale.set(s1 - s0, TRK_M, 1); m.position.set((s0 + s1) / 2, TRK_M / 2, 0); }
      else { m.scale.set(TRK_M, s1 - s0, 1); m.position.set(TRK_M / 2, (s0 + s1) / 2, 0); }
    }
  }
  function quad(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz), ux = dx / l, uz = dz / l, sx = -uz * WIDTH / 2, sz = ux * WIDTH / 2;
    // stretch both ends by half a tyre width so segments overlap at the joins
    ax -= ux * WIDTH / 2; az -= uz * WIDTH / 2; bx += ux * WIDTH / 2; bz += uz * WIDTH / 2;
    const ox = Math.floor(ax / TRK_M) * TRK_M, oz = Math.floor(az / TRK_M) * TRK_M;
    const c = [ax - ox + sx, az - oz + sz, ax - ox - sx, az - oz - sz, bx - ox - sx, bz - oz - sz, bx - ox + sx, bz - oz + sz];
    let x1 = -Infinity, z1 = -Infinity; for (let i = 0; i < 8; i += 2) { x1 = Math.max(x1, c[i]); z1 = Math.max(z1, c[i + 1]); }
    // a quad over the texture's edge is drawn again one sheet over, so it wraps
    for (const sx2 of x1 > TRK_M ? [0, -TRK_M] : [0]) for (const sz2 of z1 > TRK_M ? [0, -TRK_M] : [0]) {
      if (quads >= MAX_QUADS) return;
      const v = quads * 6;
      for (const [k, i] of [[0, 0], [1, 2], [2, 4], [3, 0], [4, 4], [5, 6]]) {
        pos[(v + k) * 3] = c[i] + sx2; pos[(v + k) * 3 + 1] = c[i + 1] + sz2; pos[(v + k) * 3 + 2] = 0;
        across[v + k] = i === 0 || i === 6 ? 1 : -1;
      }
      quads++;
    }
  }
  return {
    texture: rt.texture, window: win,
    /** cx, cz: the rover. wheels: [{ contact, px, pz }] from the physics. */
    update(cx, cz, wheels) {
      const x0 = Math.floor(cx / STEP) * STEP - TRK_M / 2, z0 = Math.floor(cz / STEP) * STEP - TRK_M / 2;
      if (x0 !== win.x) { clearStrip(0, Math.min(x0, win.x), Math.max(x0, win.x)); win.x = x0; }
      if (z0 !== win.y) { clearStrip(1, Math.min(z0, win.y), Math.max(z0, win.y)); win.y = z0; }
      wheels.forEach((w, k) => {
        if (!w.contact) { last[k] = null; return; }
        const p = last[k];
        if (!p) { last[k] = [w.px, w.pz]; return; }
        const d = Math.hypot(w.px - p[0], w.pz - p[1]);
        if (d > 2) { last[k] = [w.px, w.pz]; return; } // put back upright: no track across the jump
        if (d < 0.04) return;
        quad(p[0], p[1], w.px, w.pz); last[k] = [w.px, w.pz];
      });
      return quads > 0 || nClear > 0 || wipeAll;
    },
    /** draw this frame's quads into the texture (renderer.autoClear must be off) */
    draw(r) {
      if (!quads && !nClear && !wipeAll) return;
      r.setRenderTarget(rt);
      if (wipeAll) { r.clear(true, false, false); wipeAll = false; }
      geo.setDrawRange(0, quads * 6); geo.attributes.position.needsUpdate = true; geo.attributes.aS.needsUpdate = true;
      r.render(scene, cam);
      r.setRenderTarget(null);
      quads = 0; nClear = 0; for (const m of clears) m.visible = false;
    },
    dispose() { rt.dispose(); geo.dispose(); stampMat.dispose(); clearGeo.dispose(); clearMat.dispose(); },
  };
}

const DUST = 2048;
export function createDust(THREE) {
  const p0 = new Float32Array(DUST * 3), v0 = new Float32Array(DUST * 3), t0 = new Float32Array(DUST).fill(-1e9), size = new Float32Array(DUST);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(p0, 3)); geo.setAttribute('aV', new THREE.BufferAttribute(v0, 3));
  geo.setAttribute('aT', new THREE.BufferAttribute(t0, 1)); geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const u = { uTime: { value: 0 }, uLight: { value: 1 }, uPx: { value: 800 } };
  const mat = new THREE.ShaderMaterial({
    uniforms: u, transparent: true, depthWrite: false,
    vertexShader: /* glsl */`
      attribute vec3 aV; attribute float aT; attribute float aSize; uniform float uTime, uPx; varying float vA;
      void main() {
        float t = uTime - aT, up = 2. * aV.y / ${G.toFixed(2)} + 0.05; // time to fall back to the height it left from
        if (t < 0. || t > up) { gl_Position = vec4(2., 2., 2., 1.); gl_PointSize = 0.; return; }
        vec3 p = position + aV * t + vec3(0., -0.5 * ${G.toFixed(2)} * t * t, 0.);
        vec4 mv = modelViewMatrix * vec4(p, 1.);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = max(1.5, aSize * uPx / -mv.z);
        vA = 1. - smoothstep(0.75, 1., t / up);
      }`,
    fragmentShader: /* glsl */`
      uniform float uLight; varying float vA;
      void main() { vec2 c = gl_PointCoord - .5; float r = dot(c, c); if (r > .25) discard;
        gl_FragColor = vec4(vec3(.72, .71, .69) * uLight, vA * (1. - r * 3.) * .8); }`,
  });
  const points = new THREE.Points(geo, mat); points.frustumCulled = false;
  let head = 0, bank = 0, liveUntil = 0, seed = 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return {
    points, uniforms: u,
    /** time (s), dt (s); wheels from the physics; fwd, up, side: the rover's axes; vel: its velocity; speed: m/s along fwd */
    update(time, dt, wheels, fwd, side, vel, speed) {
      u.uTime.value = time;
      const sp = Math.abs(speed); if (sp < 0.3) return time < liveUntil;
      bank += sp * dt * 45; // particles per wheel this frame
      const n = Math.floor(bank); bank -= n; if (!n) return true;
      const back = Math.sign(speed) || 1;
      for (const w of wheels) {
        if (!w.contact) continue;
        for (let i = 0; i < n; i++) {
          const k = head; head = (head + 1) % DUST;
          // thrown up and back off the tread, faster the faster the rover goes; a little to either side
          const b = (0.25 + 0.6 * rnd()) * sp, h = (0.15 + 0.45 * rnd()) * sp, s = (rnd() - 0.5) * 0.5 * sp;
          p0[k * 3] = w.px - fwd.x * 0.15 * back; p0[k * 3 + 1] = w.py + 0.04; p0[k * 3 + 2] = w.pz - fwd.z * 0.15 * back;
          v0[k * 3] = vel.x * 0.3 - fwd.x * b * back + side.x * s; v0[k * 3 + 1] = h; v0[k * 3 + 2] = vel.z * 0.3 - fwd.z * b * back + side.z * s;
          t0[k] = time - rnd() * dt; size[k] = 0.02 + 0.04 * rnd();
          liveUntil = Math.max(liveUntil, time + 2 * h / G + 0.1);
        }
      }
      for (const a of ['position', 'aV', 'aT', 'aSize']) geo.attributes[a].needsUpdate = true;
      return true;
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

/**
  Pixels per CSS pixel for a view drawn every frame, between top and low. frame(now ms, gap s) returns a new value
  when it should change, else null.
  A frame that misses the screen's refresh comes 2 refreshes late, so the mean gap rises above the shortest gap
  seen (the refresh). Mean over 1 s more than 20% above it: 15% fewer pixels per side. 3 s on time: try 12%
  more. A step up followed by a step down within 4 s doubles the wait before the next try (at most 60 s).
*/
export function createDynamicResolution(top, low) {
  const d = { dpr: top, n: 0, t: 0, refresh: 1, refreshAt: 0, changedAt: 0, wait: 3000, lastUp: -1e9 };
  d.frame = (now, gap) => {
    if (gap > 0.1) { d.n = 0; d.t = 0; return null; } // a pause, not a slow frame
    if (now - d.refreshAt > 5000) { d.refresh = 1; d.refreshAt = now; }
    d.refresh = Math.min(d.refresh, Math.max(gap, 1 / 250)); d.n++; d.t += gap;
    if (d.t < 1) return null;
    const mean = d.t / d.n; d.n = 0; d.t = 0;
    let next = d.dpr;
    if (mean > d.refresh * 1.2 && d.dpr > low) {
      if (now - d.lastUp < 4000) d.wait = Math.min(d.wait * 2, 60000);
      next = Math.max(low, d.dpr * 0.85);
    } else if (mean < d.refresh * 1.08 && d.dpr < top && now - d.changedAt > d.wait) {
      next = Math.min(top, d.dpr * 1.12); d.lastUp = now;
    }
    if (next === d.dpr) return null;
    d.dpr = next; d.changedAt = now; return Math.round(next * 20) / 20;
  };
  return d;
}
