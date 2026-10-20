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

for (const key of Object.keys(SCENES)) {
  test(`scene "${key}" stands at rest (Strain)`, () => {
    const st = new Structure(SCENES[key].build());
    for (const R of st.regions) {
      const res = solveRegion(st, R.id, 0);
      const dyn = R.modules.some((m) => st.modules[m].dynamic);
      if (!dyn) assert.equal(res.detached.length, 0, `group ${R.id} has unsupported fragments`);
      assert.equal(res.breaks.length, 0, `group ${R.id} overloaded at rest (maxU ${res.maxU.toFixed(2)})`);
    }
  });
}
