// UVs laid out for hand painting: few, large charts whose seams run where they show least, flattened with little
// stretch, turned upright and laid out on the sheet in the order they sit on the model, bottom to top.
//
// How the charts come about:
// - Every edge between two faces gets a seam cost per unit length: high on smooth surface that is seen from outside,
//   low on hidden surface, in folds, along sharp edges and where the original's colour changes. A quad's two triangles
//   always stay in one chart.
// - Small first charts grow across the most expensive edges first while the curvature they enclose stays small, so
//   their borders settle on cheap edges. One-cell spurs and notches are smoothed off.
// - Charts then join in rounds, the neighbours with the costliest seam between them first. A join stands only when
//   the joined chart still flattens without folding over or overlapping itself and without stretching seen surface
//   much. Charts painted in clearly different colours don't join (they are different parts). Tiny charts join their
//   longest neighbour even when that stretches a little more.
// - Tubes and holes are cut open along the cheapest path between their border loops.
// - Flattening: least squares conformal maps (Lévy et al. 2002), or Tutte's embedding when that folds, refined by
//   as-rigid-as-possible iterations (Liu et al. 2008, "A Local/Global Approach to Mesh Parameterization") that never
//   step far enough to flip a triangle.
// - Each chart is turned so the model's up points up the sheet (charts that don't rise use the model's front), and
//   nudged so its quads' edges run along the sheet. Charts are packed per material in bands by height, lowest first,
//   biggest first within a band; strips much taller than wide may lie on their side.

const TAU = Math.PI * 2;

class MinHeap {
  constructor(cap = 256) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.size = 0; this.lastKey = 0; }
  push(key, val) {
    if (this.size === this.k.length) {
      const k = new Float64Array(this.size * 2), v = new Int32Array(this.size * 2);
      k.set(this.k); v.set(this.v); this.k = k; this.v = v;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const top = this.v[0], n = --this.size;
    this.lastKey = this.k[0];
    if (n > 0) {
      const key = this.k[n], val = this.v[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && this.k[c + 1] < this.k[c]) c++;
        if (this.k[c] >= key) break;
        this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
      }
      this.k[i] = key; this.v[i] = val;
    }
    return top;
  }
}

// ---------- the surface ----------
// Positions (vertices at bit-identical positions are one), faces' normals, areas and centres, cells (a quad's two
// triangles), edges by position with their half-edges, and per position its cells, angle defect and whether it lies
// on an open border.
function surfaceOf(mesh) {
  const P = mesh.positions, idx = mesh.index, T = idx.length / 3, V = mesh.vertexCount, Q = mesh.quad;
  const bits = new Uint32Array(P.buffer, P.byteOffset, V * 3), pmap = new Map(), pid = new Int32Array(V);
  for (let v = 0; v < V; v++) {
    const k = `${bits[v * 3]},${bits[v * 3 + 1]},${bits[v * 3 + 2]}`;
    let g = pmap.get(k);
    if (g === undefined) pmap.set(k, g = pmap.size);
    pid[v] = g;
  }
  const NP = pmap.size, fn = new Float64Array(T * 3), area = new Float64Array(T), cen = new Float64Array(T * 3);
  for (let t = 0; t < T; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
    area[t] = l / 2;
    if (l > 0) { fn[t * 3] = nx / l; fn[t * 3 + 1] = ny / l; fn[t * 3 + 2] = nz / l; }
    for (let k = 0; k < 3; k++) cen[t * 3 + k] = (P[a + k] + P[b + k] + P[c + k]) / 3;
  }
  const cell = new Int32Array(T);
  let C = 0;
  for (let t = 0; t < T; t++) {
    if (Q && Q[t] === 2 && t > 0) { cell[t] = cell[t - 1]; continue; }
    cell[t] = C++;
  }
  const emap = new Map();
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const a = pid[idx[t * 3 + k]], b = pid[idx[t * 3 + ((k + 1) % 3)]];
    if (a === b) continue;
    const key = a < b ? a * NP + b : b * NP + a;
    let l = emap.get(key);
    if (!l) emap.set(key, l = []);
    l.push(t * 3 + k);
  }
  const edges = [], he = new Array(T * 3), byPair = new Map();
  for (const [key, h] of emap) {
    const t = (h[0] / 3) | 0, k = h[0] % 3, v0 = idx[t * 3 + k], v1 = idx[t * 3 + ((k + 1) % 3)];
    const e = { a: Math.floor(key / NP), b: key % NP, h, L: Math.hypot(P[v0 * 3] - P[v1 * 3], P[v0 * 3 + 1] - P[v1 * 3 + 1], P[v0 * 3 + 2] - P[v1 * 3 + 2]), cost: 0, forced: false, inner: false, c1: -1, c2: -1 };
    edges.push(e);
    byPair.set(key, e);
    for (const x of h) he[x] = e;
  }
  const angle = new Float64Array(NP), border = new Uint8Array(NP), rep = new Int32Array(NP), cellsAt = Array.from({ length: NP }, () => []);
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const v = idx[t * 3 + k], p = pid[v];
    rep[p] = v;
    if (!cellsAt[p].includes(cell[t])) cellsAt[p].push(cell[t]);
    const a = idx[t * 3 + ((k + 1) % 3)] * 3, b = idx[t * 3 + ((k + 2) % 3)] * 3, o = v * 3;
    const ux = P[a] - P[o], uy = P[a + 1] - P[o + 1], uz = P[a + 2] - P[o + 2], wx = P[b] - P[o], wy = P[b + 1] - P[o + 1], wz = P[b + 2] - P[o + 2];
    const lu = Math.hypot(ux, uy, uz), lw = Math.hypot(wx, wy, wz);
    if (lu > 0 && lw > 0) angle[p] += Math.acos(Math.max(-1, Math.min(1, (ux * wx + uy * wy + uz * wz) / (lu * lw))));
  }
  for (const e of edges) if (e.h.length !== 2) border[e.a] = border[e.b] = 1;
  const K = new Float64Array(NP);
  for (let p = 0; p < NP; p++) K[p] = border[p] ? 0 : TAU - angle[p];
  // per triangle, the triangle across each edge (-1 at open or non-manifold edges)
  const across = new Int32Array(T * 3).fill(-1);
  for (const e of edges) if (e.h.length === 2) { across[e.h[0]] = (e.h[1] / 3) | 0; across[e.h[1]] = (e.h[0] / 3) | 0; }
  return { T, NP, pid, fn, area, cen, cell, C, edges, he, byPair, cellsAt, K, border, rep, across };
}

// Seam cost per unit length of every edge between two cells: seen surface costs most, hidden surface little; folds and
// sharp convex edges cost less, since the shape hides a break there; so does a change of the original's colour, since
// the paint changes there anyway. Edges between materials, parts or texel densities must be seams.
function seamCosts(mesh, S, vis, colors, density) {
  const { edges, cell, fn, area, cen, rep, T, C } = S, idx = mesh.index;
  const cn = new Float64Array(C * 3), cc = new Float64Array(C * 3), ca = new Float64Array(C);
  let col = null;
  if (colors) col = new Float64Array(C * 3);
  for (let t = 0; t < T; t++) {
    const c = cell[t], a = area[t];
    for (let k = 0; k < 3; k++) { cn[c * 3 + k] += fn[t * 3 + k] * a; cc[c * 3 + k] += cen[t * 3 + k] * a; }
    if (col) for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) col[c * 3 + j] += (colors[idx[t * 3 + k] * 3 + j] * a) / 3;
    ca[c] += a;
  }
  for (let c = 0; c < C; c++) {
    const l = Math.hypot(cn[c * 3], cn[c * 3 + 1], cn[c * 3 + 2]) || 1;
    for (let k = 0; k < 3; k++) { cn[c * 3 + k] /= l; cc[c * 3 + k] /= ca[c] || 1; if (col) col[c * 3 + k] /= ca[c] || 1; }
  }
  S.cellColor = col;
  S.cellArea = ca;
  const group = t => mesh.vMat[idx[t * 3]] * 65536 + mesh.vPart[idx[t * 3]];
  const inner = [];
  for (const e of edges) {
    if (e.h.length !== 2) { e.forced = true; continue; }
    const t1 = (e.h[0] / 3) | 0, t2 = (e.h[1] / 3) | 0, c1 = cell[t1], c2 = cell[t2];
    if (c1 === c2) { e.inner = true; continue; }
    e.c1 = c1; e.c2 = c2;
    if (group(t1) !== group(t2) || (density && density[t1] !== density[t2])) e.forced = true;
    const v = vis ? (vis[rep[e.a]] + vis[rep[e.b]]) / 2 : 1;
    const d = cn[c1 * 3] * cn[c2 * 3] + cn[c1 * 3 + 1] * cn[c2 * 3 + 1] + cn[c1 * 3 + 2] * cn[c2 * 3 + 2], th = Math.acos(Math.max(-1, Math.min(1, d)));
    const concave = (cc[c2 * 3] - cc[c1 * 3]) * cn[c1 * 3] + (cc[c2 * 3 + 1] - cc[c1 * 3 + 1]) * cn[c1 * 3 + 1] + (cc[c2 * 3 + 2] - cc[c1 * 3 + 2]) * cn[c1 * 3 + 2] > 0;
    const shape = concave ? Math.max(0.2, 1 - th / (Math.PI / 3)) : th > (40 * Math.PI) / 180 ? 0.35 : 1;
    let tint = 1;
    if (col) tint = 1 / (1 + (Math.hypot(col[c1 * 3] - col[c2 * 3], col[c1 * 3 + 1] - col[c2 * 3 + 1], col[c1 * 3 + 2] - col[c2 * 3 + 2]) / 30) ** 2);
    e.cost = (0.03 + v * v) * shape * tint;
    inner.push(e);
  }
  return inner;
}

