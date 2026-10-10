// Rigging: the humanoid skeleton and its rest orientations, skin weights on the result's distinct positions, posing,
// and FBX and GLB files that carry the skeleton and the weights the way three.js and Assimp read them.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { THREE, core, S, settings, check, sceneOf, context, collectScene } from './helpers.js';
import { figure, figureJoints } from './figure.js';
import * as R from '../src/rig.js';
import * as K from '../src/skin.js';
import { glbBytes } from '../src/glb.js';
import { run } from '../cli/pipeline.mjs';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const template = JSON.parse(fs.readFileSync(new URL('../src/fbx_template.json', import.meta.url), 'utf8'));
const ajs = await createRequire(import.meta.url)('assimpjs')();
// GLTFExporter reads its output through a FileReader, and GLTFLoader looks for `self`.
globalThis.FileReader ??= class { readAsArrayBuffer(blob) { blob.arrayBuffer().then(b => { this.result = b; this.onloadend(); }); } };
globalThis.self ??= globalThis;

const reduceTo = (w, st) => core.runReduction(S, context(w), null, { ...settings, deferUV: false, bakeSize: 1024, symmetry: null, ...st }, { normals: 'smooth' }).result;
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const angle = (a, b) => (Math.acos(Math.min(1, Math.max(-1, R.dot(R.norm(a), R.norm(b))))) * 180) / Math.PI;

console.log('== skeleton');
const tJoints = figureJoints({ pose: 'T', fingers: false });
const rig = R.humanoidRig(tJoints, { fingers: false });
{
  const kids = R.childrenOf(rig);
  let worst = 0;
  rig.joints.forEach((j, i) => {
    const c = R.mainChild(rig, i, kids);
    if (c >= 0) worst = Math.max(worst, angle(R.qrot(j.rot, [0, 1, 0]), R.sub(rig.joints[c].pos, j.pos)));
  });
  check(rig.joints.length === 25 && worst < 1e-4, `${rig.joints.length} joints, each one's +Y along its bone (worst ${worst.toExponential(1)}°)`);
  check(rig.joints.every((j, i) => j.parent < i), 'parents come before their children');
  // Mirrored joints have mirrored axes: Y reflects, X is reflected and turned round, so a turn about X bends both alike.
  const M = v => [-v[0], v[1], v[2]];
  let off = 0;
  for (const j of rig.joints) {
    if (j.side !== 'L') continue;
    const m = rig.joints[j.mirror];
    off = Math.max(off, angle(R.qrot(m.rot, [0, 1, 0]), M(R.qrot(j.rot, [0, 1, 0]))), angle(R.qrot(m.rot, [1, 0, 0]), R.scale(M(R.qrot(j.rot, [1, 0, 0])), -1)));
  }
  check(off < 1e-4, `left and right joints are oriented as mirror images (worst ${off.toExponential(1)}°)`);
  const knee = rig.joints.find(j => j.slot === 'LeftLeg'), elbow = rig.joints.find(j => j.slot === 'LeftForeArm');
  check(angle(R.qrot(knee.rot, [1, 0, 0]), [1, 0, 0]) > 179 || angle(R.qrot(knee.rot, [1, 0, 0]), [1, 0, 0]) < 1, 'the knee hinges about the left-right axis');
  check(angle(R.qrot(elbow.rot, [1, 0, 0]), [0, 1, 0]) > 179 || angle(R.qrot(elbow.rot, [1, 0, 0]), [0, 1, 0]) < 1, 'a T-pose elbow hinges about the up axis, bending the forearm forward');
  const un = R.renameRig(R.cloneRig(rig), 'unreal');
  check(['pelvis', 'spine_03', 'clavicle_l', 'upperarm_r', 'lowerarm_l', 'thigh_r', 'calf_l', 'ball_r'].every(n => un.joints.some(j => j.name === n)), 'Unreal names: pelvis, spine_03, clavicle_l, upperarm_r, …');
  const fing = R.humanoidRig(figureJoints({ pose: 'A', fingers: true }));
  check(fing.fingers && fing.joints.length === 65 && R.boneName('LeftHandIndex2', 'unreal') === 'index_02_l', `with fingers: ${fing.joints.length} joints`);
}

