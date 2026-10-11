const N = 8;

// Base shapes; every distinct rotation/reflection becomes its own selectable piece
// (Block Blast does not let you rotate pieces).
const BASES = [
  ['X'], ['XX'], ['XXX'], ['XXXX'], ['XXXXX'],
  ['XX', 'XX'], ['XXX', 'XXX', 'XXX'], ['XXX', 'XXX'],
  ['X.', 'XX'], ['X..', 'X..', 'XXX'], ['X.', 'X.', 'XX'],
  ['XXX', '.X.'], ['XX.', '.XX'], ['XX', 'X.', 'X.'],
  ['XXX', 'X..', 'X..'], ['XX', 'XX', 'X.'], ['XX', 'X.', 'XX']
];

const rot = s => s[0].split('').map((_, c) => s.map(r => r[c]).reverse().join(''));
const flip = s => s.map(r => r.split('').reverse().join(''));

const PIECES = [];
const seen = new Set();
for (const base of BASES) {
  let s = base;
  for (const v of [base, flip(base)]) {
    s = v;
    for (let i = 0; i < 4; i++) {
      const key = s.join('/');
      if (!seen.has(key)) {
        seen.add(key);
        const cells = [];
        s.forEach((row, r) => [...row].forEach((ch, c) => ch === 'X' && cells.push([r, c])));
        PIECES.push({ shape: s, cells, h: s.length, w: s[0].length });
      }
      s = rot(s);
    }
  }
}

const $ = id => document.getElementById(id);
let board = Array.from({ length: N }, () => Array(N).fill(0));
const slots = [null, null, null];
let selSlot = 0;

function miniEl(p) {
  const d = document.createElement('div');
  d.className = 'mini';
  d.style.gridTemplateColumns = `repeat(${p.w}, auto)`;
  p.shape.forEach(row => [...row].forEach(ch => {
    const i = document.createElement('i');
    if (ch === 'X') i.className = 'f';
    d.appendChild(i);
  }));
  return d;
}

function renderBoard(el, grid, opts = {}) {
  el.innerHTML = '';
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const d = document.createElement('div');
    d.className = 'cell';
    if (grid[r][c] === 1) d.classList.add('on');
    if (opts.place && opts.place.has(r * N + c)) d.classList.add('place');
    if (opts.clear && opts.clear.has(r * N + c)) d.classList.add('clear');
    if (opts.edit) d.dataset.i = r * N + c;
    el.appendChild(d);
  }
}

// Board editing with tap or drag-paint
let paint = null;
const boardEl = $('board');
function cellAt(e) {
  const t = document.elementFromPoint(e.clientX, e.clientY);
  return t && t.dataset && t.dataset.i !== undefined ? +t.dataset.i : null;
}
function apply(i) {
  const r = Math.floor(i / N), c = i % N;
  if (board[r][c] === paint) return;
  board[r][c] = paint;
  boardEl.children[i].classList.toggle('on', !!paint);
}
boardEl.addEventListener('pointerdown', e => {
  const i = cellAt(e);
  if (i === null) return;
  paint = board[Math.floor(i / N)][i % N] ? 0 : 1;
  apply(i);
});
boardEl.addEventListener('pointermove', e => {
  if (paint === null) return;
  const i = cellAt(e);
  if (i !== null) apply(i);
});
addEventListener('pointerup', () => { paint = null; });
$('clear').onclick = () => {
  board = board.map(r => r.map(() => 0));
  renderBoard(boardEl, board, { edit: true });
};

function renderSlots() {
  const el = $('slots');
  el.innerHTML = '';
  slots.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'slot' + (i === selSlot ? ' sel' : '');
    d.onclick = () => { selSlot = i; renderSlots(); };
    d.appendChild(p ? miniEl(p) : Object.assign(document.createElement('span'), { textContent: 'empty' }));
    el.appendChild(d);
  });
}

PIECES.forEach(p => {
  const b = document.createElement('button');
  b.className = 'opt';
  b.appendChild(miniEl(p));
  b.onclick = () => {
    slots[selSlot] = p;
    selSlot = slots.findIndex(s => !s);
    if (selSlot < 0) selSlot = 0;
    renderSlots();
  };
  $('palette').appendChild(b);
});

