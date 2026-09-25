import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import { MeshBVH, INTERSECTED, NOT_INTERSECTED, MeshBVHUniformStruct, FloatVertexAttributeTexture, BVHShaderGLSL } from 'three-mesh-bvh';
import { LABEL, AUTO_UV_LIMIT, smartWeld, bounds, packAttributes, runReduction, mirrorOriginal, unwrapResult, uvEdges, exportObjects, writeFBX, writeOBJ, readFbxUnitScale } from './core.js';
import { collectScene } from './collect.js';

const $ = id => document.getElementById(id);
const numberFormat = new Intl.NumberFormat('en-US');
const fmt = n => numberFormat.format(Math.round(n));
const nextFrame = () => new Promise(resolve => {
  let done = false;
  const go = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(() => setTimeout(go, 0));
  setTimeout(go, 60);
});
const MESHOPT_URL = 'https://cdn.jsdelivr.net/npm/meshoptimizer@1.2.0/meshopt_simplifier.js';

// ---------- settings ----------
const STORE = 'poly-budget:settings:v1';
const DEFAULTS = {
  targetPct: 10, maxError: 0, hardAngle: 30, weldTol: 25, normals: 'original', creaseAngle: 60,
  optimizePositions: true, regularize: 1, lockBorder: false, permissive: false, prune: false,
  normalWeight: 0.5, uvWeight: 1, format: 'fbx', units: 'auto', uvMode: 'auto', bakeSize: 1024,
  view: 'split', shading: 'textured', wire: false, showPaint: true, brush: 6, strength: 2, mode: 'brush', tool: 'orbit',
  symmetry: false, symSide: '+', tintMirror: true, showPlane: true, sections: {},
  uvOpen: false, uvWidth: 420, uvLines: 'all', uvPanes: 'both', uvSlot: 'map',
};
const settings = { ...DEFAULTS };
// Only settings the tool still has are read back, so options removed since they were saved drop out.
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
  for (const key of Object.keys(DEFAULTS)) if (key in saved) settings[key] = saved[key];
} catch { /* storage unavailable */ }
let saveTimer = 0;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch { /* storage unavailable */ } }, 300);
}

// ---------- tabs ----------
// Each tab is a document: its model, paint, mirror plane, results, camera and the model settings in DOC_KEYS. `state`,
// `symPlane` and `session` always point at the active tab's; the other settings are shared preferences.
const DOC_KEYS = ['targetPct', 'maxError', 'hardAngle', 'weldTol', 'normals', 'creaseAngle', 'optimizePositions', 'regularize',
  'lockBorder', 'permissive', 'prune', 'normalWeight', 'uvWeight', 'uvMode', 'bakeSize', 'symmetry', 'symSide'];
const docSettings = () => Object.fromEntries(DOC_KEYS.map(k => [k, settings[k]]));
let docSeq = 0;
const newDocId = () => `t${Date.now().toString(36)}${(docSeq++).toString(36)}`;
// saved: the stored record of a tab from the last visit; its model loads the first time the tab is shown.
function newDoc(saved = null) {
  return {
    id: saved ? saved.id : newDocId(),
    title: saved ? saved.title || saved.model : 'New tab',
    state: {
      meta: null, collected: null, welded: null, labels: null, result: null, info: null, engineMesh: null,
      orig: { bvh: null, index: null }, left: null, diag: 1, size: 1, undo: [], redo: [], strokeSnapshot: null, strokeChanged: false,
      painting: false, displayMats: [], pendingMaps: [], hasColors: false, bake: null, bakedMats: null, geo: null, texturing: null,
    },
    symPlane: { axis: 0, offset: 0, fit: null, ready: false },
    session: { model: null, files: new Map(), ready: false },
    settings: saved && saved.settings ? { ...docSettings(), ...saved.settings } : docSettings(),
    camera: null, dirty: false, saved,
  };
}
const docs = [newDoc()];
let doc = docs[0], state = doc.state, symPlane = doc.symPlane, session = doc.session;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const UNDO_KEY = IS_MAC ? '⌘Z' : 'Ctrl+Z';
const REDO_KEY = IS_MAC ? '⇧⌘Z' : 'Ctrl+Y';

// ---------- renderer ----------
const viewport = $('viewport');
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
const envTexture = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const sceneL = new THREE.Scene(), sceneR = new THREE.Scene();
for (const s of [sceneL, sceneR]) {
  s.environment = envTexture;
  s.environmentIntensity = 0.55;
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(2.5, 4, 3);
  const rim = new THREE.DirectionalLight(0xffffff, 0.9);
  rim.position.set(-3.5, 2, -4);
  s.add(key, rim, new THREE.HemisphereLight(0xffffff, 0x3a3530, 0.35));
}
const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 1000);
const controls = new OrbitControls(camera, canvas);
controls.addEventListener('change', requestRender);
controls.addEventListener('end', () => saveSessionSoon());

const clayMat = new THREE.MeshStandardMaterial({ roughness: 0.66, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const facetMat = clayMat.clone();
facetMat.flatShading = true;
const wireMat = new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.4, depthWrite: false });
const paintMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
const ringMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide });
const ringGeo = new THREE.RingGeometry(0.93, 1, 72);
const ringL = new THREE.Mesh(ringGeo, ringMat), ringR = new THREE.Mesh(ringGeo, ringMat);
ringL.renderOrder = ringR.renderOrder = 10;
ringL.visible = ringR.visible = false;
sceneL.add(ringL);
sceneR.add(ringR);
const ringL2 = new THREE.Mesh(ringGeo, ringMat), ringR2 = new THREE.Mesh(ringGeo, ringMat);
ringL2.renderOrder = ringR2.renderOrder = 10;
ringL2.visible = ringR2.visible = false;
sceneL.add(ringL2);
sceneR.add(ringR2);

renderer.localClippingEnabled = true;
const tintPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
const tintMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.16, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2, clippingPlanes: [tintPlane] });
const planeMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false });
const planeEdgeMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.7 });
const planeGeo = new THREE.PlaneGeometry(1, 1);
const planeEdgeGeo = new THREE.EdgesGeometry(planeGeo);
function makePlaneHelper() {
  const g = new THREE.Group();
  const face = new THREE.Mesh(planeGeo, planeMat), edge = new THREE.LineSegments(planeEdgeGeo, planeEdgeMat);
  face.renderOrder = edge.renderOrder = 5;
  g.add(face, edge);
  g.visible = false;
  return g;
}
const planeL = makePlaneHelper(), planeR = makePlaneHelper();
sceneL.add(planeL);
sceneR.add(planeR);

const display = { L: null, R: null };
const paintRGB = { more: [0, 0, 0], less: [0, 0, 0], keep: [0, 0, 0] };
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function applyTheme() {
  renderer.setClearColor(new THREE.Color(cssVar('--viewport')), 1);
  clayMat.color.set(cssVar('--clay'));
  facetMat.color.set(cssVar('--clay'));
  wireMat.color.set(cssVar('--wire'));
  ringMat.color.set(cssVar('--text'));
  planeMat.color.set(cssVar('--accent'));
  tintMat.color.set(cssVar('--accent'));
  planeEdgeMat.color.set(cssVar('--accent'));
  for (const k of ['more', 'less', 'keep']) {
    const c = new THREE.Color(cssVar(`--${k}`));
    paintRGB[k] = [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
  }
  if (state.labels) recolorAll();
  requestRender();
  uvThemeChanged();
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// Bounds of a position array, worked out once per array (welded positions are never changed in place).
const boundsCache = new WeakMap();
function boundsOf(positions) {
  let b = boundsCache.get(positions);
  if (!b) boundsCache.set(positions, (b = bounds(positions)));
  return b;
}

// ---------- layout & render ----------
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(render);
}
function rects() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (settings.view === 'original') return { L: { x: 0, y: 0, w, h }, R: null, split: null };
  if (settings.view === 'reduced') return { L: null, R: { x: 0, y: 0, w, h }, split: null };
  if (w >= h * 0.95) {
    const half = Math.floor(w / 2);
    return { L: { x: 0, y: 0, w: half, h }, R: { x: half, y: 0, w: w - half, h }, split: 'v' };
  }
  const half = Math.floor(h / 2);
  return { L: { x: 0, y: 0, w, h: half }, R: { x: 0, y: half, w, h: h - half }, split: 'h' };
}
function render() {
  renderQueued = false;
  const r = rects();
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setScissorTest(true);
  for (const [scene, rc] of [[sceneL, r.L], [sceneR, r.R]]) {
    if (!rc) continue;
    const y = h - rc.y - rc.h;
    renderer.setViewport(rc.x, y, rc.w, rc.h);
    renderer.setScissor(rc.x, y, rc.w, rc.h);
    camera.aspect = rc.w / Math.max(1, rc.h);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  }
  positionOverlays(r, w, h);
}
function positionOverlays(r, w, h) {
  const opts = $('toolOpts'), pal = $('toolPal'), below = opts.hidden ? 0 : opts.offsetHeight + 10;
  // Labels move below the options bar, and right of the tool palette where they would sit behind it.
  const palTop = pal.hidden ? Infinity : pal.offsetTop - pal.offsetHeight / 2, palBottom = palTop + pal.offsetHeight;
  const place = (el, rc) => {
    el.hidden = !rc;
    if (!rc) return;
    const top = rc.y + 12 + (rc.y === 0 ? below : 0);
    const clear = rc.x < 70 && top < palBottom && top + 28 > palTop;
    el.style.left = `${clear ? 70 : rc.x + 12}px`;
    el.style.top = `${top}px`;
  };
  const shown = !!state.welded;
  place($('labelL'), shown && r.L);
  place($('labelR'), shown && r.R);
  $('hint').hidden = !shown;
  const d = $('divider');
  d.hidden = !r.split || !shown;
  if (r.split === 'v') Object.assign(d.style, { left: `${r.R.x}px`, top: '0px', width: '1px', height: `${h}px` });
  if (r.split === 'h') Object.assign(d.style, { left: '0px', top: `${r.R.y}px`, width: `${w}px`, height: '1px' });
}
new ResizeObserver(() => {
  renderer.setSize(viewport.clientWidth, viewport.clientHeight, false);
  requestRender();
}).observe(viewport);

function frameCamera() {
  if (!state.welded) return;
  const b = boundsOf(state.welded.positions);
  const center = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  const radius = b.diag / 2;
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.08;
  const dir = new THREE.Vector3(0.55, 0.32, 1).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = dist / 200;
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
  requestRender();
  saveSessionSoon();
}

// ---------- reduction engine (worker, with a main-thread fallback) ----------
let workerURL = null;
function workerSource() {
  if (!workerURL) workerURL = URL.createObjectURL(new Blob([$('worker-src').textContent], { type: 'text/javascript' }));
  return workerURL;
}
const engine = {
  worker: null, local: null, seq: 0, waiters: new Map(), failed: false,
  start() {
    try {
      this.worker = new Worker(workerSource(), { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        const w = this.waiters.get(data.id);
        if (!w) return;
        this.waiters.delete(data.id);
        if (data.type === 'error') w.reject(new Error(data.message)); else w.resolve(data);
      };
      this.worker.onerror = e => { e.preventDefault(); this.fallback(); };
    } catch { this.fallback(); }
  },
  fallback() {
    if (this.failed) return;
    this.failed = true;
    if (this.worker) this.worker.terminate();
    this.worker = null;
    const pending = [...this.waiters.values()];
    this.waiters.clear();
    for (const w of pending) this.callLocal(w.msg).then(w.resolve, w.reject);
  },
  call(msg) {
    if (!this.worker) return this.callLocal(msg);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject, msg });
      this.worker.postMessage({ ...msg, id });
    });
  },
  async callLocal(msg) {
    if (!this.local) {
      const mod = await import(MESHOPT_URL);
      await mod.MeshoptSimplifier.ready;
      this.local = { S: mod.MeshoptSimplifier, ctxs: new Map() };
    }
    const L = this.local;
    if (msg.type === 'unload') { L.ctxs.delete(msg.doc); return { type: 'unloaded' }; }
    let ctx = L.ctxs.get(msg.doc);
    if (msg.type === 'load' || !ctx) {
      const owner = docs.find(d => d.id === msg.doc);
      const mesh = msg.type === 'load' ? msg.mesh : owner && owner.state.engineMesh;
      if (!mesh) throw new Error('that tab has no model loaded');
      ctx = { mesh, packed: packAttributes(mesh), half: null };
      L.ctxs.set(msg.doc, ctx);
      if (msg.type === 'load') return { type: 'loaded' };
    }
    if (msg.type === 'mirror') return { type: 'mirrored', result: mirrorOriginal(ctx, msg.plane) };
    const { result, info } = runReduction(L.S, ctx, msg.labels, msg.settings, msg.finalize);
    return { type: 'reduced', result, info };
  },
  // The worker keeps one context per tab.
  async load(id, mesh) {
    try { return await this.call({ type: 'load', doc: id, mesh }); }
    catch { this.fallback(); return this.callLocal({ type: 'load', doc: id, mesh }); }
  },
  unload(id) { this.call({ type: 'unload', doc: id }).catch(() => {}); },
};

// New UVs are unwrapped in a second worker, so reductions never wait behind an unwrap. Starting a job ends the one
// still running (its promise rejects with 'cancelled').
const texEngine = {
  worker: null, seq: 0, job: null, failed: false,
  cancel() {
    if (!this.job) return;
    this.job.reject(new Error('cancelled'));
    this.job = null;
    if (this.worker) this.worker.terminate();
    this.worker = null;
  },
  run(msg) {
    this.cancel();
    if (!this.failed && !this.worker) {
      try {
        this.worker = new Worker(workerSource(), { type: 'module' });
        this.worker.onmessage = ({ data }) => {
          const job = this.job;
          if (!job || data.id !== job.id) return;
          this.job = null;
          if (data.type === 'error') job.reject(new Error(data.message)); else job.resolve(data);
        };
        this.worker.onerror = e => {
          e.preventDefault();
          this.failed = true;
          const job = this.job;
          this.job = null;
          this.worker.terminate();
          this.worker = null;
          if (job) this.runLocal(job.msg).then(job.resolve, job.reject);
        };
      } catch { this.failed = true; }
    }
    if (this.failed) return this.runLocal(msg);
    return new Promise((resolve, reject) => {
      this.job = { id: ++this.seq, resolve, reject, msg };
      this.worker.postMessage({ ...msg, id: this.job.id });
    });
  },
  async runLocal(msg) {
    await nextFrame();
    return unwrapResult(msg.mesh, msg.plane, msg.labels, msg.size);
  },
};

