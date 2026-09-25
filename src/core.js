import { remeshQuads, QUAD_NONE } from './quad.js';

export const LABEL = { NONE: 0, MORE1: 1, MORE2: 2, MORE3: 3, LESS1: -1, LESS2: -2, LESS3: -3, KEEP: 100 };
export const MORE_MULT = { 1: 2, 2: 4, 3: 8 };
export const LESS_MULT = { '-1': 0.5, '-2': 0.25, '-3': 0.125 };
const PRIORITY_FLAG = 4;

function mix(h, k) {
  k = Math.imul(k, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

function fmix(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

function tableFor(n) {
  let cap = 16;
  while (cap < n * 2) cap <<= 1;
  return new Int32Array(cap).fill(-1);
}

export function bounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return { min, max, size, diag: Math.hypot(size[0], size[1], size[2]) || 1 };
}

// Groups vertices whose quantized keys are equal. keyFn(i, out) fills out[0..len) with int keys.
function groupBy(n, len, keyFn) {
  const table = tableFor(n);
  const mask = table.length - 1;
  const tmp = new Int32Array(len), rep = new Int32Array(len);
  const group = new Int32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    keyFn(i, tmp);
    let h = 0x9747b28c;
    for (let k = 0; k < len; k++) h = mix(h, tmp[k]);
    h = fmix(h) & mask;
    for (;;) {
      const r = table[h];
      if (r === -1) {
        table[h] = i;
        group[i] = count++;
        break;
      }
      keyFn(r, rep);
      let same = true;
      for (let k = 0; k < len; k++) {
        if (rep[k] !== tmp[k]) { same = false; break; }
      }
      if (same) { group[i] = group[r]; break; }
      h = (h + 1) & mask;
    }
  }
  return { group, count };
}

class UnionFind {
  constructor(n) {
    this.p = new Int32Array(n);
    for (let i = 0; i < n; i++) this.p[i] = i;
  }
  find(x) {
    const p = this.p;
    while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; }
    return x;
  }
  union(a, b) {
    a = this.find(a); b = this.find(b);
    if (a !== b) this.p[a] = b;
  }
  labels(n) {
    const out = new Int32Array(n), ids = new Int32Array(n).fill(-1);
    let c = 0;
    for (let i = 0; i < n; i++) {
      const r = this.find(i);
      if (ids[r] < 0) ids[r] = c++;
      out[i] = ids[r];
    }
    return { labels: out, count: c };
  }
}

export function computeSmoothNormals(positions, index, tolerance = 1e-6) {
  const V = positions.length / 3;
  const b = bounds(positions);
  const step = Math.max(tolerance * b.diag, 1e-12);
  const { group, count } = groupBy(V, 3, (i, o) => {
    o[0] = Math.round((positions[i * 3] - b.min[0]) / step);
    o[1] = Math.round((positions[i * 3 + 1] - b.min[1]) / step);
    o[2] = Math.round((positions[i * 3 + 2] - b.min[2]) / step);
  });
  const acc = new Float64Array(count * 3);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, bb = index[t + 1] * 3, c = index[t + 2] * 3;
    const ux = positions[bb] - positions[a], uy = positions[bb + 1] - positions[a + 1], uz = positions[bb + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [index[t], index[t + 1], index[t + 2]]) {
      const g = group[v] * 3;
      acc[g] += nx; acc[g + 1] += ny; acc[g + 2] += nz;
    }
  }
  const out = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) {
    const g = group[i] * 3;
    const l = Math.hypot(acc[g], acc[g + 1], acc[g + 2]) || 1;
    out[i * 3] = acc[g] / l; out[i * 3 + 1] = acc[g + 1] / l; out[i * 3 + 2] = acc[g + 2] / l;
  }
  return out;
}

// Merges vertices that share a position (within tolerance), part, material and optionally UV,
// keeping normals apart only where they differ by more than hardAngle (real hard edges).
export function smartWeld(src, opt = {}) {
  const positions = src.positions;
  const normals = src.normals || null;
  const uvs = src.uvs || null;
  const colors = src.colors || null;
  const nSrc = positions.length / 3;
  const corner = src.index || Uint32Array.from({ length: nSrc }, (_, i) => i);
  const T = corner.length / 3;
  const triPart = src.triPart || new Uint16Array(T);
  const triMat = src.triMat || new Uint16Array(T);
  const keepUV = !!(opt.keepUV && uvs);
  const cosHard = Math.cos(((opt.hardAngle ?? 30) * Math.PI) / 180);
  const b = bounds(positions);
  const step = Math.max((opt.tolerance ?? 1e-6) * b.diag, 1e-12);
  const uvStep = 1e-5;

  const vPart = new Uint16Array(nSrc), vMat = new Uint16Array(nSrc), used = new Uint8Array(nSrc);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const v = corner[t * 3 + k];
      vPart[v] = triPart[t];
      vMat[v] = triMat[t];
      used[v] = 1;
    }
  }
  const qx = new Int32Array(nSrc), qy = new Int32Array(nSrc), qz = new Int32Array(nSrc);
  for (let i = 0; i < nSrc; i++) {
    qx[i] = Math.round((positions[i * 3] - b.min[0]) / step);
    qy[i] = Math.round((positions[i * 3 + 1] - b.min[1]) / step);
    qz[i] = Math.round((positions[i * 3 + 2] - b.min[2]) / step);
  }
  const exact = groupBy(nSrc, 8, (i, o) => {
    o[0] = qx[i]; o[1] = qy[i]; o[2] = qz[i];
    o[3] = normals ? Math.round(normals[i * 3] * 1e6) : 0;
    o[4] = normals ? Math.round(normals[i * 3 + 1] * 1e6) : 0;
    o[5] = normals ? Math.round(normals[i * 3 + 2] * 1e6) : 0;
    o[6] = uvs ? Math.round(uvs[i * 2] * 1e6) : 0;
    o[7] = uvs ? Math.round(uvs[i * 2 + 1] * 1e6) : 0;
  });
  const posGroups = groupBy(nSrc, 4, (i, o) => { o[0] = qx[i]; o[1] = qy[i]; o[2] = qz[i]; o[3] = vPart[i]; });
  const groups = groupBy(nSrc, 7, (i, o) => {
    o[0] = qx[i]; o[1] = qy[i]; o[2] = qz[i]; o[3] = vPart[i]; o[4] = vMat[i];
    o[5] = keepUV ? Math.round(uvs[i * 2] / uvStep) : 0;
    o[6] = keepUV ? Math.round(uvs[i * 2 + 1] / uvStep) : 0;
  });

  const G = groups.count;
  const cHead = new Int32Array(G).fill(-1);
  const cNext = new Int32Array(nSrc);
  const cSum = new Float64Array(nSrc * 3);
  const cRep = new Int32Array(nSrc);
  const cluster = new Int32Array(nSrc);
  let C = 0;
  for (let i = 0; i < nSrc; i++) {
    if (!used[i]) { cluster[i] = -1; continue; }
    const g = groups.group[i];
    let nx = 0, ny = 0, nz = 0;
    if (normals) {
      nx = normals[i * 3]; ny = normals[i * 3 + 1]; nz = normals[i * 3 + 2];
      const l = Math.hypot(nx, ny, nz);
      if (l > 0) { nx /= l; ny /= l; nz /= l; }
    }
    let found = -1;
    if (normals && (nx || ny || nz)) {
      for (let c = cHead[g]; c !== -1; c = cNext[c]) {
        const sx = cSum[c * 3], sy = cSum[c * 3 + 1], sz = cSum[c * 3 + 2];
        const l = Math.hypot(sx, sy, sz);
        if (l === 0 || (sx * nx + sy * ny + sz * nz) / l >= cosHard) { found = c; break; }
      }
    } else {
      found = cHead[g];
    }
    if (found === -1) {
      found = C++;
      cNext[found] = cHead[g];
      cHead[g] = found;
      cRep[found] = i;
    }
    cSum[found * 3] += nx; cSum[found * 3 + 1] += ny; cSum[found * 3 + 2] += nz;
    cluster[i] = found;
  }

  const remap = new Int32Array(C).fill(-1);
  const idx = new Uint32Array(T * 3);
  const outPart = new Uint16Array(T), outMat = new Uint16Array(T);
  let nT = 0, nV = 0, degenerate = 0;
  for (let t = 0; t < T; t++) {
    const a = cluster[corner[t * 3]], bb = cluster[corner[t * 3 + 1]], c = cluster[corner[t * 3 + 2]];
    if (a === bb || bb === c || a === c) { degenerate++; continue; }
    for (const x of [a, bb, c]) if (remap[x] < 0) remap[x] = nV++;
    idx[nT * 3] = remap[a]; idx[nT * 3 + 1] = remap[bb]; idx[nT * 3 + 2] = remap[c];
    outPart[nT] = triPart[t]; outMat[nT] = triMat[t];
    nT++;
  }
  const posRep = new Int32Array(posGroups.count).fill(-1);
  for (let i = 0; i < nSrc; i++) if (used[i] && posRep[posGroups.group[i]] < 0) posRep[posGroups.group[i]] = i;
  const P = new Float32Array(nV * 3), N = new Float32Array(nV * 3);
  const UV = keepUV ? new Float32Array(nV * 2) : null;
  const COL = colors ? new Float32Array(nV * 3) : null;
  const wPart = new Uint16Array(nV), wMat = new Uint16Array(nV), wPos = new Int32Array(nV);
  for (let c = 0; c < C; c++) {
    const v = remap[c];
    if (v < 0) continue;
    const r = cRep[c], pr = posRep[posGroups.group[r]];
    P[v * 3] = positions[pr * 3]; P[v * 3 + 1] = positions[pr * 3 + 1]; P[v * 3 + 2] = positions[pr * 3 + 2];
    const l = Math.hypot(cSum[c * 3], cSum[c * 3 + 1], cSum[c * 3 + 2]);
    if (l > 0) { N[v * 3] = cSum[c * 3] / l; N[v * 3 + 1] = cSum[c * 3 + 1] / l; N[v * 3 + 2] = cSum[c * 3 + 2] / l; }
    if (UV) { UV[v * 2] = uvs[r * 2]; UV[v * 2 + 1] = uvs[r * 2 + 1]; }
    if (COL) { COL[v * 3] = colors[r * 3]; COL[v * 3 + 1] = colors[r * 3 + 1]; COL[v * 3 + 2] = colors[r * 3 + 2]; }
    wPart[v] = vPart[r]; wMat[v] = vMat[r]; wPos[v] = posGroups.group[r];
  }
  const index = idx.slice(0, nT * 3);
  const triP = outPart.slice(0, nT), triM = outMat.slice(0, nT);
  let normalsOut = N;
  if (!normals) normalsOut = computeSmoothNormals(P, index, opt.tolerance ?? 1e-6);

  const ufGeo = new UnionFind(nV), ufUV = new UnionFind(nV);
  const firstOfPos = new Int32Array(posGroups.count).fill(-1);
  for (let t = 0; t < nT; t++) {
    const a = index[t * 3], bb = index[t * 3 + 1], c = index[t * 3 + 2];
    ufGeo.union(a, bb); ufGeo.union(bb, c);
    ufUV.union(a, bb); ufUV.union(bb, c);
  }
  for (let v = 0; v < nV; v++) {
    const g = wPos[v];
    if (firstOfPos[g] < 0) firstOfPos[g] = v; else ufGeo.union(v, firstOfPos[g]);
  }
  const geo = ufGeo.labels(nV), uvIsl = ufUV.labels(nV);
  let usedPos = 0;
  for (let g = 0; g < posGroups.count; g++) if (firstOfPos[g] >= 0) usedPos++;
  let exactUsed = 0;
  const seenExact = new Uint8Array(exact.count);
  for (let t = 0; t < T * 3; t++) {
    const e = exact.group[corner[t]];
    if (!seenExact[e]) { seenExact[e] = 1; exactUsed++; }
  }
  return {
    positions: P, normals: normalsOut, uvs: UV, colors: COL, index, triPart: triP, triMat: triM, vPart: wPart, vMat: wMat,
    vertexCount: nV, triCount: nT, components: geo.labels, componentCount: geo.count,
    uvIslands: keepUV ? uvIsl.count : 0, uvIsland: keepUV ? uvIsl.labels : null, stats: {
      sourceVertices: nSrc, storedRenderVertices: exactUsed, uniquePositions: usedPos, weldedVertices: nV,
      triangles: nT, removedDegenerate: degenerate, hasNormals: !!normals, hasUVs: !!uvs, keptUVs: keepUV, hasColors: !!colors,
    },
  };
}

export function packAttributes(mesh) {
  const V = mesh.vertexCount;
  const uvOff = mesh.uvs ? 3 : -1;
  const colOff = mesh.colors ? (mesh.uvs ? 5 : 3) : -1;
  const stride = 3 + (mesh.uvs ? 2 : 0) + (mesh.colors ? 3 : 0);
  const attrs = new Float32Array(V * stride);
  for (let i = 0; i < V; i++) {
    const o = i * stride;
    attrs[o] = mesh.normals[i * 3]; attrs[o + 1] = mesh.normals[i * 3 + 1]; attrs[o + 2] = mesh.normals[i * 3 + 2];
    if (uvOff > 0) { attrs[o + uvOff] = mesh.uvs[i * 2]; attrs[o + uvOff + 1] = mesh.uvs[i * 2 + 1]; }
    if (colOff > 0) { attrs[o + colOff] = mesh.colors[i * 3]; attrs[o + colOff + 1] = mesh.colors[i * 3 + 1]; attrs[o + colOff + 2] = mesh.colors[i * 3 + 2]; }
  }
  return { attrs, stride, uvOff, colOff };
}

// Result triangles per painted region, by majority label of their three vertices.
export function categorize(index, labels) {
  const out = { keep: 0, more: 0, less: 0, rest: 0 };
  if (!labels) { out.rest = index.length / 3; return out; }
  const kind = l => (l === LABEL.KEEP ? 'keep' : l > 0 ? 'more' : l < 0 ? 'less' : 'rest');
  for (let t = 0; t < index.length; t += 3) {
    const a = kind(labels[index[t]]), b = kind(labels[index[t + 1]]), c = kind(labels[index[t + 2]]);
    out[a === b || a === c ? a : b === c ? b : a]++;
  }
  return out;
}

function simplifierFlags(st) {
  const flags = [];
  if (st.regularize === 1) flags.push('RegularizeLight');
  if (st.regularize === 2) flags.push('Regularize');
  if (st.lockBorder) flags.push('LockBorder');
  if (st.permissive) flags.push('Permissive');
  return flags;
}

