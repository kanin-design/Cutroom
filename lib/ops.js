// The board model. Every change to a board is an op; the server, the `sb` CLI and the browser
// all apply ops with this file, so the same ops in the same order give the same board everywhere.
// applyOps never mutates its input: it returns the new board, the ops as applied (with ids filled
// in), the inverse ops (for undo) and one human sentence per op (for the activity feed and the log).

export const STATUSES = ['idea', 'draft', 'review', 'approved'];
export const COLORS = ['#8b8f98', '#c47a5a', '#cfa25a', '#8aa86a', '#5fa39b', '#6f8ed6', '#977dcf', '#c3719a'];
// The colours a mark on a frame can be drawn in; a mark given none gets the first.
export const MARK_COLORS = ['#ff453a', '#ffd23f', '#4cc9f0', '#f4f1ea'];
// What the user can ask Claude to render (a note's `render`: a size and a quality). The board's shape is
// fitted inside each size's standard frame, turned upright for a portrait board; the frame rate is the
// board's. Final is the project's full settings, draft its quickest that still show the look.
export const RENDER_SIZES = {
  '4k': { label: '4K', w: 3840, h: 2160 },
  '1080p': { label: '1080p', w: 1920, h: 1080 },
  '720p': { label: '720p', w: 1280, h: 720 },
};
export const RENDER_QUALITIES = ['draft', 'final'];
// How a picture is made: it decides what a frame costs and what draft and final mean (a ray-marched frame at
// a few samples a pixel is grainy, fine for checking motion; its final needs many). Every scene is its own
// little movie, made its own way: one is ray traced, the next an edit of 4K footage, the next a screen
// capture. A scene's `render` says how it is made (its type, what draft and final mean for it, the command that
// renders it); the board's `render` is the default for scenes that don't say. The film is the cut of them.
export const RENDER_TYPES = {
  '2d': { label: '2D', what: 'Drawn flat on a canvas: type, shapes and graphics.' },
  raster: { label: 'Raster', what: 'Triangles drawn the way a game engine draws them: three.js meshes and materials.' },
  raymarch: { label: 'Ray marched', what: 'Shapes made of distance formulas, found by stepping along each ray: smooth blends, fractals, organic forms. Grainy at a few samples a pixel.' },
  raytrace: { label: 'Ray traced', what: 'Rays that hit exact surfaces, like spheres and facets, with true reflection and refraction. Grainy at a few samples a pixel.' },
  pathtrace: { label: 'Path traced', what: 'Light followed through many random bounces: glass, caustics, soft bounce light. Grainy until it has enough samples, and the slowest to render.' },
  edit: { label: 'Edit', what: 'Cut together from clips that already exist: nothing new is drawn.' },
  capture: { label: 'Screen capture', what: 'A real app or page recorded frame by frame.' },
};
// Short tags for the timeline's clips.
export const RENDER_TAGS = { '2d': '2D', raster: 'RAS', raymarch: 'RM', raytrace: 'RT', pathtrace: 'PT', edit: 'EDIT', capture: 'CAP' };
// Types whose versions are footage, not renders: their quality is the footage's, so any version counts as final.
const FOOTAGE = ['edit', 'capture'];
// The names agents also use for them.
const RENDER_ALIASES = { canvas: '2d', three: 'raster', threejs: 'raster', webgl: 'raster', raymarched: 'raymarch', raymarching: 'raymarch', sdf: 'raymarch', raytraced: 'raytrace', raytracing: 'raytrace', pathtraced: 'pathtrace', pathtracing: 'pathtrace', screencapture: 'capture' };
// The shapes a board's frame comes in. Pixels are a render's business: a board keeps the 1080p frame of
// its shape as a reference (1920×1080 for 16:9, 1080×1350 for 4:5), for sketches, marks and the animatic.
export const ASPECTS = ['16:9', '9:16', '1:1', '4:5', '4:3', '2.39:1'];

// Every scene's colour: its own if it has one; otherwise one from the palette, picked from its id (so
// it stays put) and never the same as the scene beside it, so neighbours are always easy to tell apart.
export function sceneColors(board) {
  const hues = COLORS.slice(1), list = board.scenes, out = new Map();
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.color) { out.set(s.id, s.color); continue; }
    const avoid = [out.get(list[i - 1]?.id), list[i + 1]?.color];
    let k = [...s.id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % hues.length;
    while (avoid.includes(hues[k])) k = (k + 1) % hues.length;
    out.set(s.id, hues[k]);
  }
  return out;
}

const BOARD_FIELDS = ['title', 'brief', 'treatment', 'project', 'owner', 'render', 'archived', 'fps', 'aspect', 'width', 'height', 'bpm', 'beatOffset', 'beatsPerBar', 'sketchLib'];
const SCENE_FIELDS = ['title', 'duration', 'picture', 'sound', 'status', 'color', 'activeRender', 'meta', 'render'];
const NOTE_FIELDS = ['text', 'resolved', 'working', 'scene', 'at', 'pin', 'markup'];
const MARKER_FIELDS = ['t', 'label', 'color'];

// Every key an op, or an object inside one, may carry. Anything else is an error (typos must
// not be silently dropped on a shared board).
const OP_KEYS = {
  'board.set': ['fields'], 'scene.add': ['scene', 'before', 'after', 'index'], 'scene.remove': ['id'],
  'scene.set': ['id', 'fields'], 'scene.move': ['id', 'before', 'after', 'index'], 'scene.split': ['id', 'at', 'title', 'scene'],
  'render.add': ['scene', 'render', 'activate', 'index'], 'render.set': ['scene', 'id', 'fields'], 'render.remove': ['scene', 'id'],
  'note.add': ['note', 'index', 'restore'], 'note.set': ['id', 'fields'], 'note.remove': ['id'],
  'reply.add': ['note', 'reply', 'index'], 'reply.remove': ['note', 'index'],
  'marker.add': ['marker'], 'marker.set': ['id', 'fields'], 'marker.remove': ['id'], 'audio.set': ['audio'], 'sound.set': ['sound'],
  'notes.send': ['ids', 'message', 'edits'], 'notes.unsend': ['sent', 'edits'], 'notes.read': ['ids', 'read'],
};
const OBJ_KEYS = {
  scene: ['title', 'duration', 'picture', 'sound', 'status', 'color', 'meta', 'render', 'renders', 'activeRender', 'id', 'author', 'created'],
  render: ['file', 'kind', 'sketch', 'caption', 'poster', 'strip', 'stripFrames', 'duration', 'width', 'height', 'source', 'sourceMtime', 'updated', 'drawn', 'meta', 'id', 'author', 'created', 'note'],
  note: ['text', 'scene', 'soundtrack', 'sounds', 'render', 'at', 'to', 'pin', 'markup', 'files', 'resolved', 'resolvedBy', 'working', 'read', 'readBy', 'replies', 'sent', 'id', 'author', 'created'],
  renderRequest: ['size', 'quality'],
  markup: ['render', 'w', 'h', 'image', 'frame', 'marks'],
  mark: ['n', 'kind', 'text', 'color', 'x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2', 'points'],
  reply: ['text', 'files', 'author', 'created'],
  file: ['file', 'name', 'kind', 'poster', 'width', 'height', 'duration', 'size'],
  marker: ['t', 'label', 'color', 'id'],
  audio: ['file', 'name', 'duration', 'peaks'],
  // The soundtrack's parts (`sb sound`): one stem per layer, and every sound in it, listed in `events` (a file in
  // media, not in the board: a score has thousands). A note can be about some of those sounds (`sounds`).
  sound: ['name', 'duration', 'layers', 'events', 'count', 'source'],
  soundLayer: ['id', 'label', 'file', 'peaks', 'color', 'count'],
  noteSound: ['id', 'layer', 't', 'dur', 'note', 'label', 'set'],
  pin: ['x', 'y'],
  boardRender: ['type', 'draft', 'final'],
  sceneRender: ['type', 'draft', 'final', 'cmd', 'fps', 'source'],
};

export function checkKeys(o, allowed, where) {
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue;
    const near = allowed.map(a => [a, editDistance(a, k)]).sort((x, y) => x[1] - y[1])[0];
    throw new Error(`${where}: unknown field "${k}"${near && near[1] <= 2 ? ` (did you mean "${near[0]}"?)` : ''}; allowed: ${allowed.join(', ')}`);
  }
}

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export function newBoard(o = {}) {
  const frame = o.aspect != null ? aspectFrame(o.aspect) : null;
  return {
    schema: 1,
    rev: 0,
    title: o.title || 'Untitled',
    brief: o.brief || '',
    treatment: o.treatment || '',
    project: o.project || '',
    render: null,
    sketchLib: null,
    fps: num(o.fps ?? 30, 'fps', 1, 240),
    width: frame ? frame.w : Math.round(num(o.width ?? 1920, 'width', 16, 16384)),
    height: frame ? frame.h : Math.round(num(o.height ?? 1080, 'height', 16, 16384)),
    bpm: o.bpm ? num(o.bpm, 'bpm', 20, 400) : null,
    beatOffset: 0,
    beatsPerBar: Math.round(num(o.beatsPerBar ?? 4, 'beatsPerBar', 1, 16)),
    audio: null,
    sound: null,
    scenes: [],
    notes: [],
    markers: [],
    nextId: { s: 1, r: 1, n: 1, m: 1 },
  };
}

