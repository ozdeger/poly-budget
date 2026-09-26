// Pictures of the bench's saved results next to the original, all from the model's `view` in the manifest and framed
// alike: shaded, with the result's edges, and open borders in red. Writes <out>/<id>/*.png and panels.json, which
// sheets.py turns into labelled sheets.
// usage: node --max-old-space-size=16384 test/models/render.mjs [id …] [--tier=core] [--results=testdata/models/results]
//        [--out=testdata/models/renders] [--height=560]
//   the results come from: node test/models/bench.mjs --save=testdata/models/results --json=testdata/models/results/runs.json
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { core, collectScene } from '../helpers.js';
import { pick, modelPath, modelsDir } from './fetch.mjs';
import { load } from './load.mjs';

const arg = (name, dflt) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
function writePNG(file, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// The view turns the model's up axis to +y, then yaws about y and pitches about x; the camera looks down -z.
function project(P, view) {
  const V = P.length / 3, out = new Float64Array(V * 3), cy = Math.cos(view.yaw || 0), sy = Math.sin(view.yaw || 0), cp = Math.cos(view.pitch || 0), sp = Math.sin(view.pitch || 0);
  for (let v = 0; v < V; v++) {
    let x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    if (view.up === 'z') { const t = y; y = z; z = -t; }
    const rx = x * cy + z * sy, rz0 = -x * sy + z * cy;
    out[v * 3] = rx; out[v * 3 + 1] = y * cp - rz0 * sp; out[v * 3 + 2] = y * sp + rz0 * cp;
  }
  return out;
}

// Orthographic, z-buffered, clay shading per face from two lights. view.clip drops what lies above that share of the
// height and keeps only faces turned to the camera, to look into rooms from above.
function render(Q, tris, W, H, frame, opt = {}) {
  const V = Q.length / 3, sx = new Float64Array(V), sy = new Float64Array(V), sz = new Float64Array(V), s = Math.min(W, H) / frame.span;
  for (let v = 0; v < V; v++) { sx[v] = (Q[v * 3] - frame.cx) * s + W / 2; sy[v] = H / 2 - (Q[v * 3 + 1] - frame.cy) * s; sz[v] = Q[v * 3 + 2]; }
  const zb = new Float32Array(W * H).fill(-Infinity), rgb = new Uint8Array(W * H * 3).fill(0);
  for (let i = 0; i < W * H; i++) { rgb[i * 3] = 236; rgb[i * 3 + 1] = 234; rgb[i * 3 + 2] = 229; }
  const L1 = [0.35, 0.55, 0.76], L2 = [-0.6, 0.2, 0.45], n1 = Math.hypot(...L1), n2 = Math.hypot(...L2);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    const ux = Q[b * 3] - Q[a * 3], uy = Q[b * 3 + 1] - Q[a * 3 + 1], uz = Q[b * 3 + 2] - Q[a * 3 + 2], vx = Q[c * 3] - Q[a * 3], vy = Q[c * 3 + 1] - Q[a * 3 + 1], vz = Q[c * 3 + 2] - Q[a * 3 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (!(nl > 0)) continue;
    nx /= nl; ny /= nl; nz /= nl;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const lit = 0.28 + 0.62 * Math.max(0, (nx * L1[0] + ny * L1[1] + nz * L1[2]) / n1) + 0.22 * Math.max(0, (nx * L2[0] + ny * L2[1] + nz * L2[2]) / n2);
    const r = Math.min(255, 205 * lit), g = Math.min(255, 196 * lit), bl = Math.min(255, 182 * lit);
    const d = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sx[c] - sx[a]) * (sy[b] - sy[a]);
    if (Math.abs(d) < 1e-12 || (opt.cull && d < 0)) continue;
    const x0 = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[c]))), x1 = Math.min(W - 1, Math.ceil(Math.max(sx[a], sx[b], sx[c])));
    const y0 = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[c]))), y1 = Math.min(H - 1, Math.ceil(Math.max(sy[a], sy[b], sy[c])));
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
      const qx = px + 0.5, qy = py + 0.5;
      const wa = ((sx[b] - qx) * (sy[c] - qy) - (sx[c] - qx) * (sy[b] - qy)) / d, wb = ((sx[c] - qx) * (sy[a] - qy) - (sx[a] - qx) * (sy[c] - qy)) / d, wc = 1 - wa - wb;
      if (wa < 0 || wb < 0 || wc < 0) continue;
      const z = wa * sz[a] + wb * sz[b] + wc * sz[c], i = py * W + px;
      if (z <= zb[i]) continue;
      zb[i] = z; rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = bl;
    }
  }
  // Edges where they lie at the front (within a thin depth band of what the z-buffer holds); open borders everywhere.
  const line = (E, color, alpha, front, wide) => {
    for (let k = 0; k < E.length; k += 2) {
      const a = E[k], b = E[k + 1], steps = Math.max(1, Math.ceil(Math.hypot(sx[b] - sx[a], sy[b] - sy[a]) * 1.5));
      for (let j = 0; j <= steps; j++) for (const [ox, oy] of wide ? [[0, 0], [1, 0], [0, 1]] : [[0, 0]]) {
        const t = j / steps, px = Math.round(sx[a] + (sx[b] - sx[a]) * t - 0.5) + ox, py = Math.round(sy[a] + (sy[b] - sy[a]) * t - 0.5) + oy;
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const i = py * W + px;
        if (front && sz[a] + (sz[b] - sz[a]) * t < zb[i] - 0.004 * frame.span) continue;
        for (let q = 0; q < 3; q++) rgb[i * 3 + q] = Math.round(rgb[i * 3 + q] * (1 - alpha) + color[q] * alpha);
      }
    }
  };
  if (opt.edges) line(opt.edges, [60, 58, 54], 0.5, true, false);
  if (opt.open) line(opt.open, [214, 48, 39], 1, false, true);
  return rgb;
}

