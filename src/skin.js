// Skin weights for the result and posing it. No DOM and no three.js, so it runs in the page, the worker and Node alike.
//
// Weights live on the result's distinct positions (groups), never on its render vertices: the copies a vertex gets
// along UV seams and hard edges must move together, or the mesh tears where they part. In memory they are dense,
// W[g * B + b] for group g and joint b; for export and the preview each group keeps its four largest.

import { positionGroups } from './core.js';
import { compose, mmul, rigidInverse, restMatrices, childrenOf, mainChild, qmul, qnorm, sub, dot, len, norm, scale, add, dist, meshGraph } from './rig.js';

export const MAX_INFLUENCES = 4;
// Weights below this share are dropped when the weights are limited, so no vertex carries influences too small to see.
export const MIN_WEIGHT = 0.01;

// The result's distinct positions: group per vertex, the group count and each group's position.
export function skinGroups(mesh) {
  const V = mesh.positions.length / 3;
  const { group, count } = positionGroups({ positions: mesh.positions, vertexCount: V });
  const P = new Float32Array(count * 3);
  for (let v = 0; v < V; v++) P.set(mesh.positions.subarray(v * 3, v * 3 + 3), group[v] * 3);
  return { group, count, positions: P };
}

// Each deforming joint's bone as a segment, from the joint to its main child. A leaf (a hand without fingers) gets a
// stub along its parent's direction, 0.4 of its parent's length. Segments of joints that don't deform are null.
export function boneSegments(rig) {
  const kids = childrenOf(rig);
  return rig.joints.map((j, i) => {
    if (!j.deform) return null;
    const c = mainChild(rig, i, kids);
    if (c >= 0 && dist(rig.joints[c].pos, j.pos) > 1e-9) return { a: j.pos, b: rig.joints[c].pos };
    const p = j.parent >= 0 ? rig.joints[j.parent] : null;
    const d = p ? sub(j.pos, p.pos) : [0, 0, 0];
    return { a: j.pos, b: add(j.pos, scale(norm(d), 0.4 * len(d))) };
  });
}

// Distance from p to segment s, and the point's parameter along it.
export function segmentDistance(p, s) {
  const ab = sub(s.b, s.a), l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, s.a), ab) / l2)) : 0;
  return Math.hypot(p[0] - s.a[0] - ab[0] * t, p[1] - s.a[1] - ab[1] * t, p[2] - s.a[2] - ab[2] * t);
}

// Weights that fall off with the distance to each bone (1/d⁴, the two nearest): a quick stand-in for the solved ones.
export function envelopeWeights(points, rig) {
  const segs = boneSegments(rig), B = rig.joints.length, G = points.length / 3;
  const W = new Float32Array(G * B);
  for (let g = 0; g < G; g++) {
    const p = [points[g * 3], points[g * 3 + 1], points[g * 3 + 2]];
    let b1 = -1, d1 = Infinity, b2 = -1, d2 = Infinity;
    segs.forEach((s, b) => {
      if (!s) return;
      const d = segmentDistance(p, s);
      if (d < d1) { b2 = b1; d2 = d1; b1 = b; d1 = d; } else if (d < d2) { b2 = b; d2 = d; }
    });
    if (b1 < 0) continue;
    const w1 = 1 / Math.max(d1, 1e-9) ** 4, w2 = b2 >= 0 ? 1 / Math.max(d2, 1e-9) ** 4 : 0;
    W[g * B + b1] = w1 / (w1 + w2);
    if (b2 >= 0) W[g * B + b2] = w2 / (w1 + w2);
  }
  return W;
}

// Each group's largest weights (at most `max`, none under `min`), normalised: { index: Uint16Array(G·4), weight:
// Float32Array(G·4), unweighted }. A group with no weight at all goes wholly to `fallback` (the root), and is counted.
export function limitWeights(W, G, B, max = MAX_INFLUENCES, min = MIN_WEIGHT, fallback = 0) {
  const index = new Uint16Array(G * 4), weight = new Float32Array(G * 4);
  const top = new Int32Array(max), val = new Float64Array(max);
  let unweighted = 0;
  for (let g = 0; g < G; g++) {
    let n = 0, total = 0;
    for (let b = 0; b < B; b++) {
      const w = W[g * B + b];
      if (!(w > 0)) continue;
      total += w;
      if (n < max) { top[n] = b; val[n] = w; n++; }
      else {
        let lo = 0;
        for (let k = 1; k < max; k++) if (val[k] < val[lo]) lo = k;
        if (w > val[lo]) { top[lo] = b; val[lo] = w; }
      }
    }
    if (!n) { unweighted++; index[g * 4] = fallback; weight[g * 4] = 1; continue; }
    // Largest first, then drop what stays under the minimum share (always keeping the largest).
    const order = [...Array(n).keys()].sort((a, b) => val[b] - val[a]);
    let kept = 0, sum = 0;
    for (const k of order) {
      if (kept && val[k] / total < min) break;
      index[g * 4 + kept] = top[k]; weight[g * 4 + kept] = val[k]; sum += val[k]; kept++;
    }
    for (let k = 0; k < kept; k++) weight[g * 4 + k] /= sum;
  }
  return { index, weight, unweighted };
}

