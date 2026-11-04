import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultScenario, validateScenario, addNode, removeNode, modelSI, loadScenario, N_ENV } from '../src/scenario.js';
import { compileInputs } from '../src/programs.js';
import { simulate } from '../src/solver.js';

function runScenario(s) {
  const m = s.model;
  const errs = validateScenario(s);
  if (errs.length) throw new Error(errs.join('; '));
  const { tOut, tGround, control } = compileInputs(s.inputs, { n: m.n, names: m.names });
  return simulate(modelSI(s), {
    T0: s.init.T0, steps: s.init.steps, dt: s.init.dt,
    tOut, tGround, control,
  });
}

// Default scenario is the "realistic house" with realistic capacities;
// the RK4 fixture model is covered by test/03-golden.test.mjs, which
// builds the model from the fixture directly.
test('scenario: default is valid and uses realistic capacity-sheet numbers', () => {
  const s = defaultScenario();
  assert.deepEqual(validateScenario(s), []);
  const m = s.model;
  assert.deepEqual(m.names, ['water', 'screed', 'foundation', 'house']);
  // C (volumes from purchased materials), MJ/K
  assert.equal(m.C[0], 0.77);  // Water: 183 l (floor 68 + DU40 88 + radiators 27.5)
  assert.equal(m.C[1], 11.74); // Screed: 58.7 m² × 10 cm × 2000 × 1000
  assert.equal(m.C[2], 54);    // Foundation: slab 22.5 m³ × 2400 × 1000
  assert.equal(m.C[3], 34.944);// Air + int. walls + ceilings + ½ exterior walls
  // Radiators: 5 × 1 kW at ΔT = 50 K → 100 W/K
  assert.equal(m.K[0][3], 100);
  assert.equal(m.K[3][0], 100);
  // Simulation runs and stays finite
  const res = runScenario(s);
  assert.equal(res.T.length, s.init.steps + 1);
  for (const row of res.T)
    for (const v of row) assert.ok(Number.isFinite(v));
});

test('scenario: modelSI converts MJ/K to SI (J/K) for the solver', () => {
  const m = modelSI(defaultScenario());
  assert.deepEqual(m.C, [770000, 11740000, 54000000, 34944000]);
  assert.equal(m.n, 4);
  // K is not copied — units are the same (W/K)
  assert.deepEqual(m.K, defaultScenario().model.K);
});

test('scenario: loadScenario converts legacy J/K capacities to MJ/K', () => {
  const legacy = defaultScenario();
  legacy.model.C = [770000, 11740000, 54000000, 34944000]; // legacy file (J/K)
  const s = loadScenario(legacy);
  assert.deepEqual(s.model.C, [0.77, 11.74, 54, 34.944]);
  // already-MJ scenario passes through untouched
  const fresh = loadScenario(defaultScenario());
  assert.deepEqual(fresh.model.C, [0.77, 11.74, 54, 34.944]);
});

test('scenario: default heats up (9 kW boiler into water, ground at +5 °C)', () => {
  const res = runScenario(defaultScenario());
  // Water is the lightest node (770 kJ/K): in 2.5 h at 3 kW it warms up noticeably
  assert.ok(res.T[150][0] > res.T[0][0] + 5, `water T = ${res.T[150][0]}`);
  // The whole system on average also warms up rather than freezing out
  const sum = a => a.reduce((x, y) => x + y, 0);
  assert.ok(sum(res.T[150].slice(0, 4)) > sum(res.T[0].slice(0, 4)));
});

test('scenario: adding a disconnected node does not change existing curves', () => {
  const base = runScenario(defaultScenario());
  const s = defaultScenario();
  addNode(s);
  assert.equal(s.model.n, 5);
  assert.equal(s.model.K.length, 5 + N_ENV);
  s.model.K.forEach(row => assert.equal(row.length, 5 + N_ENV));
  // env rows stay last: indices 5 and 6 (new node occupies index 4)
  assert.equal(s.model.K[4][5], 0); // new node -> street
  assert.equal(s.model.K[4][6], 0); // new node -> ground
  assert.equal(s.model.K[3][5], 72); // house -> Street link survived (col shifted)
  assert.equal(s.model.K[5][3], 72);
  const res = runScenario(s);
  assert.equal(res.T[0].length, 5);
  for (let step = 0; step <= 150; step++)
    for (let node = 0; node < 4; node++)
      assert.ok(Math.abs(res.T[step][node] - base.T[step][node]) < 1e-12,
        `step ${step} node ${node}`);
});

test('scenario: removeNode keeps matrix consistent and env rows last', () => {
  const s = defaultScenario();
  removeNode(s, 1); // remove Screed
  assert.equal(s.model.n, 3);
  assert.equal(s.model.K.length, 3 + N_ENV);
  s.model.K.forEach(row => assert.equal(row.length, 3 + N_ENV));
  // symmetry preserved
  for (let i = 0; i < s.model.K.length; i++)
    for (let j = 0; j < s.model.K.length; j++)
      assert.equal(s.model.K[i][j], s.model.K[j][i]);
  // house (now index 2) -> Street (index 3) link survived: 72
  assert.equal(s.model.K[2][3], 72);
  assert.equal(s.model.K[3][2], 72);
  // foundation (now index 1) -> Ground (index 4) link survived: 61
  assert.equal(s.model.K[1][4], 61);
  assert.equal(validateScenario(s).length, 0);
  // node indices in inputs code are the user's responsibility,
  // but the scenario structure itself stays valid
  assert.equal(s.inputs.controlCode.length > 0, true);
});

test('scenario: validation catches broken scenarios', () => {
  const s = defaultScenario();
  s.model.K[0][1] = 999;
  assert.ok(validateScenario(s).some(e => e.includes('K[0][1]')));
  const s2 = defaultScenario();
  s2.model.C.length = 3;
  assert.ok(validateScenario(s2).length > 0);
  const s3 = defaultScenario();
  s3.inputs.controlCode = 42;
  assert.ok(validateScenario(s3).some(e => e.includes('controlCode')));
  const s3b = defaultScenario();
  s3b.inputs = { tOutCode: 'return -10;' };
  assert.ok(validateScenario(s3b).some(e => e.includes('inputs')));
  // wrong matrix size (env rows missing) is caught
  const s4 = defaultScenario();
  s4.model.K = s4.model.K.slice(0, 4);
  assert.ok(validateScenario(s4).some(e => e.includes('rows')));
  // asymmetric node-env link is caught
  const s5 = defaultScenario();
  s5.model.K[2][5] = 45;
  assert.ok(validateScenario(s5).some(e => e.includes('K[2][5]')));
  // duplicate node names are caught
  const s6 = defaultScenario();
  s6.model.names[1] = s6.model.names[0];
  assert.ok(validateScenario(s6).some(e => e.includes('unique')));
  // wrong names length is caught
  const s7 = defaultScenario();
  s7.model.names.length = 3;
  assert.ok(validateScenario(s7).some(e => e.includes('names')));
});
