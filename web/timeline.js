// The timeline. One sticky canvas draws the ruler, the beat grid and the waveform for the
// visible stretch; scenes, note flags and the playhead are DOM on top. Native horizontal
// scrolling gives trackpad momentum; pinch (or ⌘/Ctrl + wheel) zooms around the pointer.

import { S, on, commit, select, sceneRange, mediaUrl, upload, here, activeSay } from './store.js';
import { layout, activeRender, totalDuration, snapFrame, noteTime, noteState, plural, STATUSES, renderLabel } from '/lib/ops.js';
import { $, h, clamp, secs, tc, menu, ask, authorName } from './util.js';
import { icons } from './icons.js';
import { seek, end, pause } from './player.js';
import { STATUS_COLOR, sceneColor } from './viewer.js';
import { actions } from './actions.js';
import { noteStatus } from './inspector.js';
import { noteOnSoundtrack } from './composer.js';
import { openRender } from './render.js';

const PAD = 14;
const MIN_PPS = 2, MAX_PPS = 2400;
const tl = $('#timeline'), scroll = $('#tlScroll'), content = $('#tlContent'), canvas = $('#tlCanvas');
const laneScenes = $('#laneScenes'), laneNotes = $('#laneNotes'), laneAudio = $('#laneAudio'), soundLane = $('#soundLane'), markersEl = $('#markers');
const playhead = $('#playhead'), snapline = $('#snapline'), zoom = $('#zoom'), audioName = $('#audioName');
const ctx = canvas.getContext('2d');
const Y = { ruler: 34, scenes: 0, hScenes: 0, notes: 0, hNotes: 28, audio: 0, hAudio: 46 };
let peaks = null, peaksFor = null;
let fitted = false;

const xOf = t => PAD + t * S.pps;
const tOf = x => (x - PAD) / S.pps;
const contentX = e => e.clientX - scroll.getBoundingClientRect().left + scroll.scrollLeft;

// ---------------------------------------------------------------- geometry

function measure() {
  const H = scroll.clientHeight;
  Y.scenes = Y.ruler + 8;
  Y.hScenes = Math.max(48, H - Y.scenes - 8 - Y.hNotes - 6 - Y.hAudio - 12);
  Y.notes = Y.scenes + Y.hScenes + 6;
  Y.audio = Y.notes + Y.hNotes + 6;
  const set = (k, v) => tl.style.setProperty(k, v + 'px');
  set('--y-ruler-h', Y.ruler);
  set('--y-scenes', Y.scenes);
  set('--h-scenes', Y.hScenes);
  set('--y-notes', Y.notes);
  set('--h-notes', Y.hNotes);
  set('--y-audio', Y.audio);
  set('--h-audio', Y.hAudio);
  // lane heads sit beside the scroll area, offset by the bar above
  $('#tlHeads').style.setProperty('--y-ruler-h', Y.ruler + 'px');
}

function contentWidth() {
  const d = Math.max(end(), S.board?.audio?.duration || 0, 1);
  return Math.max(scroll.clientWidth, xOf(d) + 140);
}

function sizeContent() {
  content.style.width = contentWidth() + 'px';
}

export function fitAll() {
  if (!S.board) return;
  const d = Math.max(end(), S.board.audio?.duration || 0, 4);
  setPps((scroll.clientWidth - PAD - 120) / d, 0);
  scroll.scrollLeft = 0;
}

function setPps(p, anchorX = null) {
  const old = S.pps;
  const t = anchorX == null ? null : tOf(scroll.scrollLeft + anchorX);
  S.pps = clamp(p, MIN_PPS, MAX_PPS);
  zoom.value = Math.round((Math.log(S.pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 1000);
  sizeContent();
  if (t != null) scroll.scrollLeft = xOf(t) - anchorX;
  if (old !== S.pps) renderAll();
}
export const zoomBy = f => setPps(S.pps * f, xOf(S.t) - scroll.scrollLeft);

zoom.addEventListener('input', () => {
  const p = MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, zoom.value / 1000);
  setPps(p, xOf(S.t) - scroll.scrollLeft);
});

scroll.addEventListener('wheel', e => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const x = e.clientX - scroll.getBoundingClientRect().left;
    setPps(S.pps * Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.012 : 0.004)), x);
  } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) {
    e.preventDefault();
    scroll.scrollLeft += e.deltaY;
  }
}, { passive: false });

scroll.addEventListener('scroll', () => requestDraw());

new ResizeObserver(() => {
  measure();
  sizeContent();
  if (S.board && !fitted) { fitted = true; fitAll(); }
  renderAll();
}).observe(scroll);

// ---------------------------------------------------------------- canvas: ruler, grid, waveform

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

