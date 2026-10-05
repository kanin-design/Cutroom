// Client state and sync. The server is the only writer: the page sends ops, and applies the
// batches the server hands back (on the POST response and over SSE) strictly in rev order.
// Local round trips are a few milliseconds, so there is no optimistic state to reconcile.

import { applyOps, locate, totalDuration, findScene, sceneColors, COLORS } from '/lib/ops.js';
import { toast } from './util.js';

export const S = {
  slug: null,
  board: null,
  sel: { scene: null, note: null },
  t: 0,
  playing: false,
  rate: 1, // playback speed: J/K/L shuttle runs it at 2, 4, 8, or backwards
  loop: false,
  muted: false,
  view: 'edit',
  tab: 'scene',
  pps: 60,
  snap: true,
  ruler: 'bars',
  presence: { watching: 0, say: null, lastAgentAt: 0 },
  activity: [],
  glow: new Map(),
  undo: [],
  redo: [],
};

// ---------------------------------------------------------------- events

const bus = new Map();
export const on = (evt, fn) => { if (!bus.has(evt)) bus.set(evt, new Set()); bus.get(evt).add(fn); };
export const emit = (evt, data) => { for (const fn of bus.get(evt) || []) fn(data); };

export const scene = id => (S.board ? findScene(S.board, id) : null);
export const here = () => (S.board ? locate(S.board, S.t) : null);
export const total = () => (S.board ? totalDuration(S.board) : 0);
// The agent's status line while it's fresh (the editor stops showing it after 30 minutes).
export const activeSay = () => {
  const s = S.presence.say;
  return s && Date.now() - s.at < 30 * 60_000 ? s : null;
};
// A scene's colour (its own, or the one the editor gives it), worked out once per change.
let colors = { rev: -1, slug: null, map: new Map() };
export function sceneColor(s) {
  const b = S.board;
  if (b && (colors.rev !== b.rev || colors.slug !== S.slug)) colors = { rev: b.rev, slug: S.slug, map: sceneColors(b) };
  return colors.map.get(s.id) || s.color || COLORS[0];
}
export const mediaUrl = rel => `/media/${encodeURIComponent(S.slug)}/${rel.replace(/^media\//, '')}`;

export function select(sceneId, { note = null, keepTime = false } = {}) {
  S.sel = { scene: sceneId, note };
  emit('select');
  if (sceneId && !keepTime && S.board) {
    const hit = here();
    if (!hit || hit.scene.id !== sceneId) {
      const { start } = layoutOf(sceneId);
      emit('seek', start);
    }
  }
}

function layoutOf(id) {
  let t = 0;
  for (const s of S.board.scenes) {
    if (s.id === id) return { start: t, end: t + s.duration };
    t += s.duration;
  }
  return { start: 0, end: 0 };
}
export const sceneRange = layoutOf;

// ---------------------------------------------------------------- sync

const clientId = Math.random().toString(36).slice(2, 10);
let es = null;
const pending = new Map();
let gapTimer = null;

export async function openBoard(slug) {
  es?.close();
  pending.clear();
  S.slug = slug;
  S.undo = [];
  S.redo = [];
  S.sel = { scene: null, note: null };
  S.t = 0;
  const r = await fetch(`/api/boards/${encodeURIComponent(slug)}`);
  if (!r.ok) throw new Error((await r.json()).error);
  S.board = (await r.json()).board;
  const log = await (await fetch(`/api/boards/${encodeURIComponent(slug)}/log?limit=120`)).json();
  S.activity = log.entries.reverse();
  try { localStorage.setItem('sb.board', slug); } catch {}
  connect();
  emit('open');
  emit('board', { reset: true });
}

function connect() {
  es = new EventSource(`/api/boards/${encodeURIComponent(S.slug)}/events?client=${clientId}`);
  es.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'batch') receive(msg);
    else if (msg.type === 'reset') {
      S.board = msg.board;
      pending.clear();
      if (msg.entry) S.activity.unshift(msg.entry);
      emit('board', { reset: true });
      emit('activity');
    } else if (msg.type === 'presence') {
      S.presence = msg;
      emit('presence');
    } else if (msg.type === 'focus') emit('agent-focus', msg);
    else if (msg.type === 'deleted') { es.close(); emit('board-deleted', msg.slug); }
    else if (msg.type === 'hello' || msg.type === 'build') {
      if (msg.build) emit('build', msg.build);
      if (msg.type === 'hello' && S.board && msg.rev !== S.board.rev) refetch();
    }
  };
}

