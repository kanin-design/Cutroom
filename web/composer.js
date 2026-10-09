// The message bar under the monitor: the way the user talks to the agent about the film. It always
// says what a message is about: the scene under the playhead (or another one, the whole film, or the
// soundtrack), and, with Frame on, the exact frame (on the soundtrack: the moment). To show something
// on the frame itself, the markup button (A) opens the frame large in the annotator.

import { S, on, emit, here, commit, select, scene, hold } from './store.js';
import { layout, snapFrame, plural, editList, sendList } from '/lib/ops.js';
import { $, h, tc, menu, toast } from './util.js';
import { refreshTip } from './tip.js';
import { icons } from './icons.js';
import { pause, seek } from './player.js';
import { sceneColor } from './viewer.js';
import { wire, chips, takeFiles, pendingFiles } from './attach.js';
import { openAnnotator } from './annotate.js';
import { handOff, claudeState } from './handoff.js';

const bar = $('#composerBar'), sceneBtn = $('#cbScene'), frameBtn = $('#cbFrame'), frameLabel = $('#cbFrameLabel'), tcEl = $('#cbTc');
const text = $('#cbText'), markBtn = $('#cbMark'), sendBtn = $('#cbSend'), sendAllBtn = $('#cbSendAll'), filesEl = $('#cbFiles');

hold(() => !!text.value.trim()); // words typed but not added

// target: 'here' (the scene under the playhead), 'board' or 'soundtrack'
S.noteTarget = 'here';
try { S.noteFrame = localStorage.getItem('sb.noteFrame') === '1'; } catch { S.noteFrame = false; }

const target = () => (S.noteTarget !== 'here' || !S.board?.scenes.length ? null : here());
const onSoundtrack = () => S.noteTarget === 'soundtrack' && !!S.board?.audio;

let chipKey = '';
function renderChip(hit) {
  const rows = layout(S.board);
  if (onSoundtrack()) {
    sceneBtn.style.setProperty('--c', 'var(--muted)');
    sceneBtn.replaceChildren(h('span.wave', { html: icons.wave }), h('span.t', 'Soundtrack'), h('span', { html: icons.chevron, style: { display: 'inline-grid' } }));
    sceneBtn.title = 'A note about the soundtrack — click to choose a scene instead';
  } else if (hit) {
    const row = rows[hit.index];
    sceneBtn.style.setProperty('--c', sceneColor(hit.scene));
    sceneBtn.replaceChildren(h('i'), h('span.n', String(hit.index + 1).padStart(2, '0')), h('span.t', hit.scene.title), h('span', { html: icons.chevron, style: { display: 'inline-grid' } }));
    sceneBtn.title = `${hit.scene.id} · ${tc(row.start, S.board.fps)}–${tc(row.end, S.board.fps)} — click to choose another scene`;
  } else {
    sceneBtn.style.setProperty('--c', 'var(--faint)');
    sceneBtn.replaceChildren(h('i'), h('span.t', 'Whole film'), h('span', { html: icons.chevron, style: { display: 'inline-grid' } }));
  }
}

// A note needs words or a file before it can be added.
function updateAdd() { sendBtn.disabled = !text.value.trim() && !pendingFiles('bar').length; }

function render() {
  if (!S.board) return;
  const hit = target(), sound = onSoundtrack();
  const key = sound ? 'soundtrack' : hit ? `${hit.scene.id}|${hit.scene.title}|${hit.scene.color}|${hit.index}|${S.board.rev}` : 'board';
  if (key !== chipKey) renderChip(hit);
  chipKey = key;
  const frameOn = S.noteFrame && (!!hit || sound);
  frameBtn.disabled = !hit && !sound;
  frameBtn.classList.toggle('on', frameOn);
  frameLabel.textContent = sound ? 'At' : 'Frame';
  frameBtn.title = sound ? 'About this moment of the soundtrack (F)' : 'About this exact frame (F)';
  const f = Math.round(S.t * S.board.fps);
  tcEl.textContent = `${tc(S.t, S.board.fps)} · f${f}`;
  text.placeholder = sound
    ? frameOn ? `Add a note about the soundtrack at ${tc(S.t, S.board.fps)}…` : 'Add a note about the whole soundtrack…'
    : !hit
      ? 'Add a note about the whole film…'
      : frameOn
        ? `Add a note about this frame of “${hit.scene.title}”…`
        : `Add a note about “${hit.scene.title}”…`;
  updateAdd();
  const notes = unsentNotes().length, changes = unsentChanges();
  sendAllBtn.hidden = !notes && !changes;
  if (notes || changes) sendAllBtn.replaceChildren(h('span', { html: icons.spark, style: { display: 'inline-grid' } }), `Send ${notes + changes} to Claude`);
}