// ---------- first charts ----------
// Kruskal over the cell graph, most expensive edges first: two charts join while the angle defect of the positions that
// turn inner (counted fully where seen, 15% where hidden) stays under kMax. Charts under minShare of the surface then
// join the neighbour they share the most boundary with.
function firstCharts(S, vis, inner, kMax, minShare) {
  const { C, cellsAt, K, border, rep, NP } = S;
  const par = Int32Array.from({ length: C }, (_, i) => i), find = x => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  const members = Array.from({ length: C }, (_, i) => [i]), kin = new Float64Array(C), chartArea = Float64Array.from(S.cellArea);
  let total = 0;
  for (const a of S.cellArea) total += a;
  const cellPos = Array.from({ length: C }, () => []);
  for (let p = 0; p < NP; p++) for (const c of cellsAt[p]) cellPos[c].push(p);
  const weight = p => Math.abs(K[p]) * (0.15 + 0.85 * (vis ? vis[rep[p]] : 1));
  const isInner = new Uint8Array(NP);
  // positions that turn inner when A and B join, and their weighted angle defect
  const turning = (A, B, commit) => {
    const small = members[A].length < members[B].length ? A : B;
    let g = 0;
    const seen = new Set();
    for (const c of members[small]) for (const p of cellPos[c]) {
      if (isInner[p] || border[p] || seen.has(p)) continue;
      seen.add(p);
      let all = true;
      for (const q of cellsAt[p]) { const r = find(q); if (r !== A && r !== B) { all = false; break; } }
      if (!all) continue;
      g += weight(p);
      if (commit) isInner[p] = 1;
    }
    return g;
  };
  const join = (A, B) => {
    const g = turning(A, B, true), small = members[A].length < members[B].length ? A : B, big = small === A ? B : A;
    par[small] = big;
    for (const c of members[small]) members[big].push(c);
    members[small] = [];
    kin[big] += kin[small] + g;
    chartArea[big] += chartArea[small];
  };
  const order = inner.filter(e => !e.forced).sort((x, y) => y.cost - x.cost || y.L - x.L);
  for (const e of order) {
    const A = find(e.c1), B = find(e.c2);
    if (A === B || kin[A] + kin[B] + turning(A, B, false) > kMax) continue;
    join(A, B);
  }
  for (let pass = 0; pass < 3; pass++) {
    const shared = new Map();
    for (const e of inner) {
      if (e.forced) continue;
      const A = find(e.c1), B = find(e.c2);
      if (A === B) continue;
      for (const [x, y] of [[A, B], [B, A]]) {
        if (chartArea[x] >= minShare * total) continue;
        let m = shared.get(x);
        if (!m) shared.set(x, m = new Map());
        m.set(y, (m.get(y) || 0) + e.L);
      }
    }
    let joined = 0;
    for (const [x, m] of shared) {
      const X = find(x);
      if (X !== x || chartArea[X] >= minShare * total) continue;
      let best = -1, bl = 0;
      for (const [y, l] of m) { const Y = find(y); if (Y !== X && l > bl) { bl = l; best = Y; } }
      if (best >= 0) { join(X, best); joined++; }
    }
    if (!joined) break;
  }
  const label = new Int32Array(C), ids = new Map();
  for (let c = 0; c < C; c++) { const r = find(c); if (!ids.has(r)) ids.set(r, ids.size); label[c] = ids.get(r); }
  return { label, count: ids.size };
}

// A cell with more seam cost towards one neighbouring chart than towards its own moves there: takes off one-cell
// spurs and fills one-cell notches.
function smoothLabels(S, inner, label, count, passes = 4) {
  const cellEdges = Array.from({ length: S.C }, () => []), size = new Int32Array(count);
  for (const e of inner) { cellEdges[e.c1].push(e); cellEdges[e.c2].push(e); }
  for (let c = 0; c < S.C; c++) size[label[c]]++;
  for (let pass = 0; pass < passes; pass++) {
    let moves = 0;
    for (let c = 0; c < S.C; c++) {
      const own = label[c], toward = new Map();
      let keep = 0, forced = false;
      for (const e of cellEdges[c]) {
        if (e.forced) { forced = true; break; }
        const o = label[e.c1 === c ? e.c2 : e.c1], w = e.L * (e.cost + 1e-3);
        if (o === own) keep += w; else toward.set(o, (toward.get(o) || 0) + w);
      }
      if (forced || !toward.size || size[own] <= 1) continue;
      let best = -1, bw = 0;
      for (const [o, w] of toward) if (w > bw) { bw = w; best = o; }
      if (bw > keep * 1.2) { label[c] = best; size[own]--; size[best]++; moves++; }
    }
    if (!moves) break;
  }
}

// Connected pieces of a set of triangles, joined across shared edges.
function pieces(S, tris) {
  const slot = new Map(tris.map((t, i) => [t, i])), comp = new Int32Array(tris.length).fill(-1), out = [];
  for (let i = 0; i < tris.length; i++) {
    if (comp[i] >= 0) continue;
    const piece = [tris[i]];
    comp[i] = out.length;
    for (let q = 0; q < piece.length; q++) for (let k = 0; k < 3; k++) {
      const u = S.across[piece[q] * 3 + k];
      if (u < 0) continue;
      const j = slot.get(u);
      if (j !== undefined && comp[j] < 0) { comp[j] = out.length; piece.push(u); }
    }
    out.push(piece);
  }
  return out;
}

// Two halves of a set of triangles, split across its longest axis by area, quads kept whole.
function halves(S, tris) {
  const { cen, area, cell } = S;
  let mx = 0, my = 0, mz = 0, w = 0;
  for (const t of tris) { const a = area[t] + 1e-30; mx += cen[t * 3] * a; my += cen[t * 3 + 1] * a; mz += cen[t * 3 + 2] * a; w += a; }
  mx /= w; my /= w; mz /= w;
  const cov = [0, 0, 0, 0, 0, 0];
  for (const t of tris) {
    const x = cen[t * 3] - mx, y = cen[t * 3 + 1] - my, z = cen[t * 3 + 2] - mz, a = area[t] + 1e-30;
    cov[0] += x * x * a; cov[1] += x * y * a; cov[2] += x * z * a; cov[3] += y * y * a; cov[4] += y * z * a; cov[5] += z * z * a;
  }
  let ax = 1, ay = 0.7, az = 0.3;
  for (let it = 0; it < 24; it++) {
    const nx = cov[0] * ax + cov[1] * ay + cov[2] * az, ny = cov[1] * ax + cov[3] * ay + cov[4] * az, nz = cov[2] * ax + cov[4] * ay + cov[5] * az;
    const l = Math.hypot(nx, ny, nz) || 1;
    ax = nx / l; ay = ny / l; az = nz / l;
  }
  const byCell = new Map();
  for (const t of tris) { const c = cell[t]; let l = byCell.get(c); if (!l) byCell.set(c, l = []); l.push(t); }
  const cells = [...byCell.values()].map(ts => {
    let p = 0, a = 0;
    for (const t of ts) { p += ((cen[t * 3] - mx) * ax + (cen[t * 3 + 1] - my) * ay + (cen[t * 3 + 2] - mz) * az) * area[t]; a += area[t]; }
    return { ts, p: a > 0 ? p / a : 0, a };
  }).sort((x, y) => x.p - y.p);
  let acc = 0;
  const h0 = [], h1 = [];
  for (const c of cells) { (acc < w / 2 ? h0 : h1).push(...c.ts); acc += c.a; }
  if (!h1.length) h1.push(h0.pop());
  return [h0, h1];
}

// ---------- one chart's own mesh ----------
// Corners at one position share a vertex when joined inside the chart by edges that aren't cut. Also the chart's
// border: which vertices are on it, its loops, and the Euler characteristic (1 for a disk).
function chartMesh(mesh, S, tris, cuts) {
  const idx = mesh.index, P = mesh.positions, m = tris.length, slot = new Map(tris.map((t, i) => [t, i]));
  const par = Int32Array.from({ length: m * 3 }, (_, i) => i), find = x => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };
  for (let i = 0; i < m; i++) {
    const t = tris[i];
    for (let k = 0; k < 3; k++) {
      const e = S.he[t * 3 + k];
      if (!e || e.h.length !== 2 || (!e.inner && cuts.has(e))) continue;
      const other = e.h[0] === t * 3 + k ? e.h[1] : e.h[0], t2 = (other / 3) | 0, j = slot.get(t2);
      if (j === undefined || j < i) continue;
      const k2 = other % 3, a1 = i * 3 + k, b1 = i * 3 + ((k + 1) % 3), x2 = j * 3 + k2, y2 = j * 3 + ((k2 + 1) % 3);
      if (S.pid[idx[t2 * 3 + k2]] === S.pid[idx[t * 3 + k]]) { unite(a1, x2); unite(b1, y2); } else { unite(a1, y2); unite(b1, x2); }
    }
  }
  const map = new Map(), lt = new Int32Array(m * 3), src = [];
  for (let c = 0; c < m * 3; c++) {
    const r = find(c);
    let v = map.get(r);
    if (v === undefined) { map.set(r, v = map.size); src.push(idx[tris[(c / 3) | 0] * 3 + (c % 3)]); }
    lt[c] = v;
  }
  const n = map.size, X = new Float64Array(n * 3);
  for (let v = 0; v < n; v++) { const s = src[v]; X[v * 3] = P[s * 3]; X[v * 3 + 1] = P[s * 3 + 1]; X[v * 3 + 2] = P[s * 3 + 2]; }
  const uses = new Map();
  for (let i = 0; i < m; i++) for (let k = 0; k < 3; k++) {
    const a = lt[i * 3 + k], b = lt[i * 3 + ((k + 1) % 3)], key = a < b ? a * n + b : b * n + a;
    uses.set(key, (uses.get(key) || 0) + 1);
  }
  const onBorder = new Uint8Array(n), bn = new Map();
  for (const [key, c] of uses) {
    if (c !== 1) continue;
    const a = Math.floor(key / n), b = key % n;
    onBorder[a] = onBorder[b] = 1;
    (bn.get(a) || bn.set(a, []).get(a)).push(b);
    (bn.get(b) || bn.set(b, []).get(b)).push(a);
  }
  const loopOf = new Int32Array(n).fill(-1);
  let loops = 0;
  for (const s of bn.keys()) {
    if (loopOf[s] >= 0) continue;
    const st = [s];
    loopOf[s] = loops;
    while (st.length) { const x = st.pop(); for (const y of bn.get(x)) if (loopOf[y] < 0) { loopOf[y] = loops; st.push(y); } }
    loops++;
  }
  return { n, tris, lt, X, src: Int32Array.from(src), onBorder, loopOf, loops, chi: n - uses.size + m, uses };
}