// ---------- last session ----------
// Open tabs are kept in this browser (IndexedDB) and reopen on the next visit: per tab, the model and the files that
// came with it, texture assignments, paint, mirror plane, camera and model settings. Keys: 'tabs' (order and active
// tab), '<tab>:session' and '<tab>:file:<name>'. Shared settings are kept in localStorage (STORE).
const SESSION_DB = 'poly-budget', SESSION_STORE = 'session';
let sessionDB = null;
function openSessionDB() {
  if (!sessionDB) {
    sessionDB = new Promise(resolve => {
      try {
        const req = indexedDB.open(SESSION_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(SESSION_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return sessionDB;
}
// Runs fn(store) in one transaction and resolves with whatever fn returns, once the transaction has completed.
async function sessionTx(mode, fn) {
  const db = await openSessionDB();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(SESSION_STORE, mode);
      const out = fn(tx.objectStore(SESSION_STORE));
      tx.oncomplete = () => resolve(typeof out === 'function' ? out() : out);
      tx.onerror = tx.onabort = () => reject(tx.error);
    } catch (err) { reject(err); }
  });
}
const readKeys = keys => sessionTx('readonly', store => { const rs = keys.map(k => store.get(k)); return () => rs.map(r => r.result); });
// Stores a tab's files; replace starts a new model in the tab and drops the previous one's files.
async function rememberFiles(d, files, replace) {
  const s = d.session, prefix = `${d.id}:file:`;
  if (replace) s.files.clear();
  for (const f of files) s.files.set(f.name, f);
  try {
    await sessionTx('readwrite', store => {
      if (replace) {
        const keys = store.getAllKeys();
        keys.onsuccess = () => { for (const k of keys.result) if (String(k).startsWith(prefix) && !s.files.has(String(k).slice(prefix.length))) store.delete(k); };
      }
      for (const f of files) store.put(f, prefix + f.name);
    });
  } catch (err) {
    console.error(err);
    setStatus("Couldn't keep this model for next time: browser storage is full or blocked", 'info', 6000);
  }
}
let sessionTimer = 0;
function saveSessionSoon(delay = 700) {
  if (!session.ready) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(saveSession, delay);
}
// Tabs that have a model, or are waiting to reopen one, in tab order.
function tabsRecord() {
  const kept = docs.filter(d => d.session.model || d.saved);
  return { version: 2, order: kept.map(d => d.id), active: kept.includes(doc) ? doc.id : kept[0] ? kept[0].id : null };
}
async function saveTabs() {
  try { await sessionTx('readwrite', store => { store.put(tabsRecord(), 'tabs'); }); } catch { /* storage unavailable */ }
}
// Saves the active tab and the tab list.
async function saveSession() {
  clearTimeout(sessionTimer);
  if (!session.ready || !state.meta || state.meta.name !== session.model) return saveTabs();
  const names = new Map([...session.files.keys()].map(n => [n.toLowerCase(), n]));
  const textures = [];
  state.displayMats.forEach((m, mat) => {
    for (const slot of MAP_SLOTS) {
      const file = m[slot] && m[slot].userData && m[slot].userData.pbFile;
      if (file && names.has(file)) textures.push({ mat, slot, file });
    }
  });
  const id = doc.id;
  const record = {
    version: 2, id, title: doc.title, model: session.model, files: [...session.files.keys()], textures, settings: docSettings(),
    labels: state.labels, weld: { hardAngle: settings.hardAngle, weldTol: settings.weldTol },
    symPlane: symPlane.ready ? { axis: symPlane.axis, offset: symPlane.offset } : null,
    camera: { position: camera.position.toArray(), target: controls.target.toArray() },
  };
  try { await sessionTx('readwrite', store => { store.put(record, `${id}:session`); store.put(tabsRecord(), 'tabs'); }); } catch (err) { console.error(err); }
}
async function forgetDoc(id) {
  try {
    await sessionTx('readwrite', store => {
      const keys = store.getAllKeys();
      keys.onsuccess = () => { for (const k of keys.result) if (String(k).startsWith(`${id}:`)) store.delete(k); };
      store.put(tabsRecord(), 'tabs');
    });
  } catch { /* storage unavailable */ }
}
// Moves the single saved session from before tabs existed into a tab.
async function migrateSession() {
  const [old] = await readKeys(['session']);
  if (!old || !old.model || !old.files) return null;
  const files = await readKeys(old.files.map(n => `file:${n}`));
  const id = newDocId(), index = { version: 2, order: [id], active: id };
  await sessionTx('readwrite', store => {
    old.files.forEach((n, i) => { if (files[i]) store.put(files[i], `${id}:file:${n}`); store.delete(`file:${n}`); });
    store.delete('session');
    store.put({ ...old, version: 2, id, title: old.model.replace(/\.[^.]+$/, '') }, `${id}:session`);
    store.put(index, 'tabs');
  });
  return index;
}
// Recreates the last visit's tabs: the active one loads now, the others the first time they are shown.
async function restoreTabs() {
  let records = [], index = null;
  try {
    [index] = await readKeys(['tabs']);
    if (!index) index = await migrateSession();
    if (!index || !index.order || !index.order.length) return false;
    records = await readKeys(index.order.map(id => `${id}:session`));
  } catch { return false; }
  const restored = (records || []).filter(r => r && r.model && r.files && r.files.length).map(r => newDoc(r));
  if (!restored.length) return false;
  docs.splice(0, docs.length, ...restored);
  await activate(restored.find(d => d.id === index.active) || restored[0]);
  return !!state.welded;
}
// Loads a tab restored from the last visit, the first time it is shown.
async function loadSavedDoc(d) {
  const rec = d.saved;
  let files = [];
  try { files = await readKeys(rec.files.map(n => `${d.id}:file:${n}`)); } catch { files = []; }
  files = (files || []).map((f, i) => (f instanceof File ? f : f ? new File([f], rec.files[i], { type: f.type }) : null)).filter(Boolean);
  if (files.some(f => f.name === rec.model)) {
    setStatus(`Reopening ${rec.model} from your last visit…`);
    await openFiles(files, rec);
  }
  d.saved = null;
  if (d.state.meta && d.state.meta.name === rec.model) return true;
  showError(`Couldn't reopen ${rec.model} from your last visit`);
  d.title = 'New tab';
  forgetDoc(d.id);
  renderTabs();
  if (d === doc) attachDoc();
  return false;
}
// Puts back the texture each material slot had, for slots that loading alone doesn't reproduce (picked on a tile, added files).
async function applyTextureState(list) {
  for (const t of list || []) {
    const m = state.displayMats[t.mat], file = state.meta.files.get(t.file);
    if (!m || !file || !(t.slot in m) || (m[t.slot] && m[t.slot].userData.pbFile === t.file)) continue;
    m[t.slot] = await textureFromFile(file, t.slot);
    m.needsUpdate = true;
    state.pendingMaps = state.pendingMaps.filter(p => !(p.material === m && p.slot === t.slot));
  }
}

// ---------- import ----------
const MODEL_EXT = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'tga', 'bmp', 'gif'];
function extOf(name) { return (name.split('.').pop() || '').toLowerCase(); }
const baseName = url => decodeURIComponent(String(url).split(/[\\/]/).pop().split('?')[0]).toLowerCase();

// Every texture a loader requests remembers its file name, and whether the file was missing.
const loadTextureOriginal = THREE.TextureLoader.prototype.load;
THREE.TextureLoader.prototype.load = function (url, onLoad, onProgress, onError) {
  let texture = null;
  texture = loadTextureOriginal.call(this, url, onLoad, onProgress, err => {
    if (texture) texture.userData.pbMissing = true;
    if (onError) onError(err);
  });
  if (!texture.userData.pbFile) texture.userData.pbFile = baseName(url);
  return texture;
};
const MAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'specularMap', 'bumpMap', 'alphaMap'];
const COLOR_SLOTS = new Set(['map', 'emissiveMap', 'specularMap']);
const SLOT_NAMES = { map: 'base colour', normalMap: 'normal', roughnessMap: 'roughness', metalnessMap: 'metalness', aoMap: 'occlusion', emissiveMap: 'emissive', specularMap: 'specular', bumpMap: 'bump', alphaMap: 'alpha' };
const SLOT_RULES = [['normalMap', /normal|nrm|[_\-.]n\./i], ['roughnessMap', /rough/i], ['metalnessMap', /metal/i], ['aoMap', /(^|[_\-. ])ao([_\-. ]|$)|occlusion/i], ['emissiveMap', /emiss|glow/i]];
function slotForFile(name) {
  for (const [slot, re] of SLOT_RULES) if (re.test(name)) return slot;
  return 'map';
}

// restore: a saved session record whose model these files are; its paint, plane, camera and textures are put back.
async function openFiles(fileList, restore = null) {
  const files = [...fileList];
  if (!files.length) return;
  const main = MODEL_EXT.map(e => files.find(f => extOf(f.name) === e)).find(Boolean);
  const images = files.filter(f => IMAGE_EXT.includes(extOf(f.name)));
  if (!main) {
    if (images.length && state.collected) { await addTextures(images); return; }
    showError(images.length ? 'Open a model first, then add its textures.' : 'No model in those files. Open an .fbx, .obj, .glb, .gltf, .stl or .ply, with or without its textures.');
    return;
  }
  if (loading) { showError('Wait for the model that is loading to finish.'); return; }
  // A model opens in a new tab unless this tab is empty or shows the sample.
  if (!restore && state.welded && !state.meta.sample) await openTab(newDoc());
  loading = doc;
  renderTabs();
  const byName = new Map(files.map(f => [f.name.toLowerCase(), f]));
  const urls = new Map(files.map(f => [f.name.toLowerCase(), URL.createObjectURL(f)]));
  const blobToName = new Map([...urls].map(([n, u]) => [u, byName.get(n).name]));
  const missing = new Set(), requested = new Set();
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => {
    if (/^(blob|data):/.test(url)) return url;
    const base = baseName(url);
    requested.add(base);
    if (urls.has(base)) return urls.get(base);
    missing.add(base);
    return 'data:,';
  });
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  let texturesDone = false, modelReady = false, settled = false, settleDone = null;
  const texturesSettled = new Promise(resolve => { settleDone = resolve; });
  const settle = () => {
    if (settled) return;
    settled = true;
    settleTextures(images.filter(f => !requested.has(f.name.toLowerCase()))).finally(settleDone);
  };
  manager.onLoad = () => { texturesDone = true; if (modelReady) settle(); requestRender(); };
  setStatus(`${restore ? 'Reopening' : 'Reading'} ${main.name} (${(main.size / 1048576).toFixed(1)} MB)…`);
  session.ready = false;
  await nextFrame();
  try {
    const ext = extOf(main.name);
    let root, unitScale = 100;
    if (ext === 'fbx') {
      const buf = await main.arrayBuffer();
      setStatus(`Parsing ${main.name}…`);
      await nextFrame();
      unitScale = readFbxUnitScale(buf) ?? 1;
      root = new FBXLoader(manager).parse(buf, '');
    } else if (ext === 'glb' || ext === 'gltf') {
      const data = ext === 'glb' ? await main.arrayBuffer() : await main.text();
      const gltf = await new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder).parseAsync(data, '');
      root = gltf.scene;
    } else if (ext === 'obj') {
      const text = await main.text();
      const loader = new OBJLoader(manager);
      const lib = (text.match(/^mtllib\s+(.+)$/m) || [])[1];
      const mtlFile = (lib && byName.get(lib.trim().split(/[\\/]/).pop().toLowerCase())) || files.find(f => extOf(f.name) === 'mtl');
      if (mtlFile) {
        const mtl = new MTLLoader(manager).parse(await mtlFile.text(), '');
        mtl.preload();
        loader.setMaterials(mtl);
      }
      root = loader.parse(text);
    } else {
      const buf = await main.arrayBuffer();
      const geo = ext === 'stl' ? new STLLoader().parse(buf) : new PLYLoader().parse(buf);
      // STL files often store zero facet normals; shade from the geometry instead.
      const n = geo.attributes.normal;
      if (!n || !n.array.some(v => v !== 0)) geo.computeVertexNormals();
      root = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc8c2b8, vertexColors: !!geo.attributes.color, roughness: 0.7 }));
      root.name = main.name.replace(/\.[^.]+$/, '');
    }
    await prepareModel(root, { name: main.name, size: main.size, unitScale, kind: ext, files: byName, blobToName, missing, sample: false, restore });
    modelReady = true;
    if (texturesDone || !requested.size) settle();
    session.model = main.name;
    if (restore) {
      session.files = new Map(files.map(f => [f.name, f]));
      await Promise.race([texturesSettled, new Promise(r => setTimeout(r, 20000))]);
      await applyTextureState(restore.textures);
      updateTexturePanel();
      updateModelPanel();
      applyDisplaySettings();
      refreshBake();
      setStatus(`Reopened ${main.name} as you left it. It is kept in this browser only.`, 'info', 5000);
    } else {
      rememberFiles(doc, files, true);
    }
    session.ready = true;
    saveSessionSoon(0);
  } catch (err) {
    console.error(err);
    showError(`Couldn't open ${main.name}: ${err.message || err}`);
  } finally {
    finishLoading();
  }
}

async function prepareModel(root, meta) {
  setStatus('Collecting meshes…');
  await nextFrame();
  const collected = collectScene(root);
  if (!collected.index.length) throw new Error('the file has no triangle meshes');
  state.meta = meta;
  state.collected = collected;
  doc.title = meta.sample ? 'Sample pawn' : meta.name.replace(/\.[^.]+$/, '');
  showEmptyState(false);
  renderTabs();
  state.hasColors = !!collected.colors;
  state.displayMats = collected.materials.map(m => {
    const mat = m && m.isMaterial ? m : new THREE.MeshStandardMaterial({ color: 0xc8c2b8 });
    // Loaders turn on flat shading for a GLB without normals or an OBJ with smoothing off. Here the vertex normals
    // come from the file or are worked out, and the Normals setting decides the result's, so the views follow them.
    mat.flatShading = false;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = 1;
    mat.polygonOffsetUnits = 1;
    if (state.hasColors) mat.vertexColors = true;
    mat.needsUpdate = true;
    return mat;
  });
  if (!state.displayMats.length) state.displayMats = [new THREE.MeshStandardMaterial({ color: 0xc8c2b8 })];
  state.pendingMaps = [];
  resetHistory();
  cancelTexture();
  disposeBakedMaterials();
  state.bake = null;
  state.geo = null;
  state.result = null;
  state.info = null;
  updateHeader();
  await rebuildWeld(true);
  frameCamera();
  flashHint(6000);
  const cam = meta.restore && meta.restore.camera;
  if (cam) {
    camera.position.fromArray(cam.position);
    controls.target.fromArray(cam.target);
    controls.update();
    requestRender();
  }
  updateTexturePanel();
}

function weldTolerance() { return 1e-7 * Math.pow(10, settings.weldTol / 25); }

async function rebuildWeld(resetLabels) {
  const c = state.collected;
  if (!c) return;
  setStatus(`Welding ${fmt(c.positions.length / 3)} vertices…`);
  await nextFrame();
  const old = state.welded, oldLabels = state.labels;
  const welded = smartWeld(c, { keepUV: true, hardAngle: settings.hardAngle, tolerance: weldTolerance() });
  state.welded = welded;
  const bb = bounds(welded.positions);
  state.diag = bb.diag;
  state.size = Math.max(...bb.size) || 1;
  const saved = resetLabels && state.meta.restore;
  const savedLabels = saved && saved.labels && saved.labels.length === welded.vertexCount && saved.weld
    && saved.weld.hardAngle === settings.hardAngle && saved.weld.weldTol === settings.weldTol ? saved.labels : null;
  state.labels = savedLabels ? Int8Array.from(savedLabels) : resetLabels || !old ? new Int8Array(welded.vertexCount) : transferLabels(old, oldLabels, welded);
  resetHistory();
  state.engineMesh = {
    positions: welded.positions, normals: welded.normals, uvs: welded.uvs, colors: welded.colors,
    index: welded.index, vPart: welded.vPart, vMat: welded.vMat, vertexCount: welded.vertexCount, uvIsland: welded.uvIsland,
  };
  state.orig = { bvh: null, index: null };
  cancelTexture();
  resetBakeSources();
  setLeftSurface(originalSurface());
  setStatus('Indexing surface for the brush…');
  await nextFrame();
  buildBVH();
  if (resetLabels) {
    symPlane.ready = false;
    if (saved && saved.symPlane) {
      setPlane(saved.symPlane.axis, saved.symPlane.offset);
    } else if (settings.symmetry) {
      setStatus('Finding the mirror plane…');
      await nextFrame();
      detectPlane();
    }
  }
  updatePlaneHelper();
  updateTint();
  if (state.meta.sample && resetLabels) paintSample();
  await engine.load(doc.id, state.engineMesh);
  setStatus('');
  if (symActive()) refreshMirrorView();
  updateModelPanel();
  updateLegend();
  updateTargetUI();
  updateResultUI();
  updateUVPanel();
  scheduleReduce(0);
}

function transferLabels(old, oldLabels, welded) {
  const key = (P, i) => `${P[i * 3]},${P[i * 3 + 1]},${P[i * 3 + 2]}`;
  const map = new Map();
  for (let i = 0; i < old.vertexCount; i++) if (oldLabels[i]) map.set(key(old.positions, i), oldLabels[i]);
  const out = new Int8Array(welded.vertexCount);
  for (let i = 0; i < welded.vertexCount; i++) out[i] = map.get(key(welded.positions, i)) || 0;
  return out;
}

// ---------- textures ----------
// After loading: maps whose file was missing come off the material (so they don't render black) and wait here.
async function settleTextures(loose) {
  if (!state.collected) return;
  for (const m of state.displayMats) {
    for (const slot of MAP_SLOTS) {
      const t = m[slot];
      if (t && t.userData && t.userData.pbMissing) {
        state.pendingMaps.push({ material: m, slot, texture: t, file: t.userData.pbFile });
        m[slot] = null;
        m.needsUpdate = true;
      }
    }
  }
  if (loose && loose.length) {
    try { await assignLoose(loose); } catch (err) { console.error(err); }
  }
  refreshBake();
  updateTexturePanel();
  updateModelPanel();
  requestRender();
  saveSessionSoon();
}

async function imageFromFile(file) {
  const url = URL.createObjectURL(file);
  state.meta.files.set(file.name.toLowerCase(), file);
  state.meta.blobToName.set(url, file.name);
  if (extOf(file.name) === 'tga') return (await new TGALoader().loadAsync(url)).image;
  return new THREE.ImageLoader().loadAsync(url);
}

async function textureFromFile(file, slot) {
  const url = URL.createObjectURL(file);
  state.meta.files.set(file.name.toLowerCase(), file);
  state.meta.blobToName.set(url, file.name);
  const tex = extOf(file.name) === 'tga' ? await new TGALoader().loadAsync(url) : await new THREE.TextureLoader().loadAsync(url);
  tex.userData.pbFile = file.name.toLowerCase();
  tex.colorSpace = COLOR_SLOTS.has(slot) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.flipY = !(state.meta.kind === 'glb' || state.meta.kind === 'gltf');
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// Images whose names the model never asked for: base colour, or a map type guessed from the file name.
async function assignLoose(files) {
  const mats = state.displayMats, used = [];
  for (const f of files) {
    const slot = slotForFile(f.name);
    const targets = mats.filter(m => slot in m && (mats.length === 1 || !m[slot]));
    if (!targets.length) continue;
    const tex = await textureFromFile(f, slot);
    for (const m of targets) { m[slot] = tex; m.needsUpdate = true; }
    state.pendingMaps = state.pendingMaps.filter(p => !(targets.includes(p.material) && p.slot === slot));
    used.push(f.name);
  }
  return used;
}

async function addTextures(files) {
  if (!state.collected.uvs) {
    showError("This model has no UVs, so a texture can't show on it. Open a version of the model that has UVs.");
    return;
  }
  const matched = [], unmatched = [];
  for (const f of files) {
    const name = f.name.toLowerCase();
    const waiting = state.pendingMaps.filter(p => p.file === name);
    const current = [];
    for (const m of state.displayMats) for (const slot of MAP_SLOTS) if (m[slot] && m[slot].userData && m[slot].userData.pbFile === name) current.push({ material: m, slot, texture: m[slot] });
    const targets = [...waiting, ...current];
    if (!targets.length) { unmatched.push(f); continue; }
    const image = await imageFromFile(f);
    for (const t of targets) {
      t.texture.image = image;
      t.texture.userData.pbMissing = false;
      t.texture.needsUpdate = true;
      t.material[t.slot] = t.texture;
      t.material.needsUpdate = true;
    }
    state.pendingMaps = state.pendingMaps.filter(p => p.file !== name);
    matched.push(f.name);
  }
  const assigned = await assignLoose(unmatched);
  const added = [...matched, ...assigned];
  if (added.length) rememberFiles(doc, files.filter(f => added.includes(f.name)), false).then(() => saveSessionSoon(0));
  const ignored = unmatched.map(f => f.name).filter(n => !assigned.includes(n));
  if (added.length && settings.shading !== 'textured') { settings.shading = 'textured'; syncControls(); saveSettings(); }
  refreshBake();
  applyDisplaySettings();
  updateTexturePanel();
  updateModelPanel();
  if (added.length) setStatus(`Added ${added.join(', ')}${ignored.length ? ` · not used: ${ignored.join(', ')}` : ''}`, 'info', 6000);
  else showError(`None of these matched a texture slot: ${ignored.join(', ')}. Click a material's tile under Texture to pick its file.`);
}

let textureTarget = null;
// Puts a file into one map slot of one material (its base colour unless another slot is given).
async function setMaterialTexture(index, file, slot = 'map') {
  const m = state.displayMats[index];
  if (!m || !(slot in m)) return;
  if (!state.collected.uvs) { showError("This model has no UVs, so a texture can't show on it."); return; }
  const tex = await textureFromFile(file, slot);
  const old = m[slot];
  m[slot] = tex;
  m.needsUpdate = true;
  if (old && !state.displayMats.some(o => MAP_SLOTS.some(k => o[k] === old))) old.dispose();
  state.pendingMaps = state.pendingMaps.filter(p => !(p.material === m && p.slot === slot));
  rememberFiles(doc, [file], false).then(() => saveSessionSoon(0));
  if (settings.shading !== 'textured') { settings.shading = 'textured'; syncControls(); saveSettings(); }
  refreshBake();
  applyDisplaySettings();
  updateTexturePanel();
  updateModelPanel();
  setStatus(`${file.name} is now the ${SLOT_NAMES[slot]} map of ${m.name || `material ${index + 1}`}`, 'info', 5000);
}

const SLOT_SHORT = { map: 'Colour', normalMap: 'Normal', roughnessMap: 'Rough', metalnessMap: 'Metal', aoMap: 'AO', emissiveMap: 'Emissive', specularMap: 'Specular', bumpMap: 'Bump', alphaMap: 'Alpha' };
// A small preview of a texture image, made once per image; null until the image has loaded.
const thumbs = new WeakMap();
function thumbnail(image) {
  if (!image) return null;
  if (thumbs.has(image)) return thumbs.get(image);
  if (image.complete === false || image.naturalWidth === 0) return null;
  const [w, h] = imageSize(image), size = 120;
  let url = null;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    if (image.data) {
      if (!(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray) || image.data.length < w * h * 4) return null;
      const src = document.createElement('canvas');
      src.width = w;
      src.height = h;
      src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, w * h * 4), w, h), 0, 0);
      g.drawImage(src, 0, 0, size, size);
    } else {
      g.drawImage(image, 0, 0, size, size);
    }
    url = c.toDataURL('image/png');
  } catch { url = null; }
  thumbs.set(image, url);
  return url;
}
function tile(i, slot, className, title, content) {
  const b = el('button', { type: 'button', className: `tile ${className}`, title }, content, el('span', { className: 'slot', textContent: SLOT_SHORT[slot] }));
  b.dataset.mat = String(i);
  b.dataset.slot = slot;
  return b;
}
function updateTexturePanel() {
  const list = $('texList');
  // A model without UVs can't show a texture, so the whole section goes away.
  const hasUVs = !!(state.collected && state.collected.uvs);
  $('secTex').hidden = !hasUVs && !!state.collected;
  list.hidden = !hasUVs;
  if (!hasUVs) { list.replaceChildren(); return; }
  const rows = state.displayMats.map((m, i) => {
    const tiles = MAP_SLOTS.filter(slot => m[slot]).map(slot => {
      const t = m[slot], file = t.userData && t.userData.pbFile, [w, h] = t.image ? imageSize(t.image) : [0, 0];
      const url = thumbnail(t.image);
      const title = `${SLOT_NAMES[slot]}: ${file || 'built into the model'}${w > 1 ? ` · ${w} × ${h}` : ''}\nClick to replace it`;
      return tile(i, slot, '', title, el('span', { className: 'thumb' }, ...(url ? [el('img', { src: url, alt: '' })] : [])));
    });
    const waiting = state.pendingMaps.filter(p => p.material === m);
    for (const p of waiting) tiles.push(tile(i, p.slot, 'missing', `${SLOT_NAMES[p.slot]}: ${p.file} is missing\nClick to pick the file, or drop it on the view`, el('span', { className: 'thumb', textContent: '!' })));
    if ('map' in m && !m.map && !waiting.some(p => p.slot === 'map')) tiles.push(tile(i, 'map', 'add', 'Add a base colour texture', el('span', { className: 'thumb', textContent: '+' })));
    return el('li', {}, el('span', { className: 'mat-name', textContent: m.name || `Material ${i + 1}`, title: m.name || '' }), el('div', { className: 'tiles' }, ...tiles));
  });
  list.replaceChildren(...rows);
  refreshUVView();
}

// ---------- texture bake for new UVs ----------
// The reduced mesh is drawn in its new UV layout. Every texel finds the original surface under it (a ray cast inward
// from a thin cage along the normal, else the closest point that faces the same way), reads the original UV there and
// samples the original texture, so the texture fits the new UVs.
const BAKE_GLSL = /* glsl */`
precision highp isampler2D;
precision highp usampler2D;
${BVHShaderGLSL.common_functions}
${BVHShaderGLSL.bvh_struct_definitions}
${BVHShaderGLSL.bvh_distance_functions}
${BVHShaderGLSL.bvh_ray_functions}
uniform BVH bvh;
uniform sampler2D srcUV;
uniform sampler2D srcNormal;
varying vec3 vPos;
varying vec3 vNrm;
`;
const UV_SPACE_VS = /* glsl */`
varying vec3 vPos;
varying vec3 vNrm;
void main() {
  vPos = position;
  vNrm = normal;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;
const QUAD_VS = /* glsl */'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';

// Output: original UV, original UV area per texel (for the mip level), and 1 + the matched triangle (0 = empty texel).
const CORR_FS = /* glsl */`${BAKE_GLSL}
uniform float maxDist;
uniform float cage;

