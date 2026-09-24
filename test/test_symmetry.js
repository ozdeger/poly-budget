// Mirror symmetry: every vertex of a mirrored result has a partner. `node test/test_symmetry.js model.fbx [axis]` adds a real model.
import { THREE, core, S, settings, check, timed, bumpySphere, sceneOf, context, loadFBX, openEdges } from './helpers.js';

function run(label, src, target, sym, paint = null) {
  const w = core.smartWeld(src, { keepUV: true, hardAngle: 30 });
  const ctx = context(w);
  const labels = paint ? paint(w) : null;
  const { result, info } = timed(label, () => core.runReduction(S, ctx, labels, { ...settings, targetTris: target, symmetry: sym }, { normals: 'original' }));
  const nan = result.positions.some(Number.isNaN) || result.normals.some(Number.isNaN);
  const before = openEdges({ positions: w.positions, index: w.index }), after = openEdges(result);
  console.log(`     ${w.triCount} -> ${result.triCount} tris (target ${target}), open edges ${before.open} -> ${after.open}, non-manifold ${after.nonManifold}`);
  check(!nan, `${label}: no NaN`);
  check(after.open <= before.open, `${label}: no new holes`);
  if (sym) check(info.symmetry.paired === info.symmetry.total, `${label}: all ${info.symmetry.total} vertices paired across the plane`);
  return result;
}

const sphere = sceneOf(bumpySphere(), 'Sphere');
const x = { axis: 0, offset: 0, keepPositive: true };
const mirrored = run('symmetric sphere, X plane', sphere, 6000, x);
let minX = Infinity, maxX = -Infinity;
for (let v = 0; v < mirrored.positions.length; v += 3) { minX = Math.min(minX, mirrored.positions[v]); maxX = Math.max(maxX, mirrored.positions[v]); }
check(Math.abs(minX + maxX) < 1e-6, 'the mirrored result spans the same distance on both sides of the plane');
run('symmetric sphere, keep −X, painted', sphere, 6000, { ...x, keepPositive: false }, w => {
  const L = new Int8Array(w.vertexCount);
  for (let v = 0; v < w.vertexCount; v++) { const y = w.positions[v * 3 + 1]; if (y > 0.6) L[v] = core.LABEL.MORE2; else if (y < -0.6) L[v] = core.LABEL.LESS2; }
  return L;
});
run('sphere without symmetry', sphere, 6000, null);

// The mirror seam is the cut half's border but not a real one: Lock open borders and Less paint must leave it free,
// while a real open border (the rim of a bowl) stays locked when asked.
{
  const bowl = core.smartWeld(sceneOf(new THREE.SphereGeometry(1, 128, 64, 0, Math.PI * 2, 0, Math.PI * 0.75), 'Bowl'), { keepUV: true, hardAngle: 30 });
  const rimY = Math.cos(Math.PI * 0.75);
  const count = res => {
    let rim = 0, seam = 0;
    for (let v = 0; v < res.positions.length / 3; v++) {
      const px = res.positions[v * 3], py = res.positions[v * 3 + 1];
      if (px === 0) seam++; else if (Math.abs(py - rimY) < 1e-4) rim++;
    }
    return { rim, seam };
  };
  const source = count(bowl);
  for (const lockBorder of [false, true]) {
    const paint = new Int8Array(bowl.vertexCount);
    for (let v = 0; v < bowl.vertexCount; v++) if (bowl.positions[v * 3 + 1] > 0.5) paint[v] = core.LABEL.LESS3;
    const { result } = core.runReduction(S, context(bowl), paint, { ...settings, lockBorder, targetTris: 2000, symmetry: x }, { normals: 'original' });
    const c = count(result);
    console.log(`     bowl, lock borders ${lockBorder ? 'on' : 'off'}: rim ${source.rim} -> ${c.rim}, seam ${source.seam} -> ${c.seam}`);
    check(c.seam < source.seam * 0.8, `bowl, lock borders ${lockBorder ? 'on' : 'off'}: the mirror seam simplifies`);
    check(lockBorder ? c.rim >= source.rim - 4 : c.rim < source.rim * 0.5, `bowl, lock borders ${lockBorder ? 'on' : 'off'}: the real rim is ${lockBorder ? 'kept' : 'reduced'}`);
  }
}

const modelPath = process.argv[2];
if (modelPath) {
  const axis = Number(process.argv[3] ?? 0);
  const { src } = timed('parse', () => loadFBX(modelPath));
  run(`${modelPath}, plane ${'XYZ'[axis]} = 0`, src, 30000, { axis, offset: 0, keepPositive: true });
}
