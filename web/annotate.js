// The annotator: a frame opened large over the editor, to show exactly what a note is about. Draw
// boxes, brush strokes, arrows and points; each mark is numbered and gets its own words. It saves as
// one frame note. Claude reads every mark (where it is, as fractions and pixels, and what you wrote)
// and sees the frame with the marks drawn on it, made here from exactly what you saw.

import { S, on, emit, here, commit, mediaUrl, sceneRange, sceneColor } from './store.js';
import { snapFrame, findScene, activeRender } from '/lib/ops.js';
import { h, tc, toast, clamp } from './util.js';
import { icons } from './icons.js';
import { pause, seek } from './player.js';
import { uploadFile } from './attach.js';

export const MARK_COLORS = ['#ff453a', '#ffd23f', '#4cc9f0', '#f4f1ea'];
const TOOLS = [
  { id: 'rect', key: 'r', label: 'Box', icon: 'box' },
  { id: 'stroke', key: 'b', label: 'Brush', icon: 'brush' },
  { id: 'arrow', key: 'a', label: 'Arrow', icon: 'arrowTool' },
  { id: 'point', key: 'p', label: 'Point', icon: 'pin' },
];
let tool = 'rect', color = MARK_COLORS[0]; // remembered from one opening to the next
let A = null; // the open annotator

// ---------------------------------------------------------------- drawing marks (shared with the monitor)

const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  return el;
};

// Where a mark's number sits: just off the mark, so it covers none of it (outside a box's top-left
// corner, behind an arrow's tail or a stroke's start, beside a point). P maps frame fractions to
// [x, y]; k scales the gap (1 on screen, the picture's own scale in the composite).
export function anchor(m, P, k = 1) {
  if (m.kind === 'point') { const [x, y] = P(m.x, m.y); return [x + 16 * k, y - 16 * k]; }
  if (m.kind === 'rect') { const [x, y] = P(m.x, m.y); return [x - 12 * k, y - 12 * k]; }
  const [a, b] = m.kind === 'arrow' ? [[m.x1, m.y1], [m.x2, m.y2]] : [m.points[0], m.points[Math.min(m.points.length - 1, 4)]];
  const [x1, y1] = P(a[0], a[1]), [x2, y2] = P(b[0], b[1]), L = Math.hypot(x2 - x1, y2 - y1) || 1;
  return [x1 - ((x2 - x1) / L) * 15 * k, y1 - ((y2 - y1) / L) * 15 * k];
}

