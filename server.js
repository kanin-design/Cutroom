#!/usr/bin/env node
// The Cutroom server: serves the editor, owns every open board in memory, applies ops from the
// browser and from `sb`, writes board.json after each change, and streams changes to every
// open page over Server-Sent Events. Edits made straight to board.json on disk are picked up too.
//
//   node server.js [--port 8840]

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pipeline as pipe } from 'node:stream';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import * as store from './lib/store.js';
import { applyOps, findScene, defaultDuration, placement, activeRender, forYou, noteState, editList } from './lib/ops.js';
import { boardText } from './lib/text.js';
import { ingestRender, ingestAudio, mediaKind, stamp, libSource, saveAttachment, frameAt } from './lib/media.js';
import { agentApi, makeSay } from './lib/agent.js';
import { chrome } from './lib/codesketch.js';
import { makeSketch, drawnStale, redrawCode } from './lib/sketch.js';
import { watchSketches } from './lib/folder.js';
import { exportAnimatic } from './lib/animatic.js';
import { cutStatus, exportCut, cutReport } from './lib/cut.js';
import { overview, boardRows, handoff } from './lib/manual.js';

const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.SB_PORT || 8840);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4v': 'video/mp4',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.mov': 'video/quicktime', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// ---------------------------------------------------------------- the editor's build
// A fingerprint of every file the editor loads. Pages get it in index.html and again on every
// (re)connect, and it's pushed when the files change, so a tab left open across an update knows
// it's running old code and reloads itself.
const BUILD_DIRS = ['web', 'lib'];
function computeBuild() {
  const h = crypto.createHash('sha1');
  for (const d of BUILD_DIRS)
    for (const f of fs.readdirSync(path.join(store.ROOT, d)).sort())
      if (/\.(js|css|html)$/.test(f)) h.update(f).update(fs.readFileSync(path.join(store.ROOT, d, f)));
  return h.digest('hex').slice(0, 10);
}
let BUILD = computeBuild();
let buildTimer;
for (const d of BUILD_DIRS) {
  fs.watch(path.join(store.ROOT, d), () => {
    clearTimeout(buildTimer);
    buildTimer = setTimeout(() => {
      restartOnNewCode();
      const next = computeBuild();
      if (next === BUILD) return;
      BUILD = next;
      for (const L of live.values()) broadcast(L, { type: 'build', build: BUILD });
    }, 600);
  }).on('error', () => {});
}

// ---------------------------------------------------------------- staying current
// Started by `sb start` (SB_AUTORESTART=1), the server restarts itself when its own code changes, so
// agents never meet an old server that lacks what the manual describes. New code that doesn't parse,
// or a new server that doesn't come up, leaves this one running.
const serverFiles = () => ['server.js', ...fs.readdirSync(path.join(store.ROOT, 'lib')).filter(f => f.endsWith('.js')).map(f => `lib/${f}`)];
const serverCode = () => {
  const h = crypto.createHash('sha1');
  for (const f of serverFiles()) h.update(f).update(fs.readFileSync(path.join(store.ROOT, f)));
  return h.digest('hex');
};
let SERVER_CODE = serverCode();
let restarting = false;
async function restartOnNewCode() {
  if (process.env.SB_AUTORESTART !== '1' || restarting) return;
  const next = serverCode();
  if (next === SERVER_CODE) return;
  for (const f of serverFiles()) {
    try { execFileSync(process.execPath, ['--check', path.join(store.ROOT, f)], { stdio: 'pipe' }); } catch {
      console.warn(`[restart] the code changed, but ${f} doesn't parse; staying on the running code`);
      return;
    }
  }
  restarting = true;
  console.log('[restart] the server code changed; handing over to a new server');
  server.close();
  for (const L of live.values()) { for (const c of L.clients) c.res.end(); L.clients.clear(); }
  const child = spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    try { if ((await fetch(`http://${HOST}:${PORT}/api/ping`)).ok) { console.log('[restart] the new server is up'); process.exit(0); } } catch {}
  }
  console.warn('[restart] the new server did not come up (see above); carrying on with the running code');
  SERVER_CODE = next;
  restarting = false;
  try { server.listen(PORT, HOST); } catch (e) { console.error(`[restart] couldn't listen again: ${e.message}`); }
}
fs.watch(path.join(store.ROOT, 'server.js'), () => { clearTimeout(buildTimer); buildTimer = setTimeout(restartOnNewCode, 600); }).on('error', () => {});

