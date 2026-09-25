// How visible each vertex is from all sides: the share of a surrounding sphere of view directions that sees it, with
// head-on views weighted more, after Zhang & Turk, "Visibility-guided simplification" (IEEE Visualization 2002).
// 1 anywhere on a convex shape, 0 where no direction can see the surface (enclosed or buried).
// Rays are cast from every vertex (every distinct position) over a cosine-weighted hemisphere, a few per vertex on
// dense meshes, then averaged over neighbours. Closed shapes look outward only (inside-out ones are flipped first);
// open surfaces such as cards and cloth count whichever side is more visible.

// Rays for the whole model; dense meshes get fewer per vertex and more smoothing.
const RAY_BUDGET = 1.5e6;
const MIN_RAYS = 1, MAX_RAYS = 64;
// Vertices that come out as never seen are checked again with this many rays before anything counts as hidden for good.
const CONFIRM_RAYS = 32;
// Visibility histogram bins, a hundredth wide; the last one also holds everything above.
const HIST_BINS = 50;

// Open-addressing table of distinct positions (bit-identical floats, which the weld guarantees for copies).
function positionGroups(P, V) {
  const bits = new Int32Array(P.buffer, P.byteOffset, V * 3);
  let size = 1;
  while (size < V * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1), group = new Int32Array(V), mask = size - 1;
  let count = 0;
  for (let v = 0; v < V; v++) {
    const x = bits[v * 3], y = bits[v * 3 + 1], z = bits[v * 3 + 2];
    let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(z, 0xc2b2ae3d);
    h = (h ^ (h >>> 15)) & mask;
    for (;;) {
      const r = table[h];
      if (r < 0) { table[h] = v; group[v] = count++; break; }
      if (bits[r * 3] === x && bits[r * 3 + 1] === y && bits[r * 3 + 2] === z) { group[v] = group[r]; break; }
      h = (h + 1) & mask;
    }
  }
  return { group, count };
}

// Median-split BVH for occlusion rays. Triangles are stored in leaf order as a corner and two edges.
function buildBVH(P, I, T) {
  const cen = new Float32Array(T * 3);
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    cen[t * 3] = P[a] + P[b] + P[c]; cen[t * 3 + 1] = P[a + 1] + P[b + 1] + P[c + 1]; cen[t * 3 + 2] = P[a + 2] + P[b + 2] + P[c + 2];
  }
  const order = new Uint32Array(T);
  for (let t = 0; t < T; t++) order[t] = t;
  const maxNodes = 2 * Math.ceil(T / 2) + 1;
  const box = new Float32Array(maxNodes * 6), right = new Int32Array(maxNodes), first = new Uint32Array(maxNodes);
  const count = new Uint8Array(maxNodes), axisOf = new Uint8Array(maxNodes);
  let nodes = 0;
  const select = (lo, hi, k, ax) => {
    while (hi > lo) {
      const pivot = cen[order[(lo + hi) >> 1] * 3 + ax];
      let i = lo, j = hi;
      while (i <= j) {
        while (cen[order[i] * 3 + ax] < pivot) i++;
        while (cen[order[j] * 3 + ax] > pivot) j--;
        if (i <= j) { const s = order[i]; order[i] = order[j]; order[j] = s; i++; j--; }
      }
      if (k <= j) hi = j; else if (k >= i) lo = i; else return;
    }
  };
  // Iterative build in depth-first order, so a left child always follows its parent; a right child's id is known once
  // it is popped. Pending entries: start, end, parent (-1 for the root).
  const todo = [[0, T, -1]];
  while (todo.length) {
    const [s, e, parent] = todo.pop();
    const node = nodes++;
    if (parent >= 0) right[parent] = node;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let i = s; i < e; i++) {
      const t = order[i];
      for (let k = 0; k < 3; k++) {
        const v = I[t * 3 + k] * 3, x = P[v], y = P[v + 1], z = P[v + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      const cx = cen[t * 3], cy = cen[t * 3 + 1], cz = cen[t * 3 + 2];
      if (cx < cx0) cx0 = cx; if (cx > cx1) cx1 = cx;
      if (cy < cy0) cy0 = cy; if (cy > cy1) cy1 = cy;
      if (cz < cz0) cz0 = cz; if (cz > cz1) cz1 = cz;
    }
    const o = node * 6;
    box[o] = x0; box[o + 1] = y0; box[o + 2] = z0; box[o + 3] = x1; box[o + 4] = y1; box[o + 5] = z1;
    if (e - s <= 4) { right[node] = -1; first[node] = s; count[node] = e - s; continue; }
    const dx = cx1 - cx0, dy = cy1 - cy0, dz = cz1 - cz0;
    const ax = dx >= dy && dx >= dz ? 0 : dy >= dz ? 1 : 2;
    const mid = (s + e) >> 1;
    select(s, e - 1, mid, ax);
    axisOf[node] = ax;
    right[node] = 0;
    // The left range is pushed last so it is built next and gets id node + 1.
    todo.push([mid, e, node]);
    todo.push([s, mid, -2 - node]);
  }
  // Leaf-ordered triangle data.
  const tri = new Float32Array(T * 9);
  for (let i = 0; i < T; i++) {
    const t = order[i], a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3, o = i * 9;
    tri[o] = P[a]; tri[o + 1] = P[a + 1]; tri[o + 2] = P[a + 2];
    tri[o + 3] = P[b] - P[a]; tri[o + 4] = P[b + 1] - P[a + 1]; tri[o + 5] = P[b + 2] - P[a + 2];
    tri[o + 6] = P[c] - P[a]; tri[o + 7] = P[c + 1] - P[a + 1]; tri[o + 8] = P[c + 2] - P[a + 2];
  }
  return { box, right, first, count, axisOf, tri };
}