// Closest point among triangles that face within ~105 degrees of n, so thin shells and nearby strands don't swap sides.
float closestFacing(vec3 p, vec3 n, float maxD, inout uvec4 faceIndices, inout vec3 barycoord) {
  int pointer = 0;
  uint stack[BVH_STACK_DEPTH];
  stack[0] = 0u;
  float best = maxD * maxD;
  while (pointer > -1 && pointer < BVH_STACK_DEPTH) {
    uint node = stack[pointer];
    pointer--;
    if (distanceSqToBVHNodeBoundsPoint(p, bvh.bvhBounds, node) > best) continue;
    uvec2 info = uTexelFetch1D(bvh.bvhContents, node).xy;
    if (bool(info.x & 0xffff0000u)) {
      uint end = info.y + (info.x & 0x0000ffffu);
      for (uint i = info.y; i < end; i++) {
        uvec3 ind = uTexelFetch1D(bvh.index, i).xyz;
        vec3 a = texelFetch1D(bvh.position, ind.x).xyz;
        vec3 b = texelFetch1D(bvh.position, ind.y).xyz;
        vec3 c = texelFetch1D(bvh.position, ind.z).xyz;
        vec3 fn = cross(b - a, c - a);
        float fl = length(fn);
        if (fl > 0.0 && dot(fn, n) < -0.25 * fl) continue;
        vec3 bc;
        vec3 d = p - closestPointToTriangle(p, a, b, c, bc);
        float d2 = dot(d, d);
        if (d2 < best) { best = d2; faceIndices = uvec4(ind, i); barycoord = bc; }
      }
    } else {
      uint left = node + 1u;
      uint right = node + info.y;
      bool leftFirst = distanceSqToBVHNodeBoundsPoint(p, bvh.bvhBounds, left) < distanceSqToBVHNodeBoundsPoint(p, bvh.bvhBounds, right);
      pointer++;
      stack[pointer] = leftFirst ? right : left;
      pointer++;
      stack[pointer] = leftFirst ? left : right;
    }
  }
  return sqrt(best);
}

void main() {
  float texelArea = length(cross(dFdx(vPos), dFdy(vPos)));
  vec3 n = normalize(vNrm);
  uvec4 fi = uvec4(0u);
  vec3 bc = vec3(1.0, 0.0, 0.0);
  vec3 hn = vec3(0.0);
  float side = 0.0, dist = 0.0;
  // The outermost surface along the normal is what shows from outside, even where strands were merged into the head.
  bool hit = bvhIntersectFirstHit(bvh, vPos + n * cage, -n, fi, hn, bc, side, dist) && side > 0.0 && dist < 2.0 * cage;
  float d = hit ? 0.0 : closestFacing(vPos, n, maxDist, fi, bc);
  if (d >= maxDist) {
    vec3 op = vec3(0.0);
    d = bvhClosestPointToPoint(bvh, vPos, maxDist * 4.0, fi, hn, bc, side, op);
    if (d >= maxDist * 4.0) { gl_FragColor = vec4(0.0); return; }
  }
  vec2 uv0 = textureSampleBarycoord(srcUV, bc, fi.xyz).xy;
  vec3 a = texelFetch1D(bvh.position, fi.x).xyz, b = texelFetch1D(bvh.position, fi.y).xyz, c = texelFetch1D(bvh.position, fi.z).xyz;
  vec2 ta = texelFetch1D(srcUV, fi.x).xy, tb = texelFetch1D(srcUV, fi.y).xy, tc = texelFetch1D(srcUV, fi.z).xy;
  float a3 = length(cross(b - a, c - a));
  float auv = abs((tb.x - ta.x) * (tc.y - ta.y) - (tc.x - ta.x) * (tb.y - ta.y));
  gl_FragColor = vec4(uv0, texelArea * auv / max(a3, 1e-30), float(fi.w) + 1.0);
}`;

// Samples one source map at the matched UVs. mode 0: data as is, 1: colour (stored sRGB), 2: tangent-space normals,
// re-expressed from the original triangle's tangent frame in the reduced mesh's frame.
const MAP_FS = /* glsl */`${BAKE_GLSL}
uniform sampler2D corr;
uniform sampler2D srcMap;
uniform mat3 srcMatrix;
uniform vec2 srcSize;
uniform vec2 normalScale;
uniform int mode;

vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

void main() {
  vec3 tr = dFdx(vPos), br = dFdy(vPos);
  vec4 c = texelFetch(corr, ivec2(gl_FragCoord.xy), 0);
  if (c.a < 0.5) discard;
  vec2 uv = (srcMatrix * vec3(c.xy, 1.0)).xy;
  vec4 s = textureLod(srcMap, uv, 0.5 * log2(max(c.z * srcSize.x * srcSize.y, 1.0)));
  if (mode == 2) {
    uvec3 ind = uTexelFetch1D(bvh.index, uint(c.a - 0.5)).xyz;
    vec3 pa = texelFetch1D(bvh.position, ind.x).xyz, pb = texelFetch1D(bvh.position, ind.y).xyz, pc = texelFetch1D(bvh.position, ind.z).xyz;
    vec2 ta = texelFetch1D(srcUV, ind.x).xy, tb = texelFetch1D(srcUV, ind.y).xy, tc = texelFetch1D(srcUV, ind.z).xy;
    vec2 e0 = tb - ta, e1 = tc - ta, ep = c.xy - ta;
    float den = e0.x * e1.y - e1.x * e0.y;
    if (abs(den) > 1e-20) {
      float wb = (ep.x * e1.y - e1.x * ep.y) / den, wc = (e0.x * ep.y - ep.x * e0.y) / den;
      vec3 no = normalize((1.0 - wb - wc) * texelFetch1D(srcNormal, ind.x).xyz + wb * texelFetch1D(srcNormal, ind.y).xyz + wc * texelFetch1D(srcNormal, ind.z).xyz);
      vec3 q0 = pb - pa, q1 = pc - pa;
      vec3 to = (q0 * e1.y - q1 * e0.y) / den, bo = (q1 * e0.x - q0 * e1.x) / den;
      to = normalize(to - no * dot(no, to));
      vec3 bo2 = cross(no, to) * (dot(cross(no, to), bo) < 0.0 ? -1.0 : 1.0);
      // Read as three.js shows it: the material's scale, whose sign also carries the green direction (flipped for glTF).
      vec3 nt = s.xyz * 2.0 - 1.0;
      nt.xy *= normalScale;
      vec3 obj = normalize(to * nt.x + bo2 * nt.y + no * nt.z);
      vec3 nr = normalize(vNrm);
      vec3 tn = normalize(tr - nr * dot(nr, tr));
      vec3 bn = cross(nr, tn) * (dot(cross(nr, tn), br) < 0.0 ? -1.0 : 1.0);
      s.xyz = vec3(dot(obj, tn), dot(obj, bn), dot(obj, nr)) * 0.5 + 0.5;
    }
  }
  gl_FragColor = vec4(mode == 1 ? toSRGB(s.rgb) : s.rgb, mode == 2 ? 1.0 : s.a);
}`;

// Jump flooding: every empty texel learns its nearest baked texel, so gutters repeat the chart edge colours.
const JFA_INIT_FS = /* glsl */`
uniform sampler2D corr;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  gl_FragColor = texelFetch(corr, p, 0).a > 0.5 ? vec4(vec2(p), 0.0, 1.0) : vec4(0.0);
}`;
const JFA_STEP_FS = /* glsl */`
uniform sampler2D seeds;
uniform int stepSize;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), size = textureSize(seeds, 0);
  vec4 best = texelFetch(seeds, p, 0);
  float bd = best.a > 0.5 ? distance(best.xy, vec2(p)) : 1e9;
  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
    ivec2 q = p + ivec2(dx, dy) * stepSize;
    if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
    vec4 s = texelFetch(seeds, q, 0);
    if (s.a < 0.5) continue;
    float d = distance(s.xy, vec2(p));
    if (d < bd) { bd = d; best = s; }
  }
  gl_FragColor = best;
}`;
const FILL_FS = /* glsl */`
uniform sampler2D corr;
uniform sampler2D seeds;
uniform sampler2D img;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), q = p;
  if (texelFetch(corr, p, 0).a < 0.5) {
    vec4 s = texelFetch(seeds, p, 0);
    if (s.a > 0.5) q = ivec2(s.xy + 0.5);
  }
  gl_FragColor = texelFetch(img, q, 0);
}`;

const bakeMaterial = (vertexShader, fragmentShader, uniforms) => new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
const corrMat = bakeMaterial(UV_SPACE_VS, CORR_FS, { bvh: { value: null }, srcUV: { value: null }, srcNormal: { value: null }, maxDist: { value: 1 }, cage: { value: 0.01 } });
const mapMat = bakeMaterial(UV_SPACE_VS, MAP_FS, {
  bvh: { value: null }, srcUV: { value: null }, srcNormal: { value: null }, corr: { value: null }, srcMap: { value: null },
  srcMatrix: { value: new THREE.Matrix3() }, srcSize: { value: new THREE.Vector2() }, normalScale: { value: new THREE.Vector2(1, 1) }, mode: { value: 0 },
});
const jfaInitMat = bakeMaterial(QUAD_VS, JFA_INIT_FS, { corr: { value: null } });
const jfaStepMat = bakeMaterial(QUAD_VS, JFA_STEP_FS, { seeds: { value: null }, stepSize: { value: 1 } });
const fillMat = bakeMaterial(QUAD_VS, FILL_FS, { corr: { value: null }, seeds: { value: null }, img: { value: null } });
const quadGeo = new THREE.BufferGeometry();
quadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
const bakeScene = new THREE.Scene(), bakeCam = new THREE.Camera();
const bake = { size: 0, corr: null, seedA: null, seedB: null, scratch: null, out: null, sources: new Map(), uv: null, normal: null };

function bakeTarget(size, type) {
  return new THREE.WebGLRenderTarget(size, size, { type, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });
}
function ensureBakeTargets(size) {
  if (bake.size === size) return;
  for (const k of ['corr', 'seedA', 'seedB', 'scratch', 'out']) if (bake[k]) bake[k].dispose();
  bake.corr = bakeTarget(size, THREE.FloatType);
  bake.seedA = bakeTarget(size, THREE.HalfFloatType);
  bake.seedB = bakeTarget(size, THREE.HalfFloatType);
  bake.scratch = bakeTarget(size, THREE.UnsignedByteType);
  bake.out = bakeTarget(size, THREE.UnsignedByteType);
  bake.size = size;
}
function resetBakeSources() {
  for (const s of bake.sources.values()) { s.struct.dispose(); if (s.geometry) s.geometry.dispose(); }
  bake.sources.clear();
  if (bake.uv) { bake.uv.dispose(); bake.normal.dispose(); }
  bake.uv = bake.normal = null;
}
// The original surface of one material, packed for the shader (one BVH over everything when there is one material).
function bakeSource(mi) {
  let src = bake.sources.get(mi);
  if (src) return src;
  const w = state.welded;
  let bvh = state.orig.bvh, geometry = null;
  if (state.displayMats.length > 1) {
    const idx = w.index, keep = [];
    for (let t = 0; t < idx.length; t += 3) if (Math.min(w.vMat[idx[t]], state.displayMats.length - 1) === mi) keep.push(idx[t], idx[t + 1], idx[t + 2]);
    geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(w.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(keep), 1));
    bvh = new MeshBVH(geometry);
  }
  const struct = new MeshBVHUniformStruct();
  struct.updateFrom(bvh);
  if (!bake.uv) {
    bake.uv = new FloatVertexAttributeTexture();
    bake.uv.updateFrom(new THREE.BufferAttribute(w.uvs, 2));
    bake.normal = new FloatVertexAttributeTexture();
    bake.normal.updateFrom(new THREE.BufferAttribute(w.normals, 3));
  }
  src = { struct, geometry };
  bake.sources.set(mi, src);
  return src;
}
const clearColor = new THREE.Color();
// One pass into a bake target; band = [first row, rows] limits it to part of the target so a heavy pass can be
// spread over frames.
function bakePass(material, target, mesh, band) {
  const obj = mesh || new THREE.Mesh(quadGeo, material);
  obj.material = material;
  obj.frustumCulled = false;
  renderer.getClearColor(clearColor);
  const clearAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);
  if (band) { target.scissor.set(0, band[0], target.width, band[1]); target.scissorTest = true; }
  bakeScene.add(obj);
  renderer.setRenderTarget(target);
  renderer.render(bakeScene, bakeCam);
  bakeScene.remove(obj);
  renderer.setRenderTarget(null);
  target.scissorTest = false;
  renderer.setClearColor(clearColor, clearAlpha);
}
const imageSize = img => [img.naturalWidth || img.width || 1, img.naturalHeight || img.height || 1];
const texturedMaterials = () => state.displayMats.map((m, mi) => ({ mi, slots: MAP_SLOTS.filter(slot => m[slot] && m[slot].image && !m[slot].userData.pbMissing) })).filter(j => j.slots.length);
function prewarmBakeSources() {
  if (!state.welded || !state.welded.uvs || !state.orig.bvh) return;
  for (const { mi } of texturedMaterials()) bakeSource(mi);
}

// Bakes every loaded map of every textured material onto the result's new UVs, 256 rows of the heavy pass per frame
// so the view keeps rendering. Returns { size, maps: [{ mi, slot, data, colorSpace }] } with RGBA rows from v = 0
// (colour maps hold sRGB), or null when there is nothing to bake or current() turns false on the way.
async function bakeResultAsync(res, info, current) {
  const jobs = texturedMaterials();
  if (!jobs.length || !res.uvs || !state.welded.uvs || !state.orig.bvh) return null;
  if (!renderer.extensions.has('EXT_color_buffer_float')) throw new Error('this browser cannot render float textures');
  const size = settings.bakeSize, rows = 256;
  ensureBakeTargets(size);
  const triEnd = info && info.symmetry ? res.triCount / 2 : res.triCount;
  const nMat = state.displayMats.length, idx = res.index;
  const out = { size, maps: [] };
  for (const job of jobs) {
    const sub = [];
    for (let t = 0; t < triEnd; t++) if (Math.min(res.vMat[idx[t * 3]], nMat - 1) === job.mi) sub.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]);
    if (!sub.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(res.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(res.normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(res.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(sub), 1));
    const mesh = new THREE.Mesh(geo, corrMat);
    try {
      const src = bakeSource(job.mi);
      for (const m of [corrMat, mapMat]) {
        m.uniforms.bvh.value = src.struct;
        m.uniforms.srcUV.value = bake.uv;
        m.uniforms.srcNormal.value = bake.normal;
      }
      corrMat.uniforms.maxDist.value = 0.08 * state.size;
      corrMat.uniforms.cage.value = 0.01 * state.size;
      for (let y = 0; y < size; y += rows) {
        bakePass(corrMat, bake.corr, mesh, [y, Math.min(rows, size - y)]);
        await nextFrame();
        if (!current()) return null;
      }
      jfaInitMat.uniforms.corr.value = bake.corr.texture;
      bakePass(jfaInitMat, bake.seedA);
      let a = bake.seedA, b = bake.seedB;
      for (let step = size >> 1; step >= 1; step >>= 1) {
        jfaStepMat.uniforms.seeds.value = a.texture;
        jfaStepMat.uniforms.stepSize.value = step;
        bakePass(jfaStepMat, b);
        [a, b] = [b, a];
      }
      for (const slot of job.slots) {
        const tex = state.displayMats[job.mi][slot];
        tex.updateMatrix();
        mapMat.uniforms.corr.value = bake.corr.texture;
        mapMat.uniforms.srcMap.value = tex;
        mapMat.uniforms.srcMatrix.value.copy(tex.matrix);
        mapMat.uniforms.srcSize.value.set(...imageSize(tex.image));
        mapMat.uniforms.normalScale.value.copy(state.displayMats[job.mi].normalScale || new THREE.Vector2(1, 1));
        mapMat.uniforms.mode.value = slot === 'normalMap' ? 2 : tex.colorSpace === THREE.SRGBColorSpace ? 1 : 0;
        bakePass(mapMat, bake.scratch, mesh);
        fillMat.uniforms.corr.value = bake.corr.texture;
        fillMat.uniforms.seeds.value = a.texture;
        fillMat.uniforms.img.value = bake.scratch.texture;
        bakePass(fillMat, bake.out);
        const data = await renderer.readRenderTargetPixelsAsync(bake.out, 0, 0, size, size, new Uint8Array(size * size * 4));
        if (!current()) return null;
        out.maps.push({ mi: job.mi, slot, data, colorSpace: tex.colorSpace === THREE.SRGBColorSpace ? THREE.SRGBColorSpace : THREE.NoColorSpace });
      }
    } finally {
      geo.dispose();
    }
  }
  return out.maps.length ? out : null;
}

// Display materials for a result with new UVs: the original materials with their maps swapped for the baked ones.
function bakedMaterials(bk) {
  return state.displayMats.map((m, mi) => {
    const maps = bk ? bk.maps.filter(x => x.mi === mi) : [];
    const c = m.clone();
    for (const slot of MAP_SLOTS) if (c[slot]) c[slot] = null;
    for (const x of maps) {
      const t = new THREE.DataTexture(x.data, bk.size, bk.size, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.colorSpace = x.colorSpace;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = 4;
      t.userData.pbBaked = true;
      t.needsUpdate = true;
      c[x.slot] = t;
    }
    // A baked normal map already carries the source's strength and green direction.
    if (c.normalScale) c.normalScale.set(1, 1);
    c.needsUpdate = true;
    return c;
  });
}
function disposeBakedMaterials(s = state) {
  if (!s.bakedMats) return;
  for (const m of s.bakedMats) {
    for (const slot of MAP_SLOTS) if (m[slot] && m[slot].userData.pbBaked) m[slot].dispose();
    m.dispose();
  }
  s.bakedMats = null;
}
// ---------- texture jobs ----------
// A reduction result goes on screen as soon as it exists. For New UVs it arrives without UVs and shows untextured;
// the unwrap (second worker) and the bake (GPU, spread over frames) follow in the background, and the textured mesh
// replaces it when both are done. A newer result, texture or setting cancels the job in flight.
let textureSeq = 0;
function cancelTexture() {
  textureSeq++;
  texEngine.cancel();
  state.texturing = null;
}
function startTextureJob(rebakeOnly = false) {
  const geo = state.geo;
  if (!geo) return;
  const seq = ++textureSeq;
  const current = () => seq === textureSeq && state.geo === geo;
  const job = (async () => {
    let res = state.result, info = state.info;
    if (!(rebakeOnly && res && res.uvLayout === 'new')) {
      const unwrapped = texEngine.run({ type: 'unwrap', mesh: geo.result, plane: geo.plane, labels: geo.labels, size: settings.bakeSize });
      prewarmBakeSources();
      const u = await unwrapped;
      if (!current()) return;
      res = u.result;
      info = { ...geo.info, atlas: u.atlas, verts: res.vertexCount, symmetry: u.symmetry || geo.info.symmetry };
    }
    const baked = await bakeResultAsync(res, info, current);
    if (!current()) return;
    disposeBakedMaterials();
    state.result = res;
    state.info = info;
    state.bake = baked;
    state.bakedMats = bakedMaterials(baked);
    buildReducedDisplay(res);
  })().catch(err => {
    if (err && err.message === 'cancelled') return;
    console.error(err);
    if (current()) showError(`Couldn't make the texture: ${err.message || err}`);
  }).finally(() => {
    if (state.texturing !== job) return;
    state.texturing = null;
    updateResultUI();
    updateUVPanel();
  });
  state.texturing = job;
  updateResultUI();
  updateUVPanel();
}
// Textures changed: the UVs stay, the bake runs again.
function refreshBake() {
  if (state.geo) startTextureJob(true);
}

// A result that arrives after its tab was left waits for the tab to be shown again.
function keepResult(d, res, info, labels, st) {
  const s = d.state;
  if (!s) return;
  disposeBakedMaterials(s);
  s.bake = null;
  s.result = res;
  s.info = info;
  s.geo = res.uvLayout === 'pending' ? { result: res, info, labels, plane: st.symmetry } : null;
}