// Ruler steps in whole frames below a second, so every label is an exact timecode.
function niceStep(minSec, fps) {
  const frames = [1, 2, 5, 10, Math.round(fps / 2)].map(n => n / fps).filter(s => s < 1);
  return [...frames, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(s => s >= minSec) || 600;
}

function draw() {
  if (!S.board) return;
  const dpr = devicePixelRatio || 1;
  const W = scroll.clientWidth, H = scroll.clientHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const sl = scroll.scrollLeft;
  const t0 = tOf(sl), t1 = tOf(sl + W);
  const b = S.board;
  const X = t => xOf(t) - sl;

  // ruler
  ctx.fillStyle = '#121216';
  ctx.fillRect(0, 0, W, Y.ruler);
  ctx.fillStyle = 'rgba(255,255,255,0.065)';
  ctx.fillRect(0, Y.ruler - 1, W, 1);
  ctx.font = '10px "SF Mono", ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'top';

  const beat = b.bpm ? 60 / b.bpm : null;
  const useBars = S.ruler === 'bars' && beat;
  if (useBars) {
    const bar = beat * b.beatsPerBar;
    let every = 1;
    while (bar * every * S.pps < 56) every *= 2;
    const showBeats = beat * S.pps >= 7;
    const off = b.beatOffset || 0;
    const firstBeat = Math.floor((t0 - off) / beat);
    for (let i = firstBeat; off + i * beat <= t1; i++) {
      if (i < 0) continue;
      const x = Math.round(X(off + i * beat)) + 0.5;
      const isBar = i % b.beatsPerBar === 0;
      const barN = i / b.beatsPerBar;
      if (isBar && barN % every === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.32)';
        ctx.fillRect(x - 0.5, 10, 1, Y.ruler - 10);
        ctx.fillStyle = 'rgba(236,235,232,0.75)';
        ctx.fillText(String(barN + 1), x + 4, 6);
        gridLine(x, 0.07);
      } else if (isBar || showBeats) {
        ctx.fillStyle = isBar ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.13)';
        ctx.fillRect(x - 0.5, Y.ruler - (isBar ? 9 : 5), 1, isBar ? 9 : 5);
        if (isBar || beat * S.pps > 22) gridLine(x, isBar ? 0.045 : 0.022);
      }
    }
  } else {
    const major = niceStep(100 / S.pps, b.fps);
    const per = major >= 1 || Math.round(major * b.fps) >= 5 ? 5 : 2;
    const minor = major / per;
    for (let i = Math.max(0, Math.floor(t0 / minor)); i * minor <= t1; i++) {
      const t = i * minor;
      const x = Math.round(X(t)) + 0.5;
      if (i % per === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.fillRect(x - 0.5, 10, 1, Y.ruler - 10);
        ctx.fillStyle = 'rgba(236,235,232,0.7)';
        ctx.fillText(tc(t, b.fps), x + 4, 6);
        gridLine(x, 0.05);
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.13)';
        ctx.fillRect(x - 0.5, Y.ruler - 5, 1, 5);
      }
    }
  }

  // shade past the end of the cut
  const endX = X(totalDuration(b));
  if (endX < W) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(Math.max(0, endX), Y.ruler, W, H - Y.ruler);
  }

  // waveform, in the audio clip's teal
  if (b.audio && peaks) {
    const mid = Y.audio + Y.hAudio / 2, amp = Y.hAudio / 2 - 3;
    const rate = peaks.rate;
    ctx.fillStyle = 'rgba(52,150,120,0.13)';
    ctx.fillRect(X(0), Y.audio, X(b.audio.duration) - X(0), Y.hAudio);
    for (let x = Math.max(0, Math.floor(X(0))); x < Math.min(W, X(b.audio.duration)); x++) {
      const a = Math.floor(tOf(x + sl) * rate), z = Math.max(a + 1, Math.floor(tOf(x + 1 + sl) * rate));
      let p = 0, r = 0;
      for (let i = a; i < z && i < peaks.peak.length; i++) {
        if (peaks.peak[i] > p) p = peaks.peak[i];
        if (peaks.rms[i] > r) r = peaks.rms[i];
      }
      const ph = Math.max(0.5, (p / 255) * amp), rh = Math.max(0.5, (r / 255) * amp * 1.25);
      ctx.fillStyle = 'rgba(72,196,160,0.3)';
      ctx.fillRect(x, mid - ph, 1, ph * 2);
      ctx.fillStyle = 'rgba(120,222,186,0.7)';
      ctx.fillRect(x, mid - Math.min(rh, ph), 1, Math.min(rh, ph) * 2);
    }
  }

  function gridLine(x, a) {
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.fillRect(x - 0.5, Y.ruler, 1, Y.notes + Y.hNotes - Y.ruler);
  }
}

async function loadPeaks() {
  const a = S.board?.audio;
  if (!a?.peaks) { peaks = null; peaksFor = null; return; }
  if (peaksFor === a.peaks) return;
  peaksFor = a.peaks;
  try {
    peaks = await (await fetch(mediaUrl(a.peaks))).json();
  } catch { peaks = null; }
  requestDraw();
}

// ---------------------------------------------------------------- scenes

