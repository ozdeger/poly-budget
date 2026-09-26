// Runs the fetched test models through the reducer and the quad remesher as the app does, and prints what came out:
// time, faces against the budget, how far the original's surface lies from the result, poles and open edges.
// usage: node --max-old-space-size=16384 test/models/bench.mjs [id …] [--tier=core] [--tris=20000,60000] [--quads=10000,30000]
//        [--mirror] [--json=out.json]
//   --tris / --quads   budgets in faces (0 skips the mode); quads are counted as faces, as the app shows them
//   --mirror           also remeshes into quads with the model's mirror plane (models whose manifest entry has one)
//   --save=dir         writes each result there as an OBJ (quads kept as quads), to look at or open in the app
//   --measure [--pin]  only loads and welds: counts, UV islands, open edges, and the best mirror plane of models tagged
//                      symmetric; --pin writes the counts and planes into manifest.json
import fs from 'fs';
import path from 'path';
import { core, collectScene, S, settings, context } from '../helpers.js';
import { pick, modelPath, manifest } from './fetch.mjs';
import { load } from './load.mjs';

// Area-weighted points on a triangle mesh (deterministic).
function samples(P, I, K) {
  const T = I.length / 3, cum = new Float64Array(T);
  let acc = 0;
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    acc += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    cum[t] = acc;
  }
  let s = 12345;
  const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = new Float64Array(K * 3);
  for (let k = 0; k < K; k++) {
    const x = rnd() * acc;
    let lo = 0, hi = T - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; }
    let u = rnd(), v = rnd();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    for (let d = 0; d < 3; d++) out[k * 3 + d] = P[I[lo * 3] * 3 + d] * (1 - u - v) + P[I[lo * 3 + 1] * 3 + d] * u + P[I[lo * 3 + 2] * 3 + d] * v;
  }
  return out;
}

// Squared distance from p to segment ab.
function segDist2(px, py, pz, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az, l = dx * dx + dy * dy + dz * dz;
  const t = l > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l)) : 0;
  return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2 + (pz - az - t * dz) ** 2;
}