console.log('== finding the skeleton');
// Figures in a T and an A pose, with mitten hands and with fingers apart, and one on a base, remeshed to triangles as
// the app's result: every joint near where the figure was built on, and the fingers found only where they are apart.
for (const [pose, fingers, base] of [['T', false, false], ['A', false, false], ['T', true, false], ['A', true, false], ['A', false, true]]) {
  const f = figure({ pose, fingers, base, step: fingers ? 0.006 : 0.01 });
  const fw = core.smartWeld(sceneOf(f.geometry, 'Figure'), { keepUV: false, hardAngle: 30 });
  const r = reduceTo(fw, { targetTris: 24000 });
  const t = Date.now();
  const { rig: placed, report } = R.placeHumanoid(r, { fingers: 'auto' });
  const ms = Date.now() - t, H = 1.77;
  let worst = 0, at = '';
  for (const j of placed.joints) {
    if (!f.joints[j.slot]) continue;
    const e = R.dist(j.pos, f.joints[j.slot]);
    if (e > worst) { worst = e; at = j.slot; }
  }
  const label = `${pose} pose${fingers ? ', fingers' : ', mittens'}${base ? ', on a base' : ''}`;
  // Mittens get an end joint at the tip of each hand.
  const want = (fingers ? 65 : 27) + (base ? 1 : 0);
  check(report.found && placed.joints.length === want && placed.fingers === fingers && (!base || placed.joints[0].slot === 'Root'),
    `${label}: ${placed.joints.length} joints${base ? ', a Root carrying the base' : ''} (${ms} ms)`);
  check(worst < (base ? 0.05 : 0.03) * H, `${label}: every joint within ${base ? 5 : 3}% of the height of the truth (worst ${(worst * 100).toFixed(1)} cm, ${at})`);
  let sym = 0;
  for (const j of placed.joints) if (j.mirror >= 0) { const m = placed.joints[j.mirror].pos; sym = Math.max(sym, Math.hypot(j.pos[0] + m[0], j.pos[1] - m[1], j.pos[2] - m[2])); }
  check(sym < 1e-3 && R.dot(placed.frame.up, [0, 1, 0]) > 0.999 && R.dot(placed.frame.front, [0, 0, 1]) > 0.999, `${label}: symmetric, facing +Z with Y up`);
}
{
  // In a floor-length gown on a base: upright, the base on a Root, the legs laid out inside the dress (marked to check),
  // and the arms reaching the ends of the hands, the elbows where they are. As triangles and as quads, whose base (4 cm
  // thick, under 3% of the height) shows as a single step.
  const f = figure({ pose: 'A', fingers: false, base: true, gown: true, step: 0.01 });
  const fw = core.smartWeld(sceneOf(f.geometry, 'Figure'), { keepUV: false, hardAngle: 30 });
  for (const [label, st] of [['triangles', { targetTris: 24000 }], ['quads', { targetTris: 16000, topology: 'quads' }]]) {
    const r = reduceTo(fw, st);
    const { rig: g, report } = R.placeHumanoid(r, { fingers: 'auto' });
    const at = slot => g.joints.find(j => j.slot === slot);
    const legs = ['UpLeg', 'Leg', 'Foot'].flatMap(k => ['Left', 'Right'].map(sd => at(`${sd}${k}`)));
    const hip = at('LeftUpLeg').pos, foot = at('LeftFoot').pos, end = at('LeftHand_End').pos, tip = f.joints.LeftHand.map((x, k) => x + [0.766, -0.643, 0][k] * 0.17);
    const elbow = R.dist(at('LeftForeArm').pos, f.joints.LeftForeArm);
    check(R.dot(g.frame.up, [0, 1, 0]) > 0.999 && g.joints[0].slot === 'Root' && g.joints.length === 28 && legs.every(j => j.placed === 'estimated') && g.hiddenLegs && report.notes.some(n => /hidden/.test(n)),
      `in a gown on a base (${label}): upright, a Root, ${g.joints.length} joints, the hidden legs laid out and marked to check`);
    check(hip[1] > 0.7 && hip[1] < 1.05 && foot[1] < 0.2 && hip[0] > 0.02 && R.dist(end, tip) < 0.06 && elbow < 0.03 * 1.77,
      `in a gown (${label}): the hips at ${hip[1].toFixed(2)} m, the feet at ${foot[1].toFixed(2)} m, the hand's end ${(R.dist(end, tip) * 100).toFixed(1)} cm from its tip, the elbow ${(elbow * 100).toFixed(1)} cm from its own`);
  }
}
{
  // The left arm in a bell sleeve, its cuff wider than the hand: the arm keeps narrowing up the sleeve past where a
  // wrist would be, so that side's wrist is not taken from it, and the other side's is mirrored over.
  const f = figure({ pose: 'A', fingers: false, sleeve: true, step: 0.01 });
  const fw = core.smartWeld(sceneOf(f.geometry, 'Figure'), { keepUV: false, hardAngle: 30 });
  for (const [label, st] of [['triangles', { targetTris: 24000 }], ['quads', { targetTris: 16000, topology: 'quads' }]]) {
    const { rig: placed } = R.placeHumanoid(reduceTo(fw, st), { fingers: 'auto' });
    const err = slot => R.dist(placed.joints.find(j => j.slot === slot).pos, f.joints[slot]);
    check(err('LeftHand') < 0.03 * 1.77 && err('LeftForeArm') < 0.03 * 1.77,
      `a bell sleeve (${label}): the wrist ${(err('LeftHand') * 100).toFixed(1)} cm and the elbow ${(err('LeftForeArm') * 100).toFixed(1)} cm from where they are`);
  }
}
{
  // Asked for fingers on mittens, the hands get them by a hand's proportions, marked for checking.
  const f = figure({ pose: 'T', fingers: false, step: 0.01 });
  const r = reduceTo(core.smartWeld(sceneOf(f.geometry, 'Figure'), { keepUV: false, hardAngle: 30 }), { targetTris: 24000 });
  const { rig: placed, report } = R.placeHumanoid(r, { fingers: 'full' });
  const est = placed.joints.filter(j => /Hand(Thumb|Index|Middle|Ring|Pinky)/.test(j.slot));
  check(est.length === 40 && est.every(j => j.placed === 'estimated') && report.notes.length === 1, `mittens with fingers asked for: ${est.length} finger joints laid out and marked estimated`);
  // The same figure lying along Z, as a scan saved Z up: up and front come out turned with it.
  const geo = f.geometry.clone().rotateX(Math.PI / 2);
  const rz = reduceTo(core.smartWeld(sceneOf(geo, 'Figure'), { keepUV: false, hardAngle: 30 }), { targetTris: 24000 });
  const { rig: pz } = R.placeHumanoid(rz, { fingers: 'none' });
  const head = pz.joints.find(j => j.slot === 'Head').pos;
  check(R.dot(pz.frame.up, [0, 0, 1]) > 0.999 && Math.abs(head[2] - 1.56) < 0.05, `a Z-up figure: up is +Z and the head at its height (${head[2].toFixed(2)} m)`);
}