// What a clip's label has room for, measured in its fonts: the title where at least four letters of it
// show (otherwise just the number), the length where all of it fits, and nothing on a sliver too
// narrow for its number. Returned as classes for the clip.
const textCtx = document.createElement('canvas').getContext('2d');
let fonts = null;
const textW = (text, font) => {
  fonts ??= { body: getComputedStyle(document.body).fontFamily, mono: getComputedStyle(document.body).getPropertyValue('--mono') };
  textCtx.font = font(fonts);
  return textCtx.measureText(text).width;
};
function clipFit(w, num, title, len) {
  const pad = w < 36 ? 3 : w < 110 ? 6 : 8; // .clip .top's padding at that width
  const numW = textW(num, f => `500 10px ${f.mono}`);
  if (w - 2 * pad < numW) return 'bare';
  const room = w - 2 * pad - numW - 6;
  const titleW = t => textW(t, f => `600 11.5px ${f.body}`);
  const fit = [];
  if (w < 36 || (titleW(title) > room && titleW(`${title.slice(0, 4)}…`) > room)) fit.push('no-title');
  if (w >= 36 && 12 + textW(len, f => `10px ${f.mono}`) > w - 12) fit.push('no-foot'); // dot and gap, then the length
  return fit.join(' ');
}

function renderClips() {
  if (!S.board) return;
  const b = S.board;
  const now = performance.now();
  const tileH = Y.hScenes;
  const tileW = Math.max(24, tileH * (b.width / b.height));
  const say = activeSay();
  const els = layout(b).map(({ scene: s, index, start }) => {
    const w = Math.max(3, s.duration * S.pps - 2);
    const r = activeRender(s);
    const num = String(index + 1).padStart(2, '0');
    const el = h('div.clip', {
      class: `${r ? '' : 'plain'} ${S.sel.scene === s.id ? 'sel' : ''} ${w < 36 ? 'tiny' : w < 110 ? 'small' : ''} ${clipFit(w, num, s.title, secs(s.duration))} ${now - (S.glow.get(s.id) || -1e9) < 2600 ? 'glow' : ''}`,
      style: { left: xOf(start) + 'px', width: w + 'px', '--c': sceneColor(s) },
      'data-id': s.id,
      title: `${String(index + 1).padStart(2, '0')} ${s.title} · ${secs(s.duration)}${r ? ` · ${r.sketch ? 'sketch' : 'render'} ${r.id}` : ''}`,
    });
    if (r) {
      const strip = h('div.strip');
      const n = Math.min(400, Math.ceil(w / tileW));
      const src = mediaUrl(/\.svg$/i.test(r.file) ? r.file : r.strip || r.poster || r.file);
      for (let i = 0; i < n; i++) {
        const tile = h('div.tile', { style: { width: tileW + 'px', backgroundImage: `url("${src}")` } });
        if (r.strip && r.stripFrames) {
          const tLocal = ((i + 0.5) * tileW / w) * s.duration;
          const f = clamp(Math.floor((Math.min(tLocal, r.duration) / r.duration) * r.stripFrames), 0, r.stripFrames - 1);
          tile.style.backgroundSize = `${tileW * r.stripFrames}px ${tileH}px`;
          tile.style.backgroundPosition = `${-f * tileW}px 0`;
        } else {
          tile.style.backgroundSize = 'cover';
          tile.style.backgroundPosition = 'center';
        }
        strip.append(tile);
      }
      el.append(strip, h('div.shade'));
    }
    el.append(h('div.cbar'));
    el.append(h('div.cur'), h('div.ring'));
    if (say?.scene === s.id) {
      el.classList.add('working');
      el.title += `\n${b.owner || 'Claude'}: ${say.text}${say.progress != null ? ` · ${Math.round(say.progress * 100)}%` : ''}`;
      el.append(h('div.work', { class: say.progress == null ? 'spin' : '', style: { '--p': say.progress ?? 0.25 } }));
    }
    el.append(...[
      h('div.top', h('div.label', h('span.cn', num), h('span.ct', s.title))),
      !r && s.picture && h('div.desc', s.picture),
      h('div.foot',
        h('i.sdot', { style: { '--sc': STATUS_COLOR[s.status] }, title: s.status }),
        h('span', secs(s.duration)),
      ),
      h('div.handle', { title: 'Drag to change the duration · Alt: roll the cut' }),
    ].filter(Boolean)); // append() would print a null as text
    return el;
  });
  laneScenes.replaceChildren(...els);
  markCurrent();
}

// Open notes, in time, with their words. A frame note is a dot at its exact frame (with a hairline up
// through the clip) followed by its text; a note about a whole scene spans that scene. Notes stack in
// up to three rows; a frame note's text runs until the next note in its row. Notes about the whole
// board sit in the lane's head. Resolved notes leave the lane (they stay in the Notes panel), except
// the one that's selected.
const ROW_H = 22, MAX_ROWS = 3;
let noteRows = 1;

