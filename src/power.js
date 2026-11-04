// Power series for the chart: total supplied heat and total losses to the
// environment (street + ground flows). Internal node-to-node flows are not
// losses — they cancel in the balance; only env columns count.
//
// q: qHist[step][node] (steps rows, as returned by simulate());
// t/T: steps+1 rows. The last supplied point holds the previous value so all
// series share the same time axis.
export function powerSeries(model, t, T, q, tOut, tGround) {
  const steps = t.length;
  const { n, K } = model;
  const supplied = new Array(steps);
  const losses = new Array(steps);
  for (let s = 0; s < steps; s++) {
    supplied[s] = s < q.length ? q[s].reduce((a, b) => a + b, 0) : supplied[s - 1];
    const tt = t[s];
    let loss = 0;
    for (let i = 0; i < n; i++) {
      loss += K[i][n] * (T[s][i] - tOut(tt)) + K[i][n + 1] * (T[s][i] - tGround(tt));
    }
    losses[s] = loss;
  }
  return { supplied, losses };
}