// The Send button's card: what it hands Claude (sendList), so you can check before you send. A long list shows
// its first rows and how many more, so the card stays on screen.
function sendCard() {
  const notes = unsentNotes().length, changes = unsentChanges();
  if (!notes && !changes) return null;
  const list = sendList(S.board);
  const rows = (all, max = 8) => [
    h('div.send-list', all.slice(0, all.length > max ? max - 1 : max).map(r => h('div.send-row', h('span.n', r.n), h('span.t', r.t), r.w && h('span.w', r.w)))),
    all.length > max && h('div.tip-sub', `and ${all.length - max + 1} more`),
  ];
  return [
    h('div.tip-head', 'Not sent yet'),
    notes > 0 && [h('div.tip-sub', plural(notes, 'note')), rows(list.notes)],
    changes > 0 && [h('div.tip-sub', `${plural(changes, 'change')} you made on the board`), rows(list.changes)],
    h('div.tip-sub', 'Send hands Claude all of them (⌘⏎).'),
  ];
}
sendAllBtn.card = sendCard;
on('board', () => refreshTip(sendAllBtn)); // open while the board changes: it shows what waits now

function fit() {
  text.style.height = 'auto';
  text.style.height = Math.min(140, text.scrollHeight) + 'px';
}

export function setFrame(v) {
  S.noteFrame = v;
  try { localStorage.setItem('sb.noteFrame', v ? '1' : '0'); } catch {}
  render();
}

export function focusComposer() {
  if (S.playing) pause();
  text.focus();
}

// Write a note about the soundtrack: at moment t (seconds into it), or about the whole of it.
export function noteOnSoundtrack(t = null) {
  S.noteTarget = 'soundtrack';
  if (t != null) seek(t);
  setFrame(t != null);
  focusComposer();
}

const unsentNotes = () => (S.board ? S.board.notes.filter(n => n.author === 'you' && !n.sent && !n.resolved) : []);
// Your own changes to the board since you last sent: they go to Claude with the notes.
const unsentChanges = () => (S.board ? editList(S.board).length : 0);
export const waiting = (notes, changes) => [notes && plural(notes, 'note'), changes && plural(changes, 'change')].filter(Boolean).join(' and ');

// Enter: add the note to the board. Claude doesn't get it until you send. One at a time: a held Enter or a
// double click on Add makes one note, not several.
let adding = false;
async function add() {
  if (adding) return;
  adding = true;
  try { await addNote(); } finally { adding = false; }
}
async function addNote() {
  const body = text.value.trim();
  if (!body && !pendingFiles('bar').length) {
    bar.classList.remove('shake');
    void bar.offsetWidth;
    bar.classList.add('shake');
    return text.focus();
  }
  const hit = target(), sound = onSoundtrack();
  const frameOn = S.noteFrame && (!!hit || sound);
  const note = sound ? { soundtrack: true, text: body } : { scene: hit ? hit.scene.id : null, text: body };
  if (frameOn) note.at = snapFrame(S.board, sound ? S.t : hit.local);
  const files = await takeFiles('bar');
  if (files.length) note.files = files;
  showFiles();
  const j = await commit([{ op: 'note.add', note }]);
  if (!j) return;
  text.value = '';
  fit();
  render();
  const n = j.ops[0].note;
  const count = unsentNotes().length;
  toast(`Note added · ${count} waiting to send`);
  S.sel = { scene: n.scene ?? S.sel.scene, note: n.id };
  emit('select');
}

