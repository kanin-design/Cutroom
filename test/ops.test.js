// The board model: every change is an op, and every op's inverse undoes it exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newBoard, applyOps, layout, locate, noteTime, noteState, sceneColors, boardGaps, forYou, timecode, parseTimecode, clock, seconds,
  snapFrame, fitDuration, kindName, musical, createdIds, plural, renderSize, renderWords, renderTypeName, barBeat, aspectFrame, aspectName, COLORS, MARK_COLORS,
} from '../lib/ops.js';

const ctx = { author: 'claude', now: '2026-10-01T12:00:00.000Z' };
const apply = (b, ops, c = ctx) => applyOps(b, ops, c).board;

function sample() {
  return apply(newBoard({ title: 'Test', fps: 30, bpm: 120 }), [
    { op: 'scene.add', scene: { title: 'One', duration: 2 } },
    { op: 'scene.add', scene: { title: 'Two', duration: 1.5, picture: 'A dot', sound: 'Kick' } },
    { op: 'scene.add', scene: { title: 'Three', duration: 2.5, color: '#6f8ed6' } },
  ]);
}

// What a board says, without the counters that only ever go up. A new board has no owner or
// archived field, and undoing the first change to one leaves it empty, which means the same.
const content = b => {
  const { rev, nextId, ...rest } = b;
  if (rest.owner === '') delete rest.owner;
  if (rest.archived === false) delete rest.archived;
  return rest;
};

test('scenes play end to end', () => {
  const b = sample();
  assert.deepEqual(layout(b).map(r => [r.scene.id, r.start, r.end]), [['s1', 0, 2], ['s2', 2, 3.5], ['s3', 3.5, 6]]);
  const hit = locate(b, 3);
  assert.equal(hit.scene.id, 's2');
  assert.equal(hit.local, 1);
  assert.equal(locate(b, 99).scene.id, 's3', 'past the end is the last scene');
});

test('applyOps leaves its input alone and moves the rev by one a batch', () => {
  const b = sample();
  const before = structuredClone(b);
  const r = applyOps(b, [{ op: 'scene.set', id: 's1', fields: { title: 'Uno' } }, { op: 'scene.set', id: 's2', fields: { status: 'draft' } }], ctx);
  assert.deepEqual(b, before);
  assert.equal(r.board.rev, b.rev + 1);
  assert.equal(r.summaries.length, 2);
});

test('every op is undone exactly by its inverse', () => {
  let b = sample();
  b = apply(b, [
    { op: 'note.add', note: { scene: 's2', at: 1, text: 'Too dark', author: 'you' } },
    { op: 'marker.add', marker: { t: 2, label: 'Drop' } },
    { op: 'note.add', note: { soundtrack: true, at: 1.5, text: 'Kick too soft' } },
  ]);
  const batches = [
    [{ op: 'board.set', fields: { title: 'Renamed', brief: 'A film', bpm: 90, archived: true } }],
    [{ op: 'board.set', fields: { aspect: '9:16' } }],
    [{ op: 'board.set', fields: { render: { type: 'raymarch', final: '64 samples a pixel' } } }],
    [{ op: 'scene.set', id: 's1', fields: { title: 'Uno', duration: 3, status: 'review', color: '#c47a5a', meta: { cmd: 'x' } } }],
    [{ op: 'scene.move', id: 's3', before: 's1' }],
    [{ op: 'scene.split', id: 's3', at: 1 }],
    [{ op: 'scene.remove', id: 's2' }],
    [{ op: 'scene.add', scene: { title: 'New', duration: 1 }, after: 's1' }],
    [{ op: 'render.add', scene: 's1', render: { file: 'media/renders/a.png', kind: 'image', meta: { cmd: 'render a' } } }],
    [{ op: 'note.add', note: { scene: null, text: 'About the board' } }],
    [{ op: 'note.set', id: 'n1', fields: { resolved: true } }],
    [{ op: 'note.set', id: 'n1', fields: { working: true } }],
    [{ op: 'note.set', id: 'n1', fields: { text: 'Far too dark', at: 0.5 } }],
    [{ op: 'note.remove', id: 'n1' }],
    [{ op: 'note.add', note: { render: { size: '4k' } } }],
    [{ op: 'note.add', note: { scene: 's3', render: '720p', text: 'A quick look' } }],
    [{ op: 'note.add', note: { soundtrack: true, text: 'Too quiet overall' } }],
    [{ op: 'note.set', id: 'n2', fields: { at: { bar: 2 }, text: 'Kick far too soft' } }],
    [{ op: 'note.remove', id: 'n2' }],
    [{ op: 'reply.add', note: 'n1', reply: { text: 'On it' } }],
    [{ op: 'notes.send', ids: ['n1'] }],
    [{ op: 'notes.read', ids: ['n1'] }],
    [{ op: 'marker.set', id: 'm1', fields: { t: 4, label: 'Hit' } }],
    [{ op: 'marker.remove', id: 'm1' }],
    [{ op: 'audio.set', audio: { file: 'media/audio/a.wav', name: 'a.wav', duration: 6 } }],
  ];
  for (const ops of batches) {
    const r = applyOps(b, ops, ctx);
    const undone = apply(r.board, r.inverse);
    assert.deepEqual(content(undone), content(b), `undoing ${ops.map(o => o.op).join(', ')}`);
  }
});