// Cheapest path from border loop 0 to any other loop, over the chart's edges (local vertices).
function bridge(cm, costOf) {
  const n = cm.n, adj = Array.from({ length: n }, () => []);
  for (const key of cm.uses.keys()) {
    const a = Math.floor(key / n), b = key % n, c = costOf(a, b);
    if (c < Infinity) { adj[a].push(b, c); adj[b].push(a, c); }
  }
  const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), heap = new MinHeap();
  for (let v = 0; v < n; v++) if (cm.loopOf[v] === 0) { dist[v] = 0; heap.push(0, v); }
  while (heap.size) {
    const x = heap.pop();
    if (heap.lastKey > dist[x]) continue;
    if (cm.loopOf[x] > 0) { const path = []; for (let y = x; y >= 0; y = prev[y]) path.push(y); return path.reverse(); }
    const l = adj[x];
    for (let q = 0; q < l.length; q += 2) {
      const y = l[q];
      if (cm.loopOf[y] === 0) continue;
      const d = dist[x] + l[q + 1];
      if (d < dist[y]) { dist[y] = d; prev[y] = x; heap.push(d, y); }
    }
  }
  return null;
}

// ---------- flattening ----------
// Projection onto the plane of the chart's average normal.
function planar(cm) {
  const { n, X, lt } = cm, m = lt.length / 3;
  let nx = 0, ny = 0, nz = 0;
  for (let t = 0; t < m; t++) {
    const a = lt[t * 3] * 3, b = lt[t * 3 + 1] * 3, c = lt[t * 3 + 2] * 3;
    const ux = X[b] - X[a], uy = X[b + 1] - X[a + 1], uz = X[b + 2] - X[a + 2], vx = X[c] - X[a], vy = X[c + 1] - X[a + 1], vz = X[c + 2] - X[a + 2];
    nx += uy * vz - uz * vy; ny += uz * vx - ux * vz; nz += ux * vy - uy * vx;
  }
  let l = Math.hypot(nx, ny, nz);
  if (!(l > 0)) { nx = 0; ny = 0; nz = 1; l = 1; }
  nx /= l; ny /= l; nz /= l;
  const hx = Math.abs(nx) < 0.9 ? 1 : 0, hy = hx ? 0 : 1;
  let e1x = hy * nz, e1y = -hx * nz, e1z = hx * ny - hy * nx;
  const le = Math.hypot(e1x, e1y, e1z);
  e1x /= le; e1y /= le; e1z /= le;
  const e2x = ny * e1z - nz * e1y, e2y = nz * e1x - nx * e1z, e2z = nx * e1y - ny * e1x, uv = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) { uv[i] = X[i * 3] * e1x + X[i * 3 + 1] * e1y + X[i * 3 + 2] * e1z; uv[n + i] = X[i * 3] * e2x + X[i * 3 + 1] * e2y + X[i * 3 + 2] * e2z; }
  return uv;
}

// Least squares conformal map from the planar start, solved with Jacobi-preconditioned CG, pins where the start puts them.
function lscm(n, tris, X, uv, pinA, pinB) {
  const m = tris.length / 3, co = new Float64Array(m * 6), diag = new Float64Array(2 * n);
  for (let t = 0; t < m; t++) {
    const i0 = tris[t * 3] * 3, i1 = tris[t * 3 + 1] * 3, i2 = tris[t * 3 + 2] * 3;
    const e1x = X[i1] - X[i0], e1y = X[i1 + 1] - X[i0 + 1], e1z = X[i1 + 2] - X[i0 + 2], e2x = X[i2] - X[i0], e2y = X[i2 + 1] - X[i0 + 1], e2z = X[i2 + 2] - X[i0 + 2];
    const l1 = Math.hypot(e1x, e1y, e1z), nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x, ln = Math.hypot(nx, ny, nz);
    if (l1 === 0 || ln === 0) continue;
    const ax = e1x / l1, ay = e1y / l1, az = e1z / l1, bx = (ny * az - nz * ay) / ln, by = (nz * ax - nx * az) / ln, bz = (nx * ay - ny * ax) / ln;
    const x1 = l1, x2 = e2x * ax + e2y * ay + e2z * az, y2 = e2x * bx + e2y * by + e2z * bz, s = 1 / Math.sqrt(x1 * y2);
    const w = [(x2 - x1) * s, y2 * s, -x2 * s, -y2 * s, x1 * s, 0];
    for (let k = 0; k < 3; k++) {
      co[t * 6 + k * 2] = w[k * 2]; co[t * 6 + k * 2 + 1] = w[k * 2 + 1];
      const d = w[k * 2] * w[k * 2] + w[k * 2 + 1] * w[k * 2 + 1], v = tris[t * 3 + k];
      diag[v] += d; diag[n + v] += d;
    }
  }
  const mul = (x, y) => {
    y.fill(0);
    for (let t = 0; t < m; t++) {
      const o = t * 6, i0 = tris[t * 3], i1 = tris[t * 3 + 1], i2 = tris[t * 3 + 2];
      const a0 = co[o], b0 = co[o + 1], a1 = co[o + 2], b1 = co[o + 3], a2 = co[o + 4], b2 = co[o + 5];
      const r1 = a0 * x[i0] - b0 * x[n + i0] + a1 * x[i1] - b1 * x[n + i1] + a2 * x[i2] - b2 * x[n + i2];
      const r2 = b0 * x[i0] + a0 * x[n + i0] + b1 * x[i1] + a1 * x[n + i1] + b2 * x[i2] + a2 * x[n + i2];
      y[i0] += a0 * r1 + b0 * r2; y[n + i0] += a0 * r2 - b0 * r1;
      y[i1] += a1 * r1 + b1 * r2; y[n + i1] += a1 * r2 - b1 * r1;
      y[i2] += a2 * r1 + b2 * r2; y[n + i2] += a2 * r2 - b2 * r1;
    }
    y[pinA] = y[pinB] = y[n + pinA] = y[n + pinB] = 0;
  };
  const N2 = 2 * n, x = Float64Array.from(uv), r = new Float64Array(N2), z = new Float64Array(N2), p = new Float64Array(N2), q = new Float64Array(N2);
  mul(x, q);
  let rz = 0, r0 = 0;
  for (let i = 0; i < N2; i++) { r[i] = -q[i]; z[i] = r[i] / (diag[i] || 1); p[i] = z[i]; rz += r[i] * z[i]; r0 += r[i] * r[i]; }
  r0 = Math.sqrt(r0);
  const maxIt = Math.min(3000, 200 + 8 * Math.sqrt(n));
  for (let it = 0; it < maxIt && r0 > 0; it++) {
    mul(p, q);
    let pq = 0;
    for (let i = 0; i < N2; i++) pq += p[i] * q[i];
    if (!(pq > 0)) break;
    const alpha = rz / pq;
    let rr = 0;
    for (let i = 0; i < N2; i++) { x[i] += alpha * p[i]; r[i] -= alpha * q[i]; rr += r[i] * r[i]; }
    if (Math.sqrt(rr) < 1e-6 * r0) break;
    let rzn = 0;
    for (let i = 0; i < N2; i++) { z[i] = r[i] / (diag[i] || 1); rzn += r[i] * z[i]; }
    const beta = rzn / rz;
    rz = rzn;
    for (let i = 0; i < N2; i++) p[i] = z[i] + beta * p[i];
  }
  return x;
}

// Tutte's embedding: the border loop on a circle by arc length, inner vertices at the average of their neighbours. It
// never folds, so it's the start when the conformal map does.
function tutte(cm) {
  const { n, X, lt, uses } = cm, m = lt.length / 3, next = new Map();
  for (let t = 0; t < m; t++) for (let k = 0; k < 3; k++) {
    const a = lt[t * 3 + k], b = lt[t * 3 + ((k + 1) % 3)], key = a < b ? a * n + b : b * n + a;
    if (uses.get(key) === 1) next.set(a, b);
  }
  if (!next.size) return null;
  const loop = [], s = next.keys().next().value;
  for (let v = s, g = 0; g <= next.size; g++) { loop.push(v); v = next.get(v); if (v === s || v === undefined) break; }
  if (loop.length < 3 || loop.length !== next.size) return null;
  const len = [0];
  for (let i = 1; i <= loop.length; i++) {
    const a = loop[i - 1], b = loop[i % loop.length];
    len.push(len[i - 1] + Math.hypot(X[a * 3] - X[b * 3], X[a * 3 + 1] - X[b * 3 + 1], X[a * 3 + 2] - X[b * 3 + 2]));
  }
  const total = len[loop.length], R = total / TAU, uv = new Float64Array(2 * n), fixed = new Uint8Array(n);
  loop.forEach((v, i) => { const th = (TAU * len[i]) / total; uv[v] = R * Math.cos(th); uv[n + v] = R * Math.sin(th); fixed[v] = 1; });
  const nb = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < m; t++) for (let k = 0; k < 3; k++) { const a = lt[t * 3 + k], b = lt[t * 3 + ((k + 1) % 3)]; nb[a].add(b); nb[b].add(a); }
  const L = nb.map(x => Int32Array.from(x));
  for (let sweep = 0; sweep < 400; sweep++) {
    let move = 0;
    for (let i = 0; i < n; i++) {
      if (fixed[i] || !L[i].length) continue;
      let sx = 0, sy = 0;
      for (const j of L[i]) { sx += uv[j]; sy += uv[n + j]; }
      sx /= L[i].length; sy /= L[i].length;
      move = Math.max(move, Math.abs(sx - uv[i]) + Math.abs(sy - uv[n + i]));
      uv[i] = sx; uv[n + i] = sy;
    }
    if (move < 1e-7 * R) break;
  }
  return uv;
}

