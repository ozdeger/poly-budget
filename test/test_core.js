// Welding, painted reduction, normals and the FBX/OBJ writers. `node test/test_core.js model.fbx` also runs a real model.
import fs from 'fs';
import { createRequire } from 'module';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { THREE, core, S, settings, check, timed, bumpySphere, sceneOf, loadFBX } from './helpers.js';
const template = JSON.parse(fs.readFileSync(new URL('../src/fbx_template.json', import.meta.url), 'utf8'));
const ajs = await createRequire(import.meta.url)('assimpjs')();

console.log('== split-normal soup');
{
  const geo = new THREE.SphereGeometry(1, 64, 32).toNonIndexed();
  geo.computeVertexNormals();
  const w = core.smartWeld(sceneOf(geo), { keepUV: true, hardAngle: 30 });
  console.log(`     ${w.stats.storedRenderVertices} stored vertices, ${w.stats.uniquePositions} positions -> ${w.vertexCount} welded`);
  check(w.stats.storedRenderVertices >= w.triCount * 2, 'face corners are separate vertices before welding (over 2 per triangle)');
  check(w.vertexCount <= w.stats.uniquePositions * 1.3, 'welding merges them back to about one vertex per position and UV');
  const r = core.reduce(S, w, core.packAttributes(w), null, { ...settings, targetTris: 400 });
  check(Math.abs(r.index.length / 3 - 400) <= 8, `the welded soup reduces to its budget (${r.index.length / 3} of 400)`);
}

console.log('== painted reduction');
const src = sceneOf(bumpySphere(), 'Sphere');
const w = core.smartWeld(src, { keepUV: true, hardAngle: 30 });
const packed = core.packAttributes(w);
const P = w.positions;
const labels = new Int8Array(w.vertexCount), keep = new Int8Array(w.vertexCount);
for (let v = 0; v < w.vertexCount; v++) {
  const y = P[v * 3 + 1];
  if (y > 0.6) labels[v] = core.LABEL.MORE2;
  else if (y < -0.6) labels[v] = core.LABEL.LESS3;
  if (Math.hypot(P[v * 3], P[v * 3 + 1], P[v * 3 + 2] - 1) < 0.25) keep[v] = core.LABEL.KEEP;
}
const inRegion = (res, test) => { let n = 0; for (let t = 0; t < res.index.length; t += 3) { let k = 0; for (let j = 0; j < 3; j++) if (test(res.positions[res.index[t + j] * 3 + 1])) k++; if (k === 3) n++; } return n; };
const st = { ...settings, targetTris: 6000 };
const plain = timed('reduce', () => core.reduce(S, w, packed, null, st));
const painted = timed('reduce, painted', () => core.reduce(S, w, packed, labels, st));
const top = y => y > 0.6, bottom = y => y < -0.6;
console.log(`     top ${inRegion(plain, top)} -> ${inRegion(painted, top)} tris, bottom ${inRegion(plain, bottom)} -> ${inRegion(painted, bottom)}`);
check(inRegion(painted, top) > inRegion(plain, top) * 2, 'More ×4 keeps well over twice the triangles on the painted cap');
check(inRegion(painted, bottom) < inRegion(plain, bottom) * 0.5, 'Less ⅛ removes most triangles from the painted cap');
const kept = core.reduce(S, w, packed, keep, st);
const keptSet = new Set(kept.index);
let lockedKept = 0, lockedTotal = 0;
for (let v = 0; v < w.vertexCount; v++) if (keep[v]) { lockedTotal++; if (keptSet.has(v)) lockedKept++; }
check(lockedTotal > 0 && lockedKept === lockedTotal, `Keep original leaves every painted vertex in place (${lockedKept}/${lockedTotal})`);

console.log('== normals and export');
for (const normals of ['original', 'smooth', 'crease']) {
  const fin = core.finalize(w, painted, { normals, creaseAngle: 60 });
  check(!fin.normals.some(Number.isNaN) && fin.triCount === painted.index.length / 3, `${normals} normals: ${fin.triCount} tris, ${fin.vertexCount} verts, no NaN`);
}
const fin = core.finalize(w, painted, { normals: 'original' });
const mats = [{ name: 'SphereMaterial', color: [0.8, 0.7, 0.6], texture: 'Sphere_basecolor.png', normal: 'Sphere_normal.png' }];
const objects = core.exportObjects(fin, src.parts, mats, true, 'Sphere');
const fbx = core.writeFBX(objects, { unitScale: 100, fileName: 'Sphere.fbx' }, template);
let reloaded = null;
new FBXLoader().parse(fbx.buffer.slice(0), '').traverse(o => { if (o.isMesh) reloaded = o; });
check(reloaded && reloaded.geometry.attributes.position.count / 3 === fin.triCount, 'three.js reads the FBX back with the same triangle count');
check(reloaded && !!reloaded.geometry.attributes.uv && reloaded.material.map?.name === 'Sphere_basecolor' && reloaded.material.normalMap?.name === 'Sphere_normal', 'the FBX keeps UVs and links the base colour and normal textures');
check(core.readFbxUnitScale(fbx.buffer.slice(0)) === 100, 'the unit scale reads back');
const list = new ajs.FileList();
list.AddFile('m.fbx', fbx);
const conv = ajs.ConvertFileList(list, 'assjson');
const faces = conv.IsSuccess() ? JSON.parse(new TextDecoder().decode(conv.GetFile(0).GetContent())).meshes.reduce((n, m) => n + m.faces.length, 0) : -1;
check(faces === fin.triCount, `Assimp reads the FBX too (${faces} faces)`);
const { obj } = core.writeOBJ(objects, { scale: 0.01, mtlName: 'Sphere.mtl' });
let objTris = 0;
new OBJLoader().parse(obj).traverse(o => { if (o.isMesh) objTris += o.geometry.attributes.position.count / 3; });
check(objTris === fin.triCount, 'the OBJ has the same triangle count');

const modelPath = process.argv[2];
if (modelPath) {
  console.log(`== ${modelPath}`);
  const { src: real, ab } = timed('parse', () => loadFBX(modelPath));
  const rw = timed('weld', () => core.smartWeld(real, { keepUV: true, hardAngle: 30 }));
  console.log(`     ${rw.triCount} tris, ${rw.stats.storedRenderVertices} stored -> ${rw.vertexCount} welded vertices, ${rw.uvIslands} UV islands, unit scale ${core.readFbxUnitScale(ab)}`);
  const target = Math.max(100, Math.round(rw.triCount * 0.01));
  const rr = timed('reduce to 1%', () => core.reduce(S, rw, core.packAttributes(rw), null, { ...settings, targetTris: target }));
  console.log(`     -> ${rr.index.length / 3} tris (target ${target})`);
}