function renderNotes() {
  if (!S.board) return;
  const b = S.board;
  const num = n => String(b.notes.indexOf(n) + 1);
  const rows = layout(b);
  const items = [];
  for (const n of b.notes) {
    if (!n.scene || (n.resolved && S.sel.note !== n.id)) continue;
    const row = rows.find(r => r.scene.id === n.scene);
    if (!row) continue;
    if (n.at == null) {
      const x0 = xOf(row.start) + 2;
      items.push({ n, kind: 'scene', x0, min: Math.max(18, xOf(row.end) - 2 - x0), fixed: true });
    } else {
      const t = noteTime(b, n);
      const x = xOf(t);
      items.push({ n, kind: 'frame', t, x, x0: x - 9, min: 40, want: Math.min(300, 52 + (n.text || n.markup?.marks[0]?.text || n.files?.[0]?.name || '').length * 6.4 + (n.files || n.markup ? 16 : 0)) });
    }
  }
  items.sort((p, q) => p.x0 - q.x0 || (p.kind === 'scene' ? -1 : 1));
  // pack by the smallest width each needs, then let frame notes grow into the room they have
  const ends = [];
  for (const it of items) {
    let r = ends.findIndex(e => e + 4 <= it.x0);
    if (r < 0 && ends.length < MAX_ROWS) r = ends.push(-Infinity) - 1;
    if (r < 0) r = ends.indexOf(Math.min(...ends));
    it.row = r;
    ends[r] = it.x0 + it.min;
  }
  for (const it of items) {
    if (it.fixed) { it.w = it.min; continue; }
    const next = items.find(o => o !== it && o.row === it.row && o.x0 > it.x0);
    it.w = clamp(it.want, it.min, next ? Math.max(it.min, next.x0 - 4 - it.x0) : it.want);
  }

  // the lanes are as tall as what they hold; the clips take the rest
  const used = clamp(Math.max(1, ...items.map(i => i.row + 1)), 1, MAX_ROWS);
  const hAudio = b.audio ? 46 : 24;
  if (used !== noteRows || hAudio !== Y.hAudio) {
    noteRows = used;
    Y.hNotes = used * ROW_H + 6;
    Y.hAudio = hAudio;
    measure();
  }

  const out = [];
  for (const it of items) {
    const n = it.n;
    const st = cardState(n);
    const top = it.row * ROW_H + 3;
    const cls = `${it.kind} ${st} ${n.pin ? 'spot' : ''} ${n.markup ? 'marked' : ''} ${S.sel.note === n.id ? 'sel' : ''}`;
    const tip = `#${num(n)} ${authorName(n.author)}${it.kind === 'frame' ? ` · frame ${tc(it.t, b.fps)}${n.pin ? ' · spot' : ''}` : ' · the whole scene'} · ${noteStatus(n).label}\n${n.text}`;
    if (it.kind === 'frame') {
      const h0 = Y.notes - Y.scenes + top + 10;
      out.push(h('div.nline', { class: S.sel.note === n.id ? 'sel' : '', style: { left: it.x + 'px', top: -(Y.notes - Y.scenes) + 'px', height: h0 + 'px', '--pc': who(n) } }));
    }
    out.push(h('div.ncard', {
      class: cls,
      style: { left: it.x0 + 'px', top: top + 'px', width: it.w + 'px', '--pc': who(n) },
      title: tip,
      onpointerdown: e => e.stopPropagation(),
      onclick: () => actions.openNote(n),
    },
      it.kind === 'frame' && h('i.ndot'),
      h('b', `#${num(n)}`),
      n.files && h('span.nclip', { html: icons.clip, title: `${plural(n.files.length, 'file')} attached` }),
      n.markup && h('span.nmarks', { html: icons.markup, title: `${plural(n.markup.marks.length, 'mark')} on the frame` }),
      h('span.ntxt', cardText(n)),
      ...cardFlags(st),
    ));
  }
  laneNotes.replaceChildren(...out);

  // notes about the whole film
  const boardNotes = b.notes.filter(n => !n.scene && !n.soundtrack && !n.resolved);
  const chip = $('#boardNotes');
  chip.hidden = !boardNotes.length;
  if (boardNotes.length) {
    chip.className = `head-board ${boardNotes.some(n => cardState(n) === 'unsent') ? 'unsent' : ''} ${boardNotes.some(n => cardState(n) === 'replied') ? 'replied' : ''}`;
    chip.replaceChildren(h('span', { html: icons.note }), String(boardNotes.length));
    chip.title = `About the whole film:\n${boardNotes.map(n => `#${num(n)} ${n.text.slice(0, 80)}`).join('\n')}`;
    chip.onclick = () => actions.openNote(boardNotes.find(n => cardState(n) === 'replied') || boardNotes[0]);
  }

}
const who = n => (n.author === 'you' ? 'var(--you)' : 'var(--claude)');
// A note card's look on the timeline: unsent (your draft), open (sent), read, working, replied or resolved.
const cardState = n => { const s = noteState(n); return { draft: 'unsent', sent: 'open', agent: 'open', done: 'resolved' }[s] || s; };
const cardText = n => [n.render && `Render ${renderLabel(n)}`, n.text.replace(/\s+/g, ' ')].filter(Boolean).join(' · ')
  || n.markup?.marks.map(m => m.text).filter(Boolean).join(' · ') || n.files?.map(f => f.name).join(', ') || '';
