// Skeletons for the result: the humanoid template, bone names for each engine, and each joint's rest orientation.
// No DOM and no three.js, so it runs in the page, the worker and Node alike.
//
// A rig is { version, template, fingers, naming, frame: { up, front, left }, plane, joints }. Each joint is
// { name, slot, parent, pos, rot, deform, side, mirror, placed }: pos in the model's own units (as the result's
// positions), rot its rest orientation in model space as a quaternion [x, y, z, w], parent and mirror joint indices
// (-1 for none), side 'L', 'R' or 'C', and placed 'detected', 'estimated' or 'user'. Parents always come before their
// children. A joint's bone runs from it to its main child; its +Y points along that bone and +X is its hinge, the axis
// elbows, knees, the spine and fingers bend about.

import { positionGroups } from './core.js';

export const RIG_VERSION = 1;

// ---------- small vector, quaternion and matrix helpers (matrices column-major, as three.js keeps them) ----------

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = a => Math.hypot(a[0], a[1], a[2]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export function norm(a) { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; }

// The rotation whose columns are the axes x, y, z (orthonormal, right-handed).
export function quatFromAxes(x, y, z) {
  const m00 = x[0], m10 = x[1], m20 = x[2], m01 = y[0], m11 = y[1], m21 = y[2], m02 = z[0], m12 = z[1], m22 = z[2];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s]; }
  else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]; }
  return qnorm(q);
}
export function qnorm(q) { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; }
export const qconj = q => [-q[0], -q[1], -q[2], q[3]];
export function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
export function qrot(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}
export function qaxis(axis, angle) { const a = norm(axis), s = Math.sin(angle / 2); return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angle / 2)]; }
// The shortest rotation taking direction a onto direction b.
export function qbetween(a, b) {
  a = norm(a); b = norm(b);
  const d = dot(a, b);
  if (d < -0.999999) {
    const axis = norm(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
    return [axis[0], axis[1], axis[2], 0];
  }
  const c = cross(a, b);
  return qnorm([c[0], c[1], c[2], 1 + d]);
}

// Rotation and translation as a 4×4 matrix.
export function compose(pos, q, out = new Float64Array(16)) {
  const [x, y, z, w] = q, x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - (yy + zz); out[1] = xy + wz; out[2] = xz - wy; out[3] = 0;
  out[4] = xy - wz; out[5] = 1 - (xx + zz); out[6] = yz + wx; out[7] = 0;
  out[8] = xz + wy; out[9] = yz - wx; out[10] = 1 - (xx + yy); out[11] = 0;
  out[12] = pos[0]; out[13] = pos[1]; out[14] = pos[2]; out[15] = 1;
  return out;
}
export function mmul(a, b, out = new Float64Array(16)) {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) {
    r[c * 4 + row] = a[row] * b[c * 4] + a[4 + row] * b[c * 4 + 1] + a[8 + row] * b[c * 4 + 2] + a[12 + row] * b[c * 4 + 3];
  }
  out.set(r);
  return out;
}
// Inverse of a rotation plus translation.
export function rigidInverse(m, out = new Float64Array(16)) {
  const r = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const t = [m[12], m[13], m[14]];
  out[0] = r[0]; out[1] = r[1]; out[2] = r[2]; out[3] = 0;
  out[4] = r[3]; out[5] = r[4]; out[6] = r[5]; out[7] = 0;
  out[8] = r[6]; out[9] = r[7]; out[10] = r[8]; out[11] = 0;
  out[12] = -(r[0] * t[0] + r[3] * t[1] + r[6] * t[2]);
  out[13] = -(r[1] * t[0] + r[4] * t[1] + r[7] * t[2]);
  out[14] = -(r[2] * t[0] + r[5] * t[1] + r[8] * t[2]);
  out[15] = 1;
  return out;
}
// FBX's default rotation order (eEulerXYZ: X first, then Y, then Z), which is three.js's 'ZYX', in degrees.
export function eulerXYZ(q) {
  const m = compose([0, 0, 0], q);
  const m11 = m[0], m12 = m[4], m21 = m[1], m22 = m[5], m31 = m[2], m32 = m[6], m33 = m[10];
  const y = Math.asin(-Math.min(1, Math.max(-1, m31)));
  let x, z;
  if (Math.abs(m31) < 0.9999999) { x = Math.atan2(m32, m33); z = Math.atan2(m21, m11); }
  else { x = 0; z = Math.atan2(-m12, m22); }
  const d = 180 / Math.PI;
  return [x * d, y * d, z * d];
}

// ---------- the humanoid template ----------

export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
const SIDES = [['Left', 'L'], ['Right', 'R']];

// The humanoid's joints in order, parents first: { slot, parent, side, deform }. Slots are Mixamo's joint names, and
// Root, on the floor under the hips, for a figure on a base (Unreal's mannequin has one too).
export function humanoidSlots(fingers = true, root = false) {
  const out = [];
  const add = (slot, parent, side = 'C', deform = true) => out.push({ slot, parent, side, deform });
  if (root) add('Root', null);
  add('Hips', root ? 'Root' : null); add('Spine', 'Hips'); add('Spine1', 'Spine'); add('Spine2', 'Spine1');
  add('Neck', 'Spine2'); add('Head', 'Neck'); add('HeadTop_End', 'Head', 'C', false);
  for (const [S, side] of SIDES) {
    add(`${S}Shoulder`, 'Spine2', side); add(`${S}Arm`, `${S}Shoulder`, side); add(`${S}ForeArm`, `${S}Arm`, side); add(`${S}Hand`, `${S}ForeArm`, side);
    // Without fingers, an end joint at the tip of the hand, so the hand's bone reaches its end.
    if (!fingers) add(`${S}Hand_End`, `${S}Hand`, side, false);
    if (fingers) {
      for (const f of FINGERS) {
        add(`${S}Hand${f}1`, `${S}Hand`, side); add(`${S}Hand${f}2`, `${S}Hand${f}1`, side);
        add(`${S}Hand${f}3`, `${S}Hand${f}2`, side); add(`${S}Hand${f}4`, `${S}Hand${f}3`, side, false);
      }
    }
  }
  for (const [S, side] of SIDES) {
    add(`${S}UpLeg`, 'Hips', side); add(`${S}Leg`, `${S}UpLeg`, side); add(`${S}Foot`, `${S}Leg`, side);
    add(`${S}ToeBase`, `${S}Foot`, side); add(`${S}Toe_End`, `${S}ToeBase`, side, false);
  }
  return out;
}

// Where a joint with several children points its bone.
const MAIN_CHILD = { Hips: 'Spine', Spine2: 'Neck', LeftHand: 'LeftHandMiddle1', RightHand: 'RightHandMiddle1' };

// The other side's slot: Left ↔ Right.
export const mirrorSlot = slot => (slot.startsWith('Left') ? `Right${slot.slice(4)}` : slot.startsWith('Right') ? `Left${slot.slice(5)}` : slot);

// Bone names per engine. Mixamo's (the slots themselves) are mapped on their own by Unity's Humanoid, Godot's humanoid
// profile and Blender; Unreal's are its mannequin's.
const UNREAL = {
  Root: 'root', Hips: 'pelvis', Spine: 'spine_01', Spine1: 'spine_02', Spine2: 'spine_03', Neck: 'neck_01', Head: 'head', HeadTop_End: 'head_end',
  Shoulder: 'clavicle', Arm: 'upperarm', ForeArm: 'lowerarm', Hand: 'hand', Hand_End: 'hand_end', UpLeg: 'thigh', Leg: 'calf', Foot: 'foot', ToeBase: 'ball', Toe_End: 'ball_end',
};
export const NAMINGS = ['mixamo', 'unreal'];
export function boneName(slot, naming = 'mixamo') {
  if (naming !== 'unreal') return slot;
  if (UNREAL[slot]) return UNREAL[slot];
  const m = /^(Left|Right)(.+)$/.exec(slot);
  if (!m) return slot;
  const s = m[1] === 'Left' ? 'l' : 'r', rest = m[2];
  if (UNREAL[rest]) return `${UNREAL[rest]}_${s}`;
  const f = /^Hand(Thumb|Index|Middle|Ring|Pinky)(\d)$/.exec(rest);
  if (f) return `${f[1].toLowerCase()}_0${f[2]}_${s}`;
  return slot;
}

// A rig from joint positions by slot. Joints the map lacks are left out with their children; `placed` marks how each
// position was found ({ slot: 'detected' | 'estimated' | 'user' }, default estimated).
export function humanoidRig(positions, opt = {}) {
  const fingers = opt.fingers ?? FINGERS.every(f => positions[`LeftHand${f}1`]);
  const naming = opt.naming || 'mixamo';
  const slots = humanoidSlots(fingers, !!positions.Root).filter(s => positions[s.slot]);
  const index = new Map(slots.map((s, i) => [s.slot, i]));
  const joints = slots.map(s => ({
    name: boneName(s.slot, naming), slot: s.slot, parent: s.parent ? index.get(s.parent) ?? -1 : -1,
    pos: [...positions[s.slot]], rot: [0, 0, 0, 1], deform: s.deform, side: s.side,
    mirror: index.get(mirrorSlot(s.slot)) ?? -1, placed: (opt.placed && opt.placed[s.slot]) || 'estimated',
  }));
  // A joint whose parent was left out goes too.
  const keep = joints.map(() => true);
  joints.forEach((j, i) => { if (slots[i].parent && (j.parent < 0 || !keep[j.parent])) keep[i] = false; });
  const rig = { version: RIG_VERSION, template: 'humanoid', fingers, naming, frame: frameOf(opt.frame), plane: opt.plane || null, joints: [] };
  const remap = new Int32Array(joints.length).fill(-1);
  joints.forEach((j, i) => { if (keep[i]) { remap[i] = rig.joints.length; rig.joints.push(j); } });
  for (const j of rig.joints) { j.parent = j.parent >= 0 ? remap[j.parent] : -1; j.mirror = j.mirror >= 0 ? remap[j.mirror] : -1; }
  orientJoints(rig);
  return rig;
}