// Send: hand every unsent note to Claude at once.
export async function sendAll() {
  if (text.value.trim() || pendingFiles('bar').length) await add();
  const notes = unsentNotes();
  if (!notes.length && !unsentChanges()) return toast('Nothing to send. Add a note, or change the board, first.');
  return sendNotes(notes);
}

// Hand notes to Claude, then say honestly what happens to them. `what` names them for the user. A session
// listening has them now; a busy one (working on earlier notes) gets them the moment it's done; with
// neither, nothing will notice them by itself, so the hand-off message is offered.
export async function sendNotes(notes, { what = notes.length ? plural(notes.length, 'note') : '' } = {}) {
  const changes = unsentChanges();
  const j = await commit([{ op: 'notes.send', ids: notes.map(n => n.id) }]);
  if (!j) return;
  render();
  if (changes) what = [what, plural(changes, 'change')].filter(Boolean).join(' and ');
  const them = notes.length + changes > 1 ? 'them' : 'it';
  const st = claudeState(S.board.owner);
  if (st.key === 'listening') return toast(`Sent ${what} to Claude: it has ${them} now`);
  if (st.key === 'busy') return toast(`Sent ${what}. Claude is working on your earlier notes and gets ${them} the moment it’s done`, { ms: 5000 });
  handOff({ sent: what });
}

// ---------------------------------------------------------------- wiring

text.addEventListener('focus', () => { bar.classList.add('focus'); if (S.playing) pause(); });
text.addEventListener('blur', () => bar.classList.remove('focus'));
text.addEventListener('input', () => { fit(); updateAdd(); });
text.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendAll(); return; }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); add(); }
  if (e.key === 'Escape') { e.preventDefault(); text.blur(); }
});
sendBtn.addEventListener('click', add);

// Files on the bar's note: the paperclip, a drop on the bar, or a paste into the field.
function showFiles() {
  filesEl.replaceChildren(...[chips('bar', showFiles)].filter(Boolean));
  updateAdd();
}
wire('bar', { button: $('#cbClip'), zone: bar, field: text, onchange: showFiles });
sendAllBtn.addEventListener('click', sendAll);
frameBtn.addEventListener('click', () => setFrame(!S.noteFrame));
// Mark up this frame: words already typed in the bar go along as the note's text.
export function annotateHere() {
  const words = text.value.trim();
  text.value = '';
  fit();
  render();
  openAnnotator({ text: words });
}
markBtn.addEventListener('click', annotateHere);
on('send-notes', () => sendAll());

sceneBtn.addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  const cur = target();
  const rows = layout(S.board);
  const m = menu(r.left, r.top - 8, [
    { head: 'Message about' },
    { label: 'Whole film', icon: 'note', cls: !cur && !onSoundtrack() ? 'cur' : '', onclick: () => { S.noteTarget = 'board'; render(); text.focus(); } },
    S.board.audio && { label: 'Soundtrack', icon: 'wave', cls: onSoundtrack() ? 'cur' : '', onclick: () => { S.noteTarget = 'soundtrack'; render(); text.focus(); } },
    '-',
    ...rows.map(({ scene: s, index, start }) => ({
      label: `${String(index + 1).padStart(2, '0')}  ${s.title}`,
      dot: sceneColor(s),
      meta: tc(start, S.board.fps),
      cls: cur?.scene.id === s.id ? 'cur' : '',
      onclick: () => { S.noteTarget = 'here'; select(s.id); render(); text.focus(); },
    })),
  ].filter(Boolean), { cls: 'scene-menu' });
  // open upwards from the bar
  const mr = m.getBoundingClientRect();
  m.style.top = Math.max(8, r.top - mr.height - 6) + 'px';
});

on('time', render);
on('board', render);
on('select', render);
on('presence', render);
on('open', () => { S.noteTarget = 'here'; text.value = ''; fit(); render(); });
render();