// One mark as SVG in screen space, over a dark halo so it reads on light, dark and same-coloured
// frames alike. With hit, it also gets a wide invisible edge to grab it by.
export function markShape(m, P, { i = null, sel = false, hit = false, hover = false } = {}) {
  const g = sv('g', { class: `mk${sel ? ' sel' : ''}${hover ? ' hover' : ''}`, 'data-i': i });
  const parts = [];
  const line = (attrs, w) => parts.push([attrs, w]);
  if (m.kind === 'rect') {
    const [x0, y0] = P(m.x, m.y), [x1, y1] = P(m.x + m.w, m.y + m.h);
    g.append(sv('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: m.color, 'fill-opacity': 0.1, stroke: 'none' }));
    line({ tag: 'rect', x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: 'none' }, 2.5);
  } else if (m.kind === 'stroke') {
    const d = m.points.map((p, k) => { const [x, y] = P(p[0], p[1]); return `${k ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; }).join('');
    line({ tag: 'path', d, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, 3.5);
  } else if (m.kind === 'arrow') {
    const [x1, y1] = P(m.x1, m.y1), [x2, y2] = P(m.x2, m.y2);
    const a = Math.atan2(y2 - y1, x2 - x1), L = 18, W = 9;
    const bx = x2 - L * Math.cos(a), by = y2 - L * Math.sin(a);
    line({ tag: 'line', x1, y1, x2: bx, y2: by, 'stroke-linecap': 'round' }, 3.5);
    const head = `M${x2} ${y2}L${bx + W * Math.sin(a)} ${by - W * Math.cos(a)}L${bx - W * Math.sin(a)} ${by + W * Math.cos(a)}Z`;
    g.append(sv('path', { d: head, fill: '#000', 'fill-opacity': 0.5, stroke: '#000', 'stroke-opacity': 0.5, 'stroke-width': 4, 'stroke-linejoin': 'round' }));
    g.append(sv('path', { d: head, fill: m.color, stroke: m.color, 'stroke-width': 1, 'stroke-linejoin': 'round' }));
  } else {
    const [x, y] = P(m.x, m.y);
    line({ tag: 'circle', cx: x, cy: y, r: 10, fill: 'none' }, 3);
    g.append(sv('circle', { cx: x, cy: y, r: 3, fill: m.color }));
  }
  for (const [{ tag, ...attrs }, w] of parts) {
    g.prepend(sv(tag, { ...attrs, stroke: '#000', 'stroke-opacity': 0.5, 'stroke-width': w + 4 }));
    g.append(sv(tag, { ...attrs, stroke: m.color, 'stroke-width': w }));
    if (sel) g.prepend(sv(tag, { ...attrs, stroke: '#fff', 'stroke-opacity': 0.55, 'stroke-width': w + 6 }));
    if (hit) g.append(sv(tag, { ...attrs, class: 'hit', fill: 'none', stroke: 'transparent', 'stroke-width': w + 14 }));
  }
  return g;
}

export const ink = c => { // dark text on light marks
  const n = parseInt(c.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? '#111' : '#fff';
};

// The marks of a note over the monitor, on their frame: shapes and numbers, nothing to edit. Click
// one to open the note in the annotator.
export function marksOverlay(n, w, hgt) {
  const P = (x, y) => [x * w, y * hgt];
  const svg = sv('svg', { class: 'mo-svg', width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}` });
  for (const m of n.markup.marks) svg.append(markShape(m, P));
  const wrap = h('div.marks-overlay', { title: 'Open the marks', onpointerdown: e => e.stopPropagation(), onclick: e => { e.stopPropagation(); openAnnotator({ note: n.id }); } });
  wrap.append(svg);
  for (const m of n.markup.marks) {
    const [x, y] = anchor(m, P).map((v, j) => clamp(v, 10, (j ? hgt : w) - 10));
    wrap.append(h('span.mk-n.mo', { style: { left: x + 'px', top: y + 'px', '--mc': m.color, color: ink(m.color) }, title: m.text || '' }, String(m.n)));
  }
  return wrap;
}

// ---------------------------------------------------------------- opening

// Opens on the frame under the playhead, or on a note's marks (to change them while it's a draft,
// otherwise to look). text: words already typed in the message bar come along as the note's text.
export async function openAnnotator({ note = null, text = '' } = {}) {
  if (!S.board?.scenes.length) return toast('Add a scene first, then mark up its frames');
  if (A) return;
  if (S.playing) pause();
  let n = null, scene, at;
  if (note) {
    n = S.board.notes.find(x => x.id === note);
    if (!n?.markup || !findScene(S.board, n.scene)) return;
    scene = n.scene;
    at = n.at ?? 0;
  } else {
    const hit = here();
    scene = hit.scene.id;
    at = snapFrame(S.board, hit.local);
  }
  A = {
    scene, at, noteId: n?.id ?? null, readOnly: !!n && !(n.author === 'you' && !n.sent),
    marks: n ? structuredClone(n.markup.marks) : [], overall: n ? n.text : text, base: n?.markup.frame ?? null, render: n?.markup.render ?? null,
    W: S.board.width, H: S.board.height, zoom: 1, panX: 0, panY: 0,
    sel: null, editing: null, draft: null, hover: null, lastPoint: null, history: [], future: [], dirty: false, space: false, loading: true,
    saving: false, discard: false, labels: [],
  };
  build();
  addEventListener('keydown', onKey, true);
  addEventListener('keyup', onKeyUp, true);
  addEventListener('resize', onResize);
  await loadFrame();
}

function close(force = false) {
  if (!A) return;
  if (!force && A.dirty && !A.readOnly && !A.discard) { A.discard = true; return side(); }
  removeEventListener('keydown', onKey, true);
  removeEventListener('keyup', onKeyUp, true);
  removeEventListener('resize', onResize);
  if (A.url) URL.revokeObjectURL(A.url);
  A.el.remove();
  A = null;
}

// ---------------------------------------------------------------- the frame

// The bare frame, from the server (the same picture agents get), or the one a note was drawn on.
async function loadFrame() {
  const a = A;
  a.loading = true;
  a.el.classList.add('loading');
  const s = findScene(S.board, a.scene);
  const r = activeRender(s);
  try {
    let blob;
    if (a.base) blob = await (await fetch(mediaUrl(a.base))).blob();
    else if (!r) blob = await cardImage(s);
    else {
      const res = await fetch(`/api/boards/${encodeURIComponent(S.slug)}/frame?scene=${encodeURIComponent(a.scene)}&at=${a.at}&w=${Math.min(2560, S.board.width)}`);
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      blob = await res.blob();
      a.render = r.id;
    }
    if (a !== A) return;
    a.blob = blob;
    if (a.url) URL.revokeObjectURL(a.url);
    a.url = URL.createObjectURL(blob);
    a.img.src = a.url;
    await a.img.decode();
    if (a !== A) return;
    a.img.classList.remove('in');
    void a.img.offsetWidth;
    a.img.classList.add('in');
  } catch (e) {
    if (a !== A) return;
    a.el.querySelector('.anno-load').textContent = `Couldn't get this frame: ${e.message}`;
    return;
  }
  a.loading = false;
  a.el.classList.remove('loading');
  head();
  fit();
}

// A scene with nothing rendered yet: its storyboard card, drawn here so it can be marked up too.
async function cardImage(s) {
  const W = 1600, H = Math.round((1600 * S.board.height) / S.board.width);
  const c = h('canvas', { width: W, height: H });
  const g = c.getContext('2d');
  g.fillStyle = '#111114';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#ecebe8';
  g.font = `italic ${Math.round(W * 0.06)}px "New York", Georgia, serif`;
  g.fillText(s.title, W * 0.08, H * 0.45);
  g.fillStyle = '#86858c';
  g.font = `${Math.round(W * 0.018)}px -apple-system, sans-serif`;
  wrap(g, s.picture || '', W * 0.08, H * 0.55, W * 0.7, W * 0.026).forEach(([t, x, y]) => g.fillText(t, x, y));
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
}

// Another frame of the same scene (← →): the marks stay; the note will be about the new frame.
function step(dir) {
  if (A.readOnly || A.loading) return;
  const b = S.board, s = findScene(b, A.scene);
  const at = clamp(snapFrame(b, A.at + dir / b.fps), 0, Math.max(0, s.duration - 1 / b.fps));
  if (Math.abs(at - A.at) < 1e-9) return;
  A.at = at;
  A.base = null;
  A.dirty = true;
  seek(sceneRange(A.scene).start + at);
  loadFrame();
}

// ---------------------------------------------------------------- view: zoom and pan

const stageSize = () => [A.stage.clientWidth, A.stage.clientHeight];

function fit() {
  const [sw, sh] = stageSize();
  A.zoom = Math.max(0.02, Math.min((sw - 48) / A.W, (sh - 48) / A.H));
  A.panX = (sw - A.W * A.zoom) / 2;
  A.panY = (sh - A.H * A.zoom) / 2;
  view();
}

function zoomAt(z, sx, sy) {
  const nz = clamp(z, 0.05, 8);
  const fx = (sx - A.panX) / (A.W * A.zoom), fy = (sy - A.panY) / (A.H * A.zoom);
  A.zoom = nz;
  A.panX = sx - fx * A.W * nz;
  A.panY = sy - fy * A.H * nz;
  view();
}
const zoomBy = f => { const [sw, sh] = stageSize(); zoomAt(A.zoom * f, sw / 2, sh / 2); };

function view() {
  const img = A.img;
  img.style.width = A.W + 'px';
  img.style.height = A.H + 'px';
  img.style.transform = `translate(${A.panX}px, ${A.panY}px) scale(${A.zoom})`;
  img.classList.toggle('pixels', img.naturalWidth && (A.zoom * A.W) / img.naturalWidth >= 2);
  A.zoomEl.textContent = `${Math.round(A.zoom * 100)}%`;
  paint();
}

function onResize() { if (A && !A.loading) fit(); }

// frame fractions ↔ the stage
const P = (x, y) => [A.panX + x * A.W * A.zoom, A.panY + y * A.H * A.zoom];
function frac(e) {
  const r = A.stage.getBoundingClientRect();
  return [clamp((e.clientX - r.left - A.panX) / (A.W * A.zoom), 0, 1), clamp((e.clientY - r.top - A.panY) / (A.H * A.zoom), 0, 1)];
}

// ---------------------------------------------------------------- painting the marks

// The handles a selected mark is reshaped by: a box's corners, an arrow's two ends.
const grips = m => (m.kind === 'rect' ? [['nw', m.x, m.y], ['ne', m.x + m.w, m.y], ['sw', m.x, m.y + m.h], ['se', m.x + m.w, m.y + m.h]]
  : m.kind === 'arrow' ? [['tail', m.x1, m.y1], ['tip', m.x2, m.y2]] : []);

function paint() {
  if (!A || A.loading) return;
  const selected = A.sel != null && !A.readOnly && !A.draft ? A.marks[A.sel] : null;
  A.svg.replaceChildren(
    ...A.marks.map((m, i) => markShape(m, P, { i, sel: A.sel === i, hit: !A.readOnly, hover: A.hover === i })),
    ...(A.draft ? [markShape(A.draft, P)] : []),
    ...(selected ? grips(selected).map(([id, x, y]) => { const [sx, sy] = P(x, y); return sv('rect', { class: 'grip', 'data-h': id, x: sx - 5, y: sy - 5, width: 10, height: 10, rx: 2 }); }) : []),
  );
  // Labels are kept from paint to paint, so the one being typed in keeps its focus.
  while (A.labels.length > A.marks.length) A.labels.pop().remove();
  A.marks.forEach((m, i) => {
    let el = A.labels[i];
    if (!el) {
      el = h('div.mk-label', { 'data-i': i }, h('span.mk-n'), h('span.mk-t'));
      A.labelsEl.append(el);
      A.labels[i] = el;
    }
    const [x, y] = anchor(m, P);
    el.dataset.i = i;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.setProperty('--mc', m.color);
    el.classList.toggle('sel', A.sel === i);
    el.classList.toggle('hover', A.hover === i);
    const num = el.querySelector('.mk-n');
    num.textContent = String(i + 1);
    num.style.color = ink(m.color);
    const editing = A.editing === i;
    let t = el.querySelector('.mk-t, .mk-edit');
    if (editing && !t.matches('.mk-edit')) {
      const ta = h('textarea.mk-edit', { rows: 1, placeholder: 'What about it?', spellcheck: true });
      ta.value = m.text;
      ta.addEventListener('input', () => { m.text = ta.value; grow(ta); side(); });
      ta.addEventListener('blur', () => endEdit(i));
      ta.addEventListener('pointerdown', e => e.stopPropagation());
      t.replaceWith(ta);
      grow(ta);
      requestAnimationFrame(() => ta.focus());
    } else if (!editing && t.matches('.mk-edit')) {
      const span = h('span.mk-t');
      t.replaceWith(span);
      t = span;
    }
    if (!editing) {
      t.textContent = m.text;
      t.hidden = !m.text;
    }
    // keep labels inside the frame's stage: flip to the left near the right edge
    el.classList.toggle('flip', x > A.stage.clientWidth - 280);
  });
  side();
}
const grow = ta => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };

// ---------------------------------------------------------------- editing marks

const snapshot = () => JSON.stringify(A.marks);
function remember() { A.history.push(snapshot()); A.future = []; A.dirty = true; }
function restore(json) { A.marks = JSON.parse(json); A.sel = null; A.editing = null; paint(); }
function undo() { if (A.history.length) { A.future.push(snapshot()); restore(A.history.pop()); } }
function redo() { if (A.future.length) { A.history.push(snapshot()); restore(A.future.pop()); } }

function addMark(m) {
  remember();
  A.marks.push({ ...m, color, text: '' });
  A.sel = A.marks.length - 1;
  A.editing = A.sel; // every mark asks what it's about
  paint();
}

function removeMark(i) {
  remember();
  A.marks.splice(i, 1);
  A.sel = null;
  A.editing = null;
  paint();
}

function select(i) { A.sel = i; paint(); }

// A mark and its row in the list light up together, so it's clear which words go with which mark.
function setHover(i) {
  if (!A || A.hover === i) return;
  A.hover = i;
  for (const el of A.svg.querySelectorAll('g.mk')) el.classList.toggle('hover', el.dataset.i === String(i));
  A.labels.forEach((el, k) => el.classList.toggle('hover', k === i));
  for (const li of A.listEl.querySelectorAll('li')) li.classList.toggle('hover', li.dataset.i === String(i));
}
function edit(i) { if (A.readOnly) return; A.sel = i; A.editing = i; paint(); }
function endEdit(i) {
  if (A?.editing !== i) return;
  A.editing = null;
  A.dirty = true;
  paint();
}

// Moving a mark: every point by the same amount, kept on the frame.
function shift(m, dx, dy) {
  const mv = (x, d) => clamp(x + d, 0, 1);
  if (m.kind === 'rect') { m.x = clamp(m.x + dx, 0, 1 - m.w); m.y = clamp(m.y + dy, 0, 1 - m.h); }
  else if (m.kind === 'point') { m.x = mv(m.x, dx); m.y = mv(m.y, dy); }
  else if (m.kind === 'arrow') { m.x1 = mv(m.x1, dx); m.y1 = mv(m.y1, dy); m.x2 = mv(m.x2, dx); m.y2 = mv(m.y2, dy); }
  else m.points = m.points.map(([x, y]) => [mv(x, dx), mv(y, dy)]);
}

// ⇧ while drawing or reshaping: a box comes out square and an arrow snaps to 15° steps, on screen,
// whatever the frame's shape.
function square([ax, ay], [gx, gy]) {
  const s = Math.max(Math.abs(gx - ax) * A.W, Math.abs(gy - ay) * A.H);
  return [clamp(ax + (Math.sign(gx - ax || 1) * s) / A.W, 0, 1), clamp(ay + (Math.sign(gy - ay || 1) * s) / A.H, 0, 1)];
}
function straighten([ax, ay], [gx, gy]) {
  const dx = (gx - ax) * A.W, dy = (gy - ay) * A.H, len = Math.hypot(dx, dy), step = Math.PI / 12;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return [clamp(ax + (Math.cos(a) * len) / A.W, 0, 1), clamp(ay + (Math.sin(a) * len) / A.H, 0, 1)];
}

// Reshape the selected mark by a handle: a box from its opposite corner, an arrow by one end.
function reshape(e, i, grip) {
  const m = A.marks[i], start = structuredClone(m);
  let moved = false;
  track(e, ev => {
    if (!moved) { remember(); moved = true; }
    let [gx, gy] = frac(ev);
    if (m.kind === 'arrow') {
      const fixed = grip === 'tip' ? [start.x1, start.y1] : [start.x2, start.y2];
      if (ev.shiftKey) [gx, gy] = straighten(fixed, [gx, gy]);
      Object.assign(m, grip === 'tip' ? { x2: gx, y2: gy } : { x1: gx, y1: gy });
    } else {
      const ax = grip.includes('w') ? start.x + start.w : start.x, ay = grip.includes('n') ? start.y + start.h : start.y;
      if (ev.shiftKey) [gx, gy] = square([ax, ay], [gx, gy]);
      Object.assign(m, { x: Math.min(ax, gx), y: Math.min(ay, gy), w: Math.abs(gx - ax), h: Math.abs(gy - ay) });
    }
    paint();
  });
}

// A brush stroke keeps the points that shape it (Ramer–Douglas–Peucker, about a screen pixel).
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0], [bx, by] = pts.at(-1);
  const L = Math.hypot(bx - ax, by - ay) || 1e-9;
  let far = 0, at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((by - ay) * pts[i][0] - (bx - ax) * pts[i][1] + bx * ay - by * ax) / L;
    if (d > far) { far = d; at = i; }
  }
  return far > eps ? [...simplify(pts.slice(0, at + 1), eps).slice(0, -1), ...simplify(pts.slice(at), eps)] : [pts[0], pts.at(-1)];
}