// up, front and left as unit vectors; three.js's convention (Y up, facing +Z, the character's left at +X) by default.
export function frameOf(f) {
  const up = norm(f?.up || [0, 1, 0]);
  const front = norm(sub(f?.front || [0, 0, 1], scale(up, dot(f?.front || [0, 0, 1], up))));
  return { up, front, left: norm(cross(up, front)) };
}

export const childrenOf = rig => {
  const kids = rig.joints.map(() => []);
  rig.joints.forEach((j, i) => { if (j.parent >= 0) kids[j.parent].push(i); });
  return kids;
};

// The child a joint's bone points at, or -1 for a leaf.
export function mainChild(rig, i, kids = childrenOf(rig)) {
  const c = kids[i];
  if (!c.length) return -1;
  const want = MAIN_CHILD[rig.joints[i].slot];
  if (want) { const k = c.find(k => rig.joints[k].slot === want); if (k !== undefined) return k; }
  return c[0];
}

// Each joint's rest orientation: +Y along its bone (a leaf keeps its parent's), +X its hinge, cross(Y, front) or, for a
// bone running front to back (feet, toes), cross(Y, ±up). Mirrored joints come out mirrored, so a rotation about X bends
// both elbows alike. Joints marked keepRot (from a file's own skeleton) keep theirs.
export function orientJoints(rig) {
  const { up, front } = rig.frame, kids = childrenOf(rig);
  const dirs = rig.joints.map(() => null);
  rig.joints.forEach((j, i) => {
    const c = mainChild(rig, i, kids);
    let y = c >= 0 ? norm(sub(rig.joints[c].pos, j.pos)) : null;
    if (!y || len(y) < 0.5) y = j.parent >= 0 ? dirs[j.parent] : up;
    dirs[i] = y;
    if (j.keepRot) return;
    const f = dot(y, front);
    const ref = Math.abs(f) <= 0.8 ? front : scale(up, Math.sign(f) || 1);
    let x = norm(cross(y, ref));
    if (len(x) < 0.5) x = norm(cross(y, Math.abs(dot(y, up)) < 0.9 ? up : front));
    const z = cross(x, y);
    j.rot = quatFromAxes(x, y, z);
  });
  return rig;
}

// Rest matrices in model space, 16 per joint.
export function restMatrices(rig) {
  const out = new Float64Array(rig.joints.length * 16);
  rig.joints.forEach((j, i) => compose(j.pos, j.rot, out.subarray(i * 16, i * 16 + 16)));
  return out;
}

// The skeleton as exporters want it, in the model's units times `unit`: per joint its name, parent, world rest matrix,
// local translation and rotation (quaternion, and Euler degrees in FBX's XYZ order), whether it deforms, and a display
// size for FBX's LimbNode.
export function exportSkeleton(rig, unit = 1) {
  const kids = childrenOf(rig);
  return rig.joints.map((j, i) => {
    const p = j.parent >= 0 ? rig.joints[j.parent] : null;
    const pos = scale(j.pos, unit);
    const local = p ? qrot(qconj(p.rot), sub(pos, scale(p.pos, unit))) : pos;
    const q = p ? qnorm(qmul(qconj(p.rot), j.rot)) : j.rot;
    const c = mainChild(rig, i, kids);
    const size = c >= 0 ? dist(j.pos, rig.joints[c].pos) * unit : p ? dist(j.pos, p.pos) * unit * 0.5 : 1;
    return { name: j.name, parent: j.parent, world: compose(pos, j.rot), t: local, q, r: eulerXYZ(q), deform: j.deform, size };
  });
}

// Renames template joints for another engine's names; custom joints keep theirs.
export function renameRig(rig, naming) {
  rig.naming = naming;
  for (const j of rig.joints) if (j.slot) j.name = boneName(j.slot, naming);
  return rig;
}

// Joint names made unique (FBX and glTF importers match bones by name), in place.
export function uniqueNames(rig) {
  const seen = new Set();
  for (const j of rig.joints) {
    let base = (j.name || 'Bone').replace(/[^\w.:-]+/g, '_') || 'Bone', name = base, k = 1;
    while (seen.has(name)) name = `${base}.${String(k++).padStart(3, '0')}`;
    seen.add(name);
    j.name = name;
  }
  return rig;
}

// A plain copy, safe to store, post to a worker or keep in undo history.
export function cloneRig(rig) {
  return rig && { ...rig, frame: { ...rig.frame }, plane: rig.plane && { ...rig.plane }, joints: rig.joints.map(j => ({ ...j, pos: [...j.pos], rot: [...j.rot] })) };
}

// ---------- finding the skeleton on the mesh ----------
//
// A standing biped is read from its surface alone. Geodesic distance from the middle of the body peaks at the ends of
// the limbs; the five longest branches (by persistence: how far a peak's region reaches before it merges with a higher
// one's) are the head, the hands and the feet. The mirror plane splits them into sides, the head is the one on it, and
// of each side's two the farther from the head is the foot. That gives up, front (where the toes point) and left
// whatever the file's axes. Each limb's centreline is traced by the rings of equal geodesic distance from its tip:
// their centroids run down the middle of the limb, their length is its girth, and where a ring suddenly grows the limb
// has met the trunk. Joints go where the limb narrows (wrist, neck), turns (ankle) or bends (elbow, knee), and
// otherwise at a person's proportions along it.

class Heap {
  constructor() { this.key = []; this.val = []; }
  get size() { return this.key.length; }
  push(k, v) {
    const K = this.key, Vv = this.val;
    let i = K.length;
    K.push(k); Vv.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= k) break;
      K[i] = K[p]; Vv[i] = Vv[p]; i = p;
    }
    K[i] = k; Vv[i] = v;
  }
  pop() {
    const K = this.key, Vv = this.val, top = Vv[0], k = K.pop(), v = Vv.pop();
    if (K.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= K.length) break;
        if (c + 1 < K.length && K[c + 1] < K[c]) c++;
        if (K[c] >= k) break;
        K[i] = K[c]; Vv[i] = Vv[c]; i = c;
      }
      K[i] = k; Vv[i] = v;
    }
    return top;
  }
}

// The surface as a graph over its distinct positions: P, triangles T over them, CSR neighbours with edge lengths.
export function meshGraph(positions, index) {
  const V = positions.length / 3;
  const { group, count: n } = positionGroups({ positions, vertexCount: V });
  const P = new Float64Array(n * 3);
  for (let v = 0; v < V; v++) for (let k = 0; k < 3; k++) P[group[v] * 3 + k] = positions[v * 3 + k];
  const tris = [];
  for (let t = 0; t < index.length; t += 3) {
    const a = group[index[t]], b = group[index[t + 1]], c = group[index[t + 2]];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  const T = Uint32Array.from(tris);
  const seen = new Set(), ea = [], eb = [];
  for (let t = 0; t < T.length; t += 3) for (let k = 0; k < 3; k++) {
    let a = T[t + k], b = T[t + ((k + 1) % 3)];
    if (a > b) [a, b] = [b, a];
    const key = a * n + b;
    if (!seen.has(key)) { seen.add(key); ea.push(a); eb.push(b); }
  }
  const start = new Int32Array(n + 1);
  for (let e = 0; e < ea.length; e++) { start[ea[e] + 1]++; start[eb[e] + 1]++; }
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const fill = start.slice(0, n), to = new Int32Array(ea.length * 2), w = new Float64Array(ea.length * 2);
  for (let e = 0; e < ea.length; e++) {
    const a = ea[e], b = eb[e], l = Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
    to[fill[a]] = b; w[fill[a]++] = l;
    to[fill[b]] = a; w[fill[b]++] = l;
  }
  return { P, T, n, start, to, w, group };
}

const pointOf = (g, v) => [g.P[v * 3], g.P[v * 3 + 1], g.P[v * 3 + 2]];

// Shortest distances along edges from the sources ([vertex, distance] pairs), within mask when given.
function dijkstra(g, sources, mask = null) {
  const d = new Float64Array(g.n).fill(Infinity), prev = new Int32Array(g.n).fill(-1), done = new Uint8Array(g.n);
  const h = new Heap();
  for (const [v, d0] of sources) if (d0 < d[v]) { d[v] = d0; h.push(d0, v); }
  while (h.size) {
    const v = h.pop();
    if (done[v]) continue;
    done[v] = 1;
    for (let e = g.start[v]; e < g.start[v + 1]; e++) {
      const u = g.to[e];
      if (mask && !mask[u]) continue;
      const nd = d[v] + g.w[e];
      if (nd < d[u]) { d[u] = nd; prev[u] = v; h.push(nd, u); }
    }
  }
  return { d, prev };
}

// Connected pieces: label per vertex and each piece's vertex count.
function pieces(g) {
  const label = new Int32Array(g.n).fill(-1), sizes = [];
  for (let s = 0; s < g.n; s++) {
    if (label[s] >= 0) continue;
    const id = sizes.length, stack = [s];
    label[s] = id;
    let count = 0;
    while (stack.length) {
      const v = stack.pop();
      count++;
      for (let e = g.start[v]; e < g.start[v + 1]; e++) { const u = g.to[e]; if (label[u] < 0) { label[u] = id; stack.push(u); } }
    }
    sizes.push(count);
  }
  return { label, sizes };
}

// The peaks of f with their persistence: sweeping f downward, a peak's region lives until it meets a higher peak's,
// at its saddle. The highest peak never dies. Only vertices in mask take part when it is given.
function peaks(g, f, mask = null) {
  const order = [];
  for (let v = 0; v < g.n; v++) if ((!mask || mask[v]) && Number.isFinite(f[v])) order.push(v);
  order.sort((a, b) => f[b] - f[a]);
  const parent = new Int32Array(g.n).fill(-1), top = new Int32Array(g.n).fill(-1);
  const find = v => { while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v]; } return v; };
  const out = new Map();
  for (const v of order) {
    parent[v] = v; top[v] = v;
    for (let e = g.start[v]; e < g.start[v + 1]; e++) {
      const u = g.to[e];
      if (parent[u] < 0) continue;
      const a = find(u), b = find(v);
      if (a === b) continue;
      // The lower peak dies here.
      const [hi, lo] = f[top[a]] >= f[top[b]] ? [a, b] : [b, a];
      if (top[lo] !== v) out.set(top[lo], { v: top[lo], persistence: f[top[lo]] - f[v], saddle: v });
      parent[lo] = hi;
    }
  }
  const roots = new Set();
  for (const v of order) roots.add(top[find(v)]);
  for (const r of roots) out.set(r, { v: r, persistence: Infinity, saddle: -1 });
  return [...out.values()].filter(Boolean).sort((a, b) => b.persistence - a.persistence);
}