function concatIndex(a, b) {
  const out = new Uint32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Remove tiny floating parts: pieces smaller than this share of the model's size.
export const PRUNE_SIZE = 0.01;

// Region-aware reduction. labels: Int8Array per vertex (LABEL values).
// st.seam (under symmetry): vertices on the mirror plane. They are the cut half's border but not a real one, so they stay
// free to simplify along the plane; LockBorder then becomes explicit locks on the real open borders in st.border.
export function reduce(S, mesh, packed, labels, st) {
  const t0 = Date.now();
  const V = mesh.vertexCount;
  const Torig = mesh.index.length / 3;
  const target = Math.max(1, Math.min(Torig, Math.round(st.targetTris)));
  const g = target / Torig;
  const seam = st.seam || null;
  const flags = simplifierFlags(st).filter(f => !(seam && f === 'LockBorder'));
  const borderLock = seam && st.lockBorder && st.border ? st.border : null;
  const maxError = st.maxError > 0 ? st.maxError : 1;
  const positions = mesh.positions.slice();
  const attrs = packed.attrs.slice();
  const stride = packed.stride;
  const weights = [st.normalWeight, st.normalWeight, st.normalWeight];
  if (packed.uvOff > 0) weights.push(st.uvWeight, st.uvWeight);
  if (packed.colOff > 0) weights.push(st.uvWeight, st.uvWeight, st.uvWeight);
  let index = mesh.index;
  // Tiny floating parts go first, by their size alone. The simplifier's own Prune option cuts at the error limit, and
  // with no limit it removes whole pieces, the model itself included, when it can't otherwise reach the budget.
  if (st.prune) index = S.simplifyPrune(index, positions, 3, PRUNE_SIZE);
  const present = new Set();
  if (labels) for (let i = 0; i < V; i++) if (labels[i]) present.add(labels[i]);
  const regionTris = {};

  for (const lvl of [-1, -2, -3]) {
    if (!present.has(lvl)) continue;
    let nIn = 0;
    for (let t = 0; t < index.length; t += 3) {
      if (labels[index[t]] === lvl && labels[index[t + 1]] === lvl && labels[index[t + 2]] === lvl) nIn++;
    }
    if (!nIn) continue;
    const sub = new Uint32Array(nIn * 3), rest = new Uint32Array(index.length - nIn * 3);
    let si = 0, ri = 0;
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t], b = index[t + 1], c = index[t + 2];
      if (labels[a] === lvl && labels[b] === lvl && labels[c] === lvl) { sub[si++] = a; sub[si++] = b; sub[si++] = c; }
      else { rest[ri++] = a; rest[ri++] = b; rest[ri++] = c; }
    }
    const want = Math.max(3, Math.floor((sub.length / 3) * g * LESS_MULT[lvl]) * 3);
    const regularize = flags.filter(f => f.startsWith('Regularize'));
    let r;
    if (seam) {
      // Lock only the vertices the rest of the mesh shares with the region, so the region's stretch of the seam can simplify.
      const shared = new Uint8Array(V);
      for (let k = 0; k < rest.length; k++) shared[rest[k]] = 1;
      if (borderLock) for (let v = 0; v < V; v++) if (borderLock[v]) shared[v] = 1;
      [r] = S.simplifyWithAttributes(sub, positions, 3, attrs, stride, weights.map(() => 0), shared, Math.min(sub.length, want), 1, regularize);
    } else {
      [r] = S.simplify(sub, positions, 3, Math.min(sub.length, want), 1, ['LockBorder', ...regularize]);
    }
    regionTris[lvl] = r.length / 3;
    index = concatIndex(rest, r);
  }

  const lock = new Uint8Array(V);
  let keepCount = 0, borderLocked = false;
  if (borderLock) for (let i = 0; i < V; i++) if (borderLock[i]) { lock[i] = 1; borderLocked = true; }
  if (labels) {
    for (let i = 0; i < V; i++) {
      if (labels[i] === LABEL.KEEP) { lock[i] = 1; keepCount++; }
      else if (labels[i] > 0 && labels[i] < LABEL.KEEP) lock[i] = PRIORITY_FLAG;
    }
  }
  for (const lvl of [1, 2, 3]) {
    if (!present.has(lvl)) continue;
    const want = Math.min(index.length, Math.round(target * MORE_MULT[lvl]) * 3);
    const [r] = S.simplify(index, positions, 3, want - (want % 3), 1, flags);
    for (let k = 0; k < r.length; k++) if (labels[r[k]] === lvl) lock[r[k]] = 1;
  }

  const anyLock = (labels && present.size > 0) || borderLocked;
  const targetIdx = Math.min(index.length, target * 3);
  let out, error;
  if (st.optimizePositions) {
    const work = index.slice();
    const [count, e] = S.simplifyWithUpdate(work, positions, 3, attrs, stride, weights, anyLock ? lock : null, targetIdx, maxError, flags);
    out = work.slice(0, count);
    error = e;
  } else {
    [out, error] = S.simplifyWithAttributes(index, positions, 3, attrs, stride, weights, anyLock ? lock : null, targetIdx, maxError, flags);
  }
  return { index: out, positions, attrs, stride, uvOff: packed.uvOff, colOff: packed.colOff, error, ms: Date.now() - t0, target, keepCount, regionTris };
}

function faceNormalsOf(positions, index) {
  const F = index.length / 3;
  const fn = new Float32Array(F * 3);
  for (let t = 0; t < F; t++) {
    const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    fn[t * 3] = uy * vz - uz * vy; fn[t * 3 + 1] = uz * vx - ux * vz; fn[t * 3 + 2] = ux * vy - uy * vx;
  }
  return fn;
}

// quad: pair marks (see validatePairs); both triangles of a quad take the quad's normal, so its diagonal never splits.
function creased(positions, normals, uvs, colors, srcId, index, vPart, vMat, angle, quad = null) {
  const V = positions.length / 3, F = index.length / 3;
  const cosA = Math.cos((angle * Math.PI) / 180);
  const b = bounds(positions);
  const step = Math.max(1e-6 * b.diag, 1e-12);
  const pg = groupBy(V, 3, (i, o) => {
    o[0] = Math.round((positions[i * 3] - b.min[0]) / step);
    o[1] = Math.round((positions[i * 3 + 1] - b.min[1]) / step);
    o[2] = Math.round((positions[i * 3 + 2] - b.min[2]) / step);
  });
  const fn = faceNormalsOf(positions, index);
  if (quad) {
    for (let t = 0; t + 1 < F; t++) {
      if (quad[t] !== 1) continue;
      for (let k = 0; k < 3; k++) fn[t * 3 + k] = fn[(t + 1) * 3 + k] = fn[t * 3 + k] + fn[(t + 1) * 3 + k];
    }
  }
  const fu = new Float32Array(F * 3);
  for (let t = 0; t < F; t++) {
    const l = Math.hypot(fn[t * 3], fn[t * 3 + 1], fn[t * 3 + 2]) || 1;
    fu[t * 3] = fn[t * 3] / l; fu[t * 3 + 1] = fn[t * 3 + 1] / l; fu[t * 3 + 2] = fn[t * 3 + 2] / l;
  }
  const cnt = new Int32Array(pg.count + 1);
  for (let k = 0; k < index.length; k++) cnt[pg.group[index[k]] + 1]++;
  for (let g = 0; g < pg.count; g++) cnt[g + 1] += cnt[g];
  const faces = new Int32Array(index.length), fill = cnt.slice();
  for (let k = 0; k < index.length; k++) faces[fill[pg.group[index[k]]]++] = (k / 3) | 0;
  const cornerN = new Float32Array(index.length * 3);
  for (let k = 0; k < index.length; k++) {
    const t = (k / 3) | 0, g = pg.group[index[k]];
    let sx = 0, sy = 0, sz = 0;
    for (let j = cnt[g]; j < cnt[g + 1]; j++) {
      const f = faces[j];
      if (fu[f * 3] * fu[t * 3] + fu[f * 3 + 1] * fu[t * 3 + 1] + fu[f * 3 + 2] * fu[t * 3 + 2] >= cosA) {
        sx += fn[f * 3]; sy += fn[f * 3 + 1]; sz += fn[f * 3 + 2];
      }
    }
    const l = Math.hypot(sx, sy, sz) || 1;
    cornerN[k * 3] = sx / l; cornerN[k * 3 + 1] = sy / l; cornerN[k * 3 + 2] = sz / l;
  }
  const split = groupBy(index.length, 4, (k, o) => {
    o[0] = index[k];
    o[1] = Math.round(cornerN[k * 3] * 1e4); o[2] = Math.round(cornerN[k * 3 + 1] * 1e4); o[3] = Math.round(cornerN[k * 3 + 2] * 1e4);
  });
  const nV = split.count;
  const P = new Float32Array(nV * 3), N = new Float32Array(nV * 3), UV = uvs ? new Float32Array(nV * 2) : null;
  const COL = colors ? new Float32Array(nV * 3) : null, SRC = new Uint32Array(nV);
  const pP = new Uint16Array(nV), pM = new Uint16Array(nV), idx = new Uint32Array(index.length);
  for (let k = 0; k < index.length; k++) {
    const v = split.group[k], s = index[k];
    idx[k] = v;
    P[v * 3] = positions[s * 3]; P[v * 3 + 1] = positions[s * 3 + 1]; P[v * 3 + 2] = positions[s * 3 + 2];
    N[v * 3] = cornerN[k * 3]; N[v * 3 + 1] = cornerN[k * 3 + 1]; N[v * 3 + 2] = cornerN[k * 3 + 2];
    if (UV) { UV[v * 2] = uvs[s * 2]; UV[v * 2 + 1] = uvs[s * 2 + 1]; }
    if (COL) { COL[v * 3] = colors[s * 3]; COL[v * 3 + 1] = colors[s * 3 + 1]; COL[v * 3 + 2] = colors[s * 3 + 2]; }
    SRC[v] = srcId[s];
    pP[v] = vPart[s]; pM[v] = vMat[s];
  }
  return { positions: P, normals: N, uvs: UV, colors: COL, srcId: SRC, index: idx, vPart: pP, vMat: pM };
}

// Normals for a reduced mesh from the smooth normals of the dense surface it came from (srcId: the source vertex of each
// vertex), so shading follows the original rather than the reduced triangles. Where the reduced surface turns far from
// that normal, in very coarse areas, the normal leans back toward the reduced surface's own.
function surfaceNormals(smooth, srcId, positions, index) {
  const V = srcId.length, picked = new Float32Array(V * 3);
  for (let v = 0; v < V; v++) for (let k = 0; k < 3; k++) picked[v * 3 + k] = smooth[srcId[v] * 3 + k];
  return leanToSurface(picked, positions, index);
}
// Normals that turn more than 75° from the mesh's own smooth normals lean back toward them.
function leanToSurface(N, positions, index) {
  const V = positions.length / 3, out = new Float32Array(V * 3), own = computeSmoothNormals(positions, index);
  const cosLimit = Math.cos((75 * Math.PI) / 180);
  for (let v = 0; v < V; v++) {
    const o = v * 3;
    let x = N[o], y = N[o + 1], z = N[o + 2];
    const l0 = Math.hypot(x, y, z) || 1;
    x /= l0; y /= l0; z /= l0;
    const d = x * own[o] + y * own[o + 1] + z * own[o + 2];
    if (d < cosLimit) {
      const t = Math.min(1, (cosLimit - d) / (cosLimit + 1));
      x += (own[o] - x) * t; y += (own[o + 1] - y) * t; z += (own[o + 2] - z) * t;
    }
    const l = Math.hypot(x, y, z) || 1;
    out[o] = x / l; out[o + 1] = y / l; out[o + 2] = z / l;
  }
  return out;
}

// Smooth normals of a mesh's own surface, worked out once per mesh.
const smoothCache = new WeakMap();
function smoothNormalsOf(mesh) {
  let n = smoothCache.get(mesh);
  if (!n) smoothCache.set(mesh, (n = computeSmoothNormals(mesh.positions, mesh.index)));
  return n;
}

// opt.smooth: smooth normals of `mesh`'s dense surface, per vertex of `mesh`, for the 'smooth' mode.
export function finalize(mesh, red, opt = {}) {
  const src = red.index, pos = red.positions, attrs = red.attrs, stride = red.stride, uvOff = red.uvOff, colOff = red.colOff;
  const V = pos.length / 3;
  const remap = new Int32Array(V).fill(-1);
  let n = 0;
  for (let k = 0; k < src.length; k++) if (remap[src[k]] < 0) remap[src[k]] = n++;
  let positions = new Float32Array(n * 3), normals = new Float32Array(n * 3);
  let uvs = uvOff > 0 ? new Float32Array(n * 2) : null;
  let colors = colOff > 0 ? new Float32Array(n * 3) : null;
  let vPart = new Uint16Array(n), vMat = new Uint16Array(n), srcId = new Uint32Array(n);
  for (let v = 0; v < V; v++) {
    const o = remap[v];
    if (o < 0) continue;
    positions[o * 3] = pos[v * 3]; positions[o * 3 + 1] = pos[v * 3 + 1]; positions[o * 3 + 2] = pos[v * 3 + 2];
    const a = v * stride;
    const l = Math.hypot(attrs[a], attrs[a + 1], attrs[a + 2]) || 1;
    normals[o * 3] = attrs[a] / l; normals[o * 3 + 1] = attrs[a + 1] / l; normals[o * 3 + 2] = attrs[a + 2] / l;
    if (uvs) { uvs[o * 2] = attrs[a + uvOff]; uvs[o * 2 + 1] = attrs[a + uvOff + 1]; }
    if (colors) {
      for (let k = 0; k < 3; k++) colors[o * 3 + k] = Math.min(1, Math.max(0, attrs[a + colOff + k]));
    }
    vPart[o] = mesh.vPart[v]; vMat[o] = mesh.vMat[v]; srcId[o] = v;
  }
  let index = new Uint32Array(src.length);
  for (let k = 0; k < src.length; k++) index[k] = remap[src[k]];
  if (opt.normals === 'smooth') {
    normals = opt.smooth ? surfaceNormals(opt.smooth, srcId, positions, index) : computeSmoothNormals(positions, index);
  } else if (opt.normals === 'crease') {
    ({ positions, normals, uvs, colors, srcId, index, vPart, vMat } = creased(positions, normals, uvs, colors, srcId, index, vPart, vMat, opt.creaseAngle ?? 60));
  }
  return { positions, normals, uvs, colors, srcId, index, vPart, vMat, vertexCount: positions.length / 3, triCount: index.length / 3 };
}

// Splits a finalized result into export objects, one per part (or one merged object).
export function exportObjects(result, parts, materials, merge, name) {
  const T = result.triCount;
  const groupsOf = merge ? [[...parts.keys()]] : parts.map((_, i) => [i]);
  const objects = [];
  for (const partIds of groupsOf) {
    const want = new Set(partIds);
    const tris = [];
    for (let t = 0; t < T; t++) if (want.has(result.vPart[result.index[t * 3]])) tris.push(t);
    if (!tris.length) continue;
    const remap = new Map();
    const matMap = new Map();
    const idx = new Uint32Array(tris.length * 3), triMat = new Uint16Array(tris.length);
    const quad = result.quad ? Uint8Array.from(tris, t => result.quad[t]) : null;
    if (quad) validatePairs(quad);
    tris.forEach((t, j) => {
      for (let k = 0; k < 3; k++) {
        const v = result.index[t * 3 + k];
        if (!remap.has(v)) remap.set(v, remap.size);
        idx[j * 3 + k] = remap.get(v);
      }
      const gm = result.vMat[result.index[t * 3]];
      if (!matMap.has(gm)) matMap.set(gm, matMap.size);
      triMat[j] = matMap.get(gm);
    });
    const n = remap.size;
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3), UV = result.uvs ? new Float32Array(n * 2) : null;
    const COL = result.colors ? new Float32Array(n * 3) : null;
    for (const [v, o] of remap) {
      P.set(result.positions.subarray(v * 3, v * 3 + 3), o * 3);
      N.set(result.normals.subarray(v * 3, v * 3 + 3), o * 3);
      if (UV) UV.set(result.uvs.subarray(v * 2, v * 2 + 2), o * 2);
      if (COL) COL.set(result.colors.subarray(v * 3, v * 3 + 3), o * 3);
    }
    const mats = [...matMap.keys()].map(gm => materials[gm]);
    objects.push({ name: merge ? name : parts[partIds[0]].name, positions: P, normals: N, uvs: UV, colors: COL, index: idx, quad, triMat, materials: mats });
  }
  return objects;
}

// ---------- quads ----------
// A quad is kept as two consecutive triangles: quad[t] is 1 on the first and 2 on the second (0 for a lone triangle).
// Clears marks whose partner went missing; half: where a mirrored copy starts, so no pair spans the two copies.
function validatePairs(quad, half = Infinity) {
  for (let t = 0; t < quad.length; t++) {
    if (quad[t] === 1 && !(t + 1 < quad.length && quad[t + 1] === 2 && (t < half) === (t + 1 < half))) quad[t] = 0;
    else if (quad[t] === 2 && !(t > 0 && quad[t - 1] === 1)) quad[t] = 0;
  }
}

// The four corners of the quad made by triangles t and t + 1: the second triangle's corner that the first lacks goes
// between the two they share. Null when the triangles don't share exactly two corners.
export function quadCorners(index, t) {
  const a = [index[t * 3], index[t * 3 + 1], index[t * 3 + 2]], b = [index[t * 3 + 3], index[t * 3 + 4], index[t * 3 + 5]];
  const extra = b.filter(v => !a.includes(v));
  if (extra.length !== 1) return null;
  for (let k = 0; k < 3; k++) {
    const x = a[k], y = a[(k + 1) % 3];
    if (b.includes(x) && b.includes(y)) return [y, a[(k + 2) % 3], x, extra[0]];
  }
  return null;
}

// ---------- FBX (binary 7400, Blender-compatible layout) ----------