console.log('== weights and posing');
const fig = figure({ pose: 'T', fingers: false, step: 0.01 });
const w = core.smartWeld(sceneOf(fig.geometry, 'Figure'), { keepUV: false, hardAngle: 30 });
const res = reduceTo(w, { targetTris: 6000 });
const groups = K.skinGroups(res);
const W = K.envelopeWeights(groups.positions, rig);
const gskin = K.limitWeights(W, groups.count, rig.joints.length);
const vskin = K.vertexSkin(groups.group, gskin);
{
  let bad = 0, over = 0;
  for (let g = 0; g < groups.count; g++) {
    let s = 0, n = 0;
    for (let k = 0; k < 4; k++) { s += gskin.weight[g * 4 + k]; if (gskin.weight[g * 4 + k] > 0) n++; }
    if (!near(s, 1, 1e-5)) bad++;
    if (n > 4) over++;
  }
  check(bad === 0 && over === 0 && gskin.unweighted === 0, `${groups.count} positions, every one's weights sum to 1 over at most 4 joints`);
  const id = K.poseMatrices(rig).skin;
  let maxId = 0;
  for (let i = 0; i < id.length; i++) maxId = Math.max(maxId, Math.abs(id[i] - (i % 16 % 5 === 0 ? 1 : 0)));
  check(maxId < 1e-9, 'at rest every joint\'s skinning matrix is the identity');
}

