// Claude's session on a board: whether it's there (listening, busy, gone, or never there), finding its
// window (a ping), and handing the board to a session. The server writes the hand-off message for a
// Claude Code session: take over a new board, pick one up again, or start on notes the user just sent.
// The user pastes it into a session, and the moment an agent is listening the card says so and goes.

import { S, on, activeSay } from './store.js';
import { h, modal, ago, toast } from './util.js';
import { icons } from './icons.js';

let card = null; // the open card: { el, update, close }
let pending = null; // a board to hand over as soon as it opens

// `sent` names notes just sent while nobody was listening ("2 notes", "a render request").
export async function handOff({ sent = null } = {}) {
  if (!S.board) return;
  const r = await fetch(`/api/boards/${encodeURIComponent(S.slug)}/handoff${sent ? `?sent=${encodeURIComponent(sent)}` : ''}`);
  const { text } = await r.json();
  card?.close();
  const b = S.board, owner = b.owner;
  const many = +(/^\d+/.exec(sent || '')?.[0] ?? 1) > 1;
  const message = h('textarea.field.handoff-text', { readOnly: true, rows: 4 });
  message.value = text;
  const copy = h('button.text-btn.primary', {
    onclick: async () => {
      try { await navigator.clipboard.writeText(text); } catch { message.select(); document.execCommand('copy'); }
      copy.textContent = 'Copied';
    },
  }, 'Copy message');
  const status = h('div.handoff-status');
  const el = h('div.handoff',
    h('h2', sent ? 'Sent, but no Claude session is listening' : owner ? `Get Claude back on “${b.title}”` : `Hand “${b.title}” to Claude`),
    h('p', sent
      ? `${sent[0].toUpperCase() + sent.slice(1)} ${many ? 'are' : 'is'} marked as sent. Paste this into ${owner ? `${owner}’s session` : 'a Claude Code session'} so it picks ${many ? 'them' : 'it'} up and keeps listening:`
      : `Paste this into a Claude Code session: a new one, or one you have open. ${owner ? 'It picks the board up where it left off' : 'It owns the board from then on, fills it in and lays the idea out'}, and listens for your notes.`),
    message, status,
    h('div.row', h('button.text-btn', { onclick: () => close() }, 'Close'), copy));
  const close = modal([el]);
  message.style.height = `${Math.min(360, message.scrollHeight + 2)}px`; // the whole message, without scrolling
  const wasListening = S.presence.watching > 0;
  card = {
    el,
    close,
    update() {
      const on = S.presence.watching > 0;
      status.replaceChildren(on
        ? h('span.ok', h('span', { html: icons.check }), `${S.board.owner || 'Claude'} is listening.`)
        : h('span.wait', h('span.spin'), 'Waiting for a Claude session to start listening…'));
      if (on && !wasListening) setTimeout(() => el.isConnected && close(), 1800);
    },
  };
  card.update();
}

// Whether Claude has this board, from the server's presence `p`: listening for notes (a green light that
// pings), working on notes it was given (orange: what you send now reaches it when it's done), not
// listening (red), or no session yet (grey). `word` names the state; `tip` says what it means for you.
export function claudeState(owner, p = S.presence) {
  if (p.watching > 0 || (p.answeringUntil || 0) > Date.now()) return { key: 'listening', light: 'is-on is-live', word: 'Listening', tip: 'Notes you send reach it the moment you send them.' };
  if ((p.busyUntil || 0) > Date.now()) return { key: 'busy', light: 'is-work', word: 'Working', tip: 'On the notes it was given. What you send now reaches it the moment it’s done.' };
  if (owner) return { key: 'away', light: 'is-off', word: 'Not listening', tip: 'Notes you send wait until it listens again.' };
  return { key: 'none', light: 'is-none', word: 'No session yet', tip: 'No Claude Code session has this board yet.' };
}
export const reachable = (owner, p = S.presence) => ['listening', 'busy'].includes(claudeState(owner, p).key);

// What to do about Claude, wherever it's offered: ping a session that's there (to find its window), get
// one back, or hand the board over. `again` after a ping.
export const claudeAct = () => (reachable(S.board?.owner) ? ping() : handOff());
export const claudeButton = (owner, { again = false } = {}) => (reachable(owner)
  ? h('button.text-btn', { onclick: () => ping() }, again ? 'Ping again' : 'Ping')
  : h('button.text-btn', { onclick: () => handOff() }, owner ? 'Get it back…' : 'Hand to Claude…'));

// Find the session's window among several: it says which board it's on, in that window. A session
// waiting for notes hears it at once; a busy one when it's done.
export async function ping() {
  const r = await fetch(`/api/boards/${encodeURIComponent(S.slug)}/ping`, { method: 'POST' });
  if (!r.ok) return toast('The ping didn’t go through', { err: true });
  const { heardNow } = await r.json();
  toast(heardNow ? 'Pinged: look for its line in your Claude Code windows' : 'Pinged: it answers in its window the moment it’s done');
}

// The card on Claude's light: the state, which session it is, what it's doing, and the one thing to do
// about it: ping it, get it back, or hand the board over.
export function presenceCard() {
  const b = S.board;
  if (!b) return null;
  const p = S.presence, st = claudeState(b.owner, p), say = activeSay();
  const pinged = p.ping && Date.now() - p.ping.at < 10 * 60_000 ? p.ping : null;
  const near = st.key === 'listening' || st.key === 'busy';
  return [
    h('div.tip-head', h('i.light', { class: st.light }), st.word),
    b.owner && h('div.tip-who', b.owner),
    h('div.tip-text', st.tip),
    say && h('div.tip-say', say.text),
    st.key === 'busy' && p.lastAgentAt > 0 && h('div.tip-sub', `Last heard from ${ago(new Date(p.lastAgentAt).toISOString())}`),
    pinged && near && h('div.tip-ping', pinged.heard ? 'It heard your ping: look for its line in your Claude Code windows.' : 'Pinged: it answers in its window the moment it’s done.'),
    h('div.tip-actions', near && h('span.tip-hint', 'Ping it to find its window'), claudeButton(b.owner, { again: !!pinged })),
  ];
}

// After making a board: hand it over once the editor has opened it.
export const handOffWhenOpen = slug => { pending = slug; };

on('presence', () => card?.el.isConnected && card.update());
on('open', () => { if (pending && pending === S.slug) { pending = null; handOff(); } });