// True when the ray (origin o, unit direction d) hits any triangle at a distance in (tmin, infinity).
const STACK = new Int32Array(128);
function occluded(bvh, ox, oy, oz, dx, dy, dz, tmin) {
  const { box, right, first, count, axisOf, tri } = bvh;
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  let sp = 0;
  STACK[sp++] = 0;
  while (sp > 0) {
    const node = STACK[--sp], b = node * 6;
    let t0 = (box[b] - ox) * ix, t1 = (box[b + 3] - ox) * ix;
    if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    let u0 = (box[b + 1] - oy) * iy, u1 = (box[b + 4] - oy) * iy;
    if (u0 > u1) { const s = u0; u0 = u1; u1 = s; }
    if (u0 > t0) t0 = u0;
    if (u1 < t1) t1 = u1;
    let w0 = (box[b + 2] - oz) * iz, w1 = (box[b + 5] - oz) * iz;
    if (w0 > w1) { const s = w0; w0 = w1; w1 = s; }
    if (w0 > t0) t0 = w0;
    if (w1 < t1) t1 = w1;
    if (t0 > t1 || t1 < tmin) continue;
    const r = right[node];
    if (r >= 0) {
      // Near child on top, so occluders close to the origin are found first.
      const ax = axisOf[node];
      if (ax === 0 ? dx < 0 : ax === 1 ? dy < 0 : dz < 0) { STACK[sp++] = node + 1; STACK[sp++] = r; } else { STACK[sp++] = r; STACK[sp++] = node + 1; }
      continue;
    }
    for (let i = first[node], e = i + count[node]; i < e; i++) {
      const o = i * 9;
      const e1x = tri[o + 3], e1y = tri[o + 4], e1z = tri[o + 5], e2x = tri[o + 6], e2y = tri[o + 7], e2z = tri[o + 8];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-20 && det < 1e-20) continue;
      const inv = 1 / det, sx = ox - tri[o], sy = oy - tri[o + 1], sz = oz - tri[o + 2];
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      if ((e2x * qx + e2y * qy + e2z * qz) * inv > tmin) return true;
    }
  }
  return false;
}

// Components of the position-welded surface: whether each is closed (no open edge) and, if closed, inside-out.
function components(I, T, group, G, P) {
  const root = new Int32Array(G);
  for (let g = 0; g < G; g++) root[g] = g;
  const find = x => { while (root[x] !== x) { root[x] = root[root[x]]; x = root[x]; } return x; };
  const keys = new Float64Array(T * 3);
  let n = 0;
  for (let t = 0; t < T; t++) {
    const a = group[I[t * 3]], b = group[I[t * 3 + 1]], c = group[I[t * 3 + 2]];
    const ra = find(a), rb = find(b);
    if (ra !== rb) root[ra] = rb;
    const rc = find(c), rb2 = find(b);
    if (rc !== rb2) root[rc] = rb2;
    if (a !== b) keys[n++] = a < b ? a * G + b : b * G + a;
    if (b !== c) keys[n++] = b < c ? b * G + c : c * G + b;
    if (c !== a) keys[n++] = c < a ? c * G + a : a * G + c;
  }
  const edges = keys.subarray(0, n).sort();
  const open = new Uint8Array(G);
  for (let i = 0; i < n;) {
    let j = i + 1;
    while (j < n && edges[j] === edges[i]) j++;
    if (j - i === 1) { const a = Math.floor(edges[i] / G); open[find(a)] = 1; }
    i = j;
  }
  // Signed volume per component; a closed one with negative volume faces inward.
  const vol = new Float64Array(G);
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const cx = P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1], cy = P[b + 2] * P[c] - P[b] * P[c + 2], cz = P[b] * P[c + 1] - P[b + 1] * P[c];
    vol[find(group[I[t * 3]])] += P[a] * cx + P[a + 1] * cy + P[a + 2] * cz;
  }
  const twoSided = new Uint8Array(G), flip = new Uint8Array(G);
  for (let g = 0; g < G; g++) {
    const r = find(g);
    if (open[r]) twoSided[g] = 1;
    else if (vol[r] < 0) flip[g] = 1;
  }
  return { twoSided, flip };
}