// Triangles below view.clip of the height (all of them without a clip).
function clipped(P, I, view) {
  if (!view.clip) return I;
  const k = view.up === 'z' ? 2 : 1;
  let lo = Infinity, hi = -Infinity;
  for (let v = k; v < P.length; v += 3) { lo = Math.min(lo, P[v]); hi = Math.max(hi, P[v]); }
  const cut = lo + (hi - lo) * view.clip, out = [];
  for (let t = 0; t < I.length; t += 3) if ((P[I[t] * 3 + k] + P[I[t + 1] * 3 + k] + P[I[t + 2] * 3 + k]) / 3 < cut) out.push(I[t], I[t + 1], I[t + 2]);
  return Uint32Array.from(out);
}

// Edges used by one triangle only (sorted keys, so millions of triangles stay cheap).
function openEdges(I) {
  let V = 0;
  for (const v of I) if (v >= V) V = v + 1;
  const keys = new Float64Array(I.length);
  for (let t = 0; t < I.length; t += 3) for (let k = 0; k < 3; k++) { const a = I[t + k], b = I[t + (k + 1) % 3]; keys[t + k] = a < b ? a * V + b : b * V + a; }
  keys.sort();
  let open = 0;
  for (let i = 0; i < keys.length;) { let j = i + 1; while (j < keys.length && keys[j] === keys[i]) j++; if (j - i === 1) open++; i = j; }
  return open;
}

// Polygons of an OBJ as triangles, edges, and open-border edges (used by one face).
function readObj(file) {
  const P = [], tris = [], use = new Map();
  let faces = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('v ')) { const [, x, y, z] = line.split(' '); P.push(+x, +y, +z); continue; }
    if (!line.startsWith('f ')) continue;
    const p = line.slice(2).trim().split(/\s+/).map(t => parseInt(t, 10) - 1);
    faces++;
    for (let k = 1; k + 1 < p.length; k++) tris.push(p[0], p[k], p[k + 1]);
    for (let k = 0; k < p.length; k++) { const a = p[k], b = p[(k + 1) % p.length], key = a < b ? `${a} ${b}` : `${b} ${a}`; use.set(key, (use.get(key) || 0) + 1); }
  }
  const edges = [], open = [];
  for (const [key, c] of use) (c === 1 ? open : edges).push(...key.split(' ').map(Number));
  return { P: Float64Array.from(P), tris: Uint32Array.from(tris), edges, open, faces };
}

const results = arg('results', path.join(modelsDir, 'results')), outDir = arg('out', path.join(modelsDir, 'renders')), H = Number(arg('height', 560));
for (const m of pick(process.argv.slice(2))) {
  const file = modelPath(m), view = m.view || { up: 'y' };
  if (!file || !fs.existsSync(results)) { console.log(`skip ${m.id}: not fetched, or no results yet`); continue; }
  const names = fs.readdirSync(results).filter(n => n.startsWith(`${m.id}-`) && n.endsWith('.obj')).sort();
  if (!names.length) { console.log(`skip ${m.id}: no saved results in ${results}`); continue; }
  const dir = path.join(outDir, m.id);
  fs.mkdirSync(dir, { recursive: true });
  const w = core.smartWeld(collectScene(await load(file)), { keepUV: false, hardAngle: 180 });
  const Q0 = project(w.positions, view);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let v = 0; v < Q0.length; v += 3) { x0 = Math.min(x0, Q0[v]); x1 = Math.max(x1, Q0[v]); y0 = Math.min(y0, Q0[v + 1]); y1 = Math.max(y1, Q0[v + 1]); }
  const W = Math.round(H * Math.min(1.7, Math.max(0.6, (x1 - x0) / (y1 - y0))));
  const frame = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, span: Math.max((x1 - x0) / W, (y1 - y0) / H) * Math.min(W, H) * 1.06 };
  writePNG(path.join(dir, 'original.png'), W, H, render(Q0, clipped(w.positions, w.index, view), W, H, frame, { cull: !!view.clip }));
  const panels = [{ key: 'original', file: 'original.png' }];
  for (const name of names) {
    const r = readObj(path.join(results, name)), key = name.slice(m.id.length + 1, -4);
    writePNG(path.join(dir, `${key}.png`), W, H, render(project(r.P, view), clipped(r.P, r.tris, view), W, H, frame, { edges: r.edges, open: r.open, cull: !!view.clip }));
    panels.push({ key, file: `${key}.png`, faces: r.faces, open: r.open.length / 2 });
  }
  fs.writeFileSync(path.join(dir, 'panels.json'), JSON.stringify({ id: m.id, W, H, original: { triangles: w.triCount, open: openEdges(w.index) }, panels }, null, 1));
  console.log(`ok   ${m.id}: ${panels.map(p => p.key).join(', ')}`);
}
