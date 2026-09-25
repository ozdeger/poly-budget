// Quad remeshing: rebuilds a surface as quads that follow its shape, at a given face count.
//
// The field solver and the quad extraction follow Instant Meshes: Wenzel Jakob, Marco Tarini, Daniele Panozzo and
// Olga Sorkine-Hornung, "Instant Field-Aligned Meshes", ACM Transactions on Graphics 34(6), 2015. A direction field
// (which way edges run, up to quarter turns) and a position field (where the corners of a square grid of the target
// edge length sit) are smoothed over a hierarchy of ever coarser vertex graphs, and the quads are read off where the
// grid says two input vertices share a corner or sit one edge apart. Their implementation carries this licence:
//
//   Copyright (c) 2015 Wenzel Jakob, Daniele Panozzo, Marco Tarini, and Olga Sorkine-Hornung. All rights reserved.
//
//   Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
//   following conditions are met:
//   1. Redistributions of source code must retain the above copyright notice, this list of conditions and the
//      following disclaimer.
//   2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the
//      following disclaimer in the documentation and/or other materials provided with the distribution.
//   3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote
//      products derived from this software without specific prior written permission.
//   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
//   INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
//   DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
//   SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
//   SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
//   WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE
//   USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//
// Face sizes follow the shape (opt.adapt): each face is sized from the surface's two principal curvatures, short
// across the direction that bends most and long along the one that bends least, and the direction field is pulled
// toward that long direction where the faces stretch (see formSizes).
//
// Instant Meshes leaves a few triangles and pentagons among the quads and offers all quads only by splitting every
// face in four. Here each leftover odd face is instead paired with its nearest odd neighbour, and the strip of faces
// between them is split in two lengthwise, which turns every face into quads while the density barely changes. Edge
// rotations and diagonal collapses then lower the pole count, long sharp edges are kept as edge loops, and the
// vertices are relaxed along the original surface.

const NONE = 0xffffffff;

function random(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Two unit tangents s, t for the normal n (s × t = n), written to out[o..o+5].
function tangents(nx, ny, nz, out, o = 0) {
  let cx, cy, cz;
  if (Math.abs(nx) > Math.abs(ny)) {
    const l = 1 / Math.sqrt(nx * nx + nz * nz);
    cx = nz * l; cy = 0; cz = -nx * l;
  } else {
    const l = 1 / (Math.sqrt(ny * ny + nz * nz) || 1);
    cx = 0; cy = nz * l; cz = -ny * l;
  }
  out[o] = cy * nz - cz * ny; out[o + 1] = cz * nx - cx * nz; out[o + 2] = cx * ny - cy * nx;
  out[o + 3] = cx; out[o + 4] = cy; out[o + 5] = cz;
}

// ---------- working surface ----------

// Each undirected edge of a triangle list once, with how many triangles use it.
function edgesOf(index, V) {
  const keys = new Float64Array(index.length);
  let m = 0;
  for (let t = 0; t < index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = index[t + k], b = index[t + (k === 2 ? 0 : k + 1)];
      if (a !== b) keys[m++] = a < b ? a * V + b : b * V + a;
    }
  }
  const sorted = keys.subarray(0, m).sort();
  const ea = new Int32Array(m), eb = new Int32Array(m), count = new Uint16Array(m);
  let n = 0;
  for (let i = 0; i < m;) {
    let j = i + 1;
    while (j < m && sorted[j] === sorted[i]) j++;
    const a = Math.floor(sorted[i] / V);
    ea[n] = a; eb[n] = sorted[i] - a * V; count[n] = Math.min(65535, j - i);
    n++;
    i = j;
  }
  return { a: ea.subarray(0, n), b: eb.subarray(0, n), count: count.subarray(0, n), n };
}

// Splits edges longer than factor × the local grid size (the smaller of their ends' sizes) until none is left, so the
// grid can't step over a vertex. With a metric (6 floats per vertex, see formSizes) and the grid scale, an edge counts
// as long when it spans more than factor of the grid step along its own direction, so edges along the long side of
// stretched faces stay whole. New vertices remember the two they were made between, take the smaller size and the
// mean metric.
function splitLongEdges(P, index, size, factor = 0.5, maxPasses = 6, metric = null, scale = 1) {
  let pos = P, idx = index, V = P.length / 3, sz = size, met = metric;
  let pa = new Int32Array(V), pb = new Int32Array(V);
  for (let i = 0; i < V; i++) pa[i] = pb[i] = i;
  const tooLong = (a, b, dx, dy, dz) => {
    if (!met) { const s = factor * Math.min(sz[a], sz[b]); return dx * dx + dy * dy + dz * dz > s * s; }
    let worst = 0;
    for (const o of [a * 6, b * 6]) {
      const q = dx * (met[o] * dx + met[o + 1] * dy + met[o + 2] * dz) + dy * (met[o + 1] * dx + met[o + 3] * dy + met[o + 4] * dz) + dz * (met[o + 2] * dx + met[o + 4] * dy + met[o + 5] * dz);
      if (q > worst) worst = q;
    }
    return worst > factor * factor * scale * scale;
  };
  for (let pass = 0; pass < maxPasses; pass++) {
    const E = edgesOf(idx, V);
    const mid = new Map();
    let add = 0;
    for (let e = 0; e < E.n; e++) {
      const a = E.a[e], b = E.b[e];
      const dx = pos[a * 3] - pos[b * 3], dy = pos[a * 3 + 1] - pos[b * 3 + 1], dz = pos[a * 3 + 2] - pos[b * 3 + 2];
      if (tooLong(a, b, dx, dy, dz)) { mid.set(a * V + b, V + add); add++; }
    }
    if (!add) break;
    const np = new Float64Array((V + add) * 3);
    np.set(pos.subarray(0, V * 3));
    const na = new Int32Array(V + add), nb = new Int32Array(V + add), ns = new Float64Array(V + add);
    na.set(pa.subarray(0, V)); nb.set(pb.subarray(0, V)); ns.set(sz.subarray(0, V));
    const nm = met ? new Float64Array((V + add) * 6) : null;
    if (nm) nm.set(met.subarray(0, V * 6));
    for (const [key, m] of mid) {
      const a = Math.floor(key / V), b = key - a * V;
      for (let k = 0; k < 3; k++) np[m * 3 + k] = (pos[a * 3 + k] + pos[b * 3 + k]) / 2;
      na[m] = a; nb[m] = b; ns[m] = Math.min(sz[a], sz[b]);
      if (nm) for (let k = 0; k < 6; k++) nm[m * 6 + k] = (met[a * 6 + k] + met[b * 6 + k]) / 2;
    }
    const out = [];
    const midOf = (a, b) => { const m = mid.get(a < b ? a * V + b : b * V + a); return m === undefined ? -1 : m; };
    const d2 = (a, b) => { const x = np[a * 3] - np[b * 3], y = np[a * 3 + 1] - np[b * 3 + 1], z = np[a * 3 + 2] - np[b * 3 + 2]; return x * x + y * y + z * z; };
    for (let t = 0; t < idx.length; t += 3) {
      const v = [idx[t], idx[t + 1], idx[t + 2]];
      const m = [midOf(v[0], v[1]), midOf(v[1], v[2]), midOf(v[2], v[0])];
      const cnt = (m[0] >= 0) + (m[1] >= 0) + (m[2] >= 0);
      if (cnt === 0) { out.push(v[0], v[1], v[2]); continue; }
      if (cnt === 3) {
        out.push(v[0], m[0], m[2], m[0], v[1], m[1], m[2], m[1], v[2], m[0], m[1], m[2]);
        continue;
      }
      // Rotate so the split edges come first.
      let r = 0;
      if (cnt === 1) r = m[0] >= 0 ? 0 : m[1] >= 0 ? 1 : 2;
      else r = m[0] < 0 ? 1 : m[1] < 0 ? 2 : 0;
      const a = v[r], b = v[(r + 1) % 3], c = v[(r + 2) % 3], m0 = m[r], m1 = m[(r + 1) % 3];
      if (cnt === 1) { out.push(a, m0, c, m0, b, c); continue; }
      // Edges a-b and b-c split: the corner triangle at b, and the rest as two triangles along the shorter diagonal.
      out.push(m0, b, m1);
      if (d2(a, m1) < d2(m0, c)) out.push(a, m0, m1, a, m1, c);
      else out.push(a, m0, c, m0, m1, c);
    }
    pos = np; idx = Uint32Array.from(out); V += add; pa = na; pb = nb; sz = ns;
    if (nm) met = nm;
  }
  return { positions: pos, index: idx, parentA: pa, parentB: pb, size: sz, metric: met };
}

// ---------- graph hierarchy ----------

function edgeArgs(index, n) {
  const E = edgesOf(index, n);
  return [E.a, E.b, E.n];
}

function adjacency(n, ea, eb, ne) {
  const start = new Int32Array(n + 1);
  for (let e = 0; e < ne; e++) { start[ea[e] + 1]++; start[eb[e] + 1]++; }
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const id = new Int32Array(start[n]), w = new Float32Array(start[n]).fill(1), fill = start.slice(0, n);
  for (let e = 0; e < ne; e++) { id[fill[ea[e]]++] = eb[e]; id[fill[eb[e]]++] = ea[e]; }
  return { start, id, w };
}

// One coarser level: vertex pairs along links with similar normals are merged (Instant Meshes' downsample_graph); the
// metric is averaged by area.
function downsample(L) {
  const { n, start, id, w, N, A, V, S, M } = L;
  const owner = new Int32Array(id.length);
  let m = 0;
  for (let i = 0; i < n; i++) for (let l = start[i]; l < start[i + 1]; l++) { owner[l] = i; if (id[l] > i) m++; }
  const keys = new Float64Array(m);
  let c = 0;
  for (let i = 0; i < n; i++) {
    for (let l = start[i]; l < start[i + 1]; l++) {
      const k = id[l];
      if (k <= i) continue;
      const dp = N[i * 3] * N[k * 3] + N[i * 3 + 1] * N[k * 3 + 1] + N[i * 3 + 2] * N[k * 3 + 2];
      let ratio = A[i] > A[k] ? A[i] / A[k] : A[k] / A[i];
      if (!(ratio < 100)) ratio = 100;
      const order = Math.max(-100, Math.min(100, dp * ratio));
      keys[c++] = Math.floor(((100 - order) / 200) * 1048575) * 4294967296 + l;
    }
  }
  keys.sort();
  const merged = new Uint8Array(n), pa = new Int32Array(n), pb = new Int32Array(n);
  let np = 0;
  for (let e = 0; e < m; e++) {
    const l = keys[e] % 4294967296, i = owner[l], k = id[l];
    if (merged[i] || merged[k]) continue;
    merged[i] = merged[k] = 1;
    pa[np] = i; pb[np] = k; np++;
  }
  const n2 = n - np;
  const V2 = new Float64Array(n2 * 3), N2 = new Float64Array(n2 * 3), A2 = new Float64Array(n2), S2 = new Float64Array(n2), M2 = new Float64Array(n2 * 6);
  const up = new Int32Array(n2 * 2).fill(-1), toLower = new Int32Array(n);
  for (let p = 0; p < np; p++) {
    const i = pa[p], k = pb[p], ai = A[i], ak = A[k], sa = ai + ak;
    const wi = sa > 1e-30 ? ai / sa : 0.5, wk = 1 - wi;
    let nx = N[i * 3] * ai + N[k * 3] * ak, ny = N[i * 3 + 1] * ai + N[k * 3 + 1] * ak, nz = N[i * 3 + 2] * ai + N[k * 3 + 2] * ak;
    const nl = Math.hypot(nx, ny, nz);
    if (nl > 1e-30) { nx /= nl; ny /= nl; nz /= nl; } else { nx = N[i * 3]; ny = N[i * 3 + 1]; nz = N[i * 3 + 2]; }
    for (let d = 0; d < 3; d++) V2[p * 3 + d] = V[i * 3 + d] * wi + V[k * 3 + d] * wk;
    N2[p * 3] = nx; N2[p * 3 + 1] = ny; N2[p * 3 + 2] = nz;
    A2[p] = sa;
    S2[p] = S[i] * wi + S[k] * wk;
    for (let d = 0; d < 6; d++) M2[p * 6 + d] = M[i * 6 + d] * wi + M[k * 6 + d] * wk;
    up[p * 2] = i; up[p * 2 + 1] = k;
    toLower[i] = toLower[k] = p;
  }
  let q = np;
  for (let i = 0; i < n; i++) {
    if (merged[i]) continue;
    for (let d = 0; d < 3; d++) { V2[q * 3 + d] = V[i * 3 + d]; N2[q * 3 + d] = N[i * 3 + d]; }
    A2[q] = A[i]; S2[q] = S[i];
    for (let d = 0; d < 6; d++) M2[q * 6 + d] = M[i * 6 + d];
    up[q * 2] = i;
    toLower[i] = q++;
  }
  const start2 = new Int32Array(n2 + 1), id2 = new Int32Array(id.length), w2 = new Float32Array(id.length);
  const mark = new Int32Array(n2).fill(-1), slot = new Int32Array(n2);
  let o = 0;
  for (let p = 0; p < n2; p++) {
    start2[p] = o;
    for (let h = 0; h < 2; h++) {
      const child = up[p * 2 + h];
      if (child < 0) continue;
      for (let l = start[child]; l < start[child + 1]; l++) {
        const t = toLower[id[l]];
        if (t === p) continue;
        if (mark[t] !== p) { mark[t] = p; slot[t] = o; id2[o] = t; w2[o] = w[l]; o++; }
        else w2[slot[t]] += w[l];
      }
    }
  }
  start2[n2] = o;
  return { n: n2, V: V2, N: N2, A: A2, S: S2, M: M2, start: start2, id: id2.slice(0, o), w: w2.slice(0, o), up, toLower };
}

function buildHierarchy(L0) {
  const levels = [L0];
  for (let guard = 0; guard < 40; guard++) {
    const L = levels[levels.length - 1];
    if (L.n <= 1) break;
    const next = downsample(L);
    if (next.n >= L.n) break;
    levels.push(next);
  }
  return levels;
}

// Constraints (a direction a vertex's edges must follow and a line its grid must pass through) carried to the coarser
// levels, as Instant Meshes' propagateConstraints does.
function propagateConstraints(levels) {
  for (let l = 0; l + 1 < levels.length; l++) {
    const F = levels[l], C = levels[l + 1];
    C.CQ = new Float64Array(C.n * 3); C.CO = new Float64Array(C.n * 3); C.Cw = new Float32Array(C.n);
    for (let i = 0; i < C.n; i++) {
      const a = C.up[i * 2], b = C.up[i * 2 + 1];
      const ha = F.Cw[a] > 0, hb = b >= 0 && F.Cw[b] > 0;
      if (!ha && !hb) continue;
      let qx, qy, qz, ox, oy, oz;
      if (ha && hb) {
        compatOrient(F.CQ, a * 3, F.N, a * 3, F.CQ, b * 3, F.N, b * 3);
        qx = R[0] + R[3]; qy = R[1] + R[4]; qz = R[2] + R[5];
        ox = (F.CO[a * 3] + F.CO[b * 3]) / 2; oy = (F.CO[a * 3 + 1] + F.CO[b * 3 + 1]) / 2; oz = (F.CO[a * 3 + 2] + F.CO[b * 3 + 2]) / 2;
      } else {
        const s = ha ? a : b;
        qx = F.CQ[s * 3]; qy = F.CQ[s * 3 + 1]; qz = F.CQ[s * 3 + 2];
        ox = F.CO[s * 3]; oy = F.CO[s * 3 + 1]; oz = F.CO[s * 3 + 2];
      }
      const nx = C.N[i * 3], ny = C.N[i * 3 + 1], nz = C.N[i * 3 + 2], d = nx * qx + ny * qy + nz * qz;
      qx -= nx * d; qy -= ny * d; qz -= nz * d;
      const ql = Math.hypot(qx, qy, qz);
      if (ql < 1e-12) continue;
      C.CQ[i * 3] = qx / ql; C.CQ[i * 3 + 1] = qy / ql; C.CQ[i * 3 + 2] = qz / ql;
      C.CO[i * 3] = ox; C.CO[i * 3 + 1] = oy; C.CO[i * 3 + 2] = oz;
      C.Cw[i] = 1;
    }
  }
}

// ---------- the two fields ----------

// Scratch results: compatOrient writes the two agreeing representatives to R[0..2] and R[3..5], and which ones they
// are to RA (0: the direction itself, 1: its quarter turn).
const R = new Float64Array(6);
const RA = new Int8Array(2);

