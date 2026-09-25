// Hidden areas: visibility from all sides on shapes with known answers, the levels it turns into, and the reduction
// deleting surface nothing can see or spending less on hidden surface, in Triangles and Quads mode and under symmetry.
import { THREE, core, S, settings, check, sceneOf, context, openEdges } from './helpers.js';
import { computeVisibility } from '../src/visibility.js';

const weld = geo => core.smartWeld(sceneOf(geo), { keepUV: false, hardAngle: 180 });
const merge = (...geos) => {
  const pos = [], idx = [];
  let off = 0;
  for (const g of geos) {
    pos.push(...g.attributes.position.array);
    idx.push(...[...g.index.array].map(i => i + off));
    off += g.attributes.position.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  m.setIndex(idx);
  m.computeVertexNormals();
  return m;
};
const flipped = g => {
  const m = g.clone(), ix = m.index.array;
  for (let t = 0; t < ix.length; t += 3) { const s = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = s; }
  return m;
};

// Anything convex is fully visible, whichever way its triangles face; so is an open sheet, from its two sides.
for (const [name, geo] of [['sphere', new THREE.SphereGeometry(1, 48, 24)], ['inside-out sphere', flipped(new THREE.SphereGeometry(1, 48, 24))], ['open sheet', new THREE.PlaneGeometry(1, 1, 24, 24)]]) {
  const { vis, stats } = computeVisibility(weld(geo));
  check(Math.min(...vis) > 0.9 && stats.hist[0] === 0, `${name}: seen from all sides (lowest ${Math.min(...vis).toFixed(3)})`);
}

// A box sealed inside another is never seen; its share of the surface is 1.5 of 25.5.
const boxes = weld(merge(new THREE.BoxGeometry(2, 2, 2, 12, 12, 12), new THREE.BoxGeometry(0.5, 0.5, 0.5, 6, 6, 6)));
const inner = v => Math.max(Math.abs(boxes.positions[v * 3]), Math.abs(boxes.positions[v * 3 + 1]), Math.abs(boxes.positions[v * 3 + 2])) < 0.3;
{
  const { vis, stats } = computeVisibility(boxes);
  let innerMax = 0, outerMin = 1;
  for (let v = 0; v < boxes.vertexCount; v++) if (inner(v)) innerMax = Math.max(innerMax, vis[v]); else outerMin = Math.min(outerMin, vis[v]);
  check(innerMax === 0 && outerMin > 0.9 && Math.abs(stats.hist[0] - 1.5 / 25.5) < 0.005,
    `box in a box: the inner box is never seen, the outer one always (${(100 * stats.hist[0]).toFixed(1)}% never seen)`);
  // The levels: Medium gives the inner box the lowest Less level, Delete marks it for deletion, the outer box stays.
  const med = core.hiddenLabels(vis, 'medium'), cull = core.hiddenLabels(vis, 'medium', true);
  let ok = true;
  for (let v = 0; v < boxes.vertexCount; v++) {
    if (inner(v) ? med[v] !== core.LABEL.LESS3 || cull[v] !== core.LABEL.CULL : med[v] !== 0 || cull[v] !== 0) ok = false;
  }
  check(ok, 'box in a box: Medium puts the inner box at ⅛, Delete marks it, the outer box has no level');
  // Through the reducer: the inner box is gone and the outer one stays closed, as triangles and as quads.
  const ctx = context(boxes);
  for (const topology of ['tris', 'quads']) {
    const { result: r } = core.runReduction(S, ctx, cull, { ...settings, targetTris: 1200, topology, symmetry: null, deferUV: true }, { normals: 'smooth' });
    let left = 0;
    for (let v = 0; v < r.vertexCount; v++) if (Math.max(Math.abs(r.positions[v * 3]), Math.abs(r.positions[v * 3 + 1]), Math.abs(r.positions[v * 3 + 2])) < 0.3) left++;
    const oe = openEdges(r);
    check(left === 0 && oe.open === 0 && oe.nonManifold === 0, `box in a box, ${topology}: nothing of the inner box is left and the outer box is closed (${r.triCount} triangles)`);
  }
}

// Two spheres pushed into each other: the part of each inside the other is never seen. With the levels the buried caps
// get far fewer triangles; with Delete none, and under symmetry every vertex still pairs up.
{
  const w = weld(merge(new THREE.SphereGeometry(1, 96, 48).translate(-0.55, 0, 0), new THREE.SphereGeometry(1, 96, 48).translate(0.55, 0, 0)));
  const { vis } = computeVisibility(w);
  const buried = (P, v) => { const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2]; return (x + 0.55) ** 2 + y * y + z * z < 0.97 || (x - 0.55) ** 2 + y * y + z * z < 0.97; };
  const ctx = context(w);
  const buriedTris = labels => {
    const { result: r } = core.runReduction(S, ctx, labels, { ...settings, targetTris: 3000, topology: 'tris', symmetry: null, deferUV: true }, { normals: 'smooth' });
    let n = 0;
    for (let t = 0; t < r.triCount; t++) if ([0, 1, 2].every(k => buried(r.positions, r.index[t * 3 + k]))) n++;
    return n;
  };
  const plain = buriedTris(null), less = buriedTris(core.hiddenLabels(vis, 'medium')), gone = buriedTris(core.hiddenLabels(vis, 'medium', true));
  check(less < plain / 3 && gone === 0, `overlapping spheres: ${plain} triangles on the buried caps, ${less} with the levels, ${gone} with Delete`);
  const sym = { axis: 0, offset: 0, keepPositive: true };
  const { result: r, info } = core.runReduction(S, ctx, core.hiddenLabels(vis, 'medium', true), { ...settings, targetTris: 3000, topology: 'tris', symmetry: sym, deferUV: true }, { normals: 'smooth' });
  let left = 0;
  for (let t = 0; t < r.triCount; t++) if ([0, 1, 2].every(k => buried(r.positions, r.index[t * 3 + k]))) left++;
  check(left === 0 && info.symmetry.paired === info.symmetry.total, `overlapping spheres, mirrored: no buried triangles, ${info.symmetry.paired}/${info.symmetry.total} vertices paired`);
}

