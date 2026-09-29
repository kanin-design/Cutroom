// `sb`: the agent's side of the storyboard. Every command reads board.json or turns into ops.
// When the server is running, ops go through it so the open page updates live; otherwise they
// are applied to the file directly. Run `sb help` for the reference.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as store from './store.js';
import { applyOps, STATUSES, findScene, locate, snapFrame, defaultDuration } from './ops.js';
import { boardText, sceneText, notesText } from './text.js';
import { ingestRender, ingestAudio, stamp, frameAt, contactSheet, sceneStrip } from './media.js';
import { overview, topic, topicNames, boardRows } from './manual.js';
import { prepareOps } from './sketch.js';

const PORT = Number(process.env.SB_PORT || 8840);
const BASE = `http://127.0.0.1:${PORT}`;
const BOOL = new Set(['json', 'all', 'resolve', 'keep', 'no-activate', 'first', 'last', 'fit', 'help', 'clear', 'code']);

const HELP = `sb — the agent's side of the storyboard (UI: ${BASE})

Boards
  sb boards                                   list boards
  sb new <title> [--fps 60] [--size 2560x1440] [--bpm 128] [--brief ".."] [--slug s]
  sb use <board>                              write .storyboard here so later calls target it
  sb open                                     open the board in the browser
  sb start                                    start the server in the background (it outlives this shell)
  sb stop                                     stop the server
  sb serve                                    run the server in the foreground
  sb manual [topic]                           the agent overview, or one topic (also served at ${BASE}/agent)

Read
  sb show [--all]                             the whole board as a shot list (--all: resolved notes too)
  sb scene <sX>                               one scene with every render version and its notes
  sb notes [--all]                            open notes with replies
  sb log [--since <rev>]                      what changed and who changed it
  sb sheet                                    the whole board as one labelled image (prints the jpg path)
  sb strip <sX> [--n 6]                       n frames across a scene, pinned notes marked
  sb frame <nX | sX [--at 1.2] | seconds>     one frame as a jpg (a note's pin is drawn on it)
  sb wait [--on send|change] [--timeout 86400]
                                              listen until the user sends you notes (or, with --on change, edits
                                              anything), then print them; rides out server restarts; exit 2 on timeout
  sb json                                     raw board.json

Scenes
  sb add <title> [--dur 3.75] [--after sX | --before sX] [--picture ..] [--sound ..] [--status draft] [--render file] [--sketch file]
  sb set <sX> key=value ...                   title dur picture sound status color meta.<key>
  sb move <sX> --after sY | --before sY | --first | --last
  sb rm <sX>
  sb split <sX> <seconds-into-scene>

Renders (stills or clips; clips get a scrub-friendly proxy, a poster and a filmstrip)
  sb render <sX> <file> [--caption ..] [--fit] [--keep] [--no-activate]
                                              --fit sets the scene duration to the clip's length
                                              --keep copies the clip as is instead of making a proxy
  sb pick <sX> <rY>                           make an earlier version the one that plays
  sb sketch <sX> <file | -> [--code] [--paper dark]
                                              a sketch on a scene, no rendering needed: a .js code sketch,
                                              an .svg drawing, or any still or clip (- reads SVG, or code
                                              with --code, from stdin)
  sb sketch --new <title> [--after sX] [--dur 2] [--picture ..] <file | ->
                                              a new idea scene with that sketch
  (or save s3.png / s3.mp4 / s3.svg / s3.js into the board's sketches/ folder; see sb manual)
  sb unrender <sX> <rY>

Notes
  sb note <sX|board> <text> [--at 1.2] [--pin 0.4,0.6]
  sb reply <nX> <text> [--resolve]
  sb resolve <nX>  ·  sb reopen <nX>

Board
  sb board key=value ...                      title brief fps width height bpm beatsPerBar beatOffset
  sb audio <file> | --clear                   the soundtrack
  sb marker <seconds> <label>  ·  sb unmark <mX>
  sb say <text> [--scene s4] [--progress 40] | --clear
                                              a status line the user sees ("rendering s4 at half res…");
                                              with --scene that shot shows it's being worked on
  sb focus <sX | nX | seconds>                move the user's playhead there
  sb apply <file.json | ->                    a JSON array of raw ops, applied atomically

Options: -b <board> (default: SB_BOARD, then .storyboard up the tree, then the latest board)
         --as <name> (default: claude)
Times are seconds. Durations snap to whole frames. Ids never change once given.`;

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const pos = [], flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-b') flags.b = argv[++i];
  else if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split(/=(.*)/s);
    if (v !== undefined) flags[k] = v;
    else if (BOOL.has(k)) flags[k] = true;
    else flags[k] = argv[++i];
  } else pos.push(a);
}
const AS = flags.as || 'claude';
const cmd = pos.shift() || 'help';

