// The message bar under the monitor: the way the user talks to the agent about the film. It always
// says what a message is about: the scene under the playhead (or another one, or the whole board),
// and, with Frame on, the exact frame. A spot marked on the monitor (P) opens a small card right
// there instead, for a note about that point of that frame.

import { S, on, emit, here, commit, select, scene } from './store.js';
import { layout, snapFrame } from '/lib/ops.js';
import { $, h, tc, menu, closeMenu, toast, clamp } from './util.js';
import { icons } from './icons.js';
import { pause } from './player.js';
import { sceneColor, setPinning } from './viewer.js';
import { wire, chips, takeFiles, pendingFiles } from './attach.js';

const bar = $('#composerBar'), sceneBtn = $('#cbScene'), frameBtn = $('#cbFrame'), tcEl = $('#cbTc');
const text = $('#cbText'), spotBtn = $('#cbSpot'), sendBtn = $('#cbSend'), sendAllBtn = $('#cbSendAll'), filesEl = $('#cbFiles');

// target: 'here' (the scene under the playhead) or 'board'
S.noteTarget = 'here';
S.draftPin = null;
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
  spotBtn.classList.toggle('on', S.pinning || !!S.draftPin);
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
  if (!v) setPinning(false);
  render();
}

export function focusComposer() {
  if (S.playing) pause();
  text.focus();
}

// ---------------------------------------------------------------- a note on the frame itself
// A spot marked on the monitor opens a card beside it. The note is about the frame on screen when
// the spot was marked, at that point; the card says which, and stays with it.
const frameEl = $('#frame');
let card = null;

function closeCard() {
  takeFiles('card');
  card?.el.remove();
  card = null;
  S.draftPin = null;
  emit('draft-pin');
  render();
}

on('spot', p => {
  const hit = S.board?.scenes.length ? here() : null;
  if (!hit) return;
  closeCard();
  const b = S.board;
  const at = snapFrame(b, hit.local);
  const t = hit.start + at;
  S.draftPin = p;
  emit('draft-pin');
  const ta = h('textarea', { rows: 2, placeholder: 'What about this spot?', spellcheck: true });
  // Text already typed in the bar comes along.
  if (text.value.trim()) { ta.value = text.value; text.value = ''; fit(); }
  const addBtn = h('button.fn-add', { onclick: () => addFromCard(false) }, 'Add', h('span.k', '⏎'));
  const clipBtn = h('button.fn-clip', { title: 'Attach a file (or drop or paste one)', html: icons.clip });
  const cardFiles = h('div.fn-files');
  const el = h('div.fnote', { onpointerdown: e => e.stopPropagation(), onclick: e => e.stopPropagation(), ondblclick: e => e.stopPropagation() },
    h('div.fn-head', h('span', { html: icons.pin, style: { display: 'inline-grid' } }), h('b', `Frame ${tc(t, b.fps)}`), h('span.mono', `f${Math.round(t * b.fps)}`), h('span.fn-scene', `${String(hit.index + 1).padStart(2, '0')} ${hit.scene.title}`),
      h('button.fn-close', { title: 'Cancel (Esc)', html: icons.x, onclick: closeCard })),
    ta,
    cardFiles,
    h('div.fn-foot', clipBtn, h('span.fn-hint', '⌘⏎ adds it and sends your notes'), addBtn),
  );
  const sync = () => {
    addBtn.disabled = !ta.value.trim() && !pendingFiles('card').length;
    cardFiles.replaceChildren(...[chips('card', sync)].filter(Boolean));
    place();
  };
  wire('card', { button: clipBtn, zone: el, field: ta, onchange: sync });
  ta.addEventListener('input', () => { sync(); ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; });
  ta.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addFromCard(true); }
    else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); addFromCard(false); }
    else if (e.key === 'Escape') { e.preventDefault(); closeCard(); }
  });
  frameEl.append(el);
  card = { el, ta, scene: hit.scene.id, at, pin: p, sync };
  sync();
  place();
  if (S.playing) pause();
  ta.focus();
});

// Beside the spot, flipped to stay inside the frame.
function place() {
  if (!card) return;
  const W = frameEl.clientWidth, H = frameEl.clientHeight;
  const w = Math.min(340, W - 20);
  card.el.style.width = w + 'px';
  const px = card.pin.x * W, py = card.pin.y * H;
  const left = px + 22 + w <= W - 10 ? px + 22 : Math.max(10, px - 22 - w);
  const ch = card.el.offsetHeight;
  card.el.style.left = left + 'px';
  card.el.style.top = clamp(py - 28, 10, Math.max(10, H - ch - 10)) + 'px';
}
new ResizeObserver(place).observe(frameEl);

async function addFromCard(send) {
  if (!card) return;
  const body = card.ta.value.trim();
  if (body || pendingFiles('card').length) {
    const files = await takeFiles('card');
    const j = await commit([{ op: 'note.add', note: { scene: card.scene, at: card.at, pin: card.pin, text: body, ...(files.length ? { files } : {}) } }]);
    if (!j) return;
    S.sel = { scene: card.scene, note: j.ops[0].note.id };
    emit('select');
  } else if (!send) return card.ta.focus();
  closeCard();
  if (send) return sendAll();
  toast(`Note added · ${unsentNotes().length} waiting to send`);
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
  if (e.key === 'Escape') { e.preventDefault(); setPinning(false); text.blur(); }
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
spotBtn.addEventListener('click', () => {
  if (card) return closeCard();
  if (S.playing) pause();
  setPinning(!S.pinning);
});

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
on('pinning', render);
on('presence', render);
on('open', () => { S.noteTarget = 'here'; closeCard(); text.value = ''; fit(); render(); });
on('board', () => card?.sync());
render();