// Of the four quarter-turn representatives of q0 (normal n0) and q1 (normal n1), the pair that agrees best
// (Instant Meshes' compat_orientation_extrinsic_4).
function compatOrient(Qa, ia, Na, ja, Qb, ib, Nb, jb) {
  const q0x = Qa[ia], q0y = Qa[ia + 1], q0z = Qa[ia + 2], n0x = Na[ja], n0y = Na[ja + 1], n0z = Na[ja + 2];
  const q1x = Qb[ib], q1y = Qb[ib + 1], q1z = Qb[ib + 2], n1x = Nb[jb], n1y = Nb[jb + 1], n1z = Nb[jb + 2];
  const a1x = n0y * q0z - n0z * q0y, a1y = n0z * q0x - n0x * q0z, a1z = n0x * q0y - n0y * q0x;
  const b1x = n1y * q1z - n1z * q1y, b1y = n1z * q1x - n1x * q1z, b1z = n1x * q1y - n1y * q1x;
  const d00 = q0x * q1x + q0y * q1y + q0z * q1z, d01 = q0x * b1x + q0y * b1y + q0z * b1z;
  const d10 = a1x * q1x + a1y * q1y + a1z * q1z, d11 = a1x * b1x + a1y * b1y + a1z * b1z;
  let best = Math.abs(d00), ai = 0, bi = 0, dp = d00;
  if (Math.abs(d01) > best) { best = Math.abs(d01); ai = 0; bi = 1; dp = d01; }
  if (Math.abs(d10) > best) { best = Math.abs(d10); ai = 1; bi = 0; dp = d10; }
  if (Math.abs(d11) > best) { ai = 1; bi = 1; dp = d11; }
  const s = dp < 0 ? -1 : 1;
  RA[0] = ai; RA[1] = bi;
  if (ai === 0) { R[0] = q0x; R[1] = q0y; R[2] = q0z; } else { R[0] = a1x; R[1] = a1y; R[2] = a1z; }
  if (bi === 0) { R[3] = q1x * s; R[4] = q1y * s; R[5] = q1z * s; } else { R[3] = b1x * s; R[4] = b1y * s; R[5] = b1z * s; }
}

// Where the faces stretch (L.AQ, L.Aw from levelAlignment), each vertex is pulled toward the long direction by its
// weight after averaging its neighbours; constraints (open borders) come last and win.
function optimizeOrientations(L, iterations) {
  const { n, start, id, w, N, Q } = L;
  const CQ = L.CQ, Cw = L.Cw, AQ = L.AQ, Aw = L.Aw;
  const S3 = new Float64Array(3);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
      S3[0] = Q[i * 3]; S3[1] = Q[i * 3 + 1]; S3[2] = Q[i * 3 + 2];
      let wsum = 0;
      for (let l = start[i]; l < start[i + 1]; l++) {
        const j = id[l], wt = w[l];
        compatOrient(S3, 0, N, i * 3, Q, j * 3, N, j * 3);
        let x = R[0] * wsum + R[3] * wt, y = R[1] * wsum + R[4] * wt, z = R[2] * wsum + R[5] * wt;
        const d = nx * x + ny * y + nz * z;
        x -= nx * d; y -= ny * d; z -= nz * d;
        wsum += wt;
        const len = Math.hypot(x, y, z);
        if (len > 1e-30) { x /= len; y /= len; z /= len; }
        S3[0] = x; S3[1] = y; S3[2] = z;
      }
      if (Aw && Aw[i] > 0) {
        const aw = Aw[i];
        compatOrient(S3, 0, N, i * 3, AQ, i * 3, N, i * 3);
        let x = R[0] * (1 - aw) + R[3] * aw, y = R[1] * (1 - aw) + R[4] * aw, z = R[2] * (1 - aw) + R[5] * aw;
        const d = nx * x + ny * y + nz * z;
        x -= nx * d; y -= ny * d; z -= nz * d;
        const len = Math.hypot(x, y, z);
        if (len > 1e-30) { S3[0] = x / len; S3[1] = y / len; S3[2] = z / len; }
      }
      if (Cw && Cw[i] > 0) {
        const cw = Cw[i];
        compatOrient(S3, 0, N, i * 3, CQ, i * 3, N, i * 3);
        let x = R[0] * (1 - cw) + R[3] * cw, y = R[1] * (1 - cw) + R[4] * cw, z = R[2] * (1 - cw) + R[5] * cw;
        const d = nx * x + ny * y + nz * z;
        x -= nx * d; y -= ny * d; z -= nz * d;
        const len = Math.hypot(x, y, z);
        if (len > 1e-30) { S3[0] = x / len; S3[1] = y / len; S3[2] = z / len; }
      }
      if (wsum > 0 || (Cw && Cw[i] > 0) || (Aw && Aw[i] > 0)) { Q[i * 3] = S3[0]; Q[i * 3 + 1] = S3[1]; Q[i * 3 + 2] = S3[2]; }
    }
  }
}

// Scratch results: compatPos writes the agreeing grid corners of vertex 0 and vertex 1 to P2[0..2] and P2[3..5] (and
// their integer grid coordinates, relative to each vertex's own grid origin, to I4), and the squared distance to P2[6].
const P2 = new Float64Array(7);
const I4 = new Int32Array(4);

// The grid corners near two vertices that come closest to each other (Instant Meshes'
// compat_position_extrinsic_4, with a grid size per vertex as QuadriFlow allows, and here one per direction).
// Arguments: position p, normal n, direction q (unit, in the tangent plane), grid origin o, and the grid step along q
// (s) and across it (r) of each.
function compatPos(p0x, p0y, p0z, n0x, n0y, n0z, q0x, q0y, q0z, o0x, o0y, o0z, s0, r0,
  p1x, p1y, p1z, n1x, n1y, n1z, q1x, q1y, q1z, o1x, o1y, o1z, s1, r1) {
  // The point closest to both vertices that lies in both tangent planes.
  const n0p0 = n0x * p0x + n0y * p0y + n0z * p0z, n0p1 = n0x * p1x + n0y * p1y + n0z * p1z;
  const n1p0 = n1x * p0x + n1y * p0y + n1z * p0z, n1p1 = n1x * p1x + n1y * p1y + n1z * p1z;
  const n0n1 = n0x * n1x + n0y * n1y + n0z * n1z;
  const den = 1 / (1 - n0n1 * n0n1 + 1e-4);
  const l0 = 2 * (n0p1 - n0p0 - n0n1 * (n1p0 - n1p1)) * den, l1 = 2 * (n1p0 - n1p1 - n0n1 * (n0p1 - n0p0)) * den;
  const mx = 0.5 * (p0x + p1x) - 0.25 * (n0x * l0 + n1x * l1);
  const my = 0.5 * (p0y + p1y) - 0.25 * (n0y * l0 + n1y * l1);
  const mz = 0.5 * (p0z + p1z) - 0.25 * (n0z * l0 + n1z * l1);
  const t0x = n0y * q0z - n0z * q0y, t0y = n0z * q0x - n0x * q0z, t0z = n0x * q0y - n0y * q0x;
  const t1x = n1y * q1z - n1z * q1y, t1y = n1z * q1x - n1x * q1z, t1z = n1x * q1y - n1y * q1x;
  let dx = mx - o0x, dy = my - o0y, dz = mz - o0z;
  const a0 = Math.floor((q0x * dx + q0y * dy + q0z * dz) / s0), b0 = Math.floor((t0x * dx + t0y * dy + t0z * dz) / r0);
  dx = mx - o1x; dy = my - o1y; dz = mz - o1z;
  const a1 = Math.floor((q1x * dx + q1y * dy + q1z * dz) / s1), b1 = Math.floor((t1x * dx + t1y * dy + t1z * dz) / r1);
  let best = Infinity, bi = 0, bj = 0;
  for (let i = 0; i < 4; i++) {
    const u0 = (a0 + (i & 1)) * s0, v0 = (b0 + (i >> 1)) * r0;
    const x0 = o0x + q0x * u0 + t0x * v0, y0 = o0y + q0y * u0 + t0y * v0, z0 = o0z + q0z * u0 + t0z * v0;
    for (let j = 0; j < 4; j++) {
      const u1 = (a1 + (j & 1)) * s1, v1 = (b1 + (j >> 1)) * r1;
      const ex = o1x + q1x * u1 + t1x * v1 - x0, ey = o1y + q1y * u1 + t1y * v1 - y0, ez = o1z + q1z * u1 + t1z * v1 - z0;
      const c = ex * ex + ey * ey + ez * ez;
      if (c < best) { best = c; bi = i; bj = j; }
    }
  }
  const u0 = (a0 + (bi & 1)) * s0, v0 = (b0 + (bi >> 1)) * r0, u1 = (a1 + (bj & 1)) * s1, v1 = (b1 + (bj >> 1)) * r1;
  P2[0] = o0x + q0x * u0 + t0x * v0; P2[1] = o0y + q0y * u0 + t0y * v0; P2[2] = o0z + q0z * u0 + t0z * v0;
  P2[3] = o1x + q1x * u1 + t1x * v1; P2[4] = o1y + q1y * u1 + t1y * v1; P2[5] = o1z + q1z * u1 + t1z * v1;
  P2[6] = best;
  I4[0] = a0 + (bi & 1); I4[1] = b0 + (bi >> 1); I4[2] = a1 + (bj & 1); I4[3] = b1 + (bj >> 1);
}

// Each vertex's grid runs along its own direction with steps L.SU along it and L.SV across it (levelSpacings).
function optimizePositions(L, iterations) {
  const { n, start, id, w, N, Q, O, V, SU, SV } = L;
  const CQ = L.CQ, CO = L.CO, Cw = L.Cw;
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const px = V[i3], py = V[i3 + 1], pz = V[i3 + 2], nx = N[i3], ny = N[i3 + 1], nz = N[i3 + 2];
      let qx = Q[i3], qy = Q[i3 + 1], qz = Q[i3 + 2];
      const ql = Math.hypot(qx, qy, qz) || 1;
      qx /= ql; qy /= ql; qz /= ql;
      const si = SU[i], ri = SV[i];
      let sx = O[i3], sy = O[i3 + 1], sz = O[i3 + 2], wsum = 0;
      for (let l = start[i]; l < start[i + 1]; l++) {
        const j = id[l], j3 = j * 3, wt = w[l];
        let rx = Q[j3], ry = Q[j3 + 1], rz = Q[j3 + 2];
        const rl = Math.hypot(rx, ry, rz) || 1;
        rx /= rl; ry /= rl; rz /= rl;
        compatPos(px, py, pz, nx, ny, nz, qx, qy, qz, sx, sy, sz, si, ri,
          V[j3], V[j3 + 1], V[j3 + 2], N[j3], N[j3 + 1], N[j3 + 2], rx, ry, rz, O[j3], O[j3 + 1], O[j3 + 2], SU[j], SV[j]);
        const tw = wsum + wt;
        sx = (P2[0] * wsum + P2[3] * wt) / tw; sy = (P2[1] * wsum + P2[4] * wt) / tw; sz = (P2[2] * wsum + P2[5] * wt) / tw;
        wsum = tw;
        const d = nx * (sx - px) + ny * (sy - py) + nz * (sz - pz);
        sx -= nx * d; sy -= ny * d; sz -= nz * d;
      }
      if (Cw && Cw[i] > 0) {
        const cw = Cw[i], cqx = CQ[i3], cqy = CQ[i3 + 1], cqz = CQ[i3 + 2];
        let dx = CO[i3] - sx, dy = CO[i3 + 1] - sy, dz = CO[i3 + 2] - sz;
        const along = cqx * dx + cqy * dy + cqz * dz;
        dx -= cqx * along; dy -= cqy * along; dz -= cqz * along;
        sx += cw * dx; sy += cw * dy; sz += cw * dz;
        const d = nx * (sx - px) + ny * (sy - py) + nz * (sz - pz);
        sx -= nx * d; sy -= ny * d; sz -= nz * d;
      }
      if (wsum > 0) {
        // The grid corner nearest the vertex.
        const tx = ny * qz - nz * qy, ty = nz * qx - nx * qz, tz = nx * qy - ny * qx;
        const dx = px - sx, dy = py - sy, dz = pz - sz;
        const a = Math.round((qx * dx + qy * dy + qz * dz) / si) * si, b = Math.round((tx * dx + ty * dy + tz * dz) / ri) * ri;
        O[i3] = sx + qx * a + tx * b; O[i3 + 1] = sy + qy * a + ty * b; O[i3 + 2] = sz + qz * a + tz * b;
      }
    }
  }
}

// The direction field alone, from the coarsest level down (the position field follows in resolvePositions).
function solveOrientations(levels, seed, progress) {
  const rand = random(seed), top = levels[levels.length - 1], T6 = new Float64Array(6);
  for (const L of levels) { if (!L.Q) L.Q = new Float64Array(L.n * 3); if (!L.O) L.O = new Float64Array(L.n * 3); }
  for (let i = 0; i < top.n; i++) {
    tangents(top.N[i * 3], top.N[i * 3 + 1], top.N[i * 3 + 2], T6);
    const a = rand() * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
    for (let d = 0; d < 3; d++) top.Q[i * 3 + d] = T6[d] * c + T6[3 + d] * s;
  }
  const total = levels.reduce((sum, L) => sum + L.n, 0);
  let done = 0;
  for (let l = levels.length - 1; l >= 0; l--) {
    const L = levels[l];
    optimizeOrientations(L, 6);
    done += L.n;
    if (progress) progress('orientation', done / total);
    if (l === 0) break;
    const F = levels[l - 1];
    for (let i = 0; i < L.n; i++) {
      for (let h = 0; h < 2; h++) {
        const c = L.up[i * 2 + h];
        if (c < 0) continue;
        const nx = F.N[c * 3], ny = F.N[c * 3 + 1], nz = F.N[c * 3 + 2];
        let x = L.Q[i * 3], y = L.Q[i * 3 + 1], z = L.Q[i * 3 + 2];
        const d = nx * x + ny * y + nz * z;
        x -= nx * d; y -= ny * d; z -= nz * d;
        const len = Math.hypot(x, y, z);
        if (len > 1e-30) { x /= len; y /= len; z /= len; } else { tangents(nx, ny, nz, T6); x = T6[0]; y = T6[1]; z = T6[2]; }
        F.Q[c * 3] = x; F.Q[c * 3 + 1] = y; F.Q[c * 3 + 2] = z;
      }
    }
  }
}

// Solves the position field (the direction field stays), from a fresh random start at the coarsest level.
function resolvePositions(levels, seed, progress = null) {
  const rand = random(seed ^ 0x5bd1e995), top = levels[levels.length - 1], T6 = new Float64Array(6);
  const total = levels.reduce((sum, L) => sum + L.n, 0);
  let done = 0;
  for (let i = 0; i < top.n; i++) {
    tangents(top.N[i * 3], top.N[i * 3 + 1], top.N[i * 3 + 2], T6);
    const x = rand() * 2 - 1, y = rand() * 2 - 1;
    for (let d = 0; d < 3; d++) top.O[i * 3 + d] = top.V[i * 3 + d] + (T6[d] * x + T6[3 + d] * y) * top.S[i];
  }
  for (let l = levels.length - 1; l >= 0; l--) {
    const L = levels[l];
    optimizePositions(L, 6);
    done += L.n;
    if (progress) progress('position', done / total);
    if (l === 0) break;
    const F = levels[l - 1];
    for (let i = 0; i < L.n; i++) {
      for (let h = 0; h < 2; h++) {
        const c = L.up[i * 2 + h];
        if (c < 0) continue;
        const nx = F.N[c * 3], ny = F.N[c * 3 + 1], nz = F.N[c * 3 + 2];
        const x = L.O[i * 3], y = L.O[i * 3 + 1], z = L.O[i * 3 + 2];
        const d = nx * (x - F.V[c * 3]) + ny * (y - F.V[c * 3 + 1]) + nz * (z - F.V[c * 3 + 2]);
        F.O[c * 3] = x - nx * d; F.O[c * 3 + 1] = y - ny * d; F.O[c * 3 + 2] = z - nz * d;
      }
    }
  }
}

// ---------- extraction ----------

