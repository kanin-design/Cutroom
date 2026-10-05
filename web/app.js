// Boot, top bar, board switching, keyboard and the bits of chrome that tie the panels together.

import { S, on, emit, openBoard, undo, redo, select, commit, scene, activeSay, holding } from './store.js';
import { $, h, menu, closeMenu, modal, toast, typing, clamp, tc, ago, ask, authorName } from './util.js';
import { hydrateIcons, icons } from './icons.js';
import { pause, toggle, seek, setMuted, end, shuttle } from './player.js';
import { setCinema, inCinema } from './screen.js';
import { fitAll, zoomBy } from './timeline.js';
import { setView } from './grid.js';
import { actions } from './actions.js';
import { plural, noteState, forYou, sceneStart, aspectName, aspectFrame, RENDER_TYPES, RENDER_QUALITIES, ASPECTS } from '/lib/ops.js';
import { focusComposer, setFrame, sendAll, annotateHere } from './composer.js';
import { openRender } from './render.js';
import { handOffWhenOpen, claudeState, reachable, claudeAct, presenceCard } from './handoff.js';
import { refreshTip } from './tip.js';
import { openBoardSettings, openFilm } from './inspector.js';

hydrateIcons();

// ---------------------------------------------------------------- top bar

const boardTitle = $('#boardTitle'), boardMeta = $('#boardMeta'), renderKind = $('#renderKind'), presence = $('#presence'), presenceSay = $('#presenceSay');
const presenceLight = $('#presenceLight'), presenceScene = $('#presenceScene'), presenceProg = $('#presenceProg'), forYouChip = $('#forYou');

on('board', () => {
  const b = S.board;
  if (!b) return;
  boardTitle.textContent = b.title;
  document.title = `${b.title} · Cutroom`;
  boardMeta.textContent = [aspectName(b), `${+b.fps} fps`, b.bpm && `${+b.bpm} bpm`, plural(b.scenes.length, 'scene'), tc(end(), b.fps), b.archived && 'archived'].filter(Boolean).join(' · ');
  renderKind.hidden = !b.render;
  if (b.render) renderKind.textContent = b.render.type.map(t => RENDER_TYPES[t].label).join(' · ');
  $('#rulerSeg').hidden = !b.bpm; // without a tempo the ruler counts time, and the choice waits for a board with one
});

// Claude in the top bar: whether it's listening, what it's doing, on which shot, and how far along.
function renderPresence() {
  const p = S.presence;
  const recent = Date.now() - (p.lastAgentAt || 0) < 90_000;
  const say = activeSay();
  const owner = S.board?.owner;
  // Just "Claude" and its light; which session it is, what the light means and what to do about it are
  // in the card on hover. A click pings a session that's there, or hands the board to one that isn't.
  const st = claudeState(owner, p);
  presence.hidden = !S.board;
  presence.classList.toggle('idle', !reachable(owner, p) && !recent && !say);
  presence.classList.toggle('busy', !!say && recent);
  presenceLight.className = `light ${st.light}`;
  refreshTip(presence);
  presenceSay.textContent = say ? say.text : '';
  const s = say?.scene && scene(say.scene);
  presenceScene.hidden = !s;
  if (s) {
    const i = S.board.scenes.indexOf(s);
    presenceScene.replaceChildren(h('span.n', String(i + 1).padStart(2, '0')), s.title);
    presenceScene.onclick = () => { S.tab = 'scene'; select(s.id); };
  }
  presenceProg.hidden = say?.progress == null;
  if (say?.progress != null) {
    presenceProg.style.setProperty('--p', say.progress);
    presenceProg.querySelector('em').textContent = `${Math.round(say.progress * 100)}%`;
  }
}
on('presence', renderPresence);
on('board', renderPresence);
presence.card = presenceCard;
presence.addEventListener('click', e => { if (!e.target.closest('.presence-scene')) claudeAct(); });
presence.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); claudeAct(); } });
boardMeta.addEventListener('click', () => openBoardSettings());
// How the film renders, beside its title once Claude has set it: what that is and what draft and final
// mean, on hover; the film pane, on click.
renderKind.card = () => {
  const r = S.board?.render;
  if (!r) return null;
  return [
    r.type.map(t => [h('div.tip-head', RENDER_TYPES[t].label), h('div.tip-text', RENDER_TYPES[t].what)]),
    RENDER_QUALITIES.some(q => r[q]) && h('div.tip-rows', RENDER_QUALITIES.filter(q => r[q]).map(q => [h('span', q === 'draft' ? 'Draft' : 'Final'), h('span', r[q])])),
    h('div.tip-sub', 'Set by Claude'),
  ];
};
renderKind.addEventListener('click', () => openFilm());
setInterval(renderPresence, 15000);

