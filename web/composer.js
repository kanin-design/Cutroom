// The message bar under the monitor: the way the user talks to the agent about the film. It always
// says what a message is about: the scene under the playhead (or another one, or the whole board),
// and, with Frame on, the exact frame. To show something on the frame itself, the markup button (A)
// opens the frame large in the annotator.

import { S, on, emit, here, commit, select, scene } from './store.js';
import { layout, snapFrame } from '/lib/ops.js';
import { $, h, tc, menu, closeMenu, toast } from './util.js';
import { icons } from './icons.js';
import { pause } from './player.js';
import { sceneColor } from './viewer.js';
import { wire, chips, takeFiles, pendingFiles } from './attach.js';
import { openAnnotator } from './annotate.js';

const bar = $('#composerBar'), sceneBtn = $('#cbScene'), frameBtn = $('#cbFrame'), tcEl = $('#cbTc');
const text = $('#cbText'), markBtn = $('#cbMark'), sendBtn = $('#cbSend'), sendAllBtn = $('#cbSendAll'), filesEl = $('#cbFiles');

// target: 'here' (the scene under the playhead) or 'board'
S.noteTarget = 'here';
try { S.noteFrame = localStorage.getItem('sb.noteFrame') === '1'; } catch { S.noteFrame = false; }

const target = () => (S.noteTarget === 'board' || !S.board?.scenes.length ? null : here());

let chipKey = '';
function renderChip(hit) {
  const rows = layout(S.board);
  if (hit) {
    const row = rows[hit.index];
    sceneBtn.style.setProperty('--c', sceneColor(hit.scene));
    sceneBtn.replaceChildren(h('i'), h('span.n', String(hit.index + 1).padStart(2, '0')), h('span.t', hit.scene.title), h('span', { html: icons.chevron, style: { display: 'inline-grid' } }));
    sceneBtn.title = `${hit.scene.id} · ${tc(row.start, S.board.fps)}–${tc(row.end, S.board.fps)} — click to choose another scene`;
  } else {
    sceneBtn.style.setProperty('--c', 'var(--faint)');
    sceneBtn.replaceChildren(h('i'), h('span.t', 'Whole board'), h('span', { html: icons.chevron, style: { display: 'inline-grid' } }));
  }
}

function render() {
  if (!S.board) return;
  const hit = target();
  const key = hit ? `${hit.scene.id}|${hit.scene.title}|${hit.scene.color}|${hit.index}|${S.board.rev}` : 'board';
  if (key !== chipKey) renderChip(hit);
  chipKey = key;
  const frameOn = S.noteFrame && !!hit;
  frameBtn.disabled = !hit;
  frameBtn.classList.toggle('on', frameOn);
  const f = Math.round(S.t * S.board.fps);
  tcEl.textContent = `${tc(S.t, S.board.fps)} · f${f}`;
  text.placeholder = !hit
    ? 'Add a note about the whole board…'
    : frameOn
      ? `Add a note about this frame of “${hit.scene.title}”…`
      : `Add a note about “${hit.scene.title}”…`;
  sendBtn.disabled = !text.value.trim() && !pendingFiles('bar').length;
  const unsent = unsentNotes().length;
  sendAllBtn.hidden = !unsent;
  if (unsent) sendAllBtn.replaceChildren(h('span', { html: icons.spark, style: { display: 'inline-grid' } }), `Send ${unsent} to Claude`);
  sendAllBtn.title = `Hand your ${unsent} unsent note${unsent === 1 ? '' : 's'} to Claude (⌘⏎)`;
}

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

const unsentNotes = () => (S.board ? S.board.notes.filter(n => n.author === 'you' && !n.sent && !n.resolved) : []);

// Enter: add the note to the board. Claude doesn't get it until you send.
async function add() {
  const body = text.value.trim();
  if (!body && !pendingFiles('bar').length) {
    bar.classList.remove('shake');
    void bar.offsetWidth;
    bar.classList.add('shake');
    return text.focus();
  }
  const hit = target();
  const frameOn = S.noteFrame && !!hit;
  const note = { scene: hit ? hit.scene.id : null, text: body };
  if (frameOn) note.at = snapFrame(S.board, hit.local);
  const files = await takeFiles('bar');
  if (files.length) note.files = files;
  showFiles();
  const j = await commit([{ op: 'note.add', note }]);
  if (!j) return;
  text.value = '';
  fit();
  render();
  const n = j.ops[0].note;
  const what = !hit ? 'the whole board' : frameOn ? `frame ${tc(S.t, S.board.fps)} of “${hit.scene.title}”` : `“${hit.scene.title}”`;
  const count = unsentNotes().length;
  toast(`Note added · ${count} waiting to send`);
  S.sel = { scene: n.scene ?? S.sel.scene, note: n.id };
  emit('select');
}