console.log('== automatic weights');
{
  const remesh = (geo, st = {}, fopt = { normals: 'smooth' }) => core.runReduction(S, context(core.smartWeld(sceneOf(geo, 'Figure'), { keepUV: false, hardAngle: 30 })), null,
    { ...settings, deferUV: false, bakeSize: 1024, symmetry: null, targetTris: 16000, topology: 'quads', ...st }, fopt).result;
  const figT = figure({ pose: 'T', fingers: false, step: 0.01 });
  const bones = R.humanoidRig(figT.joints, { fingers: false }), B = bones.joints.length, at = slot => bones.joints.findIndex(j => j.slot === slot);
  const segs = K.boneSegments(bones);
  for (const [label, r] of [['quads', remesh(figT.geometry)], ['triangles', reduceTo(core.smartWeld(sceneOf(figT.geometry, 'Figure'), { keepUV: false, hardAngle: 30 }), { targetTris: 24000 })]]) {
    const { W: HW, groups: hg, stats } = K.boneHeat(r, bones);
    let bad = 0, lo = Infinity, hi = -Infinity;
    for (let g2 = 0; g2 < hg.count; g2++) {
      let sum = 0;
      for (let b = 0; b < B; b++) { const x = HW[g2 * B + b]; sum += x; lo = Math.min(lo, x); hi = Math.max(hi, x); }
      if (Math.abs(sum - 1) > 1e-4) bad++;
    }
    check(bad === 0 && lo >= 0 && hi <= 1 + 1e-6, `${label}: ${hg.count} positions, weights between 0 and 1 summing to 1 (${stats.ms} ms)`);
    // Each limb mostly its own bone along its middle, and the elbow shared about evenly.
    const own = slot => {
      const b = at(slot);
      let sum = 0, n = 0;
      for (let g2 = 0; g2 < hg.count; g2++) {
        const p = [hg.positions[g2 * 3], hg.positions[g2 * 3 + 1], hg.positions[g2 * 3 + 2]];
        const s0 = segs[b], ab = R.sub(s0.b, s0.a), t = R.dot(R.sub(p, s0.a), ab) / R.dot(ab, ab);
        if (t < 0.3 || t > 0.7 || K.segmentDistance(p, s0) > 0.1) continue;
        sum += HW[g2 * B + b]; n++;
      }
      return sum / n;
    };
    const mids = ['LeftForeArm', 'LeftArm', 'LeftLeg', 'LeftUpLeg', 'Head'].map(sl => [sl, own(sl)]);
    check(mids.every(([, x]) => x > 0.8), `${label}: along the middle of a limb its own bone holds over 80% (${mids.map(([sl, x]) => `${sl} ${x.toFixed(2)}`).join(', ')})`);
    const e = bones.joints[at('LeftForeArm')].pos;
    const sample = dx => { let best = 0, bd = Infinity; for (let g2 = 0; g2 < hg.count; g2++) { const d = Math.hypot(hg.positions[g2 * 3] - e[0] - dx, hg.positions[g2 * 3 + 1] - e[1] - 0.045, hg.positions[g2 * 3 + 2] - e[2]); if (d < bd) { bd = d; best = g2; } } return [HW[best * B + at('LeftArm')], HW[best * B + at('LeftForeArm')]]; };
    const [a0, f0] = sample(0), [a1] = sample(-0.1), [, f1] = sample(0.1);
    check(Math.abs(a0 - f0) < 0.35 && a1 > 0.85 && f1 > 0.85, `${label}: the elbow blends upper arm and forearm (${a0.toFixed(2)} / ${f0.toFixed(2)}), 10 cm to either side one holds (${a1.toFixed(2)}, ${f1.toFixed(2)})`);
    // The front of the chest, far from the spine, stays the spine's: the arms and legs reach no further than about
    // twice the distance to the nearest bone.
    const limbs = ['LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg'].map(at);
    let limb = 0, n = 0;
    for (let g2 = 0; g2 < hg.count; g2++) {
      const p = [hg.positions[g2 * 3], hg.positions[g2 * 3 + 1], hg.positions[g2 * 3 + 2]];
      if (Math.abs(p[0]) > 0.06 || p[2] < 0.03 || p[1] < figT.joints.Spine1[1] || p[1] > figT.joints.Spine2[1]) continue;
      for (const b of limbs) limb += HW[g2 * B + b];
      n++;
    }
    check(n > 20 && limb / n < 0.05, `${label}: the middle of the chest takes ${(100 * limb / n).toFixed(1)}% from the arms and legs (${n} positions)`);
  }
  // Copies of a vertex along hard edges get the same weights: they are one position to the skin.
  {
    const r = remesh(figT.geometry, {}, { normals: 'crease', creaseAngle: 25 });
    const { W: HW, groups: hg } = K.boneHeat(r, bones), sk = K.vertexSkin(hg.group, K.limitWeights(HW, hg.count, B));
    const firstAt = new Map();
    let copies = 0, differ = 0;
    for (let v = 0; v < r.vertexCount; v++) {
      const k = `${r.positions[v * 3]},${r.positions[v * 3 + 1]},${r.positions[v * 3 + 2]}`, f0 = firstAt.get(k);
      if (f0 === undefined) { firstAt.set(k, v); continue; }
      copies++;
      for (let q = 0; q < 4; q++) if (sk.index[v * 4 + q] !== sk.index[f0 * 4 + q] || sk.weight[v * 4 + q] !== sk.weight[f0 * 4 + q]) differ++;
    }
    check(copies > 0 && differ === 0, `${copies} vertex copies along creases carry the same weights as their originals`);
  }
  // Mirrored: every vertex's weights are its partner's with left and right swapped.
  {
    const r = remesh(figT.geometry, { symmetry: { axis: 0, offset: 0, keepPositive: true } });
    const { W: HW, groups: hg } = K.boneHeat(r, bones);
    let worst = 0;
    for (let v = 0; v < r.vertexCount; v++) {
      const a = hg.group[v], m = hg.group[r.twin[v]];
      for (let b = 0; b < B; b++) worst = Math.max(worst, Math.abs(HW[a * B + b] - HW[m * B + (bones.joints[b].mirror >= 0 ? bones.joints[b].mirror : b)]));
    }
    check(worst === 0, `mirrored result: each vertex's weights are its mirror partner's, left and right swapped (worst ${worst})`);
  }
  // Eyes: separate spheres inside the head see no bone, so they move rigidly with the head.
  {
    const eye = x => { const e = new THREE.SphereGeometry(0.025, 16, 12).translate(x, 1.64, 0.05); e.deleteAttribute('uv'); return e; };
    const geo = mergeGeometries([figT.geometry, eye(0.04), eye(-0.04)]);
    const r = remesh(geo, { targetTris: 20000 });
    const { W: HW, groups: hg, stats } = K.boneHeat(r, bones);
    let inEyes = 0, onHead = 0;
    for (let g2 = 0; g2 < hg.count; g2++) {
      const p = [hg.positions[g2 * 3], hg.positions[g2 * 3 + 1], hg.positions[g2 * 3 + 2]];
      if (Math.min(R.dist(p, [0.04, 1.64, 0.05]), R.dist(p, [-0.04, 1.64, 0.05])) > 0.027) continue;
      inEyes++;
      if (HW[g2 * B + at('Head')] === 1) onHead++;

    }
    check(stats.rigidPieces >= 2 && inEyes > 0 && onHead === inEyes, `eyes inside the head: ${stats.rigidPieces} rigid pieces, ${onHead} of their ${inEyes} positions wholly on the head`);
  }
  // A figure on a base: the base goes wholly to the Root, the legs stay their own.
  {
    const f = figure({ pose: 'A', fingers: false, base: true, step: 0.01 });
    const r = remesh(f.geometry);
    const { rig: placed } = R.placeHumanoid(r, { fingers: 'none' });
    const { W: HW, groups: hg } = K.boneHeat(r, placed);
    const PB = placed.joints.length, root = placed.joints.findIndex(j => j.slot === 'Root'), shin = placed.joints.findIndex(j => j.slot === 'LeftLeg');
    let base = 0, onRoot = 0, shinOwn = 0, nShin = 0;
    for (let g2 = 0; g2 < hg.count; g2++) {
      const y = hg.positions[g2 * 3 + 1], x = hg.positions[g2 * 3];
      if (y < -0.02) { base++; if (HW[g2 * PB + root] > 0.95) onRoot++; }
      if (y > 0.25 && y < 0.35 && x > 0.05) { shinOwn += HW[g2 * PB + shin]; nShin++; }
    }
    check(base > 0 && onRoot === base && shinOwn / nShin > 0.8, `on a base: ${onRoot} of ${base} base positions on the Root (over 95%), the shin ${(shinOwn / nShin).toFixed(2)} its own`);
  }
  // A floor-length dress over hidden legs hangs from both thighs: the knees and feet move none of it, the front of
  // the skirt is shared between the two thighs, and in the walk it holds together instead of tearing between the legs.
  {
    const f = figure({ pose: 'A', fingers: false, base: true, gown: true, step: 0.01 });
    const r = remesh(f.geometry);
    const { rig: placed } = R.placeHumanoid(r, { fingers: 'none' });
    const { W: HW, groups: hg } = K.boneHeat(r, placed);
    const PB = placed.joints.length, ix = slot => placed.joints.findIndex(j => j.slot === slot);
    const lower = ['LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightLeg', 'RightFoot', 'RightToeBase'].map(ix);
    let below = 0, front = -1, fz = -Infinity;
    for (let g2 = 0; g2 < hg.count; g2++) {
      for (const b of lower) below += HW[g2 * PB + b];
      const p = [hg.positions[g2 * 3], hg.positions[g2 * 3 + 1], hg.positions[g2 * 3 + 2]];
      if (Math.abs(p[1] - 0.5) < 0.02 && Math.abs(p[0]) < 0.02 && p[2] > fz) { fz = p[2]; front = g2; }
    }
    const l = HW[front * PB + ix('LeftUpLeg')], rr = HW[front * PB + ix('RightUpLeg')];
    const sk = K.vertexSkin(hg.group, K.limitWeights(HW, hg.count, PB));
    const tp = R.testPose(placed, 'walk', 0.25), m = K.poseMatrices(placed, tp.pose, tp.rootOffset, tp.offsetJoint), Q = new Float32Array(r.positions.length);
    K.skinVertices(m.skin, sk.index, sk.weight, r.positions, null, Q, null);
    const hipsY = placed.joints[ix('Hips')].pos[1], P0 = r.positions, I = r.index, ratios = [];
    for (let t = 0; t < I.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = I[t + k], b = I[t + (k + 1) % 3];
      if (P0[a * 3 + 1] > hipsY || P0[a * 3 + 1] < 0.02) continue;
      const l0 = Math.hypot(P0[a * 3] - P0[b * 3], P0[a * 3 + 1] - P0[b * 3 + 1], P0[a * 3 + 2] - P0[b * 3 + 2]), l1 = Math.hypot(Q[a * 3] - Q[b * 3], Q[a * 3 + 1] - Q[b * 3 + 1], Q[a * 3 + 2] - Q[b * 3 + 2]);
      if (l0 > 0) ratios.push(Math.max(l1 / l0, l0 / l1));
    }
    ratios.sort((x, y) => x - y);
    const p99 = ratios[Math.floor(ratios.length * 0.99)];
    check(placed.hiddenLegs && below === 0 && l > 0.3 && rr > 0.3 && p99 < 1.6,
      `a dress over hidden legs: nothing on the knees and feet, the front of the skirt ${l.toFixed(2)} / ${rr.toFixed(2)} on the two thighs, walking it stretches 1% of its edges past ${p99.toFixed(2)}×`);
  }
  // A dense result solves quickly.
  {
    const r = reduceTo(core.smartWeld(sceneOf(figure({ pose: 'T', fingers: true, step: 0.006 }).geometry, 'Figure'), { keepUV: false, hardAngle: 30 }), { targetTris: 70000 });
    const fr = R.humanoidRig(figureJoints({ pose: 'T', fingers: true }));
    const { groups: hg, stats } = K.boneHeat(r, fr);
    check(stats.ms < 3000, `${hg.count} positions and ${fr.joints.length} joints weighted in ${stats.ms} ms`);
  }
}

