// The sound view: the soundtrack's layers (`sb sound`), a row per layer under the waveform, every sound a block
// at its time. Click a sound to hear just it, shift-click (or ⌘-click) to pick more; the message bar then writes a
// note about the picked sounds, which carries exactly which ones (id, layer, time, pitch, what it's for) so the
// agent can find them in the score. M and S mute or solo a layer while the film plays: the layers' stems play in
// place of the mix, kept in step with it.
//
// Two events: 'sound' when the rows change (a new set, shown or hidden: the timeline lays out again) and
// 'sound-paint' when only what they show changes (picks, mute and solo, a layer's waveform arriving: a redraw).

import { S, on, emit, mediaUrl, commit } from './store.js';
import { h, toast, menu } from './util.js';

export const MIX_H = 46;  // the mix's waveform, above the layers
export const LH = 15;     // a layer's row, automatic: at most this (rows shrink to fit the timeline)
export const ROW_COMFY = 12; // the row height the timeline grows to make room for
export let rowH = LH;
export const setRowH = v => { rowH = v; };
const PALETTE = ['#e8a33d', '#5fb3e6', '#8fd17a', '#d8749a', '#a98be6', '#e6d25f', '#5fd1c3', '#e67e5f', '#9aa3b5', '#c7e65f'];
const SHORT = 0.25;       // how long a sound with no `dur` is drawn and heard
const LEAD = 0.05;        // the stems start this far ahead, to be scheduled in time
const DRIFT = 0.08;       // stems further than this from the film's clock start again

S.soundSel = [];          // the picked sounds
S.soundMute = new Set();  // layer ids
S.soundSolo = new Set();
S.stemsOn = false;        // the stems are playing in place of the mix

let shown = true;
try { shown = localStorage.getItem('sb.soundOpen') !== '0'; } catch {}
let byLayer = new Map(), byId = new Map(), eventsFor = null;
const peaks = new Map();

export const soundOpen = () => !!S.board?.sound && !!S.board.audio && shown;
export const layerRows = () => (soundOpen() ? S.board.sound.layers.length : 0);
export const layerColor = (l, i) => l.color || PALETTE[i % PALETTE.length];
const layers = () => S.board?.sound?.layers || [];
const layerOf = id => layers().find(l => l.id === id);
export const colorOfLayer = id => { const i = layers().findIndex(l => l.id === id); return i < 0 ? 'var(--faint)' : layerColor(layers()[i], i); };
export const audible = id => (S.soundSolo.size ? S.soundSolo.has(id) : !S.soundMute.has(id));
const endOf = e => e.t + (e.dur ?? SHORT);

