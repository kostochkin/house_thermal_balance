import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { simulate } from '../src/solver.js';

// Golden test: our RK4 solver must reproduce the reference curves.
// Fixture: test/fixtures/rk4.json — 151 steps, dt=60s,
// boiler stair 2 (2*1500 W into node 1), street temp -10 °C (ground = street).
//
// The fixture's flat kOut/ambIdx are translated here into the extended
// K matrix: 4 nodes + 2 env rows [Street (4), Ground (5)].

const fx = JSON.parse(readFileSync(new URL('./fixtures/rk4.json', import.meta.url)));

test('golden: default 4-node scenario matches fixture curves', () => {
  const n = fx.n;
  const K = fx.K.map(row => [...row, 0, 0]); // 4 nodes x 6 cols
  // node 2 (Foundation) -> env 1 (Ground, col 5): 40 W/K
  K[2][5] = 40;
  // node 3 (Air) -> env 0 (Street, col 4): 150 W/K
  K[3][4] = 150;
  // env rows (symmetric mirrors; env-to-env ignored)
  K.push([0, 0, 0, 150, 0, 0]);
  K.push([0, 0, 40, 0, 0, 0]);

  const model = { n, C: fx.C, K };
  const tOutVal = fx.tStreet[0];
  const res = simulate(model, {
    T0: fx.t0,
    steps: fx.T[0].length - 1,
    dt: fx.dt,
    tOut: () => tOutVal,
    tGround: () => tOutVal, // fixture uses one street column for both envs
    control: () => {
      const q = new Array(model.n).fill(0);
      q[0] = fx.stair[0] * 1500;
      return { q };
    },
  });

  let maxErr = 0;
  for (let node = 0; node < fx.n; node++) {
    for (let s = 0; s <= fx.T[0].length - 1; s++) {
      const err = Math.abs(res.T[s][node] - fx.T[node][s]);
      if (err > maxErr) maxErr = err;
    }
  }
  assert.ok(maxErr < 1e-6, `max abs deviation from fixture = ${maxErr} °C`);
});