// Puts a reduction result on screen; New-UV results show untextured until their texture job finishes.
function showResult(res, info, labels, st) {
  cancelTexture();
  disposeBakedMaterials();
  state.bake = null;
  state.result = res;
  state.info = info;
  state.geo = res.uvLayout === 'pending' ? { result: res, info, labels, plane: st.symmetry } : null;
  buildReducedDisplay(res);
  $('resErr').textContent = '…';
  updateResultUI();
  updateUVPanel();
  setTimeout(() => measureDeviation(res), 30);
  if (state.geo) startTextureJob();
}

// ---------- display ----------
function buildSurfaceGeometry(P, N, UV, COL, index, vMat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  if (UV) g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
  if (COL) g.setAttribute('color', new THREE.BufferAttribute(COL, 3));
  const T = index.length / 3;
  const nMat = Math.max(1, state.displayMats.length);
  const counts = new Uint32Array(nMat + 1);
  for (let t = 0; t < T; t++) counts[Math.min(vMat[index[t * 3]], nMat - 1) + 1]++;
  for (let m = 0; m < nMat; m++) counts[m + 1] += counts[m];
  const sorted = new Uint32Array(index.length), fill = counts.slice();
  for (let t = 0; t < T; t++) {
    const m = Math.min(vMat[index[t * 3]], nMat - 1);
    const o = fill[m]++ * 3;
    sorted[o] = index[t * 3]; sorted[o + 1] = index[t * 3 + 1]; sorted[o + 2] = index[t * 3 + 2];
  }
  for (let m = 0; m < nMat; m++) if (counts[m + 1] > counts[m]) g.addGroup(counts[m] * 3, (counts[m + 1] - counts[m]) * 3, m);
  g.setIndex(new THREE.BufferAttribute(sorted, 1));
  g.computeBoundingSphere();
  return g;
}

// The reduced view shows the baked materials when its result has new UVs, and clay while they are on the way.
function surfaceMaterials(side) {
  if (settings.shading === 'textured' && side === 'R' && state.result && state.result.uvLayout === 'pending') return state.displayMats.map(() => clayMat);
  if (settings.shading === 'textured') return side === 'R' && state.bakedMats ? state.bakedMats : state.displayMats;
  const m = settings.shading === 'facets' ? facetMat : clayMat;
  return state.displayMats.map(() => m);
}

function makeDisplay(scene, geo, side) {
  const surface = new THREE.Mesh(geo, surfaceMaterials(side));
  const paintGeo = new THREE.BufferGeometry();
  paintGeo.setAttribute('position', geo.attributes.position);
  paintGeo.setIndex(geo.index);
  const colors = new Uint8Array(geo.attributes.position.count * 4);
  paintGeo.setAttribute('color', new THREE.BufferAttribute(colors, 4, true));
  const paint = new THREE.Mesh(paintGeo, paintMat);
  const wire = new THREE.Mesh(geo, wireMat);
  const tint = new THREE.Mesh(geo, tintMat);
  for (const m of [surface, paint, wire, tint]) m.frustumCulled = false;
  scene.add(surface, paint, wire, tint);
  return { surface, paint, wire, tint, colors, geo, paintGeo, tris: geo.index.count / 3 };
}

function disposeDisplay(d, scene) {
  if (!d) return;
  scene.remove(d.surface, d.paint, d.wire, d.tint);
  d.geo.dispose();
  d.paintGeo.dispose();
}

// The left view shows a surface: the welded original, or the original with its kept half mirrored.
// srcId maps a shown vertex to the welded vertex whose paint it displays; twin is its partner across the plane.
function originalSurface() {
  const w = state.welded;
  return {
    positions: w.positions, normals: w.normals, uvs: w.uvs, colors: w.colors, index: w.index, vMat: w.vMat,
    srcId: null, twin: null, halfCount: w.vertexCount, bvh: state.orig.bvh, bvhIndex: state.orig.index, mirrored: false,
  };
}

function setLeftSurface(surf) {
  disposeDisplay(display.L, sceneL);
  state.left = surf;
  display.L = makeDisplay(sceneL, buildSurfaceGeometry(surf.positions, surf.normals, surf.uvs, surf.colors, surf.index, surf.vMat), 'L');
  recolorAll();
  applyDisplaySettings();
  updateTargetUI();
}

function buildReducedDisplay(res) {
  disposeDisplay(display.R, sceneR);
  display.R = makeDisplay(sceneR, buildSurfaceGeometry(res.positions, res.normals, res.uvs, res.colors, res.index, res.vMat), 'R');
  display.R.srcId = res.srcId;
  recolorReduced();
  applyDisplaySettings();
  refreshUVView();
}

function applyDisplaySettings() {
  const tint = symActive() && settings.tintMirror;
  for (const [d, side] of [[display.L, 'L'], [display.R, 'R']]) {
    if (!d) continue;
    d.surface.material = state.displayMats.length ? surfaceMaterials(side) : [clayMat];
    d.paint.visible = settings.showPaint;
    d.wire.visible = settings.wire && d.tris <= 800000;
    d.tint.visible = tint;
  }
  requestRender();
}

function writeLabelColor(label, out, o) {
  if (!label) { out[o + 3] = 0; return; }
  const c = label === LABEL.KEEP ? paintRGB.keep : label > 0 ? paintRGB.more : paintRGB.less;
  out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
  out[o + 3] = label === LABEL.KEEP ? 150 : [0, 105, 145, 185][Math.abs(label)];
}

function labelOf(v) {
  const map = state.left && state.left.srcId;
  return map ? map[v] : v;
}

// Refreshes paint colours for these shown vertices of the left view and their mirror twins.
function recolorLeft(verts) {
  const d = display.L, L = state.left;
  if (!d) return;
  const twin = L.twin, half = L.halfCount;
  let loA = Infinity, hiA = -1, loB = Infinity, hiB = -1;
  const touch = v => {
    writeLabelColor(state.labels[labelOf(v)], d.colors, v * 4);
    if (v < half) { if (v < loA) loA = v; if (v > hiA) hiA = v; }
    else { if (v < loB) loB = v; if (v > hiB) hiB = v; }
  };
  for (const v of verts) {
    touch(v);
    if (twin && twin[v] !== v) touch(twin[v]);
  }
  const attr = d.paintGeo.attributes.color;
  attr.clearUpdateRanges();
  if (hiA >= 0) attr.addUpdateRange(loA * 4, (hiA - loA + 1) * 4);
  if (hiB >= 0) attr.addUpdateRange(loB * 4, (hiB - loB + 1) * 4);
  attr.needsUpdate = true;
}

function recolorReduced() {
  const d = display.R;
  if (!d || !d.srcId) return;
  const n = d.srcId.length;
  for (let v = 0; v < n; v++) writeLabelColor(state.labels[d.srcId[v]], d.colors, v * 4);
  const attr = d.paintGeo.attributes.color;
  attr.clearUpdateRanges();
  attr.needsUpdate = true;
}

function recolorAll() {
  const d = display.L;
  if (!d) return;
  const n = state.left.positions.length / 3;
  for (let v = 0; v < n; v++) writeLabelColor(state.labels[labelOf(v)], d.colors, v * 4);
  const attr = d.paintGeo.attributes.color;
  attr.clearUpdateRanges();
  attr.needsUpdate = true;
  recolorReduced();
  requestRender();
}

// ---------- brush ----------
function buildBVHFor(positions, index) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(index.slice(), 1));
  const bvh = new MeshBVH(g);
  return { bvh, index: g.index.array };
}
function buildBVH() {
  state.orig = buildBVHFor(state.welded.positions, state.welded.index);
  if (state.left && !state.left.mirrored) {
    state.left.bvh = state.orig.bvh;
    state.left.bvhIndex = state.orig.index;
  }
}

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function sideAt(x, y) {
  const r = rects();
  for (const side of ['L', 'R']) {
    const rc = r[side];
    if (rc && x >= rc.x && x < rc.x + rc.w && y >= rc.y && y < rc.y + rc.h) return { side, rc };
  }
  return null;
}
function pick(clientX, clientY) {
  const L = state.left;
  if (!L || !L.bvh) return null;
  const box = viewport.getBoundingClientRect();
  const x = clientX - box.left, y = clientY - box.top;
  const s = sideAt(x, y);
  if (!s) return null;
  ndc.set(((x - s.rc.x) / s.rc.w) * 2 - 1, -((y - s.rc.y) / s.rc.h) * 2 + 1);
  camera.aspect = s.rc.w / s.rc.h;
  camera.updateProjectionMatrix();
  raycaster.setFromCamera(ndc, camera);
  if (s.side === 'L') {
    const hit = L.bvh.raycastFirst(raycaster.ray, THREE.DoubleSide);
    if (!hit) return null;
    const idx = L.bvhIndex, f = hit.faceIndex, N = L.normals;
    const n = new THREE.Vector3();
    for (let k = 0; k < 3; k++) { const v = idx[f * 3 + k]; n.x += N[v * 3]; n.y += N[v * 3 + 1]; n.z += N[v * 3 + 2]; }
    return { side: 'L', point: hit.point.clone(), normal: n.normalize(), vertex: labelOf(idx[f * 3]) };
  }
  if (!display.R) return null;
  const hits = raycaster.intersectObject(display.R.surface, false);
  if (!hits.length) return null;
  const h = hits[0];
  return { side: 'R', point: h.point.clone(), normal: h.face.normal.clone(), vertex: display.R.srcId[h.face.a] };
}

function brushRadius() { return (state.diag * settings.brush) / 100; }
function paintValue() {
  switch (settings.tool) {
    case 'more': return settings.strength;
    case 'less': return -settings.strength;
    case 'keep': return LABEL.KEEP;
    default: return 0;
  }
}
const brushSphere = new THREE.Sphere();
function paintAt(point) {
  const L = state.left;
  paintOnSurface(L, point, true);
  if (symActive()) {
    if (L.mirrored) paintOnSurface(originalSurface(), keptSide(point) ? mirrorPoint(point) : point, false);
    else paintOnSurface(L, mirrorPoint(point), true);
  }
  recolorReduced();
  requestRender();
}
// Labels every vertex of surf inside the brush; with recolor, refreshes the left view's colours.
function paintOnSurface(surf, point, recolor) {
  if (!surf || !surf.bvh) return;
  const r = brushRadius(), r2 = r * r, val = paintValue();
  const P = surf.positions, idx = surf.bvhIndex, map = surf.srcId, labels = state.labels;
  const hits = [];
  let changed = false;
  brushSphere.set(point, r);
  surf.bvh.shapecast({
    intersectsBounds: box => (brushSphere.intersectsBox(box) ? INTERSECTED : NOT_INTERSECTED),
    intersectsTriangle: (tri, i) => {
      for (let k = 0; k < 3; k++) {
        const v = idx[i * 3 + k];
        const dx = P[v * 3] - point.x, dy = P[v * 3 + 1] - point.y, dz = P[v * 3 + 2] - point.z;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        const id = map ? map[v] : v;
        if (labels[id] !== val) { labels[id] = val; changed = true; }
        if (recolor) hits.push(v);
      }
      return false;
    },
  });
  if (!changed) return;
  state.strokeChanged = true;
  if (recolor) recolorLeft(hits);
}
function fillAt(hit) {
  const comp = state.welded.components, val = paintValue(), labels = state.labels;
  const targets = new Set([comp[hit.vertex]]);
  if (symActive() && state.orig.bvh) {
    const q = state.left.mirrored ? (keptSide(hit.point) ? mirrorPoint(hit.point) : hit.point) : mirrorPoint(hit.point);
    const near = state.orig.bvh.closestPointToPoint(q, {});
    if (near) targets.add(comp[state.orig.index[near.faceIndex * 3]]);
  }
  for (let v = 0; v < comp.length; v++) {
    if (targets.has(comp[v]) && labels[v] !== val) { labels[v] = val; state.strokeChanged = true; }
  }
  if (state.strokeChanged) recolorAll();
}

// Paint history: each entry is a full label snapshot taken before a change.
function commitHistory(snapshot) {
  state.undo.push(snapshot);
  if (state.undo.length > 40) state.undo.shift();
  state.redo.length = 0;
  updateHistoryButtons();
}
function resetHistory() {
  state.undo = [];
  state.redo = [];
  updateHistoryButtons();
}
function updateHistoryButtons() {
  $('undoBtn').disabled = !state.undo.length;
  $('redoBtn').disabled = !state.redo.length;
}
function restoreLabels(labels) {
  state.labels = labels;
  recolorAll();
  updateLegend();
  updateHistoryButtons();
  scheduleReduce(0);
}
function undo() {
  if (state.painting) return;
  const prev = state.undo.pop();
  if (!prev) { setStatus('Nothing to undo', 'info', 1500); return; }
  state.redo.push(state.labels);
  restoreLabels(prev);
}
function redo() {
  if (state.painting) return;
  const next = state.redo.pop();
  if (!next) { setStatus('Nothing to redo', 'info', 1500); return; }
  state.undo.push(state.labels);
  restoreLabels(next);
}
function clearPaint() {
  if (!state.labels || !state.labels.some(Boolean)) return;
  commitHistory(state.labels.slice());
  state.labels.fill(0);
  recolorAll();
  updateLegend();
  scheduleReduce(0);
}

function placeRing(ring, point, normal, r) {
  ring.position.copy(point).addScaledVector(normal, state.diag * 0.002);
  ring.scale.setScalar(r);
  ring.lookAt(point.clone().add(normal));
  ring.visible = true;
}
function showRing(hit) {
  ringL.visible = ringR.visible = ringL2.visible = ringR2.visible = false;
  if (!hit || settings.tool === 'orbit') { requestRender(); return; }
  const r = settings.mode === 'fill' ? state.diag * 0.012 : brushRadius();
  placeRing(hit.side === 'L' ? ringL : ringR, hit.point, hit.normal, r);
  if (symActive()) {
    const n = hit.normal.clone();
    n.setComponent(symPlane.axis, -n.getComponent(symPlane.axis));
    placeRing(hit.side === 'L' ? ringL2 : ringR2, mirrorPoint(hit.point), n, r);
  }
  requestRender();
}

// ---------- symmetry ----------
const AXES = ['X', 'Y', 'Z'];
function symActive() { return settings.symmetry && symPlane.ready; }
function keptSide(p) { return (p.getComponent(symPlane.axis) - symPlane.offset) * (settings.symSide === '-' ? -1 : 1) >= 0; }
function mirrorPoint(p) {
  const q = p.clone();
  q.setComponent(symPlane.axis, 2 * symPlane.offset - q.getComponent(symPlane.axis));
  return q;
}
function symmetrySamples(count = 2500) {
  const V = state.welded.vertexCount, step = Math.max(1, Math.floor(V / count)), out = [];
  for (let v = 0; v < V; v += step) out.push(v);
  return out;
}
function mirrorDistances(axis, offset, samples) {
  const P = state.welded.positions, p = new THREE.Vector3(), info = {};
  const d = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    p.set(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    p.setComponent(axis, 2 * offset - p.getComponent(axis));
    const hit = state.orig.bvh.closestPointToPoint(p, info);
    d[i] = hit ? hit.distance : 0;
  }
  return d;
}
// How far the original's mirror image lands from its own surface, as a share of model size.
function planeFit(axis, offset, samples) {
  const d = mirrorDistances(axis, offset, samples);
  let sum = 0, max = 0;
  for (const x of d) { sum += x; if (x > max) max = x; }
  return { mean: sum / d.length / state.size, max: max / state.size };
}
// Mean of the best 80% of mirror distances, so a one-sided feature can't pull the plane toward it.
function trimmedMirrorError(axis, offset, samples) {
  const d = mirrorDistances(axis, offset, samples).sort();
  const keep = Math.max(1, Math.floor(d.length * 0.8));
  let sum = 0;
  for (let i = 0; i < keep; i++) sum += d[i];
  return sum / keep;
}
// Coarse scan around the box centre, then golden-section refinement of the plane position.
function refineOffset(axis, samples) {
  const b = boundsOf(state.welded.positions);
  const extent = b.max[axis] - b.min[axis] || 1, centre = (b.min[axis] + b.max[axis]) / 2;
  const steps = 12, span = extent * 0.35, stepSize = (2 * span) / steps;
  const f = o => trimmedMirrorError(axis, o, samples);
  let best = centre, bestErr = Infinity;
  for (let i = 0; i <= steps; i++) {
    const o = centre - span + stepSize * i, e = f(o);
    if (e < bestErr) { bestErr = e; best = o; }
  }
  const g = (Math.sqrt(5) - 1) / 2;
  let a = best - stepSize, c = best + stepSize;
  let x1 = c - g * (c - a), x2 = a + g * (c - a), f1 = f(x1), f2 = f(x2);
  for (let it = 0; it < 14; it++) {
    if (f1 < f2) { c = x2; x2 = x1; f2 = f1; x1 = c - g * (c - a); f1 = f(x1); }
    else { a = x1; x1 = x2; f1 = f2; x2 = a + g * (c - a); f2 = f(x2); }
  }
  const offset = (a + c) / 2;
  return Math.abs(offset) < 1e-3 * state.size ? 0 : offset;
}
function setPlane(axis, offset) {
  Object.assign(symPlane, { axis, offset, fit: planeFit(axis, offset, symmetrySamples()), ready: true });
  syncSymmetryUI();
  updatePlaneHelper();
  updateTint();
  scheduleMirrorView(0);
}
function detectPlane(axisOnly) {
  const coarse = symmetrySamples(800), samples = symmetrySamples();
  let best = null;
  for (const axis of axisOnly === undefined ? [0, 1, 2] : [axisOnly]) {
    const offset = refineOffset(axis, coarse);
    const score = planeFit(axis, offset, coarse).mean;
    if (!best || score < best.score) best = { axis, offset, score };
  }
  best.fit = planeFit(best.axis, best.offset, samples);
  delete best.score;
  Object.assign(symPlane, best, { ready: true });
  syncSymmetryUI();
  updatePlaneHelper();
  updateTint();
  scheduleMirrorView(0);
}
function setPlaneOffset(offset) {
  symPlane.offset = offset;
  symPlane.fit = planeFit(symPlane.axis, offset, symmetrySamples());
  syncSymmetryUI();
  updatePlaneHelper();
  updateTint();
  scheduleMirrorView(60);
  scheduleReduce(60);
}
function updateTint() {
  const s = settings.symSide === '-' ? -1 : 1;
  const n = new THREE.Vector3();
  n.setComponent(symPlane.axis, -s);
  tintPlane.set(n, s * symPlane.offset);
  applyDisplaySettings();
}
let mirrorTimer = 0, mirrorSeq = 0;
function scheduleMirrorView(delay = 250) {
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(refreshMirrorView, delay);
}
// Shows the unreduced model with its kept half mirrored, so both views preview the symmetric result.
async function refreshMirrorView() {
  if (!state.welded) return;
  const seq = ++mirrorSeq;
  if (!symActive()) {
    if (state.left && state.left.mirrored) setLeftSurface(originalSurface());
    return;
  }
  const plane = { axis: symPlane.axis, offset: symPlane.offset, keepPositive: settings.symSide !== '-' };
  try {
    const out = await engine.call({ type: 'mirror', doc: doc.id, plane });
    if (seq !== mirrorSeq || !symActive()) return;
    const r = out.result;
    const { bvh, index } = buildBVHFor(r.positions, r.index);
    setLeftSurface({ positions: r.positions, normals: r.normals, uvs: r.uvs, colors: r.colors, index: r.index, vMat: r.vMat,
      srcId: r.srcId, twin: r.twin, halfCount: r.halfCount, bvh, bvhIndex: index, mirrored: true });
    if (state.result) measureDeviation(state.result);
  } catch (err) {
    console.error(err);
    showError(`Couldn't build the mirrored preview: ${err.message || err}`);
  }
}
// offset: a plane position to show without applying it, while the plane slider is being dragged.
function updatePlaneHelper(offset = symPlane.offset) {
  const on = settings.symmetry && settings.showPlane && symPlane.ready && state.welded;
  planeL.visible = planeR.visible = !!on;
  if (on) {
    const b = boundsOf(state.welded.positions);
    const c = [0, 1, 2].map(k => (b.min[k] + b.max[k]) / 2);
    c[symPlane.axis] = offset;
    const s = b.size.map(x => x * 1.12 + b.diag * 0.02);
    for (const g of [planeL, planeR]) {
      g.position.set(c[0], c[1], c[2]);
      g.rotation.set(0, 0, 0);
      if (symPlane.axis === 0) { g.rotation.y = Math.PI / 2; g.scale.set(s[2], s[1], 1); }
      else if (symPlane.axis === 1) { g.rotation.x = -Math.PI / 2; g.scale.set(s[0], s[2], 1); }
      else g.scale.set(s[0], s[1], 1);
    }
  }
  requestRender();
}
function syncSymmetryUI() {
  $('symOn').checked = settings.symmetry;
  $('symBody').hidden = !settings.symmetry;
  $('symIntro').hidden = settings.symmetry;
  $('tintMirror').checked = settings.tintMirror;
  $('showPlane').checked = settings.showPlane;
  pressSeg('symAxisSeg', 'axis', symPlane.axis);
  pressSeg('symSideSeg', 'side', settings.symSide);
  const a = AXES[symPlane.axis];
  const [neg, pos] = $('symSideSeg').querySelectorAll('button');
  neg.textContent = `Keep −${a}`;
  pos.textContent = `Keep +${a}`;
  if (!state.welded || !symPlane.ready) { $('symFitRow').hidden = true; return; }
  const b = boundsOf(state.welded.positions);
  const lo = b.min[symPlane.axis], hi = b.max[symPlane.axis];
  $('symOffset').value = String(Math.round((1000 * (symPlane.offset - lo)) / Math.max(1e-9, hi - lo)));
  if (document.activeElement !== $('symOffNum')) $('symOffNum').value = String(+symPlane.offset.toPrecision(6));
  $('symOffNum').step = String(+(state.size / 1000).toPrecision(2));
  // How well the model matches its own mirror image: within 0.5% of its size counts as symmetric, past 2% it doesn't.
  const f = symPlane.fit;
  const pct = v => (v < 0.1 ? v.toFixed(3) : v < 1 ? v.toFixed(2) : v.toFixed(1));
  const row = $('symFitRow');
  row.hidden = false;
  row.className = `status-line ${!f ? '' : f.max <= 0.005 ? 'ok' : f.max <= 0.02 ? '' : 'warn'}`;
  row.title = 'How far the original lands from its own mirror image, as a share of the model size';
  $('symFit').textContent = !f ? 'Mirror plane' : `${f.max <= 0.005 ? 'Symmetric' : f.max <= 0.02 ? 'Nearly symmetric' : 'Not symmetric'} · ${pct(f.mean * 100)}% avg, ${pct(f.max * 100)}% max`;
  $('symWhat').textContent = `The ${settings.symSide === '-' ? '−' : '+'}${a} half is reduced, then mirrored over ${a} = ${+symPlane.offset.toPrecision(4)}. The tinted half is the copy and shares its UVs.`;
}