// ---------------------------------------------------------------- time

const round6 = x => Math.round(x * 1e6) / 1e6;
export const snapFrame = (b, t) => round6(Math.round(t * b.fps) / b.fps);
// A scene length that shows all of a clip: whole frames, rounded up.
export const fitDuration = (b, d) => Math.ceil(d * b.fps - 1e-6) / b.fps;
export const totalDuration = b => round6(b.scenes.reduce((a, s) => a + s.duration, 0));

export function layout(b) {
  let t = 0;
  return b.scenes.map((scene, index) => {
    const start = t;
    t = round6(t + scene.duration);
    return { scene, index, start, end: t };
  });
}

export function locate(b, t) {
  let start = 0;
  for (let i = 0; i < b.scenes.length; i++) {
    const s = b.scenes[i];
    const end = start + s.duration;
    if (t < end - 1e-9 || i === b.scenes.length - 1) return { scene: s, index: i, start, local: Math.max(0, t - start) };
    start = end;
  }
  return null;
}

// Where a scene sits in the cut: what a code sketch needs to follow the film's clock.
export function placement(b, id) {
  let t = 0;
  const total = totalDuration(b);
  for (const [index, s] of b.scenes.entries()) {
    if (s.id === id) return { start: round6(t), duration: s.duration, filmDuration: total, scene: id, index };
    t += s.duration;
  }
  return null;
}

export function sceneStart(b, id) {
  let t = 0;
  for (const s of b.scenes) {
    if (s.id === id) return t;
    t += s.duration;
  }
  return null;
}

export function noteTime(b, note) {
  if (note.soundtrack) return note.at ?? null;
  if (!note.scene) return null;
  const st = sceneStart(b, note.scene);
  return st == null ? null : round6(st + (note.at ?? 0));
}

export const activeRender = s => s.renders.find(r => r.id === s.activeRender) || null;
export const findScene = (b, id) => b.scenes.find(s => s.id === id) || null;
// What to say when a scene id isn't on the board.
export const noScene = (b, id) => `no scene ${id} (scenes: ${b.scenes.map(s => s.id).join(', ') || 'none'})`;

// Time as agents read and write it: m:ss.ss ("1:21.50"). The editor shows SMPTE timecode instead.
export function clock(t) {
  const neg = t < 0;
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${neg ? '-' : ''}${m}:${s.toFixed(2).padStart(5, '0')}`;
}
export const secs = t => `${+(+t).toFixed(3)}s`;
// "1 note", "3 notes", "1.5 beats"; pass the plural when it isn't the word plus s.
export const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;
// The editor's timecode, 00:01:11:15 (hours:minutes:seconds:frames): how the user reads and types times.
export function timecode(t, fps) {
  const f = Math.round(Math.max(0, t) * fps);
  const fr = f % Math.round(fps);
  const s = Math.floor(f / fps);
  const p = n => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(fr)}`;
}

// A time typed into the timecode, read the way editors do: digits fill from the right, so 2115 and
// 21:15 are 00:00:21:15 and 5 is five frames; a leading + or - moves from `now` instead.
// Returns seconds, or null if it isn't a time.
export function parseTimecode(text, fps, now = 0) {
  const m = /^\s*([+-]?)\s*([\d:;.\s]+)$/.exec(text);
  if (!m) return null;
  const body = m[2].trim();
  let parts;
  if (/[:;.]/.test(body)) parts = body.split(/\s*[:;.]\s*/);
  else {
    const d = body.replace(/\s+/g, '');
    if (!d || d.length > 8) return null;
    const p = d.padStart(8, '0');
    parts = [p.slice(0, 2), p.slice(2, 4), p.slice(4, 6), p.slice(6)];
  }
  if (parts.length > 4 || parts.some(x => !/^\d*$/.test(x))) return null;
  const [ff = 0, ss = 0, mm = 0, hh = 0] = parts.reverse().map(x => +x || 0);
  const t = (((hh * 60 + mm) * 60 + ss) * Math.round(fps) + ff) / fps;
  return m[1] === '+' ? now + t : m[1] === '-' ? now - t : t;
}

// Ids that a list of applied ops created, by kind.
export function createdIds(applied) {
  const out = { scenes: [], renders: [], notes: [], markers: [] };
  for (const op of applied) {
    if (op.op === 'scene.add' || op.op === 'scene.split') {
      out.scenes.push(op.scene.id);
      out.renders.push(...op.scene.renders.map(r => r.id));
    } else if (op.op === 'render.add') out.renders.push(op.render.id);
    else if (op.op === 'note.add') out.notes.push(op.note.id);
    else if (op.op === 'marker.add') out.markers.push(op.marker.id);
  }
  for (const k of Object.keys(out)) if (!out[k].length) delete out[k];
  return out;
}

// ---------------------------------------------------------------- apply

export function applyOps(board, ops, ctx = {}) {
  if (!Array.isArray(ops)) ops = [ops];
  if (!ops.length) throw new Error('no ops');
  const c = { author: ctx.author || 'you', now: ctx.now || new Date().toISOString() };
  const b = structuredClone(board);
  const applied = [], inverse = [], summaries = [];
  for (const raw of ops) {
    if (!raw || typeof raw.op !== 'string') throw new Error('each op needs an "op" field');
    const fn = APPLY[raw.op];
    if (!fn) throw new Error(`unknown op "${raw.op}" (known: ${Object.keys(APPLY).join(', ')})`);
    const plain = shorthand(raw);
    checkKeys(plain, ['op', ...OP_KEYS[plain.op]], plain.op);
    const op = structuredClone(plain);
    const [inv, text] = fn(b, op, c);
    applied.push(op);
    inverse.unshift(...inv);
    summaries.push(text);
  }
  if (c.author === 'you') trackEdits(board, b);
  settleEdits(b);
  b.rev = (b.rev || 0) + 1;
  return { board: b, applied, inverse, summaries };
}

// The user's own changes since they last sent: Claude hasn't been told about them. `edits` keeps, for each
// thing changed, what it was at the last send, so a change put back (by anyone) drops out, the editor can offer
// to put it back, and Send hands Claude each one as was → now. Keys: `s3.picture` (a scene's field), `s3` (a
// scene added or deleted: before is whether it was there), `order` (before: the scene ids), `board.brief` (a
// board field). A scene added since the last send is one change: its fields aren't counted separately.
export const EDIT_SCENE_FIELDS = ['title', 'duration', 'picture', 'sound', 'status', 'activeRender', 'render'];
const EDIT_BOARD_FIELDS = ['title', 'brief', 'treatment', 'width', 'height', 'fps', 'bpm', 'beatOffset', 'beatsPerBar', 'audio'];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// Two orders of the scenes, by the scenes both have: adding or deleting one isn't also a reorder.
const sameOrder = (a, b) => same(a.filter(id => b.includes(id)), b.filter(id => a.includes(id)));

// Only the user's changes are noted (Claude knows its own), each with what it was when first changed.
function trackEdits(prev, next) {
  const E = { ...next.edits };
  const change = (key, was, now, extra) => { if (!same(was, now) && !(key in E)) E[key] = { before: was ?? null, ...extra }; };
  const before = new Map(prev.scenes.map(s => [s.id, s]));
  const after = new Map(next.scenes.map(s => [s.id, s]));
  for (const [id, s] of before) if (!after.has(id)) change(id, true, false, { title: s.title });
  for (const [id, s] of after) if (!before.has(id)) change(id, false, true, { title: s.title });
  for (const [id, s] of after) {
    const p = before.get(id);
    if (!p || E[id]?.before === false) continue;
    for (const f of EDIT_SCENE_FIELDS) change(`${id}.${f}`, p[f], s[f]);
  }
  const ids = prev.scenes.map(s => s.id);
  if (!E.order && !sameOrder(ids, next.scenes.map(s => s.id))) E.order = { before: ids };
  for (const f of EDIT_BOARD_FIELDS) change(`board.${f}`, prev[f], next[f]);
  next.edits = E;
}

// After every change, by anyone: a thing that is as it was at the last send again is no change, so it drops
// out (Claude bringing back a scene the user deleted, say). A deleted scene's own changes wait with it, and
// count again if it comes back.
function settleEdits(b) {
  for (const [key, e] of Object.entries(b.edits || {})) if (editState(b, key, e) === 'back') delete b.edits[key];
  if (b.edits && !Object.keys(b.edits).length) delete b.edits;
}

// Where a change stands now: 'changed', 'back' (as it was at the last send) or 'waiting' (a change to a scene
// that is deleted now, or an order that had it in).
function editState(b, key, e) {
  const [id, field] = key.split('.');
  if (key === 'order') return !sameOrder(e.before, b.scenes.map(s => s.id)) ? 'changed' : e.before.every(x => findScene(b, x)) ? 'back' : 'waiting';
  if (field && id !== 'board' && !findScene(b, id)) return 'waiting';
  return same(e.before, editNow(b, key)) ? 'back' : 'changed';
}

function editNow(b, key) {
  const [id, field] = key.split('.');
  if (key === 'order') return b.scenes.map(s => s.id);
  if (id === 'board') return b[field] ?? null;
  const s = findScene(b, id);
  return field ? s?.[field] ?? null : !!s;
}