// Per-group skin data spread to the render vertices.
export function vertexSkin(group, skin) {
  const V = group.length, index = new Uint16Array(V * 4), weight = new Float32Array(V * 4);
  for (let v = 0; v < V; v++) {
    const g = group[v];
    for (let k = 0; k < 4; k++) { index[v * 4 + k] = skin.index[g * 4 + k]; weight[v * 4 + k] = skin.weight[g * 4 + k]; }
  }
  return { index, weight };
}

// Every joint's posed matrix in model space, given per-joint rotations (quaternions in the joint's own rest frame,
// null for none) and a translation of the root (or of joint `offsetJoint`, the hips of a figure whose Root carries its
// base): { world, skin }, skin being world × rest⁻¹, 16 per joint, which takes a rest position to its posed one.
export function poseMatrices(rig, pose = null, rootOffset = null, offsetJoint = -1) {
  const B = rig.joints.length, rest = restMatrices(rig), world = new Float64Array(B * 16), skinM = new Float64Array(B * 16);
  const local = new Float64Array(16), inv = new Float64Array(16), tmp = new Float64Array(16);
  for (let i = 0; i < B; i++) {
    const j = rig.joints[i], r = rest.subarray(i * 16, i * 16 + 16);
    const q = pose && pose[i] ? qnorm(qmul(j.rot, pose[i])) : j.rot;
    if (j.parent < 0) {
      compose(rootOffset && offsetJoint < 0 ? add(j.pos, rootOffset) : j.pos, q, world.subarray(i * 16, i * 16 + 16));
    } else {
      // The joint keeps its place in its parent's rest frame and turns by its own rotation.
      const p = j.parent, pr = rest.subarray(p * 16, p * 16 + 16);
      rigidInverse(pr, inv);
      mmul(inv, compose(j.pos, q, tmp), local);
      mmul(world.subarray(p * 16, p * 16 + 16), local, world.subarray(i * 16, i * 16 + 16));
      if (rootOffset && i === offsetJoint) for (let k = 0; k < 3; k++) world[i * 16 + 12 + k] += rootOffset[k];
    }
    mmul(world.subarray(i * 16, i * 16 + 16), rigidInverse(r, inv), skinM.subarray(i * 16, i * 16 + 16));
  }
  return { world, skin: skinM };
}

// Linear blend skinning, as the engines do it: posed positions and normals (and tangents, xyz of 4) from their rest
// ones, with M from poseMatrices().skin. index and weight hold four influences per vertex.
export function skinVertices(M, index, weight, P, N, outP, outN, T = null, outT = null) {
  const V = P.length / 3;
  const m = new Float64Array(12);
  for (let v = 0; v < V; v++) {
    m.fill(0);
    for (let k = 0; k < 4; k++) {
      const w = weight[v * 4 + k];
      if (!w) continue;
      const o = index[v * 4 + k] * 16;
      m[0] += w * M[o]; m[1] += w * M[o + 1]; m[2] += w * M[o + 2];
      m[3] += w * M[o + 4]; m[4] += w * M[o + 5]; m[5] += w * M[o + 6];
      m[6] += w * M[o + 8]; m[7] += w * M[o + 9]; m[8] += w * M[o + 10];
      m[9] += w * M[o + 12]; m[10] += w * M[o + 13]; m[11] += w * M[o + 14];
    }
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    outP[v * 3] = m[0] * x + m[3] * y + m[6] * z + m[9];
    outP[v * 3 + 1] = m[1] * x + m[4] * y + m[7] * z + m[10];
    outP[v * 3 + 2] = m[2] * x + m[5] * y + m[8] * z + m[11];
    if (N && outN) {
      const a = N[v * 3], b = N[v * 3 + 1], c = N[v * 3 + 2];
      const nx = m[0] * a + m[3] * b + m[6] * c, ny = m[1] * a + m[4] * b + m[7] * c, nz = m[2] * a + m[5] * b + m[8] * c;
      const l = Math.hypot(nx, ny, nz) || 1;
      outN[v * 3] = nx / l; outN[v * 3 + 1] = ny / l; outN[v * 3 + 2] = nz / l;
    }
    if (T && outT) {
      const a = T[v * 4], b = T[v * 4 + 1], c = T[v * 4 + 2];
      const tx = m[0] * a + m[3] * b + m[6] * c, ty = m[1] * a + m[4] * b + m[7] * c, tz = m[2] * a + m[5] * b + m[8] * c;
      const l = Math.hypot(tx, ty, tz) || 1;
      outT[v * 4] = tx / l; outT[v * 4 + 1] = ty / l; outT[v * 4 + 2] = tz / l; outT[v * 4 + 3] = T[v * 4 + 3];
    }
  }
}