// Squared distance from p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5); a triangle without area
// (two corners together, or all three on a line) counts as its edges.
function triDist2(px, py, pz, P, ia, ib, ic) {
  const ax = P[ia * 3], ay = P[ia * 3 + 1], az = P[ia * 3 + 2];
  const abx = P[ib * 3] - ax, aby = P[ib * 3 + 1] - ay, abz = P[ib * 3 + 2] - az, acx = P[ic * 3] - ax, acy = P[ic * 3 + 1] - ay, acz = P[ic * 3 + 2] - az;
  const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
  if (!(nx * nx + ny * ny + nz * nz > 1e-24 * (abx * abx + aby * aby + abz * abz) * (acx * acx + acy * acy + acz * acz))) {
    const bx = ax + abx, by = ay + aby, bz = az + abz, cx = ax + acx, cy = ay + acy, cz = az + acz;
    return Math.min(segDist2(px, py, pz, ax, ay, az, bx, by, bz), segDist2(px, py, pz, bx, by, bz, cx, cy, cz), segDist2(px, py, pz, ax, ay, az, cx, cy, cz));
  }
  const apx = px - ax, apy = py - ay, apz = pz - az, d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const q = (x, y, z) => (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
  if (d1 <= 0 && d2 <= 0) return q(ax, ay, az);
  const bpx = px - ax - abx, bpy = py - ay - aby, bpz = pz - az - abz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return q(ax + abx, ay + aby, az + abz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return q(ax + v * abx, ay + v * aby, az + v * abz); }
  const cpx = px - ax - acx, cpy = py - ay - acy, cpz = pz - az - acz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return q(ax + acx, ay + acy, az + acz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return q(ax + w * acx, ay + w * acy, az + w * acz); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + d5 - d6); return q(ax + abx + w * (acx - abx), ay + aby + w * (acy - aby), az + abz + w * (acz - abz)); }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return q(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

// Distances from points to the nearest point of a triangle mesh, through a uniform grid of its triangles, built once.
// The search stops at `cap` (a point farther off than that gets cap): without a cap, points out in empty space
// would scan the whole grid.
function surface(P, I, cap = Infinity) {
  const b = core.bounds(P), cell = b.diag / 80, inv = 1 / cell, n = [0, 1, 2].map(k => Math.max(1, Math.ceil(b.size[k] * inv) + 1));
  const key = (i, j, k) => (i * n[1] + j) * n[2] + k, cells = new Map();
  for (let t = 0; t < I.length / 3; t++) {
    const lo = [0, 1, 2].map(k => Math.floor((Math.min(P[I[t * 3] * 3 + k], P[I[t * 3 + 1] * 3 + k], P[I[t * 3 + 2] * 3 + k]) - b.min[k]) * inv));
    const hi = [0, 1, 2].map(k => Math.floor((Math.max(P[I[t * 3] * 3 + k], P[I[t * 3 + 1] * 3 + k], P[I[t * 3 + 2] * 3 + k]) - b.min[k]) * inv));
    for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) {
      const kk = key(i, j, k), l = cells.get(kk);
      if (l) l.push(t); else cells.set(kk, [t]);
    }
  }
  return pts => {
    const out = new Float64Array(pts.length / 3);
    for (let s = 0; s < out.length; s++) {
      const px = pts[s * 3], py = pts[s * 3 + 1], pz = pts[s * 3 + 2];
      const c = [0, 1, 2].map(k => Math.min(n[k] - 1, Math.max(0, Math.floor((pts[s * 3 + k] - b.min[k]) * inv))));
      let best = cap * cap;
      // Rings of cells outward, until the nearest unsearched cell is farther than the best hit (or the cap).
      for (let r = 0; r <= Math.max(...n); r++) {
        if (best <= ((r - 1) * cell) ** 2) break;
        for (let i = c[0] - r; i <= c[0] + r; i++) for (let j = c[1] - r; j <= c[1] + r; j++) for (let k = c[2] - r; k <= c[2] + r; k++) {
          if (Math.max(Math.abs(i - c[0]), Math.abs(j - c[1]), Math.abs(k - c[2])) !== r) continue;
          const l = cells.get(key(i, j, k));
          if (l) for (const t of l) best = Math.min(best, triDist2(px, py, pz, P, I[t * 3], I[t * 3 + 1], I[t * 3 + 2]));
        }
      }
      out[s] = Math.sqrt(best);
    }
    return out;
  };
}
// Past a quarter of the diagonal a point stands for a lost part anyway.
const distances = (P, I, pts) => surface(P, I, 0.25 * core.bounds(P).diag)(pts);

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

// Open and non-manifold edges, with vertices at the same position counted as one (sorted keys, so millions of triangles
// stay cheap).
function edgeCounts(P, I) {
  const V = P.length / 3, bits = new Uint32Array(new Float32Array(P).buffer), id = new Int32Array(V);
  let cap = 16;
  while (cap < V * 2) cap <<= 1;
  const table = new Int32Array(cap).fill(-1);
  let G = 0;
  for (let v = 0; v < V; v++) {
    let h = (Math.imul(bits[v * 3], 73856093) ^ Math.imul(bits[v * 3 + 1], 19349663) ^ Math.imul(bits[v * 3 + 2], 83492791)) & (cap - 1);
    for (;;) {
      const u = table[h];
      if (u < 0) { table[h] = v; id[v] = G++; break; }
      if (bits[u * 3] === bits[v * 3] && bits[u * 3 + 1] === bits[v * 3 + 1] && bits[u * 3 + 2] === bits[v * 3 + 2]) { id[v] = id[u]; break; }
      h = (h + 1) & (cap - 1);
    }
  }
  const keys = new Float64Array(I.length);
  let m = 0;
  for (let t = 0; t < I.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = id[I[t + k]], b = id[I[t + (k + 1) % 3]];
    if (a !== b) keys[m++] = a < b ? a * G + b : b * G + a;
  }
  const sorted = keys.subarray(0, m).sort();
  let open = 0, nonManifold = 0;
  for (let i = 0; i < m;) { let j = i + 1; while (j < m && sorted[j] === sorted[i]) j++; if (j - i === 1) open++; else if (j - i > 2) nonManifold++; i = j; }
  return { open, nonManifold, positions: G };
}

// Triangles without area: two corners at one position, or all three on a line.
function degenerate(P, I) {
  let n = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (!(nx * nx + ny * ny + nz * nz > 1e-24 * (ux * ux + uy * uy + uz * uz) * (vx * vx + vy * vy + vz * vz))) n++;
  }
  return n;
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

const pct = (d, diag) => { const s = Float64Array.from(d).sort(); let m = 0; for (const x of s) m += x; return { mean: (100 * m) / s.length / diag, p99: (100 * s[Math.floor(s.length * 0.99)]) / diag, max: (100 * s[s.length - 1]) / diag }; };
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
    const st = { ...settings, targetTris: topology === 'quads' ? faces * 2 : faces, topology, uvMode: 'auto', deferUV: true, quadAdapt: 0.75, quadSharp: core.QUAD_SHARP, symmetry: plane ? { ...plane, keepPositive: true } : null };
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
