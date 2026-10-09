// The cut: the film at a size and quality, made of its scenes' own renders. Every scene is its own little
// movie, made its own way (ray traced, raster, an edit of 4K footage, a screen capture) at its own frame rate;
// the cut fits each into the film's frame, conforms it to the film's frame rate, trims it to its scene (or
// holds its last frame), and joins them in one encode with the soundtrack. A scene with no render at that size
// and quality is missing: it has to be rendered first, its own way (or, for a preview, a partial cut lets the
// version it has stand in).

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { cutPlan, renderSize, RENDER_SIZES, RENDER_QUALITIES, versionWords, sceneRenderName, layout } from './ops.js';
import { assemble } from './animatic.js';

// The file a version is cut from: the render itself (its `source`), not the board's copy, which for a clip
// is a scrub-friendly proxy at most 1920 wide. A source changed since the version came (a project that
// renders to the same path each time) isn't that version any more: then the board's copy, if it's big enough.
const PROXY_W = 1920;
function inputFor(r, boardDir, w, h) {
  if (r.source && path.isAbsolute(r.source)) {
    try { const st = fs.statSync(r.source); if (st.isFile() && st.mtimeMs <= Date.parse(r.created) + 120_000) return { path: r.source }; } catch {}
  }
  const proxied = r.kind === 'video' && (r.width || 0) > PROXY_W;
  const pw = proxied ? PROXY_W : r.width || 0, ph = proxied ? Math.round(((r.height || 0) * PROXY_W) / r.width) : r.height || 0;
  if (pw >= w * 0.98 - 1 && ph >= h * 0.98 - 1) return { path: path.resolve(boardDir, r.file) };
  return { path: null, why: `its render (${r.source || r.file}) is gone or was rendered over, and the board keeps only a ${pw}×${ph} copy` };
}

// Where the film stands for a cut at this size and quality: each scene ready (and the version that goes in) or
// missing (and how it is made, what final means for it, what it has now).
export function cutReport(b, size = '1080p', quality = 'final', boardDir = null) {
  if (!RENDER_SIZES[size]) throw Object.assign(new Error(`size: one of ${Object.keys(RENDER_SIZES).join(', ')}`), { status: 400 });
  if (!RENDER_QUALITIES.includes(quality)) throw Object.assign(new Error(`quality: one of ${RENDER_QUALITIES.join(', ')}`), { status: 400 });
  const { w, h } = renderSize(b, size);
  const plan = cutPlan(b, size, quality).map(p => {
    if (!p.render || !boardDir) return p;
    const input = inputFor(p.render, boardDir, w, h);
    return input.path ? { ...p, input: input.path } : { ...p, render: null, why: input.why };
  });
  const scene = p => ({
    id: p.scene.id, n: p.index + 1, title: p.scene.title,
    how: p.how ? { type: p.how.type, name: sceneRenderName(p.how), [quality]: p.how[quality] ?? null, cmd: p.how.cmd ?? null, fps: p.how.fps ?? null, source: p.how.source ?? null, own: p.how.own } : null,
    render: p.render ? { id: p.render.id, file: p.render.file, words: versionWords(p.render) } : null,
    has: versionWords(p.active),
    ...(p.why ? { why: p.why } : {}),
    short: p.short || false,
  });
  return { size, quality, w, h, fps: b.fps, ready: plan.filter(p => p.render).length, total: plan.length, scenes: plan.map(scene), plan };
}

// The report in words, for an agent: what goes in, and what has to be rendered first.
export function cutText(rep) {
  const missing = rep.scenes.filter(s => !s.render);
  const label = `${RENDER_SIZES[rep.size].label} ${rep.quality}`;
  const out = [`The cut at ${label}: ${rep.w}×${rep.h} at ${rep.fps} fps. ${rep.ready} of ${rep.total} scenes have a render that fits.`];
  for (const s of rep.scenes) {
    const head = `${String(s.n).padStart(2, '0')} ${s.title} (${s.id})`;
    const how = s.how ? `${s.how.name}${s.how[rep.quality] ? `, ${rep.quality}: ${s.how[rep.quality]}` : ''}${s.how.fps ? `, ${s.how.fps} fps (conformed to ${rep.fps})` : ''}` : 'how it is made: not set';
    if (s.render) out.push(`- ${head}: ${s.render.words} ${s.render.id}${s.short ? ' (shorter than the scene: its last frame holds)' : ''}`);
    else {
      const make = !s.how ? `Say how it is made first (its render: sb set ${s.id} render.type=…), then render it at ${rep.w}×${rep.h}`
        : s.how.type === 'edit' ? `Cut it from its footage at ${rep.w}×${rep.h}${s.how.source ? ` (${s.how.source})` : ''}` : s.how.type === 'capture' ? `Capture it at ${rep.w}×${rep.h}` : `Render it ${how}`;
      out.push(`- ${head}: MISSING (has ${s.has}${s.why ? `; ${s.why}` : ''}). ${make}${s.how?.cmd ? `; made with: ${s.how.cmd}` : ''}${s.how?.source && s.how.type !== 'edit' ? `; footage: ${s.how.source}` : ''}`);
    }
  }
  if (missing.length) out.push('', `Render each missing scene its own way at ${rep.w}×${rep.h}, ${rep.quality} quality, and put it on its scene (sb render <sX> <file> --quality ${rep.quality}); then cut again.`);
  return out.join('\n');
}