test('a board has a shape: a ratio, with the 1080p frame of it as its reference', () => {
  const frames = Object.fromEntries(['16:9', '9:16', '1:1', '4:5', '4:3', '2.39:1', '3:2'].map(a => [a, aspectFrame(a)]).map(([a, f]) => [a, `${f.w}×${f.h}`]));
  assert.deepEqual(frames, { '16:9': '1920×1080', '9:16': '1080×1920', '1:1': '1080×1080', '4:5': '1080×1350', '4:3': '1440×1080', '2.39:1': '1920×804', '3:2': '1620×1080' });
  assert.equal(aspectName({ width: 1280, height: 720 }), '16:9');
  assert.equal(aspectName({ width: 2048, height: 858 }), '2.39:1');
  assert.equal(aspectName({ width: 1620, height: 1080 }), '1.5:1');
  assert.equal(aspectName({ width: 1080, height: 1620 }), '1:1.5');
  const b = newBoard({ title: 'Reel', aspect: '4:5' });
  assert.deepEqual([b.width, b.height], [1080, 1350]);
  const r = applyOps(b, [{ op: 'board.set', fields: { aspect: '1:1' } }], ctx);
  assert.deepEqual([r.board.width, r.board.height, r.summaries[0]], [1080, 1080, 'changed the board\'s shape (1:1)']);
  assert.deepEqual(r.inverse, [{ op: 'board.set', fields: { width: 1080, height: 1350 } }]);
  assert.throws(() => applyOps(b, [{ op: 'board.set', fields: { aspect: '16' } }], ctx), /aspect: give a shape like 16:9/);
});

test('render requests: the whole film, a scene or one frame, at a size and quality that follow the board', () => {
  assert.deepEqual(renderSize({ width: 1920, height: 1080 }, '4k'), { w: 3840, h: 2160 });
  assert.deepEqual(renderSize({ width: 1280, height: 720 }, '1080p'), { w: 1920, h: 1080 });
  assert.deepEqual(renderSize({ width: 1080, height: 1920 }, '720p'), { w: 720, h: 1280 }, 'portrait');
  assert.deepEqual(renderSize({ width: 2560, height: 1080 }, '4k'), { w: 3840, h: 1620 }, 'scope');
  assert.deepEqual(renderSize({ width: 1080, height: 1080 }, '1080p'), { w: 1080, h: 1080 }, 'square fits the 1080 frame');
  assert.deepEqual(renderSize({ width: 1080, height: 1350 }, '4k'), { w: 2160, h: 2700 }, '4:5 fits upright');
  assert.deepEqual(renderSize({ width: 1440, height: 1080 }, '720p'), { w: 960, h: 720 }, '4:3');
  const r = applyOps(sample(), [
    { op: 'note.add', note: { render: { size: '4k' } } },
    { op: 'note.add', note: { scene: 's2', render: '720p', text: 'A quick look' } },
    { op: 'note.add', note: { scene: 's2', at: 0.5, render: { size: '1080p', quality: 'draft' } } },
  ], { ...ctx, author: 'you' });
  const [film, shot, frame] = r.board.notes;
  assert.deepEqual([film.scene, film.render, film.text, film.sent], [null, { size: '4k', quality: 'final' }, '', null]);
  assert.deepEqual([shot.scene, shot.render, shot.text], ['s2', { size: '720p', quality: 'draft' }, 'A quick look'], '720p is a draft unless asked');
  assert.deepEqual([frame.scene, frame.at, frame.render], ['s2', 0.5, { size: '1080p', quality: 'draft' }]);
  assert.equal(r.summaries[0], 'asked for a render (n1): the whole film, 4K final (not sent yet)');
  assert.equal(r.summaries[1], 'asked for a render (n2): s2 “Two”, 720p draft (not sent yet)');
  assert.equal(r.summaries[2], 'asked for a render (n3): the frame at 0:02.50 in s2 “Two”, 1080p draft still (not sent yet)');
  assert.throws(() => applyOps(sample(), [{ op: 'note.add', note: { render: { size: '8k' } } }], ctx), /render: size must be one of 4k, 1080p, 720p/);
  assert.throws(() => applyOps(sample(), [{ op: 'note.add', note: { render: { size: '4k', quality: 'ultra' } } }], ctx), /render: quality must be draft or final/);
  assert.throws(() => applyOps(sample(), [{ op: 'note.add', note: { at: 1, render: '4k' } }], ctx), /a frame to render needs its scene/);
  assert.equal(apply(r.board, [{ op: 'note.set', id: 'n2', fields: { at: 1 } }]).notes[1].at, 1, 'a scene request can become a frame request');
});

