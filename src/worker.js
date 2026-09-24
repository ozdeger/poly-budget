import { MeshoptSimplifier } from 'https://cdn.jsdelivr.net/npm/meshoptimizer@1.2.0/meshopt_simplifier.js';
import { packAttributes, runReduction, mirrorOriginal, unwrapResult } from './core.js';

let ctx = null;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'unwrap') {
      const out = unwrapResult(data.mesh, data.plane, data.labels, data.size), r = out.result;
      const transfer = [r.positions.buffer, r.normals.buffer, r.index.buffer, r.vPart.buffer, r.vMat.buffer, r.srcId.buffer, r.uvs.buffer];
      if (r.twin) transfer.push(r.twin.buffer);
      if (r.colors) transfer.push(r.colors.buffer);
      self.postMessage({ type: 'unwrapped', id: data.id, ...out }, transfer);
      return;
    }
    await MeshoptSimplifier.ready;
    if (data.type === 'load') {
      ctx = { mesh: data.mesh, packed: packAttributes(data.mesh), half: null };
      self.postMessage({ type: 'loaded', id: data.id });
      return;
    }
    if (data.type === 'mirror') {
      const result = mirrorOriginal(ctx, data.plane);
      const transfer = [result.positions.buffer, result.normals.buffer, result.index.buffer, result.vPart.buffer, result.vMat.buffer, result.srcId.buffer, result.twin.buffer];
      if (result.uvs) transfer.push(result.uvs.buffer);
      if (result.colors) transfer.push(result.colors.buffer);
      self.postMessage({ type: 'mirrored', id: data.id, result }, transfer);
      return;
    }
    if (data.type === 'reduce') {
      const { result, info } = runReduction(MeshoptSimplifier, ctx, data.labels, data.settings, data.finalize);
      const transfer = [result.positions.buffer, result.normals.buffer, result.index.buffer, result.vPart.buffer, result.vMat.buffer, result.srcId.buffer];
      if (result.twin) transfer.push(result.twin.buffer);
      if (result.uvs) transfer.push(result.uvs.buffer);
      if (result.colors) transfer.push(result.colors.buffer);
      self.postMessage({ type: 'reduced', id: data.id, result, info }, transfer);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, message: String((err && err.message) || err) });
  }
};
