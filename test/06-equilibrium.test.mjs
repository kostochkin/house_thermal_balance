import { test } from 'node:test';
import assert from 'node:assert/strict';
import { steadyState, steadyStateTarget, solveLinear } from '../src/equilibrium.js';
import { defaultScenario, modelSI } from '../src/scenario.js';

const envT = [-10, 5]; // street, ground

// Power balance check: at equilibrium every node gets exactly as much as it loses.
function residual(model, T, q) {
  const { n, K } = model;
  const out = [];
  for (let i = 0; i < n; i++) {
    let bal = q[i] ?? 0;
    for (let j = 0; j < n + 2; j++) {
      if (j === i || !K[i][j]) continue;
      const Tj = j < n ? T[j] : envT[j - n];
      bal += K[i][j] * (Tj - T[i]);
    }
    out.push(bal);
  }
  return out;
}

test('equilibrium: single node with constant q', () => {
  const model = { n: 1, C: [1e6], K: [[0, 10], [10, 0]] };
  const { T } = steadyState(model, { q: [100], envT: [0] });
  assert.ok(Math.abs(T[0] - 10) < 1e-9, `T = ${T[0]}`);
});

test('equilibrium: default scenario with 9 kW into water, residuals ~0', () => {
  const model = modelSI(defaultScenario());
  const q = [9000, 0, 0, 0];
  const { T } = steadyState(model, { q, envT });
  for (const [i, bal] of residual(model, T, q).entries())
    assert.ok(Math.abs(bal) < 1e-6, `node ${i} residual ${bal}`);
  // sanity: water is the hot source, house above street
  assert.ok(T[0] > T[3] && T[3] > -10, `water=${T[0]} house=${T[3]}`);
});

test('equilibrium: target mode pins node at 20 °C and solves its power', () => {
  const model = modelSI(defaultScenario());
  const { T, q } = steadyStateTarget(model, { node: 3, target: 20, envT });
  assert.ok(Math.abs(T[3] - 20) < 1e-9, `dom = ${T[3]}`);
  // house loses 72 W/K to the street (ΔT=30) + ~300 W via screed->foundation->ground
  assert.ok(Math.abs(q[3] - 2461) < 10, `q = ${q[3]}`);
  // water has no sink of its own, but leaks to the ground path via screed:
  // slightly below house, above screed (heat flows house/water -> screed)
  assert.ok(T[1] < T[0] && T[0] < 20, `screed=${T[1]} water=${T[0]}`);
  // screed sits slightly below house (feeds the ground path), foundation above ground
  assert.ok(T[1] > 19 && T[1] < 20, `screed = ${T[1]}`);
  assert.ok(T[2] > 5 && T[2] < 15, `foundation = ${T[2]}`);
  for (const [i, bal] of residual(model, T, q).entries())
    assert.ok(Math.abs(bal) < 1e-6, `node ${i} residual ${bal}`);
});

// Pinning the house while heating via water (source ≠ target node): the boiler
// heats the water, the house holds at the target T. Water ends up the hottest —
// heat has to pass through the screed, part of it inevitably leaks into the
// cold slab, so more power is needed than with direct pinning.
test('equilibrium: power injected into source node while target node is pinned', () => {
  const model = modelSI(defaultScenario());
  const res = steadyStateTarget(model, { node: 3, target: 25, source: 0, envT });
  assert.ok(!('error' in res), `error: ${res.error}`);
  const { T, q } = res;
  assert.ok(Math.abs(T[3] - 25) < 1e-9, `house = ${T[3]}`);
  // power goes into the source (water), the pinned node has q = 0
  assert.ok(Math.abs(q[3]) < 1e-9, `q[house] = ${q[3]}`);
  // temperature hierarchy: water -> screed -> house (heat flows through the screed)
  assert.ok(T[0] > T[1] && T[1] > T[3], `water=${T[0]} screed=${T[1]} house=${T[3]}`);
  // ~3 kW: 2.92 kW direct pin + losses into the cold slab
  assert.ok(q[0] > 2900 && q[0] < 3100, `q[water] = ${q[0]}`);
  for (const [i, bal] of residual(model, T, q).entries())
    assert.ok(Math.abs(bal) < 1e-6, `node ${i} residual ${bal}`);
  // default source = the node itself (backward compatibility)
  const same = steadyStateTarget(model, { node: 3, target: 25, envT });
  assert.ok(Math.abs(same.q[3] - 2921) < 10, `q[house] = ${same.q[3]}`);
});

test('equilibrium: target with negative required power means cooling', () => {
  const model = modelSI(defaultScenario());
  const { q } = steadyStateTarget(model, { node: 3, target: -30, envT });
  assert.ok(q[3] < 0, `q = ${q[3]}`);
});

test('equilibrium: isolated network reports error', () => {
  const z = [0, 0, 0, 0];
  const model = { n: 2, C: [1, 1], K: [z, z, z, z] };
  assert.ok(steadyState(model, { q: [100, 0], envT }).error);
  // pinning one node is not enough: the second stays isolated
  assert.ok(steadyStateTarget(model, { node: 0, target: 20, envT }).error);
});

test('equilibrium: solveLinear solves a small system and rejects singular', () => {
  const x = solveLinear([[2, 1], [1, 3]], [3, 5]);
  assert.ok(Math.abs(x[0] - 0.8) < 1e-12 && Math.abs(x[1] - 1.4) < 1e-12);
  assert.equal(solveLinear([[1, 2], [2, 4]], [1, 2]), null);
});
