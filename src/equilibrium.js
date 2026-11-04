// Equilibrium (steady state) of the thermal network.
//
// With fixed per-node power q and fixed env temperatures the network is
// linear in T, so the equilibrium is the solution of a linear system, not
// a simulation:
//   for each node i:  sum_j K_ij (T_j - T_i) + sum_e K_ie (T_e - T_i) + q_i = 0
// A group of nodes with no path to any environment has no equilibrium
// (temperature drifts forever) — the system matrix is singular, we report
// an error instead of returning garbage.

// Gaussian elimination with partial pivoting. Returns null when singular.
export function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (!f) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = M.map((row, i) => row[n] / row[i]);
  return x.every(Number.isFinite) ? x : null;
}

// Build A·T = b for the node temperatures (q in W, envT = [street, ground]).
function system(model, q, envT) {
  const { n, K } = model;
  const A = [], b = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(n).fill(0);
    let bi = q[i] ?? 0;
    for (let j = 0; j < n + 2; j++) {
      const k = K[i][j];
      if (j === i || !k) continue;
      if (j < n) row[j] -= k;
      else bi += k * envT[j - n];
      row[i] += k;
    }
    A.push(row);
    b.push(bi);
  }
  return { A, b };
}

// Equilibrium temperatures with constant per-node power q (W).
// Returns { T } or { error }.
export function steadyState(model, { q = [], envT }) {
  const { A, b } = system(model, q, envT);
  const T = solveLinear(A, b);
  if (!T) return { error: 'no equilibrium: the network has no heat path to the environment (singular system)' };
  return { T };
}

// Equilibrium with node `node` pinned to `target` °C; the required power is
// solved for the source node `source` (default: the pinned node itself).
// Other nodes get q = 0. Returns { T, q } or { error }.
// Unknowns: T[0..n-1] and q_source; equations: n equilibrium rows + pin row.
export function steadyStateTarget(model, { node, target, source, envT }) {
  const src = source ?? node;
  const { n, K } = model;
  const size = n + 1;
  const A = [], b = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(size).fill(0);
    let bi = 0;
    for (let j = 0; j < n + 2; j++) {
      const k = K[i][j];
      if (j === i || !k) continue;
      if (j < n) row[j] -= k;
      else bi += k * envT[j - n];
      row[i] += k;
    }
    if (i === src) row[n] = -1; // -q_src, so the solved q is the injected power
    A.push(row);
    b.push(bi);
  }
  const pin = new Array(size).fill(0);
  pin[node] = 1;
  A.push(pin);
  b.push(target);
  const x = solveLinear(A, b);
  if (!x) return { error: 'no equilibrium: the network has no heat path to the environment (singular system)' };
  const T = x.slice(0, n);
  const q = new Array(n).fill(0);
  q[src] = x[n];
  return { T, q };
}