let moveQueued = null;
canvas.addEventListener('pointerdown', e => {
  if (settings.tool === 'orbit' || e.button !== 0 || !(state.left && state.left.bvh)) return;
  const hit = pick(e.clientX, e.clientY);
  if (!hit) return;
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
  state.strokeSnapshot = state.labels.slice();
  state.strokeChanged = false;
  if (settings.mode === 'fill') { fillAt(hit); endStroke(); return; }
  state.painting = true;
  paintAt(hit.point);
});
canvas.addEventListener('pointermove', e => {
  if (settings.tool === 'orbit' || !(state.left && state.left.bvh)) return;
  const first = !moveQueued;
  moveQueued = { x: e.clientX, y: e.clientY };
  if (!first) return;
  requestAnimationFrame(() => {
    const m = moveQueued;
    moveQueued = null;
    const hit = pick(m.x, m.y);
    showRing(hit);
    if (state.painting && hit) paintAt(hit.point);
  });
});
const endPointer = () => { if (state.painting) { state.painting = false; endStroke(); } };
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { if (!state.painting) showRing(null); });
canvas.addEventListener('contextmenu', e => e.preventDefault());
function endStroke() {
  const changed = state.strokeChanged && state.strokeSnapshot;
  if (changed) commitHistory(state.strokeSnapshot);
  state.strokeSnapshot = null;
  state.strokeChanged = false;
  if (!changed) return;
  if (state.left && state.left.srcId) recolorAll();
  updateLegend();
  scheduleReduce(40);
}

function applyTool() {
  const painting = settings.tool !== 'orbit';
  controls.mouseButtons = painting
    ? { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
    : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.touches = painting ? { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE } : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  canvas.style.cursor = painting ? 'crosshair' : 'grab';
  if (!painting) showRing(null);
  const touch = matchMedia('(pointer: coarse)').matches;
  const hint = !painting
    ? touch ? 'Drag to orbit · pinch to zoom · two fingers to pan' : 'Drag to orbit · right-drag to pan · scroll to zoom'
    : settings.mode === 'fill'
      ? touch ? 'Tap a part to fill it · two fingers to orbit' : `Click a part to fill it · right-drag to orbit · ${UNDO_KEY} undo · ${REDO_KEY} redo`
      : touch ? 'Drag across the model to paint · two fingers to orbit' : `Drag to paint · right-drag to orbit · [ ] brush size · ${UNDO_KEY} undo · ${REDO_KEY} redo`;
  if ($('hint').textContent !== hint) {
    $('hint').textContent = hint;
    flashHint();
  }
}
let hintTimer = 0;
function flashHint(ms = 5000) {
  $('hint').classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => $('hint').classList.remove('show'), ms);
}

// ---------- reduction ----------
function targetTris(pct = settings.targetPct) {
  const T = state.welded ? state.welded.triCount : 0;
  return Math.max(4, Math.min(T, Math.round((T * pct) / 100)));
}
function reduceSettings(target) {
  return {
    targetTris: target ?? targetTris(), maxError: Number(settings.maxError), lockBorder: settings.lockBorder,
    permissive: settings.permissive, prune: settings.prune, regularize: settings.regularize, normalWeight: settings.normalWeight,
    uvWeight: settings.uvWeight, optimizePositions: settings.optimizePositions,
    uvMode: settings.uvMode, deferUV: true, hardAngle: settings.hardAngle,
    symmetry: settings.symmetry && symPlane.ready ? { axis: symPlane.axis, offset: symPlane.offset, keepPositive: settings.symSide !== '-' } : null,
  };
}
function finalizeOptions() { return { normals: settings.normals, creaseAngle: settings.creaseAngle }; }

let reduceTimer = 0, reducing = false, reducePending = false;
function scheduleReduce(delay = 120) {
  clearTimeout(reduceTimer);
  reduceTimer = setTimeout(runReduce, delay);
  saveSessionSoon();
}
async function runReduce() {
  reduceTimer = 0;
  if (!state.welded) return;
  if (reducing) { reducePending = true; return; }
  reducing = true;
  setBusy(true);
  try {
    const d = doc, labels = state.labels.slice(), st = reduceSettings();
    const out = await engine.call({ type: 'reduce', doc: d.id, labels, settings: st, finalize: finalizeOptions() });
    if (d === doc) showResult(out.result, out.info, labels, st);
    else keepResult(d, out.result, out.info, labels, st);
  } catch (err) {
    console.error(err);
    showError(`Reduction failed: ${err.message || err}`);
  }
  reducing = false;
  setBusy(false);
  if (reducePending) { reducePending = false; runReduce(); }
}

function measureDeviation(res) {
  const ref = state.left && state.left.bvh;
  if (!ref || (res !== state.result && !(state.geo && state.geo.result === res))) return;
  const P = res.positions, idx = res.index, T = idx.length / 3;
  const n = Math.min(4000, T), step = T / n;
  const p = new THREE.Vector3(), hitInfo = {};
  let sum = 0, max = 0;
  for (let i = 0; i < n; i++) {
    const t = Math.floor(i * step);
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    p.set((P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3);
    const hit = ref.closestPointToPoint(p, hitInfo);
    const d = hit ? hit.distance : 0;
    sum += d;
    if (d > max) max = d;
  }
  const mean = (100 * sum) / n / state.size, worst = (100 * max) / state.size;
  const f = v => (v < 0.1 ? v.toFixed(3) : v < 1 ? v.toFixed(2) : v.toFixed(1));
  $('resErr').textContent = `${f(mean)}% avg · ${f(worst)}% max`;
}

// ---------- panels ----------
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const c of children) n.append(c);
  return n;
}
const kpiItems = list => list.map(([k, v]) => el('div', {}, el('dt', { textContent: k }), el('dd', { textContent: v, title: v })));
const checkItem = ([tone, title, detail]) => el('li', { className: tone }, el('b', { textContent: title }), ...(detail ? [el('span', { textContent: detail })] : []));
function updateModelPanel() {
  const w = state.welded;
  $('modelKpis').hidden = $('modelSize').hidden = $('meshDetails').hidden = !w;
  if (!w) {
    $('diag').replaceChildren(checkItem(doc.saved ? ['info', 'Reopening from your last visit…', ''] : ['info', 'No model in this tab yet', 'Open one, or drop it on the view with its textures.']));
    return;
  }
  const s = w.stats, c = state.collected;
  const b = bounds(w.positions);
  const scale = (state.meta.unitScale || 100) / 100;
  const dims = b.size.map(x => (x * scale).toFixed(x * scale < 10 ? 3 : 1)).join(' × ');
  $('modelKpis').replaceChildren(...kpiItems([
    ['Triangles', fmt(w.triCount)],
    ['Vertices', fmt(s.weldedVertices)],
    s.keptUVs ? ['UV islands', fmt(w.uvIslands)] : ['Materials', fmt(Math.max(1, c.materials.length))],
  ]));
  $('modelSize').replaceChildren(el('b', { textContent: 'Size' }), `${dims} m`);
  const rows = [
    ['Vertices as stored', fmt(s.storedRenderVertices)],
    ['Vertices after welding', fmt(s.weldedVertices)],
    ['Parts', fmt(c.parts.length)],
    ['Materials', fmt(Math.max(1, c.materials.length))],
    ['Separate pieces', fmt(w.componentCount)],
    ...(s.keptUVs ? [['UV islands', fmt(w.uvIslands)]] : []),
    ...(s.removedDegenerate ? [['Zero-area triangles removed', fmt(s.removedDegenerate)]] : []),
  ];
  $('modelStats').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]));
  const checks = [];
  if (state.pendingMaps && state.pendingMaps.length) {
    const names = [...new Set(state.pendingMaps.map(p => p.file))];
    checks.push(['warn', names.length === 1 ? 'A texture is missing' : `${names.length} textures are missing`, `${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}. Drop the files on the view, or click the dashed tile under Texture.`]);
  }
  if (c.parts.some(p => p.skinned)) checks.push(['warn', 'Skinned mesh', 'Reduced in its bind pose and exported without bones.']);
  if (settings.symmetry && symPlane.ready && symPlane.fit && symPlane.fit.max > 0.02) {
    checks.push(['warn', `Not symmetric about ${AXES[symPlane.axis]} = ${+symPlane.offset.toPrecision(4)}`, "Mirroring replaces the other half's differences."]);
  }
  const ratio = s.storedRenderVertices / Math.max(1, s.uniquePositions);
  if (ratio >= 2.5) checks.push(['ok', 'Split vertices merged', `${fmt(s.storedRenderVertices)} stored copies of ${fmt(s.uniquePositions)} points. This is why other tools could not reduce it.`]);
  if (!s.hasUVs) checks.push(['info', 'No UVs', "Textures can't map onto this model."]);
  if (s.hasColors) checks.push(['info', 'Vertex colours', 'Kept through reduction.']);
  if (w.componentCount > 1) checks.push(['info', `${fmt(w.componentCount)} separate pieces`, 'Fill part paints one piece at a time.']);
  if (state.meta.sample) checks.unshift(['info', 'Sample model', 'The head and the knurled base band are painted More detail, the underside Less detail.']);
  $('diag').replaceChildren(...checks.map(checkItem));
}

function updateLegend() {
  const counts = { more: 0, less: 0, keep: 0 };
  const L = state.labels;
  if (L) for (let i = 0; i < L.length; i++) { const l = L[i]; if (l === LABEL.KEEP) counts.keep++; else if (l > 0) counts.more++; else if (l < 0) counts.less++; }
  const item = (cls, label, n) => el('li', {}, el('span', { className: `dot ${cls}` }), `${label} ${fmt(n)}`);
  $('legend').replaceChildren(item('more', 'More', counts.more), item('less', 'Less', counts.less), item('keep', 'Keep', counts.keep));
  $('legend').title = 'Painted vertices per region';
}

function sizeBudgetInput() {
  const input = $('targetNum');
  input.style.width = `${Math.max(4, input.value.length) + 1}ch`;
}
// preview: a budget to show without applying it, while the slider is dragged; nothing else redraws the readout meanwhile.
let budgetDragging = false;
function updateTargetUI(preview) {
  if (budgetDragging && preview === undefined) return;
  const pct = preview ?? settings.targetPct;
  const input = $('targetNum'), editing = document.activeElement === input;
  if (!state.welded) {
    if (!editing) input.value = '—';
    sizeBudgetInput();
    $('targetOf').textContent = '';
    pressSeg('quickSeg', 'pct', null);
    return;
  }
  const T = state.welded.triCount, t = targetTris(pct);
  if (!editing) input.value = fmt(t);
  sizeBudgetInput();
  $('targetOf').textContent = `of ${fmt(T)} · ${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
  $('targetSlider').value = String(Math.round((1000 * Math.log(pct / 0.1)) / Math.log(1000)));
  pressSeg('quickSeg', 'pct', pct);
  if (display.L && state.left) {
    const L = state.left;
    $('labelLText').textContent = L.mirrored
      ? `${fmt(L.index.length / 3)} tris · ${fmt(L.positions.length / 3)} verts · mirrored`
      : `${fmt(T)} tris · ${fmt(state.welded.vertexCount)} verts`;
  }
}

function setPill(tone, text) {
  const p = $('bNote');
  p.className = `pill ${tone}`;
  p.textContent = text;
}
function clearErrorLimit() {
  settings.maxError = 0;
  syncControls();
  saveSettings();
  scheduleReduce(0);
}
function setUVMode(mode) {
  settings.uvMode = mode;
  syncControls();
  saveSettings();
  updateUVPanel();
  scheduleReduce(0);
}
function updateResultUI() {
  const i = state.info;
  $('exportOpen').disabled = !state.result;
  $('result').hidden = !state.welded;
  if (!i) {
    for (const id of ['resTris', 'resVerts', 'resErr', 'resTex']) $(id).textContent = '—';
    $('resTex').className = '';
    $('resTime').textContent = '';
    for (const id of ['bKeep', 'bMore', 'bLess', 'bRest']) $(id).style.width = '0';
    $('bMarker').hidden = true;
    $('barLegend').replaceChildren();
    $('resWhy').hidden = true;
    setPill(state.welded ? 'busy' : '', state.welded ? 'Reducing…' : '');
    $('labelRText').textContent = '';
    $('resSym').hidden = true;
    return;
  }
  const target = targetTris(), over = i.tris > target * 1.02;
  $('resTris').textContent = fmt(i.tris);
  $('resVerts').textContent = fmt(i.verts);
  $('resTime').textContent = i.ms >= 1000 ? `${(i.ms / 1000).toFixed(1)} s` : `${fmt(i.ms)} ms`;
  const layout = state.result && state.result.uvLayout;
  $('labelRText').replaceChildren(`${fmt(i.tris)} tris · ${fmt(i.verts)} verts${i.symmetry ? ' · mirrored' : ''}${layout === 'new' ? ' · new UVs' : layout === 'pending' ? ' · baking texture…' : ''}`);
  if (over) $('labelRText').append(el('span', { className: 'warn', textContent: ' · over budget' }));
  const sym = i.symmetry, symEl = $('resSym');
  symEl.hidden = !sym;
  if (sym) {
    const all = sym.paired === sym.total;
    symEl.classList.toggle('bad', !all);
    $('resSymText').textContent = all ? `all ${fmt(sym.total)} vertices paired` : `${fmt(sym.total - sym.paired)} of ${fmt(sym.total)} unpaired`;
    symEl.title = `${fmt(sym.seamVertices)} vertices sit on the plane and pair with themselves; the rest pair across it`;
  }
  const max = Math.max(i.tris, target) * 1.04;
  const pct = n => `${((100 * n) / max).toFixed(3)}%`;
  $('bKeep').style.width = pct(i.cat.keep);
  $('bMore').style.width = pct(i.cat.more);
  $('bLess').style.width = pct(i.cat.less);
  $('bRest').style.width = pct(i.cat.rest);
  $('bMarker').hidden = false;
  $('bMarker').style.left = `calc(${pct(target)} - 1px)`;
  $('bar').title = `Kept original ${fmt(i.cat.keep)} · More detail ${fmt(i.cat.more)} · Less detail ${fmt(i.cat.less)} · Unpainted ${fmt(i.cat.rest)} triangles; the line is the budget`;
  const painted = i.cat.keep + i.cat.more + i.cat.less > 0;
  const cats = [['keep', 'Keep', i.cat.keep], ['more', 'More', i.cat.more], ['less', 'Less', i.cat.less], ['rest', 'Unpainted', i.cat.rest]];
  $('barLegend').hidden = !painted;
  $('barLegend').replaceChildren(...(painted ? cats.filter(c => c[2] > 0).map(([k, name, n]) => el('li', {}, el('i', { className: `seg-${k}` }), `${name} ${fmt(n)}`)) : []));
  const tex = textureSummary();
  $('resTex').textContent = tex[1];
  $('resTex').className = tex[0];
  // What the result says about the budget, and a one-click way out when there is one.
  const w = state.welded, limited = Number(settings.maxError) > 0;
  let tone = 'ok', text = 'On budget', why = '', action = null;
  if (!over) {
    if (i.tris < target * 0.98 && limited) { tone = 'info'; text = 'Under budget'; why = 'It stopped at the error limit before using the whole budget.'; action = ['Remove the limit', clearErrorLimit]; }
  } else {
    tone = 'warn';
    text = 'Over budget';
    if (i.cat.keep > target * 0.5) why = `Keep-original areas alone use ${fmt(i.cat.keep)} triangles. Paint less Keep, or raise the budget.`;
    else if (limited) { why = 'It stopped at the error limit before reaching the budget.'; action = ['Remove the limit', clearErrorLimit]; }
    else if (w.stats.keptUVs && w.uvIslands > 100 && !settings.permissive && layout === 'original') {
      why = `UV seams stop it at ${fmt(i.tris)} triangles.`;
      action = settings.uvMode === 'keep' ? ['Switch to Auto', () => setUVMode('auto')] : ['Use new UVs', () => setUVMode('new')];
    } else why = "Locked or protected areas can't collapse any further.";
  }
  let whyTone = tone;
  if (!why && tex[0] === 'warn' && layout === 'original' && settings.uvMode === 'keep') {
    why = 'Most of the texture lands in the wrong place with the original UVs at this budget.';
    action = ['Switch to Auto', () => setUVMode('auto')];
    whyTone = 'warn';
  }
  setPill(tone, text);
  const whyEl = $('resWhy');
  whyEl.hidden = !why;
  whyEl.className = `result-why${whyTone === 'warn' ? ' warn' : ''}`;
  whyEl.replaceChildren(el('span', { textContent: why }));
  if (action) {
    const b = el('button', { type: 'button', className: 'btn small', textContent: action[0] });
    b.addEventListener('click', action[1]);
    whyEl.append(b);
  }
}

// [tone, text] for the result's texture line.
function textureSummary() {
  const r = state.result, i = state.info;
  if (!state.welded || !state.welded.uvs) return ['', 'none, the model has no UVs'];
  if (!r || !i) return ['', '—'];
  if (r.uvLayout === 'pending') return state.texturing ? ['busy', 'new UVs · baking…'] : ['warn', 'new UVs not made yet'];
  const textured = state.displayMats.some(m => MAP_SLOTS.some(slot => m[slot]));
  if (r.uvLayout === 'new') return state.bake ? ['', `new UVs · baked at ${state.bake.size} px`] : textured ? ['warn', 'new UVs · not baked'] : ['', 'new UVs'];
  const fit = i.uvFit, bad = fit && fit.misplaced > AUTO_UV_LIMIT;
  return bad ? ['warn', `original UVs · ${(fit.misplaced * 100).toFixed(0)}% misplaced`] : ['', 'original UVs · fits'];
}
// [tone, headline, detail] for the Texture section, or null without a model.
function uvStatus() {
  const r = state.result, i = state.info;
  if (!state.welded) return null;
  if (!state.welded.uvs) return ['', 'No UVs', 'This model has no UVs, so there is no texture to keep or bake.'];
  if (!r || !i) return ['busy', 'Reducing…', ''];
  const pct = v => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
  const fit = i.uvFit;
  const textured = state.displayMats.some(m => MAP_SLOTS.some(slot => m[slot]));
  const why = i.uvDecision === 'rebuilt' && fit ? `The original UVs would put ${fit.estimated ? 'over ' : ''}${pct(fit.misplaced)} of the texture in the wrong place at this budget.` : '';
  if (r.uvLayout === 'pending') {
    if (!state.texturing) return ['warn', 'New UVs not made yet', why];
    return ['busy', textured ? 'Making new UVs and baking the texture…' : 'Making new UVs…', [why, textured ? 'The reduced view shows clay until it is done.' : ''].filter(Boolean).join(' ')];
  }
  if (r.uvLayout === 'new') {
    const a = i.atlas;
    const baked = state.bake ? `The texture is baked onto them from the original at ${state.bake.size} px.` : textured ? 'The texture could not be baked.' : 'There is no texture to bake.';
    return [state.bake || !textured ? 'ok' : 'warn', `New UVs · ${fmt(a.charts)} charts · ${pct(a.coverage)} of the sheet`, [why, baked].filter(Boolean).join(' ')];
  }
  if (!fit) return ['ok', 'Original UVs', ''];
  if (settings.uvMode === 'keep') {
    const bad = fit.misplaced > AUTO_UV_LIMIT;
    return [bad ? 'warn' : 'ok', 'Original UVs', `${pct(fit.misplaced)} of the texture lands in the wrong place at this budget.${bad ? ' Auto or New UVs would bake the texture to fit.' : ''}`];
  }
  return ['ok', 'Original UVs still fit', fit.misplaced < 0.0005 ? 'The texture lands where it should, so it is used as it is.' : `Only ${pct(fit.misplaced)} of the texture is off, so it is used as it is.`];
}
function updateUVPanel() {
  $('keepUVOpts').hidden = settings.uvMode === 'new';
  updateExportPanel();
  const st = uvStatus(), row = $('uvStatus');
  row.hidden = !st;
  if (!st) return;
  row.className = `status-line ${st[0]}`;
  $('uvHead').textContent = st[1];
  $('uvNote').textContent = st[2];
  $('uvNote').hidden = !st[2];
  refreshUVView();
}

let busyTimer = 0;
function setBusy(on) {
  clearTimeout(busyTimer);
  const label = $('labelR');
  if (on) {
    busyTimer = setTimeout(() => {
      if (!label.querySelector('.busy-dot')) label.append(el('span', { className: 'busy-dot', title: 'Reducing…' }));
      $('result').classList.add('stale');
    }, 150);
  } else {
    label.querySelector('.busy-dot')?.remove();
    $('result').classList.remove('stale');
  }
}
let statusTimer = 0;
function setStatus(text, tone = 'info', ttl = 0) {
  const s = $('status');
  clearTimeout(statusTimer);
  s.textContent = text;
  s.classList.toggle('error', tone === 'error');
  if (text) $('hint').classList.remove('show');
  if (ttl) statusTimer = setTimeout(() => { s.textContent = ''; }, ttl);
}
function showError(text) { setStatus(text, 'error', 12000); }

// ---------- export ----------
function sanitize(name) { return String(name || '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'Model'; }

async function imageToPng(image) {
  const w = image.width || image.naturalWidth, h = image.height || image.naturalHeight;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (image.data) g.putImageData(new ImageData(new Uint8ClampedArray(image.data.buffer ? image.data : Uint8Array.from(image.data)), w, h), 0, 0);
  else g.drawImage(image, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

const MAP_FILE = { map: 'basecolor', normalMap: 'normal', roughnessMap: 'roughness', metalnessMap: 'metallic', aoMap: 'occlusion', emissiveMap: 'emissive', specularMap: 'specular', bumpMap: 'height', alphaMap: 'alpha' };

// PNG of a baked map, rows flipped so the top row is v = 1 as FBX and OBJ expect.
async function bakedPng(data, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const img = new ImageData(size, size), row = size * 4;
  for (let y = 0; y < size; y++) img.data.set(data.subarray((size - 1 - y) * row, (size - y) * row), y * row);
  c.getContext('2d').putImageData(img, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

// Unique, file-safe material names, as the exporters write them.
function materialNames() {
  const used = new Set();
  return (state.displayMats.length ? state.displayMats : [null]).map((m, i) => {
    let name = sanitize(m && m.name ? m.name : `Material${i + 1}`);
    while (used.has(name)) name += '_';
    used.add(name);
    return name;
  });
}
// The opened file a texture image came from, if any.
function sourceFileOf(img) {
  const src = img && (img.currentSrc || img.src || '');
  const known = src && state.meta.blobToName && state.meta.blobToName.get(src);
  return (known && state.meta.files.get(known.toLowerCase())) || null;
}

async function materialInfos(stem) {
  const out = [], names = materialNames();
  const baked = state.result && state.result.uvLayout === 'new';
  const mats = state.displayMats.length ? state.displayMats : [null];
  for (let i = 0; i < mats.length; i++) {
    const m = mats[i], name = names[i];
    const rgb = m && m.color ? m.color.getRGB(new THREE.Color(), THREE.SRGBColorSpace) : { r: 0.8, g: 0.8, b: 0.8 };
    let texture = null, bytes = null, normal = null;
    const extra = [];
    if (baked) {
      for (const x of state.bake ? state.bake.maps.filter(b => b.mi === i) : []) {
        const file = `${stem}_${name}_${MAP_FILE[x.slot] || x.slot}.png`;
        const png = await bakedPng(x.data, state.bake.size);
        if (x.slot === 'map') { texture = file; bytes = png; } else extra.push({ file, bytes: png });
        if (x.slot === 'normalMap') normal = file;
      }
    } else if (m) {
      for (const slot of MAP_SLOTS) {
        const img = m[slot] && m[slot].image;
        if (!img) continue;
        const file = sourceFileOf(img);
        let fileName, data;
        if (file) { fileName = file.name; data = new Uint8Array(await file.arrayBuffer()); }
        else if (slot === 'map') { fileName = `${name}_basecolor.png`; data = await imageToPng(img); }
        else continue;
        if (slot === 'map') { texture = fileName; bytes = data; } else extra.push({ file: fileName, bytes: data });
        if (slot === 'normalMap') normal = fileName;
      }
    }
    out.push({ name, color: [rgb.r, rgb.g, rgb.b], texture, bytes, normal, extra, source: baked && state.bakedMats ? state.bakedMats[i] : m });
  }
  return out;
}

async function glbBytes(objects, scale) {
  const scene = new THREE.Scene();
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

const downloadsReady = window.claude && typeof window.claude.use === 'function' ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);

async function saveZip(filename, bytes) {
  const blob = new Blob([bytes], { type: 'application/zip' });
  const dl = await downloadsReady;
  if (dl) {
    try {
      await dl.save({ filename, data: blob });
      setStatus(`Saved ${filename}`, 'info', 4000);
    } catch (err) {
      const code = err && err.code;
      if (code === 'declined') setStatus('Export cancelled', 'info', 3000);
      else if (code === 'rate_limited') setStatus('A save prompt is already open', 'info', 3000);
      else if (code === 'rejected_extension' || code === 'extension_not_enabled') showError('Zip downloads are turned off in this view.');
      else showError(`Couldn't save the file: ${(err && err.message) || code || err}`);
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  setStatus(`Saved ${filename}`, 'info', 4000);
}

