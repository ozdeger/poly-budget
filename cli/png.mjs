// PNG files without a canvas: an 8-bit RGBA encoder, and the UV layout sheet the app's Export adds for new UVs.
import zlib from 'zlib';
import { uvEdges } from '../src/core.js';

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

// rgba: w × h pixels, 4 bytes each, rows from the top.
export function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// The UV layout of material mi as an image to paint over, as uvTemplatePng in src/app.js draws it: black lines on a
// clear sheet, chart borders heavier than the quads' edges, rows from the top as image editors show them. Each set of
// lines is one stroke with round ends: its coverage is the union of its lines, laid over the sheet once.
// nMat: the model's material count; triEnd: where a mirrored result's own half ends.
export function uvLayoutPng(res, mi, size, nMat, triEnd = res.triCount) {
  const { edges, seams } = uvEdges(res, t => Math.min(res.vMat[res.index[t * 3]], nMat - 1) === mi, triEnd);
  const uv = res.uvs, k = size / 1024, alpha = new Float32Array(size * size), cover = new Float32Array(size * size);
  const stroke = (list, width, a) => {
    cover.fill(0);
    const r = width / 2;
    for (let i = 0; i < list.length; i += 2) {
      const ax = uv[list[i] * 2] * size, ay = (1 - uv[list[i] * 2 + 1]) * size, bx = uv[list[i + 1] * 2] * size, by = (1 - uv[list[i + 1] * 2 + 1]) * size;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1)), x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx) + r + 1));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1)), y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by) + r + 1));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5, t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
        const c = r + 0.5 - Math.hypot(px - ax - t * dx, py - ay - t * dy);
        if (c > 0) { const o = y * size + x, v = Math.min(1, c); if (v > cover[o]) cover[o] = v; }
      }
    }
    for (let o = 0; o < cover.length; o++) if (cover[o] > 0) { const s = cover[o] * a; alpha[o] = s + alpha[o] * (1 - s); }
  };
  stroke(edges, Math.max(1, k), 0.55);
  stroke(seams, Math.max(1.5, 2 * k), 1);
  const rgba = new Uint8Array(size * size * 4);
  for (let o = 0; o < alpha.length; o++) rgba[o * 4 + 3] = Math.round(alpha[o] * 255);
  return encodePNG(size, size, rgba);
}