// ---------- automatic weights: bone heat ----------
//
// Baran and Popović, "Automatic Rigging and Animation of 3D Characters" (SIGGRAPH 2007), the method behind Blender's
// automatic weights: each bone's weight is the steady temperature of the surface when the bone heats the vertices
// that see it nearest, −Δw + Hw = Hp, with H = 1/d² for a vertex at distance d from the nearest bone it can see (the
// straight line to it doesn't cross the surface) and p 1 where that bone is this one. Weights spread smoothly along the
// surface, stay between 0 and 1 and sum to 1. The Laplacian is over the distinct positions, each edge weighted by a
// third of its triangles' area over its length squared: the cotangent weight on even triangles, and never negative on
// the long thin ones a reduction leaves, where clamped cotangents made weights spread three times too far.

// A bounding volume hierarchy over triangles, for whether a segment crosses the surface.
function triangleTree(P, T) {
  const n = T.length / 3, order = new Uint32Array(n), cen = new Float64Array(n * 3);
  for (let t = 0; t < n; t++) {
    order[t] = t;
    for (let k = 0; k < 3; k++) cen[t * 3 + k] = (P[T[t * 3] * 3 + k] + P[T[t * 3 + 1] * 3 + k] + P[T[t * 3 + 2] * 3 + k]) / 3;
  }
  const nodes = []; // { box, left, right, start, end }
  const build = (s, e) => {
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = s; i < e; i++) for (let c = 0; c < 3; c++) {
      const v = T[order[i] * 3 + c] * 3;
      for (let k = 0; k < 3; k++) { box[k] = Math.min(box[k], P[v + k]); box[k + 3] = Math.max(box[k + 3], P[v + k]); }
    }
    const id = nodes.length;
    nodes.push({ box, left: -1, right: -1, start: s, end: e });
    if (e - s <= 6) return id;
    const ext = [box[3] - box[0], box[4] - box[1], box[5] - box[2]], ax = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
    const part = [...order.subarray(s, e)].sort((a, b) => cen[a * 3 + ax] - cen[b * 3 + ax]);
    order.set(part, s);
    const m = (s + e) >> 1;
    nodes[id].left = build(s, m);
    nodes[id].right = build(m, e);
    return id;
  };
  build(0, n);
  return { nodes, order, P, T };
}

