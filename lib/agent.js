// The agent API, under /agent. Reads return text written for an agent to read (or JSON with
// ?format=json); images return jpg (or the saved file's path with ?format=path); writes return
// JSON on one line. The manual at GET /agent documents all of it.

import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import { overview, topic, topicNames, boardRows } from './manual.js';
import { boardText, sceneText, notesText, editsText } from './text.js';
import { applyOps, createdIds, findScene, noScene, locate, defaultDuration, fitDuration, checkKeys, seconds, placement, clock, secs, plural, layout, boardGaps, editList, mergeEdits } from './ops.js';
import { ingestRender, ingestAudio, frameAt, mediaKind, probe, stamp, currentLib, libSource } from './media.js';
import { contactSheet, sheetPages, sceneStrip, timesSheet } from './sheet.js';
import { prepareOps, sourceOf, makeSketch, previewSketch } from './sketch.js';
import { exportAnimatic } from './animatic.js';
import { cutReport, cutText, exportCut } from './cut.js';
import { SKETCH_FILE } from './folder.js';

// A status line in the user's top bar, optionally about one scene (which then shows it's being worked
// on) and with progress (0–1, or a percentage).
export function makeSay(b, { text, scene, progress } = {}, author = 'claude') {
  if (!text) return null;
  if (scene != null && !findScene(b, scene)) throw Object.assign(new Error(noScene(b, scene)), { status: 404 });
  let p = progress == null || progress === '' ? null : Number(progress);
  if (p != null && !Number.isFinite(p)) throw Object.assign(new Error('progress is a number: 0–1, or a percentage'), { status: 400 });
  if (p != null) p = Math.min(1, Math.max(0, p > 1 ? p / 100 : p));
  return { text: String(text).slice(0, 200), author, at: Date.now(), scene: scene || null, progress: p };
}

