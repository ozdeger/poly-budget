// The app's work between opening a model and exporting it, without the page: welding, hidden areas, paint, the mirror
// plane, the reduction or remesh, new UVs, and the files its Export writes, with a report of what came out. The command
// line (cli/poly-budget.mjs) runs it, and a Node pipeline can import it:
//   import { run } from './cli/pipeline.mjs';
//   const { report, files } = await run('model.fbx', { topology: 'quads', budget: '10k' });
// Options take the app's settings names and defaults (DEFAULTS). What the page does on the GPU is left out: textures
// aren't baked onto new UVs, and no normal map is made from the original.
import fs from 'fs';
import path from 'path';
import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import * as core from '../src/core.js';
import { collectScene } from '../src/collect.js';
import { computeVisibility } from '../src/visibility.js';
import { formDensity } from '../src/quad.js';
import { openModel, MAP_SLOTS } from './load.mjs';
import { surfaceTree, mirrorPlane, mirrorFit, deviation, edgeCounts } from './measure.mjs';
import { uvLayoutPng } from './png.mjs';

const FBX_TEMPLATE = JSON.parse(fs.readFileSync(new URL('../src/fbx_template.json', import.meta.url), 'utf8'));
const { LABEL } = core;

// The app's defaults (src/app.js DEFAULTS), for the settings that shape the result. budget: as typed into the app, in
// the output's unit (quads or triangles), or 'auto' (Quads only; see pickBudget). mirror: null (off), 'auto', an axis
// ('x', 'y', 'z') to find the plane along, or a plane ('x=0.25', { axis: 'x', offset: 0.25 }). mergeDistance: the
// app's merge distance, as a share of the model's size (its slider at 25 is 1e-6).
export const DEFAULTS = {
  topology: 'quads', budget: '10%',
  quadAdapt: 0.75, quadSharp: true, quadThin: true, prune: false,
  maxError: 0, optimizePositions: true, regularize: 1, normalWeight: 0.5, lockBorder: false, permissive: false, uvWeight: 1,
  hidden: true, hiddenLevel: 'medium', hiddenCull: false,
  mirror: null, symSide: '+', paint: [],
  normals: 'original', creaseAngle: 60, hardAngle: 30, mergeDistance: 1e-6,
  uvMode: 'auto', uvStyle: 'compact', bakeSize: 1024,
  format: 'fbx', units: 'auto', name: null, zip: false, measure: true, textures: [],
};

// A mistake in the options, as opposed to a model that can't be processed.
export class UsageError extends Error {}
const usage = msg => new UsageError(msg);

const oneOf = (key, v, list) => { if (!list.includes(v)) throw usage(`${key} takes ${list.map(x => `"${x}"`).join(', ')}: not ${JSON.stringify(v)}`); return v; };
const inRange = (key, v, lo, hi) => { const n = Number(v); if (v === '' || v === null || !Number.isFinite(n) || n < lo || n > hi) throw usage(`${key} takes a number from ${lo} to ${hi}: not ${JSON.stringify(v)}`); return n; };
const flag = (key, v) => { if (typeof v !== 'boolean') throw usage(`${key} takes true or false: not ${JSON.stringify(v)}`); return v; };

// The options with the defaults filled in and checked.
export function settingsOf(opt = {}) {
  const o = { ...DEFAULTS };
  for (const [k, v] of Object.entries(opt)) {
    if (!(k in DEFAULTS)) throw usage(`there is no option "${k}"`);
    if (v !== undefined) o[k] = v;
  }
  oneOf('topology', o.topology, ['quads', 'tris']);
  o.quadAdapt = inRange('quadAdapt', o.quadAdapt, 0, 1);
  o.maxError = inRange('maxError', o.maxError, 0, 1);
  o.regularize = oneOf('regularize', Number(o.regularize), [0, 1, 2]);
  o.normalWeight = inRange('normalWeight', o.normalWeight, 0, 2);
  o.uvWeight = inRange('uvWeight', o.uvWeight, 0, 3);
  o.creaseAngle = inRange('creaseAngle', o.creaseAngle, 10, 90);
  o.hardAngle = inRange('hardAngle', o.hardAngle, 0, 90);
  o.mergeDistance = inRange('mergeDistance', o.mergeDistance, 0, 0.1);
  for (const k of ['quadSharp', 'quadThin', 'prune', 'optimizePositions', 'lockBorder', 'permissive', 'hidden', 'hiddenCull', 'zip', 'measure']) flag(k, o[k]);
  oneOf('hiddenLevel', o.hiddenLevel, ['gentle', 'medium', 'strong']);
  oneOf('symSide', o.symSide, ['+', '-']);
  oneOf('normals', o.normals, ['original', 'smooth', 'crease']);
  oneOf('uvMode', o.uvMode, ['auto', 'keep', 'new']);
  oneOf('uvStyle', o.uvStyle, ['compact', 'paint']);
  o.bakeSize = oneOf('bakeSize', Number(o.bakeSize), [512, 1024, 2048]);
  oneOf('format', o.format, ['fbx', 'obj', 'glb']);
  oneOf('units', o.units, ['auto', 'm', 'cm']);
  if (o.budget !== 'auto' && parseBudget(o.budget, 1e6) === null) throw usage(`budget takes a count (12500), a short count (12.5k), a share of the original triangles (5%) or auto: not ${JSON.stringify(o.budget)}`);
  if (o.budget === 'auto' && o.topology !== 'quads') throw usage('an auto budget needs Quads: it comes from the budget zones, which only a remesh measures');
  o.mirror = mirrorSpec(o.mirror);
  o.paint = paintRules(o.paint);
  if (!Array.isArray(o.textures)) throw usage('textures takes a list of files');
  return o;
}

