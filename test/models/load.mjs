// Opens a model file in Node as the app does, for the bench and the renderer.
import fs from 'fs';
import path from 'path';
import { THREE } from '../helpers.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { MeshoptDecoder } from 'meshoptimizer';

// The glTF loader reads browser globals (self.URL) for embedded images.
globalThis.self ??= globalThis;
// glTF waits for its textures to load; here they are empty stand-ins, handed over at once. Its buffers next to the file
// are read from disk, which fetch() can't do here.
THREE.TextureLoader.prototype.load = function (url, onLoad) { const t = new THREE.Texture(); t.name = url; if (onLoad) queueMicrotask(() => onLoad(t)); return t; };
const fileLoad = THREE.FileLoader.prototype.load;
THREE.FileLoader.prototype.load = function (url, onLoad, onProgress, onError) {
  if (/^(https?|data|blob):/.test(url)) return fileLoad.call(this, url, onLoad, onProgress, onError);
  try {
    const buf = fs.readFileSync(decodeURIComponent(url));
    const data = this.responseType === 'arraybuffer' ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf.toString('utf8');
    queueMicrotask(() => onLoad(this.responseType === 'json' ? JSON.parse(data) : data));
  } catch (e) { if (onError) onError(e); else throw e; }
};

// As the app opens it: normals dropped where the file has none of its own (OBJ without vn, STL, PLY without normals),
// so smooth ones are worked out instead of flat ones that split every vertex.
export async function load(file) {
  const ext = path.extname(file).slice(1).toLowerCase(), buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  if (ext === 'fbx') return new FBXLoader().parse(ab, '');
  if (ext === 'glb' || ext === 'gltf') return (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(ext === 'glb' ? ab : buf.toString('utf8'), path.dirname(file) + '/')).scene;
  if (ext === 'obj') {
    const text = buf.toString('utf8'), root = new OBJLoader().parse(text);
    if (!/^vn\s/m.test(text)) root.traverse(o => { if (o.isMesh) o.geometry.deleteAttribute('normal'); });
    return root;
  }
  if (ext === 'stl' || ext === 'ply') {
    const geo = ext === 'stl' ? new STLLoader().parse(ab) : new PLYLoader().parse(ab), n = geo.attributes.normal;
    if (ext === 'stl' || !n || !n.array.some(v => v !== 0)) geo.deleteAttribute('normal');
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ name: 'Material', vertexColors: !!geo.attributes.color }));
  }
  throw new Error(`can't open .${ext}`);
}