// hub: { open(slug), commit(L, ops, opts), broadcast(L, msg), presence(L), send(res, status, body, type), json(req) }
export function agentApi(hub) {
  const { open, commit, broadcast, presence, send, json } = hub;
  const base = req => `http://${req.headers.host}`;
  const md = (res, text, status = 200) => send(res, status, text.endsWith('\n') ? text : text + '\n', 'text/markdown; charset=utf-8');
  const out = (res, body, status = 200) => send(res, status, JSON.stringify(body) + '\n');
  const fail = (msg, status = 400) => { throw Object.assign(new Error(msg), { status }); };
  const rows = () => boardRows(store.list(), store.read);
  const pagesOpen = L => [...L.clients].filter(c => c.role === 'ui').length;
  // Read receipts: once an agent has been given the text of notes the user sent, they show as read.
  const markRead = (L, notes, as) => {
    const ids = notes.filter(n => n.author === 'you' && n.sent && !n.read && !n.resolved).map(n => n.id);
    if (ids.length) commit(L, [{ op: 'notes.read', ids }], { author: as });
  };

  return async function agent(req, res, url, parts) {
    const q = k => url.searchParams.get(k);
    const flag = k => q(k) === '1' || q(k) === 'true';
    const accept = String(req.headers.accept || '');
    const asJson = q('format') === 'json' || (/application\/json/.test(accept) && !/text\/(markdown|plain)/.test(accept));
    const GET = req.method === 'GET' || req.method === 'HEAD';
    try {
      const docOpts = () => ({ base: base(req), boards: rows(), root: store.ROOT, home: store.HOME, read: store.read });
      if (!parts.length) return md(res, overview(docOpts()));
      if (parts[0] === 'help') {
        const text = parts[1] ? topic(parts[1], docOpts()) : null;
        if (!text) fail(`help topics: ${topicNames().join(', ')} (e.g. GET /agent/help/code)`, parts[1] ? 404 : 400);
        return md(res, text);
      }
      if (parts[0] !== 'boards') fail(`no such endpoint — the manual is at ${base(req)}/agent`, 404);
      const [, slug, sub, id, sub2] = parts;

      // ------------------------------------------------ boards
      if (!slug) {
        if (GET) {
          const all = flag('all');
          const list = rows().filter(x => all || !x.archived);
          if (asJson) return out(res, { boards: list });
          if (!list.length) return md(res, 'No boards yet. Create one with POST /agent/boards (see /agent).');
          return md(res, ['| board | title | scenes | length | open notes | rev |', '|---|---|---|---|---|---|', ...list.map(x => `| ${x.slug} | ${x.title} | ${x.scenes} | ${secs(x.duration)} | ${x.open} | ${x.rev} |`)].join('\n'));
        }
        const body = await json(req);
        checkKeys(body, ['title', 'slug', 'fps', 'aspect', 'width', 'height', 'size', 'bpm', 'beatsPerBar', 'brief', 'project'], 'POST /agent/boards');
        if (!body.title) fail('a board needs a "title"');
        const [w, h] = body.size ? String(body.size).split('x').map(Number) : [body.width, body.height];
        const slug2 = body.slug ? store.slugify(body.slug) : store.uniqueSlug(body.title);
        const { board } = store.create(slug2, { ...body, width: w, height: h });
        return out(res, { ok: true, board: slug2, rev: board.rev, api: `${base(req)}/agent/boards/${slug2}`, ui: `${base(req)}/#${slug2}` });
      }

      if (!store.exists(slug)) fail(`no board "${slug}" (boards: ${store.list().map(x => x.slug).join(', ') || 'none'})`, 404);
      const L = open(slug);
      const b = () => L.board;
      const dir = store.dir(slug);
      const ui = `${base(req)}/#${slug}`;

      // ------------------------------------------------ reads
      if (GET) {
        if (!sub) {
          if (asJson) return out(res, b());
          const pages = pagesOpen(L);
          const problems = [...(L.problems || new Map())].map(([n, p]) => `  - sketches/${n}: ${p.error}`);
          markRead(L, b().notes, q('as') || 'claude');
          if (flag('compact')) return md(res, boardText(b(), { slug, dir, compact: true }));
          return md(res, [
            boardText(b(), { slug, dir, notes: q('notes') === 'all' ? 'all' : 'open', treatment: flag('treatment') }),
            '',
            `The user's editor: ${ui} (${pages ? `open in ${plural(pages, 'page')} right now` : 'not open right now'})`,
            `Sketches folder: ${path.join(dir, 'sketches')}. Save s3.js, s3.svg, s3.png or s3.mp4 there to put a sketch on s3 (save again to update it), and _shared.js for the code shared by every code sketch.`,
            ...(problems.length ? ['Files in the sketches folder that could not be used:', ...problems] : []),
          ].join('\n'));
        }
        if (sub === 'scenes' && id && sub2 === 'strip') {
          const n = numParam(url, 'n', 6, 1, 24);
          const file = path.join(dir, 'frames', `strip-${id}-n${n}-rev${b().rev}.jpg`);
          if (!fs.existsSync(file)) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            await sceneStrip(b(), dir, id, n, file);
          }
          return image(res, file, q('format'), `${plural(n, 'frame')} across ${id}`);
        }
        if (sub === 'scenes' && id) {
          if (!findScene(b(), id)) fail(noScene(b(), id), 404);
          if (asJson) return out(res, { scene: findScene(b(), id), notes: b().notes.filter(n => n.scene === id) });
          markRead(L, b().notes.filter(n => n.scene === id), q('as') || 'claude');
          return md(res, sceneText(b(), id, { dir, slug }));
        }
        if (sub === 'scenes') return md(res, boardText(b(), { slug, dir }));
        if (sub === 'treatment') {
          if (asJson) return out(res, { treatment: b().treatment || '' });
          return md(res, b().treatment?.trim() || 'No treatment yet: board.set {"treatment":"…"}.');
        }
        if (sub === 'notes') {
          const all = flag('all');
          // drafts=1: also the notes the user hasn't sent yet (for when they ask you to look at them)
          const drafts = flag('drafts');
          markRead(L, b().notes, q('as') || 'claude');
          if (asJson) return out(res, { notes: b().notes.filter(n => (n.sent || drafts) && (all || !n.resolved)), unsent: b().notes.filter(n => !n.sent).length });
          return md(res, notesText(b(), { all, slug, dir, drafts }));
        }
        if (sub === 'log') return log(res, slug, numParam(url, 'since', 0, 0, 1e9), q('author'), asJson);
        if (sub === 'wait') return wait(req, res, L, slug, url);
        if (sub === 'at') {
          const bd = b();
          const beatLen = bd.bpm ? 60 / bd.bpm : null;
          const off = bd.beatOffset || 0;
          let t;
          if (q('beat') != null || q('bar') != null) {
            if (!beatLen) fail('this board has no tempo (bpm), so there are no beats or bars');
            t = q('beat') != null ? off + numParam(url, 'beat', 0, 0, 1e6) * beatLen : off + (numParam(url, 'bar', 1, 1, 1e6) - 1) * bd.beatsPerBar * beatLen;
          } else t = numParam(url, 't', NaN, 0, 36000);
          if (!Number.isFinite(t)) fail('pass t=<seconds>, beat=<n> (counted from 0) or bar=<n> (counted from 1)');
          const hit = locate(bd, t);
          const beat = beatLen ? (t - off) / beatLen : null;
          const music = beat != null ? { beat: +beat.toFixed(3), bar: Math.floor(beat / bd.beatsPerBar) + 1, beatInBar: +((beat % bd.beatsPerBar) + 1).toFixed(3) } : {};
          if (asJson) return out(res, { t: +t.toFixed(6), ...music, scene: hit?.scene.id ?? null, local: hit ? +hit.local.toFixed(6) : null });
          const m = beat != null ? ` = beat ${+beat.toFixed(2)} (bar ${music.bar}, beat ${music.beatInBar} of ${bd.beatsPerBar})` : '';
          return md(res, hit ? `${+t.toFixed(4)}s (${clock(t)})${m} → ${hit.scene.id} “${hit.scene.title}”, ${hit.local.toFixed(3)}s in (scene ${hit.index + 1} of ${bd.scenes.length}).` : `${+t.toFixed(4)}s${m}. The board has no scenes.`);
        }
        if (sub === 'presence') {
          const pages = pagesOpen(L);
          const p = presence(L);
          const body = { owner: L.board.owner || null, pagesOpen: pages, agentsWaiting: p.watching, unsentNotes: L.board.notes.filter(n => !n.sent).length, unsentChanges: editList(L.board).length, say: L.say ? { text: L.say.text, author: L.say.author, scene: L.say.scene, progress: L.say.progress, setAt: new Date(L.say.at).toISOString() } : null };
          if (asJson) return out(res, body);
          return md(res, [
            L.board.owner ? `Owner: ${L.board.owner}.` : 'No owner set: set board.set owner to your session name if this board is yours.',
            pages ? `The user has this board open in ${plural(pages, 'editor page')}.` : `No editor page has this board open right now (${ui}).`,
            `${plural(p.watching, 'agent is', 'agents are')} waiting for changes.`,
            L.say ? `Status line: “${L.say.text}”${L.say.scene ? ` on ${L.say.scene}` : ''}${L.say.progress != null ? ` at ${Math.round(L.say.progress * 100)}%` : ''} (set by ${L.say.author} at ${body.say.setAt.slice(11, 16)}Z; shown until replaced or cleared, hidden after 30 minutes).` : 'No status line is set.',
          ].join('\n'));
        }
        // The cut: the film at a size and quality from each scene's own render. ?plan=1: what's ready and what's
        // missing. A missing scene answers 409 with the plan; ?partial=1 lets the versions they have stand in.
        if (sub === 'cut' || sub === 'cut.mp4') {
          const size = q('size') || '1080p', quality = q('quality') || 'final', partial = q('partial') === '1' || q('partial') === 'true';
          let rep;
          try { rep = cutReport(b(), size, quality, dir); } catch (e) { return send(res, e.status || 400, { error: e.message }); }
          if (q('plan') === '1' || q('plan') === 'true') return q('format') === 'json' ? out(res, { ...rep, plan: undefined }) : md(res, cutText(rep));
          let x;
          try { x = exportCut(L, dir, { size, quality, partial }); } catch (e) {
            if (e.status === 409) return send(res, 409, cutText(e.report) + '\n(Or cut it now with what they have, for a preview: &partial=1.)\n', 'text/plain; charset=utf-8');
            throw e;
          }
          const t0 = Date.now(), r = await x.job;
          if (q('format') === 'path') return send(res, 200, r.path + '\n', 'text/plain; charset=utf-8');
          return out(res, { path: r.path, cached: !!r.cached, size, quality, width: rep.w, height: rep.h, fps: rep.fps, seconds: r.seconds ?? null, partial: rep.ready < rep.total, tookSeconds: +((Date.now() - t0) / 1000).toFixed(1) });
        }
        if (sub === 'animatic' || sub === 'animatic.mp4') {
          const scale = numParam(url, 'scale', 0.5, 0.1, 1);
          const fps = numParam(url, 'fps', b().fps, 1, 60);
          const t0 = Date.now();
          const a = await exportAnimatic(L, dir, { scale, fps });
          const f = a.path;
          if (q('format') === 'path') return send(res, 200, f + '\n', 'text/plain; charset=utf-8');
          if (q('format') === 'json') return out(res, { path: f, cached: !!a.cached, seconds: a.seconds, width: a.width, height: a.height, fps: a.fps, tookSeconds: +((Date.now() - t0) / 1000).toFixed(1) });
          const data = fs.readFileSync(f);
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': data.length, 'X-Path': f, 'Cache-Control': 'no-store' });
          return res.end(data);
        }
        if (sub === 'sheet') {
          const text = q('text') !== '0' && q('text') !== 'false';
          const bd = b();
          const { pages } = sheetPages(bd);
          const draw = async p => {
            const file = path.join(dir, 'frames', `sheet-rev${bd.rev}${text ? '' : '-notext'}${pages > 1 ? `-p${p}` : ''}.jpg`);
            if (!fs.existsSync(file)) {
              fs.mkdirSync(path.dirname(file), { recursive: true });
              await contactSheet(bd, dir, file, { slug, text, page: p });
            }
            return file;
          };
          const label = `contact sheet of ${slug} at rev ${bd.rev}`;
          // A long film's sheet comes in pages: as a path, every page's, one a line; as an image, ?page=.
          if (!url.searchParams.has('page') && pages > 1 && ['path', 'json'].includes(q('format'))) {
            const files = [];
            for (let p = 1; p <= pages; p++) files.push(await draw(p));
            if (q('format') === 'json') return out(res, { paths: files, caption: `${label}, in ${pages} pages` });
            return send(res, 200, files.join('\n') + '\n', 'text/plain; charset=utf-8');
          }
          const page = numParam(url, 'page', 1, 1, pages);
          return image(res, await draw(page), q('format'), `${label}${pages > 1 ? `, page ${page} of ${pages}` : ''}`);
        }
        // The sketches folder: what became of each file. ?wait=1 first waits (up to 90 s) until every
        // saved file has been drawn, instead of guessing with sleep.
        if (sub === 'sketches') {
          if (flag('wait')) {
            const until = Date.now() + 90_000;
            while (L.pendingSketches?.size && Date.now() < until) await new Promise(r => setTimeout(r, 250));
          }
          const folder = path.join(dir, 'sketches');
          const names = fs.existsSync(folder) ? fs.readdirSync(folder).filter(n => n === '_shared.js' || SKETCH_FILE.test(n)).sort() : [];
          const rows = names.map(name => {
            const file = path.join(folder, name);
            if (L.pendingSketches?.has(name)) return { name, state: 'drawing' };
            const problem = L.problems?.get(name);
            if (problem) return { name, state: 'error', error: problem.error };
            if (name === '_shared.js') return { name, state: b().sketchLib?.includes('/lib-folder-') ? 'in use' : 'not in use' };
            const s = b().scenes.find(x => x.renders.some(r => r.source === file));
            const r = s?.renders.find(x => x.source === file);
            return r ? { name, state: 'on the board', scene: s.id, render: r.id, active: s.activeRender === r.id } : { name, state: 'not picked up' };
          });
          if (asJson) return out(res, { folder, pending: [...(L.pendingSketches || [])], files: rows });
          return md(res, [`Sketches folder: ${folder}`, ...(rows.length ? rows.map(x => `- ${x.name}: ${x.state === 'on the board' ? `${x.scene} ${x.render}${x.active ? ' (playing)' : ''}` : x.state === 'error' ? `couldn't use it: ${x.error}` : x.state}`) : ['(empty)'])].join('\n'));
        }
        // Several moments at once: ?t=1.2,3,4.5 (seconds in the cut) → one labelled grid.
        if (sub === 'frames') {
          const ts = String(q('t') || '').split(',').map(x => x.trim()).filter(Boolean).map(Number);
          if (!ts.length || ts.length > 24 || ts.some(x => !Number.isFinite(x))) fail('send ?t=1.2,3,4.5: 1 to 24 times in the cut, in seconds');
          const skipped = [];
          const shots = (await Promise.all(ts.map(async t => {
            try { return { t, ...(await frameAt(b(), dir, { t: String(t) }, path.join(dir, 'frames', `t${t}-${stamp()}.jpg`))) }; }
            catch (e) { if (e.status === 409) { skipped.push(t); return null; } throw e; }
          }))).filter(Boolean);
          if (!shots.length) fail(`nothing to show at ${ts.join(', ')} s: the scenes there have no picture yet`, 409);
          const file = path.join(dir, 'frames', `moments-${stamp()}.jpg`);
          await timesSheet(b(), shots, file);
          return image(res, file, q('format'), `${plural(shots.length, 'moment')}${skipped.length ? ` (no picture yet at ${skipped.join(', ')} s)` : ''}`);
        }
        if (sub === 'frame') {
          const target = { note: q('note'), scene: q('scene'), at: q('at'), t: q('t') };
          const key = (target.note || target.scene ? `${target.note || target.scene}-${target.at || 0}` : `t${target.t}`).replace(/[^\w.-]/g, '_');
          const f = await frameAt(b(), dir, target, path.join(dir, 'frames', `${key}-${stamp()}.jpg`));
          return image(res, f.path, q('format'), f.label);
        }
        fail(`no such endpoint — the manual is at ${base(req)}/agent`, 404);
      }

      // ------------------------------------------------ writes
      if (req.method !== 'POST') fail('use GET or POST', 405);
      const body = await json(req);
      const as = body.as || 'claude';

      const BODY = {
        ops: ['ops', 'as', 'expectRev', 'dryRun'],
        renders: ['scene', 'path', 'caption', 'label', 'note', 'meta', 'sketch', 'paper', 'fit', 'keep', 'activate', 'new', 'split', 'scenes', 'offset', 'as', 'expectRev', 'dryRun'],
        sketches: ['scene', 'svg', 'code', 'path', 'caption', 'paper', 'activate', 'new', 'replace', 'preview', 'at', 'n', 'duration', 'as', 'expectRev', 'dryRun'],
        audio: ['path', 'clear', 'as', 'expectRev', 'dryRun'],
        say: ['text', 'scene', 'progress', 'as'],
        focus: ['scene', 'note', 't', 'as'],
      };
      if (!BODY[sub]) fail(`no such endpoint — the manual is at ${base(req)}/agent`, 404);
      checkKeys(body, BODY[sub], `POST ${sub}`);

      // expectRev: refuse (409) if the board moved on since the agent read it.
      if (body.expectRev != null && +body.expectRev !== b().rev) {
        const since = store.readLog(slug, { since: +body.expectRev });
        return out(res, {
          error: `the board is at rev ${b().rev}, not ${body.expectRev} — nothing was applied. Read it again, then retry.`,
          rev: b().rev,
          changedSince: since.map(e => ({ rev: e.rev, author: e.author, changes: e.summaries })),
        }, 409);
      }
      // Apply, or with dryRun only report what would happen.
      const apply = (ops, extra = {}) => {
        if (body.dryRun) {
          const r = applyOps(b(), ops, { author: as });
          return out(res, { ok: true, dryRun: true, wouldBeRev: r.board.rev, changes: r.summaries, created: createdIds(r.applied), ...extra });
        }
        return out(res, { ...result(commit(L, ops, { author: as }), ui, L, slug), ...extra });
      };

      if (sub === 'ops') {
        const ops = body.ops;
        if (!Array.isArray(ops) || !ops.length) fail('send {"ops": [ … ]} with at least one op — the op reference is at /agent');
        return apply(await prepareOps(ops, b(), dir, { dry: !!body.dryRun }));
      }

      const NEW_KEYS = ['title', 'after', 'before', 'index', 'duration', 'picture', 'sound', 'status', 'color', 'meta'];
      const place = n => (n.after != null ? { after: n.after } : n.before != null ? { before: n.before } : Number.isInteger(n.index) ? { index: n.index } : {});
      const addScene = (n, r, status) => ({
        op: 'scene.add',
        scene: { title: n.title || 'Idea', duration: n.duration ?? (r.kind === 'video' ? fitDuration(b(), r.duration) : r.kind === 'code' ? r.duration : defaultDuration(b())), picture: n.picture, sound: n.sound, status: n.status || status, color: n.color, meta: n.meta, renders: [r] },
        ...place(n),
      });

      // A sketch in any medium: an SVG drawing, a code sketch, or a still, clip, .svg or .js file.
      // Where a new scene would sit in the cut, placed as the request asks (for code sketches).
      const placeNew = n => {
        const probe = applyOps(b(), [{ op: 'scene.add', scene: { title: n.title || 'Idea', duration: n.duration ?? defaultDuration(b()) }, ...place(n) }], { author: as });
        return placement(probe.board, probe.applied[0].scene.id);
      };

      if (sub === 'sketches') {
        const src = sourceOf(Object.fromEntries(Object.entries({ svg: body.svg, code: body.code, path: body.path, paper: body.paper }).filter(([, v]) => v != null)), 'POST sketches');
        if (body.new) checkKeys(body.new, NEW_KEYS, 'new');
        if (body.replace && body.new) fail('"replace" swaps a version on an existing scene; it can\'t be combined with "new"');
        const s = body.scene != null ? findScene(b(), body.scene) : null;
        if (body.scene != null && !s) fail(noScene(b(), body.scene), 404);
        if (!body.preview && !body.new && !s) fail('say which scene: "scene": "s3" (or "new": {…} for a new idea scene; a preview needs neither)');
        const at = s ? placement(b(), s.id) : body.new ? placeNew(body.new) : { start: 0, duration: body.duration != null ? seconds(b(), body.duration, 'duration') : defaultDuration(b()), filmDuration: null, scene: null, index: null };
        const lib = body.preview ? currentLib(b(), dir) : libSource(b(), dir);
        if (body.preview) {
          const n = body.n == null ? 1 : Math.round(Number(body.n));
          if (!(n >= 1 && n <= 24)) fail('n must be a number of frames from 1 to 24');
          const secondsIn = body.at == null ? null : seconds(b(), body.at, 'at');
          const report = await previewSketch(src, b(), path.join(dir, 'frames', `preview-${stamp()}.jpg`), { at, lib, seconds: secondsIn, n });
          return send(res, 200, report + '\n', 'text/plain; charset=utf-8');
        }
        if (body.replace) {
          const ops = await prepareOps([{ op: 'sketch.set', scene: s.id, id: body.replace, ...src, ...(body.caption != null ? { caption: body.caption } : {}) }], b(), dir, { dry: !!body.dryRun });
          return apply(ops);
        }
        const r = await makeSketch(dir, src, b(), { base: `${s ? s.id : 'new'}-sketch-${stamp()}`, at, lib, dry: !!body.dryRun });
        Object.assign(r, { caption: body.caption ?? (body.new ? 'idea sketch' : 'sketch'), author: as });
        if (body.new) return apply([addScene({ ...body.new, duration: body.new.duration ?? at.duration }, r, 'idea')]);
        return apply([{ op: 'render.add', scene: s.id, render: r, activate: body.activate !== false }]);
      }

      if (sub === 'renders' && body.split) {
        // One whole film, cut into a clip per scene at the scenes' times in the cut, all in one rev.
        // offset: where in the cut the file starts (default 0); scenes: only these.
        const file = localFile(body.path);
        if (mediaKind(file) !== 'video') fail(`${path.basename(file)} isn't a clip`);
        const info = await probe(file);
        const offset = Number(body.offset) || 0;
        const only = body.scenes == null ? null : [].concat(body.scenes);
        if (only) for (const id of only) if (!findScene(b(), id)) fail(noScene(b(), id), 404);
        const rows = layout(b()).filter(r => !only || only.includes(r.scene.id));
        const inFile = rows.filter(r => r.start - offset < info.duration - 0.5 / b().fps && r.end - offset > 0);
        if (!inFile.length) fail(`${path.basename(file)} (${secs(info.duration)} from ${secs(offset)} in the cut) doesn't reach any of those scenes`);
        const cut = async r => {
          const start = Math.max(0, r.start - offset);
          const render = body.dryRun
            ? { kind: 'video', file: '(not prepared in a dry run)', duration: Math.min(r.scene.duration, info.duration - start) }
            : await ingestRender(dir, file, { base: `${r.scene.id}-${stamp()}`, cut: { start, duration: r.scene.duration } });
          Object.assign(render, { source: file, caption: body.caption ?? body.label ?? `from ${path.basename(file)} at ${secs(r.start)}`, author: as, ...(body.meta ? { meta: body.meta } : {}) });
          return { op: 'render.add', scene: r.scene.id, render, activate: body.activate !== false };
        };
        const ops = [];
        for (let i = 0; i < inFile.length; i += 4) ops.push(...(await Promise.all(inFile.slice(i, i + 4).map(cut))));
        const missed = rows.filter(r => !inFile.includes(r)).map(r => r.scene.id);
        return apply(ops, missed.length ? { outside: `${missed.join(', ')} fall outside the file and kept their versions` } : {});
      }

      if (sub === 'renders') {
        const file = localFile(body.path);
        const kind = mediaKind(file);
        if (!['image', 'video', 'sketch', 'code'].includes(kind)) fail(`${path.basename(file)} isn't a still, a clip, an .svg drawing or a .js code sketch`);
        const asSketch = !!body.sketch || kind === 'sketch' || kind === 'code';
        if (body.new) checkKeys(body.new, NEW_KEYS, 'new');
        const target = body.new ? null : findScene(b(), body.scene);
        if (!body.new && !target) fail(body.scene ? noScene(b(), body.scene) : 'say which scene: "scene": "s3" (or "new": {…} for a new scene)', body.scene ? 404 : 400);
        if (body.new && !body.dryRun) {
          const pos0 = body.new.after ?? body.new.before;
          if (pos0 && !findScene(b(), pos0)) fail(noScene(b(), pos0), 404);
        }
        const stem = target ? target.id : 'new';
        const at = target ? placement(b(), target.id) : placeNew({ title: path.basename(file), ...body.new });
        // A dry run checks the file (and a code sketch's code) but doesn't prepare the media.
        const r = asSketch
          ? await makeSketch(dir, { path: file, ...(body.paper ? { paper: body.paper } : {}) }, b(), { base: `${stem}-sketch-${stamp()}`, at, lib: libSource(b(), dir), dry: !!body.dryRun })
          : body.dryRun
            ? { kind, file: '(not prepared in a dry run)', duration: kind === 'video' ? (await probe(file)).duration : null }
            : await ingestRender(dir, file, { base: `${stem}-${stamp()}`, proxy: !body.keep });
        Object.assign(r, { source: file, caption: body.caption ?? body.label ?? body.note ?? '', author: as, ...(body.meta ? { meta: body.meta } : {}) });
        if (body.new) return apply([addScene({ title: path.basename(file).replace(/\.[^.]+$/, ''), ...body.new }, r, asSketch ? 'idea' : 'draft')]);
        const ops = [{ op: 'render.add', scene: target.id, render: r, activate: body.activate !== false }];
        if (body.fit && r.kind === 'video') ops.push({ op: 'scene.set', id: target.id, fields: { duration: fitDuration(b(), r.duration) } });
        return apply(ops);
      }

      if (sub === 'audio') {
        if (body.clear) return apply([{ op: 'audio.set', audio: null }]);
        const file = localFile(body.path);
        if (mediaKind(file) !== 'audio') fail(`${path.basename(file)} isn't an audio file`);
        const audio = body.dryRun ? { file: '(not prepared in a dry run)', name: path.basename(file), duration: (await probe(file)).duration } : await ingestAudio(dir, file, { base: stamp() });
        return apply([{ op: 'audio.set', audio }]);
      }

      if (sub === 'say') {
        L.say = makeSay(b(), body, as);
        L.lastAgentAt = Date.now();
        broadcast(L, presence(L));
        return out(res, { ok: true, say: L.say ? { text: L.say.text, scene: L.say.scene, progress: L.say.progress } : null });
      }

      if (sub === 'focus') {
        const msg = { type: 'focus', by: as };
        let what;
        if (body.note) {
          const n = b().notes.find(x => x.id === body.note);
          if (!n) fail(`no note ${body.note}`, 404);
          Object.assign(msg, { note: n.id, scene: n.scene });
          what = `note ${n.id}`;
        } else if (body.scene) {
          const s = findScene(b(), body.scene);
          if (!s) fail(noScene(b(), body.scene), 404);
          Object.assign(msg, { scene: s.id, t: body.t ?? null });
          what = `${s.id} “${s.title}”`;
        } else if (body.t != null) {
          msg.t = +body.t;
          what = clock(+body.t);
        } else fail('say where: {"scene":"s3"}, {"note":"n2"} or {"t":12.4}');
        const pages = pagesOpen(L);
        broadcast(L, msg);
        return out(res, { ok: true, message: pages ? `showing the user ${what} (${plural(pages, 'open page')})` : `no editor is open, so nothing moved — the user can open ${ui}` });
      }

    } catch (e) {
      console.warn(`[agent] ${req.method} ${url.pathname}${url.search} → ${e.status || 400}: ${e.message}`);
      if (!res.headersSent) out(res, { error: e.message }, e.status || 400);
      else res.end();
    }
  };

  // A numeric query parameter, checked. Missing → def.
  function numParam(url, k, def, min, max) {
    if (!url.searchParams.has(k)) return def;
    const v = Number(url.searchParams.get(k));
    if (url.searchParams.get(k) === '' || !Number.isFinite(v) || v < min || v > max) fail(`${k} must be a number from ${min} to ${max}`);
    return v;
  }

  // A write's answer (its undo is in the log: GET /log?format=json). It also says when the user has sent notes nobody has read yet, so an agent
  // that isn't listening still finds out, and what the board still lacks, so it stays current.
  function result(r, ui, L, slug) {
    const answer = { ok: true, rev: r.rev, changes: r.summaries, created: createdIds(r.ops), ui };
    const waiting = L ? L.board.notes.filter(n => n.author === 'you' && n.sent && !n.read && !n.resolved).length : 0;
    if (waiting) answer.notes = `The user has sent you ${plural(waiting, 'note')} nobody has read yet: GET /agent/boards/${slug}/notes`;
    if (r.ops?.some(o => o.op === 'render.add')) answer.next = 'Bring each scene you rendered up to date with what it shows now: picture, sound, duration and status (scene.set), and put the command that made the render in its meta (render.set) so it can be remade.';
    const gaps = L ? boardGaps(L.board) : [];
    if (gaps.length) answer.todo = `Keep the board current. Still to fill in: ${gaps.join(' · ')}`;
    return answer;
  }

  function localFile(p) {
    if (!p) fail('send "path": the absolute path of a file on this machine');
    const abs = path.resolve(String(p).replace(/^~(?=\/)/, process.env.HOME));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) fail(`no such file: ${abs}`, 404);
    return abs;
  }

  function image(res, file, format, label) {
    if (format === 'path') return send(res, 200, file + '\n', 'text/plain; charset=utf-8');
    if (format === 'json') return out(res, { path: file, caption: label });
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': data.length, 'X-Path': file, 'X-Label': encodeURIComponent(label), 'Cache-Control': 'no-store' });
    res.end(data);
  }

  function log(res, slug, since, author, asJsonOut) {
    let entries = store.readLog(slug, { since, limit: 1000 });
    if (author) entries = entries.filter(e => e.author === author);
    if (asJsonOut) return out(res, { entries: entries.map(e => ({ rev: e.rev, author: e.author, created: e.created, changes: e.summaries, inverse: e.inverse ?? null })) });
    if (!entries.length) return md(res, `No changes${author ? ` by ${author}` : ''} after rev ${since}.`);
    return md(res, entries.flatMap(e => e.summaries.map(s => `rev ${e.rev}  ${e.created.slice(0, 19).replace('T', ' ')}Z  ${e.author}: ${s}`)).join('\n'));
  }

  // Long-poll until someone other than `as` changes the board after `since`.
  function wait(req, res, L, slug, url) {
    const as = url.searchParams.get('as') || 'claude';
    const since = numParam(url, 'since', L.board.rev, 0, 1e9);
    const timeout = numParam(url, 'timeout', 600, 1, 86400) * 1000;
    const on = url.searchParams.get('on') || 'send';
    if (!['change', 'send'].includes(on)) fail('on must be "change" (any edit by someone else) or "send" (the user sends you notes)');
    const asJsonOut = url.searchParams.get('format') === 'json';
    const isSend = e => (e.ops || []).some(o => o.op === 'notes.send');
    // Your own changes and the server's redraws never count; with on=send, only the user's Send does.
    const ignore = e => e.author === as || e.author === 'storyboard' || (on === 'send' && !isSend(e));
    const got = store.readLog(slug, { since, limit: 1000 }).filter(e => !ignore(e));
    L.lastAgentAt = Date.now(); // a session that waits is alive
    let done = false, quiet, timer, deleted = false;
    let pinged = L.ping.seq > L.ping.delivered; // the user pinged while it was busy: it hears it now
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(quiet);
      clearTimeout(timer);
      L.waiters.delete(onEntry);
      if (deleted) return md(res, `The user deleted the board “${L.board.title}” (${slug}). Stop listening on it; if you need a board again, make a new one.`);
      const sends = got.flatMap(e => (e.ops || []).filter(o => o.op === 'notes.send'));
      const sentIds = [...new Set(sends.flatMap(o => o.ids || []))];
      // The user's own changes, sent with the notes: sent twice, a thing keeps its first was and its last now.
      const edits = mergeEdits(sends.map(o => o.edits || []));
      // It's on them now, until it waits again: busy, not gone. A ping alone it answers in a line and waits
      // again in moments: until then it still counts as listening (what's sent meanwhile reaches it on that
      // wait), for two minutes at most.
      if (sentIds.length || edits.length) L.handed = true;
      else if (pinged) L.answering = Date.now() + 120_000;
      if (pinged) { L.ping.delivered = L.ping.seq; L.ping.heard = Date.now(); }
      // A listener asks again straight away (sb wait does, every few minutes): tell the editor a
      // moment later, so it doesn't flicker to "not listening" in between.
      setTimeout(() => broadcast(L, presence(L)), 1500);
      markRead(L, L.board.notes.filter(n => sentIds.includes(n.id)), as);
      const rev = L.board.rev;
      const messages = got.flatMap(e => (e.ops || []).filter(o => o.op === 'notes.send' && o.message).map(o => o.message));
      const answer = `answer in this window now, in one short line, so they see which window it is: “This is the ${L.board.title} session${L.board.owner ? ` (${L.board.owner})` : ''}: <what you're doing>.”`;
      if (asJsonOut) return out(res, { changed: got.length > 0, since, rev, entries: got.map(e => ({ rev: e.rev, author: e.author, created: e.created, changes: e.summaries })), sentNotes: sentIds, sentEdits: edits, pinged });
      if (pinged && !sentIds.length && !edits.length) {
        return md(res, `The user pinged you from the editor: they're looking for the window that has “${L.board.title}”. Don't run anything for it; ${answer} Then listen again in the background: ${path.join(store.ROOT, 'sb')} -b ${slug} wait`);
      }
      if (sentIds.length || edits.length) {
        const gaps = boardGaps(L.board);
        const what = [sentIds.length && plural(sentIds.length, 'note'), edits.length && `${plural(edits.length, 'change')} they made on the board themselves`].filter(Boolean).join(' and ');
        return md(res, [
          `The user sent you ${what} on “${L.board.title}” (now rev ${rev}):`,
          ...messages.map(m => `Their message: “${m}”`),
          ...(sentIds.length ? ['', notesText(L.board, { ids: sentIds, slug, dir: store.dir(slug) })] : []),
          ...(edits.length ? ['', 'Their own changes, was → now:', editsText(L.board, edits), '',
            'A change is direction, like a note: carry it through to what it touches (the scenes around it, the treatment, sketches, the sound), and leave what they wrote as they wrote it. A change has no thread: say what you did with them in your status line (POST /say).'] : []),
          '',
          `${sentIds.length ? 'The user now sees the notes as read. ' : ''}Sending means go: start now, without asking. Render each scene you change at preview quality (the board's draft, at 720p) and put it on its scene; nothing else, and no finals, unless a note asks for it.${sentIds.length ? ` For each note: mark it working when you start it (note.set {"working":true}), look at what it points at, change the board, then reply in its thread (reply.add) and resolve it (note.set {"resolved":true}); the user sees each step.` : ''} Put any new render on its scene and keep the scenes' text and status current. Then listen again in the background: ${path.join(store.ROOT, 'sb')} -b ${slug} wait`,
          ...(L.board.notes.some(n => sentIds.includes(n.id) && n.render) ? ['', `A RENDER REQUEST asks you to render: render exactly what it says, at that size, then deliver it as GET ${base(req)}/agent/help/requests says.`] : []),
          ...(gaps.length ? ['', `The board still lacks: ${gaps.join(' · ')}. Fill that in too.`] : []),
          ...(pinged ? ['', `The user also pinged you, to find this window: ${answer}`] : []),
        ].join('\n'));
      }
      if (!got.length) return md(res, `Nobody other than ${as} changed the board after rev ${since} (waited ${timeout / 1000}s). The board is at rev ${rev}${rev > since ? `; revs ${since + 1}–${rev} were ${as}'s own changes or the server's poster redraws` : ''}. Call wait again with since=${rev} to keep waiting.`);
      md(res, [`The board changed since rev ${since} (now rev ${rev}):`, ...got.flatMap(e => e.summaries.map(s => `  rev ${e.rev}  ${e.author}: ${s}`)), '', `Read it again: GET /agent/boards/${slug} · next time wait with ?since=${rev}`].join('\n'));
    };
    const onEntry = e => {
      if (e.deleted) { deleted = true; return finish(); }
      if (e.ping) { pinged = true; return finish(); }
      if (ignore(e)) return;
      got.push(e);
      clearTimeout(quiet);
      quiet = setTimeout(finish, 2500); // let a burst of edits land together
    };
    // Asking again means whatever it was handed is done, and any ping answered; what this wait hands over
    // (finish) says what it's on next.
    L.handed = false;
    L.answering = 0;
    if (got.length || pinged) return finish();
    L.waiters.add(onEntry);
    broadcast(L, presence(L));
    timer = setTimeout(finish, timeout);
    req.on('close', () => { if (!done) { done = true; clearTimeout(quiet); clearTimeout(timer); L.waiters.delete(onEntry); setTimeout(() => broadcast(L, presence(L)), 1500); } });
  }
}