console.log('== editing weights');
{
  const f = figure({ pose: 'T', fingers: false, step: 0.01 });
  const r = core.runReduction(S, context(core.smartWeld(sceneOf(f.geometry, 'Figure'), { keepUV: false, hardAngle: 30 })), null,
    { ...settings, deferUV: false, bakeSize: 1024, symmetry: null, targetTris: 16000, topology: 'quads' }, { normals: 'smooth' }).result;
  const bones = R.humanoidRig(f.joints, { fingers: false }), B = bones.joints.length, at = slot => bones.joints.findIndex(j => j.slot === slot);
  const { W, groups } = K.boneHeat(r, bones), G = groups.count, graph = R.meshGraph(r.positions, r.index);
  const sums = () => { let bad = 0; for (let g = 0; g < G; g++) { let t = 0; for (let b = 0; b < B; b++) t += W[g * B + b]; if (Math.abs(t - 1) > 1e-4) bad++; } return bad; };
  // Painting a joint's weight up and down: the rest make room or take it back, locked joints untouched.
  const fore = at('LeftForeArm'), arm = at('LeftArm'), locks = new Uint8Array(B);
  locks[arm] = 1;
  const armBefore = Array.from({ length: G }, (_, g) => W[g * B + arm]);
  let moved = 0;
  for (let g = 0; g < G; g++) if (W[g * B + fore] > 0.05) { K.setWeight(W, B, g, fore, W[g * B + fore] + 0.3, locks, arm); moved++; }
  for (let g = 0; g < G; g++) if (g % 3 === 0) K.setWeight(W, B, g, fore, 0, null, arm);
  const armKept = armBefore.every((x, g) => g % 3 === 0 || Math.abs(W[g * B + arm] - x) < 1e-6);
  check(moved > 0 && sums() === 0 && armKept, `painting ${moved} positions up and a third of them to zero: every position still sums to 1, the locked upper arm unchanged`);
  // Smoothing and cleaning.
  const all = [...Array(G).keys()];
  K.smoothWeights(W, B, graph, all, 0.5, null);
  const cleaned = K.cleanWeights(W, B, G, 0.05, 4);
  let over = 0;
  for (let g = 0; g < G; g++) { let n = 0; for (let b = 0; b < B; b++) if (W[g * B + b] > 0) n++; if (n > 4) over++; }
  check(sums() === 0 && over === 0 && cleaned > 0, `smoothed and cleaned (${cleaned} positions): at most 4 joints each, all summing to 1`);
  // Mirroring one side onto the other on a result that wasn't mirrored: each right position takes the left one's.
  for (let g = 0; g < G; g++) if (groups.positions[g * 3] > 0.3) K.setWeight(W, B, g, fore, 1, null, arm);
  const partners = K.mirrorPartners(groups.positions, G, { axis: 0, offset: 0 }, 0.02 * 2.6);
  const changed = K.mirrorSide(W, B, groups.positions, G, partners, bones, 'L');
  const tot = j => { let t = 0; for (let g = 0; g < G; g++) t += W[g * B + j]; return t; };
  const lf = tot(fore), rf = tot(at('RightForeArm'));
  check(changed > G * 0.4 && Math.abs(lf - rf) / lf < 0.05 && sums() === 0, `Mirror L→R: ${changed} right positions take their left partners' weights (forearm ${lf.toFixed(0)} against ${rf.toFixed(0)})`);
}

