// A standing figure for the rigging checks: one closed surface around a smooth union of capsules, meshed by marching
// tetrahedra, in a T or an A pose, with separate fingers or mitten hands, and the joint positions it was built on.
// Metres, Y up, facing +Z, its left at +X, feet on y = 0, 1.77 m tall. Stylised: big hands with fingers well apart, so
// a 6 mm grid keeps them separate.
import * as THREE from 'three';

const FINGER = { Index: [0.034, 0.95], Middle: [0.0, 1], Ring: [-0.034, 0.93], Pinky: [-0.068, 0.78] };

export function figureJoints({ pose = 'T', fingers = true } = {}) {
  const J = {
    Hips: [0, 0.95, 0], Spine: [0, 1.05, 0], Spine1: [0, 1.17, 0], Spine2: [0, 1.3, 0],
    Neck: [0, 1.47, 0], Head: [0, 1.56, 0], HeadTop_End: [0, 1.77, 0],
  };
  const a = pose === 'A' ? (40 * Math.PI) / 180 : 0;
  const d = [Math.cos(a), -Math.sin(a), 0], w = [0, 0, 1];
  const at = (p, ...terms) => terms.reduce((q, [v, s]) => [q[0] + v[0] * s, q[1] + v[1] * s, q[2] + v[2] * s], p);
  const side = {};
  side.Shoulder = [0.04, 1.41, 0];
  side.Arm = [0.17, 1.41, 0];
  side.ForeArm = at(side.Arm, [d, 0.27]);
  side.Hand = at(side.ForeArm, [d, 0.25]);
  if (fingers) {
    for (const [f, [off, s]] of Object.entries(FINGER)) {
      const k = at(side.Hand, [d, 0.1], [w, off - 0.017]);
      side[`Hand${f}1`] = k;
      side[`Hand${f}2`] = at(k, [d, 0.045 * s]);
      side[`Hand${f}3`] = at(k, [d, 0.075 * s]);
      side[`Hand${f}4`] = at(k, [d, 0.1 * s]);
    }
    const t = [d[0] * 0.6 + w[0] * 0.8, d[1] * 0.6 + w[1] * 0.8, d[2] * 0.6 + w[2] * 0.8];
    const t1 = at(side.Hand, [d, 0.03], [w, 0.05]);
    side.HandThumb1 = t1;
    side.HandThumb2 = at(t1, [t, 0.045]);
    side.HandThumb3 = at(t1, [t, 0.08]);
    side.HandThumb4 = at(t1, [t, 0.11]);
  }
  side.UpLeg = [0.1, 0.92, 0];
  side.Leg = [0.1, 0.5, 0.012];
  side.Foot = [0.1, 0.09, -0.01];
  side.ToeBase = [0.1, 0.03, 0.12];
  side.Toe_End = [0.1, 0.03, 0.2];
  for (const [k, p] of Object.entries(side)) { J[`Left${k}`] = p; J[`Right${k}`] = [-p[0], p[1], p[2]]; }
  return J;
}

