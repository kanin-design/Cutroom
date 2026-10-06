// The agent API end to end: a real server on a spare port, with its boards in a temporary folder.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cutroom-test-'));
let server;

async function call(method, url, body, headers = {}) {
  const r = await fetch(BASE + url, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('json') ? await r.json() : await r.text() };
}

before(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, SB_HOME: HOME, SB_PORT: String(PORT), SB_AUTORESTART: '' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/ping`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('the server did not start');
});

after(() => {
  server?.kill();
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('an agent makes a board, fills it in and is told what is missing', async () => {
  const made = await call('POST', '/agent/boards', { title: 'API test', fps: 30 });
  assert.equal(made.status, 200);
  assert.equal(made.body.board, 'api-test');

  const ops = await call('POST', '/agent/boards/api-test/ops', { ops: [
    { op: 'scene.add', scene: { title: 'Open', duration: 2, picture: 'A door' } },
    { op: 'scene.add', scene: { title: 'Close', duration: 1 } },
  ] });
  assert.equal(ops.status, 200);
  assert.deepEqual(ops.body.created, { scenes: ['s1', 's2'] });
  assert.match(ops.body.todo, /board owner, project, brief, treatment/);
  assert.equal(ops.body.inverse, undefined, 'the undo stays in the log');
  assert.ok((await call('GET', '/agent/boards/api-test/log?format=json')).body.entries.at(-1).inverse.length);

  const text = await call('GET', '/agent/boards/api-test');
  assert.match(text.body, /TO FILL IN/);
  assert.match(text.body, /s2   02  0:02\.00–0:03\.00/);

  const bad = await call('POST', '/agent/boards/api-test/ops', { ops: [{ op: 'scene.set', id: 's9', fields: { title: 'x' } }] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /no scene s9/);

  const stale = await call('POST', '/agent/boards/api-test/ops', { ops: [{ op: 'scene.set', id: 's1', fields: { title: 'x' } }], expectRev: 0 });
  assert.equal(stale.status, 409);
});

test('a render goes on its scene with the command that made it', async () => {
  const png = path.join(HOME, 'still.png');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x36', '-frames:v', '1', png]);
  const r = await call('POST', '/agent/boards/api-test/renders', { scene: 's1', path: png, caption: 'first look', meta: { cmd: 'node render.js still' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.created, { renders: ['r1'] });
  assert.match(r.body.next, /picture, sound, duration and status/);
  const scene = await call('GET', '/agent/boards/api-test/scenes/s1');
  assert.match(scene.body, /▸ r1 · still · 64×36 · by claude · “first look” · made with: node render\.js still/);
});

test('sketches: an SVG drawing on paper, a code sketch as a new idea scene, and one by op', async () => {
  const svg = await call('POST', '/agent/boards/api-test/sketches', { scene: 's2', svg: '<svg viewBox="0 0 160 90"><circle cx="80" cy="45" r="30" fill="none" stroke="#222" stroke-width="3"/></svg>' });
  assert.equal(svg.status, 200, JSON.stringify(svg.body));
  const code = 'const ctx = canvas.getContext("2d");\nfunction draw(t, s) { ctx.fillStyle = "#123"; ctx.fillRect(0, 0, s.w, s.h); ctx.fillStyle = "#fc3"; ctx.fillRect(0, 0, s.w * s.progress, s.h); }';
  const idea = await call('POST', '/agent/boards/api-test/sketches', { new: { title: 'Wipe', duration: 1 }, code });
  assert.equal(idea.status, 200, JSON.stringify(idea.body));
  const byOp = await call('POST', '/agent/boards/api-test/ops', { ops: [{ op: 'sketch.add', scene: 's1', code, caption: 'by op' }] });
  assert.equal(byOp.status, 200, JSON.stringify(byOp.body));
  const board = (await call('GET', '/agent/boards/api-test?format=json')).body;
  const drawing = board.scenes[1].renders.at(-1), wipe = board.scenes.at(-1).renders[0];
  assert.deepEqual([drawing.kind, drawing.sketch, /\.svg$/.test(drawing.file)], ['image', true, true]);
  assert.deepEqual([wipe.kind, wipe.sketch, board.scenes.at(-1).title, board.scenes.at(-1).status], ['code', true, 'Wipe', 'idea']);
  const op = board.scenes[0].renders.at(-1);
  assert.deepEqual([op.kind, op.caption, board.scenes[0].activeRender], ['code', 'by op', op.id]);
  for (const f of [drawing.poster, wipe.poster, wipe.strip, op.poster]) assert.ok(fs.existsSync(path.join(HOME, 'api-test', f)), f);
  const bad = await call('POST', '/agent/boards/api-test/sketches', { scene: 's1', code: 'function draw(t, s) { nope( }' });
  assert.equal(bad.status, 400);
  const broken = await call('POST', '/agent/boards/api-test/sketches', { scene: 's1', svg: '<g>\n  <rect x="1" y="1" width="9" height="9">\n</g>' });
  assert.equal(broken.status, 400);
  assert.match(broken.body.error, /isn't valid SVG \(XML\) at line 3, column \d+ of what you sent/);
});

test('a file saved in the sketches folder becomes a version, and saving it again updates it', async () => {
  const file = path.join(HOME, 'api-test', 'sketches', 's2-folder.svg');
  const until = async (ok, what) => {
    for (let i = 0; i < 60; i++) {
      const b = (await call('GET', '/agent/boards/api-test?format=json')).body;
      const r = b.scenes[1].renders.find(x => x.caption === 's2-folder.svg');
      if (ok(r)) return r;
      await new Promise(res => setTimeout(res, 100));
    }
    assert.fail(what);
  };
  fs.writeFileSync(file, '<svg viewBox="0 0 160 90"><rect x="20" y="20" width="60" height="40" fill="#222"/></svg>');
  const first = await until(r => r, 'the sketch never arrived');
  assert.deepEqual([first.kind, first.sketch, first.author], ['image', true, 'sketches folder']);
  await new Promise(res => setTimeout(res, 20));
  fs.writeFileSync(file, '<svg viewBox="0 0 160 90"><circle cx="80" cy="45" r="20" fill="#222"/></svg>');
  const again = await until(r => r && r.file !== first.file, 'the sketch was never updated');
  assert.equal(again.id, first.id, 'the same version, updated in place');
});

test('wait returns when the user sends notes, and reads them', async () => {
  const quiet = await call('GET', '/agent/boards/api-test/wait?on=send&timeout=1');
  assert.match(quiet.body, /^Nobody other than claude changed the board/);

  const before = (await call('GET', '/agent/boards/api-test?format=json')).body.rev;
  const add = await call('POST', '/api/boards/api-test/ops', { ops: [{ op: 'note.add', note: { scene: 's2', at: 0.5, text: 'Slower here' } }], author: 'you' });
  const id = add.body.ops[0].note.id;
  await call('POST', '/api/boards/api-test/ops', { ops: [{ op: 'notes.send', ids: [id] }], author: 'you' });

  const sent = await call('GET', `/agent/boards/api-test/wait?on=send&since=${before}&timeout=5`);
  assert.match(sent.body, /^The user sent you 1 note on “API test”/);
  assert.match(sent.body, /Slower here/);
  const board = (await call('GET', '/agent/boards/api-test?format=json')).body;
  assert.equal(board.notes[0].readBy, 'claude', 'handing the notes over marks them read');
});

test('a session handed notes is busy until it waits again; a ping reaches it either way', async () => {
  const boards = async () => (await call('GET', '/api/boards')).body.boards.find(b => b.slug === 'api-test');
  // the wait above handed over a note and nothing has waited since: the session is on it
  assert.equal((await boards()).busy, true);
  // a ping while it's busy is kept for it, and its next wait answers at once
  const rev = (await call('GET', '/agent/boards/api-test?format=json')).body.rev;
  assert.equal((await call('POST', '/api/boards/api-test/ping')).body.heardNow, false);
  const queued = await call('GET', `/agent/boards/api-test/wait?on=send&since=${rev}&timeout=5`);
  assert.match(queued.body, /^The user pinged you from the editor: they're looking for the window that has “API test”/);
  assert.match(queued.body, /“This is the API test session/);
  // answering it, the session still counts as listening (it waits again in moments), not busy or gone
  assert.deepEqual([(await boards()).listening, (await boards()).busy], [1, false]);
  // a session listening hears a ping at once, and is no longer busy
  const listening = call('GET', `/agent/boards/api-test/wait?on=send&since=${rev}&timeout=20`);
  await new Promise(r => setTimeout(r, 300));
  const b = await boards();
  assert.deepEqual([b.listening, b.busy], [1, false]);
  assert.equal((await call('POST', '/api/boards/api-test/ping')).body.heardNow, true);
  assert.match((await listening).body, /pinged you from the editor/);
});

test('a render request reaches the agent through wait, with how to deliver it', async () => {
  const before = (await call('GET', '/agent/boards/api-test?format=json')).body.rev;
  const add = await call('POST', '/api/boards/api-test/ops', { ops: [{ op: 'note.add', note: { render: { size: '1080p' }, text: 'For the client' } }], author: 'you' });
  const id = add.body.ops[0].note.id;
  await call('POST', '/api/boards/api-test/ops', { ops: [{ op: 'notes.send', ids: [id] }], author: 'you' });
  const sent = await call('GET', `/agent/boards/api-test/wait?on=send&since=${before}&timeout=5`);
  assert.match(sent.body, new RegExp(`${id} +#\\d+ you · RENDER REQUEST: the whole film, 1080p final: 1920×1080 at 30 fps, final quality, H\\.264`));
  assert.match(sent.body, /\nA RENDER REQUEST asks you to render: .*GET http:\/\/127\.0\.0\.1:\d+\/agent\/help\/requests says\.$/m);
  assert.match((await call('GET', '/agent/help/requests')).body, /^## Render requests\n/);
});

