// Boot, top bar, board switching, keyboard and the bits of chrome that tie the panels together.

import { S, on, emit, openBoard, undo, redo, select, commit, scene, activeSay, sceneRange } from './store.js';
import { $, h, menu, closeMenu, modal, toast, typing, clamp, short, ago } from './util.js';
import { hydrateIcons, icons } from './icons.js';
import { play, pause, toggle, seek, setMuted, end } from './player.js';
import { setPinning } from './viewer.js';
import { fitAll, zoomBy } from './timeline.js';
import { setView } from './grid.js';
import { actions } from './actions.js';
import { noteStatus } from './inspector.js';
import { noteTime } from '/lib/ops.js';
import { focusComposer, setFrame, sendAll } from './composer.js';

hydrateIcons();

// ---------------------------------------------------------------- top bar

const boardTitle = $('#boardTitle'), boardMeta = $('#boardMeta'), presence = $('#presence'), presenceSay = $('#presenceSay');
const presenceState = $('#presenceState'), presenceScene = $('#presenceScene'), presenceProg = $('#presenceProg'), forYou = $('#forYou');

on('board', () => {
  const b = S.board;
  if (!b) return;
  boardTitle.textContent = b.title;
  document.title = `${b.title} · Storyboard`;
  boardMeta.textContent = [`${b.width}×${b.height}`, `${+b.fps} fps`, b.bpm && `${+b.bpm} bpm`, `${b.scenes.length} scene${b.scenes.length === 1 ? '' : 's'}`, short(end()), b.archived && 'archived'].filter(Boolean).join(' · ');
  $('#rulerSeg').hidden = !b.bpm;
  if (!b.bpm && S.ruler === 'bars') S.ruler = 'time';
});