// A pose: the left forearm bent 70° about its hinge, the right thigh raised 45° and the spine turned 20°.
const POSE = { LeftForeArm: R.qaxis([1, 0, 0], (70 * Math.PI) / 180), RightUpLeg: R.qaxis([1, 0, 0], (-45 * Math.PI) / 180), Spine1: R.qaxis([0, 1, 0], (20 * Math.PI) / 180) };
const poseOf = r => r.joints.map(j => POSE[j.slot] || null);
const posed = (r, P, N, sk) => {
  const out = new Float32Array(P.length), outN = new Float32Array(P.length);
  K.skinVertices(K.poseMatrices(r, poseOf(r)).skin, sk.index, sk.weight, P, N, out, outN);
  return out;
};
const ours = posed(rig, res.positions, res.normals, vskin);
{
  // A vertex with no weight on a posed joint or anything below one stays put.
  const segs = K.boneSegments(rig), hand = rig.joints.findIndex(j => j.slot === 'LeftHand');
  const posedBelow = rig.joints.map(() => false);
  rig.joints.forEach((j, i) => { posedBelow[i] = !!POSE[j.slot] || (j.parent >= 0 && posedBelow[j.parent]); });
  let still = 0, handMove = 0, nHand = 0;
  for (let v = 0; v < res.vertexCount; v++) {
    const p = [res.positions[v * 3], res.positions[v * 3 + 1], res.positions[v * 3 + 2]];
    const moved = Math.hypot(ours[v * 3] - p[0], ours[v * 3 + 1] - p[1], ours[v * 3 + 2] - p[2]);
    let affected = false;
    for (let k = 0; k < 4; k++) if (vskin.weight[v * 4 + k] > 0 && posedBelow[vskin.index[v * 4 + k]]) affected = true;
    if (!affected) still = Math.max(still, moved);
    if (K.segmentDistance(p, segs[hand]) < 0.04) { handMove += moved; nHand++; }
  }
  check(still < 1e-6, `vertices weighted only to joints left at rest stay put (move ${still.toExponential(1)} m)`);
  check(nHand > 0 && handMove / nHand > 0.15, `the left hand swings with the forearm (${(handMove / nHand).toFixed(2)} m on average)`);
}

console.log('== test motions');
{
  const world = (r, out, slot) => { const i = r.joints.findIndex(j => j.slot === slot); return [out.world[i * 16 + 12], out.world[i * 16 + 13], out.world[i * 16 + 14]]; };
  for (const base of [false, true]) {
    const joints = { ...figureJoints({ pose: 'A', fingers: false }) };
    if (base) joints.Root = [0, -0.04, 0];
    const r = R.humanoidRig(joints, { fingers: false });
    // The squat at its deepest: the hips down, the feet where they stood, a base's Root unmoved.
    const sq = R.testPose(r, 'squat', 0.5), m = K.poseMatrices(r, sq.pose, sq.rootOffset, sq.offsetJoint);
    const foot = R.dist(world(r, m, 'LeftFoot'), joints.LeftFoot), hipDrop = joints.Hips[1] - world(r, m, 'Hips')[1];
    const rootStill = !base || R.dist(world(r, m, 'Root'), joints.Root) < 1e-9;
    check(foot < 0.03 && hipDrop > 0.25 && rootStill, `squat${base ? ' on a base' : ''}: the hips drop ${(hipDrop * 100).toFixed(0)} cm, the feet stay within ${(foot * 100).toFixed(1)} cm of where they stood${base ? ', the Root carrying the base stays put' : ''}`);
  }
  const r = R.humanoidRig(figureJoints({ pose: 'T', fingers: true }));
  let finite = true, moved = 0;
  for (const name of R.MOTIONS) for (const t of [0, 0.13, 0.37, 0.5, 0.81]) {
    const tp = R.testPose(r, name, t), m = K.poseMatrices(r, tp.pose, tp.rootOffset, tp.offsetJoint);
    finite = finite && m.world.every(Number.isFinite);
    if (tp.pose.some(Boolean)) moved++;
  }
  check(finite && moved >= R.MOTIONS.length * 4, `every test motion gives finite poses that move the skeleton (${moved} of ${R.MOTIONS.length * 5} samples)`);
  // Mirrored: the left arm raised in Arms is the right arm's mirror image.
  const tp = R.testPose(r, 'arms', 0.25), m = K.poseMatrices(r, tp.pose);
  const l = world(r, m, 'LeftHand'), rr = world(r, m, 'RightHand');
  check(Math.abs(l[0] + rr[0]) < 1e-9 && Math.abs(l[1] - rr[1]) < 1e-9 && l[1] > 1.6, `Arms raises both hands alike, over the head (${l[1].toFixed(2)} m)`);
  // Arms already lowered (an A-pose) go down to the sides, not on through the body.
  const ra = R.humanoidRig(figureJoints({ pose: 'A', fingers: false }), { fingers: false });
  const down = R.testPose(ra, 'arms', 0.75), md = K.poseMatrices(ra, down.pose), hand = world(ra, md, 'LeftHand'), shoulder = world(ra, md, 'LeftArm');
  check(hand[0] > shoulder[0] && hand[1] < shoulder[1] - 0.4, `Arms on an A-pose lowers the hands to the sides (${(hand[0] * 100).toFixed(0)} cm out, the shoulder ${(shoulder[0] * 100).toFixed(0)} cm)`);
}

