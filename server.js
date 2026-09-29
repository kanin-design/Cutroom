#!/usr/bin/env node
// Storyboard server: serves the editor, owns every open board in memory, applies ops from the
// browser and from `sb`, writes board.json after each change, and streams changes to every
// open page over Server-Sent Events. Edits made straight to board.json on disk are picked up too.
//
//   node server.js [--port 8840]

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import * as store from './lib/store.js';
import { applyOps, findScene, defaultDuration, placement, activeRender } from './lib/ops.js';
import { boardText } from './lib/text.js';
import { ingestRender, ingestAudio, mediaKind, stamp, libSource } from './lib/media.js';
import { agentApi, makeSay } from './lib/agent.js';
import { makeSketch, drawnStale, redrawCode } from './lib/sketch.js';
import { watchSketches } from './lib/folder.js';
import { exportAnimatic } from './lib/animatic.js';
import { overview, boardRows } from './lib/manual.js';

const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.SB_PORT || 8840);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4v': 'video/mp4',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
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
      const next = computeBuild();
      if (next === BUILD) return;
      BUILD = next;
      for (const L of live.values()) broadcast(L, { type: 'build', build: BUILD });
    }, 600);
  }).on('error', () => {});
}

// ---------------------------------------------------------------- live boards

const live = new Map(); // slug -> { slug, board, written, clients:Set, say, lastAgentAt, watcher }

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
  L = { slug, board, written: fs.readFileSync(store.file(slug), 'utf8'), clients: new Set(), waiters: new Set(), say: null, lastAgentAt: 0 };
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
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const c of L.clients) c.res.write(data);
}

function presence(L) {
  const watching = [...L.clients].filter(c => c.role === 'agent').length + L.waiters.size;
  return { type: 'presence', watching, say: L.say, lastAgentAt: L.lastAgentAt };
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
    if (req.method === 'GET') return send(res, 200, { boards: store.list() });
    if (req.method === 'POST') {
      const body = await json(req);
      const created = store.create(body.slug ? store.slugify(body.slug) : store.uniqueSlug(body.title || 'Untitled'), body);
      return send(res, 200, created);
    }
  }

  const L = open(slug);
  if (!action && req.method === 'GET') return send(res, 200, { slug, board: L.board });
  if (action === 'text') return send(res, 200, boardText(L.board, { slug, dir: store.dir(slug), notes: url.searchParams.get('notes') || 'open' }), 'text/plain; charset=utf-8');
  if (action === 'log') return send(res, 200, { entries: store.readLog(slug, { since: +url.searchParams.get('since') || 0, limit: +url.searchParams.get('limit') || 200 }) });
  if (action === 'events') return events(req, res, L, url);
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
  if (action === 'ingest') return ingest(req, res, L, url);
  send(res, 404, { error: 'not found' });
}

// A file dropped on the page: store it, then attach it where it was dropped.
async function ingest(req, res, L, url) {
  if (req.headers['x-storyboard'] !== '1') return send(res, 403, { error: 'missing x-storyboard header' });
  const name = path.basename(url.searchParams.get('name') || 'upload');
  const kind = mediaKind(name);
  if (!kind) return send(res, 400, { error: `can't use ${name} (not a still, clip or audio file)` });
  const tmp = path.join(os.tmpdir(), `sb-${stamp()}-${name}`);
  await pipeline(req, fs.createWriteStream(tmp));
  try {
    const dir = store.dir(L.slug);
    const q = k => url.searchParams.get(k);
    const stem = `${stamp()}`;
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
    const duration = r.kind === 'video' ? r.duration : defaultDuration(L.board);
    const pos = q('before') ? { before: q('before') } : q('after') ? { after: q('after') } : {};
    return send(res, 200, commit(L, [{ op: 'scene.add', scene: { title, duration: r.kind === 'code' ? r.duration : duration, status: r.sketch ? 'idea' : 'draft', renders: [r] }, ...pos }]));
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}

function events(req, res, L, url) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 1000\n\n');
  const c = { res, role: url.searchParams.get('role') === 'agent' ? 'agent' : 'ui' };
  L.clients.add(c);
  res.write(`data: ${JSON.stringify({ type: 'hello', rev: L.board.rev, build: BUILD })}\n\n`);
  res.write(`data: ${JSON.stringify(presence(L))}\n\n`);
  if (c.role === 'agent') broadcast(L, presence(L));
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
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
  const type = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...(type === 'image/svg+xml' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" } : {}), 'Cache-Control': p.includes(`${path.sep}media${path.sep}`) ? 'max-age=31536000, immutable' : 'no-cache' };
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? +range[1] : st.size - +range[2];
    const end = range[1] && range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) return res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(p, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(p).pipe(res);
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
  let data = '';
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

const agent = agentApi({ open, commit, broadcast, presence, send, json });

server.listen(PORT, HOST, () => {
  // Open every board now, so each one's sketches folder is watched from the start.
  for (const b of store.list()) {
    try { open(b.slug); } catch (e) { console.warn(`[${b.slug}] couldn't open: ${e.message}`); }
  }
  console.log(`storyboard → http://${HOST}:${PORT}`);
  console.log(`agent API and manual → http://${HOST}:${PORT}/agent`);
  console.log(`boards in ${store.HOME}`);
});