// The ring where f = t that crosses edge a–b: the level set's segments joined into loops through the edges they share.
// { c: centroid, perimeter, radius (mean distance from c), count } or null.
function ringAt(g, f, lohi, t, a, b) {
  const P = g.P, T = g.T, n = g.n, keyOf = (u, v) => (u < v ? u * n + v : v * n + u);
  const segKeys = [], segPts = [];
  const cross = (u, v) => {
    const s = (t - f[u]) / (f[v] - f[u]);
    return [P[u * 3] + (P[v * 3] - P[u * 3]) * s, P[u * 3 + 1] + (P[v * 3 + 1] - P[u * 3 + 1]) * s, P[u * 3 + 2] + (P[v * 3 + 2] - P[u * 3 + 2]) * s];
  };
  for (let i = 0, tc = T.length / 3; i < tc; i++) {
    // Triangles outside the region f was measured over (infinite there) have no part in its level sets.
    if (lohi[i * 2] > t || !(lohi[i * 2 + 1] > t) || lohi[i * 2 + 1] === Infinity) continue;
    const vs = [T[i * 3], T[i * 3 + 1], T[i * 3 + 2]], ks = [], ps = [];
    for (let k = 0; k < 3; k++) {
      const u = vs[k], v = vs[(k + 1) % 3];
      if ((f[u] < t) !== (f[v] < t)) { ks.push(keyOf(u, v)); ps.push(cross(u, v)); }
    }
    if (ks.length === 2) { segKeys.push(ks[0], ks[1]); segPts.push(ps[0], ps[1]); }
  }
  const S = segKeys.length / 2;
  if (!S) return null;
  const parent = new Int32Array(S).map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const firstAt = new Map();
  for (let i = 0; i < S; i++) for (const k of [segKeys[i * 2], segKeys[i * 2 + 1]]) {
    const j = firstAt.get(k);
    if (j === undefined) firstAt.set(k, i); else parent[find(i)] = find(j);
  }
  const target = firstAt.get(keyOf(a, b));
  if (target === undefined) return null;
  const root = find(target);
  let L = 0, cx = 0, cy = 0, cz = 0, count = 0;
  const mids = [];
  for (let i = 0; i < S; i++) {
    if (find(i) !== root) continue;
    const p = segPts[i * 2], q = segPts[i * 2 + 1], l = dist(p, q), m = lerp(p, q, 0.5);
    L += l; cx += m[0] * l; cy += m[1] * l; cz += m[2] * l; count++;
    mids.push([m, l]);
  }
  if (!(L > 0)) return null;
  const c = [cx / L, cy / L, cz / L];
  let r = 0;
  for (const [m, l] of mids) r += dist(m, c) * l;
  return { c, perimeter: L, radius: r / L, count };
}

const triRange = (g, f) => {
  const T = g.T, out = new Float64Array((T.length / 3) * 2);
  for (let i = 0; i < T.length / 3; i++) {
    const a = f[T[i * 3]], b = f[T[i * 3 + 1]], c = f[T[i * 3 + 2]];
    out[i * 2] = Math.min(a, b, c); out[i * 2 + 1] = Math.max(a, b, c);
  }
  return out;
};

// A limb traced from its tip: rings of equal distance from the tip every `step`, along the shortest way to `to`.
// [{ t, c, perimeter, radius }].
function trace(g, tip, to, step, mask = null, tMax = Infinity) {
  const { d, prev } = dijkstra(g, [[tip, 0]], mask);
  const path = [];
  for (let v = to; v >= 0; v = prev[v]) path.push(v);
  path.reverse();
  const lohi = triRange(g, d), out = [];
  let i = 0;
  const end = Math.min(d[to], tMax);
  for (let t = step; t < end; t += step) {
    while (i + 1 < path.length && d[path[i + 1]] <= t) i++;
    if (i + 1 >= path.length) break;
    const r = ringAt(g, d, lohi, t, path[i], path[i + 1]);
    if (r) out.push({ t, ...r });
  }
  return { rings: out, d, path };
}

// Where the rings suddenly grow: the limb has met the trunk. The index of the last ring before, or the last ring. The
// search starts a third of the way in, and no earlier than ring `first` (past a foot, whose rings across the heel grow
// too).
function junction(rings, from = 0.35, first = 0) {
  const n = rings.length;
  for (let i = Math.max(3, first, Math.floor(n * from)); i < n; i++) {
    const before = rings.slice(Math.floor(i * 0.5), Math.max(Math.floor(i * 0.5) + 1, i - 1)).map(r => r.perimeter).sort((a, b) => a - b);
    const med = before[before.length >> 1];
    if (rings[i].perimeter > 1.8 * med) return i - 1;
  }
  return n - 1;
}

// A point along the ring centroids at arc length s from ring i0 toward ring i1.
function alongRings(rings, i0, i1, frac) {
  const step = i1 > i0 ? 1 : -1, pts = [];
  for (let i = i0; i !== i1 + step; i += step) pts.push(rings[i].c);
  return alongPolyline(pts, frac);
}
export function alongPolyline(pts, frac) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  let want = total * frac;
  for (let i = 1; i < pts.length; i++) {
    const l = dist(pts[i - 1], pts[i]);
    if (want <= l || i === pts.length - 1) return lerp(pts[i - 1], pts[i], l > 0 ? Math.min(1, want / l) : 0);
    want -= l;
  }
  return pts[0];
}

// The bend along rings i0..i1: the ring where the centreline turns most, and by how much (degrees), measured over a
// quarter of the span to either side.
function bendOf(rings, i0, i1) {
  const span = Math.abs(i1 - i0), w = Math.max(2, Math.round(span / 4)), lo = Math.min(i0, i1), hi = Math.max(i0, i1);
  let best = -1, angle = 0;
  for (let i = lo + w; i <= hi - w; i++) {
    const a = norm(sub(rings[i].c, rings[i - w].c)), b = norm(sub(rings[i + w].c, rings[i].c));
    const ang = (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;
    if (ang > angle) { angle = ang; best = i; }
  }
  return { i: best, angle };
}

// The point on the line through ring centroids i0 and i1 nearest to p.
function axisPoint(rings, i0, i1, p) {
  const a = rings[i0].c, d = norm(sub(rings[i1].c, a));
  return add(a, scale(d, dot(sub(p, a), d)));
}

// The narrowest ring between i0 and i1, if it is clearly narrower than the rings around it: its index, or -1.
function narrowest(rings, i0, i1) {
  let best = -1;
  for (let i = i0; i <= i1; i++) if (best < 0 || rings[i].perimeter < rings[best].perimeter) best = i;
  if (best < 0) return -1;
  const around = rings.slice(i0, i1 + 1).map(r => r.perimeter).sort((a, b) => a - b);
  return rings[best].perimeter < 0.95 * around[around.length >> 1] ? best : -1;
}

// The plane the shape is most nearly mirror-symmetric about, among the three axis planes: { axis, offset, error (mean
// distance from a mirrored point to the surface, as a share of the size) }.
export function mirrorPlaneOf(P, n) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[i * 3 + k]); hi[k] = Math.max(hi[k], P[i * 3 + k]); }
  const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1, h = size / 60;
  const cells = new Map(), cell = (x, y, z) => `${Math.floor(x / h)},${Math.floor(y / h)},${Math.floor(z / h)}`;
  for (let i = 0; i < n; i++) { const k = cell(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(i); }
  const nearest = (x, y, z) => {
    let best = Infinity;
    for (let r = 1; r <= 3 && best === Infinity; r++) {
      const cx = Math.floor(x / h), cy = Math.floor(y / h), cz = Math.floor(z / h);
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        for (const i of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) || []) best = Math.min(best, Math.hypot(P[i * 3] - x, P[i * 3 + 1] - y, P[i * 3 + 2] - z));
      }
    }
    return Math.min(best, 3 * h);
  };
  const sample = [], stride = Math.max(1, Math.floor(n / 1500));
  for (let i = 0; i < n; i += stride) sample.push(i);
  const score = (axis, off) => {
    let s = 0;
    for (const i of sample) {
      const q = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
      q[axis] = 2 * off - q[axis];
      s += nearest(q[0], q[1], q[2]);
    }
    return s / sample.length;
  };
  let best = null;
  for (let axis = 0; axis < 3; axis++) {
    let c = 0;
    for (let i = 0; i < n; i++) c += P[i * 3 + axis];
    c /= n;
    // Golden-section search for the offset around the centroid.
    let a = c - 0.06 * size, b = c + 0.06 * size;
    const gr = (Math.sqrt(5) - 1) / 2;
    let x1 = b - gr * (b - a), x2 = a + gr * (b - a), f1 = score(axis, x1), f2 = score(axis, x2);
    for (let it = 0; it < 18; it++) {
      if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - gr * (b - a); f1 = score(axis, x1); }
      else { a = x1; x1 = x2; f1 = f2; x2 = a + gr * (b - a); f2 = score(axis, x2); }
    }
    const offset = (a + b) / 2, err = score(axis, offset) / size;
    if (!best || err < best.error) best = { axis, offset, error: err };
  }
  return best;
}

// Where the line through o along unit dir meets the surface: the distances along it, sorted.
function rayHits(g, o, dir) {
  const P = g.P, T = g.T, out = [];
  for (let i = 0; i < T.length; i += 3) {
    const a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3;
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const pv = cross(dir, e2), det = dot(e1, pv);
    if (Math.abs(det) < 1e-14) continue;
    const tv = [o[0] - P[a], o[1] - P[a + 1], o[2] - P[a + 2]], u = dot(tv, pv) / det;
    if (u < 0 || u > 1) continue;
    const qv = cross(tv, e1), v = dot(dir, qv) / det;
    if (v < 0 || u + v > 1) continue;
    out.push(dot(e2, qv) / det);
  }
  return out.sort((x, y) => x - y);
}

