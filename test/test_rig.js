// Rigging: the humanoid skeleton and its rest orientations, skin weights on the result's distinct positions, posing,
// and FBX and GLB files that carry the skeleton and the weights the way three.js and Assimp read them.
import fs from 'fs';
import { createRequire } from 'module';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { THREE, core, S, settings, check, sceneOf, context } from './helpers.js';
import { figure, figureJoints } from './figure.js';
import * as R from '../src/rig.js';
import * as K from '../src/skin.js';
import { glbBytes } from '../src/glb.js';

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
  const want = (fingers ? 65 : 25) + (base ? 1 : 0);
  check(report.found && placed.joints.length === want && placed.fingers === fingers && (!base || placed.joints[0].slot === 'Root'),
    `${label}: ${placed.joints.length} joints${base ? ', a Root carrying the base' : ''} (${ms} ms)`);
  check(worst < (base ? 0.05 : 0.03) * H, `${label}: every joint within ${base ? 5 : 3}% of the height of the truth (worst ${(worst * 100).toFixed(1)} cm, ${at})`);
  let sym = 0;
  for (const j of placed.joints) if (j.mirror >= 0) { const m = placed.joints[j.mirror].pos; sym = Math.max(sym, Math.hypot(j.pos[0] + m[0], j.pos[1] - m[1], j.pos[2] - m[2])); }
  check(sym < 1e-3 && R.dot(placed.frame.up, [0, 1, 0]) > 0.999 && R.dot(placed.frame.front, [0, 0, 1]) > 0.999, `${label}: symmetric, facing +Z with Y up`);
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