// ---------------------------------------------------------------- live boards

const live = new Map(); // slug -> { slug, board, written, clients:Set, waiters:Set, say, lastAgentAt, watcher, … }

// When an agent last did something on a board, from its log: after a restart, a session that was
// working a minute ago still counts as working.
const AUTHORS_NOT_AGENTS = ['you', 'storyboard', 'sketches folder'];
function lastAgentEntry(slug) {
  const e = store.readLog(slug, { limit: 200 }).findLast(x => !AUTHORS_NOT_AGENTS.includes(x.author));
  return e ? Date.parse(e.created) || 0 : 0;
}

function open(slug) {
  let L = live.get(slug);
  if (L && !store.exists(slug)) {
    L.watcher.close();
    L.sketchWatcher?.close();
    live.delete(slug);
    L = null;
  }
  if (L) return L;
  const board = store.read(slug);
  L = {
    slug, board, written: fs.readFileSync(store.file(slug), 'utf8'), clients: new Set(), waiters: new Set(), say: null, lastAgentAt: lastAgentEntry(slug),
    handed: false, // a wait handed the session notes, and it hasn't started waiting again: it's on them
    answering: 0, // a wait handed it a ping alone: until then it counts as listening, while it answers
    ping: { seq: 0, delivered: 0, at: 0, heard: 0 }, // the user looking for the session's window
  };
  let t;
  L.watcher = fs.watch(store.dir(slug), (_, name) => {
    if (name !== 'board.json') return;
    clearTimeout(t);
    t = setTimeout(() => reloadFromDisk(L), 80);
  });
  L.watcher.on('error', () => {});
  live.set(slug, L);
  L.sketchWatcher = watchSketches(L, commit);
  scheduleRedraw(L);
  return L;
}

// Someone edited board.json by hand (usually an agent). Take it if it parses.
function reloadFromDisk(L) {
  let text;
  try { text = fs.readFileSync(store.file(L.slug), 'utf8'); } catch { return; }
  if (text === L.written) return;
  try {
    const board = store.migrate(JSON.parse(text));
    if (!Array.isArray(board.scenes)) throw new Error('no scenes array');
    board.rev = Math.max(board.rev || 0, L.board.rev) + 1;
    L.board = board;
    L.written = store.write(L.slug, board);
    L.lastAgentAt = Date.now();
    const entry = { rev: board.rev, author: 'claude', created: new Date().toISOString(), summaries: ['edited board.json directly'], ops: [] };
    store.appendLog(L.slug, entry);
    broadcast(L, { type: 'reset', board, entry });
    for (const w of L.waiters) w(entry);
    console.log(`[${L.slug}] reloaded board.json from disk (rev ${board.rev})`);
  } catch (e) {
    console.warn(`[${L.slug}] ignored a board.json edit that doesn't parse: ${e.message}`);
  }
}

function commit(L, ops, { author = 'you', client = null } = {}) {
  const now = new Date().toISOString();
  const res = applyOps(L.board, ops, { author, now });
  L.board = res.board;
  L.written = store.write(L.slug, L.board);
  const batch = { type: 'batch', rev: L.board.rev, author, client, created: now, ops: res.applied, summaries: res.summaries };
  const entry = { rev: batch.rev, author, created: now, summaries: res.summaries, ops: res.applied, inverse: res.inverse };
  store.appendLog(L.slug, entry);
  if (author !== 'you') L.lastAgentAt = Date.now();
  broadcast(L, batch);
  for (const w of L.waiters) w(entry);
  scheduleRedraw(L);
  if (author !== 'you') broadcast(L, presence(L));
  return { ...batch, inverse: res.inverse };
}

// Code sketches that follow the film's clock (s.filmT) or use the shared library need their poster
// and filmstrip redrawn when their scene moves or the library changes. The editor always runs them
// live; this keeps the timeline, the board view and the contact sheet in step. Commits as author
// "storyboard", which doesn't wake agents waiting for the user.
function scheduleRedraw(L) {
  clearTimeout(L.redrawTimer);
  L.redrawTimer = setTimeout(() => redraw(L), 1500);
}

