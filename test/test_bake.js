// The texture bake's reach, how far its rays look for the original: measured on the faces around each vertex, so a
// separate part close in front of a well-fitting surface stays out of reach while a spot that strays far still reaches
// its own.
import { THREE, core, check } from './helpers.js';

// The original: a unit sphere, and a plate 0.08 in front of it at +Z, as glasses sit over a cheek.
const plate = (x, y, z) => Math.hypot(Math.max(Math.abs(x) - 0.3, 0), Math.max(Math.abs(y) - 0.3, 0), z - 1.08);
const dist = (x, y, z) => Math.min(Math.abs(Math.hypot(x, y, z) - 1), plate(x, y, z));
// The result: an icosphere of 1,620 triangles (a copy of each vertex per triangle, as seams leave them) with its lowest
// vertex in Z pulled 0.3 out.
const geo = new THREE.IcosahedronGeometry(1, 8), P = Float32Array.from(geo.attributes.position.array), V = P.length / 3;
let low = Infinity;
for (let v = 0; v < V; v++) low = Math.min(low, P[v * 3 + 2]);
for (let v = 0; v < V; v++) if (P[v * 3 + 2] === low) P[v * 3 + 2] -= 0.3;
const mesh = { positions: P, index: Uint32Array.from({ length: V }, (_, i) => i), vertexCount: V, triCount: V / 3 };
const reach = await core.bakeReach(mesh, mesh.triCount, dist, 0.001, 0.5);

// Every vertex reaches twice the farthest sample (centre, edge midpoints) of the triangles at its position.
const far = new Map(), key = v => `${P[v * 3]},${P[v * 3 + 1]},${P[v * 3 + 2]}`;
for (let t = 0; t < mesh.triCount; t++) {
  let m = 0;
  for (const w of [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]]) {
    const q = [0, 1, 2].map(k => w[0] * P[t * 9 + k] + w[1] * P[t * 9 + 3 + k] + w[2] * P[t * 9 + 6 + k]);
    m = Math.max(m, dist(...q));
  }
  for (let c = 0; c < 3; c++) far.set(key(t * 3 + c), Math.max(far.get(key(t * 3 + c)) || 0, m));
}
let wrong = 0;
for (let v = 0; v < V; v++) if (Math.abs(reach[v] - Math.min(0.5, Math.max(0.001, 2 * far.get(key(v))))) > 1e-6) wrong++;
check(wrong === 0, `reach is twice the farthest sample around each position, the same on every copy there (${wrong} of ${V} off)`);

// Under the plate the faces fit the sphere closely, so the plate stays out of reach; the pulled vertex reaches far.
let front = 0, pole = Infinity;
for (let v = 0; v < V; v++) {
  if (P[v * 3 + 2] > 0.9) front = Math.max(front, reach[v]);
  if (P[v * 3 + 2] < low - 0.2) pole = Math.min(pole, reach[v]);
}
check(front < 0.01 && pole > 0.2, `under the plate the reach is ${front.toFixed(4)} (the plate is 0.08 away), at the pulled vertex ${pole.toFixed(3)}`);

// A pause answering false stops the work.
const stopped = await core.bakeReach(mesh, mesh.triCount, dist, 0.001, 0.5, async () => false);
check(stopped === null, 'stops when the job is no longer current');