async function refetch() {
  const r = await fetch(`/api/boards/${encodeURIComponent(S.slug)}`);
  if (!r.ok) return;
  S.board = (await r.json()).board;
  pending.clear();
  emit('board', { reset: true });
}

function receive(batch) {
  if (!S.board || batch.rev <= S.board.rev) return;
  pending.set(batch.rev, batch);
  const done = [];
  while (pending.has(S.board.rev + 1)) {
    const b = pending.get(S.board.rev + 1);
    pending.delete(b.rev);
    try {
      S.board = applyOps(S.board, b.ops, { author: b.author, now: b.created }).board;
    } catch (e) {
      console.warn('replay failed, refetching', e);
      return refetch();
    }
    done.push(b);
  }
  clearTimeout(gapTimer);
  if (pending.size) gapTimer = setTimeout(refetch, 700);
  if (!done.length) return;
  for (const b of done) {
    S.activity.unshift({ rev: b.rev, author: b.author, created: b.created, summaries: b.summaries });
    if (b.author !== 'you') for (const id of touched(b.ops)) S.glow.set(id, performance.now());
  }
  S.activity.length = Math.min(S.activity.length, 300);
  if (S.sel.scene && !scene(S.sel.scene)) S.sel.scene = null;
  if (S.sel.note && !S.board.notes.some(n => n.id === S.sel.note)) S.sel.note = null;
  emit('board', { batches: done });
  emit('activity');
}

function touched(ops) {
  const ids = new Set();
  for (const op of ops) {
    if (op.op.startsWith('scene.')) ids.add(op.id || op.scene?.id);
    if (op.op.startsWith('render.')) ids.add(op.scene);
    if (op.op === 'note.add') ids.add(op.note.scene);
  }
  ids.delete(undefined);
  ids.delete(null);
  return ids;
}

// Work an editor reload would lose: writes on their way to the server, and whatever the panels hold
// (a frame being marked up, words typed but not added). A reload for a new editor waits for none.
let writing = 0;
const holds = new Set();
export const hold = holding => holds.add(holding);
export const holding = () => writing > 0 || [...holds].some(f => f());
async function write(request) {
  writing++;
  try { return await request(); } finally { writing--; }
}

// Send ops. `key` merges consecutive edits of one field into a single undo step.
export async function commit(ops, { key = null, undoable = true, quiet = false } = {}) {
  let j;
  try {
    j = await write(async () => {
      const r = await fetch(`/api/boards/${encodeURIComponent(S.slug)}/ops`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops, author: 'you', client: clientId }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || r.statusText);
      return body;
    });
  } catch (e) {
    if (!quiet) toast(e.message, { err: true });
    emit('board', { failed: true });
    return null;
  }
  receive(j);
  if (undoable) {
    const top = S.undo.at(-1);
    if (!(key && top?.key === key)) S.undo.push({ ops: j.inverse, key });
    if (S.undo.length > 200) S.undo.shift();
    S.redo.length = 0;
  }
  return j;
}

export async function undo() {
  const e = S.undo.pop();
  if (!e) return toast('Nothing to undo');
  if (!e.ops.length) return undo();
  const j = await commit(e.ops, { undoable: false, quiet: true });
  if (j) S.redo.push({ ops: j.inverse });
  else toast('Can’t undo that — it has changed since', { err: true });
}

export async function redo() {
  const e = S.redo.pop();
  if (!e) return toast('Nothing to redo');
  const j = await commit(e.ops, { undoable: false, quiet: true });
  if (j) S.undo.push({ ops: j.inverse });
  else toast('Can’t redo that — it has changed since', { err: true });
}

// A file dropped somewhere: `target` is {scene} to add a version, {before|after} for a new scene, or {audio}.
export async function upload(file, target = {}) {
  const q = new URLSearchParams({ name: file.name });
  if (target.scene) q.set('scene', target.scene);
  if (target.before) q.set('before', target.before);
  if (target.after) q.set('after', target.after);
  if (target.audio) q.set('as', 'audio');
  const t = toast(`Preparing ${file.name}…`, { spin: true });
  try {
    const j = await write(async () => {
      const r = await fetch(`/api/boards/${encodeURIComponent(S.slug)}/ingest?${q}`, { method: 'POST', headers: { 'x-storyboard': '1' }, body: file });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      return body;
    });
    receive(j);
    S.undo.push({ ops: j.inverse });
    S.redo.length = 0;
    t.done();
    toast(j.summaries[0].replace(/^./, c => c.toUpperCase()));
    return j;
  } catch (e) {
    t.done();
    toast(e.message, { err: true, ms: 5000 });
  }
}