test('soundtrack notes: a moment in the soundtrack, or the whole of it', () => {
  const r = applyOps(sample(), [
    { op: 'note.add', note: { soundtrack: true, at: { bar: 2 }, text: 'The drop lands late' } },
    { op: 'note.add', note: { soundtrack: true, text: 'Too quiet overall' } },
  ], ctx);
  const [moment, whole] = r.board.notes;
  assert.deepEqual([moment.soundtrack, moment.scene, moment.at], [true, null, 2], 'bar 2 at 120 bpm starts 2 s in');
  assert.equal(noteTime(r.board, moment), 2);
  assert.equal(noteTime(r.board, whole), null);
  assert.equal(r.summaries[0], 'wrote note n1 about the soundtrack at 0:02.00: “The drop lands late”');
  assert.equal(r.summaries[1], 'wrote note n2 about the whole soundtrack: “Too quiet overall”');
  assert.deepEqual(barBeat(r.board, 2.75), { bar: 2, beat: 2.5 });
  assert.throws(() => applyOps(sample(), [{ op: 'note.add', note: { soundtrack: true, scene: 's1', text: 'x' } }], ctx), /not a scene/);
  assert.throws(() => applyOps(sample(), [{ op: 'note.add', note: { soundtrack: true, at: 1, pin: { x: 0.5, y: 0.5 }, text: 'x' } }], ctx), /belong to a frame/);
  assert.throws(() => applyOps(r.board, [{ op: 'note.set', id: 'n1', fields: { scene: 's1' } }], ctx), /a soundtrack note has no scene/);
});

test('render meta is kept, on add and on set', () => {
  let b = apply(sample(), [{ op: 'render.add', scene: 's1', render: { file: 'media/renders/a.png', meta: { cmd: 'node render.js' } } }]);
  assert.deepEqual(b.scenes[0].renders[0].meta, { cmd: 'node render.js' });
  b = apply(b, [{ op: 'render.set', scene: 's1', id: 'r1', fields: { meta: { cmd: 'again' } } }]);
  assert.deepEqual(b.scenes[0].renders[0].meta, { cmd: 'again' });
});

test('unknown fields are refused, never dropped', () => {
  assert.throws(() => applyOps(sample(), [{ op: 'scene.add', scene: { titel: 'x' } }], ctx), /unknown field "titel".*did you mean "title"/);
  assert.throws(() => applyOps(sample(), [{ op: 'scene.set', id: 's1', fields: { titel: 'x' } }], ctx), /^Error: scene\.set: unknown field "titel" \(did you mean "title"\?\); allowed: title, duration,/);
  const marked = apply(sample(), [{ op: 'marker.add', marker: { t: 1, label: 'Drop' } }]);
  assert.throws(() => applyOps(marked, [{ op: 'marker.set', id: 'm1', fields: { lable: 'x' } }], ctx), /marker\.set: unknown field "lable" \(did you mean "label"\?\)/);
  const noted = apply(sample(), [{ op: 'note.add', note: { scene: 's1', text: 'x' } }]);
  assert.throws(() => applyOps(noted, [{ op: 'note.set', id: 'n1', fields: { nope: 1 } }], ctx), /note\.set: unknown field "nope"; allowed: /);
  assert.throws(() => applyOps(noted, [{ op: 'board.set', fields: { nope: 1 } }], ctx), /board\.set: unknown field "nope"; allowed: /);
  assert.throws(() => applyOps(sample(), [{ op: 'nope' }], ctx), /unknown op "nope"/);
});