// p moved along dir to the middle of the solid around it: halfway between the surface the line enters before p and the
// one it leaves by after. p stays as it is when no such pair surrounds it.
export function centreAlong(g, p, dir) {
  const hits = rayHits(g, p, dir);
  for (let i = 0; i + 1 < hits.length; i += 2) {
    if (hits[i] <= 0 && hits[i + 1] >= 0) return add(p, scale(dir, (hits[i] + hits[i + 1]) / 2));
  }
  // Not enclosed (an open or self-crossing surface): the pair of hits nearest to p.
  let best = null;
  for (let i = 0; i + 1 < hits.length; i++) {
    const m = (hits[i] + hits[i + 1]) / 2;
    if (!best || Math.abs(m) < Math.abs(best)) best = m;
  }
  return best === null ? p : add(p, scale(dir, best));
}

// Standing-figure proportions for when the shape can't be read: joints as [left, up, front] shares of the height,
// from the feet, arms 45° down.
const TEMPLATE = (() => {
  const J = { Hips: [0, 0.53, 0], Spine: [0, 0.59, 0], Spine1: [0, 0.66, 0], Spine2: [0, 0.73, 0], Neck: [0, 0.83, 0], Head: [0, 0.88, 0], HeadTop_End: [0, 1, 0] };
  const s = Math.SQRT1_2, side = {
    Shoulder: [0.025, 0.8, 0], Arm: [0.1, 0.8, 0], ForeArm: [0.1 + 0.155 * s, 0.8 - 0.155 * s, 0], Hand: [0.1 + 0.295 * s, 0.8 - 0.295 * s, 0],
    UpLeg: [0.055, 0.52, 0], Leg: [0.055, 0.285, 0.005], Foot: [0.055, 0.05, -0.005], ToeBase: [0.055, 0.015, 0.065], Toe_End: [0.055, 0.015, 0.11],
  };
  for (const [k, v] of Object.entries(side)) { J[`Left${k}`] = v; J[`Right${k}`] = [-v[0], v[1], v[2]]; }
  return J;
})();
const HAND_TIP = 0.1; // the template hand's length, as a share of the height

// Fingers laid out in a hand's frame, by a hand's proportions: from the wrist w along d, palm facing -n (n out of the
// back of the hand), across along a (toward the thumb), the hand `length` long and `width` wide.
function templateFingers(w, d, a, length, width, prefix, out) {
  const at = (p, ...terms) => terms.reduce((q, [v, s]) => add(q, scale(v, s)), p);
  const spec = { Index: [0.36, 0.42], Middle: [0.12, 0.46], Ring: [-0.12, 0.43], Pinky: [-0.36, 0.35] };
  for (const [f, [off, l]] of Object.entries(spec)) {
    const k = at(w, [d, 0.56 * length], [a, off * width]);
    out[`${prefix}${f}1`] = k;
    out[`${prefix}${f}2`] = at(k, [d, 0.45 * l * length]);
    out[`${prefix}${f}3`] = at(k, [d, 0.75 * l * length]);
    out[`${prefix}${f}4`] = at(k, [d, l * length]);
  }
  const t = norm(add(scale(d, 0.6), scale(a, 0.8))), t1 = at(w, [d, 0.15 * length], [a, 0.4 * width]);
  out[`${prefix}Thumb1`] = t1;
  out[`${prefix}Thumb2`] = at(t1, [t, 0.16 * length]);
  out[`${prefix}Thumb3`] = at(t1, [t, 0.29 * length]);
  out[`${prefix}Thumb4`] = at(t1, [t, 0.4 * length]);
}