// ---------------------------------------------------------------- plumbing

let up;
async function serverUp() {
  if (up !== undefined) return up;
  try {
    const r = await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(500) });
    up = r.ok;
  } catch {
    up = false;
  }
  return up;
}

function resolveSlug() {
  if (flags.b) return flags.b;
  if (process.env.SB_BOARD) return process.env.SB_BOARD;
  for (let d = process.cwd(); ; d = path.dirname(d)) {
    const f = path.join(d, '.storyboard');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
    if (d === path.dirname(d)) break;
  }
  const latest = store.list()[0];
  if (!latest) fail('no boards yet — make one with `sb new <title>`');
  return latest.slug;
}

// Starts the server in the background if it isn't running. True once it answers.
async function launch() {
  if (await serverUp()) return true;
  const log = path.join(store.ROOT, 'server.log');
  const child = spawn(process.execPath, [path.join(store.ROOT, 'server.js'), '--port', String(PORT)], { detached: true, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')] });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    up = undefined;
    if (await serverUp()) return true;
  }
  return false;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Every change goes through the server, the board's only writer; if it isn't running, start it.
// Only when it can't start (and so nothing else is writing) does sb write board.json itself.
async function commit(slug, ops) {
  let res;
  const wasUp = await serverUp();
  if (!wasUp && (await launch())) console.log(`(started the server — ${BASE})`);
  if (await serverUp()) {
    const r = await fetch(`${BASE}/api/boards/${slug}/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops, author: AS }) });
    res = await r.json();
    if (!r.ok) fail(res.error);
  } else {
    const now = new Date().toISOString();
    const out = applyOps(store.read(slug), ops, { author: AS, now });
    store.write(slug, out.board);
    store.appendLog(slug, { rev: out.board.rev, author: AS, created: now, summaries: out.summaries, ops: out.applied, inverse: out.inverse });
    res = { rev: out.board.rev, applied: out.applied, summaries: out.summaries };
  }
  for (const s of res.summaries) console.log(`✓ ${s}`);
  console.log(`  rev ${res.rev} · ${slug}${(await serverUp()) ? '' : ` · the server couldn't start (see ${path.join(store.ROOT, 'server.log')}), so this was written to board.json directly`}`);
  return res;
}

function fail(msg) {
  console.error(`sb: ${msg}`);
  process.exit(1);
}

const need = (v, what) => (v === undefined || v === '' ? fail(`missing ${what} — see \`sb help\``) : v);
const fileArg = f => {
  const p = path.resolve(need(f, 'file'));
  if (!fs.existsSync(p)) fail(`no such file: ${p}`);
  return p;
};
const sceneOf = (b, id) => findScene(b, id) || fail(`no scene ${id} (scenes: ${b.scenes.map(s => s.id).join(', ') || 'none'})`);

function where() {
  if (flags.after) return { after: flags.after };
  if (flags.before) return { before: flags.before };
  if (flags.first) return { index: 0 };
  return {};
}

function parsePairs(pairs, scene) {
  const fields = {};
  for (const p of pairs) {
    const m = /^([\w.]+)=(.*)$/s.exec(p);
    if (!m) fail(`expected key=value, got "${p}"`);
    let [, k, v] = m;
    if (k === 'dur') k = 'duration';
    if (k.startsWith('meta.')) {
      fields.meta ??= { ...(scene?.meta || {}) };
      const key = k.slice(5);
      if (v === '') delete fields.meta[key];
      else fields.meta[key] = v;
      continue;
    }
    fields[k] = v;
  }
  return fields;
}

async function renderFor(slug, sceneId, file) {
  console.log(`… preparing ${path.basename(file)}`);
  const r = await ingestRender(store.dir(slug), file, { base: `${sceneId}-${stamp()}`, proxy: !flags.keep });
  r.source = file;
  if (flags.caption || flags.note) r.caption = flags.caption || flags.note;
  return r;
}

// ---------------------------------------------------------------- commands

const commands = {
  help: () => console.log(HELP),

  boards() {
    const all = store.list();
    if (!all.length) return console.log('No boards yet. `sb new <title>`');
    for (const b of all) console.log(`${b.slug.padEnd(24)} ${String(b.scenes).padStart(3)} scenes  ${b.duration.toFixed(2).padStart(7)}s  ${b.title}`);
  },

  async new() {
    const title = need(pos.join(' '), 'title');
    const [width, height] = (flags.size || '1920x1080').split('x').map(Number);
    const slug = flags.slug ? store.slugify(flags.slug) : store.uniqueSlug(title);
    store.create(slug, { title, width, height, fps: flags.fps ? +flags.fps : 30, bpm: flags.bpm ? +flags.bpm : null, brief: flags.brief || '' });
    console.log(`✓ made board ${slug} — ${BASE}/#${slug}`);
    console.log(`  tip: \`sb use ${slug}\` in the project folder makes it the default there`);
  },

  use() {
    const slug = need(pos[0], 'board');
    if (!store.exists(slug)) fail(`no board ${slug}`);
    fs.writeFileSync(path.join(process.cwd(), '.storyboard'), slug + '\n');
    console.log(`✓ ${process.cwd()}/.storyboard → ${slug}`);
  },

  async open() {
    const slug = resolveSlug();
    if (!(await launch())) fail(`the server didn't come up — see ${path.join(store.ROOT, 'server.log')}`);
    spawn('open', [`${BASE}/#${slug}`], { stdio: 'ignore', detached: true }).unref();
  },

  serve() {
    spawn(process.execPath, [path.join(store.ROOT, 'server.js'), '--port', String(PORT)], { stdio: 'inherit' });
  },

  show() {
    const slug = resolveSlug();
    console.log(boardText(store.read(slug), { slug, dir: store.dir(slug), notes: flags.all ? 'all' : 'open' }));
  },

  scene() {
    const slug = resolveSlug();
    console.log(sceneText(store.read(slug), need(pos[0], 'scene id'), { dir: store.dir(slug) }));
  },

  notes() {
    console.log(notesText(store.read(resolveSlug()), { all: !!flags.all }));
  },

  json() {
    console.log(fs.readFileSync(store.file(resolveSlug()), 'utf8'));
  },

  log() {
    const slug = resolveSlug();
    const entries = store.readLog(slug, { since: +flags.since || 0, limit: flags.since ? 1000 : 30 });
    if (!entries.length) return console.log('Nothing yet.');
    for (const e of entries) for (const s of e.summaries) console.log(`rev ${String(e.rev).padEnd(4)} ${e.created.slice(11, 19)}Z  ${e.author.padEnd(7)} ${s}`);
  },

  // Wait until the user presses Send to Claude (or, with --on change, until they change anything),
  // then print what they sent. Run it in the background and start it again when it returns.
  // Listens until the user sends notes (or, with --on change, anyone else edits the board). It asks in
  // stretches of four minutes from one fixed rev, so a server restart or a dropped connection costs
  // nothing: it waits for the server to come back and carries on, and no send is missed.
  async wait() {
    const slug = resolveSlug();
    const on = flags.on || 'send';
    const seconds = +flags.timeout || (on === 'send' ? 86400 : 3600);
    const end = Date.now() + seconds * 1000;
    let since = flags.since ?? null;
    let away = false;
    while (Date.now() < end) {
      up = undefined;
      if (!(await serverUp())) {
        if (!away) console.error(`(the server isn't answering; still listening, and carrying on when it's back)`);
        away = true;
        await sleep(3000);
        continue;
      }
      away = false;
      try {
        if (since == null) since = (await (await fetch(`${BASE}/agent/boards/${slug}?format=json`)).json()).rev;
        const q = new URLSearchParams({ on, since: String(since), timeout: String(Math.max(1, Math.min(240, Math.ceil((end - Date.now()) / 1000)))), as: AS });
        const r = await fetch(`${BASE}/agent/boards/${slug}/wait?${q}`);
        const text = await r.text();
        if (!r.ok) fail(text);
        if (/^Nobody other than /.test(text)) continue; // a quiet stretch: keep listening from the same rev
        console.log(text.trim());
        process.exit(0);
      } catch {
        await sleep(2000); // the connection dropped (a restart, say): ask again
      }
    }
    console.log(`Nothing ${on === 'send' ? 'was sent' : 'changed'} on ${slug} in ${seconds}s. Run \`sb -b ${slug} wait\` again to keep listening.`);
    process.exit(2);
  },

  async add() {
    const slug = resolveSlug();
    const title = need(pos.join(' '), 'title');
    const b = store.read(slug);
    const scene = { title, picture: flags.picture, sound: flags.sound, status: flags.status };
    if (flags.dur) scene.duration = +flags.dur;
    if (flags.render) {
      const r = await renderFor(slug, 'new', fileArg(flags.render));
      scene.renders = [r];
      if (!flags.dur && r.kind === 'video') scene.duration = r.duration;
    }
    if (flags.sketch) scene.sketch = { path: fileArg(flags.sketch) };
    if (scene.duration == null) scene.duration = defaultDuration(b);
    await commit(slug, await prepareOps([{ op: 'scene.add', scene, ...where() }], b, store.dir(slug), { stamp }));
  },

  async set() {
    const slug = resolveSlug();
    const id = need(pos.shift(), 'scene id');
    const s = sceneOf(store.read(slug), id);
    await commit(slug, [{ op: 'scene.set', id, fields: parsePairs(pos, s) }]);
  },

  async board() {
    const slug = resolveSlug();
    await commit(slug, [{ op: 'board.set', fields: parsePairs(pos) }]);
  },

  async move() {
    const slug = resolveSlug();
    const id = need(pos[0], 'scene id');
    const w = where();
    if (flags.last) w.before = null;
    if (!Object.keys(w).length && !flags.last) fail('say where: --after sY, --before sY, --first or --last');
    await commit(slug, [{ op: 'scene.move', id, ...w }]);
  },

  async rm() {
    const slug = resolveSlug();
    await commit(slug, pos.map(id => ({ op: 'scene.remove', id })));
  },

  async split() {
    const slug = resolveSlug();
    const b = store.read(slug);
    const s = sceneOf(b, need(pos[0], 'scene id'));
    const at = snapFrame(b, +need(pos[1], 'seconds into the scene'));
    if (!(at > 0 && at < s.duration)) fail(`split point must be inside the scene (0–${s.duration}s)`);
    await commit(slug, [{ op: 'scene.split', id: s.id, at }]);
  },

  async render() {
    const slug = resolveSlug();
    const id = need(pos[0], 'scene id');
    sceneOf(store.read(slug), id);
    const r = await renderFor(slug, id, fileArg(pos[1]));
    const ops = [{ op: 'render.add', scene: id, render: r, activate: !flags['no-activate'] }];
    const fps = store.read(slug).fps;
    if (flags.fit && r.kind === 'video') ops.push({ op: 'scene.set', id, fields: { duration: Math.ceil(r.duration * fps - 1e-6) / fps } });
    await commit(slug, ops);
  },

  // A sketch from a file (.svg drawing, .js code sketch, still or clip), or from stdin (- is SVG, or
  // code with --code).
  async sketch() {
    const slug = resolveSlug();
    const b = store.read(slug);
    const source = f => (f === '-' ? { [flags.code ? 'code' : 'svg']: fs.readFileSync(0, 'utf8') } : { path: fileArg(f) });
    if (flags.new) {
      const src = source(need(pos[0], 'a file (or - for stdin)'));
      const scene = { title: flags.new, duration: flags.dur ? +flags.dur : defaultDuration(b), picture: flags.picture, sound: flags.sound, status: flags.status || 'idea', sketch: { ...src, ...(flags.paper ? { paper: flags.paper } : {}) } };
      return commit(slug, await prepareOps([{ op: 'scene.add', scene, ...where() }], b, store.dir(slug), { stamp }));
    }
    const id = need(pos[0], 'scene id');
    sceneOf(b, id);
    const src = source(need(pos[1], 'a file (or - for stdin)'));
    await commit(slug, await prepareOps([{ op: 'sketch.add', scene: id, ...src, ...(flags.paper ? { paper: flags.paper } : {}), caption: flags.caption }], b, store.dir(slug), { stamp }));
  },

  async pick() {
    const slug = resolveSlug();
    await commit(slug, [{ op: 'scene.set', id: need(pos[0], 'scene id'), fields: { activeRender: need(pos[1], 'render id') } }]);
  },

  async unrender() {
    const slug = resolveSlug();
    await commit(slug, [{ op: 'render.remove', scene: need(pos[0], 'scene id'), id: need(pos[1], 'render id') }]);
  },

  async note() {
    const slug = resolveSlug();
    const target = need(pos.shift(), 'scene id (or "board")');
    const text = need(pos.join(' '), 'text');
    const note = { text, scene: target === 'board' ? null : target };
    if (flags.at != null) note.at = +flags.at;
    if (flags.pin) {
      const [x, y] = flags.pin.split(',').map(Number);
      note.pin = { x, y };
    }
    await commit(slug, [{ op: 'note.add', note }]);
  },

  async reply() {
    const slug = resolveSlug();
    const id = need(pos.shift(), 'note id');
    const ops = [{ op: 'reply.add', note: id, reply: { text: need(pos.join(' '), 'text') } }];
    if (flags.resolve) ops.push({ op: 'note.set', id, fields: { resolved: true } });
    await commit(slug, ops);
  },

  async resolve() {
    const slug = resolveSlug();
    await commit(slug, pos.map(id => ({ op: 'note.set', id, fields: { resolved: true } })));
  },

  async reopen() {
    const slug = resolveSlug();
    await commit(slug, pos.map(id => ({ op: 'note.set', id, fields: { resolved: false } })));
  },

  async audio() {
    const slug = resolveSlug();
    if (flags.clear) return commit(slug, [{ op: 'audio.set', audio: null }]);
    const f = fileArg(pos[0]);
    console.log(`… preparing ${path.basename(f)}`);
    const audio = await ingestAudio(store.dir(slug), f, { base: stamp() });
    await commit(slug, [{ op: 'audio.set', audio }]);
  },

  async marker() {
    const slug = resolveSlug();
    await commit(slug, [{ op: 'marker.add', marker: { t: +need(pos[0], 'seconds'), label: pos.slice(1).join(' ') } }]);
  },

  async unmark() {
    const slug = resolveSlug();
    await commit(slug, pos.map(id => ({ op: 'marker.remove', id })));
  },

  async say() {
    const slug = resolveSlug();
    if (!(await serverUp())) return console.log('(server not running — nobody to tell)');
    const text = flags.clear ? null : need(pos.join(' '), 'text');
    const r = await fetch(`${BASE}/api/boards/${slug}/say`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, scene: flags.scene, progress: flags.progress, author: AS }) });
    if (!r.ok) fail((await r.json()).error);
    console.log(text ? `✓ status: ${text}${flags.scene ? ` (on ${flags.scene})` : ''}${flags.progress != null ? ` ${flags.progress}` : ''}` : '✓ status cleared');
  },

  async apply() {
    const slug = resolveSlug();
    const src = need(pos[0], 'file or -');
    const text = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
    await commit(slug, await prepareOps(JSON.parse(text), store.read(slug), store.dir(slug), { stamp }));
  },

  // Look at the picture: the frame a note points at (pin drawn), a scene at a time, or a point in the cut.
  async frame() {
    const slug = resolveSlug();
    const arg = need(pos[0], 'note id, scene id or seconds');
    const target = /^n\d+$/.test(arg) ? { note: arg } : /^s\d+$/.test(arg) ? { scene: arg, at: flags.at } : { t: +arg };
    const out = path.resolve(flags.out || path.join(store.dir(slug), 'frames', `${arg.replace(/[^\w.]/g, '_')}-${stamp()}.jpg`));
    try {
      const f = await frameAt(store.read(slug), store.dir(slug), target, out);
      console.log(f.label);
      console.log(f.path);
    } catch (e) {
      if (e.status === 409) return console.log(e.message);
      throw e;
    }
  },

  // The whole board as one labelled image.
  async sheet() {
    const slug = resolveSlug();
    const b = store.read(slug);
    const out = path.resolve(flags.out || path.join(store.dir(slug), 'frames', `sheet-rev${b.rev}.jpg`));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    console.log(await contactSheet(b, store.dir(slug), out, { slug }));
  },

  // n frames across one scene.
  async strip() {
    const slug = resolveSlug();
    const b = store.read(slug);
    const id = need(pos[0], 'scene id');
    const n = +(flags.n || 6);
    const out = path.resolve(flags.out || path.join(store.dir(slug), 'frames', `strip-${id}-n${n}-rev${b.rev}.jpg`));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    console.log(await sceneStrip(b, store.dir(slug), id, n, out));
  },

  // Point the user's editor at something.
  async focus() {
    const slug = resolveSlug();
    if (!(await serverUp())) return console.log('(server not running — nobody to show)');
    const a = need(pos[0], 'scene id, note id or seconds');
    const body = /^n\d+$/.test(a) ? { note: a } : /^s\d+$/.test(a) ? { scene: a } : { t: +a };
    const r = await fetch(`${BASE}/agent/boards/${slug}/focus`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, as: AS }) });
    const j = await r.json();
    if (!r.ok) fail(j.error);
    console.log(`✓ ${j.message}`);
  },

  // The short overview, or one topic of the full manual (sb manual code, sb manual all).
  manual() {
    const o = { base: BASE, boards: boardRows(store.list(), store.read), root: store.ROOT, home: store.HOME, read: store.read };
    if (!pos[0]) return console.log(overview(o));
    const text = topic(pos[0], o);
    if (!text) fail(`topics: ${topicNames().join(', ')}`);
    console.log(text);
  },

  // Start the server in the background (it keeps running after this shell exits).
  async start() {
    if (await serverUp()) return console.log(`✓ already running — ${BASE}`);
    const log = path.join(store.ROOT, 'server.log');
    if (await launch()) return console.log(`✓ started — ${BASE} (agent overview: ${BASE}/agent, log: ${log}). Tell the user their editor is at ${BASE}/#<board>.`);
    fail(`the server didn't come up — see ${log}`);
  },

  // Stop whatever storyboard server is listening on the port, however it was started.
  async stop() {
    if (!(await serverUp())) return console.log('✓ not running');
    const { execFileSync } = await import('node:child_process');
    let pids = [];
    try { pids = execFileSync('lsof', ['-ti', `tcp:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch {}
    if (!pids.length) fail(`something answers on port ${PORT} but lsof can't see its process`);
    for (const pid of pids) process.kill(+pid, 'SIGTERM');
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      up = undefined;
      if (!(await serverUp())) return console.log(`✓ stopped (pid ${pids.join(', ')})`);
    }
    fail('the server is still running');
  },

  // Where is the playhead in scene terms? Handy when the user says "at 12.4 s".
  at() {
    const b = store.read(resolveSlug());
    const hit = locate(b, +need(pos[0], 'seconds'));
    if (!hit) return console.log('No scenes.');
    console.log(`${hit.scene.id} “${hit.scene.title}” +${hit.local.toFixed(3)}s`);
  },
};

if (flags.help || !commands[cmd]) {
  if (!commands[cmd]) console.error(`sb: unknown command "${cmd}"\n`);
  console.log(HELP);
  process.exit(commands[cmd] ? 0 : 1);
}
if (flags.status && !STATUSES.includes(flags.status)) fail(`status must be one of ${STATUSES.join(', ')}`);
try {
  await commands[cmd]();
} catch (e) {
  fail(e.message);
}