// Vertices of a loaded mesh (in the file's units, scale times the result's) matched to the result's by position.
function matchByPosition(P, Q, scale = 1) {
  const h = 1e-4, cell = (x, y, z) => `${Math.floor(x / h)},${Math.floor(y / h)},${Math.floor(z / h)}`;
  const at = new Map();
  for (let v = 0; v < P.length / 3; v++) {
    const k = cell(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    if (!at.has(k)) at.set(k, []);
    at.get(k).push(v);
  }
  const out = new Int32Array(Q.length / 3).fill(-1);
  for (let i = 0; i < out.length; i++) {
    const x = Q[i * 3] / scale, y = Q[i * 3 + 1] / scale, z = Q[i * 3 + 2] / scale;
    let best = 1e-5;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const v of at.get(cell(x + dx * h, y + dy * h, z + dz * h)) || []) {
        const d = Math.hypot(P[v * 3] - x, P[v * 3 + 1] - y, P[v * 3 + 2] - z);
        if (d < best) { best = d; out[i] = v; }
      }
    }
  }
  return out;
}
// A loaded skinned mesh posed like POSE (bone by name) and compared with our skinning: the worst distance, in units of
// the loaded file, after taking its scale out.
function comparePosed(root, scale, label) {
  let mesh = null;
  root.traverse(o => { if (o.isSkinnedMesh) mesh = o; });
  if (!mesh) { check(false, `${label}: a skinned mesh comes back`); return; }
  const byName = new Map(rig.joints.map(j => [j.name, j]));
  const bones = [];
  root.traverse(o => { if (o.isBone) bones.push(o); });
  check(bones.length === rig.joints.length && bones.every(b => byName.has(b.name)), `${label}: all ${bones.length} joints come back, by name`);
  const P = mesh.geometry.attributes.position.array;
  const match = matchByPosition(res.positions, P, scale);
  check(match.every(m => m >= 0), `${label}: every vertex lines up with the result's (${P.length / 3})`);
  // At rest, skinned = rest.
  root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let rest = 0;
  for (let i = 0; i < P.length / 3; i++) { mesh.getVertexPosition(i, v); rest = Math.max(rest, Math.hypot(v.x - P[i * 3], v.y - P[i * 3 + 1], v.z - P[i * 3 + 2])); }
  check(rest < 1e-5 * scale + 1e-7, `${label}: at its bind pose the skin leaves every vertex where it is (${rest.toExponential(1)})`);
  for (const b of bones) { const q = POSE[byName.get(b.name).slot]; if (q) b.quaternion.multiply(new THREE.Quaternion(...q)); }
  root.updateMatrixWorld(true);
  let worst = 0;
  for (let i = 0; i < P.length / 3; i++) {
    mesh.getVertexPosition(i, v);
    const o = match[i];
    worst = Math.max(worst, Math.hypot(v.x / scale - ours[o * 3], v.y / scale - ours[o * 3 + 1], v.z / scale - ours[o * 3 + 2]));
  }
  check(worst < 1e-4, `${label}: posed by its bones it matches the app's own skinning (worst ${worst.toExponential(1)} m)`);
}

console.log('== FBX');
const objects = core.exportObjects(res, w.parts || [{ name: 'Figure' }], [{ name: 'Skin', color: [0.8, 0.7, 0.6] }], true, 'Figure', vskin);
{
  const fbx = core.writeFBX(objects, { unitScale: 100, fileName: 'Figure.fbx', skeleton: R.exportSkeleton(rig, 1) }, template);
  const root = new FBXLoader().parse(fbx.buffer.slice(fbx.byteOffset, fbx.byteOffset + fbx.byteLength), '');
  comparePosed(root, 1, 'FBX');
  const list = new ajs.FileList();
  list.AddFile('m.fbx', fbx);
  const conv = ajs.ConvertFileList(list, 'assjson');
  const json = conv.IsSuccess() ? JSON.parse(new TextDecoder().decode(conv.GetFile(0).GetContent())) : null;
  const mesh = json && json.meshes[0];
  const sums = mesh ? new Float64Array(mesh.vertices.length / 3) : null;
  if (mesh) for (const b of mesh.bones || []) for (const [vi, wt] of b.weights) sums[vi] += wt;
  const deforming = new Set(gskin.index.filter((_, i) => gskin.weight[i] > 0)).size;
  check(mesh && (mesh.bones || []).length === deforming && sums.every(s => near(s, 1, 1e-4)),
    `Assimp reads ${mesh ? (mesh.bones || []).length : 0} bones with weights (${deforming} joints move vertices), each vertex's summing to 1`);
}

