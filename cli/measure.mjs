// Measurements on meshes, for the command line and the bench: how far the original's surface lies from a result, open
// and non-manifold edges, and the app's mirror plane search (which asks the nearest point of the surface to a point).
import { bounds } from '../src/core.js';

// Area-weighted points on a triangle mesh (deterministic).
export function samples(P, I, K) {
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
  const b = bounds(P), cell = b.diag / 80, inv = 1 / cell, n = [0, 1, 2].map(k => Math.max(1, Math.ceil(b.size[k] * inv) + 1));
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
export const distances = (P, I, pts) => surface(P, I, 0.25 * bounds(P).diag)(pts);

// Mean, 99th percentile and largest of distances, as percentages of diag.
export const pct = (d, diag) => { const s = Float64Array.from(d).sort(); let m = 0; for (const x of s) m += x; return { mean: (100 * m) / s.length / diag, p99: (100 * s[Math.floor(s.length * 0.99)]) / diag, max: (100 * s[s.length - 1]) / diag }; };

// How far the original's surface lies from a result, as the bench measures it: 60,000 points spread over the original by
// area, each point's distance to the result, as percentages of the original's diagonal. plane: a mirrored result is
// measured on its kept half only, since the other half is its copy and the original is never quite symmetric.
export function deviation(original, result, plane = null) {
  let pts = samples(original.positions, original.index, 60000);
  if (plane) {
    const s = plane.keepPositive === false ? -1 : 1, kept = [];
    for (let i = 0; i < pts.length; i += 3) if (s * (pts[i + plane.axis] - plane.offset) >= 0) kept.push(pts[i], pts[i + 1], pts[i + 2]);
    pts = Float64Array.from(kept);
  }
  return pct(distances(result.positions, result.index, pts), bounds(original.positions).diag);
}

// Open and non-manifold edges, with vertices at the same position counted as one (sorted keys, so millions of triangles
// stay cheap).
export function edgeCounts(P, I) {
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
export function degenerate(P, I) {
  let n = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (!(nx * nx + ny * ny + nz * nz > 1e-24 * (ux * ux + uy * uy + uz * uz) * (vx * vx + vy * vy + vz * vz))) n++;
  }
  return n;
}

// A bounding volume hierarchy over a triangle mesh: nearest(x, y, z) is how far the point lies from the surface, exactly
// and however far off it is. Triangles are split at the median along the longest axis of their centres, down to 8.
export function surfaceTree(P, I) {
  const T = I.length / 3, LEAF = 8, cen = new Float32Array(T * 3), order = new Uint32Array(T);
  for (let t = 0; t < T; t++) {
    order[t] = t;
    for (let k = 0; k < 3; k++) cen[t * 3 + k] = (P[I[t * 3] * 3 + k] + P[I[t * 3 + 1] * 3 + k] + P[I[t * 3 + 2] * 3 + k]) / 3;
  }
  // Per node: its box, and either its two children (a, b) or, for a leaf, -1 - its first triangle in order (a) and how
  // many (b).
  const cap = 2 * Math.ceil((2 * Math.max(1, T)) / LEAF) + 1, box = new Float32Array(cap * 6), A = new Int32Array(cap), B = new Int32Array(cap);
  let nodes = 0;
  // Puts the k-th smallest centre along axis at order[k], smaller ones before it and larger ones after (quickselect).
  const select = (lo, hi, k, axis) => {
    while (hi > lo) {
      const pivot = cen[order[(lo + hi) >> 1] * 3 + axis];
      let i = lo, j = hi;
      while (i <= j) {
        while (cen[order[i] * 3 + axis] < pivot) i++;
        while (cen[order[j] * 3 + axis] > pivot) j--;
        if (i <= j) { const s = order[i]; order[i] = order[j]; order[j] = s; i++; j--; }
      }
      if (k <= j) hi = j; else if (k >= i) lo = i; else return;
    }
  };
  const build = (start, end) => {
    const n = nodes++, o = n * 6;
    if (end - start <= LEAF) {
      A[n] = -1 - start;
      B[n] = end - start;
      box[o] = box[o + 1] = box[o + 2] = Infinity;
      box[o + 3] = box[o + 4] = box[o + 5] = -Infinity;
      for (let i = start; i < end; i++) for (let c = 0; c < 3; c++) {
        const v = I[order[i] * 3 + c] * 3;
        for (let k = 0; k < 3; k++) { const x = P[v + k]; if (x < box[o + k]) box[o + k] = x; if (x > box[o + 3 + k]) box[o + 3 + k] = x; }
      }
      return n;
    }
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) for (let k = 0; k < 3; k++) { const x = cen[order[i] * 3 + k]; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; }
    const e = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], axis = e[0] >= e[1] && e[0] >= e[2] ? 0 : e[1] >= e[2] ? 1 : 2;
    const mid = (start + end) >> 1;
    select(start, end - 1, mid, axis);
    const l = build(start, mid), r = build(mid, end);
    A[n] = l;
    B[n] = r;
    for (let k = 0; k < 3; k++) {
      box[o + k] = Math.min(box[l * 6 + k], box[r * 6 + k]);
      box[o + 3 + k] = Math.max(box[l * 6 + 3 + k], box[r * 6 + 3 + k]);
    }
    return n;
  };
  if (T) build(0, T);
  const boxDist2 = (n, x, y, z) => {
    const o = n * 6, dx = Math.max(box[o] - x, 0, x - box[o + 3]), dy = Math.max(box[o + 1] - y, 0, y - box[o + 4]), dz = Math.max(box[o + 2] - z, 0, z - box[o + 5]);
    return dx * dx + dy * dy + dz * dz;
  };
  const stack = new Int32Array(256);
  const nearest = (x, y, z) => {
    if (!T) return Infinity;
    let best = Infinity, sp = 0;
    stack[sp++] = 0;
    while (sp) {
      const n = stack[--sp];
      if (boxDist2(n, x, y, z) >= best) continue;
      if (A[n] < 0) {
        const s = -1 - A[n], e = s + B[n];
        for (let i = s; i < e; i++) {
          const t = order[i], d = triDist2(x, y, z, P, I[t * 3], I[t * 3 + 1], I[t * 3 + 2]);
          if (d < best) best = d;
        }
        continue;
      }
      // The nearer child goes on top, so it is searched first and the other is often skipped.
      const l = A[n], r = B[n], dl = boxDist2(l, x, y, z), dr = boxDist2(r, x, y, z);
      if (dl < dr) { if (dr < best) stack[sp++] = r; stack[sp++] = l; } else { if (dl < best) stack[sp++] = l; stack[sp++] = r; }
    }
    return Math.sqrt(best);
  };
  return { nearest };
}

