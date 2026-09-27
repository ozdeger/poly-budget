// UVs laid out for painting by hand: whole quads, no overlap, few charts, seams on the side nothing sees, parts painted
// differently kept apart, charts upright, and mirrored halves sharing their layout.
import { THREE, core, S, settings, check, bumpySphere, sceneOf, context, layoutCheck } from './helpers.js';

const remesh = (geo, targetTris, symmetry = null) => {
  const w = core.smartWeld(sceneOf(geo), { keepUV: true, hardAngle: 30 });
  return core.runReduction(S, context(w), null, { ...settings, deferUV: true, targetTris, topology: 'quads', symmetry }, { normals: 'smooth' }).result;
};
// Charts: triangles joined across edges whose two vertices they share.
function chartsOf(r, triEnd = r.triCount) {
  const I = r.index, par = Int32Array.from({ length: triEnd }, (_, i) => i), find = x => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  const seen = new Map();
  for (let t = 0; t < triEnd; t++) for (let k = 0; k < 3; k++) {
    const a = I[t * 3 + k], b = I[t * 3 + ((k + 1) % 3)], key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (seen.has(key)) { const x = find(seen.get(key)), y = find(t); if (x !== y) par[x] = y; } else seen.set(key, t);
  }
  const id = new Int32Array(triEnd), ids = new Map();
  for (let t = 0; t < triEnd; t++) { const x = find(t); if (!ids.has(x)) ids.set(x, ids.size); id[t] = ids.get(x); }
  return { id, count: ids.size };
}
const brokenQuads = (r, triEnd = r.triCount) => { let n = 0; for (let t = 0; t < triEnd; t++) if (r.quad[t] === 1 && !core.quadCorners(r.index, t)) n++; return n; };
// Seam edges: edges at one place that different charts both hold, with where their middle is.
function seams(r) {
  const P = r.positions, I = r.index, key = v => `${P[v * 3]},${P[v * 3 + 1]},${P[v * 3 + 2]}`, at = new Map();
  for (let t = 0; t < r.triCount; t++) for (let k = 0; k < 3; k++) {
    const a = I[t * 3 + k], b = I[t * 3 + ((k + 1) % 3)], ka = key(a), kb = key(b), pk = ka < kb ? ka + '|' + kb : kb + '|' + ka;
    const vk = a < b ? `${a}_${b}` : `${b}_${a}`;
    let e = at.get(pk);
    if (!e) at.set(pk, e = { pairs: new Set(), a, b });
    e.pairs.add(vk);
  }
  return [...at.values()].filter(e => e.pairs.size > 1).map(e => ({
    length: Math.hypot(P[e.a * 3] - P[e.b * 3], P[e.a * 3 + 1] - P[e.b * 3 + 1], P[e.a * 3 + 2] - P[e.b * 3 + 2]),
    mid: [0, 1, 2].map(k => (P[e.a * 3 + k] + P[e.b * 3 + k]) / 2),
  }));
}

// A bumpy sphere: whole quads, inside the sheet without overlap, and far fewer charts than the compact layout.
const ball = remesh(bumpySphere(160, 80), 4000);
{
  const compact = core.unwrapResult(ball, null, null, 1024), t0 = Date.now(), paint = core.unwrapResult(ball, null, null, 1024, { style: 'paint' });
  const r = paint.result, lc = layoutCheck(r), n = chartsOf(r).count;
  check(lc.overlap === 0 && lc.outside === 0 && lc.nan === 0 && brokenQuads(r) === 0 && paint.atlas.style === 'paint',
    `sphere: paintable UVs without overlap, inside the sheet, every quad whole (${Date.now() - t0} ms)`);
  check(n * 4 <= compact.atlas.charts, `sphere: ${n} charts, against ${compact.atlas.charts} packed for baking`);
}