// The changes waiting to be sent, as was → now: what Send hands Claude, and what the editor lists by Send.
export function editList(b) {
  return Object.entries(b.edits || {}).filter(([key, e]) => editState(b, key, e) === 'changed').map(([key, e]) => {
    const [id, field] = key.split('.'), now = editNow(b, key);
    if (key === 'order') return { key, field: 'order', before: e.before, now };
    if (id === 'board') return { key, field, before: e.before, now };
    const s = findScene(b, id);
    if (!field) return { key, scene: id, title: s?.title ?? e.title, field: 'scene', before: e.before, now };
    return { key, scene: id, title: s?.title, field, before: e.before, now };
  });
}

// The changes several sends handed over, as one: a thing keeps its first was and its last now, and one that
// is back as it was (deleted, then brought back) is no change.
export function mergeEdits(lists) {
  const m = new Map();
  for (const e of lists.flat()) m.set(e.key, m.has(e.key) ? { ...e, before: m.get(e.key).before } : e);
  return [...m.values()].filter(e => !(e.field === 'order' ? sameOrder(e.before, e.now) : same(e.before, e.now)));
}

// What Send hands Claude now, in the editor's words: the Send button's card lists it, so the user can check
// before they send. Each note not sent yet, then the changes by where they are, in the order of the cut (a
// deleted scene after the rest, then the order and the board). A scene's changes share its row: a short value
// as was → now, a text by its field. A row is { n, t, w }: a number, a title, and the words under it.
const SEND_WORDS = { title: 'title', duration: 'length', picture: 'picture', sound: 'sound', status: 'status', activeRender: 'version', render: 'render as', brief: 'brief', treatment: 'treatment', fps: 'frame rate', bpm: 'tempo', beatOffset: 'beat offset', beatsPerBar: 'beats per bar', audio: 'soundtrack', width: 'width', height: 'height' };
export function sendList(b) {
  const num = new Map(b.scenes.map((s, i) => [s.id, String(i + 1).padStart(2, '0')]));
  const about = n => (n.soundtrack ? 'on the soundtrack' : !n.scene ? 'on the whole film' : num.has(n.scene) ? `on ${num.get(n.scene)} ${findScene(b, n.scene).title}` : 'on a deleted scene');
  const notes = b.notes.filter(n => n.author === 'you' && !n.sent && !n.resolved).map(n => ({
    n: `#${b.notes.indexOf(n) + 1}`,
    t: n.text?.trim() ? clip(n.text.trim(), 80) : n.render ? `Render ${renderLabel(n)}` : n.markup ? 'Marks on a frame' : 'Files',
    w: about(n),
  }));
  const words = e => {
    if (e.field === 'scene') return e.now ? 'added' : 'deleted';
    const s = e.scene && findScene(b, e.scene);
    const value = v => {
      if (e.field === 'render') return v ? RENDER_TYPES[v.type]?.label || v.type : 'the film';
      if (v == null || v === '') return 'none';
      if (e.field === 'duration' || e.field === 'beatOffset') return secs(v);
      if (e.field === 'status') return v[0].toUpperCase() + v.slice(1);
      if (e.field === 'activeRender') { const i = s ? s.renders.findIndex(r => r.id === v) : -1; return i < 0 ? v : `v${i + 1}`; }
      if (e.field === 'title') return `“${clip(v, 24)}”`;
      if (e.field === 'audio') return `“${clip(v.name || '', 24)}”`;
      return String(v);
    };
    const word = SEND_WORDS[e.field] || e.field, was = value(e.before), now = value(e.now);
    return ['picture', 'sound', 'brief', 'treatment'].includes(e.field) || was === now ? word : `${word} ${was} → ${now}`;
  };
  const at = new Map();
  for (const e of editList(b)) {
    const k = e.field === 'order' ? 'order' : e.scene || 'board';
    at.set(k, [...(at.get(k) || []), e]);
  }
  const place = k => (num.has(k) ? +num.get(k) : k === 'order' ? 1e4 : k === 'board' ? 1e5 : 1e3);
  const changes = [...at].sort((x, y) => place(x[0]) - place(y[0])).map(([k, list]) => {
    if (k === 'order') return { n: '', t: 'The order of the scenes', w: 'changed' };
    if (k === 'board') return { n: '', t: 'The board', w: list.map(words).join(' · ') };
    return { n: num.get(k) || '', t: list[0].title || k, w: list.map(words).join(' · ') };
  });
  return { notes, changes };
}