// Notes waiting on the user: Claude replied, or Claude wrote to them.
function renderForYou() {
  const b = S.board;
  const list = b ? b.notes.filter(forYou) : [];
  forYouChip.hidden = !list.length;
  if (!list.length) return;
  const replies = list.filter(n => noteState(n) === 'replied').length;
  const label = replies === list.length ? plural(replies, 'reply', 'replies') : replies === 0 ? `${plural(list.length, 'note')} for you` : `${list.length} for you`;
  forYouChip.replaceChildren(h('i'), label);
  forYouChip.title = list.map(n => `#${b.notes.indexOf(n) + 1} ${n.text.slice(0, 70)}`).join('\n');
  forYouChip.onclick = () => actions.openNote(list[0]);
}
on('board', renderForYou);

// The boards, newest first: who owns each, whether an agent is listening, and what's waiting on you.
// Archiving hides a board from here and from the agents' overview; nothing is deleted.
let showArchived = false;
async function boardMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const { boards } = await (await fetch('/api/boards')).json();
  const current = boards.filter(b => !b.archived), archived = boards.filter(b => b.archived);
  const row = b => h('div.brow', { class: b.slug === S.slug ? 'cur' : '' },
    h('button.bmain', { onclick: () => { closeMenu(); location.hash = b.slug; } },
      h('span.bt', b.title),
      h('span.bsub', [b.owner || 'no owner', ago(new Date(b.updated).toISOString()), plural(b.scenes, 'scene')].join(' · ')),
    ),
    b.unsent > 0 && h('span.bunsent', { 'data-tip': `${plural(b.unsent, 'note')} you haven’t sent yet: open the board and press Send to Claude` }, String(b.unsent)),
    b.forYou > 0 && h('span.bfor', { 'data-tip': `${plural(b.forYou, 'note')} waiting on you` }, String(b.forYou)),
    b.listening > 0 ? h('i.light.is-on', { 'data-tip': 'Claude is listening for your notes on this board' })
      : b.busy && h('i.light.is-work', { 'data-tip': 'Claude is working on your notes on this board' }),
    h('button.barch', { title: 'Rename, settings, archive or delete', html: icons.more, onclick: ev => { ev.stopPropagation(); boardActions(b, ev.currentTarget.getBoundingClientRect()); } }),
  );
  menu(r.left, r.bottom + 6, [
    { head: 'Boards' },
    { node: h('div.boards', current.map(row)) },
    archived.length > 0 && { node: h('button.barch-toggle', { onclick: () => { showArchived = !showArchived; boardMenu(anchor); } }, `${showArchived ? 'Hide' : 'Show'} ${archived.length} archived`) },
    showArchived && archived.length > 0 && { node: h('div.boards.archived', archived.map(row)) },
    '-',
    { label: 'Board settings', icon: 'settings', onclick: () => openBoardSettings() },
    { label: 'New board…', icon: 'plus', onclick: () => newBoardDialog() },
  ].filter(Boolean), { cls: 'board-menu' });
}
$('#boardSwitch').addEventListener('click', e => boardMenu(e.currentTarget));

// Deleting moves the board's folder to the Trash; emptying the Trash is what frees the space.
// r: where to open, below it (the rect of what was clicked).
function confirmDelete(b, r) {
  const pop = h('div.pop.delete-pop',
    h('h3', `Delete “${b.title}”?`),
    h('p', `${plural(b.scenes, 'scene')}${b.open ? `, ${plural(b.open, 'open note')}` : ''} and all its media go to the Trash. It can be brought back from there until you empty it.`),
    b.listening > 0 && h('p.warn', 'An agent is listening on this board; it will be told the board is gone.'),
    h('div.row',
      h('button.text-btn', { onclick: () => closeMenu() }, 'Cancel'),
      h('button.text-btn.primary.danger-fill', { onclick: async () => {
        closeMenu();
        const res = await fetch(`/api/boards/${encodeURIComponent(b.slug)}/delete`, { method: 'POST', headers: { 'x-storyboard': '1' } });
        const j = await res.json();
        if (!res.ok) return toast(j.error, { err: true });
        toast(`Deleted “${b.title}” · it's in the Trash`);
        if (b.slug !== S.slug) boardMenu($('#boardSwitch'));
      } }, 'Delete'),
    ),
  );
  menu(Math.min(r.left, innerWidth - 340), r.bottom + 6, [], { el: pop });
}