const FBX_HEAD = [75, 97, 121, 100, 97, 114, 97, 32, 70, 66, 88, 32, 66, 105, 110, 97, 114, 121, 32, 32, 0, 26, 0];
const FOOT_ID = [0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e];
const FOOT_MAGIC = [0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b];

class Bytes {
  constructor(size = 1 << 16) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
    this.len = 0;
  }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let s = this.buf.length * 2;
    while (s < this.len + n) s *= 2;
    const nb = new Uint8Array(s);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }
  u8(v) { this.ensure(1); this.buf[this.len++] = v; }
  bytes(arr) { this.ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
  i16(v) { this.ensure(2); this.view.setInt16(this.len, v, true); this.len += 2; }
  u32(v) { this.ensure(4); this.view.setUint32(this.len, v, true); this.len += 4; }
  i32(v) { this.ensure(4); this.view.setInt32(this.len, v, true); this.len += 4; }
  f32(v) { this.ensure(4); this.view.setFloat32(this.len, v, true); this.len += 4; }
  f64(v) { this.ensure(8); this.view.setFloat64(this.len, v, true); this.len += 8; }
  i64(v) { this.ensure(8); this.view.setBigInt64(this.len, BigInt(v), true); this.len += 8; }
  zeros(n) { this.ensure(n); this.buf.fill(0, this.len, this.len + n); this.len += n; }
}

const enc = new TextEncoder();
const ARR = { f: [Float32Array, 4], d: [Float64Array, 8], l: [BigInt64Array, 8], i: [Int32Array, 4], b: [Uint8Array, 1] };

function writeProp(out, [t, v]) {
  out.u8(t.charCodeAt(0));
  switch (t) {
    case 'Y': out.i16(v); break;
    case 'C': out.u8(v ? 1 : 0); break;
    case 'I': out.i32(v); break;
    case 'F': out.f32(v); break;
    case 'D': out.f64(v); break;
    case 'L': out.i64(v); break;
    case 'S': { const b = typeof v === 'string' ? enc.encode(v) : v; out.u32(b.length); out.bytes(b); break; }
    case 'R': { out.u32(v.length); out.bytes(v); break; }
    default: {
      const [Ctor, size] = ARR[t];
      const a = v instanceof Ctor ? v : Ctor.from(v);
      out.u32(a.length); out.u32(0); out.u32(a.length * size);
      out.bytes(new Uint8Array(a.buffer, a.byteOffset, a.length * size));
    }
  }
}

function writeNode(out, node, isLast) {
  const [name, props, children, sentinel] = node;
  const start = out.len;
  out.zeros(12);
  const nb = enc.encode(name);
  out.u8(nb.length);
  out.bytes(nb);
  const ps = out.len;
  for (const p of props) writeProp(out, p);
  const plen = out.len - ps;
  if (children.length) {
    children.forEach((c, i) => writeNode(out, c, i === children.length - 1));
    out.zeros(13);
  } else if (sentinel ?? (!props.length && !isLast)) {
    out.zeros(13);
  }
  out.view.setUint32(start, out.len, true);
  out.view.setUint32(start + 4, props.length, true);
  out.view.setUint32(start + 8, plen, true);
}

function fromTemplate(n) {
  const [name, props, children, sentinel] = n;
  return [name, props.map(([t, v]) => (t === 'R' ? [t, Uint8Array.from(atob(v), c => c.charCodeAt(0))] : [t, v])), children.map(fromTemplate), sentinel];
}

const N = (name, props = [], children = []) => [name, props, children];
const P70 = (name, type, label, flags, ...vals) => N('P', [['S', name], ['S', type], ['S', label], ['S', flags], ...vals]);

// An export object's faces: its quads (pairs of triangles) and lone triangles, as { corners, tri } with tri the
// first triangle (for the material).
function polygonsOf(o) {
  const T = o.index.length / 3, out = [];
  for (let t = 0; t < T; t++) {
    const q = o.quad && o.quad[t] === 1 ? quadCorners(o.index, t) : null;
    if (q) { out.push({ corners: q, tri: t }); t++; continue; }
    out.push({ corners: [o.index[t * 3], o.index[t * 3 + 1], o.index[t * 3 + 2]], tri: t });
  }
  return out;
}

// Each edge once, as the polygon-vertex index where it starts (FBX's Edges).
function edgesOf(polys) {
  const seen = new Set();
  const out = [];
  let k = 0;
  for (const { corners } of polys) {
    for (let j = 0; j < corners.length; j++, k++) {
      const a = corners[j], b = corners[(j + 1) % corners.length];
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      if (!seen.has(key)) { seen.add(key); out.push(k); }
    }
  }
  return Int32Array.from(out);
}

export function writeFBX(objects, opt, template) {
  const tpl = Object.fromEntries(Object.entries(template).filter(([k]) => k !== 'templates').map(([k, v]) => [k, fromTemplate(v)]));
  const templates = Object.fromEntries(Object.entries(template.templates).map(([k, v]) => [k, fromTemplate(v)]));
  const fileName = opt.fileName || 'model.fbx';
  const patchStrings = node => {
    const [name, props, children] = node;
    if (name === 'P' && props[0] && typeof props[0][1] === 'string') {
      const key = props[0][1];
      const s = props[4] && props[4][0] === 'S';
      if (s && /DocumentUrl|FileName$/.test(key)) props[4][1] = fileName;
      if (s && /Application(Name|Vendor)$/.test(key)) props[4][1] = 'Poly Budget';
      if (s && /ApplicationVersion$/.test(key)) props[4][1] = '1.0';
    }
    if (name === 'Creator') props[0][1] = 'Poly Budget';
    children.forEach(patchStrings);
  };
  patchStrings(tpl.FBXHeaderExtension);
  tpl.Creator[1][0][1] = 'Poly Budget';
  const gs = tpl.GlobalSettings[2].find(c => c[0] === 'Properties70');
  for (const p of gs[2]) {
    if (p[1][0][1] === 'UnitScaleFactor' || p[1][0][1] === 'OriginalUnitScaleFactor') p[1][4] = ['D', opt.unitScale];
  }

  let nextId = 1000000 + Math.floor(Math.random() * 1000000);
  const id = () => nextId++;
  const objNodes = [], conns = [];
  const matIds = new Map(), texIds = new Map();
  let geoCount = 0, matCount = 0, texCount = 0;
  for (const o of objects) {
    const gid = id(), mid = id();
    const polys = polygonsOf(o);
    const corners = [];
    for (const p of polys) corners.push(...p.corners);
    const pvi = new Int32Array(corners.length), cornerIndex = Int32Array.from(corners);
    let k0 = 0;
    for (const p of polys) {
      for (let j = 0; j < p.corners.length; j++) pvi[k0 + j] = j === p.corners.length - 1 ? ~p.corners[j] : p.corners[j];
      k0 += p.corners.length;
    }
    const layer = [N('Version', [['I', 100]]), N('LayerElement', [], [N('Type', [['S', 'LayerElementNormal']]), N('TypedIndex', [['I', 0]])])];
    const geoChildren = [
      ['Properties70', [], [], true],
      N('GeometryVersion', [['I', 124]]),
      N('Vertices', [['d', Float64Array.from(o.positions)]]),
      N('PolygonVertexIndex', [['i', pvi]]),
      N('Edges', [['i', edgesOf(polys)]]),
      N('LayerElementNormal', [['I', 0]], [
        N('Version', [['I', 101]]), N('Name', [['S', '']]),
        N('MappingInformationType', [['S', 'ByPolygonVertex']]), N('ReferenceInformationType', [['S', 'IndexToDirect']]),
        N('Normals', [['d', Float64Array.from(o.normals)]]), N('NormalsIndex', [['i', cornerIndex]]),
      ]),
    ];
    if (o.uvs) {
      geoChildren.push(N('LayerElementUV', [['I', 0]], [
        N('Version', [['I', 101]]), N('Name', [['S', 'UVMap']]),
        N('MappingInformationType', [['S', 'ByPolygonVertex']]), N('ReferenceInformationType', [['S', 'IndexToDirect']]),
        N('UV', [['d', Float64Array.from(o.uvs)]]), N('UVIndex', [['i', cornerIndex]]),
      ]));
      layer.push(N('LayerElement', [], [N('Type', [['S', 'LayerElementUV']]), N('TypedIndex', [['I', 0]])]));
    }
    if (o.colors) {
      const nv = o.colors.length / 3;
      const rgba = new Float64Array(nv * 4);
      for (let i = 0; i < nv; i++) { rgba[i * 4] = o.colors[i * 3]; rgba[i * 4 + 1] = o.colors[i * 3 + 1]; rgba[i * 4 + 2] = o.colors[i * 3 + 2]; rgba[i * 4 + 3] = 1; }
      geoChildren.push(N('LayerElementColor', [['I', 0]], [
        N('Version', [['I', 101]]), N('Name', [['S', 'Col']]),
        N('MappingInformationType', [['S', 'ByPolygonVertex']]), N('ReferenceInformationType', [['S', 'IndexToDirect']]),
        N('Colors', [['d', rgba]]), N('ColorIndex', [['i', cornerIndex]]),
      ]));
      layer.push(N('LayerElement', [], [N('Type', [['S', 'LayerElementColor']]), N('TypedIndex', [['I', 0]])]));
    }
    const single = o.materials.length <= 1;
    geoChildren.push(N('LayerElementMaterial', [['I', 0]], [
      N('Version', [['I', 101]]), N('Name', [['S', '']]),
      N('MappingInformationType', [['S', single ? 'AllSame' : 'ByPolygon']]), N('ReferenceInformationType', [['S', 'IndexToDirect']]),
      N('Materials', [['i', single ? Int32Array.of(0) : Int32Array.from(polys, p => o.triMat[p.tri])]]),
    ]));
    layer.push(N('LayerElement', [], [N('Type', [['S', 'LayerElementMaterial']]), N('TypedIndex', [['I', 0]])]));
    geoChildren.push(N('Layer', [['I', 0]], layer));
    objNodes.push(N('Geometry', [['L', gid], ['S', `${o.name}\u0000\u0001Geometry`], ['S', 'Mesh']], geoChildren));
    objNodes.push(N('Model', [['L', mid], ['S', `${o.name}\u0000\u0001Model`], ['S', 'Mesh']], [
      N('Version', [['I', 232]]),
      N('Properties70', [], [
        P70('Lcl Translation', 'Lcl Translation', '', 'A', ['D', 0], ['D', 0], ['D', 0]),
        P70('Lcl Rotation', 'Lcl Rotation', '', 'A', ['D', 0], ['D', 0], ['D', 0]),
        P70('Lcl Scaling', 'Lcl Scaling', '', 'A', ['D', 1], ['D', 1], ['D', 1]),
        P70('DefaultAttributeIndex', 'int', 'Integer', '', ['I', 0]),
        P70('InheritType', 'enum', '', '', ['I', 1]),
      ]),
      N('MultiLayer', [['I', 0]]), N('MultiTake', [['I', 0]]), N('Shading', [['C', 1]]), N('Culling', [['S', 'CullingOff']]),
    ]));
    geoCount++;
    conns.push(N('C', [['S', 'OO'], ['L', mid], ['L', 0]]));
    conns.push(N('C', [['S', 'OO'], ['L', gid], ['L', mid]]));
    const mats = o.materials.length ? o.materials : [{ name: 'Material', color: [0.8, 0.8, 0.8], texture: null }];
    for (const m of mats) {
      if (!matIds.has(m)) {
        const matId = id();
        matIds.set(m, matId);
        matCount++;
        const c = m.color || [0.8, 0.8, 0.8];
        objNodes.push(N('Material', [['L', matId], ['S', `${m.name}\u0000\u0001Material`], ['S', '']], [
          N('Version', [['I', 102]]), N('ShadingModel', [['S', 'Phong']]), N('MultiLayer', [['I', 0]]),
          N('Properties70', [], [
            P70('DiffuseColor', 'Color', '', 'A', ['D', c[0]], ['D', c[1]], ['D', c[2]]),
            P70('EmissiveFactor', 'Number', '', 'A', ['D', 0]),
            P70('AmbientColor', 'Color', '', 'A', ['D', 0.05], ['D', 0.05], ['D', 0.05]),
            P70('SpecularFactor', 'Number', '', 'A', ['D', 0.25]),
            P70('ShininessExponent', 'Number', '', 'A', ['D', 20]),
          ]),
        ]));
        for (const [file, prop] of [[m.texture, 'DiffuseColor'], [m.normal, 'NormalMap']]) {
          if (!file) continue;
          let t = texIds.get(file);
          if (!t) {
            t = { tex: id(), vid: id() };
            texIds.set(file, t);
            texCount++;
            const base = file.replace(/\.[^.]+$/, '');
            objNodes.push(N('Texture', [['L', t.tex], ['S', `${base}\u0000\u0001Texture`], ['S', '']], [
              N('Type', [['S', 'TextureVideoClip']]), N('Version', [['I', 202]]),
              N('TextureName', [['S', `${base}\u0000\u0001Texture`]]), N('Media', [['S', `${base}\u0000\u0001Video`]]),
              N('FileName', [['S', file]]), N('RelativeFilename', [['S', file]]),
              N('Properties70', [], [P70('UseMaterial', 'bool', '', '', ['I', 1])]),
            ]));
            objNodes.push(N('Video', [['L', t.vid], ['S', `${base}\u0000\u0001Video`], ['S', 'Clip']], [
              N('Type', [['S', 'Clip']]),
              N('Properties70', [], [P70('Path', 'KString', 'Url', '', ['S', file])]),
              N('UseMipMap', [['I', 0]]), N('Filename', [['S', file]]), N('RelativeFilename', [['S', file]]),
            ]));
            conns.push(N('C', [['S', 'OO'], ['L', t.vid], ['L', t.tex]]));
          }
          conns.push(N('C', [['S', 'OP'], ['L', t.tex], ['L', matId], ['S', prop]]));
        }
      }
      conns.push(N('C', [['S', 'OO'], ['L', matIds.get(m)], ['L', mid]]));
    }
  }
  const objType = (name, count, tplName) => N('ObjectType', [['S', name]], [N('Count', [['I', count]]), ...(tplName && templates[name] ? [templates[name]] : [])]);
  const defs = N('Definitions', [], [
    N('Version', [['I', 100]]),
    N('Count', [['I', 1 + geoCount * 2 + matCount + texCount * 2]]),
    objType('GlobalSettings', 1),
    objType('Geometry', geoCount, true),
    objType('Model', geoCount, true),
    objType('Material', matCount, true),
    ...(texCount ? [objType('Texture', texCount, true), objType('Video', texCount, true)] : []),
  ]);
  const top = [tpl.FBXHeaderExtension, tpl.FileId, tpl.CreationTime, tpl.Creator, tpl.GlobalSettings, tpl.Documents, tpl.References,
    defs, N('Objects', [], objNodes), N('Connections', [], conns), tpl.Takes];
  const out = new Bytes(1 << 20);
  out.bytes(FBX_HEAD);
  out.u32(7400);
  top.forEach((n, i) => writeNode(out, n, i === top.length - 1));
  out.zeros(13);
  out.bytes(FOOT_ID);
  out.zeros(4);
  const pad = ((out.len + 15) & ~15) - out.len;
  out.zeros(pad || 16);
  out.u32(7400);
  out.zeros(120);
  out.bytes(FOOT_MAGIC);
  return out.buf.slice(0, out.len);
}