const cardFlags = st => [
  st === 'replied' && h('span.nflag', { html: icons.reply, title: 'Claude replied' }),
  st === 'read' && h('span.nflag.read', { html: icons.check, title: 'Claude has read it' }),
  st === 'working' && h('span.nflag.working', { title: 'Claude is working on it' }),
];

// Notes on the soundtrack: a card at their moment in the Audio lane, and a chip in its head for those
// about the whole soundtrack.
function renderSoundNotes() {
  if (!S.board) return;
  const b = S.board;
  const num = n => String(b.notes.indexOf(n) + 1);
  const shown = b.notes.filter(n => n.soundtrack && (!n.resolved || S.sel.note === n.id));
  const timed = shown.filter(n => n.at != null).sort((p, q) => p.at - q.at);
  soundLane.replaceChildren(...timed.flatMap((n, i) => {
    const x = xOf(n.at), next = timed[i + 1];
    const sel = S.sel.note === n.id, st = cardState(n);
    return [
      h('div.nline.snline', { class: sel ? 'sel' : '', style: { left: x + 'px', '--pc': who(n) } }),
      h('div.ncard.frame.snote', {
        class: `${st} ${sel ? 'sel' : ''}`,
        style: { left: x - 9 + 'px', width: clamp(next ? xOf(next.at) - x - 4 : 240, 26, 240) + 'px', '--pc': who(n) },
        title: `#${num(n)} ${authorName(n.author)} · the soundtrack at ${tc(n.at, b.fps)} · ${noteStatus(n).label}\n${n.text}`,
        onpointerdown: e => e.stopPropagation(),
        onclick: () => actions.openNote(n),
      }, h('i.ndot'), h('b', `#${num(n)}`), h('span.ntxt', cardText(n)), ...cardFlags(st)),
    ];
  }));
  const whole = shown.filter(n => n.at == null && !n.resolved);
  const chip = $('#soundNotes');
  chip.hidden = !whole.length;
  if (whole.length) {
    chip.className = `head-board ${whole.some(n => cardState(n) === 'unsent') ? 'unsent' : ''} ${whole.some(n => cardState(n) === 'replied') ? 'replied' : ''}`;
    chip.replaceChildren(h('span', { html: icons.note }), String(whole.length));
    chip.title = `About the whole soundtrack:\n${whole.map(n => `#${num(n)} ${n.text.slice(0, 80)}`).join('\n')}`;
    chip.onclick = () => actions.openNote(whole.find(n => cardState(n) === 'replied') || whole[0]);
  }
}

function renderMarkers() {
  if (!S.board) return;
  const sorted = [...S.board.markers].sort((a, b) => a.t - b.t);
  markersEl.replaceChildren(...sorted.map((m, i) => {
    const room = i + 1 < sorted.length ? xOf(sorted[i + 1].t) - xOf(m.t) - 3 : Infinity;
    return h('div.marker', {
    class: room < 22 ? 'flag-only' : '',
    style: { left: xOf(m.t) + 'px', '--mc': m.color || '#cfa25a', maxWidth: room === Infinity ? null : Math.max(2, room) + 'px' },
    title: `${m.label} · ${tc(m.t, S.board.fps)} — right-click to edit`,
    onpointerdown: e => e.stopPropagation(),
    onclick: () => seek(m.t),
    oncontextmenu: e => {
      e.preventDefault();
      menu(e.clientX, e.clientY, [
        { label: 'Rename…', icon: 'flag', onclick: async () => { const v = await ask(e.clientX, e.clientY, { value: m.label }); if (v) commit([{ op: 'marker.set', id: m.id, fields: { label: v } }]); } },
        { label: 'Delete marker', icon: 'trash', danger: true, onclick: () => commit([{ op: 'marker.remove', id: m.id }]) },
      ]);
    },
  }, m.label);
  }));
}

function renderAudioLabel() {
  const a = S.board?.audio;
  audioName.textContent = a ? `${a.name} · ${secs(a.duration)}` : '';
  laneAudio.querySelector('.audio-empty')?.remove();
  if (!a) laneAudio.append(h('div.audio-empty', 'Drop a soundtrack here'));
}

// The clip under the playhead is marked, so it's always clear which scene you're in.
let currentId = null;
function markCurrent() {
  const hit = S.board?.scenes.length ? here() : null;
  const id = hit?.scene.id ?? null;
  if (id === currentId && laneScenes.querySelector('.clip.current')?.dataset.id === id) return;
  currentId = id;
  for (const el of laneScenes.querySelectorAll('.clip.current')) el.classList.remove('current');
  if (id) laneScenes.querySelector(`.clip[data-id="${CSS.escape(id)}"]`)?.classList.add('current');
}

function placePlayhead() {
  if (!S.board) return;
  markCurrent();
  const x = xOf(S.t);
  playhead.style.transform = `translateX(${x}px)`;
  if (S.playing) {
    const W = scroll.clientWidth;
    if (x > scroll.scrollLeft + W - 40 || x < scroll.scrollLeft) scroll.scrollLeft = x - 60;
  }
}

function renderAll() {
  sizeContent();
  renderNotes();
  renderSoundNotes();
  renderClips();
  renderMarkers();
  renderAudioLabel();
  placePlayhead();
  requestDraw();
}

