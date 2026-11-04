import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSeries } from '../src/series.js';

test('series: transposes step-major history into per-node series', () => {
  // solver format: T[step][node]
  const T = [
    [10, 20],
    [11, 21],
    [12, 22],
  ];
  const s = toSeries(T);
  assert.deepEqual(s, [
    [10, 11, 12], // node 0 over time
    [20, 21, 22], // node 1 over time
  ]);
});

test('series: non-finite values become null (chart gap, not garbage)', () => {
  const T = [
    [1, NaN],
    [2, undefined],
  ];
  const s = toSeries(T);
  assert.deepEqual(s, [
    [1, 2],
    [null, null],
  ]);
});

test('series: empty history yields no series', () => {
  assert.deepEqual(toSeries([]), []);
});