// What an export writes, without reading any bytes: the model files and the textures, each { name, note, pending }.
function exportPlan() {
  const res = state.result;
  if (!res || !state.meta) return null;
  const base = sanitize((state.meta.name || 'model').replace(/\.[^.]+$/, ''));
  const stem = `${base}_${res.triCount}`, ext = settings.format;
  const files = ext === 'obj' ? [{ name: `${stem}.obj`, note: 'model' }, { name: `${stem}.mtl`, note: 'materials' }] : [{ name: `${stem}.${ext}`, note: 'model' }];
  const names = materialNames(), seen = new Set(), textures = [];
  const add = (name, note, pending = false) => { if (!seen.has(name)) { seen.add(name); textures.push({ name, note, pending }); } };
  if (res.uvLayout === 'new' && state.bake) {
    for (const x of state.bake.maps) add(`${stem}_${names[x.mi]}_${MAP_FILE[x.slot] || x.slot}.png`, `${SLOT_NAMES[x.slot]} · baked at ${state.bake.size} px`);
  } else if (res.uvLayout === 'pending') {
    if (texturedMaterials().length) add('Baked textures', 'still being made; the export waits for them', true);
  } else if (res.uvLayout !== 'new') {
    state.displayMats.forEach((m, i) => {
      for (const slot of MAP_SLOTS) {
        const img = m[slot] && m[slot].image;
        if (!img) continue;
        const file = sourceFileOf(img);
        if (file) add(file.name, `${SLOT_NAMES[slot]} · the original file`);
        else if (slot === 'map') add(`${names[i]}_basecolor.png`, `${SLOT_NAMES[slot]} · written from the model`);
      }
    });
  }
  return { stem, files, textures };
}
const ICON_FILE = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5"/></svg>';
const ICON_IMAGE = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.7"/><path d="m20.5 16-5-5-9 8.5"/></svg>';
function svgIcon(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup;
  return t.content.firstChild;
}
const listText = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
let exportIsOpen = false;
function updateExportPanel() {
  if (!exportIsOpen) return;
  const plan = exportPlan();
  $('exportBtn').disabled = !plan;
  $('exportMeta').textContent = plan ? `${fmt(state.result.triCount)} tris · ${fmt(state.result.vertexCount)} verts` : '';
  if (!plan) {
    $('exportFiles').replaceChildren(el('li', { className: 'none', textContent: 'Nothing to export yet.' }));
    $('exportNote').textContent = '';
    return;
  }
  const row = (icon, name, note, cls = '') => el('li', { className: cls }, svgIcon(icon), el('span', { className: 'fname', textContent: name, title: name }), el('span', { className: 'fnote', textContent: note }));
  const rows = [];
  if (settings.format === 'glb') {
    const kinds = [...new Set(plan.textures.filter(t => !t.pending).map(t => t.note.split(' · ')[0]))];
    rows.push(row(ICON_FILE, plan.files[0].name, kinds.length ? `model, with its ${listText(kinds)} ${kinds.length === 1 ? 'texture' : 'textures'} inside` : 'model'));
    for (const t of plan.textures.filter(t => t.pending)) rows.push(row(ICON_IMAGE, t.name, t.note, 'pending'));
  } else {
    for (const f of plan.files) rows.push(row(ICON_FILE, f.name, f.note));
    for (const t of plan.textures) rows.push(row(ICON_IMAGE, t.name, t.note, t.pending ? 'pending' : ''));
  }
  $('exportFiles').replaceChildren(...rows);
  const units = { auto: 'in the source file\'s units', m: 'in metres', cm: 'in centimetres' }[settings.units];
  $('exportNote').textContent = `Saved as ${plan.stem}.zip, ${units}.`;
}
function placeExport() {
  const pop = $('exportPop'), r = $('exportOpen').getBoundingClientRect(), w = Math.min(340, window.innerWidth - 16);
  pop.style.width = `${w}px`;
  pop.style.top = `${Math.round(r.bottom + 8)}px`;
  pop.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)))}px`;
}
function exportToggled(open) {
  exportIsOpen = open;
  $('exportOpen').setAttribute('aria-expanded', String(open));
  if (open) { placeExport(); updateExportPanel(); }
}
function closeExport() {
  const pop = $('exportPop');
  if (!exportIsOpen) return;
  if (typeof pop.hidePopover === 'function') pop.hidePopover();
  else { pop.classList.remove('open'); exportToggled(false); }
}

async function exportModel() {
  if (!state.result) return;
  const btn = $('exportBtn');
  btn.disabled = true;
  try {
    const { filename, zip } = await buildExport();
    await saveZip(filename, zip);
    closeExport();
  } catch (err) {
    console.error(err);
    showError(`Export failed: ${err.message || err}`);
  } finally {
    btn.disabled = false;
  }
}

async function buildExport() {
  if (state.texturing) {
    setStatus('Finishing the texture…');
    while (state.texturing) await state.texturing;
  }
  if (state.result.uvLayout === 'pending') throw new Error("the new UVs and texture couldn't be made for this result");
  const base = sanitize((state.meta.name || 'model').replace(/\.[^.]+$/, ''));
  const unitScale = settings.units === 'm' ? 100 : settings.units === 'cm' ? 1 : state.meta.unitScale || 100;
  const res = state.result, stem = `${base}_${res.triCount}`;
  const mats = await materialInfos(stem);
  const parts = state.collected.parts;
  setStatus('Writing files…');
  await nextFrame();
  const objects = exportObjects(res, parts, mats, parts.length === 1, base);
  const files = {};
  if (settings.format === 'fbx') files[`${stem}.fbx`] = writeFBX(objects, { unitScale, fileName: `${stem}.fbx` }, FBX_TEMPLATE);
  else if (settings.format === 'glb') files[`${stem}.glb`] = await glbBytes(objects, unitScale / 100);
  else {
    const { obj, mtl } = writeOBJ(objects, { scale: unitScale / 100, mtlName: `${stem}.mtl` });
    files[`${stem}.obj`] = strToU8(obj);
    files[`${stem}.mtl`] = strToU8(mtl);
  }
  if (settings.format !== 'glb') {
    for (const m of mats) {
      if (m.texture && m.bytes) files[m.texture] = m.bytes;
      for (const x of m.extra) files[x.file] = x.bytes;
    }
  }
  setStatus('');
  return { filename: `${stem}.zip`, zip: zipSync(files, { level: 6 }) };
}

// ---------- sample ----------
function samplePawn() {
  const ctrl = [[0, 0], [0.4, 0], [0.428, 0.012], [0.44, 0.045], [0.432, 0.072], [0.392, 0.086], [0.372, 0.102], [0.38, 0.124],
    [0.344, 0.15], [0.284, 0.178], [0.228, 0.24], [0.192, 0.34], [0.17, 0.45], [0.158, 0.52], [0.232, 0.556], [0.25, 0.574],
    [0.214, 0.594], [0.148, 0.614], [0.128, 0.64], [0.126, 0.664], [0.128, 0.686]];
  const curve = new THREE.CatmullRomCurve3(ctrl.map(([r, y]) => new THREE.Vector3(r, y, 0)), false, 'centripetal');
  const pts = curve.getPoints(230).map(p => new THREE.Vector2(Math.max(0, p.x), p.y));
  const cy = 0.768, R = 0.152, a0 = Math.asin((0.686 - cy) / R);
  for (let i = 1; i <= 64; i++) {
    const a = a0 + (Math.PI / 2 - a0) * (i / 64);
    pts.push(new THREE.Vector2(Math.max(0, R * Math.cos(a)), cy + R * Math.sin(a)));
  }
  const geo = new THREE.LatheGeometry(pts, 320);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-6) continue;
    const th = Math.atan2(x, z);
    let d = 0;
    if (y > 0.018 && y < 0.068) {
      const k = Math.abs(Math.sin(36 * th + 260 * y)) + Math.abs(Math.sin(36 * th - 260 * y));
      d -= 0.0034 * Math.max(0, k - 0.9);
    }
    d -= 0.006 * Math.exp(-(((y - 0.3) / 0.0045) ** 2)) + 0.006 * Math.exp(-(((y - 0.4) / 0.0045) ** 2));
    if (y > 0.7) {
      const phi = Math.acos(Math.min(1, Math.max(-1, (y - cy) / R)));
      d += 0.0024 * Math.sin(14 * th) * Math.sin(12 * phi);
    }
    const s = (r + d) / r;
    pos.setXYZ(i, x * s, y, z * s);
  }
  geo.computeVertexNormals();
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { g.fillStyle = (x + y) % 2 ? '#d9ccb7' : '#b8a68b'; g.fillRect(x * 32, y * 32, 32, 32); }
  g.strokeStyle = 'rgba(52, 38, 20, 0.45)';
  g.lineWidth = 3;
  for (let i = 0; i <= 512; i += 128) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 512); g.moveTo(0, i); g.lineTo(512, i); g.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, name: 'PawnMaterial' }));
  mesh.name = 'SamplePawn';
  return mesh;
}
function paintSample() {
  const P = state.welded.positions, L = state.labels;
  for (let v = 0; v < L.length; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    const r = Math.hypot(x, z);
    if (y > 0.69) L[v] = LABEL.MORE1;
    else if (y > 0.016 && y < 0.07 && r > 0.4) L[v] = LABEL.MORE1;
    else if (y < 0.0015) L[v] = LABEL.LESS3;
  }
  recolorAll();
}

// ---------- texture & UV panel ----------
// A drawer beside the view shows one texture of the open tab with its UV layout drawn over it: the original model on
// one pane, the reduced result on the other. It has its own small WebGL renderer and draws only when something changes.
// Textures show their stored values (no tone mapping or colour conversion), magnified texels stay square.
const UV_TEX_VS = /* glsl */'varying vec2 vUv; void main() { vUv = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, 0.0, 1.0); }';
const UV_TEX_FS = /* glsl */`
uniform sampler2D map;
uniform mat3 uvTransform;
uniform bool hasMap;
uniform vec3 checkA;
uniform vec3 checkB;
uniform vec3 outside;
uniform float cell;
varying vec2 vUv;
void main() {
  vec2 c = floor(gl_FragCoord.xy / cell);
  vec3 col = mod(c.x + c.y, 2.0) < 1.0 ? checkA : checkB;
  // Outside the 0-1 sheet the checker fades into the background, so UVs that stray off it stand out.
  bool inside = vUv.x >= 0.0 && vUv.x <= 1.0 && vUv.y >= 0.0 && vUv.y <= 1.0;
  if (hasMap && inside) {
    vec4 t = texture2D(map, (uvTransform * vec3(vUv, 1.0)).xy);
    col = mix(col, t.rgb, t.a);
  }
  gl_FragColor = vec4(inside ? col : mix(col, outside, 0.8), 1.0);
}`;
// Triangle edges partly invert what is under them, so they read on light and dark texels alike; seams (island borders)
// are a solid colour that few textures share.
const UV_LINE_VS = /* glsl */'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, 0.0, 1.0); }';
const uvEdgeMaterial = () => new THREE.ShaderMaterial({
  vertexShader: UV_LINE_VS,
  fragmentShader: 'uniform float strength; void main() { gl_FragColor = vec4(vec3(strength), 1.0); }',
  uniforms: { strength: { value: 0.4 } },
  transparent: true, depthTest: false, depthWrite: false,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneMinusDstColorFactor, blendDst: THREE.OneMinusSrcColorFactor,
});
const uvSeamMat = new THREE.LineBasicMaterial({ color: 0x2fd3ff, transparent: true, opacity: 0.95, depthTest: false, toneMapped: false });
const uvBorderMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.85, depthTest: false, toneMapped: false });
const uvQuadGeo = new THREE.BufferGeometry();
uvQuadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-3, -3, 0, 4, -3, 0, 4, 4, 0, -3, 4, 0]), 3));
uvQuadGeo.setIndex([0, 1, 2, 0, 2, 3]);
const uvBorderGeo = new THREE.BufferGeometry();
uvBorderGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
const uvCam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
const uvEdgeCache = new WeakMap();
const objIds = new WeakMap();
let objSeq = 0;
const objId = o => (o ? objIds.get(o) || (objIds.set(o, ++objSeq), objSeq) : 0);

function makeUVPane(side) {
  const scene = new THREE.Scene();
  const quad = new THREE.Mesh(uvQuadGeo, new THREE.ShaderMaterial({
    vertexShader: UV_TEX_VS, fragmentShader: UV_TEX_FS, depthTest: false, depthWrite: false,
    uniforms: { map: { value: null }, uvTransform: { value: new THREE.Matrix3() }, hasMap: { value: false }, checkA: { value: new THREE.Color() }, checkB: { value: new THREE.Color() }, outside: { value: new THREE.Color() }, cell: { value: 8 } },
  }));
  const border = new THREE.LineLoop(uvBorderGeo, uvBorderMat);
  const edges = new THREE.LineSegments(new THREE.BufferGeometry(), uvEdgeMaterial());
  const seams = new THREE.LineSegments(new THREE.BufferGeometry(), uvSeamMat);
  [quad, edges, seams, border].forEach((o, i) => { o.frustumCulled = false; o.renderOrder = i; scene.add(o); });
  return { side, scene, quad, border, edges, seams, el: $(`uvPane${side}`), view: { zoom: 1, cx: 0.5, cy: 0.5 }, rect: null, key: '', texture: null, shown: false, triArea: 0 };
}
const uvView = { renderer: null, queued: false, mat: 0, slot: settings.uvSlot, panes: null, pointers: new Map() };

// Edges of a mesh's layout for one material, cached per mesh.
function layoutEdges(mesh, mi, triEnd) {
  let byMesh = uvEdgeCache.get(mesh.index);
  if (!byMesh) uvEdgeCache.set(mesh.index, (byMesh = new Map()));
  const key = `${mi}|${triEnd}`;
  if (!byMesh.has(key)) {
    const nMat = Math.max(1, state.displayMats.length), vMat = mesh.vMat, idx = mesh.index, uv = mesh.uvs;
    const keep = nMat > 1 ? t => Math.min(vMat[idx[t * 3]], nMat - 1) === mi : null;
    let area = 0, n = 0;
    for (let t = 0; t < triEnd; t++) {
      if (keep && !keep(t)) continue;
      const a = idx[t * 3] * 2, b = idx[t * 3 + 1] * 2, c = idx[t * 3 + 2] * 2;
      area += Math.abs((uv[b] - uv[a]) * (uv[c + 1] - uv[a + 1]) - (uv[c] - uv[a]) * (uv[b + 1] - uv[a + 1])) / 2;
      n++;
    }
    byMesh.set(key, { ...uvEdges(mesh, keep, triEnd), triArea: n ? area / n : 0 });
  }
  return byMesh.get(key);
}
const uvHint = () => (matchMedia('(pointer: coarse)').matches ? 'Pinch to zoom · drag to pan · double-tap to fit' : 'Scroll to zoom · drag to pan · double-click to fit');
const loadedMap = (m, slot) => (m && m[slot] && m[slot].image && !m[slot].userData.pbMissing ? m[slot] : null);
const pctOf = v => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;

// What one pane shows: { key, texture, mesh, triEnd, label, msg, busy }. key changes whenever the texture or the
// layout does; labels and messages are cheap and always refreshed.
function uvPaneContent(side) {
  const w = state.welded;
  if (!w) return { key: 'empty', label: '', msg: loading === doc || doc.saved ? 'Loading the model…' : 'No model in this tab.', busy: loading === doc || !!doc.saved };
  if (!w.uvs) return { key: 'nouv', label: '', msg: 'This model has no UVs, so it has no texture layout.' };
  const mi = uvView.mat, slot = uvView.slot, mat = state.displayMats[mi], base = `${side}|${objId(w.index)}|${mi}`;
  const src = loadedMap(mat, slot), size = t => { const [x, y] = imageSize(t.image); return x === y ? `${x} px` : `${x} × ${y} px`; };
  if (side === 'A') {
    return { key: `${base}|${slot}|${objId(src)}`, texture: src, mesh: w, triEnd: w.triCount, label: `${fmt(w.uvIslands)} ${w.uvIslands === 1 ? 'island' : 'islands'}${src ? ` · ${size(src)}` : ' · no texture'}` };
  }
  const r = state.result, i = state.info;
  if (!r || !i) return { key: `${base}|wait`, label: '', msg: 'Reducing…', busy: true };
  if (r.uvLayout === 'pending') {
    return { key: `${base}|pending|${objId(r)}`, label: 'new UVs', msg: state.texturing ? 'Making new UVs and baking the texture…' : 'New UVs not made yet for this result.', busy: !!state.texturing };
  }
  const triEnd = i.symmetry ? r.triCount / 2 : r.triCount;
  if (r.uvLayout === 'new') {
    const baked = state.bakedMats && state.bakedMats[mi] ? loadedMap(state.bakedMats[mi], slot) : null;
    const a = i.atlas && (i.atlas.atlases || []).find(x => x.mat === mi);
    const charts = a ? `${fmt(a.charts)} charts · ${pctOf(a.coverage)} filled` : i.atlas ? `${fmt(i.atlas.charts)} charts` : '';
    return { key: `${base}|${objId(r)}|${slot}|${objId(baked)}`, texture: baked, mesh: r, triEnd, label: `new UVs · ${charts}${baked ? ` · baked ${size(baked)}` : src ? ' · not baked' : ''}` };
  }
  const fit = i.uvFit;
  return { key: `${base}|${objId(r)}|${slot}|${objId(src)}`, texture: src, mesh: r, triEnd, label: `original UVs${!fit ? '' : fit.misplaced < 0.0005 ? ' · fits' : ` · ${pctOf(fit.misplaced)} off`}` };
}

function setPaneContent(pane, c) {
  $(`uvLabel${pane.side}`).textContent = c.label ? ` ${c.label}` : '';
  const msg = $(`uvMsg${pane.side}`);
  msg.hidden = !c.msg;
  msg.textContent = c.msg || '';
  msg.classList.toggle('busy', !!c.busy);
  pane.shown = !!c.mesh;
  if (pane.key === c.key) return;
  const sameLayout = pane.key.split('|').slice(0, 3).join('|') === c.key.split('|').slice(0, 3).join('|');
  pane.key = c.key;
  if (pane.texture) pane.texture.dispose();
  pane.texture = null;
  const u = pane.quad.material.uniforms;
  if (c.texture) {
    const t = c.texture.clone();
    t.colorSpace = THREE.NoColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    t.updateMatrix();
    pane.texture = t;
    u.uvTransform.value.copy(t.matrix);
  }
  u.map.value = pane.texture;
  u.hasMap.value = !!pane.texture;
  pane.edges.geometry.dispose();
  pane.seams.geometry.dispose();
  pane.edges.geometry = new THREE.BufferGeometry();
  pane.seams.geometry = new THREE.BufferGeometry();
  if (c.mesh) {
    const { edges, seams, triArea } = layoutEdges(c.mesh, uvView.mat, c.triEnd);
    pane.triArea = triArea;
    const pos = new THREE.BufferAttribute(c.mesh.uvs, 2);
    pane.edges.geometry.setAttribute('position', pos);
    pane.edges.geometry.setIndex(new THREE.BufferAttribute(edges, 1));
    pane.seams.geometry.setAttribute('position', pos);
    pane.seams.geometry.setIndex(new THREE.BufferAttribute(seams, 1));
  }
  // A new result keeps the view where it was; a different model, material or map starts from the whole sheet.
  if (!sameLayout) pane.view = { zoom: 1, cx: 0.5, cy: 0.5 };
}

function uvThemeChanged() {
  if (!uvView.panes) return;
  // The checker is written straight to the canvas, so it takes the tokens' sRGB values as they are.
  const raw = name => new THREE.Color().setRGB(...new THREE.Color(cssVar(name)).getRGB(new THREE.Color(), THREE.SRGBColorSpace).toArray());
  for (const pane of Object.values(uvView.panes)) {
    const u = pane.quad.material.uniforms;
    u.checkA.value.copy(raw('--check-a'));
    u.checkB.value.copy(raw('--check-b'));
    u.outside.value.copy(raw('--viewport'));
    pane.scene.background = new THREE.Color(cssVar('--viewport'));
  }
  uvBorderMat.color.set(cssVar('--accent'));
  requestUVRender();
}

function ensureUVRenderer() {
  if (uvView.renderer) return true;
  try {
    uvView.renderer = new THREE.WebGLRenderer({ canvas: $('uvCanvas'), antialias: true });
  } catch (err) {
    console.error(err);
    showError("Couldn't start the texture view: this browser won't give it a WebGL context.");
    return false;
  }
  uvView.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  // Each pane draws in the order its objects were added; depth sorting would read the 2D UV positions as 3D.
  uvView.renderer.sortObjects = false;
  uvView.panes = { A: makeUVPane('A'), B: makeUVPane('B') };
  $('uvFoot').firstChild.textContent = uvHint();
  uvThemeChanged();
  new ResizeObserver(() => {
    const st = $('uvStage');
    uvView.renderer.setSize(st.clientWidth, st.clientHeight, false);
    layoutUV();
    requestUVRender();
  }).observe($('uvStage'));
  bindUVPanes();
  return true;
}

// Both panes side by side when the drawer is wide, stacked when it is tall; one pane fills it.
function layoutUV() {
  if (!uvView.panes) return;
  const st = $('uvStage'), W = st.clientWidth, H = st.clientHeight, sep = $('uvSep');
  const { A, B } = uvView.panes, mode = settings.uvPanes;
  A.rect = B.rect = null;
  sep.hidden = true;
  if (mode === 'A') A.rect = { x: 0, y: 0, w: W, h: H };
  else if (mode === 'B') B.rect = { x: 0, y: 0, w: W, h: H };
  else if (W >= H * 1.15) {
    const half = Math.floor(W / 2);
    A.rect = { x: 0, y: 0, w: half, h: H };
    B.rect = { x: half, y: 0, w: W - half, h: H };
    Object.assign(sep.style, { left: `${half}px`, top: '0px', width: '1px', height: `${H}px` });
    sep.hidden = false;
  } else {
    const half = Math.floor(H / 2);
    A.rect = { x: 0, y: 0, w: W, h: half };
    B.rect = { x: 0, y: half, w: W, h: H - half };
    Object.assign(sep.style, { left: '0px', top: `${half}px`, width: `${W}px`, height: '1px' });
    sep.hidden = false;
  }
  for (const pane of [A, B]) {
    pane.el.hidden = !pane.rect;
    if (pane.rect) Object.assign(pane.el.style, { left: `${pane.rect.x}px`, top: `${pane.rect.y}px`, width: `${pane.rect.w}px`, height: `${pane.rect.h}px` });
  }
}
// Pixels per UV unit: zoom 1 fits the 0–1 square with a margin, clear of the pane label.
function uvScale(pane) {
  const r = pane.rect;
  return Math.max(1, Math.min(r.w - 32, r.h - 76)) * pane.view.zoom;
}
function requestUVRender() {
  if (uvView.queued || !settings.uvOpen) return;
  uvView.queued = true;
  requestAnimationFrame(renderUV);
}
function renderUV() {
  uvView.queued = false;
  const R = uvView.renderer;
  if (!R || !settings.uvOpen) return;
  const H = $('uvStage').clientHeight;
  R.setScissorTest(true);
  for (const pane of Object.values(uvView.panes)) {
    const r = pane.rect;
    if (!r || r.w < 2 || r.h < 2) continue;
    const y = H - r.y - r.h, s = uvScale(pane), v = pane.view;
    R.setViewport(r.x, y, r.w, r.h);
    R.setScissor(r.x, y, r.w, r.h);
    uvCam.left = v.cx - r.w / 2 / s;
    uvCam.right = v.cx + r.w / 2 / s;
    uvCam.top = v.cy + (r.h / 2 - 22) / s;
    uvCam.bottom = v.cy - (r.h / 2 + 22) / s;
    uvCam.updateProjectionMatrix();
    pane.quad.material.uniforms.cell.value = 8 * R.getPixelRatio();
    // Triangle edges fade in as the triangles grow on screen: none below ~1.5 px², full from ~14 px².
    const px = pane.triArea * s * s, fade = Math.min(1, Math.max(0, (px - 1.5) / 12.5));
    pane.edges.material.uniforms.strength.value = 0.4 * fade * fade * (3 - 2 * fade);
    pane.edges.visible = pane.shown && settings.uvLines === 'all' && fade > 0;
    pane.seams.visible = pane.shown && settings.uvLines !== 'none';
    pane.border.visible = pane.shown;
    pane.quad.visible = pane.shown;
    R.render(pane.scene, uvCam);
  }
}
// The UV point under a pane pixel.
function uvAt(pane, x, y) {
  const s = uvScale(pane), r = pane.rect;
  return [pane.view.cx + (x - r.w / 2) / s, pane.view.cy - (y - r.h / 2 - 22) / s];
}
function zoomUV(pane, x, y, factor) {
  const [u, v] = uvAt(pane, x, y);
  pane.view.zoom = Math.min(128, Math.max(0.5, pane.view.zoom * factor));
  const s = uvScale(pane), r = pane.rect;
  pane.view.cx = u - (x - r.w / 2) / s;
  pane.view.cy = v + (y - r.h / 2 - 22) / s;
  requestUVRender();
}
function readUV(pane, x, y) {
  const [u, v] = uvAt(pane, x, y), t = pane.texture;
  let text = `u ${u.toFixed(4)}   v ${v.toFixed(4)}`;
  if (t && pane.shown) {
    const [w, h] = imageSize(t.image), st = new THREE.Vector3(u, v, 1).applyMatrix3(t.matrix);
    // Pixel rows count from the top of the image file (baked maps are saved with v = 1 at the top).
    const fy = t.flipY || t.userData.pbBaked ? 1 - st.y : st.y;
    if (st.x >= 0 && st.x <= 1 && fy >= 0 && fy <= 1) text += `   ·   pixel ${Math.min(w - 1, Math.floor(st.x * w))}, ${Math.min(h - 1, Math.floor(fy * h))} of ${w} × ${h}`;
  }
  $('uvFoot').firstChild.textContent = text;
}
function bindUVPanes() {
  const P = uvView.pointers;
  for (const pane of Object.values(uvView.panes)) {
    const node = pane.el, pos = e => { const b = node.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    node.addEventListener('wheel', e => {
      e.preventDefault();
      const [x, y] = pos(e);
      zoomUV(pane, x, y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
    }, { passive: false });
    node.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.button !== 1) return;
      try { node.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
      P.set(e.pointerId, pos(e));
      node.classList.add('drag');
    });
    node.addEventListener('pointermove', e => {
      const [x, y] = pos(e);
      if (!P.has(e.pointerId)) { readUV(pane, x, y); return; }
      const [px, py] = P.get(e.pointerId);
      if (P.size === 2) {
        // Two fingers: zoom by the change in their distance, around their midpoint.
        const [ox, oy] = [...P.entries()].find(([id]) => id !== e.pointerId)[1];
        const d0 = Math.hypot(px - ox, py - oy), d1 = Math.hypot(x - ox, y - oy);
        if (d0 > 0) zoomUV(pane, (x + ox) / 2, (y + oy) / 2, d1 / d0);
      } else {
        const s = uvScale(pane);
        pane.view.cx -= (x - px) / s;
        pane.view.cy += (y - py) / s;
        requestUVRender();
      }
      P.set(e.pointerId, [x, y]);
      readUV(pane, x, y);
    });
    const end = e => { P.delete(e.pointerId); if (!P.size) node.classList.remove('drag'); };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
    node.addEventListener('pointerleave', () => { if (!P.size) $('uvFoot').firstChild.textContent = uvHint(); });
    node.addEventListener('dblclick', () => { pane.view = { zoom: 1, cx: 0.5, cy: 0.5 }; requestUVRender(); });
  }
}

// Material and map pickers: every material, and the maps the chosen one has loaded.
function syncUVControls() {
  const mats = state.displayMats, n = mats.length;
  if (uvView.mat >= n) uvView.mat = 0;
  const matSel = $('uvMat');
  matSel.hidden = n < 2;
  const matNames = mats.map((m, i) => m.name || `Material ${i + 1}`);
  if (matSel.dataset.names !== matNames.join('\n')) {
    matSel.replaceChildren(...matNames.map((name, i) => el('option', { value: String(i), textContent: name })));
    matSel.dataset.names = matNames.join('\n');
  }
  matSel.value = String(uvView.mat);
  const slots = MAP_SLOTS.filter(slot => loadedMap(mats[uvView.mat], slot));
  if (!slots.includes(uvView.slot)) uvView.slot = slots.includes(settings.uvSlot) ? settings.uvSlot : slots[0] || 'map';
  const slotSel = $('uvSlot');
  const none = !state.welded ? 'No model' : !state.welded.uvs ? 'No UVs' : 'No texture · UVs only';
  const opts = slots.length ? slots.map(slot => [slot, `${SLOT_NAMES[slot][0].toUpperCase()}${SLOT_NAMES[slot].slice(1)}`]) : [['', none]];
  const optKey = opts.map(o => o.join(':')).join(',');
  if (slotSel.dataset.slots !== optKey) {
    slotSel.replaceChildren(...opts.map(([value, text]) => el('option', { value, textContent: text })));
    slotSel.dataset.slots = optKey;
  }
  slotSel.disabled = !slots.length;
  slotSel.value = slots.length ? uvView.slot : '';
  pressSeg('uvLinesSeg', 'lines', settings.uvLines);
  pressSeg('uvPanesSeg', 'panes', settings.uvPanes);
}

// Brings the open drawer up to date with the active tab; cheap when nothing it shows has changed.
function refreshUVView() {
  if (!settings.uvOpen || !uvView.panes) return;
  syncUVControls();
  for (const side of ['A', 'B']) setPaneContent(uvView.panes[side], uvPaneContent(side));
  layoutUV();
  requestUVRender();
}
function releaseUVPanes() {
  if (!uvView.panes) return;
  for (const pane of Object.values(uvView.panes)) {
    if (pane.texture) pane.texture.dispose();
    pane.texture = null;
    pane.quad.material.uniforms.map.value = null;
    pane.edges.geometry.dispose();
    pane.seams.geometry.dispose();
    pane.key = '';
  }
}
function setUVOpen(open) {
  settings.uvOpen = open;
  saveSettings();
  $('uvDrawer').hidden = !open;
  $('uvBtn').setAttribute('aria-expanded', String(open));
  if (open && ensureUVRenderer()) refreshUVView();
  if (!open) releaseUVPanes();
}
// Dragging stops where the view would get too narrow; a narrower window only caps the width (CSS), so the drawer
// comes back at its size when the window grows again.
function setUVWidth(w, dragging = false) {
  const max = dragging ? Math.max(300, $('stage').clientWidth - 260) : 2400;
  settings.uvWidth = Math.round(Math.min(max, Math.max(280, w)));
  $('uvDrawer').style.setProperty('--uvw', `${settings.uvWidth}px`);
}

// ---------- tab switching ----------
let loading = null, queuedDoc = null;
// Loading a model can't be interrupted, so a tab picked meanwhile is shown once it finishes.
function finishLoading() {
  loading = null;
  renderTabs();
  if (queuedDoc) { const next = queuedDoc; queuedDoc = null; activate(next); }
}
function renderTabs() {
  $('tabs').replaceChildren(...docs.map(d => {
    const close = el('button', { type: 'button', className: 'tab-close', textContent: '×', title: `Close ${d.title}` });
    close.setAttribute('aria-label', `Close ${d.title}`);
    close.dataset.close = d.id;
    const tab = el('div', { className: 'tab', tabIndex: 0, title: d.title }, el('span', { className: 'tab-title', textContent: d.title }), close);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(d === doc));
    tab.dataset.doc = d.id;
    tab.classList.toggle('busy', d === loading || d === queuedDoc);
    return tab;
  }));
}
function updateHeader() {
  const m = state.meta;
  $('modelName').textContent = !m ? doc.title : m.sample ? 'Sample pawn' : m.name;
  $('modelName').title = m && !m.sample ? m.name : '';
  $('modelKind').textContent = !m ? '' : m.sample ? 'built-in sample' : `${m.kind.toUpperCase()} · ${(m.size / 1048576).toFixed(1)} MB`;
  $('emptyBusyText').textContent = doc.saved ? `Reopening ${doc.saved.model} from your last visit…` : 'Loading the model…';
  document.title = m ? `${doc.title} · Poly Budget` : 'Poly Budget';
}
// Without a model the view shows the open card, and the settings that need a model are dimmed and inert.
function showEmptyState(on) {
  $('emptyState').hidden = !on;
  $('emptyBusy').hidden = !(loading === doc || doc.saved);
  $('emptyIdle').hidden = !$('emptyBusy').hidden;
  $('toolPal').hidden = on;
  $('toolOpts').hidden = on || settings.tool === 'orbit';
  for (const sec of document.querySelectorAll('[data-needs-model]')) sec.inert = on;
  $('stagebar').inert = on;
  requestRender();
}
// Near and far planes for the active model, as frameCamera sets them.
function clipForModel() {
  const dist = (state.diag / 2 / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.08;
  camera.near = dist / 200;
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
}
// Leaves the active tab: keeps its camera and settings, saves it, stops its background work and frees its view.
function detachDoc() {
  if (state.painting) { state.painting = false; endStroke(); }
  doc.settings = docSettings();
  if (state.welded) doc.camera = { position: camera.position.toArray(), target: controls.target.toArray() };
  if (docs.includes(doc)) saveSession();
  cancelTexture();
  if (reduceTimer) { clearTimeout(reduceTimer); reduceTimer = 0; doc.dirty = true; }
  if (reducePending) { reducePending = false; doc.dirty = true; }
  clearTimeout(mirrorTimer);
  mirrorSeq++;
  disposeDisplay(display.L, sceneL);
  disposeDisplay(display.R, sceneR);
  display.L = display.R = null;
  resetBakeSources();
  showRing(null);
}
// Shows the active tab: its view, panels and camera, and restarts any work it still needs.
function attachDoc() {
  updateHeader();
  renderTabs();
  syncControls();
  const panels = () => { updateModelPanel(); updateTexturePanel(); updateLegend(); updateTargetUI(); updateResultUI(); updateUVPanel(); updateHistoryButtons(); };
  if (!state.welded) {
    showEmptyState(true);
    updatePlaneHelper();
    panels();
    refreshUVView();
    return;
  }
  showEmptyState(false);
  setLeftSurface(state.left || originalSurface());
  if (state.result) buildReducedDisplay(state.result);
  if (doc.camera) {
    camera.position.fromArray(doc.camera.position);
    controls.target.fromArray(doc.camera.target);
    clipForModel();
    controls.update();
  } else {
    frameCamera();
  }
  updatePlaneHelper();
  updateTint();
  panels();
  flashHint();
  $('resErr').textContent = '…';
  if (state.result) setTimeout(() => measureDeviation(state.result), 30);
  if (state.result && state.result.uvLayout === 'pending' && state.geo) startTextureJob();
  if (doc.dirty || !state.result) { doc.dirty = false; scheduleReduce(0); }
  requestRender();
}
async function activate(next) {
  if (!next || next === doc) return;
  if (loading) { queuedDoc = next; renderTabs(); return; }
  detachDoc();
  doc = next;
  ({ state, symPlane, session } = next);
  Object.assign(settings, next.settings);
  saveSettings();
  attachDoc();
  if (next.saved && !next.session.model) await loadSavedDoc(next);
}
async function openTab(d) {
  docs.splice(docs.indexOf(doc) + 1, 0, d);
  await activate(d);
}
async function closeDoc(d) {
  if (!d || d === loading) return;
  if (docs.length === 1) docs.push(newDoc());
  const i = docs.indexOf(d);
  if (d === doc) await activate(docs[i + 1] || docs[i - 1]);
  if (d === doc) return;
  docs.splice(docs.indexOf(d), 1);
  engine.unload(d.id);
  disposeBakedMaterials(d.state);
  for (const m of d.state.displayMats) {
    for (const slot of MAP_SLOTS) if (m[slot]) m[slot].dispose();
    m.dispose();
  }
  d.state = null;
  forgetDoc(d.id);
  renderTabs();
}
async function loadSample() {
  if (loading) return;
  loading = doc;
  renderTabs();
  showEmptyState(true);
  try {
    await prepareModel(samplePawn(), { name: 'SamplePawn.fbx', size: 0, unitScale: 100, kind: 'sample', files: new Map(), blobToName: new Map(), missing: null, sample: true });
  } catch (err) {
    console.error(err);
    showError(`Couldn't build the sample: ${err.message || err}`);
  } finally {
    finishLoading();
  }
}

