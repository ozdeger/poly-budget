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
