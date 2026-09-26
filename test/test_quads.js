// Quad remeshing: all quads near the budget, closed where the input is, symmetric under a mirror plane, painted
// density, new UVs that keep each quad whole, and FBX/OBJ files that store quads.
import { THREE, core, S, settings, check, bumpySphere, sceneOf, context, layoutCheck, openEdges } from './helpers.js';
import { remeshQuads, QUAD_NONE } from '../src/quad.js';

const quadsOf = r => { let n = 0; for (let t = 0; t < r.triCount; t++) if (r.quad[t] === 1) n++; return n; };
const loneOf = r => { let n = 0; for (let t = 0; t < r.triCount; t++) if (!r.quad[t]) n++; return n; };
const run = (w, st, fopt = { normals: 'smooth' }, labels = null) =>
  core.runReduction(S, context(w), labels, { ...settings, deferUV: false, bakeSize: 1024, ...st, topology: 'quads' }, fopt);

// The remesher alone: a closed shape gives a closed, all-quad mesh near the asked count.
for (const [name, geo, target] of [['torus', new THREE.TorusGeometry(1, 0.38, 48, 120), 1200], ['knot', new THREE.TorusKnotGeometry(0.8, 0.25, 300, 40), 1500]]) {
  const w = core.smartWeld(sceneOf(geo), { keepUV: false, hardAngle: 180 });
  const rq = remeshQuads({ positions: w.positions, index: w.index }, { targetFaces: target });
  const nv = rq.positions.length / 3, edges = new Map();
  for (let f = 0; f < rq.faceCount; f++) {
    const p = [...rq.faces.subarray(f * 4, f * 4 + 4)].filter(v => v !== 0xffffffff);
    for (let k = 0; k < p.length; k++) {
      const a = p[k], b = p[(k + 1) % p.length], key = a < b ? a * nv + b : b * nv + a;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  const open = [...edges.values()].filter(c => c === 1).length;
  check(rq.stats.others === 0 && Math.abs(rq.faceCount / target - 1) < 0.08 && open === 0,
    `${name}: ${rq.stats.quads} quads for ${target} asked, ${rq.stats.others} other faces, ${open} open edges (${rq.stats.ms} ms)`);
}

// Through the pipeline: a textured sphere becomes quads with new UVs, and each quad keeps one UV per corner.
const w = core.smartWeld(sceneOf(bumpySphere(160, 80)), { keepUV: true, hardAngle: 30 });
{
  const { result: r, info } = run(w, { targetTris: 3000, symmetry: null });
  const lc = layoutCheck(r), oe = openEdges(r);
  let broken = 0;
  for (let t = 0; t < r.triCount; t++) if (r.quad[t] === 1 && !core.quadCorners(r.index, t)) broken++;
  check(quadsOf(r) === info.quads && loneOf(r) === 0 && Math.abs(r.triCount / 3000 - 1) < 0.06,
    `sphere: ${info.quads} quads (${r.triCount} of 3000 triangles), no lone triangles`);
  check(r.uvLayout === 'new' && lc.overlap === 0 && lc.outside === 0 && lc.nan === 0 && broken === 0,
    `sphere: new UVs without overlap, every quad's two triangles share their corners (${info.atlas.charts} charts)`);
  check(oe.open === 0 && oe.nonManifold === 0, 'sphere: the quads close up with no open or non-manifold edges');
  check(info.poles.count < info.poles.inner * 0.3, `sphere: ${info.poles.count} poles among ${info.poles.inner} vertices`);
  // Files: OBJ writes 4-corner faces, FBX polygons end on their fourth corner.
  const objs = core.exportObjects(r, [{ name: 'Sphere' }], [{ name: 'Mat', color: [1, 1, 1] }], true, 'Sphere');
  const faces = core.writeOBJ(objs, { mtlName: 'a.mtl' }).obj.split('\n').filter(l => l.startsWith('f '));
  check(faces.length === info.quads && faces.every(l => l.split(' ').length === 5), `OBJ: ${faces.length} faces, all quads`);
  const fbx = core.writeFBX(objs, { unitScale: 1, fileName: 'a.fbx' }, JSON.parse((await import('fs')).readFileSync(new URL('../src/fbx_template.json', import.meta.url), 'utf8')));
  const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
  let loadedTris = 0;
  new FBXLoader().parse(fbx.buffer.slice(fbx.byteOffset, fbx.byteOffset + fbx.byteLength), '').traverse(o => { if (o.isMesh) loadedTris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  check(loadedTris === info.quads * 2, `FBX: loads back as ${loadedTris} triangles from ${info.quads} quads`);
}

// Under symmetry the kept half is remeshed and mirrored: every vertex pairs up, and the plane is an edge loop.
{
  const plane = { axis: 0, offset: 0, keepPositive: true };
  const { result: r, info } = run(w, { targetTris: 3000, symmetry: plane });
  const oe = openEdges(r);
  check(info.symmetry.paired === info.symmetry.total && loneOf(r) === 0 && oe.open === 0,
    `mirrored sphere: ${info.symmetry.paired}/${info.symmetry.total} vertices paired, ${info.quads} quads, closed along the plane`);
  // Mirrored halves share the texture: the kept half's quads keep their UVs whole too.
  let broken = 0;
  for (let t = 0; t < r.triCount; t++) if (r.quad[t] === 1 && !core.quadCorners(r.index, t)) broken++;
  check(broken === 0 && layoutCheck(r, r.triCount / 2).overlap === 0, 'mirrored sphere: the kept half unwraps with whole quads and no overlap');
}

// Painted detail: More detail on the top makes its quads smaller than the bottom's.
{
  const labels = new Int8Array(w.vertexCount);
  for (let v = 0; v < w.vertexCount; v++) if (w.positions[v * 3 + 1] > 0.3) labels[v] = core.LABEL.MORE2;
  const { result: r } = run(w, { targetTris: 3000, symmetry: null }, { normals: 'smooth' }, labels);
  let top = 0, bottom = 0;
  for (let t = 0; t < r.triCount; t++) {
    if (r.quad[t] !== 1) continue;
    const y = (r.positions[r.index[t * 3] * 3 + 1] + r.positions[r.index[t * 3 + 1] * 3 + 1] + r.positions[r.index[t * 3 + 2] * 3 + 1]) / 3;
    if (y > 0.5) top++; else if (y < -0.5) bottom++;
  }
  // The caps above 0.5 and below -0.5 have the same area; four times the density shows as about four times the quads.
  check(top > bottom * 2.5, `painted: ${top} quads on the painted cap, ${bottom} on the bare one`);
}

// Separate small pieces keep a few quads each instead of vanishing.
{
  const big = new THREE.SphereGeometry(1, 64, 32), small = new THREE.SphereGeometry(0.05, 16, 8).translate(2, 0, 0);
  const merged = new THREE.BufferGeometry();
  const nb = big.attributes.position.count;
  merged.setAttribute('position', new THREE.BufferAttribute(Float32Array.of(...big.attributes.position.array, ...small.attributes.position.array), 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(Float32Array.of(...big.attributes.normal.array, ...small.attributes.normal.array), 3));
  merged.setIndex([...big.index.array, ...[...small.index.array].map(i => i + nb)]);
  const w2 = core.smartWeld(sceneOf(merged), { keepUV: false, hardAngle: 30 });
  const { result: r } = run(w2, { targetTris: 1000, symmetry: null });
  let onSmall = 0;
  for (let t = 0; t < r.triCount; t++) if (r.quad[t] === 1 && r.positions[r.index[t * 3] * 3] > 1.5) onSmall++;
  check(onSmall >= 12, `small piece: keeps ${onSmall} quads next to the big sphere`);
}

// Sharp edges: a box keeps its edges and corners crisp instead of rounding them off.
{
  const w3 = core.smartWeld(sceneOf(new THREE.BoxGeometry(1.6, 1, 1, 48, 30, 30)), { keepUV: false, hardAngle: 30 });
  const edgeGap = (sharp, adapt = 0) => {
    const { result: r } = run(w3, { targetTris: 2000, symmetry: null, quadSharp: sharp, quadAdapt: adapt });
    const P = r.positions, idx = r.index;
    // Distance from points along the box's twelve edges to the remeshed surface.
    const dist = (x, y, z) => {
      let best = Infinity;
      for (let t = 0; t < idx.length; t += 3) {
        const a = new THREE.Vector3().fromArray(P, idx[t] * 3), b = new THREE.Vector3().fromArray(P, idx[t + 1] * 3), c = new THREE.Vector3().fromArray(P, idx[t + 2] * 3);
        const q = new THREE.Triangle(a, b, c).closestPointToPoint(new THREE.Vector3(x, y, z), new THREE.Vector3());
        best = Math.min(best, q.distanceTo(new THREE.Vector3(x, y, z)));
      }
      return best;
    };
    let worst = 0;
    const H = [0.8, 0.5, 0.5];
    for (let axis = 0; axis < 3; axis++) for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) for (let i = 1; i < 8; i++) {
      const p = [0, 0, 0], o = [(axis + 1) % 3, (axis + 2) % 3];
      p[axis] = -H[axis] + (2 * H[axis] * i) / 8; p[o[0]] = s1 * H[o[0]]; p[o[1]] = s2 * H[o[1]];
      worst = Math.max(worst, dist(...p));
    }
    return worst;
  };
  const crisp = edgeGap(45), round = edgeGap(0), shaped = edgeGap(45, 0.5);
  check(crisp < 0.005 && crisp < round / 4 && shaped < 0.005, `sharp edges: the box's edges stay within ${crisp.toFixed(4)} of the remesh (${shaped.toFixed(4)} following the shape, ${round.toFixed(4)} without sharp edges)`);
}

// Bumps that the mirror plane only grazes: the cut loop there is smaller than a quad and sags off the plane unless the
// whole loop is put back on it, which left gaps along the seam.
{
  let gaps = 0;
  for (const [dx, target] of [[0.02, 1200], [0.02, 2400], [0.04, 1200], [0.04, 2400]]) {
    const g = new THREE.SphereGeometry(1, 128, 64), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      let s = 1;
      for (const [cy, cz] of [[0.3, -0.9], [-0.2, -0.95], [0.6, -0.75], [-0.6, -0.78]]) s += 0.12 * Math.exp(-((x - dx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) / 0.004);
      p.setXYZ(i, x * s, y * s, z * s);
    }
    g.computeVertexNormals();
    const wb = core.smartWeld(sceneOf(g), { keepUV: false, hardAngle: 30 });
    const { result: r } = run(wb, { targetTris: target, symmetry: { axis: 0, offset: 0, keepPositive: true } });
    gaps += openEdges(r).open;
  }
  check(gaps === 0, `mirror seam: no gaps where the plane grazes small bumps (${gaps} open edges)`);
}

// Following the shape: a thin ridge around a sphere's middle bends far more than the rest, so with the density following
// curvature it gets a larger share of the same budget, and the ridge's worst gap to the original shrinks.
{
  const g = new THREE.SphereGeometry(1, 256, 128), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), s = 1 + 0.06 * Math.exp(-(y * y) / 0.0009);
    p.setXYZ(i, x * s, y * s, z * s);
  }
  g.computeVertexNormals();
  const wr = core.smartWeld(sceneOf(g), { keepUV: false, hardAngle: 180 });
  const ridge = adapt => {
    const { result: r } = run(wr, { targetTris: 3000, symmetry: null, quadAdapt: adapt });
    let inBand = 0, worst = 0;
    for (let t = 0; t < r.triCount; t++) {
      const y = (r.positions[r.index[t * 3] * 3 + 1] + r.positions[r.index[t * 3 + 1] * 3 + 1] + r.positions[r.index[t * 3 + 2] * 3 + 1]) / 3;
      if (Math.abs(y) < 0.08) inBand++;
    }
    // How far the ridge's crest (radius 1.06 at y = 0) sinks into the result: the result's largest radius near the equator.
    for (let v = 0; v < r.vertexCount; v++) if (Math.abs(r.positions[v * 3 + 1]) < 0.01) worst = Math.max(worst, Math.hypot(r.positions[v * 3], r.positions[v * 3 + 2]));
    return { share: inBand / r.triCount, crest: worst };
  };
  const even = ridge(0), shaped = ridge(0.8);
  check(shaped.share > even.share * 1.5 && shaped.crest >= even.crest - 1e-3,
    `follow the shape: the ridge gets ${(100 * shaped.share).toFixed(1)}% of the faces instead of ${(100 * even.share).toFixed(1)}%, crest radius ${shaped.crest.toFixed(3)} vs ${even.crest.toFixed(3)} (1.060 in the original)`);
}

// Long quads: a thin ring bends far more around its tube than along it, so following the shape makes its quads long
// along the ring and short around the tube, with more of them around for the same budget, and the faces' middles then
// sit closer to the ring's surface than with even squares.
{
  const R = 1, r0 = 0.12, wt = core.smartWeld(sceneOf(new THREE.TorusGeometry(R, r0, 48, 320)), { keepUV: false, hardAngle: 180 });
  const ring = adapt => {
    const rq = remeshQuads({ positions: wt.positions, index: wt.index }, { targetFaces: 240, adapt });
    const P = rq.positions, along = [], around = [], off = [];
    for (let f = 0; f < rq.faceCount; f++) {
      const q = [...rq.faces.subarray(f * 4, f * 4 + 4)].filter(v => v !== QUAD_NONE);
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < q.length; k++) {
        const a = q[k] * 3, b = q[(k + 1) % q.length] * 3;
        cx += P[a] / q.length; cy += P[a + 1] / q.length; cz += P[a + 2] / q.length;
        const ex = P[b] - P[a], ey = P[b + 1] - P[a + 1], ez = P[b + 2] - P[a + 2], el = Math.hypot(ex, ey, ez);
        const mx = (P[a] + P[b]) / 2, my = (P[a + 1] + P[b + 1]) / 2, ml = Math.hypot(mx, my) || 1;
        const c = Math.abs((-my * ex + mx * ey) / ml) / el;
        if (c > 0.8) along.push(el); else if (c < 0.3) around.push(el);
      }
      // How far the face's middle is from the ring's surface.
      off.push(Math.abs(Math.hypot(Math.hypot(cx, cy) - R, cz) - r0));
    }
    const med = a => a.sort((x, y) => x - y)[a.length >> 1];
    return { aspect: med(along) / med(around), around: (2 * Math.PI * r0) / med(around), mean: off.reduce((x, y) => x + y, 0) / off.length, faces: rq.faceCount };
  };
  const even = ring(0), long = ring(1);
  check(long.aspect > 1.8 && even.aspect < 1.3 && long.around > even.around * 1.3 && long.mean < even.mean * 0.8,
    `long quads: on a thin ring ${long.aspect.toFixed(1)}:1 quads with ${long.around.toFixed(1)} around the tube (even squares: ${even.aspect.toFixed(1)}:1, ${even.around.toFixed(1)} around), face middles ${long.mean.toFixed(4)} off the surface on average (${even.mean.toFixed(4)})`);
}

// Fewer poles: a torus with quads following its shape needs no poles at all, but steps that follow curvature alone
// can't close the grid around it, and it answers with pole pairs; steps fitted to what the direction field allows
// leave far fewer. Averaged over three budgets, since single remeshes vary.
{
  const wt = core.smartWeld(sceneOf(new THREE.TorusGeometry(1, 0.38, 64, 160)), { keepUV: false, hardAngle: 180 });
  const share = rq => {
    const nv = rq.positions.length / 3, deg = new Int32Array(nv), seen = new Set();
    for (let f = 0; f < rq.faceCount; f++) {
      const p = [...rq.faces.subarray(f * 4, f * 4 + 4)].filter(v => v !== QUAD_NONE);
      for (let k = 0; k < p.length; k++) {
        const a = p[k], b = p[(k + 1) % p.length], key = a < b ? a * nv + b : b * nv + a;
        if (!seen.has(key)) { seen.add(key); deg[a]++; deg[b]++; }
      }
    }
    let used = 0, irregular = 0;
    for (let v = 0; v < nv; v++) if (deg[v]) { used++; if (deg[v] !== 4) irregular++; }
    return irregular / used;
  };
  const mean = fit => [1300, 1500, 1700].reduce((s, t) => s + share(remeshQuads({ positions: wt.positions, index: wt.index }, { targetFaces: t, adapt: 1, fit })), 0) / 3;
  const fitted = mean(true), asked = mean(false);
  check(fitted < 0.7 * asked, `fewer poles: ${(100 * fitted).toFixed(1)}% of the torus's vertices are poles with fitted steps, ${(100 * asked).toFixed(1)}% without`);
}

// The budget: after one remesh of a surface the next lands within 5% on its first try, and asking for a budget again
// gives the same faces whatever was asked in between.
{
  const wk = core.smartWeld(sceneOf(new THREE.TorusKnotGeometry(0.8, 0.25, 300, 40)), { keepUV: false, hardAngle: 180 });
  const cache = {}, mesh = { positions: wk.positions, index: wk.index };
  const a = remeshQuads(mesh, { targetFaces: 1500, adapt: 1, cache, cacheKey: 'k' });
  const b = remeshQuads(mesh, { targetFaces: 1100, adapt: 1, cache, cacheKey: 'k' });
  const c = remeshQuads(mesh, { targetFaces: 1500, adapt: 1, cache, cacheKey: 'k' });
  const same = a.faceCount === c.faceCount && a.positions.length === c.positions.length && a.positions.every((x, i) => x === c.positions[i]);
  check(b.stats.attempts.length === 1 && Math.abs(b.faceCount / 1100 - 1) < 0.05 && same,
    `budget: ${b.faceCount} faces for 1100 on the first try after a remesh at 1500; 1500 again gives the same ${c.faceCount} faces`);
}