// This board was deleted (here or in another tab): move on to another one.
on('board-deleted', slug => {
  if (slug !== S.slug) return;
  S.slug = null;
  try { localStorage.removeItem('sb.board'); } catch {}
  history.replaceState(null, '', location.pathname);
  route();
});

// The whole cut as one mp4 (renders, sketches, cards and the soundtrack), downloaded when ready.

// A new board starts from the idea: what it is, its shape and its frame rate. Claude fills in the rest
// once it has the board, so the new board opens straight onto handing it over.
function newBoardForm(onDone) {
  let aspect = '16:9', fps = 30;
  const brief = h('textarea.field.nb-brief', { rows: 4, placeholder: 'What is it? The idea, the length, the feel, in a few lines. Claude takes it from there.' });
  const title = h('input.field', { placeholder: 'Title (optional: Claude can name it)' });
  // A row of choices, like a segmented control.
  const choose = (values, get, set, label) => {
    const seg = h('div.seg.nb-seg');
    const draw = () => seg.replaceChildren(...values.map(v => h('button', { type: 'button', class: v === get() ? 'on' : '', onclick: () => { set(v); draw(); } }, label(v))));
    draw();
    return seg;
  };
  const shape = a => { const f = aspectFrame(a), k = 13 / Math.max(f.w, f.h); return [h('i.nb-shape', { style: { width: `${f.w * k}px`, height: `${f.h * k}px` } }), a]; };
  const form = h('form.board-form',
    brief,
    title,
    h('div.nb-row', h('span.nb-label', 'Shape'), choose(ASPECTS, () => aspect, v => { aspect = v; }, shape)),
    h('div.nb-row', h('span.nb-label', 'Frame rate'), choose([24, 25, 30, 60], () => fps, v => { fps = v; }, v => `${v} fps`)),
    h('div.row', { style: { justifyContent: 'flex-end' } },
      onDone && h('button.text-btn', { type: 'button', onclick: () => onDone() }, 'Cancel'),
      h('button.text-btn.primary', { type: 'submit', title: 'Create the board (⌘⏎)' }, 'Create board')),
  );
  form.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const r = await fetch('/api/boards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.value.trim() || 'Untitled', brief: brief.value.trim(), aspect, fps }) });
    const j = await r.json();
    if (!r.ok) return toast(j.error, { err: true });
    onDone?.();
    handOffWhenOpen(j.slug);
    location.hash = j.slug;
  });
  requestAnimationFrame(() => brief.focus());
  return form;
}