// Whether the segment from o along d (unit) crosses a triangle between tmin and tmax.
function blocked(tree, o, d, tmin, tmax) {
  const { nodes, order, P, T } = tree, inv = [1 / d[0], 1 / d[1], 1 / d[2]], stack = [0];
  while (stack.length) {
    const nd = nodes[stack.pop()], b = nd.box;
    let t0 = tmin, t1 = tmax;
    for (let k = 0; k < 3; k++) {
      let a = (b[k] - o[k]) * inv[k], c = (b[k + 3] - o[k]) * inv[k];
      if (a > c) [a, c] = [c, a];
      if (a > t0) t0 = a;
      if (c < t1) t1 = c;
    }
    if (t0 > t1) continue;
    if (nd.left >= 0) { stack.push(nd.left, nd.right); continue; }
    for (let i = nd.start; i < nd.end; i++) {
      const t = order[i], A = T[t * 3] * 3, B = T[t * 3 + 1] * 3, C = T[t * 3 + 2] * 3;
      const e1 = [P[B] - P[A], P[B + 1] - P[A + 1], P[B + 2] - P[A + 2]], e2 = [P[C] - P[A], P[C + 1] - P[A + 1], P[C + 2] - P[A + 2]];
      const px = d[1] * e2[2] - d[2] * e2[1], py = d[2] * e2[0] - d[0] * e2[2], pz = d[0] * e2[1] - d[1] * e2[0];
      const det = e1[0] * px + e1[1] * py + e1[2] * pz;
      if (Math.abs(det) < 1e-20) continue;
      const s0 = o[0] - P[A], s1 = o[1] - P[A + 1], s2 = o[2] - P[A + 2], u = (s0 * px + s1 * py + s2 * pz) / det;
      if (u < 0 || u > 1) continue;
      const qx = s1 * e1[2] - s2 * e1[1], qy = s2 * e1[0] - s0 * e1[2], qz = s0 * e1[1] - s1 * e1[0];
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2[0] * qx + e2[1] * qy + e2[2] * qz) / det;
      if (tt > tmin && tt < tmax) return true;
    }
  }
  return false;
}

// The closest point to p on segment s.
function closestOnSegment(p, s) {
  const ab = sub(s.b, s.a), l2 = dot(ab, ab), t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, s.a), ab) / l2)) : 0;
  return add(s.a, scale(ab, t));
}

// A sparse symmetric positive definite matrix factored as L D Lᵀ (after Davis's LDL, "Algorithm 849", 2005), its
// rows reordered by nested dissection first so the factor stays sparse: the vertices are split in two by position,
// recursively, with the vertices along each cut numbered last. One factorisation then solves for every bone.
// The matrix comes as CSR over all rows (start, col, val), symmetric.
function factorLDL(n, start, col, val, coords) {
  // Nested dissection: halves by the median along the longest side of their bounds; the cut is the vertices of the
  // lower half that touch the upper one.
  const order = [], inB = new Uint8Array(n), mark = new Uint8Array(n);
  const split = list => {
    if (list.length <= 48) { for (const v of list) order.push(v); return; }
    let ax = 0, ext = -1;
    for (let k = 0; k < 3; k++) {
      let lo = Infinity, hi = -Infinity;
      for (const v of list) { const x = coords[v * 3 + k]; if (x < lo) lo = x; if (x > hi) hi = x; }
      if (hi - lo > ext) { ext = hi - lo; ax = k; }
    }
    const sorted = list.slice().sort((a, b) => coords[a * 3 + ax] - coords[b * 3 + ax]);
    const half = sorted.length >> 1, A = sorted.slice(0, half), Bs = sorted.slice(half);
    for (const v of Bs) inB[v] = 1;
    const sep = [], rest = [];
    for (const v of A) {
      let touches = false;
      for (let k = start[v]; k < start[v + 1]; k++) if (inB[col[k]] && mark[col[k]] === 0) { touches = true; break; }
      (touches ? sep : rest).push(v);
    }
    for (const v of Bs) inB[v] = 0;
    for (const v of sep) mark[v] = 1;
    split(rest);
    split(Bs);
    for (const v of sep) order.push(v);
  };
  // Pieces of the graph are ordered one after another.
  const done = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (done[s]) continue;
    const list = [s], stack = [s];
    done[s] = 1;
    while (stack.length) { const v = stack.pop(); for (let k = start[v]; k < start[v + 1]; k++) { const u = col[k]; if (!done[u]) { done[u] = 1; list.push(u); stack.push(u); } } }
    split(list);
  }
  const perm = Int32Array.from(order), pinv = new Int32Array(n);
  for (let k = 0; k < n; k++) pinv[perm[k]] = k;
  // Symbolic: the elimination tree and the column counts.
  const parent = new Int32Array(n), lnz = new Int32Array(n), flag = new Int32Array(n), Lp = new Int32Array(n + 1);
  for (let k = 0; k < n; k++) {
    parent[k] = -1; flag[k] = k; lnz[k] = 0;
    const kk = perm[k];
    for (let p = start[kk]; p < start[kk + 1]; p++) {
      let i = pinv[col[p]];
      if (i < k) for (; flag[i] !== k; i = parent[i]) { if (parent[i] === -1) parent[i] = k; lnz[i]++; flag[i] = k; }
    }
  }
  for (let k = 0; k < n; k++) Lp[k + 1] = Lp[k] + lnz[k];
  // Numeric, row by row.
  const Li = new Int32Array(Lp[n]), Lx = new Float64Array(Lp[n]), D = new Float64Array(n), Y = new Float64Array(n), pattern = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    Y[k] = 0; let top = n; flag[k] = k; lnz[k] = 0;
    const kk = perm[k];
    for (let p = start[kk]; p < start[kk + 1]; p++) {
      let i = pinv[col[p]];
      if (i > k) continue;
      Y[i] += val[p];
      let l = 0;
      for (; flag[i] !== k; i = parent[i]) { pattern[l++] = i; flag[i] = k; }
      while (l > 0) pattern[--top] = pattern[--l];
    }
    D[k] = Y[k]; Y[k] = 0;
    for (; top < n; top++) {
      const i = pattern[top], yi = Y[i];
      Y[i] = 0;
      const p2 = Lp[i] + lnz[i];
      for (let p = Lp[i]; p < p2; p++) Y[Li[p]] -= Lx[p] * yi;
      const lki = yi / D[i];
      D[k] -= lki * yi;
      Li[p2] = k; Lx[p2] = lki; lnz[i]++;
    }
    if (!(D[k] > 0)) D[k] = 1e-12;
  }
  const x = new Float64Array(n);
  // Solves A out = b.
  const solve = (b, out) => {
    for (let k = 0; k < n; k++) x[k] = b[perm[k]];
    for (let j = 0; j < n; j++) { const xj = x[j]; for (let p = Lp[j]; p < Lp[j + 1]; p++) x[Li[p]] -= Lx[p] * xj; }
    for (let j = 0; j < n; j++) x[j] /= D[j];
    for (let j = n - 1; j >= 0; j--) { let s = x[j]; for (let p = Lp[j]; p < Lp[j + 1]; p++) s -= Lx[p] * x[Li[p]]; x[j] = s; }
    for (let k = 0; k < n; k++) out[perm[k]] = x[k];
    return out;
  };
  return { solve, nnz: Lp[n] };
}