// Reads UnitScaleFactor (centimetres per file unit) from an FBX file, binary or ASCII.
export function readFbxUnitScale(buffer) {
  const u8 = new Uint8Array(buffer);
  const head = String.fromCharCode(...u8.subarray(0, 18));
  if (head !== 'Kaydara FBX Binary') {
    const text = new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 1 << 20)));
    const m = text.match(/"UnitScaleFactor",\s*"double",\s*"Number",\s*"[^"]*",\s*([-\d.eE+]+)/);
    return m ? parseFloat(m[1]) : null;
  }
  const dv = new DataView(buffer);
  const version = dv.getUint32(23, true);
  const wide = version >= 7500;
  const readHeader = off => {
    const end = wide ? Number(dv.getBigUint64(off, true)) : dv.getUint32(off, true);
    const nprops = wide ? Number(dv.getBigUint64(off + 8, true)) : dv.getUint32(off + 4, true);
    const hdr = wide ? 24 : 12;
    const nlen = u8[off + hdr];
    const name = String.fromCharCode(...u8.subarray(off + hdr + 1, off + hdr + 1 + nlen));
    return { end, nprops, name, propsAt: off + hdr + 1 + nlen };
  };
  const readProps = (off, n) => {
    const vals = [];
    for (let i = 0; i < n; i++) {
      const t = String.fromCharCode(u8[off]); off++;
      if (t === 'S' || t === 'R') { const l = dv.getUint32(off, true); vals.push(t === 'S' ? String.fromCharCode(...u8.subarray(off + 4, off + 4 + l)) : null); off += 4 + l; }
      else if (t === 'D') { vals.push(dv.getFloat64(off, true)); off += 8; }
      else if (t === 'F') { vals.push(dv.getFloat32(off, true)); off += 4; }
      else if (t === 'I') { vals.push(dv.getInt32(off, true)); off += 4; }
      else if (t === 'L') { vals.push(Number(dv.getBigInt64(off, true))); off += 8; }
      else if (t === 'Y') { vals.push(dv.getInt16(off, true)); off += 2; }
      else if (t === 'C') { vals.push(u8[off]); off += 1; }
      else return { vals, off: -1 };
    }
    return { vals, off };
  };
  let off = 27;
  while (off < u8.length - 13) {
    const h = readHeader(off);
    if (h.end === 0) break;
    if (h.name === 'GlobalSettings') {
      let c = readProps(h.propsAt, h.nprops).off;
      while (c > 0 && c < h.end - 13) {
        const ch = readHeader(c);
        if (ch.end === 0) break;
        if (ch.name === 'Properties70') {
          let p = readProps(ch.propsAt, ch.nprops).off;
          while (p > 0 && p < ch.end - 13) {
            const ph = readHeader(p);
            if (ph.end === 0) break;
            const { vals } = readProps(ph.propsAt, ph.nprops);
            if (vals[0] === 'UnitScaleFactor') return vals[4];
            p = ph.end;
          }
        }
        c = ch.end;
      }
      return null;
    }
    off = h.end;
  }
  return null;
}

export function writeOBJ(objects, opt) {
  const s = opt.scale ?? 1;
  const lines = ['# Poly Budget', `mtllib ${opt.mtlName}`];
  const mtl = ['# Poly Budget'];
  const seenMat = new Set();
  let base = 1;
  for (const o of objects) {
    lines.push(`o ${o.name}`);
    const n = o.positions.length / 3;
    for (let i = 0; i < n; i++) lines.push(`v ${(o.positions[i * 3] * s).toFixed(6)} ${(o.positions[i * 3 + 1] * s).toFixed(6)} ${(o.positions[i * 3 + 2] * s).toFixed(6)}`);
    if (o.uvs) for (let i = 0; i < n; i++) lines.push(`vt ${o.uvs[i * 2].toFixed(6)} ${o.uvs[i * 2 + 1].toFixed(6)}`);
    for (let i = 0; i < n; i++) lines.push(`vn ${o.normals[i * 3].toFixed(5)} ${o.normals[i * 3 + 1].toFixed(5)} ${o.normals[i * 3 + 2].toFixed(5)}`);
    let current = -1;
    for (const p of polygonsOf(o)) {
      const m = o.triMat[p.tri] ?? 0;
      if (m !== current && o.materials[m]) { lines.push(`usemtl ${o.materials[m].name}`); current = m; }
      const f = p.corners.map(c => { const v = c + base; return o.uvs ? `${v}/${v}/${v}` : `${v}//${v}`; });
      lines.push(`f ${f.join(' ')}`);
    }
    for (const m of o.materials) {
      if (!m || seenMat.has(m.name)) continue;
      seenMat.add(m.name);
      const c = m.color || [0.8, 0.8, 0.8];
      mtl.push(`newmtl ${m.name}`, `Kd ${c.map(x => x.toFixed(4)).join(' ')}`);
      if (m.texture) mtl.push(`map_Kd ${m.texture}`);
      if (m.normal) mtl.push(`norm ${m.normal}`);
    }
    base += n;
  }
  return { obj: lines.join('\n') + '\n', mtl: mtl.join('\n') + '\n' };
}

// ---------- UV fit ----------
// Calls visit(texel) for every texel centre inside the triangle; coordinates are in texels.
function rasterTri(ax, ay, bx, by, cx, cy, W, H, visit) {
  const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5)), x1 = Math.min(W - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
  const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5)), y1 = Math.min(H - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
  if (x0 > x1 || y0 > y1) return;
  const s = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay) > 0 ? 1 : -1;
  for (let j = y0; j <= y1; j++) {
    const py = j + 0.5;
    for (let i = x0; i <= x1; i++) {
      const px = i + 0.5;
      if (((bx - px) * (cy - py) - (cx - px) * (by - py)) * s < 0) continue;
      if (((cx - px) * (ay - py) - (ax - px) * (cy - py)) * s < 0) continue;
      if (((ax - px) * (by - py) - (bx - px) * (ay - py)) * s < 0) continue;
      visit(j * W + i);
    }
  }
}

// A triangle's UVs in texels, moved into the first tile when the UVs repeat.
function uvTexels(uv, a, b, c, res, out) {
  const ou = Math.floor(Math.min(uv[a * 2], uv[b * 2], uv[c * 2])), ov = Math.floor(Math.min(uv[a * 2 + 1], uv[b * 2 + 1], uv[c * 2 + 1]));
  out[0] = (uv[a * 2] - ou) * res; out[1] = (uv[a * 2 + 1] - ov) * res;
  out[2] = (uv[b * 2] - ou) * res; out[3] = (uv[b * 2 + 1] - ov) * res;
  out[4] = (uv[c * 2] - ou) * res; out[5] = (uv[c * 2 + 1] - ov) * res;
}

// Which UV island each texel of the original layout belongs to (-1: none).
export function uvOwnership(mesh, res = 1024) {
  const owner = new Int32Array(res * res).fill(-1);
  const uv = mesh.uvs, idx = mesh.index, isl = mesh.uvIsland, t6 = new Float64Array(6);
  for (let t = 0; t < idx.length; t += 3) {
    const island = isl[idx[t]];
    uvTexels(uv, idx[t], idx[t + 1], idx[t + 2], res, t6);
    rasterTri(t6[0], t6[1], t6[2], t6[3], t6[4], t6[5], res, res, k => { owner[k] = island; });
  }
  return { owner, res };
}

// Share of the texels under a mesh's triangles that belong to another island than the triangle's own.
// srcId maps the mesh's vertices to the welded vertices whose islands are known (null: same vertices).
export function uvMisplaced(own, islands, uv, index, srcId) {
  const { owner, res } = own, t6 = new Float64Array(6);
  let total = 0, good = 0, island = 0;
  const visit = k => { total++; if (owner[k] === island) good++; };
  for (let t = 0; t < index.length; t += 3) {
    island = islands[srcId ? srcId[index[t]] : index[t]];
    uvTexels(uv, index[t], index[t + 1], index[t + 2], res, t6);
    rasterTri(t6[0], t6[1], t6[2], t6[3], t6[4], t6[5], res, res, visit);
  }
  return total ? 1 - good / total : 0;
}

// How far a reduced result's original UVs drift into other islands, net of any overlap the source layout already has.
function measureUVFit(ctx, result) {
  const t0 = Date.now();
  if (!ctx.mesh.uvIsland) {
    const uf = new UnionFind(ctx.mesh.vertexCount), idx = ctx.mesh.index;
    for (let t = 0; t < idx.length; t += 3) { uf.union(idx[t], idx[t + 1]); uf.union(idx[t + 1], idx[t + 2]); }
    ctx.mesh.uvIsland = uf.labels(ctx.mesh.vertexCount).labels;
  }
  if (!ctx.own) {
    ctx.own = uvOwnership(ctx.mesh);
    ctx.ownBase = uvMisplaced(ctx.own, ctx.mesh.uvIsland, ctx.mesh.uvs, ctx.mesh.index, null);
  }
  const m = uvMisplaced(ctx.own, ctx.mesh.uvIsland, result.uvs, result.index, result.srcId);
  return { misplaced: Math.max(0, (m - ctx.ownBase) / Math.max(1e-6, 1 - ctx.ownBase)), raw: m, base: ctx.ownBase, ms: Date.now() - t0 };
}

// A mesh's layout in UV space, for drawing it: every edge once, and the seams (edges only one triangle uses: UV island
// borders and open borders), as pairs of vertex indices into mesh.uvs. Vertices at the same place with the same UV
// count as one, so an edge that is only split for its normals isn't taken for a seam, while islands that are stacked
// in UV space (mirrored halves) keep their own borders. keep(t) picks triangles; triEnd stops early (a mirrored
// result's own half). The diagonals of quads (mesh.quad) are left out.
export function uvEdges(mesh, keep = null, triEnd = mesh.index.length / 3) {
  const f32 = a => (a instanceof Float32Array ? a : Float32Array.from(a));
  const P = f32(mesh.positions), UV = f32(mesh.uvs), idx = mesh.index, V = UV.length / 2;
  const pb = new Int32Array(P.buffer, P.byteOffset, P.length), ub = new Int32Array(UV.buffer, UV.byteOffset, UV.length);
  const { group, count: G } = groupBy(V, 5, (i, out) => {
    out[0] = ub[i * 2]; out[1] = ub[i * 2 + 1]; out[2] = pb[i * 3]; out[3] = pb[i * 3 + 1]; out[4] = pb[i * 3 + 2];
  });
  const rep = new Int32Array(G).fill(-1);
  for (let i = 0; i < V; i++) if (rep[group[i]] < 0) rep[group[i]] = i;
  // A quad's diagonal (the edge its two triangles share) is not drawn.
  const pair = mesh.quad || null;
  const diagonal = (t, a, b) => {
    if (!pair || !pair[t]) return false;
    const p = pair[t] === 1 ? t + 1 : t - 1;
    const g0 = group[idx[p * 3]], g1 = group[idx[p * 3 + 1]], g2 = group[idx[p * 3 + 2]];
    return (a === g0 || a === g1 || a === g2) && (b === g0 || b === g1 || b === g2);
  };
  // Half-edges bucketed by their lower end, then sorted within each (small) bucket so equal edges sit together.
  const start = new Uint32Array(G + 1);
  const visit = fn => {
    for (let t = 0; t < triEnd; t++) {
      if (keep && !keep(t)) continue;
      for (let k = 0; k < 3; k++) {
        const a = group[idx[t * 3 + k]], b = group[idx[t * 3 + ((k + 1) % 3)]];
        if (a !== b && !diagonal(t, a, b)) fn(a < b ? a : b, a < b ? b : a);
      }
    }
  };
  visit(lo => { start[lo + 1]++; });
  for (let g = 0; g < G; g++) start[g + 1] += start[g];
  const hi = new Uint32Array(start[G]), fill = start.slice(0, G);
  visit((lo, h) => { hi[fill[lo]++] = h; });
  let edges = 0, seams = 0;
  for (let g = 0; g < G; g++) {
    const s = start[g], e = start[g + 1];
    for (let i = s + 1; i < e; i++) {
      const x = hi[i];
      let j = i - 1;
      while (j >= s && hi[j] > x) { hi[j + 1] = hi[j]; j--; }
      hi[j + 1] = x;
    }
    for (let i = s; i < e;) {
      let j = i + 1;
      while (j < e && hi[j] === hi[i]) j++;
      edges++;
      if (j - i === 1) seams++;
      i = j;
    }
  }
  const E = new Uint32Array(edges * 2), S = new Uint32Array(seams * 2);
  let ne = 0, ns = 0;
  for (let g = 0; g < G; g++) {
    const e = start[g + 1];
    for (let i = start[g]; i < e;) {
      let j = i + 1;
      while (j < e && hi[j] === hi[i]) j++;
      E[ne++] = rep[g]; E[ne++] = rep[hi[i]];
      if (j - i === 1) { S[ns++] = rep[g]; S[ns++] = rep[hi[i]]; }
      i = j;
    }
  }
  return { edges: E, seams: S };
}

// Merges welded vertices that differ only by UV, so reduction can ignore the old UV seams.
export function stripUVs(mesh, hardAngle = 30) {
  const P = mesh.positions, N = mesh.normals, V = mesh.vertexCount, idx = mesh.index;
  const bits = new Int32Array(P.buffer, P.byteOffset, V * 3);
  const g = groupBy(V, 5, (i, o) => { o[0] = bits[i * 3]; o[1] = bits[i * 3 + 1]; o[2] = bits[i * 3 + 2]; o[3] = mesh.vPart[i]; o[4] = mesh.vMat[i]; });
  const cosHard = Math.cos((hardAngle * Math.PI) / 180);
  const head = new Int32Array(g.count).fill(-1), next = new Int32Array(V), sum = new Float64Array(V * 3), first = new Int32Array(V), of = new Int32Array(V);
  let C = 0;
  for (let i = 0; i < V; i++) {
    const gi = g.group[i], nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    let found = -1;
    for (let c = head[gi]; c !== -1; c = next[c]) {
      const sx = sum[c * 3], sy = sum[c * 3 + 1], sz = sum[c * 3 + 2], l = Math.hypot(sx, sy, sz);
      if (l === 0 || (sx * nx + sy * ny + sz * nz) / l >= cosHard) { found = c; break; }
    }
    if (found < 0) { found = C++; next[found] = head[gi]; head[gi] = found; first[found] = i; }
    sum[found * 3] += nx; sum[found * 3 + 1] += ny; sum[found * 3 + 2] += nz;
    of[i] = found;
  }
  const positions = new Float32Array(C * 3), normals = new Float32Array(C * 3), colors = mesh.colors ? new Float32Array(C * 3) : null;
  const vPart = new Uint16Array(C), vMat = new Uint16Array(C), rep = first.slice(0, C);
  for (let c = 0; c < C; c++) {
    const r = rep[c], l = Math.hypot(sum[c * 3], sum[c * 3 + 1], sum[c * 3 + 2]) || 1;
    for (let k = 0; k < 3; k++) { positions[c * 3 + k] = P[r * 3 + k]; normals[c * 3 + k] = sum[c * 3 + k] / l; }
    if (colors) for (let k = 0; k < 3; k++) colors[c * 3 + k] = mesh.colors[r * 3 + k];
    vPart[c] = mesh.vPart[r]; vMat[c] = mesh.vMat[r];
  }
  const tmp = new Uint32Array(idx.length);
  let n = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = of[idx[t]], b = of[idx[t + 1]], c = of[idx[t + 2]];
    if (a === b || b === c || a === c) continue;
    tmp[n++] = a; tmp[n++] = b; tmp[n++] = c;
  }
  return { mesh: { positions, normals, uvs: null, colors, index: tmp.slice(0, n), vPart, vMat, vertexCount: C }, rep, of };
}

// ---------- new UVs ----------
// Linear texel density per painted label, so More ×2/×4/×8 areas also get 2/4/8× the texels.
const TEXEL_DENSITY = { 0: 1, 1: Math.SQRT2, 2: 2, 3: 2 * Math.SQRT2, '-1': Math.SQRT1_2, '-2': 0.5, '-3': 0.5 * Math.SQRT1_2, 100: 2 * Math.SQRT2 };

function faceDensity(mesh, labels) {
  if (!labels) return null;
  const idx = mesh.index, T = idx.length / 3, out = new Float32Array(T), src = mesh.srcId;
  let any = false;
  for (let t = 0; t < T; t++) {
    const a = labels[src[idx[t * 3]]], b = labels[src[idx[t * 3 + 1]]], c = labels[src[idx[t * 3 + 2]]];
    const l = a === b || a === c ? a : b === c ? b : 0;
    out[t] = TEXEL_DENSITY[l] ?? 1;
    if (l) any = true;
  }
  return any ? out : null;
}

class MinHeap {
  constructor(cap = 256) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.size = 0; }
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
    const top = this.v[0];
    this.lastKey = this.k[0];
    const n = --this.size;
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