// ---- Solver ----
// Scoring: 1 point per cell placed, plus 10 * lines^2 for lines cleared at once
// (a rough model of Block Blast's combo bonus).
function canPlace(g, p, r, c) {
  for (const [dr, dc] of p.cells) {
    const rr = r + dr, cc = c + dc;
    if (rr >= N || cc >= N || g[rr][cc]) return false;
  }
  return true;
}

function placeAndClear(g, p, r, c) {
  const ng = g.map(row => row.slice());
  const placed = new Set();
  for (const [dr, dc] of p.cells) { ng[r + dr][c + dc] = 1; placed.add((r + dr) * N + c + dc); }
  const rows = [], cols = [];
  for (let i = 0; i < N; i++) {
    if (ng[i].every(v => v)) rows.push(i);
    if (ng.every(row => row[i])) cols.push(i);
  }
  const cleared = new Set();
  rows.forEach(i => { for (let j = 0; j < N; j++) cleared.add(i * N + j); });
  cols.forEach(j => { for (let i = 0; i < N; i++) cleared.add(i * N + j); });
  cleared.forEach(k => { ng[Math.floor(k / N)][k % N] = 0; });
  const lines = rows.length + cols.length;
  return { grid: ng, placed, cleared, score: p.cells.length + 10 * lines * lines, lines };
}

function evalBoard(g) {
  // Heuristic for leftover board quality: fewer filled cells, fewer isolated holes.
  let filled = 0, holes = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (g[r][c]) { filled++; continue; }
    const nb = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
    if (nb.every(([a, b]) => a < 0 || b < 0 || a >= N || b >= N || g[a][b])) holes++;
  }
  return -filled - 3 * holes;
}

function permutations(a) {
  if (a.length <= 1) return [a];
  return a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]));
}

function solve(g, pieces) {
  let best = null;
  const order = permutations(pieces.map((p, i) => i));
  for (const ord of order) {
    const rec = (grid, k, steps, score) => {
      if (k === ord.length) {
        const total = score * 100 + evalBoard(grid);
        if (!best || total > best.total) best = { total, steps, score, grid };
        return;
      }
      const p = pieces[ord[k]];
      let any = false;
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (!canPlace(grid, p, r, c)) continue;
        any = true;
        const res = placeAndClear(grid, p, r, c);
        rec(res.grid, k + 1, [...steps, { slot: ord[k], r, c, before: grid, res }], score + res.score);
      }
      if (!any) {
        // piece can't be placed: record partial line, penalized heavily
        const total = (score - 1000) * 100 + evalBoard(grid) - (ord.length - k) * 50;
        if (!best || total > best.total) best = { total, steps, score, grid, stuck: true };
      }
    };
    rec(g, 0, [], 0);
  }
  return best;
}

$('solve').onclick = () => {
  const pieces = slots.filter(Boolean);
  if (!pieces.length) { alert('Pick at least one piece.'); return; }
  const out = solve(board, pieces);
  const sum = $('summary'), stepsEl = $('steps');
  $('result').hidden = false;
  stepsEl.innerHTML = '';
  if (!out || !out.steps.length) {
    sum.innerHTML = '<b style="color:#ff6b6b">No legal placement found — game over for this set.</b>';
    return;
  }
  const lines = out.steps.reduce((a, s) => a + s.res.lines, 0);
  sum.innerHTML = out.stuck
    ? '<b style="color:#ff6b6b">Warning:</b> not every piece can be placed. Best partial line shown. '
    : `Best score: <b>${out.score}</b> pts · ${lines} line${lines === 1 ? '' : 's'} cleared`;
  const pieceNames = ['A', 'B', 'C'];
  out.steps.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'step';
    const lab = document.createElement('div');
    lab.className = 'label';
    lab.textContent = `Move ${i + 1}: piece ${pieceNames[slots.indexOf(pieces[s.slot])] || s.slot + 1}` +
      ` → row ${s.r + 1}, col ${s.c + 1}` + (s.res.lines ? ` (clears ${s.res.lines})` : '');
    const b = document.createElement('div');
    b.className = 'board';
    renderBoard(b, s.before.map((row, r) => row.map((v, c) => v || s.res.placed.has(r * N + c) ? 1 : 0)), { place: s.res.placed, clear: s.res.cleared });
    div.append(lab, b);
    stepsEl.appendChild(div);
  });
  $('result').scrollIntoView({ behavior: 'smooth' });
};

renderBoard(boardEl, board, { edit: true });
renderSlots();