// Re-run the glow class removal after it has played out.
let glowTimer;
function scheduleGlowCleanup() {
  clearTimeout(glowTimer);
  glowTimer = setTimeout(() => { for (const el of laneScenes.querySelectorAll('.glow')) el.classList.remove('glow'); }, 2700);
}

on('open', () => { fitted = false; peaks = null; peaksFor = null; measure(); requestAnimationFrame(() => { fitted = true; fitAll(); renderAll(); }); });
on('board', e => {
  if (drag || trim) return; // the drag finishes into a fresh render
  loadPeaks();
  renderAll();
  if (e?.batches) scheduleGlowCleanup();
});
on('select', () => { renderNotes(); renderSoundNotes(); renderClips(); });
let workingKey = '';
on('presence', () => {
  const say = activeSay();
  const k = say?.scene ? `${say.scene}|${say.progress}|${say.text}` : '';
  if (k !== workingKey) { workingKey = k; renderClips(); }
});
on('time', placePlayhead);
on('ruler', requestDraw);

// ---------------------------------------------------------------- snapping

function snapCandidates(excludeEnd = null) {
  const b = S.board;
  const c = [0];
  for (const r of layout(b)) { c.push(r.end); }
  for (const m of b.markers) c.push(m.t);
  if (b.audio) c.push(b.audio.duration);
  return c.filter(t => t !== excludeEnd);
}

// The beat grid at this zoom: beats, halved while they are wide, doubled while they are cramped.
function gridUnit() {
  const b = S.board;
  if (!b.bpm) return null;
  let u = 60 / b.bpm;
  while (u * S.pps > 64 && u / 2 >= 2 / b.fps) u /= 2;
  while (u * S.pps < 12) u *= 2;
  return u;
}

// Snap t to a cut or marker within 8 px; with `quantize`, otherwise land on the beat grid
// (like a DAW). Returns [t, cutOrMarker|null]. Hold ⌘ to skip.
function snap(t, e, { quantize = false, exclude = null } = {}) {
  if (!S.snap || e?.metaKey) return [t, null];
  const tol = 8 / S.pps;
  let best = null, bd = tol;
  for (const c of snapCandidates(exclude)) { const d = Math.abs(c - t); if (d < bd) { bd = d; best = c; } }
  if (best != null) return [best, best];
  const u = quantize && gridUnit();
  if (u) {
    const off = S.board.beatOffset || 0;
    return [off + Math.round((t - off) / u) * u, null];
  }
  return [t, null];
}

function showSnap(t) {
  snapline.style.display = t == null ? 'none' : 'block';
  if (t != null) snapline.style.left = xOf(t) + 'px';
}

// ---------------------------------------------------------------- pointer: scrub, drag, trim

let drag = null, trim = null;

scroll.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !S.board) return;
  const clip = e.target.closest('.clip');
  if (clip && e.target.classList.contains('handle')) return startTrim(e, clip);
  if (clip) return startDrag(e, clip);
  startScrub(e);
});

function startScrub(e) {
  const move = ev => {
    const [t, s] = snap(tOf(contentX(ev)), ev);
    showSnap(s);
    seek(t);
  };
  if (S.playing) pause();
  move(e);
  scroll.setPointerCapture(e.pointerId);
  const up = () => { showSnap(null); scroll.removeEventListener('pointermove', move); scroll.removeEventListener('pointerup', up); scroll.removeEventListener('pointercancel', up); };
  scroll.addEventListener('pointermove', move);
  scroll.addEventListener('pointerup', up);
  scroll.addEventListener('pointercancel', up);
}

function startDrag(e, clipEl) {
  const id = clipEl.dataset.id;
  const x0 = e.clientX;
  const clips = [...laneScenes.querySelectorAll('.clip')];
  const rows = clips.map(el => ({ el, id: el.dataset.id, left: parseFloat(el.style.left), w: parseFloat(el.style.width) + 2 }));
  const from = rows.findIndex(r => r.id === id);
  let started = false, target = from, autoTimer = null, lastEv = e;
  scroll.setPointerCapture(e.pointerId);

  const layoutAt = to => {
    const others = rows.filter(r => r.id !== id);
    others.splice(to, 0, rows[from]);
    let x = xOf(0);
    const pos = new Map();
    for (const r of others) { pos.set(r.id, x); x += r.w; }
    return pos;
  };

  const move = ev => {
    lastEv = ev;
    const dx = ev.clientX - x0 + (scroll.scrollLeft - scrollAtStart);
    if (!started) {
      if (Math.abs(ev.clientX - x0) < 4) return;
      started = true;
      drag = { id };
      if (S.playing) pause();
      rows[from].el.classList.add('dragging');
      for (const r of rows) if (r.id !== id) r.el.classList.add('animate');
    }
    rows[from].el.style.transform = `translateX(${dx}px)`;
    const center = rows[from].left + dx + rows[from].w / 2;
    const others = rows.filter(r => r.id !== id);
    let x = xOf(0), to = 0;
    for (const r of others) { if (center > x + r.w / 2) to++; x += r.w; }
    if (to !== target) {
      target = to;
      const pos = layoutAt(to);
      for (const r of rows) if (r.id !== id) r.el.style.transform = `translateX(${pos.get(r.id) - r.left}px)`;
    }
    edgeScroll(ev);
  };

  const scrollAtStart = scroll.scrollLeft;
  const edgeScroll = ev => {
    clearInterval(autoTimer);
    const r = scroll.getBoundingClientRect();
    const dir = ev.clientX < r.left + 40 ? -1 : ev.clientX > r.right - 40 ? 1 : 0;
    if (dir) autoTimer = setInterval(() => { scroll.scrollLeft += dir * 14; move(lastEv); }, 16);
  };

  const up = async () => {
    clearInterval(autoTimer);
    scroll.removeEventListener('pointermove', move);
    scroll.removeEventListener('pointerup', up);
    scroll.removeEventListener('pointercancel', up);
    if (!started) {
      select(id);
      return;
    }
    if (target !== from) {
      const others = rows.filter(r => r.id !== id);
      const before = others[target]?.id ?? null;
      await commit([{ op: 'scene.move', id, before }]);
    }
    drag = null;
    renderAll();
  };
  scroll.addEventListener('pointermove', move);
  scroll.addEventListener('pointerup', up);
  scroll.addEventListener('pointercancel', up);
}