// A board's own menu: rename, its settings, archive, delete.
function boardActions(b, r) {
  const change = fields => (b.slug === S.slug
    ? commit([{ op: 'board.set', fields }])
    : fetch(`/api/boards/${encodeURIComponent(b.slug)}/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: [{ op: 'board.set', fields }], author: 'you' }) }));
  menu(r.left, r.bottom + 4, [
    { label: 'Rename…', icon: 'edit', onclick: async () => { const v = await ask(r.left, r.bottom + 4, { value: b.title, ok: 'Rename' }); if (v && v !== b.title) change({ title: v }); } },
    { label: 'Settings', icon: 'settings', onclick: () => openBoardSettings(b.slug) },
    { label: b.archived ? 'Bring back' : 'Archive', icon: b.archived ? 'unarchive' : 'archive', onclick: () => change({ archived: !b.archived }) },
    '-',
    { label: 'Delete…', icon: 'trash', danger: true, onclick: () => confirmDelete(b, r) },
  ]);
}

function newBoardDialog() {
  const close = modal([h('h2', 'New board'), newBoardForm(() => close())]);
}

// What the editor shows with no board to open: the logo and how to start, two ways. With `error` (the
// boards couldn't be read or opened), what went wrong and a way to try again.
function startScreen({ error = null } = {}) {
  document.querySelector('.welcome')?.remove();
  document.body.append(h('div.welcome', h('div.welcome-card',
    h('img.welcome-logo', { src: '/web/logo.svg', alt: 'Cutroom' }),
    error
      ? [h('h1', 'Your boards didn’t open'), h('p', error),
          h('div.row', h('button.text-btn.primary', { onclick: () => route() }, 'Try again'))]
      : [h('h1', 'Start a film'),
          h('p', 'Say what it is. Cutroom makes a board for it and hands it to Claude, who lays the idea out as scenes on a timeline for you to watch and mark up.'),
          newBoardForm(),
          h('p.welcome-alt', 'Or ask Claude to plan a film on the storyboard, in any Claude Code session that has the storyboard skill.')],
  )));
  started();
}

// The editor is up: the launch screen (index.html) goes.
function started() {
  if (window.cutroomStarted) return;
  window.cutroomStarted = true;
  try { sessionStorage.removeItem('sb.retried'); } catch {}
  const boot = $('#boot');
  boot?.classList.add('gone');
  setTimeout(() => boot?.remove(), 400);
}

// The agent pointing at something: select it and move the playhead there.
on('agent-focus', m => {
  const who = authorName(m.by || 'claude');
  if (S.playing) pause();
  if (m.note) {
    const n = S.board.notes.find(x => x.id === m.note);
    if (!n) return;
    actions.openNote(n);
    toast(`${who} is pointing at note ${S.board.notes.indexOf(n) + 1}`);
  } else if (m.scene) {
    const s = scene(m.scene);
    if (!s) return;
    S.tab = 'scene';
    select(s.id, { keepTime: true });
    seek(sceneStart(S.board, s.id) + (m.t ?? 0));
    toast(`${who} is showing you “${s.title}”`);
  } else if (m.t != null) {
    seek(m.t);
    toast(`${who} moved the playhead`);
  }
});

// ---------------------------------------------------------------- Claude answering your notes
// When an agent replies to, resolves or writes a note, say so; clicking the toast opens the thread.
on('board', e => {
  for (const batch of e?.batches || []) {
    if (batch.author === 'you' || batch.author === 'storyboard') continue;
    const who = authorName(batch.author);
    // One toast per note, however many things happened to it in this change.
    const acts = new Map();
    const read = batch.ops.filter(op => op.op === 'notes.read' && op.ids).flatMap(op => op.ids);
    if (read.length) {
      const nums = read.map(id => `#${S.board.notes.findIndex(n => n.id === id) + 1}`).join(', ');
      toast(`${who} read your note${read.length > 1 ? 's' : ''} ${nums}`, { ms: 5000 });
    }
    for (const op of batch.ops) {
      const [id, act] = op.op === 'reply.add' ? [op.note, 'replied to'] : op.op === 'note.set' && op.fields?.resolved === true ? [op.id, 'resolved']
        : op.op === 'note.set' && op.fields?.working ? [op.id, 'started on'] : op.op === 'note.add' ? [op.note?.id, 'wrote'] : [];
      if (!id) continue;
      if (!acts.has(id)) acts.set(id, []);
      if (!acts.get(id).includes(act)) acts.get(id).push(act);
    }
    for (const [id, did] of acts) {
      const n = S.board.notes.find(x => x.id === id);
      if (!n) continue;
      const num = S.board.notes.indexOf(n) + 1;
      toast(`${who} ${did.join(' and ')} note #${num} — open`, { ms: 7000, onclick: () => actions.openNote(n) });
    }
  }
});

on('annotate', () => annotateHere());

// ---------------------------------------------------------------- updates
// The server says which build of the editor it serves. If this tab is running an older one, offer
// a reload, and do it by itself at the first idle moment, keeping the board, playhead and selection.
const BUILD = document.querySelector('meta[name="sb-build"]')?.content;
let reloading = false;
function idle() {
  if (S.playing || holding()) return false; // never under a save, a markup or words not yet added
  if (document.visibilityState === 'hidden') return true;
  if (typing({ target: document.activeElement })) return false;
  if (document.querySelector('.clip.dragging, .clip.trimming, .gcard.dragging, .modal-back')) return false;
  return !$('#overlays').children.length;
}
function reloadNow() {
  try {
    sessionStorage.setItem('sb.resume', JSON.stringify({ slug: S.slug, t: S.t, sel: S.sel, tab: S.tab, view: S.view }));
  } catch {}
  location.reload();
}
on('build', build => {
  if (!BUILD || BUILD.startsWith('%') || build === BUILD || reloading) return;
  reloading = true;
  const chip = $('#updateChip');
  chip.hidden = false;
  chip.onclick = reloadNow;
  const attempt = () => (idle() ? reloadNow() : setTimeout(attempt, 1500));
  setTimeout(attempt, 1200);
});

