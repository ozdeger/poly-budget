// GLB export of baked maps: three's GLTFExporter draws normal, roughness and metalness maps onto a canvas, and baked maps
// are DataTextures, which drawImage refuses. The export must go through, and three's GLTFLoader must read back the
// texels the app shows: the normal map pointing the same way, roughness and metalness merged, occlusion and base colour
// as they were, and a DataTexture with flipY (as TGALoader makes them) the same way round.
import { THREE, check } from './helpers.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { glbBytes } from '../src/glb.js';

// A 2D canvas as far as the exporter uses one. drawImage takes canvases only, as a browser refuses a DataTexture image.
class Canvas {
  constructor(w = 300, h = 150) { this.width = w; this.height = h; }
  set width(w) { this.w = w; this.px = new Uint8ClampedArray(w * (this.h || 0) * 4); }
  get width() { return this.w; }
  set height(h) { this.h = h; this.px = new Uint8ClampedArray((this.w || 0) * h * 4); }
  get height() { return this.h; }
  getContext() { return this.ctx || (this.ctx = new Context(this)); }
  async convertToBlob() { return new Blob([new Uint32Array([this.w, this.h]), this.px]); }
}
class Context {
  constructor(c) { this.c = c; this.m = [1, 1, 0, 0]; this.fillStyle = '#000000'; }
  translate(x, y) { this.m[2] += this.m[0] * x; this.m[3] += this.m[1] * y; }
  scale(x, y) { this.m[0] *= x; this.m[1] *= y; }
  fillRect(x, y, w, h) {
    const n = parseInt(this.fillStyle.slice(1), 16), { px } = this.c;
    for (let i = 0; i < px.length; i += 4) px.set([n >> 16, (n >> 8) & 255, n & 255, 255], i);
  }
  getImageData(x, y, w, h) { return new ImageData(this.c.px.slice(), w, h); }
  putImageData(img) { this.c.px.set(img.data); }
  drawImage(src, x, y, w, h) {
    if (!(src instanceof Canvas)) throw new TypeError("Failed to execute 'drawImage' on 'CanvasRenderingContext2D': The provided value is not of type '(CSSImageValue or HTMLCanvasElement or HTMLImageElement or HTMLVideoElement or ImageBitmap or OffscreenCanvas or SVGImageElement or VideoFrame)'.");
    const { c, m } = this;
    for (let j = 0; j < src.h; j++) for (let i = 0; i < src.w; i++) {
      const X = Math.floor(m[0] * (x + (i + 0.5) * w / src.w) + m[2]), Y = Math.floor(m[1] * (y + (j + 0.5) * h / src.h) + m[3]);
      if (X >= 0 && X < c.w && Y >= 0 && Y < c.h) c.px.set(src.px.subarray((j * src.w + i) * 4, (j * src.w + i) * 4 + 4), (Y * c.w + X) * 4);
    }
  }
}
globalThis.OffscreenCanvas = Canvas;
globalThis.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };
globalThis.FileReader = class { readAsArrayBuffer(blob) { blob.arrayBuffer().then(b => { this.result = b; this.onloadend(); }); } };
globalThis.self = globalThis;
// GLTFLoader reads images through object URLs: hand back the canvas pixels the export wrote.
const blobs = new Map(), objectURL = URL.createObjectURL;
URL.createObjectURL = b => { const u = objectURL(b); blobs.set(u, b); return u; };
THREE.TextureLoader.prototype.load = function (url, onLoad) {
  const t = new THREE.Texture();
  blobs.get(url).arrayBuffer().then(b => {
    const [w, h] = new Uint32Array(b, 0, 2);
    t.image = { data: new Uint8Array(b, 8), width: w, height: h };
    onLoad(t);
  });
  return t;
};

// Baked maps as bakedMaterials makes them: RGBA rows from v = 0, flipY off, a normal map with normalScale (1, 1).
const S = 8;
let seed = 7;
const rand = () => ((seed = Math.imul(seed, 1103515245) + 12345 >>> 0) / 2 ** 32);
const dataTexture = (fill, colorSpace = THREE.NoColorSpace) => {
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) data.set([...fill(), 255], i * 4);
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = colorSpace;
  t.needsUpdate = true;
  return t;
};
const byte = () => Math.floor(rand() * 256);
const normalTexel = () => {
  const x = rand() * 1.2 - 0.6, y = rand() * 1.2 - 0.6, z = Math.sqrt(1 - x * x - y * y);
  return [x, y, z].map(c => Math.round((c * 0.5 + 0.5) * 255));
};
const baked = new THREE.MeshStandardMaterial({
  map: dataTexture(() => [byte(), byte(), byte()], THREE.SRGBColorSpace), normalMap: dataTexture(normalTexel),
  roughnessMap: dataTexture(() => [byte(), byte(), byte()]), metalnessMap: dataTexture(() => [byte(), byte(), byte()]), aoMap: dataTexture(() => [byte(), byte(), byte()]),
});
baked.normalScale.set(1, 1);
// A kept original map loaded by TGALoader: a DataTexture whose first row is the top of the image.
const tga = dataTexture(() => [byte(), byte(), byte()], THREE.SRGBColorSpace);
tga.flipY = true;
const kept = new THREE.MeshStandardMaterial({ map: tga });

