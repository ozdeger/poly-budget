// Budget zones for the Quads slider: on a sphere they fall where the chord error κh²/8 predicts, paint shifts them by
// the extra faces it asks for, and a flat part thinner than half a quad sets red.
import { THREE, core, S, settings, check, sceneOf, context } from './helpers.js';

const zonesOf = (geo, st = {}, labels = null) => {
  const w = core.smartWeld(sceneOf(geo), { keepUV: false, hardAngle: 30 });
  const lab = labels ? labels(w) : null;
  return core.runReduction(S, context(w), lab, { ...settings, deferUV: true, targetTris: 4000, topology: 'quads', quadAdapt: 0.75, quadThin: true, symmetry: null, ...st }, { normals: 'smooth' }).info.zones;
};

// A sphere of radius r bends by 1/r everywhere, so its faces are even: h² = 4πr² / n and each stands off by
// 2 · h²/(8r) = πr / n. Against its diagonal (2√3 r), 1.2 × that is 0.13% at about 837 faces and 0.03% at about 3,628.
const ball = new THREE.SphereGeometry(1, 192, 96);
const plain = zonesOf(ball);
check(Math.abs(plain.red / 837 - 1) < 0.15 && Math.abs(plain.gray / 3628 - 1) < 0.15 && plain.redBy === 'shape',
  `sphere: red below ${Math.round(plain.red)} quads (837 expected), gray above ${Math.round(plain.gray)} (3,628)`);

// Mirrored, the kept half counts for both and is measured against the whole ball, whose diagonal is 15% longer than
// the half's: the same limits.
{
  const mirrored = zonesOf(ball, { symmetry: { axis: 0, offset: 0, keepPositive: true } });
  check(Math.abs(mirrored.red / plain.red - 1) < 0.05 && Math.abs(mirrored.gray / plain.gray - 1) < 0.05,
    `mirrored sphere: red below ${Math.round(mirrored.red)} quads, gray above ${Math.round(mirrored.gray)}, as without the mirror`);
}

// Painting the top half More ×2 (four times the faces per area) asks for (4 + 1) / 2 = 2.5 times the faces.
{
  const painted = zonesOf(ball, {}, w => Int8Array.from({ length: w.vertexCount }, (_, v) => (w.positions[v * 3 + 1] > 0 ? 2 : 0)));
  const k = painted.red / plain.red;
  check(Math.abs(k / 2.5 - 1) < 0.12 && Math.abs(painted.gray / plain.gray / k - 1) < 0.01, `painted half: both limits ${k.toFixed(2)} times higher (2.5 expected)`);
}

// A flat blade beside the ball (flat, so the shape asks for its biggest quads): thinner than half a quad, it comes
// apart until the grid is fine enough, which sets red far above the ball's own limit; Keep thin parts halves the
// quads on it, so that comes sooner.
{
  const blade = new THREE.BoxGeometry(1.0, 0.12, 0.01);
  blade.translate(1.8, 0, 0);
  const merged = [ball.clone().toNonIndexed(), blade.toNonIndexed()], both = new THREE.BufferGeometry();
  const pos = new Float32Array(merged.reduce((n, g) => n + g.attributes.position.array.length, 0));
  let o = 0;
  for (const g of merged) { pos.set(g.attributes.position.array, o); o += g.attributes.position.array.length; }
  both.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const off = zonesOf(both, { quadThin: false }), on = zonesOf(both, { quadThin: true });
  check(off.redBy === 'thin' && on.redBy === 'thin' && on.red > 10 * plain.red && off.red > 1.5 * on.red,
    `blade: red below ${Math.round(on.red)} quads with Keep thin parts, ${Math.round(off.red)} without, against ${Math.round(plain.red)} for the ball alone`);
}
