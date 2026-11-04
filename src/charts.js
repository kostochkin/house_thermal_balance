// Chart.js wrapper: temperature curves + ambient temps (dashed) + power
// curves (dashed, right axis). Zoom plugin: wheel/pinch/pan, time axis only.
// Chart and ChartZoom are UMD globals from vendor/.

import { toSeries } from './series.js';

Chart.register(ChartZoom);

const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#46f0f0', '#f032e6', '#bcf60c', '#008080', '#9a6324', '#800000', '#3cb4b4'];

export function createTempChart(canvas) {
  return new Chart(canvas, {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: { title: { display: true, text: 'Time, h' } },
        y: { title: { display: true, text: 'Temperature, °C' } },
      },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 14, boxHeight: 3 } },
        tooltip: { callbacks: {} },
        zoom: {
          // pan on plain drag is occupied by drag-zoom, so pan is via Alt
          pan: { enabled: true, mode: 'x', modifierKey: 'alt' },
          zoom: {
            wheel: { enabled: true, mode: 'x' },
            pinch: { enabled: true, mode: 'x' },
            drag: {
              enabled: true, mode: 'x',   // drag-rectangle selects a time interval
              threshold: 5,               // threshold against accidental micro-selections, px
              borderColor: '#4363d8',
              backgroundColor: 'rgba(67, 99, 216, 0.15)',
            },
            mode: 'x',
          },
          limits: { x: { min: 'original', max: 'original' } },
        },
      },
    },
  });
}

// t: seconds[]; T: solver history T[step][node]; names: per-node labels;
// env: { tOut[], tGround[] } (optional); power: { supplied[], losses[] } in W
// (optional) — drawn dashed on the right axis in kW.
export function updateTempChart(chart, t, T, names, env = {}, power = {}) {
  const labels = t.map(s => (s / 3600).toFixed(2));
  const series = toSeries(T);
  const datasets = [];
  series.forEach((data, i) => {
    const name = names[i];
    if (!name) return; // never plot a series without a label
    datasets.push({
      label: name,
      data,
      borderColor: PALETTE[i % PALETTE.length],
      backgroundColor: PALETTE[i % PALETTE.length],
      tension: 0.15,
      pointRadius: 0,
      borderWidth: 2,
    });
  });
  if (env.tOut) {
    datasets.push({
      label: 'Street', data: env.tOut,
      borderColor: '#888', borderDash: [6, 4], pointRadius: 0, borderWidth: 1,
    });
  }
  if (env.tGround) {
    datasets.push({
      label: 'Ground', data: env.tGround,
      borderColor: '#a06a2c', borderDash: [2, 3], pointRadius: 0, borderWidth: 1,
    });
  }
  const kW = (arr) => arr.map(v => v / 1000);
  if (power.supplied) {
    datasets.push({
      label: 'Supplied', data: kW(power.supplied), yAxisID: 'y1',
      borderColor: 'rgba(31, 119, 180, 0.55)', borderDash: [8, 4],
      pointRadius: 0, borderWidth: 2, tension: 0.15,
    });
  }
  if (power.losses) {
    datasets.push({
      label: 'Losses', data: kW(power.losses), yAxisID: 'y1',
      borderColor: 'rgba(214, 39, 40, 0.55)', borderDash: [4, 3],
      pointRadius: 0, borderWidth: 2, tension: 0.15,
    });
  }
  // Right axis only shown while power series exist.
  chart.options.scales.y1 = {
    position: 'right',
    title: { display: true, text: 'Power, kW' },
    grid: { drawOnChartArea: false },
    display: !!(power.supplied || power.losses),
  };
  chart.data.labels = labels;
  chart.data.datasets = datasets;
  chart.update('none');
}
