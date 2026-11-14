/*
  rover-model.js: the rover's low-poly model, built in code (no model file to download).

  A polar prospecting rover, 1.84 m wheel track and 2.0 m wheelbase (the numbers rover-physics.js drives).
  Solar panels stand upright on both sides and the back, because near the pole the Sun stays a few degrees
  above the horizon. A camera mast with a lamp bar stands at the front, and a dish turns toward Earth.

  4 draw calls: the body is one mesh, the 4 wheels are one instanced mesh, the 4 wheel forks another, and the
  dish turns on its own. All parts share one material: colour, metalness, roughness and glow are stored per
  vertex, so a gold foil blanket, a glass lens and a painted panel need no separate materials.

  Units: metres. Origin: the centre of mass. Axes: x right, y up, -z forward.
*/
import { WHEELS, R_WHEEL } from './rover-physics.js?v=4';

// colour (sRGB), metalness, roughness, glow (1 = lamp)
const LOOK = {
  paint: [0xe2e3e5, 0, 0.5, 0], grey: [0xa4a8af, 0.25, 0.45, 0], dark: [0x2b2e34, 0.4, 0.5, 0], black: [0x121316, 0.3, 0.35, 0],
  alu: [0xb6bbc2, 0.9, 0.3, 0], foil: [0xd6a23c, 1, 0.3, 0], cell: [0x1b2f5e, 0.6, 0.18, 0], lens: [0x060708, 0.7, 0.08, 0],
  lamp: [0xfff1d6, 0, 1, 1], tread: [0x8e9399, 0.85, 0.4, 0],
};