// The capsules: [a, b, radius, group, radius at b], group 0 the body, 1 the palm, 2 the fingers. Limbs taper, so wrists,
// ankles and the neck are narrower than what lies to either side, as on a person.
function capsules(J, fingers) {
  const C = [];
  const cap = (a, b, r, g = 0, rb = r) => C.push([a, b, r, g, rb]);
  cap([-0.09, 0.93, 0], [0.09, 0.93, 0], 0.12);
  cap(J.Hips, J.Spine1, 0.13);
  cap([-0.07, 1.3, 0], [0.07, 1.3, 0], 0.13);
  cap([-0.17, 1.4, 0], [0.17, 1.4, 0], 0.06);
  cap([0, 1.36, 0], J.Head, 0.055);
  cap([0, 1.62, 0.01], [0, 1.67, 0.01], 0.1);
  for (const S of ['Left', 'Right']) {
    const j = k => J[`${S}${k}`];
    cap(j('Arm'), j('ForeArm'), 0.052, 0, 0.044);
    cap(j('ForeArm'), j('Hand'), 0.044, 0, 0.03);
    const h = j('Hand'), d = norm(sub(j('Hand'), j('ForeArm')));
    if (fingers) {
      for (const f of Object.keys(FINGER)) {
        cap(h, j(`Hand${f}1`), 0.02, 1);
        cap(j(`Hand${f}1`), j(`Hand${f}4`), 0.012, 2);
      }
      cap(h, j('HandThumb1'), 0.022, 1);
      cap(j('HandThumb1'), j('HandThumb4'), 0.013, 2);
    } else {
      cap(h, [h[0] + d[0] * 0.17, h[1] + d[1] * 0.17, h[2] + d[2] * 0.17], 0.032, 1);
      cap([h[0] + d[0] * 0.03, h[1] + d[1] * 0.03, h[2] + 0.04], [h[0] + d[0] * 0.08, h[1] + d[1] * 0.08, h[2] + 0.09], 0.016, 1);
    }
    cap(j('UpLeg'), j('Leg'), 0.08, 0, 0.055);
    cap(j('Leg'), j('Foot'), 0.055, 0, 0.035);
    const f = j('Foot');
    cap([f[0], 0.045, -0.03], [f[0], 0.035, 0.18], 0.04);
  }
  return C;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function norm(a) { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function capsuleDist(p, [a, b, r, , rb]) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2], l2 = abx * abx + aby * aby + abz * abz;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t, p[2] - a[2] - abz * t) - (r + (rb - r) * t);
}
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };

// Marching tetrahedra (six per cube, all sharing the cube's main diagonal, so neighbours match) over the grid points
// within reach of the surface.
const TETS = [[0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7]];
// base: the figure stands on a round base 30 cm across and 4 cm thick, joined to its soles, as game pieces often do.
// gown: a floor-length dress hides the legs, flaring from the waist to the floor.
export function figure({ pose = 'T', fingers = true, step = 0.006, base = false, gown = false } = {}) {
  const J = figureJoints({ pose, fingers }), C = capsules(J, fingers);
  const sdf = p => {
    let body = Infinity, palm = Infinity, fing = Infinity;
    for (const c of C) {
      const d = capsuleDist(p, c);
      if (c[3] === 0) body = smin(body, d, 0.035);
      else if (c[3] === 1) palm = smin(palm, d, 0.012);
      else fing = Math.min(fing, d);
    }
    let d = smin(body, smin(palm, fing, 0.006), 0.015);
    if (gown) {
      // A cone from the waist (16 cm out from the middle) to the floor (21 cm), closed at both ends, inside the base.
      const t = Math.min(1, Math.max(0, (1.05 - p[1]) / 1.05)), r = 0.16 + 0.05 * t;
      d = smin(d, Math.max(Math.hypot(p[0], p[2]) - r, p[1] - 1.05, -p[1]), 0.03);
    }
    if (base) d = smin(d, Math.max(Math.hypot(p[0], p[2] - 0.04) - 0.3, Math.abs(p[1] + 0.02) - 0.03), 0.02);
    return d;
  };
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const [a, b, r, , rb] of C) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], a[k] - r, b[k] - rb); hi[k] = Math.max(hi[k], a[k] + r, b[k] + rb); }
  if (gown) { lo[0] = Math.min(lo[0], -0.3); hi[0] = Math.max(hi[0], 0.3); lo[2] = Math.min(lo[2], -0.3); hi[2] = Math.max(hi[2], 0.3); lo[1] = Math.min(lo[1], -0.02); }
  if (base) { lo[0] = Math.min(lo[0], -0.3); hi[0] = Math.max(hi[0], 0.3); lo[1] = -0.05; lo[2] = Math.min(lo[2], -0.26); hi[2] = Math.max(hi[2], 0.34); }
  const B = 8, n = [0, 1, 2].map(k => Math.ceil((hi[k] - lo[k] + 4 * step) / step / B) * B);
  const o = [0, 1, 2].map(k => lo[k] - 2 * step);
  const nx = n[0] + 1, ny = n[1] + 1, nz = n[2] + 1;
  const F = new Float32Array(nx * ny * nz).fill(NaN);
  const pid = (i, j, k) => (k * ny + j) * nx + i;
  const pt = (i, j, k) => [o[0] + i * step, o[1] + j * step, o[2] + k * step];
  const R = (Math.sqrt(3) * B * step) / 2;
  const live = [];
  for (let bk = 0; bk < n[2]; bk += B) for (let bj = 0; bj < n[1]; bj += B) for (let bi = 0; bi < n[0]; bi += B) {
    if (Math.abs(sdf(pt(bi + B / 2, bj + B / 2, bk + B / 2))) > R + step) continue;
    live.push([bi, bj, bk]);
    for (let k = bk; k <= bk + B; k++) for (let j = bj; j <= bj + B; j++) for (let i = bi; i <= bi + B; i++) {
      const id = pid(i, j, k);
      // Kept a little off zero, so no surface vertex lands on a grid point where several would meet.
      if (Number.isNaN(F[id])) { const v = sdf(pt(i, j, k)); F[id] = Math.abs(v) < 0.02 * step ? (v < 0 ? -0.02 : 0.02) * step : v; }
    }
  }
  const pos = [], tris = [], edgeVert = new Map(), NP = nx * ny * nz;
  const vertexOn = (a, b) => {
    const key = a < b ? a * NP + b : b * NP + a;
    let v = edgeVert.get(key);
    if (v === undefined) {
      const fa = F[a], fb = F[b], t = fa / (fa - fb);
      const ka = Math.floor(a / (nx * ny)), ja = Math.floor((a % (nx * ny)) / nx), ia = a % nx;
      const kb = Math.floor(b / (nx * ny)), jb = Math.floor((b % (nx * ny)) / nx), ib = b % nx;
      const pa = pt(ia, ja, ka), pb = pt(ib, jb, kb);
      v = pos.length / 3;
      pos.push(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t);
      edgeVert.set(key, v);
    }
    return v;
  };
  const P = i => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  const emit = (a, b, c, out) => {
    // Facing away from the inside: the triangle's normal along the way the field grows.
    const pa = P(a), pb = P(b), pc = P(c);
    const nrm = [(pb[1] - pa[1]) * (pc[2] - pa[2]) - (pb[2] - pa[2]) * (pc[1] - pa[1]), (pb[2] - pa[2]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[2] - pa[2]), (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])];
    if (nrm[0] * out[0] + nrm[1] * out[1] + nrm[2] * out[2] < 0) tris.push(a, c, b); else tris.push(a, b, c);
  };
  for (const [bi, bj, bk] of live) for (let k = bk; k < bk + B; k++) for (let j = bj; j < bj + B; j++) for (let i = bi; i < bi + B; i++) {
    const corner = [0, 1, 2, 3, 4, 5, 6, 7].map(c => pid(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1)));
    let neg = 0;
    for (const c of corner) if (F[c] < 0) neg++;
    if (!neg || neg === 8) continue;
    for (const tet of TETS) {
      const ids = tet.map(t => corner[t]);
      const inn = ids.filter(id => F[id] < 0), out = ids.filter(id => F[id] >= 0);
      if (!inn.length || !out.length) continue;
      // Outward: from the inside corners toward the outside ones (in grid steps; only the direction matters).
      const dirOut = [0, 0, 0];
      for (const t of tet) { const s = F[corner[t]] < 0 ? -1 : 1; dirOut[0] += s * (t & 1); dirOut[1] += s * ((t >> 1) & 1); dirOut[2] += s * ((t >> 2) & 1); }
      if (inn.length === 1 || out.length === 1) {
        const [apex, rest] = inn.length === 1 ? [inn[0], out] : [out[0], inn];
        emit(vertexOn(apex, rest[0]), vertexOn(apex, rest[1]), vertexOn(apex, rest[2]), dirOut);
      } else {
        const [a, b] = inn, [c, d] = out;
        const v0 = vertexOn(a, c), v1 = vertexOn(a, d), v2 = vertexOn(b, d), v3 = vertexOn(b, c);
        emit(v0, v1, v2, dirOut);
        emit(v0, v2, v3, dirOut);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(tris), 1));
  geometry.computeVertexNormals();
  return { geometry, joints: J };
}