// The skeleton for a mesh ({ positions, index }, as the result has them). opt: plane ({ axis, offset }, the app's
// mirror plane, found here when absent), fingers ('auto': where the hands have them; 'full'; 'none'), naming.
// Returns a rig (see the top of this file) and a report { found, extremities, error, notes }.
export function placeHumanoid(mesh, opt = {}) {
  const t0 = Date.now();
  const g = meshGraph(mesh.positions, mesh.index);
  const notes = [];
  // The body is the largest piece; eyes, teeth and accessories don't shape the skeleton.
  const { label, sizes } = pieces(g);
  const bodyId = sizes.indexOf(Math.max(...sizes));
  const body = new Uint8Array(g.n);
  for (let v = 0; v < g.n; v++) body[v] = label[v] === bodyId ? 1 : 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], cen = [0, 0, 0];
  let nb = 0;
  for (let v = 0; v < g.n; v++) {
    if (!body[v]) continue;
    nb++;
    for (let k = 0; k < 3; k++) { const x = g.P[v * 3 + k]; lo[k] = Math.min(lo[k], x); hi[k] = Math.max(hi[k], x); cen[k] += x; }
  }
  for (let k = 0; k < 3; k++) cen[k] /= nb;
  const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const plane = opt.plane && Number.isFinite(opt.plane.offset) ? { axis: opt.plane.axis, offset: opt.plane.offset, error: 0 } : mirrorPlaneOf(g.P, g.n);
  const nrm = [0, 0, 0];
  nrm[plane.axis] = 1;
  const side = p => p[plane.axis] - plane.offset;
  const toPlane = p => { const q = [...p]; q[plane.axis] = plane.offset; return q; };
  const mirror = p => { const q = [...p]; q[plane.axis] = 2 * plane.offset - q[plane.axis]; return q; };

  // Up is the longer of the two axes along the mirror plane (Y, as three.js, glTF and most exporters have it, when the
  // two are about as long); front is three.js's +Z way, or -Y with Z up (Blender's), until the toes say otherwise.
  const axes = [0, 1, 2].filter(k => k !== plane.axis), ext = k => hi[k] - lo[k];
  let upAxis = ext(axes[0]) >= ext(axes[1]) ? axes[0] : axes[1];
  if (axes.includes(1) && ext(1) > 0.85 * ext(upAxis)) upAxis = 1;
  const frontAxis = axes.find(k => k !== upAxis), H0 = ext(upAxis);
  const up = [0, 0, 0];
  up[upAxis] = 1;
  const fallback = (why, f) => {
    notes.push(why);
    return templateRig(g, body, lo, hi, plane, opt, notes, t0, f);
  };
  // The middle of the body: the body vertex nearest its centroid, from which geodesic distance is measured.
  let mid = -1, md = Infinity;
  for (let v = 0; v < g.n; v++) if (body[v]) { const d = dist(pointOf(g, v), cen); if (d < md) { md = d; mid = v; } }
  const ends = () => peaks(g, dijkstra(g, [[mid, 0]], body).d, body).filter(p => p.persistence > 0.03 * H0).map(e => ({ ...e, p: pointOf(g, e.v) }));
  let all = ends();
  // The hands: on each side, the peak farthest out from the plane. (Up is the file's own: a figure whose arms hang
  // low under a big head has its hands below its middle, which once read as upside down.)
  const handOn = (list, sgn) => list.filter(e => Math.sign(side(e.p)) === sgn).sort((a, b) => Math.abs(side(b.p)) - Math.abs(side(a.p)))[0];
  const hp0 = handOn(all, 1), hn0 = handOn(all, -1);
  if (!hp0 || !hn0) return fallback('The hands could not be found on both sides of the mirror plane.', { up });
  const height = p => dot(p, up);
  const floorH = up[upAxis] > 0 ? lo[upAxis] : -hi[upAxis];
  // A base the feet stand on is left out of the skeleton's shape: the feet end where they meet it.
  const baseTop = findBase(g, body, plane, up, floorH, H0);
  if (baseTop !== null) {
    for (let v = 0; v < g.n; v++) if (body[v] && height(pointOf(g, v)) < baseTop) body[v] = 0;
    if (!body[mid]) return fallback('The figure could not be told from its base.', { up });
    notes.push('The figure stands on a base; the base goes with a Root joint and stays put.');
    all = ends();
  }
  const hp = handOn(all, 1), hn = handOn(all, -1);
  if (!hp || !hn) return fallback('The hands could not be found on both sides of the mirror plane.', { up });
  // The legs, where they stand apart below the hands; a long dress or robe hides them down to the floor, and they are
  // then laid out inside it by a figure's proportions.
  let bottomH = Infinity;
  for (let v = 0; v < g.n; v++) if (body[v]) bottomH = Math.min(bottomH, height(pointOf(g, v)));
  const hidden = !legsApart(g, body, plane, up, bottomH, Math.min(height(hp.p), height(hn.p)), H0);
  // The feet: on each side, the lowest peak that isn't the hand.
  const footOn = (sgn, hand) => all.filter(e => Math.sign(side(e.p)) === sgn && e !== hand).sort((a, b) => height(a.p) - height(b.p))[0];
  const fp = hidden ? null : footOn(1, hp), fn = hidden ? null : footOn(-1, hn);
  if (!hidden && (!fp || !fn)) return fallback('The hands and feet could not all be told apart.', { up });
  if (!hidden && (height(fp.p) > height(hp.p) - 0.15 * H0 || height(fn.p) > height(hn.p) - 0.15 * H0)) return fallback('The feet are not clearly below the hands: the pose is not a standing one.', { up });
  if (hidden) notes.push('The legs are hidden by the clothes down to the floor, so they are laid out inside by a figure\'s proportions: check them.');
  // The head: the top of the body on the plane.
  let top = -1;
  for (let v = 0; v < g.n; v++) {
    if (!body[v]) continue;
    const p = pointOf(g, v);
    if (Math.abs(side(p)) < 0.08 * H0 && (top < 0 || height(p) > height(pointOf(g, top)))) top = v;
  }
  const headEnd = { v: top, p: pointOf(g, top), persistence: Infinity };
  const sp = { hand: hp, foot: fp }, sn = { hand: hn, foot: fn };
  const H = height(headEnd.p) - (hidden ? bottomH : Math.min(height(fp.p), height(fn.p)));
  if (!(H > 0.2 * size)) return fallback('The shape is not tall enough for a standing figure.', { up });
  void frontAxis;
  const step = H / 160;

  // Each limb's rings, from its tip toward the middle of the body. The peak found from the middle can sit off the very
  // end (on the side of a toe cap), so the tip is taken again as the point farthest from a ring partway down the limb.
  const limb = (e, legFloor = null) => {
    // A leg's junction is looked for only above the lowest fifth of the figure.
    const above = R => (legFloor === null ? 0 : Math.max(0, R.findIndex(r => height(r.c) > legFloor + 0.2 * H)));
    let { rings, d } = trace(g, e.v, mid, step, body);
    let j = junction(rings, 0.35, above(rings));
    if (j > 8) {
      // The part of the limb past a ring partway down it: all that is reached from the tip without crossing the ring
      // (or, where the ring doesn't close, all nearer the tip than it).
      const tm = Math.min(rings[Math.round(j * 0.6)].t, 0.15 * H), part = new Uint8Array(g.n), band = [], stack = [e.v];
      const onRing = v => d[v] > tm - 2 * step && d[v] <= tm;
      part[e.v] = 1;
      let count = 1, nBody = 0;
      for (let v = 0; v < g.n; v++) if (body[v]) nBody++;
      while (stack.length) {
        const v = stack.pop();
        for (let k = g.start[v]; k < g.start[v + 1]; k++) {
          const u = g.to[k];
          if (part[u] || !body[u]) continue;
          part[u] = 1; count++;
          if (onRing(u)) band.push([u, 0]); else stack.push(u);
        }
      }
      if (count > 0.25 * nBody || band.length < 3) {
        part.fill(0); band.length = 0;
        for (let v = 0; v < g.n; v++) if (body[v] && d[v] <= tm) { part[v] = 1; if (onRing(v)) band.push([v, 0]); }
      }
      const far = dijkstra(g, band, part).d;
      let tip = e.v;
      for (let v = 0; v < g.n; v++) if (part[v] && Number.isFinite(far[v]) && far[v] > far[tip]) tip = v;
      if (tip !== e.v) {
        e = { ...e, v: tip, p: pointOf(g, tip) };
        ({ rings, d } = trace(g, tip, mid, step, body));
        j = junction(rings, 0.35, above(rings));
      }
    }
    return { e, rings, j, d };
  };
  const lowest = hidden ? bottomH : Math.min(height(fp.p), height(fn.p));
  const feet = hidden ? null : { pos: limb(sp.foot, lowest), neg: limb(sn.foot, lowest) }, hands = { pos: limb(sp.hand), neg: limb(sn.hand) }, head = limb(headEnd);
  // Front: the way the toes point from the leg above them, when they clearly do; otherwise the file's convention.
  const frontC = norm(cross(up, nrm));
  const conventional = upAxis === 2 ? -frontC[1] : frontC[2] || frontC[0];
  let fs = 0;
  if (feet) for (const L of [feet.pos, feet.neg]) {
    const i = Math.min(L.j, Math.round(L.j * 0.45));
    if (L.rings.length) fs += dot(sub(L.e.p, L.rings[i].c), frontC);
  }
  const front = (Math.abs(fs) > 0.03 * H ? fs : conventional || 1) >= 0 ? frontC : scale(frontC, -1);
  const left = cross(up, front);
  const leftSign = Math.sign(dot(left, nrm)) || 1; // which side of the plane is the figure's left
  const S = { L: leftSign > 0 ? 'pos' : 'neg', R: leftSign > 0 ? 'neg' : 'pos' };
  const J = {}, placed = {};
  const put = (slot, p, how = 'detected') => { J[slot] = p; placed[slot] = how; };

  // Legs: the ankle where the centreline turns from along the foot to up the leg, the ball of the foot between it and
  // the toes, the hip a little above where the leg meets the trunk, the knee where the leg bends or halfway.
  const w = Math.max(2, Math.round((0.025 * H) / step));
  const legOf = (L, shoulderH) => {
    const R = L.rings, out = {};
    let n = L.j;
    // The ankle: the sharpest turn of the centreline low down, where it goes from along the foot to up the leg.
    const floor = Math.min(...R.slice(0, n + 1).map(r => height(r.c)));
    let ia = -1, best = 0;
    for (let i = w; i + w <= n && height(R[i].c) < floor + 0.15 * H; i++) {
      const a = norm(sub(R[i].c, R[i - w].c)), b = norm(sub(R[i + w].c, R[i].c));
      const turn = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
      if (turn > best && dot(b, up) > 0.5) { best = turn; ia = i; }
    }
    if (ia < 0 || best < (35 * Math.PI) / 180) { ia = Math.max(1, Math.round(n * 0.12)); out.ankleGuess = true; }
    // A leg whose girth doubles within a tenth of the height has gone up into a skirt or shorts, which hide where it
    // meets the trunk (a thigh widens far more slowly).
    const span = Math.max(2, Math.round((0.1 * H) / step));
    let skirt = -1;
    for (let i = ia + span; i + 2 <= n; i++) {
      const k = i - span;
      if ([0, 1, 2].every(o => R[i + o].perimeter > 2 * R[k].perimeter)) { skirt = k + Math.round(span / 3); break; }
    }
    // The torso of a standing figure, from the hip joints to the shoulders, is about 0.29 of its height, from a
    // person's proportions to a big-headed stylised character's.
    const hipGuess = shoulderH - 0.29 * H;
    if (skirt >= 0) n = skirt;
    const axis = axisPoint(R, Math.round(ia + (n - ia) * 0.55), Math.round(ia + (n - ia) * 0.85), R[n].c);
    // The hip joint: on the thigh's axis where it meets the trunk, raised by about the thigh's radius.
    out.UpLeg = add(axis, scale(up, 0.9 * R[Math.round(ia + (n - ia) * 0.85)].radius));
    if (skirt >= 0 || height(out.UpLeg) < hipGuess - 0.08 * H) {
      // Hidden: along the leg's axis up to the hips the proportions give.
      const dir = norm(sub(R[n].c, R[ia].c));
      out.UpLeg = add(out.UpLeg, scale(dir, Math.max(0, hipGuess - height(out.UpLeg)) / Math.max(0.3, dot(dir, up))));
      out.hipGuess = true;
    }
    out.Foot = R[ia].c;
    out.ToeBase = R[Math.max(1, Math.round(ia * 0.38))].c;
    out.Toe_End = R[Math.max(0, Math.round(ia * 0.06))].c;
    const b = bendOf(R, Math.round(ia + (n - ia) * 0.25), Math.round(ia + (n - ia) * 0.75));
    if (b.angle > 20 && !out.hipGuess) { out.Leg = R[b.i].c; out.kneeBent = true; }
    else out.Leg = alongPolyline([out.Foot, ...R.slice(ia, n + 1).map(r => r.c), out.UpLeg], 0.5);
    return out;
  };
  // Arms: the wrist at the narrowest ring past the hand, the shoulder where the arm meets the trunk, the elbow where the
  // arm bends or at a person's proportions.
  const armOf = L => {
    const R = L.rings, n = L.j, out = {};
    // The wrist: past the widest ring of the hand (the palm, or where the thumb joins it), the narrowest one.
    let palm = Math.round(n * 0.05);
    for (let i = palm; i <= Math.round(n * 0.4); i++) if (R[i].perimeter > R[palm].perimeter) palm = i;
    let iw = narrowest(R, palm + 1, Math.min(n - 1, palm + Math.round(n * 0.25)));
    if (iw < 0) { iw = Math.round(n * 0.27); out.wristGuess = true; }
    // Of rings about as narrow, the one nearest the hand: a forearm can stay that narrow for a while.
    else for (let i = palm + 1; i < iw; i++) if (R[i].perimeter <= 1.03 * R[iw].perimeter) { iw = i; break; }
    out.iw = iw;
    out.Hand = R[iw].c;
    // The shoulder joint: on the upper arm's axis where the arm meets the trunk. With the arms lowered the armpit closes
    // before the axis reaches the joint, so it carries on inward until the top of the shoulder is about an arm's radius
    // above it.
    const i0 = Math.round(iw + (n - iw) * 0.6), i1 = Math.round(iw + (n - iw) * 0.9), r = R[i1].radius;
    out.Arm = axisPoint(R, i0, i1, R[n].c);
    const inward = norm(sub(R[i1].c, R[i0].c));
    for (let k = 0; k < 8; k++) {
      const above = rayHits(g, out.Arm, up).find(t => t > 0);
      if (above === undefined || above <= 1.15 * r) break;
      out.Arm = add(out.Arm, scale(inward, 0.2 * r));
    }
    const b = bendOf(R, Math.round(iw + (n - iw) * 0.25), Math.round(iw + (n - iw) * 0.75));
    if (b.angle > 20) { out.ForeArm = R[b.i].c; out.elbowBent = true; }
    else out.ForeArm = alongPolyline([out.Hand, ...R.slice(iw, n + 1).map(r => r.c), out.Arm], 0.46);
    out.tip = L.e.p;
    // The end of the hand: the middle of the rings at its very tip.
    out.end = R[Math.max(0, Math.min(iw - 1, Math.round(n * 0.02)))].c;
    return out;
  };
  // Legs hidden down to the floor: the hips where a figure's torso puts them (about 0.29 of its height below the
  // shoulders), a quarter of the way out from the middle on either side of the trunk there, the feet just above the
  // floor, the knees halfway, the toes forward.
  const hiddenLegs = shoulderH => {
    const hipH = Math.max(bottomH + 0.3 * H, shoulderH - 0.29 * H);
    const centre = centreAlong(g, toPlane(add(cen, scale(up, hipH - height(cen)))), front);
    const f = new Float64Array(g.n);
    for (let v = 0; v < g.n; v++) f[v] = body[v] ? height(pointOf(g, v)) : -Infinity;
    const loops = sliceLoops(g, f, triRange(g, f), hipH, plane).filter(l => l.min < 0 && l.max > 0);
    const half = loops.length ? Math.min(...loops.map(l => Math.min(-l.min, l.max))) : 0.1 * H;
    const out = {};
    for (const [s, sgn] of [['L', leftSign], ['R', -leftSign]]) {
      const across = scale(nrm, sgn * 0.5 * half);
      const hip = add(centre, across), foot = add(add(toPlane(add(centre, scale(up, bottomH + 0.05 * H - hipH))), across), scale(front, 0.01 * H));
      out[s] = {
        UpLeg: hip, Leg: lerp(hip, foot, 0.5), Foot: foot,
        ToeBase: add(add(foot, scale(front, 0.07 * H)), scale(up, -0.03 * H)), Toe_End: add(add(foot, scale(front, 0.11 * H)), scale(up, -0.035 * H)),
      };
    }
    return out;
  };
  const arms = { L: armOf(hands[S.L]), R: armOf(hands[S.R]) };
  const shoulderH = (height(arms.L.Arm) + height(arms.R.Arm)) / 2;
  const legs = hidden ? hiddenLegs(shoulderH) : { L: legOf(feet[S.L], shoulderH), R: legOf(feet[S.R], shoulderH) };
  for (const s of ['L', 'R']) {
    const pre = s === 'L' ? 'Left' : 'Right', leg = legs[s], arm = arms[s];
    const legHow = hidden ? 'estimated' : 'detected';
    put(`${pre}UpLeg`, leg.UpLeg, leg.hipGuess || hidden ? 'estimated' : 'detected'); put(`${pre}Leg`, leg.Leg, leg.kneeBent ? 'detected' : 'estimated');
    put(`${pre}Foot`, leg.Foot, leg.ankleGuess || hidden ? 'estimated' : 'detected'); put(`${pre}ToeBase`, leg.ToeBase, legHow); put(`${pre}Toe_End`, leg.Toe_End, legHow);
    put(`${pre}Arm`, arm.Arm); put(`${pre}ForeArm`, arm.ForeArm, arm.elbowBent ? 'detected' : 'estimated'); put(`${pre}Hand`, arm.Hand, arm.wristGuess ? 'estimated' : 'detected');
    put(`${pre}Hand_End`, arm.end);
  }
  // Head and neck: the neck at its narrowest, the head joint where the skull starts to widen above it, the neck joint
  // where the neck meets the shoulders.
  {
    const R = head.rings, n = head.j;
    let widest = 0;
    for (let i = 0; i <= Math.round(n * 0.6); i++) if (R[i].perimeter > R[widest].perimeter) widest = i;
    const shoulderH = (height(J.LeftArm) + height(J.RightArm)) / 2, topH = height(head.e.p);
    // The neck is low between the shoulders and the top of the head, in a person and a big-headed character alike;
    // narrowings higher up are hair (a bun, curls) or a hat.
    const lowest = shoulderH + 0.45 * (topH - shoulderH);
    let from = widest + 1;
    while (from < n && height(R[from].c) > lowest) from++;
    const ineck = narrowest(R, from, n);
    put('HeadTop_End', toPlane(head.e.p));
    if (ineck >= 0 && height(R[ineck].c) > shoulderH) {
      // The neck joint at the base of the neck, where it has flared by a third into the shoulders; the head joint where
      // the skull starts to widen above the neck, at most 0.3 of the way from there to the top.
      let ib = ineck;
      while (ib < n && R[ib].perimeter < 1.3 * R[ineck].perimeter) ib++;
      const neck = height(R[ib].c) > shoulderH ? R[ib].c : add(R[ib].c, scale(up, shoulderH - height(R[ib].c)));
      const ih = Math.round(widest + 0.7 * (ineck - widest)), cap = height(neck) + 0.3 * (topH - height(neck));
      put('Head', toPlane(height(R[ih].c) > cap ? add(R[ih].c, scale(up, cap - height(R[ih].c))) : R[ih].c));
      put('Neck', toPlane(neck));
    } else {
      // No neck to see (hair, a collar, a stylised head on the shoulders): the neck just above the shoulders, the head
      // joint a little above it, each centred front to back.
      const at = h => toPlane(centreAlong(g, toPlane(add(head.e.p, scale(up, h - topH))), [0, 0, 0].map((_, k) => cross(up, nrm)[k])));
      const neckH = shoulderH + 0.06 * (topH - shoulderH);
      put('Neck', at(neckH), 'estimated');
      put('Head', at(neckH + 0.15 * (topH - neckH)), 'estimated');
    }
  }
  // Hips just above the hip joints, centred front to back in the trunk; the spine evenly up to the neck. Front to
  // back the spine runs from the hips to the shoulder joints' line, as hair or a backpack on the back would pull a
  // centring through the trunk behind it. The neck and head stand on that line too.
  const hipH = (height(J.LeftUpLeg) + height(J.RightUpLeg)) / 2 + (feet ? 0.3 * feet[S.L].rings[Math.max(0, feet[S.L].j - 2)].radius : 0.02 * H);
  const onAxis = h => toPlane(add(cen, scale(up, h - height(cen))));
  const hips = toPlane(centreAlong(g, onAxis(hipH), front));
  put('Hips', hips);
  const fwd = p => dot(p, front), shoulderF = (fwd(J.LeftArm) + fwd(J.RightArm)) / 2;
  const neckH = height(J.Neck), headH = height(J.Head), topH = height(J.HeadTop_End);
  const at = (h, f) => add(add(scale(up, h), scale(front, f)), scale(nrm, plane.offset));
  const lean = h => fwd(hips) + (shoulderF - fwd(hips)) * Math.min(1, (h - hipH) / Math.max(1e-9, neckH - hipH));
  [['Spine', 0.2], ['Spine1', 0.43], ['Spine2', 0.67]].forEach(([slot, f]) => { const h = hipH + (neckH - hipH) * f; put(slot, at(h, lean(h)), placed[slot]); });
  put('Neck', at(neckH, shoulderF), placed.Neck);
  put('Head', at(headH, shoulderF), placed.Head);
  put('HeadTop_End', at(topH, shoulderF), placed.HeadTop_End);
  // Shoulders (clavicles): from beside the neck to each arm, at the arm's height.
  for (const s of ['L', 'R']) {
    const pre = s === 'L' ? 'Left' : 'Right', arm = J[`${pre}Arm`];
    const base = toPlane(add(J.Spine2, scale(up, height(arm) - height(J.Spine2))));
    put(`${pre}Shoulder`, lerp(base, arm, 0.25));
    // The shoulder joint sits midway through the arm front to back.
    J[`${pre}Arm`] = centreAlong(g, arm, front);
  }
  // Fingers (in place of the hands' end joints).
  const wantFingers = opt.fingers || 'auto';
  let fingers = false;
  if (wantFingers !== 'none') {
    const found = { L: null, R: null };
    for (const s of ['L', 'R']) found[s] = findFingers(g, hands[S[s]], arms[s], front, up, step, body);
    if (found.L && found.R) {
      fingers = true;
      for (const s of ['L', 'R']) for (const [k, p] of Object.entries(found[s])) put(`${s === 'L' ? 'Left' : 'Right'}Hand${k}`, p);
      delete J.LeftHand_End; delete J.RightHand_End;
    } else if (wantFingers === 'full') {
      fingers = true;
      for (const s of ['L', 'R']) {
        const pre = s === 'L' ? 'Left' : 'Right', w = J[`${pre}Hand`], tip = arms[s].tip, d = norm(sub(tip, w));
        const across = norm(sub(front, scale(d, dot(front, d))));
        const out = {};
        templateFingers(w, d, len(across) > 0.1 ? across : norm(cross(d, up)), dist(tip, w), 0.6 * dist(tip, w), '', out);
        for (const [k, p] of Object.entries(out)) put(`${pre}Hand${k}`, p, 'estimated');
      }
      delete J.LeftHand_End; delete J.RightHand_End;
      notes.push('The fingers could not be told apart, so they are laid out by a hand\'s proportions: check them.');
    }
  }
  // One side mirrors the other where the figure is symmetric (a raised arm would make the shape lopsided): each pair
  // is averaged with its mirror image, or takes the side that was found rather than estimated.
  const symmetric = plane.error < 0.01;
  if (symmetric) {
    for (const slot of Object.keys(J)) {
      if (slot.startsWith('Left')) {
        const other = mirrorSlot(slot);
        if (!J[other]) continue;
        const a = J[slot], b = mirror(J[other]), fa = placed[slot] !== 'estimated', fb = placed[other] !== 'estimated';
        const p = fa === fb ? lerp(a, b, 0.5) : fa ? a : b;
        J[slot] = p; J[other] = mirror(p);
        placed[slot] = placed[other] = fa || fb ? 'detected' : 'estimated';
      } else if (!slot.startsWith('Right')) J[slot] = toPlane(J[slot]);
    }
  }
  // On a base, a Root joint on the floor between the feet carries the base, so the figure moves on it.
  if (baseTop !== null) put('Root', toPlane(add(lerp(J.LeftFoot, J.RightFoot, 0.5), scale(up, floorH - height(J.LeftFoot)))));
  const rig = humanoidRig(J, { fingers, naming: opt.naming, placed, frame: { up, front }, plane: { axis: plane.axis, offset: plane.offset } });
  // Below this height (along up) the surface is the base, which the Root carries.
  if (baseTop !== null) rig.base = baseTop - 0.012 * H0;
  return { rig, report: { found: true, height: H, plane, symmetric, base: baseTop !== null, notes, ms: Date.now() - t0 } };
}