// A typed budget as the app reads it (parseBudget in src/app.js): a count ("23078", "23,078"), a short count ("20k",
// "1.5m") or a share of the model's triangles ("5%"). A count is in units of unit triangles (2 in Quads mode).
export function parseBudget(text, total, unit = 1) {
  const m = String(text).trim().toLowerCase().replace(/[\s,_]/g, '').match(/^(\d*\.?\d+)(k|m|%)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === '%' ? (n / 100) * total : n * unit * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1);
}

const AXIS = { x: 0, y: 1, z: 2 };
function mirrorSpec(v) {
  if (v === null || v === undefined || v === false || v === 'off') return null;
  if (typeof v === 'object') {
    const auto = v.axis === null || v.axis === undefined || v.axis === 'auto';
    const axis = auto ? null : typeof v.axis === 'number' ? v.axis : AXIS[String(v.axis).toLowerCase()];
    if (!auto && ![0, 1, 2].includes(axis)) throw usage(`mirror axis takes x, y or z: not ${JSON.stringify(v.axis)}`);
    if (auto && v.offset !== undefined && v.offset !== null) throw usage('a mirror plane with an offset needs its axis');
    if (v.offset !== undefined && v.offset !== null && !Number.isFinite(Number(v.offset))) throw usage(`mirror offset takes a number: not ${JSON.stringify(v.offset)}`);
    return { axis, offset: v.offset === undefined || v.offset === null ? null : Number(v.offset) };
  }
  const m = String(v).trim().toLowerCase().match(/^(auto|x|y|z)(?:\s*=\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?))?$/);
  if (!m || (m[1] === 'auto' && m[2] !== undefined)) throw usage(`mirror takes auto, x, y or z, or a plane such as x=0.25: not ${JSON.stringify(v)}`);
  return { axis: m[1] === 'auto' ? null : AXIS[m[1]], offset: m[2] === undefined ? null : Number(m[2]) };
}

// Paint rules, as the app's brush and fill paint: each gives the vertices it selects More detail (2, 4 or 8 times as
// many faces per area), Less (½, ¼ or ⅛), Keep original, Normal detail (out of the hidden-area levels) or no paint; later
// rules paint over earlier ones. It selects by part (mesh names in the file), material, a box [x0, y0, z0, x1, y1, z1]
// or a sphere [x, y, z, radius]; a vertex must match every selector the rule gives. Boxes and spheres are in the
// model's units, or with relative: true in shares of its bounds (0 to 1 along each axis; a sphere's radius as a share
// of the diagonal). part and material take a name or a list of names (any case), or "/pattern/flags".
const DETAILS = ['more', 'less', 'keep', 'normal', 'erase'], SELECTORS = ['part', 'material', 'box', 'sphere'];
function paintRules(rules) {
  if (rules === null || rules === undefined) return [];
  if (!Array.isArray(rules)) throw usage('paint takes a list of rules, such as [{"more": 4, "part": "Head"}]');
  return rules.map((r, i) => {
    const at = `paint rule ${i + 1}`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw usage(`${at} is not an object`);
    for (const k of Object.keys(r)) if (![...DETAILS, ...SELECTORS, 'relative'].includes(k)) throw usage(`${at}: there is no "${k}" (a rule takes one of ${DETAILS.join(', ')}, and ${SELECTORS.join(', ')} or relative)`);
    const kinds = DETAILS.filter(k => k in r);
    if (kinds.length !== 1) throw usage(`${at} needs exactly one of ${DETAILS.join(', ')}`);
    const kind = kinds[0];
    let label;
    if (kind === 'more' || kind === 'less') {
      const f = Number(r[kind]), level = { 2: 1, 4: 2, 8: 3 }[f];
      if (!level) throw usage(`${at}: ${kind} takes 2, 4 or 8 (×2, ×4 or ×8 in the app): not ${JSON.stringify(r[kind])}`);
      label = kind === 'more' ? level : -level;
    } else label = kind === 'keep' ? LABEL.KEEP : kind === 'normal' ? LABEL.PLAIN : LABEL.NONE;
    if (!SELECTORS.some(k => k in r)) throw usage(`${at} selects nothing: give a part, material, box or sphere`);
    const names = k => {
      if (!(k in r)) return null;
      const list = Array.isArray(r[k]) ? r[k] : [r[k]];
      return list.map(s => {
        const m = String(s).match(/^\/(.*)\/([a-z]*)$/s);
        if (m) { try { return new RegExp(m[1], m[2]); } catch (e) { throw usage(`${at}: ${k} ${s} is not a pattern: ${e.message}`); } }
        return String(s).toLowerCase();
      });
    };
    const nums = (k, n) => {
      if (!(k in r)) return null;
      const v = r[k];
      if (!Array.isArray(v) || v.length !== n || !v.every(x => Number.isFinite(Number(x)))) throw usage(`${at}: ${k} takes ${n} numbers`);
      return v.map(Number);
    };
    const sphere = nums('sphere', 4);
    if (sphere && !(sphere[3] > 0)) throw usage(`${at}: a sphere's radius must be above 0`);
    return { label, kind, parts: names('part'), materials: names('material'), box: nums('box', 6), sphere, relative: !!r.relative, source: r };
  });
}

