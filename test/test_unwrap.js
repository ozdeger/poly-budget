// New UVs: charts, packing and the deferred path the editor uses. `node test/test_unwrap.js model.fbx` adds a real model:
// the Auto decision across budgets, then new UVs with and without symmetry.
import { THREE, core, S, settings, check, timed, bumpySphere, sceneOf, context, loadFBX, layoutCheck } from './helpers.js';

function unwrapShape(label, geo) {
  const w = core.smartWeld(sceneOf(geo), { keepUV: false, hardAngle: 30 });
  const fin = { positions: w.positions, normals: w.normals, uvs: null, colors: null, index: w.index, vPart: w.vPart, vMat: w.vMat, srcId: Uint32Array.from({ length: w.vertexCount }, (_, i) => i), vertexCount: w.vertexCount, triCount: w.triCount };
  const u = timed(label, () => core.unwrap(fin, { size: 1024 }));
  const c = layoutCheck(u.mesh);
  console.log(`     ${w.triCount} tris -> ${u.info.charts} charts filling ${(u.info.coverage * 100).toFixed(1)}% of the sheet, ${u.mesh.vertexCount} verts`);
  check(c.overlap === 0 && c.outside === 0 && c.nan === 0, `${label}: no overlapping texels, nothing outside [0,1], no NaN`);
  check(u.info.coverage > 0.35, `${label}: the charts fill over 35% of the sheet`);
}
unwrapShape('sphere', new THREE.SphereGeometry(1, 64, 32));
unwrapShape('torus knot', new THREE.TorusKnotGeometry(1, 0.3, 256, 32));
unwrapShape('box', new THREE.BoxGeometry(1, 2, 3, 4, 4, 4));
const blob = new THREE.IcosahedronGeometry(1, 40);
{
  const p = blob.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), s = 1 + 0.15 * Math.sin(5 * x) * Math.cos(4 * y) * Math.sin(3 * z);
    p.setXYZ(i, x * s, y * s, z * s);
  }
  blob.computeVertexNormals();
}
unwrapShape('bumpy blob', blob);

// The editor first shows the geometry (deferUV), then unwraps it in a second worker.
{
  const w = core.smartWeld(sceneOf(bumpySphere(128, 64)), { keepUV: true, hardAngle: 30 });
  const ctx = context(w);
  for (const sym of [null, { axis: 0, offset: 0, keepPositive: true }]) {
    const label = `deferred ${sym ? 'symmetric' : 'plain'}`;
    const { result } = core.runReduction(S, ctx, null, { ...settings, targetTris: 4000, uvMode: 'new', deferUV: true, symmetry: sym }, { normals: 'original' });
    check(result.uvLayout === 'pending' && !result.uvs, `${label}: the geometry comes back first, without UVs`);
    const u = core.unwrapResult(result, sym, null, 1024);
    const c = layoutCheck(u.result, sym ? u.result.triCount / 2 : u.result.triCount);
    console.log(`     ${result.vertexCount} -> ${u.result.vertexCount} verts, ${u.atlas.charts} charts, ${(u.atlas.coverage * 100).toFixed(1)}% of the sheet`);
    check(u.result.uvLayout === 'new' && u.result.triCount === result.triCount && c.overlap === 0 && c.outside === 0 && c.nan === 0, `${label}: unwrapped with the same triangles and a clean layout`);
    if (sym) check(u.symmetry.paired === u.symmetry.total, `${label}: all ${u.symmetry.total} vertices still paired`);
  }
}