// Where a base the feet stand on ends: the bottom of the shape is one piece across the mirror plane, and higher up the
// shape narrows to legs standing apart, one to each side. The cut goes a little above where it has narrowed by a third,
// so a raised rim or what lies on the base goes with it. The height of the cut, or null when the feet reach the bottom
// (or a long skirt hides the legs).
function findBase(g, body, plane, up, floorH, H) {
  const f = new Float64Array(g.n);
  for (let v = 0; v < g.n; v++) f[v] = body[v] ? dot(pointOf(g, v), up) : -Infinity;
  const lohi = triRange(g, f), step = H / 300, extents = [];
  let extent0 = null;
  for (let i = 1; i < 120; i++) {
    const h = floorH + i * step, loops = sliceLoops(g, f, lohi, h, plane);
    if (!loops.length) continue;
    const wide = loops.some(l => l.min < -0.01 * H && l.max > 0.01 * H);
    const pos = loops.some(l => l.min > 0), neg = loops.some(l => l.max < 0);
    const extent = Math.max(...loops.map(l => l.max)) - Math.min(...loops.map(l => l.min));
    if (extent0 === null) {
      if (!wide) return null;
      extent0 = extent;
      continue;
    }
    extents[i] = extent;
    // Narrowed by a third to legs apart, or by a fifth in a step: a base's top edge narrows within 3% of the height,
    // where a long dress's flared hem only narrows gradually.
    if (!wide && pos && neg && extent < 0.7 * extent0) return h + 0.012 * H;
    if (extent >= 0.8 * extent0) continue;
    const back = extents[Math.max(1, i - Math.round((0.03 * H) / step))];
    return back !== undefined && back >= 0.92 * extent0 ? h + 0.012 * H : null;
  }
  return null;
}

