// What agents read: the board as a shot list, one scene, and the notes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newBoard, applyOps } from '../lib/ops.js';
import { boardText, sceneText, notesText } from '../lib/text.js';

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
  assert.match(t, /how: render exactly this, with the project's pipeline: GET \/agent\/help\/requests/);
  // Once the board says how it's rendered, a request says what its quality means there.
  const ray = apply(b, [{ op: 'board.set', fields: { render: { type: 'raymarch', draft: '8 samples a pixel', final: '64 samples a pixel' } } }]);
  assert.match(notesText(ray, { slug: 'requests' }), /n2   #2 you · RENDER REQUEST: s1 “One”, 720p draft: 1280×720 at 25 fps, draft quality \(ray marched, 8 samples a pixel\), H\.264/);
  assert.match(boardText(ray, { slug: 'requests' }), /\nrender: ray marched · draft: 8 samples a pixel · final: 64 samples a pixel\n/);
  assert.match(t, /n3   #3 you · SOUNDTRACK at 0:02\.75 \(00:00:02:19 in the editor, bar 2 beat 2\.5\)/);
  assert.match(t, /listen: \/boards\/requests\/media\/audio\/song\.wav · on screen then: GET \/agent\/boards\/requests\/frame\?note=n3/);
  assert.match(t, /n4   #4 you · WHOLE SOUNDTRACK/);
  const compact = boardText(b, { slug: 'requests', compact: true }).split('\n');
  assert.ok(compact.includes('n2 #2 you · RENDER 720p draft of s1'), compact.join('\n'));
  assert.ok(compact.includes('n5 #5 you · RENDER 1080p final still of s1 frame 0:01.00'), compact.join('\n'));
  assert.ok(compact.includes('n3 #3 you · soundtrack 0:02.75: The snare is harsh here'), compact.join('\n'));
});