// ---------- controls ----------
function pressSeg(id, key, value) {
  for (const b of $(id).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset[key] === String(value)));
}
function syncControls() {
  pressSeg('viewSeg', 'view', settings.view);
  pressSeg('shadeSeg', 'shade', settings.shading);
  pressSeg('modeSeg', 'mode', settings.mode);
  pressSeg('strengthSeg', 'strength', settings.strength);
  pressSeg('normalsSeg', 'normals', settings.normals);
  pressSeg('regSeg', 'reg', settings.regularize);
  pressSeg('formatSeg', 'format', settings.format);
  for (const b of document.querySelectorAll('.tool')) b.setAttribute('aria-pressed', String(b.dataset.tool === settings.tool));
  const less = settings.tool === 'less';
  const labels = less ? ['½', '¼', '⅛'] : ['×2', '×4', '×8'];
  $('strengthSeg').querySelectorAll('button').forEach((b, i) => { b.textContent = labels[i]; });
  $('strengthSeg').hidden = !(settings.tool === 'more' || settings.tool === 'less');
  $('wireBtn').setAttribute('aria-pressed', String(settings.wire));
  const paint = settings.tool !== 'orbit';
  $('showPaintBtn').setAttribute('aria-pressed', String(settings.showPaint));
  $('showPaintBtn').title = settings.showPaint ? 'Hide paint' : 'Show paint';
  $('toolPal').hidden = !state.welded;
  $('toolOpts').hidden = !state.welded || !paint;
  const name = { more: 'More detail', less: 'Less detail', keep: 'Keep original', erase: 'Erase' }[settings.tool] || '';
  $('optName').textContent = name;
  $('optName').dataset.tool = settings.tool;
  $('optSize').hidden = settings.mode === 'fill';
  $('brushSize').value = String(settings.brush);
  $('brushOut').textContent = `${settings.brush}%`;
  $('maxErr').value = String(settings.maxError);
  $('optPos').checked = settings.optimizePositions;
  $('permissive').checked = settings.permissive;
  $('lockBorder').checked = settings.lockBorder;
  $('prune').checked = settings.prune;
  $('creaseAngle').value = String(settings.creaseAngle);
  $('creaseOut').textContent = `${settings.creaseAngle}°`;
  $('creaseField').hidden = settings.normals !== 'crease';
  $('normalsMeta').textContent = settings.normals === 'crease' ? `creased ${settings.creaseAngle}°` : settings.normals;
  $('normalWeight').value = String(settings.normalWeight);
  $('nwOut').textContent = settings.normalWeight.toFixed(2);
  $('uvWeight').value = String(settings.uvWeight);
  $('uvwOut').textContent = settings.uvWeight.toFixed(2);
  $('hardAngle').value = String(settings.hardAngle);
  $('hardOut').textContent = `${settings.hardAngle}°`;
  $('weldTol').value = String(settings.weldTol);
  const tol = weldTolerance();
  $('tolOut').textContent = `${(tol * 100).toPrecision(2)}% of size`;
  $('units').value = settings.units;
  pressSeg('uvModeSeg', 'uvmode', settings.uvMode);
  pressSeg('bakeSeg', 'bake', settings.bakeSize);
  $('keepUVOpts').hidden = settings.uvMode === 'new';
  syncSymmetryUI();
  applyTool();
}