async function redraw(L) {
  if (L.redrawing) return void (L.redrawAgain = true);
  L.redrawing = true;
  L.redrawFailed ??= new Set();
  try {
    for (const s of [...L.board.scenes]) {
      const r = activeRender(s), at = placement(L.board, s.id);
      if (!drawnStale(r, at, L.board)) continue;
      const key = `${r.id}:${at.start}:${at.duration}:${L.board.sketchLib}`;
      if (L.redrawFailed.has(key)) continue;
      try {
        const fields = await redrawCode(store.dir(L.slug), r, L.board, at);
        if (!findScene(L.board, s.id)?.renders.some(x => x.id === r.id)) continue;
        commit(L, [{ op: 'render.set', scene: s.id, id: r.id, fields }], { author: 'storyboard' });
      } catch (e) {
        L.redrawFailed.add(key);
        console.warn(`[${L.slug}] couldn't redraw ${r.id} on ${s.id}: ${e.message}`);
      }
    }
  } finally {
    L.redrawing = false;
    if (L.redrawAgain) { L.redrawAgain = false; scheduleRedraw(L); }
  }
}

function broadcast(L, msg) {
  if (restarting) return; // handing over to a new server: its pages reconnect there
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const c of L.clients) {
    if (c.res.writableEnded || c.res.destroyed) { L.clients.delete(c); continue; }
    try { c.res.write(data); } catch { L.clients.delete(c); }
  }
}

// Whether a Claude session has the board: watching (waiting for notes right now, or answering a ping
// until answeringUntil, as good as waiting), or busy until busyUntil (it was handed notes, or has one
// marked working, and hasn't come back to wait: it's working on them, as long as it was heard from in the
// last half hour). Notes sent while it's busy reach it the moment it waits again.
const BUSY_FOR = 30 * 60_000;
function presence(L) {
  const watching = [...L.clients].filter(c => c.role === 'agent').length + L.waiters.size;
  const working = L.handed || L.board.notes.some(n => noteState(n) === 'working');
  const busyUntil = !watching && working ? L.lastAgentAt + BUSY_FOR : 0;
  const ping = L.ping.at ? { at: L.ping.at, heard: L.ping.heard >= L.ping.at ? L.ping.heard : 0 } : null;
  return { type: 'presence', watching, answeringUntil: L.answering, busyUntil, say: L.say, lastAgentAt: L.lastAgentAt, ping };
}

// ---------------------------------------------------------------- http

const server = http.createServer(async (req, res) => {
  try {
    // Only answer to this machine's own names, so a web page can't reach the API by DNS rebinding.
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return send(res, 403, { error: 'forbidden host' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    // Browsers get the editor; anything else asking for / (curl, an agent) gets the agent manual.
    const wantsHtml = String(req.headers.accept || '').includes('text/html');
    if ((url.pathname === '/' && !wantsHtml) || url.pathname === '/llms.txt' || url.pathname === '/agent.md')
      return send(res, 200, overview({ base: `http://${req.headers.host}`, boards: boardRows(store.list(), store.read), root: store.ROOT }), 'text/markdown; charset=utf-8');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(store.ROOT, 'web/index.html'), 'utf8').replaceAll('%BUILD%', BUILD).replaceAll('%ROOT%', store.ROOT);
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (parts[0] === 'agent') return await agent(req, res, url, parts.slice(1));
    if (parts[0] === 'web' || parts[0] === 'lib') return file(req, res, inside(path.join(store.ROOT, parts[0]), parts.slice(1)));
    if (parts[0] === 'media' && parts[1]) return file(req, res, inside(path.join(store.dir(parts[1]), 'media'), parts.slice(2)));
    if (parts[0] === 'api') return await api(req, res, url, parts.slice(1));
    send(res, 404, { error: `not found — agents: the API and its manual are at http://${req.headers.host}/agent` });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 400, { error: e.message });
    else res.end();
  }
});