// A quad folded onto itself, as the remesher can leave one in a tight groove, keeps its true shape in a chart of its own
// instead of becoming a sliver inside a bigger chart (which reads its texture from the gutter), and no face anywhere
// gets less than 0.15 of its share of texels.
{
  const pos = [], idx = [], marks = [];
  for (let j = 0; j <= 5; j++) for (let i = 0; i <= 5; i++) pos.push(i, j, 0);
  const id = (i, j) => j * 6 + i;
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) {
    idx.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
    marks.push(1, 2);
  }
  // The corner quad's free corner turned 150° about its diagonal, over the quad's other half.
  const c = id(0, 5) * 3, t = (150 * Math.PI) / 180;
  pos[c] = 0.5 - 0.5 * Math.cos(t); pos[c + 1] = 4.5 + 0.5 * Math.cos(t); pos[c + 2] = Math.SQRT1_2 * Math.sin(t);
  const V = pos.length / 3, T = idx.length / 3;
  const fin = { positions: Float32Array.from(pos), normals: new Float32Array(V * 3), uvs: null, colors: null, index: Uint32Array.from(idx), quad: Uint8Array.from(marks), vPart: new Uint16Array(V), vMat: new Uint16Array(V), srcId: Uint32Array.from({ length: V }, (_, i) => i), vertexCount: V, triCount: T };
  const u = core.unwrap(fin, { size: 1024 }), m = u.mesh, P = m.positions, UV = m.uvs, I = m.index;
  const a3 = [], au = [];
  let s3 = 0, su = 0;
  for (let f = 0; f < T; f++) {
    const [a, b, c2] = [I[f * 3], I[f * 3 + 1], I[f * 3 + 2]];
    const e = [0, 1, 2].map(k => P[b * 3 + k] - P[a * 3 + k]), g = [0, 1, 2].map(k => P[c2 * 3 + k] - P[a * 3 + k]);
    a3.push(Math.hypot(e[1] * g[2] - e[2] * g[1], e[2] * g[0] - e[0] * g[2], e[0] * g[1] - e[1] * g[0]) / 2);
    au.push(((UV[b * 2] - UV[a * 2]) * (UV[c2 * 2 + 1] - UV[a * 2 + 1]) - (UV[c2 * 2] - UV[a * 2]) * (UV[b * 2 + 1] - UV[a * 2 + 1])) / 2);
    s3 += a3[f]; su += Math.abs(au[f]);
  }
  const share = f => Math.abs(au[f]) / su / (a3[f] / s3);
  const folded = 4 * 5 * 2; // the corner quad's two triangles (row 4, column 0)
  const lowest = Math.min(...a3.map((_, f) => share(f)));
  const lc = layoutCheck(m);
  // Its own chart: none of its corners' UV vertices is used by another face.
  const own = new Set([...I.subarray(folded * 3, folded * 3 + 6)]);
  let alone = true;
  for (let f = 0; f < T; f++) if (f !== folded && f !== folded + 1) for (let k = 0; k < 3; k++) if (own.has(I[f * 3 + k])) alone = false;
  check(alone && lowest >= 0.15 && Math.abs(share(folded) - share(folded + 1)) < 0.05 && Math.abs(share(folded) - 1) < 0.1 && lc.overlap === 0 && au.every(x => x > 0),
    `folded quad: a chart of its own at its true size (${share(folded).toFixed(2)} and ${share(folded + 1).toFixed(2)} of its share), every face at least ${lowest.toFixed(2)}, no overlap or flips (${u.info.charts} charts)`);
}

const modelPath = process.argv[2];
if (modelPath) {
  const { src } = timed('parse', () => loadFBX(modelPath));
  const w = timed('weld', () => core.smartWeld(src, { keepUV: true, hardAngle: 30 }));
  console.log(`     ${w.triCount} tris, ${w.uvIslands} UV islands`);
  const ctx = context(w);
  for (const pct of [50, 20, 10, 3.3, 1]) {
    const target = Math.round((w.triCount * pct) / 100);
    const { result, info } = timed(`auto at ${target}`, () => core.runReduction(S, ctx, null, { ...settings, targetTris: target, uvMode: 'auto' }, { normals: 'original' }));
    const c = result.uvLayout === 'new' ? layoutCheck(result) : null;
    console.log(`     misplaced ${(info.uvFit.misplaced * 100).toFixed(2)}% -> ${info.uvDecision}` + (c ? `, ${info.atlas.charts} charts, ${(info.atlas.coverage * 100).toFixed(1)}% of the sheet, overlap ${c.overlap} texels` : ''));
  }
}
