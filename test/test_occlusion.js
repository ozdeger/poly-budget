// Ambient occlusion for the bake: the estimator against shapes whose answer is known, and what the shading does to a
// colour. The shaders in app.js are built from the same numbers (core.OCCLUSION).
import { core, check } from './helpers.js';

const up = [0, 1, 0], down = [0, -1, 0], side = [1, 0, 0], none = () => Infinity, far = 1e6;

// Every interleaved set covers the sphere evenly (unit length, mean almost zero), and the 16 sets share no direction.
{
  const n = core.OCCLUSION.dirs;
  let worst = 0, drift = 0, closest = Infinity;
  const all = [];
  for (let j = 0; j < 16; j++) {
    const mean = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const d = core.occlusionDirection(i, n, j);
      worst = Math.max(worst, Math.abs(Math.hypot(...d) - 1));
      for (let k = 0; k < 3; k++) mean[k] += d[k] / n;
      all.push(d);
    }
    drift = Math.max(drift, Math.hypot(...mean));
  }
  for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) closest = Math.min(closest, Math.hypot(all[a][0] - all[b][0], all[a][1] - all[b][1], all[a][2] - all[b][2]));
  const bayer = new Set(core.OCCLUSION_BAYER);
  check(worst < 1e-12 && drift < 0.03 && closest > 1e-3 && bayer.size === 16 && [...bayer].every(j => j >= 0 && j < 16),
    `16 sets of ${n} directions: unit length, mean at most ${drift.toFixed(3)}, no two closer than ${closest.toFixed(4)}; the Bayer pattern holds every set once`);
}

// Nothing around: fully open, and a surface facing straight up sees the whole sky.
{
  const a = core.ambientOcclusion(up, up, none, far), d = core.ambientOcclusion(down, down, none, far), s = core.ambientOcclusion(side, side, none, far);
  check(a.ao === 1 && Math.abs(a.sky - 1) < 1e-12, `open and facing up: AO ${a.ao}, sky ${a.sky.toFixed(3)}`);
  check(d.ao === 1 && d.sky < 0.3 && s.sky > d.sky && s.sky < a.sky, `facing down sees ${d.sky.toFixed(3)} of the sky, facing sideways ${s.sky.toFixed(3)}`);
}

// The bottom of a hemispherical bowl: the rim is 45° from the normal, and the cosine-weighted share of a cone of
// half-angle θ is sin²θ, so half the sky is open. One set of directions is off by a few percent; the 16 sets merged, as a
// texel ends up, land much closer.
{
  const hit = d => (d[1] * d[1] <= 0.5 ? 2 * d[1] : Infinity);
  let single = 0;
  for (let j = 0; j < 16; j++) single = Math.max(single, Math.abs(core.ambientOcclusion(up, up, hit, far, undefined, j).ao - 0.5));
  const { ao } = core.ambientOcclusionMerged(up, up, hit, far);
  check(Math.abs(ao - 0.5) < 0.005 && Math.abs(ao - 0.5) < single / 2, `bottom of a bowl: AO ${ao.toFixed(4)} merged (exactly 0.5), one set off by up to ${single.toFixed(3)}`);
}

// A floor beside a wall that rises forever: every direction toward the wall meets it, the half of the sky on that side
// is blocked wherever the spot is.
{
  const rows = [0.01, 0.1, 1].map(x => core.ambientOcclusionMerged(up, up, d => (d[0] > 0 ? x / d[0] : Infinity), far).ao);
  check(rows.every(ao => Math.abs(ao - 0.5) < 0.01), `floor beside an endless wall: AO ${rows.map(a => a.toFixed(3)).join(', ')} merged (exactly 0.5)`);
}

// A floor beside a low wall: the open share grows as the spot moves away from it. Merged, it grows smoothly; one fixed set
// jumps in steps where the wall's top edge crosses its directions (the streaks such a set leaves in a map).
{
  const wall = x => d => (d[0] > 0 && d[1] * (x / d[0]) < 0.3 ? x / d[0] : Infinity);
  const xs = Array.from({ length: 60 }, (_, i) => 0.02 + i * 0.01);
  const merged = xs.map(x => core.ambientOcclusionMerged(up, up, wall(x), far).ao), fixed = xs.map(x => core.ambientOcclusion(up, up, wall(x), far).ao);
  const rough = a => Math.max(...a.slice(1, -1).map((v, i) => Math.abs(a[i] - 2 * v + a[i + 2])));
  check(merged.every((v, i) => i === 0 || v >= merged[i - 1] - 1e-9) && rough(merged) < rough(fixed) / 2,
    `beside a wall 0.3 high: AO rises from ${merged[0].toFixed(3)} to ${merged.at(-1).toFixed(3)}, steps ${rough(merged).toFixed(4)} merged against ${rough(fixed).toFixed(4)} for one set`);
}