// The output vertices and edges the fields describe (Instant Meshes' extract_graph): input vertices on the same grid
// corner are merged, and those one grid step apart are joined.
function extractGraph(L) {
  const { n, start, id, N, V, Q, O, SU, SV } = L;
  const Cw = L.Cw;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const nbr = new Array(n);
  for (let i = 0; i < n; i++) nbr[i] = [];
  let cc = 0, cap = n * 2;
  let ca = new Int32Array(cap), cb = new Int32Array(cap), ce = new Float64Array(cap);
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    for (let l = start[i]; l < start[i + 1]; l++) {
      const j = id[l];
      if (j < i) continue;
      const j3 = j * 3;
      compatOrient(Q, i3, N, i3, Q, j3, N, j3);
      let qix = R[0], qiy = R[1], qiz = R[2], qjx = R[3], qjy = R[4], qjz = R[5];
      // A quarter-turned representative swaps which step runs along it.
      const sui = RA[0] ? SV[i] : SU[i], svi = RA[0] ? SU[i] : SV[i], suj = RA[1] ? SV[j] : SU[j], svj = RA[1] ? SU[j] : SV[j];
      const li = Math.hypot(qix, qiy, qiz) || 1, lj = Math.hypot(qjx, qjy, qjz) || 1;
      qix /= li; qiy /= li; qiz /= li; qjx /= lj; qjy /= lj; qjz /= lj;
      compatPos(V[i3], V[i3 + 1], V[i3 + 2], N[i3], N[i3 + 1], N[i3 + 2], qix, qiy, qiz, O[i3], O[i3 + 1], O[i3 + 2], sui, svi,
        V[j3], V[j3 + 1], V[j3 + 2], N[j3], N[j3 + 1], N[j3 + 2], qjx, qjy, qjz, O[j3], O[j3 + 1], O[j3 + 2], suj, svj);
      const dx = Math.abs(I4[0] - I4[2]), dy = Math.abs(I4[1] - I4[3]);
      if (dx > 1 || dy > 1 || (dx === 1 && dy === 1)) continue;
      if (dx + dy === 0) {
        if (cc === cap) {
          cap *= 2;
          const a2 = new Int32Array(cap), b2 = new Int32Array(cap), e2 = new Float64Array(cap);
          a2.set(ca); b2.set(cb); e2.set(ce); ca = a2; cb = b2; ce = e2;
        }
        ca[cc] = i; cb[cc] = j; ce[cc] = P2[6]; cc++;
      } else {
        nbr[i].push(j);
        nbr[j].push(i);
      }
    }
  }
  // Merge along the collapsing links, closest agreement first, unless the two groups are already joined by an edge.
  const order = new Uint32Array(cc);
  for (let k = 0; k < cc; k++) order[k] = k;
  order.sort((x, y) => ce[x] - ce[y]);
  const collapses = new Int32Array(n), stamp = new Int32Array(n).fill(-1);
  let stampId = 0;
  for (let k = 0; k < cc; k++) {
    let a = find(ca[order[k]]), b = find(cb[order[k]]);
    if (a === b) continue;
    let joined = false;
    for (const x of nbr[a]) if (find(x) === b) { joined = true; break; }
    if (joined) continue;
    if (nbr[a].length < nbr[b].length) { const t = a; a = b; b = t; }
    parent[b] = a;
    stampId++;
    const merged = [];
    for (const list of [nbr[a], nbr[b]]) {
      for (const x of list) {
        const r = find(x);
        if (r === a || stamp[r] === stampId) continue;
        stamp[r] = stampId;
        merged.push(r);
      }
    }
    nbr[a] = merged;
    nbr[b] = [];
    collapses[a] += collapses[b] + 1;
  }
  // Output vertices: the groups that kept an edge.
  const vid = new Int32Array(n).fill(-1);
  let nv = 0, avg = 0;
  for (let i = 0; i < n; i++) if (parent[i] === i && nbr[i].length) { vid[i] = nv++; avg += collapses[i]; }
  avg /= Math.max(1, nv);
  const adj = new Array(nv), weight = new Float64Array(nv), removed = new Uint8Array(nv);
  const count = new Int32Array(nv);
  for (let i = 0; i < n; i++) {
    if (vid[i] < 0) continue;
    const v = vid[i], set = new Set();
    for (const x of nbr[i]) { const r = find(x); if (vid[r] >= 0 && r !== i) set.add(vid[r]); }
    adj[v] = [...set];
    count[v] = collapses[i];
  }
  // Groups that barely merged anything sit on grid corners that no input vertex really owns.
  for (let v = 0; v < nv; v++) {
    if (count[v] > avg / 10) continue;
    for (const u of adj[v]) { const a = adj[u], k = a.indexOf(v); if (k >= 0) a.splice(k, 1); }
    adj[v] = [];
    removed[v] = 1;
  }
  // Positions: the group's grid corners, weighted toward members whose corner is close to them (in grid steps along each
  // direction); a group's size is its members' shorter step.
  const P = new Float64Array(nv * 3), NN = new Float64Array(nv * 3), SS = new Float64Array(nv), fixed = new Uint8Array(nv);
  const rep = new Int32Array(nv).fill(-1), repD = new Float64Array(nv).fill(Infinity), members = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const v = vid[find(i)];
    if (v < 0 || removed[v]) continue;
    members[i] = v;
    const i3 = i * 3, s = Math.min(SU[i], SV[i]);
    const ex = O[i3] - V[i3], ey = O[i3 + 1] - V[i3 + 1], ez = O[i3 + 2] - V[i3 + 2], d2 = ex * ex + ey * ey + ez * ez;
    const ql = Math.hypot(Q[i3], Q[i3 + 1], Q[i3 + 2]) || 1, qx = Q[i3] / ql, qy = Q[i3 + 1] / ql, qz = Q[i3 + 2] / ql;
    const tx = N[i3 + 1] * qz - N[i3 + 2] * qy, ty = N[i3 + 2] * qx - N[i3] * qz, tz = N[i3] * qy - N[i3 + 1] * qx;
    const du = (ex * qx + ey * qy + ez * qz) / SU[i], dv = (ex * tx + ey * ty + ez * tz) / SV[i];
    const wt = Math.exp(-9 * (du * du + dv * dv));
    for (let d = 0; d < 3; d++) { P[v * 3 + d] += O[i3 + d] * wt; NN[v * 3 + d] += N[i3 + d] * wt; }
    SS[v] += s * wt;
    weight[v] += wt;
    if (Cw && Cw[i] > 0) fixed[v] = 1;
    if (d2 < repD[v]) { repD[v] = d2; rep[v] = i; }
  }
  for (let v = 0; v < nv; v++) {
    if (!(weight[v] > 0)) { removed[v] = 1; adj[v] = []; continue; }
    for (let d = 0; d < 3; d++) P[v * 3 + d] /= weight[v];
    SS[v] /= weight[v];
    const l = Math.hypot(NN[v * 3], NN[v * 3 + 1], NN[v * 3 + 2]) || 1;
    for (let d = 0; d < 3; d++) NN[v * 3 + d] /= l;
  }
  for (let v = 0; v < nv; v++) if (removed[v]) for (const u of adj[v]) { const a = adj[u], k = a.indexOf(v); if (k >= 0) a.splice(k, 1); }
  for (let v = 0; v < nv; v++) if (removed[v]) adj[v] = [];
  return { nv, P, N: NN, S: SS, adj, fixed, rep, members, removed };
}

const has = (list, x) => list.indexOf(x) >= 0;
const drop = (list, x) => { const k = list.indexOf(x); if (k >= 0) list.splice(k, 1); };

// Snaps vertices that sit on an edge into it and removes quad diagonals (Instant Meshes' step 5).
function cleanGraph(G) {
  const { P, N, S, adj, fixed } = G;
  const dist = (a, b) => Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
  for (let round = 0; round < 20; round++) {
    let changed = false;
    for (let inner = 0; inner < 20; inner++) {
      let changedInner = false;
      const cand = [];
      for (let i = 0; i < G.nv; i++) {
        for (const j of adj[i]) {
          for (const k of adj[j]) {
            if (k === i) continue;
            const a = dist(j, k), b = dist(i, j), c = dist(i, k);
            if (a > Math.max(b, c)) {
              const s = 0.5 * (a + b + c), h = (2 * Math.sqrt(Math.max(0, s * (s - a) * (s - b) * (s - c)))) / a;
              const thresh = 0.3 * (S[i] + S[j] + S[k]) / 3;
              if (h < thresh) cand.push([h, i, j, k]);
            }
          }
        }
      }
      cand.sort((x, y) => x[0] - y[0]);
      for (const [h0, i, j, k] of cand) {
        if (!has(adj[i], j) || !has(adj[j], k)) continue;
        const a = dist(j, k), b = dist(i, j), c = dist(i, k);
        const s = 0.5 * (a + b + c), h = (2 * Math.sqrt(Math.max(0, s * (s - a) * (s - b) * (s - c)))) / a;
        if (h !== h0) continue;
        const thresh = 0.3 * (S[i] + S[j] + S[k]) / 3;
        if (b < thresh || c < thresh) {
          const m = b < thresh ? j : k;
          for (let d = 0; d < 3; d++) { P[i * 3 + d] = (P[i * 3 + d] + P[m * 3 + d]) / 2; N[i * 3 + d] = (N[i * 3 + d] + N[m * 3 + d]) / 2; }
          const nl = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
          for (let d = 0; d < 3; d++) N[i * 3 + d] /= nl;
          const set = new Set(adj[i]);
          for (const u of adj[m]) {
            if (u === i) continue;
            set.add(u);
            const au = adj[u];
            for (let q = 0; q < au.length; q++) if (au[q] === m) au[q] = i;
            // A neighbour of both now lists i twice.
            const seen = new Set();
            adj[u] = au.filter(x => (seen.has(x) ? false : (seen.add(x), true)));
          }
          set.delete(i); set.delete(m);
          adj[m] = [];
          adj[i] = [...set];
          if (fixed[m]) fixed[i] = 1;
          G.removed[m] = 1;
        } else {
          for (let d = 0; d < 3; d++) { P[i * 3 + d] = (P[j * 3 + d] + P[k * 3 + d]) / 2; N[i * 3 + d] = N[j * 3 + d] + N[k * 3 + d]; }
          const nl = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
          for (let d = 0; d < 3; d++) N[i * 3 + d] /= nl;
          if (fixed[j] && fixed[k]) fixed[i] = 1;
          drop(adj[j], k); drop(adj[k], j);
          if (!has(adj[i], k)) { adj[i].push(k); adj[k].push(i); }
        }
        changed = changedInner = true;
      }
      if (!changedInner) break;
    }
    // Diagonals: an edge whose two ends share exactly two neighbours splits a quad into two triangles.
    const cand = [];
    for (let i = 0; i < G.nv; i++) {
      for (const j of adj[i]) {
        if (j < i) continue;
        let tris = 0, length = 0;
        for (const k of adj[i]) {
          if (k === j || !has(adj[j], k)) continue;
          tris++;
          length += dist(k, i) + dist(k, j);
        }
        if (tris === 2) {
          const expected = (length / 4) * Math.SQRT2, diag = dist(i, j);
          cand.push([Math.abs((diag - expected) / Math.min(diag, expected)), i, j]);
        }
      }
    }
    cand.sort((x, y) => x[0] - y[0]);
    for (const [, i, j] of cand) {
      let tris = 0;
      for (const k of adj[i]) if (k !== j && has(adj[j], k)) tris++;
      if (tris !== 2) continue;
      drop(adj[i], j); drop(adj[j], i);
      changed = true;
    }
    if (!changed) break;
  }
}

// Angle (degrees) at corner k of a polygon.
function cornerAngle(P, poly, k) {
  const n = poly.length, a = poly[(k + n - 1) % n], b = poly[k], c = poly[(k + 1) % n];
  const ux = P[a * 3] - P[b * 3], uy = P[a * 3 + 1] - P[b * 3 + 1], uz = P[a * 3 + 2] - P[b * 3 + 2];
  const vx = P[c * 3] - P[b * 3], vy = P[c * 3 + 1] - P[b * 3 + 1], vz = P[c * 3 + 2] - P[b * 3 + 2];
  const cos = (ux * vx + uy * vy + uz * vz) / ((Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz)) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}
// How far a quad's corners are from right angles.
function quadScore(P, q) {
  let s = 0;
  for (let k = 0; k < 4; k++) s += Math.abs(cornerAngle(P, q, k) - 90);
  return s;
}
// Splits a polygon with an even number of sides into quads without new vertices, choosing the split whose quads come
// closest to right angles overall (every split for up to ten sides; larger ones cut the best quad off first).
// taken(a, b): an edge that already exists elsewhere; a cut along it would give that edge a third face, so it costs
// more than any shape.
function evenToQuads(P, poly, taken = null) {
  if (poly.length <= 4) return { score: poly.length === 4 ? quadScore(P, poly) : 0, quads: [poly] };
  const cut = i => {
    const q = [0, 1, 2, 3].map(k => poly[(i + k) % poly.length]);
    return { q, score: quadScore(P, q) + (taken && taken(q[0], q[3]) ? 1000 : 0), rest: poly.filter((_, k) => k !== (i + 1) % poly.length && k !== (i + 2) % poly.length) };
  };
  if (poly.length > 10) {
    let best = null;
    for (let i = 0; i < poly.length; i++) { const c = cut(i); if (!best || c.score < best.score) best = c; }
    const rest = evenToQuads(P, best.rest, taken);
    return { score: best.score + rest.score, quads: [best.q, ...rest.quads] };
  }
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const c = cut(i), rest = evenToQuads(P, c.rest, taken), score = c.score + rest.score;
    if (!best || score < best.score) best = { score, quads: [c.q, ...rest.quads] };
  }
  return best;
}
// A pentagon as a quad and a triangle, whichever split leaves the better quad.
function pentagonSplit(P, poly, taken = null) {
  let best = Infinity, bi = 0;
  for (let i = 0; i < 5; i++) {
    const s = quadScore(P, [0, 1, 2, 3].map(k => poly[(i + k) % 5])) + (taken && taken(poly[i], poly[(i + 3) % 5]) ? 1000 : 0);
    if (s < best) { best = s; bi = i; }
  }
  return [[0, 1, 2, 3].map(k => poly[(bi + k) % 5]), [poly[(bi + 3) % 5], poly[(bi + 4) % 5], poly[bi]]];
}

// Faces from the graph: neighbours are sorted around each vertex, and faces are walked by always taking the next edge
// in that order (Instant Meshes' extract_faces). Quads first, then triangles, then larger faces, which are cut into
// quads while they have more than five sides. Returns polygons as arrays of vertex ids.
function extractFaces(G) {
  const { P, N, adj } = G, nv = G.nv, T6 = new Float64Array(6);
  for (let i = 0; i < nv; i++) {
    if (adj[i].length < 2) continue;
    tangents(N[i * 3], N[i * 3 + 1], N[i * 3 + 2], T6);
    const ang = new Map();
    for (const j of adj[i]) {
      const dx = P[j * 3] - P[i * 3], dy = P[j * 3 + 1] - P[i * 3 + 1], dz = P[j * 3 + 2] - P[i * 3 + 2];
      ang.set(j, Math.atan2(T6[3] * dx + T6[4] * dy + T6[5] * dz, T6[0] * dx + T6[1] * dy + T6[2] * dz));
    }
    adj[i].sort((a, b) => ang.get(b) - ang.get(a));
  }
  let used = adj.map(a => new Uint8Array(a.length));
  let links = adj, maxHole = 16;
  const faces = [];
  // Walks a face from the link start → links[start][startIdx]; target: its number of sides (0: any, up to 16).
  const walk = (start, startIdx, target) => {
    let cur = start, idx = startIdx;
    const path = [];
    for (;;) {
      if (used[cur][idx] || (target > 0 && path.length / 2 + 1 > target) || path.length > 2 * maxHole) return null;
      path.push(cur, idx);
      const next = links[cur][idx], rank = links[next].length;
      const back = links[next].indexOf(cur);
      if (back < 0 || rank === 1) return null;
      cur = next;
      idx = (back + 1) % rank;
      if (cur === start) {
        if (target > 0 && path.length / 2 !== target) return null;
        for (let k = 0; k < path.length; k += 2) used[path[k]][path[k + 1]] = 1;
        const poly = [];
        for (let k = 0; k < path.length; k += 2) poly.push(path[k]);
        return poly;
      }
    }
  };
  const taken = (a, b) => adj[a].includes(b);
  const fill = poly => {
    // Odd faces keep five sides (or three) for the all-quad pass; the rest become quads.
    while (poly.length > 5 && poly.length & 1) {
      let best = Infinity, bi = 0;
      for (let i = 0; i < poly.length; i++) {
        const s = quadScore(P, [0, 1, 2, 3].map(k => poly[(i + k) % poly.length])) + (taken(poly[i], poly[(i + 3) % poly.length]) ? 1000 : 0);
        if (s < best) { best = s; bi = i; }
      }
      faces.push([0, 1, 2, 3].map(k => poly[(bi + k) % poly.length]));
      poly = poly.filter((_, k) => k !== (bi + 1) % poly.length && k !== (bi + 2) % poly.length);
    }
    if (poly.length >= 6) {
      faces.push(...evenToQuads(P, poly, taken).quads);
      return;
    }
    if (poly.length >= 3) faces.push(poly);
  };
  for (const target of [4, 3, 5, 6, 7, 8]) {
    for (let i = 0; i < nv; i++) {
      for (let j = 0; j < adj[i].length; j++) {
        const poly = walk(i, j, target);
        if (poly) fill(poly);
      }
    }
  }
  const unuse = p => {
    for (let k = 0; k < p.length; k++) {
      const a = p[k], b = p[(k + 1) % p.length], j = adj[a].indexOf(b);
      if (j >= 0) used[a][j] = 0;
    }
  };
  // Pockets: where the edges fold back, the same corners are walked once from each side; neither face is real.
  {
    const seen = new Map();
    for (const p of faces) { const k = p.slice().sort((x, y) => x - y).join(','); seen.set(k, (seen.get(k) || 0) + 1); }
    for (let f = faces.length - 1; f >= 0; f--) {
      if (seen.get(faces[f].slice().sort((x, y) => x - y).join(',')) < 2) continue;
      unuse(faces[f]);
      faces.splice(f, 1);
    }
  }
  // Flaps: a face hanging off the surface by one edge (two or more of its corners belong to no other face) is dropped,
  // so the hole it covers gets filled properly.
  for (let round = 0; round < 3; round++) {
    const uses = new Int32Array(nv);
    for (const p of faces) for (const v of p) uses[v]++;
    let dropped = 0;
    for (let f = faces.length - 1; f >= 0; f--) {
      const p = faces[f];
      if (p.filter(v => uses[v] === 1).length < 2) continue;
      unuse(p);
      faces.splice(f, 1);
      dropped++;
    }
    if (!dropped) break;
  }
  const faceKeys = new Set(faces.map(p => p.slice().sort((x, y) => x - y).join(',')));
  // Holes: keep only the edges that a face uses on one side, and walk the loops they form; small ones are filled.
  const rimAdj = [], rimUsed = [];
  for (let i = 0; i < nv; i++) {
    const a = [], u = [];
    for (let j = 0; j < adj[i].length; j++) {
      const k = adj[i][j], back = adj[k].indexOf(i);
      if (back < 0 || used[i][j] === used[k][back]) continue;
      a.push(k);
      u.push(used[i][j]);
    }
    rimAdj.push(a);
    rimUsed.push(Uint8Array.from(u));
  }
  links = rimAdj;
  used = rimUsed;
  maxHole = 64;
  // Loops along real open borders (their vertices carry the border constraint) stay open; others are holes the grid
  // tore where the surface folds tighter than a grid step, and are closed.
  for (let i = 0; i < nv; i++) {
    for (let j = 0; j < links[i].length; j++) {
      if (used[i][j]) continue;
      const poly = walk(i, j, 0);
      if (!poly) continue;
      let fixedCount = 0;
      for (const v of poly) if (G.fixed[v]) fixedCount++;
      // A loop around one existing face is that face seen from behind, not a hole.
      if (faceKeys.has(poly.slice().sort((x, y) => x - y).join(','))) continue;
      if (poly.length <= 6 || fixedCount < poly.length / 2) fill(poly);
    }
  }
  return faces;
}

