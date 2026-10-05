// The monitor: shows whatever is under the playhead. A clip plays in sync with the clock
// (holding its last frame if the scene runs longer), a still sits still, and a scene with no
// render yet shows its storyboard card. Notes pinned on the frame float on top.

import { S, on, emit, here, total, mediaUrl, select, upload, sceneRange, sceneColor } from './store.js';
import { RUNNER } from '/lib/sketch-runtime.js';
import { activeRender, sketchCanvas, parseTimecode } from '/lib/ops.js';
import { $, h, tc, clamp, secs } from './util.js';
import { icons } from './icons.js';
import { toggle, seek, end, pause } from './player.js';
import { marksOverlay } from './annotate.js';
import { inCinema } from './screen.js';
import { actions } from './actions.js';
import { handOff } from './handoff.js';

const frame = $('#frame'), viewer = $('#viewer');
const cardLayer = $('#cardLayer'), still = $('#still'), videos = $('#videos'), endLayer = $('#endLayer'), codeFrame = $('#codeFrame');
const pinsEl = $('#pins'), chip = $('#frameChip'), caption = $('#caption');
const cache = new Map(); // render file -> <video>
let shown = { key: null, video: null };

export const STATUS_COLOR = { idea: 'var(--st-idea)', draft: 'var(--st-draft)', review: 'var(--st-review)', approved: 'var(--st-approved)' };
export { sceneColor };

