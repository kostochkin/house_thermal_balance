// UI wiring: builds editable tables from the scenario, runs the solver,
// updates the chart. Chart.js is the UMD global loaded in index.html.
// Scenario is auto-saved to localStorage (debounced) and restored on page load;
// Save/Load buttons remain for file export/import.

import { defaultScenario, validateScenario, addNode, removeNode, ENV_NAMES, N_ENV, modelSI, loadScenario } from './scenario.js';
import { compileInputs, TOUT_PRESETS, TGROUND_PRESETS, CONTROL_PRESETS } from './programs.js';
import { steadyStateTarget } from './equilibrium.js';
import { simulate } from './solver.js';
import { powerSeries } from './power.js';
import { createTempChart, updateTempChart } from './charts.js';

const $ = (id) => document.getElementById(id);

let scenario = defaultScenario();
let chart = null;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function num(v, fallback = 0) {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : fallback;
}

// ---------- equilibrium dialog ----------

const EQ_SOURCE_KEY = 'teplo-eq-source';
let eqNode = null; // index of the pinned (target) node while the dialog is open

function openEqDialog(i) {
  const m = scenario.model;
  eqNode = i;
  $('eq-node').textContent = m.names[i];
  $('eq-target').value = scenario.init.T0[i];
  // Restore the last selected source (stored by name, survives node
  // rename/removal); default is the node itself.
  const saved = localStorage.getItem(EQ_SOURCE_KEY);
  const savedIdx = m.names.indexOf(saved);
  const pre = savedIdx >= 0 ? savedIdx : i;
  $('eq-source').innerHTML = m.names.map((n, j) =>
    `<option value="${j}" ${j === pre ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
  $('eq-dialog').showModal();
}

function bindEqDialog() {
  $('eq-dialog').addEventListener('close', () => {
    if ($('eq-dialog').returnValue !== 'apply') return;
    const m = scenario.model;
    const target = num($('eq-target').value, scenario.init.T0[eqNode]);
    const source = Math.min(Math.max(0, Math.round(num($('eq-source').value, eqNode))), m.n - 1);
    if (m.names[source]) localStorage.setItem(EQ_SOURCE_KEY, m.names[source]);
    const compiled = compileInputs(scenario.inputs, { n: m.n, names: m.names });
    const envT = [compiled.tOut(0), compiled.tGround(0)];
    const r = steadyStateTarget(modelSI(scenario), { node: eqNode, target, source, envT });
    if (r.error) {
      $('errors').textContent = `Equilibrium (${m.names[eqNode]}): ${r.error}`;
      return;
    }
    $('errors').textContent = '';
    scenario.init.T0 = r.T.map(v => Math.round(v * 100) / 100);
    renderNodes();
    refresh();
    const kw = (r.q[source] / 1000).toFixed(2);
    const cool = r.q[source] < 0 ? ' (cooling required)' : '';
    const where = source === eqNode ? 'into this node' : `into node ${m.names[source]}`;
    $('status').textContent = `Equilibrium at ${m.names[eqNode]} = ${target} °C: supply ${kw} kW ${where}${cool}`;
  });
}

// ---------- localStorage persistence ----------

const STORAGE_KEY = 'teplo-scenario';

// Restores the scenario saved by saveLocal(); null if absent/corrupt/invalid.
function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = loadScenario(JSON.parse(raw));
    return validateScenario(s).length ? null : s;
  } catch {
    return null; // corrupt JSON — fall back to defaults
  }
}

// Debounced: called on every refresh (i.e., after every edit), so rapid
// typing coalesces into one write.
let saveTimer = null;
function saveLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(scenario));
    } catch {
      // quota exceeded / private mode — persistence is best-effort
    }
  }, 300);
}

// ---------- simulation ----------

function runSim() {
  const m = scenario.model;
  const errs = validateScenario(scenario);
  if (errs.length) {
    $('errors').textContent = errs.join('; ');
    return null;
  }

  const compiled = compileInputs(scenario.inputs, { n: m.n, names: m.names });
  if (compiled.errors.length) {
    $('errors').textContent = compiled.errors.join('; ');
    return null;
  }
  $('errors').textContent = '';

  const model = modelSI(scenario);
  const res = simulate(model, {
    T0: scenario.init.T0,
    steps: scenario.init.steps,
    dt: scenario.init.dt,
    tOut: compiled.tOut,
    tGround: compiled.tGround,
    control: compiled.control,
  });
  return { res, model, tOut: compiled.tOut, tGround: compiled.tGround };
}

function refresh() {
  saveLocal(); // persist every edit, even mid-validation
  const run = runSim();
  if (!run) return;
  const { res, model, tOut, tGround } = run;
  const power = powerSeries(model, res.t, res.T, res.q, tOut, tGround);
  updateTempChart(chart, res.t, res.T, scenario.model.names, {
    tOut: res.t.map(tOut),
    tGround: res.t.map(tGround),
  }, power);
  const hours = (scenario.init.steps * scenario.init.dt / 3600).toFixed(1);
  const kw = (v) => (v / 1000).toFixed(2);
  const lastSup = power.supplied[power.supplied.length - 1];
  const lastLoss = power.losses[power.losses.length - 1];
  $('status').textContent =
    `${scenario.init.steps} steps · ${hours} h · nodes: ${scenario.model.n}` +
    ` · supplied ${kw(lastSup)} kW · losses ${kw(lastLoss)} kW`;
}

// ---------- rendering ----------

function renderNodes() {
  const m = scenario.model;
  const tbody = $('nodes-body');
  tbody.innerHTML = '';
  m.names.forEach((name, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input class="in-name" value="${escapeHtml(name)}"></td>
      <td><input class="in-c num" type="number" value="${m.C[i]}"></td>
      <td><input class="in-t0 num" type="number" value="${scenario.init.T0[i]}" step="0.5"></td>
      <td><button class="btn-eq" title="Equilibrium: solve power and temperatures of other nodes at this T₀">⇌</button></td>
      <td><button class="btn-del" title="Delete node">✕</button></td>`;
    tbody.appendChild(tr);

    tr.querySelector('.in-name').addEventListener('input', e => {
      m.names[i] = e.target.value;
      renderK(); refresh();
    });
    tr.querySelector('.in-c').addEventListener('input', e => {
      m.C[i] = num(e.target.value, m.C[i]); refresh();
    });
    tr.querySelector('.in-t0').addEventListener('input', e => {
      scenario.init.T0[i] = num(e.target.value, scenario.init.T0[i]); refresh();
    });
    tr.querySelector('.btn-eq').addEventListener('click', () => {
      openEqDialog(i);
    });
    tr.querySelector('.btn-del').addEventListener('click', () => {
      removeNode(scenario, i);
      renderAll(); refresh();
    });
  });
}