// Send: hand every unsent note to Claude at once, then say honestly whether anyone received them.
export async function sendAll() {
  if (text.value.trim() || pendingFiles('bar').length) await add();
  const notes = unsentNotes();
  if (!notes.length) return toast('No unsent notes. Add notes first, then send them.');
  const j = await commit([{ op: 'notes.send', ids: notes.map(n => n.id) }]);
  if (!j) return;
  render();
  const owner = S.board.owner;
  const who = owner ? `“${owner}”` : 'the Claude session working on this board';
  if (S.presence.watching > 0) {
    toast(`Sent ${notes.length} note${notes.length > 1 ? 's' : ''} to Claude — ${owner || 'an agent'} is listening and has them now`);
    return;
  }
  // Nobody is listening: the notes are marked sent on the board, but no session will notice by itself.
  const url = `${location.origin}/#${S.slug}`;
  const root = document.querySelector('meta[name="sb-root"]')?.content;
  const listen = root && !root.startsWith('%') ? `${root}/sb -b ${S.slug} wait` : `curl -s "${location.origin}/agent/boards/${S.slug}/wait?on=send&timeout=86400"`;
  const msg = `I've sent you ${notes.length} note${notes.length > 1 ? 's' : ''} on the “${S.board.title}” storyboard (${url}).\n` +
    `Read them: curl -s ${location.origin}/agent/boards/${S.slug}/notes\n` +
    `Start on them now; don't re-render unless a note asks for it. Mark each one working when you start it, then reply in its thread and resolve it. Then keep listening for my next notes in the background: ${listen}`;
  const ta = h('textarea.field', { readOnly: true });
  ta.value = msg;
  const copy = h('button.text-btn.primary', { onclick: async () => { try { await navigator.clipboard.writeText(msg); copy.textContent = 'Copied'; } catch { ta.select(); document.execCommand('copy'); copy.textContent = 'Copied'; } } }, 'Copy message');
  // Anchor to the bar: the Send button itself has just been hidden.
  const r = bar.getBoundingClientRect();
  const pop = h('div.pop.send-pop',
    h('h3', `Sent — but no Claude session is listening to this board`),
    h('p', `${notes.length > 1 ? `The ${notes.length} notes are` : 'The note is'} marked as sent. ${owner ? `This board's owner is ${who}.` : 'No owner is recorded for this board yet.'} Paste this into that Claude session so it picks them up (and keeps listening from then on):`),
    ta,
    h('div.row', h('button.text-btn', { onclick: () => closeMenu() }, 'Close'), copy),
  );
  menu(Math.max(8, r.right - 428), r.top - 8, [], { el: pop });
  const pr = pop.getBoundingClientRect();
  pop.style.top = Math.max(8, r.top - pr.height - 10) + 'px';
}

// ---------------------------------------------------------------- wiring

text.addEventListener('focus', () => { bar.classList.add('focus'); if (S.playing) pause(); });
text.addEventListener('blur', () => bar.classList.remove('focus'));
text.addEventListener('input', () => { fit(); sendBtn.disabled = !text.value.trim(); });
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
  sendBtn.disabled = !text.value.trim() && !pendingFiles('bar').length;
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
    { label: 'Whole board', icon: 'note', cls: !cur ? 'cur' : '', onclick: () => { S.noteTarget = 'board'; render(); text.focus(); } },
    '-',
    ...rows.map(({ scene: s, index, start }) => ({
      label: `${String(index + 1).padStart(2, '0')}  ${s.title}`,
      dot: sceneColor(s),
      meta: tc(start, S.board.fps),
      cls: cur?.scene.id === s.id ? 'cur' : '',
      onclick: () => { S.noteTarget = 'here'; select(s.id); render(); text.focus(); },
    })),
  ], { cls: 'scene-menu' });
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