// Per welded vertex, the label the rules paint, and how many vertices each rule reached. Under mirror symmetry a box or
// sphere also paints where its mirror image falls, as the app's brush paints both halves.
function paintLabels(rules, w, collected, plane) {
  const V = w.vertexCount, P = w.positions, labels = new Int8Array(V), reached = [];
  if (!rules.length) return { labels, reached };
  const b = core.bounds(P);
  const nameMatch = (list, raw) => {
    if (!list) return null;
    const s = String(raw || ''), low = s.toLowerCase(), clean = low.replace(/[^\w.-]+/g, '_');
    return list.some(x => (x instanceof RegExp ? x.test(s) : x === low || x.replace(/[^\w.-]+/g, '_') === clean));
  };
  for (const r of rules) {
    const parts = r.parts ? collected.parts.map(p => nameMatch(r.parts, p.name)) : null;
    const mats = r.materials ? collected.materials.map(m => nameMatch(r.materials, m && m.name)) : null;
    const at = (f, k) => (r.relative ? b.min[k] + f * b.size[k] : f);
    const box = r.box ? [0, 1, 2].map(k => [Math.min(at(r.box[k], k), at(r.box[k + 3], k)), Math.max(at(r.box[k], k), at(r.box[k + 3], k))]) : null;
    const sph = r.sphere ? { c: [0, 1, 2].map(k => at(r.sphere[k], k)), r: r.relative ? r.sphere[3] * b.diag : r.sphere[3] } : null;
    const inside = (x, y, z) => {
      const q = [x, y, z];
      if (box && !q.every((v, k) => v >= box[k][0] && v <= box[k][1])) return false;
      if (sph && (x - sph.c[0]) ** 2 + (y - sph.c[1]) ** 2 + (z - sph.c[2]) ** 2 > sph.r * sph.r) return false;
      return true;
    };
    let n = 0;
    for (let v = 0; v < V; v++) {
      if (parts && !parts[w.vPart[v]]) continue;
      if (mats && !mats[w.vMat[v]]) continue;
      if (box || sph) {
        const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
        let hit = inside(x, y, z);
        if (!hit && plane) { const q = [x, y, z]; q[plane.axis] = 2 * plane.offset - q[plane.axis]; hit = inside(q[0], q[1], q[2]); }
        if (!hit) continue;
      }
      labels[v] = r.label;
      n++;
    }
    reached.push(n);
  }
  return { labels, reached };
}

// Result triangles by what set their density (resultRegions in src/app.js).
function resultRegions(res, paint, auto) {
  const out = { keep: 0, more: 0, less: 0, hidden: 0, rest: 0 }, idx = res.index, src = res.srcId;
  const kind = id => { const m = paint[id]; return m === LABEL.KEEP ? 'keep' : m > 0 ? 'more' : m < 0 ? 'less' : auto[id] ? 'hidden' : 'rest'; };
  for (let t = 0; t < idx.length; t += 3) {
    const a = kind(src[idx[t]]), b = kind(src[idx[t + 1]]), c = kind(src[idx[t + 2]]);
    out[a === b || a === c ? a : b === c ? b : a]++;
  }
  return out;
}

// The budget --budget auto picks: the middle of the green zone as the app's slider shows it (its scale is logarithmic,
// so the geometric mean of where red ends and gray starts), in quads, and never more than the model has.
export function pickBudget(zones, triangles) {
  const max = triangles / 2, red = Math.min(zones.red, max), gray = Math.min(Math.max(zones.gray, red), max);
  return Math.max(8, Math.round(Math.sqrt(red * gray)));
}

