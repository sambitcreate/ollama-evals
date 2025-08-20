/* Parses data.md and renders a Vercel-like dashboard */
const EXPECTED_ANSWER = 3600;

const el = (sel, root = document) => root.querySelector(sel);
const els = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function parseDurationToSeconds(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Supports formats like "10m16.674888625s", "36.477755333s", "79.06375ms"
  const minMatch = s.match(/([0-9]+(?:\.[0-9]+)?)m/);
  const secMatch = s.match(/([0-9]+(?:\.[0-9]+)?)s/);
  const msMatch = s.match(/([0-9]+(?:\.[0-9]+)?)ms/);
  let seconds = 0;
  if (minMatch) seconds += parseFloat(minMatch[1]) * 60;
  if (secMatch) seconds += parseFloat(secMatch[1]);
  if (!secMatch && msMatch) seconds += parseFloat(msMatch[1]) / 1000;
  return seconds || null;
}

function fmtSeconds(sec) {
  if (sec == null || isNaN(sec)) return '—';
  if (sec < 1) return `${(sec * 1000).toFixed(0)} ms`;
  if (sec < 60) return `${sec.toFixed(2)} s`;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}m ${s.toFixed(1)}s`;
}

function extractNumberFromText(text) {
  if (!text) return null;
  const nums = String(text)
    .replace(/[,^\n]/g, ' ')
    .match(/-?\d+(?:\.\d+)?/g);
  if (!nums || !nums.length) return null;
  // Prefer a 3+ digit integer (like 3600). If none, take the last number on the line.
  const bigInt = nums
    .map(n => n)
    .filter(n => /^-?\d{3,}$/.test(n));
  const chosen = bigInt.length ? bigInt[0] : nums[nums.length - 1];
  const num = Number(chosen);
  return Number.isFinite(num) ? num : null;
}

async function loadData() {
  const res = await fetch('data.md');
  if (!res.ok) throw new Error('Failed to load data.md');
  const txt = await res.text();
  const lines = txt.split(/\r?\n/);

  const isModelHeader = (line) => /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+/.test(line.trim());

  /** @type {Array<any>} */
  const models = [];
  let cur = null;
  let afterHeaderLineCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('```')) continue;

    if (isModelHeader(line)) {
      if (cur) models.push(cur);
      cur = {
        name: line.replace(/\s+$/,'') ,
        answerLine: null,
        numericAnswer: null,
        metrics: {},
      };
      afterHeaderLineCount = 0;
      continue;
    }

    if (!cur) continue;
    afterHeaderLineCount++;

    // Capture early answer line before metrics
    if (!cur.answerLine && afterHeaderLineCount <= 6) {
      if (/Step\s*5:/i.test(line) || /answer/i.test(line) || /The\s+trains/i.test(line)) {
        cur.answerLine = raw.trim();
        cur.numericAnswer = extractNumberFromText(cur.answerLine);
        continue;
      }
    }

    // Metrics
    const m = raw.match(/^(total duration|load duration|prompt eval count|prompt eval duration|prompt eval rate|eval count|eval duration|eval rate):\s*(.+)$/i);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      cur.metrics[key] = val;
      continue;
    }

    // Some models put the answer without the "Step 5" prefix
    if (!cur.answerLine && /\b(\d{3,})\b/.test(line) && !/duration|count|rate/i.test(line)) {
      cur.answerLine = raw.trim();
      cur.numericAnswer = extractNumberFromText(cur.answerLine);
    }
  }
  if (cur) models.push(cur);

  // Normalize metrics to seconds or numbers where helpful
  for (const m of models) {
    const md = m.metrics;
    m.totalSeconds = parseDurationToSeconds(md['total duration']);
    m.loadSeconds = parseDurationToSeconds(md['load duration']);
    m.promptCount = md['prompt eval count'] ? Number(String(md['prompt eval count']).match(/\d+/)?.[0]) : null;
    m.evalCount = md['eval count'] ? Number(String(md['eval count']).match(/\d+/)?.[0]) : null;
    m.promptDurationSeconds = parseDurationToSeconds(md['prompt eval duration']);
    m.evalDurationSeconds = parseDurationToSeconds(md['eval duration']);
    m.promptRate = md['prompt eval rate'] ? Number(String(md['prompt eval rate']).match(/(-?\d+(?:\.\d+)?)/)?.[1]) : null;
    m.evalRate = md['eval rate'] ? Number(String(md['eval rate']).match(/(-?\d+(?:\.\d+)?)/)?.[1]) : null;
    m.correct = Number(m.numericAnswer) === EXPECTED_ANSWER;
  }

  return models;
}

function renderOptions(models) {
  const names = models.map(m => m.name);
  const a = el('#modelA');
  const b = el('#modelB');
  const opts = names.map(n => `<option value="${n}">${n}</option>`).join('');
  a.innerHTML = `<option value="">Select a model…</option>` + opts;
  b.innerHTML = `<option value="">Select a model…</option>` + opts;
}

