/*
  rover-physics.js: a 450 kg rover on 4 sprung wheels over a height function, as plain numbers with no
  Three.js objects, so it runs in the page and in Node (verify/rover.mjs tests it).

  One rigid body, steps of 1/120 s (semi-implicit Euler). Each wheel casts a ray along the body's down axis
  (a raycast vehicle); the ground under a wheel is the highest point its rim can rest on, so a wheel rolls up
  onto a rock edge instead of hitting it as a wall.
  Lunar gravity 1.62 m/s². Regolith grip 0.6 and rolling resistance 0.06. 4 motors of 200 W with at most
  120 N each: it climbs 24° but not 28° (uphill, weight moves off the front wheels), close to the 25° Apollo's
  rover was rated for, and reaches 13 km/h on flat ground. With no throttle the motors brake it to a stop
  and hold it there, within the grip the slope leaves. Traction control: sideways grip comes first, driving and braking use what
  is left. verify/rover.mjs checks each of these numbers.

  Height function: H(x, z) in metres, x east, z south, y up. Body axes: x right, y up, -z forward.
  Written with Claude Code (an AI coding agent) at the team's direction. See README.md, "Use of AI".
*/
export const MASS = 450, G = 1.62, DT = 1 / 120;
export const COM = 0.25;                 // the body's origin is its centre of mass, 0.25 m below the chassis centre (batteries sit low)
export const R_WHEEL = 0.3, REST = 0.42; // wheel radius, spring length at rest (m)
const TRAVEL = 0.3, K_SPRING = 2600, C_DAMP = 600, K_ROLL = 3000, F_SPRING_MAX = 2500, BUMP_MAX = 6000;
// A tyre's grip stops growing with load long before a bump-stop spike: grip uses at most 600 N of load
// (3.3 times a wheel's share of the rover's weight), so hitting a rock edge cannot throw the rover sideways
const GRIP_LOAD_MAX = 600;
const MU = 0.6, CRR = 0.06, F_PEAK = 120, P_WHEEL = 200, BRAKE = 300;
export const V_MAX = 3.6, V_FAST = 14;  // m/s; fast travel is not a real rover speed and the page says so
/** wheel mounts from the centre of mass: x, y, z (m), and whether the wheel steers */
// 1.84 m track and 2.0 m wheelbase, about the Apollo rover's: in 1/6 g a narrow rover tips before it slides
export const WHEELS = [[-0.92, 0.17, -1.0, 1], [0.92, 0.17, -1.0, 1], [-0.92, 0.17, 1.0, 0], [0.92, 0.17, 1.0, 0]];
const CORNERS = [];
for (const x of [-0.8, 0.8]) for (const y of [0.05, 1.07]) for (const z of [-1.1, 1.1]) CORNERS.push([x, y, z]);
// box inertia of the chassis with its panels, 1.5 x 0.9 x 2.1 m
const IX = MASS / 12 * (0.9 ** 2 + 2.1 ** 2), IY = MASS / 12 * (1.5 ** 2 + 2.1 ** 2), IZ = MASS / 12 * (1.5 ** 2 + 0.9 ** 2);
const RIM_A = 0.2, RIM_DROP = R_WHEEL - Math.sqrt(R_WHEEL * R_WHEEL - RIM_A * RIM_A);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/**
  H(x, z): ground height (m). edge: half-width (m) of the drivable square around (0, 0).
  input for advance(): { thr: -1..1, steer: -1..1 (positive turns left), brake, fast }
*/
export function createVehicle(H, { edge = Infinity } = {}) {
  const s = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1, wx: 0, wy: 0, wz: 0,
    steer: 0, odometer: 0, settled: false, still: 0, acc: 0, atEdge: false };
  const wheels = WHEELS.map(() => ({ comp: 0, rate: 0, len: REST, spin: 0, contact: false, px: 0, py: 0, pz: 0 }));
  const ax = new Float64Array(9); // body right, up, forward in world space
  let Fx = 0, Fy = 0, Fz = 0, Tx = 0, Ty = 0, Tz = 0;
  const out = new Float64Array(3);

  // v rotated by the body's quaternion (inv: by its inverse), into out
  function rot(x, y, z, inv) {
    const qx = inv ? -s.qx : s.qx, qy = inv ? -s.qy : s.qy, qz = inv ? -s.qz : s.qz, qw = s.qw;
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    out[0] = x + qw * tx + (qy * tz - qz * ty); out[1] = y + qw * ty + (qz * tx - qx * tz); out[2] = z + qw * tz + (qx * ty - qy * tx);
  }
  function axes() {
    rot(1, 0, 0); ax[0] = out[0]; ax[1] = out[1]; ax[2] = out[2];
    rot(0, 1, 0); ax[3] = out[0]; ax[4] = out[1]; ax[5] = out[2];
    rot(0, 0, -1); ax[6] = out[0]; ax[7] = out[1]; ax[8] = out[2];
  }
  // force (fx, fy, fz) applied at world point p: adds to the total force and the torque about the centre of mass
  function applyAt(fx, fy, fz, px, py, pz) {
    const rx = px - s.x, ry = py - s.y, rz = pz - s.z;
    Fx += fx; Fy += fy; Fz += fz; Tx += ry * fz - rz * fy; Ty += rz * fx - rx * fz; Tz += rx * fy - ry * fx;
  }
  // velocity of world point p on the body, into out
  function velAt(px, py, pz) {
    const rx = px - s.x, ry = py - s.y, rz = pz - s.z;
    out[0] = s.vx + s.wy * rz - s.wz * ry; out[1] = s.vy + s.wz * rx - s.wx * rz; out[2] = s.vz + s.wx * ry - s.wy * rx;
  }
  function wheelGround(x, z) {
    const l = Math.hypot(ax[6], ax[8]) || 1, dx = ax[6] / l * RIM_A, dz = ax[8] / l * RIM_A;
    return Math.max(H(x, z), H(x + dx, z + dz) - RIM_DROP, H(x - dx, z - dz) - RIM_DROP);
  }
  const nrm = new Float64Array(3);
  function normalAt(x, z) {
    const e = 0.2, hx = H(x + e, z) - H(x - e, z), hz = H(x, z + e) - H(x, z - e), l = Math.hypot(hx, 2 * e, hz);
    nrm[0] = -hx / l; nrm[1] = 2 * e / l; nrm[2] = -hz / l; return nrm;
  }

  function step(h, input) {
    axes();
    const [rx, ry, rz, ux, uy, uz, fx, fy, fz] = ax;
    const speed = s.vx * fx + s.vy * fy + s.vz * fz;
    // less steering lock at speed: in 1/6 g a tight turn tips the rover long before the tyres slide
    const maxSteer = 0.5 / (1 + Math.abs(speed) * 0.6 + speed * speed * 0.04);
    s.steer += clamp(clamp(input.steer, -1, 1) * maxSteer - s.steer, -2.5 * h, 2.5 * h);
    let thr = clamp(input.thr, -1, 1), braking = !!input.brake;
    if (thr < 0 && speed > 0.3) { braking = true; thr = 0; } else if (thr < 0) thr *= 0.6; // S brakes first, then reverses slowly
    const vmax = input.fast ? V_FAST : V_MAX, power = P_WHEEL * (input.fast ? 4 : 1), mW = MASS / 4;
    Fx = 0; Fy = -MASS * G; Fz = 0; Tx = 0; Ty = 0; Tz = 0;

    // pass 1: where each wheel touches the ground and how far its spring is pressed
    for (let k = 0; k < 4; k++) {
      const [wx, wy, wz] = WHEELS[k], w = wheels[k];
      w.contact = false;
      const mx = s.x + rx * wx + ux * wy - fx * wz, my = s.y + ry * wx + uy * wy - fy * wz, mz = s.z + rz * wx + uz * wy - fz * wz;
      if (uy < 0.25) { w.comp = 0; w.rate = 0; w.len = REST; continue; } // on its side: no wheel reaches down
      let t = (my - wheelGround(mx, mz)) / uy; t = (my - wheelGround(mx - ux * t, mz - uz * t)) / uy;
      const len = t - R_WHEEL;
      if (len > REST) { w.comp = 0; w.rate = 0; w.len = REST; continue; }
      const comp = REST - len;
      // a rock edge can jump the compression in one step; a limited rate keeps the damper from kicking
      w.rate = clamp((comp - w.comp) / h, -3, 3); w.comp = comp; w.len = len; w.contact = true;
      w.px = mx - ux * t; w.py = my - uy * t; w.pz = mz - uz * t;
    }
    // pass 2: spring, anti-roll bar, tyre
    for (let k = 0; k < 4; k++) {
      const w = wheels[k]; if (!w.contact) continue;
      const o = wheels[k ^ 1]; // wheels 0-1 share the front axle, 2-3 the rear
      const n = normalAt(w.px, w.pz), nx = n[0], ny = n[1], nz = n[2];
      const roll = o.contact ? K_ROLL * (w.comp - o.comp) * 0.5 : 0; // the more pressed side pushes up harder
      // the spring is capped so a rock cannot kick the body; the bump stop past full travel has its own,
      // much higher cap, so a hard landing stops the body instead of letting it sink into the ground
      const fs = Math.min(F_SPRING_MAX, Math.max(0, K_SPRING * w.comp + C_DAMP * w.rate + roll))
        // a rubber bump stop: stiff while pressed, soft on the way back, so a hard landing does not bounce
        + (w.comp > TRAVEL ? Math.min(BUMP_MAX, 40000 * (w.comp - TRAVEL) * (w.rate > 0 ? 1 : 0.25) + 4000 * Math.max(0, w.rate)) : 0);
      applyAt(ux * fs, uy * fs, uz * fs, w.px, w.py, w.pz);
      const load = fs * Math.max(0, nx * ux + ny * uy + nz * uz);
      // tyre directions in the ground plane: forward (turned by the steering) and sideways
      const d = WHEELS[k][3] ? s.steer : 0, c = Math.cos(d), sn = Math.sin(d);
      let ex = fx * c - rx * sn, ey = fy * c - ry * sn, ez = fz * c - rz * sn;
      const en = ex * nx + ey * ny + ez * nz; ex -= nx * en; ey -= ny * en; ez -= nz * en;
      const el = Math.hypot(ex, ey, ez) || 1; ex /= el; ey /= el; ez /= el;
      const sx = ny * ez - nz * ey, sy = nz * ex - nx * ez, sz = nx * ey - ny * ex;
      velAt(w.px, w.py, w.pz);
      const vl = out[0] * ex + out[1] * ey + out[2] * ez, vs = out[0] * sx + out[1] * sy + out[2] * sz;
      // The corrections below cancel part of the slip each step. A force at the contact patch, 0.57 m below
      // the centre of mass, also rolls or pitches the body, so it moves far less mass than a quarter of the
      // rover in a straight line: full corrections would overshoot and rock the body. Hence 0.25 and 0.4.
      let fl = 0;
      if (braking) fl = -clamp(vl * mW / h * 0.4, -BRAKE, BRAKE);
      else if (thr) fl = thr * vl < vmax ? thr * Math.min(F_PEAK, power / Math.max(Math.abs(vl), 0.3))
        : -thr * Math.min(F_PEAK, (thr * vl - vmax) * mW / h * 0.1); // over the top speed downhill: the motors hold it back
      else fl = -clamp(vl * mW / h * 0.4, -BRAKE, BRAKE); // no throttle: the motors brake to a stop and hold it there, as on a slope
      fl -= CRR * load * clamp(vl / 0.05, -1, 1);
      const lim = MU * Math.min(load, GRIP_LOAD_MAX), fsd = clamp(-vs * mW / h * 0.25, -lim, lim);
      const room = Math.sqrt(Math.max(0, lim * lim - fsd * fsd)); fl = clamp(fl, -room, room);
      applyAt(ex * fl + sx * fsd, ey * fl + sy * fsd, ez * fl + sz * fsd, w.px, w.py, w.pz);
      w.spin += vl / R_WHEEL * h;
    }
    // chassis and panels touching the ground: a stiff spring at each corner
    for (const [cx, cy, cz] of CORNERS) {
      const px = s.x + rx * cx + ux * cy - fx * cz, py = s.y + ry * cx + uy * cy - fy * cz, pz = s.z + rz * cx + uz * cy - fz * cz;
      const pen = H(px, pz) - py; if (pen <= 0) continue;
      velAt(px, py, pz);
      applyAt(-out[0] * 900, Math.min(BUMP_MAX, 60000 * pen - 3500 * Math.min(0, out[1])), -out[2] * 900, px, py, pz);
    }
    // never let the centre of mass end up under the ground (a landing faster than the springs can stop)
    const g0 = H(s.x, s.z) + 0.15; if (s.y < g0) { s.y = g0; if (s.vy < 0) s.vy = 0; }
    // keep inside the drivable square
    s.atEdge = false;
    if (Math.abs(s.x) > edge) { Fx -= Math.sign(s.x) * 4000 * (Math.abs(s.x) - edge + 1); s.vx *= 0.98; s.atEdge = true; }
    if (Math.abs(s.z) > edge) { Fz -= Math.sign(s.z) * 4000 * (Math.abs(s.z) - edge + 1); s.vz *= 0.98; s.atEdge = true; }

    // integrate: velocities first, then position and orientation
    s.vx += Fx / MASS * h; s.vy += Fy / MASS * h; s.vz += Fz / MASS * h;
    rot(s.wx, s.wy, s.wz, true); let bx = out[0], by = out[1], bz = out[2]; // angular velocity in body axes
    rot(Tx, Ty, Tz, true); let tx = out[0], ty = out[1], tz = out[2];
    const lx = IX * bx, ly = IY * by, lz = IZ * bz;                   // angular momentum in body axes
    tx -= by * lz - bz * ly; ty -= bz * lx - bx * lz; tz -= bx * ly - by * lx; // Euler's equations
    const damp = 1 - 0.4 * h;
    bx = (bx + tx / IX * h) * damp; by = (by + ty / IY * h) * damp; bz = (bz + tz / IZ * h) * damp;
    rot(bx, by, bz, false); s.wx = out[0]; s.wy = out[1]; s.wz = out[2];
    s.x += s.vx * h; s.y += s.vy * h; s.z += s.vz * h;
    const { qx, qy, qz, qw } = s, wx = s.wx, wy = s.wy, wz = s.wz, k2 = 0.5 * h;
    let nx = qx + k2 * (wx * qw + wy * qz - wz * qy), ny = qy + k2 * (-wx * qz + wy * qw + wz * qx);
    let nz = qz + k2 * (wx * qy - wy * qx + wz * qw), nw = qw - k2 * (wx * qx + wy * qy + wz * qz);
    const ql = Math.hypot(nx, ny, nz, nw); s.qx = nx / ql; s.qy = ny / ql; s.qz = nz / ql; s.qw = nw / ql;
    s.odometer += Math.hypot(s.vx, s.vz) * h;
    // asleep when nothing moves and no key is held: the page then stops drawing
    const busy = thr || input.steer || braking || s.vx * s.vx + s.vy * s.vy + s.vz * s.vz > 4e-4 || s.wx * s.wx + s.wy * s.wy + s.wz * s.wz > 4e-4;
    s.still = busy ? 0 : s.still + h; if (s.still > 1) s.settled = true;
  }

  return {
    state: s, wheels, axes: () => { axes(); return ax; },
    /** change the drivable square's half-width (m), for a ground that loads after the vehicle is made */
    setEdge(e) { edge = e; },
    /** place the rover at (x, z) facing yaw (rad, 0 = north), tilted to the ground under it, wheels just touching */
    spawn(x, z, yaw) {
      // ground normal over the rover's footprint (2 m), then turn the body's up axis onto it
      const e = 1, hx = H(x + e, z) - H(x - e, z), hz = H(x, z + e) - H(x, z - e), l = Math.hypot(hx, 2 * e, hz);
      const nx = -hx / l, ny = 2 * e / l, nz = -hz / l, a = Math.acos(Math.min(1, ny)), al = Math.hypot(nz, nx) || 1, sa = Math.sin(a / 2) / al;
      const tx = nz * sa, tz = -nx * sa, tw = Math.cos(a / 2), yy = Math.sin(yaw / 2), yw = Math.cos(yaw / 2);
      // tilt x yaw (Hamilton product; the tilt has no y part and the yaw only y and w)
      s.qx = tx * yw - tz * yy; s.qy = tw * yy; s.qz = tx * yy + tz * yw; s.qw = tw * yw;
      s.x = x; s.z = z; s.y = H(x, z) + (R_WHEEL + REST - WHEELS[0][1] - 0.03) / ny;
      s.vx = s.vy = s.vz = s.wx = s.wy = s.wz = 0; s.steer = 0; s.acc = 0; s.settled = false; s.still = 0;
      for (const w of wheels) { w.comp = 0; w.rate = 0; }
    },
    yaw() { rot(0, 0, -1); return Math.atan2(-out[0], -out[2]); },
    /** forward speed (m/s), negative when reversing */
    speed() { axes(); return s.vx * ax[6] + s.vy * ax[7] + s.vz * ax[8]; },
    /** run fixed steps for dt seconds of real time (at most 8 per call, so a slow frame cannot snowball) */
    advance(dt, input) {
      if (s.settled) return 0;
      s.acc += Math.min(dt, 0.05); let n = 0;
      while (s.acc >= DT && n < 8) { step(DT, input); s.acc -= DT; n++; }
      if (n === 8) s.acc = 0;
      return n;
    },
    wake() { if (s.settled) { s.settled = false; s.still = 0; s.acc = 0; } },
  };
}