// Least squares conformal map (Lévy et al. 2002), solved with Jacobi-preconditioned CG from the planar start.
// uv holds all u values then all v values; pins stay where the start puts them.
function lscm(n, tris, X, uv, pinA, pinB) {
  const m = tris.length / 3, co = new Float64Array(m * 6), diag = new Float64Array(2 * n);
  for (let t = 0; t < m; t++) {
    const i0 = tris[t * 3] * 3, i1 = tris[t * 3 + 1] * 3, i2 = tris[t * 3 + 2] * 3;
    const e1x = X[i1] - X[i0], e1y = X[i1 + 1] - X[i0 + 1], e1z = X[i1 + 2] - X[i0 + 2];
    const e2x = X[i2] - X[i0], e2y = X[i2 + 1] - X[i0 + 1], e2z = X[i2 + 2] - X[i0 + 2];
    const l1 = Math.hypot(e1x, e1y, e1z);
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x, ln = Math.hypot(nx, ny, nz);
    if (l1 === 0 || ln === 0) continue;
    const ax = e1x / l1, ay = e1y / l1, az = e1z / l1;
    const bx = (ny * az - nz * ay) / ln, by = (nz * ax - nx * az) / ln, bz = (nx * ay - ny * ax) / ln;
    const x1 = l1, x2 = e2x * ax + e2y * ay + e2z * az, y2 = e2x * bx + e2y * by + e2z * bz;
    const s = 1 / Math.sqrt(x1 * y2);
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

// A flattened chart is usable when no triangle flips, no two triangles overlap and texel density stays within 5×.
function chartIsValid(uv, n, tris, area3) {
  const m = tris.length / 3;
  let uvTotal = 0, a3Total = 0;
  const s = new Float64Array(m);
  for (let t = 0; t < m; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    s[t] = (uv[b] - uv[a]) * (uv[n + c] - uv[n + a]) - (uv[c] - uv[a]) * (uv[n + b] - uv[n + a]);
    uvTotal += s[t]; a3Total += area3[t];
  }
  if (!(uvTotal > 0)) return false;
  let stretched = 0;
  for (let t = 0; t < m; t++) {
    if (area3[t] <= a3Total * 1e-9) continue;
    if (s[t] <= 0) return false;
    const ratio = (s[t] / uvTotal) / (area3[t] / a3Total);
    if (ratio < 0.2 || ratio > 5) stretched += area3[t];
  }
  if (stretched > a3Total * 0.02) return false;
  if (m < 4) return true;
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (let i = 0; i < n; i++) {
    if (uv[i] < minU) minU = uv[i]; if (uv[i] > maxU) maxU = uv[i];
    if (uv[n + i] < minV) minV = uv[n + i]; if (uv[n + i] > maxV) maxV = uv[n + i];
  }
  let cell = Math.sqrt(uvTotal / 2 / (m * 4));
  if (!(cell > 0)) return true;
  let W = Math.ceil((maxU - minU) / cell) + 1, H = Math.ceil((maxV - minV) / cell) + 1;
  if (W * H > 4e6) { const f = Math.sqrt((W * H) / 4e6); cell *= f; W = Math.ceil((maxU - minU) / cell) + 1; H = Math.ceil((maxV - minV) / cell) + 1; }
  const grid = new Uint8Array(W * H);
  for (let t = 0; t < m; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    const ax = (uv[a] - minU) / cell, ay = (uv[n + a] - minV) / cell, bx = (uv[b] - minU) / cell, by = (uv[n + b] - minV) / cell;
    const cx = (uv[c] - minU) / cell, cy = (uv[n + c] - minV) / cell;
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5)), x1 = Math.min(W - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5)), y1 = Math.min(H - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    for (let j = y0; j <= y1; j++) {
      const py = j + 0.5;
      for (let i = x0; i <= x1; i++) {
        const px = i + 0.5;
        if ((bx - px) * (cy - py) - (cx - px) * (by - py) <= 0) continue;
        if ((cx - px) * (ay - py) - (ax - px) * (cy - py) <= 0) continue;
        if ((ax - px) * (by - py) - (bx - px) * (ay - py) <= 0) continue;
        if (grid[j * W + i]) return false;
        grid[j * W + i] = 1;
      }
    }
  }
  return true;
}

// Rotation (radians) that gives the smallest bounding box, from the convex hull's edge directions.
function minBoxAngle(pts, n) {
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => pts[a * 2] - pts[b * 2] || pts[a * 2 + 1] - pts[b * 2 + 1]);
  const cross = (o, a, b) => (pts[a * 2] - pts[o * 2]) * (pts[b * 2 + 1] - pts[o * 2 + 1]) - (pts[a * 2 + 1] - pts[o * 2 + 1]) * (pts[b * 2] - pts[o * 2]);
  const hull = [];
  for (const i of order) { while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], i) <= 0) hull.pop(); hull.push(i); }
  const lower = hull.length + 1;
  for (let k = order.length - 2; k >= 0; k--) { const i = order[k]; while (hull.length >= lower && cross(hull[hull.length - 2], hull[hull.length - 1], i) <= 0) hull.pop(); hull.push(i); }
  hull.pop();
  let best = 0, bestArea = Infinity;
  for (let e = 0; e < hull.length; e++) {
    const a = hull[e], b = hull[(e + 1) % hull.length];
    const ang = Math.atan2(pts[b * 2 + 1] - pts[a * 2 + 1], pts[b * 2] - pts[a * 2]);
    const cs = Math.cos(-ang), sn = Math.sin(-ang);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const h of hull) {
      const x = pts[h * 2] * cs - pts[h * 2 + 1] * sn, y = pts[h * 2] * sn + pts[h * 2 + 1] * cs;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const a2 = (x1 - x0) * (y1 - y0);
    if (a2 < bestArea) { bestArea = a2; best = -ang; }
  }
  return best;
}

// Marks every cell a chart touches at the given scale, grown by pad cells so neighbours keep their distance.
function chartMask(c, sigma, pad) {
  const w = Math.ceil(c.w * sigma) + 2 * pad + 1, h = Math.ceil(c.h * sigma) + 2 * pad + 1;
  const bits = new Uint8Array(w * h), uv = c.uv, tris = c.tris;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 2, b = tris[t + 1] * 2, cc = tris[t + 2] * 2;
    let ax = uv[a] * sigma + pad, ay = uv[a + 1] * sigma + pad, bx = uv[b] * sigma + pad, by = uv[b + 1] * sigma + pad;
    const cx = uv[cc] * sigma + pad, cy = uv[cc + 1] * sigma + pad;
    if ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay) < 0) { let tx = ax; ax = bx; bx = tx; tx = ay; ay = by; by = tx; }
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), i1 = Math.min(w - 1, Math.floor(Math.max(ax, bx, cx)));
    const j0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), j1 = Math.min(h - 1, Math.floor(Math.max(ay, by, cy)));
    const ex = [ax, bx, cx], ey = [ay, by, cy];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      let inside = true;
      for (let e = 0; e < 3 && inside; e++) {
        const px = ex[e], py = ey[e], qx = ex[(e + 1) % 3], qy = ey[(e + 1) % 3];
        const dx = qx - px, dy = qy - py;
        const f = (x, y) => dx * (y - py) - dy * (x - px);
        if (f(i, j) < 0 && f(i + 1, j) < 0 && f(i, j + 1) < 0 && f(i + 1, j + 1) < 0) inside = false;
      }
      if (inside) bits[j * w + i] = 1;
    }
  }
  if (pad > 0) {
    const tmp = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      if (!bits[j * w + i]) continue;
      for (let d = Math.max(0, i - pad); d <= Math.min(w - 1, i + pad); d++) tmp[j * w + d] = 1;
    }
    bits.fill(0);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      if (!tmp[j * w + i]) continue;
      for (let d = Math.max(0, j - pad); d <= Math.min(h - 1, j + pad); d++) bits[d * w + i] = 1;
    }
  }
  return { w, h, bits };
}

// Bottom and top occupied row per column of a mask turned by r quarter turns (-1: empty column).
function maskProfiles(mask, r) {
  const { w, h, bits } = mask, W = r & 1 ? h : w;
  const bottom = new Int32Array(W).fill(-1), top = new Int32Array(W).fill(-1);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!bits[j * w + i]) continue;
    const x = r === 0 ? i : r === 1 ? h - 1 - j : r === 2 ? w - 1 - i : j;
    const y = r === 0 ? j : r === 1 ? i : r === 2 ? h - 1 - j : w - 1 - i;
    if (bottom[x] < 0 || y < bottom[x]) bottom[x] = y;
    if (y > top[x]) top[x] = y;
  }
  return { bottom, top, W };
}

// Drops each chart onto a skyline G cells wide (largest first), choosing the position and turn that stays lowest.
function skylinePack(charts, order, sigma, G, pad) {
  const sky = new Int32Array(G), place = new Array(charts.length);
  for (const ci of order) {
    const mask = chartMask(charts[ci], sigma, pad);
    if (Math.min(mask.w, mask.h) > G) return null;
    let best = Infinity, bx = 0, by = 0, br = 0, bp = null;
    for (let r = 0; r < 4; r++) {
      if ((r & 1 ? mask.h : mask.w) > G) continue;
      const pr = maskProfiles(mask, r), { bottom, top, W } = pr;
      for (let x = 0; x + W <= G; x++) {
        let y = 0;
        for (let i = 0; i < W; i++) if (bottom[i] >= 0 && sky[x + i] - bottom[i] > y) y = sky[x + i] - bottom[i];
        let peak = 0, waste = 0;
        for (let i = 0; i < W; i++) {
          if (bottom[i] < 0) continue;
          waste += y + bottom[i] - sky[x + i];
          if (y + top[i] + 1 > peak) peak = y + top[i] + 1;
        }
        const score = peak + waste / W;
        if (score < best) { best = score; bx = x; by = y; br = r; bp = pr; }
      }
    }
    for (let i = 0; i < bp.W; i++) if (bp.bottom[i] >= 0) sky[bx + i] = Math.max(sky[bx + i], by + bp.top[i] + 1);
    place[ci] = { x: bx, y: by, r: br, w: mask.w, h: mask.h };
  }
  let height = 0;
  for (let i = 0; i < G; i++) if (sky[i] > height) height = sky[i];
  return { height, place };
}

// Scales the charts of one atlas to the largest size whose packing still fits the square, then writes their UVs.
function packAtlas(charts, G, pad) {
  let total = 0;
  for (const c of charts) total += c.area;
  const order = charts.map((_, i) => i).sort((a, b) => charts[b].w * charts[b].h - charts[a].w * charts[a].h);
  let sigma = Math.sqrt((0.55 * G * G) / Math.max(total, 1e-30)), best = null, fail = Infinity;
  for (let it = 0; it < 12; it++) {
    const res = skylinePack(charts, order, sigma, G, pad);
    if (res && res.height <= G) {
      if (!best || sigma > best.sigma) best = { sigma, res };
      if (res.height > G * 0.985 || sigma * 1.005 >= fail) break;
      sigma = Math.min(sigma * Math.min(1.3, Math.sqrt(G / res.height)), (sigma + fail) / 2);
    } else {
      fail = Math.min(fail, sigma);
      sigma = best ? (best.sigma + sigma) / 2 : sigma * (res ? Math.max(0.6, Math.sqrt(G / res.height) * 0.97) : 0.7);
    }
  }
  for (let guard = 0; !best && guard < 30; guard++) {
    sigma *= 0.75;
    const res = skylinePack(charts, order, sigma, G, pad);
    if (res && res.height <= G) best = { sigma, res };
  }
  const s = best.sigma;
  charts.forEach((c, ci) => {
    const p = best.res.place[ci], uv = c.uv;
    for (let i = 0; i < c.n; i++) {
      const cx = uv[i * 2] * s + pad, cy = uv[i * 2 + 1] * s + pad;
      const x = p.r === 0 ? cx : p.r === 1 ? p.h - cy : p.r === 2 ? p.w - cx : cy;
      const y = p.r === 0 ? cy : p.r === 1 ? cx : p.r === 2 ? p.h - cy : p.w - cx;
      uv[i * 2] = (p.x + x) / G;
      uv[i * 2 + 1] = (p.y + y) / G;
    }
  });
  return (total * s * s) / (G * G);
}