// ---------------------------------------------------------------- pitch: a sound's notes, as MIDI numbers
const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function midiOf(n) {
  if (typeof n === 'number') return Number.isFinite(n) ? Math.round(n) : null;
  const s = String(n ?? '').trim();
  if (/^\d+$/.test(s)) return +s;
  const m = /^([A-Ga-g])([#b♯♭]?)(-?\d+)$/.exec(s);
  return m ? 12 * (+m[3] + 1) + STEP[m[1].toUpperCase()] + ({ '#': 1, '♯': 1, b: -1, '♭': -1 }[m[2]] || 0) : null;
}
export const noteName = m => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
// Its notes: `notes` (a chord), else `note`, else a chord written in its label ("stab (A4 C5 E5)"). Unpitched: [].
export function pitchesOf(e) {
  if (Array.isArray(e.notes) && e.notes.length) return e.notes.map(midiOf).filter(x => x != null);
  const one = e.note != null ? midiOf(e.note) : null;
  if (one != null) return [one];
  const chord = /\(([A-G][#b]?-?\d(?:[\s,]+[A-G][#b]?-?\d)+)\)/.exec(e.label || '');
  return chord ? chord[1].split(/[\s,]+/).map(midiOf).filter(x => x != null) : [];
}
const range = new Map(); // layer id → [lowest, highest] note it plays (only layers with two or more pitches)
// A sound as it is in the score now (null when the set isn't loaded, or the sound is gone from it).
export const soundById = id => byId.get(id) ?? null;
export const soundsLoaded = () => !!eventsFor && eventsFor === S.board?.sound?.events;
// A sound in a few words, for the message bar: its layer, its pitch and when ("kick · 9.10 s", "plings A5 · 25.75 s").
export const soundShort = e => `${e.layer}${e.note ? ` ${e.note}` : ''} · ${(+e.t).toFixed(2)} s`;

export function setSoundOpen(v) {
  shown = v;
  try { localStorage.setItem('sb.soundOpen', v ? '1' : '0'); } catch {}
  emit('sound');
  syncStems(); // hidden: the mix again; shown: the layers' mute and solo again
}

// The sounds the selected note is about: drawn with a dashed outline, so a note shows what it points at.
function noteSounds() {
  const n = S.sel.note && S.board?.notes.find(x => x.id === S.sel.note);
  return new Set(n?.sounds?.map(x => x.id) || []);
}

async function load() {
  const x = S.board?.sound;
  if (!x) {
    if (eventsFor) { eventsFor = null; byLayer = new Map(); byId = new Map(); peaks.clear(); buffers.clear(); setPicks([]); stopStems(); }
    return;
  }
  if (eventsFor === x.events) return;
  eventsFor = x.events;
  peaks.clear();
  buffers.clear();
  stopStems();
  S.soundMute.clear();
  S.soundSolo.clear();
  setPicks([], { quiet: true }); // the picks were sounds of the earlier set
  let events = [];
  try { events = await (await fetch(mediaUrl(x.events))).json(); } catch {}
  if (eventsFor !== x.events) return;
  byLayer = new Map(x.layers.map(l => [l.id, []]));
  byId = new Map(events.map(e => [e.id, e]));
  for (const e of events) byLayer.get(e.layer)?.push(e);
  for (const list of byLayer.values()) list.sort((p, q) => p.t - q.t); // drawing and picking stop at the first sound past the view
  range.clear();
  for (const [id, list] of byLayer) {
    const all = list.flatMap(pitchesOf);
    if (new Set(all).size > 1) range.set(id, [Math.min(...all), Math.max(...all)]);
  }
  emit('sound');
  for (const l of x.layers) {
    fetch(mediaUrl(l.peaks)).then(r => r.json()).then(p => { if (eventsFor === x.events) { peaks.set(l.id, p); emit('sound-paint'); } }).catch(() => {});
  }
}
on('board', load);
on('open', () => { eventsFor = null; load(); });

// ---------------------------------------------------------------- drawing (into the timeline's canvas)

// top: the first layer row's y; X(t): x on the canvas; [t0, t1]: the time in view; H: the canvas's height.
export function drawLayers(ctx, { top, W, H, X, t0, t1, tOf }) {
  if (!soundOpen()) return;
  const picked = new Set(S.soundSel.map(e => e.id)), ofNote = noteSounds(), gone = markedForRemoval();
  const inset0 = rowH >= 12 ? 3 : rowH >= 8 ? 2 : 1;
  layers().forEach((l, i) => {
    const y = Math.round(top + i * rowH), col = layerColor(l, i), heard = audible(l.id);
    // a layer that plays notes uses the row's full height, for the marks of its notes
    const inset = range.has(l.id) ? 1 : inset0, bh = Math.max(2, Math.round(rowH) - 1 - 2 * inset);
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.04)';
    ctx.fillRect(0, y, W, Math.round(rowH) - 1);
    // the layer's own waveform, faint and inside the blocks' height: where it sounds, even where the score listed no sound
    const p = peaks.get(l.id);
    if (p) {
      ctx.globalAlpha = heard ? 0.28 : 0.1;
      ctx.fillStyle = col;
      const mid = y + (Math.round(rowH) - 1) / 2, amp = rowH * 0.3;
      for (let x = Math.max(0, Math.floor(X(0))); x < W; x++) {
        const a = Math.floor(tOf(x) * p.rate), z = Math.max(a + 1, Math.floor(tOf(x + 1) * p.rate));
        if (a >= p.peak.length) break;
        let m = 0;
        for (let k = a; k < z && k < p.peak.length; k++) if (p.peak[k] > m) m = p.peak[k];
        const hh = (m / 255) * amp;
        if (hh > 0.3) ctx.fillRect(x, mid - hh, 1, hh * 2);
      }
    }
    // its sounds, whole pixels with a pixel's gap, so sounds that touch still read as two
    const box = e => { const xa = Math.round(X(e.t)); return [xa, Math.max(2, Math.round(X(endOf(e))) - xa - 1)]; };
    ctx.fillStyle = col;
    for (const e of byLayer.get(l.id) || []) {
      if (e.t > t1) break;
      if (endOf(e) < t0) continue;
      const [xa, w] = box(e);
      ctx.globalAlpha = picked.has(e.id) ? 1 : heard ? 0.78 : 0.25;
      ctx.fillRect(xa, y + inset, w, bh);
    }
    // its notes, where the layer plays more than one: a mark at each note's height in the block (high at the top),
    // so a melody shows its shape and a chord its notes
    const span = range.get(l.id);
    if (span && bh >= 5) {
      const [lo, hi] = span, yOf = m => y + inset + 1 + (1 - (m - lo) / Math.max(1, hi - lo)) * (bh - 3);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      for (const e of byLayer.get(l.id) || []) {
        if (e.t > t1) break;
        if (endOf(e) < t0) continue;
        const [xa, w] = box(e);
        ctx.globalAlpha = heard ? 1 : 0.4;
        for (const m of pitchesOf(e)) ctx.fillRect(xa, Math.round(yOf(m)), Math.max(2, w), 1.5);
      }
      ctx.fillStyle = col;
    }
    ctx.globalAlpha = 1;
    // picked: a dark keyline and a white line round the block; the selected note's sounds: dashed
    for (const e of byLayer.get(l.id) || []) {
      const mine = picked.has(e.id), note = ofNote.has(e.id);
      if (!mine && !note) continue;
      const [xa, w] = box(e);
      ctx.setLineDash(mine ? [] : [3, 2]);
      if (mine) { ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.lineWidth = 3.5; ctx.strokeRect(xa - 1, y + inset - 1, w + 2, bh + 2); }
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(xa - 1, y + inset - 1, w + 2, bh + 2);
    }
    ctx.setLineDash([]);
    // marked for removal: a red line through, and a red edge
    for (const e of byLayer.get(l.id) || []) {
      if (!gone.has(e.id) || e.t > t1 || endOf(e) < t0) continue;
      const [xa, w] = box(e);
      ctx.strokeStyle = '#ec5446'; ctx.lineWidth = 1.5;
      ctx.strokeRect(xa - 0.5, y + inset - 0.5, w + 1, bh + 1);
      ctx.beginPath(); ctx.moveTo(xa, y + inset + bh); ctx.lineTo(xa + w, y + inset); ctx.stroke();
    }
  });
  // what you can do, under the rows when there's room
  const below = Math.round(top + layers().length * rowH) + 14;
  if (below < H - 4) {
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    ctx.font = '10.5px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillText(S.soundSel.length
      ? `${S.soundSel.length === 1 ? '1 sound' : `${S.soundSel.length} sounds`} picked · write the note under the picture · ⌥← ⌥→ the next one · Esc lets go`
      : 'Click a sound to hear it · ⇧-click to pick more · double-click a layer to hear only it · Esc clears mute and solo', 10, below);
  }
}

// ---------------------------------------------------------------- picking and hearing

// The sound in layer row `row` at time t: one sounding then (the latest to start, when they overlap), or else
// the nearest within `tol` seconds (a pixel or two, at any zoom).
export function soundAt(t, row, tol = 0) {
  const l = layers()[row];
  if (!l) return null;
  let best = null, gap = Infinity;
  for (const e of byLayer.get(l.id) || []) {
    if (e.t - tol > t) break;
    const d = t < e.t ? e.t - t : Math.max(0, t - endOf(e));
    if (d <= tol && d <= gap) { best = e; gap = d; }
  }
  return best;
}

// The one place the picks change: the message bar follows them ("these sounds" while there are any).
function setPicks(list, { quiet = false } = {}) {
  S.soundSel = [...list].sort((p, q) => p.t - q.t);
  if (S.soundSel.length) S.noteTarget = 'sounds';
  else if (S.noteTarget === 'sounds') S.noteTarget = 'soundtrack';
  if (!quiet) emit('sound-paint');
}

let lastPick = null;
export function pickSound(e, add = false) {
  if (!e) { if (!add) clearSounds(); return; }
  const had = S.soundSel.some(x => x.id === e.id);
  setPicks(add ? (had ? S.soundSel.filter(x => x.id !== e.id) : [...S.soundSel, e]) : [e]);
  if (add && had) return;
  lastPick = e;
  // stopped: the playhead goes to it, so the picture shows what plays with it
  if (!S.playing && !add) emit('seek', e.t);
  audition(e);
}

export function clearSounds() {
  if (!S.soundSel.length) return false;
  setPicks([]);
  return true;
}

// ⌥← ⌥→: the sound before or after the last one picked, in its layer, picked and heard in its place.
export function stepPick(dir) {
  const e = lastPick && soundById(lastPick.id);
  if (!e) return false;
  const list = byLayer.get(e.layer) || [];
  const next = list[list.indexOf(e) + dir];
  if (next) pickSound(next);
  return true;
}

// What you're hearing, for a note written now: the layers muted or soloed, and the ones that play (null: the whole mix).
export const listening = () => !soundOpen() || (!S.soundMute.size && !S.soundSolo.size) ? null : {
  mute: [...S.soundMute], solo: [...S.soundSolo], heard: layers().filter(l => audible(l.id)).map(l => l.id),
};

// The picked sounds as a note carries them.
const asNoteSound = ({ id, layer, t, dur, note, label }) => ({ id, layer, t, dur: dur ?? null, note: note ?? null, label: label || '', set: S.board.sound.events });
export const pickedForNote = () => S.soundSel.map(asNoteSound);

// ---------------------------------------------------------------- right-click a sound: hear it, a note, removal
// "Mark for removal" writes the note for you ("Remove this sound."): it goes to Claude with your other notes when
// you send them, and the sounds it names are struck through in red until it's done.
const REMOVE = ['Remove this sound.', 'Remove these sounds.'];
const removalNotes = () => (S.board?.notes || []).filter(n => !n.resolved && n.sounds?.length && REMOVE.includes(n.text));
export const markedForRemoval = () => new Set(removalNotes().flatMap(n => n.sounds.map(x => x.id)));

export function soundMenu(ev, e) {
  ev.preventDefault();
  // a picked sound among several picked: the menu is for all of them
  const group = S.soundSel.length > 1 && S.soundSel.some(x => x.id === e.id) ? S.soundSel : [e];
  const many = group.length > 1, marked = markedForRemoval().has(e.id);
  menu(ev.clientX, ev.clientY, [
    { head: many ? `${group.length} picked sounds` : `${soundShort(e)}${e.label ? ` · ${e.label}` : ''}` },
    { label: 'Hear it', icon: 'sound', onclick: () => audition(e) },
    { label: many ? 'Write a note about them…' : 'Write a note about it…', icon: 'note', onclick: () => { setPicks(group); lastPick = e; emit('focus-composer'); } },
    '-',
    marked
      ? { label: 'Unmark for removal', icon: 'undo', onclick: () => unmarkRemoval(e) }
      : { label: many ? `Mark ${group.length} for removal` : 'Mark for removal', icon: 'trash', danger: true, onclick: () => markRemoval(group) },
  ]);
}

async function markRemoval(group) {
  const sounds = group.map(asNoteSound);
  const j = await commit([{ op: 'note.add', note: { soundtrack: true, sounds, text: REMOVE[sounds.length > 1 ? 1 : 0] } }]);
  if (!j) return;
  toast(`Marked for removal: Claude gets it with your other notes when you send them`);
  emit('sound-paint');
}

async function unmarkRemoval(e) {
  const n = removalNotes().find(x => x.sounds.some(y => y.id === e.id));
  if (!n) return;
  if (n.sent) return toast('That one is sent already: reply in its note to take it back');
  const rest = n.sounds.filter(y => y.id !== e.id);
  await commit(rest.length
    ? [{ op: 'note.remove', id: n.id }, { op: 'note.add', note: { soundtrack: true, sounds: rest, text: REMOVE[rest.length > 1 ? 1 : 0] } }]
    : [{ op: 'note.remove', id: n.id }]);
  emit('sound-paint');
}
export const soundName = e => [e.id, layerOf(e.layer)?.label || e.layer, e.note, e.label].filter(Boolean).join(' · ');

let ac = null, master = null;
const buffers = new Map();
function audioCtx() {
  if (!ac) {
    ac = new AudioContext();
    master = ac.createGain();
    master.connect(ac.destination);
  }
  if (ac.state === 'suspended') ac.resume();
  master.gain.value = S.muted ? 0 : 1;
  return ac;
}
on('mute', () => { if (master) master.gain.value = S.muted ? 0 : 1; });

// A layer's stem, decoded once (the first time it's heard, or when a layer is muted or soloed).
function buffer(l) {
  if (!buffers.has(l.file)) {
    const p = fetch(mediaUrl(l.file)).then(r => r.arrayBuffer()).then(b => audioCtx().decodeAudioData(b));
    p.catch(() => buffers.delete(l.file));
    buffers.set(l.file, p);
  }
  return buffers.get(l.file);
}

// Already heard: the film is playing and this sound's layer is in what plays (the mix, or a layer not muted).
const inPlay = layer => S.playing && audible(layer);

let audition0 = null, auditionSeq = 0;
// `from`: an earlier version of the score (its events file): the sound as it was, from that version's stem
export async function audition(e, { from = null } = {}) {
  const now = layerOf(e.layer);
  const l = from && from !== S.board?.sound?.events ? { file: `${from.replace(/\/[^/]+$/, '')}/${e.layer}.flac`, label: `${e.layer} (before)` } : now;
  if (!l || (!from && inPlay(e.layer))) return; // it would be heard twice
  const my = ++auditionSeq; // the last sound clicked is the one heard, whichever layer loads first
  let buf;
  try { buf = await buffer(l); } catch { return toast(`Couldn't load the ${l.label} layer`, { err: true }); }
  if (my !== auditionSeq || (!from && inPlay(e.layer))) return; // another sound was clicked since, or the film started
  const a = audioCtx();
  try { audition0?.stop(); } catch {}
  const len = Math.min(Math.max(e.dur ?? 0.5, 0.12), 12) + 0.02, at = a.currentTime + 0.01;
  const g = a.createGain();
  g.connect(master);
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(1, at + 0.004);
  g.gain.setValueAtTime(1, at + len - 0.03);
  g.gain.linearRampToValueAtTime(0, at + len);
  const src = a.createBufferSource();
  src.buffer = buf;
  src.connect(g);
  src.start(at, Math.max(0, e.t - 0.004), len);
  audition0 = src;
}

// ---------------------------------------------------------------- mute and solo: the stems in place of the mix

// Hear only this layer (double-click its row or its name). `toggle`: when it already is the only one, back to the
// mix (its name); without it, it stays the only one (its row: play it from somewhere else).
export function soloOnly(id, toggle = true) {
  const only = S.soundSolo.size === 1 && S.soundSolo.has(id);
  if (only && !toggle) return true;
  S.soundSolo = only ? new Set() : new Set([id]);
  emit('sound-paint');
  syncStems();
  toast(only ? 'The whole mix again' : `Only ${layerOf(id)?.label || id} — double-click its name (or Esc) for the whole mix`);
  return !only;
}

export function toggleLayer(id, kind) {
  const set = kind === 'solo' ? S.soundSolo : S.soundMute;
  set.has(id) ? set.delete(id) : set.add(id);
  emit('sound-paint');
  syncStems();
}

// Esc, with no sounds picked: the whole mix again.
export function clearLayerStates() {
  if (!S.soundMute.size && !S.soundSolo.size) return false;
  S.soundMute.clear();
  S.soundSolo.clear();
  emit('sound-paint');
  syncStems();
  toast('Mute and solo cleared: the whole mix');
  return true;
}

// Only while the layers are shown: hidden, a solo would go on with nothing on screen saying why (it comes back with them).
const wanted = () => (S.soundMute.size > 0 || S.soundSolo.size > 0) && S.playing && S.rate > 0 && S.rate <= 4 && soundOpen();
let running = null, starting = false, failedKey = null; // failedKey: the layers that wouldn't load, not tried again every frame

function setStems(v) {
  if (S.stemsOn === v) return;
  S.stemsOn = v;
  emit('stems'); // the player mutes or unmutes the mix
}

function stopStems() {
  if (running) for (const { src } of running.nodes.values()) { try { src.stop(); } catch {} }
  running = null;
  if (!starting) setStems(false);
}

// Only the layers you'll hear are decoded and played (a 60 s stereo layer is ~23 MB decoded; a score has 17).
const heardKey = () => layers().filter(l => audible(l.id)).map(l => l.id).join(',');

async function startStems() {
  if (starting) return;
  starting = true;
  setStems(true); // the mix goes quiet at once, not after the layers have loaded
  try {
    const ls = layers().filter(l => audible(l.id));
    if (ls.some(l => !buffers.has(l.file))) toast(`Loading ${ls.length === 1 ? ls[0].label : `${ls.length} layers`}…`);
    const bufs = await Promise.all(ls.map(buffer));
    if (!wanted()) { if (!running) setStems(false); return; }
    try { audition0?.stop(); } catch {} // a sound heard on its own stops when the layers play
    const a = audioCtx(), at = a.currentTime + LEAD, t0 = S.t + LEAD * S.rate;
    const nodes = new Map();
    ls.forEach((l, i) => {
      const g = a.createGain();
      g.connect(master);
      const src = a.createBufferSource();
      src.buffer = bufs[i];
      src.playbackRate.value = S.rate;
      src.connect(g);
      if (t0 < bufs[i].duration) src.start(at, Math.max(0, t0));
      nodes.set(l.id, { src, g });
    });
    running = { at, t0, rate: S.rate, nodes, key: ls.map(l => l.id).join(',') };
    failedKey = null;
  } catch {
    failedKey = heardKey();
    setStems(false);
    toast('Couldn’t play the layers', { err: true });
  } finally { starting = false; }
}

function syncStems() {
  if (!wanted()) { if (running || S.stemsOn) stopStems(); return; }
  if (!running) { if (heardKey() !== failedKey) void startStems(); return; }
  // other layers to hear, a seek, a loop or a change of speed: start again from where the film is
  const now = running.t0 + (ac.currentTime - running.at) * running.rate;
  if (running.key !== heardKey() || running.rate !== S.rate || Math.abs(now - S.t) > DRIFT) { stopStems(); startStems(); }
}
on('play', () => { if (S.playing) { try { audition0?.stop(); } catch {} } syncStems(); });
on('rate', syncStems);
on('time', () => { if (running || wanted()) syncStems(); });

// ---------------------------------------------------------------- the layer heads (beside the rows)

let headsEl = null;
export function renderHeads(el) {
  headsEl = el;
  if (!soundOpen()) return el.replaceChildren();
  el.replaceChildren(...layers().map((l, i) => h('div.shead', {
    // dimmed when it isn't heard; too short for its buttons, only the name (double-click still solos)
    class: `${audible(l.id) ? '' : 'off'} ${rowH < 11 ? 'tight' : ''}`,
    style: { top: i * rowH + 'px', height: rowH + 'px', '--lc': layerColor(l, i), '--rh': rowH + 'px' },
    ondblclick: e => { if (!e.target.closest('button')) emit('solo-play', { id: l.id }); },
    title: `${l.id}: ${l.label} · ${l.count ?? (byLayer.get(l.id) || []).length} sounds\nDouble-click to play only this layer (again: the whole mix)`,
  },
    h('span.lv'), // its level at the playhead: the layer making the sound you hear lights up
    h('i'),
    h('span.sl', l.id), // the short name: labels often start alike ("Glass figure", "Glass counter")
    h('button.sm', { class: S.soundMute.has(l.id) ? 'on' : '', title: `Mute ${l.label} while the film plays`, onclick: () => toggleLayer(l.id, 'mute') }, 'M'),
    h('button.ss', { class: S.soundSolo.has(l.id) ? 'on' : '', title: `Hear only ${l.label} (and other soloed layers)`, onclick: () => toggleLayer(l.id, 'solo') }, 'S'),
  )));
}

// ---------------------------------------------------------------- what you're doing, for the agent
// Sound is hard to talk about, so the agent can read what you hear and where you are (GET …/view, sb view): the
// playhead, the layers muted or soloed, the sounds picked. Sent when it changes, at most every 0.6 s.
let reportTimer = null;
function report() {
  if (reportTimer || !S.slug) return;
  reportTimer = setTimeout(() => {
    reportTimer = null;
    if (!S.board) return;
    fetch(`/api/boards/${encodeURIComponent(S.slug)}/view`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t: S.t, playing: S.playing, range: S.range, scene: S.sel.scene, note: S.sel.note, shown: soundOpen(), mute: [...S.soundMute], solo: [...S.soundSolo], heard: listening()?.heard ?? null, picked: pickedForNote() }),
    }).catch(() => {});
  }, 600);
}
for (const ev of ['open', 'sound', 'sound-paint', 'play', 'select', 'time', 'range']) on(ev, report);