// A short label for a version: its length for clips, otherwise what it is.
// On a panel's picture: a clip whose length isn't the scene's (the scene's own length is under the panel).
export const versionLabel = (r, s) => (r.kind === 'video' && Math.abs(r.duration - s.duration) >= 0.05 ? `${secs(r.duration)} clip` : '');
// The quality a version was rendered at, when whoever made it said (its meta's quality and samples):
// "final, 64 samples". Empty when nobody did.
export const versionQuality = r => {
  const q = r.meta?.quality, n = Math.round(+r.meta?.samples || 0);
  return [q, n > 0 && `${n} sample${n === 1 ? '' : 's'}`].filter(Boolean).join(', ');
};
// What a version is, in a word, for a panel on the wall: a sketch, or the quality it was rendered at.
export const versionKind = r => (r.kind === 'code' ? 'code sketch' : r.sketch || r.kind === 'sketch' ? 'sketch' : r.meta?.quality || '');

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
  const m = inCinema() ? 0 : 1; // full-screen playback: the picture runs to the edges
  const aw = r.width - 56 * m, ah = r.height - 32 * m;
  const ar = S.board.width / S.board.height;
  let w = aw, hh = aw / ar;
  if (hh > ah) { hh = ah; w = ah * ar; }
  frame.style.width = Math.max(40, Math.floor(w)) + 'px';
  frame.style.height = Math.max(24, Math.floor(hh)) + 'px';
}
new ResizeObserver(fit).observe(viewer);
// Marks on the frame are placed in its pixels: redraw them when it changes size.
new ResizeObserver(() => renderPins()).observe(frame);

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
      endLayer.replaceChildren(h('div.empty-board',
        h('div', h('b', 'An empty board'), 'Claude lays the film out here, or you can start it yourself.'),
        h('div.empty-actions',
          h('button.text-btn.primary', { onclick: () => handOff() }, h('span', { html: icons.spark, style: { display: 'inline-grid' } }), 'Hand to Claude'),
          h('button.text-btn', { onclick: () => actions.addScene() }, 'Add a scene')),
        h('div.empty-hint', 'or drop clips onto the timeline')));
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
  const rate = S.rate;
  if (S.playing && rate > 0) {
    if (local >= d - 0.02) {
      if (!v.paused) v.pause();
    } else if (v.paused) {
      v.currentTime = target;
      v.playbackRate = rate;
      v.play().catch(() => {});
    } else {
      // Big drift: jump. Small drift: lean on the playback rate until picture meets the clock.
      const drift = v.currentTime - target;
      if (Math.abs(drift) > 0.25 * rate) v.currentTime = target;
      v.playbackRate = Math.abs(drift) < 0.012 * rate ? rate : clamp(rate - drift * 2.5, rate * 0.8, rate * 1.2);
    }
  } else {
    // Paused, or shuttling backwards (video can't play in reverse): show the frame at the clock.
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
// A note's spot (a pin) or marks show on its own frame only, while paused: step or play past it and
// they're gone. The timeline marker and the Notes list both bring you back. Click the marks to open
// them in the annotator.

let pinsKey = '';

function renderPins() {
  if (!S.board) return;
  const hit = here();
  if (!hit) { pinsKey = ''; return pinsEl.replaceChildren(); } // a board with no scenes yet
  const sid = hit.scene.id;
  const b = S.board;
  const here_ = Math.round(hit.local * b.fps); // the frame number under the playhead
  const onFrame = n => n.at != null && Math.round(n.at * b.fps) === here_;
  const visible = n => n.scene === sid && onFrame(n) && (!n.resolved || S.sel.note === n.id);
  const pinned = S.playing ? [] : b.notes.filter(n => n.pin && visible(n));
  const marked = S.playing ? [] : b.notes.filter(n => n.markup?.marks.length && visible(n));
  const key = `${sid}|${pinned.map(n => n.id).join(',')}|${marked.map(n => n.id).join(',')}|${S.sel.note}|${b.rev}|${S.playing}|${frame.clientWidth}x${frame.clientHeight}`;
  if (key === pinsKey) return;
  pinsKey = key;
  const num = n => String(b.notes.indexOf(n) + 1);
  const pins = pinned.map(n => h('div.pin', {
    class: `${n.resolved ? 'resolved' : ''} ${S.sel.note === n.id ? 'sel' : ''}`,
    style: { left: n.pin.x * 100 + '%', top: n.pin.y * 100 + '%', '--pc': n.author === 'you' ? 'var(--you)' : 'var(--claude)' },
    title: n.text,
    onpointerdown: e => e.stopPropagation(),
    onclick: e => { e.stopPropagation(); actions.openNote(n); },
  }, h('div.dot', num(n))));
  for (const n of marked) pins.push(marksOverlay(n, frame.clientWidth, frame.clientHeight));
  pinsEl.replaceChildren(...pins);
}

// Double-click the picture to mark up that frame (full screen too). Watching full screen, a click
// plays or pauses.
viewer.addEventListener('dblclick', e => { if (!e.target.closest('.pins, button')) emit('annotate'); });
viewer.addEventListener('click', () => { if (inCinema()) toggle(); });

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

const tcEl = $('#tc'), tcInput = $('#tcInput'), tcRate = $('#tcRate'), tcTotal = $('#tcTotal'), tcBeat = $('#tcBeat'), playBtn = $('#tPlay');

// Click the timecode to type where to go: 2115 (or 21:15) is 00:00:21:15, +12 is twelve frames on.
tcEl.addEventListener('click', () => {
  if (!S.board) return;
  if (S.playing) pause();
  tcInput.value = tc(S.t, S.board.fps);
  tcEl.hidden = true;
  tcInput.hidden = false;
  tcInput.focus();
  tcInput.select();
});
tcInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); tcInput.blur(); }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const t = parseTimecode(tcInput.value, S.board.fps, S.t);
  if (t == null) {
    tcInput.classList.remove('bad');
    void tcInput.offsetWidth;
    return tcInput.classList.add('bad');
  }
  seek(Math.round(t * S.board.fps) / S.board.fps);
  tcInput.blur();
});
tcInput.addEventListener('blur', () => { tcInput.hidden = true; tcInput.classList.remove('bad'); tcEl.hidden = false; });

// The shuttle speed beside the timecode, while it isn't plain playback.
on('rate', () => {
  tcRate.hidden = !S.playing || S.rate === 1;
  tcRate.textContent = S.rate < 0 ? `◀ ${-S.rate}×` : `${S.rate}×`;
});

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
on('play', renderPins);
on('open', () => {
  for (const v of cache.values()) v.remove();
  cache.clear();
  shown = { key: null, video: null };
  fit();
});
