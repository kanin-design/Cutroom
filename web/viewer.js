// The monitor: shows whatever is under the playhead. A clip plays in sync with the clock
// (holding its last frame if the scene runs longer), a still sits still, and a scene with no
// render yet shows its storyboard card. Notes pinned on the frame float on top.

import { S, on, emit, here, total, mediaUrl, commit, select, upload, sceneRange } from './store.js';
import { RUNNER } from '/lib/sketch-runtime.js';
import { activeRender, layout, noteTime, kindName, sketchCanvas, STATUSES, COLORS } from '/lib/ops.js';
import { $, h, tc, clamp, ask, toast, secs } from './util.js';
import { icons } from './icons.js';
import { toggle, seek, end } from './player.js';

const frame = $('#frame'), viewer = $('#viewer');
const cardLayer = $('#cardLayer'), still = $('#still'), videos = $('#videos'), endLayer = $('#endLayer'), codeFrame = $('#codeFrame');
const pinsEl = $('#pins'), chip = $('#frameChip'), caption = $('#caption');
const cache = new Map(); // render file -> <video>
let shown = { key: null, video: null };

export const STATUS_COLOR = { idea: 'var(--st-idea)', draft: 'var(--st-draft)', review: 'var(--st-review)', approved: 'var(--st-approved)' };
export const sceneColor = s => s.color || COLORS[0];

// A short label for a version: its length for clips, otherwise what it is.
export const versionLabel = r =>
  r.kind === 'code' ? 'code' : r.kind === 'video' ? `${r.sketch ? 'sketch · ' : ''}${secs(r.duration)}` : r.sketch ? 'sketch' : 'still';