// ---------------------------------------------------------------- pointer

function onPointerDown(e) {
  if (A.loading || e.target.closest('.mk-edit')) return;
  const onMark = e.target.closest('[data-i]');
  const i = onMark ? +onMark.dataset.i : null;
  if (e.button === 1 || A.space || (e.button === 0 && A.readOnly && i == null)) return pan(e);
  if (e.button !== 0) return;
  if (document.activeElement?.matches('.mk-edit')) document.activeElement.blur();
  const grip = e.target.closest('[data-h]');
  if (grip && !A.readOnly && A.sel != null) return reshape(e, A.sel, grip.dataset.h);
  if (i != null) return A.readOnly ? select(i) : move(e, i, !!e.target.closest('.mk-label'));
  draw(e);
}

function track(e, onMove, onUp) {
  A.stage.setPointerCapture(e.pointerId);
  const up = ev => { A.stage.removeEventListener('pointermove', onMove); A.stage.removeEventListener('pointerup', up); A.stage.removeEventListener('pointercancel', up); onUp?.(ev); };
  A.stage.addEventListener('pointermove', onMove);
  A.stage.addEventListener('pointerup', up);
  A.stage.addEventListener('pointercancel', up);
}

function pan(e) {
  const x0 = e.clientX, y0 = e.clientY, px = A.panX, py = A.panY;
  A.stage.classList.add('grabbing');
  track(e, ev => { A.panX = px + ev.clientX - x0; A.panY = py + ev.clientY - y0; view(); }, () => A?.stage.classList.remove('grabbing'));
}