test('a soundtrack note: look at what is on screen at its moment', async () => {
  const add = await call('POST', '/api/boards/api-test/ops', { ops: [{ op: 'note.add', note: { soundtrack: true, at: 0.5, text: 'Kick' } }, { op: 'note.add', note: { soundtrack: true, text: 'Louder' } }], author: 'you' });
  const [moment, whole] = add.body.ops.map(o => o.note.id);
  const r = await call('GET', `/agent/boards/api-test/frame?note=${moment}&format=json`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.caption, new RegExp(`^${moment} on the soundtrack: 0:00\\.50 → s1 `));
  const no = await call('GET', `/agent/boards/api-test/frame?note=${whole}&format=json`);
  assert.match(no.body.error, /about the whole soundtrack, not a moment/);
});

test('the editor\'s own API wants its header for raw uploads', async () => {
  const r = await fetch(`${BASE}/api/boards/api-test/attach?name=x.txt`, { method: 'POST', body: 'hello' });
  assert.equal(r.status, 403);
  const ok = await fetch(`${BASE}/api/boards/api-test/attach?name=x.txt`, { method: 'POST', body: 'hello', headers: { 'x-storyboard': '1' } });
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).file.file, /^media\/refs\/.+-x\.txt$/);
});

test('the editor\'s drops: a still onto a scene, a clip onto empty timeline, a soundtrack', async () => {
  const make = (name, args) => { const f = path.join(HOME, name); execFileSync('ffmpeg', ['-y', '-v', 'error', ...args, f]); return fs.readFileSync(f); };
  const drop = (query, body) => fetch(`${BASE}/api/boards/api-test/ingest?${query}`, { method: 'POST', body, headers: { 'x-storyboard': '1' } });
  const still = make('drop.png', ['-f', 'lavfi', '-i', 'color=c=blue:s=64x36', '-frames:v', '1']);
  const clip = make('drop.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=64x36:r=30:d=1.5', '-pix_fmt', 'yuv420p']);
  const wav = make('drop.wav', ['-f', 'lavfi', '-i', 'sine=d=2']);
  assert.equal((await fetch(`${BASE}/api/boards/api-test/ingest?name=x.png&scene=s1`, { method: 'POST', body: still })).status, 403);
  assert.equal((await drop('name=drop.png&scene=s1', still)).status, 200);
  assert.equal((await drop('name=my_clip.mp4&after=s1', clip)).status, 200);
  assert.equal((await drop('name=drop.wav', wav)).status, 200);
  const b = (await call('GET', '/agent/boards/api-test?format=json')).body;
  assert.deepEqual([b.scenes[0].renders.at(-1).kind, b.scenes[0].renders.at(-1).source], ['image', 'drop.png']);
  const made = b.scenes[1];
  assert.deepEqual([made.title, made.status, made.renders[0].kind, made.duration], ['my clip', 'draft', 'video', 1.5]);
  assert.deepEqual([b.audio.name, Math.round(b.audio.duration)], ['drop.wav', 2]);
});