// Gives a finalized mesh new, non-overlapping UVs: charts grown by normal direction, flattened with LSCM
// (split in two whenever that flips, overlaps or stretches), then packed per material into [0,1].
// opt: { size: texture px, density: per-face texel density multiplier, maxAngle }.
export function unwrap(mesh, opt = {}) {
  const P = mesh.positions, idx = mesh.index, T = idx.length / 3, V = mesh.vertexCount;
  const size = opt.size || 1024, G = Math.min(512, Math.max(64, size >> 1)), pad = 1;
  const dens = opt.density || null;
  const cosMax = Math.cos(((opt.maxAngle ?? 60) * Math.PI) / 180), cosCrease = Math.cos(((opt.crease ?? 75) * Math.PI) / 180), cosMerge = Math.cos((80 * Math.PI) / 180);
  const bits = new Int32Array(P.buffer, P.byteOffset, V * 3);
  const pg = groupBy(V, 3, (i, o) => { o[0] = bits[i * 3]; o[1] = bits[i * 3 + 1]; o[2] = bits[i * 3 + 2]; });
  const pid = pg.group, NP = pg.count;

  const fn = new Float64Array(T * 3), area = new Float64Array(T);
  let totalArea = 0;
  for (let t = 0; t < T; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
    area[t] = l / 2;
    totalArea += l / 2;
    if (l > 0) { fn[t * 3] = nx / l; fn[t * 3 + 1] = ny / l; fn[t * 3 + 2] = nz / l; }
  }
  const tiny = totalArea * 1e-12;
  // The two triangles of a quad (mesh.quad) always share a chart, so the quad keeps one set of UVs.
  const pair = mesh.quad || null;
  const partner = t => (!pair ? -1 : pair[t] === 1 ? t + 1 : pair[t] === 2 ? t - 1 : -1);
  if (pair && dens) for (let t = 0; t + 1 < T; t++) if (pair[t] === 1) dens[t + 1] = dens[t];
  const groupOf = t => mesh.vMat[idx[t * 3]] * 65536 + mesh.vPart[idx[t * 3]];
  const dot = (t, u) => fn[t * 3] * fn[u * 3] + fn[t * 3 + 1] * fn[u * 3 + 1] + fn[t * 3 + 2] * fn[u * 3 + 2];

  // Faces are neighbours across a shared, consistently wound edge within one part, material and density.
  const adj = new Int32Array(T * 3).fill(-1), edges = new Map();
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const a = pid[idx[t * 3 + k]], b = pid[idx[t * 3 + ((k + 1) % 3)]];
    if (a === b) continue;
    const key = a < b ? a * NP + b : b * NP + a;
    const h = edges.get(key);
    if (h === undefined) { edges.set(key, t * 3 + k); continue; }
    edges.set(key, -1);
    if (h < 0) continue;
    const t2 = (h / 3) | 0;
    if (pid[idx[h]] !== b || groupOf(t) !== groupOf(t2) || (dens && dens[t] !== dens[t2])) continue;
    if (area[t] > tiny && area[t2] > tiny && dot(t, t2) < cosCrease) continue;
    adj[t * 3 + k] = t2;
    adj[h] = t;
  }
  if (pair) {
    for (let t = 0; t + 1 < T; t++) {
      if (pair[t] !== 1) continue;
      const u = t + 1;
      for (let k = 0; k < 3; k++) {
        const a = pid[idx[t * 3 + k]], b = pid[idx[t * 3 + ((k + 1) % 3)]];
        for (let j = 0; j < 3; j++) {
          const c = pid[idx[u * 3 + j]], d = pid[idx[u * 3 + ((j + 1) % 3)]];
          if (a === d && b === c) { adj[t * 3 + k] = u; adj[u * 3 + j] = t; }
        }
      }
    }
  }

  // Grow charts from the largest faces, always taking the neighbour closest to the chart's mean normal.
  let chart = new Int32Array(T).fill(-1);
  const order = new Uint32Array(T);
  for (let t = 0; t < T; t++) order[t] = t;
  order.sort((a, b) => area[b] - area[a]);
  const heap = new MinHeap();
  let C = 0;
  for (let s = 0; s < T; s++) {
    const seed = order[s];
    if (chart[seed] >= 0) continue;
    const c = C++;
    let sx = 0, sy = 0, sz = 0;
    heap.size = 0;
    heap.push(0, seed);
    while (heap.size) {
      const f = heap.pop(), key = heap.lastKey;
      if (chart[f] >= 0) continue;
      const l = Math.hypot(sx, sy, sz);
      if (l > 0 && area[f] > tiny) {
        const d = (fn[f * 3] * sx + fn[f * 3 + 1] * sy + fn[f * 3 + 2] * sz) / l;
        if (d < cosMax) continue;
        if (1 - d > key + 0.02 && heap.size && heap.k[0] < 1 - d) { heap.push(1 - d, f); continue; }
      }
      const mate = partner(f), members = mate >= 0 && chart[mate] < 0 ? [f, mate] : [f];
      for (const m of members) {
        chart[m] = c;
        sx += fn[m * 3] * area[m]; sy += fn[m * 3 + 1] * area[m]; sz += fn[m * 3 + 2] * area[m];
      }
      const ll = Math.hypot(sx, sy, sz) || 1;
      for (const m of members) {
        for (let k = 0; k < 3; k++) {
          const g = adj[m * 3 + k];
          if (g < 0 || chart[g] >= 0) continue;
          heap.push(area[g] > tiny ? 1 - (fn[g * 3] * sx + fn[g * 3 + 1] * sy + fn[g * 3 + 2] * sz) / ll : 0, g);
        }
      }
    }
  }

  // Merge neighbouring charts, longest shared boundary first, while all their faces stay within the merge cone;
  // one- and two-face slivers may bend a little further.
  const faceLists = Array.from({ length: C }, () => []);
  for (let t = 0; t < T; t++) faceLists[chart[t]].push(t);
  const sum = new Float64Array(C * 3);
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) sum[chart[t] * 3 + k] += fn[t * 3 + k] * area[t];
  const shared = new Map();
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const g = adj[t * 3 + k];
    if (g < 0 || chart[g] === chart[t]) continue;
    const a = Math.min(chart[t], chart[g]), b = Math.max(chart[t], chart[g]), key = a * C + b;
    shared.set(key, (shared.get(key) || 0) + 1);
  }
  const pairs = [...shared.entries()].sort((x, y) => y[1] - x[1]);
  const uf = new UnionFind(C);
  const cosCone = Math.cos(((opt.mergeAngle ?? 66) * Math.PI) / 180);
  for (const [key] of pairs) {
    const a = uf.find(Math.floor(key / C)), b = uf.find(key % C);
    if (a === b) continue;
    const nx = sum[a * 3] + sum[b * 3], ny = sum[a * 3 + 1] + sum[b * 3 + 1], nz = sum[a * 3 + 2] + sum[b * 3 + 2];
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 0)) continue;
    const small = faceLists[a].length <= 2 || faceLists[b].length <= 2;
    const limit = small ? cosMerge : cosCone;
    let ok = true;
    for (const list of [faceLists[a], faceLists[b]]) {
      for (const f of list) {
        if (area[f] > tiny && (fn[f * 3] * nx + fn[f * 3 + 1] * ny + fn[f * 3 + 2] * nz) / l < limit) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (!ok) continue;
    uf.union(a, b);
    const r = uf.find(a), o = r === a ? b : a;
    for (const f of faceLists[o]) faceLists[r].push(f);
    faceLists[o] = [];
    sum[r * 3] = nx; sum[r * 3 + 1] = ny; sum[r * 3 + 2] = nz;
  }
  const merged = uf.labels(C);
  const lists = faceLists.filter(l => l.length);

  // Flatten each chart; split it along its longest axis until every piece flattens cleanly.
  const stamp = new Int32Array(NP).fill(-1), localOf = new Int32Array(NP), inPart = new Int32Array(T).fill(-1);
  let stampId = 0, partId = 0, splits = 0;
  const done = [], queue = lists;
  const split = faces => {
    let mx = 0, my = 0, mz = 0, w = 0;
    const cen = new Float64Array(faces.length * 3);
    faces.forEach((f, i) => {
      for (let k = 0; k < 3; k++) {
        const v = idx[f * 3 + k] * 3;
        cen[i * 3] += P[v] / 3; cen[i * 3 + 1] += P[v + 1] / 3; cen[i * 3 + 2] += P[v + 2] / 3;
      }
      const a = area[f] + tiny;
      mx += cen[i * 3] * a; my += cen[i * 3 + 1] * a; mz += cen[i * 3 + 2] * a; w += a;
    });
    mx /= w; my /= w; mz /= w;
    const cov = [0, 0, 0, 0, 0, 0];
    faces.forEach((f, i) => {
      const x = cen[i * 3] - mx, y = cen[i * 3 + 1] - my, z = cen[i * 3 + 2] - mz, a = area[f] + tiny;
      cov[0] += x * x * a; cov[1] += x * y * a; cov[2] += x * z * a; cov[3] += y * y * a; cov[4] += y * z * a; cov[5] += z * z * a;
    });
    let ax = 1, ay = 0.7, az = 0.3;
    for (let it = 0; it < 24; it++) {
      const nx = cov[0] * ax + cov[1] * ay + cov[2] * az, ny = cov[1] * ax + cov[3] * ay + cov[4] * az, nz = cov[2] * ax + cov[4] * ay + cov[5] * az;
      const l = Math.hypot(nx, ny, nz) || 1;
      ax = nx / l; ay = ny / l; az = nz / l;
    }
    const proj = faces.map((f, i) => (cen[i * 3] - mx) * ax + (cen[i * 3 + 1] - my) * ay + (cen[i * 3 + 2] - mz) * az);
    const sorted = faces.map((_, i) => i).sort((a, b) => proj[a] - proj[b]);
    let acc = 0, cut = sorted.length >> 1;
    for (let i = 0; i < sorted.length; i++) { acc += area[faces[sorted[i]]] + tiny; if (acc >= w / 2) { cut = Math.max(1, Math.min(sorted.length - 1, i)); break; } }
    const side = new Map();
    sorted.forEach((i, rank) => side.set(faces[i], rank < cut ? 0 : 1));
    for (const f of faces) { const m = partner(f); if (pair && pair[f] === 1 && side.has(m)) side.set(m, side.get(f)); }
    const pieces = [];
    for (const f of faces) {
      if (inPart[f] === partId) continue;
      const piece = [f], s = side.get(f);
      inPart[f] = partId;
      for (let q = 0; q < piece.length; q++) {
        for (let k = 0; k < 3; k++) {
          const g = adj[piece[q] * 3 + k];
          if (g >= 0 && inPart[g] !== partId && side.get(g) === s) { inPart[g] = partId; piece.push(g); }
        }
      }
      pieces.push(piece);
    }
    partId++;
    return pieces;
  };
  while (queue.length) {
    const faces = queue.pop(), m = faces.length;
    stampId++;
    const verts = [], tris = new Int32Array(m * 3), a3 = new Float64Array(m);
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < m; i++) {
      const f = faces[i];
      a3[i] = area[f];
      nx += fn[f * 3] * area[f]; ny += fn[f * 3 + 1] * area[f]; nz += fn[f * 3 + 2] * area[f];
      for (let k = 0; k < 3; k++) {
        const v = idx[f * 3 + k], p = pid[v];
        if (stamp[p] !== stampId) { stamp[p] = stampId; localOf[p] = verts.length; verts.push(v); }
        tris[i * 3 + k] = localOf[p];
      }
    }
    const n = verts.length;
    let l = Math.hypot(nx, ny, nz);
    if (!(l > 0)) { nx = 0; ny = 0; nz = 1; l = 1; }
    nx /= l; ny /= l; nz /= l;
    const hx = Math.abs(nx) < 0.9 ? 1 : 0, hy = hx ? 0 : 1;
    let e1x = hy * nz, e1y = -hx * nz, e1z = hx * ny - hy * nx;
    const le = Math.hypot(e1x, e1y, e1z);
    e1x /= le; e1y /= le; e1z /= le;
    const e2x = ny * e1z - nz * e1y, e2y = nz * e1x - nx * e1z, e2z = nx * e1y - ny * e1x;
    const X = new Float64Array(n * 3), start = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const v = verts[i] * 3;
      X[i * 3] = P[v]; X[i * 3 + 1] = P[v + 1]; X[i * 3 + 2] = P[v + 2];
      start[i] = P[v] * e1x + P[v + 1] * e1y + P[v + 2] * e1z;
      start[n + i] = P[v] * e2x + P[v + 1] * e2y + P[v + 2] * e2z;
    }
    let uv = start;
    if (m > 1) {
      let pinA = 0, pinB = 0;
      for (let i = 1; i < n; i++) { if (start[i] < start[pinA]) pinA = i; if (start[i] > start[pinB]) pinB = i; }
      const solved = pinA !== pinB ? lscm(n, tris, X, start, pinA, pinB) : start;
      if (chartIsValid(solved, n, tris, a3)) uv = solved;
      else if (!chartIsValid(start, n, tris, a3)) {
        // A chart that won't split any further (one quad) keeps the flattening it has.
        const pieces = split(faces);
        if (pieces.length > 1) { splits++; queue.push(...pieces); continue; }
        uv = solved;
      }
    }
    let uvArea = 0, a3Total = 0;
    for (let t = 0; t < m; t++) {
      const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
      uvArea += Math.abs((uv[b] - uv[a]) * (uv[n + c] - uv[n + a]) - (uv[c] - uv[a]) * (uv[n + b] - uv[n + a])) / 2;
      a3Total += a3[t];
    }
    const scale = (uvArea > 0 ? Math.sqrt(a3Total / uvArea) : 1) * (dens ? dens[faces[0]] : 1);
    const pts = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) { pts[i * 2] = uv[i] * scale; pts[i * 2 + 1] = uv[n + i] * scale; }
    const ang = n >= 3 ? minBoxAngle(pts, n) : 0, cs = Math.cos(ang), sn = Math.sin(ang);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2] * cs - pts[i * 2 + 1] * sn, y = pts[i * 2] * sn + pts[i * 2 + 1] * cs;
      pts[i * 2] = x; pts[i * 2 + 1] = y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    for (let i = 0; i < n; i++) { pts[i * 2] -= x0; pts[i * 2 + 1] -= y0; }
    done.push({ faces, verts, tris, n, uv: pts, w: x1 - x0, h: y1 - y0, area: uvArea * scale * scale, mat: mesh.vMat[idx[faces[0] * 3]] });
  }

  // One atlas per material.
  const byMat = new Map();
  for (const c of done) { if (!byMat.has(c.mat)) byMat.set(c.mat, []); byMat.get(c.mat).push(c); }
  const atlases = [];
  for (const [mat, charts] of byMat) atlases.push({ mat, charts: charts.length, coverage: packAtlas(charts, G, pad) });

  // New vertices: one per source vertex and chart.
  const outIndex = new Uint32Array(T * 3), vStamp = new Int32Array(V).fill(-1), vLocal = new Int32Array(V);
  let cap = Math.max(16, V + (V >> 1)), src = new Uint32Array(cap), uvs = new Float32Array(cap * 2), nOut = 0;
  done.forEach((c, ci) => {
    for (let i = 0; i < c.faces.length; i++) {
      const f = c.faces[i];
      for (let k = 0; k < 3; k++) {
        const v = idx[f * 3 + k];
        if (vStamp[v] !== ci) {
          if (nOut === cap) {
            cap *= 2;
            const s2 = new Uint32Array(cap); s2.set(src); src = s2;
            const u2 = new Float32Array(cap * 2); u2.set(uvs); uvs = u2;
          }
          vStamp[v] = ci;
          vLocal[v] = nOut;
          src[nOut] = v;
          const li = c.tris[i * 3 + k];
          uvs[nOut * 2] = c.uv[li * 2];
          uvs[nOut * 2 + 1] = c.uv[li * 2 + 1];
          nOut++;
        }
        outIndex[f * 3 + k] = vLocal[v];
      }
    }
  });
  const positions = new Float32Array(nOut * 3), normals = new Float32Array(nOut * 3), colors = mesh.colors ? new Float32Array(nOut * 3) : null;
  const vPart = new Uint16Array(nOut), vMat = new Uint16Array(nOut), srcId = new Uint32Array(nOut);
  for (let o = 0; o < nOut; o++) {
    const v = src[o];
    for (let k = 0; k < 3; k++) { positions[o * 3 + k] = P[v * 3 + k]; normals[o * 3 + k] = mesh.normals[v * 3 + k]; }
    if (colors) for (let k = 0; k < 3; k++) colors[o * 3 + k] = mesh.colors[v * 3 + k];
    vPart[o] = mesh.vPart[v]; vMat[o] = mesh.vMat[v]; srcId[o] = mesh.srcId[v];
  }
  const coverage = atlases.reduce((s, a) => s + a.coverage, 0) / Math.max(1, atlases.length);
  return {
    mesh: { positions, normals, uvs: uvs.slice(0, nOut * 2), colors, srcId, index: outIndex, quad: pair, vPart, vMat, vertexCount: nOut, triCount: T },
    info: { charts: done.length, coverage, atlases, size, stats: { grown: C, merged: merged.count, splits } },
  };
}

// ---------- symmetry ----------
// plane: { axis: 0|1|2, offset, keepPositive }. Keeps one side, clipping triangles that cross the plane.
export function cutHalf(mesh, plane) {
  const { axis, offset } = plane;
  const P = mesh.positions, N = mesh.normals, UV = mesh.uvs, COL = mesh.colors;
  const V = mesh.vertexCount, idx = mesh.index, T = idx.length / 3;
  const eps = 1e-5 * bounds(P).diag;
  const off32 = Math.fround(offset);
  const sgn = plane.keepPositive ? 1 : -1;
  const sd = new Float64Array(V);
  for (let v = 0; v < V; v++) {
    const d = (P[v * 3 + axis] - offset) * sgn;
    sd[v] = Math.abs(d) <= eps ? 0 : d;
  }
  const cutA = [], cutB = [], cutT = [], edgeMap = new Map();
  const cutVertex = (a, b) => {
    const key = a < b ? a * V + b : b * V + a;
    let id = edgeMap.get(key);
    if (id === undefined) {
      id = V + cutA.length;
      edgeMap.set(key, id);
      cutA.push(a); cutB.push(b); cutT.push(sd[a] / (sd[a] - sd[b]));
    }
    return id;
  };
  const out = [], triSrc = [];
  const poly = [0, 0, 0, 0], vs = [0, 0, 0], ds = [0, 0, 0];
  let inPlane = 0;
  for (let t = 0; t < T; t++) {
    vs[0] = idx[t * 3]; vs[1] = idx[t * 3 + 1]; vs[2] = idx[t * 3 + 2];
    ds[0] = sd[vs[0]]; ds[1] = sd[vs[1]]; ds[2] = sd[vs[2]];
    if (ds[0] >= 0 && ds[1] >= 0 && ds[2] >= 0) {
      if (ds[0] === 0 && ds[1] === 0 && ds[2] === 0) { inPlane++; continue; }
      out.push(vs[0], vs[1], vs[2]);
      triSrc.push(t);
      continue;
    }
    if (ds[0] <= 0 && ds[1] <= 0 && ds[2] <= 0) continue;
    let n = 0;
    for (let k = 0; k < 3; k++) {
      const c = vs[k], nx = vs[(k + 1) % 3], dc = ds[k], dn = ds[(k + 1) % 3];
      if (dc >= 0) poly[n++] = c;
      if ((dc > 0 && dn < 0) || (dc < 0 && dn > 0)) poly[n++] = cutVertex(c, nx);
    }
    for (let j = 1; j + 1 < n; j++) { out.push(poly[0], poly[j], poly[j + 1]); triSrc.push(t); }
  }
  const total = V + cutA.length;
  const used = new Int32Array(total).fill(-1);
  let n = 0;
  for (let k = 0; k < out.length; k++) if (used[out[k]] < 0) used[out[k]] = n++;
  const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3);
  const uvs = UV ? new Float32Array(n * 2) : null, colors = COL ? new Float32Array(n * 3) : null;
  const vPart = new Uint16Array(n), vMat = new Uint16Array(n), origOf = new Uint32Array(n), onPlane = new Uint8Array(n);
  for (let v = 0; v < total; v++) {
    const o = used[v];
    if (o < 0) continue;
    if (v < V) {
      for (let k = 0; k < 3; k++) { positions[o * 3 + k] = P[v * 3 + k]; normals[o * 3 + k] = N[v * 3 + k]; }
      if (uvs) { uvs[o * 2] = UV[v * 2]; uvs[o * 2 + 1] = UV[v * 2 + 1]; }
      if (colors) for (let k = 0; k < 3; k++) colors[o * 3 + k] = COL[v * 3 + k];
      vPart[o] = mesh.vPart[v]; vMat[o] = mesh.vMat[v]; origOf[o] = v;
      if (sd[v] === 0) { onPlane[o] = 1; positions[o * 3 + axis] = off32; }
      continue;
    }
    const c = v - V, a = cutA[c], b = cutB[c], t = cutT[c];
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < 3; k++) positions[o * 3 + k] = P[a * 3 + k] + (P[b * 3 + k] - P[a * 3 + k]) * t;
    positions[o * 3 + axis] = off32;
    nx = N[a * 3] + (N[b * 3] - N[a * 3]) * t; ny = N[a * 3 + 1] + (N[b * 3 + 1] - N[a * 3 + 1]) * t; nz = N[a * 3 + 2] + (N[b * 3 + 2] - N[a * 3 + 2]) * t;
    const l = Math.hypot(nx, ny, nz) || 1;
    normals[o * 3] = nx / l; normals[o * 3 + 1] = ny / l; normals[o * 3 + 2] = nz / l;
    if (uvs) for (let k = 0; k < 2; k++) uvs[o * 2 + k] = UV[a * 2 + k] + (UV[b * 2 + k] - UV[a * 2 + k]) * t;
    if (colors) for (let k = 0; k < 3; k++) colors[o * 3 + k] = COL[a * 3 + k] + (COL[b * 3 + k] - COL[a * 3 + k]) * t;
    vPart[o] = mesh.vPart[a]; vMat[o] = mesh.vMat[a];
    origOf[o] = sd[a] > 0 ? a : b;
    onPlane[o] = 1;
  }
  const index = new Uint32Array(out.length);
  for (let k = 0; k < out.length; k++) index[k] = used[out[k]];
  return { mesh: { positions, normals, uvs, colors, index, vPart, vMat, vertexCount: n }, origOf, onPlane, inPlane, triSrc: Uint32Array.from(triSrc) };
}