test('a set op may carry its fields beside it', () => {
  let b = apply(sample(), [{ op: 'note.add', note: { scene: 's1', text: 'x', author: 'you' } }]);
  b = apply(b, [{ op: 'note.set', id: 'n1', resolved: true }]);
  assert.equal(b.notes[0].resolved, true);
  b = apply(b, [{ op: 'reply.add', note: 'n1', text: 'Done' }]);
  assert.equal(b.notes[0].replies[0].text, 'Done');
});

test('notes need words, a file or marks, and marks need a frame', () => {
  assert.throws(() => applyOps(sample(), [{ op: 'note.add', note: { scene: 's1', text: ' ' } }], ctx), /needs text, a file or marks/);
  assert.throws(() => applyOps(sample(), [{ op: 'note.add', note: { scene: 's9', text: 'x' } }], ctx), /^Error: no scene s9 \(scenes: s1, s2, s3\)$/);
  const markup = { marks: [{ kind: 'point', x: 0.5, y: 0.5 }] };
  assert.throws(() => applyOps(sample(), [{ op: 'note.add', note: { scene: 's1', markup } }], ctx), /marks belong to a frame/);
  const b = apply(sample(), [{ op: 'note.add', note: { scene: 's1', at: 1, markup: { marks: [{ kind: 'rect', x: -1, y: 0.2, w: 2, h: 0.3, text: ' here ' }] } } }]);
  const m = b.notes[0].markup.marks[0];
  assert.deepEqual([m.n, m.x, m.w, m.text], [1, 0, 1, 'here']);
  assert.equal(m.color, MARK_COLORS[0], 'a mark without a colour gets the annotator\'s first');
});

test('times: frames, timecode, the agents\' clock and musical time', () => {
  const b = sample();
  assert.equal(snapFrame(b, 1.016), 1);
  assert.equal(fitDuration(b, 1.01), 31 / 30, 'a clip\'s length rounds up to whole frames');
  assert.equal(fitDuration(b, 2), 2);
  assert.equal(timecode(21.5, 30), '00:00:21:15');
  assert.equal(timecode(3725 + 12 / 25, 25), '01:02:05:12');
  // Typed the way editors type it: digits fill from the right; + and - move from where you are.
  assert.equal(parseTimecode('2115', 30), 21.5);
  assert.equal(parseTimecode('21:15', 30), 21.5);
  assert.equal(parseTimecode('5', 30), 5 / 30);
  assert.equal(parseTimecode('01:02:05:12', 25), 3725 + 12 / 25);
  assert.equal(parseTimecode('+12', 30, 10), 10.4);
  assert.equal(parseTimecode('-1:00', 30, 10), 9);
  for (const bad of ['abc', '123456789', '1:2:3:4:5', '', '+']) assert.equal(parseTimecode(bad, 30), null, bad);
  assert.equal(clock(81.5), '1:21.50');
  assert.equal(seconds(b, { bars: 1 }), 2);
  assert.equal(seconds(b, { beats: 3 }), 1.5);
  assert.equal(seconds(b, { bar: 2 }, 'at', 'position'), 2);
  assert.equal(seconds(b, { beat: 4 }, 'at', 'position'), 2);
  assert.equal(musical(b, 2), '1 bar');
  assert.equal(musical(b, 1.5), '3 beats');
  assert.equal(noteTime(apply(b, [{ op: 'note.add', note: { scene: 's2', at: 0.5, text: 'x' } }]), { scene: 's2', at: 0.5 }), 2.5);
});

test('scene colours: a scene\'s own, else one unlike its neighbours, and stable', () => {
  const b = apply(newBoard(), Array.from({ length: 30 }, (_, i) => ({ op: 'scene.add', scene: { title: `S${i}`, ...(i === 7 ? { color: '#977dcf' } : {}) } })));
  const c = sceneColors(b), ids = b.scenes.map(s => s.id);
  assert.equal(c.get('s8'), '#977dcf');
  for (let i = 1; i < ids.length; i++) assert.notEqual(c.get(ids[i]), c.get(ids[i - 1]), `${ids[i]} beside ${ids[i - 1]}`);
  for (const id of ids) assert.ok(COLORS.includes(c.get(id)));
  assert.deepEqual([...sceneColors(b)], [...c]);
});