function move(e, i, onLabel) {
  const m = A.marks[i];
  const [fx, fy] = frac(e);
  const x0 = e.clientX, y0 = e.clientY;
  const start = structuredClone(m);
  let moved = false;
  A.sel = i;
  paint();
  track(e, ev => {
    if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
    if (!moved) { remember(); moved = true; }
    const [gx, gy] = frac(ev);
    Object.assign(m, structuredClone(start));
    shift(m, gx - fx, gy - fy);
    paint();
  }, () => { if (!moved && onLabel) edit(i); });
}

function draw(e) {
  const [x, y] = frac(e);
  if (tool === 'point') {
    // the second click of a double-click opens the point's words; it isn't another point
    const last = A.lastPoint, now = performance.now();
    A.lastPoint = { t: now, x, y };
    if (last && now - last.t < 400 && Math.hypot((x - last.x) * A.W, (y - last.y) * A.H) * A.zoom < 8) return;
    return addMark({ kind: 'point', x, y });
  }
  A.sel = null;
  A.draft = tool === 'rect' ? { kind: 'rect', x, y, w: 0, h: 0, color } : tool === 'arrow' ? { kind: 'arrow', x1: x, y1: y, x2: x, y2: y, color } : { kind: 'stroke', points: [[x, y]], color };
  const px = 1 / (A.W * A.zoom); // one screen pixel, as a fraction of the frame's width
  track(e, ev => {
    let [gx, gy] = frac(ev);
    const d = A.draft;
    if (d.kind === 'rect') {
      if (ev.shiftKey) [gx, gy] = square([x, y], [gx, gy]);
      Object.assign(d, { x: Math.min(x, gx), y: Math.min(y, gy), w: Math.abs(gx - x), h: Math.abs(gy - y) });
    } else if (d.kind === 'arrow') {
      if (ev.shiftKey) [gx, gy] = straighten([x, y], [gx, gy]);
      Object.assign(d, { x2: gx, y2: gy });
    }
    else {
      const [lx, ly] = d.points.at(-1);
      if (Math.hypot((gx - lx) * A.W, (gy - ly) * A.H) * A.zoom >= 2) d.points.push([gx, gy]);
    }
    paint();
  }, () => {
    const d = A.draft;
    A.draft = null;
    const sx = A.W * A.zoom, sy = A.H * A.zoom;
    const big = d.kind === 'rect' ? d.w * sx >= 6 && d.h * sy >= 6
      : d.kind === 'arrow' ? Math.hypot((d.x2 - d.x1) * sx, (d.y2 - d.y1) * sy) >= 12
      : d.points.length >= 2;
    if (!big) return paint();
    if (d.kind === 'stroke') d.points = simplify(d.points, px * 0.8);
    const { color: _, ...shape } = d;
    addMark(shape);
  });
}