// Mirrors a finalized half across the plane; vertices on the plane are shared by both halves.
export function mirrorMerge(half, plane) {
  const { axis, offset } = plane;
  const off32 = Math.fround(offset);
  const V = half.vertexCount, P = half.positions, N = half.normals;
  const seam = new Uint8Array(V);
  let extra = 0;
  for (let v = 0; v < V; v++) { if (P[v * 3 + axis] === off32) seam[v] = 1; else extra++; }
  const n = V + extra;
  const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3);
  const uvs = half.uvs ? new Float32Array(n * 2) : null, colors = half.colors ? new Float32Array(n * 3) : null;
  const vPart = new Uint16Array(n), vMat = new Uint16Array(n), srcId = new Uint32Array(n), twin = new Int32Array(n);
  positions.set(P); normals.set(N); vPart.set(half.vPart); vMat.set(half.vMat); srcId.set(half.srcId);
  if (uvs) uvs.set(half.uvs);
  if (colors) colors.set(half.colors);
  const mirrorOf = new Uint32Array(V);
  let m = V;
  for (let v = 0; v < V; v++) {
    if (seam[v]) {
      mirrorOf[v] = v;
      twin[v] = v;
      const nx = axis === 0 ? 0 : N[v * 3], ny = axis === 1 ? 0 : N[v * 3 + 1], nz = axis === 2 ? 0 : N[v * 3 + 2];
      const l = Math.hypot(nx, ny, nz);
      if (l > 1e-6) { normals[v * 3] = nx / l; normals[v * 3 + 1] = ny / l; normals[v * 3 + 2] = nz / l; }
      continue;
    }
    mirrorOf[v] = m;
    twin[v] = m;
    twin[m] = v;
    for (let k = 0; k < 3; k++) { positions[m * 3 + k] = P[v * 3 + k]; normals[m * 3 + k] = N[v * 3 + k]; }
    positions[m * 3 + axis] = 2 * offset - P[v * 3 + axis];
    normals[m * 3 + axis] = -N[v * 3 + axis];
    if (uvs) { uvs[m * 2] = half.uvs[v * 2]; uvs[m * 2 + 1] = half.uvs[v * 2 + 1]; }
    if (colors) for (let k = 0; k < 3; k++) colors[m * 3 + k] = half.colors[v * 3 + k];
    vPart[m] = half.vPart[v]; vMat[m] = half.vMat[v]; srcId[m] = half.srcId[v];
    m++;
  }
  const T = half.index.length / 3, src = half.index;
  let keep = 0;
  for (let t = 0; t < T; t++) if (!(seam[src[t * 3]] && seam[src[t * 3 + 1]] && seam[src[t * 3 + 2]])) keep++;
  const index = new Uint32Array(keep * 6), quad = half.quad ? new Uint8Array(keep * 2) : null;
  let o = 0;
  for (let t = 0; t < T; t++) {
    const a = src[t * 3], b = src[t * 3 + 1], c = src[t * 3 + 2];
    if (seam[a] && seam[b] && seam[c]) continue;
    index[o] = a; index[o + 1] = b; index[o + 2] = c;
    index[keep * 3 + o] = mirrorOf[a]; index[keep * 3 + o + 1] = mirrorOf[c]; index[keep * 3 + o + 2] = mirrorOf[b];
    if (quad) quad[o / 3] = quad[keep + o / 3] = half.quad[t];
    o += 3;
  }
  if (quad) validatePairs(quad, keep);
  return { positions, normals, uvs, colors, srcId, twin, index, quad, vPart, vMat, vertexCount: n, halfCount: V, triCount: keep * 2, seamVertices: V - extra, inPlaneDropped: T - keep };
}

// Confirms every vertex has a partner at its mirrored position.
export function checkSymmetry(res, plane) {
  const { axis, offset } = plane;
  const P = res.positions, V = res.vertexCount;
  const b = bounds(P);
  const tol = 1e-5 * b.diag, cell = tol * 4;
  const cellOf = x => Math.floor(x / cell);
  const table = tableFor(V), mask = table.length - 1;
  const kx = new Int32Array(table.length), ky = new Int32Array(table.length), kz = new Int32Array(table.length);
  const next = new Int32Array(V).fill(-1);
  const slot = (cx, cy, cz, insert) => {
    let h = fmix(mix(mix(mix(0x9747b28c, cx), cy), cz)) & mask;
    for (;;) {
      if (table[h] === -1) return insert ? h : -1;
      if (kx[h] === cx && ky[h] === cy && kz[h] === cz) return h;
      h = (h + 1) & mask;
    }
  };
  for (let v = 0; v < V; v++) {
    const cx = cellOf(P[v * 3]), cy = cellOf(P[v * 3 + 1]), cz = cellOf(P[v * 3 + 2]);
    const h = slot(cx, cy, cz, true);
    if (table[h] === -1) { kx[h] = cx; ky[h] = cy; kz[h] = cz; }
    next[v] = table[h];
    table[h] = v;
  }
  let paired = 0, worst = 0;
  const q = [0, 0, 0];
  for (let v = 0; v < V; v++) {
    q[0] = P[v * 3]; q[1] = P[v * 3 + 1]; q[2] = P[v * 3 + 2];
    q[axis] = 2 * offset - q[axis];
    const cx = cellOf(q[0]), cy = cellOf(q[1]), cz = cellOf(q[2]);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const h = slot(cx + dx, cy + dy, cz + dz, false);
      if (h < 0) continue;
      for (let u = table[h]; u !== -1; u = next[u]) {
        const d = Math.hypot(P[u * 3] - q[0], P[u * 3 + 1] - q[1], P[u * 3 + 2] - q[2]);
        if (d < best) best = d;
      }
    }
    if (best <= tol) { paired++; if (best > worst) worst = best; }
  }
  return { paired, total: V, maxError: worst / b.diag };
}

// Vertices on the mesh's open borders, compared by position so UV and normal splits don't count, minus the excluded ones.
function openBorderVertices(mesh, exclude) {
  const P = mesh.positions, V = mesh.vertexCount, idx = mesh.index;
  const bits = new Int32Array(P.buffer, P.byteOffset, V * 3);
  const pg = groupBy(V, 3, (i, o) => { o[0] = bits[i * 3]; o[1] = bits[i * 3 + 1]; o[2] = bits[i * 3 + 2]; });
  const pid = pg.group, NP = pg.count, count = new Map();
  for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = pid[idx[t + k]], b = pid[idx[t + ((k + 1) % 3)]];
    if (a === b) continue;
    const key = a < b ? a * NP + b : b * NP + a;
    count.set(key, (count.get(key) || 0) + 1);
  }
  const onBorder = new Uint8Array(NP);
  for (const [key, c] of count) if (c === 1) { onBorder[Math.floor(key / NP)] = 1; onBorder[key % NP] = 1; }
  const out = new Uint8Array(V);
  for (let v = 0; v < V; v++) if (onBorder[pid[v]] && !(exclude && exclude[v])) out[v] = 1;
  return out;
}

function halfFor(ctx, plane) {
  const key = `${plane.axis}|${plane.offset}|${plane.keepPositive}`;
  if (!ctx.half || ctx.half.key !== key) {
    const cut = cutHalf(ctx.mesh, plane);
    ctx.half = { key, ...cut, packed: packAttributes(cut.mesh) };
  }
  return ctx.half;
}

// The unreduced model with the kept half mirrored over the plane, for previewing.
export function mirrorOriginal(ctx, plane) {
  const H = halfFor(ctx, plane), m = H.mesh;
  return mirrorMerge({ positions: m.positions, normals: m.normals, uvs: m.uvs, colors: m.colors, index: m.index, vPart: m.vPart, vMat: m.vMat, srcId: H.origOf, vertexCount: m.vertexCount }, plane);
}

// Reduces one variant of the mesh (c: { mesh, packed, half }). With unwrapOpt the result gets new UVs;
// under symmetry only the kept half is unwrapped, so its mirror shares the same texture space.
function reduceVariant(S, c, labels, st, fopt, unwrapOpt) {
  const t0 = Date.now();
  const sym = st.symmetry;
  const flatten = fin => {
    if (!unwrapOpt) return { mesh: fin, info: null };
    const t1 = Date.now(), u = unwrap(fin, { ...unwrapOpt, density: faceDensity(fin, labels) });
    u.info.ms = Date.now() - t1;
    return u;
  };
  if (!sym) {
    const red = reduce(S, c.mesh, c.packed, labels, st);
    const u = flatten(finalize(c.mesh, red, { ...fopt, smooth: fopt.normals === 'smooth' ? smoothNormalsOf(c.mesh) : null }));
    return { result: u.mesh, info: { error: red.error, ms: Date.now() - t0, target: red.target, tris: u.mesh.triCount, verts: u.mesh.vertexCount, keepCount: red.keepCount, cat: categorize(red.index, labels), symmetry: null, atlas: u.info } };
  }
  const H = halfFor(c, sym);
  let halfLabels = null;
  if (labels) {
    halfLabels = new Int8Array(H.mesh.vertexCount);
    for (let v = 0; v < halfLabels.length; v++) halfLabels[v] = labels[H.origOf[v]];
  }
  const halfTarget = Math.max(2, Math.round(st.targetTris / 2));
  if (st.lockBorder && !H.border) H.border = openBorderVertices(H.mesh, H.onPlane);
  const red = reduce(S, H.mesh, H.packed, halfLabels, { ...st, targetTris: halfTarget, seam: H.onPlane, border: st.lockBorder ? H.border : null });
  const axis = sym.axis, off32 = Math.fround(sym.offset);
  for (let v = 0; v < H.onPlane.length; v++) if (H.onPlane[v]) red.positions[v * 3 + axis] = off32;
  // The half's smooth normals come from the whole surface, so vertices on the plane see both sides.
  if (fopt.normals === 'smooth' && !H.smooth) {
    const full = smoothNormalsOf(c.mesh);
    H.smooth = new Float32Array(H.mesh.vertexCount * 3);
    for (let v = 0; v < H.mesh.vertexCount; v++) for (let k = 0; k < 3; k++) H.smooth[v * 3 + k] = full[H.origOf[v] * 3 + k];
  }
  const fin = finalize(H.mesh, red, { ...fopt, smooth: fopt.normals === 'smooth' ? H.smooth : null });
  for (let v = 0; v < fin.srcId.length; v++) fin.srcId[v] = H.origOf[fin.srcId[v]];
  const u = flatten(fin);
  const full = mirrorMerge(u.mesh, sym);
  const cat = categorize(red.index, halfLabels);
  for (const k of Object.keys(cat)) cat[k] *= 2;
  const check = checkSymmetry(full, sym);
  check.seamVertices = full.seamVertices;
  return { result: full, info: { error: red.error, ms: Date.now() - t0, target: st.targetTris, tris: full.triCount, verts: full.vertexCount, keepCount: red.keepCount, cat, symmetry: check, atlas: u.info } };
}

// The texture half of New UVs, run after the geometry is already on screen (st.deferUV): unwraps a reduced result.
// Under symmetry it unwraps the kept half (the first halfCount vertices and triCount / 2 triangles that mirrorMerge
// puts first) and mirrors it again, so both halves share the texture space.
export function unwrapResult(mesh, plane, labels, size) {
  const t0 = Date.now();
  let base = mesh;
  if (plane) {
    const V = mesh.halfCount, K = mesh.triCount / 2;
    base = {
      positions: mesh.positions.subarray(0, V * 3), normals: mesh.normals.subarray(0, V * 3), uvs: null,
      colors: mesh.colors ? mesh.colors.subarray(0, V * 3) : null, index: mesh.index.subarray(0, K * 3), quad: mesh.quad ? mesh.quad.subarray(0, K) : null,
      vPart: mesh.vPart.subarray(0, V), vMat: mesh.vMat.subarray(0, V), srcId: mesh.srcId.subarray(0, V), vertexCount: V, triCount: K,
    };
  }
  const u = unwrap(base, { size, density: faceDensity(base, labels) });
  let result = u.mesh, symmetry = null;
  if (plane) {
    result = mirrorMerge(u.mesh, plane);
    symmetry = checkSymmetry(result, plane);
    symmetry.seamVertices = result.seamVertices;
  }
  result.uvLayout = 'new';
  u.info.ms = Date.now() - t0;
  return { result, atlas: u.info, symmetry };
}

// ---------- quad remeshing ----------
// Quads per area in painted regions, as a multiple of the unpainted density. Keep, which can't keep the original
// triangles here, asks for the densest quads.
export const QUAD_DENSITY = { 0: 1, 1: 2, 2: 4, 3: 8, '-1': 0.5, '-2': 0.25, '-3': 0.125, 100: 8 };
// Every separate piece gets at least this many quads (while that takes no more than a fifth of the budget).
const MIN_PIECE_QUADS = 24;

// The welded surface with the vertices that share a position and part merged (UV seams, hard edges and material
// borders no longer cut it), for remeshing. rep: the welded vertex each merged one stands for; triMat: each triangle's
// material; normals: the file's, smooth: the whole surface's smooth normals, both averaged per vertex.
function geometryOf(ctx) {
  if (ctx.geo) return ctx.geo;
  const m = ctx.mesh, V = m.vertexCount, P = m.positions;
  const bits = new Int32Array(P.buffer, P.byteOffset, V * 3);
  const g = groupBy(V, 4, (i, o) => { o[0] = bits[i * 3]; o[1] = bits[i * 3 + 1]; o[2] = bits[i * 3 + 2]; o[3] = m.vPart[i]; });
  const C = g.count, rep = new Int32Array(C).fill(-1);
  for (let v = 0; v < V; v++) if (rep[g.group[v]] < 0) rep[g.group[v]] = v;
  const positions = new Float32Array(C * 3), normals = new Float32Array(C * 3), smooth = new Float32Array(C * 3);
  const colors = m.colors ? new Float32Array(C * 3) : null, vPart = new Uint16Array(C), vMat = new Uint16Array(C);
  const sm = smoothNormalsOf(m);
  for (let v = 0; v < V; v++) {
    const c = g.group[v];
    for (let k = 0; k < 3; k++) { normals[c * 3 + k] += m.normals[v * 3 + k]; smooth[c * 3 + k] += sm[v * 3 + k]; }
  }
  for (let c = 0; c < C; c++) {
    const r = rep[c];
    for (let k = 0; k < 3; k++) positions[c * 3 + k] = P[r * 3 + k];
    if (colors) for (let k = 0; k < 3; k++) colors[c * 3 + k] = m.colors[r * 3 + k];
    vPart[c] = m.vPart[r]; vMat[c] = m.vMat[r];
    for (const n of [normals, smooth]) {
      const l = Math.hypot(n[c * 3], n[c * 3 + 1], n[c * 3 + 2]) || 1;
      for (let k = 0; k < 3; k++) n[c * 3 + k] /= l;
    }
  }
  const idx = new Uint32Array(m.index.length), triMat = new Uint16Array(m.index.length / 3);
  let n = 0;
  for (let t = 0; t < m.index.length; t += 3) {
    const a = g.group[m.index[t]], b = g.group[m.index[t + 1]], c = g.group[m.index[t + 2]];
    if (a === b || b === c || a === c) continue;
    triMat[n / 3] = m.vMat[m.index[t]];
    idx[n++] = a; idx[n++] = b; idx[n++] = c;
  }
  ctx.geo = { mesh: { positions, normals, smooth, colors, uvs: null, index: idx.slice(0, n), vPart, vMat, vertexCount: C }, triMat: triMat.slice(0, n / 3), rep, half: null };
  return ctx.geo;
}

