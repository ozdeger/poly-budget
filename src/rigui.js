// The Rig workspace: a skeleton on the result, found from its shape or built by hand, its weights, and what the export
// takes from them. The skeleton draws in the reduced view's scene, over the model; app.js hands over what the workspace
// needs (initRig's host) and calls back in where the workspace changes what the page does.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import * as RIG from './rig.js';
import * as SKIN from './skin.js';

// Joint colours: the figure's left blue, its right red, the middle light; joints placed by proportion amber.
const SIDE_COLOR = { L: 0x5a96ff, R: 0xff6262, C: 0xe9e2d6 };
const EST_COLOR = 0xf0b23c, SEL_COLOR = 0xffffff;
const HISTORY = 60;

// A bone as Blender draws one: an octahedron from the joint (y = 0) to its child (y = 1), widest a tenth of the way.
function boneGeometry() {
  const w = 0.1, s = 0.1;
  const v = [[0, 0, 0], [w, s, w], [w, s, -w], [-w, s, -w], [-w, s, w], [0, 1, 0]];
  const f = [[0, 2, 1], [0, 3, 2], [0, 4, 3], [0, 1, 4], [5, 1, 2], [5, 2, 3], [5, 3, 4], [5, 4, 1]];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(f.flatMap(t => t.flatMap(i => v[i]))), 3));
  g.computeVertexNormals();
  return g;
}

// Heat colours for one joint's weights, as Blender shows them: blue at 0, through green and yellow, red at 1.
function heat(w, out, o) {
  const stops = [[0, [24, 40, 150]], [0.25, [20, 160, 220]], [0.5, [40, 200, 80]], [0.75, [240, 220, 40]], [1, [235, 50, 30]]];
  let i = 1;
  while (i < stops.length - 1 && w > stops[i][0]) i++;
  const [a, ca] = stops[i - 1], [b, cb] = stops[i], t = Math.min(1, Math.max(0, (w - a) / (b - a)));
  for (let k = 0; k < 3; k++) out[o + k] = Math.round(ca[k] + (cb[k] - ca[k]) * t);
}
// A colour per joint for the all-joints view: hues spread by the golden angle.
function jointHue(j, out) {
  const c = new THREE.Color().setHSL((j * 0.381966) % 1, 0.65, 0.55);
  out[0] = c.r * 255; out[1] = c.g * 255; out[2] = c.b * 255;
}