// ---------------------------------------------------------------- transport + toolbar

$('#tPlay').addEventListener('click', toggle);
$('#tStart').addEventListener('click', () => seek(0));
$('#tPrev').addEventListener('click', () => actions.nextCut(-1));
$('#tNext').addEventListener('click', () => actions.nextCut(1));
$('#tLoop').addEventListener('click', () => { S.loop = !S.loop; emit('loop'); });
$('#tMute').addEventListener('click', () => setMuted(!S.muted));
on('loop', () => $('#tLoop').classList.toggle('on', S.loop));
on('mute', () => { $('#tMute').innerHTML = S.muted ? icons.mute : icons.volume; $('#tMute').classList.toggle('on', S.muted); });

$('#addScene').addEventListener('click', () => actions.addScene());
$('#splitBtn').addEventListener('click', () => actions.split());
$('#snapBtn').addEventListener('click', () => { S.snap = !S.snap; $('#snapBtn').classList.toggle('on', S.snap); });
$('#zoomFit').addEventListener('click', fitAll);
for (const b of document.querySelectorAll('#rulerSeg button')) b.addEventListener('click', () => { S.ruler = b.dataset.ruler; syncRuler(); emit('ruler'); });
function syncRuler() { for (const b of document.querySelectorAll('#rulerSeg button')) b.classList.toggle('on', b.dataset.ruler === S.ruler); }
on('board', syncRuler);
for (const b of document.querySelectorAll('#viewSeg button')) b.addEventListener('click', () => setView(b.dataset.view));
$('#helpBtn').addEventListener('click', showKeys);

// ---------------------------------------------------------------- splitter