// ---------- all quads ----------

// Pairs each odd face (triangle, pentagon) with the nearest other odd face or an open border, and splits every edge
// that the paths between them cross an odd number of times; afterwards every face has an even number of sides and is
// cut into quads. Returns the new faces; P grows by the edge midpoints.
function evenFaces(faces, P, nv) {
  const F = faces.length;
  const half = new Map(); // directed edge a*nv+b -> face
  for (let f = 0; f < F; f++) {
    const p = faces[f];
    for (let k = 0; k < p.length; k++) half.set(p[k] * nv + p[(k + 1) % p.length], f);
  }
  // Undirected edges with their faces (the second is -1 on a border); an edge that more than two faces use is a wall.
  const edgeId = new Map(), eFace0 = [], eFace1 = [], eA = [], eB = [], eMany = [];
  const faceEdges = faces.map(() => []);
  for (let f = 0; f < F; f++) {
    const p = faces[f];
    for (let k = 0; k < p.length; k++) {
      const a = p[k], b = p[(k + 1) % p.length], key = a < b ? a * nv + b : b * nv + a;
      let e = edgeId.get(key);
      if (e === undefined) {
        e = eA.length;
        edgeId.set(key, e);
        eA.push(a); eB.push(b); eFace0.push(f); eFace1.push(-1); eMany.push(0);
      } else if (eFace1[e] < 0 && eFace0[e] !== f) eFace1[e] = f;
      else eMany[e] = 1;
      faceEdges[f].push(e);
    }
  }
  const E = eA.length, split = new Uint8Array(E);
  let odd = [];
  for (let f = 0; f < F; f++) if (faces[f].length & 1) odd.push(f);
  const unpaired = new Uint8Array(F);
  for (const f of odd) unpaired[f] = 1;
  const dist = new Int32Array(F), src = new Int32Array(F), via = new Int32Array(F), parent = new Int32Array(F);
  const toggleBack = f => { while (via[f] >= 0) { split[via[f]] ^= 1; f = parent[f]; } };
  for (let round = 0; round < 50 && odd.length; round++) {
    dist.fill(-1); via.fill(-1);
    const queue = new Int32Array(F);
    let qh = 0, qt = 0;
    for (const f of odd) { dist[f] = 0; src[f] = f; queue[qt++] = f; }
    const cand = [];
    while (qh < qt) {
      const f = queue[qh++];
      for (const e of faceEdges[f]) {
        if (eMany[e]) continue;
        const g = eFace0[e] === f ? eFace1[e] : eFace0[e];
        if (g === f) continue;
        if (g < 0) { cand.push([dist[f] + 1, src[f], -1, f, -1, e]); continue; }
        if (dist[g] < 0) { dist[g] = dist[f] + 1; src[g] = src[f]; via[g] = e; parent[g] = f; queue[qt++] = g; }
        else if (src[g] !== src[f] && src[f] < src[g]) cand.push([dist[f] + dist[g] + 1, src[f], src[g], f, g, e]);
      }
    }
    cand.sort((x, y) => x[0] - y[0]);
    let progress = false;
    for (const [, a, b, fa, fb, e] of cand) {
      if (!unpaired[a] || (b >= 0 && !unpaired[b])) continue;
      unpaired[a] = 0;
      if (b >= 0) unpaired[b] = 0;
      split[e] ^= 1;
      toggleBack(fa);
      if (fb >= 0) toggleBack(fb);
      progress = true;
    }
    odd = odd.filter(f => unpaired[f]);
    if (!progress) break;
  }
  const taken = (a, b) => a < nv && b < nv && edgeId.has(a < b ? a * nv + b : b * nv + a);
  // Split the chosen edges.
  const mid = new Int32Array(E).fill(-1);
  let n = nv;
  const extra = [];
  for (let e = 0; e < E; e++) {
    if (!split[e]) continue;
    mid[e] = n++;
    for (let d = 0; d < 3; d++) extra.push((P[eA[e] * 3 + d] + P[eB[e] * 3 + d]) / 2);
  }
  const P2x = new Float64Array(n * 3);
  P2x.set(P.subarray(0, nv * 3));
  P2x.set(extra, nv * 3);
  const out = [];
  for (let f = 0; f < F; f++) {
    const p = faces[f];
    const poly = [];
    for (let k = 0; k < p.length; k++) {
      poly.push(p[k]);
      const m = mid[faceEdges[f][k]];
      if (m >= 0) poly.push(m);
    }
    if (poly.length & 1) {
      // An odd face that found no partner: a pentagon becomes a quad and a triangle, a triangle stays.
      if (poly.length === 5) out.push(...pentagonSplit(P2x, poly, taken));
      else if (poly.length === 3) out.push(poly);
      else {
        const q = evenToQuads(P2x, poly.slice(0, poly.length - 1), taken).quads;
        out.push(...q, [poly[poly.length - 2], poly[poly.length - 1], poly[0]]);
      }
      continue;
    }
    out.push(...evenToQuads(P2x, poly, taken).quads);
  }
  const clean = removeDoublets(out, n);
  return { faces: clean.faces, positions: P2x, nv: n, unpaired: odd.length, doublets: clean.removed };
}

// Removes doublets: an inner vertex with only two edges, between two quads that share both, is dropped and the two
// quads become one.
function removeDoublets(faces, nv) {
  let removed = 0;
  for (let round = 0; round < 8; round++) {
    const at = Array.from({ length: nv }, () => []);
    faces.forEach((p, f) => { if (p) for (const v of p) at[v].push(f); });
    let changed = false;
    for (let v = 0; v < nv; v++) {
      const list = at[v];
      if (list.length !== 2) continue;
      const f1 = faces[list[0]], f2 = faces[list[1]];
      if (!f1 || !f2 || f1.length !== 4 || f2.length !== 4) continue;
      const r1 = f1.indexOf(v), r2 = f2.indexOf(v);
      const a = f1[(r1 + 1) % 4], x = f1[(r1 + 2) % 4], b = f1[(r1 + 3) % 4];
      const c = f2[(r2 + 1) % 4], y = f2[(r2 + 2) % 4], d = f2[(r2 + 3) % 4];
      if (c !== b || d !== a || x === y) continue;
      // Both faces must still be current (an earlier merge this round may have used one).
      faces[list[0]] = [a, x, b, y];
      faces[list[1]] = null;
      for (const u of [a, x, b, y]) { const l = at[u]; if (!l.includes(list[0])) l.push(list[0]); }
      for (const u of [c, y, d]) { const l = at[u], k = l.indexOf(list[1]); if (k >= 0) l.splice(k, 1); }
      at[v] = [];
      removed++;
      changed = true;
    }
    if (!changed) break;
  }
  return { faces: faces.filter(Boolean), removed };
}

// Fewer poles: an inner edge between two quads can turn to join the other corners of the six-sided region they make,
// which moves one edge's worth of valence from its two ends to two other corners; and a quad whose opposite corners
// both have three edges while the other two have five can close up, merging the two three-edge corners. Either is
// taken when it lowers the sum of (valence - 4)² and the new quads stay convex (Tarini et al., "Practical quad mesh
// simplification", 2010, use the same moves). Faces touching an open border are left alone.
function optimizeValence(faces, P) {
  const nv = P.length / 3;
  const newell = q => {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < q.length; k++) {
      const a = q[k] * 3, b = q[(k + 1) % q.length] * 3;
      x += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
      y += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
      z += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
    }
    return [x, y, z];
  };
  // Convex, and facing the way of n, in the plane across n.
  const convex = (q, n) => {
    for (let k = 0; k < 4; k++) {
      const a = q[k] * 3, b = q[(k + 1) % 4] * 3, c = q[(k + 2) % 4] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[b], vy = P[c + 1] - P[b + 1], vz = P[c + 2] - P[b + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const cl = Math.hypot(cx, cy, cz), ul = Math.hypot(ux, uy, uz), vl = Math.hypot(vx, vy, vz);
      // Turning the right way, by at least a few degrees.
      if ((cx * n[0] + cy * n[1] + cz * n[2]) <= 0.08 * ul * vl * Math.hypot(n[0], n[1], n[2]) || cl === 0) return false;
    }
    return true;
  };
  let moves = 0;
  for (let sweep = 0; sweep < 12; sweep++) {
    const nbr = Array.from({ length: nv }, () => new Set()), edgeFaces = new Map();
    faces.forEach((q, f) => {
      if (!q) return;
      for (let k = 0; k < q.length; k++) {
        const a = q[k], b = q[(k + 1) % q.length], key = a < b ? a * nv + b : b * nv + a;
        nbr[a].add(b); nbr[b].add(a);
        const l = edgeFaces.get(key);
        if (l) l.push(f); else edgeFaces.set(key, [f]);
      }
    });
    const border = new Uint8Array(nv);
    for (const [key, l] of edgeFaces) if (l.length !== 2) { const a = Math.floor(key / nv); border[a] = border[key - a * nv] = 1; }
    const deg = v => nbr[v].size, E = d => (d - 4) * (d - 4);
    const touched = new Uint8Array(faces.length);
    let changed = 0;
    for (const [key, l] of edgeFaces) {
      if (l.length !== 2) continue;
      const [f1, f2] = l;
      if (touched[f1] || touched[f2]) continue;
      const q1 = faces[f1], q2 = faces[f2];
      if (!q1 || !q2 || q1.length !== 4 || q2.length !== 4) continue;
      const u0 = Math.floor(key / nv), v0 = key - u0 * nv;
      // Orient: q1 runs u -> v, q2 runs v -> u.
      let i1 = q1.indexOf(u0), u = u0, v = v0;
      if (q1[(i1 + 1) % 4] !== v0) { i1 = q1.indexOf(v0); u = v0; v = u0; }
      if (q1[(i1 + 1) % 4] !== v) continue;
      const i2 = q2.indexOf(v);
      if (q2[(i2 + 1) % 4] !== u) continue;
      const p = q1[(i1 + 2) % 4], q = q1[(i1 + 3) % 4], r = q2[(i2 + 2) % 4], s2 = q2[(i2 + 3) % 4];
      const hex = [u, r, s2, v, p, q];
      if (new Set(hex).size !== 6 || hex.some(x => border[x])) continue;
      const n = newell(q1), n2 = newell(q2);
      n[0] += n2[0]; n[1] += n2[1]; n[2] += n2[2];
      const before = E(deg(u)) + E(deg(v));
      let best = 0, pick = null;
      for (const [x, y, A, B] of [[r, p, [r, s2, v, p], [p, q, u, r]], [s2, q, [s2, v, p, q], [q, u, r, s2]]]) {
        if (nbr[x].has(y)) continue;
        const gain = before + E(deg(x)) + E(deg(y)) - (E(deg(u) - 1) + E(deg(v) - 1) + E(deg(x) + 1) + E(deg(y) + 1));
        if (gain > best && deg(u) > 3 && deg(v) > 3 && convex(A, n) && convex(B, n)) { best = gain; pick = [A, B]; }
      }
      if (!pick) continue;
      const [A] = pick, x = A[0], y = A[3];
      nbr[u].delete(v); nbr[v].delete(u); nbr[x].add(y); nbr[y].add(x);
      faces[f1] = pick[0];
      faces[f2] = pick[1];
      touched[f1] = touched[f2] = 1;
      changed++;
    }
    // Diagonal collapses: corners 3-5-3-5 around a quad, with the neighbourhood as it now stands.
    const at = Array.from({ length: nv }, () => []);
    faces.forEach((q, f) => { if (q) for (const x of q) at[x].push(f); });
    const done = new Uint8Array(faces.length);
    for (let f = 0; f < faces.length; f++) {
      const q = faces[f];
      if (!q || q.length !== 4 || done[f] || q.some(x => border[x])) continue;
      for (const o of [0, 1]) {
        const a = q[o], b = q[o + 1], c = q[o + 2], d = q[(o + 3) % 4];
        if (deg(a) !== 3 || deg(c) !== 3 || deg(b) < 5 || deg(d) < 5) continue;
        const around = at[c].filter(g => g !== f && faces[g]);
        if (around.some(g => done[g]) || at[a].some(g => done[g])) continue;
        for (let k = 0; k < 3; k++) P[a * 3 + k] = (P[a * 3 + k] + P[c * 3 + k]) / 2;
        for (const g of around) { faces[g] = faces[g].map(x => (x === c ? a : x)); done[g] = 1; }
        for (const g of at[a]) done[g] = 1;
        faces[f] = null;
        done[f] = 1;
        changed++;
        break;
      }
    }
    moves += changed;
    if (!changed) break;
  }
  return { faces: faces.filter(Boolean), moves };
}

// Last repairs: a face that repeats another's corners, a third face on an edge and a face hanging by one edge are
// dropped, and the small holes that leaves are closed (with quads, and a triangle for an odd hole).
function repairFaces(faces, P, nv, keepOpen) {
  let list = faces.slice(), dropped = 0, filled = 0;
  const seen = new Set();
  list = list.filter(p => {
    const k = p.slice().sort((a, b) => a - b).join(',');
    if (seen.has(k)) { dropped++; return false; }
    seen.add(k);
    return true;
  });
  const edgeUse = new Map();
  list = list.filter(p => {
    const keys = p.map((a, k) => { const b = p[(k + 1) % p.length]; return a < b ? a * nv + b : b * nv + a; });
    if (keys.some(key => (edgeUse.get(key) || 0) >= 2)) { dropped++; return false; }
    for (const key of keys) edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
    return true;
  });
  for (let round = 0; round < 3; round++) {
    const uses = new Int32Array(nv);
    for (const p of list) for (const v of p) uses[v]++;
    const before = list.length;
    list = list.filter(p => p.filter(v => uses[v] === 1).length < 2);
    dropped += before - list.length;
    if (list.length === before) break;
  }
  {
    // Holes: loops of half-edges no face uses the other way, away from real open borders. A loop runs against the
    // faces' direction, so it is walked from each unmatched half-edge a -> b back from b to a.
    const half = new Map();
    for (const p of list) for (let k = 0; k < p.length; k++) half.set(p[k] * nv + p[(k + 1) % p.length], 1);
    const next = new Map();
    for (const p of list) {
      for (let k = 0; k < p.length; k++) {
        const a = p[k], b = p[(k + 1) % p.length];
        if (half.has(b * nv + a)) continue;
        const l = next.get(b);
        if (l) l.push(a); else next.set(b, [a]);
      }
    }
    const usedHalf = new Set();
    const taken = (a, b) => half.has(a * nv + b) || half.has(b * nv + a);
    for (const start of next.keys()) {
      for (const first of next.get(start)) {
        if (usedHalf.has(start * nv + first)) continue;
        const loop = [start];
        const steps = [start * nv + first];
        let v = first, prev = start, closed = false;
        while (loop.length < 32) {
          if (v === start) { closed = true; break; }
          loop.push(v);
          const options = (next.get(v) || []).filter(x => !usedHalf.has(v * nv + x) && !steps.includes(v * nv + x));
          if (!options.length) break;
          // At a vertex two holes share, keep to the one that closes this loop (prefer the start).
          const w = options.includes(start) ? start : options[0];
          steps.push(v * nv + w);
          prev = v;
          v = w;
        }
        if (!closed || loop.length < 3 || loop.every(x => keepOpen(x))) continue;
        for (const st of steps) usedHalf.add(st);
        if (loop.length & 1) {
          const q = loop.length > 3 ? evenToQuads(P, loop.slice(0, loop.length - 1), taken).quads : [];
          list.push(...q, loop.length > 3 ? [loop[loop.length - 2], loop[loop.length - 1], loop[0]] : loop);
        } else list.push(...evenToQuads(P, loop, taken).quads);
        filled++;
      }
    }
  }
  return { faces: list, dropped, filled };
}

// ---------- surface lookup ----------