// Two quads facing +Z with u along +X and v along +Y, one per material, as exportObjects writes them. On this plane the
// app's MikkTSpace frame (bitangent along +v, test_tangents) and three's derivative frame are both (X, Y, Z).
const quad = x => [x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0];
const object = {
  name: 'quads', positions: new Float32Array([...quad(0), ...quad(2)]), normals: new Float32Array(24).map((_, i) => (i % 3 === 2 ? 1 : 0)),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]), colors: null,
  index: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]), triMat: new Uint16Array([0, 0, 1, 1]),
  materials: [{ source: baked, color: [1, 1, 1] }, { source: kept, color: [1, 1, 1] }],
};
let bytes = null;
try {
  bytes = await glbBytes([object], 1);
} catch (err) {
  check(false, `export with baked normal, roughness, metalness and occlusion maps goes through (${err.message})`);
}
if (bytes) {
  check(true, `export with baked normal, roughness, metalness and occlusion maps goes through (${bytes.length} bytes)`);
  check(baked.normalMap.isDataTexture && baked.roughnessMap.isDataTexture && kept.map === tga, 'the app\'s own materials keep their DataTextures');
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
  const mats = [];
  gltf.scene.traverse(o => { if (o.isMesh) mats.push(...[o.material].flat()); });
  const [a, b] = mats;
  check(mats.length === 2 && a.normalMap && a.map && a.aoMap && a.roughnessMap && a.roughnessMap === a.metalnessMap && b.map,
    'read back: base colour, normal, occlusion, and roughness and metalness as one texture');
  check(a.normalScale.x === 1 && a.normalScale.y === -1, `read back without tangents, the loader turns the normal map's green around (normalScale ${a.normalScale.toArray()})`);
  // Texel (i, j) sits at u = (i + 0.5) / S, v = (j + 0.5) / S: row j of a baked map, row j of a loaded glTF image
  // (flipY off), and row S - 1 - j of the TGA-style map (flipY on).
  const rows = (tex, flip) => (i, j) => tex.image.data.subarray(((flip ? S - 1 - j : j) * S + i) * 4, ((flip ? S - 1 - j : j) * S + i) * 4 + 4);
  const app = { n: rows(baked.normalMap), r: rows(baked.roughnessMap), m: rows(baked.metalnessMap), o: rows(baked.aoMap), c: rows(baked.map), k: rows(tga, true) };
  const back = { n: rows(a.normalMap), mr: rows(a.roughnessMap), o: rows(a.aoMap), c: rows(a.map), k: rows(b.map) };
  const decode = (t, scale) => [t[0], t[1], t[2]].map((c, k) => (c / 255 * 2 - 1) * (k < 2 ? scale.getComponent(k) : 1));
  let worst = 0, mr = 0, ao = 0, base = 0, flipped = 0;
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const p = decode(app.n(i, j), baked.normalScale), q = decode(back.n(i, j), a.normalScale);
    const lp = Math.hypot(...p), lq = Math.hypot(...q);
    worst = Math.max(worst, Math.acos(Math.min(1, (p[0] * q[0] + p[1] * q[1] + p[2] * q[2]) / lp / lq)) * 180 / Math.PI);
    if (back.mr(i, j)[1] !== app.r(i, j)[1] || back.mr(i, j)[2] !== app.m(i, j)[2]) mr++;
    if (back.o(i, j)[0] !== app.o(i, j)[0]) ao++;
    if (back.c(i, j).some((x, k) => x !== app.c(i, j)[k])) base++;
    if (back.k(i, j).some((x, k) => x !== app.k(i, j)[k])) flipped++;
  }
  check(worst < 0.5, `the loaded normal map gives the normals the app shows (worst ${worst.toFixed(2)}°)`);
  check(mr === 0, `roughness in green and metalness in blue at every texel (${mr} of ${S * S} off)`);
  check(ao === 0 && base === 0, `occlusion and base colour at every texel (${ao} and ${base} of ${S * S} off)`);
  check(flipped === 0, `a DataTexture with flipY reads back the same way round (${flipped} of ${S * S} off)`);
}
