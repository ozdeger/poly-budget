// Quad remeshing: all quads near the budget, closed where the input is, symmetric under a mirror plane, painted
// density, new UVs that keep each quad whole, and FBX/OBJ files that store quads.
import { THREE, core, S, settings, check, bumpySphere, sceneOf, context, layoutCheck, openEdges } from './helpers.js';
import { remeshQuads } from '../src/quad.js';

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
  const edgeGap = sharp => {
    const { result: r } = run(w3, { targetTris: 2000, symmetry: null, quadSharp: sharp });
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
  const crisp = edgeGap(45), round = edgeGap(0);
  check(crisp < 0.005 && crisp < round / 4, `sharp edges: the box's edges stay within ${crisp.toFixed(4)} of the remesh (${round.toFixed(4)} without)`);
}