// Closest points on a triangle mesh, through a uniform grid of its triangles.
class SurfaceGrid {
  constructor(P, index, cell) {
    this.P = P; this.index = index;
    const T = index.length / 3;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < P.length; i += 3) {
      if (P[i] < x0) x0 = P[i]; if (P[i] > x1) x1 = P[i];
      if (P[i + 1] < y0) y0 = P[i + 1]; if (P[i + 1] > y1) y1 = P[i + 1];
      if (P[i + 2] < z0) z0 = P[i + 2]; if (P[i + 2] > z1) z1 = P[i + 2];
    }
    let h = cell;
    const dims = () => [Math.max(1, Math.ceil((x1 - x0) / h)), Math.max(1, Math.ceil((y1 - y0) / h)), Math.max(1, Math.ceil((z1 - z0) / h))];
    let [nx, ny, nz] = dims();
    while (nx * ny * nz > 4e6) { h *= 1.5; [nx, ny, nz] = dims(); }
    Object.assign(this, { x0, y0, z0, h, nx, ny, nz });
    const count = new Int32Array(nx * ny * nz + 1);
    const range = (t, fn) => {
      const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3;
      const i0 = this.cx(Math.min(P[a], P[b], P[c])), i1 = this.cx(Math.max(P[a], P[b], P[c]));
      const j0 = this.cy(Math.min(P[a + 1], P[b + 1], P[c + 1])), j1 = this.cy(Math.max(P[a + 1], P[b + 1], P[c + 1]));
      const k0 = this.cz(Math.min(P[a + 2], P[b + 2], P[c + 2])), k1 = this.cz(Math.max(P[a + 2], P[b + 2], P[c + 2]));
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn((k * ny + j) * nx + i);
    };
    for (let t = 0; t < T; t++) range(t, c => { count[c + 1]++; });
    for (let c = 0; c < nx * ny * nz; c++) count[c + 1] += count[c];
    const items = new Int32Array(count[nx * ny * nz]), fill = count.slice(0, nx * ny * nz);
    for (let t = 0; t < T; t++) range(t, c => { items[fill[c]++] = t; });
    this.start = count; this.items = items;
    this.seen = new Int32Array(T).fill(-1); this.query = 0;
    this.out = { t: -1, u: 0, v: 0, w: 0, x: 0, y: 0, z: 0, d2: Infinity };
  }
  cx(x) { return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.h))); }
  cy(y) { return Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.y0) / this.h))); }
  cz(z) { return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.z0) / this.h))); }
  // Closest point to (px, py, pz); sets this.out { t, u, v, w (barycentric of the triangle's corners), x, y, z, d2 }.
  closest(px, py, pz) {
    const o = this.out, q = ++this.query;
    o.t = -1; o.d2 = Infinity;
    const ci = this.cx(px), cj = this.cy(py), ck = this.cz(pz), h = this.h;
    // Distance from the point to the nearest face of its own cell.
    const fx = px - this.x0 - ci * h, fy = py - this.y0 - cj * h, fz = pz - this.z0 - ck * h;
    const inCell = Math.max(0, Math.min(fx, h - fx, fy, h - fy, fz, h - fz));
    const maxR = Math.max(this.nx, this.ny, this.nz);
    for (let r = 0; r <= maxR; r++) {
      // Rings 0..r-1 cover everything within (r - 1) cells plus the point's own margin.
      if (o.t >= 0 && r > 0 && ((r - 1) * h + inCell) ** 2 >= o.d2) break;
      for (let k = ck - r; k <= ck + r; k++) {
        if (k < 0 || k >= this.nz) continue;
        for (let j = cj - r; j <= cj + r; j++) {
          if (j < 0 || j >= this.ny) continue;
          if (Math.abs(k - ck) === r || Math.abs(j - cj) === r) {
            for (let i = Math.max(0, ci - r); i <= Math.min(this.nx - 1, ci + r); i++) this.visit((k * this.ny + j) * this.nx + i, px, py, pz, q);
          } else {
            if (ci - r >= 0) this.visit((k * this.ny + j) * this.nx + ci - r, px, py, pz, q);
            if (r > 0 && ci + r < this.nx) this.visit((k * this.ny + j) * this.nx + ci + r, px, py, pz, q);
          }
        }
      }
    }
    return o;
  }
  visit(c, px, py, pz, q) {
    const o = this.out, P = this.P, idx = this.index;
    for (let s = this.start[c]; s < this.start[c + 1]; s++) {
      const t = this.items[s];
      if (this.seen[t] === q) continue;
      this.seen[t] = q;
      closestOnTriangle(px, py, pz, P, idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
      if (CP[3] < o.d2) { o.d2 = CP[3]; o.t = t; o.x = CP[0]; o.y = CP[1]; o.z = CP[2]; o.u = CP[4]; o.v = CP[5]; o.w = CP[6]; }
    }
  }
}

// Scratch result of closestOnTriangle: point [0..2], squared distance [3], barycentric weights of a, b, c [4..6].
const CP = new Float64Array(7);
// Closest point on triangle (a, b, c) to p (Ericson, Real-Time Collision Detection 5.1.5).
function closestOnTriangle(px, py, pz, P, ia, ib, ic) {
  const ax = P[ia * 3], ay = P[ia * 3 + 1], az = P[ia * 3 + 2];
  const abx = P[ib * 3] - ax, aby = P[ib * 3 + 1] - ay, abz = P[ib * 3 + 2] - az;
  const acx = P[ic * 3] - ax, acy = P[ic * 3 + 1] - ay, acz = P[ic * 3 + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let u, v, w;
  if (d1 <= 0 && d2 <= 0) { u = 1; v = 0; w = 0; }
  else {
    const bpx = px - P[ib * 3], bpy = py - P[ib * 3 + 1], bpz = pz - P[ib * 3 + 2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { u = 0; v = 1; w = 0; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); u = 1 - t; v = t; w = 0; }
      else {
        const cpx = px - P[ic * 3], cpy = py - P[ic * 3 + 1], cpz = pz - P[ic * 3 + 2];
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { u = 0; v = 0; w = 1; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); u = 1 - t; v = 0; w = t; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const t = (d4 - d3) / (d4 - d3 + (d5 - d6)); u = 0; v = 1 - t; w = t; }
            else {
              const den = 1 / (va + vb + vc || 1e-300);
              v = vb * den; w = vc * den; u = 1 - v - w;
            }
          }
        }
      }
    }
  }
  const x = ax + abx * v + acx * w, y = ay + aby * v + acy * w, z = az + abz * v + acz * w;
  CP[0] = x; CP[1] = y; CP[2] = z;
  CP[3] = (x - px) * (x - px) + (y - py) * (y - py) + (z - pz) * (z - pz);
  CP[4] = u; CP[5] = v; CP[6] = w;
}

// ---------- working surface by clustering ----------

// Vertices of a dense surface merged on a grid whose cell follows the local grid size, for a working surface of even
// density. Within a cell, vertices join only while their normals stay within 75° of the group's, so the two sides of a
// thin part stay apart. cellOf(v): the cell size at source vertex v. Returns the clusters (position: the member nearest
// their mean, normal and area: sums over members), triangles between them, and the cluster of each source vertex.
function clusterSurface(P, index, N, A, cellOf) {
  const V = P.length / 3;
  const cls = new Int32Array(V), kx = new Int32Array(V), ky = new Int32Array(V), kz = new Int32Array(V);
  for (let v = 0; v < V; v++) {
    const c = Math.round(2 * Math.log2(cellOf(v))), h = 2 ** (c / 2);
    cls[v] = c;
    kx[v] = Math.floor(P[v * 3] / h); ky[v] = Math.floor(P[v * 3 + 1] / h); kz[v] = Math.floor(P[v * 3 + 2] / h);
  }
  let cap = 16;
  while (cap < V * 2) cap <<= 1;
  const table = new Int32Array(cap).fill(-1), mask = cap - 1;
  const cellOfV = new Int32Array(V);
  let cells = 0;
  const cellRep = [];
  for (let v = 0; v < V; v++) {
    let h = (Math.imul(kx[v], 73856093) ^ Math.imul(ky[v], 19349663) ^ Math.imul(kz[v], 83492791) ^ Math.imul(cls[v], 2654435761)) & mask;
    for (;;) {
      const r = table[h];
      if (r < 0) { table[h] = v; cellOfV[v] = cells++; cellRep.push(v); break; }
      if (kx[r] === kx[v] && ky[r] === ky[v] && kz[r] === kz[v] && cls[r] === cls[v]) { cellOfV[v] = cellOfV[r]; break; }
      h = (h + 1) & mask;
    }
  }
  const head = new Int32Array(cells).fill(-1), next = [], sum = [], of = new Int32Array(V).fill(-1);
  const cos75 = Math.cos((75 * Math.PI) / 180);
  let C = 0;
  for (let v = 0; v < V; v++) {
    if (!(A[v] > 0)) continue;
    const c = cellOfV[v], nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
    let found = -1;
    for (let k = head[c]; k >= 0; k = next[k]) {
      const sx = sum[k * 3], sy = sum[k * 3 + 1], sz = sum[k * 3 + 2], l = Math.hypot(sx, sy, sz);
      if (l === 0 || (sx * nx + sy * ny + sz * nz) / l >= cos75) { found = k; break; }
    }
    if (found < 0) { found = C++; next.push(head[c]); head[c] = found; sum.push(0, 0, 0); }
    sum[found * 3] += nx * A[v]; sum[found * 3 + 1] += ny * A[v]; sum[found * 3 + 2] += nz * A[v];
    of[v] = found;
  }
  const mean = new Float64Array(C * 3), area = new Float64Array(C), rep = new Int32Array(C).fill(-1), repD = new Float64Array(C).fill(Infinity);
  for (let v = 0; v < V; v++) {
    const k = of[v];
    if (k < 0) continue;
    for (let d = 0; d < 3; d++) mean[k * 3 + d] += P[v * 3 + d] * A[v];
    area[k] += A[v];
  }
  for (let k = 0; k < C; k++) for (let d = 0; d < 3; d++) mean[k * 3 + d] /= area[k];
  for (let v = 0; v < V; v++) {
    const k = of[v];
    if (k < 0) continue;
    const d2 = (P[v * 3] - mean[k * 3]) ** 2 + (P[v * 3 + 1] - mean[k * 3 + 1]) ** 2 + (P[v * 3 + 2] - mean[k * 3 + 2]) ** 2;
    if (d2 < repD[k]) { repD[k] = d2; rep[k] = v; }
  }
  const positions = new Float64Array(C * 3), normals = new Float64Array(C * 3);
  for (let k = 0; k < C; k++) {
    for (let d = 0; d < 3; d++) positions[k * 3 + d] = P[rep[k] * 3 + d];
    const l = Math.hypot(sum[k * 3], sum[k * 3 + 1], sum[k * 3 + 2]) || 1;
    for (let d = 0; d < 3; d++) normals[k * 3 + d] = sum[k * 3 + d] / l;
  }
  const tris = [];
  for (let t = 0; t < index.length; t += 3) {
    const a = of[index[t]], b = of[index[t + 1]], c = of[index[t + 2]];
    if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue;
    tris.push(a, b, c);
  }
  // The same triangle often comes out many times; keep one of each.
  let out = Uint32Array.from(tris);
  if (C < 200000) {
    const T = out.length / 3, key = new Float64Array(T);
    for (let t = 0; t < T; t++) {
      let a = out[t * 3], b = out[t * 3 + 1], c = out[t * 3 + 2], x;
      if (a > b) { x = a; a = b; b = x; } if (b > c) { x = b; b = c; c = x; } if (a > b) { x = a; a = b; b = x; }
      key[t] = (a * C + b) * C + c;
    }
    const order = new Uint32Array(T);
    for (let t = 0; t < T; t++) order[t] = t;
    order.sort((x, y) => key[x] - key[y]);
    const keep = [];
    for (let i = 0; i < T; i++) if (i === 0 || key[order[i]] !== key[order[i - 1]]) keep.push(order[i]);
    keep.sort((x, y) => x - y);
    const dedup = new Uint32Array(keep.length * 3);
    keep.forEach((t, i) => { dedup[i * 3] = out[t * 3]; dedup[i * 3 + 1] = out[t * 3 + 1]; dedup[i * 3 + 2] = out[t * 3 + 2]; });
    out = dedup;
  }
  return { positions, normals, area, index: out, of, rep, count: C };
}

// Area-weighted vertex normals and a third of each triangle's area per vertex.
function normalsAndAreas(P, index) {
  const V = P.length / 3, N = new Float64Array(V * 3), A = new Float64Array(V);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, ar = Math.hypot(nx, ny, nz) / 2;
    for (const v of [index[t], index[t + 1], index[t + 2]]) {
      N[v * 3] += nx; N[v * 3 + 1] += ny; N[v * 3 + 2] += nz;
      A[v] += ar / 3;
    }
  }
  for (let v = 0; v < V; v++) {
    const l = Math.hypot(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
    if (l > 0) for (let d = 0; d < 3; d++) N[v * 3 + d] /= l;
    else N[v * 3 + 2] = 1;
  }
  return { N, A };
}

// The working surface for the fields: a dense input clustered to about two and a half vertices per (shortest) grid
// step, and edges still longer than 0.7 of a step along their direction split so the grid can't step over a vertex;
// then its normals (smoothed a little, keeping sharp edges), metric (Msrc, per source vertex), the open borders as
// constraints, and the hierarchy. scale: the grid scale the metric is read with.
function buildWorking(srcP, srcIdx, srcN, srcA, sizeAt, cellFactor, splitFactor, opt, V0, mark, progress, Msrc, scale) {
  let weighted = 0;
  for (let v = 0; v < V0; v++) { const s = sizeAt(v); weighted += srcA[v] / (s * s); }
  const expected = cellFactor * cellFactor * weighted;
  let wP, wN, wA, wIdx, wOf = null, wRep = null;
  if (V0 > expected * 1.5) {
    const cl = clusterSurface(srcP, srcIdx, srcN, srcA, v => sizeAt(v) / cellFactor);
    wP = cl.positions; wN = cl.normals; wA = cl.area; wIdx = cl.index; wOf = cl.of; wRep = cl.rep;
  } else {
    wP = Float64Array.from(srcP); wN = Float64Array.from(srcN); wA = srcA; wIdx = srcIdx;
    wRep = new Int32Array(V0); wOf = new Int32Array(V0);
    for (let v = 0; v < V0; v++) wRep[v] = wOf[v] = v;
  }
  const nC = wP.length / 3;
  const cSize = new Float64Array(nC);
  for (let k = 0; k < nC; k++) cSize[k] = sizeAt(wRep[k]);
  mark('cluster');
  const cMet = new Float64Array(nC * 6);
  for (let k = 0; k < nC; k++) for (let d = 0; d < 6; d++) cMet[k * 6 + d] = Msrc[wRep[k] * 6 + d];
  const sub = splitLongEdges(wP, wIdx, cSize, splitFactor, 6, cMet, scale);
  const n = sub.positions.length / 3, WI = sub.index;
  const L0 = { n, V: sub.positions, N: new Float64Array(n * 3), A: new Float64Array(n), S: new Float64Array(n), ...adjacency(n, ...edgeArgs(WI, n)) };
  // A split vertex takes the mean normal of its two parents.
  L0.N.set(wN.subarray(0, nC * 3));
  L0.S.set(sub.size);
  L0.M = sub.metric;
  for (let k = 0; k < nC; k++) L0.A[k] = wA[k];
  for (let v = nC; v < n; v++) {
    const a = sub.parentA[v], b = sub.parentB[v];
    const x = L0.N[a * 3] + L0.N[b * 3], y = L0.N[a * 3 + 1] + L0.N[b * 3 + 1], z = L0.N[a * 3 + 2] + L0.N[b * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    L0.N[v * 3] = x / l; L0.N[v * 3 + 1] = y / l; L0.N[v * 3 + 2] = z / l;
  }
  // Areas of split vertices: a third of their triangles' areas, which also rescales the parents' shares.
  {
    const Ar = new Float64Array(n), Pw = sub.positions;
    for (let t = 0; t < WI.length; t += 3) {
      const a = WI[t] * 3, b = WI[t + 1] * 3, c = WI[t + 2] * 3;
      const ux = Pw[b] - Pw[a], uy = Pw[b + 1] - Pw[a + 1], uz = Pw[b + 2] - Pw[a + 2];
      const vx = Pw[c] - Pw[a], vy = Pw[c + 1] - Pw[a + 1], vz = Pw[c + 2] - Pw[a + 2];
      const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 6;
      Ar[WI[t]] += ar; Ar[WI[t + 1]] += ar; Ar[WI[t + 2]] += ar;
    }
    if (n > nC) for (let v = 0; v < n; v++) L0.A[v] = Ar[v] > 0 ? Ar[v] : L0.A[v] || 1e-12;
  }
  mark('split');
  if (progress) progress('prepare', 0.5);

  // Open borders of the input (and the mirror plane's cut) are constraints: edges run along them and the grid passes
  // through them.
  L0.CQ = new Float64Array(n * 3); L0.CO = new Float64Array(n * 3); L0.Cw = new Float32Array(n);
  let borderEdges = 0;
  if (opt.boundary !== false) {
    const SE = edgesOf(srcIdx, V0);
    for (let e = 0; e < SE.n; e++) {
      if (SE.count[e] !== 1) continue;
      const a = wOf[SE.a[e]], b = wOf[SE.b[e]];
      if (a < 0 || b < 0 || a === b) continue;
      const Pw = sub.positions;
      let dx = srcP[SE.b[e] * 3] - srcP[SE.a[e] * 3], dy = srcP[SE.b[e] * 3 + 1] - srcP[SE.a[e] * 3 + 1], dz = srcP[SE.b[e] * 3 + 2] - srcP[SE.a[e] * 3 + 2];
      const l = Math.hypot(dx, dy, dz);
      if (!(l > 0)) continue;
      dx /= l; dy /= l; dz /= l;
      for (const v of [a, b]) {
        L0.CO[v * 3] = Pw[v * 3]; L0.CO[v * 3 + 1] = Pw[v * 3 + 1]; L0.CO[v * 3 + 2] = Pw[v * 3 + 2];
        L0.CQ[v * 3] = dx; L0.CQ[v * 3 + 1] = dy; L0.CQ[v * 3 + 2] = dz;
        L0.Cw[v] = 1;
      }
      borderEdges++;
    }
  }
  // Smoother normals for the fields, so bumps smaller than a quad don't pull the directions around: each normal is
  // averaged with its neighbours', weighted down fast as they turn away, so sharp edges keep their crease.
  const creaseCos = Math.cos((60 * Math.PI) / 180);
  for (let it = 0; it < 10; it++) {
    const Nn = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const ax = L0.N[i * 3], ay = L0.N[i * 3 + 1], az = L0.N[i * 3 + 2];
      let x = ax * L0.A[i], y = ay * L0.A[i], z = az * L0.A[i];
      for (let l = L0.start[i]; l < L0.start[i + 1]; l++) {
        const j = L0.id[l], bx = L0.N[j * 3], by = L0.N[j * 3 + 1], bz = L0.N[j * 3 + 2];
        const u = (1 - (ax * bx + ay * by + az * bz)) / (1 - creaseCos), wt = L0.A[j] * Math.exp(-u * u);
        x += bx * wt; y += by * wt; z += bz * wt;
      }
      const len = Math.hypot(x, y, z) || 1;
      Nn[i * 3] = x / len; Nn[i * 3 + 1] = y / len; Nn[i * 3 + 2] = z / len;
    }
    L0.N.set(Nn);
  }
  const levels = buildHierarchy(L0);
  if (borderEdges) propagateConstraints(levels);
  mark('hierarchy');
  if (progress) progress('prepare', 1);
  return { levels, n, nC, WI };
}

