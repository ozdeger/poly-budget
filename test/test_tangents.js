// Tangents for normal maps: MikkTSpace-compatible, and oriented so the bitangent, cross(normal, tangent) * w, runs along
// +v in this tool's UV convention (v up), on a plain quad, on mirrored UVs, and across the rotated and mirrored charts of
// a real result.
import { MeshoptTangents } from 'meshoptimizer/tangents';
import { THREE, core, S, settings, check, bumpySphere, sceneOf, context } from './helpers.js';

await MeshoptTangents.ready;
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// A quad facing +Z with u along +X and v along +Y, then with u mirrored.
{
  const quad = uvs => ({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), uvs: new Float32Array(uvs), index: new Uint32Array([0, 1, 2, 0, 2, 3]) });
  const a = core.cornerTangents(MeshoptTangents, quad([0, 0, 1, 0, 1, 1, 0, 1])), b = core.cornerTangents(MeshoptTangents, quad([1, 0, 0, 0, 0, 1, 1, 1]));
  check(a.length === 24 && a[0] === 1 && a[3] === 1 && b[0] === -1 && b[3] === -1, `quad: tangent along +u with w = +1, mirrored u gives w = -1 (${[...a.subarray(0, 4)]} / ${[...b.subarray(0, 4)]})`);
}

// A remeshed, mirrored sphere with new UVs: on every triangle the tangent follows dP/du and the rebuilt bitangent dP/dv,
// on the kept half and on the mirrored half that shares its UVs.
{
  const w = core.smartWeld(sceneOf(bumpySphere(128, 64)), { keepUV: true, hardAngle: 30 });
  const { result: r } = core.runReduction(S, context(w), null, { ...settings, targetTris: 2400, topology: 'quads', symmetry: { axis: 0, offset: 0, keepPositive: true }, deferUV: false, bakeSize: 1024 }, { normals: 'smooth' });
  const tan = core.cornerTangents(MeshoptTangents, r), P = r.positions, U = r.uvs, N = r.normals, I = r.index;
  let agreeT = 0, agreeB = 0, total = 0, mirrored = 0;
  for (let t = 0; t < r.triCount; t++) {
    const [a, b, c] = [I[t * 3], I[t * 3 + 1], I[t * 3 + 2]];
    const e1 = [0, 1, 2].map(j => P[b * 3 + j] - P[a * 3 + j]), e2 = [0, 1, 2].map(j => P[c * 3 + j] - P[a * 3 + j]);
    const du1 = U[b * 2] - U[a * 2], dv1 = U[b * 2 + 1] - U[a * 2 + 1], du2 = U[c * 2] - U[a * 2], dv2 = U[c * 2 + 1] - U[a * 2 + 1];
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    const dPdu = e1.map((x, j) => (x * dv2 - e2[j] * dv1) / det), dPdv = e1.map((x, j) => (e2[j] * du1 - x * du2) / det);
    for (let k = 0; k < 3; k++) {
      const v = I[t * 3 + k], o = (t * 3 + k) * 4, n = [N[v * 3], N[v * 3 + 1], N[v * 3 + 2]], T = [tan[o], tan[o + 1], tan[o + 2]];
      const B = cross(n, T).map(x => x * tan[o + 3]);
      total++;
      if (dot(T, dPdu) > 0) agreeT++;
      if (dot(B, dPdv) > 0) agreeB++;
      if (tan[o + 3] < 0) mirrored++;
    }
  }
  check(agreeT / total > 0.99 && agreeB / total > 0.99 && mirrored > total * 0.3,
    `mirrored sphere: tangents follow +u on ${(100 * agreeT / total).toFixed(1)}% of corners, bitangents +v on ${(100 * agreeB / total).toFixed(1)}%, ${(100 * mirrored / total).toFixed(0)}% flipped`);
}

// The bake's ray directions: at a box corner, whose three faces each have their own copy of the vertex, the averaged
// direction points out along the diagonal instead of along one face.
{
  const w = core.smartWeld(sceneOf(new THREE.BoxGeometry(2, 2, 2)), { keepUV: false, hardAngle: 30 });
  const dirs = core.positionNormals(w);
  let worst = 0;
  for (let v = 0; v < w.vertexCount; v++) {
    const p = [w.positions[v * 3], w.positions[v * 3 + 1], w.positions[v * 3 + 2]], l = Math.hypot(...p);
    worst = Math.max(worst, Math.acos(Math.min(1, dot(p.map(x => x / l), [dirs[v * 3], dirs[v * 3 + 1], dirs[v * 3 + 2]]))));
  }
  check(w.vertexCount === 24 && worst < 1e-3, `box corners: ${w.vertexCount} split vertices, averaged directions along the diagonals (off by ${worst.toExponential(1)} rad)`);
}
