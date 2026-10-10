// The command line and its pipeline: a model with two parts, two materials and a texture, symmetric in x, run through
// Quads and Triangles, paint rules, the mirror plane, the auto budget and each export format, and the command itself.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import { THREE, check, bumpySphere } from './helpers.js';
import { run, inspect, settingsOf, UsageError } from '../cli/pipeline.mjs';
import { openModel } from '../cli/load.mjs';
import { encodePNG } from '../cli/png.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-budget-cli-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const CLI = fileURLToPath(new URL('../cli/poly-budget.mjs', import.meta.url));

// An OBJ of meshes, each with its name and material, and the MTL beside it.
function writeOBJ(file, meshes, mtl) {
  const lines = [`mtllib ${path.basename(mtl.file)}`];
  let base = 1;
  for (const { name, material, geo } of meshes) {
    const g = geo.index ? geo.toNonIndexed() : geo, p = g.attributes.position, uv = g.attributes.uv, n = g.attributes.normal;
    lines.push(`o ${name}`, `usemtl ${material}`);
    for (let i = 0; i < p.count; i++) lines.push(`v ${p.getX(i)} ${p.getY(i)} ${p.getZ(i)}`);
    for (let i = 0; i < p.count; i++) lines.push(`vt ${uv.getX(i)} ${uv.getY(i)}`);
    for (let i = 0; i < p.count; i++) lines.push(`vn ${n.getX(i)} ${n.getY(i)} ${n.getZ(i)}`);
    for (let i = 0; i < p.count; i += 3) lines.push(`f ${[0, 1, 2].map(k => `${base + i + k}/${base + i + k}/${base + i + k}`).join(' ')}`);
    base += p.count;
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.writeFileSync(mtl.file, mtl.text);
}
const tiny = (r, g, b) => encodePNG(4, 4, Uint8Array.from({ length: 64 }, (_, i) => [r, g, b, 255][i % 4]));
fs.writeFileSync(path.join(dir, 'skin.png'), tiny(220, 170, 140));
// The sphere's bumps are symmetric in z as well as x; set forward, the head leaves x the only mirror plane.
const head = bumpySphere(128, 64).translate(0, 1.6, 0.15), body = new THREE.CylinderGeometry(0.6, 0.8, 2, 64, 8);
const model = path.join(dir, 'figure.obj');
writeOBJ(model, [{ name: 'Head', material: 'Skin', geo: head }, { name: 'Body', material: 'Cloth', geo: body }], {
  file: path.join(dir, 'figure.mtl'), text: 'newmtl Skin\nKd 0.9 0.7 0.6\nmap_Kd skin.png\nnewmtl Cloth\nKd 0.2 0.3 0.8\n',
});
const partShare = (res, part) => { let n = 0; for (let t = 0; t < res.triCount; t++) if (res.vPart[res.index[t * 3]] === part) n++; return n / res.triCount; };

console.log('== inspect');
{
  const r = await inspect(model);
  check(r.input.parts.map(p => p.name).join() === 'Head,Body' && r.input.materials.map(m => m.name).join() === 'Skin,Cloth', `parts ${r.input.parts.map(p => p.name)} and materials ${r.input.materials.map(m => m.name)} as the file names them`);
  check(r.input.materials[0].textures.map === 'skin.png' && !r.input.missingTextures.length, 'the MTL texture is found next to the model');
  check(r.mirror.axis === 'x' && Math.abs(r.mirror.offset) < 1e-3 && r.mirror.fit.mean < 0.1, `the mirror plane is found at x = ${r.mirror.offset} (mirror image ${r.mirror.fit.mean}% of the size off)`);
}

console.log('== quads');
const plain = await run(model, { budget: '1500', measure: true });
{
  const x = plain.report.result;
  check(x.mode === 'quads' && Math.abs(x.quads - 1500) <= 60 && x.budget.status === 'on budget', `remeshes into ${x.quads} quads for 1500 asked, on budget`);
  check(x.uvs === 'new' && x.uvCharts > 0 && x.deviation.mean < 0.5 && x.openEdges === 0, `new UVs in ${x.uvCharts} charts, ${x.deviation.mean}% mean deviation, ${x.openEdges} open edges`);
  check(x.zones && x.zones.red > 0 && x.zones.gray > x.zones.red && /Holds the shape/.test(x.zones.note), `budget zones: ${x.zones.note}`);
  const names = plain.files.map(f => f.name);
  check(names.join() === 'figure_' + x.quads + 'quads.fbx,figure_' + x.quads + 'quads_Skin_uvlayout.png,figure_' + x.quads + 'quads_Cloth_uvlayout.png', `writes the model and a UV layout sheet per material: ${names.join(', ')}`);
  check(plain.report.warnings.some(w => /aren't carried onto the new UVs/.test(w)), 'says the texture is not baked onto the new UVs');
  let faces = 0;
  new FBXLoader().parse(plain.files[0].bytes.buffer.slice(0), '').traverse(o => { if (o.isMesh) faces += o.geometry.attributes.position.count / 3; });
  check(faces === x.triangles, `three.js reads the FBX back with its ${x.triangles} triangles`);
  const png = plain.files[1].bytes;
  check(png[0] === 0x89 && png[1] === 0x50 && png.length > 1000, 'the UV layout sheet is a PNG');
}

console.log('== paint rules');
{
  const P = (await run(model, { budget: '1500', measure: false, paint: [{ more: 8, part: 'head' }] })).report;
  const base = plain.report.result.regions, more = P.result.regions.more;
  check(more > 0 && base.more === 0, `More ×8 on the part named head reaches ${more} of ${P.result.triangles} triangles (any case)`);
  const low = await run(model, { budget: '1500', measure: false, paint: [{ less: 8, box: [0, 0, 0, 1, 0.3, 1], relative: true }] });
  check(low.report.result.regions.less > 0, `Less ⅛ in the lowest 30% of the bounds reaches ${low.report.result.regions.less} triangles`);
  const empty = await run(model, { budget: '1500', measure: false, paint: [{ keep: true, material: 'Nothing' }] });
  check(empty.report.warnings.some(w => /reached no vertices/.test(w)), 'a rule that selects nothing is reported');
}

console.log('== mirror, auto budget');
{
  const m = await run(model, { budget: 'auto', mirror: 'auto', measure: false });
  const x = m.report.result;
  check(m.report.mirror.axis === 'x' && x.symmetry && x.symmetry.paired === x.symmetry.total, `mirrored across x: ${x.symmetry.paired} of ${x.symmetry.total} vertices paired`);
  check(x.budget.asked === 'auto' && x.budget.quads === x.zones.auto && x.zones.auto >= x.zones.red && x.zones.auto <= x.zones.gray, `auto picks ${x.budget.quads} quads, between red ${x.zones.red} and gray ${x.zones.gray}`);
  const fixed = await run(model, { budget: '1500', mirror: 'x=0', symSide: '-', measure: false });
  check(fixed.report.mirror.offset === 0 && fixed.report.mirror.keep === '-' && !fixed.report.mirror.found, 'a given plane is used as given, keeping the side asked');
}

console.log('== triangles with the original UVs');
{
  const t = await run(model, { topology: 'tris', budget: '20%', uvMode: 'keep', format: 'obj', measure: false });
  const x = t.report.result, names = t.files.map(f => f.name);
  check(x.mode === 'triangles' && x.uvs === 'original' && Math.abs(x.triangles - x.budget.triangles) <= x.budget.triangles * 0.02, `reduces to ${x.triangles} of ${x.budget.triangles} triangles and keeps the original UVs`);
  check(names.includes('skin.png') && t.report.textures.carried.length === 1, `the texture file is copied: ${names.join(', ')}`);
  const mtl = new TextDecoder().decode(t.files.find(f => f.name.endsWith('.mtl')).bytes);
  check(/newmtl Skin[\s\S]*map_Kd skin\.png/.test(mtl), 'the MTL links it');
  const zip = await run(model, { topology: 'tris', budget: '20%', uvMode: 'keep', format: 'obj', measure: false, zip: true });
  const entries = Object.keys(unzipSync(zip.files[0].bytes)).sort();
  check(zip.files.length === 1 && entries.join() === names.slice().sort().join(), `--zip holds the same files: ${entries.join(', ')}`);
}

console.log('== GLB, and a GLB with its texture inside');
{
  const g = await run(model, { budget: '800', format: 'glb', measure: false });
  const gltf = await new GLTFLoader().parseAsync(g.files[0].bytes.buffer.slice(0), '');
  let tris = 0;
  gltf.scene.traverse(o => { if (o.isMesh) tris += o.geometry.index.count / 3; });
  check(tris === g.report.result.triangles, `three.js reads the GLB back with its ${tris} triangles`);
  // A square with an embedded PNG, as generators ship GLB files.
  const png = tiny(10, 200, 30), pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const pad = n => (n + 3) & ~3, parts = [pos, uv, idx, png], offs = [];
  let len = 0;
  for (const p of parts) { offs.push(len); len = pad(len + p.byteLength); }
  const bin = new Uint8Array(len);
  parts.forEach((p, i) => bin.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), offs[i]));
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'Square' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'Painted', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }],
    images: [{ bufferView: 3, mimeType: 'image/png' }], buffers: [{ byteLength: len }],
    bufferViews: parts.map((p, i) => ({ buffer: 0, byteOffset: offs[i], byteLength: p.byteLength })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  };
  const jb = new TextEncoder().encode(JSON.stringify(json).padEnd(pad(JSON.stringify(json).length)));
  const glb = new Uint8Array(12 + 8 + jb.length + 8 + len), dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, glb.length, true);
  dv.setUint32(12, jb.length, true); dv.setUint32(16, 0x4e4f534a, true); glb.set(jb, 20);
  dv.setUint32(20 + jb.length, len, true); dv.setUint32(24 + jb.length, 0x004e4942, true); glb.set(bin, 28 + jb.length);
  const square = path.join(dir, 'square.glb');
  fs.writeFileSync(square, glb);
  const opened = await openModel(square);
  check(opened.textures.length === 1 && opened.textures[0].embedded, 'the embedded image is kept, though glTF revokes its blob URL once loaded');
  const s = await run(square, { topology: 'tris', budget: '2', hidden: false, measure: false, uvMode: 'keep' });
  const file = s.files.find(f => f.name === 'Painted_basecolor.png');
  check(!!file && Buffer.from(file.bytes).equals(Buffer.from(png)), 'and written out as the material\'s base colour, byte for byte');
}

