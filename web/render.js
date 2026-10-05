// Render requests: ask Claude for a render of the whole film, one scene or one frame, at 4K, 1080p or
// 720p, as a draft or final. A request is a note with `render`, sent at once, so it shows where it stands
// like any note: read, working (with Claude's progress in the top bar), replied with the file, done.

import { S, on, commit, here, scene } from './store.js';
import { RENDER_SIZES, RENDER_QUALITIES, RENDER_TYPES, renderSize, renderCodec, renderLabel, layout, noteState, noteTime, snapFrame, plural } from '/lib/ops.js';
import { $, h, menu, closeMenu, tc, secs, toast } from './util.js';
import { icons } from './icons.js';
import { actions } from './actions.js';
import { statusLight } from './inspector.js';
import { sendNotes } from './composer.js';

const btn = $('#renderBtn'), dot = $('#renderDot');

// The last size and quality asked for, remembered.
let size = '1080p', quality = 'final';
try {
  const kept = JSON.parse(localStorage.getItem('sb.render') || '{}');
  if (RENDER_SIZES[kept.size]) size = kept.size;
  if (RENDER_QUALITIES.includes(kept.quality)) quality = kept.quality;
} catch {}
const remember = () => { try { localStorage.setItem('sb.render', JSON.stringify({ size, quality })); } catch {} };

const openRequests = () => (S.board ? S.board.notes.filter(n => n.render && !n.resolved) : []);
const sceneName = s => `${String(S.board.scenes.indexOf(s) + 1).padStart(2, '0')} · ${s.title}`;
const whatOf = n => {
  const s = scene(n.scene);
  if (!n.scene) return 'the whole film';
  if (!s) return 'a deleted scene';
  return n.at != null ? `${sceneName(s)} at ${tc(noteTime(S.board, n), S.board.fps)}` : sceneName(s);
};

// What a quality means on this board: as Claude set it for the way the film is rendered, or until then,
// the project's quickest or full settings.
const qualityTip = (b, q) => b.render?.[q]
  ? `${q === 'draft' ? 'Draft' : 'Final'}: ${b.render[q]}`
  : q === 'draft' ? 'The project’s quickest settings that still show the look' : 'The project’s full settings: the real thing';