const shortCount = n => (n >= 1e6 ? `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`);
const fmt = n => new Intl.NumberFormat('en-US').format(Math.round(n));
// The line under the app's Quads slider (updateZones in src/app.js).
function zonesNote(z, triangles) {
  const max = triangles / 2, thin = z.redBy === 'thin';
  const need = Number.isFinite(z.red) ? `: ${thin ? 'they' : 'it'} need${thin ? '' : 's'} about ${shortCount(z.red)} quads.` : '.';
  if (z.red >= max) return thin ? `Thin parts such as spokes, strands or cables stay under half a quad thick at any budget here${need}` : `No budget here holds the shape well${need}`;
  return `Holds the shape from about ${shortCount(z.red)} quads${thin ? ', where thin parts stop coming apart' : ''}; ${z.gray >= max ? 'up to the most there can be here, more quads still show.' : `past ${shortCount(z.gray) === shortCount(z.red) ? 'that' : shortCount(z.gray)}, more quads change little you can see.`}`;
}

// Whether a result is on budget, and why not (updateResultUI in src/app.js).
function budgetCheck(info, target, o, w, res) {
  const quads = info.quads || 0, slack = quads ? 0.04 : 0.02, over = info.tris > target * (1 + slack), limited = o.maxError > 0;
  let status = 'on budget', why = '';
  if (quads) {
    if (over || info.tris < target * (1 - slack)) {
      status = over ? 'over budget' : 'under budget';
      why = `Remeshing lands near the budget, not on it: ${fmt(info.tris)} of ${fmt(target)} triangles.`;
      if (!over && info.remesh && info.remesh.short) why = `Parts thinner than a face (strands, wires) can't take the rest: ${fmt(info.tris)} of ${fmt(target)} triangles.`;
    }
  } else if (!over) {
    if (info.tris < target * 0.98 && limited) { status = 'under budget'; why = 'It stopped at the error limit before using the whole budget.'; }
  } else {
    status = 'over budget';
    if (info.cat.keep > target * 0.5) why = `Keep-original areas alone use ${fmt(info.cat.keep)} triangles. Paint less Keep, or raise the budget.`;
    else if (limited) why = 'It stopped at the error limit before reaching the budget.';
    else if (w.stats.keptUVs && w.uvIslands > 100 && !o.permissive && res.uvLayout === 'original') why = `UV seams stop it at ${fmt(info.tris)} triangles: new UVs (or Auto) reach the budget.`;
    else if (o.mergeDistance > 1e-5) why = 'A large merge distance joins nearby surfaces, and the joins block the reduction.';
    else why = "Locked or protected areas can't collapse any further.";
  }
  return { status, why };
}

const sanitize = name => String(name || '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'Model';
const MAP_FILE = { map: 'basecolor', normalMap: 'normal', roughnessMap: 'roughness', metalnessMap: 'metallic', aoMap: 'occlusion', emissiveMap: 'emissive', specularMap: 'specular', bumpMap: 'height', alphaMap: 'alpha' };
const SLOT_NAMES = { map: 'base colour', normalMap: 'normal', roughnessMap: 'roughness', metalnessMap: 'metalness', aoMap: 'occlusion', emissiveMap: 'emissive', specularMap: 'specular', bumpMap: 'bump', alphaMap: 'alpha' };
const countQuads = res => { let n = 0; if (res && res.quad) for (let t = 0; t < res.quad.length; t++) if (res.quad[t] === 1) n++; return n; };
const RESULT_VIS_RAYS = 300000;

// The materials as the app shows and exports them (prepareModel, materialNames in src/app.js).
function displayMaterials(collected) {
  const mats = collected.materials.map(m => {
    const mat = m && m.isMaterial ? m : new THREE.MeshStandardMaterial({ color: 0xc8c2b8 });
    mat.flatShading = false;
    if (collected.colors) mat.vertexColors = true;
    return mat;
  });
  return mats.length ? mats : [new THREE.MeshStandardMaterial({ color: 0xc8c2b8 })];
}
function materialNames(mats) {
  const used = new Set();
  return mats.map((m, i) => {
    let name = sanitize(m && m.name ? m.name : `Material${i + 1}`);
    while (used.has(name)) name += '_';
    used.add(name);
    return name;
  });
}

// What the exporters write per material (materialInfos in src/app.js). With the original UVs kept, the textures are the
// original files, copied; an embedded image is written out under the material's name. New UVs would get baked maps,
// which need the page, so they go without.
function materialInfos(mats, names, res) {
  return mats.map((m, i) => {
    const rgb = m.color ? m.color.getRGB(new THREE.Color(), THREE.SRGBColorSpace) : { r: 0.8, g: 0.8, b: 0.8 };
    let texture = null, bytes = null, normal = null;
    const extra = [];
    if (res.uvLayout !== 'new') {
      for (const slot of MAP_SLOTS) {
        const src = m[slot] && m[slot].userData && m[slot].userData.pbSource;
        if (!src) continue;
        const file = src.file ? src.name : `${names[i]}_${MAP_FILE[slot]}.${src.ext}`;
        const data = src.file ? new Uint8Array(fs.readFileSync(src.file)) : new Uint8Array(src.bytes);
        if (slot === 'map') { texture = file; bytes = data; } else if (!extra.some(x => x.file === file)) extra.push({ file, bytes: data, slot });
        if (slot === 'normalMap') normal = file;
      }
    }
    return { name: names[i], color: [rgb.r, rgb.g, rgb.b], texture, bytes, normal, extra, source: m };
  });
}

// GLB through the three.js exporter, as glbBytes in src/app.js; the materials go without their maps, which aren't
// decoded here.
async function glbBytes(objects, scale) {
  const scene = new THREE.Scene();
  for (const o of objects) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(o.positions, v => v * scale), 3));
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
        for (const slot of MAP_SLOTS) if (slot in mat) mat[slot] = null;
        return mat;
      }
      return new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(...mi.color, THREE.SRGBColorSpace) });
    });
    const mesh = new THREE.Mesh(g, mats.length > 1 ? mats : mats[0] || new THREE.MeshStandardMaterial());
    mesh.name = o.name;
    scene.add(mesh);
  }
  // The exporter turns the Phong and Lambert materials that FBX and OBJ files open with into glTF's own, as in the
  // app, with a console warning per material that would only clutter the command's output.
  const warn = console.warn;
  console.warn = (...a) => { if (!/^GLTFExporter: Use MeshStandardMaterial/.test(String(a[0]))) warn(...a); };
  try { return new Uint8Array(await new GLTFExporter().parseAsync(scene, { binary: true })); } finally { console.warn = warn; }
}

