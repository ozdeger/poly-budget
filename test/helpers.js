import fs from 'fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import * as core from '../src/core.js';
import { collectScene } from '../src/collect.js';

// three.js loaders expect a browser: FBXLoader reads the window size for cameras, and textures aren't needed here.
globalThis.window = { innerWidth: 1920, innerHeight: 1080 };
THREE.TextureLoader.prototype.load = function (url) { const t = new THREE.Texture(); t.name = url; return t; };
await MeshoptSimplifier.ready;

export { THREE, core, collectScene };
export const S = MeshoptSimplifier;
export const settings = { maxError: 0, lockBorder: false, permissive: false, prune: false, regularize: 1, normalWeight: 0.5, uvWeight: 1, sloppy: false, optimizePositions: true, hardAngle: 30 };

let failures = 0;
export function check(ok, message) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) { failures++; process.exitCode = 1; }
}
process.on('exit', () => { if (failures) console.log(`${failures} check(s) failed`); });

export function timed(label, fn) {
  const t = Date.now(), r = fn();
  console.log(`     ${label}: ${Date.now() - t} ms`);
  return r;
}

// A bumpy sphere that is mirror-symmetric in X.
export function bumpySphere(w = 256, h = 128) {
  const geo = new THREE.SphereGeometry(1, w, h);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const s = 1 + 0.08 * Math.sin(9 * y) * Math.cos(7 * z) + 0.05 * Math.cos(12 * Math.abs(x));
    p.setXYZ(i, x * s, y * s, z * s);
  }
  geo.computeVertexNormals();
  return geo;
}

export function sceneOf(geo, name = 'Shape') {
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ name: `${name}Material` }));
  mesh.name = name;
  return collectScene(mesh);
}

// The worker's context for a welded mesh.
export function context(w) {
  const ctx = { mesh: { positions: w.positions, normals: w.normals, uvs: w.uvs, colors: w.colors, index: w.index, vPart: w.vPart, vMat: w.vMat, vertexCount: w.vertexCount, uvIsland: w.uvIsland }, half: null };
  ctx.packed = core.packAttributes(ctx.mesh);
  return ctx;
}

export function loadFBX(path) {
  const buf = fs.readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { src: collectScene(new FBXLoader().parse(ab, '')), ab };
}

// Texels (1024², centre sampling) covered by more than one triangle, the share of the sheet covered, UVs outside [0,1], NaNs.
export function layoutCheck(res, triEnd = res.index.length / 3) {
  const R = 1024, grid = new Uint8Array(R * R), uv = res.uvs, idx = res.index;
  let overlap = 0, covered = 0, outside = 0, nan = 0;
  for (let i = 0; i < uv.length; i++) { if (Number.isNaN(uv[i])) nan++; else if (uv[i] < -1e-6 || uv[i] > 1 + 1e-6) outside++; }
  for (let t = 0; t < triEnd; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    const ax = uv[a * 2] * R, ay = uv[a * 2 + 1] * R, bx = uv[b * 2] * R, by = uv[b * 2 + 1] * R, cx = uv[c * 2] * R, cy = uv[c * 2 + 1] * R;
    const s = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay) > 0 ? 1 : -1;
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5)), x1 = Math.min(R - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5)), y1 = Math.min(R - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
      const px = i + 0.5, py = j + 0.5;
      if (((bx - px) * (cy - py) - (cx - px) * (by - py)) * s <= 0) continue;
      if (((cx - px) * (ay - py) - (ax - px) * (cy - py)) * s <= 0) continue;
      if (((ax - px) * (by - py) - (bx - px) * (ay - py)) * s <= 0) continue;
      if (grid[j * R + i]) overlap++; else covered++;
      grid[j * R + i] = 1;
    }
  }
  return { overlap, covered: covered / (R * R), outside, nan };
}

// Open (one face) and non-manifold (3+ faces) edges once vertices are welded by position.
export function openEdges(res) {
  const q = 1e-5 * core.bounds(res.positions).diag, P = res.positions;
  const ids = new Map(), remap = new Uint32Array(res.positions.length / 3);
  for (let v = 0; v < remap.length; v++) {
    const k = `${Math.round(P[v * 3] / q)},${Math.round(P[v * 3 + 1] / q)},${Math.round(P[v * 3 + 2] / q)}`;
    if (!ids.has(k)) ids.set(k, ids.size);
    remap[v] = ids.get(k);
  }
  const edges = new Map(), idx = res.index;
  for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = remap[idx[t + k]], b = remap[idx[t + ((k + 1) % 3)]], key = a < b ? `${a}_${b}` : `${b}_${a}`;
    edges.set(key, (edges.get(key) || 0) + 1);
  }
  let open = 0, nonManifold = 0;
  for (const c of edges.values()) { if (c === 1) open++; else if (c > 2) nonManifold++; }
  return { open, nonManifold };
}