// As-rigid-as-possible, set up once per chart: step(uv) returns where the global solve moves the vertices for the
// current per-triangle rotations. fixed (optional) marks vertices that stay where they are; otherwise one vertex is
// pinned. Only the free vertices are solved for. Cotangent weights are kept positive, so the system is an M-matrix and
// incomplete Cholesky preconditions it without breaking down.
function arapSolver(n, tris, X, tol, fixed = null) {
  const m = tris.length / 3, fi = new Int32Array(n).fill(-1), free = [];
  for (let i = 0; i < n; i++) if (fixed ? !fixed[i] : i !== 0) { fi[i] = free.length; free.push(i); }
  const nf = free.length, tl = [];
  for (let t = 0; t < m; t++) if (fi[tris[t * 3]] >= 0 || fi[tris[t * 3 + 1]] >= 0 || fi[tris[t * 3 + 2]] >= 0) tl.push(t);
  const loc = new Float64Array(tl.length * 3), w = new Float64Array(tl.length * 3);
  tl.forEach((t, q) => {
    const i0 = tris[t * 3] * 3, i1 = tris[t * 3 + 1] * 3, i2 = tris[t * 3 + 2] * 3;
    const e1x = X[i1] - X[i0], e1y = X[i1 + 1] - X[i0 + 1], e1z = X[i1 + 2] - X[i0 + 2], e2x = X[i2] - X[i0], e2y = X[i2 + 1] - X[i0 + 1], e2z = X[i2 + 2] - X[i0 + 2];
    const l1 = Math.hypot(e1x, e1y, e1z), x2 = l1 > 0 ? (e1x * e2x + e1y * e2y + e1z * e2z) / l1 : 0;
    const y2 = l1 > 0 ? Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x) / l1 : 0;
    loc[q * 3] = l1; loc[q * 3 + 1] = x2; loc[q * 3 + 2] = y2;
    const px = [0, l1, x2], py = [0, 0, y2];
    for (let k = 0; k < 3; k++) {
      const j = (k + 1) % 3, o = (k + 2) % 3, ux = px[j] - px[k], uy = py[j] - py[k], vx = px[o] - px[k], vy = py[o] - py[k], cr = Math.abs(ux * vy - uy * vx);
      w[q * 3 + k] = cr > 1e-24 ? Math.max(1e-4, (ux * vx + uy * vy) / cr) * 0.5 : 1e-4;
    }
  });
  // rows of the free vertices: diagonal, free neighbours (CSR, free indices) and fixed neighbours (for the right side)
  const diag = new Float64Array(nf), nbm = Array.from({ length: nf }, () => new Map()), fixm = Array.from({ length: nf }, () => new Map());
  tl.forEach((t, q) => {
    for (let k = 0; k < 3; k++) {
      const i = tris[t * 3 + ((k + 1) % 3)], j = tris[t * 3 + ((k + 2) % 3)], wt = w[q * 3 + k];
      for (const [x, y] of [[i, j], [j, i]]) {
        const fx = fi[x];
        if (fx < 0) continue;
        diag[fx] += wt;
        const fy = fi[y];
        if (fy >= 0) nbm[fx].set(fy, (nbm[fx].get(fy) || 0) + wt); else fixm[fx].set(y, (fixm[fx].get(y) || 0) + wt);
      }
    }
  });
  const rs = new Int32Array(nf + 1);
  for (let i = 0; i < nf; i++) rs[i + 1] = rs[i] + nbm[i].size;
  const cj = new Int32Array(rs[nf]), cw = new Float64Array(rs[nf]);
  for (let i = 0; i < nf; i++) { let o = rs[i]; for (const [j, wt] of nbm[i]) { cj[o] = j; cw[o] = wt; o++; } }
  const fs = new Int32Array(nf + 1);
  for (let i = 0; i < nf; i++) fs[i + 1] = fs[i] + fixm[i].size;
  const fj = new Int32Array(fs[nf]), fw = new Float64Array(fs[nf]);
  for (let i = 0; i < nf; i++) { let o = fs[i]; for (const [j, wt] of fixm[i]) { fj[o] = j; fw[o] = wt; o++; } }
  const mul = (x, y) => { for (let i = 0; i < nf; i++) { let s = diag[i] * x[i]; for (let o = rs[i]; o < rs[i + 1]; o++) s -= cw[o] * x[cj[o]]; y[i] = s; } };
  // incomplete Cholesky without fill: lower rows sorted by column
  const lstart = new Int32Array(nf + 1), lcols = [], lvals = [];
  for (let i = 0; i < nf; i++) {
    const row = [];
    for (let o = rs[i]; o < rs[i + 1]; o++) if (cj[o] < i) row.push([cj[o], -cw[o]]);
    row.sort((x, y) => x[0] - y[0]);
    for (const [j, v] of row) { lcols.push(j); lvals.push(v); }
    lstart[i + 1] = lcols.length;
  }
  const LC = Int32Array.from(lcols), LV = Float64Array.from(lvals), LD = new Float64Array(nf), at = new Map();
  for (let i = 0; i < nf; i++) for (let o = lstart[i]; o < lstart[i + 1]; o++) at.set(i * nf + LC[o], o);
  for (let i = 0; i < nf; i++) {
    for (let o = lstart[i]; o < lstart[i + 1]; o++) {
      const k = LC[o];
      let sum = LV[o];
      for (let oi = lstart[i]; oi < o; oi++) { const ok = at.get(k * nf + LC[oi]); if (ok !== undefined) sum -= LV[oi] * LV[ok]; }
      LV[o] = LD[k] > 0 ? sum / LD[k] : 0;
    }
    let d = diag[i];
    for (let o = lstart[i]; o < lstart[i + 1]; o++) d -= LV[o] * LV[o];
    LD[i] = d > 1e-12 * (diag[i] || 1) ? Math.sqrt(d) : Math.sqrt(diag[i] || 1);
  }
  const yb = new Float64Array(nf);
  const precond = (r, z) => {
    for (let i = 0; i < nf; i++) { let s = r[i]; for (let o = lstart[i]; o < lstart[i + 1]; o++) s -= LV[o] * yb[LC[o]]; yb[i] = s / LD[i]; }
    for (let i = 0; i < nf; i++) z[i] = yb[i];
    for (let i = nf - 1; i >= 0; i--) { const v = z[i] / LD[i]; z[i] = v; for (let o = lstart[i]; o < lstart[i + 1]; o++) z[LC[o]] -= LV[o] * v; }
  };
  const r = new Float64Array(nf), z = new Float64Array(nf), p = new Float64Array(nf), q = new Float64Array(nf);
  const solve = (x, b) => {
    mul(x, q);
    let r0 = 0;
    for (let i = 0; i < nf; i++) { r[i] = b[i] - q[i]; r0 += b[i] * b[i]; }
    precond(r, z);
    let rz = 0;
    for (let i = 0; i < nf; i++) { p[i] = z[i]; rz += r[i] * z[i]; }
    r0 = Math.sqrt(r0) || 1;
    for (let it = 0; it < 300; it++) {
      mul(p, q);
      let pq = 0;
      for (let i = 0; i < nf; i++) pq += p[i] * q[i];
      if (!(pq > 0)) break;
      const al = rz / pq;
      let rr = 0;
      for (let i = 0; i < nf; i++) { x[i] += al * p[i]; r[i] -= al * q[i]; rr += r[i] * r[i]; }
      if (Math.sqrt(rr) < tol * r0) break;
      precond(r, z);
      let rzn = 0;
      for (let i = 0; i < nf; i++) rzn += r[i] * z[i];
      const be = rzn / rz;
      rz = rzn;
      for (let i = 0; i < nf; i++) p[i] = z[i] + be * p[i];
    }
  };
  const bu = new Float64Array(nf), bv = new Float64Array(nf), U = new Float64Array(nf), Vv = new Float64Array(nf);
  return uv => {
    bu.fill(0); bv.fill(0);
    for (let i = 0; i < nf; i++) { U[i] = uv[free[i]]; Vv[i] = uv[n + free[i]]; }
    tl.forEach((t, qq) => {
      const i0 = tris[t * 3], i1 = tris[t * 3 + 1], i2 = tris[t * 3 + 2], a1 = loc[qq * 3], a2 = loc[qq * 3 + 1], b2 = loc[qq * 3 + 2];
      if (!(a1 * b2 > 1e-30)) return;
      const du1 = uv[i1] - uv[i0], du2 = uv[i2] - uv[i0], dv1 = uv[n + i1] - uv[n + i0], dv2 = uv[n + i2] - uv[n + i0];
      const j00 = du1 / a1, j01 = (du2 - j00 * a2) / b2, j10 = dv1 / a1, j11 = (dv2 - j10 * a2) / b2;
      const th = Math.atan2(j10 - j01, j00 + j11), cs = Math.cos(th), sn = Math.sin(th), vs = [i0, i1, i2], xs = [0, a1, a2], ys = [0, 0, b2];
      for (let k = 0; k < 3; k++) {
        const i = (k + 1) % 3, j = (k + 2) % 3, wt = w[qq * 3 + k], dx = xs[i] - xs[j], dy = ys[i] - ys[j];
        const rx = cs * dx - sn * dy, ry = sn * dx + cs * dy, fa = fi[vs[i]], fb = fi[vs[j]];
        if (fa >= 0) { bu[fa] += wt * rx; bv[fa] += wt * ry; }
        if (fb >= 0) { bu[fb] -= wt * rx; bv[fb] -= wt * ry; }
      }
    });
    for (let i = 0; i < nf; i++) for (let o = fs[i]; o < fs[i + 1]; o++) { bu[i] += fw[o] * uv[fj[o]]; bv[i] += fw[o] * uv[n + fj[o]]; }
    solve(U, bu); solve(Vv, bv);
    const out = Float64Array.from(uv);
    for (let i = 0; i < nf; i++) { out[free[i]] = U[i]; out[n + free[i]] = Vv[i]; }
    return out;
  };
}

// Signed doubled area of every triangle, their sum, and whether any triangle turned against the rest.
function areas(uv, n, tris) {
  const m = tris.length / 3, s = new Float64Array(m);
  let total = 0;
  for (let t = 0; t < m; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    s[t] = (uv[b] - uv[a]) * (uv[n + c] - uv[n + a]) - (uv[c] - uv[a]) * (uv[n + b] - uv[n + a]);
    total += s[t];
  }
  let flips = 0;
  for (let t = 0; t < m; t++) if (s[t] * total < 0) flips++;
  return { s, total, flips };
}

// Largest step towards target (at most 1) that keeps every triangle's orientation, with a margin.
function safeStep(n, tris, uv, target) {
  let smax = 1;
  for (let t = 0; t < tris.length / 3; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    const ux = uv[b] - uv[a], uy = uv[n + b] - uv[n + a], vx = uv[c] - uv[a], vy = uv[n + c] - uv[n + a];
    const dux = target[b] - uv[b] - target[a] + uv[a], duy = target[n + b] - uv[n + b] - target[n + a] + uv[n + a];
    const dvx = target[c] - uv[c] - target[a] + uv[a], dvy = target[n + c] - uv[n + c] - target[n + a] + uv[n + a];
    const A0 = ux * vy - uy * vx, A1 = ux * dvy + dux * vy - uy * dvx - duy * vx, A2 = dux * dvy - duy * dvx;
    if (!(A0 > 0)) continue;
    let root = Infinity;
    if (Math.abs(A2) < 1e-30) { if (A1 < 0) root = -A0 / A1; }
    else {
      const disc = A1 * A1 - 4 * A2 * A0;
      if (disc >= 0) { const sq = Math.sqrt(disc); for (const x of [(-A1 - sq) / (2 * A2), (-A1 + sq) / (2 * A2)]) if (x > 0 && x < root) root = x; }
    }
    if (0.8 * root < smax) smax = 0.8 * root;
  }
  return smax;
}

