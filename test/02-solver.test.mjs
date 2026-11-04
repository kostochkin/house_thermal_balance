import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rk4Step, simulate } from '../src/solver.js';

// ---------- helpers ----------

// Exact solution of dT/dt = lam * (T_out(t) - T), T_out(t) = c + m*t.
function exact1node(T0, c, m, lam, t) {
  // T(t) = T_out(t) - m/lam + (T0 - T_out(0) + m/lam) * e^{-lam t}
  return c + m * t - m / lam + (T0 - c + m / lam) * Math.exp(-lam * t);
}

function oneNodeModel(k, C) {
  // node 0 coupled to street (env 0) with conductance k
  return { n: 1, C: [C], K: [[0, k], [k, 0]] };
}

function rampInputs(c, m) {
  return (t) => ({ q: [0], amb: [c + m * t, 0] });
}

// ---------- tests ----------

test('rk4: one step matches exact solution of a linear ODE', () => {
  const lam = 150 / 1200; // 1/8 s
  const model = oneNodeModel(150, 1200);
  const T0 = [25];
  const dt = 2;
  const c = -10, m = 0.01;
  const T1 = rk4Step(model, 0, T0, rampInputs(c, m), dt);
  const exact = exact1node(T0[0], c, m, lam, dt);
  // local RK4 error at dt=2 is ~2.7e-4; a broken stage-time handling gives ~2e-3
  assert.ok(Math.abs(T1[0] - exact) < 1e-3, `rk4=${T1[0]} exact=${exact}`);
});

test('rk4: energy conserved in closed system over many steps', () => {
  const model = { n: 3, C: [10, 20, 30], K: [
    [0, 2, 0, 0, 0],
    [2, 0, 5, 0, 0],
    [0, 5, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ] };
  const T0 = [10, 40, -5];
  const res = simulate(model, { T0, steps: 100, dt: 1 });
  const e0 = model.C.reduce((s, c, i) => s + c * T0[i], 0);
  const e1 = model.C.reduce((s, c, i) => s + c * res.T[100][i], 0);
  assert.ok(Math.abs(e0 - e1) < 1e-6 * Math.abs(e0), `e0=${e0} e1=${e1}`);
});

test('rk4: convergence order ~4 (halving dt cuts error ~16x)', () => {
  const lam = 150 / 1200;
  const model = oneNodeModel(150, 1200);
  const c = -10, m = 0.01;
  const tend = 20;
  const exact = exact1node(25, c, m, lam, tend);
  const errAt = (dt) => {
    const steps = Math.round(tend / dt);
    const res = simulate(model, { T0: [25], steps, dt, tOut: (t) => c + m * t });
    return Math.abs(res.T[steps][0] - exact);
  };
  const e1 = errAt(1), e2 = errAt(0.5);
  const ratio = e1 / e2;
  assert.ok(ratio > 10 && ratio < 22, `ratio=${ratio} e1=${e1} e2=${e2}`);
});

test('rk4: converges to analytic steady state', () => {
  // nodes: 10(T2-T1) + 5(-10-T1) + 500 = 0 ; 10(T1-T2) + 3(-10-T2) = 0
  // env row 0 = street, env row 1 = ground (unused)
  const model = { n: 2, C: [1000, 1000], K: [
    [0, 10, 5, 0],
    [10, 0, 0, 3],
    [5, 0, 0, 0],
    [0, 3, 0, 0],
  ] };
  const res = simulate(model, { T0: [0, 0], steps: 5000, dt: 1, q: [500, 0], tOut: () => -10 });
  // solve the 2x2 linear system exactly
  // 10*T2 - 15*T1 = -450 ; 10*T1 - 13*T2 = 30
  const det = -15 * -13 - 10 * 10;
  const T1s = ((-450) * -13 - 10 * 30) / det;
  const T2s = (-15 * 30 - 10 * -450) / det;
  assert.ok(Math.abs(res.T[5000][0] - T1s) < 1e-6, `T1=${res.T[5000][0]} want ${T1s}`);
  assert.ok(Math.abs(res.T[5000][1] - T2s) < 1e-6, `T2=${res.T[5000][1]} want ${T2s}`);
});

test('simulate: control called once per step, state persists, q held for step', () => {
  const model = oneNodeModel(0, 1000);
  let calls = 0;
  const control = (t, T, state) => {
    calls++;
    state.n = (state.n || 0) + 1;
    return { q: [state.n * 1000] };
  };
  const res = simulate(model, { T0: [0], steps: 5, dt: 60, control });
  assert.equal(calls, 5);
  assert.equal(res.state.n, 5);
  // q[step] = 1000*(step+1): dT per step = q*dt/C
  for (let s = 0; s < 5; s++) {
    const dT = res.T[s + 1][0] - res.T[s][0];
    assert.ok(Math.abs(dT - ((s + 1) * 1000 * 60) / 1000) < 1e-9, `step ${s} dT=${dT}`);
  }
  assert.deepEqual(res.q, [[1000], [2000], [3000], [4000], [5000]]);
});

test('simulate: ground temperature is honored', () => {
  const model = { n: 2, C: [10, 10], K: [
    [0, 0, 1, 0],
    [0, 0, 0, 1],
    [0, 0, 0, 0],
    [0, 1, 0, 0],
  ] };
  const res = simulate(model, { T0: [0, 0], steps: 1, dt: 1, tOut: () => 20, tGround: () => 5 });
  // exact: street node 20*(1-e^-0.1) ; ground node 5*(1-e^-0.1)
  assert.ok(Math.abs(res.T[1][0] - 20 * (1 - Math.exp(-0.1))) < 1e-5, `T0=${res.T[1][0]}`);
  assert.ok(Math.abs(res.T[1][1] - 5 * (1 - Math.exp(-0.1))) < 1e-5, `T1=${res.T[1][1]}`);
});