console.log('== GLB');
for (const scale of [1, 0.01]) {
  const glb = await glbBytes(objects, scale, R.exportSkeleton(rig, scale));
  const gltf = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '');
  comparePosed(gltf.scene, scale, `GLB at scale ${scale}`);
}

console.log("== a file's own skeleton");
// A rigged file opened again: its skeleton and weights come along, the joints where they were, oriented as they were,
// and the weights land back on the result's positions.
{
  const fbx = core.writeFBX(objects, { unitScale: 100, fileName: 'Figure.fbx', skeleton: R.exportSkeleton(rig, 1) }, template);
  const glb = await glbBytes(objects, 1, R.exportSkeleton(rig, 1));
  const fromFbx = collectScene(new FBXLoader().parse(fbx.buffer.slice(fbx.byteOffset, fbx.byteOffset + fbx.byteLength), ''));
  const fromGlb = collectScene((await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '')).scene);
  for (const [label, c] of [['FBX', fromFbx], ['GLB', fromGlb]]) {
    const fileRig = c.skin && R.rigFromSkeleton(c.skin.bones);
    if (!fileRig) { check(false, `${label}: the skeleton is read`); continue; }
    let off = 0, turn = 0;
    for (const j of fileRig.joints) {
      const o = rig.joints.find(k => k.name === j.name);
      if (!o) { off = Infinity; continue; }
      off = Math.max(off, R.dist(j.pos, o.pos));
      turn = Math.max(turn, angle(R.qrot(j.rot, [0, 1, 0]), R.qrot(o.rot, [0, 1, 0])), angle(R.qrot(j.rot, [1, 0, 0]), R.qrot(o.rot, [1, 0, 0])));
    }
    const paired = fileRig.joints.filter(j => j.side !== 'C').every(j => j.mirror >= 0 && fileRig.joints[j.mirror].mirror === fileRig.joints.indexOf(j));
    check(fileRig.joints.length === rig.joints.length && off < 1e-5 && turn < 1e-3, `${label}: ${fileRig.joints.length} joints back where they were (${off.toExponential(1)} m), turned as they were (${turn.toExponential(1)}°)`);
    check(R.isHumanoid(fileRig) && paired && fileRig.joints.every(j => j.slot === j.name), `${label}: read as a humanoid, every left joint paired with its right one by name`);
    const map = K.fileBoneMap(c.skin.bones, fileRig), B = fileRig.joints.length;
    const W = K.transferWeights(c.positions, c.skin.index.map(i => map[i]), c.skin.weight, 4, B, groups.positions, groups.count);
    let worst = 0;
    for (let g = 0; g < groups.count; g++) {
      for (let k = 0; k < 4; k++) {
        const w0 = gskin.weight[g * 4 + k];
        if (!w0) continue;
        const name = rig.joints[gskin.index[g * 4 + k]].name, b = fileRig.joints.findIndex(j => j.name === name);
        worst = Math.max(worst, Math.abs((b >= 0 ? W[g * B + b] : 0) - w0));
      }
    }
    check(worst < 0.01, `${label}: the file's weights carried onto the result by position differ from the exported ones by ${worst.toFixed(4)} at most`);
  }
}

console.log('== the command line');
// --rig humanoid on a figure written as an OBJ, then --rig original on the GLB that comes out: the same skeleton comes
// back by name, with its weights.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-budget-rig-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const f = figure({ pose: 'A', fingers: false, step: 0.01 }), g = f.geometry.toNonIndexed(), p = g.attributes.position, nrm = g.attributes.normal;
  const lines = ['o Figure'];
  for (let i = 0; i < p.count; i++) lines.push(`v ${p.getX(i)} ${p.getY(i)} ${p.getZ(i)}`);
  for (let i = 0; i < p.count; i++) lines.push(`vn ${nrm.getX(i)} ${nrm.getY(i)} ${nrm.getZ(i)}`);
  for (let i = 0; i < p.count; i += 3) lines.push(`f ${i + 1}//${i + 1} ${i + 2}//${i + 2} ${i + 3}//${i + 3}`);
  const obj = path.join(dir, 'figure.obj');
  fs.writeFileSync(obj, lines.join('\n'));
  const a = await run(obj, { budget: '6k', rig: 'humanoid', format: 'glb', measure: false, hidden: false });
  const g1 = a.report.rig;
  check(g1 && g1.skeleton === 'humanoid' && g1.joints === 27 && g1.weights.unweighted === 0 && /rigged: 27 joints/.test(a.files[0].note), `--rig humanoid: ${g1 && g1.joints} joints, weights by ${g1 && g1.weights.method}, the GLB rigged`);
  const glbFile = path.join(dir, a.files[0].name);
  fs.writeFileSync(glbFile, a.files[0].bytes);
  const b = await run(glbFile, { budget: '3k', rig: 'original', format: 'fbx', measure: false, hidden: false });
  const g2 = b.report.rig;
  const same = g2 && g1.bones.every(x => g2.bones.some(y => y.name === x.name && R.dist(y.position, x.position) < 1e-4));
  check(g2 && g2.skeleton === 'file' && g2.joints === g1.joints && same && g2.weights.unweighted === 0, `--rig original on that GLB: the same ${g2 && g2.joints} joints where they were, weights from the file`);
  let threw = false;
  try { await run(obj, { budget: '2k', rig: 'original', measure: false, hidden: false }); } catch (e) { threw = /no skeleton/.test(e.message); }
  check(threw, '--rig original on a model without a skeleton says so');
}