// ---------- sharp edges ----------

// Sharp edges of the input: where neighbouring triangles turn by more than `angle` degrees. Short runs are surface
// noise and are dropped; only connected runs at least minLength(v) long count (averaged over the run's vertices, so
// runs where faces will be small may be short). Returns the kept edges as vertex pairs,
// normals where each crease vertex takes one side's normal (so the grid snaps to the crease rather than cutting it), and
// the corners where three or more kept edges meet.
function findCreases(P, index, N, angle, minLength) {
  const V = P.length / 3, T = index.length / 3, fn = new Float64Array(T * 3), fa = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.hypot(x, y, z);
    fa[t] = l / 2;
    if (l > 0) { fn[t * 3] = x / l; fn[t * 3 + 1] = y / l; fn[t * 3 + 2] = z / l; }
  }
  const start = new Int32Array(V + 1);
  for (let k = 0; k < index.length; k++) start[index[k] + 1]++;
  for (let v = 0; v < V; v++) start[v + 1] += start[v];
  const faces = new Int32Array(index.length), fill = start.slice(0, V);
  for (let k = 0; k < index.length; k++) faces[fill[index[k]]++] = (k / 3) | 0;
  const cosA = Math.cos((angle * Math.PI) / 180);
  const ea = [], eb = [];
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const a = index[t * 3 + k], b = index[t * 3 + ((k + 1) % 3)];
      for (let j = start[a]; j < start[a + 1]; j++) {
        const u = faces[j];
        if (u <= t || (index[u * 3] !== b && index[u * 3 + 1] !== b && index[u * 3 + 2] !== b)) continue;
        if (fa[t] > 0 && fa[u] > 0 && fn[t * 3] * fn[u * 3] + fn[t * 3 + 1] * fn[u * 3 + 1] + fn[t * 3 + 2] * fn[u * 3 + 2] < cosA) { ea.push(a); eb.push(b); }
      }
    }
  }
  // Runs: sharp edges joined at shared vertices; each keeps its total length.
  const parent = new Int32Array(V);
  for (let v = 0; v < V; v++) parent[v] = v;
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let e = 0; e < ea.length; e++) { const x = find(ea[e]), y = find(eb[e]); if (x !== y) parent[x] = y; }
  const length = new Map(), need = new Map(), count = new Map();
  const len = e => Math.hypot(P[ea[e] * 3] - P[eb[e] * 3], P[ea[e] * 3 + 1] - P[eb[e] * 3 + 1], P[ea[e] * 3 + 2] - P[eb[e] * 3 + 2]);
  for (let e = 0; e < ea.length; e++) {
    const r = find(ea[e]);
    length.set(r, (length.get(r) || 0) + len(e));
    need.set(r, (need.get(r) || 0) + minLength(ea[e]) + minLength(eb[e]));
    count.set(r, (count.get(r) || 0) + 2);
  }
  const segs = [], deg = new Uint8Array(V);
  for (let e = 0; e < ea.length; e++) {
    const r = find(ea[e]);
    if (length.get(r) < need.get(r) / count.get(r)) continue;
    segs.push(ea[e], eb[e]);
    deg[ea[e]] = Math.min(255, deg[ea[e]] + 1); deg[eb[e]] = Math.min(255, deg[eb[e]] + 1);
  }
  const out = Float64Array.from(N), corners = [];
  for (let v = 0; v < V; v++) {
    if (!deg[v]) continue;
    if (deg[v] >= 3) corners.push(v);
    let seed = -1, best = -1;
    for (let j = start[v]; j < start[v + 1]; j++) if (fa[faces[j]] > best) { best = fa[faces[j]]; seed = faces[j]; }
    let x = 0, y = 0, z = 0;
    for (let j = start[v]; j < start[v + 1]; j++) {
      const f = faces[j];
      if (fn[f * 3] * fn[seed * 3] + fn[f * 3 + 1] * fn[seed * 3 + 1] + fn[f * 3 + 2] * fn[seed * 3 + 2] < cosA) continue;
      x += fn[f * 3] * fa[f]; y += fn[f * 3 + 1] * fa[f]; z += fn[f * 3 + 2] * fa[f];
    }
    const l = Math.hypot(x, y, z);
    if (l > 0) { out[v * 3] = x / l; out[v * 3 + 1] = y / l; out[v * 3 + 2] = z / l; }
  }
  return { N: out, segs: Uint32Array.from(segs), corners: Int32Array.from(corners) };
}

// Nearest points on a set of segments, through a uniform grid.
class SegmentGrid {
  constructor(P, segs, cell) {
    this.P = P; this.segs = segs; this.h = cell;
    this.cells = new Map();
    for (let s = 0; s < segs.length / 2; s++) {
      const a = segs[s * 2] * 3, b = segs[s * 2 + 1] * 3;
      const lo = [0, 1, 2].map(k => Math.floor(Math.min(P[a + k], P[b + k]) / cell)), hi = [0, 1, 2].map(k => Math.floor(Math.max(P[a + k], P[b + k]) / cell));
      for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) {
        const key = `${i},${j},${k}`;
        const l = this.cells.get(key);
        if (l) l.push(s); else this.cells.set(key, [s]);
      }
    }
  }
  // The closest point within r of (x, y, z) on any segment: { x, y, z, d, seg } or null.
  nearest(x, y, z, r) {
    const P = this.P, h = this.h;
    let best = null, bd = r * r;
    const i0 = Math.floor((x - r) / h), i1 = Math.floor((x + r) / h), j0 = Math.floor((y - r) / h), j1 = Math.floor((y + r) / h);
    const k0 = Math.floor((z - r) / h), k1 = Math.floor((z + r) / h);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
      const list = this.cells.get(`${i},${j},${k}`);
      if (!list) continue;
      for (const s of list) {
        const a = this.segs[s * 2] * 3, b = this.segs[s * 2 + 1] * 3;
        const dx = P[b] - P[a], dy = P[b + 1] - P[a + 1], dz = P[b + 2] - P[a + 2], ll = dx * dx + dy * dy + dz * dz;
        let t = ll > 0 ? ((x - P[a]) * dx + (y - P[a + 1]) * dy + (z - P[a + 2]) * dz) / ll : 0;
        t = Math.max(0, Math.min(1, t));
        const px = P[a] + dx * t, py = P[a + 1] + dy * t, pz = P[a + 2] + dz * t;
        const d2 = (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
        if (d2 < bd) { bd = d2; best = { x: px, y: py, z: pz, d: Math.sqrt(d2), seg: s }; }
      }
    }
    return best;
  }
}

// ---------- following the shape ----------

// Faces per area each part of the surface needs for its shape, as a multiplier per source vertex. A flat face of edge h
// on a surface bending with curvature κ stands off it by about κh²/8, so an even error asks for faces per area in
// proportion to curvature. Curvature is read between neighbouring clusters on a grid of 0.4% of the model's size, whose
// averaged normals hide the noise of scans and generated meshes; it counts relative to its area-weighted median, is kept
// within [1/3, 12] of it, and is smoothed in log space so sizes change gradually (sudden changes cost poles). strength:
// 0 keeps faces even, 1 follows curvature fully. N and A (vertex normals and areas) are worked out when not given.
export function formDensity(P, index, N, A, strength) {
  const V = P.length / 3;
  if (!N || !A) ({ N, A } = normalsAndAreas(P, index));
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let v = 0; v < V; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const cell = 0.004 * (Math.hypot(x1 - x0, y1 - y0, z1 - z0) || 1);
  const cl = clusterSurface(P, index, N, A, () => cell), C = cl.count, CP = cl.positions, CN = cl.normals, CI = cl.index;
  // Neighbouring clusters, and the curvature across each pair: the angle between their normals over their distance.
  const kappa = new Float64Array(C), nbrs = Array.from({ length: C }, () => []);
  const seen = new Set();
  for (let t = 0; t < CI.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = CI[t + k], b = CI[t + ((k + 1) % 3)], key = a < b ? a * C + b : b * C + a;
      if (seen.has(key)) continue;
      seen.add(key);
      nbrs[a].push(b); nbrs[b].push(a);
      const d = Math.hypot(CP[a * 3] - CP[b * 3], CP[a * 3 + 1] - CP[b * 3 + 1], CP[a * 3 + 2] - CP[b * 3 + 2]);
      if (!(d > 0)) continue;
      const c = Math.max(-1, Math.min(1, CN[a * 3] * CN[b * 3] + CN[a * 3 + 1] * CN[b * 3 + 1] + CN[a * 3 + 2] * CN[b * 3 + 2]));
      const k2 = Math.acos(c) / d;
      if (k2 > kappa[a]) kappa[a] = k2;
      if (k2 > kappa[b]) kappa[b] = k2;
    }
  }
  // Relative to the area-weighted median curvature.
  const order = Array.from({ length: C }, (_, i) => i).sort((a, b) => kappa[a] - kappa[b]);
  let total = 0, acc = 0, median = 0;
  for (let i = 0; i < C; i++) total += cl.area[i];
  for (const i of order) { acc += cl.area[i]; if (acc >= total / 2) { median = kappa[i]; break; } }
  const lg = new Float64Array(C), tmp = new Float64Array(C);
  for (let i = 0; i < C; i++) lg[i] = Math.log(Math.min(12, Math.max(1 / 3, median > 0 ? kappa[i] / median : 1)));
  for (let pass = 0; pass < 5; pass++) {
    for (let i = 0; i < C; i++) {
      const nb = nbrs[i];
      if (!nb.length) { tmp[i] = lg[i]; continue; }
      let m = 0;
      for (const j of nb) m += lg[j];
      tmp[i] = 0.5 * lg[i] + (0.5 * m) / nb.length;
    }
    lg.set(tmp);
  }
  const out = new Float32Array(V).fill(1);
  for (let v = 0; v < V; v++) { const c = cl.of[v]; if (c >= 0) out[v] = Math.exp(strength * lg[c]); }
  return out;
}

// Curvature tensors from the normal cycle (David Cohen-Steiner and Jean-Marie Morvan, "Restricted Delaunay
// triangulations and normal cycle", 2003): each interior edge adds its signed dihedral angle × its length × ê⊗ê.
// Summed over a region and divided by its area this is the region's curvature tensor; being signed, bumps smaller
// than the region cancel, which keeps the noise of scans and generated meshes out. Half of each edge's term goes to
// each end (6 floats per vertex: xx xy xz yy yz zz); edges bending more than maxAngle are left out.
function vertexTensors(P, index, maxAngle) {
  const V = P.length / 3, T = index.length / 3, H = T * 3;
  const fn = new Float64Array(T * 3);
  for (let t = 0; t < T; t++) {
    const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.hypot(x, y, z);
    if (l > 0) { fn[t * 3] = x / l; fn[t * 3 + 1] = y / l; fn[t * 3 + 2] = z / l; }
  }
  // Half-edges bucketed by their lower vertex; the two halves of an interior edge share (lower, upper).
  const nxt = h => (h % 3 === 2 ? h - 2 : h + 1);
  const start = new Int32Array(V + 1);
  for (let h = 0; h < H; h++) start[Math.min(index[h], index[nxt(h)]) + 1]++;
  for (let v = 0; v < V; v++) start[v + 1] += start[v];
  const hi = new Int32Array(H), hid = new Int32Array(H), fill = start.slice(0, V);
  for (let h = 0; h < H; h++) { const a = index[h], b = index[nxt(h)], o = fill[Math.min(a, b)]++; hi[o] = Math.max(a, b); hid[o] = h; }
  const Tv = new Float64Array(V * 6);
  for (let v = 0; v < V; v++) {
    for (let i = start[v]; i < start[v + 1]; i++) {
      const w = hi[i];
      let j2 = -1, other = false;
      for (let j = start[v]; j < start[v + 1]; j++) {
        if (j === i || hi[j] !== w) continue;
        if (j < i || j2 >= 0) { other = true; break; }
        j2 = j;
      }
      // Border edges, edges of three or more faces, and each interior edge's second half are skipped.
      if (other || j2 < 0) continue;
      const h1 = hid[i], h2 = hid[j2], f1 = (h1 / 3) | 0, f2 = (h2 / 3) | 0;
      const u = index[h1], x = index[nxt(h1)];
      if (index[h2] !== x || index[nxt(h2)] !== u) continue;
      const c2 = index[nxt(nxt(h2))];
      let beta = Math.acos(Math.max(-1, Math.min(1, fn[f1 * 3] * fn[f2 * 3] + fn[f1 * 3 + 1] * fn[f2 * 3 + 1] + fn[f1 * 3 + 2] * fn[f2 * 3 + 2])));
      if (beta > maxAngle) continue;
      // Concave when the other face's far corner sits above this face.
      if (fn[f1 * 3] * (P[c2 * 3] - P[u * 3]) + fn[f1 * 3 + 1] * (P[c2 * 3 + 1] - P[u * 3 + 1]) + fn[f1 * 3 + 2] * (P[c2 * 3 + 2] - P[u * 3 + 2]) > 0) beta = -beta;
      const ex = P[x * 3] - P[u * 3], ey = P[x * 3 + 1] - P[u * 3 + 1], ez = P[x * 3 + 2] - P[u * 3 + 2], el = Math.hypot(ex, ey, ez);
      if (!(el > 0)) continue;
      const k = (0.5 * beta) / el;
      for (const o of [u * 6, x * 6]) {
        Tv[o] += k * ex * ex; Tv[o + 1] += k * ex * ey; Tv[o + 2] += k * ex * ez;
        Tv[o + 3] += k * ey * ey; Tv[o + 4] += k * ey * ez; Tv[o + 5] += k * ez * ez;
      }
    }
  }
  return Tv;
}

// A symmetric tensor (6 floats at Tm[o]) read in the tangent plane of the unit normal n: its eigenvalues there, the
// one of larger magnitude in out.big, and that one's eigenvector in out.ex, ey, ez. For a normal-cycle tensor that
// eigenvector runs along the direction that bends least (the principal directions come out swapped); for a metric it
// is the direction of the shortest edges.
function tangentEigen(Tm, o, nx, ny, nz, out) {
  let cx, cy, cz;
  if (Math.abs(nx) > Math.abs(ny)) { const l = 1 / Math.sqrt(nx * nx + nz * nz); cx = nz * l; cy = 0; cz = -nx * l; }
  else { const l = 1 / (Math.sqrt(ny * ny + nz * nz) || 1); cx = 0; cy = nz * l; cz = -ny * l; }
  const sx = cy * nz - cz * ny, sy = cz * nx - cx * nz, sz = cx * ny - cy * nx;
  const xx = Tm[o], xy = Tm[o + 1], xz = Tm[o + 2], yy = Tm[o + 3], yz = Tm[o + 4], zz = Tm[o + 5];
  const q = (ax, ay, az, bx, by, bz) => ax * (xx * bx + xy * by + xz * bz) + ay * (xy * bx + yy * by + yz * bz) + az * (xz * bx + yz * by + zz * bz);
  const a = q(sx, sy, sz, sx, sy, sz), b = q(sx, sy, sz, cx, cy, cz), d = q(cx, cy, cz, cx, cy, cz);
  const m = (a + d) / 2, r = Math.sqrt(((a - d) / 2) ** 2 + b * b), l1 = m + r, l2 = m - r;
  const phi = 0.5 * Math.atan2(2 * b, a - d), cp = Math.cos(phi), sp = Math.sin(phi);
  const e1x = cp * sx + sp * cx, e1y = cp * sy + sp * cy, e1z = cp * sz + sp * cz;
  if (Math.abs(l1) >= Math.abs(l2)) { out.big = l1; out.small = l2; out.ex = e1x; out.ey = e1y; out.ez = e1z; }
  else { out.big = l2; out.small = l1; out.ex = ny * e1z - nz * e1y; out.ey = nz * e1x - nx * e1z; out.ez = nx * e1y - ny * e1x; }
  return out;
}