export function initRig(host) {
  const { $, settings } = host;
  const st = () => host.state();
  // The tab's rig: { rig, weights: { W, groups, res }, edited, stale, report, undo, redo, selected }.
  const R = () => st() && st().rig;
  const ensure = () => {
    const s = st();
    if (!s.rig) s.rig = { rig: null, weights: null, edited: false, stale: false, report: null, undo: [], redo: [], selected: -1, busy: null, pose: null, rootOffset: null };
    return s.rig;
  };
  const inRig = () => settings.space === 'rig';

  // ---------- the skeleton overlay ----------
  const overlay = new THREE.Group();
  overlay.visible = false;
  host.sceneR.add(overlay);
  const boneGeo = boneGeometry(), jointGeo = new THREE.SphereGeometry(1, 16, 12);
  // Drawn twice: faintly through the model, solid where in front of it.
  const backMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthTest: false, depthWrite: false });
  const frontMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.96 });
  let capacity = 0, bones = null, joints = null;
  function makeInstances(n) {
    for (const m of [bones, joints]) if (m) { overlay.remove(m.back, m.front); m.back.dispose(); m.front.dispose(); }
    capacity = Math.max(64, n * 2);
    const pair = (geo, order) => {
      const back = new THREE.InstancedMesh(geo, backMat, capacity), front = new THREE.InstancedMesh(geo, frontMat, capacity);
      back.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      front.instanceMatrix = back.instanceMatrix;
      front.instanceColor = back.instanceColor;
      back.renderOrder = order; front.renderOrder = order + 1;
      back.frustumCulled = front.frustumCulled = false;
      overlay.add(back, front);
      return { back, front };
    };
    bones = pair(boneGeo, 30);
    joints = pair(jointGeo, 32);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), yAxis = new THREE.Vector3(0, 1, 0), tmp = new THREE.Vector3(), col = new THREE.Color();
  // Where each joint shows: at rest, or posed.
  const shownAt = i => (posedWorld && posing() ? [posedWorld[i * 16 + 12], posedWorld[i * 16 + 13], posedWorld[i * 16 + 14]] : R().rig.joints[i].pos);
  function drawSkeleton() {
    const s = R(), rig = s && s.rig;
    overlay.visible = inRig() && !!rig && settings.rigShowBones !== false;
    if (!rig) { host.requestRender(); return; }
    const n = rig.joints.length;
    if (n > capacity || !bones) makeInstances(n);
    const diag = st().diag || 1, sel = s.selected;
    let nb = 0;
    rig.joints.forEach((j, i) => {
      if (j.parent < 0) return;
      const a = shownAt(j.parent), b = shownAt(i), d = tmp.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]), l = d.length();
      if (!(l > 1e-9)) return;
      q.setFromUnitVectors(yAxis, d.normalize());
      const w = Math.min(Math.max(l, diag * 0.02), diag * 0.12);
      m4.compose(new THREE.Vector3(...a), q, new THREE.Vector3(w, l, w));
      bones.back.setMatrixAt(nb, m4);
      const p = rig.joints[j.parent];
      col.setHex(j.parent === sel ? SEL_COLOR : SIDE_COLOR[p.side] || SIDE_COLOR.C);
      bones.back.setColorAt(nb, col);
      nb++;
    });
    rig.joints.forEach((j, i) => {
      const r = diag * (i === sel ? 0.0085 : 0.006);
      m4.compose(new THREE.Vector3(...shownAt(i)), q.identity(), new THREE.Vector3(r, r, r));
      joints.back.setMatrixAt(i, m4);
      col.setHex(i === sel ? SEL_COLOR : j.placed === 'estimated' ? EST_COLOR : SIDE_COLOR[j.side] || SIDE_COLOR.C);
      joints.back.setColorAt(i, col);
    });
    for (const m of [bones, joints]) {
      m.back.instanceMatrix.needsUpdate = true;
      m.back.instanceColor.needsUpdate = true;
    }
    bones.back.count = bones.front.count = nb;
    joints.back.count = joints.front.count = n;
    host.requestRender();
  }

  // ---------- picking ----------
  const rect = () => host.rects().R;
  const vp = () => host.viewport.getBoundingClientRect();
  function screenOf(p) {
    const rc = rect();
    host.camera.aspect = rc.w / Math.max(1, rc.h);
    host.camera.updateProjectionMatrix();
    const v = tmp.set(p[0], p[1], p[2]).project(host.camera);
    return { x: rc.x + ((v.x + 1) / 2) * rc.w, y: rc.y + ((1 - v.y) / 2) * rc.h, z: v.z };
  }
  function pointer(e) { const b = vp(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }
  function rayAt(e) {
    const rc = rect(), { x, y } = pointer(e);
    host.camera.aspect = rc.w / Math.max(1, rc.h);
    host.camera.updateProjectionMatrix();
    const rc2 = new THREE.Raycaster();
    rc2.setFromCamera(new THREE.Vector2(((x - rc.x) / rc.w) * 2 - 1, -((y - rc.y) / rc.h) * 2 + 1), host.camera);
    return rc2.ray;
  }
  // The joint under the pointer (within 12 px, the nearest to the camera of those as close), or -1.
  function pickJoint(e) {
    const rig = R() && R().rig;
    if (!rig) return -1;
    const { x, y } = pointer(e);
    let best = -1, bd = 12, bz = Infinity;
    rig.joints.forEach((j, i) => {
      const s = screenOf(shownAt(i)), d = Math.hypot(s.x - x, s.y - y);
      if (s.z > 1) return;
      if (d < bd - 2 || (d < bd + 2 && s.z < bz)) { best = i; bd = Math.min(bd, d); bz = s.z; }
    });
    return best;
  }
  // The bone under the pointer (within 7 px of its line): the joint it starts from, or -1.
  function pickBone(e) {
    const rig = R() && R().rig;
    if (!rig) return -1;
    const { x, y } = pointer(e);
    let best = -1, bd = 7;
    rig.joints.forEach((j, i) => {
      if (j.parent < 0) return;
      const a = screenOf(shownAt(j.parent)), b = screenOf(shownAt(i));
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
      const d = Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
      if (d < bd) { bd = d; best = j.parent; }
    });
    return best;
  }
  // The result's surface for rays, built once per display (on its own index, as a BVH reorders the one it's given).
  let bvh = null, bvhOf = null;
  function surfaceTree() {
    const d = host.display();
    if (!d) return null;
    if (bvhOf !== d.geo) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', d.geo.attributes.position);
      g.setIndex(new THREE.BufferAttribute(d.geo.index.array.slice(), 1));
      bvh = new host.MeshBVH(g);
      bvhOf = d.geo;
    }
    return bvh;
  }
  // Where the line under the pointer passes through the middle of the solid it first enters: halfway between that
  // surface and the one it leaves by. Null when it misses the model.
  function middleUnder(ray) {
    const tree = surfaceTree();
    if (!tree) return null;
    const hits = tree.raycast(ray, THREE.DoubleSide).sort((a, b) => a.distance - b.distance);
    if (!hits.length) return null;
    if (hits.length === 1) return hits[0].point.toArray();
    return hits[0].point.clone().lerp(hits[1].point, 0.5).toArray();
  }
  // Where the line under the pointer crosses the plane facing the camera through p.
  function onViewPlane(ray, p) {
    const n = host.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(...p));
    const out = ray.intersectPlane(plane, new THREE.Vector3());
    return out ? out.toArray() : p;
  }

  // ---------- editing ----------
  const mirrorOf = (rig, p) => {
    if (!rig.plane) return p;
    const out = [...p];
    out[rig.plane.axis] = 2 * rig.plane.offset - out[rig.plane.axis];
    return out;
  };
  const onPlane = (rig, p) => { if (!rig.plane) return p; const out = [...p]; out[rig.plane.axis] = rig.plane.offset; return out; };
  const mirrorEdits = () => settings.rigMirror !== false;
  // Moves joint i to p; its mirror image follows, a middle joint stays on the plane, and with `subtree` everything below
  // it comes along.
  function moveJoint(rig, i, p, subtree) {
    const j = rig.joints[i];
    if (j.side === 'C' && rig.plane && mirrorEdits()) p = onPlane(rig, p);
    const delta = RIG.sub(p, j.pos);
    const moved = new Set([i]);
    if (subtree) {
      const kids = RIG.childrenOf(rig), stack = [i];
      while (stack.length) for (const c of kids[stack.pop()]) { moved.add(c); stack.push(c); }
    }
    for (const k of moved) {
      rig.joints[k].pos = RIG.add(rig.joints[k].pos, delta);
      rig.joints[k].placed = 'user';
      const m = rig.joints[k].mirror;
      if (m >= 0 && mirrorEdits() && !moved.has(m)) { rig.joints[m].pos = mirrorOf(rig, rig.joints[k].pos); rig.joints[m].placed = 'user'; }
    }
  }

  // History of the rig's edits: skeletons as they were (weights follow them by being worked out again), and poses.
  function commit(before, kind = 'rig') {
    const s = ensure();
    s.undo.push({ kind, value: before });
    if (s.undo.length > HISTORY) s.undo.shift();
    s.redo.length = 0;
  }
  const poseCopy = s => ({ pose: s.pose ? s.pose.map(q => q && [...q]) : null, rootOffset: s.rootOffset });
  function undoRedo(redo) {
    const s = R();
    if (!s) return;
    const from = redo ? s.redo : s.undo, to = redo ? s.undo : s.redo;
    if (!from.length) return;
    const entry = from.pop();
    if (entry.kind === 'pose') {
      to.push({ kind: 'pose', value: poseCopy(s) });
      ({ pose: s.pose, rootOffset: s.rootOffset } = entry.value);
      refreshPose();
      drawSkeleton();
      return;
    }
    to.push({ kind: 'rig', value: RIG.cloneRig(s.rig) });
    s.rig = entry.value;
    s.selected = s.rig && s.selected < s.rig.joints.length ? s.selected : -1;
    if (s.pose && (!s.rig || s.pose.length !== s.rig.joints.length)) s.pose = null;
    skeletonChanged();
  }

  // The skeleton changed shape: orientations again, the weights out of date (worked out again unless painted by hand).
  function skeletonChanged(reweight = true) {
    const s = R();
    if (s.rig) RIG.orientJoints(s.rig);
    if (reweight && s.rig && s.weights) {
      s.stale = true;
      if (!s.edited) scheduleWeights();
    }
    if (!s.rig) { s.weights = null; s.pose = null; }
    if (s.pose && s.rig && s.pose.length !== s.rig.joints.length) s.pose = null;
    refreshPose();
    drawSkeleton();
    paintWeights();
    updatePanels();
    host.saveSessionSoon();
  }

  // ---------- the worker ----------
  // One job at a time, as the visibility pass runs: a new one ends the one still running.
  const engine = {
    worker: null, seq: 0, job: null, failed: false,
    cancel() {
      if (!this.job) return;
      this.job.reject(new Error('cancelled'));
      this.job = null;
      if (this.worker) this.worker.terminate();
      this.worker = null;
    },
    run(msg) {
      this.cancel();
      if (!this.failed && !this.worker) {
        try {
          this.worker = new Worker(host.workerSource(), { type: 'module' });
          this.worker.onmessage = ({ data }) => {
            const job = this.job;
            if (!job || data.id !== job.id) return;
            this.job = null;
            if (data.type === 'error') job.reject(new Error(data.message)); else job.resolve(data);
          };
          this.worker.onerror = e => {
            e.preventDefault();
            this.failed = true;
            const job = this.job;
            this.job = null;
            this.worker.terminate();
            this.worker = null;
            if (job) this.runLocal(job.msg).then(job.resolve, job.reject);
          };
        } catch { this.failed = true; }
      }
      if (this.failed) return this.runLocal(msg);
      return new Promise((resolve, reject) => {
        this.job = { id: ++this.seq, resolve, reject, msg };
        this.worker.postMessage({ ...msg, id: this.job.id });
      });
    },
    async runLocal(msg) {
      await new Promise(r => setTimeout(r, 0));
      const placed = msg.rig ? { rig: msg.rig, report: null } : RIG.placeHumanoid(msg.mesh, msg.opt || {});
      const h = SKIN.boneHeat(msg.mesh, placed.rig);
      return { rig: placed.rig, report: placed.report, W: h.W, group: h.groups.group, count: h.groups.count, positions: h.groups.positions, stats: h.stats };
    },
  };
  const meshOf = res => ({ positions: res.positions, index: res.index, twin: res.twin || null });
  const planeOf = () => {
    const p = host.symPlane();
    return settings.symmetry && p.ready ? { axis: p.axis, offset: p.offset } : null;
  };

  let busyDoc = null;
  async function runRig(what) {
    const res = st().result, s = ensure(), d = host.doc();
    if (!res) return;
    const msg = what === 'place'
      ? { type: 'rig', mesh: meshOf(res), plane: planeOf(), opt: { fingers: settings.rigFingers, naming: settings.rigNaming, plane: planeOf() } }
      : { type: 'rig', mesh: meshOf(res), rig: RIG.cloneRig(s.rig) };
    s.busy = what;
    busyDoc = d;
    updatePanels();
    try {
      const out = await engine.run(msg);
      if (host.doc() !== d || st().result !== res) return;
      if (what === 'place') {
        commit(s.rig ? RIG.cloneRig(s.rig) : null);
        s.rig = out.rig;
        s.report = out.report;
        s.selected = -1;
      }
      s.weights = { W: out.W, groups: { group: out.group, count: out.count, positions: out.positions }, res, joints: s.rig.joints.length };
      s.edited = false;
      s.stale = false;
      if (out.stats && out.stats.ms) s.weightMs = out.stats.ms;
    } catch (err) {
      if (err && err.message === 'cancelled') return;
      console.error(err);
      host.showError(`Couldn't ${what === 'place' ? 'find the skeleton' : 'work out the weights'}: ${err.message || err}`);
    } finally {
      if (busyDoc === d) busyDoc = null;
      s.busy = null;
      if (host.doc() === d) {
        refreshPose();
        drawSkeleton();
        paintWeights();
        updatePanels();
        host.saveSessionSoon();
      }
    }
  }
  let weightTimer = 0;
  function scheduleWeights(delay = 350) {
    clearTimeout(weightTimer);
    weightTimer = setTimeout(() => { const s = R(); if (s && s.rig && inRig()) runRig('weights'); }, delay);
  }

  // A new result (another budget, or the same one with its UVs): weights carry over where every position is still there
  // (UV seams only split vertices); otherwise they are worked out again, or marked out of date where painted by hand.
  function onResult(res) {
    bvhOf = null;
    const s = R();
    if (!s || !s.rig) { sync(); return; }
    const w = s.weights;
    if (w && w.res !== res) {
      const groups = SKIN.skinGroups(res);
      const W = SKIN.remapWeights(w.W, s.rig.joints.length, w.groups.positions, groups);
      if (W) s.weights = { W, groups, res, joints: s.rig.joints.length };
      else {
        s.weights = null;
        s.stale = true;
        if (!s.edited && inRig()) scheduleWeights(0);
      }
    } else if (!w && inRig() && !s.busy) scheduleWeights(0);
    sync();
  }

  // ---------- the weights on the model ----------
  const showWeights = () => inRig() && settings.rigShowWeights !== false && !!(R() && R().weights && R().weights.res === st().result);
  function paintWeights() {
    const d = host.display(), s = R();
    if (!d) return;
    if (!showWeights()) { if (inRig()) d.paint.visible = false; host.requestRender(); return; }
    const { W, groups } = s.weights, B = s.rig.joints.length, sel = s.selected, C = d.colors, V = C.length / 4;
    const rgb = [0, 0, 0], hue = s.rig.joints.map((_, j) => { const c = [0, 0, 0]; jointHue(j, c); return c; });
    for (let v = 0; v < V; v++) {
      const g = groups.group[v], o = v * 4;
      if (sel >= 0) {
        heat(W[g * B + sel], C, o);
      } else {
        rgb[0] = rgb[1] = rgb[2] = 0;
        for (let b = 0; b < B; b++) { const x = W[g * B + b]; if (x > 0) for (let k = 0; k < 3; k++) rgb[k] += x * hue[b][k]; }
        C[o] = rgb[0]; C[o + 1] = rgb[1]; C[o + 2] = rgb[2];
      }
      C[o + 3] = sel >= 0 ? 215 : 150;
    }
    d.paintGeo.attributes.color.clearUpdateRanges();
    d.paintGeo.attributes.color.needsUpdate = true;
    d.paint.visible = true;
    host.requestRender();
  }

  // ---------- posing ----------
  // The reduced view's model bent by the skeleton, by linear blend skinning as engines do it. The view's geometry shares
  // its positions with the result, so posing gives it copies (the paint overlay and quad wireframe take them too); the
  // surface with tangents, when there is one, is a copy already and is posed in place from its rest values.
  let poser = null, posedWorld = null, playing = null;
  const posing = () => inRig() && !!(R() && R().rig) && (settings.rigTool === 'pose' || !!playing);
  function ensurePoser() {
    const d = host.display(), s = R();
    if (!d || !s || !s.rig || !s.weights || s.weights.res !== st().result) return null;
    if (poser && poser.d === d && poser.W === s.weights.W && poser.B === s.rig.joints.length) return poser;
    if (poser && poser.d === d) restPose();
    const B = s.rig.joints.length, { W, groups } = s.weights, sk = SKIN.vertexSkin(groups.group, SKIN.limitWeights(W, groups.count, B));
    const geo = d.geo, restP = geo.attributes.position.array, restN = geo.attributes.normal.array;
    const pos = poser && poser.d === d ? poser.pos : new THREE.BufferAttribute(restP.slice(), 3), nrm = poser && poser.d === d ? poser.nrm : new THREE.BufferAttribute(restN.slice(), 3);
    if (geo.attributes.position !== pos) {
      geo.setAttribute('position', pos);
      geo.setAttribute('normal', nrm);
      d.paintGeo.setAttribute('position', pos);
      if (d.wireGeo) d.wireGeo.setAttribute('position', pos);
    }
    let surf = null;
    if (d.surfGeo !== d.geo) {
      const sg = d.surfGeo, corner = sg.userData.cornerVertex, n = corner.length;
      const ci = new Uint16Array(n * 4), cw = new Float32Array(n * 4);
      for (let c = 0; c < n; c++) for (let k = 0; k < 4; k++) { ci[c * 4 + k] = sk.index[corner[c] * 4 + k]; cw[c * 4 + k] = sk.weight[corner[c] * 4 + k]; }
      const T = sg.attributes.tangent;
      surf = { sg, skin: { index: ci, weight: cw }, P: (poser && poser.surf ? poser.surf.P : sg.attributes.position.array.slice()), N: (poser && poser.surf ? poser.surf.N : sg.attributes.normal.array.slice()), T: T ? (poser && poser.surf ? poser.surf.T : T.array.slice()) : null };
    }
    poser = { d, W, B, sk, restP: poser && poser.d === d ? poser.restP : restP.slice(), restN: poser && poser.d === d ? poser.restN : restN.slice(), pos, nrm, surf };
    return poser;
  }
  function applyPose() {
    const s = R(), p = ensurePoser();
    const m = SKIN.poseMatrices(s.rig, s.pose, s.rootOffset, s.offsetJoint ?? -1);
    posedWorld = m.world;
    if (!p) return;
    SKIN.skinVertices(m.skin, p.sk.index, p.sk.weight, p.restP, p.restN, p.pos.array, p.nrm.array);
    p.pos.needsUpdate = true;
    p.nrm.needsUpdate = true;
    if (p.surf) {
      const a = p.surf.sg.attributes;
      SKIN.skinVertices(m.skin, p.surf.skin.index, p.surf.skin.weight, p.surf.P, p.surf.N, a.position.array, a.normal.array, p.surf.T, a.tangent ? a.tangent.array : null);
      a.position.needsUpdate = true; a.normal.needsUpdate = true;
      if (a.tangent) a.tangent.needsUpdate = true;
    }
    host.requestRender();
  }
  // Back to the model as it stands.
  function restPose() {
    const p = poser;
    if (!p) return;
    p.pos.array.set(p.restP); p.pos.needsUpdate = true;
    p.nrm.array.set(p.restN); p.nrm.needsUpdate = true;
    if (p.surf) {
      const a = p.surf.sg.attributes;
      a.position.array.set(p.surf.P); a.normal.array.set(p.surf.N);
      a.position.needsUpdate = a.normal.needsUpdate = true;
      if (a.tangent && p.surf.T) { a.tangent.array.set(p.surf.T); a.tangent.needsUpdate = true; }
    }
    host.requestRender();
  }
  function refreshPose() {
    if (posing() && R() && R().rig) applyPose(); else { restPose(); posedWorld = null; }
    placeGizmo();
  }

  // The rotate gizmo on the selected joint, in the joint's own axes: red turns about X (the bend), green about the
  // bone, blue about Z.
  const gizmo = new TransformControls(host.camera, host.canvas);
  gizmo.setMode('rotate');
  gizmo.setSpace('local');
  gizmo.setSize(0.75);
  const proxy = new THREE.Object3D();
  host.sceneR.add(proxy, gizmo.getHelper());
  gizmo.addEventListener('change', () => host.requestRender());
  let poseBefore = null;
  gizmo.addEventListener('dragging-changed', e => {
    host.controls.enabled = !e.value;
    const s = R();
    if (e.value) poseBefore = poseCopy(s);
    else if (poseBefore) { commit(poseBefore, 'pose'); poseBefore = null; updatePanels(); }
  });
  gizmo.addEventListener('objectChange', () => {
    const s = R(), i = s && s.selected;
    if (!s || !s.rig || i < 0 || !posedWorld) return;
    const rig = s.rig, j = rig.joints[i];
    // The joint's world turn is its parent's posed turn, its rest place under the parent, then its own pose: solve for
    // the last from the gizmo's.
    const qw = proxy.quaternion.toArray(), parentQ = j.parent >= 0 ? new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(posedWorld, j.parent * 16)).toArray() : [0, 0, 0, 1];
    const restParent = j.parent >= 0 ? rig.joints[j.parent].rot : [0, 0, 0, 1];
    const d = RIG.qnorm(RIG.qmul(RIG.qconj(j.rot), RIG.qmul(restParent, RIG.qmul(RIG.qconj(parentQ), qw))));
    if (!s.pose) s.pose = rig.joints.map(() => null);
    s.pose[i] = d;
    if (mirrorEdits() && j.mirror >= 0) s.pose[j.mirror] = RIG.mirrorDelta(d);
    applyPose();
    drawSkeleton();
  });
  function placeGizmo() {
    const s = R(), i = s && s.selected;
    const show = posing() && !playing && settings.rigTool === 'pose' && i >= 0 && !!posedWorld && i < s.rig.joints.length;
    if (!show) { if (gizmo.object) gizmo.detach(); host.requestRender(); return; }
    const m = new THREE.Matrix4().fromArray(posedWorld, i * 16);
    m.decompose(proxy.position, proxy.quaternion, proxy.scale);
    proxy.updateMatrixWorld(true);
    if (gizmo.object !== proxy) gizmo.attach(proxy);
    host.requestRender();
  }
  function resetPose(all) {
    const s = R();
    if (!s || !s.pose) return;
    commit(poseCopy(s), 'pose');
    if (all || s.selected < 0) { s.pose = null; s.rootOffset = null; }
    else { s.pose[s.selected] = null; const m = s.rig.joints[s.selected].mirror; if (mirrorEdits() && m >= 0) s.pose[m] = null; }
    refreshPose();
    drawSkeleton();
    updatePanels();
  }

  // Test motions, looping until stopped (Space).
  function play(on = !playing) {
    const s = R();
    if (on && (!s || !s.rig)) return;
    if (!on) {
      if (playing) cancelAnimationFrame(playing.raf);
      playing = null;
      const st2 = R();
      if (st2) { st2.pose = st2.savedPose || null; st2.rootOffset = st2.savedOffset || null; st2.offsetJoint = -1; st2.savedPose = st2.savedOffset = undefined; }
      refreshPose(); drawSkeleton(); updatePanels();
      return;
    }
    s.savedPose = s.pose; s.savedOffset = s.rootOffset;
    if (!ensurePoser() && !s.busy) scheduleWeights(0);
    const t0 = performance.now(), motion = s.rig.template === 'humanoid' ? settings.rigMotion : 'each';
    const loop = settings.rigMotion === 'each' || s.rig.template !== 'humanoid' ? 1.6 * s.rig.joints.filter(j => j.deform).length : 2.2;
    playing = { raf: 0 };
    const frame = now => {
      if (!playing) return;
      const cur = R();
      if (!cur || !cur.rig) { play(false); return; }
      const t = (now - t0) / 1000 / loop;
      ({ pose: cur.pose, rootOffset: cur.rootOffset, offsetJoint: cur.offsetJoint } = RIG.testPose(cur.rig, motion, t));
      applyPose();
      drawSkeleton();
      playing.raf = requestAnimationFrame(frame);
    };
    playing.raf = requestAnimationFrame(frame);
    placeGizmo();
    updatePanels();
  }

  // ---------- panels ----------
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function depthOf(rig, i) { let d = 0; for (let p = rig.joints[i].parent; p >= 0; p = rig.joints[p].parent) d++; return d; }
  function updatePanels() {
    const s = R(), rig = s && s.rig, res = st() && st().result;
    $('rigAuto').disabled = !res || !!(s && s.busy);
    $('rigAuto').textContent = s && s.busy === 'place' ? 'Finding the skeleton…' : rig ? 'Find the skeleton again' : 'Find the skeleton';
    $('rigCustom').disabled = !res;
    $('rigClear').disabled = !rig;
    const est = rig ? rig.joints.filter(j => j.placed === 'estimated').length : 0;
    const head = $('rigHead'), note = $('rigNote'), row = $('rigStatus');
    if (!res) { head.textContent = 'Waiting for the result'; note.textContent = 'The skeleton goes on the reduced model.'; row.className = 'status-line busy'; }
    else if (s && s.busy === 'place') { head.textContent = 'Finding the skeleton'; note.textContent = 'Reading the head, hands and feet from the shape…'; row.className = 'status-line busy'; }
    else if (!rig) { head.textContent = 'No skeleton yet'; note.textContent = 'Find one from the shape of a standing figure, or build your own bone by bone.'; row.className = 'status-line'; }
    else if (rig.template === 'custom') {
      head.textContent = `${rig.joints.length} ${rig.joints.length === 1 ? 'joint' : 'joints'}`;
      note.textContent = `Built by hand: click the model with Add joints (J) to chain new ones from the selected joint${rig.plane ? ', mirrored across the model\'s plane' : ''}, and drag them with Move joints (V).`;
      row.className = 'status-line ok';
    } else {
      head.textContent = `${rig.joints.length} joints`;
      const notes = (s.report && s.report.notes) || [];
      note.textContent = [est ? `${est} placed by proportion (amber): check them.` : 'Every joint read from the shape.', ...notes].join(' ');
      row.className = `status-line ${est ? 'warn' : 'ok'}`;
    }
    // Weights.
    const wHead = $('rigWHead'), wNote = $('rigWNote'), wRow = $('rigWStatus');
    $('rigReweight').disabled = !rig || !res || !!(s && s.busy);
    if (!rig) { wHead.textContent = 'No weights'; wNote.textContent = 'They come with the skeleton.'; wRow.className = 'status-line'; }
    else if (s.busy) { wHead.textContent = 'Working out the weights'; wNote.textContent = 'Bone heat over the reduced surface…'; wRow.className = 'status-line busy'; }
    else if (!s.weights || s.stale) { wHead.textContent = 'Out of date'; wNote.textContent = s.edited ? 'The skeleton changed since the weights were painted. Work them out again to fit it, or keep painting.' : 'They follow the skeleton in a moment.'; wRow.className = 'status-line warn'; }
    else { wHead.textContent = 'Bone heat'; wNote.textContent = `Up to ${SKIN.MAX_INFLUENCES} joints per vertex${s.weightMs ? ` · ${(s.weightMs / 1000).toFixed(1)} s` : ''}. ${s.selected >= 0 ? `Showing ${rig.joints[s.selected].name}'s weights.` : 'Select a joint to see its weights.'}`; wRow.className = 'status-line ok'; }
    // Bone tree.
    const tree = $('rigTree');
    if (!rig) tree.innerHTML = '';
    else {
      tree.innerHTML = rig.joints.map((j, i) => `<li data-j="${i}" class="${i === s.selected ? 'sel' : ''}${j.deform ? '' : ' end'}" style="--d:${depthOf(rig, i)}"><span class="jdot ${j.placed === 'estimated' ? 'est' : j.side}"></span><span class="jname">${esc(j.name)}</span></li>`).join('');
      const selEl = tree.querySelector('.sel');
      if (selEl && selEl.scrollIntoView && settings.space === 'rig') selEl.scrollIntoView({ block: 'nearest' });
    }
    $('rigTreeMeta').textContent = rig ? `${rig.joints.filter(j => j.deform).length} deform` : '';
    // The selected joint.
    const props = $('rigProps'), sel = rig && s.selected >= 0 ? rig.joints[s.selected] : null;
    props.hidden = !sel;
    if (sel) {
      if (document.activeElement !== $('rigName')) $('rigName').value = sel.name;
      const kids = RIG.childrenOf(rig), below = new Set([s.selected]), stack = [s.selected];
      while (stack.length) for (const c of kids[stack.pop()]) { below.add(c); stack.push(c); }
      $('rigParent').innerHTML = `<option value="-1">None (a root)</option>${rig.joints.map((j, i) => (below.has(i) ? '' : `<option value="${i}"${i === sel.parent ? ' selected' : ''}>${esc(j.name)}</option>`)).join('')}`;
      $('rigDeform').checked = sel.deform;
      $('rigPlaced').textContent = sel.placed === 'estimated' ? 'Placed by proportion: drag it where the joint bends.' : sel.placed === 'user' ? 'Placed by you.' : 'Read from the shape.';
      $('rigPlaced').className = `note ${sel.placed === 'estimated' ? 'warn' : ''}`;
    }
    // Pose.
    const custom = rig && rig.template !== 'humanoid';
    $('rigPlay').disabled = !rig;
    $('rigPlay').textContent = playing ? 'Stop' : 'Play the test motion';
    $('rigResetPose').disabled = !(s && s.pose && s.pose.some(Boolean)) || !!playing;
    for (const b of document.querySelectorAll('#rigMotionSeg button')) b.disabled = !rig || (custom && b.dataset.motion !== 'each');
    host.updateUndo();
    host.updateExport();
  }

  // ---------- adding and deleting joints ----------
  function newName(rig, base) {
    const taken = new Set(rig.joints.map(j => j.name));
    for (let k = 1; ; k++) { const n = `${base}${k}`; if (!taken.has(n)) return n; }
  }
  // A joint at p, child of parent (or a new root); with mirror editing off the plane, its mirror image too.
  function addJoint(p, parent) {
    const s = ensure();
    const before = s.rig ? RIG.cloneRig(s.rig) : null;
    if (!s.rig) s.rig = { version: RIG.RIG_VERSION, template: 'custom', fingers: false, naming: settings.rigNaming, frame: RIG.frameOf(), plane: planeOf(), joints: [] };
    const rig = s.rig, plane = rig.plane;
    const off = plane ? p[plane.axis] - plane.offset : 0;
    const size = st().diag || 1;
    const paired = plane && mirrorEdits() && Math.abs(off) > 0.01 * size;
    const leftSign = plane ? Math.sign(rig.frame.left[plane.axis]) || 1 : 1;
    const side = !paired ? 'C' : Math.sign(off) === leftSign ? 'L' : 'R';
    if (!paired && plane && mirrorEdits()) p = onPlane(rig, p);
    // A chain carries on its parent's name (Tail1, Tail2…); one starting from a template joint is a Bone.
    const from = parent >= 0 ? rig.joints[parent] : null;
    const base = from && !from.slot && !/^root$/i.test(from.name) ? from.name.replace(/[._]?\d+$/, '').replace(/^(Left|Right)/, '') || 'Bone' : 'Bone';
    const name = newName(rig, paired ? `${side === 'L' ? 'Left' : 'Right'}${base}` : base);
    const j = { name, slot: null, parent, pos: p, rot: [0, 0, 0, 1], deform: true, side, mirror: -1, placed: 'user' };
    rig.joints.push(j);
    const i = rig.joints.length - 1;
    if (paired) {
      const mp = parent >= 0 ? (rig.joints[parent].mirror >= 0 ? rig.joints[parent].mirror : parent) : -1;
      const other = side === 'L' ? 'R' : 'L';
      rig.joints.push({ name: newName(rig, `${other === 'L' ? 'Left' : 'Right'}${base}`), slot: null, parent: mp, pos: mirrorOf(rig, p), rot: [0, 0, 0, 1], deform: true, side: other, mirror: i, placed: 'user' });
      j.mirror = rig.joints.length - 1;
    }
    commit(before);
    // Weights get a column for each new joint, empty until worked out again.
    if (s.weights) s.weights = widen(s.weights, rig.joints.length);
    s.selected = i;
    skeletonChanged();
    return i;
  }
  function widen(w, B) {
    const G = w.groups.count, old = w.joints, W = new Float32Array(G * B);
    for (let g = 0; g < G; g++) W.set(w.W.subarray(g * old, g * old + old), g * B);
    return { ...w, W, joints: B };
  }
  // Removes joint i (and its mirror image with mirror editing): its children go to its parent, and so do its weights.
  function deleteJoint(i) {
    const s = R(), rig = s && s.rig;
    if (!rig || i < 0) return;
    const before = RIG.cloneRig(rig);
    const gone = new Set([i]);
    if (mirrorEdits() && rig.joints[i].mirror >= 0) gone.add(rig.joints[i].mirror);
    const keep = rig.joints.map((_, k) => !gone.has(k));
    // What hung from a deleted joint moves up to its nearest kept ancestor.
    const up = k => { let p = rig.joints[k].parent; while (p >= 0 && !keep[p]) p = rig.joints[p].parent; return p; };
    const remap = new Int32Array(rig.joints.length).fill(-1), old = [];
    rig.joints.forEach((_, k) => { if (keep[k]) { remap[k] = old.length; old.push(k); } });
    const joints = old.map(k => {
      const j = { ...rig.joints[k] }, p = up(k);
      j.parent = p >= 0 ? remap[p] : -1;
      j.mirror = j.mirror >= 0 && keep[j.mirror] ? remap[j.mirror] : -1;
      return j;
    });
    if (s.weights && joints.length) {
      const B = rig.joints.length, NB = joints.length, G = s.weights.groups.count, W = new Float32Array(G * NB), Wo = s.weights.W;
      const to = rig.joints.map((_, b) => { const t = keep[b] ? b : up(b); return t >= 0 ? remap[t] : 0; });
      for (let g = 0; g < G; g++) for (let b = 0; b < B; b++) { const x = Wo[g * B + b]; if (x) W[g * NB + to[b]] += x; }
      s.weights = { ...s.weights, W, joints: NB };
    }
    commit(before);
    rig.joints = joints;
    s.selected = -1;
    if (!joints.length) { s.rig = null; s.weights = null; }
    skeletonChanged(false);
  }
  // Joints in parents-first order again after a change of parent, with their weights' columns moved along.
  function reorder(s) {
    const rig = s.rig, n = rig.joints.length, kids = rig.joints.map(() => []), order = [];
    rig.joints.forEach((j, i) => { if (j.parent >= 0) kids[j.parent].push(i); });
    const visit = i => { order.push(i); for (const c of kids[i]) visit(c); };
    rig.joints.forEach((j, i) => { if (j.parent < 0) visit(i); });
    const at = new Int32Array(n);
    order.forEach((old, k) => { at[old] = k; });
    rig.joints = order.map(old => { const j = { ...rig.joints[old] }; j.parent = j.parent >= 0 ? at[j.parent] : -1; j.mirror = j.mirror >= 0 ? at[j.mirror] : -1; return j; });
    if (s.weights) {
      const G = s.weights.groups.count, W = new Float32Array(G * n), Wo = s.weights.W;
      for (let g = 0; g < G; g++) for (let b = 0; b < n; b++) W[g * n + at[b]] = Wo[g * n + b];
      s.weights = { ...s.weights, W };
    }
    if (s.selected >= 0) s.selected = at[s.selected];
  }

  // ---------- pointer ----------
  let drag = null, down = null, moveQueued = null;
  function onPointerDown(e) {
    if (!inRig() || e.button !== 0 || !st() || !st().result) return false;
    const tool = settings.rigTool, s = ensure();
    if (tool === 'select') {
      const j = pickJoint(e);
      if (j >= 0) {
        s.selected = j;
        drag = { j, before: RIG.cloneRig(s.rig), moved: false, subtree: e.shiftKey, keepDepth: e.altKey, id: e.pointerId };
        host.controls.enabled = false;
        try { host.canvas.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
        drawSkeleton(); paintWeights(); updatePanels();
        return true;
      }
      down = { x: e.clientX, y: e.clientY, tool };
      return false;
    }
    if (tool === 'add' || tool === 'pose') { down = { x: e.clientX, y: e.clientY, tool }; return false; }
    return false;
  }
  function onPointerMove(e) {
    if (!inRig()) return;
    if (!drag) { hover(e); return; }
    const first = !moveQueued;
    moveQueued = e;
    if (!first) return;
    requestAnimationFrame(() => {
      const ev = moveQueued;
      moveQueued = null;
      if (!drag) return;
      const s = R(), rig = s.rig, j = rig.joints[drag.j], ray = rayAt(ev);
      const p = !drag.keepDepth && settings.rigCentre !== false ? middleUnder(ray) || onViewPlane(ray, j.pos) : onViewPlane(ray, j.pos);
      moveJoint(rig, drag.j, p, drag.subtree);
      drag.moved = true;
      RIG.orientJoints(rig);
      drawSkeleton();
    });
  }
  function onPointerUp(e) {
    if (!inRig()) return;
    if (drag) {
      const d = drag;
      drag = null;
      host.controls.enabled = true;
      if (d.moved) { commit(d.before); skeletonChanged(); }
      return;
    }
    if (!down) return;
    const clicked = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5, tool = down.tool;
    down = null;
    if (!clicked) return;
    const s = ensure();
    if (tool === 'select' || tool === 'pose') {
      if (tool === 'pose' && gizmo.dragging) return;
      const j = tool === 'pose' ? pickJoint(e) : -1, b = j >= 0 ? j : pickBone(e);
      s.selected = b;
      drawSkeleton(); paintWeights(); updatePanels(); placeGizmo();
    } else if (tool === 'add') {
      const ray = rayAt(e), p = middleUnder(ray);
      if (!p) return;
      addJoint(p, s.rig && s.selected >= 0 ? s.selected : s.rig && s.rig.joints.length ? 0 : -1);
    }
  }
  let hovered = -1;
  function hover(e) {
    if (settings.rigTool !== 'select') { host.canvas.style.cursor = settings.rigTool === 'add' ? 'copy' : settings.rigTool === 'orbit' ? 'grab' : 'crosshair'; return; }
    const j = pickJoint(e);
    if (j !== hovered) { hovered = j; host.canvas.style.cursor = j >= 0 ? 'move' : 'default'; }
  }

  // ---------- keys ----------
  const TOOLS = { o: 'orbit', v: 'select', j: 'add', p: 'pose' };
  function onKey(e) {
    if (!inRig()) return false;
    const k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
    if (mod && k === 'z') { undoRedo(e.shiftKey); return true; }
    if (mod && k === 'y') { undoRedo(true); return true; }
    if (mod || e.altKey) return false;
    if (TOOLS[k]) { setTool(TOOLS[k]); return true; }
    if (k === 'delete' || k === 'backspace') { const s = R(); if (s && s.selected >= 0) deleteJoint(s.selected); return true; }
    if (k === 'escape') { const s = R(); if (playing) play(false); else if (s) { s.selected = -1; drawSkeleton(); paintWeights(); updatePanels(); placeGizmo(); } return true; }
    if (k === ' ') { play(); return true; }
    return false;
  }

  function setTool(t) {
    settings.rigTool = t;
    host.saveSettings();
    sync();
  }

  // ---------- the workspace's controls ----------
  function applyControls() {
    if (!inRig()) return;
    const tool = settings.rigTool;
    // Select and Add leave a left drag that starts off a joint to orbiting; the other tools orbit with the right button.
    const orbitLeft = tool === 'orbit' || tool === 'select' || tool === 'add' || tool === 'pose';
    host.controls.mouseButtons = orbitLeft ? { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN } : { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    host.controls.touches = orbitLeft ? { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN } : { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
    host.canvas.style.cursor = tool === 'orbit' ? 'grab' : tool === 'add' ? 'copy' : 'default';
    const hint = tool === 'orbit' ? 'Drag to orbit · right-drag to pan · scroll to zoom'
      : tool === 'select' ? 'Drag a joint to move it; it settles in the middle of the limb · Shift drags what hangs below too · Alt keeps its depth · click a bone to select it · drag elsewhere to orbit'
        : tool === 'pose' ? 'Click a joint and turn it with the rings: red bends it, green twists it along the bone · Space plays the test motion · drag elsewhere to orbit'
          : 'Click the model to add a joint there, chained from the selected one · Esc to start a new chain';
    host.setHint(hint);
  }
  function sync() {
    const rig = inRig();
    for (const b of document.querySelectorAll('#rigPal .tool')) b.setAttribute('aria-pressed', String(b.dataset.rigtool === settings.rigTool));
    $('rigCentre').checked = settings.rigCentre !== false;
    $('rigMirror').checked = settings.rigMirror !== false;
    $('rigShowWeights').checked = settings.rigShowWeights !== false;
    for (const b of document.querySelectorAll('#rigFingerSeg button')) b.setAttribute('aria-pressed', String(b.dataset.fingers === settings.rigFingers));
    for (const b of document.querySelectorAll('#rigNameSeg button')) b.setAttribute('aria-pressed', String(b.dataset.naming === settings.rigNaming));
    $('rigOpts').hidden = !rig || !st() || !st().result;
    $('rigOptName').textContent = { add: 'Add joint', select: 'Move joints', pose: 'Pose', orbit: 'Orbit' }[settings.rigTool] || '';
    $('rigCentre').closest('label').hidden = settings.rigTool === 'pose';
    for (const b of document.querySelectorAll('#rigMotionSeg button')) b.setAttribute('aria-pressed', String(b.dataset.motion === settings.rigMotion));
    if (rig) applyControls();
    if (!rig && playing) play(false);
    refreshPose();
    drawSkeleton();
    paintWeights();
    updatePanels();
  }

  // ---------- wiring ----------
  for (const b of document.querySelectorAll('#rigPal .tool')) b.addEventListener('click', () => setTool(b.dataset.rigtool));
  $('rigUndo').addEventListener('click', () => undoRedo(false));
  $('rigRedo').addEventListener('click', () => undoRedo(true));
  $('rigAuto').addEventListener('click', () => runRig('place'));
  $('rigReweight').addEventListener('click', () => { const s = R(); if (s) { s.edited = false; runRig('weights'); } });
  $('rigCustom').addEventListener('click', () => {
    const s = ensure(), res = st().result;
    if (!res) return;
    // A root on the floor below the middle of the model.
    const b = host.boundsOf(res.positions), p = [(b.min[0] + b.max[0]) / 2, b.min[1], (b.min[2] + b.max[2]) / 2];
    const before = s.rig ? RIG.cloneRig(s.rig) : null;
    // The app's mirror plane, or the model's own when it is about symmetric, so new joints come in pairs.
    let plane = planeOf();
    if (!plane) { const m = RIG.mirrorPlaneOf(res.positions, res.vertexCount); if (m && m.error < 0.01) plane = { axis: m.axis, offset: m.offset }; }
    s.rig = { version: RIG.RIG_VERSION, template: 'custom', fingers: false, naming: settings.rigNaming, frame: RIG.frameOf(), plane, joints: [] };
    s.weights = null;
    s.report = null;
    addJoint(onPlane(s.rig, p), -1);
    s.undo.pop();
    commit(before);
    s.rig.joints[0].name = 'Root';
    setTool('add');
  });
  $('rigClear').addEventListener('click', () => {
    const s = R();
    if (!s || !s.rig) return;
    commit(RIG.cloneRig(s.rig));
    s.rig = null; s.weights = null; s.selected = -1; s.report = null;
    skeletonChanged(false);
  });
  for (const b of document.querySelectorAll('#rigFingerSeg button')) b.addEventListener('click', () => { settings.rigFingers = b.dataset.fingers; host.saveSettings(); sync(); });
  for (const b of document.querySelectorAll('#rigNameSeg button')) b.addEventListener('click', () => {
    settings.rigNaming = b.dataset.naming;
    host.saveSettings();
    const s = R();
    if (s && s.rig) { commit(RIG.cloneRig(s.rig)); RIG.renameRig(s.rig, settings.rigNaming); RIG.uniqueNames(s.rig); host.saveSessionSoon(); }
    sync();
  });
  $('rigCentre').addEventListener('change', e => { settings.rigCentre = e.target.checked; host.saveSettings(); });
  $('rigMirror').addEventListener('change', e => { settings.rigMirror = e.target.checked; host.saveSettings(); });
  $('rigShowWeights').addEventListener('change', e => { settings.rigShowWeights = e.target.checked; host.saveSettings(); paintWeights(); });
  $('rigTree').addEventListener('click', e => {
    const li = e.target.closest('li[data-j]');
    if (!li) return;
    const s = R();
    s.selected = Number(li.dataset.j) === s.selected ? -1 : Number(li.dataset.j);
    drawSkeleton(); paintWeights(); updatePanels();
  });
  $('rigName').addEventListener('change', e => {
    const s = R(), rig = s && s.rig;
    if (!rig || s.selected < 0) return;
    const name = e.target.value.trim().replace(/[^\w.:-]+/g, '_');
    if (!name || name === rig.joints[s.selected].name) { e.target.value = rig.joints[s.selected].name; return; }
    commit(RIG.cloneRig(rig));
    rig.joints[s.selected].name = name;
    rig.joints[s.selected].slot = null;
    RIG.uniqueNames(rig);
    updatePanels();
    host.saveSessionSoon();
  });
  $('rigParent').addEventListener('change', e => {
    const s = R(), rig = s && s.rig;
    if (!rig || s.selected < 0) return;
    commit(RIG.cloneRig(rig));
    rig.joints[s.selected].parent = Number(e.target.value);
    reorder(s);
    skeletonChanged();
  });
  $('rigDeform').addEventListener('change', e => {
    const s = R(), rig = s && s.rig;
    if (!rig || s.selected < 0) return;
    commit(RIG.cloneRig(rig));
    rig.joints[s.selected].deform = e.target.checked;
    skeletonChanged();
  });
  $('rigDelete').addEventListener('click', () => { const s = R(); if (s) deleteJoint(s.selected); });
  $('rigPlay').addEventListener('click', () => play());
  $('rigResetPose').addEventListener('click', () => resetPose(true));
  for (const b of document.querySelectorAll('#rigMotionSeg button')) b.addEventListener('click', () => {
    settings.rigMotion = b.dataset.motion;
    host.saveSettings();
    if (playing) { play(false); play(true); }
    sync();
  });
  // After OrbitControls' own listeners, so a drag that starts on a joint can stop the orbit it began.
  host.canvas.addEventListener('pointerdown', onPointerDown);
  host.canvas.addEventListener('pointermove', onPointerMove);
  host.canvas.addEventListener('pointerup', onPointerUp);
  host.canvas.addEventListener('pointercancel', onPointerUp);

  // ---------- what the page asks of the workspace ----------
  return {
    sync,
    onKey,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onResult,
    // Leaving the tab or the workspace: the job for the old tab ends, the overlay goes.
    detach() {
      engine.cancel(); clearTimeout(weightTimer); drag = null; host.controls.enabled = true; overlay.visible = false;
      if (playing) { cancelAnimationFrame(playing.raf); playing = null; const s = R(); if (s) { s.pose = s.savedPose || null; s.rootOffset = s.savedOffset || null; } }
      restPose(); poser = null; posedWorld = null;
      if (gizmo.object) gizmo.detach();
    },
    paintVisible: () => showWeights(),
    canUndo: () => !!(R() && R().undo.length),
    canRedo: () => !!(R() && R().redo.length),
    undo: () => undoRedo(false),
    redo: () => undoRedo(true),
    has: () => !!(R() && R().rig),
    joints: () => (R() && R().rig ? R().rig.joints.length : 0),
    // The skeleton and per-vertex weights for an export of res, in units of `unit` times the model's (weights worked out
    // here and now when the result has none yet), or null without a skeleton.
    exportData(res, unit) {
      const s = R();
      if (!s || !s.rig || !s.rig.joints.length) return null;
      let w = s.weights && s.weights.res === res ? s.weights : null;
      if (!w) {
        const h = SKIN.boneHeat(meshOf(res), s.rig);
        w = s.weights = { W: h.W, groups: h.groups, res, joints: s.rig.joints.length };
        s.stale = false;
      }
      const rig = RIG.uniqueNames(RIG.cloneRig(s.rig));
      const limited = SKIN.limitWeights(w.W, w.groups.count, rig.joints.length);
      return { skin: SKIN.vertexSkin(w.groups.group, limited), skeleton: RIG.exportSkeleton(rig, unit), joints: rig.joints.length };
    },
  };
}
