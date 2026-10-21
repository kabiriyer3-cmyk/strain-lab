import test from 'node:test';
import assert from 'node:assert/strict';
import { fractureBox, makeSeeds } from '../src/core/voronoi.js';
import { mulberry32 } from '../src/core/rng.js';
import { SCENES } from '../src/core/scenes.js';
import { Structure } from '../src/core/structure.js';
import { solveRegion } from '../src/core/strainRun.js';

test('voronoi pre-fracture conserves volume', () => {
  const rng = mulberry32(7);
  for (let i = 0; i < 60; i++) {
    const size = [0.3 + rng() * 3, 0.3 + rng() * 3, 0.3 + rng() * 3];
    const cells = fractureBox(size, makeSeeds(size, 1 + Math.floor(rng() * 14), rng));
    const V = cells.reduce((s, c) => s + c.vol, 0), V0 = size[0] * size[1] * size[2];
    assert.ok(Math.abs(V - V0) < 1e-6 * V0, `volume ${V} vs ${V0}`);
  }
});

const overlap = (a, b) => Math.max(0, Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]))
  * Math.max(0, Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]))
  * Math.max(0, Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]));
const segBox = (p, q, m, pad = 0) => { // slab test: does segment p->q touch the (padded) box?
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const d = q[k] - p[k], lo = m.min[k] - pad, hi = m.max[k] + pad;
    if (Math.abs(d) < 1e-12) { if (p[k] < lo || p[k] > hi) return false; continue; }
    let a = (lo - p[k]) / d, b = (hi - p[k]) / d; if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) return false;
  }
  return true;
};

for (const key of Object.keys(SCENES)) {
  const def = SCENES[key].build();
  test(`scene "${key}": modules never interpenetrate`, () => {
    const M = def.modules.map((m, i) => ({ ...m, i })).sort((a, b) => a.min[0] - b.min[0]);
    for (let i = 0; i < M.length; i++) for (let j = i + 1; j < M.length && M[j].min[0] < M[i].max[0]; j++) {
      const v = overlap(M[i], M[j]);
      assert.ok(v < 1e-7, `modules ${M[i].i} (${M[i].kind}) and ${M[j].i} (${M[j].kind}) overlap by ${v.toFixed(5)} m3`);
    }
  });
  test(`scene "${key}" stands at rest (Strain)`, () => {
    const st = new Structure(def);
    for (const R of st.regions) {
      const res = solveRegion(st, R.id, 0);
      const dyn = R.modules.some((m) => st.modules[m].dynamic);
      if (!dyn) assert.equal(res.detached.length, 0, `group ${R.key} has unsupported fragments`);
      assert.equal(res.breaks.length, 0, `group ${R.key} overloaded at rest (maxU ${res.maxU.toFixed(2)})`);
    }
  });
  test(`scene "${key}": ziplines are clear and land on solid roofs`, () => {
    for (const [n, z] of (def.ziplines || []).entries()) {
      assert.ok(z.ma >= 0 && z.mb >= 0, `zipline ${n} has an anchor`);
      const L = Math.hypot(z.b[0] - z.a[0], z.b[1] - z.a[1], z.b[2] - z.a[2]);
      for (let t = 0.04; t <= 0.96; t += 0.25 / L) {
        const c = [z.a[0] + (z.b[0] - z.a[0]) * t, z.a[1] + (z.b[1] - z.a[1]) * t, z.a[2] + (z.b[2] - z.a[2]) * t];
        const eye = [c[0], c[1] - 0.8, c[2]]; // rider's head hangs below the cable
        for (const m of def.modules) assert.ok(!segBox(c, eye, m, 0.12), `zipline ${n} hits ${m.kind} at t=${t.toFixed(2)}`);
      }
      // the drop-off point must be free and above the anchor module
      for (const p of [z.a, z.b]) {
        const top = def.modules[p === z.a ? z.ma : z.mb].max[1];
        assert.ok(p[1] - top > 1.4 && p[1] - top < 4.6, `zipline ${n} end ${p} is ${(p[1] - top).toFixed(2)} m above its anchor`);
      }
    }
  });
}

for (const key of Object.keys(SCENES)) {
  test(`scene "${key}": coarse mobile fracture still stands`, () => {
    const st = new Structure(SCENES[key].build(), 1337, { fracScale: 0.6 });
    for (const R of st.regions) {
      const res = solveRegion(st, R.id, 0);
      assert.equal(res.breaks.length, 0, `group ${R.key} overloaded at rest with fracScale 0.6`);
    }
  });
}

test('every sound bank has files and unique local names', async () => {
  const { BANKS, allFiles, localName } = await import('../src/game/sfx.js');
  for (const [k, b] of Object.entries(BANKS)) assert.ok(b.files.length > 0, `bank ${k} is empty`);
  const names = allFiles().map((f) => f.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((n) => /^[A-Za-z0-9._-]+$/.test(n)));
  assert.equal(localName('kenney', 'oga-rpg-pack/RPG Sound Pack/battle/swing.wav'), 'kenney_oga-rpg-pack_RPG_Sound_Pack_battle_swing.wav');
});
