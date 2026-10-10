import { MeshoptSimplifier } from 'https://cdn.jsdelivr.net/npm/meshoptimizer@1.2.0/meshopt_simplifier.js';
import { packAttributes, runReduction, mirrorOriginal, unwrapResult } from './core.js';
import { computeVisibility } from './visibility.js';
import { formDensity } from './quad.js';
import * as RIG from './rig.js';
import * as SKIN from './skin.js';

// One context per tab: the welded mesh, its packed attributes and the caches runReduction keeps.
const ctxs = new Map();

self.onmessage = async ({ data }) => {
  try {
    // Hidden areas run in a worker of their own and report how far they got (at most every 100 ms).
    if (data.type === 'visibility') {
      let last = 0;
      const progress = frac => {
        const now = Date.now();
        if (now - last < 100) return;
        last = now;
        self.postMessage({ type: 'progress', id: data.id, frac });
      };
      const { vis, stats } = computeVisibility(data.mesh, { progress });
      // How strongly each spot bends: small curved parts keep their faces even where they are hidden.
      const curve = formDensity(data.mesh.positions, data.mesh.index, null, null, 1);
      self.postMessage({ type: 'visibility', id: data.id, vis, curve, stats }, [vis.buffer, curve.buffer]);
      return;
    }
    // A result's visibility, for the bake: few rays are enough to tell surfaces in plain view from ones out of sight.
    if (data.type === 'resultVisibility') {
      const { vis } = computeVisibility(data.mesh, { rays: data.rays });
      self.postMessage({ type: 'resultVisibility', id: data.id, vis }, [vis.buffer]);
      return;
    }
    // Rigging: a skeleton found on the result (unless one is given) and its weights by bone heat.
    if (data.type === 'rig') {
      const placed = data.rig ? { rig: data.rig, report: null } : RIG.placeHumanoid(data.mesh, data.opt || {});
      const heat = SKIN.boneHeat(data.mesh, placed.rig, data.joints ? { joints: data.joints, W: data.W } : {});
      const g = heat.groups;
      self.postMessage({ type: 'rigged', id: data.id, rig: placed.rig, report: placed.report, W: heat.W, group: g.group, count: g.count, positions: g.positions, stats: heat.stats },
        [heat.W.buffer, g.group.buffer, g.positions.buffer]);
      return;
    }
    if (data.type === 'unwrap') {
      // A paintable layout puts its seams where the surface is seen least: a quick visibility pass first.
      const vis = data.style === 'paint' ? computeVisibility(data.mesh, { rays: data.rays }).vis : null;
      const out = unwrapResult(data.mesh, data.plane, data.labels, data.size, { style: data.style, vis, colors: data.colors }), r = out.result;
      const transfer = [r.positions.buffer, r.normals.buffer, r.index.buffer, r.vPart.buffer, r.vMat.buffer, r.srcId.buffer, r.uvs.buffer];
      if (r.twin) transfer.push(r.twin.buffer);
      if (r.colors) transfer.push(r.colors.buffer);
      if (r.quad) transfer.push(r.quad.buffer);
      self.postMessage({ type: 'unwrapped', id: data.id, ...out }, transfer);
      return;
    }
    await MeshoptSimplifier.ready;
    if (data.type === 'load') {
      ctxs.set(data.doc, { mesh: data.mesh, packed: packAttributes(data.mesh), half: null });
      self.postMessage({ type: 'loaded', id: data.id });
      return;
    }
    if (data.type === 'unload') {
      ctxs.delete(data.doc);
      self.postMessage({ type: 'unloaded', id: data.id });
      return;
    }
    const ctx = ctxs.get(data.doc);
    if (!ctx) throw new Error('that tab has no model loaded');
    if (data.type === 'mirror') {
      const result = mirrorOriginal(ctx, data.plane);
      const transfer = [result.positions.buffer, result.normals.buffer, result.index.buffer, result.vPart.buffer, result.vMat.buffer, result.srcId.buffer, result.twin.buffer];
      if (result.uvs) transfer.push(result.uvs.buffer);
      if (result.colors) transfer.push(result.colors.buffer);
      self.postMessage({ type: 'mirrored', id: data.id, result }, transfer);
      return;
    }
    if (data.type === 'reduce') {
      // Remeshing takes seconds, so it reports how far it got (at most every 100 ms).
      let last = 0;
      const progress = (stage, frac) => {
        const now = Date.now();
        if (now - last < 100) return;
        last = now;
        self.postMessage({ type: 'progress', id: data.id, stage, frac });
      };
      const { result, info } = runReduction(MeshoptSimplifier, ctx, data.labels, data.settings, data.finalize, progress);
      const transfer = [result.positions.buffer, result.normals.buffer, result.index.buffer, result.vPart.buffer, result.vMat.buffer, result.srcId.buffer];
      if (result.twin) transfer.push(result.twin.buffer);
      if (result.uvs) transfer.push(result.uvs.buffer);
      if (result.colors) transfer.push(result.colors.buffer);
      if (result.quad) transfer.push(result.quad.buffer);
      self.postMessage({ type: 'reduced', id: data.id, result, info }, transfer);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, message: String((err && err.message) || err) });
  }
};
