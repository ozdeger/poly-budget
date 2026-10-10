#!/usr/bin/env node
// Poly Budget from a terminal or a pipeline: the app's reduction and quad remesh without the page. See --help, and the
// Command line section of docs/DEVELOPMENT.md.
import fs from 'fs';
import os from 'os';
import path from 'path';
import v8 from 'v8';
import { spawnSync } from 'child_process';
import { parseArgs } from 'util';

// Dense models need more memory than Node gives by default (about 4 GB): the command starts again with up to 16 GB, or
// three quarters of the machine's memory if that is less, unless a limit was set on purpose.
const heapWanted = Math.min(16384, Math.floor((os.totalmem() / 2 ** 20) * 0.75));
const heapSet = [...process.execArgv, ...(process.env.NODE_OPTIONS || '').split(/\s+/)].some(a => a.startsWith('--max-old-space-size'));
if (!process.env.POLY_BUDGET_RESTARTED && !heapSet && v8.getHeapStatistics().heap_size_limit / 2 ** 20 < 0.9 * heapWanted) {
  const r = spawnSync(process.execPath, [...process.execArgv, `--max-old-space-size=${heapWanted}`, process.argv[1], ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, POLY_BUDGET_RESTARTED: '1' },
  });
  if (r.error) { console.error(`poly-budget: couldn't start with more memory: ${r.error.message}`); process.exit(1); }
  // Ended by a signal (interrupted, or out of memory): end the same way.
  if (r.signal) process.kill(process.pid, r.signal);
  process.exit(r.status ?? 1);
}

const HELP = `Poly Budget: heavy 3D models in, light and clean ones out. The app's reduction and quad remesh, without the page.

usage: poly-budget <model> [textures…] [options]

  <model>                  .fbx, .glb, .gltf, .obj (with its .mtl), .stl or .ply
  [textures…]              texture files, matched to materials by the names the model asks for (the app does the
                           same with files dropped with a model); textures it names are also looked for next to it

Budget (Quads at 10% of the triangles, as in the app, unless given):
  --quads <n>              remesh into quads: a count (12500), a short count (12.5k), a share of the original
                           triangles (5%), or auto: the middle of the budget zones, measured by a quick first remesh
  --tris <n>               reduce the model's own triangles instead: 20000, 20k or 5%

Where the detail goes:
  --paint <rules>          paint rules, as JSON or a .json file (can be given more than once), such as
                           '[{"more": 4, "part": "Head"}, {"less": 8, "box": [0, 0, 0, 1, 0.05, 1], "relative": true}]'
                           more / less: 2, 4 or 8; keep: true; normal: true; erase: true. Select by part, material,
                           box [x0, y0, z0, x1, y1, z1] or sphere [x, y, z, r], in model units or, with
                           "relative": true, shares of the bounds; later rules paint over earlier ones
  --hidden <level>         hidden areas get less: off, gentle, medium (default) or strong
  --delete-unseen          delete faces nothing can see
  --mirror <plane>         mirror symmetry: auto, x, y or z (the plane found along that axis), or x=0.25
  --mirror-side <+|->      the half kept and mirrored (default +)

Quads:
  --follow-shape <0-100>   how closely quad sizes and stretch follow the shape (default 75)
  --no-sharp-edges         don't turn edges sharper than 45° into edge loops
  --no-thin-parts          don't give thin parts quads small enough to stay whole
  --remove-tiny-parts      remove tiny floating parts (Triangles too)

Triangles:
  --stop-at-error <x>      stop early at this error, a share of the model's size such as 0.5% (default: no limit)
  --triangle-shape <s>     any, even (default) or very-even
  --protect-shading <0-2>  default 0.5
  --protect-texture <0-3>  default 1
  --lock-borders           holes and open edges keep their outline
  --cross-seams            allow collapsing across UV seams (lower counts, some smearing)
  --no-optimize            don't optimize vertex positions

UVs and normals:
  --uvs <mode>             auto (default: keep the original UVs while they fit the texture), original, or new
  --uv-layout <layout>     compact (default) or paintable: few large upright charts with hidden seams
  --texture-size <px>      512, 1024 (default) or 2048: the size the layout is made for
  --normals <kind>         original (default), smooth or creased
  --crease-angle <deg>     default 60
  --hard-edge-angle <deg>  welding keeps normals further apart than this split (default 30)
  --merge-distance <x>     welding merges vertices this close, a share of the model's size (default 0.0001%)

Output:
  -o, --out <dir>          where the files go (default: the current directory)
  -f, --format <f>         fbx (default), obj or glb
  --units <u>              auto (the source file's), m or cm
  --name <name>            the file name to write, instead of the model's name and face count
  --zip                    one zip, as the app's Export, instead of loose files
  --json                   print the report as JSON on stdout (progress still goes to stderr)
  --info                   describe the model and stop: counts, parts, materials, textures, bounds, mirror plane
  --no-measure             skip measuring how far the original lies from the result
  -q, --quiet              no progress or summary
  -h, --help               this text
  --version                the version

Textures are not baked onto new UVs here: that takes the app, which bakes on the GPU. Quads always get new UVs; in
Triangles mode the original UVs, and the texture files, are kept while they fit (--uvs original keeps them always).`;

