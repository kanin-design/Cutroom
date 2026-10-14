// The sound view's state across boards: the editor's own modules (web/store.js, web/soundview.js) in node, with
// the few browser pieces they reach for faked. Picks, mute, solo and the looped passage belong to the board they
// were made on, and what the view reports (POST …/view) never reads a board's sound set that isn't there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { newBoard } from '../lib/ops.js';

// the page imports '/lib/…' from the server's root
const LIB = new URL('../lib/', import.meta.url).href;
registerHooks({ resolve: (spec, ctx, next) => next(spec.startsWith('/lib/') ? LIB + spec.slice(5) : spec, ctx) });

const SET = 'media/sound/abc/events.json';
const boards = {
  scored: {
    ...newBoard({ title: 'Scored' }),
    audio: { file: 'media/audio/mix.wav', duration: 10, peaks: 'media/audio/mix.wav.peaks.json' },
    sound: {
      name: 'score', duration: 10, events: SET,
      layers: [
        { id: 'kick', label: 'Kick', file: 'media/sound/abc/kick.flac', peaks: 'media/sound/abc/kick.flac.peaks.json' },
        { id: 'bell', label: 'Bell', file: 'media/sound/abc/bell.flac', peaks: 'media/sound/abc/bell.flac.peaks.json' },
      ],
    },
  },
  silent: newBoard({ title: 'No soundtrack' }),
};
boards.rescored = { ...boards.scored, title: 'Scored again' };
const events = [
  { id: 'e1', layer: 'kick', t: 1 },
  { id: 'e2', layer: 'kick', t: 2 },
  { id: 'e3', layer: 'bell', t: 3, dur: 1, note: 'A5', label: 'the first bell' },
];

const views = []; // what the editor reported, as [slug, body]
const ok = body => ({ ok: true, json: async () => body, arrayBuffer: async () => new ArrayBuffer(8) });
globalThis.fetch = async (url, o = {}) => {
  const u = decodeURI(String(url));
  let m;
  if ((m = /^\/api\/boards\/([^/]+)\/view$/.exec(u)) && o.method === 'POST') { views.push([m[1], JSON.parse(o.body)]); return ok({ ok: true }); }
  if ((m = /^\/api\/boards\/([^/?]+)\/log/.exec(u))) return ok({ entries: [] });
  if ((m = /^\/api\/boards\/([^/?]+)$/.exec(u))) return ok({ board: structuredClone(boards[m[1]]) });
  if (u.endsWith('/events.json')) return ok(events);
  if (u.endsWith('.peaks.json')) return ok({ rate: 10, peak: [] });
  return ok({});
};
globalThis.EventSource = class { close() {} };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.document = { getElementById: () => null };
globalThis.addEventListener = () => {};
const node = () => ({ connect() {}, start() {}, stop() {}, gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }, playbackRate: { value: 1 } });
globalThis.AudioContext = class { state = 'running'; currentTime = 0; destination = {}; createGain = node; createBufferSource = node; decodeAudioData = async () => ({ duration: 10 }); };

const { S, openBoard } = await import('../web/store.js');
const sv = await import('../web/soundview.js');

const until = async (f, ms = 1000) => { for (const end = Date.now() + ms; !f(); ) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };
const reported = async slug => { const n = views.length; await until(() => views.length > n, 1500); assert.equal(views.at(-1)[0], slug); return views.at(-1)[1]; };

async function openScored(slug = 'scored') {
  await openBoard(slug);
  await until(sv.soundsLoaded);
  sv.pickSound(sv.soundById('e1'));
  sv.pickSound(sv.soundById('e3'), true);
  sv.toggleLayer('bell', 'solo');
  sv.setRange(4, 6);
  assert.deepEqual(S.soundSel.map(e => e.id), ['e1', 'e3']);
}

test('picks, solo and the loop are what the view reports, with the set they come from', async () => {
  await openScored();
  const v = await reported('scored');
  assert.deepEqual(v.picked.map(x => [x.id, x.set]), [['e1', SET], ['e3', SET]]);
  assert.deepEqual(v.picked[1], { id: 'e3', layer: 'bell', t: 3, dur: 1, note: 'A5', label: 'the first bell', set: SET });
  assert.deepEqual(v.solo, ['bell']);
  assert.deepEqual(v.heard, ['bell']);
  assert.deepEqual(v.range, { a: 4, b: 6 });
  assert.equal(S.noteTarget, 'sounds');
  sv.pickSound(sv.soundById('e2'));
  assert.equal(sv.stepPick(-1), true); // ⌥←: the sound before the last one picked, in its layer
  assert.deepEqual(S.soundSel.map(e => e.id), ['e1']);
});

test('opening a board with no soundtrack lets go of the last board’s sounds', async () => {
  await openScored();
  await openBoard('silent');
  assert.deepEqual(S.soundSel, []);
  assert.equal(S.soundSolo.size + S.soundMute.size, 0);
  assert.equal(S.range, null);
  assert.equal(sv.soundById('e1'), null);
  assert.equal(sv.stepPick(1), false); // nothing to step from
  const v = await reported('silent'); // threw here: "Cannot read properties of undefined (reading 'events')"
  assert.deepEqual(v.picked, []);
  assert.deepEqual(v.solo, []);
  assert.equal(v.range, null);
});

test('opening another scored board starts its sound view afresh', async () => {
  await openScored();
  await openBoard('rescored');
  assert.deepEqual(S.soundSel, []);
  assert.equal(S.soundSolo.size, 0);
  assert.equal(S.range, null);
  await until(sv.soundsLoaded);
  const v = await reported('rescored');
  assert.deepEqual(v.picked, []);
});

test('picks a board has no sound set for are not sent as sounds', async () => {
  await openBoard('silent');
  S.soundSel = [events[0]]; // however they got there
  assert.deepEqual(sv.pickedForNote(), []);
  S.soundSel = [];
});
