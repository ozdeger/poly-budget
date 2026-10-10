// Skeletons for the result: the humanoid template, bone names for each engine, and each joint's rest orientation.
// No DOM and no three.js, so it runs in the page, the worker and Node alike.
//
// A rig is { version, template, fingers, naming, frame: { up, front, left }, plane, joints }. Each joint is
// { name, slot, parent, pos, rot, deform, side, mirror, placed }: pos in the model's own units (as the result's
// positions), rot its rest orientation in model space as a quaternion [x, y, z, w], parent and mirror joint indices
// (-1 for none), side 'L', 'R' or 'C', and placed 'detected', 'estimated' or 'user'. Parents always come before their
// children. A joint's bone runs from it to its main child; its +Y points along that bone and +X is its hinge, the axis
// elbows, knees, the spine and fingers bend about.

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

// The humanoid's joints in order, parents first: { slot, parent, side, deform }. Slots are Mixamo's joint names.
export function humanoidSlots(fingers = true) {
  const out = [];
  const add = (slot, parent, side = 'C', deform = true) => out.push({ slot, parent, side, deform });
  add('Hips', null); add('Spine', 'Hips'); add('Spine1', 'Spine'); add('Spine2', 'Spine1');
  add('Neck', 'Spine2'); add('Head', 'Neck'); add('HeadTop_End', 'Head', 'C', false);
  for (const [S, side] of SIDES) {
    add(`${S}Shoulder`, 'Spine2', side); add(`${S}Arm`, `${S}Shoulder`, side); add(`${S}ForeArm`, `${S}Arm`, side); add(`${S}Hand`, `${S}ForeArm`, side);
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
  Hips: 'pelvis', Spine: 'spine_01', Spine1: 'spine_02', Spine2: 'spine_03', Neck: 'neck_01', Head: 'head', HeadTop_End: 'head_end',
  Shoulder: 'clavicle', Arm: 'upperarm', ForeArm: 'lowerarm', Hand: 'hand', UpLeg: 'thigh', Leg: 'calf', Foot: 'foot', ToeBase: 'ball', Toe_End: 'ball_end',
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
  const slots = humanoidSlots(fingers).filter(s => positions[s.slot]);
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