const splitter = $('#splitter');
const setTimelineHeight = hgt => {
  hgt = clamp(hgt, 170, innerHeight - 260);
  document.documentElement.style.setProperty('--tl-h', hgt + 'px');
  try { localStorage.setItem('sb.tlh', hgt); } catch {}
};
splitter.addEventListener('pointerdown', e => {
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add('drag');
  const move = ev => setTimelineHeight(innerHeight - ev.clientY - 4);
  const up = () => { splitter.classList.remove('drag'); splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', up); };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
});
try {
  const hgt = +localStorage.getItem('sb.tlh');
  if (hgt) document.documentElement.style.setProperty('--tl-h', clamp(hgt, 170, innerHeight - 260) + 'px');
} catch {}
// Double-click: a big monitor (the smallest timeline), and back to the size it had.
let lastTimeline = 272;
splitter.addEventListener('dblclick', () => {
  const now = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tl-h')) || 272;
  if (now > 180) { lastTimeline = now; setTimelineHeight(170); } else setTimelineHeight(lastTimeline);
});

// The side panel can go, for a bigger picture; opening a note or the settings brings it back.
// The side pane's width: each view keeps its own (Edit's pane is a scene beside the picture, Board's the
// film beside the wall). Drag its edge to resize it; double-click the edge for the default.
const PANE = { edit: 344, board: 380 };
const paneGrip = $('#paneGrip');
const paneStored = () => { try { return +localStorage.getItem(`sb.pane.${S.view}`) || PANE[S.view]; } catch { return PANE[S.view]; } };
const setPane = w => document.documentElement.style.setProperty('--insp-w', `${clamp(Math.round(w), 280, Math.max(280, Math.min(720, innerWidth * 0.55)))}px`);
on('view', () => setPane(paneStored()));
addEventListener('resize', () => setPane(paneStored()));
paneGrip.addEventListener('pointerdown', e => {
  e.preventDefault();
  paneGrip.setPointerCapture(e.pointerId);
  paneGrip.classList.add('drag');
  const right = $('#workspace').getBoundingClientRect().right;
  const move = ev => setPane(right - ev.clientX);
  const up = () => {
    paneGrip.classList.remove('drag');
    paneGrip.removeEventListener('pointermove', move);
    paneGrip.removeEventListener('pointerup', up);
    try { localStorage.setItem(`sb.pane.${S.view}`, String(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--insp-w')))); } catch {}
  };
  paneGrip.addEventListener('pointermove', move);
  paneGrip.addEventListener('pointerup', up);
});
paneGrip.addEventListener('dblclick', () => { try { localStorage.removeItem(`sb.pane.${S.view}`); } catch {} setPane(PANE[S.view]); });

const panelBtn = $('#tPanel');
function setPanel(show) {
  document.body.classList.toggle('no-panel', !show);
  panelBtn.classList.toggle('on', !show);
  panelBtn.title = show ? 'Hide the side panel for a bigger picture (I)' : 'Show the side panel (I)';
  try { localStorage.setItem('sb.panel', show ? '1' : '0'); } catch {}
}
try { if (localStorage.getItem('sb.panel') === '0') setPanel(false); } catch {}
panelBtn.addEventListener('click', () => setPanel(document.body.classList.contains('no-panel')));
on('panel', () => setPanel(true));

// ---------------------------------------------------------------- keyboard

const KEYS = [
  ['Space', 'Play / pause'], ['J K L', 'Back, stop, forward (again for 2×, 4×, 8×)'], ['← →', 'Step one frame'], ['⇧ ← →', 'Step one second'],
  ['↑ ↓', 'Previous / next cut'], ['⇧↑ ⇧↓', 'Previous / next note'], ['Home End', 'Start / end'], ['Click the timecode', 'Type a time: 2115, or +12 frames'],
  ['⇧L', 'Loop the selected scene'], ['M', 'Mute'], ['⇧F', 'Full-screen playback'], ['C', 'Add a note'], ['⌘⏎', 'Send your notes to Claude'],
  ['F', 'Note about this exact frame (on/off)'], ['A', 'Mark up this frame (or double-click the picture)'],
  ['R', 'Ask Claude for a render: the film, a scene or a frame'], ['I', 'Hide or show the side panel'],
  ['N', 'New scene after the selection'], ['S', 'Split at the playhead'], ['⌘D', 'Duplicate scene'], ['⌫', 'Delete scene'],
  ['1 – 4', 'Status: idea, draft, review, approved'], ['[ ]', 'Select previous / next scene'], ['⌘Z  ⇧⌘Z', 'Undo / redo'], ['= −', 'Zoom in / out'],
  ['⇧Z', 'Fit timeline'], ['G', 'Edit / Board view'], ['Pinch · ⌘ scroll', 'Zoom the timeline'], ['Alt-drag an edge', 'Roll a cut'],
  ['⌘ while dragging', 'No snapping'], ['Esc', 'Clear selection'],
];

function showKeys() {
  modal([h('h2', 'Keyboard'), h('div.keys', KEYS.map(([k, v]) => h('div', h('span', v), h('kbd', k))))]);
}

// Watching full screen, only the playback keys work: nothing gets edited out of sight.
const CINEMA_KEYS = new Set([' ', 'j', 'J', 'k', 'K', 'l', 'L', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'm', 'M', 'F', 'Escape']);

addEventListener('keydown', e => {
  if (typing(e) || !S.board) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  const hit = () => e.preventDefault();
  if (inCinema() && (mod || !CINEMA_KEYS.has(k))) return;
  if (mod && k.toLowerCase() === 'z') { hit(); return e.shiftKey ? redo() : undo(); }
  if (mod && k.toLowerCase() === 'y') { hit(); return redo(); }
  if (mod && k.toLowerCase() === 'd') { hit(); return actions.duplicate(); }
  if (mod && k === 'Enter') { hit(); return sendAll(); }
  if (mod) return;
  switch (k) {
    case ' ': hit(); return toggle();
    case 'j': case 'J': hit(); return shuttle(-1);
    case 'k': case 'K': hit(); return S.playing && pause();
    case 'l': case 'L':
      hit();
      if (!e.shiftKey) return shuttle(1);
      S.loop = !S.loop;
      return emit('loop');
    case 'ArrowLeft': hit(); return actions.step(e.shiftKey ? -S.board.fps : -1);
    case 'ArrowRight': hit(); return actions.step(e.shiftKey ? S.board.fps : 1);
    case 'ArrowUp': hit(); return e.shiftKey ? actions.nextNote(-1) : actions.nextCut(-1);
    case 'ArrowDown': hit(); return e.shiftKey ? actions.nextNote(1) : actions.nextCut(1);
    case 'Home': hit(); return seek(0);
    case 'End': hit(); return seek(end());
    case 'm': case 'M': return setMuted(!S.muted);
    case 'c': case 'C': hit(); return focusComposer();
    case 'f': case 'F':
      if (e.shiftKey) { hit(); return setCinema(!inCinema()); }
      return setFrame(!S.noteFrame);
    case 'a': case 'A': case 'p': case 'P': hit(); return annotateHere();
    case 'n': case 'N': hit(); return actions.addScene();
    case 's': case 'S': return actions.split();
    case 'g': case 'G': return setView(S.view === 'edit' ? 'board' : 'edit');
    case 'i': case 'I': return setPanel(document.body.classList.contains('no-panel'));
    case 'r': case 'R': hit(); return openRender();
    case 'Z': if (e.shiftKey) return fitAll(); break;
    case '=': case '+': return zoomBy(1.5);
    case '-': case '_': return zoomBy(1 / 1.5);
    case '?': return showKeys();
    case 'Backspace': case 'Delete':
      hit();
      if (S.sel.note) return commit([{ op: 'note.remove', id: S.sel.note }]);
      return actions.remove();
    case '1': case '2': case '3': case '4': return actions.setStatus(['idea', 'draft', 'review', 'approved'][+k - 1]);
    case '[': case ']': {
      const ids = S.board.scenes.map(s => s.id);
      const i = ids.indexOf(S.sel.scene);
      const next = ids[clamp(i < 0 ? 0 : i + (k === ']' ? 1 : -1), 0, ids.length - 1)];
      if (next) select(next);
      return;
    }
    case 'Escape':
      if (inCinema()) return setCinema(false);
      if (S.sel.scene || S.sel.note) { S.sel = { scene: null, note: null }; emit('select'); }
      return;
  }
});

// Buttons never keep keyboard focus, so Space always means play/pause.
addEventListener('mousedown', e => { if (e.target.closest('button') && !e.target.closest('form, .pop')) e.preventDefault(); });

// Files dropped outside a target shouldn't navigate the page away.
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => e.preventDefault());

// ---------------------------------------------------------------- boot

// The boards, asking again for a few seconds while the server restarts.
async function listBoards() {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch('/api/boards');
      if (r.ok) return (await r.json()).boards;
    } catch {}
    if (i === 4) throw new Error('Cutroom couldn’t read your boards: the server may be restarting, or it stopped.');
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function route() {
  const slug = decodeURIComponent(location.hash.slice(1));
  let boards;
  try { boards = await listBoards(); } catch (e) { return startScreen({ error: e.message }); }
  if (!boards.length) return startScreen();
  let pick = boards.find(b => b.slug === slug)?.slug;
  if (!pick) {
    let last = null;
    try { last = localStorage.getItem('sb.board'); } catch {}
    pick = boards.find(b => b.slug === last)?.slug || (boards.find(b => !b.archived) || boards[0]).slug;
    history.replaceState(null, '', `#${pick}`);
  }
  document.querySelector('.welcome')?.remove();
  if (pick === S.slug) return;
  if (S.playing) pause();
  try {
    await openBoard(pick);
    resume(pick);
    started();
  } catch (e) {
    if (window.cutroomStarted && S.board) return toast(e.message, { err: true });
    S.slug = null; // so Try again opens it
    startScreen({ error: `“${boards.find(b => b.slug === pick)?.title || pick}” didn’t open: ${e.message}` });
  }
}
addEventListener('hashchange', route);

// After an update reload: back to where you were.
function resume(slug) {
  let r = null;
  try { r = JSON.parse(sessionStorage.getItem('sb.resume') || 'null'); sessionStorage.removeItem('sb.resume'); } catch {}
  if (!r || r.slug !== slug) return;
  if (r.view) setView(r.view);
  if (r.tab) S.tab = r.tab;
  if (r.sel?.scene && scene(r.sel.scene)) select(r.sel.scene, { note: r.sel.note, keepTime: true });
  seek(r.t || 0);
  toast('Editor updated');
}

let view = 'edit';
try { view = localStorage.getItem('sb.view') || 'edit'; } catch {}
S.tab = 'scene';
setView(view);
route();
