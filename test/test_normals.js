// Smooth normals taken from the dense source surface, and removing tiny floating parts.
import { THREE, core, S, settings, check, bumpySphere, sceneOf, context } from './helpers.js';

const angle = (N, a, M, b) => Math.acos(Math.max(-1, Math.min(1, N[a * 3] * M[b * 3] + N[a * 3 + 1] * M[b * 3 + 1] + N[a * 3 + 2] * M[b * 3 + 2]))) * 180 / Math.PI;

// Smooth: each vertex takes the smooth normal of the source surface at the vertex it came from.
{
  const w = core.smartWeld(sceneOf(bumpySphere(192, 96)), { keepUV: true, hardAngle: 30 });
  const smooth = core.computeSmoothNormals(w.positions, w.index);
  const { result } = core.runReduction(S, context(w), null, { ...settings, targetTris: 3000, uvMode: 'keep', symmetry: null }, { normals: 'smooth' });
  let close = 0;
  for (let v = 0; v < result.vertexCount; v++) if (angle(result.normals, v, smooth, result.srcId[v]) < 1) close++;
  check(close / result.vertexCount > 0.95, `smooth: ${((100 * close) / result.vertexCount).toFixed(1)}% of vertices take the source surface's normal (within 1°)`);
}
// Under symmetry the mirrored half gets mirrored normals and vertices on the plane point along it.
{
  const w = core.smartWeld(sceneOf(bumpySphere(192, 96)), { keepUV: true, hardAngle: 30 });
  const plane = { axis: 0, offset: 0, keepPositive: true };
  const { result: r } = core.runReduction(S, context(w), null, { ...settings, targetTris: 3000, uvMode: 'keep', symmetry: plane }, { normals: 'smooth' });
  let mirrored = true, seam = true;
  for (let v = 0; v < r.vertexCount; v++) {
    const t = r.twin[v], N = r.normals;
    if (t === v) { if (Math.abs(N[v * 3]) > 1e-5) seam = false; continue; }
    if (Math.abs(N[v * 3] + N[t * 3]) > 1e-5 || Math.abs(N[v * 3 + 1] - N[t * 3 + 1]) > 1e-5 || Math.abs(N[v * 3 + 2] - N[t * 3 + 2]) > 1e-5) mirrored = false;
  }
  check(mirrored && seam, 'smooth under symmetry: mirrored normals on the copy, normals on the plane lie in it');
}

// Remove tiny floating parts: a speck well under 1% of the model goes, the model stays.
{
  const big = new THREE.SphereGeometry(1, 48, 24), speck = new THREE.SphereGeometry(0.004, 8, 6).translate(3, 0, 0);
  const merged = new THREE.BufferGeometry();
  const nb = big.attributes.position.count;
  merged.setAttribute('position', new THREE.BufferAttribute(Float32Array.of(...big.attributes.position.array, ...speck.attributes.position.array), 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(Float32Array.of(...big.attributes.normal.array, ...speck.attributes.normal.array), 3));
  merged.setIndex([...big.index.array, ...[...speck.index.array].map(i => i + nb)]);
  const w = core.smartWeld(sceneOf(merged), { keepUV: false, hardAngle: 30 });
  const { result } = core.runReduction(S, context(w), null, { ...settings, targetTris: 800, prune: true, symmetry: null }, { normals: 'original' });
  let speckLeft = false;
  for (let v = 0; v < result.vertexCount; v++) if (result.positions[v * 3] > 2) speckLeft = true;
  check(!speckLeft && result.triCount > 600, `prune: the speck is gone, the sphere keeps ${result.triCount} triangles`);
}
// A reduction that can't reach its budget (everything painted Keep) still keeps the model when pruning is on.
{
  const w = core.smartWeld(sceneOf(new THREE.SphereGeometry(1, 48, 24)), { keepUV: false, hardAngle: 30 });
  const keep = new Int8Array(w.vertexCount).fill(core.LABEL.KEEP);
  const { result } = core.runReduction(S, context(w), keep, { ...settings, targetTris: 200, prune: true, symmetry: null }, { normals: 'original' });
  check(result.triCount === w.triCount, `prune: a model held above its budget keeps all ${result.triCount} of its triangles`);
}