const APPLY = {
  'board.set'(b, op) {
    let fields = obj(op.fields, 'fields');
    checkKeys(fields, BOARD_FIELDS, 'board.set');
    // A shape sets the reference frame for it.
    if (fields.aspect != null) { const { aspect, ...rest } = fields; const f = aspectFrame(aspect); fields = { ...rest, width: f.w, height: f.h }; }
    const old = {};
    for (const [k, v] of Object.entries(fields)) {
      old[k] = b[k] ?? null;
      b[k] = boardField(k, v);
    }
    const keys = Object.keys(op.fields).map(k => (k === 'aspect' ? `shape (${aspectName(b)})` : k));
    if (keys.length === 1 && keys[0] === 'archived') return [[{ op: 'board.set', fields: old }], b.archived ? 'archived the board' : 'brought the board back from the archive'];
    if (keys.length === 1 && keys[0] === 'render') return [[{ op: 'board.set', fields: old }], b.render ? `set how the film is rendered: ${renderTypeName(b)}` : 'cleared how the film is rendered'];
    return [[{ op: 'board.set', fields: old }], `changed the board's ${list(keys)}`];
  },

  'scene.add'(b, op, c) {
    const s = cleanScene(b, obj(op.scene, 'scene'), c);
    op.scene = s;
    const i = position(b, op);
    b.scenes.splice(i, 0, s);
    const withR = s.renders.length ? ` with ${s.renders.map(r => `${kindName(r)} ${r.id}`).join(', ')}` : '';
    return [[{ op: 'scene.remove', id: s.id }], `added ${name(s)}${withR}${where(b, i)}`];
  },

  'scene.remove'(b, op) {
    const i = sceneIndex(b, op.id);
    const [s] = b.scenes.splice(i, 1);
    const before = b.scenes[i]?.id ?? null;
    return [[{ op: 'scene.add', scene: s, before }], `removed ${name(s)}`];
  },

  'scene.set'(b, op) {
    const s = b.scenes[sceneIndex(b, op.id)];
    const fields = obj(op.fields, 'fields');
    checkKeys(fields, SCENE_FIELDS, 'scene.set');
    const old = {}, parts = [], was = name(s); // by the title it had, so a rename reads old → new
    for (const [k, v] of Object.entries(fields)) {
      old[k] = structuredClone(s[k] ?? null);
      const nv = sceneField(b, s, k, v);
      if (k === 'duration') parts.push(`duration ${secs(old[k])} → ${secs(nv)}`);
      else if (k === 'status') parts.push(`status ${old[k]} → ${nv}`);
      else if (k === 'title') parts.push(`title → “${nv}”`);
      else if (k === 'activeRender') parts.push(`active render → ${nv ?? 'none'}`);
      else if (k === 'render') parts.push(nv ? `renders as ${typeLabel(nv.type)}${nv.final ? ` (final: ${clip(nv.final, 40)})` : ''}` : `renders as the film does${b.render ? ` (${renderTypeName(b)})` : ''}`);
      else parts.push(k);
      if (k === 'render' && nv == null) delete s.render;
      else s[k] = nv;
    }
    op.fields = Object.fromEntries(Object.keys(fields).map(k => [k, s[k] ?? null]));
    return [[{ op: 'scene.set', id: s.id, fields: old }], `changed ${was}: ${parts.join(', ')}`];
  },

  'scene.move'(b, op) {
    const from = sceneIndex(b, op.id);
    const [s] = b.scenes.splice(from, 1);
    const oldBefore = b.scenes[from]?.id ?? null;
    if (op.before === s.id || op.after === s.id) {
      b.scenes.splice(from, 0, s);
      return [[], `left ${name(s)} where it was`];
    }
    const i = position(b, op);
    b.scenes.splice(i, 0, s);
    return [[{ op: 'scene.move', id: s.id, before: oldBefore }], `moved ${name(s)}${where(b, i, 'to')}`];
  },

  // Split a scene at `at` seconds into it; the second part (no renders) goes right after it.
  'scene.split'(b, op, c) {
    const s = b.scenes[sceneIndex(b, op.id)];
    const at = snapFrame(b, seconds(b, op.at, 'at', 'length'));
    op.at = at;
    if (!(at > 0 && at < s.duration)) throw new Error(`the split point must be inside ${s.id}: more than 0 and less than ${secs(s.duration)}`);
    const base = op.scene || { title: op.title || `${s.title} (2)`, picture: s.picture, sound: s.sound, status: s.status, color: s.color, meta: structuredClone(s.meta || {}) };
    const second = cleanScene(b, { ...base, duration: s.duration - at }, c);
    op.scene = second;
    const old = s.duration;
    s.duration = at;
    b.scenes.splice(b.scenes.indexOf(s) + 1, 0, second);
    return [[{ op: 'scene.remove', id: second.id }, { op: 'scene.set', id: s.id, fields: { duration: old } }], `split ${name(s)} at +${secs(at)}; the rest is ${name(second)}`];
  },

  'render.add'(b, op, c) {
    const s = b.scenes[sceneIndex(b, op.scene)];
    const r = cleanRender(b, obj(op.render, 'render'), c);
    op.render = r;
    const i = Number.isInteger(op.index) ? clamp(op.index, 0, s.renders.length) : s.renders.length;
    s.renders.splice(i, 0, r);
    const inv = [];
    if (op.activate !== false) {
      inv.push({ op: 'scene.set', id: s.id, fields: { activeRender: s.activeRender } });
      s.activeRender = r.id;
    }
    inv.push({ op: 'render.remove', scene: s.id, id: r.id });
    const what = `${kindName(r)} ${r.id}${r.kind === 'video' ? ` (${secs(r.duration)})` : ''}`;
    return [inv, `put ${what} on ${name(s)}`];
  },

  // Replace a version's media in place (a sketch re-saved in the sketches folder, say).
  'render.set'(b, op, c) {
    const s = b.scenes[sceneIndex(b, op.scene)];
    const r = s.renders.find(x => x.id === op.id);
    if (!r) throw new Error(`${s.id} has no render ${op.id} (renders: ${s.renders.map(x => x.id).join(', ') || 'none'})`);
    const fields = obj(op.fields, 'fields');
    checkKeys(fields, ['kind', 'file', 'poster', 'strip', 'stripFrames', 'duration', 'width', 'height', 'caption', 'meta', 'sketch', 'source', 'sourceMtime', 'updated', 'drawn'], 'render.set');
    if (fields.kind != null && !['video', 'image', 'code'].includes(fields.kind)) throw new Error('render.set: kind must be video, image or code');
    const old = {};
    for (const [k, v] of Object.entries(fields)) {
      old[k] = r[k] ?? null;
      r[k] = k === 'sketch' ? !!v : k === 'caption' ? str(v) : v;
    }
    return [[{ op: 'render.set', scene: s.id, id: r.id, fields: old }], `updated ${kindName(r)} ${r.id} on ${name(s)}`];
  },

  'render.remove'(b, op) {
    const s = b.scenes[sceneIndex(b, op.scene)];
    const i = s.renders.findIndex(r => r.id === op.id);
    if (i < 0) throw new Error(`${s.id} has no render ${op.id}`);
    const [r] = s.renders.splice(i, 1);
    const wasActive = s.activeRender === r.id;
    if (wasActive) s.activeRender = s.renders.at(-1)?.id ?? null;
    return [[{ op: 'render.add', scene: s.id, render: r, index: i, activate: wasActive }], `removed render ${r.id} from ${name(s)}`];
  },

  'note.add'(b, op, c) {
    const n = obj(op.note, 'note');
    checkKeys(n, OBJ_KEYS.note, 'note');
    const sounds = n.sounds != null ? cleanSounds(n.sounds) : null;
    const note = {
      id: takeId(b, 'n', n.id, b.notes),
      scene: n.scene ?? null,
      ...(n.soundtrack || n.sounds ? { soundtrack: true } : {}),
      ...(sounds ? { sounds } : {}),
      ...(n.render != null ? { render: renderRequest(n.render) } : {}),
      // Into the scene, so a note moves with its scene; a soundtrack note's is into the soundtrack.
      // a note about sounds is at the first of them (their times as cleaned, not as sent)
      at: n.at == null ? (sounds ? Math.min(...sounds.map(x => x.t)) : null) : round6(seconds(b, n.at, 'at', n.soundtrack || sounds ? 'position' : 'length')),
      // a passage of the soundtrack (looped in the sound view): from `at` to `to`
      ...(n.to != null ? { to: round6(seconds(b, n.to, 'to', 'position')) } : {}),
      pin: cleanPin(n.pin),
      markup: cleanMarkup(n.markup),
      text: str(n.text).trim(),
      files: cleanFiles(n.files, 'note'),
      author: n.author || c.author,
      created: n.created || c.now,
      // The user's notes wait until they press Send; anyone else's count as sent when written.
      sent: n.sent !== undefined ? n.sent : (n.author || c.author) === 'you' ? null : n.created || c.now,
      resolved: !!n.resolved,
      resolvedBy: n.resolved ? n.resolvedBy || null : null,
      read: n.read || null,
      readBy: n.readBy || null,
      working: n.resolved ? null : n.working || null,
      replies: Array.isArray(n.replies) ? n.replies : [],
    };
    if (note.soundtrack && note.scene) throw new Error('a soundtrack note is about the soundtrack, not a scene: leave out "scene"');
    if (note.soundtrack && (note.pin || note.markup)) throw new Error('spots and marks belong to a frame, not the soundtrack');
    if (note.to != null && (!note.soundtrack || note.at == null || note.to <= note.at)) throw new Error('"to" ends a passage of the soundtrack: a soundtrack note with an "at" before it');
    if (note.render && (note.soundtrack || note.pin || note.markup)) throw new Error('a render request is for the whole film, a scene or one frame (its "at"): no "soundtrack", spot or marks');
    if (note.render && note.at != null && !note.scene) throw new Error('a frame to render needs its scene: give "scene" and "at"');
    if (!note.text && !note.files.length && !note.markup?.marks.length && !note.render) throw new Error('a note needs text, a file or marks');
    if (note.markup && note.at == null) throw new Error('marks belong to a frame: give the note an "at"');
    if (!note.files.length) delete note.files;
    if (!note.markup) delete note.markup;
    if (note.scene && !op.restore && !findScene(b, note.scene)) throw new Error(noScene(b, note.scene));
    op.note = note;
    const i = Number.isInteger(op.index) ? clamp(op.index, 0, b.notes.length) : b.notes.length;
    b.notes.splice(i, 0, note);
    const s = findScene(b, note.scene);
    const said = note.sent ? (note.text ? `: “${clip(note.text, 90)}”` : '') : ' (not sent yet)';
    const withFiles = (note.markup ? ` with ${plural(note.markup.marks.length, 'mark')}` : '') + (note.files ? ` with ${plural(note.files.length, 'file')}` : '');
    if (note.render) return [[{ op: 'note.remove', id: note.id }], `asked for a render (${note.id}): ${note.at != null ? `the frame at ${clock(noteTime(b, note))} in ${name(s)}` : s ? name(s) : 'the whole film'}, ${renderLabel(note)}${withFiles}${said}`];
    return [[{ op: 'note.remove', id: note.id }], `wrote note ${note.id} about ${noteAbout(b, note, s)}${withFiles}${said}`];
  },

  'note.set'(b, op, c) {
    const n = b.notes[noteIndex(b, op.id)];
    const fields = obj(op.fields, 'fields');
    checkKeys(fields, NOTE_FIELDS, 'note.set');
    const old = {};
    for (const [k, v] of Object.entries(fields)) {
      if (n.soundtrack && v && ['scene', 'pin', 'markup'].includes(k)) throw new Error(`a soundtrack note has no ${k}: it is about the soundtrack`);
      if (n.render && v != null && ['pin', 'markup'].includes(k)) throw new Error(`a render request has no ${k}: it is for the whole film, a scene or one frame`);
      old[k] = structuredClone(n[k] ?? null);
      if (k === 'text') { n.text = str(v).trim(); if (!n.text && !n.files?.length && !(fields.markup ?? n.markup)?.marks?.length && !n.render) throw new Error('a note needs text, a file or marks'); }
      else if (k === 'resolved') { n.resolved = !!v; n.resolvedBy = n.resolved ? c.author || null : null; if (n.resolved) n.working = null; }
      else if (k === 'working') n.working = v ? c.now : null;
      else if (k === 'scene') { if (v && !findScene(b, v)) throw new Error(noScene(b, v)); n.scene = v || null; }
      else if (k === 'at') n.at = v == null ? null : round6(seconds(b, v, 'at', n.soundtrack ? 'position' : 'length'));
      else if (k === 'pin') n.pin = cleanPin(v);
      else if (k === 'markup') { n.markup = cleanMarkup(v); if (!n.markup) delete n.markup; }
    }
    const keys = Object.keys(fields);
    op.fields = Object.fromEntries(keys.map(k => [k, n[k]]));
    const text = keys.length === 1 && keys[0] === 'resolved' ? `${n.resolved ? 'resolved' : 'reopened'} ${n.id}`
      : keys.length === 1 && keys[0] === 'working' ? `${n.working ? 'started work on' : 'stopped work on'} ${n.id}`
      : `edited ${n.id} (${list(keys)})`;
    return [[{ op: 'note.set', id: n.id, fields: old }], text];
  },

  'note.remove'(b, op) {
    const i = noteIndex(b, op.id);
    const [n] = b.notes.splice(i, 1);
    return [[{ op: 'note.add', note: n, index: i, restore: true }], `deleted ${n.id}`];
  },

  // The user hands their notes over, and the changes they made themselves since they last sent (op.edits,
  // as was → now): marks the notes sent, which wakes agents waiting with on=send.
  'notes.send'(b, op, c) {
    const ids = op.ids != null ? (Array.isArray(op.ids) ? op.ids : fail0('ids must be a list of note ids'))
      : b.notes.filter(n => n.author === 'you' && !n.sent && !n.resolved).map(n => n.id);
    const edits = editList(b);
    if (!ids.length && !edits.length) throw new Error('there are no unsent notes or changes to send');
    const old = {};
    for (const id of ids) {
      const n = b.notes[noteIndex(b, id)];
      old[id] = n.sent ?? null;
      n.sent = c.now;
    }
    const inv = { op: 'notes.unsend', sent: old };
    if (b.edits) { inv.edits = b.edits; delete b.edits; }
    op.ids = ids;
    if (edits.length) op.edits = edits;
    else delete op.edits;
    if (op.message != null) op.message = str(op.message).trim();
    const what = list([ids.length && plural(ids.length, 'note'), edits.length && plural(edits.length, 'change')].filter(Boolean));
    return [[inv], `sent ${what} to Claude${ids.length ? ` (${ids.join(', ')})` : ''}${op.message ? `: “${clip(op.message, 90)}”` : ''}`];
  },

  // Takes a send back: the notes' earlier `sent`, and with `edits` the changes that were waiting then.
  'notes.unsend'(b, op) {
    const sent = obj(op.sent, 'sent');
    const old = {};
    for (const [id, v] of Object.entries(sent)) {
      const n = b.notes[noteIndex(b, id)];
      old[id] = n.sent ?? null;
      n.sent = v;
    }
    const inv = { op: 'notes.unsend', sent: old };
    if (op.edits !== undefined) {
      inv.edits = b.edits ?? null;
      if (op.edits) b.edits = obj(op.edits, 'edits');
      else delete b.edits;
    }
    return [[inv], `took back ${Object.keys(sent).length} sent note(s)`];
  },

  // A read receipt: an agent has been given these notes (the server writes it, not the agent).
  // With `read` (id → {at, by}) it restores earlier receipts instead; that's its own inverse.
  'notes.read'(b, op, c) {
    const old = {};
    const keep = n => ({ at: n.read ?? null, by: n.readBy ?? null });
    if (op.read != null) {
      for (const [id, v] of Object.entries(obj(op.read, 'read'))) {
        const n = b.notes[noteIndex(b, id)];
        old[id] = keep(n);
        n.read = v?.at ?? null;
        n.readBy = v?.by ?? null;
      }
      return [[{ op: 'notes.read', read: old }], `restored read receipts on ${Object.keys(old).join(', ')}`];
    }
    const ids = Array.isArray(op.ids) ? op.ids : fail0('ids must be a list of note ids');
    for (const id of ids) {
      const n = b.notes[noteIndex(b, id)];
      old[id] = keep(n);
      n.read = c.now;
      n.readBy = c.author;
    }
    return [[{ op: 'notes.read', read: old }], `read ${plural(ids.length, 'note')} (${ids.join(', ')})`];
  },

  'reply.add'(b, op, c) {
    const n = b.notes[noteIndex(b, op.note)];
    const r = obj(op.reply, 'reply');
    checkKeys(r, OBJ_KEYS.reply, 'reply');
    const reply = { author: r.author || c.author, text: str(r.text).trim(), created: r.created || c.now };
    const files = cleanFiles(r.files, 'reply');
    if (files.length) reply.files = files;
    if (!reply.text && !files.length) throw new Error('a reply needs text or a file');
    op.reply = reply;
    const i = Number.isInteger(op.index) ? clamp(op.index, 0, n.replies.length) : n.replies.length;
    n.replies.splice(i, 0, reply);
    return [[{ op: 'reply.remove', note: n.id, index: i }], `replied on ${n.id}: “${clip(reply.text)}”`];
  },

  'reply.remove'(b, op) {
    const n = b.notes[noteIndex(b, op.note)];
    if (!n.replies[op.index]) throw new Error(`${n.id} has no reply ${op.index}`);
    const [reply] = n.replies.splice(op.index, 1);
    return [[{ op: 'reply.add', note: n.id, reply, index: op.index }], `deleted a reply on ${n.id}`];
  },

  'marker.add'(b, op) {
    const m = obj(op.marker, 'marker');
    checkKeys(m, OBJ_KEYS.marker, 'marker');
    const marker = { id: takeId(b, 'm', m.id, b.markers), t: round6(seconds(b, m.t, 't', 'position')), label: str(m.label) || 'Marker', color: color(m.color) };
    op.marker = marker;
    b.markers.push(marker);
    b.markers.sort((x, y) => x.t - y.t);
    return [[{ op: 'marker.remove', id: marker.id }], `added marker “${marker.label}” at ${clock(marker.t)}`];
  },

  'marker.set'(b, op) {
    const m = b.markers.find(x => x.id === op.id);
    if (!m) throw new Error(`no marker ${op.id}`);
    const fields = obj(op.fields, 'fields');
    checkKeys(fields, MARKER_FIELDS, 'marker.set');
    const old = {};
    for (const [k, v] of Object.entries(fields)) {
      old[k] = m[k] ?? null;
      m[k] = k === 't' ? round6(seconds(b, v, 't', 'position')) : k === 'label' ? str(v) : color(v);
    }
    b.markers.sort((x, y) => x.t - y.t);
    op.fields = Object.fromEntries(Object.keys(fields).map(k => [k, m[k]]));
    return [[{ op: 'marker.set', id: m.id, fields: old }], `changed marker “${m.label}”`];
  },

  'marker.remove'(b, op) {
    const i = b.markers.findIndex(x => x.id === op.id);
    if (i < 0) throw new Error(`no marker ${op.id}`);
    const [m] = b.markers.splice(i, 1);
    return [[{ op: 'marker.add', marker: m }], `removed marker “${m.label}”`];
  },

  'audio.set'(b, op) {
    const old = b.audio;
    const a = op.audio;
    if (a != null) {
      obj(a, 'audio');
      checkKeys(a, OBJ_KEYS.audio, 'audio');
      if (!a.file) throw new Error('audio needs a file');
    }
    b.audio = a ?? null;
    return [[{ op: 'audio.set', audio: old }], a ? `set the soundtrack to ${a.name || a.file}` : 'removed the soundtrack'];
  },

  'sound.set'(b, op) {
    const old = b.sound ?? null;
    const x = op.sound;
    if (x != null) {
      obj(x, 'sound');
      checkKeys(x, OBJ_KEYS.sound, 'sound');
      if (!Array.isArray(x.layers) || !x.layers.length) throw new Error('sound needs its layers');
      // the files are the board's own (sb sound / POST /sound put them there): never a path out of its media
      const inMedia = (f, what) => { if (typeof f !== 'string' || !/^media\/sound\//.test(f) || f.split('/').includes('..')) throw new Error(`${what}: a file in the board's media/sound (put the layers on with POST /sound)`); };
      x.layers.forEach((l, i) => {
        obj(l, `sound.layers[${i}]`);
        checkKeys(l, OBJ_KEYS.soundLayer, `sound.layers[${i}]`);
        if (!l.id || !/^[\w.-]+$/.test(String(l.id)) || !l.file) throw new Error(`sound.layers[${i}] needs an id (letters, digits, - _ .) and a file`);
        inMedia(l.file, `sound.layers[${i}].file`);
        if (l.peaks != null) inMedia(l.peaks, `sound.layers[${i}].peaks`);
      });
      if (!x.events) throw new Error('sound needs its events (the file that lists every sound)');
      inMedia(x.events, 'sound.events');
    }
    b.sound = x ?? null;
    return [[{ op: 'sound.set', sound: old }], x ? `set the soundtrack's layers: ${x.name || 'its parts'} (${plural(x.layers.length, 'layer')}, ${plural(x.count || 0, 'sound')})` : "removed the soundtrack's layers"];
  },
};

// ---------------------------------------------------------------- cleaning

function cleanScene(b, s, c) {
  checkKeys(s, OBJ_KEYS.scene, 'scene');
  const scene = {
    id: takeId(b, 's', s.id, b.scenes),
    title: sceneTitle(s.title),
    duration: dur(b, s.duration ?? defaultDuration(b)),
    picture: str(s.picture),
    sound: str(s.sound),
    status: STATUSES.includes(s.status) ? s.status : 'idea',
    color: color(s.color),
    renders: [],
    activeRender: null,
    meta: s.meta && typeof s.meta === 'object' ? s.meta : {},
    ...(s.render != null && s.render !== '' ? { render: sceneRenderField(b, {}, s.render) } : {}),
    author: s.author || c.author,
    created: s.created || c.now,
  };
  for (const r of Array.isArray(s.renders) ? s.renders : []) scene.renders.push(cleanRender(b, r, c));
  const ids = scene.renders.map(r => r.id);
  scene.activeRender = ids.includes(s.activeRender) ? s.activeRender : ids.at(-1) ?? null;
  return scene;
}

function cleanRender(b, r, c) {
  checkKeys(r, OBJ_KEYS.render, 'render');
  if (!r.file) throw new Error('a render needs a file');
  const all = b.scenes.flatMap(s => s.renders);
  return {
    id: takeId(b, 'r', r.id, all),
    kind: ['video', 'code'].includes(r.kind) ? r.kind : 'image',
    sketch: !!r.sketch || r.kind === 'sketch',
    file: r.file,
    poster: r.poster || null,
    strip: r.strip || null,
    stripFrames: r.stripFrames || 0,
    duration: r.duration ?? null,
    width: r.width ?? null,
    height: r.height ?? null,
    caption: str(r.caption ?? r.note),
    source: r.source || null,
    sourceMtime: r.sourceMtime ?? null,
    drawn: r.drawn ?? null,
    author: r.author || c.author,
    created: r.created || c.now,
    ...(r.meta != null ? { meta: r.meta } : {}), // how it was made, e.g. {"cmd": "…"}
  };
}

// The canvas sketches are drawn on: 1600 wide, at the board's aspect.
export const sketchCanvas = b => ({ w: 1600, h: Math.round((1600 * b.height) / b.width) });

// A shape (width over height) fitted inside a standard frame, turned upright for a portrait shape,
// with even sides: 16:9 in 1920×1080 is 1920×1080, 1:1 is 1080×1080, 4:5 is 1080×1350.
function fitFrame(ratio, w, h) {
  const [W, H] = ratio < 1 ? [h, w] : [w, h];
  const fh = Math.min(W / ratio, H);
  return { w: Math.round((fh * ratio) / 2) * 2, h: Math.round(fh / 2) * 2 };
}

// The frame size of a render the user asks for (RENDER_SIZES), in the board's shape.
export const renderSize = (b, size) => fitFrame(b.width / b.height, RENDER_SIZES[size].w, RENDER_SIZES[size].h);

// A shape as given ("16:9", "2.39:1", "3/2" or 1.85), as width over height.
function aspectRatio(v) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(v));
  const r = m ? +m[1] / +m[2] : Number(v);
  if (!(r >= 0.2 && r <= 5)) throw new Error(`aspect: give a shape like ${ASPECTS.join(', ')} (or any "w:h")`);
  return r;
}

