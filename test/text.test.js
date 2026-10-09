// What agents read: the board as a shot list, one scene, and the notes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newBoard, applyOps } from '../lib/ops.js';
import { boardText, sceneText, notesText } from '../lib/text.js';
import { sheetPages } from '../lib/sheet.js';

const ctx = { author: 'claude', now: '2026-10-01T12:00:00.000Z' };
const apply = (b, ops, c = ctx) => applyOps(b, ops, c).board;

function board() {
  let b = apply(newBoard({ title: 'Text test', fps: 30 }), [
    { op: 'scene.add', scene: { title: 'One', duration: 2, picture: 'A dot' } },
    { op: 'scene.add', scene: { title: 'Two', duration: 2 } },
    { op: 'render.add', scene: 's2', render: { file: 'media/renders/a.png', caption: 'v1', meta: { cmd: 'node render.js clip' } } },
  ]);
  b = apply(b, [
    { op: 'note.add', note: { scene: 's2', at: 1, text: 'Too dark', author: 'you' } },
    { op: 'note.add', note: { scene: 's1', text: 'Still writing this', author: 'you' } },
  ], { ...ctx, author: 'you' });
  return apply(b, [{ op: 'notes.send', ids: ['n1'] }], { ...ctx, author: 'you' });
}

test('the board reads top to bottom, gaps first', () => {
  const t = boardText(board(), { slug: 'text-test' });
  assert.match(t, /^# Text test\nboard text-test · rev 3 · 16:9 \(1920×1080\) · 30 fps · 2 scenes · 4s/);
  assert.match(t, /TO FILL IN \(keep the board current\): board owner, project, brief, treatment/);
  assert.match(t, /s1   01  0:00\.00–0:02\.00/);
  assert.match(t, /n1   #1 you · FRAME 0:03\.00 \(00:00:03:00 in the editor, frame 90 of the cut\) in s2 “Two”, \+1s in/);
  assert.doesNotMatch(t, /Still writing this/, 'drafts stay with the user');
  assert.match(t, /hasn't sent 1 more note yet/);
});

test('the compact board is one line a scene', () => {
  const t = boardText(board(), { slug: 'text-test', compact: true });
  const lines = t.split('\n');
  assert.match(lines[0], /^Text test · text-test · rev 3 · 30 fps · 4s/);
  assert.match(lines[1], /^to fill in: /);
  assert.ok(lines.some(l => l.startsWith('n1 #1 you · s2 frame 0:03.00')));
});

test('a scene lists its versions with the command that made them', () => {
  const t = sceneText(board(), 's2', { slug: 'text-test' });
  assert.match(t, /▸ r1 · still · by claude · “v1” · made with: node render\.js clip/);
  assert.match(t, /## Notes on s2/);
});

test('the board keeps render lines short and a long treatment to its outline', () => {
  const long = 'x'.repeat(120);
  let b = apply(board(), [{ op: 'render.set', scene: 's2', id: 'r1', fields: { caption: long } }]);
  const t = boardText(b, { slug: 'text-test', dir: '/boards/text-test' });
  assert.match(t, /render: r1 · still · by claude · “x{79}…”\n/);
  assert.doesNotMatch(t, /made with|poster /, 'the scene\'s own page has those');
  assert.match(sceneText(b, 's2', { slug: 'text-test', dir: '/boards/text-test' }), /“x{120}” · made with: node render\.js clip · poster \/boards\/text-test\/media\/renders\/a\.png/);

  const treatment = `The film in a line.\n\n## 1. The idea\n${'words '.repeat(400)}\n\n## 2. The shape\nThree acts.`;
  b = apply(b, [{ op: 'board.set', fields: { treatment } }]);
  const short = boardText(b, { slug: 'text-test' });
  assert.match(short, /## Treatment \(2,465 characters; in full: GET \/agent\/boards\/text-test\/treatment\)\nThe film in a line\.\nIts sections: 1\. The idea · 2\. The shape$/);
  assert.ok(boardText(b, { slug: 'text-test', treatment: true }).endsWith(treatment));
  b = apply(b, [{ op: 'board.set', fields: { treatment: 'Short and whole.' } }]);
  assert.match(boardText(b, { slug: 'text-test' }), /## Treatment\nShort and whole\.$/);
});

test('a long film\'s contact sheet comes in even pages a model can still read', () => {
  const film = (n, w = 1920, h = 1080) => ({ width: w, height: h, scenes: Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}` })) });
  assert.deepEqual(sheetPages(film(16)), { pages: 1, size: 16 });
  assert.deepEqual(sheetPages(film(20)), { pages: 2, size: 12 });
  assert.deepEqual(sheetPages(film(38)), { pages: 3, size: 16 });
  assert.deepEqual(sheetPages(film(18, 1080, 1920)), { pages: 1, size: 18 });
  assert.deepEqual(sheetPages(film(19, 1080, 1920)), { pages: 2, size: 12 });
});

test('notes: open ones, and unsent ones only when asked', () => {
  const b = board();
  assert.match(notesText(b, { slug: 'text-test' }), /Too dark[\s\S]*hasn't sent 1 more note yet/);
  assert.match(notesText(b, { slug: 'text-test', drafts: true }), /NOT SENT: the user hasn't sent it to you yet/);
});

test('a render request says what to render, at what size, and how to deliver it', () => {
  let b = apply(newBoard({ title: 'Requests', fps: 25, bpm: 120 }), [{ op: 'scene.add', scene: { title: 'One', duration: 2 } }]);
  b = apply(b, [
    { op: 'note.add', note: { render: { size: '4k' }, text: 'Use the new sky' } },
    { op: 'note.add', note: { scene: 's1', render: { size: '720p' } } },
    { op: 'note.add', note: { soundtrack: true, at: 2.75, text: 'The snare is harsh here' } },
    { op: 'note.add', note: { soundtrack: true, text: 'Too quiet overall' } },
    { op: 'note.add', note: { scene: 's1', at: 1, render: { size: '1080p', quality: 'final' } } },
  ], { ...ctx, author: 'you' });
  b = apply(b, [{ op: 'audio.set', audio: { file: 'media/audio/song.wav', name: 'song.wav', duration: 8 } }]);
  b = apply(b, [{ op: 'notes.send', ids: ['n1', 'n2', 'n3', 'n4', 'n5'] }], { ...ctx, author: 'you' });
  const t = notesText(b, { slug: 'requests', dir: '/boards/requests' });
  assert.match(t, /n1   #1 you · RENDER REQUEST: the whole film, 4K final: 3840×2160 at 25 fps, final quality, 10-bit HEVC \(the master\)/);
  assert.match(t, /n2   #2 you · RENDER REQUEST: s1 “One”, 720p draft: 1280×720 at 25 fps, draft quality \(quick settings\), H\.264/);
  assert.match(t, /n5   #5 you · RENDER REQUEST: the frame at 0:01\.00 \(00:00:01:00 in the editor, frame 25\) in s1 “One”, 1080p final still: one 1920×1080 still, final quality, PNG/);
  assert.match(t, /how: render exactly this, each scene its own way: GET \/agent\/help\/requests/);
  assert.match(t, /how: render exactly this, the scene its own way: GET \/agent\/help\/requests/);
  // The whole film is the cut of its scenes: the request says which have a render that fits and which to render first.
  assert.match(t, /the cut: 0 of 1 scenes have a render that fits; render first, each its own way: s1 \(how it is made: not set; has nothing yet\); then cut them together: sb cut --size 4k --quality final/);
  // Once the board says how it's rendered, a request says what its quality means there.
  const ray = apply(b, [{ op: 'board.set', fields: { render: { type: 'raymarch', draft: '8 samples a pixel', final: '64 samples a pixel' } } }]);
  assert.match(notesText(ray, { slug: 'requests' }), /n2   #2 you · RENDER REQUEST: s1 “One”, 720p draft: 1280×720 at 25 fps, draft quality \(ray marched, 8 samples a pixel\), H\.264/);
  assert.match(boardText(ray, { slug: 'requests' }), /\nrender: each scene is its own movie, made its own way \(the cut joins them\): ray marched ×1\ndefault for scenes that don't say: ray marched · draft: 8 samples a pixel · final: 64 samples a pixel\n/);
  // A scene made its own way says so in the shot list.
  const own = apply(ray, [{ op: 'scene.set', id: 's1', fields: { render: { type: 'raytrace', final: '64 samples a pixel', cmd: 'node rt.js' } } }]);
  assert.match(boardText(own, { slug: 'requests' }), /\n {7}made: ray traced · final: 64 samples a pixel\n/);
  assert.match(sceneText(own, 's1', { slug: 'requests' }), /made: ray traced · final: 64 samples a pixel · made with: node rt\.js/);
  assert.match(t, /n3   #3 you · SOUNDTRACK at 0:02\.75 \(00:00:02:19 in the editor, bar 2 beat 2\.5\)/);
  assert.match(t, /listen: \/boards\/requests\/media\/audio\/song\.wav · on screen then: GET \/agent\/boards\/requests\/frame\?note=n3/);
  assert.match(t, /n4   #4 you · WHOLE SOUNDTRACK/);
  const compact = boardText(b, { slug: 'requests', compact: true }).split('\n');
  assert.ok(compact.includes('n2 #2 you · RENDER 720p draft of s1'), compact.join('\n'));
  assert.ok(compact.includes('n5 #5 you · RENDER 1080p final still of s1 frame 0:01.00'), compact.join('\n'));
  assert.ok(compact.includes('n3 #3 you · soundtrack 0:02.75: The snare is harsh here'), compact.join('\n'));
});

test('a note about sounds tells the agent which sounds, and where their stems are', async () => {
  const { newBoard, applyOps } = await import('../lib/ops.js');
  const { boardText } = await import('../lib/text.js');
  const c = { author: 'you', now: '2026-10-01T12:00:00.000Z' };
  let b = applyOps(newBoard({ title: 'T' }), [
    { op: 'audio.set', audio: { file: 'media/audio/mix.wav', name: 'mix.wav', duration: 60 } },
    { op: 'sound.set', sound: { name: 's', duration: 60, layers: [{ id: 'glass', label: 'Glass', file: 'media/sound/x/glass.flac' }], events: 'media/sound/x/events.json', count: 1 } },
    { op: 'note.add', note: { text: 'a mess', sounds: [{ id: 'g1', layer: 'glass', t: 3, dur: 0.5, note: 'A5', label: 'pling' }], sent: '2026-10-01T12:00:00.000Z' } },
  ], c).board;
  const text = boardText(b, { slug: 't', notes: true, all: true });
  assert.match(text, /A SOUND in the soundtrack at 0:03/);
  assert.match(text, /sound: g1 \(glass, A5, 3s for 0\.5s: pling\)/);
  assert.match(text, /glass: media\/sound\/x\/glass\.flac \(their stems\)/);
});

test('a note about sounds says when a sound changed or left the score, and what sounds with it', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { newBoard, applyOps } = await import('../lib/ops.js');
  const { boardText } = await import('../lib/text.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbsound-'));
  fs.mkdirSync(path.join(dir, 'media/sound/y'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'media/sound/y/events.json'), JSON.stringify([
    { id: 'g1', layer: 'glass', t: 3.4, dur: 0.5, note: 'B5' }, { id: 'k1', layer: 'kick', t: 3.2, dur: 0.4 }, { id: 'p1', layer: 'pad', t: 0, dur: 60, note: 'A2' },
  ]));
  const c = { author: 'you', now: '2026-10-01T12:00:00.000Z' };
  const b = applyOps(newBoard({ title: 'T' }), [
    { op: 'audio.set', audio: { file: 'media/audio/mix.wav', name: 'mix.wav', duration: 60 } },
    { op: 'sound.set', sound: { name: 's', duration: 60, layers: [{ id: 'glass', file: 'media/sound/y/glass.flac' }], events: 'media/sound/y/events.json', count: 3, source: '/score/sound.json' } },
    { op: 'note.add', note: { text: 'clash', sounds: [{ id: 'g1', layer: 'glass', t: 3, dur: 0.5, note: 'A5' }, { id: 'g9', layer: 'glass', t: 5 }], sent: c.now } },
  ], c).board;
  const text = boardText(b, { slug: 't', notes: true, all: true, dir });
  assert.match(text, /sound: g1 .*changed since: now at 3\.4s, B5/);
  assert.match(text, /sounding with it: 2 sounds — kick 1, pad 1/);
  assert.match(text, /starting nearest it: k1 \(kick, 0\.2s after\)/);
  assert.match(text, /sound: g9 .*NOT IN THE SCORE ANY MORE/);
  assert.match(text, /score: \/score\/sound\.json/);
});