// The reach: occluders count fully up to half of it and not past it.
{
  const near = core.ambientOcclusion(up, up, () => 0.2, 1).ao, mid = core.ambientOcclusion(up, up, () => 0.75, 1).ao, out = core.ambientOcclusion(up, up, () => 1.5, 1).ao;
  check(near === 0 && Math.abs(mid - 0.5) < 1e-9 && out === 1, `a ceiling at 0.2, 0.75 and 1.5 of the reach: AO ${near}, ${mid.toFixed(3)}, ${out}`);
}

// Directions under the face count as blocked: a spot whose shading normal leans past its face (a creased edge) is
// partly occluded by its own surface.
{
  const lean = [Math.sin(0.5), Math.cos(0.5), 0], { ao } = core.ambientOcclusion(lean, up, none, far);
  check(ao < 1 && ao > 0.85, `shading normal leaning 29° off its face: AO ${ao.toFixed(3)}`);
}

// The shading. Lightness and chroma in OKLab, hue as an angle.
const lch = rgb => { const [L, a, b] = core.linearToOklab(rgb); return { L, C: Math.hypot(a, b), h: Math.atan2(b, a) }; };
const red = [0.6, 0.05, 0.03], skin = [0.25, 0.1, 0.05], grey = [0.4, 0.4, 0.4];
{
  const same = [red, skin, grey].every(c => core.shadeOcclusion(c, 0.3, 0.1, 0).every((v, k) => Math.abs(v - c[k]) < 1e-9));
  check(same, 'strength 0 leaves the colour as it is');
  const open = core.shadeOcclusion(red, 1, 1, 1);
  check(lch(open).L >= lch(red).L && lch(open).L < lch(red).L * Math.cbrt(1.25), `an open surface facing up lightens a little: L ${lch(red).L.toFixed(3)} → ${lch(open).L.toFixed(3)}`);
  const sideways = lch(core.shadeOcclusion(red, 1, 0.448, 0.7)).L / lch(red).L;
  check(sideways > 0.85 && sideways < 1, `an open surface facing sideways darkens only a little (L × ${sideways.toFixed(3)})`);
}
for (const [name, c] of [['red', red], ['skin', skin]]) {
  const a = lch(c), b = lch(core.shadeOcclusion(c, 0.55, 0.3, 0.7));
  const hue = Math.abs(((b.h - a.h + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) * 180 / Math.PI;
  check(b.L < a.L && b.C / b.L > a.C / a.L && b.C < a.C && hue < 1, `${name} in a crease: darker (L ${a.L.toFixed(3)} → ${b.L.toFixed(3)}), more saturated (C/L ${(a.C / a.L).toFixed(2)} → ${(b.C / b.L).toFixed(2)}), hue within ${hue.toFixed(2)}°`);
}
{
  const g = core.shadeOcclusion(grey, 0.5, 0.2, 1);
  check(Math.max(...g) - Math.min(...g) < 1e-6 && g[0] < grey[0], `grey stays grey, only darker (${grey[0]} → ${g[0].toFixed(3)})`);
  const all = [];
  for (let ao = 0; ao <= 1; ao += 0.1) for (let sky = 0; sky <= 1.2; sky += 0.1) all.push(...core.shadeOcclusion([0.9, 0.02, 0.01], ao, sky, 1));
  check(all.every(v => v >= 0 && v <= 1), 'a saturated red stays inside 0–1 at full strength, in every corner');
}

// The separate map: 1 where open, 1 − strength where fully occluded.
check(core.occlusionMapValue(1, 0.7) === 1 && Math.abs(core.occlusionMapValue(0.35, 0.7) - 0.3) < 1e-12 && Math.abs(core.occlusionMapValue(0.65, 1) - 0.5) < 1e-12,
  'occlusion map: 1 open, 1 − strength fully occluded, linear between');
