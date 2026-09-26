// Downloads the test models listed in manifest.json into testdata/models/<id>/ (not committed) and unpacks them.
// usage: node test/models/fetch.mjs [id …] [--tier=core|extended|stress] [--list] [--check]
//   --list   prints the collection: counts, download size, licence
//   --check  asks each server whether the files are still there (HEAD requests), downloading nothing
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import zlib from 'zlib';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';

const here = path.dirname(new URL(import.meta.url).pathname);
export const modelsDir = path.resolve(here, '../../testdata/models');
export const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));

// Some hosts (Wikimedia) turn away requests that don't say who is asking.
const headers = { 'User-Agent': 'poly-budget-test-models/1.0 (+https://github.com/ozdeger/poly-budget)' };
const mb = n => (n == null ? '?' : n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);
const count = n => (n == null ? '?' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`);

// The models named on the command line, or those of one tier (--tier=core), or all of them.
export function pick(args) {
  const ids = args.filter(a => !a.startsWith('--')), tier = (args.find(a => a.startsWith('--tier=')) || '').slice(7);
  const unknown = ids.filter(id => !manifest.models.some(m => m.id === id));
  if (unknown.length) throw new Error(`not in the manifest: ${unknown.join(', ')}`);
  return manifest.models.filter(m => (!ids.length || ids.includes(m.id)) && (!tier || m.tier === tier));
}

// The model file to open, once fetched and unpacked (null when it isn't there yet).
export function modelPath(m) {
  const p = path.join(modelsDir, m.id, m.open);
  return fs.existsSync(p) ? p : null;
}

async function sha256(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

async function download(m, f) {
  const dir = path.join(modelsDir, m.id), dest = path.join(dir, f.name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && (f.bytes == null || fs.statSync(dest).size === f.bytes)) return { dest, fresh: false };
  const res = await fetch(f.url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || f.bytes;
  let got = 0, shown = Date.now();
  const body = Readable.fromWeb(res.body);
  body.on('data', chunk => {
    got += chunk.length;
    if (Date.now() - shown > 3000) { shown = Date.now(); console.log(`     ${f.name}: ${mb(got)} of ${mb(total)}`); }
  });
  await pipeline(body, fs.createWriteStream(`${dest}.part`));
  if (f.bytes != null && got !== f.bytes) throw new Error(`${f.name}: got ${got} bytes, the manifest says ${f.bytes}`);
  fs.renameSync(`${dest}.part`, dest);
  return { dest, fresh: true };
}

// A remote zip read in pieces with HTTP range requests: a file's `extract` list names the entries (path prefixes) to
// take out of it, so a model inside a multi-gigabyte archive of many costs only its own bytes. Handles zip64
// (archives over 4 GB) and stored or deflated entries, and checks each entry's CRC.
async function ranged(url, start, end) {
  const ctl = new AbortController(), res = await fetch(url, { headers: { ...headers, Range: `bytes=${start}-${end - 1}` }, redirect: 'follow', signal: ctl.signal });
  if (res.status !== 206) { ctl.abort(); throw new Error(`${url}: the server won't send parts of the file (HTTP ${res.status})`); }
  return res;
}
const rangedBytes = async (url, start, end) => Buffer.from(await (await ranged(url, start, end)).arrayBuffer());

async function zipDirectory(url, size) {
  const tailLen = Math.min(size, 65557 + 20);
  const tail = await rangedBytes(url, size - tailLen, size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0 && eocd < 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) eocd = i;
  if (eocd < 0) throw new Error(`${url}: not a zip`);
  let count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // zip64: a locator right before the end record points at the 64-bit end record.
    if (eocd < 20 || tail.readUInt32LE(eocd - 20) !== 0x07064b50) throw new Error(`${url}: zip64 locator missing`);
    const at = Number(tail.readBigUInt64LE(eocd - 12)), rec = await rangedBytes(url, at, at + 56);
    if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error(`${url}: zip64 end record missing`);
    count = Number(rec.readBigUInt64LE(32)); cdSize = Number(rec.readBigUInt64LE(40)); cdOffset = Number(rec.readBigUInt64LE(48));
  }
  const cd = await rangedBytes(url, cdOffset, cdOffset + cdSize), entries = [];
  for (let p = 0; p + 46 <= cd.length && entries.length < count;) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`${url}: bad central directory`);
    const method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16), nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    let comp = cd.readUInt32LE(p + 20), size = cd.readUInt32LE(p + 24), offset = cd.readUInt32LE(p + 42);
    // The zip64 extra field (id 1) holds, in this order, the 64-bit values of the fields set to 0xffffffff.
    for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen;) {
      const id = cd.readUInt16LE(e), len = cd.readUInt16LE(e + 2);
      if (id === 1) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (comp === 0xffffffff) { comp = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(q));
      }
      e += 4 + len;
    }
    entries.push({ name: cd.toString('utf8', p + 46, p + 46 + nameLen), method, crc, comp, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function zipTake(url, entry, dest) {
  const head = await rangedBytes(url, entry.offset, entry.offset + 30);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`${entry.name}: bad local header`);
  const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name}: compression method ${entry.method} isn't supported`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let crc = 0;
  const body = Readable.fromWeb((await ranged(url, start, start + entry.comp)).body), check = new Transform({
    transform(chunk, _, done) { crc = zlib.crc32(chunk, crc); done(null, chunk); },
  });
  await pipeline(body, ...(entry.method === 8 ? [zlib.createInflateRaw()] : []), check, fs.createWriteStream(`${dest}.part`));
  if (crc >>> 0 !== entry.crc >>> 0) throw new Error(`${entry.name}: CRC mismatch`);
  fs.renameSync(`${dest}.part`, dest);
}