// ---------------------------------------------------------------- the picked sound, close up (in the side panel)
// What a sound is: its layer, when, how long, what it's for, and its notes: lit on a keyboard, and in a piano roll
// of its layer around it (the picked one bright; click any note to pick and hear it), with the layer's waveform
// under. The last sound picked is the one shown.
const ROLL = { before: 3, after: 5, keys: 26, wave: 30, h: 190 };
export function soundCard() {
  const e = (lastPick && S.soundSel.find(x => x.id === lastPick.id)) || S.soundSel[0];
  const li = e ? layers().findIndex(l => l.id === e.layer) : -1;
  if (li < 0) return null;
  const l = layers()[li], col = layerColor(l, li), ps = pitchesOf(e);
  const canvas = h('canvas.sc-roll', { title: 'Its layer around it: click a note to pick it and hear it' });
  requestAnimationFrame(() => drawCard(canvas, e, l, col));
  return h('div.sec.sound-card', { style: { '--lc': col } },
    h('div.sec-head', h('span.label', 'Sound'), S.soundSel.length > 1 && h('span.sc-n', `${S.soundSel.length} picked · this one last`)),
    h('div.sc-title', h('i'), h('b', l.label), ps.length > 0 && h('span.sc-notes', ps.map(noteName).join(' '))),
    h('div.sc-meta', `${(+e.t).toFixed(2)} s · ${e.dur != null ? `${(+e.dur).toFixed(2)} s long` : 'short'} · ${e.id}`),
    e.label && h('div.sc-label', e.label),
    canvas,
    h('div.sc-foot', h('button.sc-play', { onclick: () => audition(e) }, '▶ Hear it'), h('span.sc-hint', '⌥← ⌥→ the next one in its layer')),
  );
}