// What a cut's pictures and sound are made of: the frame, each scene's length and the file that goes in (or, for
// a scene cut from its card, what the card shows), and the soundtrack. A note, a reply or a status change leaves it
// as it is, so the cut made before is still the cut (it used to be made again at every board revision). Code
// sketches draw with the board's shared sketch library, so it counts too.
function cutKey(b, boardDir, rep, pick, enc) {
  const stat = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  const rows = layout(b).map(({ scene: s }, i) => {
    const r = pick.get(s.id);
    return r ? [s.id, s.duration, r.id, r.file, stat(r.file)] : [s.id, s.duration, i, s.title, s.picture || '', s.sound || '', s.status, s.color || ''];
  });
  const lib = b.sketchLib && !b.sketchLib.startsWith('(') ? [b.sketchLib, stat(path.join(boardDir, b.sketchLib))] : null;
  const key = JSON.stringify([rep.w, rep.h, b.fps, enc, b.audio ? [b.audio.file, b.audio.duration] : null, lib, rows]);
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
}

// Earlier cuts of the same kind (the same size, quality and partial) once a new one is made: they are only caches.
function pruneCuts(dir, prefix, keep) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (n !== keep && n.startsWith(prefix) && /^(rev\d+|[0-9a-f]{10})\.mp4$/.test(n.slice(prefix.length))) fs.rmSync(path.join(dir, n), { force: true });
  }
}

// The cut as a file in the board's exports, made once for what goes into it (cutKey), at a size, quality and
// partial; one at a time per file. L.cuts keeps the jobs running and how far along they are.
export function exportCut(L, boardDir, { size = '1080p', quality = 'final', partial = false } = {}) {
  const b = L.board;
  const rep = cutReport(b, size, quality, boardDir);
  const missing = rep.scenes.filter(s => !s.render);
  if (missing.length && !partial) {
    const e = new Error(`${missing.length} of ${rep.total} scenes have no render at ${RENDER_SIZES[size].label} ${quality}: ${missing.map(s => s.id).join(', ')}`);
    throw Object.assign(e, { status: 409, report: rep });
  }
  const pick = new Map(rep.plan.map(p => [p.scene.id, p.render ? { ...p.render, file: p.input } : p.active && { ...p.active, file: path.resolve(boardDir, p.active.file) }]));
  const enc = quality === 'draft' ? 'draft' : size === '4k' ? 'master' : 'final';
  const prefix = `cut-${size}-${quality}${partial && missing.length ? '-partial' : ''}-`;
  const out = path.join(boardDir, 'exports', `${prefix}${cutKey(b, boardDir, rep, pick, enc)}.mp4`);
  L.cuts ??= new Map();
  if (fs.existsSync(out) && !L.cuts.has(out)) return { out, job: Promise.resolve({ path: out, cached: true }), report: rep };
  if (!L.cuts.has(out)) {
    const job = { progress: 0, started: Date.now() };
    const tmp = out + '.part.mp4';
    job.promise = assemble(b, boardDir, tmp, { W: rep.w, H: rep.h, F: b.fps, pick: s => pick.get(s.id) ?? null, enc, progress: f => { job.progress = f; } })
      .then(r => { fs.renameSync(tmp, out); pruneCuts(path.dirname(out), prefix, path.basename(out)); return { ...r, path: out }; })
      .catch(e => { fs.rmSync(tmp, { force: true }); job.error = e.message; throw e; })
      .finally(() => setTimeout(() => L.cuts.delete(out), 60_000).unref?.());
    job.promise.catch(() => {});
    L.cuts.set(out, job);
  }
  const job = L.cuts.get(out);
  return { out, job: job.promise, state: job, report: rep };
}

// Where a cut stands, for the editor, which asks again until it's done: missing (and which scenes), running
// (and how far), done (and where), or failed. Asking starts it.
export function cutStatus(L, boardDir, opts) {
  let x;
  try { x = exportCut(L, boardDir, opts); } catch (e) {
    if (e.status === 409) return { state: 'missing', ...summary(e.report) };
    throw e;
  }
  const j = L.cuts?.get(x.out);
  if (j?.error) return { state: 'failed', error: j.error, ...summary(x.report) };
  if (j && fs.existsSync(x.out)) return { state: 'done', file: path.basename(x.out), ...summary(x.report) };
  if (j) return { state: 'running', progress: +j.progress.toFixed(3), seconds: Math.round((Date.now() - j.started) / 1000), ...summary(x.report) };
  return { state: 'done', file: path.basename(x.out), ...summary(x.report) };
}
const summary = rep => ({ size: rep.size, quality: rep.quality, w: rep.w, h: rep.h, fps: rep.fps, ready: rep.ready, total: rep.total, scenes: rep.scenes });