const round = (x, d = 3) => (Number.isFinite(x) ? Number(x.toFixed(d)) : x);
const r3 = v => [round(v[0], 6), round(v[1], 6), round(v[2], 6)];

// The model as opened and welded: what the report's input section says about it.
function describe(file, model, collected, w, mats, names) {
  const b = core.bounds(w.positions);
  const byMat = new Map();
  for (const t of model.textures) {
    if (!byMat.has(t.material)) byMat.set(t.material, {});
    byMat.get(t.material)[t.slot] = t.embedded ? '(embedded)' : path.basename(t.file);
  }
  return {
    file: path.resolve(file), format: model.meta.kind, bytes: model.meta.size,
    triangles: w.triCount, vertices: w.vertexCount, uvs: !!w.uvs, uvIslands: w.uvs ? w.uvIslands : 0, vertexColors: !!w.colors,
    parts: collected.parts.map(p => ({ name: p.name, triangles: p.triCount, ...(p.skinned ? { skinned: true } : {}) })),
    materials: mats.map((m, i) => ({ name: names[i], textures: byMat.get(m.name) || {} })),
    missingTextures: model.missing.map(m => ({ material: m.material, map: SLOT_NAMES[m.slot], file: m.file })),
    bounds: { min: r3(b.min), max: r3(b.max), size: r3(b.size), diagonal: round(b.diag, 6) },
    unitScale: model.meta.unitScale,
    ...(model.meta.mtl ? { mtl: model.meta.mtl } : {}),
  };
}

// Opens and welds a model as the app does. say(stage, text, frac) hears how far it got, lap(stage) when a stage ends.
async function openAndWeld(file, o, say, lap = () => {}) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw usage(`there is no file ${file}`);
  for (const f of o.textures) if (!fs.existsSync(f)) throw usage(`there is no file ${f}`);
  say('open', `Reading ${path.basename(file)} (${(fs.statSync(file).size / 1048576).toFixed(1)} MB)`);
  const model = await openModel(file, o.textures);
  let normalsMade = false;
  model.root.traverse(obj => { if (obj.isMesh && obj.geometry && !obj.geometry.attributes.normal) normalsMade = true; });
  const collected = collectScene(model.root);
  if (!collected.index.length) throw new Error('the file has no triangle meshes');
  const mats = displayMaterials(collected), names = materialNames(mats);
  lap('open');
  say('weld', `Welding ${fmt(collected.positions.length / 3)} vertices`);
  const w = core.smartWeld(collected, { keepUV: true, hardAngle: o.hardAngle, tolerance: o.mergeDistance });
  lap('weld');
  return { model, collected, mats, names, w, normalsMade };
}