// Whether the legs stand apart anywhere between heights from and to: a cross-section with a piece on each side of the
// mirror plane and none across it.
function legsApart(g, body, plane, up, from, to, H) {
  const f = new Float64Array(g.n);
  for (let v = 0; v < g.n; v++) f[v] = body[v] ? dot(pointOf(g, v), up) : -Infinity;
  const lohi = triRange(g, f);
  for (let h = from + 0.02 * H; h < to; h += H / 100) {
    const loops = sliceLoops(g, f, lohi, h, plane);
    if (loops.some(l => l.min > 0) && loops.some(l => l.max < 0) && !loops.some(l => l.min < -0.01 * H && l.max > 0.01 * H)) return true;
  }
  return false;
}

// The loops of the cross-section where f = h, each with how far its points reach to either side of the mirror plane
// ({ min, max }, signed distances).
function sliceLoops(g, f, lohi, h, plane) {
  const P = g.P, T = g.T, n = g.n, keyOf = (u, v) => (u < v ? u * n + v : v * n + u);
  const keys = [], side = [];
  for (let i = 0, tc = T.length / 3; i < tc; i++) {
    if (lohi[i * 2] > h || lohi[i * 2 + 1] <= h) continue;
    const vs = [T[i * 3], T[i * 3 + 1], T[i * 3 + 2]], ks = [], ss = [];
    for (let k = 0; k < 3; k++) {
      const u = vs[k], v = vs[(k + 1) % 3];
      if (!Number.isFinite(f[u]) || !Number.isFinite(f[v])) continue;
      if ((f[u] < h) !== (f[v] < h)) {
        const t = (h - f[u]) / (f[v] - f[u]);
        ks.push(keyOf(u, v));
        ss.push(P[u * 3 + plane.axis] + (P[v * 3 + plane.axis] - P[u * 3 + plane.axis]) * t - plane.offset);
      }
    }
    if (ks.length === 2) { keys.push(ks[0], ks[1]); side.push(ss[0], ss[1]); }
  }
  const S = keys.length / 2, parent = new Int32Array(S).map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const at = new Map();
  for (let i = 0; i < S; i++) for (const k of [keys[i * 2], keys[i * 2 + 1]]) { const j = at.get(k); if (j === undefined) at.set(k, i); else parent[find(i)] = find(j); }
  const loops = new Map();
  for (let i = 0; i < S; i++) {
    const r = find(i);
    if (!loops.has(r)) loops.set(r, { min: Infinity, max: -Infinity, count: 0 });
    const l = loops.get(r);
    l.min = Math.min(l.min, side[i * 2], side[i * 2 + 1]); l.max = Math.max(l.max, side[i * 2], side[i * 2 + 1]); l.count++;
  }
  return [...loops.values()].filter(l => l.count > 2);
}

// The template stood in the shape's bounds, every joint estimated: for shapes the head, hands and feet can't be read
// from. Up is the longer of the two axes along the mirror plane, the figure faces three.js's +Z way where it can.
function templateRig(g, body, lo, hi, plane, opt, notes, t0, known = {}) {
  const axes = [0, 1, 2].filter(k => k !== plane.axis);
  let upAxis = axes.reduce((a, b) => (hi[b] - lo[b] > hi[a] - lo[a] ? b : a), axes[0]);
  if (axes.includes(1) && hi[1] - lo[1] > 0.85 * (hi[upAxis] - lo[upAxis])) upAxis = 1;
  const up = known.up && known.up[upAxis] ? [...known.up] : [0, 0, 0];
  if (!up[upAxis]) up[upAxis] = 1;
  const frontAxis = axes.find(k => k !== upAxis), front = [0, 0, 0];
  // three.js's +Z way with Y up, Blender's -Y with Z up.
  front[frontAxis] = upAxis === 2 && frontAxis === 1 ? -1 : 1;
  const left = cross(up, front), H = hi[upAxis] - lo[upAxis];
  const base = [0, 0, 0];
  base[upAxis] = up[upAxis] > 0 ? lo[upAxis] : hi[upAxis]; base[plane.axis] = plane.offset; base[frontAxis] = (lo[frontAxis] + hi[frontAxis]) / 2;
  const J = {};
  for (const [slot, [x, y, z]] of Object.entries(TEMPLATE)) J[slot] = add(base, add(scale(left, x * H), add(scale(up, y * H), scale(front, z * H))));
  for (const pre of ['Left', 'Right']) {
    const w = J[`${pre}Hand`], d = norm(sub(w, J[`${pre}ForeArm`]));
    if (opt.fingers === 'full') {
      const out = {};
      templateFingers(w, d, front, HAND_TIP * H, 0.06 * H, '', out);
      for (const [k, p] of Object.entries(out)) J[`${pre}Hand${k}`] = p;
    } else J[`${pre}Hand_End`] = add(w, scale(d, HAND_TIP * H));
  }
  const placed = Object.fromEntries(Object.keys(J).map(k => [k, 'estimated']));
  const rig = humanoidRig(J, { fingers: opt.fingers === 'full', naming: opt.naming, placed, frame: { up, front }, plane: { axis: plane.axis, offset: plane.offset } });
  return { rig, report: { found: false, height: H, plane, symmetric: plane.error < 0.01, notes, ms: Date.now() - t0 } };
}

// The fingers of one hand, if it has them apart: { Thumb1..4, Index1..4, … } or null. The hand is the part past the
// wrist ring; its fingertips are the long-lived peaks of the distance from the wrist.
function findFingers(g, L, arm, front, up, step, body) {
  const R = L.rings, d = L.d;
  // The hand: what lies past the plane across the wrist, reached from the fingertip without crossing it. The wrist's
  // seeds are the hand's vertices next to the rest of the arm.
  const wristC = R[arm.iw].c, along = norm(sub(wristC, R[Math.min(L.j, arm.iw + Math.max(2, Math.round(L.j * 0.1)))].c));
  const past = v => dot(sub(pointOf(g, v), wristC), along) > 0;
  const hand = new Uint8Array(g.n), stack = [L.e.v], wrist = [];
  if (!past(L.e.v)) return null;
  hand[L.e.v] = 1;
  while (stack.length) {
    const v = stack.pop();
    for (let e = g.start[v]; e < g.start[v + 1]; e++) {
      const u = g.to[e];
      if (hand[u] || !body[u]) continue;
      if (past(u)) { hand[u] = 1; stack.push(u); } else if (!wrist.length || wrist[wrist.length - 1][0] !== v) wrist.push([v, 0]);
    }
  }
  void d;
  if (wrist.length < 3) return null;
  const fromWrist = dijkstra(g, wrist, hand);
  let reach = 0;
  for (let v = 0; v < g.n; v++) if (hand[v] && Number.isFinite(fromWrist.d[v])) reach = Math.max(reach, fromWrist.d[v]);
  const tips = peaks(g, fromWrist.d, hand).filter(p => p.persistence > 0.18 * reach).slice(0, 5);
  if (tips.length < 5) return null;
  const wr = arm.Hand, dir = norm(sub(arm.tip, wr));
  // The thumb branches off nearest the wrist.
  const saddleD = p => (p.saddle >= 0 ? fromWrist.d[p.saddle] : Infinity);
  tips.sort((a, b) => saddleD(a) - saddleD(b));
  const thumb = tips[0], others = tips.slice(1);
  // The others in order from the thumb's side: across the hand, away from the thumb.
  const across = norm(sub(sub(pointOf(g, thumb.v), wr), scale(dir, dot(sub(pointOf(g, thumb.v), wr), dir))));
  others.sort((a, b) => dot(sub(pointOf(g, b.v), wr), across) - dot(sub(pointOf(g, a.v), wr), across));
  const out = {};
  const finger = (tip, name, back, ratios) => {
    const { rings } = trace(g, tip.v, wrist[0][0], step * 0.5, hand);
    if (rings.length < 4) return false;
    const lenTip = tip.persistence === Infinity ? Math.max(...others.map(o => (o.persistence === Infinity ? 0 : o.persistence))) : tip.persistence;
    const n = Math.min(rings.length - 1, Math.max(3, rings.findIndex(r => r.t >= lenTip) - 1));
    const baseR = rings[n].c, dirF = norm(sub(baseR, rings[Math.round(n * 0.35)].c));
    const knuckle = add(baseR, scale(dirF, back * lenTip));
    const tipEnd = rings[Math.max(0, Math.round(n * 0.06))].c;
    const line = [knuckle, ...rings.slice(0, n + 1).map(r => r.c).reverse()];
    line.push(tipEnd);
    out[`${name}1`] = knuckle;
    out[`${name}2`] = alongPolyline([knuckle, ...rings.slice(0, n + 1).map(r => r.c).reverse()], ratios[0]);
    out[`${name}3`] = alongPolyline([knuckle, ...rings.slice(0, n + 1).map(r => r.c).reverse()], ratios[1]);
    out[`${name}4`] = tipEnd;
    return true;
  };
  if (!finger(thumb, 'Thumb', 0.45, [0.4, 0.73])) return null;
  const names = ['Index', 'Middle', 'Ring', 'Pinky'];
  for (let i = 0; i < 4; i++) if (!finger(others[i], names[i], 0.3, [0.45, 0.75])) return null;
  void front; void up;
  return out;
}