/** extendShader(shader): optional extra changes to the material's shaders (rover.js adds the Sun's shadow) */
export function buildRover(THREE, extendShader = () => {}) {
  const lists = { body: [], wheel: [], fork: [], dish: [] };
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), c = new THREE.Color();
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  // one part: geometry placed at (x, y, z) turned by (rx, ry, rz); vary: random brightness per triangle
  function put(list, geo, look, x, y, z, rx = 0, ry = 0, rz = 0, vary = 0) {
    const g = geo.index ? geo.toNonIndexed() : geo; if (g !== geo) geo.dispose();
    g.applyMatrix4(m4.compose(p.set(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), one));
    const n = g.attributes.position.count, col = new Float32Array(n * 3), mat = new Float32Array(n * 3), [hex, metal, rough, glow] = LOOK[look];
    for (let t = 0; t < n; t += 3) {
      c.set(hex); if (vary) c.multiplyScalar(1 + (rnd() - 0.5) * vary);
      for (let v = t; v < t + 3; v++) { col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b; mat[v * 3] = metal; mat[v * 3 + 1] = rough; mat[v * 3 + 2] = glow; }
    }
    list.push({ pos: g.attributes.position.array, col, mat }); g.dispose();
  }
  const box = (list, look, w, h, d, x, y, z, rx, ry, rz, vary) => put(list, new THREE.BoxGeometry(w, h, d), look, x, y, z, rx, ry, rz, vary);
  // cylinder along y unless turned
  const cyl = (list, look, r, h, seg, x, y, z, rx, ry, rz) => put(list, new THREE.CylinderGeometry(r, r, h, seg), look, x, y, z, rx, ry, rz);
  // a box whose surface is crumpled, like the foil blankets that keep a rover's electronics warm
  function crumpled(list, look, w, h, d, x, y, z, amp) {
    const g = new THREE.BoxGeometry(w, h, d, 7, 3, 7), a = g.attributes.position;
    for (let i = 0; i < a.count; i++) {
      const X = a.getX(i), Y = a.getY(i), Z = a.getZ(i), s = Math.sin(X * 91.7 + Y * 47.3 + Z * 63.1) * 43758.5453;
      const k = (s - Math.floor(s) - 0.5) * 2 * amp; a.setXYZ(i, X + k * 0.6, Y + k, Z - k * 0.8);
    }
    put(list, g, look, x, y, z);
  }

  // ---- body (fixed to the chassis) ----
  const B = lists.body;
  { // chassis: a box with its long edges cut at 45 degrees
    const w = 0.7, h = 0.18, k = 0.06, s = new THREE.Shape();
    s.moveTo(-w + k, -h); s.lineTo(w - k, -h); s.lineTo(w, -h + k); s.lineTo(w, h - k); s.lineTo(w - k, h); s.lineTo(-w + k, h); s.lineTo(-w, h - k); s.lineTo(-w, -h + k); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 2.0, bevelEnabled: false, curveSegments: 1 }); g.translate(0, 0, -1.0);
    put(B, g, 'paint', 0, 0.25, 0);
  }
  box(B, 'dark', 1.2, 0.04, 1.8, 0, 0.06, 0);                    // belly plate
  box(B, 'grey', 1.28, 0.2, 0.03, 0, 0.24, -1.012);              // front face
  for (const sx of [-1, 1]) {
    box(B, 'black', 0.09, 0.07, 0.06, sx * 0.2, 0.3, -1.04);      // hazard cameras
    cyl(B, 'lens', 0.022, 0.02, 10, sx * 0.2, 0.3, -1.075, Math.PI / 2);
    for (const lx of [0.38, 0.52]) box(B, 'lamp', 0.08, 0.045, 0.015, sx * lx, 0.18, -1.03); // headlamps
  }
  box(B, 'grey', 1.34, 0.025, 1.86, 0, 0.44, 0);                 // deck
  crumpled(B, 'foil', 0.84, 0.22, 0.9, 0.05, 0.565, 0.25, 0.012); // electronics under a foil blanket
  box(B, 'paint', 0.52, 0.26, 0.4, 0.12, 0.58, -0.55);           // battery box
  for (let i = 0; i < 5; i++) box(B, 'alu', 0.48, 0.03, 0.012, 0.12, 0.725, -0.7 + i * 0.075); // radiator fins
  // solar panels: an aluminium frame and a grid of cells on its outer face
  function panel(cx, cz, ry, len, cols) {
    const fx = Math.sin(ry), fz = Math.cos(ry);                   // outward normal
    box(B, 'alu', len, 0.62, 0.025, cx, 0.76, cz, 0, ry);
    const cw = (len - 0.08) / cols, ch = 0.56 / 4;
    for (let r = 0; r < 4; r++) for (let k = 0; k < cols; k++) {
      const along = -len / 2 + 0.04 + (k + 0.5) * cw, y = 0.48 + (r + 0.5) * ch;
      put(B, new THREE.PlaneGeometry(cw - 0.014, ch - 0.014), 'cell', cx + fz * along + fx * 0.0135, y, cz - fx * along + fz * 0.0135, 0, ry, 0, 0.12);
    }
  }
  panel(-0.745, 0.1, -Math.PI / 2, 1.74, 10); panel(0.745, 0.1, Math.PI / 2, 1.74, 10); panel(0, 1.035, 0, 1.47, 8);
  // camera mast: pole, pan unit, a head with two cameras and a lamp bar
  const MX = -0.32, MZ = -0.78;
  box(B, 'dark', 0.14, 0.1, 0.14, MX, 0.5, MZ);
  cyl(B, 'alu', 0.035, 1.15, 10, MX, 1.02, MZ);
  cyl(B, 'dark', 0.06, 0.08, 10, MX, 1.62, MZ);
  box(B, 'dark', 0.46, 0.07, 0.09, MX, 1.7, MZ);
  for (const sx of [-1, 1]) { box(B, 'paint', 0.11, 0.1, 0.17, MX + sx * 0.16, 1.7, MZ - 0.02); cyl(B, 'lens', 0.03, 0.03, 12, MX + sx * 0.16, 1.7, MZ - 0.115, Math.PI / 2); }
  box(B, 'lamp', 0.22, 0.035, 0.02, MX, 1.635, MZ - 0.055);
  cyl(B, 'alu', 0.025, 0.76, 8, 0.45, 0.82, 0.62);               // dish stem
  cyl(B, 'alu', 0.006, 0.45, 4, -0.58, 0.68, 0.86);              // radio whip
  // wheel mounts: an arm out of the chassis and a collar the fork's shaft slides through
  for (const [x, , z] of WHEELS) { box(B, 'dark', 0.24, 0.05, 0.09, Math.sign(x) * 0.81, 0.41, z); cyl(B, 'dark', 0.05, 0.12, 10, x, 0.41, z); }

  // ---- wheel: axle along x, centre at the origin. Metal, with grousers: rubber cracks in the lunar cold ----
  const Wh = lists.wheel, rT = R_WHEEL - 0.025;
  put(Wh, new THREE.CylinderGeometry(rT, rT, 0.22, 20, 1, true), 'tread', 0, 0, 0, 0, 0, Math.PI / 2);
  for (const sx of [-1, 1]) {
    cyl(Wh, 'grey', rT - 0.005, 0.01, 20, sx * 0.11, 0, 0, 0, 0, Math.PI / 2);
    for (let i = 0; i < 5; i++) { const a = i * Math.PI * 2 / 5; box(Wh, 'dark', 0.014, 0.17, 0.03, sx * 0.117, Math.cos(a) * 0.12, Math.sin(a) * 0.12, a); }
  }
  cyl(Wh, 'dark', 0.08, 0.26, 10, 0, 0, 0, 0, 0, Math.PI / 2);
  for (let i = 0; i < 18; i++) { const a = i * Math.PI * 2 / 18; box(Wh, 'alu', 0.23, 0.032, 0.022, 0, Math.cos(a) * (rT + 0.014), Math.sin(a) * (rT + 0.014), a); }

  // ---- fork: in the steering frame, centred on the wheel hub; built for a right wheel, mirrored for the left ----
  const Fk = lists.fork;
  box(Fk, 'dark', 0.03, 0.42, 0.1, -0.145, 0.19, 0);            // inner plate
  box(Fk, 'dark', 0.16, 0.04, 0.1, -0.07, 0.4, 0);              // bracket over the tyre
  cyl(Fk, 'grey', 0.055, 0.09, 12, 0, 0.44, 0);                 // steering motor
  cyl(Fk, 'alu', 0.028, 0.32, 8, 0, 0.64, 0);                   // spring shaft
  cyl(Fk, 'dark', 0.035, 0.06, 8, -0.12, 0, 0, 0, 0, Math.PI / 2); // axle stub

  // ---- dish: opens toward +z, so lookAt() points it ----
  const Dh = lists.dish, f = 0.12, prof = [];
  for (let i = 0; i <= 5; i++) { const r = 0.26 * i / 5; prof.push(new THREE.Vector2(r, r * r / (4 * f))); }
  put(Dh, new THREE.LatheGeometry(prof, 14), 'paint', 0, 0, 0, Math.PI / 2);
  // three struts from the rim to the receiver at the focus
  for (let i = 0; i < 3; i++) {
    const a = i * Math.PI * 2 / 3, A = new THREE.Vector3(Math.cos(a) * 0.24, Math.sin(a) * 0.24, 0.24 * 0.24 / (4 * f)), Bf = new THREE.Vector3(0, 0, f), d = Bf.clone().sub(A);
    e.setFromQuaternion(q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
    put(Dh, new THREE.CylinderGeometry(0.006, 0.006, d.length(), 4), 'dark', (A.x + Bf.x) / 2, (A.y + Bf.y) / 2, (A.z + Bf.z) / 2, e.x, e.y, e.z);
  }
  box(Dh, 'dark', 0.05, 0.05, 0.06, 0, 0, f);
  box(Dh, 'dark', 0.12, 0.12, 0.08, 0, 0, -0.03);

  // ---- one material for every part ----
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
  const uLamp = { value: 0.25 };
  material.onBeforeCompile = shader => {
    shader.uniforms.uLamp = uLamp;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aMat; varying vec3 vMat;')
      .replace('#include <color_vertex>', '#include <color_vertex>\nvMat = aMat;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vMat; uniform float uLamp;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vMat.x;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vMat.y;')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += vColor.rgb * vMat.z * uLamp;');
    extendShader(shader);
  };
  function merge(list) {
    let n = 0; for (const it of list) n += it.pos.length;
    const pos = new Float32Array(n), col = new Float32Array(n), mat = new Float32Array(n); let o = 0;
    for (const it of list) { pos.set(it.pos, o); col.set(it.col, o); mat.set(it.mat, o); o += it.pos.length; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('aMat', new THREE.BufferAttribute(mat, 3));
    g.computeVertexNormals(); g.computeBoundingSphere(); return g;
  }

  const group = new THREE.Group();
  const body = new THREE.Mesh(merge(lists.body), material); group.add(body);
  const dish = new THREE.Mesh(merge(lists.dish), material); dish.position.set(0.45, 1.22, 0.62); group.add(dish);
  // wheels and forks are drawn in world space from these frames: pivot (suspension and steering), spin (rolling)
  const wheelMesh = new THREE.InstancedMesh(merge(lists.wheel), material, 4), forkMesh = new THREE.InstancedMesh(merge(lists.fork), material, 4);
  const wheels = WHEELS.map(([x, y, z]) => {
    const pivot = new THREE.Object3D(), spin = new THREE.Object3D(), fork = new THREE.Object3D();
    pivot.position.set(x, y, z); fork.scale.x = x < 0 ? -1 : 1; pivot.add(spin, fork); group.add(pivot); return { pivot, spin, fork };
  });
  const tris = (lists.body.concat(lists.dish).reduce((s, it) => s + it.pos.length, 0) + 4 * lists.wheel.concat(lists.fork).reduce((s, it) => s + it.pos.length, 0)) / 9;
  return {
    group, dish, wheels, wheelMesh, forkMesh, material, meshes: [body, dish, wheelMesh, forkMesh], triangles: Math.round(tris),
    /** lamp glow: 0 (off) to 1 (on) */
    setLamps(on) { uLamp.value = on ? 3 : 0.25; },
    /** after group.updateMatrixWorld(): copy the wheel frames into the instanced meshes */
    syncWheels() {
      wheels.forEach((w, k) => { wheelMesh.setMatrixAt(k, w.spin.matrixWorld); forkMesh.setMatrixAt(k, w.fork.matrixWorld); });
      wheelMesh.instanceMatrix.needsUpdate = true; forkMesh.instanceMatrix.needsUpdate = true;
      wheelMesh.computeBoundingSphere(); forkMesh.computeBoundingSphere();
    },
    dispose() { for (const m of [body, dish, wheelMesh, forkMesh]) m.geometry.dispose(); wheelMesh.dispose(); forkMesh.dispose(); material.dispose(); },
  };
}