// Bone heat weights for a mesh ({ positions, index, twin? }) and a rig: { W (dense, groups × joints), groups (skinGroups),
// stats }. opt.joints: solve only these joints (indices), keeping `opt.W`'s weights for the rest.
export function boneHeat(mesh, rig, opt = {}) {
  const t0 = Date.now();
  const g = meshGraph(mesh.positions, mesh.index), G = g.n, B = rig.joints.length, P = g.P, T = g.T;
  const groups = { group: g.group, count: G, positions: Float32Array.from(P) };
  const segs = boneSegments(rig), deforming = segs.map((s, i) => (s ? i : -1)).filter(i => i >= 0);
  // Edge weights, and each vertex's area (a third of its triangles').
  const area = new Float64Array(G), edgeW = new Float64Array(g.to.length);
  const slot = (i, j) => { for (let k = g.start[i]; k < g.start[i + 1]; k++) if (g.to[k] === j) return k; return -1; };
  const normals = new Float64Array(G * 3);
  for (let t = 0; t < T.length; t += 3) {
    const v = [T[t], T[t + 1], T[t + 2]], p = v.map(i => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
    const n = [(p[1][1] - p[0][1]) * (p[2][2] - p[0][2]) - (p[1][2] - p[0][2]) * (p[2][1] - p[0][1]), (p[1][2] - p[0][2]) * (p[2][0] - p[0][0]) - (p[1][0] - p[0][0]) * (p[2][2] - p[0][2]), (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0])];
    const a2 = Math.hypot(...n);
    for (let k = 0; k < 3; k++) { area[v[k]] += a2 / 6; for (let c = 0; c < 3; c++) normals[v[k] * 3 + c] += n[c]; }
    if (!(a2 > 0)) continue;
    for (let k = 0; k < 3; k++) {
      const i = v[(k + 1) % 3], j = v[(k + 2) % 3], pi = p[(k + 1) % 3], pj = p[(k + 2) % 3];
      const l2 = dot(sub(pi, pj), sub(pi, pj));
      const w = a2 / (3 * l2);
      const a = slot(i, j), b = slot(j, i);
      if (a >= 0) edgeW[a] += w;
      if (b >= 0) edgeW[b] += w;
    }
  }
  // The nearest bone each vertex sees: tried in order of distance, the line to it must not cross the surface.
  const tree = triangleTree(P, T);
  let size = 0;
  for (let k = 0; k < 3; k++) { let lo = Infinity, hi = -Infinity; for (let v = 0; v < G; v++) { lo = Math.min(lo, P[v * 3 + k]); hi = Math.max(hi, P[v * 3 + k]); } size = Math.max(size, hi - lo); }
  const eps = 1e-4 * size;
  const nearest = new Int32Array(G).fill(-1), seen = new Int32Array(G).fill(-1), heat = new Float64Array(G);
  const root = rig.joints.findIndex(j => j.slot === 'Root');
  const up = rig.frame ? rig.frame.up : [0, 1, 0];
  let invisible = 0;
  for (let v = 0; v < G; v++) {
    const p = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
    // The base a figure stands on belongs to its Root.
    if (root >= 0 && rig.base !== undefined && rig.base !== null && dot(p, up) < rig.base) { nearest[v] = seen[v] = root; heat[v] = 1 / (0.02 * size) ** 2; continue; }
    const cand = deforming.filter(b => b !== root).map(b => [b, segmentDistance(p, segs[b])]).sort((a, b) => a[1] - b[1]);
    nearest[v] = cand.length ? cand[0][0] : 0;
    for (let k = 0; k < Math.min(8, cand.length); k++) {
      const [b, d] = cand[k], q = closestOnSegment(p, segs[b]), dir = sub(q, p), l = len(dir);
      if (l < eps || !blocked(tree, p, scale(dir, 1 / l), eps, l - eps)) { seen[v] = b; heat[v] = 1 / Math.max(d, eps) ** 2; break; }
    }
    if (seen[v] < 0) invisible++;
  }
  // Pieces that see no bone at all (eyes inside the head, buttons sewn on) and small separate pieces move rigidly with
  // the bone nearest their middle.
  const piece = new Int32Array(G).fill(-1), pieces = [];
  for (let s = 0; s < G; s++) {
    if (piece[s] >= 0) continue;
    const id = pieces.length, stack = [s], members = [];
    piece[s] = id;
    while (stack.length) { const v = stack.pop(); members.push(v); for (let k = g.start[v]; k < g.start[v + 1]; k++) { const u = g.to[k]; if (piece[u] < 0) { piece[u] = id; stack.push(u); } } }
    pieces.push(members);
  }
  const totalArea = area.reduce((a, b) => a + b, 0);
  const rigid = new Int32Array(G).fill(-1);
  let rigidPieces = 0;
  for (const members of pieces) {
    let a = 0, any = false;
    const c = [0, 0, 0];
    for (const v of members) { a += area[v]; any = any || seen[v] >= 0; for (let k = 0; k < 3; k++) c[k] += P[v * 3 + k] * area[v]; }
    if (any && (a > 0.01 * totalArea || pieces.length === 1)) continue;
    const mid = c.map(x => x / (a || 1));
    let best = -1, bd = Infinity;
    for (const b of deforming) { if (b === root) continue; const d = segmentDistance(mid, segs[b]); if (d < bd) { bd = d; best = b; } }
    if (best < 0) continue;
    for (const v of members) rigid[v] = best;
    rigidPieces++;
  }
  // (L + A H) w = A H p for every bone at once: one factorisation over the whole surface. A vertex that sees no bone
  // gets a faint pull toward its nearest one, so a piece of such vertices still has a solution.
  const target = new Int32Array(G), pull = new Float64Array(G);
  for (let v = 0; v < G; v++) {
    target[v] = seen[v] >= 0 ? seen[v] : nearest[v];
    pull[v] = area[v] * (seen[v] >= 0 ? heat[v] : 1e-4 / (0.1 * size) ** 2);
  }
  const start = new Int32Array(G + 1), col = new Int32Array(g.to.length + G), val = new Float64Array(g.to.length + G);
  let o = 0;
  for (let v = 0; v < G; v++) {
    let diag = pull[v];
    for (let k = g.start[v]; k < g.start[v + 1]; k++) { diag += edgeW[k]; col[o] = g.to[k]; val[o++] = -edgeW[k]; }
    col[o] = v; val[o++] = diag;
    start[v + 1] = o;
  }
  const factor = factorLDL(G, start, col, val, P);
  const W = opt.W ? Float32Array.from(opt.W) : new Float32Array(G * B);
  const todo = opt.joints ? opt.joints.filter(b => segs[b]) : deforming;
  const rhs = new Float64Array(G), x = new Float64Array(G);
  for (const b of todo) {
    let any = false;
    for (let v = 0; v < G; v++) { rhs[v] = target[v] === b ? pull[v] : 0; any = any || rhs[v] > 0; }
    if (!any) { for (let v = 0; v < G; v++) W[v * B + b] = 0; continue; }
    factor.solve(rhs, x);
    for (let v = 0; v < G; v++) W[v * B + b] = x[v] > 1e-6 ? x[v] : 0;
  }
  // Re-solving some bones: the others make room for them in proportion.
  if (opt.joints) {
    const chosen = new Uint8Array(B);
    for (const b of todo) chosen[b] = 1;
    for (let v = 0; v < G; v++) {
      let mine = 0, rest = 0;
      for (let b = 0; b < B; b++) (chosen[b] ? (mine += W[v * B + b]) : (rest += W[v * B + b]));
      if (rest > 1e-9 && mine < 1) for (let b = 0; b < B; b++) if (!chosen[b]) W[v * B + b] *= (1 - Math.min(1, mine)) / rest;
    }
  }
  // Normalised per vertex; rigid pieces and vertices left with nothing go wholly to their bone.
  for (let v = 0; v < G; v++) {
    if (rigid[v] >= 0) { W.fill(0, v * B, v * B + B); W[v * B + rigid[v]] = 1; continue; }
    let s = 0;
    for (let b = 0; b < B; b++) s += W[v * B + b];
    if (s > 1e-9) for (let b = 0; b < B; b++) W[v * B + b] /= s;
    else { W.fill(0, v * B, v * B + B); W[v * B + nearest[v]] = 1; }
  }
  if (mesh.twin) mirrorWeights(W, groups, mesh, rig);
  return { W, groups, stats: { invisible, rigidPieces, factor: factor.nnz, ms: Date.now() - t0 } };
}