function onWheel(e) {
  e.preventDefault();
  if (A.loading) return;
  const r = A.stage.getBoundingClientRect();
  // pinch (or ⌘/ctrl-scroll) zooms at the pointer; a mouse wheel's big steps are capped so it doesn't leap
  if (e.ctrlKey || e.metaKey) zoomAt(A.zoom * Math.exp(-clamp(e.deltaY, -40, 40) * (e.ctrlKey && !e.metaKey ? 0.01 : 0.004)), e.clientX - r.left, e.clientY - r.top);
  else { A.panX -= e.deltaX; A.panY -= e.deltaY; view(); }
}

// ---------------------------------------------------------------- keys (nothing reaches the editor behind)

function onKey(e) {
  if (!A) return;
  e.stopPropagation();
  const ae = document.activeElement;
  const mod = e.metaKey || e.ctrlKey;
  if (ae?.tagName === 'TEXTAREA' && A.el.contains(ae)) {
    if (e.key === 'Enter' && mod) { e.preventDefault(); ae.blur(); save(true); }
    else if (e.key === 'Enter' && !e.shiftKey && ae.matches('.mk-edit')) { e.preventDefault(); ae.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); ae.blur(); }
    return;
  }
  if (e.key === ' ') { e.preventDefault(); A.space = true; A.stage.classList.add('panning'); return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (!A.readOnly) e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key === 'Enter') { e.preventDefault(); return save(true); }
  if (mod) return;
  switch (e.key) {
    case 'Escape': e.preventDefault(); return A.discard ? close(true) : A.sel != null ? select(null) : close();
    case 'Enter': e.preventDefault(); return A.discard ? undefined : save(false);
    case 'Backspace': case 'Delete': if (A.sel != null && !A.readOnly) { e.preventDefault(); removeMark(A.sel); } return;
    case 'ArrowLeft': e.preventDefault(); return step(-1);
    case 'ArrowRight': e.preventDefault(); return step(1);
    case '0': return fit();
    case '=': case '+': return zoomBy(1.25);
    case '-': return zoomBy(0.8);
  }
  const t = TOOLS.find(x => x.key === e.key.toLowerCase());
  if (t && !A.readOnly) setTool(t.id);
}
function onKeyUp(e) {
  if (A && e.key === ' ') { A.space = false; A.stage.classList.remove('panning'); }
}