// Fraction of R cosine-weighted rays around normal n that escape. rot and jit decorrelate neighbouring vertices.
function escaping(bvh, px, py, pz, nx, ny, nz, R, rot, jit, eps, tmin) {
  // Orthonormal frame around n (Duff et al. 2017).
  const s = nz >= 0 ? 1 : -1, a = -1 / (s + nz), b = nx * ny * a;
  const tx = 1 + s * nx * nx * a, ty = s * b, tz = -s * nx;
  const bx = b, by = s + ny * ny * a, bz = -ny;
  const ox = px + nx * eps, oy = py + ny * eps, oz = pz + nz * eps;
  let free = 0;
  for (let i = 0; i < R; i++) {
    // Fibonacci disk lifted onto the hemisphere: cosine-weighted and evenly spread.
    const r = Math.sqrt((i + jit) / R), phi = 6.283185307179586 * (i * 0.6180339887498949 + rot);
    const u = r * Math.cos(phi), v = r * Math.sin(phi), w = Math.sqrt(Math.max(0, 1 - r * r));
    const dx = tx * u + bx * v + nx * w, dy = ty * u + by * v + ny * w, dz = tz * u + bz * v + nz * w;
    if (!occluded(bvh, ox, oy, oz, dx, dy, dz, tmin)) free++;
  }
  return free / R;
}