// The mirror plane the app's Detect finds (detectPlane in src/app.js): for each axis, plane positions are scanned around
// the middle of the model and refined by golden section, scoring how far the mirror images of sampled vertices land from
// its surface (the mean of the nearest 80%, so a one-sided feature can't pull the plane toward it); the axis whose plane
// fits best wins. mesh: the welded model; axis: search only that one. Returns { axis, offset, fit }, fit as in mirrorFit.
export function mirrorPlane(mesh, axis = null, tree = surfaceTree(mesh.positions, mesh.index)) {
  const P = mesh.positions, V = mesh.vertexCount, b = bounds(P), size = Math.max(...b.size) || 1;
  const sampled = count => { const step = Math.max(1, Math.floor(V / count)), out = []; for (let v = 0; v < V; v += step) out.push(v); return out; };
  const dists = (ax, offset, list) => {
    const d = new Float64Array(list.length), q = [0, 0, 0];
    for (let i = 0; i < list.length; i++) {
      const v = list[i] * 3;
      q[0] = P[v]; q[1] = P[v + 1]; q[2] = P[v + 2];
      q[ax] = 2 * offset - q[ax];
      d[i] = tree.nearest(q[0], q[1], q[2]);
    }
    return d;
  };
  const meanFit = (ax, offset, list) => { const d = dists(ax, offset, list); let s = 0; for (const x of d) s += x; return s / d.length / size; };
  const trimmed = (ax, offset, list) => {
    const d = dists(ax, offset, list).sort(), keep = Math.max(1, Math.floor(d.length * 0.8));
    let s = 0;
    for (let i = 0; i < keep; i++) s += d[i];
    return s / keep;
  };
  // Coarse scan around the box centre, then golden-section refinement of the plane position.
  const refine = (ax, list) => {
    const extent = b.max[ax] - b.min[ax] || 1, centre = (b.min[ax] + b.max[ax]) / 2;
    const steps = 12, span = extent * 0.35, stepSize = (2 * span) / steps, f = o => trimmed(ax, o, list);
    let best = centre, bestErr = Infinity;
    for (let i = 0; i <= steps; i++) {
      const o = centre - span + stepSize * i, e = f(o);
      if (e < bestErr) { bestErr = e; best = o; }
    }
    const g = (Math.sqrt(5) - 1) / 2;
    let a = best - stepSize, c = best + stepSize;
    let x1 = c - g * (c - a), x2 = a + g * (c - a), f1 = f(x1), f2 = f(x2);
    for (let it = 0; it < 14; it++) {
      if (f1 < f2) { c = x2; x2 = x1; f2 = f1; x1 = c - g * (c - a); f1 = f(x1); } else { a = x1; x1 = x2; f1 = f2; x2 = a + g * (c - a); f2 = f(x2); }
    }
    const offset = (a + c) / 2;
    return Math.abs(offset) < 1e-3 * size ? 0 : offset;
  };
  const coarse = sampled(800);
  let best = null;
  for (const ax of axis === null ? [0, 1, 2] : [axis]) {
    const offset = refine(ax, coarse), score = meanFit(ax, offset, coarse);
    if (!best || score < best.score) best = { axis: ax, offset, score };
  }
  return { axis: best.axis, offset: best.offset, fit: mirrorFit(mesh, best.axis, best.offset, tree) };
}

// How far the model's mirror image across a plane lands from its own surface, at 2,500 of its vertices, as the app shows
// it: the mean and the largest distance, as shares of the model's largest dimension.
export function mirrorFit(mesh, axis, offset, tree = surfaceTree(mesh.positions, mesh.index)) {
  const P = mesh.positions, V = mesh.vertexCount, size = Math.max(...bounds(P).size) || 1, step = Math.max(1, Math.floor(V / 2500)), q = [0, 0, 0];
  let sum = 0, max = 0, n = 0;
  for (let v = 0; v < V; v += step) {
    q[0] = P[v * 3]; q[1] = P[v * 3 + 1]; q[2] = P[v * 3 + 2];
    q[axis] = 2 * offset - q[axis];
    const d = tree.nearest(q[0], q[1], q[2]);
    sum += d;
    if (d > max) max = d;
    n++;
  }
  return { mean: n ? sum / n / size : 0, max: max / size };
}
