// UV layout edges for the texture panel: unique edges, seams, and which vertex copies count as one.
import { THREE, core, check } from './helpers.js';

const meshOf = geo => {
  const g = geo.index ? geo : geo.setIndex([...Array(geo.attributes.position.count).keys()]);
  return { positions: Float32Array.from(g.attributes.position.array), uvs: Float32Array.from(g.attributes.uv.array), index: Uint32Array.from(g.index.array) };
};
const count = r => ({ edges: r.edges.length / 2, seams: r.seams.length / 2 });

// A 4 x 4 grid: 20 + 20 straight edges and 16 diagonals; its 16 border edges are the seams.
{
  const c = count(core.uvEdges(meshOf(new THREE.PlaneGeometry(1, 1, 4, 4))));
  check(c.edges === 56 && c.seams === 16, `grid: ${c.edges} edges and ${c.seams} seams (56 and 16)`);
}
// The same grid with a copy of every vertex per triangle, as flat-shaded files store it: the copies count as one.
{
  const c = count(core.uvEdges(meshOf(new THREE.PlaneGeometry(1, 1, 4, 4).toNonIndexed())));
  check(c.edges === 56 && c.seams === 16, `split grid: ${c.edges} edges and ${c.seams} seams, as if welded`);
}
// Two quads in different places sharing the same UVs (stacked mirrored islands) keep their own borders.
{
  const a = meshOf(new THREE.PlaneGeometry(1, 1)), b = meshOf(new THREE.PlaneGeometry(1, 1).translate(3, 0, 0));
  const m = {
    positions: Float32Array.of(...a.positions, ...b.positions),
    uvs: Float32Array.of(...a.uvs, ...b.uvs),
    index: Uint32Array.of(...a.index, ...b.index.map(i => i + 4)),
  };
  const c = count(core.uvEdges(m));
  check(c.edges === 10 && c.seams === 8, `stacked islands: ${c.edges} edges and ${c.seams} seams (10 and 8)`);
}
// A box has one island per face: 6 x 5 edges, 6 x 4 of them seams.
{
  const c = count(core.uvEdges(meshOf(new THREE.BoxGeometry(1, 1, 1))));
  check(c.edges === 30 && c.seams === 24, `box: ${c.edges} edges and ${c.seams} seams (30 and 24)`);
}
// keep() and triEnd pick triangles: the first face of the box alone is one quad.
{
  const m = meshOf(new THREE.BoxGeometry(1, 1, 1));
  const a = count(core.uvEdges(m, t => t < 2)), b = count(core.uvEdges(m, null, 2));
  check(a.edges === 5 && a.seams === 4 && b.edges === 5 && b.seams === 4, 'keep() and triEnd limit the triangles');
}
// Every pair points at real vertices.
{
  const m = meshOf(new THREE.TorusKnotGeometry(1, 0.3, 64, 8));
  const r = core.uvEdges(m), V = m.uvs.length / 2;
  check(r.edges.every(v => v < V) && r.seams.every(v => v < V) && r.seams.length < r.edges.length, `torus knot: ${r.edges.length / 2} edges, ${r.seams.length / 2} seams, all in range`);
}