function createCard(model) {
  const tpl = el('#card-tpl');
  const node = tpl.content.firstElementChild.cloneNode(true);
  el('.model-name', node).textContent = model.name;
  const badge = el('.badge', node);
  badge.textContent = model.correct ? 'Correct' : 'Incorrect';
  badge.classList.add(model.correct ? 'correct' : 'incorrect');
  el('.answer', node).textContent = model.answerLine || '—';

  el('.total', node).textContent = fmtSeconds(model.totalSeconds);
  el('.load', node).textContent = fmtSeconds(model.loadSeconds);

  const promptBits = [];
  if (Number.isFinite(model.promptCount)) promptBits.push(`${model.promptCount} tok`);
  if (Number.isFinite(model.promptDurationSeconds)) promptBits.push(fmtSeconds(model.promptDurationSeconds));
  el('.prompt', node).textContent = promptBits.join(' • ') || '—';

  const genBits = [];
  if (Number.isFinite(model.evalCount)) genBits.push(`${model.evalCount} tok`);
  if (Number.isFinite(model.evalDurationSeconds)) genBits.push(fmtSeconds(model.evalDurationSeconds));
  el('.gen', node).textContent = genBits.join(' • ') || '—';

  return node;
}

function renderGrid(models, filter = '') {
  const grid = el('#grid');
  grid.innerHTML = '';
  const q = filter.trim().toLowerCase();
  const filtered = q ? models.filter(m => m.name.toLowerCase().includes(q)) : models;
  el('#modelCount').textContent = `${filtered.length} of ${models.length}`;
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'card empty';
    empty.textContent = 'No models match your search.';
    grid.appendChild(empty);
    return;
  }
  for (const m of filtered) grid.appendChild(createCard(m));
}

function compareRow(label, aVal, bVal, betterFn) {
  const wrap = document.createElement('div');
  wrap.className = 'compare-grid';

  const makeCell = (title, value) => {
    const box = document.createElement('div');
    box.className = 'kv';
    const h = document.createElement('h4');
    h.textContent = title;
    const row = document.createElement('div');
    row.className = 'kv-row';
    const lab = document.createElement('span');
    lab.className = 'label';
    lab.textContent = label;
    const val = document.createElement('span');
    val.className = 'value';
    val.textContent = value;
    row.appendChild(lab); row.appendChild(val);
    box.appendChild(h); box.appendChild(row);
    return { box, row };
  };

  const a = makeCell('Model A', aVal);
  const b = makeCell('Model B', bVal);

  // Mark which is better
  if (betterFn) {
    const c = betterFn();
    if (c < 0) a.row.classList.add('better');
    else if (c > 0) b.row.classList.add('better');
  }

  wrap.appendChild(a.box);
  wrap.appendChild(b.box);
  return wrap;
}

function renderCompare(models) {
  const box = el('#compare');
  box.innerHTML = '';

  const nameA = el('#modelA').value;
  const nameB = el('#modelB').value;
  const A = models.find(m => m.name === nameA);
  const B = models.find(m => m.name === nameB);
  if (!A || !B) {
    box.innerHTML = '<div class="empty">Pick two models to compare.</div>';
    return;
  }

  const rows = [];
  rows.push(compareRow('Total duration', fmtSeconds(A.totalSeconds), fmtSeconds(B.totalSeconds), () => (A.totalSeconds ?? Infinity) - (B.totalSeconds ?? Infinity)));
  rows.push(compareRow('Load duration', fmtSeconds(A.loadSeconds), fmtSeconds(B.loadSeconds), () => (A.loadSeconds ?? Infinity) - (B.loadSeconds ?? Infinity)));
  rows.push(compareRow('Prompt tokens', A.promptCount ?? '—', B.promptCount ?? '—', () => (B.promptCount ?? 0) - (A.promptCount ?? 0))); // more tokens could mean harder input; neutral
  rows.push(compareRow('Prompt duration', fmtSeconds(A.promptDurationSeconds), fmtSeconds(B.promptDurationSeconds), () => (A.promptDurationSeconds ?? Infinity) - (B.promptDurationSeconds ?? Infinity)));
  rows.push(compareRow('Generate tokens', A.evalCount ?? '—', B.evalCount ?? '—', () => (B.evalCount ?? 0) - (A.evalCount ?? 0)));
  rows.push(compareRow('Generate duration', fmtSeconds(A.evalDurationSeconds), fmtSeconds(B.evalDurationSeconds), () => (A.evalDurationSeconds ?? Infinity) - (B.evalDurationSeconds ?? Infinity)));
  rows.push(compareRow('Answer', A.answerLine || '—', B.answerLine || '—'));
  rows.push(compareRow('Correct?', A.correct ? 'Correct' : 'Incorrect', B.correct ? 'Correct' : 'Incorrect'));

  for (const r of rows) box.appendChild(r);
}

(async function init() {
  try {
    const models = await loadData();
    renderOptions(models);
    renderGrid(models);

    el('#search').addEventListener('input', (e) => {
      renderGrid(models, e.target.value);
    });
    els('#modelA, #modelB').forEach(s => s.addEventListener('change', () => renderCompare(models)));
  } catch (err) {
    const grid = el('#grid');
    grid.innerHTML = `<div class="card empty">${err.message}</div>`;
  }
})();
