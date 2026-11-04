// Transpose simulation history from solver format T[step][node]
// into per-node series T[node][step] for plotting.
// Non-finite values become null so Chart.js draws a gap instead of garbage.

export function toSeries(T) {
  const steps = T.length;
  if (!steps) return [];
  const n = T[0].length;
  const out = [];
  for (let node = 0; node < n; node++) {
    const data = new Array(steps);
    for (let s = 0; s < steps; s++) {
      const v = T[s][node];
      data[s] = Number.isFinite(v) ? v : null;
    }
    out.push(data);
  }
  return out;
}
