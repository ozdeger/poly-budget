// Opens a model file in Node as the app does, with the textures it asks for: for the command line, the bench and the
// renderer. three.js loaders expect a browser, so a few of its globals stand in while a file is read. Textures are found
// (on disk, or inside the file) but not decoded: each remembers where its bytes are, for the export to copy them.
import fs from 'fs';
import path from 'path';
import { resolveObjectURL } from 'buffer';
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { MeshoptDecoder } from 'meshoptimizer';
import { readFbxUnitScale } from '../src/core.js';

// FBXLoader reads the window size for cameras, GLTFLoader self.URL for embedded images, GLTFExporter its output with
// FileReader.
globalThis.window ??= { innerWidth: 1920, innerHeight: 1080 };
globalThis.self ??= globalThis;
globalThis.FileReader ??= class FileReader {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(b => { this.result = b; if (this.onloadend) this.onloadend(); }); }
  readAsDataURL(blob) {
    blob.arrayBuffer().then(b => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(b).toString('base64')}`;
      if (this.onloadend) this.onloadend();
    });
  }
};

// As in src/app.js: the files it opens, the map slots it reads, and how a texture's file name picks its slot.
export const MODEL_EXT = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply'];
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'tga', 'bmp', 'gif'];
export const MAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'specularMap', 'bumpMap', 'alphaMap'];
const SLOT_RULES = [['normalMap', /normal|nrm|[_\-.]n\./i], ['roughnessMap', /rough/i], ['metalnessMap', /metal/i], ['aoMap', /(^|[_\-. ])ao([_\-. ]|$)|occlusion/i], ['emissiveMap', /emiss|glow/i]];
const NORMAL_FILE = /normal|nrm|[_\-.]n\./i;
export const extOf = name => (String(name).split('.').pop() || '').toLowerCase();
const baseName = url => { const s = String(url).split(/[\\/]/).pop().split('?')[0]; try { return decodeURIComponent(s).toLowerCase(); } catch { return s.toLowerCase(); } };
export function slotForFile(name) {
  for (const [slot, re] of SLOT_RULES) if (re.test(name)) return slot;
  return 'map';
}

const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/tga': 'tga', 'image/x-tga': 'tga', 'image/tiff': 'tif', 'image/ktx2': 'ktx2' };
// The file extension of an embedded image, from its type or its first bytes.
function imageExt(bytes, type) {
  if (IMAGE_TYPES[type]) return IMAGE_TYPES[type];
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'webp';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  return 'bin';
}

// While a file is read: textures stay undecoded stand-ins that remember their URL (or the blob or data URI an embedded
// image arrives as, taken at once, since glTF revokes its blob URLs as soon as a texture loads), and files the loaders
// fetch (a glTF's buffers) are read from disk.
async function withNodeLoaders(fn) {
  const textureLoad = THREE.TextureLoader.prototype.load, fileLoad = THREE.FileLoader.prototype.load;
  THREE.TextureLoader.prototype.load = function (url, onLoad) {
    const t = new THREE.Texture();
    t.name = url;
    if (/^blob:/.test(url)) t.userData.pbBlob = resolveObjectURL(url) || null;
    else if (/^data:/.test(url)) {
      const m = url.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
      t.userData.pbData = m ? { type: m[1], bytes: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(safeDecode(m[3])) } : null;
    } else t.userData.pbUrl = url;
    if (onLoad) queueMicrotask(() => onLoad(t));
    return t;
  };
  THREE.FileLoader.prototype.load = function (url, onLoad, onProgress, onError) {
    if (/^(https?|data|blob):/.test(url)) return fileLoad.call(this, url, onLoad, onProgress, onError);
    try {
      const buf = fs.readFileSync(decodeURIComponent(url));
      const data = this.responseType === 'arraybuffer' ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf.toString('utf8');
      queueMicrotask(() => onLoad(this.responseType === 'json' ? JSON.parse(data) : data));
    } catch (e) { if (onError) onError(e); else throw e; }
  };
  try { return await fn(); } finally {
    THREE.TextureLoader.prototype.load = textureLoad;
    THREE.FileLoader.prototype.load = fileLoad;
  }
}

// Opens file as the app does, with textures: extra files (textures, an MTL) given alongside, matched by name as the app
// matches files dropped with the model; a texture the model asks for that isn't among them is looked for next to the
// model, at the path it names and then by its name alone. Given textures the model never asks for go to a map slot
// guessed from their names, as in the app. Returns { root, meta, textures: [{ material, slot, file | embedded }],
// missing: [{ material, slot, file }] }; each texture found keeps its source in userData.pbSource
// ({ name, file } or { name: null, bytes, ext }).
export async function openModel(file, extra = []) {
  const ext = extOf(file), dir = path.dirname(path.resolve(file)), buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const given = new Map(extra.map(f => [path.basename(f).toLowerCase(), path.resolve(f)]));
  const meta = { name: path.basename(file), kind: ext, size: buf.length, unitScale: 100, bumpAsNormal: false };
  // A file next to the model: at the path a reference names, else by its name alone (any case).
  let listing = null;
  const nextTo = ref => {
    const rel = safeDecode(ref).replace(/\\/g, '/');
    const at = existing(path.resolve(dir, rel));
    if (at) return at;
    if (!listing) {
      try { listing = new Map(fs.readdirSync(dir).map(n => [n.toLowerCase(), n])); } catch { listing = new Map(); }
    }
    const n = listing.get(baseName(rel));
    return n ? existing(path.join(dir, n)) : null;
  };
  let root;
  await withNodeLoaders(async () => {
    if (ext === 'fbx') {
      meta.unitScale = readFbxUnitScale(ab) ?? 1;
      root = new FBXLoader().parse(ab, '');
    } else if (ext === 'glb' || ext === 'gltf') {
      root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(ext === 'glb' ? ab : buf.toString('utf8'), dir + path.sep)).scene;
    } else if (ext === 'obj') {
      const text = buf.toString('utf8'), loader = new OBJLoader();
      const lib = ((text.match(/^mtllib\s+(.+)$/m) || [])[1] || '').trim();
      // The MTL the OBJ names among the files given, else any MTL given, else the one it names next to it.
      const mtlFile = (lib && given.get(baseName(lib))) || [...given.values()].find(f => extOf(f) === 'mtl') || (lib && nextTo(lib));
      if (mtlFile) {
        const mtl = new MTLLoader().parse(fs.readFileSync(mtlFile, 'utf8'), '');
        mtl.preload();
        loader.setMaterials(mtl);
        meta.mtl = path.basename(mtlFile);
      }
      root = loader.parse(text);
      // OBJLoader makes up flat per-triangle normals for a file without vn; smooth ones are worked out instead.
      if (!/^vn\s/m.test(text)) root.traverse(o => { if (o.isMesh) o.geometry.deleteAttribute('normal'); });
    } else if (ext === 'stl' || ext === 'ply') {
      const geo = ext === 'stl' ? new STLLoader().parse(ab) : new PLYLoader().parse(ab), n = geo.attributes.normal;
      // STL stores one flat normal per triangle, often zero, so smooth ones are worked out, as for PLY without normals.
      if (ext === 'stl' || !n || !n.array.some(v => v !== 0)) geo.deleteAttribute('normal');
      root = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc8c2b8, vertexColors: !!geo.attributes.color, roughness: 0.7 }));
      root.name = meta.name.replace(/\.[^.]+$/, '');
    } else throw new Error(`can't open .${ext} files: open .${MODEL_EXT.join(', .')}`);
  });

  const materials = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m && m.isMaterial && !materials.includes(m)) materials.push(m);
  });
  const textures = [], missing = [], requested = new Set();
  for (const m of materials) {
    for (const slot of MAP_SLOTS) {
      const t = m[slot];
      if (!t || !t.isTexture) continue;
      const u = t.userData;
      if (u.pbBlob || u.pbData) {
        const bytes = u.pbBlob ? Buffer.from(await u.pbBlob.arrayBuffer()) : u.pbData.bytes;
        u.pbSource = { name: null, bytes, ext: imageExt(bytes, u.pbBlob ? u.pbBlob.type : u.pbData.type) };
        textures.push({ material: m.name, slot, embedded: true });
        continue;
      }
      const url = u.pbUrl;
      if (!url) continue;
      const name = baseName(url);
      requested.add(name);
      const found = given.get(name) || nextTo(url);
      if (found) {
        u.pbSource = { name: path.basename(found), file: found };
        textures.push({ material: m.name, slot, file: found });
      } else {
        missing.push({ material: m.name, slot, file: path.basename(safeDecode(url).replace(/\\/g, '/')) });
        m[slot] = null;
      }
    }
  }
  // Given images the model never asked for: base colour, or a map type guessed from the file name.
  for (const [name, f] of given) {
    if (requested.has(name) || !IMAGE_EXT.includes(extOf(name))) continue;
    const slot = slotForFile(name), targets = materials.filter(m => slot in m && (materials.length === 1 || !m[slot]));
    for (const m of targets) {
      const t = new THREE.Texture();
      t.name = path.basename(f);
      t.userData.pbSource = { name: path.basename(f), file: f };
      m[slot] = t;
      textures.push({ material: m.name, slot, file: f, loose: true });
    }
  }
  // OBJ exporters list normal maps under map_Bump, which MTLLoader loads as a bump map.
  for (const m of materials) {
    const bump = m.bumpMap && m.bumpMap.userData.pbSource && (m.bumpMap.userData.pbSource.name || '');
    if (bump && 'normalMap' in m && !m.normalMap && NORMAL_FILE.test(bump)) {
      m.normalMap = m.bumpMap;
      m.bumpMap = null;
      meta.bumpAsNormal = true;
      for (const t of textures) if (t.material === m.name && t.slot === 'bumpMap') t.slot = 'normalMap';
    }
  }
  return { root, meta, textures, missing };
}

// The scene alone, for the bench and the renderer.
export async function load(file) {
  return (await openModel(file)).root;
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }
function existing(f) { try { return fs.statSync(f).isFile() ? f : null; } catch { return null; } }