// The mirror plane the options ask for: found (on every axis, or along one) or as given, with how well the model fits it.
function findPlane(w, spec, tree) {
  if (spec.offset !== null) return { axis: spec.axis, offset: spec.offset, fit: mirrorFit(w, spec.axis, spec.offset, tree), found: false };
  return { ...mirrorPlane(w, spec.axis, tree), found: true };
}
const planeReport = (p, side) => ({ axis: 'xyz'[p.axis], offset: round(p.offset, 6), keep: side, found: p.found, fit: { mean: round(100 * p.fit.mean, 4), max: round(100 * p.fit.max, 3), unit: '% of largest dimension' } });

// Describes a model without processing it: counts, parts, materials and their textures, bounds, and the mirror plane
// it is most symmetric about (or the one options.mirror asks for).
export async function inspect(file, opt = {}, progress = null) {
  const o = settingsOf(opt), say = (stage, text, frac) => progress && progress({ stage, text, frac });
  const { model, collected, mats, names, w, normalsMade } = await openAndWeld(file, o, say);
  say('mirror', 'Finding the mirror plane');
  const plane = findPlane(w, o.mirror || { axis: null, offset: null }, surfaceTree(w.positions, w.index));
  const edges = edgeCounts(w.positions, w.index);
  return { input: { ...describe(file, model, collected, w, mats, names), normalsMade, openEdges: edges.open, nonManifoldEdges: edges.nonManifold }, mirror: planeReport(plane, o.symSide) };
}

