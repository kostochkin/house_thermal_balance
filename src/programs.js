// Programmable inputs: compile user JS code (function bodies) into safe
// callables for the solver, plus preset snippets for the UI.
//
// Scenario schema (scenario.js):
//   inputs: {
//     tOutCode:    body of (t) => °C,          t — seconds since sim start
//     tGroundCode: body of (t) => °C,
//     controlCode: body of (t, T, state, n, mkq) => { q: number[] } | undefined
//   }
//
// Node names are Latin identifiers (scenario.model.names) and are usable in
// control code alongside numeric indices: T.<name> reads the temperature of
// that node, q.<name> writes its heat flux; numeric T[3] / q[0] keep working.
// mkq() creates a fresh zeroed q array with the same named access.
//
// Failure semantics:
//   - syntax error at compile time -> reported in compileInputs().errors,
//     the compiled fn falls back to a safe constant (env) or undefined (control)
//   - runtime error / non-finite env value -> last good env value is kept
//     (weather never jumps to garbage), control -> undefined (no heat that step)

// Wrap an array so node names act as indices: arr.water <-> arr[0].
// Reads and writes resolve by name first, then fall through (numeric
// index, .length, symbols all keep working).
export function namedProxy(arr, names) {
  return new Proxy(arr, {
    get(t, k) {
      const i = typeof k === 'string' ? names.indexOf(k) : -1;
      return i >= 0 ? t[i] : t[k];
    },
    set(t, k, v) {
      const i = typeof k === 'string' ? names.indexOf(k) : -1;
      if (i >= 0) t[i] = v; else t[k] = v;
      return true;
    },
  });
}

export function constantHeatCode(node = 'water', power = 3000) {
  return `// Constant heating: ${power} W into node ${node}
const q = mkq();
q.${node} = ${power};
return { q };`;
}

export function hysteresisCode(heat = 'water', sensor = 'house') {
  return `// Hysteresis thermostat: heats node ${heat} based on node ${sensor} temperature.
// control is called once per step; state persists between steps; t is seconds since start.
state.on ??= false;
const target = 20, band = 0.5, power = 3000;
if (T.${sensor} < target - band) state.on = true;
if (T.${sensor} > target + band) state.on = false;
const q = mkq();
if (state.on) q.${heat} = power;
return { q };`;
}

export function averagingCode(sensor = 'house', window = 10) {
  return `// Moving average of node ${sensor} temperature over the last ${window} steps:
// state.buf accumulates between control steps.
state.buf ??= [];
state.buf.push(T.${sensor});
if (state.buf.length > ${window}) state.buf.shift();
const avg = state.buf.reduce((a, b) => a + b, 0) / state.buf.length;
const q = mkq();
if (avg < 19.5) q.water = 3000;
return { q };`;
}

// Staged boiler: modulation with discrete stages (a real-world boiler
// has 6 stages × 1.5 kW). The number of stages is determined by water
// underheating of 5 °C per stage; the boiler turns off at target.
export function boilerCode(water = 'water', target = 70, stages = 6, stepKw = 1.5) {
  return `// Staged boiler: ${stages} stages × ${stepKw} kW, keeping water at ${target} °C
// The number of stages is determined by water underheating: 5 °C per stage.
const stepW = ${Math.round(stepKw * 1000)};
const err = ${target} - T.${water};
const nst = Math.max(0, Math.min(${stages}, Math.ceil(err / 5)));
const q = mkq();
if (nst > 0) q.${water} = nst * stepW;
return { q };`;
}

export const TOUT_PRESETS = [
  { name: 'Constant', code: 'return -10;' },
  {
    name: 'Daily sine',
    code: `// Daily street temperature cycle: peak at 14:30, trough at 02:30.
// Semi-amplitude grows with cold: A = (3.5 + 0.015·mean²)/2 —
// at mean = -10 this is 2.5 °C.
const mean = -10;                          // average temperature, °C
const amp = (3.5 + 0.015 * mean ** 2) / 2; // semi-amplitude, °C
return mean + amp * Math.cos((t / 3600 - 14.5) * Math.PI / 12);`,
  },
  {
    name: '24h cooldown',
    code: `// Linear cooling: from -5 to -15 over 24 h, then constant
const k = Math.min(t, 86400) / 86400;
return -5 - 10 * k;`,
  },
];

export const TGROUND_PRESETS = [
  { name: 'Constant 8 °C', code: 'return 8;' },
  { name: 'Constant -10 °C', code: 'return -10;' },
  {
    name: 'Annual sine',
    code: `// Seasonal ground wave: mean 8, amplitude 6 °C
return 8 + 6 * Math.sin((2 * Math.PI * t) / (86400 * 365));`,
  },
];

export const CONTROL_PRESETS = [
  { name: 'Staged boiler 6×1.5 kW', code: boilerCode('water', 70, 6, 1.5) },
  { name: 'Constant heat', code: constantHeatCode('water', 3000) },
  { name: 'Hysteresis thermostat', code: hysteresisCode('water', 'house') },
  { name: 'Moving average', code: averagingCode('house', 10) },
  { name: 'No heat', code: 'const q = mkq(); return { q };' },
];

// Compile an env fn body: (t) => number, memoized last-good fallback.
function compileValue(code, name, errors) {
  let fn;
  try {
    fn = new Function('t', code);
  } catch (e) {
    errors.push(`${name}: syntax error — ${e.message}`);
    return () => 0;
  }
  let last = 0;
  return (t) => {
    try {
      const v = fn(t);
      if (Number.isFinite(v)) { last = v; return v; }
    } catch { /* keep last good value */ }
    return last;
  };
}

// Compile a control fn body: (t, T, state, n, mkq) => { q } | undefined.
// T is wrapped in a name-proxy when node names are given; mkq() creates a
// fresh named q array per control tick. Any runtime error -> undefined
// (solver keeps previous / zero q).
function compileControl(code, n, names, errors) {
  let fn;
  try {
    fn = new Function('t', 'T', 'state', 'n', 'mkq', code);
  } catch (e) {
    errors.push(`control: syntax error — ${e.message}`);
    return () => undefined;
  }
  return (t, T, state) => {
    try {
      const Tw = names.length ? namedProxy(T, names) : T;
      return fn(t, Tw, state, n, () => namedProxy(new Array(n).fill(0), names));
    } catch {
      return undefined;
    }
  };
}

// inputs: { tOutCode, tGroundCode, controlCode } — strings of JS code.
// ctx: { n, names } — node count and Latin node names, usable in control
// code as T.<name> / q.<name> alongside numeric indices.
// Returns { tOut, tGround, control, errors } — fns ready for simulate().
export function compileInputs(inputs = {}, ctx = {}) {
  const errors = [];
  const tOut = compileValue(String(inputs.tOutCode ?? 'return 0;'), 'tOut', errors);
  const tGround = compileValue(String(inputs.tGroundCode ?? 'return 0;'), 'tGround', errors);
  const control = compileControl(String(inputs.controlCode ?? ''), ctx.n ?? 0, ctx.names ?? [], errors);
  return { tOut, tGround, control, errors };
}