// Normal detail only blocks the levels: the reducer treats it as unpainted, and it isn't More detail.
{
  const w = weld(new THREE.SphereGeometry(1, 64, 32));
  const labels = new Int8Array(w.vertexCount).fill(core.LABEL.PLAIN);
  const cat = core.categorize(w.index, labels);
  const ctx = context(w);
  const a = core.runReduction(S, ctx, labels, { ...settings, targetTris: 800, topology: 'tris', symmetry: null, deferUV: true }, { normals: 'smooth' }).result;
  const b = core.runReduction(S, ctx, null, { ...settings, targetTris: 800, topology: 'tris', symmetry: null, deferUV: true }, { normals: 'smooth' }).result;
  check(cat.rest === w.triCount && a.triCount === b.triCount, `Normal detail counts as unpainted (${a.triCount} triangles either way)`);
}

// A thin ring hugging a sphere, like a necklace on a neck: its inner side faces the sphere and is hardly seen, but it
// bends sharply, so it keeps its detail (the visible side's round shape depends on it); the sphere's own hidden band
// under the ring still gets less.
{
  const { formDensity } = await import('../src/quad.js');
  const w = weld(merge(new THREE.SphereGeometry(1, 128, 64), new THREE.TorusGeometry(1.035, 0.03, 16, 160).rotateX(Math.PI / 2)));
  const { vis } = computeVisibility(w);
  const curve = formDensity(w.positions, w.index, null, null, 1);
  const plain = core.hiddenLabels(vis, 'medium'), kept = core.hiddenLabels(vis, 'medium', false, curve);
  let ringHidden = 0, ringKept = 0, sphereHidden = 0, sphereKept = 0;
  for (let v = 0; v < w.vertexCount; v++) {
    const onRing = Math.hypot(w.positions[v * 3], w.positions[v * 3 + 2]) > 1.002 && Math.abs(w.positions[v * 3 + 1]) < 0.04;
    if (onRing) { if (plain[v]) ringHidden++; if (kept[v]) ringKept++; }
    else { if (plain[v]) sphereHidden++; if (kept[v]) sphereKept++; }
  }
  check(ringHidden > 50 && ringKept < ringHidden / 5 && sphereKept > sphereHidden / 2,
    `thin ring on a sphere: ${ringHidden} hidden ring vertices without the curvature rule, ${ringKept} with it; the sphere keeps ${sphereKept} of its ${sphereHidden} hidden vertices`);
}