function startTrim(e, clipEl) {
  e.stopPropagation();
  const b = S.board;
  const id = clipEl.dataset.id;
  const rows = layout(b);
  const i = rows.findIndex(r => r.scene.id === id);
  const row = rows[i], next = rows[i + 1];
  const roll = e.altKey && next;
  const x0 = e.clientX, sl0 = scroll.scrollLeft;
  const after = [...laneScenes.children].slice(i + 1);
  const afterLeft = after.map(el => parseFloat(el.style.left));
  const nextEl = laneScenes.children[i + 1];
  const tip = h('div.trim-tip');
  document.body.append(tip);
  clipEl.classList.add('trimming');
  trim = { id };
  if (S.playing) pause();
  scroll.setPointerCapture(e.pointerId);
  let d = row.scene.duration, dn = next?.scene.duration;
  const minD = 1 / b.fps;

  const move = ev => {
    const raw = row.start + row.scene.duration + (ev.clientX - x0 + scroll.scrollLeft - sl0) / S.pps;
    let [endT, snapped] = snap(raw, ev, { quantize: true, exclude: row.end });
    endT = snapFrame(b, endT);
    const maxEnd = roll ? next.end - minD : Infinity;
    endT = clamp(endT, row.start + minD, maxEnd);
    d = snapFrame(b, endT - row.start);
    showSnap(snapped != null && Math.abs(snapped - endT) < 1 / b.fps ? snapped : null);
    clipEl.style.width = Math.max(3, d * S.pps - 2) + 'px';
    const delta = (d - row.scene.duration) * S.pps;
    if (roll) {
      dn = snapFrame(b, next.end - (row.start + d));
      nextEl.style.left = xOf(row.start + d) + 'px';
      nextEl.style.width = Math.max(3, dn * S.pps - 2) + 'px';
    } else after.forEach((el, k) => { el.style.left = afterLeft[k] + delta + 'px'; });
    const r = clipEl.getBoundingClientRect();
    tip.style.left = r.right + 'px';
    tip.style.top = r.top + 'px';
    const beats = b.bpm ? ` · ${plural(+(d / (60 / b.bpm)).toFixed(2), 'beat')}` : '';
    tip.textContent = `${secs(d)} · ${Math.round(d * b.fps)}f${beats}${roll ? ` | next ${secs(dn)}` : ''}`;
  };
  move(e);

  const up = async () => {
    scroll.removeEventListener('pointermove', move);
    scroll.removeEventListener('pointerup', up);
    scroll.removeEventListener('pointercancel', up);
    tip.remove();
    showSnap(null);
    clipEl.classList.remove('trimming');
    const ops = [];
    if (Math.abs(d - row.scene.duration) > 1e-6) ops.push({ op: 'scene.set', id, fields: { duration: d } });
    if (roll && ops.length) ops.push({ op: 'scene.set', id: next.scene.id, fields: { duration: dn } });
    if (ops.length) await commit(ops);
    trim = null;
    renderAll();
  };
  scroll.addEventListener('pointermove', move);
  scroll.addEventListener('pointerup', up);
  scroll.addEventListener('pointercancel', up);
}

// Double-click empty lane: new scene at the end.
laneScenes.addEventListener('dblclick', e => {
  const clip = e.target.closest('.clip');
  if (clip) {
    const r = sceneRange(clip.dataset.id);
    seek(r.start);
    return;
  }
  actions.addScene({ at: 'end' });
});

// ---------------------------------------------------------------- context menus