// The reference frame a board keeps for a shape: its 1080p frame.
export const aspectFrame = v => fitFrame(aspectRatio(v), 1920, 1080);

// A board's shape in words: one of ASPECTS when it's that, or else the ratio ("1.5:1").
export function aspectName(b) {
  const r = b.width / b.height;
  return ASPECTS.find(a => Math.abs(aspectRatio(a) / r - 1) < 0.01) || (r >= 1 ? `${+r.toFixed(2)}:1` : `1:${+(1 / r).toFixed(2)}`);
}

// A render request's quality: as asked, or for one from before quality was a choice, what its size meant.
export const renderQuality = r => r.quality ?? (r.size === '720p' ? 'draft' : 'final');
// How a request's file comes: a frame is a PNG still; a final 4K clip is the master.
export const renderCodec = (r, still) => (still ? 'PNG' : r.size === '4k' && renderQuality(r) === 'final' ? '10-bit HEVC (the master)' : 'H.264');
// A request in a few words: "4K final", "720p draft", "4K final still".
export const renderLabel = n => `${RENDER_SIZES[n.render.size].label} ${renderQuality(n.render)}${n.at != null ? ' still' : ''}`;

// What a render request asks for, for this board: "4K final: 3840×2160 at 30 fps, final quality (ray
// marched, 64 samples a pixel), 10-bit HEVC (the master)". A note with "at" asks for that one frame, as a still.
export function renderWords(b, n) {
  const r = n.render, { w, h } = renderSize(b, r.size), still = n.at != null;
  const s = n.scene ? b.scenes.find(x => x.id === n.scene) : null;
  return `${renderLabel(n)}: ${still ? `one ${w}×${h} still` : `${w}×${h} at ${+b.fps} fps`}, ${qualityWords(b, renderQuality(r), s)}, ${renderCodec(r, still)}`;
}