test('the sb command line, through the same server', async () => {
  // Always this test's server and folder, never the real ones.
  const env = { ...process.env, SB_PORT: String(PORT), SB_HOME: HOME };
  const sb = (...args) => new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'sb'), '-b', 'api-test', ...args], { env }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout)));
  });
  assert.match(await sb('set', 's1', 'title=Door opens'), /^✓ .*s1/m);
  assert.match(await sb('show'), /^s1 .* Door opens$/m);
  assert.match(await sb('say', 'rendering', '--scene', 's1'), /^✓ status: rendering \(on s1\)/);
  assert.match(await sb('focus', 's1'), /^✓ /);
  const film = path.join(HOME, 'film.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=64x36:r=30:d=3', '-pix_fmt', 'yuv420p', film]);
  assert.match(await sb('split', film, '--scenes', 's1', '--cmd', 'node film.js'), /^✓ .*s1/m);
  await assert.rejects(sb('set', 's99', 'title=x'), e => /no scene s99 \(scenes: s1, /.test(e.stderr));
});

test('seeing: a code sketch\'s frame and strip, moments of the cut, and a sketch that throws', async () => {
  const b = (await call('GET', '/agent/boards/api-test?format=json')).body;
  const wipe = b.scenes.find(s => s.title === 'Wipe').id;
  const isJpg = async url => {
    const r = await call('GET', url);
    assert.equal(r.status, 200, `${url}: ${r.body}`);
    assert.deepEqual([...fs.readFileSync(r.body.trim()).subarray(0, 2)], [0xff, 0xd8], url);
  };
  await isJpg(`/agent/boards/api-test/frame?scene=${wipe}&at=0.5&format=path`);
  await isJpg(`/agent/boards/api-test/scenes/${wipe}/strip?n=3&format=path`);
  await isJpg('/agent/boards/api-test/frames?t=0.5,1&format=path');
  const boom = await call('POST', '/agent/boards/api-test/sketches', { scene: 's1', code: 'function draw(t, s) { throw new Error("boom"); }' });
  assert.equal(boom.status, 400);
  assert.match(boom.body.error, /the code sketch threw an error: .*boom/);
});

