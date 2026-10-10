import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// three's GLTFExporter draws normal maps onto a 2D canvas to turn their green (for every mesh without tangents, so for
// all of these) and roughness and metalness maps to merge them, and drawImage refuses a DataTexture's { data, width,
// height }. Baked maps are DataTextures, so the export takes canvas copies, rows in the same order and flipY kept: the
// exporter writes those the way the app samples them, which it gets wrong for raw pixels with flipY set (TGALoader's).
const canvasOf = (w, h) => (typeof document === 'undefined' && typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
function drawable(tex, copies) {
  const img = tex.image;
  if (!img || !ArrayBuffer.isView(img.data) || img.data.BYTES_PER_ELEMENT !== 1 || img.data.length !== img.width * img.height * 4) return tex;
  if (!copies.has(tex)) {
    const canvas = canvasOf(img.width, img.height);
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), img.width, img.height), 0, 0);
    const t = new THREE.Texture().copy(tex);
    t.source = new THREE.TextureSource(canvas);
    copies.set(tex, t);
  }
  return copies.get(tex);
}

// The result as a binary glTF: one mesh per object, triangles grouped by material, positions times scale.
export async function glbBytes(objects, scale) {
  const scene = new THREE.Scene(), copies = new Map();
  for (const o of objects) {
    const P = Float32Array.from(o.positions, v => v * scale);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(o.normals, 3));
    if (o.uvs) g.setAttribute('uv', new THREE.BufferAttribute(o.uvs, 2));
    if (o.colors) g.setAttribute('color', new THREE.BufferAttribute(o.colors, 3));
    const T = o.index.length / 3, nm = Math.max(1, o.materials.length);
    const order = [...Array(T).keys()].sort((a, b) => o.triMat[a] - o.triMat[b]);
    const idx = new Uint32Array(o.index.length);
    order.forEach((t, j) => idx.set(o.index.subarray(t * 3, t * 3 + 3), j * 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    let start = 0;
    for (let m = 0; m < nm; m++) {
      let c = 0;
      while (start / 3 + c < T && o.triMat[order[start / 3 + c]] === m) c++;
      if (c) g.addGroup(start, c * 3, m);
      start += c * 3;
    }
    const mats = o.materials.map(mi => {
      if (mi.source && mi.source.isMaterial) {
        const mat = mi.source.clone();
        mat.polygonOffset = false;
        for (const key of Object.keys(mat)) if (mat[key] && mat[key].isTexture) mat[key] = drawable(mat[key], copies);
        return mat;
      }
      return new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...mi.color, THREE.SRGBColorSpace) });
    });
    const mesh = new THREE.Mesh(g, mats.length > 1 ? mats : mats[0] || new THREE.MeshStandardMaterial());
    mesh.name = o.name;
    scene.add(mesh);
  }
  return new Uint8Array(await new GLTFExporter().parseAsync(scene, { binary: true }));
}