// A quality as a scene means it, from how it is made: "final quality (ray marched, 64 samples a pixel)"; until
// that's decided, "final quality" or "draft quality (quick settings)". The whole film (no scene) says the same
// when every scene is made the same way, and otherwise names the ways: "final quality, each scene its own way
// (raster, edit and ray traced), cut together".
export function qualityWords(b, q, s = null) {
  let r;
  if (s) r = sceneRender(b, s);
  else {
    const rs = b.scenes.map(x => sceneRender(b, x)), key = x => (x ? `${x.type}\n${x[q] || ''}` : '');
    if (rs.some(x => key(x) !== key(rs[0]))) return `${q} quality, each scene its own way (${list(filmRenderTypes(b).map(typeLabel))}), cut together`;
    r = rs[0] || null;
  }
  const how = (r ? [typeLabel(r.type), r[q]] : [renderTypeName(b), b.render?.[q]]).filter(Boolean);
  if (!how[1] && q === 'draft') how.push('quick settings');
  return `${q} quality${how.length ? ` (${how.join(', ')})` : ''}`;
}

// Where a moment falls in the music, on a board with a bpm: the bar (from 1) and the beat in it (from 1).
export function barBeat(b, t) {
  if (!b.bpm) return null;
  const per = b.beatsPerBar || 4, beats = (t - (b.beatOffset || 0)) / (60 / b.bpm);
  return { bar: Math.floor(beats / per) + 1, beat: +((((beats % per) + per) % per) + 1).toFixed(2) };
}

export const defaultDuration = b => (b.bpm ? snapFrame(b, (60 / b.bpm) * (b.beatsPerBar || 4)) : 2);

function boardField(k, v) {
  if (k === 'title') return str(v).trim() || 'Untitled';
  if (k === 'brief' || k === 'project' || k === 'treatment' || k === 'owner') return str(v).trim();
  if (k === 'sketchLib') return v ? str(v) : null;
  if (k === 'archived') return !!v;
  if (k === 'render') return renderField(v);
  if (k === 'fps') return num(v, 'fps', 1, 240);
  if (k === 'width' || k === 'height') return Math.round(num(v, k, 16, 16384));
  // 0 clears the tempo, as a number from the editor or as "0" from `sb board bpm=0`
  if (k === 'bpm') return v == null || v === '' || Number(v) === 0 ? null : num(v, 'bpm', 20, 400);
  if (k === 'beatOffset') return round6(num(v ?? 0, 'beatOffset', -60, 60));
  if (k === 'beatsPerBar') return Math.round(num(v ?? 4, 'beatsPerBar', 1, 16));
}

// How the film is rendered (RENDER_TYPES), or null: not decided yet. The type may be a list, the main one
// first, for a film that mixes methods; draft and final say what each quality means in this film.
function renderType(t) {
  const k = String(t).toLowerCase().replace(/[\s._-]+/g, '');
  const type = RENDER_TYPES[k] ? k : RENDER_ALIASES[k];
  if (!type) throw new Error(`render.type: "${t}" isn't one of ${Object.keys(RENDER_TYPES).join(', ')}`);
  return type;
}
function renderField(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') v = { type: v };
  checkKeys(obj(v, 'render'), OBJ_KEYS.boardRender, 'render');
  const types = [v.type].flat().filter(t => t != null && t !== '').map(renderType);
  if (!types.length) throw new Error(`render.type: give one of ${Object.keys(RENDER_TYPES).join(', ')}, or a list of them`);
  const out = { type: [...new Set(types)] };
  for (const q of RENDER_QUALITIES) if (str(v[q]).trim()) out[q] = str(v[q]).trim();
  return out;
}

// How a board's film is rendered by default (for scenes that don't say), in words: "ray marched", "ray
// marched and raster"; '' when not decided.
export const renderTypeName = b => list((b.render?.type || []).map(typeLabel));
const typeLabel = t => (t === '2d' ? '2D' : RENDER_TYPES[t].label.toLowerCase());

// How one scene is made: each scene is its own little movie. `type` (one of RENDER_TYPES), what `draft` and
// `final` mean for it, the `cmd` that renders it, its own `fps` when it isn't the film's (the cut conforms it),
// and for an edit the `source` footage it is cut from. null: the scene renders as the film's default does.
// A render with a type replaces the scene's; one without (just "final", say) changes those fields and keeps the
// rest; a field given as null or '' is taken away.
function sceneRenderField(b, s, v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') v = { type: v };
  checkKeys(obj(v, 'render'), OBJ_KEYS.sceneRender, 'render');
  let out;
  if (v.type != null && v.type !== '') {
    const t = [v.type].flat();
    if (t.length !== 1) throw new Error('render.type: a scene is made one way: give one type (the film mixes them, scene by scene)');
    out = { type: renderType(t[0]) };
  } else {
    const was = s.render ? { ...s.render } : defaultSceneRender(b);
    if (!was?.type) throw new Error(`render.type: say how this scene is made: one of ${Object.keys(RENDER_TYPES).join(', ')}`);
    out = { ...was };
    delete out.own;
  }
  for (const k of ['draft', 'final', 'cmd', 'source']) {
    if (!(k in v)) continue;
    const t = v[k] == null ? '' : str(v[k]).trim();
    if (t) out[k] = t;
    else delete out[k];
  }
  if ('fps' in v) {
    if (v.fps == null || v.fps === '') delete out.fps;
    else out.fps = num(v.fps, 'render.fps', 1, 240);
  }
  return out;
}

// What a scene with no render of its own gets from the board: its type when the board names just one (a
// board that lists several leaves it undecided), and what draft and final mean.
function defaultSceneRender(b) {
  if (b.render?.type?.length !== 1) return null;
  const r = { type: b.render.type[0] };
  for (const q of RENDER_QUALITIES) if (b.render[q]) r[q] = b.render[q];
  return r;
}

// How a scene is made, its own or the film's default ({…, own: false}); null while it isn't decided.
export function sceneRender(b, s) {
  if (s.render) return { ...s.render, own: true };
  const d = defaultSceneRender(b);
  return d ? { ...d, own: false } : null;
}

