import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivative } from '../src/model.js';

// Model: { n, C[], K[][] } where K is (n+2)x(n+2): last two rows/cols are
// the ambient environments [Street, Ground] (matching inputs.amb order).
// State T has length n; environments have fixed temperatures.
// dT_i/dt = ( sum_{j<n} K_ij (T_j - T_i) + sum_a K_i,{n+a} (amb[a] - T_i) + q_i ) / C_i

test('derivative: hand-calculated 2-node system with ambient row', () => {
  // n=2, env rows 2 (street) and 3 (ground)
  const model = { n: 2, C: [100, 200], K: [
    [0, 5, 2, 0],
    [5, 0, 0, 4],
    [2, 0, 0, 0],
    [0, 4, 0, 0],
  ] };
  const T = [10, 20];
  const inputs = { q: [0, 100], amb: [5, 8] };
  // node0: 5*(20-10) + 2*(5-10) = 50 - 10 = 40; /100 = 0.4
  // node1: 5*(10-20) + 4*(8-20) + 100 = -50 - 48 + 100 = 2; /200 = 0.01
  const dT = derivative(model, T, inputs);
  assert.equal(dT.length, 2);
  assert.ok(Math.abs(dT[0] - 0.4) < 1e-12, `dT0=${dT[0]}`);
  assert.ok(Math.abs(dT[1] - 0.01) < 1e-12, `dT1=${dT[1]}`);
});

test('derivative: diagonal of K is ignored (nodes and environments)', () => {
  const base = { n: 1, C: [10], K: [[0, 3], [3, 0]] };
  const withDiag = { n: 1, C: [10], K: [[999, 3], [3, -7]] };
  const T = [10];
  const inputs = { q: [0], amb: [0] };
  const a = derivative(base, T, inputs);
  const b = derivative(withDiag, T, inputs);
  assert.deepEqual(b, a);
});

test('derivative: environment-to-environment entries have no effect', () => {
  // node -> ground 4 W/K; a spurious street<->ground entry must be ignored
  const base = { n: 1, C: [10], K: [[0, 0, 4], [0, 0, 9], [0, 9, 0]] };
  const T = [10];
  const inputs = { q: [0], amb: [0, 30] };
  const dT = derivative(base, T, inputs);
  // only node0: 4*(30-10)/10 = 8
  assert.ok(Math.abs(dT[0] - 8) < 1e-12, `dT0=${dT[0]}`);
});

test('derivative: zero ambient conductance means no loss', () => {
  const model = { n: 2, C: [10, 10], K: [
    [0, 0, 0, 0],
    [0, 0, 0, 7], // node 1 -> env 1 (ground)
    [0, 0, 0, 0],
    [0, 7, 0, 0],
  ] };
  const T = [10, 10];
  const dT = derivative(model, T, { q: [0, 0], amb: [0, 30] });
  assert.ok(Math.abs(dT[0]) < 1e-12, `dT0=${dT[0]}`);
  assert.ok(Math.abs(dT[1] - 14) < 1e-12, `dT1=${dT[1]}`);
});

test('derivative: energy sum over nodes cancels for internal links only', () => {
  // closed network (env columns all zero): sum C_i dT_i must be 0
  const model = { n: 3, C: [10, 20, 30], K: [
    [0, 2, 0, 0, 0],
    [2, 0, 5, 0, 0],
    [0, 5, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ] };
  const T = [10, 40, -5];
  const dT = derivative(model, T, { q: [0, 0, 0], amb: [0, 0] });
  const energy = dT.reduce((s, d, i) => s + model.C[i] * d, 0);
  assert.ok(Math.abs(energy) < 1e-9, `energy=${energy}`);
});