// ---------------------------------------------------------------- code sketches
// The code runs in a sandboxed iframe (scripts only, no access to this page or the API), built from
// srcdoc so nothing has to be fetched. We send it the code and the shared library once, then the time
// for every frame. If the frame can't run scripts (some embedded browsers block it), the monitor falls
// back to the drawn poster.
const RUNNER_PAGE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#000;overflow:hidden}#stage{position:absolute;inset:0}
canvas{width:100%;height:100%;object-fit:contain;display:block}
#err{position:absolute;left:12px;right:12px;bottom:12px;margin:0;padding:8px 10px;border-radius:6px;background:rgba(40,8,4,.88);color:#ffb4a3;font:12px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;display:none}
</style><div id="stage"></div><pre id="err"></pre><script>${RUNNER}
let draw = null, W = 0, H = 0, meta = {};
const err = document.getElementById('err');
const show = e => { err.textContent = String((e && e.message) || e); err.style.display = 'block'; };
addEventListener('message', ev => {
  const m = ev.data || {};
  if (m.type === 'load') {
    W = m.w; H = m.h; meta = m.meta || {};
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    document.getElementById('stage').replaceChildren(canvas);
    err.style.display = 'none';
    try { draw = compileSketch(m.code, canvas, m.lib); } catch (e) { draw = null; show(e); }
  } else if (m.type === 'frame' && draw) {
    Object.assign(meta, m.meta || {});
    try { draw(m.t, sketchInfo(W, H, m.t, meta)); err.style.display = 'none'; } catch (e) { show(e); }
  }
});
parent.postMessage({ type: 'sketch-ready' }, '*');
<\/script>`;

const code = { ready: false, failed: false, loaded: null, texts: new Map(), pending: null };
codeFrame.removeAttribute('src');
codeFrame.srcdoc = RUNNER_PAGE;
const readyTimer = setTimeout(() => { if (!code.ready) { code.failed = true; shown.key = null; update(); } }, 1500);
addEventListener('message', e => {
  if (e.source !== codeFrame.contentWindow || e.data?.type !== 'sketch-ready') return;
  clearTimeout(readyTimer);
  code.ready = true;
  code.failed = false;
  code.loaded = null;
  if (code.pending) showCode(...code.pending);
});

async function text(file) {
  if (!file) return '';
  let t = code.texts.get(file);
  if (t == null) {
    code.texts.set(file, '');
    t = await (await fetch(mediaUrl(file))).text();
    code.texts.set(file, t);
  }
  return t;
}

async function showCode(r, local, s, index) {
  code.pending = [r, local, s, index];
  if (!code.ready) return;
  const [src, lib] = await Promise.all([text(r.file), text(S.board.sketchLib)]);
  if (!src) return;
  const start = sceneRange(s.id).start;
  const meta = { duration: s.duration, start, filmDuration: total(), scene: s.id, index, fps: S.board.fps, bpm: S.board.bpm, beatsPerBar: S.board.beatsPerBar, beatOffset: S.board.beatOffset || 0 };
  const win = codeFrame.contentWindow;
  const key = `${r.file}|${S.board.sketchLib}`;
  if (code.loaded !== key) {
    const { w, h: hh } = sketchCanvas(S.board);
    win.postMessage({ type: 'load', code: src, lib, w, h: hh, meta }, '*');
    code.loaded = key;
  }
  win.postMessage({ type: 'frame', t: local, meta }, '*');
}

// The storyboard card for a scene with nothing rendered yet. Sized in container units.
export function cardNode(s, index) {
  return h('div.card', { style: { '--c': sceneColor(s) } },
    h('div.card-body',
      h('div.card-num', String(index + 1).padStart(2, '0'), h('span.st', { style: { '--sc': STATUS_COLOR[s.status] } }, h('i'), s.status)),
      h('div.card-title', s.title),
      s.picture ? h('div.card-text', s.picture) : h('div.card-text.card-empty', 'No picture described yet.'),
      s.sound && h('div.card-sound', { html: icons.sound }, h('span', s.sound)),
    ),
  );
}

// ---------------------------------------------------------------- layout

function fit() {
  if (!S.board) return;
  const r = viewer.getBoundingClientRect();
  const aw = r.width - 56, ah = r.height - 32;
  const ar = S.board.width / S.board.height;
  let w = aw, hh = aw / ar;
  if (hh > ah) { hh = ah; w = ah * ar; }
  frame.style.width = Math.max(40, Math.floor(w)) + 'px';
  frame.style.height = Math.max(24, Math.floor(hh)) + 'px';
}
new ResizeObserver(fit).observe(viewer);

// ---------------------------------------------------------------- picture

function videoFor(r) {
  let v = cache.get(r.file);
  if (!v) {
    v = h('video', { muted: true, playsInline: true, preload: 'auto' });
    v.muted = true;
    v.src = mediaUrl(r.file);
    v.addEventListener('seeked', () => { if (v.wantTime != null && Math.abs(v.currentTime - v.wantTime) > 0.02 && !S.playing) v.currentTime = v.wantTime; });
    videos.append(v);
    cache.set(r.file, v);
  }
  return v;
}

function setLayer(which) {
  codeFrame.style.display = which === 'code' ? 'block' : 'none';
  cardLayer.style.display = which === 'card' ? 'block' : 'none';
  still.style.display = which === 'still' ? 'block' : 'none';
  endLayer.style.display = which === 'end' ? 'grid' : 'none';
  if (which !== 'video' && shown.video) {
    shown.video.pause();
    shown.video.classList.remove('on');
    shown.video = null;
  }
}

function update() {
  if (!S.board) return;
  const b = S.board;
  if (!b.scenes.length) {
    setLayer('end');
    if (shown.key !== 'empty') {
      endLayer.replaceChildren(h('div.empty-board', h('div', h('b', 'An empty board'), 'Add a scene below, drop a clip on the timeline,', h('br'), 'or ask Claude to run ', h('code', 'sb add <title>'))));
      shown.key = 'empty';
    }
    chip.hidden = true;
    return;
  }
  const hit = here();
  const s = hit.scene;
  const r = activeRender(s);
  const key = `${s.id}:${r?.id || 'card'}:${S.board.rev}`;

  if (!r) {
    setLayer('card');
    if (shown.key !== key) cardLayer.replaceChildren(cardNode(s, hit.index));
  } else if (r.kind === 'code' && !code.failed) {
    setLayer('code');
    showCode(r, hit.local, s, hit.index);
  } else if (r.kind === 'code') {
    // Live preview can't run here: show the poster the server drew.
    setLayer('still');
    const src = mediaUrl(r.poster || r.file);
    if (still.getAttribute('src') !== src) still.src = src;
  } else if (r.kind !== 'video') {
    setLayer('still');
    const src = mediaUrl(r.file);
    if (still.getAttribute('src') !== src) still.src = src;
  } else {
    const v = videoFor(r);
    if (shown.video !== v) {
      setLayer('video');
      shown.video?.pause();
      shown.video?.classList.remove('on');
      v.classList.add('on');
      shown.video = v;
    }
    cardLayer.style.display = still.style.display = endLayer.style.display = codeFrame.style.display = 'none';
    syncVideo(v, hit.local, r);
    preloadNext(hit.index);
  }
  shown.key = key;

  // While a shot is still a sketch, its picture text says what it will be.
  const capText = r && r.sketch && s.picture ? s.picture : '';
  if (caption.dataset.text !== capText) {
    caption.dataset.text = capText;
    caption.replaceChildren(...(capText ? [h('b', 'sketch'), capText] : []));
  }
  // Only when the live code sketch can't run here: say that the picture is its drawn poster.
  const fallback = r?.kind === 'code' && code.failed;
  chip.hidden = !fallback;
  if (fallback) chip.textContent = 'Live preview unavailable here · showing the drawn poster';
}

function syncVideo(v, local, r) {
  const d = v.duration || r.duration || 0;
  const target = d ? Math.min(local, d - 0.5 / S.board.fps) : local;
  v.wantTime = target;
  if (S.playing) {
    if (local >= d - 0.02) {
      if (!v.paused) v.pause();
    } else if (v.paused) {
      v.currentTime = target;
      v.play().catch(() => {});
    } else {
      // Big drift: jump. Small drift: lean on the playback rate until picture meets the clock.
      const drift = v.currentTime - target;
      if (Math.abs(drift) > 0.25) v.currentTime = target;
      v.playbackRate = Math.abs(drift) < 0.012 ? 1 : clamp(1 - drift * 2.5, 0.8, 1.2);
    }
  } else {
    v.playbackRate = 1;
    if (!v.paused) v.pause();
    if (!v.seeking && Math.abs(v.currentTime - target) > 0.25 / S.board.fps) v.currentTime = target;
  }
}

function preloadNext(i) {
  const n = S.board.scenes[i + 1];
  const r = n && activeRender(n);
  if (r?.kind === 'video') videoFor(r);
}

// ---------------------------------------------------------------- notes on the frame
// Spots marked on the frame show as pins while their scene is on screen (faint away from their
// moment). The spot being written about shows as a dashed pin.

let pinsKey = '';

function openNote(n) {
  S.tab = 'notes';
  select(n.scene, { note: n.id, keepTime: true });
  if (n.at != null) seek(noteTime(S.board, n));
}

function renderPins() {
  if (!S.board) return;
  const hit = here();
  const sid = hit?.scene.id;
  const b = S.board;
  const near = n => n.at == null || Math.abs(hit.local - n.at) < 0.75;
  const pinned = b.notes.filter(n => n.pin && n.scene === sid && (!n.resolved || S.sel.note === n.id));
  const key = `${sid}|${pinned.map(n => n.id + (near(n) ? '' : 'f')).join(',')}|${S.sel.note}|${b.rev}|${S.draftPin ? S.draftPin.x + ',' + S.draftPin.y : ''}|${S.playing}`;
  if (key === pinsKey) return;
  pinsKey = key;
  const num = n => String(b.notes.indexOf(n) + 1);
  const pins = pinned.map(n => h('div.pin', {
    class: `${near(n) ? '' : 'far'} ${n.resolved ? 'resolved' : ''} ${S.sel.note === n.id ? 'sel' : ''}`,
    style: { left: n.pin.x * 100 + '%', top: n.pin.y * 100 + '%', '--pc': n.author === 'you' ? 'var(--you)' : 'var(--claude)' },
    title: n.text,
    onpointerdown: e => e.stopPropagation(),
    onclick: e => { e.stopPropagation(); openNote(n); },
  }, h('div.dot', num(n))));
  if (S.draftPin) pins.push(h('div.pin.draft', { style: { left: S.draftPin.x * 100 + '%', top: S.draftPin.y * 100 + '%' }, title: 'The spot your message will point at' }, h('div.dot', '+')));
  pinsEl.replaceChildren(...pins);
}

export function setPinning(v) {
  S.pinning = v;
  frame.classList.toggle('pinning', v);
  emit('pinning');
}

// Marking a spot: the click goes to the message bar, which then writes a note about this frame, here.
frame.addEventListener('click', e => {
  if (!S.pinning || !S.board?.scenes.length) return;
  const rect = frame.getBoundingClientRect();
  const x = clamp((e.clientX - rect.left) / rect.width, 0, 1), y = clamp((e.clientY - rect.top) / rect.height, 0, 1);
  setPinning(false);
  emit('spot', { x: +x.toFixed(4), y: +y.toFixed(4) });
});
frame.addEventListener('dblclick', () => { if (!S.pinning) toggle(); });

// Drop a file on the monitor: a new version of the scene on screen.
frame.addEventListener('dragover', e => { if (S.board?.scenes.length) { e.preventDefault(); frame.classList.add('drop-target'); } });
frame.addEventListener('dragleave', () => frame.classList.remove('drop-target'));
frame.addEventListener('drop', e => {
  e.preventDefault();
  e.stopPropagation();
  frame.classList.remove('drop-target');
  const hit = here();
  for (const f of e.dataTransfer.files) upload(f, { scene: hit.scene.id });
});

// ---------------------------------------------------------------- transport

const tcEl = $('#tc'), tcTotal = $('#tcTotal'), tcBeat = $('#tcBeat'), playBtn = $('#tPlay');

function transport() {
  if (!S.board) return;
  const b = S.board;
  tcEl.textContent = tc(S.t, b.fps);
  tcTotal.textContent = `/ ${tc(end(), b.fps)}`;
  const f = `f${Math.round(S.t * b.fps)}`;
  if (b.bpm) {
    const beat = (S.t - (b.beatOffset || 0)) / (60 / b.bpm);
    const bar = Math.floor(beat / b.beatsPerBar) + 1;
    const bt = Math.floor(beat - (bar - 1) * b.beatsPerBar) + 1;
    tcBeat.textContent = beat >= 0 ? `${f} · bar ${bar}.${bt}` : f;
  } else tcBeat.textContent = f;
}

on('play', () => { playBtn.innerHTML = S.playing ? icons.pause : icons.play; playBtn.title = S.playing ? 'Pause (Space)' : 'Play (Space)'; });
on('time', () => { update(); transport(); renderPins(); });
on('board', () => { fit(); update(); transport(); renderPins(); });
on('select', renderPins);
on('draft-pin', renderPins);
on('play', renderPins);
on('open', () => {
  for (const v of cache.values()) v.remove();
  cache.clear();
  shown = { key: null, video: null };
  fit();
});