function onSeg(id, key, apply) {
  $(id).addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !b.dataset[key]) return;
    apply(b.dataset[key]);
    syncControls();
    saveSettings();
  });
}
onSeg('viewSeg', 'view', v => { settings.view = v; requestRender(); });
onSeg('shadeSeg', 'shade', v => { settings.shading = v; applyDisplaySettings(); });
onSeg('modeSeg', 'mode', v => { settings.mode = v; });
onSeg('strengthSeg', 'strength', v => { settings.strength = Number(v); });
onSeg('normalsSeg', 'normals', v => { settings.normals = v; scheduleReduce(); });
onSeg('regSeg', 'reg', v => { settings.regularize = Number(v); scheduleReduce(); });
onSeg('formatSeg', 'format', v => { settings.format = v; updateExportPanel(); });
onSeg('uvModeSeg', 'uvmode', v => { settings.uvMode = v; updateUVPanel(); scheduleReduce(0); });
onSeg('quickSeg', 'pct', v => { settings.targetPct = Number(v); updateTargetUI(); scheduleReduce(); });
document.querySelectorAll('.tool').forEach(b => b.addEventListener('click', () => { settings.tool = b.dataset.tool; syncControls(); saveSettings(); }));

// Sliders show their value while they move and apply it once, when let go ('change'), so a drag regenerates once.
// A drag that ends where it started applies nothing, so the readout goes back to what is in use.
const pctFromSlider = v => Math.min(100, 0.1 * Math.pow(1000, Number(v) / 1000));
$('targetSlider').addEventListener('pointerdown', () => { budgetDragging = true; });
$('targetSlider').addEventListener('input', e => updateTargetUI(pctFromSlider(e.target.value)));
$('targetSlider').addEventListener('change', e => {
  budgetDragging = false;
  settings.targetPct = pctFromSlider(e.target.value);
  updateTargetUI();
  saveSettings();
  scheduleReduce(60);
});
for (const type of ['pointerup', 'pointercancel']) {
  $('targetSlider').addEventListener(type, () => setTimeout(() => { budgetDragging = false; updateTargetUI(); }, 0));
}
// A typed budget: a triangle count ("23078", "23,078"), a short count ("20k", "1.5m") or a share of the model ("5%").
function parseBudget(text, total) {
  const m = String(text).trim().toLowerCase().replace(/[\s,_]/g, '').match(/^(\d*\.?\d+)(k|m|%)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === '%' ? (n / 100) * total : n * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1);
}
$('targetNum').addEventListener('focus', e => {
  if (!state.welded) return;
  e.target.value = String(targetTris());
  sizeBudgetInput();
  e.target.select();
});
$('targetNum').addEventListener('input', sizeBudgetInput);
$('targetNum').addEventListener('keydown', e => {
  if (e.key === 'Enter') e.target.blur();
  else if (e.key === 'Escape') { e.target.value = String(targetTris()); e.target.blur(); }
});
$('targetNum').addEventListener('change', e => {
  const T = state.welded ? state.welded.triCount : 0, v = parseBudget(e.target.value, T);
  if (T && v !== null) {
    const pct = Math.max(0.01, (100 * Math.max(4, Math.min(T, Math.round(v)))) / T);
    if (pct !== settings.targetPct) { settings.targetPct = pct; saveSettings(); scheduleReduce(0); }
  }
  updateTargetUI();
});
$('targetNum').addEventListener('blur', () => updateTargetUI());
const bindCheck = (id, key, after) => $(id).addEventListener('change', e => { settings[key] = e.target.checked; syncControls(); saveSettings(); after(); });
const bindRange = (id, key, apply) => {
  const input = $(id);
  input.addEventListener('input', () => { settings[key] = Number(input.value); syncControls(); });
  input.addEventListener('change', () => { settings[key] = Number(input.value); syncControls(); saveSettings(); apply(); });
};
let weldTimer = 0;
const reweld = () => { clearTimeout(weldTimer); weldTimer = setTimeout(() => rebuildWeld(false), 60); };
$('wireBtn').addEventListener('click', () => { settings.wire = !settings.wire; syncControls(); saveSettings(); applyDisplaySettings(); });
$('showPaintBtn').addEventListener('click', () => { settings.showPaint = !settings.showPaint; syncControls(); saveSettings(); applyDisplaySettings(); });
bindCheck('optPos', 'optimizePositions', () => scheduleReduce());
bindCheck('permissive', 'permissive', () => scheduleReduce());
bindCheck('lockBorder', 'lockBorder', () => scheduleReduce());
bindCheck('prune', 'prune', () => scheduleReduce());
bindCheck('tintMirror', 'tintMirror', applyDisplaySettings);
bindCheck('showPlane', 'showPlane', updatePlaneHelper);
$('symOn').addEventListener('change', async e => {
  settings.symmetry = e.target.checked;
  saveSettings();
  if (settings.symmetry && !symPlane.ready && state.orig.bvh) {
    setStatus('Finding the mirror plane…');
    await nextFrame();
    detectPlane();
    setStatus('');
  }
  syncControls();
  updatePlaneHelper();
  updateTint();
  updateModelPanel();
  scheduleMirrorView(0);
  scheduleReduce(0);
});
onSeg('symAxisSeg', 'axis', v => {
  if (!state.orig.bvh) return;
  detectPlane(Number(v));
  updateModelPanel();
  scheduleReduce(0);
});
onSeg('symSideSeg', 'side', v => { settings.symSide = v; updateTint(); scheduleMirrorView(0); scheduleReduce(0); });
$('symDetect').addEventListener('click', async () => {
  if (!state.orig.bvh) return;
  setStatus('Finding the mirror plane…');
  await nextFrame();
  detectPlane();
  setStatus(`Mirror plane: ${AXES[symPlane.axis]} = ${+symPlane.offset.toPrecision(4)}`, 'info', 3000);
  updateModelPanel();
  scheduleReduce(0);
});
// The plane position a slider value stands for (0-1000 across the model), snapping to 0 near the middle of a centred model.
function sliderOffset(value) {
  const b = boundsOf(state.welded.positions), a = symPlane.axis;
  const off = b.min[a] + ((b.max[a] - b.min[a]) * Number(value)) / 1000;
  return b.min[a] < 0 && b.max[a] > 0 && Math.abs(off) < (b.max[a] - b.min[a]) * 0.005 ? 0 : off;
}
// While the plane slider moves only the plane and its number follow; the fit, the mirrored preview and the reduction
// are worked out when it is let go.
function previewPlane(offset) {
  updatePlaneHelper(offset);
  if (document.activeElement !== $('symOffNum')) $('symOffNum').value = String(+offset.toPrecision(6));
}
$('symOffset').addEventListener('input', e => { if (state.welded) previewPlane(sliderOffset(e.target.value)); });
$('symOffset').addEventListener('change', e => { if (state.welded) setPlaneOffset(sliderOffset(e.target.value)); });
for (const type of ['pointerup', 'pointercancel']) {
  $('symOffset').addEventListener(type, () => setTimeout(() => { if (state.welded && symPlane.ready) { syncSymmetryUI(); updatePlaneHelper(); } }, 0));
}
$('symOffNum').addEventListener('change', e => {
  const v = Number(e.target.value);
  if (Number.isFinite(v)) setPlaneOffset(v);
});
bindRange('brushSize', 'brush', () => {});
bindRange('creaseAngle', 'creaseAngle', () => scheduleReduce(60));
bindRange('normalWeight', 'normalWeight', () => scheduleReduce(60));
bindRange('uvWeight', 'uvWeight', () => scheduleReduce(60));
bindRange('hardAngle', 'hardAngle', reweld);
bindRange('weldTol', 'weldTol', reweld);
$('maxErr').addEventListener('change', e => { settings.maxError = Number(e.target.value); saveSettings(); scheduleReduce(0); });
$('units').addEventListener('change', e => { settings.units = e.target.value; saveSettings(); updateExportPanel(); });
onSeg('bakeSeg', 'bake', v => { if (settings.bakeSize === Number(v)) return; settings.bakeSize = Number(v); startTextureJob(); });
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
$('undoBtn').title = `Undo (${UNDO_KEY})`;
$('redoBtn').title = `Redo (${IS_MAC ? '⇧⌘Z' : 'Ctrl+Y'})`;
$('clearBtn').addEventListener('click', clearPaint);
$('tabs').addEventListener('click', e => {
  const close = e.target.closest('[data-close]');
  if (close) { closeDoc(docs.find(d => d.id === close.dataset.close)); return; }
  const tab = e.target.closest('[data-doc]');
  if (tab) activate(docs.find(d => d.id === tab.dataset.doc));
});
$('tabs').addEventListener('auxclick', e => {
  const tab = e.target.closest('[data-doc]');
  if (tab && e.button === 1) closeDoc(docs.find(d => d.id === tab.dataset.doc));
});
$('tabs').addEventListener('keydown', e => {
  const tab = e.target.closest('[data-doc]');
  if (tab && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); activate(docs.find(d => d.id === tab.dataset.doc)); }
});
$('tabNew').addEventListener('click', () => openTab(newDoc()));
$('sampleBtn').addEventListener('click', loadSample);
$('frameBtn').addEventListener('click', frameCamera);
$('uvBtn').addEventListener('click', () => setUVOpen(!settings.uvOpen));
$('uvViewLink').addEventListener('click', () => setUVOpen(true));
$('uvClose').addEventListener('click', () => { setUVOpen(false); $('uvBtn').focus(); });
$('uvMat').addEventListener('change', e => { uvView.mat = Number(e.target.value); refreshUVView(); });
$('uvSlot').addEventListener('change', e => { if (!e.target.value) return; uvView.slot = settings.uvSlot = e.target.value; saveSettings(); refreshUVView(); });
onSeg('uvLinesSeg', 'lines', v => { settings.uvLines = v; pressSeg('uvLinesSeg', 'lines', v); requestUVRender(); });
onSeg('uvPanesSeg', 'panes', v => { settings.uvPanes = v; pressSeg('uvPanesSeg', 'panes', v); layoutUV(); requestUVRender(); });
{
  // Dragging the drawer's left edge resizes it; so do the arrow keys when the edge has focus.
  const grip = $('uvGrip');
  let drag = null;
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
    drag = { x: e.clientX, w: $('uvDrawer').offsetWidth };
    grip.classList.add('drag');
  });
  grip.addEventListener('pointermove', e => { if (drag) setUVWidth(drag.w - (e.clientX - drag.x), true); });
  const end = () => { if (!drag) return; drag = null; grip.classList.remove('drag'); saveSettings(); };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', () => { setUVWidth(DEFAULTS.uvWidth); saveSettings(); });
  grip.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setUVWidth($('uvDrawer').offsetWidth + (e.key === 'ArrowLeft' ? 24 : -24), true);
    saveSettings();
  });
}
$('exportBtn').addEventListener('click', exportModel);
$('fileInput').addEventListener('change', e => { openFiles(e.target.files); e.target.value = ''; });
$('addTexBtn').addEventListener('click', () => {
  if (!state.collected) return;
  $('texInput').click();
});
$('texInput').addEventListener('change', e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) addTextures(files).catch(err => { console.error(err); showError(`Couldn't add the texture: ${err.message || err}`); });
});
$('texList').addEventListener('click', e => {
  const b = e.target.closest('button[data-mat]');
  if (!b) return;
  textureTarget = { mat: Number(b.dataset.mat), slot: b.dataset.slot || 'map' };
  $('texOneInput').click();
});
$('texOneInput').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file && textureTarget) setMaterialTexture(textureTarget.mat, file, textureTarget.slot).catch(err => { console.error(err); showError(`Couldn't use ${file.name}: ${err.message || err}`); });
});
// The export panel is a popover under its button; without the Popover API it is a plain panel with the same dismissal.
{
  const pop = $('exportPop'), btn = $('exportOpen');
  if (typeof pop.showPopover === 'function') {
    pop.addEventListener('beforetoggle', e => exportToggled(e.newState === 'open'));
  } else {
    btn.addEventListener('click', () => { pop.classList.toggle('open'); exportToggled(pop.classList.contains('open')); });
    document.addEventListener('pointerdown', e => { if (exportIsOpen && !pop.contains(e.target) && !btn.contains(e.target)) { pop.classList.remove('open'); exportToggled(false); } });
    document.addEventListener('keydown', e => { if (exportIsOpen && e.key === 'Escape') { pop.classList.remove('open'); exportToggled(false); btn.focus(); } });
  }
  window.addEventListener('resize', () => { if (exportIsOpen) placeExport(); });
}
// Foldable sidebar sections remember whether they were open.
for (const d of document.querySelectorAll('details[data-sec]')) {
  d.open = !!(settings.sections && settings.sections[d.dataset.sec]);
  d.addEventListener('toggle', () => { settings.sections = { ...settings.sections, [d.dataset.sec]: d.open }; saveSettings(); });
}

let dragDepth = 0;
window.addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; $('drop').hidden = false; } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop').hidden = true; });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  if (e.dataTransfer && e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
});

window.addEventListener('keydown', e => {
  if (e.target.closest && e.target.closest('input, select, textarea, .pop')) return;
  const k = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if ((e.metaKey || e.ctrlKey) && k === 'y') { e.preventDefault(); redo(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tools = { o: 'orbit', m: 'more', l: 'less', k: 'keep', e: 'erase' };
  if (tools[k]) settings.tool = tools[k];
  else if (k === 'f') settings.mode = settings.mode === 'fill' ? 'brush' : 'fill';
  else if (k === 'w') { settings.wire = !settings.wire; applyDisplaySettings(); }
  else if (k === 'u') { setUVOpen(!settings.uvOpen); return; }
  else if (k === '1' || k === '2' || k === '3') { settings.view = ['split', 'original', 'reduced'][Number(k) - 1]; requestRender(); }
  else if (k === '[' || k === ']') settings.brush = Math.min(30, Math.max(0.5, settings.brush * (k === ']' ? 1.2 : 1 / 1.2)));
  else return;
  settings.brush = Math.round(settings.brush * 2) / 2;
  syncControls();
  saveSettings();
});

window.__polyBudget = {
  openFiles, setMaterialTexture, settings, exportModel, buildExport, engine, pick, camera, controls, requestRender, rects, viewport, undo, redo,
  docs, activate, openTab, closeDoc, newDoc, uvView, renderUV, setUVOpen,
  get state() { return state; }, get doc() { return doc; },
};

// ---------- boot ----------
applyTheme();
syncControls();
engine.start();
renderer.setSize(viewport.clientWidth, viewport.clientHeight, false);
renderTabs();
updateHeader();
setUVWidth(settings.uvWidth);
setUVOpen(settings.uvOpen);
// The last visit's tabs when there are any, otherwise the sample.
restoreTabs()
  .catch(err => { console.error(err); return false; })
  .then(restored => restored || state.welded || loadSample());