// Density per vertex that gives each separate piece at least MIN_PIECE_QUADS quads, on top of the painted density.
function pieceDensity(mesh, density, quads) {
  const V = mesh.vertexCount, idx = mesh.index, P = mesh.positions, uf = new UnionFind(V);
  for (let t = 0; t < idx.length; t += 3) { uf.union(idx[t], idx[t + 1]); uf.union(idx[t + 1], idx[t + 2]); }
  const { labels, count } = uf.labels(V);
  if (count < 2) return density;
  const area = new Float64Array(count), weighted = new Float64Array(count);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2, k = labels[idx[t]];
    area[k] += ar;
    weighted[k] += density ? (ar * (density[idx[t]] + density[idx[t + 1]] + density[idx[t + 2]])) / 3 : ar;
  }
  let total = 0;
  for (let k = 0; k < count; k++) total += weighted[k];
  // Quads a piece would get, and the boost that lifts it to the minimum; the boosts together stay within a fifth.
  let min = MIN_PIECE_QUADS, extra = 0;
  const boost = new Float64Array(count).fill(1);
  for (let pass = 0; pass < 2; pass++) {
    extra = 0;
    for (let k = 0; k < count; k++) {
      const share = (quads * weighted[k]) / total;
      boost[k] = share > 0 && share < min ? min / share : 1;
      if (boost[k] > 1) extra += min - share;
    }
    if (extra <= quads * 0.2) break;
    min *= (quads * 0.2) / extra;
  }
  if (!boost.some(b => b > 1)) return density;
  const out = new Float32Array(V);
  for (let v = 0; v < V; v++) out[v] = (density ? density[v] : 1) * boost[labels[v]];
  return out;
}

// The remesher's quads as the result mesh: two consecutive triangles per quad (quad marks as in validatePairs), split
// along the shorter diagonal, with the input's normals, colours and nearest welded vertex where each vertex sits.
// A vertex whose faces lie on different materials gets one copy per material.
// plane: the mirror plane, whose vertices must not make up a whole triangle (mirroring would drop it).
function quadSurface(rq, base, smooth, triMat, welded, fopt, plane = null) {
  const nv = rq.positions.length / 3, F = rq.faceCount, faces = rq.faces, BI = base.index, P = rq.positions;
  const hitT = rq.hit.tri, bc = rq.hit.bary;
  const near = new Int32Array(nv), nOrig = new Float32Array(nv * 3), nSmooth = new Float32Array(nv * 3);
  const col = base.colors ? new Float32Array(nv * 3) : null;
  for (let v = 0; v < nv; v++) {
    const t = hitT[v];
    if (t < 0) continue;
    const ia = BI[t * 3], ib = BI[t * 3 + 1], ic = BI[t * 3 + 2], wa = bc[v * 3], wb = bc[v * 3 + 1], wc = bc[v * 3 + 2];
    near[v] = wa >= wb && wa >= wc ? ia : wb >= wc ? ib : ic;
    for (let k = 0; k < 3; k++) {
      nOrig[v * 3 + k] = base.normals[ia * 3 + k] * wa + base.normals[ib * 3 + k] * wb + base.normals[ic * 3 + k] * wc;
      nSmooth[v * 3 + k] = smooth[ia * 3 + k] * wa + smooth[ib * 3 + k] * wb + smooth[ic * 3 + k] * wc;
      if (col) col[v * 3 + k] = base.colors[ia * 3 + k] * wa + base.colors[ib * 3 + k] * wb + base.colors[ic * 3 + k] * wc;
    }
  }
  const copyOf = new Map(), srcV = [], mats = [];
  const vid = (v, m) => {
    const key = v * 65536 + m;
    let o = copyOf.get(key);
    if (o === undefined) { o = srcV.length; copyOf.set(key, o); srcV.push(v); mats.push(m); }
    return o;
  };
  const d2 = (a, b) => (P[a * 3] - P[b * 3]) ** 2 + (P[a * 3 + 1] - P[b * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[b * 3 + 2]) ** 2;
  const off32 = plane ? Math.fround(plane.offset) : 0;
  const onPlane = v => plane && P[v * 3 + plane.axis] === off32;
  // Split along a–c unless b–d is shorter, or a–c would leave a triangle lying wholly on the mirror plane.
  const alongAC = (a, b, c, d) => {
    const acFlat = onPlane(a) && onPlane(c) && (onPlane(b) || onPlane(d));
    const bdFlat = onPlane(b) && onPlane(d) && (onPlane(a) || onPlane(c));
    if (acFlat !== bdFlat) return bdFlat;
    return d2(a, c) <= d2(b, d);
  };
  const tris = [], marks = [];
  let quads = 0;
  for (let f = 0; f < F; f++) {
    const t = rq.faceTri[f], a = faces[f * 4], b = faces[f * 4 + 1], c = faces[f * 4 + 2], d = faces[f * 4 + 3];
    const m = t >= 0 ? triMat[t] : base.vMat[near[a]];
    if (d === QUAD_NONE) { tris.push(vid(a, m), vid(b, m), vid(c, m)); marks.push(0); continue; }
    if (alongAC(a, b, c, d)) tris.push(vid(a, m), vid(b, m), vid(c, m), vid(a, m), vid(c, m), vid(d, m));
    else tris.push(vid(b, m), vid(c, m), vid(d, m), vid(b, m), vid(d, m), vid(a, m));
    marks.push(1, 2);
    quads++;
  }
  const n = srcV.length;
  let positions = new Float32Array(n * 3), normals = new Float32Array(n * 3), colors = col ? new Float32Array(n * 3) : null;
  let srcId = new Uint32Array(n), vPart = new Uint16Array(n), vMat = new Uint16Array(n), uvs = null;
  const pick = fopt.normals === 'smooth' ? nSmooth : nOrig;
  for (let o = 0; o < n; o++) {
    const v = srcV[o];
    for (let k = 0; k < 3; k++) { positions[o * 3 + k] = P[v * 3 + k]; normals[o * 3 + k] = pick[v * 3 + k]; }
    const l = Math.hypot(normals[o * 3], normals[o * 3 + 1], normals[o * 3 + 2]) || 1;
    for (let k = 0; k < 3; k++) normals[o * 3 + k] /= l;
    if (colors) for (let k = 0; k < 3; k++) colors[o * 3 + k] = Math.min(1, Math.max(0, col[v * 3 + k]));
    srcId[o] = welded(near[v]);
    vPart[o] = base.vPart[near[v]];
    vMat[o] = mats[o];
  }
  let index = Uint32Array.from(tris);
  const quad = Uint8Array.from(marks);
  if (fopt.normals === 'smooth') normals = leanToSurface(normals, positions, index);
  else if (fopt.normals === 'crease') {
    ({ positions, normals, uvs, colors, srcId, index, vPart, vMat } = creased(positions, normals, null, colors, srcId, index, vPart, vMat, fopt.creaseAngle ?? 60, quad));
  }
  return { mesh: { positions, normals, uvs, colors, srcId, index, quad, vPart, vMat, vertexCount: positions.length / 3, triCount: index.length / 3 }, quads };
}

const countQuads = res => { let n = 0; for (let t = 0; t < res.quad.length; t++) if (res.quad[t] === 1) n++; return n; };

// Vertices where other than four edges meet, not counting open borders; vertices at one position count once.
export function quadPoles(res) {
  const P = res.positions, V = res.vertexCount, idx = res.index;
  const bits = new Int32Array(P.buffer, P.byteOffset, V * 3);
  const g = groupBy(V, 3, (i, o) => { o[0] = bits[i * 3]; o[1] = bits[i * 3 + 1]; o[2] = bits[i * 3 + 2]; });
  const G = g.count, edges = new Map();
  const add = (a, b) => {
    a = g.group[a]; b = g.group[b];
    if (a === b) return;
    const key = a < b ? a * G + b : b * G + a;
    edges.set(key, (edges.get(key) || 0) + 1);
  };
  for (let t = 0; t < idx.length / 3; t++) {
    const q = res.quad && res.quad[t] === 1 ? quadCorners(idx, t) : null;
    if (q) { for (let k = 0; k < 4; k++) add(q[k], q[(k + 1) % 4]); t++; continue; }
    for (let k = 0; k < 3; k++) add(idx[t * 3 + k], idx[t * 3 + ((k + 1) % 3)]);
  }
  const deg = new Int32Array(G), border = new Uint8Array(G);
  for (const [key, c] of edges) {
    const a = Math.floor(key / G), b = key - a * G;
    deg[a]++; deg[b]++;
    if (c === 1) border[a] = border[b] = 1;
  }
  let count = 0, inner = 0;
  for (let v = 0; v < G; v++) {
    if (!deg[v] || border[v]) continue;
    inner++;
    if (deg[v] !== 4) count++;
  }
  return { count, inner };
}

// Rebuilds the surface as quads (st.targetTris / 2 of them). Under symmetry the kept half is remeshed with its cut
// held on the plane as an edge loop, and mirrored. Painted regions set the local density.
function remeshVariant(S, ctx, labels, st, fopt, progress) {
  const t0 = Date.now(), geo = geometryOf(ctx), sym = st.symmetry;
  let base = geo.mesh, toGeo = null, triMat = geo.triMat, smooth = geo.mesh.smooth;
  if (sym) {
    const H = halfFor(geo, sym);
    if (!H.triMat) {
      H.triMat = new Uint16Array(H.triSrc.length);
      for (let t = 0; t < H.triSrc.length; t++) H.triMat[t] = geo.triMat[H.triSrc[t]];
      H.smooth = new Float32Array(H.mesh.vertexCount * 3);
      for (let v = 0; v < H.mesh.vertexCount; v++) for (let k = 0; k < 3; k++) H.smooth[v * 3 + k] = geo.mesh.smooth[H.origOf[v] * 3 + k];
    }
    base = H.mesh; toGeo = H.origOf; triMat = H.triMat; smooth = H.smooth;
  }
  const welded = v => geo.rep[toGeo ? toGeo[v] : v];
  const V = base.vertexCount, quads = Math.max(8, Math.round(st.targetTris / 2 / (sym ? 2 : 1)));
  let index = base.index;
  if (st.prune && S) index = S.simplifyPrune(index, base.positions, 3, PRUNE_SIZE);
  let density = null;
  if (labels) {
    density = new Float32Array(V);
    let any = false;
    for (let v = 0; v < V; v++) { const l = labels[welded(v)]; density[v] = QUAD_DENSITY[l] ?? 1; if (l) any = true; }
    if (!any) density = null;
  }
  density = pieceDensity({ positions: base.positions, index, vertexCount: V }, density, quads);
  const rq = remeshQuads({ positions: base.positions, index, normals: smooth }, {
    targetFaces: quads, density, plane: sym ? { axis: sym.axis, offset: Math.fround(sym.offset) } : null, progress,
  });
  // Triangles the prune dropped don't exist for the lookups either.
  const surf = quadSurface(rq, { ...base, index }, smooth, triMat, welded, fopt, sym);
  let result = surf.mesh, symmetry = null;
  if (sym) {
    result = mirrorMerge(result, sym);
    symmetry = checkSymmetry(result, sym);
    symmetry.seamVertices = result.seamVertices;
  }
  const faceLabels = labels ? Int8Array.from(result.srcId, s => labels[s]) : null;
  const cat = categorize(result.index, faceLabels);
  return {
    result,
    info: {
      error: 0, ms: Date.now() - t0, target: st.targetTris, tris: result.triCount, verts: result.vertexCount, quads: countQuads(result),
      keepCount: 0, cat, symmetry, atlas: null, remesh: rq.stats, poles: quadPoles(result),
    },
  };
}

// Past this share of misplaced texels, Auto gives the reduced mesh new UVs.
export const AUTO_UV_LIMIT = 0.03;

// One entry point for the worker and the main-thread fallback. ctx caches the cut half per plane,
// the UV-free variant of the mesh and the texel ownership of the original UVs.
// st.uvMode: 'keep' keeps the original UVs, 'new' reduces without UV seams and unwraps, 'auto' picks per result.
// st.topology 'quads' remeshes into quads instead; their UVs are always new (made later when st.deferUV).
export function runReduction(S, ctx, labels, st, fopt, progress = null) {
  if (st.topology === 'quads') {
    const out = remeshVariant(S, ctx, labels, st, fopt, progress);
    if (ctx.mesh.uvs) {
      if (st.deferUV) out.result.uvLayout = 'pending';
      else {
        const u = unwrapResult(out.result, st.symmetry, labels, st.bakeSize || 1024);
        out.result = u.result;
        out.info.atlas = u.atlas;
      }
    }
    return out;
  }
  const mode = ctx.mesh.uvs ? st.uvMode || 'keep' : 'keep';
  const kept = () => {
    const out = reduceVariant(S, ctx, labels, st, fopt, null);
    if (out.result.uvs) { out.info.uvFit = measureUVFit(ctx, out.result); out.result.uvLayout = 'original'; }
    return out;
  };
  const fresh = () => {
    const hard = st.hardAngle ?? 30, t0 = Date.now();
    if (!ctx.free || ctx.free.hardAngle !== hard) {
      const s = stripUVs(ctx.mesh, hard);
      ctx.free = { hardAngle: hard, mesh: s.mesh, packed: packAttributes(s.mesh), half: null, rep: s.rep, ms: Date.now() - t0 };
    }
    const fv = ctx.free;
    let fl = null;
    if (labels) {
      fl = new Int8Array(fv.mesh.vertexCount);
      for (let v = 0; v < fl.length; v++) fl[v] = labels[fv.rep[v]];
    }
    const out = reduceVariant(S, fv, fl, st, fopt, st.deferUV ? null : { size: st.bakeSize || 1024 });
    const src = out.result.srcId;
    for (let v = 0; v < src.length; v++) src[v] = fv.rep[src[v]];
    out.result.uvLayout = st.deferUV ? 'pending' : 'new';
    out.info.freeMs = Date.now() - t0 - out.info.ms;
    return out;
  };
  if (mode === 'keep') return kept();
  if (mode === 'new') return fresh();
  // Misplacement only grows as the budget drops, so once the original UVs failed at some budget, lower budgets
  // with the same settings skip straight to new UVs.
  const sig = JSON.stringify([st.symmetry, st.permissive, st.regularize, st.lockBorder, st.prune, st.optimizePositions, st.normalWeight, st.uvWeight, st.maxError, st.hardAngle, fopt]);
  const failed = ctx.autoFail && ctx.autoFail.sig === sig ? ctx.autoFail : null;
  if (failed && st.targetTris <= failed.target) {
    const out = fresh();
    out.info.uvFit = { ...failed.fit, estimated: true };
    out.info.uvDecision = 'rebuilt';
    return out;
  }
  const first = kept();
  if (first.info.uvFit.misplaced <= AUTO_UV_LIMIT) { first.info.uvDecision = 'fits'; return first; }
  ctx.autoFail = { sig, target: Math.max(st.targetTris, failed ? failed.target : 0), fit: first.info.uvFit };
  const out = fresh();
  out.info.uvFit = first.info.uvFit;
  out.info.uvDecision = 'rebuilt';
  out.info.ms += first.info.ms;
  return out;
}
