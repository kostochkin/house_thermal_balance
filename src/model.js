// Thermal network model: N nodes with heat capacities, connected by
// conductances (W/K) to each other and to ambient environments.
//
// model: {
//   n: number,
//   C: number[],   // heat capacity of each node, J/K
//   K: number[][], // (n + nEnv) x (n + nEnv) conductance matrix, W/K.
//                  // Rows/cols 0..n-1: nodes. Rows/cols n..: environments
//                  // (env-to-env entries are ignored). Must be symmetric.
// }
//
// inputs: { q: number[], amb: number[] }
//   q[i]   - heat power injected into node i, W
//   amb[a] - temperature of environment a, °C (order must match env rows)
//
// dT_i/dt = ( sum_{j<n} K_ij (T_j - T_i) + sum_a K_i,{n+a} (amb[a] - T_i) + q_i ) / C_i

export function derivative(model, T, inputs) {
  const { n, C, K } = model;
  const m = K.length;
  const dT = new Array(n);
  for (let i = 0; i < n; i++) {
    let flow = inputs.q[i] || 0;
    const Ki = K[i];
    const Ti = T[i];
    for (let j = 0; j < m; j++) {
      if (j === i) continue;
      const Kij = Ki[j];
      if (!Kij) continue;
      const Tj = j < n ? T[j] : inputs.amb[j - n];
      flow += Kij * (Tj - Ti);
    }
    dT[i] = flow / C[i];
  }
  return dT;
}
