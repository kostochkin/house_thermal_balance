import { test } from 'node:test';
import assert from 'node:assert/strict';
import { powerSeries } from '../src/power.js';
import { steadyState } from '../src/equilibrium.js';
import { defaultScenario, modelSI } from '../src/scenario.js';

const envT = [-10, 5]; // street, ground
const tOut = () => envT[0];
const tGround = () => envT[1];

test('power: series lengths match the time axis (steps+1)', () => {
  const model = modelSI(defaultScenario());
  const T0 = [20, 20, 10, 20];
  const t = [0, 60, 120];
  const T = [T0, T0, T0];
  const q = [[9000, 0, 0, 0], [9000, 0, 0, 0]];
  const { supplied, losses } = powerSeries(model, t, T, q, tOut, tGround);
  assert.equal(supplied.length, t.length);
  assert.equal(losses.length, t.length);
  // q has steps rows (2), t has steps+1 (3): last point holds previous value
  assert.equal(supplied[2], supplied[1]);
});

test('power: at steady state losses equal supplied power (balance)', () => {
  const model = modelSI(defaultScenario());
  const q = [9000, 0, 0, 0];
  const { T } = steadyState(model, { q, envT });
  const t = [0, 60];
  const { supplied, losses } = powerSeries(model, t, [T, T], [q], tOut, tGround);
  for (const s of [0, 1]) {
    assert.ok(Math.abs(supplied[s] - 9000) < 1e-9, `supplied = ${supplied[s]}`);
    assert.ok(Math.abs(losses[s] - 9000) < 1e-6, `losses = ${losses[s]}`);
  }
});

test('power: zero losses when each node sits at its env temperature', () => {
  const model = modelSI(defaultScenario());
  // street -10, ground 5. Only house (72 W/K) is linked to the street, only
  // foundation (61 W/K) to the ground; water/screed have no env links at all.
  const T = [[-10, -10, 5, -10], [-10, -10, 5, -10]];
  const t = [0, 60];
  const { losses } = powerSeries(model, t, T, [[0, 0, 0, 0]], tOut, tGround);
  for (const s of [0, 1])
    assert.ok(Math.abs(losses[s]) < 1e-9, `losses = ${losses[s]}`);
});

test('power: losses grow with temperature and count env flows only', () => {
  const model = modelSI(defaultScenario());
  const t = [0];
  const cold = [[0, 0, 0, 0]];
  const hot = [[40, 40, 20, 40]];
  const q = [[0, 0, 0, 0]];
  const coldLoss = powerSeries(model, t, cold, q, tOut, tGround).losses[0];
  const hotLoss = powerSeries(model, t, hot, q, tOut, tGround).losses[0];
  assert.ok(hotLoss > coldLoss, `hot ${hotLoss} <= cold ${coldLoss}`);
  // coldLoss: nodes at 0 lose to street (-10) but gain from ground (5)
  // sanity: hot losses are positive (net outflow)
  assert.ok(hotLoss > 0, `losses = ${hotLoss}`);
});
