import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileInputs, constantHeatCode, hysteresisCode, averagingCode, boilerCode,
  TOUT_PRESETS, TGROUND_PRESETS, CONTROL_PRESETS,
} from '../src/programs.js';

const BASE = { tOutCode: 'return 0;', tGroundCode: 'return 0;' };

test('programs: tOut code compiles and evaluates as a function of time', () => {
  const c = compileInputs({ tOutCode: 'return -10 + t / 3600;', tGroundCode: 'return 8;' });
  assert.deepEqual(c.errors, []);
  assert.equal(c.tOut(0), -10);
  assert.equal(c.tOut(3600), -9);
  assert.equal(c.tGround(0), 8);
  assert.equal(c.tGround(12345), 8);
});

test('programs: daily sine tOut preset computes semi-amplitude from mean', () => {
  // preset formula: amp = (3.5 + 0.015 * mean**2) / 2, mean = -10 -> amp = 2.5
  const preset = TOUT_PRESETS.find(p => p.name === 'Daily sine');
  assert.ok(preset, 'preset "Daily sine" must exist');
  const c = compileInputs({ tOutCode: preset.code, tGroundCode: 'return 8;' });
  assert.deepEqual(c.errors, []);
  // peak at 14:30 (t = 14.5 * 3600s), trough at 02:30 (t = 2.5 * 3600s)
  const peak = 14.5 * 3600;
  const trough = 2.5 * 3600;
  const inflection = 8.5 * 3600;
  assert.equal(Math.round(c.tOut(peak) * 100) / 100, -7.5);
  assert.equal(Math.round(c.tOut(trough) * 100) / 100, -12.5);
  assert.equal(Math.round(c.tOut(inflection) * 100) / 100, -10);
});

test('programs: syntax errors are reported, not thrown', () => {
  const c = compileInputs({ tOutCode: 'return (-10', tGroundCode: 'return 8;', controlCode: 'const q =' });
  assert.equal(c.errors.length, 2);
  assert.ok(c.errors[0].includes('tOut'));
  assert.ok(c.errors[1].includes('control'));
  assert.equal(typeof c.tOut(0), 'number'); // safe fallback, must not throw
});

test('programs: runtime error in env fn keeps last good value', () => {
  const c = compileInputs({
    tOutCode: 'if (t > 100) throw new Error("boom"); return t;',
    tGroundCode: 'return 8;',
  });
  assert.deepEqual(c.errors, []);
  assert.equal(c.tOut(0), 0);
  assert.equal(c.tOut(50), 50);
  assert.equal(c.tOut(101), 50); // last good value survives the throw
  assert.equal(c.tOut(102), 50);
});

test('programs: non-finite env result keeps last good value', () => {
  const c = compileInputs({ tOutCode: 'return t > 10 ? NaN : t;', tGroundCode: 'return 8;' });
  assert.equal(c.tOut(5), 5);
  assert.equal(c.tOut(11), 5);
});

test('programs: control receives t, T, state, n and state persists', () => {
  const c = compileInputs({
    ...BASE,
    controlCode: `state.calls = (state.calls ?? 0) + 1;
const q = new Array(n).fill(0);
if (state.calls > 1) q[0] = 100;
return { q };`,
  }, { n: 3 });
  const state = {};
  const r1 = c.control(0, [20, 20, 20], state);
  assert.equal(r1.q[0], 0);
  const r2 = c.control(60, [20, 20, 20], state);
  assert.equal(r2.q[0], 100);
  assert.equal(state.calls, 2);
});

test('programs: control runtime error yields undefined (no heat that step)', () => {
  const c = compileInputs({
    ...BASE,
    controlCode: 'if (t > 0) throw new Error("x"); return { q: [1] };',
  }, { n: 2 });
  assert.deepEqual(c.control(0, [20, 20], {}).q, [1]);
  assert.equal(c.control(60, [20, 20], {}), undefined);
});