const options = {
  quads: { type: 'string' }, tris: { type: 'string' },
  paint: { type: 'string', multiple: true }, hidden: { type: 'string' }, 'delete-unseen': { type: 'boolean' },
  mirror: { type: 'string' }, 'mirror-side': { type: 'string' },
  'follow-shape': { type: 'string' }, 'no-sharp-edges': { type: 'boolean' }, 'no-thin-parts': { type: 'boolean' }, 'remove-tiny-parts': { type: 'boolean' },
  'stop-at-error': { type: 'string' }, 'triangle-shape': { type: 'string' }, 'protect-shading': { type: 'string' }, 'protect-texture': { type: 'string' },
  'lock-borders': { type: 'boolean' }, 'cross-seams': { type: 'boolean' }, 'no-optimize': { type: 'boolean' },
  uvs: { type: 'string' }, 'uv-layout': { type: 'string' }, 'texture-size': { type: 'string' },
  normals: { type: 'string' }, 'crease-angle': { type: 'string' }, 'hard-edge-angle': { type: 'string' }, 'merge-distance': { type: 'string' },
  out: { type: 'string', short: 'o' }, format: { type: 'string', short: 'f' }, units: { type: 'string' }, name: { type: 'string' }, zip: { type: 'boolean' },
  json: { type: 'boolean' }, info: { type: 'boolean' }, 'no-measure': { type: 'boolean' }, quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
};

class ArgError extends Error {}
const fail = msg => { throw new ArgError(msg); };
const choice = (flag, v, map) => (v in map ? map[v] : fail(`--${flag} takes ${Object.keys(map).join(', ')}: not "${v}"`));
const num = (flag, v, lo, hi) => { const n = Number(v); return v !== '' && Number.isFinite(n) && n >= lo && n <= hi ? n : fail(`--${flag} takes a number from ${lo} to ${hi}: not "${v}"`); };
// A share: "0.5%" or 0.005.
const share = (flag, v) => { const m = String(v).trim().match(/^([\d.]+(?:e-?\d+)?)(%?)$/i); const n = m ? Number(m[1]) / (m[2] ? 100 : 1) : NaN; return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fail(`--${flag} takes a share of the model's size, such as 0.5%: not "${v}"`); };