// One triangle, or two sharing an edge, laid flat with their true shapes.
function unfold(cm) {
  const { n, X, lt } = cm, uv = new Float64Array(2 * n);
  const d = (i, j) => Math.hypot(X[i * 3] - X[j * 3], X[i * 3 + 1] - X[j * 3 + 1], X[i * 3 + 2] - X[j * 3 + 2]);
  const place = (x, i, j, ri, rj) => {
    const ux = uv[j] - uv[i], uy = uv[n + j] - uv[n + i], l = Math.hypot(ux, uy) || 1e-30;
    const along = (ri * ri - rj * rj + l * l) / (2 * l), across = Math.sqrt(Math.max(0, ri * ri - along * along));
    uv[x] = uv[i] + (ux * along - uy * across) / l;
    uv[n + x] = uv[n + i] + (uy * along + ux * across) / l;
  };
  const [a, b, c] = [lt[0], lt[1], lt[2]];
  uv[b] = d(a, b);
  place(c, a, b, d(a, c), d(b, c));
  if (lt.length > 3) {
    const t2 = [lt[3], lt[4], lt[5]], k = t2.findIndex(v => v !== a && v !== b && v !== c);
    if (k >= 0) { const x = t2[k], p = t2[(k + 1) % 3], q = t2[(k + 2) % 3]; place(x, p, q, d(p, x), d(q, x)); }
  }
  return uv;
}

// A flattened chart: the conformal map (or Tutte's when that folds, or a given warm start), then as-rigid-as-possible
// steps that never flip a triangle. Returns UVs as [u…, v…] wound counter-clockwise, or null.
function flatten(cm, iters, tol, warm = null, warmIters = 3, fixed = null) {
  const { n, X, lt } = cm, m = lt.length / 3;
  if (m <= 2) return unfold(cm);
  let start = null;
  if (warm) { const a = areas(warm, n, lt); if (!a.flips && a.total > 0) { start = warm; iters = Math.min(iters, warmIters); } else fixed = null; }
  else fixed = null;
  if (!start) {
    const pl = planar(cm);
    let pinA = 0, pinB = 0;
    for (let i = 1; i < n; i++) { if (pl[i] < pl[pinA]) pinA = i; if (pl[i] > pl[pinB]) pinB = i; }
    if (pinA !== pinB) {
      const conf = lscm(n, lt, X, pl, pinA, pinB), a = areas(conf, n, lt);
      if (!a.flips && a.total !== 0) { if (a.total < 0) for (let i = 0; i < n; i++) conf[i] = -conf[i]; start = conf; }
    }
  }
  if (!start) start = tutte(cm);
  if (!start) return null;
  const a0 = areas(start, n, lt);
  if (a0.flips || !(a0.total > 0)) return null;
  const step = arapSolver(n, lt, X, tol, fixed);
  const uv = start;
  for (let it = 0; it < iters; it++) {
    const target = step(uv), s = safeStep(n, lt, uv, target);
    if (!(s > 1e-5)) break;
    for (let i = 0; i < 2 * n; i++) uv[i] += s * (target[i] - uv[i]);
  }
  return uv;
}

// Texel density of every triangle against its share, weighted by how visible it is: the weighted 90th percentile and
// worst of |log ratio| (hidden surface counts a fifth), and whether it's usable for painting: no overlap, squashed
// triangles (under 1/8 or over 8× their share) on at most 0.5% of the seen area and 5% of all, stretched ones (1/4 to
// 4×) on at most 3% of the seen area.
function judge(uv, cm, visOf) {
  const { n, X, lt, src } = cm, m = lt.length / 3, { s, total } = areas(uv, n, lt), a3 = new Float64Array(m);
  let A3 = 0;
  for (let t = 0; t < m; t++) {
    const a = lt[t * 3] * 3, b = lt[t * 3 + 1] * 3, c = lt[t * 3 + 2] * 3;
    const ux = X[b] - X[a], uy = X[b + 1] - X[a + 1], uz = X[b + 2] - X[a + 2], vx = X[c] - X[a], vy = X[c + 1] - X[a + 1], vz = X[c + 2] - X[a + 2];
    a3[t] = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    A3 += a3[t];
  }
  if (!(total > 0)) return { ok: false };
  const list = [];
  let worst = 0, seen = 0, squashed = 0, stretched = 0, crushed = 0;
  for (let t = 0; t < m; t++) {
    if (a3[t] <= A3 * 1e-9) continue;
    if (s[t] <= 0) return { ok: false };
    const v = (visOf(src[lt[t * 3]]) + visOf(src[lt[t * 3 + 1]]) + visOf(src[lt[t * 3 + 2]])) / 3;
    const r = (s[t] / total) / (a3[t] / A3), l = Math.abs(Math.log(r)), wv = a3[t] * v;
    list.push([l, a3[t] * (0.15 + 0.85 * v)]);
    // hidden surface may take the stretch, within reason
    worst = Math.max(worst, l * (0.2 + 0.8 * v));
    seen += wv;
    if (r < 0.125 || r > 8) { squashed += wv; crushed += a3[t]; } else if (r < 0.25 || r > 4) stretched += wv;
  }
  // hidden surface may take the stretch, but not so much that a sizeable part of the chart gets crushed
  if (squashed > 0.005 * seen || stretched > 0.03 * seen || crushed > 0.05 * A3 || overlaps(uv, cm)) return { ok: false };
  list.sort((x, y) => x[0] - y[0]);
  let tot = 0, acc = 0, p90 = 0;
  for (const x of list) tot += x[1];
  for (const x of list) { acc += x[1]; if (acc >= 0.9 * tot) { p90 = x[0]; break; } }
  return { ok: true, p90, worst };
}

// Whether a flattened chart overlaps itself. With no triangle turned over, a disk's layout is one-to-one exactly when
// its border doesn't cross itself (a locally injective map of a disk with a simple boundary is injective), so only the
// border's segments are tested against each other, through a grid.
function overlaps(uv, cm) {
  const { n, lt, uses } = cm, m = lt.length / 3, next = new Int32Array(n).fill(-1);
  for (let t = 0; t < m; t++) for (let k = 0; k < 3; k++) {
    const a = lt[t * 3 + k], b = lt[t * 3 + ((k + 1) % 3)];
    if (uses.get(a < b ? a * n + b : b * n + a) === 1) next[a] = b;
  }
  const seg = [];
  let len = 0;
  for (let a = 0; a < n; a++) if (next[a] >= 0) { seg.push(a, next[a]); len += Math.hypot(uv[next[a]] - uv[a], uv[n + next[a]] - uv[n + a]); }
  const S = seg.length / 2;
  if (S < 4) return false;
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (let i = 0; i < seg.length; i++) { const v = seg[i]; minU = Math.min(minU, uv[v]); maxU = Math.max(maxU, uv[v]); minV = Math.min(minV, uv[n + v]); maxV = Math.max(maxV, uv[n + v]); }
  const cell = Math.max((2 * len) / S, 1e-12), W = Math.min(2048, Math.ceil((maxU - minU) / cell) + 1), H = Math.min(2048, Math.ceil((maxV - minV) / cell) + 1);
  const cu = (maxU - minU) / W || 1, cv = (maxV - minV) / H || 1, bins = new Map();
  for (let s = 0; s < S; s++) {
    const a = seg[s * 2], b = seg[s * 2 + 1];
    const i0 = Math.min(W - 1, Math.floor((Math.min(uv[a], uv[b]) - minU) / cu)), i1 = Math.min(W - 1, Math.floor((Math.max(uv[a], uv[b]) - minU) / cu));
    const j0 = Math.min(H - 1, Math.floor((Math.min(uv[n + a], uv[n + b]) - minV) / cv)), j1 = Math.min(H - 1, Math.floor((Math.max(uv[n + a], uv[n + b]) - minV) / cv));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * W + i; let l = bins.get(k); if (!l) bins.set(k, l = []); l.push(s); }
  }
  const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const onSeg = (ax, ay, bx, by, px, py) => Math.min(ax, bx) <= px && px <= Math.max(ax, bx) && Math.min(ay, by) <= py && py <= Math.max(ay, by);
  for (const l of bins.values()) for (let x = 0; x < l.length; x++) for (let y = x + 1; y < l.length; y++) {
    const a = seg[l[x] * 2], b = seg[l[x] * 2 + 1], c = seg[l[y] * 2], d = seg[l[y] * 2 + 1];
    if (a === c || a === d || b === c || b === d) continue;
    const ax = uv[a], ay = uv[n + a], bx = uv[b], by = uv[n + b], cx = uv[c], cy = uv[n + c], dx = uv[d], dy = uv[n + d];
    const o1 = orient(ax, ay, bx, by, cx, cy), o2 = orient(ax, ay, bx, by, dx, dy), o3 = orient(cx, cy, dx, dy, ax, ay), o4 = orient(cx, cy, dx, dy, bx, by);
    if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
    if ((o1 === 0 && onSeg(ax, ay, bx, by, cx, cy)) || (o2 === 0 && onSeg(ax, ay, bx, by, dx, dy)) || (o3 === 0 && onSeg(cx, cy, dx, dy, ax, ay)) || (o4 === 0 && onSeg(cx, cy, dx, dy, bx, by))) return true;
  }
  return false;
}