console.log('== options');
{
  const bad = [{ budget: 'lots' }, { topology: 'tris', budget: 'auto' }, { mirror: 'w' }, { paint: [{ more: 3, part: 'Head' }] }, { paint: [{ more: 2 }] }, { paint: [{ more: 2, part: 'Head', colour: 'red' }] }, { quadAdapt: 2 }, { format: 'stl' }, { budgett: '10k' }];
  const thrown = bad.map(o => { try { settingsOf(o); return null; } catch (e) { return e instanceof UsageError ? e.message : `not a usage error: ${e.message}`; } });
  check(thrown.every(Boolean) && thrown.every(m => !/not a usage error/.test(m)), `bad options are refused with a reason, such as "${thrown[3]}"`);
}

console.log('== the command');
{
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: dir });
  const out = path.join(dir, 'out');
  const r = cli(model, '--quads', '800', '--json', '-o', out, '-q');
  const report = r.status === 0 ? JSON.parse(r.stdout) : null;
  check(r.status === 0 && report && report.files.every(f => f.path.startsWith('out/') && fs.existsSync(path.resolve(dir, f.path))), `poly-budget model.obj --quads 800 --json writes ${report ? report.files.map(f => f.path).join(', ') : r.stderr}`);
  const info = cli(model, '--info', '--json');
  check(info.status === 0 && JSON.parse(info.stdout).input.triangles > 0, '--info --json describes the model');
  const human = cli(model, '--tris', '5%', '-o', out);
  check(human.status === 0 && /Reduced to [\d,]+ tris/.test(human.stdout) && /Wrote/.test(human.stdout), 'without --json it prints a summary');
  const wrong = cli(model, '--quads', '800', '--bogus');
  check(wrong.status === 2 && /there is no option --bogus/.test(wrong.stderr), `an unknown option exits with 2: ${wrong.stderr.trim()}`);
  const none = cli('--quads', '800');
  check(none.status === 2 && /no model/.test(none.stderr), 'so does a missing model');
}