// The ways the film is made, scene by scene, in the order they first come (the board's default when no
// scene has one): ['raster', 'edit', 'raytrace'].
export function filmRenderTypes(b) {
  const seen = [];
  for (const s of b.scenes) { const t = sceneRender(b, s)?.type; if (t && !seen.includes(t)) seen.push(t); }
  return seen.length ? seen : b.render?.type || [];
}
export const filmRenderName = b => list(filmRenderTypes(b).map(typeLabel));
export const sceneRenderName = r => (r ? typeLabel(r.type) : '');

// The film at a size and quality is the cut of its scenes, each its own movie. For each scene: the version that
// can be cut in as it is (a clip or a still, not a sketch, at least that size, rendered at that quality: a final
// needs one rendered at final quality, or footage, from an edit or a capture), or, when none can, what it has.
// Only the version that plays, or one newer than it (a final put on after the draft): an older one may not show
// the scene as it is now.
export function cutPlan(b, size, quality) {
  const { w, h } = renderSize(b, size);
  return layout(b).map(({ scene: s, index, start, end }) => {
    const how = sceneRender(b, s);
    const big = r => (r.width || 0) >= w * 0.98 - 1 && (r.height || 0) >= h * 0.98 - 1;
    const good = r => quality === 'draft' || r.meta?.quality === 'final' || (r.meta?.quality == null && FOOTAGE.includes(how?.type));
    const fits = r => !r.sketch && (r.kind === 'video' || r.kind === 'image') && big(r) && good(r);
    const from = Math.max(0, s.renders.findIndex(r => r.id === s.activeRender));
    const ok = s.renders.slice(from).filter(fits);
    const render = ok.find(r => r.id === s.activeRender) || ok.at(-1) || null;
    return { scene: s, index, start, end, how, render, active: activeRender(s), w, h, short: render?.kind === 'video' && render.duration != null && render.duration < s.duration - 1 / b.fps };
  });
}
// What a version is, for the cut: "1280×720 draft clip", "3840×2160 final still", "sketch".
export function versionWords(r) {
  if (!r) return 'nothing yet';
  if (r.sketch || r.kind === 'code') return kindName(r);
  return [r.width && `${r.width}×${r.height}`, r.meta?.quality, kindName(r)].filter(Boolean).join(' ');
}

// A scene's title is its name. The editor numbers scenes, so a number or id in front of the name
// ("s05 · ", "05 – ", "Scene 3: ") is dropped; "2001: A Space Odyssey" and "1:1 Square" stay.
const NUMBERED = /^(?:scene\s*|s)?\d{1,3}\s*[·.:\-–—|)]\s+/i;
const sceneTitle = v => str(v).trim().replace(NUMBERED, '').trim() || 'Untitled';

function sceneField(b, s, k, v) {
  if (k === 'title') return sceneTitle(v);
  if (k === 'duration') return dur(b, v);
  if (k === 'picture' || k === 'sound') return str(v);
  if (k === 'status') {
    if (!STATUSES.includes(v)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
    return v;
  }
  if (k === 'color') return color(v);
  if (k === 'activeRender') {
    if (v != null && !s.renders.some(r => r.id === v)) throw new Error(`${s.id} has no render ${v}`);
    return v ?? null;
  }
  if (k === 'meta') return v && typeof v === 'object' ? v : {};
  if (k === 'render') return sceneRenderField(b, s, v);
}

// Seconds from a number, or from musical time on a board with a bpm. A length is
// {"beats": n} and/or {"bars": n}; a position is {"beat": n} (counted from 0) or {"bar": n}
// (counted from 1, the bar's first beat).
export function seconds(b, v, what, kind = 'length') {
  if (v && typeof v === 'object') {
    const keys = kind === 'length' ? ['beats', 'bars'] : ['beat', 'bar'];
    checkKeys(v, keys, what);
    if (!b.bpm) throw new Error(`${what}: this board has no bpm, so give seconds`);
    const beat = 60 / b.bpm, per = b.beatsPerBar || 4;
    if (kind === 'length') return num(v.beats ?? 0, `${what}.beats`, 0, 1e6) * beat + num(v.bars ?? 0, `${what}.bars`, 0, 1e5) * per * beat;
    const off = b.beatOffset || 0;
    if (v.beat != null) return off + num(v.beat, `${what}.beat`, 0, 1e6) * beat;
    if (v.bar != null) return off + (num(v.bar, `${what}.bar`, 1, 1e5) - 1) * per * beat;
    throw new Error(`${what}: give {"beat": n} or {"bar": n}`);
  }
  return num(v, what, 0, 36000);
}

function dur(b, v) {
  const d = snapFrame(b, Math.min(3600, seconds(b, v, 'duration', 'length')));
  return Math.max(d, snapFrame(b, 1 / b.fps));
}

// A label colour: "#rgb" or "#rrggbb", or null for none.
function color(v) {
  if (v == null || v === '') return null;
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v))) throw new Error(`color must be a hex colour like "#6f8ed6", or null (the editor's palette: ${COLORS.slice(1).join(', ')})`);
  return String(v).toLowerCase();
}

// "2 bars", "3 beats" or "2.5 beats" for a length, on a board with a bpm.
export function musical(b, d) {
  if (!b.bpm) return null;
  const beats = d / (60 / b.bpm), per = b.beatsPerBar || 4;
  const near = x => Math.abs(x - Math.round(x)) < 0.02;
  if (near(beats / per)) { const n = Math.round(beats / per); return plural(n, 'bar'); }
  if (near(beats)) { const n = Math.round(beats); return plural(n, 'beat'); }
  return plural(+beats.toFixed(2), 'beat');
}

// Marks drawn on a frame (the editor's annotator): boxes, brush strokes, arrows and points, each with
// optional words, in fractions of the frame (0–1). w × h is the board's size when they were drawn;
// image is the frame with the marks on it, frame the bare frame (both in the board's media).
const MARK_KINDS = ['rect', 'stroke', 'arrow', 'point'];
function cleanMarkup(m) {
  if (m == null) return null;
  checkKeys(obj(m, 'markup'), OBJ_KEYS.markup, 'markup');
  if (!Array.isArray(m.marks)) throw new Error('markup.marks must be a list');
  if (m.marks.length > 60) throw new Error('markup: at most 60 marks');
  const u = (v, k) => {
    const x = Number(v);
    if (!Number.isFinite(x)) throw new Error(`markup: ${k} must be a number (a fraction of the frame, 0–1)`);
    return Math.round(clamp(x, 0, 1) * 1e4) / 1e4;
  };
  const media = (v, k) => {
    if (v == null) return null;
    if (typeof v !== 'string' || !v.startsWith('media/')) throw new Error(`markup.${k} must be a path inside the board's media folder`);
    return v;
  };
  const marks = m.marks.map((k, i) => {
    const where = `markup.marks[${i}]`;
    checkKeys(obj(k, where), OBJ_KEYS.mark, where);
    if (!MARK_KINDS.includes(k.kind)) throw new Error(`${where}.kind must be one of ${MARK_KINDS.join(', ')}`);
    const out = { n: i + 1, kind: k.kind, color: color(k.color) || MARK_COLORS[0], text: str(k.text).trim() };
    if (k.kind === 'rect') Object.assign(out, { x: u(k.x, 'x'), y: u(k.y, 'y'), w: u(k.w, 'w'), h: u(k.h, 'h') });
    else if (k.kind === 'point') Object.assign(out, { x: u(k.x, 'x'), y: u(k.y, 'y') });
    else if (k.kind === 'arrow') Object.assign(out, { x1: u(k.x1, 'x1'), y1: u(k.y1, 'y1'), x2: u(k.x2, 'x2'), y2: u(k.y2, 'y2') });
    else {
      if (!Array.isArray(k.points) || k.points.length < 2) throw new Error(`${where}.points: a stroke needs at least two [x, y] points`);
      out.points = k.points.slice(0, 4000).map((p, j) => [u(p?.[0], `points[${j}][0]`), u(p?.[1], `points[${j}][1]`)]);
    }
    return out;
  });
  const size = (v, k) => (v == null ? null : Math.round(num(v, `markup.${k}`, 1, 16384)));
  return { render: m.render == null ? null : str(m.render), w: size(m.w, 'w'), h: size(m.h, 'h'), image: media(m.image, 'image'), frame: media(m.frame, 'frame'), marks };
}

// A note's render request: {"size": "4k" | "1080p" | "720p", "quality": "draft" | "final"}, or just the
// size (720p is a draft by default, the others final).
function renderRequest(v) {
  const r = typeof v === 'string' ? { size: v } : obj(v, 'render');
  checkKeys(r, OBJ_KEYS.renderRequest, 'render');
  if (!RENDER_SIZES[r.size]) throw new Error(`render: size must be one of ${Object.keys(RENDER_SIZES).join(', ')}`);
  if (r.quality != null && !RENDER_QUALITIES.includes(r.quality)) throw new Error(`render: quality must be ${RENDER_QUALITIES.join(' or ')}`);
  return { size: r.size, quality: renderQuality(r) };
}

function cleanPin(p) {
  if (p == null) return null;
  obj(p, 'pin');
  checkKeys(p, OBJ_KEYS.pin, 'pin');
  const x = num(p.x, 'pin.x', 0, 1), y = num(p.y, 'pin.y', 0, 1);
  return { x: round6(x), y: round6(y) };
}