test('a scene title is its name: a number in front is dropped, and old ones are flagged', () => {
  const titles = ['s05 · LIGHT CYCLE · 1982', '05 – Opening', '1. Intro', 'Scene 3: The fall', '2001: A Space Odyssey', '1982 · Light cycle', '1:1 Square', '3D Glasses', '01'];
  const b = apply(newBoard({ title: 'Titles' }), titles.map(title => ({ op: 'scene.add', scene: { title, duration: 1 } })));
  assert.deepEqual(b.scenes.map(s => s.title), ['LIGHT CYCLE · 1982', 'Opening', 'Intro', 'The fall', '2001: A Space Odyssey', '1982 · Light cycle', '1:1 Square', '3D Glasses', '01']);
  assert.equal(apply(b, [{ op: 'scene.set', id: 's1', fields: { title: 's01 · Tea' } }]).scenes[0].title, 'Tea');
  // The change log names the scene by the title it had, so a rename reads old → new.
  assert.equal(applyOps(b, [{ op: 'scene.set', id: 's1', fields: { title: 'Tea' } }], ctx).summaries[0], 'changed s1 “LIGHT CYCLE · 1982”: title → “Tea”');
  // A board from before keeps its titles until its agent sets them again: the board says so.
  const old = structuredClone(b);
  old.scenes[0].title = 's01 · Tea';
  assert.ok(boardGaps(old).some(g => g.startsWith('a title without its number') && g.endsWith('on s1')), boardGaps(old).join(' | '));
});

test('board gaps list what is missing until it is filled in', () => {
  let b = sample();
  assert.deepEqual(boardGaps(b), ['board owner, project, brief, treatment', 'picture text on s1, s3', 'sound text (what we hear, or "silence") on s1, s3']);
  b = apply(b, [
    { op: 'board.set', fields: { owner: 'Claude', project: '/tmp/film', brief: 'B', treatment: 'T' } },
    { op: 'scene.set', id: 's1', fields: { picture: 'p', sound: 's' } },
    { op: 'scene.set', id: 's3', fields: { picture: 'p', sound: 'silence' } },
  ]);
  assert.deepEqual(boardGaps(b), []);
  // A board made without a title waits for its agent to name it.
  assert.deepEqual(boardGaps(apply(b, [{ op: 'board.set', fields: { title: '' } }]))[0], 'board title');
  // How it's rendered is asked for once a scene has a real render, not while it has only sketches.
  b = apply(b, [{ op: 'render.add', scene: 's1', render: { file: 'media/s1-sketch.png', kind: 'image', sketch: true } }]);
  assert.deepEqual(boardGaps(b), []);
  b = apply(b, [{ op: 'render.add', scene: 's1', render: { file: 'media/s1.mp4', kind: 'video', duration: 2 } }, { op: 'scene.set', id: 's1', fields: { status: 'draft' } }]);
  assert.deepEqual(boardGaps(b), ['board render (how the film is rendered: its type, and what draft and final mean)']);
  assert.deepEqual(boardGaps(apply(b, [{ op: 'board.set', fields: { render: { type: 'raster' } } }])), []);
});