async function extractRemote(m, f) {
  const dir = path.join(modelsDir, m.id), stamp = path.join(dir, `.${f.name}.extracted`);
  if (fs.existsSync(stamp)) return;
  const entries = (await zipDirectory(f.url, f.bytes)).filter(e => !e.name.endsWith('/') && f.extract.some(x => e.name.startsWith(x)));
  if (!entries.length) throw new Error(`${f.name}: nothing matches ${f.extract.join(', ')}`);
  const total = entries.reduce((s, e) => s + e.comp, 0);
  console.log(`     ${f.name}: taking ${entries.length} entries (${mb(total)}) out of ${mb(f.bytes)}`);
  for (const e of entries) {
    const dest = path.join(dir, e.name);
    if (!dest.startsWith(dir + path.sep)) throw new Error(`${e.name}: path leaves the model's folder`);
    if (!fs.existsSync(dest) || fs.statSync(dest).size !== e.size) await zipTake(f.url, e, dest);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stamp, '');
}

// Unpacks an archive next to it once (a stamp file remembers it).
function unpack(dest) {
  const dir = path.dirname(dest), name = path.basename(dest), stamp = path.join(dir, `.${name}.unpacked`);
  if (fs.existsSync(stamp)) return;
  if (/\.zip$/i.test(name)) execFileSync('unzip', ['-o', '-q', dest, '-d', dir]);
  else if (/\.(tar\.gz|tgz)$/i.test(name)) execFileSync('tar', ['-xzf', dest, '-C', dir]);
  else if (/\.tar\.xz$/i.test(name)) execFileSync('tar', ['-xJf', dest, '-C', dir]);
  else if (/\.gz$/i.test(name)) execFileSync('gunzip', ['-kf', dest]);
  else if (/\.7z$/i.test(name)) execFileSync('7z', ['x', '-y', `-o${dir}`, dest]);
  else return;
  fs.writeFileSync(stamp, '');
}

async function main() {
  const args = process.argv.slice(2), flags = new Set(args.filter(a => a.startsWith('--')));
  const models = pick(args);
  if (flags.has('--list')) {
    let total = 0;
    for (const m of models) {
      const bytes = m.files.reduce((s, f) => s + ((f.extract ? f.extractBytes : f.bytes) || 0), 0);
      total += bytes;
      console.log(`${m.id.padEnd(26)} ${m.tier.padEnd(8)} ${count(m.vertices).padStart(6)} verts ${count(m.triangles).padStart(6)} tris ${mb(bytes).padStart(9)}  ${m.license.split(/[:;(]/)[0].trim()}${modelPath(m) ? '  (fetched)' : ''}`);
    }
    console.log(`${models.length} models, ${mb(total)} to download in all`);
    return;
  }
  if (flags.has('--check')) {
    for (const m of models) for (const f of m.files) {
      const res = await fetch(f.url, { method: 'HEAD', headers, redirect: 'follow' }).catch(e => ({ ok: false, status: e.message, headers: new Headers() }));
      const len = Number(res.headers.get('content-length')) || null;
      const note = !res.ok ? `HTTP ${res.status}` : f.bytes != null && len != null && len !== f.bytes ? `size changed: ${len} (manifest ${f.bytes})` : 'ok';
      console.log(`${note === 'ok' ? 'ok  ' : 'FAIL'} ${m.id} ${f.name} ${mb(len)} ${note === 'ok' ? '' : note}`);
      if (note !== 'ok') process.exitCode = 1;
    }
    return;
  }
  for (const m of models) {
    console.log(`== ${m.id} (${m.name})`);
    try {
      for (const f of m.files) {
        if (f.extract) { await extractRemote(m, f); continue; }
        const { dest, fresh } = await download(m, f);
        if (fresh) {
          const sum = await sha256(dest);
          if (f.sha256 && f.sha256 !== sum) throw new Error(`${f.name}: checksum ${sum} does not match the manifest's ${f.sha256}`);
          if (!f.sha256) console.log(`     ${f.name}: sha256 ${sum} (not in the manifest yet)`);
        }
        unpack(dest);
      }
    } catch (e) {
      console.log(`FAIL ${m.id}: ${e.message}`);
      process.exitCode = 1;
      continue;
    }
    const p = modelPath(m);
    if (!p) { console.log(`FAIL ${m.id}: ${m.open} is missing after unpacking`); process.exitCode = 1; continue; }
    console.log(`ok   ${path.relative(process.cwd(), p)} (${mb(fs.statSync(p).size)})`);
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) main().catch(e => { console.error(e.message); process.exit(1); });