test('programs: constant heat preset puts constant power into one node', () => {
  const c = compileInputs({
    ...BASE,
    controlCode: constantHeatCode('screed', 2500),
  }, { n: 4, names: ['water', 'screed', 'foundation', 'house'] });
  assert.deepEqual(c.control(0, [20, 20, 20, 20], {}).q, [0, 2500, 0, 0]);
  assert.deepEqual(c.control(3600, [15, 20, 20, 20], {}).q, [0, 2500, 0, 0]);
});

test('programs: hysteresis preset toggles with the band and holds inside it', () => {
  const c = compileInputs({ ...BASE, controlCode: hysteresisCode('water', 'house') }, {
    n: 4, names: ['water', 'screed', 'foundation', 'house'],
  });
  const state = {};
  const q = (T) => c.control(0, T, state).q;
  assert.deepEqual(q([15, 15, 15, 15]), [3000, 0, 0, 0]);   // cold house: heats
  assert.deepEqual(q([25, 25, 15, 20.6]), [0, 0, 0, 0]);    // above target + band: stops
  assert.deepEqual(q([25, 25, 15, 20.0]), [0, 0, 0, 0]);    // inside the dead band: holds off
  assert.deepEqual(q([25, 25, 15, 19.4]), [3000, 0, 0, 0]); // below target - band: heats again
});

test('programs: averaging preset accumulates a window in state', () => {
  const c = compileInputs({ ...BASE, controlCode: averagingCode('house', 3) }, {
    n: 4, names: ['water', 'screed', 'foundation', 'house'],
  });
  const state = {};
  const q = (T) => c.control(0, T, state).q;
  assert.deepEqual(q([15, 15, 15, 15]), [3000, 0, 0, 0]);   // buf [15], avg 15
  assert.deepEqual(q([15, 15, 15, 15]), [3000, 0, 0, 0]);   // buf [15,15], avg 15
  assert.deepEqual(q([15, 15, 15, 25]), [3000, 0, 0, 0]);   // buf [15,15,25], avg 18.33
  assert.deepEqual(q([15, 15, 15, 25]), [0, 0, 0, 0]);      // buf [15,25,25], avg 21.67 -> off
});

test('programs: staged boiler scales stages by water underheat, caps at max', () => {
  const c = compileInputs({ ...BASE, controlCode: boilerCode('water', 70, 6, 1.5) }, {
    n: 4, names: ['water', 'screed', 'foundation', 'house'],
  });
  const q = (T) => c.control(0, T, {}).q;
  assert.deepEqual(q([15, 15, 15, 15]), [9000, 0, 0, 0]);   // cold water: all 6 stages
  assert.deepEqual(q([64.9, 15, 15, 15]), [3000, 0, 0, 0]); // underheat 5.1 °C → 2 stages
  assert.deepEqual(q([67, 15, 15, 15]), [1500, 0, 0, 0]);   // underheat 3 °C → 1 stage
  assert.deepEqual(q([70, 15, 15, 15]), [0, 0, 0, 0]);      // target reached: boiler is off
  assert.deepEqual(q([72, 15, 15, 15]), [0, 0, 0, 0]);      // overheat: does not turn on
});

test('programs: nodes addressable by name (T.house, q.foundation) and by index', () => {
  const c = compileInputs({
    ...BASE,
    controlCode: `state.seen = T.house;
const q = mkq();
q[1] = T.water;
q.foundation = T.house + 1;
return { q };`,
  }, { n: 4, names: ['water', 'screed', 'foundation', 'house'] });
  const state = {};
  const r = c.control(0, [10, 20, 30, 40], state);
  assert.equal(state.seen, 40);
  assert.deepEqual(r.q, [0, 10, 41, 0]);
});

test('programs: presets are exposed for the UI', () => {
  for (const list of [TOUT_PRESETS, TGROUND_PRESETS, CONTROL_PRESETS]) {
    assert.ok(Array.isArray(list) && list.length > 0);
    list.forEach(p => {
      assert.equal(typeof p.name, 'string');
      assert.equal(typeof p.code, 'string');
    });
  }
});