test('how a film is rendered: Claude says once it has decided, and requests say what draft and final mean', () => {
  let b = sample();
  assert.equal(b.render, null);
  assert.match(renderWords(b, { render: { size: '1080p', quality: 'draft' } }), /draft quality \(quick settings\)/);
  const r = applyOps(b, [{ op: 'board.set', fields: { render: { type: 'Ray marched', draft: ' 8 samples a pixel: grainy, for checking motion ', final: '64 samples a pixel' } } }], ctx);
  b = r.board;
  assert.deepEqual(b.render, { type: ['raymarch'], draft: '8 samples a pixel: grainy, for checking motion', final: '64 samples a pixel' });
  assert.equal(r.summaries[0], 'set how the film is rendered: ray marched');
  assert.equal(renderWords(b, { render: { size: '4k', quality: 'final' } }), '4K final: 3840×2160 at 30 fps, final quality (ray marched, 64 samples a pixel), 10-bit HEVC (the master)');
  assert.match(renderWords(b, { render: { size: '720p', quality: 'draft' } }), /draft quality \(ray marched, 8 samples a pixel: grainy, for checking motion\), H\.264$/);
  // The names agents use, a list for a film that mixes methods (the main one first), and a type alone.
  assert.deepEqual(apply(b, [{ op: 'board.set', fields: { render: { type: ['three.js', '2D', 'threejs'] } } }]).render, { type: ['raster', '2d'] });
  assert.equal(renderTypeName(apply(b, [{ op: 'board.set', fields: { render: { type: ['raymarch', 'raster', '2d'] } } }])), 'ray marched, raster and 2D');
  assert.deepEqual(apply(b, [{ op: 'board.set', fields: { render: 'pathtrace' } }]).render, { type: ['pathtrace'] });
  assert.match(renderWords(apply(b, [{ op: 'board.set', fields: { render: 'edit' } }]), { render: { size: '1080p', quality: 'final' } }), /final quality \(edit\), H\.264/);
  // Wrong ones are refused with what would do; null clears it.
  assert.throws(() => apply(b, [{ op: 'board.set', fields: { render: { type: 'blender' } } }]), /render\.type: "blender" isn't one of 2d, raster, raymarch, raytrace, pathtrace, edit, capture/);
  assert.throws(() => apply(b, [{ op: 'board.set', fields: { render: { draft: 'quick' } } }]), /render\.type: give one of/);
  assert.throws(() => apply(b, [{ op: 'board.set', fields: { render: { type: 'raymarch', samples: 64 } } }]), /render: unknown field "samples"/);
  const cleared = applyOps(b, [{ op: 'board.set', fields: { render: null } }], ctx);
  assert.equal(cleared.board.render, null);
  assert.equal(cleared.summaries[0], 'cleared how the film is rendered');
});

test('where a note stands', () => {
  const note = o => ({ author: 'you', sent: '2026-10-01T08:00:00Z', replies: [], ...o });
  const working = '2026-10-01T10:00:00Z';
  assert.equal(noteState(note({ sent: null })), 'draft');
  assert.equal(noteState(note({})), 'sent');
  assert.equal(noteState(note({ read: '2026-10-01T09:00:00Z' })), 'read');
  assert.equal(noteState(note({ working })), 'working');
  assert.equal(noteState(note({ working, replies: [{ author: 'claude', created: '2026-10-01T09:30:00Z' }] })), 'working', 'a reply from before the work is old news');
  assert.equal(noteState(note({ working, replies: [{ author: 'claude', created: '2026-10-01T11:00:00Z' }] })), 'replied');
  assert.equal(noteState(note({ replies: [{ author: 'you', created: '2026-10-01T11:00:00Z' }] })), 'sent', 'the user\'s own reply is not an answer');
  assert.equal(noteState(note({ author: 'claude' })), 'agent');
  assert.equal(noteState(note({ resolved: true, working })), 'done');
});

test('notes for you: replied to, or written by Claude', () => {
  const note = (o = {}) => ({ author: 'you', sent: '2026-10-01T10:00:00Z', resolved: false, working: null, replies: [], ...o });
  const reply = (created, author = 'claude') => ({ author, text: 'x', created });
  assert.equal(forYou(note({ sent: null })), false);
  assert.equal(forYou(note()), false);
  assert.equal(forYou(note({ replies: [reply('2026-10-01T11:00:00Z')] })), true);
  assert.equal(forYou(note({ working: '2026-10-01T12:00:00Z', replies: [reply('2026-10-01T11:00:00Z')] })), false, 'work started after the reply');
  assert.equal(forYou(note({ working: '2026-10-01T12:00:00Z', replies: [reply('2026-10-01T13:00:00Z')] })), true);
  assert.equal(forYou(note({ resolved: true, replies: [reply('2026-10-01T11:00:00Z')] })), false);
  assert.equal(forYou(note({ author: 'claude' })), true);
});

test('counts in words: one is singular, anything else plural', () => {
  assert.equal(plural(0, 'note'), '0 notes');
  assert.equal(plural(1, 'scene'), '1 scene');
  assert.equal(plural(2, 'reply', 'replies'), '2 replies');
  assert.equal(plural(1.5, 'beat'), '1.5 beats');
});

test('a version\'s kind in words', () => {
  assert.equal(kindName({ kind: 'code' }), 'code sketch');
  assert.equal(kindName({ kind: 'video', sketch: true }), 'sketch clip');
  assert.equal(kindName({ kind: 'image', sketch: true }), 'sketch');
  assert.equal(kindName({ kind: 'video' }), 'clip');
  assert.equal(kindName({ kind: 'image' }), 'still');
});

test('created ids come back by kind', () => {
  const r = applyOps(sample(), [{ op: 'scene.add', scene: { title: 'X', renders: [{ file: 'media/a.png' }] } }, { op: 'note.add', note: { scene: null, text: 'n' } }], ctx);
  assert.deepEqual(createdIds(r.applied), { scenes: ['s4'], renders: ['r1'], notes: ['n1'] });
});