async function api(req, res, url, [a, slug, action]) {
  if (a === 'ping') return send(res, 200, { ok: true, port: PORT });
  if (a !== 'boards') return send(res, 404, { error: `/api is the editor's own API — agents: use http://${req.headers.host}/agent` });

  if (!slug) {
    if (req.method === 'GET') {
      // For the switcher: who owns each board, whether an agent is listening, what waits on you, and the
      // notes you wrote there but haven't sent.
      const boards = store.list().map(x => {
        const b = live.get(x.slug)?.board || store.read(x.slug);
        const L = live.get(x.slug);
        const p = L ? presence(L) : null;
        return { ...x, listening: p ? p.watching || +(p.answeringUntil > Date.now()) : 0, busy: !!p && p.busyUntil > Date.now(), forYou: b.notes.filter(forYou).length, open: b.notes.filter(n => !n.resolved && n.sent).length, unsent: b.notes.filter(n => n.author === 'you' && !n.sent && !n.resolved).length, changes: editList(b).length };
      });
      return send(res, 200, { boards });
    }
    if (req.method === 'POST') {
      const body = await json(req);
      const created = store.create(body.slug ? store.slugify(body.slug) : store.uniqueSlug(body.title || 'Untitled'), body);
      return send(res, 200, created);
    }
  }

  const L = open(slug);
  if (!action && req.method === 'GET') return send(res, 200, { slug, board: L.board });
  // The message that hands this board to a Claude session (?sent=… when notes were just sent to nobody).
  if (action === 'handoff') {
    // After a Send nobody heard: the new session reads it the way a listening one would have, from the send on.
    const last = store.readLog(slug, { limit: 1000 }).findLast(e => (e.ops || []).some(o => o.op === 'notes.send'));
    return send(res, 200, { text: handoff(L.board, { base: `http://${req.headers.host}`, slug, root: store.ROOT, sent: url.searchParams.get('sent'), since: last ? last.rev - 1 : null }) });
  }
  if (action === 'text') return send(res, 200, boardText(L.board, { slug, dir: store.dir(slug), notes: url.searchParams.get('notes') || 'open' }), 'text/plain; charset=utf-8');
  if (action === 'log') return send(res, 200, { entries: store.readLog(slug, { since: +url.searchParams.get('since') || 0, limit: +url.searchParams.get('limit') || 200 }) });
  if (action === 'events') return events(req, res, L, url);
  if (action === 'frame' && req.method === 'GET') {
    // One frame of a scene, as the server draws it for agents too (clips, stills and code sketches
    // alike), up to w pixels wide: what the annotator opens on.
    const out = path.join(os.tmpdir(), `sb-frame-${stamp()}.jpg`);
    try {
      const w = Math.min(3840, Math.max(320, +url.searchParams.get('w') || 1920));
      const f = await frameAt(L.board, store.dir(slug), { scene: url.searchParams.get('scene'), at: url.searchParams.get('at') }, out, { width: w });
      res.on('finish', () => fs.rm(out, { force: true }, () => {}));
      res.setHeader('X-Frame-Label', encodeURIComponent(f.label));
      return file(req, res, f.path);
    } catch (e) {
      fs.rm(out, { force: true }, () => {});
      return send(res, e.status || 400, { error: e.message });
    }
  }
  // The cut: the film at a size and quality from each scene's own render. Asking starts it and says where it
  // stands (the editor asks again until it's done); ?file=1 then hands over the file.
  if (action === 'cut') {
    const opts = { size: url.searchParams.get('size') || '1080p', quality: url.searchParams.get('quality') || 'final', partial: url.searchParams.get('partial') === '1' };
    try {
      if (url.searchParams.get('file') === '1') {
        const x = exportCut(L, store.dir(slug), opts);
        const r = await x.job;
        res.setHeader('Content-Disposition', `attachment; filename="${slug}-${opts.size}-${opts.quality}${opts.partial ? '-partial' : ''}.mp4"`);
        return file(req, res, r.path);
      }
      if (url.searchParams.get('plan') === '1') { const { plan, ...rep } = cutReport(L.board, opts.size, opts.quality, store.dir(slug)); return send(res, 200, rep); }
      return send(res, 200, cutStatus(L, store.dir(slug), opts));
    } catch (e) {
      return send(res, e.status || 500, { error: e.message });
    }
  }
  if (action === 'animatic') {
    const scale = Math.min(1, Math.max(0.1, +url.searchParams.get('scale') || 0.5));
    const a = await exportAnimatic(L, store.dir(slug), { scale });
    const data = fs.readFileSync(a.path);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': data.length, 'Content-Disposition': `attachment; filename="${slug}-animatic.mp4"`, 'Cache-Control': 'no-store' });
    return res.end(data);
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  if (action === 'ops') {
    const body = await json(req);
    return send(res, 200, commit(L, body.ops, { author: body.author || 'you', client: body.client || null }));
  }
  if (action === 'say') {
    const body = await json(req);
    try { L.say = makeSay(L.board, body, body.author || 'claude'); } catch (e) { return send(res, e.status || 400, { error: e.message }); }
    L.lastAgentAt = Date.now();
    broadcast(L, presence(L));
    return send(res, 200, { ok: true });
  }
  // Ping: the user is looking for the session's window. A session waiting for notes hears it now; a busy
  // one, the moment it waits again. It answers in its own window.
  if (action === 'ping') {
    L.ping.seq++;
    L.ping.at = Date.now();
    for (const w of [...L.waiters]) w({ ping: true });
    broadcast(L, presence(L));
    return send(res, 200, { ok: true, heardNow: L.ping.delivered === L.ping.seq });
  }
  if (action === 'ingest') return ingest(req, res, L, url);
  if (action === 'attach') return attach(req, res, L, url);
  if (action === 'delete') {
    if (!fromEditor(req, res)) return;
    return send(res, 200, deleteBoard(L));
  }
  if (action === 'revert') {
    // What undoing one logged change (an agent's, typically) would do now: the ops and one sentence
    // each, checked against the current board. The page shows that, then commits the ops itself, so
    // the revert is one of the user's own changes (and ⌘Z undoes it).
    const rev = +(await json(req)).rev;
    const entry = store.readLog(L.slug, { since: rev - 1, limit: 100000 }).find(e => e.rev === rev);
    if (!entry?.inverse?.length) return send(res, 404, { error: `rev ${rev} has nothing to revert` });
    try {
      const { summaries } = applyOps(L.board, entry.inverse, { author: 'you', now: new Date().toISOString() });
      const later = store.readLog(L.slug, { since: rev, limit: 100000 }).filter(e => e.author !== 'storyboard').length;
      return send(res, 200, { rev, ops: entry.inverse, summaries, later });
    } catch (e) {
      return send(res, 409, { error: `can't revert rev ${rev} any more: ${e.message}` });
    }
  }
  send(res, 404, { error: 'not found' });
}

// A file dropped on the page: store it, then attach it where it was dropped.
async function ingest(req, res, L, url) {
  if (!fromEditor(req, res)) return;
  const name = path.basename(url.searchParams.get('name') || 'upload');
  const kind = mediaKind(name);
  if (!kind) return send(res, 400, { error: `can't use ${name} (not a still, clip or audio file)` });
  return withUpload(req, name, async tmp => {
    const dir = store.dir(L.slug);
    const q = k => url.searchParams.get(k);
    const stem = stamp();
    if (q('as') === 'audio' || kind === 'audio') {
      const audio = await ingestAudio(dir, tmp, { base: stem });
      audio.name = name;
      return send(res, 200, commit(L, [{ op: 'audio.set', audio }]));
    }
    const target = findScene(L.board, q('scene'));
    const r = kind === 'sketch' || kind === 'code'
      ? await makeSketch(dir, { path: tmp }, L.board, { base: `${q('scene') || 'new'}-sketch-${stem}`, at: target ? placement(L.board, target.id) : null, lib: libSource(L.board, dir) })
      : await ingestRender(dir, tmp, { base: `${q('scene') || 'new'}-${stem}` });
    r.source = name;
    const scene = q('scene');
    if (scene && findScene(L.board, scene)) return send(res, 200, commit(L, [{ op: 'render.add', scene, render: r }]));
    const title = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    const duration = r.kind === 'video' || r.kind === 'code' ? r.duration : defaultDuration(L.board);
    const pos = q('before') ? { before: q('before') } : q('after') ? { after: q('after') } : {};
    return send(res, 200, commit(L, [{ op: 'scene.add', scene: { title, duration, status: r.sketch ? 'idea' : 'draft', renders: [r] }, ...pos }]));
  });
}

// A file for a note or reply: saved into the board's media/refs, described back to the page, which
// puts it on the note it then adds.
async function attach(req, res, L, url) {
  if (!fromEditor(req, res)) return;
  const name = path.basename(url.searchParams.get('name') || 'file');
  return withUpload(req, name, async tmp => {
    try {
      return send(res, 200, { file: await saveAttachment(store.dir(L.slug), tmp, name) });
    } catch (e) {
      return send(res, e.status || 500, { error: e.message });
    }
  });
}

// Uploads and deletes come with this header instead of a JSON body. Like JSON, a custom header
// forces a CORS preflight, so only the editor's own page can send them.
function fromEditor(req, res) {
  if (req.headers['x-storyboard'] === '1') return true;
  send(res, 403, { error: 'missing x-storyboard header' });
  return false;
}

// The request body in a temporary file named like the upload, for `use`; removed afterwards.
async function withUpload(req, name, use) {
  const tmp = path.join(os.tmpdir(), `sb-${stamp()}-${name}`);
  await pipeline(req, fs.createWriteStream(tmp));
  try {
    return await use(tmp);
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}

// Deleting a board moves its folder to the Trash, so it can still be brought back until the Trash is
// emptied. Open editors move on to another board, and agents listening on it are told it's gone.
function deleteBoard(L) {
  const trash = path.join(os.homedir(), '.Trash');
  fs.mkdirSync(trash, { recursive: true });
  let to = path.join(trash, `storyboard ${L.slug}`);
  if (fs.existsSync(to)) to += ` ${new Date().toISOString().slice(0, 19).replace(/:/g, '.')}`;
  broadcast(L, { type: 'deleted', slug: L.slug });
  for (const c of L.clients) c.res.end();
  L.clients.clear();
  for (const w of [...L.waiters]) w({ deleted: true });
  L.watcher?.close();
  L.sketchWatcher?.close();
  clearTimeout(L.redrawTimer);
  live.delete(L.slug);
  fs.renameSync(store.dir(L.slug), to);
  console.log(`[${L.slug}] deleted by the user (moved to ${to})`);
  return { ok: true, trash: to };
}

function events(req, res, L, url) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 1000\n\n');
  const c = { res, role: url.searchParams.get('role') === 'agent' ? 'agent' : 'ui' };
  L.clients.add(c);
  res.write(`data: ${JSON.stringify({ type: 'hello', rev: L.board.rev, build: BUILD })}\n\n`);
  res.write(`data: ${JSON.stringify(presence(L))}\n\n`);
  if (c.role === 'agent') broadcast(L, presence(L));
  const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20000);
  req.on('close', () => {
    clearInterval(ping);
    L.clients.delete(c);
    if (c.role === 'agent') broadcast(L, presence(L));
  });
}