// Claude in the top bar: whether it's listening, what it's doing, on which shot, and how far along.
function renderPresence() {
  const p = S.presence;
  const recent = Date.now() - (p.lastAgentAt || 0) < 90_000;
  const say = activeSay();
  presence.hidden = !(p.watching || recent || say || S.board?.owner);
  presence.classList.toggle('idle', !p.watching && !recent && !say);
  presence.classList.toggle('busy', !!say && recent);
  presence.title = p.watching ? 'Listening: your notes reach it the moment you send them' : 'Not listening: notes you send wait until it checks the board';
  presence.querySelector('.presence-name').textContent = S.board?.owner || 'Claude';
  presenceState.className = `presence-state ${p.watching ? 'on' : ''}`;
  presenceState.textContent = p.watching ? 'Listening' : 'Not listening';
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
setInterval(renderPresence, 15000);

// Notes waiting on the user: Claude replied, or Claude wrote to them.
function renderForYou() {
  const b = S.board;
  const list = b ? b.notes.filter(n => ['replied', 'agent'].includes(noteStatus(n).key)) : [];
  forYou.hidden = !list.length;
  if (!list.length) return;
  const replies = list.filter(n => noteStatus(n).key === 'replied').length;
  const label = replies === list.length ? `${replies} repl${replies > 1 ? 'ies' : 'y'}` : replies === 0 ? `${list.length} note${list.length > 1 ? 's' : ''} for you` : `${list.length} for you`;
  forYou.replaceChildren(h('i'), label);
  forYou.title = list.map(n => `#${b.notes.indexOf(n) + 1} ${n.text.slice(0, 70)}`).join('\n');
  forYou.onclick = () => {
    const n = list[0];
    S.tab = 'notes';
    select(n.scene, { note: n.id, keepTime: true });
    const t = noteTime(S.board, n);
    if (t != null && n.at != null) seek(t);
    else if (n.scene) seek(sceneRange(n.scene).start);
  };
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
      h('span.bsub', [b.owner || 'no owner', ago(new Date(b.updated).toISOString()), `${b.scenes} scene${b.scenes === 1 ? '' : 's'}`].join(' · ')),
    ),
    b.forYou > 0 && h('span.bfor', { title: `${b.forYou} note${b.forYou > 1 ? 's' : ''} waiting on you` }, String(b.forYou)),
    b.listening > 0 && h('i.blisten', { title: 'An agent is listening for your notes' }),
    h('button.barch', { title: b.archived ? 'Bring back' : 'Archive: hide it from the lists (nothing is deleted)', html: icons[b.archived ? 'unarchive' : 'archive'], onclick: async ev => {
      ev.stopPropagation();
      await fetch(`/api/boards/${encodeURIComponent(b.slug)}/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: [{ op: 'board.set', fields: { archived: !b.archived } }], author: 'you' }) });
      boardMenu(anchor);
    } }),
    h('button.barch.bdel', { title: 'Delete: move the board to the Trash', html: icons.trash, onclick: ev => { ev.stopPropagation(); confirmDelete(b, ev.currentTarget); } }),
  );
  menu(r.left, r.bottom + 6, [
    { head: 'Boards' },
    { node: h('div.boards', current.map(row)) },
    archived.length > 0 && { node: h('button.barch-toggle', { onclick: () => { showArchived = !showArchived; boardMenu(anchor); } }, `${showArchived ? 'Hide' : 'Show'} ${archived.length} archived`) },
    showArchived && archived.length > 0 && { node: h('div.boards.archived', archived.map(row)) },
    '-',
    { label: 'Export animatic (mp4)', icon: 'film', onclick: () => exportAnimatic() },
    { label: 'New board…', icon: 'plus', onclick: () => newBoardDialog() },
  ].filter(Boolean), { cls: 'board-menu' });
}
$('#boardSwitch').addEventListener('click', e => boardMenu(e.currentTarget));

// Deleting moves the board's folder to the Trash; emptying the Trash is what frees the space.
function confirmDelete(b, at) {
  const r = at.getBoundingClientRect();
  const pop = h('div.pop.delete-pop',
    h('h3', `Delete “${b.title}”?`),
    h('p', `${b.scenes} scene${b.scenes === 1 ? '' : 's'}${b.open ? `, ${b.open} open note${b.open > 1 ? 's' : ''}` : ''} and all its media go to the Trash. It can be brought back from there until you empty it.`),
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

function newBoardForm(onDone) {
  const title = h('input.field', { placeholder: 'Title — e.g. Showreel 2026' });
  const size = h('select.field', ...['1920x1080', '2560x1440', '3840x2160', '1080x1920', '1080x1350', '1080x1080', '2048x858'].map(v => h('option', { value: v }, v.replace('x', ' × '))));
  const fps = h('select.field', ...[24, 25, 30, 48, 50, 60].map(v => h('option', { value: v, selected: v === 30 }, `${v} fps`)));
  const bpm = h('input.field', { placeholder: 'Tempo (bpm), optional', type: 'number' });
  const form = h('form.board-form',
    title,
    h('div.two', size, fps),
    bpm,
    h('div.row', { style: { justifyContent: 'flex-end' } }, h('button.text-btn.primary', { type: 'submit' }, 'Create board')),
  );
  form.addEventListener('keydown', e => e.stopPropagation());
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const [width, height] = size.value.split('x').map(Number);
    const r = await fetch('/api/boards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.value.trim() || 'Untitled', width, height, fps: +fps.value, bpm: bpm.value ? +bpm.value : null }) });
    const j = await r.json();
    if (!r.ok) return toast(j.error, { err: true });
    onDone?.();
    location.hash = j.slug;
  });
  requestAnimationFrame(() => title.focus());
  return form;
}

function newBoardDialog() {
  const close = modal([h('h2', 'New board'), newBoardForm(() => close())]);
}

function welcome() {
  document.querySelector('.welcome')?.remove();
  document.body.append(h('div.welcome', h('div.welcome-card',
    h('h1', 'Start a storyboard'),
    h('p', 'A board is a sequence of scenes on a timeline that you and Claude edit together. Claude can also start one with ', h('code', 'sb new <title>'), '.'),
    newBoardForm(),
  )));
}

// The agent pointing at something: select it and move the playhead there.
on('agent-focus', async m => {
  const { sceneStart } = await import('/lib/ops.js');
  const who = m.by ? m.by[0].toUpperCase() + m.by.slice(1) : 'Claude';
  if (S.playing) pause();
  if (m.note) {
    const n = S.board.notes.find(x => x.id === m.note);
    if (!n) return;
    S.tab = 'notes';
    select(n.scene, { note: n.id, keepTime: true });
    const t = noteTime(S.board, n);
    if (t != null) seek(t);
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
    const who = batch.author[0].toUpperCase() + batch.author.slice(1);
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
      toast(`${who} ${did.join(' and ')} note #${num} — open`, { ms: 7000, onclick: () => { S.tab = 'notes'; S.sel = { scene: n.scene ?? S.sel.scene, note: n.id }; emit('select'); } });
    }
  }
});

// ---------------------------------------------------------------- updates
// The server says which build of the editor it serves. If this tab is running an older one, offer
// a reload, and do it by itself at the first idle moment, keeping the board, playhead and selection.
const BUILD = document.querySelector('meta[name="sb-build"]')?.content;
let reloading = false;
function idle() {
  if (S.playing) return false;
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
splitter.addEventListener('pointerdown', e => {
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add('drag');
  const move = ev => {
    const hgt = clamp(innerHeight - ev.clientY - 4, 170, innerHeight - 260);
    document.documentElement.style.setProperty('--tl-h', hgt + 'px');
    try { localStorage.setItem('sb.tlh', hgt); } catch {}
  };
  const up = () => { splitter.classList.remove('drag'); splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', up); };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', up);
});
try {
  const hgt = +localStorage.getItem('sb.tlh');
  if (hgt) document.documentElement.style.setProperty('--tl-h', clamp(hgt, 170, innerHeight - 260) + 'px');
} catch {}

// ---------------------------------------------------------------- keyboard

const KEYS = [
  ['Space', 'Play / pause'], ['← →', 'Step one frame'], ['⇧ ← →', 'Step one second'], ['↑ ↓', 'Previous / next cut'],
  ['Home End', 'Start / end'], ['L', 'Loop the selected scene'], ['M', 'Mute'], ['C', 'Add a note'], ['⌘⏎', 'Send your notes to Claude'],
  ['F', 'Note about this exact frame (on/off)'], ['P', 'Mark a spot on the frame'],
  ['N', 'New scene after the selection'], ['S', 'Split at the playhead'], ['⌘D', 'Duplicate scene'], ['⌫', 'Delete scene'],
  ['1 – 4', 'Status: idea, draft, review, approved'], ['[ ]', 'Select previous / next scene'], ['⌘Z  ⇧⌘Z', 'Undo / redo'], ['= −', 'Zoom in / out'],
  ['⇧Z', 'Fit timeline'], ['G', 'Edit / Board view'], ['Pinch · ⌘ scroll', 'Zoom the timeline'], ['Alt-drag an edge', 'Roll a cut'],
  ['⌘ while dragging', 'No snapping'], ['Esc', 'Clear selection'],
];

function showKeys() {
  modal([h('h2', 'Keyboard'), h('div.keys', KEYS.map(([k, v]) => h('div', h('span', v), h('kbd', k))))]);
}

addEventListener('keydown', e => {
  if (typing(e) || !S.board) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  const hit = () => e.preventDefault();
  if (mod && k.toLowerCase() === 'z') { hit(); return e.shiftKey ? redo() : undo(); }
  if (mod && k.toLowerCase() === 'y') { hit(); return redo(); }
  if (mod && k.toLowerCase() === 'd') { hit(); return actions.duplicate(); }
  if (mod && k === 'Enter') { hit(); return sendAll(); }
  if (mod) return;
  switch (k) {
    case ' ': hit(); return toggle();
    case 'ArrowLeft': hit(); return actions.step(e.shiftKey ? -S.board.fps : -1);
    case 'ArrowRight': hit(); return actions.step(e.shiftKey ? S.board.fps : 1);
    case 'ArrowUp': hit(); return actions.nextCut(-1);
    case 'ArrowDown': hit(); return actions.nextCut(1);
    case 'Home': hit(); return seek(0);
    case 'End': hit(); return seek(end());
    case 'l': case 'L': S.loop = !S.loop; return emit('loop');
    case 'm': case 'M': return setMuted(!S.muted);
    case 'c': case 'C': hit(); return focusComposer();
    case 'f': case 'F': return setFrame(!S.noteFrame);
    case 'p': case 'P': if (S.playing) pause(); return setPinning(!S.pinning);
    case 'n': case 'N': hit(); return actions.addScene();
    case 's': case 'S': return actions.split();
    case 'g': case 'G': return setView(S.view === 'edit' ? 'board' : 'edit');
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
      if (S.pinning) return setPinning(false);
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

async function route() {
  const slug = decodeURIComponent(location.hash.slice(1));
  const { boards } = await (await fetch('/api/boards')).json();
  if (!boards.length) return welcome();
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
  } catch (e) {
    toast(e.message, { err: true });
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
