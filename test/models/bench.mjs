// Runs the fetched test models through the reducer and the quad remesher as the app does, and prints what came out:
// time, faces against the budget, how far the original's surface lies from the result, poles and open edges.
// usage: node --max-old-space-size=16384 test/models/bench.mjs [id …] [--tier=core] [--tris=20000,60000] [--quads=10000,30000]
//        [--mirror] [--json=out.json]
//   --tris / --quads   budgets in faces (0 skips the mode); quads are counted as faces, as the app shows them
//   --mirror           also remeshes into quads with the model's mirror plane (models whose manifest entry has one)
//   --thin=0           remeshes without Keep thin parts
//   --save=dir         writes each result there as an OBJ (quads kept as quads), to look at or open in the app
//   --measure [--pin]  only loads and welds: counts, UV islands, open edges, and the best mirror plane of models tagged
//                      symmetric; --pin writes the counts and planes into manifest.json
import fs from 'fs';
import path from 'path';
import { core, collectScene, S, settings, context } from '../helpers.js';
import { pick, modelPath, manifest } from './fetch.mjs';
import { load } from './load.mjs';
import { samples, distances, pct, edgeCounts, degenerate } from '../../cli/measure.mjs';

// Distances from points to the nearest of a set of points, capped (a dense sample stands in for a dense surface, where
// a grid of millions of triangles would be slow to search).
function pointSet(Q, cell, cap) {
  const lo = [Infinity, Infinity, Infinity];
  for (let i = 0; i < Q.length; i++) lo[i % 3] = Math.min(lo[i % 3], Q[i]);
  const key = (i, j, k) => `${i},${j},${k}`, cells = new Map(), c = i => Math.floor((Q[i] - lo[i % 3]) / cell);
  for (let p = 0; p < Q.length / 3; p++) { const kk = key(c(p * 3), c(p * 3 + 1), c(p * 3 + 2)), l = cells.get(kk); if (l) l.push(p); else cells.set(kk, [p]); }
  const rings = Math.ceil(cap / cell);
  return pts => {
    const out = new Float64Array(pts.length / 3);
    for (let s = 0; s < out.length; s++) {
      const x = pts[s * 3], y = pts[s * 3 + 1], z = pts[s * 3 + 2], ci = Math.floor((x - lo[0]) / cell), cj = Math.floor((y - lo[1]) / cell), ck = Math.floor((z - lo[2]) / cell);
      let best = cap * cap;
      for (let r = 0; r <= rings; r++) {
        if (best <= ((r - 1) * cell) ** 2) break;
        for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) for (let k = ck - r; k <= ck + r; k++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== r) continue;
          const l = cells.get(key(i, j, k));
          if (l) for (const p of l) best = Math.min(best, (Q[p * 3] - x) ** 2 + (Q[p * 3 + 1] - y) ** 2 + (Q[p * 3 + 2] - z) ** 2);
        }
      }
      out[s] = Math.sqrt(best);
    }
    return out;
  };
}

// The plane (axis and offset) the model is most nearly mirror-symmetric about: sample points are mirrored across
// candidate planes near the middle and measured against the rest of the sample; a coarse scan per axis, then
// golden-section search.
function mirrorPlane(pts, b) {
  const near = pointSet(pts, 0.01 * b.diag, 0.05 * b.diag), few = pts.subarray(0, 3 * 3000);
  const score = (axis, offset) => {
    const q = Float64Array.from(few);
    for (let i = axis; i < q.length; i += 3) q[i] = 2 * offset - q[i];
    const d = near(q);
    let m = 0;
    for (const x of d) m += x;
    return m / d.length;
  };
  let best = null;
  for (let axis = 0; axis < 3; axis++) {
    const mid = (b.min[axis] + b.max[axis]) / 2, span = 0.2 * b.size[axis];
    let lo = mid - span, hi = mid + span, at = mid, err = Infinity;
    for (let k = 0; k <= 20; k++) { const o = lo + ((hi - lo) * k) / 20, e = score(axis, o); if (e < err) { err = e; at = o; } }
    lo = at - (hi - lo) / 20; hi = at + (hi - lo) / 20;
    const g = (Math.sqrt(5) - 1) / 2;
    for (let k = 0; k < 14; k++) {
      const x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
      if (score(axis, x1) < score(axis, x2)) hi = x2; else lo = x1;
    }
    at = (lo + hi) / 2; err = score(axis, at);
    if (!best || err < best.err) best = { axis, offset: at, err };
  }
  return { axis: best.axis, offset: Number(best.offset.toPrecision(6)), error: (100 * best.err) / b.diag };
}

// A result as OBJ text: corners at one position become one vertex, a quad's two triangles one face.
function resultObj(r, note) {
  const P = r.positions, id = new Map(), g = new Int32Array(r.vertexCount), out = [`# ${note}`];
  for (let v = 0; v < r.vertexCount; v++) {
    const k = `${P[v * 3]} ${P[v * 3 + 1]} ${P[v * 3 + 2]}`;
    if (!id.has(k)) { id.set(k, id.size + 1); out.push(`v ${k}`); }
    g[v] = id.get(k);
  }
  for (let t = 0; t < r.triCount; t++) {
    const q = r.quad && r.quad[t] === 1 ? core.quadCorners(r.index, t) : null;
    if (q) { out.push(`f ${q.map(v => g[v]).join(' ')}`); t++; } else out.push(`f ${g[r.index[t * 3]]} ${g[r.index[t * 3 + 1]]} ${g[r.index[t * 3 + 2]]}`);
  }
  return out.join('\n') + '\n';
}