// mesh: { positions, index, vertexCount }. Returns { vis: Float32Array per vertex in [0, 1], stats }.
// opt.rays overrides the ray budget; opt.progress(frac) reports how far it got.
export function computeVisibility(mesh, opt = {}) {
  const t0 = Date.now();
  const P = mesh.positions, I = mesh.index, V = mesh.vertexCount, T = I.length / 3;
  const { group, count: G } = positionGroups(P, V);
  // Area-weighted normals from the winding, and area per position.
  const N = new Float64Array(G * 3), area = new Float64Array(G);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < V; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  for (let t = 0; t < T; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const wx = P[c * 3] - P[a * 3], wy = P[c * 3 + 1] - P[a * 3 + 1], wz = P[c * 3 + 2] - P[a * 3 + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, A = Math.hypot(nx, ny, nz) / 6;
    for (let k = 0; k < 3; k++) {
      const g = group[I[t * 3 + k]];
      N[g * 3] += nx; N[g * 3 + 1] += ny; N[g * 3 + 2] += nz;
      area[g] += A;
    }
  }
  const { twoSided, flip } = components(I, T, group, G, P);
  const bvh = buildBVH(P, I, T);

  let sides = 0;
  for (let g = 0; g < G; g++) sides += twoSided[g] ? 2 : 1;
  const R = Math.max(MIN_RAYS, Math.min(MAX_RAYS, Math.floor((opt.rays || RAY_BUDGET) / Math.max(1, sides))));
  const eps = 2e-5 * diag, tmin = 1e-6 * diag;
  // Positions: the first vertex of each group.
  const first = new Int32Array(G).fill(-1);
  for (let v = 0; v < V; v++) if (first[group[v]] < 0) first[group[v]] = v;
  const vg = new Float32Array(G);
  let rays = 0;
  for (let g = 0; g < G; g++) {
    let nx = N[g * 3], ny = N[g * 3 + 1], nz = N[g * 3 + 2];
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 0)) { vg[g] = 1; continue; }
    const k = flip[g] ? -1 / l : 1 / l;
    nx *= k; ny *= k; nz *= k;
    const v = first[g], px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2];
    // Low-discrepancy per-vertex offsets (R2 sequence).
    const rot = (g * 0.7548776662466927) % 1, jit = (g * 0.5698402909980532 + 0.5) % 1;
    let f = escaping(bvh, px, py, pz, nx, ny, nz, R, rot, jit, eps, tmin);
    rays += R;
    if (twoSided[g] && f < 1) {
      f = Math.max(f, escaping(bvh, px, py, pz, -nx, -ny, -nz, R, rot, jit, eps, tmin));
      rays += R;
    }
    vg[g] = f;
    if (opt.progress && (g & 16383) === 0) opt.progress(0.85 * (g / G));
  }
  // Average over neighbours to calm the noise of few rays: each pass takes the mean over the vertex's triangle fan.
  const passes = R >= 48 ? 0 : R >= 24 ? 1 : R >= 12 ? 2 : R >= 6 ? 3 : R >= 4 ? 4 : R >= 2 ? 6 : 8;
  const acc = new Float32Array(G), cnt = new Float32Array(G);
  for (let pass = 0; pass < passes; pass++) {
    acc.fill(0); cnt.fill(0);
    for (let t = 0; t < T; t++) {
      const a = group[I[t * 3]], b = group[I[t * 3 + 1]], c = group[I[t * 3 + 2]];
      const s = vg[a] + vg[b] + vg[c];
      acc[a] += s; acc[b] += s; acc[c] += s;
      cnt[a] += 3; cnt[b] += 3; cnt[c] += 3;
    }
    for (let g = 0; g < G; g++) if (cnt[g] > 0) vg[g] = acc[g] / cnt[g];
  }
  // Few rays can miss a narrow opening, so a vertex only stays at zero if many more rays confirm it.
  let confirmed = 0, reopened = 0;
  for (let g = 0; g < G; g++) {
    if (vg[g] > 1e-6) continue;
    let nx = N[g * 3], ny = N[g * 3 + 1], nz = N[g * 3 + 2];
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 0)) continue;
    const k = flip[g] ? -1 / l : 1 / l;
    nx *= k; ny *= k; nz *= k;
    const v = first[g], px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2];
    const rot = (g * 0.7548776662466927 + 0.37) % 1, jit = (g * 0.5698402909980532 + 0.13) % 1;
    let f = escaping(bvh, px, py, pz, nx, ny, nz, CONFIRM_RAYS, rot, jit, eps, tmin);
    rays += CONFIRM_RAYS;
    if (twoSided[g] && f === 0) { f = escaping(bvh, px, py, pz, -nx, -ny, -nz, CONFIRM_RAYS, rot, jit, eps, tmin); rays += CONFIRM_RAYS; }
    if (f > 0) { vg[g] = f; reopened++; } else confirmed++;
    if (opt.progress && (g & 16383) === 0) opt.progress(0.85 + 0.15 * (g / G));
  }
  // A barely visible vertex whose neighbours are nearly all hidden sits inside a hidden region (the odd ray that slipped
  // through); it counts as hidden too, or deleting the region would leave it behind as a floating scrap.
  // seenNear / allNear: fan neighbours that are visible at all, and all of them (counted once per triangle).
  const seenNear = new Uint32Array(G), allNear = new Uint32Array(G);
  for (let pass = 0; pass < 3; pass++) {
    seenNear.fill(0); allNear.fill(0);
    for (let t = 0; t < T; t++) {
      const a = group[I[t * 3]], b = group[I[t * 3 + 1]], c = group[I[t * 3 + 2]];
      const sa = vg[a] > 0 ? 1 : 0, sb = vg[b] > 0 ? 1 : 0, sc = vg[c] > 0 ? 1 : 0;
      seenNear[a] += sb + sc; seenNear[b] += sa + sc; seenNear[c] += sa + sb;
      allNear[a] += 2; allNear[b] += 2; allNear[c] += 2;
    }
    let changed = 0;
    for (let g = 0; g < G; g++) if (vg[g] > 0 && vg[g] < 0.05 && seenNear[g] * 5 <= allNear[g]) { vg[g] = 0; changed++; }
    if (!changed) break;
  }
  const vis = new Float32Array(V);
  for (let v = 0; v < V; v++) vis[v] = vg[group[v]];
  // Share of the surface by visibility: hist[0] is never seen, hist[i] up to i/100 (the last bin takes the rest); and the
  // mean, Zhang & Turk's visibility of the whole mesh.
  let total = 0, mean = 0;
  const hist = new Array(HIST_BINS + 1).fill(0);
  for (let g = 0; g < G; g++) {
    const A = area[g], x = vg[g];
    total += A; mean += A * x;
    hist[x <= 1e-6 ? 0 : Math.min(HIST_BINS, Math.ceil(x * 100))] += A;
  }
  for (let i = 0; i <= HIST_BINS; i++) hist[i] = total > 0 ? hist[i] / total : 0;
  let open = 0;
  for (let g = 0; g < G; g++) if (twoSided[g]) open++;
  return {
    vis,
    stats: { ms: Date.now() - t0, rays, raysPerVertex: R, passes, positions: G, confirmed, reopened, openShare: open / Math.max(1, G), mean: total > 0 ? mean / total : 1, hist },
  };
}