// Seams go where nothing sees them. An open tube with its back (z < 0) hidden is cut open along the back, as arms and
// legs are cut along their inner side; on a closed ball, which can't be laid flat without cuts in view, most of the
// seam length still runs on the hidden half.
const hiddenBack = (r, lim) => {
  const vis = Float32Array.from({ length: r.vertexCount }, (_, v) => (r.positions[v * 3 + 2] < 0 ? 0.05 : 1));
  let back = 0, all = 0;
  for (const e of seams(core.unwrapResult(r, null, null, 1024, { style: 'paint', vis }).result)) { all += e.length; if (e.mid[2] < lim) back += e.length; }
  return all > 0 ? back / all : 0;
};
{
  const tube = remesh(new THREE.CylinderGeometry(0.5, 0.5, 2, 64, 32, true), 3000), share = hiddenBack(tube, 0);
  check(share > 0.9, `open tube: ${(100 * share).toFixed(0)}% of the seam length on the hidden back`);
  const ball2 = hiddenBack(ball, 0);
  check(ball2 > 0.55, `ball: ${(100 * ball2).toFixed(0)}% of the seam length on the hidden half`);
}

// Painted red on top and blue below, no chart holds much of both.
{
  const colors = new Float32Array(ball.vertexCount * 3);
  for (let v = 0; v < ball.vertexCount; v++) colors.set(ball.positions[v * 3 + 1] > 0 ? [220, 40, 40] : [40, 40, 220], v * 3);
  const r = core.unwrapResult(ball, null, null, 1024, { style: 'paint', colors }).result, { id, count } = chartsOf(r);
  const top = new Float64Array(count), bottom = new Float64Array(count), P = r.positions, I = r.index;
  for (let t = 0; t < r.triCount; t++) {
    const y = (P[I[t * 3] * 3 + 1] + P[I[t * 3 + 1] * 3 + 1] + P[I[t * 3 + 2] * 3 + 1]) / 3;
    if (y > 0.05) top[id[t]]++; else if (y < -0.05) bottom[id[t]]++;
  }
  let mixed = 0;
  for (let c = 0; c < count; c++) if (Math.min(top[c], bottom[c]) > 0.1 * Math.max(top[c], bottom[c])) mixed++;
  check(mixed === 0, `two colours: ${mixed} of ${count} charts hold both`);
}

// A standing capsule: charts that rise run up the sheet.
{
  const r = core.unwrapResult(remesh(new THREE.CapsuleGeometry(0.4, 1.4, 24, 48), 3000), null, null, 1024, { style: 'paint' }).result;
  const { id, count } = chartsOf(r), gx = new Float64Array(count), gy = new Float64Array(count), wt = new Float64Array(count), P = r.positions, UV = r.uvs, I = r.index;
  for (let t = 0; t < r.triCount; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const du1 = UV[b * 2] - UV[a * 2], dv1 = UV[b * 2 + 1] - UV[a * 2 + 1], du2 = UV[c * 2] - UV[a * 2], dv2 = UV[c * 2 + 1] - UV[a * 2 + 1], det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-14) continue;
    const y1 = P[b * 3 + 1] - P[a * 3 + 1], y2 = P[c * 3 + 1] - P[a * 3 + 1], ar = Math.abs(det);
    gx[id[t]] += (ar * (y1 * dv2 - y2 * dv1)) / det; gy[id[t]] += (ar * (du1 * y2 - du2 * y1)) / det; wt[id[t]] += ar;
  }
  let rising = 0, upright = 0;
  for (let c = 0; c < count; c++) {
    if (Math.hypot(gx[c], gy[c]) < 1e-9 * wt[c]) continue;
    rising++;
    if (Math.abs(Math.atan2(gx[c], gy[c])) < (20 * Math.PI) / 180) upright++;
  }
  check(rising > 0 && upright === rising, `capsule: ${upright} of ${rising} rising charts run up the sheet`);
}

// Mirrored: the kept half is laid out and the other half shares its UVs.
{
  const plane = { axis: 0, offset: 0, keepPositive: true }, half = remesh(bumpySphere(160, 80), 4000, plane);
  const u = core.unwrapResult(half, plane, null, 1024, { style: 'paint' }), r = u.result;
  check(u.symmetry.paired === u.symmetry.total && brokenQuads(r, r.triCount / 2) === 0 && layoutCheck(r, r.triCount / 2).overlap === 0,
    `mirrored sphere: ${u.symmetry.paired}/${u.symmetry.total} vertices paired, the kept half laid out whole in ${u.atlas.charts} charts`);
}