test('a code sketch is redrawn when its scene is retimed', async () => {
  const find = async () => (await call('GET', '/agent/boards/api-test?format=json')).body.scenes.find(s => s.title === 'Wipe');
  const before = await find();
  const r0 = before.renders[0];
  await call('POST', '/agent/boards/api-test/ops', { ops: [{ op: 'scene.set', id: before.id, fields: { duration: 2 } }] });
  let r;
  for (let i = 0; i < 100 && !(r?.drawn?.duration === 2); i++) {
    await new Promise(res => setTimeout(res, 100));
    r = (await find()).renders[0];
  }
  assert.equal(r.drawn.duration, 2, 'redrawn for the new length');
  assert.notEqual(r.poster, r0.poster);
  assert.equal(r.stripFrames, 10);
  assert.ok(fs.existsSync(path.join(HOME, 'api-test', r.strip)));
});

test('the animatic: every kind of version cut together, exactly as long as the board', async () => {
  const b = (await call('GET', '/agent/boards/api-test?format=json')).body;
  const kinds = new Set(b.scenes.map(s => s.renders.find(r => r.id === s.activeRender)?.kind ?? 'card'));
  assert.ok(['video', 'image', 'code'].every(k => kinds.has(k)), [...kinds].join(', '));
  const r = await call('GET', '/agent/boards/api-test/animatic?scale=0.1&fps=10&format=json');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const frames = +execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', r.body.path], { encoding: 'utf8' }).trim();
  const want = b.scenes.reduce((n, s) => n + Math.max(1, Math.round(s.duration * 10)), 0);
  assert.equal(frames, want);
});