// Weights made exactly symmetric through the result's mirror pairs (twin): each group averaged with its partner's,
// left and right joints swapped.
export function mirrorWeights(W, groups, mesh, rig, from = null) {
  const B = rig.joints.length, G = groups.count, partner = new Int32Array(G).fill(-1);
  for (let v = 0; v < mesh.twin.length; v++) partner[groups.group[v]] = groups.group[mesh.twin[v]];
  const swap = rig.joints.map((j, i) => (j.mirror >= 0 ? j.mirror : i));
  const out = new Float32Array(B);
  for (let g = 0; g < G; g++) {
    const m = partner[g];
    if (m < 0 || m < g) continue;
    // from: 'L' or 'R' copies that side's weights onto the other instead of averaging the two.
    const keepG = from === null ? null : sideOf(groups, g, rig) === from;
    for (let b = 0; b < B; b++) {
      const a = W[g * B + b], c = W[m * B + swap[b]];
      out[b] = keepG === null ? (a + c) / 2 : keepG ? a : c;
    }
    for (let b = 0; b < B; b++) { W[g * B + b] = out[b]; W[m * B + swap[b]] = out[b]; }
  }
  return W;
}

// Which side of the rig's mirror plane a group lies on, 'L' or 'R' (the figure's left is the frame's left).
function sideOf(groups, g, rig) {
  const p = [groups.positions[g * 3], groups.positions[g * 3 + 1], groups.positions[g * 3 + 2]];
  return dot(p, rig.frame.left) - (rig.plane ? rig.plane.offset * rig.frame.left[rig.plane.axis] : 0) >= 0 ? 'L' : 'R';
}

// The weights of the same positions in a new result, one whose vertices are only split differently (an unwrap): matched
// by exact position. Null when a position of the new result wasn't in the old one.
export function remapWeights(W, B, oldPositions, groups) {
  const G0 = oldPositions.length / 3, at = new Map();
  const ob = new Uint32Array(oldPositions.buffer, oldPositions.byteOffset, G0 * 3);
  for (let g = 0; g < G0; g++) at.set(`${ob[g * 3]},${ob[g * 3 + 1]},${ob[g * 3 + 2]}`, g);
  const nb = new Uint32Array(groups.positions.buffer, groups.positions.byteOffset, groups.count * 3);
  const out = new Float32Array(groups.count * B);
  for (let g = 0; g < groups.count; g++) {
    const o = at.get(`${nb[g * 3]},${nb[g * 3 + 1]},${nb[g * 3 + 2]}`);
    if (o === undefined) return null;
    out.set(W.subarray(o * B, o * B + B), g * B);
  }
  return out;
}