// The flags as the pipeline's options (DEFAULTS in pipeline.mjs), and the files to open.
function optionsOf(values, positionals, MODEL_EXT, IMAGE_EXT, extOf) {
  const models = positionals.filter(f => MODEL_EXT.includes(extOf(f)));
  if (!models.length) fail(positionals.length ? `no model among ${positionals.join(', ')}: open .${MODEL_EXT.join(', .')}` : 'no model given');
  if (models.length > 1) fail(`one model at a time: ${models.join(', ')}`);
  const textures = positionals.filter(f => f !== models[0]);
  for (const f of textures) if (!IMAGE_EXT.includes(extOf(f)) && extOf(f) !== 'mtl') fail(`${f} is neither a model, a texture (.${IMAGE_EXT.join(', .')}) nor an .mtl`);
  const o = { textures };
  if (values.quads !== undefined && values.tris !== undefined) fail('give --quads or --tris, not both');
  if (values.quads !== undefined) { o.topology = 'quads'; o.budget = values.quads.trim().toLowerCase() === 'auto' ? 'auto' : values.quads; }
  if (values.tris !== undefined) { o.topology = 'tris'; o.budget = values.tris; if (values.tris.trim().toLowerCase() === 'auto') fail('--tris auto: an auto budget needs --quads, since the budget zones come from the remesh'); }
  if (values.paint) {
    o.paint = [];
    for (const p of values.paint) {
      const text = /^\s*[[{]/.test(p) ? p : fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : fail(`--paint takes JSON or a .json file: there is no file ${p}`);
      let rules;
      try { rules = JSON.parse(text); } catch (e) { fail(`--paint ${p.length > 60 ? `${p.slice(0, 57)}…` : p} isn't valid JSON: ${e.message}`); }
      o.paint.push(...(Array.isArray(rules) ? rules : [rules]));
    }
  }
  if (values.hidden !== undefined) {
    const h = choice('hidden', values.hidden, { off: 'off', gentle: 'gentle', medium: 'medium', strong: 'strong' });
    o.hidden = h !== 'off';
    if (o.hidden) o.hiddenLevel = h;
  }
  if (values['delete-unseen']) o.hiddenCull = true;
  if (values.mirror !== undefined) o.mirror = values.mirror;
  if (values['mirror-side'] !== undefined) o.symSide = choice('mirror-side', values['mirror-side'], { '+': '+', '-': '-' });
  if (values['follow-shape'] !== undefined) o.quadAdapt = num('follow-shape', String(values['follow-shape']).replace(/%$/, ''), 0, 100) / 100;
  if (values['no-sharp-edges']) o.quadSharp = false;
  if (values['no-thin-parts']) o.quadThin = false;
  if (values['remove-tiny-parts']) o.prune = true;
  if (values['stop-at-error'] !== undefined) o.maxError = share('stop-at-error', values['stop-at-error']);
  if (values['triangle-shape'] !== undefined) o.regularize = choice('triangle-shape', values['triangle-shape'], { any: 0, even: 1, 'very-even': 2 });
  if (values['protect-shading'] !== undefined) o.normalWeight = num('protect-shading', values['protect-shading'], 0, 2);
  if (values['protect-texture'] !== undefined) o.uvWeight = num('protect-texture', values['protect-texture'], 0, 3);
  if (values['lock-borders']) o.lockBorder = true;
  if (values['cross-seams']) o.permissive = true;
  if (values['no-optimize']) o.optimizePositions = false;
  if (values.uvs !== undefined) o.uvMode = choice('uvs', values.uvs, { auto: 'auto', original: 'keep', new: 'new' });
  if (values['uv-layout'] !== undefined) o.uvStyle = choice('uv-layout', values['uv-layout'], { compact: 'compact', paintable: 'paint' });
  if (values['texture-size'] !== undefined) o.bakeSize = choice('texture-size', values['texture-size'], { 512: 512, 1024: 1024, 2048: 2048 });
  if (values.normals !== undefined) o.normals = choice('normals', values.normals, { original: 'original', smooth: 'smooth', creased: 'crease' });
  if (values['crease-angle'] !== undefined) o.creaseAngle = num('crease-angle', values['crease-angle'], 10, 90);
  if (values['hard-edge-angle'] !== undefined) o.hardAngle = num('hard-edge-angle', values['hard-edge-angle'], 0, 90);
  if (values['merge-distance'] !== undefined) o.mergeDistance = share('merge-distance', values['merge-distance']);
  if (values.format !== undefined) o.format = choice('format', values.format.toLowerCase(), { fbx: 'fbx', obj: 'obj', glb: 'glb' });
  if (values.units !== undefined) o.units = choice('units', values.units, { auto: 'auto', m: 'm', cm: 'cm' });
  if (values.name !== undefined) o.name = values.name;
  if (values.zip) o.zip = true;
  if (values['no-measure']) o.measure = false;
  return { file: models[0], o };
}

// Progress on stderr: one line rewritten in place on a terminal, a line per stage otherwise.
function progressPrinter(quiet) {
  if (quiet) return null;
  const tty = process.stderr.isTTY;
  let last = '', lastAt = 0;
  return ({ text, frac }) => {
    const line = frac !== undefined ? `${text}… ${Math.round(100 * frac)}%` : `${text}…`;
    if (tty) {
      const now = Date.now();
      if (line === last || (text === last.split('…')[0] && now - lastAt < 100)) return;
      process.stderr.write(`\r\x1b[2K${line}`);
      last = line; lastAt = now;
    } else if (!last.startsWith(text)) {
      process.stderr.write(`${text}…\n`);
      last = line;
    }
  };
}
function clearProgress(quiet) { if (!quiet && process.stderr.isTTY) process.stderr.write('\r\x1b[2K'); }

const fmt = n => new Intl.NumberFormat('en-US').format(Math.round(n));
const size = b => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const pct = v => (v < 0.1 ? v.toFixed(3) : v < 1 ? v.toFixed(2) : v.toFixed(1));

function inputLine(i) {
  const mats = i.materials.map(m => {
    const t = Object.entries(m.textures).map(([slot, f]) => `${slot === 'map' ? 'base colour' : slot.replace(/Map$/, '')} ${f}`);
    return t.length ? `${m.name} (${t.join(', ')})` : m.name;
  });
  return [
    `${path.basename(i.file)}: ${fmt(i.triangles)} tris · ${fmt(i.vertices)} verts · ${i.uvs ? `UVs in ${fmt(i.uvIslands)} islands` : 'no UVs'}${i.vertexColors ? ' · vertex colours' : ''}`,
    `  parts       ${i.parts.length > 6 ? `${i.parts.length} parts` : i.parts.map(p => `${p.name} (${fmt(p.triangles)} tris)`).join(', ')}`,
    `  materials   ${mats.length > 6 ? `${mats.length} materials` : mats.join('; ')}`,
    ...(i.missingTextures.length ? [`  missing     ${i.missingTextures.map(m => m.file).join(', ')}`] : []),
  ];
}
const mirrorLine = m => `  mirror      ${m.axis} = ${m.offset}${m.found ? ' (found)' : ''}, keeping ${m.keep}: its mirror image lands ${pct(m.fit.mean)}% of its size from it on average, ${pct(m.fit.max)}% at most`;

function summary(r) {
  const x = r.result, lines = inputLine(r.input);
  if (r.mirror) lines.push(mirrorLine(r.mirror));
  const made = x.mode === 'quads' ? `Remeshed into ${fmt(x.quads)} quads (${fmt(x.triangles)} tris · ${fmt(x.vertices)} verts)` : `Reduced to ${fmt(x.triangles)} tris (${fmt(x.vertices)} verts)`;
  const asked = x.budget.quads ? `${fmt(x.budget.quads)} quads` : `${fmt(x.budget.triangles)} tris`;
  lines.push('', `${made} · ${x.budget.status}, asked ${x.budget.asked}${/^[\d.]+$/.test(x.budget.asked) ? '' : ` = ${asked}`} · ${r.seconds.total} s`);
  if (x.poles) lines.push(`  poles       ${fmt(x.poles.count)} · ${x.poles.percent}% of vertices`);
  if (x.zones) lines.push(`  zones       ${x.zones.note}`);
  if (x.deviation) lines.push(`  deviation   ${pct(x.deviation.mean)}% mean · ${pct(x.deviation.p99)}% p99 · ${pct(x.deviation.max)}% max, of the diagonal`);
  if (x.openEdges !== undefined) lines.push(`  edges       ${fmt(x.openEdges)} open · ${fmt(x.nonManifoldEdges)} non-manifold`);
  const reg = x.regions, painted = reg.keep + reg.more + reg.less + (reg.hidden || 0);
  if (painted) lines.push(`  regions     ${[['keep', 'Keep'], ['more', 'More'], ['less', 'Less'], ['hidden', 'Hidden'], ['rest', 'unpainted']].filter(([k]) => reg[k]).map(([k, n]) => `${n} ${fmt(reg[k])}`).join(' · ')} tris`);
  const why = x.uvFit && x.uvFit.decision === 'rebuilt' ? `: the original UVs would put ${pct(100 * x.uvFit.misplaced)}% of the texture in the wrong place` : '';
  lines.push(`  UVs         ${x.uvs === 'new' ? `new · ${fmt(x.uvCharts)} charts${x.uvLayout === 'paint' ? ', paintable' : ''}${why}` : x.uvs === 'original' ? `original${x.uvFit ? ` · ${pct(100 * x.uvFit.misplaced)}% of the texture misplaced` : ''}` : 'none'}`);
  if (x.symmetry) lines.push(`  symmetry    ${x.symmetry.paired === x.symmetry.total ? `all ${fmt(x.symmetry.total)} vertices paired` : `${fmt(x.symmetry.total - x.symmetry.paired)} of ${fmt(x.symmetry.total)} unpaired`}`);
  lines.push('', 'Wrote');
  const w = Math.max(...r.files.map(f => (f.path || f.name).length));
  for (const f of r.files) lines.push(`  ${(f.path || f.name).padEnd(w)}  ${size(f.bytes).padStart(8)}  ${f.note}`);
  if (r.warnings.length) lines.push('', 'Note', ...r.warnings.map(s => `  - ${s}`));
  return lines.join('\n');
}

function infoSummary(r) {
  const i = r.input, b = i.bounds, lines = inputLine(i);
  lines.push(`  bounds      min [${b.min.join(', ')}] · max [${b.max.join(', ')}] · size [${b.size.join(', ')}]${i.format === 'fbx' ? ` · ${i.unitScale} cm per unit` : ''}`);
  lines.push(`  edges       ${fmt(i.openEdges)} open · ${fmt(i.nonManifoldEdges)} non-manifold`);
  lines.push(mirrorLine(r.mirror));
  if (i.normalsMade) lines.push('  normals     none in the file: smooth ones are worked out');
  return lines.join('\n');
}

async function main() {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ options, allowPositionals: true, strict: true }));
  } catch (e) {
    throw new ArgError(e.message.replace(/^Unknown option '([^']*)'.*$/s, 'there is no option $1'));
  }
  if (values.help) { console.log(HELP); return 0; }
  if (values.version) {
    console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    return 0;
  }
  const { MODEL_EXT, IMAGE_EXT, extOf } = await import('./load.mjs');
  const { run, inspect } = await import('./pipeline.mjs');
  const { file, o } = optionsOf(values, positionals, MODEL_EXT, IMAGE_EXT, extOf);
  const quiet = !!values.quiet, progress = progressPrinter(quiet);
  if (values.info) {
    const pick = ['textures', 'mirror', 'symSide', 'hardAngle', 'mergeDistance'].filter(k => k in o);
    const r = await inspect(file, Object.fromEntries(pick.map(k => [k, o[k]])), progress);
    clearProgress(quiet);
    if (values.json) console.log(JSON.stringify(r, null, 2));
    else if (!quiet) console.log(infoSummary(r));
    return 0;
  }
  const { report, files } = await run(file, o, progress);
  clearProgress(quiet);
  fs.mkdirSync(path.resolve(values.out || '.'), { recursive: true });
  // The real path, so a folder reached through a link (macOS's /var and /tmp) still shows relative to where we are.
  const dir = fs.realpathSync(path.resolve(values.out || '.'));
  for (const [i, f] of files.entries()) {
    const to = path.join(dir, f.name);
    fs.writeFileSync(to, f.bytes);
    const rel = path.relative(process.cwd(), to);
    report.files[i].path = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : to;
  }
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else if (!quiet) console.log(summary(report));
  return 0;
}

main().then(code => { process.exitCode = code; }, async err => {
  clearProgress(false);
  const { UsageError } = await import('./pipeline.mjs').catch(() => ({ UsageError: class {} }));
  const isUsage = err instanceof ArgError || err instanceof UsageError;
  const message = isUsage ? err.message : `couldn't process the model: ${err && err.message ? err.message : err}`;
  if (process.argv.includes('--json')) console.log(JSON.stringify({ error: message }, null, 2));
  console.error(`poly-budget: ${message}${isUsage ? ' (poly-budget --help)' : ''}`);
  if (!isUsage && process.env.POLY_BUDGET_DEBUG && err && err.stack) console.error(err.stack);
  process.exitCode = isUsage ? 2 : 1;
});