// Runs a model through the app's pipeline and builds its export. Returns { report, files: [{ name, bytes, note }] }
// (one zip when options.zip); nothing is written to disk. progress({ stage, text, frac }) hears how far it got.
export async function run(file, opt = {}, progress = null) {
  const o = settingsOf(opt), say = (stage, text, frac) => progress && progress({ stage, text, frac });
  const times = {}, warnings = [];
  let t0 = Date.now();
  const lap = k => { const now = Date.now(); times[k] = round((times[k] || 0) + (now - t0) / 1000, 2); t0 = now; };
  await MeshoptSimplifier.ready;
  const { model, collected, mats, names, w, normalsMade } = await openAndWeld(file, o, say, lap);
  const ctx = { mesh: { positions: w.positions, normals: w.normals, uvs: w.uvs, colors: w.colors, index: w.index, vPart: w.vPart, vMat: w.vMat, vertexCount: w.vertexCount, uvIsland: w.uvIsland }, half: null };
  ctx.packed = core.packAttributes(ctx.mesh);
  const quads = o.topology === 'quads', T = w.triCount;

  // Hidden areas: how visible each vertex is, turned into Less levels under the paint.
  let auto = null;
  if (o.hidden) {
    say('hidden', 'Finding hidden areas', 0);
    const { vis } = computeVisibility({ positions: w.positions, index: w.index, vertexCount: w.vertexCount }, { progress: f => say('hidden', 'Finding hidden areas', f) });
    auto = core.hiddenLabels(vis, o.hiddenLevel, o.hiddenCull, formDensity(w.positions, w.index, null, null, 1));
    lap('hidden');
  }
  let plane = null;
  if (o.mirror) {
    say('mirror', 'Finding the mirror plane');
    plane = findPlane(w, o.mirror, surfaceTree(w.positions, w.index));
    if (plane.fit.mean > 0.01) warnings.push(`The model's two halves differ: across ${'xyz'[plane.axis]} = ${round(plane.offset, 6)}, its mirror image lands ${round(100 * plane.fit.mean, 2)}% of its size from it on average, and the result copies the kept half onto the other.`);
    lap('mirror');
  }
  const symmetry = plane ? { axis: plane.axis, offset: plane.offset, keepPositive: o.symSide !== '-' } : null;

  // Paint as the reducer sees it (Normal detail unpainted, hidden levels wherever nothing is painted), and as the unwrap
  // and the region counts see it (the paint alone).
  const painted = paintLabels(o.paint, w, collected, symmetry), L = painted.labels;
  painted.reached.forEach((n, i) => { if (!n) warnings.push(`Paint rule ${i + 1} (${JSON.stringify(o.paint[i].source)}) reached no vertices.`); });
  const effective = new Int8Array(L.length), paint = L.slice();
  for (let i = 0; i < L.length; i++) { const m = L[i]; effective[i] = m === LABEL.PLAIN ? 0 : m || (auto ? auto[i] : 0); if (m === LABEL.PLAIN) paint[i] = 0; }

  const st = {
    maxError: o.maxError, lockBorder: o.lockBorder, permissive: o.permissive, prune: o.prune, regularize: o.regularize, normalWeight: o.normalWeight,
    uvWeight: o.uvWeight, optimizePositions: o.optimizePositions, uvMode: o.uvMode, deferUV: true, hardAngle: o.hardAngle, topology: o.topology,
    quadSharp: o.quadSharp ? core.QUAD_SHARP : 0, quadThin: o.quadThin, quadAdapt: o.quadAdapt, symmetry,
  };
  const fopt = { normals: o.normals, creaseAngle: o.creaseAngle };
  // The remesher reports its stage; this is the share of the whole remesh (REMESH_STAGES in src/app.js).
  const STAGES = { prepare: [0, 0.1], orientation: [0.1, 0.35], position: [0.35, 0.7], extract: [0.7, 0.85], relax: [0.85, 1] };
  const remeshing = text => (stage, frac) => { const r = STAGES[stage]; if (r) say('reduce', text, r[0] + (r[1] - r[0]) * Math.min(1, Math.max(0, frac))); };

  let target, zones = null;
  if (o.budget === 'auto') {
    // The zones don't depend on the budget, so a small remesh measures them for the real one.
    say('zones', 'Measuring the budget zones', 0);
    zones = core.runReduction(MeshoptSimplifier, ctx, effective, { ...st, targetTris: Math.min(T, 2000) }, fopt, remeshing('Measuring the budget zones')).info.zones;
    target = Math.max(4, Math.min(T, 2 * pickBudget(zones, T)));
    lap('zones');
  } else target = Math.max(4, Math.min(T, Math.round(parseBudget(o.budget, T, quads ? 2 : 1))));

  say('reduce', quads ? `Remeshing into ${fmt(target / 2)} quads` : `Reducing to ${fmt(target)} triangles`, 0);
  let { result: res, info } = core.runReduction(MeshoptSimplifier, ctx, effective, { ...st, targetTris: target }, fopt, quads ? remeshing(`Remeshing into ${fmt(target / 2)} quads`) : null);
  const regions = auto ? resultRegions(res, paint, auto) : info.cat;
  const budget = budgetCheck(info, target, o, w, res);
  lap('reduce');

  // New UVs: the texture job's unwrap, as the app's texture worker runs it. A model without UVs gets them only when asked.
  if (res.uvLayout === 'pending' || (o.uvMode === 'new' && !w.uvs && !res.uvs)) {
    say('unwrap', o.uvStyle === 'paint' ? 'Laying out paintable UVs' : 'Making new UVs');
    const paintable = o.uvStyle === 'paint';
    // The paintable layout reads the original's colour under each vertex to place seams where it changes; textures
    // aren't decoded here, so every vertex gets the grey the app gives an untextured model.
    const vis = paintable ? computeVisibility(res, { rays: RESULT_VIS_RAYS }).vis : null;
    const colors = paintable ? new Float32Array(res.vertexCount * 3).fill(128) : null;
    const u = core.unwrapResult(res, symmetry, paint, o.bakeSize, { style: o.uvStyle, vis, colors });
    res = u.result;
    info = { ...info, atlas: u.atlas, verts: res.vertexCount, symmetry: u.symmetry || info.symmetry };
    lap('unwrap');
  }

  let measured = null;
  if (o.measure) {
    say('measure', 'Measuring the result');
    const dev = deviation(w, res, symmetry), e = edgeCounts(res.positions, res.index);
    measured = { deviation: { mean: round(dev.mean, 4), p99: round(dev.p99, 4), max: round(dev.max, 3), unit: '% of diagonal' }, openEdges: e.open, nonManifoldEdges: e.nonManifold };
    lap('measure');
  }

  // The export, as the app's Export builds its zip.
  say('export', 'Writing files');
  const unitScale = o.units === 'm' ? 100 : o.units === 'cm' ? 1 : model.meta.unitScale || 100;
  const base = sanitize(o.name || model.meta.name.replace(/\.[^.]+$/, ''));
  const stem = o.name ? base : res.quad ? `${base}_${countQuads(res)}quads` : `${base}_${res.triCount}`;
  const infos = materialInfos(mats, names, res);
  const objects = core.exportObjects(res, collected.parts, infos, collected.parts.length === 1, base);
  const out = new Map();
  const add = (name, bytes, note) => { if (!out.has(name)) out.set(name, { name, bytes, note }); };
  if (o.format === 'fbx') add(`${stem}.fbx`, core.writeFBX(objects, { unitScale, fileName: `${stem}.fbx` }, FBX_TEMPLATE), 'model');
  else if (o.format === 'glb') add(`${stem}.glb`, await glbBytes(objects, unitScale / 100), 'model');
  else {
    const { obj, mtl } = core.writeOBJ(objects, { scale: unitScale / 100, mtlName: `${stem}.mtl` });
    add(`${stem}.obj`, strToU8(obj), 'model');
    add(`${stem}.mtl`, strToU8(mtl), 'materials');
  }
  const carried = [];
  for (const m of infos) {
    if (m.texture && m.bytes) carried.push({ file: m.texture, map: SLOT_NAMES.map, material: m.name, bytes: m.bytes });
    for (const x of m.extra) carried.push({ file: x.file, map: SLOT_NAMES[x.slot], material: m.name, bytes: x.bytes });
  }
  if (o.format !== 'glb') for (const c of carried) add(c.file, c.bytes, `${c.map} · the original file`);
  const triEnd = info.symmetry ? res.triCount / 2 : res.triCount;
  if (res.uvLayout === 'new') {
    const used = new Set(), nMat = Math.max(1, mats.length);
    for (let t = 0; t < res.triCount; t++) used.add(Math.min(res.vMat[res.index[t * 3]], nMat - 1));
    for (const mi of [...used].sort((a, b) => a - b)) add(`${stem}_${names[mi]}_uvlayout.png`, uvLayoutPng(res, mi, o.bakeSize, nMat, triEnd), 'UV layout · edges to paint over');
  }
  let files = [...out.values()];
  if (o.zip) files = [{ name: `${stem}.zip`, bytes: zipSync(Object.fromEntries(files.map(f => [f.name, f.bytes])), { level: 6 }), note: `zip of ${files.map(f => f.name).join(', ')}` }];
  lap('export');

  // What the app would say.
  const textured = model.textures.length > 0;
  if (model.missing.length) for (const m of model.missing) warnings.push(`The model asks for ${m.file} (${SLOT_NAMES[m.slot]} of ${m.material || 'its material'}), which is neither next to it nor among the files given.`);
  if (res.uvLayout === 'new' && textured) warnings.push("The textures aren't carried onto the new UVs: baking them takes the app, which bakes on the GPU. Triangles mode with the original UVs (--uvs original) keeps the textures as they are.");
  if (o.format === 'glb' && carried.length) warnings.push("GLB from the command line doesn't carry textures yet: FBX and OBJ link the original files, which are written beside them.");
  if (budget.why) warnings.push(budget.why);
  if (info.symmetry && info.symmetry.paired !== info.symmetry.total) warnings.push(`${fmt(info.symmetry.total - info.symmetry.paired)} of ${fmt(info.symmetry.total)} vertices have no mirror partner.`);
  if (collected.parts.some(p => p.skinned)) warnings.push("Bones and animations aren't carried over: skinned meshes come out in their rest pose.");
  if (o.uvMode === 'keep' && res.uvLayout === 'original' && info.uvFit && info.uvFit.misplaced > core.AUTO_UV_LIMIT) warnings.push(`With the original UVs, ${round(100 * info.uvFit.misplaced, 0)}% of the texture lands in the wrong place at this budget: Auto or new UVs avoid that.`);

  const report = {
    input: { ...describe(file, model, collected, w, mats, names), normalsMade },
    mirror: plane ? planeReport(plane, o.symSide) : null,
    result: {
      mode: quads ? 'quads' : 'triangles',
      budget: { asked: String(o.budget), ...(quads ? { quads: Math.round(target / 2) } : {}), triangles: target, status: budget.status },
      ...(quads ? { quads: info.quads } : {}), triangles: res.triCount, vertices: res.vertexCount,
      ...(quads && info.poles ? { poles: { count: info.poles.count, percent: round((100 * info.poles.count) / Math.max(1, info.poles.inner), 1) } } : {}),
      ...(quads && (zones || info.zones) ? { zones: zonesReport(zones || info.zones, T) } : {}),
      regions,
      uvs: res.uvLayout === 'new' ? 'new' : res.uvs ? 'original' : 'none',
      ...(info.atlas ? { uvCharts: info.atlas.charts, uvCoverage: round(info.atlas.coverage, 3), uvLayout: info.atlas.style } : {}),
      ...(info.uvFit ? { uvFit: { misplaced: round(info.uvFit.misplaced, 4), decision: info.uvDecision || (o.uvMode === 'keep' ? 'kept' : o.uvMode) } } : {}),
      ...(info.symmetry ? { symmetry: { paired: info.symmetry.paired, total: info.symmetry.total } } : {}),
      ...(measured || {}),
      normals: o.normals,
    },
    textures: {
      carried: o.format === 'glb' ? [] : carried.map(c => ({ file: c.file, map: c.map, material: c.material })),
      baked: false,
      ...(textured && res.uvLayout === 'new' ? { notCarried: model.textures.map(t => (t.embedded ? `${t.material} ${SLOT_NAMES[t.slot]} (embedded)` : path.basename(t.file))).filter((x, i, a) => a.indexOf(x) === i) } : {}),
    },
    files: files.map(f => ({ name: f.name, bytes: f.bytes.length, note: f.note })),
    warnings,
    seconds: { ...times, total: round(Object.values(times).reduce((s, x) => s + x, 0), 2) },
  };
  return { report, files };
}

// In quads; a limit no budget reaches is null.
function zonesReport(z, triangles) {
  const q = x => (Number.isFinite(x) ? Math.round(x) : null);
  return { red: q(z.red), gray: q(z.gray), by: z.redBy, note: zonesNote(z, triangles), auto: pickBudget(z, triangles) };
}