// The surface's principal curvatures, per cluster: normal-cycle tensors (sharp edges past opt.sharp degrees left out,
// since they become edge loops) summed over clusters of opt.cell × the model's diagonal, plus half of each neighbouring
// cluster facing the same way. Returns the clusters, their neighbours (CSR) and, per cluster, the larger and smaller
// principal curvature (magnitudes) and the direction that bends least; worked out once per surface.
export function formAnalysis(P, index, N, A, opt = {}) {
  const V = P.length / 3;
  if (!N || !A) ({ N, A } = normalsAndAreas(P, index));
  const Tv = vertexTensors(P, index, opt.sharp > 0 ? (opt.sharp * Math.PI) / 180 : Math.PI);
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let v = 0; v < V; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const cell = (opt.cell ?? 0.003) * (Math.hypot(x1 - x0, y1 - y0, z1 - z0) || 1);
  const cl = clusterSurface(P, index, N, A, () => cell), C = cl.count, CN = cl.normals, CI = cl.index;
  const T0 = new Float64Array(C * 6);
  for (let v = 0; v < V; v++) { const c = cl.of[v]; if (c >= 0) for (let k = 0; k < 6; k++) T0[c * 6 + k] += Tv[v * 6 + k]; }
  const nstart = new Int32Array(C + 1);
  let nid;
  {
    const keys = new Float64Array(CI.length);
    let m = 0;
    for (let t = 0; t < CI.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = CI[t + k], b = CI[t + ((k + 1) % 3)];
      if (a !== b) keys[m++] = a < b ? a * C + b : b * C + a;
    }
    const sorted = keys.subarray(0, m).sort(), ea = [], eb = [];
    for (let i = 0; i < m; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) { const a = Math.floor(sorted[i] / C); ea.push(a); eb.push(sorted[i] - a * C); }
    for (let e = 0; e < ea.length; e++) { nstart[ea[e] + 1]++; nstart[eb[e] + 1]++; }
    for (let c = 0; c < C; c++) nstart[c + 1] += nstart[c];
    nid = new Int32Array(nstart[C]);
    const fillN = nstart.slice(0, C);
    for (let e = 0; e < ea.length; e++) { nid[fillN[ea[e]]++] = eb[e]; nid[fillN[eb[e]]++] = ea[e]; }
  }
  const T1 = Float64Array.from(T0), A1 = Float64Array.from(cl.area);
  for (let c = 0; c < C; c++) {
    for (let l = nstart[c]; l < nstart[c + 1]; l++) {
      const j = nid[l];
      if (CN[c * 3] * CN[j * 3] + CN[c * 3 + 1] * CN[j * 3 + 1] + CN[c * 3 + 2] * CN[j * 3 + 2] < 0.5) continue;
      for (let k = 0; k < 6; k++) T1[c * 6 + k] += 0.5 * T0[j * 6 + k];
      A1[c] += 0.5 * cl.area[j];
    }
  }
  const kb = new Float32Array(C), ks = new Float32Array(C), dir = new Float32Array(C * 3), E = {};
  for (let c = 0; c < C; c++) {
    for (let k = 0; k < 6; k++) T1[c * 6 + k] /= A1[c] || 1;
    tangentEigen(T1, c * 6, CN[c * 3], CN[c * 3 + 1], CN[c * 3 + 2], E);
    kb[c] = Math.abs(E.big); ks[c] = Math.abs(E.small);
    dir[c * 3] = E.ex; dir[c * 3 + 1] = E.ey; dir[c * 3 + 2] = E.ez;
  }
  let area = 0;
  for (let c = 0; c < C; c++) area += cl.area[c];
  return { cl, nstart, nid, kb, ks, dir, area, V };
}

// The largest metric inside both ellipses A and B (2×2 symmetric as a, b, d), by simultaneous reduction, into out;
// false when B asks for nothing A doesn't already give.
function intersect2(a1, b1, d1, a2, b2, d2, out) {
  const pa = a1 - a2, pb = b1 - b2, pd = d1 - d2;
  if (pa >= 0 && pd >= 0 && pa * pd - pb * pb >= -1e-12 * (a1 * d1 + 1e-30)) return false;
  const det = a1 * d1 - b1 * b1;
  if (!(det > 0)) { out[0] = a2; out[1] = b2; out[2] = d2; return true; }
  // N = A⁻¹B; its eigenvectors are A- and B-orthogonal.
  const ia = d1 / det, ib = -b1 / det, id = a1 / det;
  const n00 = ia * a2 + ib * b2, n01 = ia * b2 + ib * d2, n10 = ib * a2 + id * b2, n11 = ib * b2 + id * d2;
  const tr = n00 + n11, disc = (tr * tr) / 4 - (n00 * n11 - n01 * n10);
  if (disc <= 1e-14 * tr * tr) {
    const k = Math.max(1, tr / 2);
    out[0] = a1 * k; out[1] = b1 * k; out[2] = d1 * k;
    return true;
  }
  const r = Math.sqrt(disc);
  // From whichever row of N - λI gives the longer vector.
  const eig = l => { const ax = n01, ay = l - n00, bx = l - n11, by = n10; return ax * ax + ay * ay >= bx * bx + by * by ? [ax, ay] : [bx, by]; };
  const [v1x, v1y] = eig(tr / 2 + r), [v2x, v2y] = eig(tr / 2 - r);
  const q = (x, y, a, b, d) => a * x * x + 2 * b * x * y + d * y * y;
  const m1 = Math.max(q(v1x, v1y, a1, b1, d1), q(v1x, v1y, a2, b2, d2)), m2 = Math.max(q(v2x, v2y, a1, b1, d1), q(v2x, v2y, a2, b2, d2));
  const pdet = v1x * v2y - v2x * v1y;
  if (!(Math.abs(pdet) > 1e-30)) return false;
  // M = P⁻ᵀ diag(m1, m2) P⁻¹ with P = [v1 v2].
  const i00 = v2y / pdet, i01 = -v2x / pdet, i10 = -v1y / pdet, i11 = v1x / pdet;
  out[0] = m1 * i00 * i00 + m2 * i10 * i10;
  out[1] = m1 * i00 * i01 + m2 * i10 * i11;
  out[2] = m1 * i01 * i01 + m2 * i11 * i11;
  return true;
}

// The metric for about `target` faces (6 floats per source vertex, xx xy xz yy yz zz): an edge along unit u should be
// 1/√(u·M·u) long. A flat face with an edge h along a direction in which the surface bends by κ stands off it by about
// κh²/8, so an even error everywhere asks for edges h = c/√κ along each principal direction: short across the
// direction that bends most, long along the one that bends least (square faces spend √(κ1/κ2) times more, which on
// tubes, folds and limbs is several times), and faces per area in proportion to √(κ1κ2). Edges stay within
// [hMin, hMax] × the even size √(area / target) and the long one within alpha × the short one; strength blends from
// even squares (0) to that (1) in log space; c is found for the target. Then no edge length may grow by more than
// grade × the distance from a neighbour's, along each of the neighbour's directions (Frédéric Alauzet, "Size gradation
// control of anisotropic meshes", 2010): along a tube the long edges then stay even all around it, as a grid of
// closed loops needs, and sizes change slowly enough for the grid to follow. The result is scaled back to the target.
export function formSizes(an, target, strength, opt = {}) {
  const { cl, nstart, nid, kb, ks, dir, area, V } = an, C = cl.count, CN = cl.normals, CP = cl.positions;
  const hMin = opt.hMin ?? 0.15, hMax = opt.hMax ?? 2.5, alpha = opt.alpha ?? 4, grade = opt.grade ?? 0.3;
  const h0 = Math.sqrt(area / target);
  const h1 = new Float64Array(C), h2 = new Float64Array(C);
  const sizes = c => {
    for (let i = 0; i < C; i++) {
      let s1 = kb[i] > 0 ? c / Math.sqrt(kb[i]) : Infinity, s2 = ks[i] > 0 ? c / Math.sqrt(ks[i]) : Infinity;
      s1 = Math.min(hMax * h0, Math.max(hMin * h0, s1));
      s2 = Math.min(hMax * h0, Math.max(s1, Math.min(alpha * s1, s2)));
      h1[i] = h0 * (s1 / h0) ** strength; h2[i] = h0 * (s2 / h0) ** strength;
    }
  };
  // Bisection on log c: faces fall as c grows.
  let lo = -40, hi = 40;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    sizes(Math.exp(mid));
    let n = 0;
    for (let i = 0; i < C; i++) n += cl.area[i] / (h1[i] * h2[i]);
    if (n > target) lo = mid; else hi = mid;
  }
  sizes(Math.exp(hi));
  // Per cluster, the metric in its tangent basis (s, t from tangents()) as a, b, d.
  const M2 = new Float64Array(C * 3), basis = new Float64Array(C * 6);
  for (let i = 0; i < C; i++) {
    tangents(CN[i * 3], CN[i * 3 + 1], CN[i * 3 + 2], basis, i * 6);
    const u = dir[i * 3] * basis[i * 6] + dir[i * 3 + 1] * basis[i * 6 + 1] + dir[i * 3 + 2] * basis[i * 6 + 2];
    const w = dir[i * 3] * basis[i * 6 + 3] + dir[i * 3 + 1] * basis[i * 6 + 4] + dir[i * 3 + 2] * basis[i * 6 + 5];
    const ul = Math.hypot(u, w) || 1, cu = u / ul, cw = w / ul, mL = 1 / (h2[i] * h2[i]), mS = 1 / (h1[i] * h1[i]);
    M2[i * 3] = mL * cu * cu + mS * cw * cw;
    M2[i * 3 + 1] = (mL - mS) * cu * cw;
    M2[i * 3 + 2] = mL * cw * cw + mS * cu * cu;
  }
  const O3 = new Float64Array(3);
  for (let round = 0; grade > 0 && round < 2; round++) {
    for (let sweep = 0; sweep < 4; sweep++) {
      for (let k = 0; k < C; k++) {
        const i = sweep % 2 ? C - 1 - k : k, si = i * 6;
        for (let l = nstart[i]; l < nstart[i + 1]; l++) {
          const j = nid[l], sj = j * 6;
          if (CN[i * 3] * CN[j * 3] + CN[i * 3 + 1] * CN[j * 3 + 1] + CN[i * 3 + 2] * CN[j * 3 + 2] < 0.5) continue;
          // j's metric read in i's basis.
          const a = M2[j * 3], b = M2[j * 3 + 1], d = M2[j * 3 + 2];
          const us = basis[si] * basis[sj] + basis[si + 1] * basis[sj + 1] + basis[si + 2] * basis[sj + 2];
          const ut = basis[si] * basis[sj + 3] + basis[si + 1] * basis[sj + 4] + basis[si + 2] * basis[sj + 5];
          const vs = basis[si + 3] * basis[sj] + basis[si + 4] * basis[sj + 1] + basis[si + 5] * basis[sj + 2];
          const vt = basis[si + 3] * basis[sj + 3] + basis[si + 4] * basis[sj + 4] + basis[si + 5] * basis[sj + 5];
          let A2 = a * us * us + 2 * b * us * ut + d * ut * ut, B2 = a * us * vs + b * (us * vt + ut * vs) + d * ut * vt, D2 = a * vs * vs + 2 * b * vs * vt + d * vt * vt;
          // Each of its edge lengths grown by grade × the distance.
          const dist = Math.hypot(CP[i * 3] - CP[j * 3], CP[i * 3 + 1] - CP[j * 3 + 1], CP[i * 3 + 2] - CP[j * 3 + 2]);
          const m = (A2 + D2) / 2, r = Math.sqrt(((A2 - D2) / 2) ** 2 + B2 * B2), e1 = m + r, e2 = Math.max(1e-30, m - r);
          const phi = 0.5 * Math.atan2(2 * B2, A2 - D2), cp = Math.cos(phi), sp = Math.sin(phi);
          const g1 = e1 / (1 + grade * dist * Math.sqrt(e1)) ** 2, g2 = e2 / (1 + grade * dist * Math.sqrt(e2)) ** 2;
          A2 = g1 * cp * cp + g2 * sp * sp; B2 = (g1 - g2) * cp * sp; D2 = g1 * sp * sp + g2 * cp * cp;
          if (intersect2(M2[i * 3], M2[i * 3 + 1], M2[i * 3 + 2], A2, B2, D2, O3)) { M2[i * 3] = O3[0]; M2[i * 3 + 1] = O3[1]; M2[i * 3 + 2] = O3[2]; }
        }
      }
    }
    // Back to the target: faces per area is √det.
    let n = 0;
    for (let i = 0; i < C; i++) n += cl.area[i] * Math.sqrt(Math.max(0, M2[i * 3] * M2[i * 3 + 2] - M2[i * 3 + 1] ** 2));
    const f = target / n;
    for (let i = 0; i < C * 3; i++) M2[i] *= f;
  }
  // As 3D tensors (the normal gets the smaller value), per source vertex.
  const out = new Float32Array(V * 6), Mc = new Float64Array(C * 6);
  for (let i = 0; i < C; i++) {
    const a = M2[i * 3], b = M2[i * 3 + 1], d = M2[i * 3 + 2], o = i * 6;
    const S = [basis[o], basis[o + 1], basis[o + 2]], T = [basis[o + 3], basis[o + 4], basis[o + 5]], Nn = [CN[i * 3], CN[i * 3 + 1], CN[i * 3 + 2]];
    const mn = (a + d) / 2 - Math.sqrt(((a - d) / 2) ** 2 + b * b);
    const e = (p, q) => S[p] * (a * S[q] + b * T[q]) + T[p] * (b * S[q] + d * T[q]) + mn * Nn[p] * Nn[q];
    Mc[o] = e(0, 0); Mc[o + 1] = e(0, 1); Mc[o + 2] = e(0, 2); Mc[o + 3] = e(1, 1); Mc[o + 4] = e(1, 2); Mc[o + 5] = e(2, 2);
  }
  const iso = 1 / (h0 * h0);
  for (let v = 0; v < V; v++) {
    const k = cl.of[v];
    if (k < 0) { out[v * 6] = out[v * 6 + 3] = out[v * 6 + 5] = iso; continue; }
    for (let q = 0; q < 6; q++) out[v * 6 + q] = Mc[k * 6 + q];
  }
  return out;
}

// The grid step at each vertex of a level along its direction q (SU) and across it (SV), from the level's metric
// (q·M·q · SU² = scale²), and their geometric mean in S.
function levelSpacings(L, scale) {
  const { n, N, Q, M } = L;
  if (!L.SU || L.SU.length !== n) { L.SU = new Float64Array(n); L.SV = new Float64Array(n); }
  for (let i = 0; i < n; i++) {
    const i3 = i * 3, i6 = i * 6;
    const ql = Math.hypot(Q[i3], Q[i3 + 1], Q[i3 + 2]) || 1, qx = Q[i3] / ql, qy = Q[i3 + 1] / ql, qz = Q[i3 + 2] / ql;
    const nx = N[i3], ny = N[i3 + 1], nz = N[i3 + 2];
    const tx = ny * qz - nz * qy, ty = nz * qx - nx * qz, tz = nx * qy - ny * qx;
    const xx = M[i6], xy = M[i6 + 1], xz = M[i6 + 2], yy = M[i6 + 3], yz = M[i6 + 4], zz = M[i6 + 5];
    const mq = qx * (xx * qx + xy * qy + xz * qz) + qy * (xy * qx + yy * qy + yz * qz) + qz * (xz * qx + yz * qy + zz * qz);
    const mt = tx * (xx * tx + xy * ty + xz * tz) + ty * (xy * tx + yy * ty + yz * tz) + tz * (xz * tx + yz * ty + zz * tz);
    const su = scale / Math.sqrt(Math.max(1e-12, mq)), sv = scale / Math.sqrt(Math.max(1e-12, mt));
    L.SU[i] = su; L.SV[i] = sv; L.S[i] = Math.sqrt(su * sv);
  }
}

// Where the metric stretches faces, the direction field is pulled toward its long direction, with weight
// strength × (m1 - m2) / (m1 + m2); none where faces stay square.
function levelAlignment(L, strength) {
  const { n, N, M } = L, E = {};
  L.AQ = new Float64Array(n * 3); L.Aw = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    tangentEigen(M, i * 6, nx, ny, nz, E);
    const m1 = Math.abs(E.big), m2 = Math.abs(E.small), stretch = m1 + m2 > 0 ? (m1 - m2) / (m1 + m2) : 0;
    if (!(stretch > 1e-3)) continue;
    // E.e is the short direction; the long one is across it.
    L.AQ[i * 3] = ny * E.ez - nz * E.ey; L.AQ[i * 3 + 1] = nz * E.ex - nx * E.ez; L.AQ[i * 3 + 2] = nx * E.ey - ny * E.ex;
    L.Aw[i] = strength * stretch;
    any = true;
  }
  if (!any) { L.AQ = null; L.Aw = null; }
}

// ---------- the whole remesh ----------