function drawCard(canvas, e, l, col) {
  const W = canvas.clientWidth || 300, H = ROLL.h, dpr = devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); canvas.style.height = H + 'px';
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  // the window: a few seconds either side, the whole sound in it
  const t0 = Math.max(0, e.t - ROLL.before), t1 = Math.min(Math.max(e.t + ROLL.after, endOf(e) + 0.5), t0 + 14);
  const list = (byLayer.get(l.id) || []).filter(x => x.t < t1 && endOf(x) > t0);
  const x0 = ROLL.keys, rollH = H - ROLL.wave - 4, X = t => x0 + ((t - t0) / (t1 - t0)) * (W - x0);
  const all = [...new Set(list.flatMap(pitchesOf))], pitched = all.length > 0;
  let lo = pitched ? Math.min(...all) - 2 : 0, hi = pitched ? Math.max(...all) + 2 : 0;
  if (pitched && hi - lo < 12) { const pad = Math.ceil((12 - (hi - lo)) / 2); lo -= pad; hi += pad; }
  const rows = hi - lo + 1, rh = rollH / rows, yOf = m => (hi - m) * rh;
  g.fillStyle = '#141418'; g.fillRect(0, 0, W, H);
  if (pitched) {
    // the keyboard (black keys dark), the picked sound's notes lit; and the rows behind the roll
    const lit = new Set(pitchesOf(e));
    for (let m = lo; m <= hi; m++) {
      const black = NAMES[((m % 12) + 12) % 12].includes('#'), y = yOf(m);
      g.fillStyle = lit.has(m) ? col : black ? '#232329' : '#cfcfd6';
      g.fillRect(0, y, x0 - 2, Math.max(1, rh - 0.5));
      g.fillStyle = black ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.05)';
      g.fillRect(x0, y, W - x0, Math.max(1, rh - 0.5));
      if (m % 12 === 0 && rh >= 5) { g.fillStyle = 'rgba(255,255,255,0.45)'; g.font = '8px ui-monospace, Menlo, monospace'; g.fillText(noteName(m), x0 + 3, y + rh - 1); }
    }
  } else {
    g.fillStyle = 'rgba(255,255,255,0.4)'; g.font = '10px ui-monospace, Menlo, monospace';
    g.fillText('no pitch (a drum or a noise)', x0 + 6, 14);
  }
  // seconds
  g.fillStyle = 'rgba(255,255,255,0.07)';
  for (let s = Math.ceil(t0); s <= t1; s++) g.fillRect(Math.round(X(s)), 0, 1, rollH);
  // the notes: its layer's sounds, the picked one bright with a white edge
  const bars = [];
  for (const x of list) {
    const xa = X(x.t), w = Math.max(3, X(endOf(x)) - xa), mine = x.id === e.id;
    const ms = pitched ? pitchesOf(x) : [null];
    for (const m of ms) {
      const y = m == null ? rollH * 0.35 : yOf(m), bh = m == null ? rollH * 0.3 : Math.max(2, rh - 1);
      g.globalAlpha = mine ? 1 : 0.5; g.fillStyle = col; g.fillRect(xa, y, w, bh);
      if (mine) { g.globalAlpha = 1; g.strokeStyle = '#fff'; g.lineWidth = 1.25; g.strokeRect(xa - 0.5, y - 0.5, w + 1, bh + 1); }
      bars.push([xa, y, w, bh, x]);
    }
  }
  g.globalAlpha = 1;
  // the layer's waveform, the picked sound's stretch brighter
  const p = peaks.get(l.id), wy = H - ROLL.wave;
  if (p) {
    const mid = wy + ROLL.wave / 2, amp = ROLL.wave / 2 - 2;
    for (let px = x0; px < W; px++) {
      const ta = t0 + ((px - x0) / (W - x0)) * (t1 - t0), tb = t0 + ((px + 1 - x0) / (W - x0)) * (t1 - t0);
      let m = 0;
      for (let k = Math.floor(ta * p.rate); k < Math.max(Math.floor(ta * p.rate) + 1, Math.floor(tb * p.rate)) && k < p.peak.length; k++) if (p.peak[k] > m) m = p.peak[k];
      const hh = (m / 255) * amp;
      g.fillStyle = col; g.globalAlpha = ta >= e.t && ta <= endOf(e) ? 0.9 : 0.3;
      g.fillRect(px, mid - hh, 1, Math.max(0.5, hh * 2));
    }
    g.globalAlpha = 1;
  }
  canvas.onclick = ev => {
    const r = canvas.getBoundingClientRect(), cx = ev.clientX - r.left, cy = ev.clientY - r.top;
    const hit = bars.find(([bx, by, bw, bb]) => cx >= bx - 2 && cx <= bx + bw + 2 && cy >= by - 2 && cy <= by + bb + 2);
    if (hit) pickSound(hit[4]);
  };
}

