// RK4 solver over the thermal network model.
//
// inputsFn(t) -> { q: number[], amb: number[] }
//   Called at t, t+dt/2 (twice) and t+dt within each RK4 step.
//
// control(t, T, state) -> { q: number[] } | undefined
//   Called exactly once per step, at the start of the step (t).
//   Its returned q is held constant for the whole step (zero-order hold),
//   so any accumulated state (averages, hysteresis) is updated once per
//   control tick, not four times per RK4 stage.

import { derivative } from './model.js';

export function rk4Step(model, t, T, inputsFn, dt) {
  const k1 = derivative(model, T, inputsFn(t));
  const T2 = T.map((x, i) => x + (dt / 2) * k1[i]);
  const k2 = derivative(model, T2, inputsFn(t + dt / 2));
  const T3 = T.map((x, i) => x + (dt / 2) * k2[i]);
  const k3 = derivative(model, T3, inputsFn(t + dt / 2));
  const T4 = T.map((x, i) => x + dt * k3[i]);
  const k4 = derivative(model, T4, inputsFn(t + dt));
  return T.map((x, i) => x + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
}

// opts: {
//   T0: number[],               // initial temperatures, °C
//   steps: number,
//   dt: number,                 // seconds
//   t0?: number,                // start time, s (default 0)
//   tOut?: (t) => number,       // street temperature, °C (default const 0)
//   tGround?: (t) => number,    // ground temperature, °C (default = tOut)
//   control?: (t, T, state) => { q? } 
// }
//
// returns {
//   T: number[][],   // history T[step][node], steps+1 rows
//   t: number[],     // time at each step, s
//   q: number[][],   // heat power used at each step (from control), steps rows
//   state,           // final controller state
// }
export function simulate(model, opts) {
  const { T0, steps, dt } = opts;
  const t0 = opts.t0 ?? 0;
  const tOut = opts.tOut ?? (() => 0);
  const tGround = opts.tGround ?? tOut;

  const state = {};
  const T = [T0.slice()];
  const t = [t0];
  const qHist = [];
  const q0 = opts.q ?? new Array(model.n).fill(0); // constant power, used when no control

  let cur = T0.slice();
  for (let s = 0; s < steps; s++) {
    const ts = t0 + s * dt;
    let q = q0;
    if (opts.control) {
      const r = opts.control(ts, cur, state);
      if (r && r.q) q = r.q;
    }
    const inputsFn = (tt) => {
      const amb = [tOut(tt), tGround(tt)];
      return { q, amb };
    };
    cur = rk4Step(model, ts, cur, inputsFn, dt);
    T.push(cur.slice());
    t.push(ts + dt);
    qHist.push(q);
  }
  return { T, t, q: qHist, state };
}