// mesh: { positions, index, normals? } — the surface to remesh (no UV seams; parts may touch).
// opt: { targetFaces, density (per-vertex multiplier of faces per area, or null), adapt: how far face sizes and
//        directions follow the surface's curvature (0 even squares … 1, see formSizes), boundary: align open borders (true),
//        plane: { axis, offset } whose border is kept exactly on the plane, sharp: the angle past which long sharp
//        edges become edge loops (0: off), pure: all quads (true), seed, relax: iterations, progress(stage, f),
//        cache and cacheKey: where to keep the working surface and direction field between calls }
// Returns { positions (Float32Array), faces (Uint32Array, 4 per face, NONE in the 4th for a triangle), faceCount,
//           hit: { tri (Int32Array), bary (Float32Array, 3 per vertex) }: where each vertex sits on the input surface,
//           faceTri (Int32Array): the input triangle under each face's middle, stats }.
export function remeshQuads(mesh, opt) {
  const t0 = Date.now(), timings = {};
  const mark = label => { timings[label] = Date.now() - t0 - Object.values(timings).reduce((s, v) => s + v, 0); };
  const progress = opt.progress || null;
  const srcP = mesh.positions, srcIdx = mesh.index instanceof Uint32Array ? mesh.index : Uint32Array.from(mesh.index), V0 = srcP.length / 3;
  const target = Math.max(6, opt.targetFaces | 0);
  const na = normalsAndAreas(srcP, srcIdx);
  const srcN = mesh.normals || na.N, srcA = na.A;
  // The metric (edge lengths wanted, per direction) follows the shape when opt.adapt > 0: the curvature analysis is
  // worked out once per surface, the sizes once per budget step of 2^(1/4) (so they, the working surface and the
  // direction field are reused while the budget stays within the step; the grid scale fits the exact budget), both
  // kept with the cache. Painted density multiplies faces per area.
  const dens = opt.density || null, cache = opt.cache || null;
  const step = Math.round(4 * Math.log2(target));
  let Msrc = null;
  if (opt.adapt > 0) {
    const anKey = `${V0}|${srcIdx.length}|${opt.sharp || 0}`, formKey = `${anKey}|${opt.adapt}|${step}`;
    Msrc = cache && cache.form && cache.form.key === formKey ? cache.form.m : null;
    if (!Msrc) {
      let an = cache && cache.analysis && cache.analysis.key === anKey ? cache.analysis.an : null;
      if (!an) {
        an = formAnalysis(srcP, srcIdx, srcN, srcA, { sharp: opt.sharp });
        if (cache) cache.analysis = { key: anKey, an };
      }
      Msrc = formSizes(an, 2 ** (step / 4), opt.adapt);
      if (cache) cache.form = { key: formKey, m: Msrc };
    }
    mark('form');
  }
  if (!Msrc || dens) {
    const base = Msrc;
    Msrc = new Float32Array(V0 * 6);
    for (let v = 0; v < V0; v++) {
      const f = dens ? dens[v] : 1;
      if (base) for (let k = 0; k < 6; k++) Msrc[v * 6 + k] = base[v * 6 + k] * f;
      else Msrc[v * 6] = Msrc[v * 6 + 3] = Msrc[v * 6 + 5] = f;
    }
  }
  // Per source vertex: the metric's larger value (the shortest edge wanted) and √(m1·m2), faces per area.
  const mMax = new Float32Array(V0), mArea = new Float32Array(V0), EG = {};
  for (let v = 0; v < V0; v++) {
    tangentEigen(Msrc, v * 6, srcN[v * 3], srcN[v * 3 + 1], srcN[v * 3 + 2], EG);
    const m1 = Math.max(1e-12, Math.abs(EG.big)), m2 = Math.max(1e-12, Math.abs(EG.small));
    mMax[v] = m1; mArea[v] = Math.sqrt(m1 * m2);
  }

  // Surface area weighted by faces per area sets the grid scale: faces ≈ Σ area·density / scale².
  let weighted = 0, areaTotal = 0;
  for (let v = 0; v < V0; v++) { weighted += srcA[v] * mArea[v]; areaTotal += srcA[v]; }
  // Extraction gives more faces than that (a few percent on an even grid, more where sizes vary), so the first grid
  // starts that much larger; how much more the last remesh of this surface gave is remembered with the cache, and so
  // is the start each budget got, so that asking for a budget again gives the same faces.
  const biasKey = [opt.cacheKey ?? '', opt.sharp || 0, opt.adapt || 0, opt.boundary !== false].join('|');
  if (cache && (!cache.bias || cache.bias.key !== biasKey)) cache.bias = { key: biasKey, phi: 1.04 + 0.12 * (opt.adapt || 0), used: new Map() };
  let phi = cache ? cache.bias.used.get(target) : undefined;
  if (phi === undefined) {
    phi = cache ? cache.bias.phi : 1.04 + 0.12 * (opt.adapt || 0);
    if (cache) cache.bias.used.set(target, phi);
  }
  let scale = Math.sqrt((phi * weighted) / target);
  // The shortest edge wanted at a source vertex (the working surface must resolve it), the mean edge there, and the
  // mean edge over the surface.
  const sizeAt = v => scale / Math.sqrt(mMax[v]);
  const sizeMean = v => scale / Math.sqrt(mArea[v]);
  const sizeRef = () => scale * Math.sqrt(areaTotal / weighted);
  // Sharp edges (opt.sharp: the angle, 0 for none): the fields see one side's normal along them, and vertices near
  // them are snapped onto them after extraction.
  const crease = opt.sharp > 0 ? findCreases(srcP, srcIdx, srcN, opt.sharp, v => 3 * sizeMean(v)) : null;
  const fieldN = crease && crease.segs.length ? crease.N : srcN;

  // The working surface, its hierarchy and the direction field don't depend on the exact budget: they are kept in
  // opt.cache and reused while the budget (or, with even sizes, the grid size) stays within the same step of 2^(1/4)
  // and nothing else changed.
  const cellFactor = 2.5, splitFactor = 0.7;
  const seed = opt.seed ?? 12345;
  const bucket = opt.adapt > 0 ? step : Math.round(4 * Math.log2(scale / cellFactor));
  const key = [opt.cacheKey ?? '', bucket, opt.boundary !== false, seed, opt.sharp || 0, opt.adapt || 0].join('|');
  let work = cache && cache.key === key && opt.cacheKey !== undefined ? cache.work : null;
  if (work) {
    for (const L of work.levels) levelSpacings(L, scale);
    mark('cached');
    if (progress) progress('orientation', 1);
  } else {
    work = buildWorking(srcP, srcIdx, fieldN, srcA, sizeAt, cellFactor, splitFactor, opt, V0, mark, progress, Msrc, scale);
    for (const L of work.levels) levelAlignment(L, 0.5);
    solveOrientations(work.levels, seed, progress);
    for (const L of work.levels) levelSpacings(L, scale);
    mark('orientation');
    if (cache) { cache.key = key; cache.work = work; }
  }
  const { levels, n, nC, WI } = work, L0 = levels[0];
  resolvePositions(levels, seed, progress);
  mark('positions');

  const grid = new SurfaceGrid(srcP, srcIdx, sizeRef());
  const attempts = [];
  mark('grid');
  let result = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const G = extractGraph(L0);
    cleanGraph(G);
    const polys = extractFaces(G);
    // Faces face the same way as the surface.
    let agree = 0;
    for (const p of polys) {
      let nx = 0, ny = 0, nz = 0, vx = 0, vy = 0, vz = 0;
      for (let k = 0; k < p.length; k++) {
        const a = p[k] * 3, b = p[(k + 1) % p.length] * 3;
        nx += (G.P[a + 1] - G.P[b + 1]) * (G.P[a + 2] + G.P[b + 2]);
        ny += (G.P[a + 2] - G.P[b + 2]) * (G.P[a] + G.P[b]);
        nz += (G.P[a] - G.P[b]) * (G.P[a + 1] + G.P[b + 1]);
        vx += G.N[a]; vy += G.N[a + 1]; vz += G.N[a + 2];
      }
      agree += nx * vx + ny * vy + nz * vz > 0 ? 1 : -1;
    }
    if (agree < 0) for (const p of polys) p.reverse();
    const even = opt.pure === false
      ? { faces: polys.flatMap(p => (p.length === 5 ? pentagonSplit(G.P, p) : [p])), positions: G.P, nv: G.nv, unpaired: 0 }
      : evenFaces(polys, G.P, G.nv);
    if (progress) progress('extract', 1);
    const count = even.faces.length;
    result = { G, even, count };
    attempts.push(count);
    mark(`extract${attempt}`);
    // Close enough to the budget, or out of attempts: keep it. Otherwise resize the grid and solve positions again.
    if (Math.abs(count / target - 1) < 0.04 || attempt === 2 || count === 0) break;
    const f = Math.sqrt(count / target);
    scale *= Math.max(0.6, Math.min(1.6, f));
    for (const L of levels) levelSpacings(L, scale);
    if (progress) progress('position', 0);
    resolvePositions(levels, seed + attempt + 1);
    mark(`positions${attempt + 1}`);
  }
  if (cache && result.count > 0) cache.bias.phi = (result.count * scale * scale) / weighted;
  // Relax: every vertex moves toward the middle of its neighbours along the surface, then back onto it.
  const { even } = result;
  const nv = even.nv, P = even.positions;
  const tidy = optimizeValence(even.faces, P);
  // Vertices on real open borders (their grid corner carried the border constraint), which repairs leave open.
  const keepOpen = v => v < result.G.nv && result.G.fixed[v] === 1;
  const repaired = repairFaces(removeDoublets(tidy.faces, nv).faces, P, nv, keepOpen);
  const faces = repaired.dropped || repaired.filled ? removeDoublets(repaired.faces, nv).faces : repaired.faces;
  mark('valence');
  const nbr = new Array(nv);
  for (let v = 0; v < nv; v++) nbr[v] = [];
  const edgeUse = new Map();
  for (const p of faces) {
    for (let k = 0; k < p.length; k++) {
      const a = p[k], b = p[(k + 1) % p.length], key = a < b ? a * nv + b : b * nv + a;
      edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
      if (!has(nbr[a], b)) nbr[a].push(b);
      if (!has(nbr[b], a)) nbr[b].push(a);
    }
  }
  const border = new Uint8Array(nv);
  for (const [key, c] of edgeUse) if (c === 1) { const a = Math.floor(key / nv); border[a] = 1; border[key - a * nv] = 1; }
  const plane = opt.plane || null;
  let relaxSharp = null;
  const hitT = new Int32Array(nv).fill(-1), bary = new Float32Array(nv * 3);
  const Nw = srcN;
  const project = v => {
    const h = grid.closest(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    if (h.t < 0) return;
    P[v * 3] = h.x; P[v * 3 + 1] = h.y; P[v * 3 + 2] = h.z;
    hitT[v] = h.t; bary[v * 3] = h.u; bary[v * 3 + 1] = h.v; bary[v * 3 + 2] = h.w;
  };
  // The mirror plane's cut: open borders that mostly run within 0.75 grid steps of the plane are the cut, and all their
  // vertices go onto it however far they sagged, or the mirrored half would leave a gap there.
  const onCut = new Uint8Array(nv);
  if (plane) {
    const root = new Int32Array(nv);
    for (let v = 0; v < nv; v++) root[v] = v;
    const find = x => { while (root[x] !== x) { root[x] = root[root[x]]; x = root[x]; } return x; };
    for (const [key, c] of edgeUse) {
      if (c !== 1) continue;
      const a = Math.floor(key / nv), b = key - a * nv, ra = find(a), rb = find(b);
      if (ra !== rb) root[ra] = rb;
    }
    const near = new Map(), total = new Map();
    for (let v = 0; v < nv; v++) {
      if (!border[v]) continue;
      const r = find(v);
      total.set(r, (total.get(r) || 0) + 1);
      if (Math.abs(P[v * 3 + plane.axis] - plane.offset) < 0.75 * sizeRef()) near.set(r, (near.get(r) || 0) + 1);
    }
    for (let v = 0; v < nv; v++) if (border[v] && (near.get(find(v)) || 0) * 2 >= total.get(find(v))) onCut[v] = 1;
  }
  const snapPlane = v => { if (onCut[v]) P[v * 3 + plane.axis] = plane.offset; };
  for (let v = 0; v < nv; v++) { project(v); snapPlane(v); }
  // Sharp edges: corners take the nearest vertex and hold it; vertices close to an edge move onto it and afterwards only
  // slide along it. Distances count in the local face size (the mean length of a vertex's edges), which varies where
  // density follows the shape or paint.
  const sharpV = new Uint8Array(nv);
  let segGrid = null;
  const local = new Float64Array(nv);
  for (let v = 0; v < nv; v++) {
    let sum = 0;
    for (const u of nbr[v]) sum += Math.hypot(P[u * 3] - P[v * 3], P[u * 3 + 1] - P[v * 3 + 1], P[u * 3 + 2] - P[v * 3 + 2]);
    local[v] = nbr[v].length ? Math.min(2 * sizeRef(), sum / nbr[v].length) : sizeRef();
  }
  if (crease && crease.segs.length) {
    segGrid = new SegmentGrid(srcP, crease.segs, sizeRef());
    const snapSeg = v => {
      const q = segGrid.nearest(P[v * 3], P[v * 3 + 1], P[v * 3 + 2], 0.4 * local[v]);
      if (!q) return false;
      P[v * 3] = q.x; P[v * 3 + 1] = q.y; P[v * 3 + 2] = q.z;
      return true;
    };
    for (let v = 0; v < nv; v++) if (nbr[v].length && !border[v] && snapSeg(v)) { sharpV[v] = 1; project(v); }
    for (const c of crease.corners) {
      let best = -1, bd = (0.5 * Math.min(2 * sizeRef(), sizeMean(c))) ** 2;
      for (let v = 0; v < nv; v++) {
        if (!nbr[v].length || border[v]) continue;
        const d2 = (P[v * 3] - srcP[c * 3]) ** 2 + (P[v * 3 + 1] - srcP[c * 3 + 1]) ** 2 + (P[v * 3 + 2] - srcP[c * 3 + 2]) ** 2;
        if (d2 < bd) { bd = d2; best = v; }
      }
      if (best < 0) continue;
      for (let k = 0; k < 3; k++) P[best * 3 + k] = srcP[c * 3 + k];
      sharpV[best] = 2;
      project(best);
    }
    // Sharp vertices sit on the input surface already; their snapped spot is where they stay between moves.
    const slide = v => {
      const sharpNbr = nbr[v].filter(u => sharpV[u]);
      if (sharpNbr.length < 2) return;
      let cx = 0, cy = 0, cz = 0;
      for (const u of sharpNbr) { cx += P[u * 3]; cy += P[u * 3 + 1]; cz += P[u * 3 + 2]; }
      const q = segGrid.nearest((P[v * 3] + cx / sharpNbr.length) / 2, (P[v * 3 + 1] + cy / sharpNbr.length) / 2, (P[v * 3 + 2] + cz / sharpNbr.length) / 2, 0.6 * local[v]);
      if (q) { tmp[v * 3] = q.x; tmp[v * 3 + 1] = q.y; tmp[v * 3 + 2] = q.z; }
    };
    relaxSharp = slide;
  }
  const iterations = opt.relax ?? 6;
  const tmp = new Float64Array(nv * 3);
  for (let it = 0; it < iterations; it++) {
    for (let v = 0; v < nv; v++) {
      const list = nbr[v];
      tmp[v * 3] = P[v * 3]; tmp[v * 3 + 1] = P[v * 3 + 1]; tmp[v * 3 + 2] = P[v * 3 + 2];
      if (sharpV[v]) { if (sharpV[v] === 1 && relaxSharp) relaxSharp(v); continue; }
      if (!list.length || border[v] || hitT[v] < 0) continue;
      let cx = 0, cy = 0, cz = 0;
      for (const u of list) { cx += P[u * 3]; cy += P[u * 3 + 1]; cz += P[u * 3 + 2]; }
      cx = cx / list.length - P[v * 3]; cy = cy / list.length - P[v * 3 + 1]; cz = cz / list.length - P[v * 3 + 2];
      // Only along the surface: the normal part of the move would shrink the shape.
      const t = hitT[v], ia = srcIdx[t * 3], ib = srcIdx[t * 3 + 1], ic = srcIdx[t * 3 + 2];
      let nx = Nw[ia * 3] * bary[v * 3] + Nw[ib * 3] * bary[v * 3 + 1] + Nw[ic * 3] * bary[v * 3 + 2];
      let ny = Nw[ia * 3 + 1] * bary[v * 3] + Nw[ib * 3 + 1] * bary[v * 3 + 1] + Nw[ic * 3 + 1] * bary[v * 3 + 2];
      let nz = Nw[ia * 3 + 2] * bary[v * 3] + Nw[ib * 3 + 2] * bary[v * 3 + 1] + Nw[ic * 3 + 2] * bary[v * 3 + 2];
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const d = cx * nx + cy * ny + cz * nz;
      tmp[v * 3] += (cx - nx * d) * 0.8; tmp[v * 3 + 1] += (cy - ny * d) * 0.8; tmp[v * 3 + 2] += (cz - nz * d) * 0.8;
    }
    P.set(tmp);
    for (let v = 0; v < nv; v++) if (!border[v]) {
      if (sharpV[v]) { const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2]; project(v); P[v * 3] = x; P[v * 3 + 1] = y; P[v * 3 + 2] = z; }
      else project(v);
    }
  }
  for (let v = 0; v < nv; v++) if (border[v]) { project(v); snapPlane(v); }
  mark('relax');
  if (progress) progress('relax', 1);

  // Compact: drop vertices no face uses.
  const used = new Int32Array(nv).fill(-1);
  let m = 0;
  for (const p of faces) for (const v of p) if (used[v] < 0) used[v] = m++;
  const positions = new Float32Array(m * 3), tri = new Int32Array(m), bc = new Float32Array(m * 3);
  for (let v = 0; v < nv; v++) {
    const o = used[v];
    if (o < 0) continue;
    positions[o * 3] = P[v * 3]; positions[o * 3 + 1] = P[v * 3 + 1]; positions[o * 3 + 2] = P[v * 3 + 2];
    tri[o] = hitT[v]; bc[o * 3] = bary[v * 3]; bc[o * 3 + 1] = bary[v * 3 + 1]; bc[o * 3 + 2] = bary[v * 3 + 2];
  }
  const out = new Uint32Array(faces.length * 4), faceTri = new Int32Array(faces.length);
  let quads = 0, others = 0;
  faces.forEach((p, f) => {
    for (let k = 0; k < 4; k++) out[f * 4 + k] = k < p.length ? used[p[k]] : NONE;
    if (p.length === 4) quads++; else others++;
    // The input triangle under the face's middle (its material decides the face's).
    let cx = 0, cy = 0, cz = 0;
    for (const v of p) { cx += P[v * 3]; cy += P[v * 3 + 1]; cz += P[v * 3 + 2]; }
    faceTri[f] = grid.closest(cx / p.length, cy / p.length, cz / p.length).t;
  });
  return {
    positions, faces: out, faceCount: faces.length, hit: { tri, bary: bc }, faceTri,
    stats: { quads, others, unpaired: even.unpaired, valenceMoves: tidy.moves, repaired: repaired.dropped, target, scale, size: sizeRef(), clusters: nC, workVertices: n, levels: levels.length, attempts, ms: Date.now() - t0, timings },
  };
}

export const QUAD_NONE = NONE;