function takeId(b, kind, given, existing) {
  if (given) {
    if (existing.some(x => x.id === given)) throw new Error(`id ${given} already exists`);
    const n = parseInt(String(given).slice(1), 10);
    if (Number.isFinite(n) && n >= b.nextId[kind]) b.nextId[kind] = n + 1;
    return given;
  }
  return kind + b.nextId[kind]++;
}

function position(b, op) {
  if (op.after != null) return sceneIndex(b, op.after) + 1;
  if (op.before != null) return sceneIndex(b, op.before);
  if (Number.isInteger(op.index)) return clamp(op.index, 0, b.scenes.length);
  return b.scenes.length;
}

function sceneIndex(b, id) {
  const i = b.scenes.findIndex(s => s.id === id);
  if (i < 0) throw new Error(noScene(b, id));
  return i;
}

function noteIndex(b, id) {
  const i = b.notes.findIndex(n => n.id === id);
  if (i < 0) throw new Error(`no note ${id} (notes: ${b.notes.map(n => n.id).join(', ') || 'none'})`);
  return i;
}

function num(v, what, min, max) {
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n)) throw new Error(`${what} must be a number`);
  return Math.min(max, Math.max(min, n));
}

function obj(v, what) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`"${what}" must be an object`);
  return v;
}

const str = v => (v == null ? '' : String(v));

// The sounds a note is about, as the sound view sent them: which sound (its id and layer), when, how long, its
// pitch and what it is for, so the agent can find it in the score.
function cleanSounds(v) {
  if (!Array.isArray(v) || !v.length) throw new Error('sounds: a list of the sounds the note is about');
  if (v.length > 64) throw new Error('sounds: at most 64 in one note');
  return v.map((x, i) => {
    obj(x, `sounds[${i}]`);
    checkKeys(x, OBJ_KEYS.noteSound, `sounds[${i}]`);
    if (!x.id || !x.layer) throw new Error(`sounds[${i}] needs its id and layer`);
    return {
      id: str(x.id), layer: str(x.layer), t: round6(num(x.t ?? 0, 't', 0, 86400)),
      dur: x.dur == null ? null : round6(num(x.dur, 'dur', 0, 3600)),
      note: x.note == null || x.note === '' ? null : str(x.note), label: str(x.label).trim(),
      // the version of the score it was picked in (its events file), so the user can hear it as it was
      ...(typeof x.set === 'string' && /^media\/sound\/[\w-]+\/events\.json$/.test(x.set) ? { set: x.set } : {}),
    };
  });
}
// A note's sounds in words: "glass-b07-1 (glass, A5, 12.35 s for 0.8 s: pling, the letters spring out)".
export const soundWords = x => `${x.id} (${[x.layer, x.note].filter(Boolean).join(', ')}, ${secs(x.t)}${x.dur != null ? ` for ${secs(x.dur)}` : ''}${x.label ? `: ${x.label}` : ''})`;
const fail0 = m => { throw new Error(m); };
// What a note is about, in words: one frame, a whole scene, or the board.
function noteAbout(b, n, s = findScene(b, n.scene)) {
  if (n.sounds?.length) return `${n.sounds.length === 1 ? 'a sound' : `${n.sounds.length} sounds`} in the soundtrack at ${clock(n.at ?? n.sounds[0].t)}: ${n.sounds.slice(0, 6).map(soundWords).join('; ')}${n.sounds.length > 6 ? `; and ${n.sounds.length - 6} more` : ''}`;
  if (n.soundtrack && n.to != null) return `the soundtrack from ${clock(n.at)} to ${clock(n.to)}`;
  if (n.soundtrack) return n.at == null ? 'the whole soundtrack' : `the soundtrack at ${clock(n.at)}`;
  if (!n.scene) return 'the whole film';
  if (!s) return `a deleted scene (${n.scene})`;
  if (n.at == null) return `the whole scene ${name(s)}`;
  const t = sceneStart(b, s.id) + n.at;
  return `the frame at ${clock(t)} (frame ${Math.round(t * b.fps)} of the cut, +${secs(n.at)} into ${name(s)})${n.pin ? ', with a spot marked' : ''}`;
}

// Near-miss shapes agents send, read the way they were meant: a set op's fields given beside it
// ({"op":"note.set","id":"n2","working":true}), and a reply's or note's content given beside it
// ({"op":"reply.add","note":"n2","text":"…"}). Anything else unknown is still refused.
const SET_FIELDS = { 'board.set': BOARD_FIELDS, 'scene.set': SCENE_FIELDS, 'note.set': NOTE_FIELDS, 'marker.set': MARKER_FIELDS };
const CONTENT = { 'reply.add': ['reply', 'reply'], 'note.add': ['note', 'note'] };
function shorthand(raw) {
  const allowed = ['op', ...OP_KEYS[raw.op]];
  const extra = Object.keys(raw).filter(k => !allowed.includes(k));
  if (!extra.length) return raw;
  const op = { ...raw };
  const move = (into, keys) => { op[into] = { ...(op[into] || {}) }; for (const k of keys) { op[into][k] = op[k]; delete op[k]; } };
  if (SET_FIELDS[op.op] && extra.every(k => SET_FIELDS[op.op].includes(k))) move('fields', extra);
  else if (CONTENT[op.op] && extra.every(k => OBJ_KEYS[CONTENT[op.op][1]].includes(k))) move(CONTENT[op.op][0], extra);
  return op;
}

// Files attached to a note or reply: already saved in the board's media/refs (the API and sb copy a
// {"path"} there before the op is applied).
function cleanFiles(v, where) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new Error(`${where}.files must be a list`);
  return v.map((f, i) => {
    if (f?.path != null) throw new Error(`${where}.files[${i}]: {"path"} files are copied in by the agent API or sb; send the op through one of them`);
    checkKeys(f, OBJ_KEYS.file, `${where}.files[${i}]`);
    if (typeof f.file !== 'string' || !f.file.startsWith('media/')) throw new Error(`${where}.files[${i}].file must be a path inside the board's media folder`);
    return { ...f, name: str(f.name) || f.file.split('/').pop(), kind: f.kind || 'file' };
  });
}

// What an agent still has to fill in for the board to say what the film is and where it stands.
// Board reads, write answers and wait answers all list it, until it's done.
export function boardGaps(b) {
  const out = [];
  const missing = ['owner', 'project', 'brief', 'treatment'].filter(k => !String(b[k] ?? '').trim());
  if (b.title === 'Untitled') missing.unshift('title'); // made without one: the agent names it
  if (missing.length) out.push(`board ${missing.join(', ')}`);
  const count = (f, what) => {
    const ids = b.scenes.filter(f).map(s => s.id);
    if (ids.length) out.push(`${what} on ${ids.length > 6 ? `${ids.length} scenes` : ids.join(', ')}`);
  };
  count(s => !s.picture?.trim(), 'picture text');
  count(s => !s.sound?.trim(), 'sound text (what we hear, or "silence")');
  count(s => s.status === 'idea' && s.renders.some(r => !r.sketch), 'a status past idea (it has a render)');
  // A scene marked review or approved is finished: the board should play its render, not a sketch or its card.
  count(s => ['review', 'approved'].includes(s.status) && (r => !r || r.sketch || r.kind === 'code')(activeRender(s)), 'a render to play (its status says it is finished, but it plays a sketch or its card: put its preview on)');
  // Decided by the time a scene has a real render (not a sketch): how it is made, and what draft and final mean.
  count(s => !sceneRender(b, s) && s.renders.some(r => !r.sketch && r.kind !== 'code'), 'how it is made (its render: type, what draft and final mean, the command)');
  count(s => NUMBERED.test(s.title), 'a title without its number (the editor numbers scenes: set the title again and the number goes)');
  return out;
}

// Where a note stands: draft (the user hasn't sent it), sent, read, working, replied, agent (an agent
// wrote it to the user) or done.
export function noteState(n) {
  if (n.resolved) return 'done';
  if (n.author === 'you' && !n.sent) return 'draft';
  const last = n.replies.at(-1);
  const answered = last && last.author !== 'you';
  // A reply written after work started is news; before that, the work is.
  if (n.working && !(answered && last.created > n.working)) return 'working';
  if (answered) return 'replied';
  if (n.author === 'you') return n.read ? 'read' : 'sent';
  return 'agent';
}

// A note waiting on the user: an agent replied (after any work it marked), or an agent wrote it.
export const forYou = n => ['replied', 'agent'].includes(noteState(n));

// What a version is, in words: its medium, and whether it's a sketch rather than a render.
export const kindName = r => {
  if (r.kind === 'code') return 'code sketch';
  if (r.sketch || r.kind === 'sketch') return r.kind === 'video' ? 'sketch clip' : 'sketch';
  return r.kind === 'video' ? 'clip' : 'still';
};
const clamp = (x, a, z) => Math.min(z, Math.max(a, x));
const name = s => `${s.id} “${s.title}”`;
const clip = (t, n = 60) => (t.length > n ? t.slice(0, n - 1) + '…' : t).replace(/\s+/g, ' ');
const list = a => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);

function where(b, i, prep = 'at') {
  if (b.scenes.length === 1) return '';
  if (i === 0) return ` ${prep} the start`;
  if (i === b.scenes.length - 1) return ` ${prep} the end`;
  return ` after ${name(b.scenes[i - 1])}`;
}