// ---------- test motions ----------
//
// Short loops that bend the joints the way animation will, to see how the weights hold: on humanoid slots, and for any
// skeleton every joint in turn. Rotations are about each joint's own axes: X bends (elbows, knees, the spine and fingers
// forward, thighs forward with a positive angle), Y twists along the bone, Z raises an arm away from the body. The left
// side's rotation is mirrored onto the right (x, −y, −z), so both sides move alike.
export const MOTIONS = ['walk', 'arms', 'squat', 'twist', 'each'];
const deg = Math.PI / 180;
const qx = a => qaxis([1, 0, 0], a), qy = a => qaxis([0, 1, 0], a), qz = a => qaxis([0, 0, 1], a);
export const mirrorDelta = q => [q[0], -q[1], -q[2], q[3]];

// The pose of motion `name` at time t (in loops; any number): { pose: quaternion or null per joint, rootOffset,
// offsetJoint }, the offset moving the hips when a Root carries a base, the whole figure otherwise.
export function testPose(rig, name, t) {
  const B = rig.joints.length, pose = new Array(B).fill(null), at = new Map(rig.joints.map((j, i) => [j.slot, i]));
  const s = Math.sin(2 * Math.PI * t), c = Math.cos(2 * Math.PI * t), half = Math.sin(Math.PI * t) ** 2;
  // Sets a slot's rotation; for a left slot the right one gets its mirror image (or `right`, given its own).
  const set = (slot, q, right = null) => {
    if (at.has(slot)) pose[at.get(slot)] = q;
    if (slot.startsWith('Left')) { const r = `Right${slot.slice(4)}`; if (at.has(r)) pose[at.get(r)] = right || mirrorDelta(q); }
  };
  let rootOffset = null;
  const offsetJoint = at.has('Root') && at.has('Hips') ? at.get('Hips') : -1;
  const hips = at.has('Hips') ? rig.joints[at.get('Hips')] : null, feet = at.has('LeftFoot') ? rig.joints[at.get('LeftFoot')] : null;
  const legLength = hips && feet ? Math.abs(dot(sub(hips.pos, feet.pos), rig.frame.up)) : 0;
  // Where the hips go with the thigh turned forward by a and the knee bent back by k, the feet staying put: down by the
  // height the bent leg loses, back by how far the knee would carry the foot forward.
  const thigh = at.has('LeftUpLeg') && at.has('LeftLeg') ? dist(rig.joints[at.get('LeftUpLeg')].pos, rig.joints[at.get('LeftLeg')].pos) : legLength / 2;
  const shin = at.has('LeftLeg') && feet ? dist(rig.joints[at.get('LeftLeg')].pos, feet.pos) : legLength / 2;
  const hipsFor = (a, k) => add(scale(rig.frame.up, -(thigh + shin - (thigh * Math.cos(a) + shin * Math.cos(k - a)))), scale(rig.frame.front, -(thigh * Math.sin(a) - shin * Math.sin(k - a))));
  if (name === 'each' || !hips) {
    // Every deforming joint bends forward and back in turn.
    const order = rig.joints.map((j, i) => i).filter(i => rig.joints[i].deform && rig.joints[i].parent >= 0);
    if (!order.length) return { pose, rootOffset, offsetJoint };
    const k = ((t % 1) + 1) % 1 * order.length, i = order[Math.floor(k)], f = k - Math.floor(k);
    pose[i] = qx(45 * deg * Math.sin(2 * Math.PI * f));
    return { pose, rootOffset, offsetJoint };
  }
  if (name === 'walk') {
    set('LeftUpLeg', qx(28 * deg * s), qx(-28 * deg * s));
    set('LeftLeg', qx(-(35 * Math.max(0, -s) + 8) * deg), qx(-(35 * Math.max(0, s) + 8) * deg));
    set('LeftFoot', qx(10 * deg * s), qx(-10 * deg * s));
    set('LeftArm', qx(-22 * deg * s), qx(22 * deg * s));
    set('LeftForeArm', qx(18 * deg), qx(18 * deg));
    set('Spine1', qy(6 * deg * s));
    set('Spine2', qy(6 * deg * s));
    rootOffset = scale(rig.frame.up, -0.02 * legLength * Math.abs(c));
  } else if (name === 'arms') {
    // Arms up over the head and down to the sides, the elbows bending on the way.
    set('LeftShoulder', qz(12 * deg * s));
    set('LeftArm', qz(70 * deg * s));
    set('LeftForeArm', qx(60 * deg * half));
    set('LeftHand', qx(30 * deg * s));
    for (const f of FINGERS) for (const k of [1, 2, 3]) set(`LeftHand${f}${k}`, qx((f === 'Thumb' ? 25 : 55) * deg * half));
  } else if (name === 'squat') {
    // A deep knee bend with the feet flat where they stand: thighs forward, knees back, the hips down as far as that
    // takes them, ankles turned to keep the feet flat, the back leaning forward and the arms out for balance.
    const a = 80 * deg * half, k = 115 * deg * half;
    rootOffset = hipsFor(a, k);
    set('LeftUpLeg', qx(a));
    set('LeftLeg', qx(-k));
    set('LeftFoot', qx(k - a));
    set('Spine', qx(25 * deg * half));
    set('LeftArm', qx(55 * deg * half));
  } else if (name === 'twist') {
    set('Spine', qy(15 * deg * s));
    set('Spine1', qy(15 * deg * s));
    set('Spine2', qy(15 * deg * s));
    set('Neck', qy(25 * deg * s));
    set('Head', qx(20 * deg * c));
  }
  return { pose, rootOffset, offsetJoint };
}

// ---------- a skeleton from the file ----------

// The humanoid slot a file's bone name stands for, if any: Mixamo's names with or without their prefix, Unreal's
// mannequin names, and the common Left/Right, _l/_r, .L/.R spellings of them.
const UNREAL_SLOT = Object.fromEntries(Object.entries(UNREAL).map(([k, v]) => [v, k]));
export function slotOfName(name) {
  const bare = String(name).replace(/^.*[:|]/, '');
  if (humanoidSlots(true, true).some(s => s.slot === bare)) return bare;
  if (UNREAL_SLOT[bare.toLowerCase()]) return UNREAL_SLOT[bare.toLowerCase()];
  const m = /^(.+?)[._](l|r)$/i.exec(bare);
  if (m) {
    const base = UNREAL_SLOT[m[1].toLowerCase()], side = m[2].toLowerCase() === 'l' ? 'Left' : 'Right';
    if (base) return `${side}${base}`;
    const f = /^(thumb|index|middle|ring|pinky)_0(\d)$/i.exec(m[1]);
    if (f) return `${side}Hand${f[1][0].toUpperCase()}${f[1].slice(1).toLowerCase()}${f[2]}`;
  }
  return null;
}
// Which side a name says a bone is on: Left/Right, or L/R as a separate token (upperarm_l, Arm.L, Bip01 L Thigh).
const SIDE_TOKEN = /(^|[\s._:|-])([lr])(?=$|[\s._|-])/i;
function sideOfName(name) {
  const s = String(name).replace(/^.*[:|]/, '');
  if (/left/i.test(s)) return 'L';
  if (/right/i.test(s)) return 'R';
  const m = SIDE_TOKEN.exec(s);
  return m ? (m[2].toLowerCase() === 'l' ? 'L' : 'R') : 'C';
}
// The same name for the other side.
function otherSide(name) {
  const s = String(name), swap = { l: 'r', r: 'l', L: 'R', R: 'L' };
  if (/Left/.test(s)) return s.replace(/Left/g, 'Right');
  if (/Right/.test(s)) return s.replace(/Right/g, 'Left');
  if (/left/i.test(s)) return s.replace(/left/gi, w => (w[0] === 'L' ? 'Right' : 'right'));
  if (/right/i.test(s)) return s.replace(/right/gi, w => (w[0] === 'R' ? 'Left' : 'left'));
  return s.replace(SIDE_TOKEN, (m, pre, c) => `${pre}${swap[c]}`);
}
export const isHumanoid = rig => !!rig && (rig.template === 'humanoid' || !!rig.humanoid);

// A rig of the file's own bones (collect.js skin.bones), parents first, each keeping its rest place and orientation so
// animations made for it still fit. plane: the model's mirror plane, for mirror editing (null if it isn't symmetric).
export function rigFromSkeleton(bones, plane = null) {
  const n = bones.length, order = [], placed = new Uint8Array(n), kids = bones.map(() => []);
  bones.forEach((b, i) => { if (b.parent >= 0) kids[b.parent].push(i); });
  const visit = i => { placed[i] = 1; order.push(i); for (const c of kids[i]) visit(c); };
  bones.forEach((b, i) => { if (b.parent < 0 || b.parent >= n) visit(i); });
  bones.forEach((b, i) => { if (!placed[i]) visit(i); });
  const at = new Int32Array(n);
  order.forEach((old, k) => { at[old] = k; });
  const joints = order.map(old => {
    const b = bones[old], m = b.matrix;
    // The rotation of the rest matrix, its axes freed of any scale.
    const x = norm([m[0], m[1], m[2]]), y0 = [m[4], m[5], m[6]], y = norm(sub(y0, scale(x, dot(y0, x)))), z = cross(x, y);
    return {
      name: b.name, slot: slotOfName(b.name), parent: b.parent >= 0 && b.parent < n ? at[b.parent] : -1, pos: [m[12], m[13], m[14]],
      rot: quatFromAxes(x, y, z), deform: b.deform !== false, side: sideOfName(b.name), mirror: -1, placed: 'detected', keepRot: true,
    };
  });
  const byName = new Map(joints.map((j, i) => [j.name, i]));
  joints.forEach(j => { if (j.side !== 'C') { const m = byName.get(otherSide(j.name)); if (m !== undefined && joints[m].side !== j.side) j.mirror = m; } });
  const humanoid = joints.some(j => j.slot === 'Hips');
  return { version: RIG_VERSION, template: 'original', humanoid, fingers: joints.some(j => /Hand(Index|Middle)\d/.test(j.slot || '')), naming: 'file', frame: frameOf(), plane, joints };
}