test('media is served with ranges', async () => {
  const board = (await call('GET', '/agent/boards/api-test?format=json')).body;
  const url = `/media/api-test/${board.scenes[0].renders[0].file.replace(/^media\//, '')}`;
  const all = await fetch(BASE + url);
  const size = (await all.arrayBuffer()).byteLength;
  const part = await fetch(BASE + url, { headers: { range: 'bytes=0-9' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 10);
  assert.ok(size > 10);
  const tail = await fetch(BASE + url, { headers: { range: `bytes=-${size + 100}` } });
  assert.equal(tail.status, 206, 'a suffix longer than the file is the whole file');
  assert.equal((await tail.arrayBuffer()).byteLength, size);
  const outside = await fetch(BASE + '/media/api-test/../../etc/passwd');
  assert.notEqual(outside.status, 200);
});

test('the contact sheet draws', { skip: !fs.existsSync('/usr/bin/swiftc') && 'needs swiftc' }, async () => {
  const r = await call('GET', '/agent/boards/api-test/sheet?format=path');
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(r.body.trim()));
  // A long film's sheet comes in pages: every page's path, one a line, or one page as an image.
  await call('POST', '/agent/boards', { title: 'Long sheet' });
  await call('POST', '/agent/boards/long-sheet/ops', { ops: Array.from({ length: 17 }, (_, i) => ({ op: 'scene.add', scene: { title: `Shot ${i + 1}`, duration: 1 } })) });
  const pages = (await call('GET', '/agent/boards/long-sheet/sheet?format=path')).body.trim().split('\n');
  assert.equal(pages.length, 2);
  assert.ok(pages.every(f => /-p[12]\.jpg$/.test(f) && fs.existsSync(f)), pages.join('\n'));
  assert.equal((await call('GET', '/agent/boards/long-sheet/sheet?page=2&format=path')).body.trim(), pages[1]);
  assert.equal((await call('GET', '/agent/boards/long-sheet/sheet?page=3')).status, 400);
});

test('boards come in a shape, and the editor can hand one to a Claude session', async () => {
  const made = await call('POST', '/agent/boards', { title: 'Vertical', aspect: '9:16', beatsPerBar: 3 });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const b = (await call('GET', '/agent/boards/vertical?format=json')).body;
  assert.deepEqual([b.width, b.height, b.beatsPerBar], [1080, 1920, 3]);
  assert.match((await call('GET', '/agent/boards/vertical')).body, /· 9:16 \(1080×1920\) ·/);
  // The editor makes a board from the idea alone, then asks for the message to hand it over.
  const fresh = await call('POST', '/api/boards', { title: 'Untitled', brief: 'A 20 s loop of ink in water', aspect: '1:1', fps: 24 });
  const slug = fresh.body.slug;
  let text = (await call('GET', `/api/boards/${slug}/handoff`)).body.text;
  assert.match(text, new RegExp(`^Take over my Cutroom storyboard “Untitled”: ${BASE}/#${slug}\n`));
  assert.match(text, /\nUse your storyboard skill \(without it, read http:\/\/127\.0\.0\.1:\d+\/agent first/);
  assert.match(text, /What it's for: A 20 s loop of ink in water/);
  assert.match(text, /starting with a title.*Lay the idea out as scenes with quick sketches/);
  assert.match(text, new RegExp(`keep \`.*/sb -b ${slug} wait\` running in the background`));
  await call('POST', `/agent/boards/${slug}/ops`, { ops: [{ op: 'board.set', fields: { owner: 'Claude (ink session)' } }] });
  text = (await call('GET', `/api/boards/${slug}/handoff`)).body.text;
  assert.match(text, /^Pick up my Cutroom storyboard “Untitled” again.*\nUse your storyboard skill/);
  text = (await call('GET', `/api/boards/${slug}/handoff?sent=2%20notes`)).body.text;
  assert.match(text, /^I've sent you 2 notes on my Cutroom storyboard “Untitled” \(.*\)\. Use your storyboard skill/);
});

test('agents and browsers get different things at /', async () => {
  const agent = await fetch(`${BASE}/`);
  assert.match(await agent.text(), /^# Cutroom agent API/);
  const page = await fetch(`${BASE}/`, { headers: { accept: 'text/html' } });
  assert.match(await page.text(), /<title>Cutroom<\/title>/);
  const manual = await call('GET', '/agent/help/all');
  assert.equal(manual.status, 200);
  assert.match(manual.body, /`canvas` is 1600×\d+: 1600 wide/);
});