// A start for a joined chart from its two flattened parts: the second turned and moved onto the first along the
// vertices they share (least squares), those vertices at the average.
function joinedStart(cm, A, B) {
  if (!A.uv || !B.uv) return null;
  const n = cm.n, nA = A.tris.length, fromA = new Int32Array(n).fill(-1), fromB = new Int32Array(n).fill(-1);
  for (let i = 0; i < cm.lt.length / 3; i++) for (let k = 0; k < 3; k++) {
    const l = cm.lt[i * 3 + k];
    if (i < nA) fromA[l] = A.cm.lt[i * 3 + k]; else fromB[l] = B.cm.lt[(i - nA) * 3 + k];
  }
  const a = A.uv, na = A.cm.n, b = B.uv, nb = B.cm.n;
  let cax = 0, cay = 0, cbx = 0, cby = 0, k = 0;
  for (let l = 0; l < n; l++) if (fromA[l] >= 0 && fromB[l] >= 0) { cax += a[fromA[l]]; cay += a[na + fromA[l]]; cbx += b[fromB[l]]; cby += b[nb + fromB[l]]; k++; }
  if (k < 2) return null;
  cax /= k; cay /= k; cbx /= k; cby /= k;
  let sxx = 0, sxy = 0;
  for (let l = 0; l < n; l++) if (fromA[l] >= 0 && fromB[l] >= 0) {
    const px = b[fromB[l]] - cbx, py = b[nb + fromB[l]] - cby, qx = a[fromA[l]] - cax, qy = a[na + fromA[l]] - cay;
    sxx += px * qx + py * qy; sxy += px * qy - py * qx;
  }
  const th = Math.atan2(sxy, sxx), cs = Math.cos(th), sn = Math.sin(th), uv = new Float64Array(2 * n);
  for (let l = 0; l < n; l++) {
    let x = 0, y = 0, c = 0;
    if (fromA[l] >= 0) { x += a[fromA[l]]; y += a[na + fromA[l]]; c++; }
    if (fromB[l] >= 0) { const px = b[fromB[l]] - cbx, py = b[nb + fromB[l]] - cby; x += cs * px - sn * py + cax; y += sn * px + cs * py + cay; c++; }
    uv[l] = x / c; uv[n + l] = y / c;
  }
  const nb2 = Array.from({ length: n }, () => []);
  for (let i = 0; i < cm.lt.length / 3; i++) for (let k = 0; k < 3; k++) nb2[cm.lt[i * 3 + k]].push(cm.lt[i * 3 + ((k + 1) % 3)], cm.lt[i * 3 + ((k + 2) % 3)]);
  // Triangles turned over where the two layouts meet: their corners move to the average of their neighbours.
  for (let it = 0; it < 30; it++) {
    const a = areas(uv, n, cm.lt);
    if (!a.flips && a.total > 0) break;
    const move = new Set();
    for (let t = 0; t < a.s.length; t++) if (a.s[t] * a.total <= 0) for (let k = 0; k < 3; k++) move.add(cm.lt[t * 3 + k]);
    for (const v of move) {
      let x = 0, y = 0;
      for (const u of nb2[v]) { x += uv[u]; y += uv[n + u]; }
      uv[v] = x / nb2[v].length; uv[n + v] = y / nb2[v].length;
    }
  }
  // The first part's vertices more than four rings from the shared border can stay where they are while the join
  // settles (when that leaves most of the chart still).
  const ring = new Int32Array(n).fill(-1), frontier = [];
  for (let l = 0; l < n; l++) if (fromB[l] >= 0) { ring[l] = 0; frontier.push(l); }
  for (let q = 0; q < frontier.length; q++) { const x = frontier[q]; if (ring[x] >= 4) continue; for (const y of nb2[x]) if (ring[y] < 0) { ring[y] = ring[x] + 1; frontier.push(y); } }
  const fixed = new Uint8Array(n);
  let still = 0;
  for (let l = 0; l < n; l++) if (ring[l] < 0) { fixed[l] = 1; still++; }
  return { uv, fixed: still > 0.4 * n ? fixed : null };
}

// ---------- layout ----------
// Turned so the model's up (for charts that rise, else its front) points up the sheet, then nudged by up to 20° so the
// quads' edges run along the sheet.
function upright(uv, cm, up, front, quadEdges) {
  const { n, X, lt } = cm, m = lt.length / 3;
  let gx = 0, gy = 0, fx = 0, fy = 0, W = 0;
  for (let t = 0; t < m; t++) {
    const a = lt[t * 3], b = lt[t * 3 + 1], c = lt[t * 3 + 2];
    const du1 = uv[b] - uv[a], dv1 = uv[n + b] - uv[n + a], du2 = uv[c] - uv[a], dv2 = uv[n + c] - uv[n + a], det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-20) continue;
    const ar = Math.abs(det) / 2, y1 = X[b * 3 + up] - X[a * 3 + up], y2 = X[c * 3 + up] - X[a * 3 + up];
    gx += (ar * (y1 * dv2 - y2 * dv1)) / det; gy += (ar * (du1 * y2 - du2 * y1)) / det;
    const f1 = (X[b * 3] - X[a * 3]) * front[0] + (X[b * 3 + 1] - X[a * 3 + 1]) * front[1] + (X[b * 3 + 2] - X[a * 3 + 2]) * front[2];
    const f2 = (X[c * 3] - X[a * 3]) * front[0] + (X[c * 3 + 1] - X[a * 3 + 1]) * front[1] + (X[c * 3 + 2] - X[a * 3 + 2]) * front[2];
    fx += (ar * (f1 * dv2 - f2 * dv1)) / det; fy += (ar * (du1 * f2 - du2 * f1)) / det;
    W += ar;
  }
  const rises = Math.hypot(gx, gy) / (W || 1) > 0.2;
  let ang = rises ? Math.atan2(gx, gy) : Math.atan2(fx, fy);
  let s4 = 0, c4 = 0;
  for (const [a, b, wt] of quadEdges) { const phi = Math.atan2(uv[n + b] - uv[n + a], uv[b] - uv[a]); s4 += wt * Math.sin(4 * phi); c4 += wt * Math.cos(4 * phi); }
  if (s4 || c4) {
    const q = Math.atan2(s4, c4) / 4 + ang, d = Math.round(q / (Math.PI / 2)) * (Math.PI / 2) - q;
    if (Math.abs(d) < (20 * Math.PI) / 180) ang += d;
  }
  const cs = Math.cos(ang), sn = Math.sin(ang), out = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) { out[i] = uv[i] * cs - uv[n + i] * sn; out[n + i] = uv[i] * sn + uv[n + i] * cs; }
  return out;
}

// The cells a chart covers at a scale, grown by pad cells, as runs [bottom, top] per column (lying on its side when
// turned): its exact outline, so later charts can nest into its hollows.
function mask(c, sigma, pad, turned) {
  const H0 = c.h * sigma, w0 = Math.ceil(c.w * sigma) + 2 * pad + 1, h0 = Math.ceil(c.h * sigma) + 2 * pad + 1;
  const w = turned ? h0 : w0, h = turned ? w0 : h0, bits = new Uint8Array(w * h), uv = c.uv, tris = c.tris;
  for (let t = 0; t < tris.length; t += 3) {
    const xs = [], ys = [];
    for (let k = 0; k < 3; k++) {
      const x = uv[tris[t + k] * 2] * sigma, y = uv[tris[t + k] * 2 + 1] * sigma;
      xs.push((turned ? H0 - y : x) + pad); ys.push((turned ? x : y) + pad);
    }
    let [ax, bx, cx] = xs, [ay, by, cy] = ys;
    if ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay) < 0) { [bx, cx] = [cx, bx]; [by, cy] = [cy, by]; }
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), i1 = Math.min(w - 1, Math.floor(Math.max(ax, bx, cx)));
    const j0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), j1 = Math.min(h - 1, Math.floor(Math.max(ay, by, cy)));
    const ex = [ax, bx, cx], ey = [ay, by, cy];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      // a cell counts when the triangle reaches into it at all
      let inside = true;
      for (let e = 0; e < 3 && inside; e++) {
        const px = ex[e], py = ey[e], dx = ex[(e + 1) % 3] - px, dy = ey[(e + 1) % 3] - py, f = (x, y) => dx * (y - py) - dy * (x - px);
        if (f(i, j) < 0 && f(i + 1, j) < 0 && f(i, j + 1) < 0 && f(i + 1, j + 1) < 0) inside = false;
      }
      if (inside) bits[j * w + i] = 1;
    }
  }
  if (pad > 0) {
    const tmp = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (bits[j * w + i]) for (let d = Math.max(0, i - pad); d <= Math.min(w - 1, i + pad); d++) tmp[j * w + d] = 1;
    bits.fill(0);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (tmp[j * w + i]) for (let d = Math.max(0, j - pad); d <= Math.min(h - 1, j + pad); d++) bits[d * w + i] = 1;
  }
  const runs = [];
  for (let i = 0; i < w; i++) {
    const col = [];
    for (let j = 0; j < h; j++) {
      if (!bits[j * w + i]) continue;
      let k = j;
      while (k + 1 < h && bits[(k + 1) * w + i]) k++;
      col.push(j, k);
      j = k;
    }
    runs.push(col);
  }
  return { w, h, runs };
}

// Packing on a G-cell square, charts in the given order, each where its outline fits (hollows and gaps between earlier
// charts included) closest to the height it should have on the sheet (chart.rank, 0 bottom to 1 top), preferring low
// places; scaled to the largest size that fits. Returns the share of the square the charts cover.
function pack(charts, order, G, pad) {
  const place = sigma => {
    // occupied runs per column of the sheet, kept sorted
    const occ = Array.from({ length: G }, () => []), out = new Array(charts.length);
    let height = 0;
    const lowestAt = (m, x, from = 0) => {
      // lowest y from `from` up where every run of the chart, shifted by y, misses the occupied runs of its column
      let y = from;
      for (let guard = 0; guard < 4 * G; guard++) {
        let moved = false;
        for (let i = 0; i < m.w && !moved; i++) {
          const cr = m.runs[i], col = occ[x + i];
          for (let r = 0; r < cr.length && !moved; r += 2) {
            const lo = y + cr[r], hi = y + cr[r + 1];
            for (let o = 0; o < col.length; o += 2) {
              if (col[o] > hi) break;
              if (col[o + 1] >= lo) { y = col[o + 1] + 1 - cr[r]; moved = true; break; }
            }
          }
        }
        if (!moved) return y;
      }
      return Infinity;
    };
    for (const ci of order) {
      const c = charts[ci];
      let best = null;
      for (const turned of c.h > 2.5 * c.w ? [false, true] : [false]) {
        const m = mask(c, sigma, pad, turned);
        if (m.w > G) continue;
        // where on the sheet the chart belongs: as high up as it sits on the model
        const want = c.rank * Math.max(0, G - m.h);
        for (let x = 0; x + m.w <= G; x++) {
          for (const from of [0, Math.round(want)]) {
            const y = lowestAt(m, x, from);
            if (y + m.h > G) continue;
            // near its place, low, and upright rather than on its side
            const score = (Math.abs(y - want) + 0.5 * (y + m.h)) * (turned ? 1.15 : 1) + x * 1e-6;
            if (!best || score < best.score) best = { score, x, y, turned, m };
          }
        }
      }
      if (!best) return null;
      const { x, y, m } = best;
      for (let i = 0; i < m.w; i++) {
        const col = occ[x + i], cr = m.runs[i];
        for (let r = 0; r < cr.length; r += 2) col.push(y + cr[r], y + cr[r + 1]);
        // keep the column's runs sorted by start
        const pairs = [];
        for (let o = 0; o < col.length; o += 2) pairs.push([col[o], col[o + 1]]);
        pairs.sort((p, q) => p[0] - q[0]);
        col.length = 0;
        for (const [p0, p1] of pairs) col.push(p0, p1);
      }
      height = Math.max(height, y + m.h);
      out[ci] = { x, y, turned: best.turned };
    }
    return { height, out };
  };
  let total = 0;
  for (const c of charts) total += c.area;
  let sigma = Math.sqrt((0.5 * G * G) / Math.max(total, 1e-30)), best = null, fail = Infinity;
  for (let it = 0; it < 14; it++) {
    const res = place(sigma);
    if (res && res.height <= G) {
      if (!best || sigma > best.sigma) best = { sigma, res };
      if (sigma * 1.01 >= fail) break;
      sigma = fail < Infinity ? (sigma + fail) / 2 : sigma * 1.15;
    } else {
      fail = Math.min(fail, sigma);
      sigma = best ? (best.sigma + sigma) / 2 : sigma * 0.85;
    }
  }
  for (let g = 0; !best && g < 40; g++) { sigma *= 0.8; const res = place(sigma); if (res && res.height <= G) best = { sigma, res }; }
  if (!best) return 0;
  const s = best.sigma;
  charts.forEach((c, ci) => {
    const p = best.res.out[ci], H0 = c.h * s;
    for (let i = 0; i < c.cm.n; i++) {
      const x = c.uv[i * 2] * s, y = c.uv[i * 2 + 1] * s, px = p.turned ? H0 - y : x, py = p.turned ? x : y;
      c.uv[i * 2] = (p.x + px + pad) / G;
      c.uv[i * 2 + 1] = (p.y + py + pad) / G;
    }
  });
  return (total * s * s) / (G * G);
}