scroll.addEventListener('contextmenu', e => {
  if (!S.board) return;
  e.preventDefault();
  const clip = e.target.closest('.clip');
  const t = tOf(contentX(e));
  if (clip) {
    const id = clip.dataset.id;
    select(id, { keepTime: true });
    const s = S.board.scenes.find(x => x.id === id);
    const r = sceneRange(id);
    const canSplit = S.t > r.start + 1e-6 && S.t < r.end - 1e-6;
    menu(e.clientX, e.clientY, [
      { label: 'Play from here', icon: 'play2', onclick: () => { seek(r.start); actions.play(); } },
      '-',
      { label: 'New scene before', icon: 'insertL', onclick: () => actions.addScene({ before: id }) },
      { label: 'New scene after', icon: 'insertR', key: 'N', onclick: () => actions.addScene({ after: id }) },
      { label: 'Duplicate', icon: 'copy', key: '⌘D', onclick: () => actions.duplicate(id) },
      canSplit && { label: 'Split at playhead', icon: 'split', key: 'S', onclick: () => actions.split() },
      { label: 'Add a still or clip…', icon: 'upload', onclick: () => actions.pickFile({ scene: id }) },
      { label: 'Ask Claude to render it…', icon: 'render', onclick: () => openRender({ scene: id }) },
      '-',
      { head: 'Status' },
      ...STATUSES.map(st => ({ label: st[0].toUpperCase() + st.slice(1), dot: STATUS_COLOR[st], cls: s.status === st ? 'cur checked' : '', onclick: () => commit([{ op: 'scene.set', id, fields: { status: st } }]) })),
      '-',
      { label: 'Delete scene', icon: 'trash', key: '⌫', danger: true, onclick: () => actions.remove(id) },
    ].filter(Boolean));
  } else if (e.clientY - scroll.getBoundingClientRect().top < Y.ruler + 4) {
    menu(e.clientX, e.clientY, [
      { label: `Add marker at ${tc(snapFrame(S.board, t), S.board.fps)}`, icon: 'flag', onclick: async () => {
        const label = await ask(e.clientX, e.clientY, { placeholder: 'Marker label (drop, hit, VO…)', ok: 'Add' });
        if (label) commit([{ op: 'marker.add', marker: { t: snapFrame(S.board, Math.max(0, t)), label } }]);
      } },
    ]);
  } else if (e.clientY - scroll.getBoundingClientRect().top >= Y.audio - 3) {
    const at = snapFrame(S.board, clamp(t, 0, S.board.audio?.duration ?? 0));
    menu(e.clientX, e.clientY, [
      S.board.audio && { label: `Note on the soundtrack at ${tc(at, S.board.fps)}`, icon: 'note', onclick: () => noteOnSoundtrack(at) },
      S.board.audio && { label: 'Note on the whole soundtrack', icon: 'wave', onclick: () => noteOnSoundtrack() },
      S.board.audio && '-',
      { label: S.board.audio ? 'Replace soundtrack…' : 'Add soundtrack…', icon: 'wave', onclick: () => actions.pickFile({ audio: true }) },
      S.board.audio && { label: 'Remove soundtrack', icon: 'trash', danger: true, onclick: () => commit([{ op: 'audio.set', audio: null }]) },
    ].filter(Boolean));
  } else {
    menu(e.clientX, e.clientY, [
      { label: 'New scene at the end', icon: 'plus', onclick: () => actions.addScene({ at: 'end' }) },
      { label: 'Add a still or clip…', icon: 'upload', onclick: () => actions.pickFile({}) },
      { label: S.board.audio ? 'Replace soundtrack…' : 'Add soundtrack…', icon: 'wave', onclick: () => actions.pickFile({ audio: true }) },
      S.board.audio && { label: 'Remove soundtrack', icon: 'trash', danger: true, onclick: () => commit([{ op: 'audio.set', audio: null }]) },
    ].filter(Boolean));
  }
});

// ---------------------------------------------------------------- dropping files

scroll.addEventListener('dragover', e => {
  if (!S.board || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  for (const el of document.querySelectorAll('.drop-target')) el.classList.remove('drop-target');
  const y = e.clientY - scroll.getBoundingClientRect().top;
  const clip = e.target.closest('.clip');
  if (y >= Y.audio - 3) laneAudio.classList.add('drop-target');
  else if (clip) clip.classList.add('drop-target');
  else laneScenes.classList.add('drop-target');
});
scroll.addEventListener('dragleave', e => { if (!scroll.contains(e.relatedTarget)) for (const el of document.querySelectorAll('.drop-target')) el.classList.remove('drop-target'); });
scroll.addEventListener('drop', async e => {
  e.preventDefault();
  for (const el of document.querySelectorAll('.drop-target')) el.classList.remove('drop-target');
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  const y = e.clientY - scroll.getBoundingClientRect().top;
  const clip = e.target.closest('.clip');
  if (y >= Y.audio - 3) return upload(files[0], { audio: true });
  if (clip) {
    for (const f of files) await upload(f, { scene: clip.dataset.id });
    return;
  }
  // Empty space: new scenes, placed at the drop point.
  const t = tOf(contentX(e));
  const rows = layout(S.board);
  const hitRow = rows.find(r => t < r.start + r.scene.duration / 2);
  for (const f of files) await upload(f, hitRow ? { before: hitRow.scene.id } : {});
});