function renderK() {
  const m = scenario.model;
  const size = m.n + N_ENV;
  const allNames = [...m.names, ...ENV_NAMES];
  const tbl = $('k-matrix');
  tbl.innerHTML = '';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  hr.appendChild(document.createElement('th'));
  allNames.forEach((n, j) => {
    const th = document.createElement('th');
    th.textContent = n;
    if (j >= m.n) th.classList.add('env');
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  tbl.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let i = 0; i < size; i++) {
    const tr = document.createElement('tr');
    if (i >= m.n) tr.classList.add('env');
    const th = document.createElement('th');
    th.textContent = allNames[i];
    tr.appendChild(th);
    for (let j = 0; j < size; j++) {
      const td = document.createElement('td');
      const isEnv = i >= m.n && j >= m.n;
      if (i === j || isEnv) {
        // diagonal or env-to-env: not used by the solver
        const div = document.createElement('div');
        div.className = 'diag';
        div.textContent = '·';
        td.appendChild(div);
      } else {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.className = 'num';
        inp.value = m.K[i][j];
        inp.step = 10;
        inp.addEventListener('input', () => {
          const v = num(inp.value, 0);
          m.K[i][j] = v;
          m.K[j][i] = v; // keep symmetric
          // sync the mirrored cell visually
          const mirror = tbl.rows[1 + j].cells[1 + i].querySelector('input');
          if (mirror && mirror !== inp) mirror.value = v;
          refresh();
        });
        td.appendChild(inp);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  tbl.appendChild(tbody);
}

function renderParams() {
  $('in-dt').value = scenario.init.dt;
  $('in-steps').value = scenario.init.steps;
  $('in-tout-code').value = scenario.inputs.tOutCode;
  $('in-tground-code').value = scenario.inputs.tGroundCode;
  $('in-control-code').value = scenario.inputs.controlCode;
}

function renderAll() {
  renderParams();
  renderNodes();
  renderK();
  refresh();
}

// ---------- events ----------

// Populate a preset <select> and wire it: picking a preset replaces
// the code in the paired textarea (an "insert snippet" action).
function bindCodeEditor(codeId, selId, presets, key) {
  const sel = $(selId);
  sel.innerHTML = '<option value="">— choose a preset —</option>' +
    presets.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`).join('');
  sel.addEventListener('change', () => {
    if (sel.value === '') return;
    scenario.inputs[key] = presets[sel.value].code;
    $(codeId).value = scenario.inputs[key];
    sel.value = '';
    refresh();
  });
  $(codeId).addEventListener('input', e => {
    scenario.inputs[key] = e.target.value;
    refresh();
  });
}

function bindParams() {
  $('in-dt').addEventListener('input', e => { scenario.init.dt = Math.max(1, num(e.target.value, 60)); refresh(); });
  $('in-steps').addEventListener('input', e => { scenario.init.steps = Math.max(1, Math.round(num(e.target.value, 20160))); refresh(); });
  bindCodeEditor('in-tout-code', 'sel-tout', TOUT_PRESETS, 'tOutCode');
  bindCodeEditor('in-tground-code', 'sel-tground', TGROUND_PRESETS, 'tGroundCode');
  bindCodeEditor('in-control-code', 'sel-control', CONTROL_PRESETS, 'controlCode');
  $('btn-add-node').addEventListener('click', () => { addNode(scenario); renderAll(); });
  $('btn-run').addEventListener('click', refresh);
  $('btn-reset').addEventListener('click', () => { scenario = defaultScenario(); renderAll(); });
  $('btn-reset-zoom').addEventListener('click', () => chart.resetZoom());
  $('temp-chart').addEventListener('dblclick', () => chart.resetZoom());
  $('btn-save').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(scenario, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'teplo-scenario.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('btn-load').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const s = loadScenario(JSON.parse(reader.result));
        const errs = validateScenario(s);
        if (errs.length) { $('errors').textContent = 'Invalid scenario: ' + errs.join('; '); return; }
        scenario = s;
        renderAll();
      } catch {
        $('errors').textContent = 'Failed to parse JSON';
      }
    };
    reader.readAsText(f);
    e.target.value = '';
  });
}

// ---------- init ----------

// Restore last session from localStorage; fall back to defaults when absent
// or corrupt (loadLocal returns null in both cases).
scenario = loadLocal() ?? defaultScenario();

chart = createTempChart($('temp-chart'));
bindParams();
bindEqDialog();
renderAll();