// ---------------------------------------------------------------- a passage to loop
// Drag across the soundtrack's waveform: the film loops between there while it plays, mute and solo work as
// always, and a note written then is about the passage. Esc lets go of it.
S.range = null;
export function setRange(a, b) {
  S.range = b - a >= 0.05 ? { a: Math.max(0, Math.min(a, b)), b: Math.max(a, b) } : null;
  if (S.range && !S.soundSel.length) S.noteTarget = 'soundtrack';
  emit('sound-paint');
  emit('range');
}
export function clearRange() {
  if (!S.range) return false;
  setRange(0, 0);
  return true;
}

// ---------------------------------------------------------------- what is sounding now
// The sounds playing at a time, the newest first (what you just heard), in the layers you hear.
export function soundingAt(t) {
  const out = [];
  for (const l of layers()) {
    if (!audible(l.id)) continue;
    for (const e of byLayer.get(l.id) || []) {
      if (e.t > t) break;
      if (endOf(e) > t) out.push(e);
    }
  }
  return out.sort((p, q) => q.t - p.t);
}

// Under the picture: those sounds as chips with their labels; click one to pick it and hear it. Rebuilt only
// when the set changes, not every frame.
let nowEl = null, nowKey = '';
export function renderNow(el = nowEl ?? document.getElementById('nowSounds')) {
  nowEl = el;
  if (!el) return;
  const list = soundOpen() ? soundingAt(S.t) : [];
  const key = list.map(e => e.id).join('|') + `|${S.soundSel.map(e => e.id).join(',')}|${[...markedForRemoval()].join(',')}`;
  if (key === nowKey) return;
  nowKey = key;
  el.hidden = !soundOpen();
  if (!list.length) return el.replaceChildren(h('span.now-empty', 'Sounding now: nothing'));
  const picked = new Set(S.soundSel.map(e => e.id)), gone = markedForRemoval(), max = 7;
  el.replaceChildren(h('span.now-head', 'Sounding now'), ...list.slice(0, max).map(e => h('button.now-snd', {
    class: `${picked.has(e.id) ? 'on' : ''} ${gone.has(e.id) ? 'marked' : ''}`,
    oncontextmenu: ev => soundMenu(ev, e),
    style: { '--lc': colorOfLayer(e.layer) },
    title: `${soundName(e)}\n${(+e.t).toFixed(2)} s${e.dur != null ? ` for ${(+e.dur).toFixed(2)} s` : ''} — click to pick it and hear it; right-click for a note or to mark it for removal`,
    onclick: () => pickSound(e, false),
  }, h('i'), h('b', e.layer), pitchesOf(e).length > 0 && h('em', pitchesOf(e).map(noteName).join(' ')), e.label && h('span', e.label))),
  list.length > max && h('span.now-more', `+${list.length - max}`));
}

// Each layer's level at the playhead, from its waveform data, as a bar behind its name.
function meters() {
  if (!headsEl || !soundOpen()) return;
  const heads = headsEl.children;
  layers().forEach((l, i) => {
    const p = peaks.get(l.id), el = heads[i]?.firstChild;
    if (!el) return;
    let v = 0;
    if (p) {
      const k = Math.floor(S.t * p.rate), src = p.rms || p.peak;
      for (let j = Math.max(0, k - 4); j <= k && j < src.length; j++) v = Math.max(v, src[j]);
    }
    el.style.transform = `scaleX(${Math.min(1, (v / 255) * (p?.rms ? 1.8 : 1))})`;
  });
}
on('time', () => { renderNow(); meters(); });
for (const ev of ['sound', 'sound-paint', 'open', 'board']) on(ev, () => { nowKey = ''; renderNow(); meters(); });