function keptHalf(pts, plane) {
  const out = [];
  for (let i = 0; i < pts.length; i += 3) if (pts[i + plane.axis] >= plane.offset) out.push(pts[i], pts[i + 1], pts[i + 2]);
  return Float64Array.from(out);
}

const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };

const trisBudgets = arg('tris', '20000,60000').split(',').map(Number).filter(Boolean);
const quadBudgets = arg('quads', '10000,30000').split(',').map(Number).filter(Boolean);
const mirror = process.argv.includes('--mirror'), measure = process.argv.includes('--measure'), rows = [];
for (const m of pick(process.argv.slice(2))) {
  const file = modelPath(m);
  if (!file) { console.log(`skip ${m.id}: not fetched (node test/models/fetch.mjs ${m.id})`); continue; }
  let t0 = Date.now();
  const root = await load(file), loadMs = Date.now() - t0;
  t0 = Date.now();
  const w = core.smartWeld(collectScene(root), { keepUV: true, hardAngle: 30 });
  const ctx = context(w), b = core.bounds(w.positions), pts = samples(w.positions, w.index, 60000), weldMs = Date.now() - t0;
  const input = edgeCounts(w.positions, w.index);
  console.log(`== ${m.id}: ${input.positions} positions, ${w.triCount} triangles, ${w.uvs ? `${w.uvIslands} UV islands` : 'no UVs'}, ${input.open} open, ${input.nonManifold} non-manifold edges, ${new Set(w.vMat).size} materials (load ${loadMs} ms, weld ${weldMs} ms)`);
  if (measure) {
    const plane = m.tags.some(t => /symmetric/.test(t)) ? mirrorPlane(pts, b) : null;
    if (plane) console.log(`     mirror plane: ${'xyz'[plane.axis]} = ${plane.offset}, mirrored points lie ${plane.error.toFixed(3)}% of the diagonal off the surface on average`);
    if (process.argv.includes('--pin')) {
      Object.assign(m, { vertices: input.positions, triangles: w.triCount, counts: 'measured' });
      // A plane the model is far from symmetric about makes no fair mirror test.
      if (plane && plane.error < 3) m.mirror = { axis: plane.axis, offset: plane.offset };
      else delete m.mirror;
      fs.writeFileSync(new URL('./manifest.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
    }
    continue;
  }
  const runs = [...trisBudgets.map(f => ['tris', f, null]), ...quadBudgets.map(f => ['quads', f, null])];
  if (mirror && m.mirror) runs.push(...quadBudgets.map(f => ['quads', f, m.mirror]));
  for (const [topology, faces, plane] of runs) {
    const st = { ...settings, targetTris: topology === 'quads' ? faces * 2 : faces, topology, uvMode: 'auto', deferUV: true, quadAdapt: 0.75, quadSharp: core.QUAD_SHARP, quadThin: arg('thin', '1') !== '0', symmetry: plane ? { ...plane, keepPositive: true } : null };
    t0 = Date.now();
    const { result: r, info } = core.runReduction(S, ctx, null, st, { normals: 'smooth', creaseAngle: 30 });
    // Mirrored, only the kept half is measured: the other is its copy, and the original is never quite symmetric.
    const ms = Date.now() - t0, got = topology === 'quads' ? info.quads : r.triCount, oe = edgeCounts(r.positions, r.index);
    const dev = pct(distances(r.positions, r.index, plane ? keptHalf(pts, plane) : pts), b.diag);
    const row = { id: m.id, mode: plane ? 'mirrored quads' : topology, budget: faces, faces: got, ms, deviation: dev, open: oe.open, nonManifold: oe.nonManifold, degenerate: degenerate(r.positions, r.index), poles: info.poles ? info.poles.count / info.poles.inner : null, uv: r.uvLayout || 'kept' };
    rows.push(row);
    const saveDir = arg('save', null);
    if (saveDir) {
      fs.mkdirSync(saveDir, { recursive: true });
      fs.writeFileSync(path.join(saveDir, `${m.id}-${row.mode.replace(' ', '-')}-${faces}.obj`), resultObj(r, `${m.name}: ${row.mode}, ${got} faces for ${faces} asked (Poly Budget bench)`));
    }
    console.log(`     ${row.mode.padEnd(14)} ${String(faces).padStart(6)} -> ${String(got).padStart(6)} faces ${String(ms).padStart(6)} ms | off the original: mean ${dev.mean.toFixed(3)}% p99 ${dev.p99.toFixed(3)}% max ${dev.max.toFixed(2)}% of the diagonal | ${oe.open} open, ${oe.nonManifold} non-manifold edges${row.degenerate ? `, ${row.degenerate} flat triangles` : ''}${row.poles != null ? ` | poles ${(100 * row.poles).toFixed(1)}%` : ''}${topology === 'tris' ? ` | UVs ${row.uv === 'pending' ? 'new' : 'kept'}` : ''}`);
  }
}
const out = arg('json', null);
if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 1));
