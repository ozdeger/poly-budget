import * as THREE from 'three';
import { computeSmoothNormals } from './core.js';

// Flattens every mesh under root into one world-space triangle soup with part and material ids.
export function collectScene(root) {
  root.updateMatrixWorld(true);
  const parts = [], materials = [], matIndex = new Map(), chunks = [];
  let anyUV = false, anyColor = false, totalV = 0, totalI = 0;
  const v = new THREE.Vector3();
  root.traverse(obj => {
    if (!obj.isMesh || !obj.geometry || !obj.geometry.attributes.position) return;
    const g = obj.geometry;
    const pos = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv, col = g.attributes.color;
    const n = pos.count;
    const m = obj.matrixWorld, nm = new THREE.Matrix3().getNormalMatrix(m);
    const P = new Float32Array(n * 3);
    let N = nrm ? new Float32Array(n * 3) : null;
    const U = uv ? new Float32Array(n * 2) : null;
    const Cc = col ? new Float32Array(n * 3) : null;
    for (let i = 0; i < n; i++) {
      if (Cc) { Cc[i * 3] = col.getX(i); Cc[i * 3 + 1] = col.getY(i); Cc[i * 3 + 2] = col.getZ(i); }
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z;
      if (N) {
        v.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
        N[i * 3] = v.x; N[i * 3 + 1] = v.y; N[i * 3 + 2] = v.z;
      }
      if (U) { U[i * 2] = uv.getX(i); U[i * 2 + 1] = uv.getY(i); }
    }
    const idx = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: n }, (_, i) => i);
    if (m.determinant() < 0) {
      for (let t = 0; t < idx.length; t += 3) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
    }
    if (!N) N = computeSmoothNormals(P, idx);
    const T = idx.length / 3;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const toGlobal = mats.map(mt => {
      if (!matIndex.has(mt)) { matIndex.set(mt, materials.length); materials.push(mt); }
      return matIndex.get(mt);
    });
    const triMat = new Uint16Array(T).fill(toGlobal[0]);
    if (Array.isArray(obj.material) && g.groups.length) {
      for (const gr of g.groups) {
        const s = Math.floor(gr.start / 3), e = Math.min(T, Math.floor((gr.start + gr.count) / 3));
        for (let t = s; t < e; t++) triMat[t] = toGlobal[gr.materialIndex ?? 0] ?? toGlobal[0];
      }
    }
    const partId = parts.length;
    parts.push({ name: (obj.name || `Part${partId + 1}`).replace(/[^\w.-]+/g, '_'), triCount: T, hasUV: !!uv, skinned: !!obj.isSkinnedMesh });
    chunks.push({ P, N, U, C: Cc, idx, triMat, partId, n });
    anyUV = anyUV || !!uv;
    anyColor = anyColor || !!col;
    totalV += n;
    totalI += idx.length;
  });
  const positions = new Float32Array(totalV * 3), normals = new Float32Array(totalV * 3);
  const uvs = anyUV ? new Float32Array(totalV * 2) : null;
  const colors = anyColor ? new Float32Array(totalV * 3).fill(1) : null;
  const index = new Uint32Array(totalI), triPart = new Uint16Array(totalI / 3), triMat = new Uint16Array(totalI / 3);
  let vo = 0, io = 0;
  for (const c of chunks) {
    positions.set(c.P, vo * 3);
    normals.set(c.N, vo * 3);
    if (uvs && c.U) uvs.set(c.U, vo * 2);
    if (colors && c.C) colors.set(c.C, vo * 3);
    for (let k = 0; k < c.idx.length; k++) index[io + k] = c.idx[k] + vo;
    triPart.fill(c.partId, io / 3, (io + c.idx.length) / 3);
    triMat.set(c.triMat, io / 3);
    vo += c.n;
    io += c.idx.length;
  }
  return { positions, normals, uvs, colors, index, triPart, triMat, parts, materials };
}