// ---------- borders ----------
// Minimum s-t cut (Dinic's algorithm) on an undirected graph: nodes 0..n-1, edges as [a, b, capacity]; source and sink
// sets hold nodes tied to either end. Returns 1 for nodes on the source side.
function minCut(n, edges, source, sink) {
  const S = n, T = n + 1, N = n + 2, head = new Int32Array(N).fill(-1), to = [], cap = [], nxt = [];
  const add = (a, b, c1, c2) => { to.push(b); cap.push(c1); nxt.push(head[a]); head[a] = to.length - 1; to.push(a); cap.push(c2); nxt.push(head[b]); head[b] = to.length - 1; };
  for (const [a, b, c] of edges) add(a, b, c, c);
  for (const v of source) add(S, v, Infinity, 0);
  for (const v of sink) add(v, T, Infinity, 0);
  const C = Float64Array.from(cap), TO = Int32Array.from(to), NX = Int32Array.from(nxt), level = new Int32Array(N), it = new Int32Array(N), q = new Int32Array(N);
  const bfs = () => {
    level.fill(-1); level[S] = 0;
    let qh = 0, qt = 0; q[qt++] = S;
    while (qh < qt) { const x = q[qh++]; for (let e = head[x]; e >= 0; e = NX[e]) if (C[e] > 1e-15 && level[TO[e]] < 0) { level[TO[e]] = level[x] + 1; q[qt++] = TO[e]; } }
    return level[T] >= 0;
  };
  // iterative blocking-flow search
  const stack = new Int32Array(N), via = new Int32Array(N);
  const push = () => {
    let total = 0;
    for (;;) {
      let sp = 0, x = S;
      stack[sp] = S;
      while (x !== T) {
        let e = it[x];
        for (; e >= 0; e = NX[e]) if (C[e] > 1e-15 && level[TO[e]] === level[x] + 1) break;
        it[x] = e;
        if (e < 0) { if (x === S) return total; level[x] = -1; sp--; x = stack[sp]; it[x] = NX[it[x]]; continue; }
        via[sp] = e; stack[++sp] = TO[e]; x = TO[e];
      }
      let f = Infinity;
      for (let i = 0; i < sp; i++) f = Math.min(f, C[via[i]]);
      if (!(f < Infinity)) return Infinity;
      for (let i = 0; i < sp; i++) { C[via[i]] -= f; C[via[i] ^ 1] += f; }
      total += f;
    }
  };
  let guard = 0;
  while (bfs() && guard++ < 10000) { for (let i = 0; i < N; i++) it[i] = head[i]; if (push() === Infinity) break; }
  const side = new Uint8Array(n);
  bfs();
  for (let v = 0; v < n; v++) side[v] = level[v] >= 0 ? 1 : 0;
  return side;
}

