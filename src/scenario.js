// Scenario: everything needed to run a simulation.
//
// {
//   model: { n, names[], C[], K[][] },
//     C is in MJ/K (user-friendly, no long zero tails) — modelSI()
//     converts it to SI (J/K) at the simulate() boundary.
//     K is (n + 2) x (n + 2): rows/cols 0..n-1 are the nodes,
//     the last two rows/cols are the environments [Street, Ground].
//     Symmetric; env-to-env entries are ignored by the solver.
//   init:  { T0[], dt, steps },
//   inputs: { tOutCode, tGroundCode, controlCode },
//     JS function bodies compiled by programs.js:
//     tOutCode/tGroundCode — body of (t) => °C, t in seconds;
//     controlCode — body of (t, T, state, n) => { q } | undefined,
//     called once per step with zero-order hold, state persists.
// }

import { boilerCode } from './programs.js';

export const N_ENV = 2;
export const ENV_NAMES = ['Street', 'Ground'];

export function defaultScenario() {
  return {
    model: {
      n: 4,
      names: ['water', 'screed', 'foundation', 'house'],
      // Capacities (MJ/K) from purchased material volumes. "house" is the
      // heated envelope of the building:
      // air + interior walls + ceilings + half of the exterior walls
      // (linear temperature profile; the other half is in the losses).
      //   water:      183 l (floor 68 + DU40 88 + radiators 27.5) = 0.77
      //   screed:     58.7 m² × 10 cm × 2000 kg/m³ × 1000         = 11.74
      //   foundation: slab 22.5 m³ × 2400 × 1000                    = 54
      //   house:      266 + 8203 + 19200 + 3725 + 3550             = 34.944
      C: [0.77, 11.74, 54, 34.944],
      // K (W/K): value = area / R, R = thickness/lambda (no surface films).
      K: [
        //             water screed foundation house Street Ground
        /* water      */ [0, 660, 0, 100, 0, 0],  // floor-heating pipes 660 (1.1 W/m·K × ~600 m); radiators: 5 × 1 kW @ ΔT=50 K
        /* screed     */ [660, 0, 31, 724, 0, 0],  // -> foundation via XPS 100 mm (90 m² / 2.94); floor -> house 11 W/m²K
        /* foundation */ [0, 31, 0, 0, 0, 61],  // -> Ground via XPS 50 mm (90 m² / 1.47)
        /* house      */ [100, 724, 0, 0, 72, 0], // -> Street: walls 26.3 + windows 22.9 + door 2.8 + ceiling 20.4
        /* Street     */ [0, 0, 0, 72, 0, 0],
        /* Ground     */ [0, 0, 61, 0, 0, 0],
      ],
    },
    init: { T0: [15, 15, 15, 15], dt: 60, steps: 20160 }, // 2 weeks
    inputs: {
      tOutCode: 'return -10;',
      // Ground under the insulated slab stays at ~+5 °C — it does not
      // freeze along with the street air.
      tGroundCode: 'return 5;',
      // Real boiler: 6 stages × 1.5 kW, holding water at 70 °C
      controlCode: boilerCode('water', 70, 6, 1.5),
    },
  };
}

// Errors: list of human-readable strings; [] when valid.
export function validateScenario(s) {
  const errs = [];
  const m = s.model;
  if (!m || !Array.isArray(m.C) || !Array.isArray(m.K)) {
    errs.push('model.C and model.K must be arrays');
    return errs;
  }
  const n = m.n;
  const size = n + N_ENV;
  if (m.C.length !== n) errs.push(`model.C: length ${m.C.length}, expected ${n}`);
  if (!Array.isArray(m.names) || m.names.length !== n) {
    errs.push(`model.names: length ${m.names?.length}, expected ${n}`);
  } else if (new Set(m.names).size !== n) {
    errs.push('model.names: node names must be unique');
  }
  if (m.K.length !== size) errs.push(`model.K: ${m.K.length} rows, expected ${size} (n + 2 env)`);
  m.K?.forEach((row, i) => {
    if (!Array.isArray(row) || row.length !== size) errs.push(`model.K[${i}]: length ${row?.length}, expected ${size}`);
  });
  // K must be symmetric (nodes, node-env links, and env rows)
  // guard against short/ragged matrices — those are reported above
  for (let i = 0; i < size; i++) {
    const rowI = m.K[i];
    if (!Array.isArray(rowI)) continue;
    for (let j = i + 1; j < size; j++) {
      const rowJ = m.K[j];
      if (!Array.isArray(rowJ)) continue;
      if (rowI[j] !== rowJ[i]) errs.push(`K[${i}][${j}]=${rowI[j]} != K[${j}][${i}]=${rowJ[i]}`);
    }
  }
  if (s.init.T0.length !== n) errs.push(`init.T0: length ${s.init.T0.length}, expected ${n}`);
  const inp = s.inputs;
  if (!inp || typeof inp !== 'object') {
    errs.push('inputs: expected an object with tOutCode, tGroundCode, controlCode');
  } else {
    for (const key of ['tOutCode', 'tGroundCode', 'controlCode']) {
      if (typeof inp[key] !== 'string') errs.push(`inputs.${key}: must be a string with JS code`);
    }
  }
  return errs;
}

// SI model for the solver: capacities MJ/K -> J/K. K is untouched (W/K
// on both sides). Returns a plain { n, C, K } ready for simulate().
export function modelSI(s) {
  const m = s.model;
  return { n: m.n, C: m.C.map(c => c * 1e6), K: m.K };
}

// Load a saved scenario: legacy files (before MJ/K) stored C in J/K —
// auto-detect by the long zero tails and divide. Mutates and returns s.
export function loadScenario(s) {
  const C = s?.model?.C;
  if (Array.isArray(C) && C.some(c => Math.abs(c) > 1000)) {
    s.model.C = C.map(c => c / 1e6);
  }
  return s;
}

// New node is inserted at index i = n (before the env rows), so the
// env rows/cols always stay last. Existing rows get a 0 inserted at that
// position; a new all-zero row is added.
export function addNode(s, name) {
  const m = s.model;
  const i = m.n; // insertion index == first env row
  m.n += 1;
  m.names.push(name ?? `node${m.n}`);
  m.C.push(1); // MJ/K
  s.init.T0.push(20);
  for (let r = 0; r < m.K.length; r++) {
    m.K[r].splice(i, 0, 0);
  }
  const newRow = new Array(m.K.length + 1).fill(0);
  m.K.splice(i, 0, newRow);
  return s;
}

export function removeNode(s, i) {
  const m = s.model;
  if (m.n <= 1) return s;
  m.n -= 1;
  m.names.splice(i, 1);
  m.C.splice(i, 1);
  s.init.T0.splice(i, 1);
  m.K.splice(i, 1); // env rows shift up, staying last
  for (let r = 0; r < m.K.length; r++) m.K[r].splice(i, 1);
  return s;
}
