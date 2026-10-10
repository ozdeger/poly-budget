import * as THREE from 'three';
import { computeSmoothNormals } from './core.js';

// Flattens every mesh under root into one world-space triangle soup with part and material ids. A skinned file also
// gives its skeleton: skin = { bones: [{ name, parent, matrix }], index, weight }, each bone's rest matrix in the same
// space as the positions (where the skin leaves the mesh as it is) and four joints and weights per vertex. Meshes that
// aren't skinned follow the bone they hang from, if any.
export function collectScene(root) {
  root.updateMatrixWorld(true);
  const parts = [], materials = [], matIndex = new Map(), chunks = [];
  let anyUV = false, anyColor = false, totalV = 0, totalI = 0;
  const v = new THREE.Vector3();
  const bones = [], boneIndex = new Map();
  root.traverse(obj => {
    if (!obj.isSkinnedMesh || !obj.skeleton) return;
    const toWorld = new THREE.Matrix4().multiplyMatrices(obj.matrixWorld, obj.bindMatrixInverse);
    obj.skeleton.bones.forEach((b, i) => {
      if (!b || boneIndex.has(b)) return;
      boneIndex.set(b, bones.length);
      const rest = new THREE.Matrix4().copy(obj.skeleton.boneInverses[i]).invert().premultiply(toWorld);
      bones.push({ bone: b, name: b.name || `Bone${bones.length}`, matrix: Float64Array.from(rest.elements), deform: true });
    });
  });
  // Bones no skin uses (end joints, helpers) come along too, where they stand, so the hierarchy stays the file's.
  if (bones.length) root.traverse(obj => {
    if (!obj.isBone || boneIndex.has(obj)) return;
    boneIndex.set(obj, bones.length);
    bones.push({ bone: obj, name: obj.name || `Bone${bones.length}`, matrix: Float64Array.from(obj.matrixWorld.elements), deform: false });
  });
  const boneAbove = obj => { for (let o = obj.parent; o; o = o.parent) if (boneIndex.has(o)) return boneIndex.get(o); return -1; };
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
    // Joints and weights per vertex, into the file's bone list.
    let SI = null, SW = null;
    if (bones.length) {
      SI = new Uint16Array(n * 4); SW = new Float32Array(n * 4);
      const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      if (obj.isSkinnedMesh && si && sw) {
        const map = obj.skeleton.bones.map(b => (boneIndex.has(b) ? boneIndex.get(b) : 0));
        for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) { SI[i * 4 + k] = map[si.getComponent(i, k)] ?? 0; SW[i * 4 + k] = sw.getComponent(i, k); }
      } else {
        const b = boneAbove(obj);
        if (b >= 0) for (let i = 0; i < n; i++) { SI[i * 4] = b; SW[i * 4] = 1; }
      }
    }
    const partId = parts.length;
    parts.push({ name: (obj.name || `Part${partId + 1}`).replace(/[^\w.-]+/g, '_'), triCount: T, hasUV: !!uv, skinned: !!obj.isSkinnedMesh });
    chunks.push({ P, N, U, C: Cc, idx, triMat, partId, n, SI, SW });
    anyUV = anyUV || !!uv;
    anyColor = anyColor || !!col;
    totalV += n;
    totalI += idx.length;
  });
  const positions = new Float32Array(totalV * 3), normals = new Float32Array(totalV * 3);
  const uvs = anyUV ? new Float32Array(totalV * 2) : null;
  const colors = anyColor ? new Float32Array(totalV * 3).fill(1) : null;
  const index = new Uint32Array(totalI), triPart = new Uint16Array(totalI / 3), triMat = new Uint16Array(totalI / 3);
  const skin = bones.length ? {
    bones: bones.map(b => ({ name: b.name, parent: boneAbove(b.bone), matrix: b.matrix, deform: b.deform })),
    index: new Uint16Array(totalV * 4), weight: new Float32Array(totalV * 4),
  } : null;
  let vo = 0, io = 0;
  for (const c of chunks) {
    if (skin) { skin.index.set(c.SI, vo * 4); skin.weight.set(c.SW, vo * 4); }
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
  return { positions, normals, uvs, colors, index, triPart, triMat, parts, materials, skin };
}