// ---------- the unwrap ----------
// mesh: a finalized result (quad pairs in mesh.quad, parts and materials per vertex). opt: { size: texture px,
// density: per-face texel density multiplier, vis: how visible each vertex is (0–1), colors: the original's colour
// under each vertex (0–255 RGB), up: the axis that points up (1 = +Y) }. Returns { mesh, info } as unwrap() does.
export function unwrapPaintable(mesh, opt = {}) {
  const t0 = Date.now(), idx = mesh.index, T = idx.length / 3;
  const size = opt.size || 1024, G = Math.min(512, Math.max(64, size >> 1)), pad = 1, up = opt.up ?? 1, front = up === 2 ? [0, -1, 0] : [0, 0, 1];
  const vis = opt.vis || null, visOf = v => (vis ? vis[v] : 1), dens = opt.density || null;
  const limit = Math.log(1.4), worstLimit = Math.log(4), partColor = 120, crumbShare = 0.002;
  const S = surfaceOf(mesh);
  if (dens && mesh.quad) for (let t = 0; t + 1 < T; t++) if (mesh.quad[t] === 1) dens[t + 1] = dens[t];
  const inner = seamCosts(mesh, S, vis, opt.colors || null, dens);
  const first = firstCharts(S, vis, inner, 0.35, 0.0005);
  smoothLabels(S, inner, first.label, first.count);
  const stats = { first: first.count, splits: 0, joins: 0, tried: 0, bridges: 0, crumbs: 0, times: {} };
  const seamCost = e => (e.forced ? Infinity : e.L * (e.cost || 1e-3) + 1e-12);
  // A chart from a set of triangles: tubes and holes cut open along the cheapest paths, flattened, judged.
  const make = (tris, cuts, parts = null, iters = 8, tol = 1e-4) => {
    cuts = new Set(cuts);
    let cm = chartMesh(mesh, S, tris, cuts);
    const costOf = (a, b) => {
      const pa = S.pid[cm.src[a]], pb = S.pid[cm.src[b]], e = S.byPair.get(pa < pb ? pa * S.NP + pb : pb * S.NP + pa);
      return e && !e.inner ? seamCost(e) : Infinity;
    };
    for (let g = 0; g < 16 && cm.loops > 1; g++) {
      const path = bridge(cm, costOf);
      if (!path) break;
      for (let i = 0; i + 1 < path.length; i++) {
        const pa = S.pid[cm.src[path[i]]], pb = S.pid[cm.src[path[i + 1]]], e = S.byPair.get(pa < pb ? pa * S.NP + pb : pb * S.NP + pa);
        if (e) cuts.add(e);
      }
      stats.bridges++;
      cm = chartMesh(mesh, S, tris, cuts);
    }
    if (cm.loops !== 1 || cm.chi !== 1) return null;
    const js = parts ? joinedStart(cm, parts[0], parts[1]) : null, uv = flatten(cm, iters, tol, js && js.uv, 3, js && js.fixed);
    if (!uv) return null;
    const q = judge(uv, cm, visOf);
    return q.ok ? { tris, cuts, cm, uv, q } : null;
  };
  const stamp = k => { stats.times[k] = Date.now() - t0; };
  stamp('grown');
  // first charts, split in halves until each flattens
  const byLabel = Array.from({ length: first.count }, () => []);
  for (let t = 0; t < T; t++) byLabel[first.label[S.cell[t]]].push(t);
  let charts = [];
  const queue = [];
  for (const l of byLabel) if (l.length) queue.push(...pieces(S, l));
  while (queue.length) {
    const tris = queue.pop(), c = make(tris, []);
    if (c) { charts.push(c); continue; }
    if (tris.length <= 2) { const cm = chartMesh(mesh, S, tris, new Set()); charts.push({ tris, cuts: new Set(), cm, uv: unfold(cm), q: { p90: 0, worst: 0 }, alone: true }); continue; }
    stats.splits++;
    for (const h of halves(S, tris)) queue.push(...pieces(S, h));
  }
  stamp('firstCharts');
  // joins in rounds: each round pairs charts off, costliest seams first, every chart in at most one attempt, so a round
  // costs about one pass over the mesh however large the charts grow; a pair is tried once per version of its charts
  const owner = new Int32Array(T), alive = charts.map(() => true), version = charts.map(() => 0), tried = new Set();
  charts.forEach((c, i) => { for (const t of c.tris) owner[t] = i; });
  const colorOf = c => {
    if (!S.cellColor) return null;
    let r = 0, g = 0, b = 0, w = 0;
    for (const t of c.tris) { const k = S.cell[t], a = S.area[t]; r += S.cellColor[k * 3] * a; g += S.cellColor[k * 3 + 1] * a; b += S.cellColor[k * 3 + 2] * a; w += a; }
    return w > 0 ? [r / w, g / w, b / w] : null;
  };
  for (let round = 0; round < 64; round++) {
    const between = new Map();
    for (const e of inner) {
      if (e.forced) continue;
      const A = owner[(e.h[0] / 3) | 0], B = owner[(e.h[1] / 3) | 0];
      if (A === B) continue;
      const key = A < B ? A * 1048576 + B : B * 1048576 + A;
      between.set(key, (between.get(key) || 0) + e.L * e.cost);
    }
    const pairs = [];
    for (const [key, c] of between) {
      const A = Math.floor(key / 1048576), B = key % 1048576;
      if (charts[A].alone || charts[B].alone) continue;
      const tk = `${A}:${version[A]}|${B}:${version[B]}`;
      if (!tried.has(tk)) pairs.push([c, A, B, tk]);
    }
    if (!pairs.length) break;
    pairs.sort((x, y) => y[0] - x[0]);
    const used = new Set();
    for (const [, A, B, tk] of pairs) {
      if (used.has(A) || used.has(B)) continue;
      used.add(A); used.add(B); tried.add(tk);
      stats.tried++;
      const cA = charts[A], cB = charts[B];
      if (S.cellColor) {
        cA.color ||= colorOf(cA); cB.color ||= colorOf(cB);
        if (Math.hypot(cA.color[0] - cB.color[0], cA.color[1] - cB.color[1], cA.color[2] - cB.color[2]) > partColor) continue;
      }
      const j = make(cA.tris.concat(cB.tris), [], [cA, cB]);
      if (!j || j.q.p90 > limit || j.q.worst > worstLimit) continue;
      stats.joins++;
      charts[A] = j; alive[B] = false; version[A]++;
      for (const t of cB.tris) owner[t] = A;
    }
  }
  stamp('joined');
  // tiny charts join the neighbour they share the longest boundary with, if that still flattens
  let total = 0;
  for (let t = 0; t < T; t++) total += S.area[t];
  const areaOf = c => { let a = 0; for (const t of c.tris) a += S.area[t]; return a; };
  for (let pass = 0; pass < 2; pass++) {
    for (let A = 0; A < charts.length; A++) {
      if (!alive[A] || charts[A].alone || areaOf(charts[A]) >= crumbShare * total) continue;
      const near = new Map();
      for (const t of charts[A].tris) for (let k = 0; k < 3; k++) {
        const e = S.he[t * 3 + k];
        if (!e || e.h.length !== 2 || e.forced || e.inner) continue;
        const o = owner[((e.h[0] === t * 3 + k ? e.h[1] : e.h[0]) / 3) | 0];
        if (o !== A && alive[o] && !charts[o].alone) near.set(o, (near.get(o) || 0) + e.L);
      }
      for (const [B] of [...near.entries()].sort((x, y) => y[1] - x[1])) {
        const cA = charts[A], cB = charts[B], j = make(cB.tris.concat(cA.tris), [], [cB, cA]);
        if (!j || j.q.worst > worstLimit) continue;
        charts[B] = j; alive[A] = false; stats.crumbs++;
        for (const t of cA.tris) owner[t] = B;
        break;
      }
    }
  }
  charts = charts.filter((_, i) => alive[i]);
  stamp('crumbed');
  // Borders: between two neighbouring charts the border moves to the cheapest line, by seam cost, that still separates
  // their cores (a minimum cut), and the move stands when both charts then flatten within the limits.
  {
    const cellNb = Array.from({ length: S.C }, () => []);
    for (const e of inner) if (!e.forced) { const w = e.L * e.cost + 1e-12; cellNb[e.c1].push(e.c2, w); cellNb[e.c2].push(e.c1, w); }
    const cellTris = Array.from({ length: S.C }, () => []);
    for (let t = 0; t < T; t++) cellTris[S.cell[t]].push(t);
    const chartOfCell = new Int32Array(S.C).fill(-1);
    charts.forEach((c, i) => { for (const t of c.tris) chartOfCell[S.cell[t]] = i; });
    const between = new Map();
    for (const e of inner) {
      if (e.forced) continue;
      const A = chartOfCell[e.c1], B = chartOfCell[e.c2];
      if (A === B || A < 0 || B < 0) continue;
      const key = A < B ? A * 1048576 + B : B * 1048576 + A;
      between.set(key, (between.get(key) || 0) + e.L * e.cost);
    }
    const done = new Set();
    const pairs = [...between.entries()].sort((x, y) => y[1] - x[1]).slice(0, 24);
    for (const [key, before] of pairs) {
      const A = Math.floor(key / 1048576), B = key % 1048576;
      if (done.has(A) || done.has(B) || charts[A].alone || charts[B].alone) continue;
      const cells = [];
      for (let c = 0; c < S.C; c++) if (chartOfCell[c] === A || chartOfCell[c] === B) cells.push(c);
      const at = new Map(cells.map((c, i) => [c, i])), ring = new Int32Array(cells.length).fill(-1), q = [];
      cells.forEach((c, i) => {
        for (let k = 0; k < cellNb[c].length; k += 2) { const o = cellNb[c][k], j = at.get(o); if (j !== undefined && chartOfCell[o] !== chartOfCell[c]) { ring[i] = 0; q.push(i); return; } }
      });
      for (let h = 0; h < q.length; h++) { const i = q[h], c = cells[i]; for (let k = 0; k < cellNb[c].length; k += 2) { const j = at.get(cellNb[c][k]); if (j !== undefined && ring[j] < 0) { ring[j] = ring[i] + 1; q.push(j); } } }
      const far = [0, 0];
      cells.forEach((c, i) => { const s2 = chartOfCell[c] === A ? 0 : 1; far[s2] = Math.max(far[s2], ring[i]); });
      const edges = [];
      cells.forEach((c, i) => { for (let k = 0; k < cellNb[c].length; k += 2) { const j = at.get(cellNb[c][k]); if (j !== undefined && j > i) edges.push([i, j, cellNb[c][k + 1]]); } });
      // the widest band first; a move that doesn't flatten well is tried again closer to the old border
      for (const band of [0.5, 0.2]) {
        const src = [], snk = [];
        cells.forEach((c, i) => { const s2 = chartOfCell[c] === A ? 0 : 1; if (ring[i] >= Math.max(2, band * far[s2])) (s2 ? snk : src).push(i); });
        if (!src.length || !snk.length) continue;
        const side = minCut(cells.length, edges, src, snk);
        let moved = 0, after = 0;
        cells.forEach((c, i) => { if ((side[i] ? A : B) !== chartOfCell[c]) moved++; });
        if (!moved) break;
        for (const [x, y, w] of edges) if (side[x] !== side[y]) after += w;
        if (!(after < before * 0.8)) break;
        const trisA = [], trisB = [];
        cells.forEach((c, i) => { for (const t of cellTris[c]) (side[i] ? trisA : trisB).push(t); });
        if (pieces(S, trisA).length !== 1 || pieces(S, trisB).length !== 1) continue;
        const jA = make(trisA, []), jB = jA && make(trisB, []);
        if (!jA || !jB || jA.q.p90 > limit || jB.q.p90 > limit || jA.q.worst > worstLimit || jB.q.worst > worstLimit) { stats.bordersKept = (stats.bordersKept || 0) + 1; continue; }
        charts[A] = jA; charts[B] = jB; done.add(A); done.add(B);
        cells.forEach((c, i) => { chartOfCell[c] = side[i] ? A : B; });
        stats.borders = (stats.borders || 0) + 1;
        break;
      }
    }
  }
  stamp('borders');
  // polish: more as-rigid-as-possible steps on every chart, kept when still usable
  for (const c of charts) {
    if (c.alone) continue;
    const more = flatten(c.cm, 20, 1e-5, Float64Array.from(c.uv), 12);
    if (more && judge(more, c.cm, visOf).ok) c.uv = more;
  }
  stamp('polished');
  // true size (times the painted texel density), upright, then packed per material in bands by height
  const byMat = new Map();
  for (const c of charts) {
    const { cm } = c, n = cm.n;
    let uv = c.uv;
    const { s } = areas(uv, n, cm.lt);
    let AU = 0, A3 = 0;
    for (let t = 0; t < s.length; t++) { AU += Math.abs(s[t]) / 2; A3 += S.area[c.tris[t]]; }
    const sc = (AU > 0 ? Math.sqrt(A3 / AU) : 1) * (dens ? dens[c.tris[0]] : 1);
    for (let i = 0; i < 2 * n; i++) uv[i] *= sc;
    const quadEdges = [];
    c.tris.forEach((t, i) => { for (let k = 0; k < 3; k++) { const e = S.he[t * 3 + k]; if (e && !e.inner) quadEdges.push([cm.lt[i * 3 + k], cm.lt[i * 3 + ((k + 1) % 3)], e.L]); } });
    uv = upright(uv, cm, up, front, quadEdges);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, hs = 0;
    for (let i = 0; i < n; i++) { x0 = Math.min(x0, uv[i]); x1 = Math.max(x1, uv[i]); y0 = Math.min(y0, uv[n + i]); y1 = Math.max(y1, uv[n + i]); hs += cm.X[i * 3 + up]; }
    const pts = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) { pts[i * 2] = uv[i] - x0; pts[i * 2 + 1] = uv[n + i] - y0; }
    const placed = { cm, tris: cm.lt, faces: c.tris, uv: pts, w: x1 - x0, h: y1 - y0, area: AU * sc * sc, height: hs / n };
    const mat = mesh.vMat[idx[c.tris[0] * 3]];
    if (!byMat.has(mat)) byMat.set(mat, []);
    byMat.get(mat).push(placed);
  }
  const atlases = [];
  for (const [mat, list] of byMat) {
    // biggest first, so smaller ones can nest around them; each aims for its height on the model
    const byH = list.map((_, i) => i).sort((a, b) => list[a].height - list[b].height);
    byH.forEach((ci, k) => { list[ci].rank = byH.length > 1 ? k / (byH.length - 1) : 0; });
    const order = list.map((_, i) => i).sort((a, b) => list[b].area - list[a].area);
    atlases.push({ mat, charts: list.length, coverage: pack(list, order, G, pad) });
  }
  // new vertices: one per chart vertex
  let count = 0;
  const placedAll = [...byMat.values()].flat();
  for (const c of placedAll) count += c.cm.n;
  const P = mesh.positions, N = mesh.normals, outIndex = new Uint32Array(T * 3), uvs = new Float32Array(count * 2), positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
  const colors = mesh.colors ? new Float32Array(count * 3) : null, vPart = new Uint16Array(count), vMat = new Uint16Array(count), srcId = new Uint32Array(count);
  let base = 0;
  for (const c of placedAll) {
    const n = c.cm.n;
    c.faces.forEach((t, i) => { for (let k = 0; k < 3; k++) outIndex[t * 3 + k] = base + c.cm.lt[i * 3 + k]; });
    for (let l = 0; l < n; l++) {
      const g = base + l, v = c.cm.src[l];
      uvs[g * 2] = c.uv[l * 2]; uvs[g * 2 + 1] = c.uv[l * 2 + 1];
      for (let k = 0; k < 3; k++) { positions[g * 3 + k] = P[v * 3 + k]; normals[g * 3 + k] = N[v * 3 + k]; if (colors) colors[g * 3 + k] = mesh.colors[v * 3 + k]; }
      vPart[g] = mesh.vPart[v]; vMat[g] = mesh.vMat[v]; srcId[g] = mesh.srcId[v];
    }
    base += n;
  }
  const coverage = atlases.reduce((s, a) => s + a.coverage, 0) / Math.max(1, atlases.length);
  return {
    mesh: { positions, normals, uvs, colors, srcId, index: outIndex, quad: mesh.quad || null, vPart, vMat, vertexCount: count, triCount: T },
    info: { charts: charts.length, coverage, atlases, size, stats: { ...stats, ms: Date.now() - t0 } },
  };
}