// ---------------------------------------------------------------- helpers

function inside(root, rest) {
  const p = path.resolve(root, ...rest);
  if (p !== root && !p.startsWith(root + path.sep)) throw Object.assign(new Error('forbidden'), { status: 403 });
  return p;
}

function file(req, res, p) {
  let st;
  try { st = fs.statSync(p); } catch { return send(res, 404, { error: 'not found' }); }
  if (!st.isFile()) return send(res, 404, { error: 'not found' });
  let type = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
  if (p.includes(`${path.sep}refs${path.sep}`) && /html|javascript/.test(type)) type = 'text/plain; charset=utf-8';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...(type === 'image/svg+xml' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" } : {}), 'Cache-Control': p.includes(`${path.sep}media${path.sep}`) ? 'max-age=31536000, immutable' : 'no-cache' };
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? +range[1] : Math.max(0, st.size - +range[2]);
    const end = range[1] && range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) return res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    // pipe() would leave the file open when the browser drops a range request (every scrub does) and crash
    // the server if the file went away; pipeline closes both ends either way
    return pipe(fs.createReadStream(p, { start, end }), res, () => {});
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  pipe(fs.createReadStream(p), res, () => {});
}

function send(res, status, body, type) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

async function json(req) {
  // Requiring JSON forces a CORS preflight, which this server never grants to other origins.
  if (!String(req.headers['content-type'] || '').includes('application/json'))
    throw Object.assign(new Error('send the body as JSON with the header Content-Type: application/json'), { status: 415 });
  // joined as bytes, then decoded: a character split across two chunks must not turn into �
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const data = Buffer.concat(chunks).toString('utf8');
  return data ? JSON.parse(data) : {};
}

const agent = agentApi({ open, commit, broadcast, presence, send, json });

server.listen(PORT, HOST, () => {
  // Open every board now, so each one's sketches folder is watched from the start.
  for (const b of store.list()) {
    try { open(b.slug); } catch (e) { console.warn(`[${b.slug}] couldn't open: ${e.message}`); }
  }
  console.log(`Cutroom → http://${HOST}:${PORT}`);
  console.log(`agent API and manual → http://${HOST}:${PORT}/agent`);
  console.log(`boards in ${store.HOME}`);
  // What the media features need, said once at the start rather than as an error later.
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { console.warn('ffmpeg not found: clips, stills and soundtracks need it (brew install ffmpeg)'); }
  if (!chrome()) console.warn('Google Chrome not found: code sketches play in the editor, but their posters and contact sheets need it (or set CHROME to a Chromium-based browser)');
});