// The popover under the Render button: requests still open, then a new one. What to render: the whole
// film, a scene (the selected one, or another from the list), or the frame under the playhead.
// `sceneId` (from a scene's menu) starts on that scene.
export function openRender({ scene: sceneId = null } = {}) {
  if (!S.board) return;
  const hit = here();
  let what = sceneId ? 'scene' : 'film';
  let pick = (scene(sceneId) || scene(S.sel.scene) || hit?.scene)?.id ?? null;
  const words = h('textarea.field.rq-words', {
    rows: 2,
    placeholder: 'Anything else Claude should know? (optional)',
    onkeydown: e => { e.stopPropagation(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } },
  });
  const pop = h('div.pop.render-pop');

  const send = async () => {
    const note = { render: { size, quality }, text: words.value.trim() };
    if (what === 'scene') note.scene = pick;
    if (what === 'frame') Object.assign(note, { scene: hit.scene.id, at: snapFrame(S.board, hit.local) });
    const j = await commit([{ op: 'note.add', note }]);
    if (!j) return;
    closeMenu();
    await sendNotes([S.board.notes.find(n => n.id === j.ops[0].note.id)], { what: 'a render request' });
  };
  const cancel = n => commit([
    { op: 'reply.add', note: n.id, reply: { text: 'Cancelled.' } },
    { op: 'note.set', id: n.id, fields: { resolved: true } },
  ]);
  const choose = (values, get, set, label, tip) => h('div.seg.rq-seg', values.map(v => h('button', { class: v === get() ? 'on' : '', 'data-tip': tip?.(v), onclick: () => { set(v); draw(); } }, label(v))));

  const draw = () => {
    const b = S.board, rows = layout(b), open = openRequests();
    const { w, h: hh } = renderSize(b, size), still = what === 'frame';
    // Parts that don't apply are left out (replaceChildren would print `false`).
    pop.replaceChildren(...[
      h('h3', 'Render with Claude'),
      open.length > 0 && h('div.rq-open', open.map(n => {
        return h('div.rq', { onclick: () => { closeMenu(); actions.openNote(n); }, title: 'Open the request' },
          h('span.rq-num', `#${b.notes.indexOf(n) + 1}`),
          h('span.rq-what', `${renderLabel(n)} of ${whatOf(n)}`),
          statusLight(n),
          h('button.icon-btn', { title: 'Cancel this request', html: icons.x, onclick: async e => { e.stopPropagation(); await cancel(n); draw(); } }));
      })),
      h('div.rq-label', 'What'),
      choose(['film', 'scene', 'frame'].filter(v => v === 'film' || (v === 'scene' ? rows.length : hit)), () => what, v => { what = v; },
        v => (v === 'film' ? 'Whole film' : v === 'scene' ? 'One scene' : 'One frame'),
        v => (v === 'film' ? `The whole cut${rows.length ? `, ${secs(rows.at(-1).end)}` : ''}` : v === 'scene' ? 'One scene, from the list' : 'The frame under the playhead, as a still')),
      what === 'scene' && h('select.field.rq-scene', { onchange: e => { pick = e.target.value; } },
        rows.map(({ scene: s }) => h('option', { value: s.id, selected: s.id === pick }, `${sceneName(s)} · ${+s.duration.toFixed(2)}s`))),
      what === 'frame' && h('div.rq-frame', `The frame under the playhead: ${tc(S.t, b.fps)} in ${sceneName(hit.scene)}. Move the playhead to pick another.`),
      h('div.rq-label', 'Size'),
      h('div.rq-sizes', Object.entries(RENDER_SIZES).map(([k, v]) => {
        const d = renderSize(b, k);
        return h('button.rq-size', { class: k === size ? 'on' : '', onclick: () => { size = k; remember(); draw(); } }, h('b', v.label), h('span', `${d.w}×${d.h}`));
      })),
      h('div.rq-label', 'Quality'),
      choose(RENDER_QUALITIES, () => quality, v => { quality = v; remember(); }, v => (v === 'draft' ? 'Draft' : 'Final'), v => qualityTip(b, v)),
      b.render && h('div.rq-how', b.render.type.map(t => RENDER_TYPES[t].label).join(' · '), b.render[quality] && h('span', ` · ${b.render[quality]}`)),
      h('div.rq-spec', still ? `One ${w}×${hh} still · PNG` : `${w}×${hh} · ${+b.fps} fps · ${renderCodec({ size, quality }, false)}`),
      words,
      h('div.row',
        h('button.text-btn', { onclick: () => closeMenu() }, 'Cancel'),
        h('button.text-btn.primary', { onclick: send, title: 'Send the request to Claude (⌘⏎)' }, h('span', { html: icons.spark, style: { display: 'inline-grid' } }), 'Send to Claude')),
      h('div.rq-instant', h('button.link', { title: 'The current versions cut together at half size, made here in a moment: no Claude needed', onclick: () => { closeMenu(); exportAnimatic(); } }, 'Or download the animatic now')),
    ].filter(Boolean));
  };
  draw();
  const r = btn.getBoundingClientRect();
  menu(r.right - 380, r.bottom + 6, [], { el: pop });
  words.focus();
}

// The animatic: Cutroom's own cut of the current versions, made here in a moment, no Claude needed.
async function exportAnimatic() {
  const t = toast('Rendering the animatic… (code sketches take a while)', { spin: true });
  try {
    const r = await fetch(`/api/boards/${encodeURIComponent(S.slug)}/animatic?scale=0.5`);
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    const url = URL.createObjectURL(await r.blob());
    const a = h('a', { href: url, download: `${S.slug}-animatic.mp4` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    t.done();
    toast('Animatic ready');
  } catch (e) {
    t.done();
    toast(e.message, { err: true, ms: 6000 });
  }
}

// The button shows when requests are open, and spins while Claude works on one.
function renderButton() {
  const open = openRequests();
  dot.hidden = !open.length;
  dot.classList.toggle('working', open.some(n => noteState(n) === 'working'));
  btn.title = open.length
    ? `${plural(open.length, 'render request')} open: see where they stand, or ask for another (R)`
    : 'Ask Claude for a render: the 4K master, 1080p or 720p (R)';
}

btn.addEventListener('click', () => openRender());
on('board', renderButton);
on('open', renderButton);