// ---------------------------------------------------------------- saving

// The frame with the marks and their words drawn on it, at the frame's own size: the picture Claude
// looks at. Sizes are relative to a 1280-wide frame, so it reads the same at any resolution.
async function composite() {
  const iw = A.img.naturalWidth, ih = A.img.naturalHeight, k = iw / 1280;
  const c = h('canvas', { width: iw, height: ih });
  const g = c.getContext('2d');
  g.drawImage(A.img, 0, 0, iw, ih);
  const Pc = (x, y) => [x * iw, y * ih];
  g.lineCap = g.lineJoin = 'round';
  for (const m of A.marks) {
    const shape = () => {
      g.beginPath();
      if (m.kind === 'rect') { const [x, y] = Pc(m.x, m.y); g.rect(x, y, m.w * iw, m.h * ih); }
      else if (m.kind === 'stroke') m.points.forEach(([x, y], i) => (i ? g.lineTo : g.moveTo).call(g, x * iw, y * ih));
      else if (m.kind === 'arrow') { g.moveTo(...Pc(m.x1, m.y1)); g.lineTo(...Pc(m.x2, m.y2)); }
      else { const [x, y] = Pc(m.x, m.y); g.arc(x, y, 10 * k, 0, Math.PI * 2); }
    };
    const w = (m.kind === 'stroke' || m.kind === 'arrow' ? 3.5 : m.kind === 'point' ? 3 : 2.5) * k;
    if (m.kind === 'rect') { g.fillStyle = m.color + '1a'; shape(); g.fill(); }
    shape(); g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = w + 4 * k; g.stroke();
    shape(); g.strokeStyle = m.color; g.lineWidth = w; g.stroke();
    if (m.kind === 'arrow') {
      const [x1, y1] = Pc(m.x1, m.y1), [x2, y2] = Pc(m.x2, m.y2);
      const a = Math.atan2(y2 - y1, x2 - x1), L = 19 * k, W = 9.5 * k;
      g.beginPath();
      g.moveTo(x2, y2);
      g.lineTo(x2 - L * Math.cos(a) + W * Math.sin(a), y2 - L * Math.sin(a) - W * Math.cos(a));
      g.lineTo(x2 - L * Math.cos(a) - W * Math.sin(a), y2 - L * Math.sin(a) + W * Math.cos(a));
      g.closePath();
      g.strokeStyle = 'rgba(0,0,0,.5)';
      g.lineWidth = 4 * k;
      g.stroke();
      g.fillStyle = m.color;
      g.fill();
    }
    if (m.kind === 'point') { g.beginPath(); g.arc(...Pc(m.x, m.y), 3 * k, 0, Math.PI * 2); g.fillStyle = m.color; g.fill(); }
  }
  // numbers, and each mark's words beside its number
  A.marks.forEach((m, i) => {
    let [x, y] = anchor(m, Pc, k);
    const r = 11 * k;
    x = clamp(x, r + 2 * k, iw - r - 2 * k);
    y = clamp(y, r + 2 * k, ih - r - 2 * k);
    g.beginPath(); g.arc(x, y, r + 1.5 * k, 0, Math.PI * 2); g.fillStyle = 'rgba(0,0,0,.45)'; g.fill();
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = m.color; g.fill();
    g.fillStyle = ink(m.color);
    g.font = `700 ${13 * k}px -apple-system, "SF Pro Text", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(i + 1), x, y + 0.5 * k);
    if (!m.text) return;
    g.font = `500 ${14 * k}px -apple-system, "SF Pro Text", sans-serif`;
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    const lh = 19 * k, pad = 7 * k, maxW = 320 * k;
    const lines = wrap(g, m.text, 0, 0, maxW, lh);
    const bw = Math.max(...lines.map(([t]) => g.measureText(t).width)) + pad * 2, bh = lines.length * lh + pad * 1.6;
    let bx = x + r + 6 * k, by = y - r;
    if (bx + bw > iw - 4 * k) bx = x - r - 6 * k - bw;
    bx = clamp(bx, 4 * k, iw - bw - 4 * k);
    by = clamp(by, 4 * k, ih - bh - 4 * k);
    g.fillStyle = 'rgba(12,12,14,.86)';
    g.beginPath(); g.roundRect(bx, by, bw, bh, 6 * k); g.fill();
    g.fillStyle = m.color; g.fillRect(bx, by + 5 * k, 2.5 * k, bh - 10 * k);
    g.fillStyle = '#f4f1ea';
    lines.forEach(([t], j) => g.fillText(t, bx + pad + 2 * k, by + pad + (j + 0.78) * lh));
  });
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
}

// Lines of text no wider than maxW, as [text, x, y].
function wrap(g, text, x, y, maxW, lh) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && g.measureText(next).width > maxW) { out.push(line); line = word; } else line = next;
    }
    out.push(line);
  }
  return out.map((t, i) => [t, x, y + i * lh]);
}

async function save(send) {
  if (!A || A.loading || A.saving) return;
  if (A.readOnly) return close(true);
  document.activeElement?.blur();
  if (!A.marks.length && !A.overall.trim()) {
    A.el.querySelector('.anno-hint')?.classList.add('flash');
    return toast('Mark something on the frame first: a box, a stroke, an arrow or a point');
  }
  A.saving = true;
  side();
  try {
    const b = S.board, s = findScene(b, A.scene);
    const where = `${s.id}-f${Math.round((sceneRange(A.scene).start + A.at) * b.fps)}`;
    const [image, frame] = await Promise.all([
      uploadFile(await composite(), `marked-${where}.jpg`),
      A.base ? null : uploadFile(A.blob, `frame-${where}.jpg`),
    ]);
    const markup = { render: A.render, w: A.W, h: A.H, image: image.file, frame: frame ? frame.file : A.base, marks: A.marks.map(({ n, ...m }) => m) };
    const j = A.noteId
      ? await commit([{ op: 'note.set', id: A.noteId, fields: { text: A.overall.trim(), markup, at: A.at } }])
      : await commit([{ op: 'note.add', note: { scene: A.scene, at: A.at, text: A.overall.trim(), markup } }]);
    if (!j) throw new Error('not saved');
    const id = A.noteId || j.ops[0].note.id;
    const count = A.marks.length;
    close(true);
    S.sel = { scene: S.sel.scene, note: id };
    emit('select');
    if (send) emit('send-notes');
    else toast(`Note added with ${count} mark${count === 1 ? '' : 's'} · not sent yet`);
  } catch (e) {
    if (A) { A.saving = false; side(); }
    if (e.message !== 'not saved') toast(`Couldn't save the marks: ${e.message}`, { err: true });
  }
}

// ---------------------------------------------------------------- the overlay

function setTool(id) {
  tool = id;
  for (const b of A.el.querySelectorAll('.anno-tools button')) b.classList.toggle('on', b.dataset.tool === id);
  A.stage.dataset.tool = id;
  if (!A.marks.length) side();
}
function setColor(c) {
  color = c;
  for (const b of A.el.querySelectorAll('.anno-colors button')) b.classList.toggle('on', b.dataset.c === c);
  if (A.sel != null && !A.readOnly) { remember(); A.marks[A.sel].color = c; paint(); }
}

function build() {
  const ib = (icon, title, onclick, cls = '') => h('button.icon-btn', { class: cls, title, html: icons[icon], onclick });
  A.img = h('img.anno-img', { alt: '', draggable: false });
  A.svg = sv('svg', { class: 'anno-svg' });
  A.labelsEl = h('div.anno-labels');
  A.zoomEl = h('span.anno-zoom');
  A.stage = h('div.anno-stage', { onpointerdown: onPointerDown },
    A.img, A.svg, A.labelsEl, h('div.anno-load', h('span.spin'), 'Getting the frame…'));
  A.stage.addEventListener('wheel', onWheel, { passive: false });
  A.stage.addEventListener('dragstart', e => e.preventDefault());
  A.stage.addEventListener('dblclick', e => { const el = e.target.closest('[data-i]'); if (el && !A.readOnly) edit(+el.dataset.i); });
  A.stage.addEventListener('pointerover', e => { if (!e.buttons) setHover(e.target.closest('[data-i]') ? +e.target.closest('[data-i]').dataset.i : null); });
  A.stage.addEventListener('pointerleave', () => setHover(null));
  A.where = h('div.anno-where');
  // The side panel's parts: the list and the buttons are redrawn; the whole-frame text never is, so
  // it keeps its focus while you type.
  A.overallEl = h('textarea.field', { rows: 3, placeholder: 'Anything about the whole frame? (optional)', spellcheck: true, readOnly: A.readOnly });
  A.overallEl.value = A.overall;
  A.overallEl.addEventListener('input', () => { A.overall = A.overallEl.value; A.dirty = true; side(); });
  A.listEl = h('div.anno-marks');
  A.footEl = h('div.anno-foot-wrap');
  const overall = h('div.anno-overall', h('span.label', 'The whole frame'), A.overallEl);
  overall.hidden = A.readOnly && !A.overall.trim(); // nothing said about the whole frame: nothing to show
  A.sideEl = h('aside.anno-side', A.listEl, overall, A.footEl);
  const tools = h('div.anno-tools.seg', TOOLS.map(t => h('button', { 'data-tool': t.id, title: `${t.label} (${t.key.toUpperCase()})`, onclick: () => setTool(t.id) }, h('span', { html: icons[t.icon] }), t.label)));
  const colors = h('div.anno-colors', MARK_COLORS.map(c => h('button', { 'data-c': c, style: { '--c': c }, title: 'Colour (also recolours the selected mark)', onclick: () => setColor(c) })));
  A.el = h('div.anno-back', { onpointerdown: e => { if (e.target === A.el) close(); } },
    h('div.anno', { class: A.readOnly ? 'read-only' : '' },
      h('header.anno-top',
        A.where,
        !A.readOnly && h('div.anno-draw', tools, colors),
        h('div.anno-view',
          !A.readOnly && ib('undo', 'Undo (⌘Z)', () => undo()),
          !A.readOnly && ib('redo', 'Redo (⇧⌘Z)', () => redo()),
          !A.readOnly && h('span.tl-sep'),
          ib('minus', 'Zoom out (−)', () => zoomBy(0.8)), A.zoomEl, ib('plus', 'Zoom in (=)', () => zoomBy(1.25)),
          ib('fit', 'Fit (0)', () => fit()),
          h('span.tl-sep'),
          ib('x', 'Close (Esc)', () => close()),
        ),
      ),
      h('div.anno-body', A.stage, A.sideEl),
    ));
  document.body.append(A.el);
  if (!A.readOnly) { setTool(tool); setColor(color); }
  head();
  side();
}

// The frame this is about, and ‹ › to step it.
function head() {
  if (!A) return;
  const b = S.board, s = findScene(b, A.scene), i = b.scenes.indexOf(s);
  const t = sceneRange(A.scene).start + A.at;
  A.where.replaceChildren(...[
    h('span.anno-scene', { style: { '--c': sceneColor(s) } }, h('i'), h('span.n', String(i + 1).padStart(2, '0')), s.title),
    !A.readOnly && h('button.icon-btn', { title: 'Previous frame (←)', html: icons.prev, onclick: () => step(-1) }),
    h('span.anno-tc', `Frame ${tc(t, b.fps)}`, h('em', ` f${Math.round(t * b.fps)}`)),
    !A.readOnly && h('button.icon-btn', { title: 'Next frame (→)', html: icons.next, onclick: () => step(1) }),
    h('span.anno-ver', { title: A.render ? 'The version these marks are on' : 'This scene has no picture yet: its storyboard card' }, A.render || 'card'),
  ].filter(x => x instanceof Node));
}

// The marks by number, the words for the whole frame, and saving.
function side() {
  if (!A) return;
  const unsent = S.board.notes.filter(n => n.author === 'you' && !n.sent && !n.resolved && n.id !== A.noteId).length + 1;
  const nothing = !A.marks.length && !A.overall.trim();
  const foot = A.readOnly
    ? h('div.anno-foot', h('span.anno-hint', 'Sent to Claude. Reply or resolve it in the Notes panel.'), h('button.text-btn.primary', { onclick: () => close(true) }, 'Close'))
    : A.discard
      ? h('div.anno-foot.ask', h('span', `Discard ${A.marks.length ? `${A.marks.length} mark${A.marks.length === 1 ? '' : 's'}` : 'your changes'}?`),
          h('button.text-btn', { onclick: () => { A.discard = false; side(); } }, 'Keep editing'),
          h('button.text-btn.primary.danger-fill', { onclick: () => close(true) }, 'Discard'))
      : h('div.anno-foot',
          h('span.grow'),
          h('button.anno-add', { disabled: A.saving || nothing, onclick: () => save(false), title: 'Add it as a note; Claude gets it when you send (⏎)' }, A.saving ? 'Saving…' : A.noteId ? 'Save' : 'Add note', h('span.k', '⏎')),
          h('button.cb-sendall', { disabled: A.saving || nothing, onclick: () => save(true), title: 'Add it and send your notes to Claude (⌘⏎)' }, h('span', { html: icons.spark, style: { display: 'inline-grid' } }), `Send ${unsent} to Claude`));
  A.footEl.replaceChildren(foot);
  A.listEl.replaceChildren(
    h('div.anno-side-head', h('span.label', 'Marks', h('em', A.marks.length ? String(A.marks.length) : ''))),
    A.marks.length
      ? h('ol.anno-list', A.marks.map((m, i) => h('li', { class: `${A.sel === i ? 'sel' : ''} ${A.hover === i ? 'hover' : ''}`, 'data-i': i, onclick: () => (A.readOnly ? select(i) : edit(i)), onpointerenter: () => setHover(i), onpointerleave: () => setHover(null) },
          h('span.mk-n', { style: { '--mc': m.color, color: ink(m.color) } }, String(i + 1)),
          h('span.what', m.text || h('em', A.readOnly ? 'no words' : 'Add a comment…')),
          !A.readOnly && h('button.icon-btn.rm', { title: 'Delete this mark (⌫)', html: icons.x, onclick: e => { e.stopPropagation(); removeMark(i); } }))))
      : A.readOnly
        ? h('div.anno-hint', 'No marks.')
        : h('div.anno-empty',
            h('p', 'Drag on the frame to show what you mean. Each mark asks for its own words.'),
            h('div.anno-keys', TOOLS.map(t => h('button', { class: tool === t.id ? 'on' : '', onclick: () => setTool(t.id) }, h('span', { html: icons[t.icon] }), t.label, h('kbd', t.key.toUpperCase())))),
            h('p.anno-hint', '⇧ squares a box or straightens an arrow. Space-drag or scroll to move around, pinch to zoom, ← → to step frames.'),
          ),
  );
}

// The message bar's "Send" after the annotator added its note.
on('open', () => close(true));
