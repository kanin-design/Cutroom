// Sketches: quick SVG drawings of a shot, so an idea can be laid out before anything is rendered.
// An agent sends just the drawing; it's placed on storyboard paper with a small style kit
// (ink lines, masses, motion and camera arrows, labels). A sketch is stored as a render of kind
// "sketch", so when the real render arrives the sketch stays as the earlier version.

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOps, checkKeys, seconds, defaultDuration, findScene, placement, sketchCanvas } from './ops.js';
import { ingestRender, mediaKind, probe, framesSheet, libSource, saveAttachment } from './media.js';
export { libSource };
import { checkSyntax, capture } from './codesketch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools/.bin/sheet');

// The drawing canvas: 1600 wide, the board's aspect.
export const canvas = sketchCanvas;

export const STYLE_KIT = {
  paper: '#f1ece4',
  classes: {
    '(default)': 'ink line: #1d1d1f, 5 px, round ends, no fill',
    thin: 'a 2.5 px line, for detail and background',
    mass: 'a flat grey-beige fill with no line, for ground, shadows and big volumes',
    dark: 'a near-black fill, for silhouettes and dark shapes',
    light: 'a soft warm-yellow fill, for light sources and glows',
    move: 'a red dashed line for motion. Add marker-end="url(#arrow)" for an arrowhead',
    cam: 'a blue line for camera moves. Add marker-end="url(#arrow-cam)" for an arrowhead',
    title: 'large bold ink text',
    label: 'small grey caps, for naming things in the frame',
    note: 'blue italic text, for direction ("slow push in", "hits on b8")',
  },
};

// Light paper by default; "dark" paper (for films that are light on black) swaps the colours, so
// the same classes work on both.
const STYLE = `
  svg { --paper: #f1ece4; --ink: #1d1d1f; --mass: #d6cdbd; --solid: #1d1d1f; --tag: #a39a8a; --label: #6f685d; --cam: #3b6fd8; }
  svg.dark-paper { --paper: #121215; --ink: #ecebe8; --mass: #34343c; --solid: #ecebe8; --tag: #5c5b63; --label: #a3a2aa; --cam: #7fa6ff; }
  .paper { fill: var(--paper); }
  .tag { fill: var(--tag); font: 600 26px -apple-system, "Helvetica Neue", Helvetica, sans-serif; letter-spacing: 3px; }
  .ink { fill: none; stroke: var(--ink); stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; }
  .ink .thin { stroke-width: 2.5; }
  .ink .mass { fill: var(--mass); stroke: none; }
  .ink .dark { fill: var(--solid); stroke: none; }
  .ink .light { fill: #f6d67a; stroke: none; opacity: 0.85; }
  .ink .move { stroke: #e0452b; stroke-width: 6; stroke-dasharray: 18 12; fill: none; }
  .ink .cam { stroke: var(--cam); stroke-width: 6; fill: none; }
  .ink text { fill: var(--ink); stroke: none; font-family: -apple-system, "Helvetica Neue", Helvetica, sans-serif; font-size: 44px; }
  .ink text.title { font-size: 64px; font-weight: 700; }
  .ink text.label { fill: var(--label); font-size: 28px; font-weight: 600; letter-spacing: 2px; }
  .ink text.note { fill: var(--cam); font-size: 36px; font-style: italic; }
  .arrow-cam { fill: var(--cam); }
  .arrow-ink { fill: var(--ink); }
`;

const DEFS = `
  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#e0452b"/></marker>
  <marker id="arrow-cam" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path class="arrow-cam" d="M0 0 L10 5 L0 10 z"/></marker>
  <marker id="arrow-ink" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path class="arrow-ink" d="M0 0 L10 5 L0 10 z"/></marker>`;

const isFullSvg = s => /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(s);

// Put a drawing on the paper, unless it is already a complete <svg>.
export function wrap(drawing, b, { paper = 'light' } = {}) {
  if (!['light', 'dark'].includes(paper)) throw new Error('paper must be "light" or "dark"');
  const s = String(drawing ?? '').trim();
  if (!s) throw new Error('the sketch is empty — send SVG elements (see the sketch section of the manual)');
  if (isFullSvg(s)) return s.includes('xmlns=') ? s : s.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  const { w, h } = canvas(b);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"${paper === 'dark' ? ' class="dark-paper"' : ''}>
<defs>${DEFS}
</defs>
<style>${STYLE}</style>
<rect class="paper" width="${w}" height="${h}"/>
<text class="tag" x="${w - 36}" y="54" text-anchor="end">SKETCH</text>
<g class="ink">
${s}
</g>
</svg>
`;
}

// No scripts, event handlers, embedded HTML or outside resources: a sketch is only a drawing.
export function sanitize(svg) {
  return svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script[^>]*\/>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:xlink:)?href\s*=\s*("|')\s*(?!#|data:image\/)[^"']*\1/gi, '');
}

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => resolve({ code, out, err }));
    p.stdin.end(input ?? '');
  });
}

async function tool() {
  const src = path.join(ROOT, 'tools/sheet.swift');
  if (!fs.existsSync(TOOL) || fs.statSync(TOOL).mtimeMs < fs.statSync(src).mtimeMs) {
    fs.mkdirSync(path.dirname(TOOL), { recursive: true });
    const r = await run('swiftc', ['-O', src, '-o', TOOL]);
    if (r.code) throw new Error(`couldn't build the sheet tool: ${r.err.trim()}`);
  }
  return TOOL;
}

// Well-formed XML, or an error that quotes the broken spot. A bare drawing is checked on its own
// first, so line and column point into what the agent sent, not into the paper around it.
export async function check(drawing) {
  const s = String(drawing ?? '').trim();
  const full = isFullSvg(s);
  const doc = full ? s : `<svg xmlns="http://www.w3.org/2000/svg">\n${s}\n</svg>`;
  const r = await run(await tool(), ['--check-xml'], doc);
  if (!r.code) return;
  let [line, col] = r.err.trim().split(':').map(Number);
  const lines = s.split('\n');
  const atEnd = !full && line - 1 > lines.length; // reported at our closing </svg>: something never closed
  if (!full) line = Math.min(Math.max(1, line - 1), lines.length);
  const text = lines[line - 1] || '';
  const from = Math.max(0, col - 50);
  throw new Error(
    `the sketch isn't valid SVG (XML) at line ${line}, column ${col} of what you sent${atEnd ? ' (the end: something opened earlier was never closed)' : ''}: …${text.slice(from, col + 20).trim()}… ` +
    `Usual causes: an element that isn't closed (<rect …/> needs the slash), a closing tag that doesn't match, a bare & (write &amp;) or a < in text (write &lt;).`,
  );
}

// SVG sketch → media/renders/<base>.svg plus a jpg poster drawn by WebKit (Quick Look), which
// renders SVG the way the user's browser does.
export async function ingestSvg(boardDir, drawing, b, { base, paper }) {
  await check(drawing);
  const svg = sanitize(wrap(drawing, b, { paper }));
  const dir = path.join(boardDir, 'media/renders');
  fs.mkdirSync(dir, { recursive: true });
  const file = `media/renders/${base}.svg`, poster = `media/renders/${base}.poster.jpg`;
  fs.writeFileSync(path.join(boardDir, file), svg);
  const { w, h } = canvas(b);
  await rasterize(svg, path.join(boardDir, poster), w, h);
  return { kind: 'image', sketch: true, file, poster, width: w, height: h, duration: null };
}

async function rasterize(svg, out, w, h) {
  // Quick Look makes square thumbnails, so centre the frame in a square and crop it back out.
  const S = Math.max(w, h);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sketch-'));
  try {
    const b64 = Buffer.from(svg).toString('base64');
    const sq = path.join(tmp, 'sq.svg');
    fs.writeFileSync(sq, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><image x="${(S - w) / 2}" y="${(S - h) / 2}" width="${w}" height="${h}" href="data:image/svg+xml;base64,${b64}" xlink:href="data:image/svg+xml;base64,${b64}"/></svg>`);
    await new Promise((res, rej) => execFile('qlmanage', ['-t', '-s', String(S), '-o', tmp, sq], err => (err ? rej(new Error(`Quick Look couldn't draw the sketch: ${err.message}`)) : res())));
    const png = path.join(tmp, 'sq.svg.png');
    if (!fs.existsSync(png)) throw new Error("Quick Look couldn't draw the sketch");
    await new Promise((res, rej) => execFile('ffmpeg', ['-y', '-v', 'error', '-i', png, '-vf', `crop=${w}:${h}:${(S - w) / 2}:${(S - h) / 2},scale='min(1280,iw)':-2`, out], err => (err ? rej(err) : res())));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- any sketch

// A sketch comes from one of: {"svg": drawing}, {"code": js} or {"path": a still, clip, .svg or .js}.
// A bare string is an SVG drawing. "caption" and "paper" (svg only) may ride along.
export function sourceOf(x, where = 'sketch') {
  if (typeof x === 'string') return { svg: x };
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error(`${where}: a sketch is {"svg": …}, {"code": …} or {"path": …}`);
  checkKeys(x, ['svg', 'code', 'path', 'caption', 'paper'], where);
  const given = ['svg', 'code', 'path'].filter(k => x[k] != null);
  if (given.length !== 1) throw new Error(`${where}: give exactly one of "svg", "code" or "path"`);
  return x;
}


// Prepare a sketch as a render object (or, with dry, only check it). `at` is where the scene sits
// in the cut (see placement()), which code sketches are drawn with; `lib` is the shared library.
export async function makeSketch(boardDir, src, b, { base, at, lib = null, dry = false }) {
  if (src.svg != null) {
    if (!dry) return ingestSvg(boardDir, src.svg, b, { base, paper: src.paper });
    await check(src.svg);
    wrap(src.svg, b, { paper: src.paper });
    return { kind: 'image', sketch: true, file: '(not prepared in a dry run)', ...canvasWH(b), duration: null };
  }
  if (src.code != null) return codeSketch(boardDir, src.code, b, { base, at, lib, dry });
  const file = path.resolve(String(src.path).replace(/^~(?=\/)/, os.homedir()));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw Object.assign(new Error(`no such file: ${file}`), { status: 404 });
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === 'svg') return { ...(await makeSketch(boardDir, { svg: fs.readFileSync(file, 'utf8'), paper: src.paper }, b, { base, dry })), source: file };
  if (ext === 'js') return { ...(await makeSketch(boardDir, { code: fs.readFileSync(file, 'utf8') }, b, { base, at, lib, dry })), source: file };
  const kind = mediaKind(file);
  if (kind !== 'image' && kind !== 'video') throw new Error(`${path.basename(file)} can't be a sketch (stills, clips, .svg drawings or .js code sketches)`);
  if (dry) return { kind, sketch: true, file: '(not prepared in a dry run)', duration: kind === 'video' ? (await probe(file)).duration : null };
  return { ...(await ingestRender(boardDir, file, { base })), sketch: true, source: file };
}

const canvasWH = b => { const { w, h } = canvas(b); return { width: w, height: h }; };
const place0 = b => ({ start: 0, duration: defaultDuration(b), filmDuration: null, scene: null, index: null });

// A code sketch: check it parses, draw a poster and a filmstrip in one headless Chrome launch,
// and refuse it if draw() throws. `drawn` records the timing and library it was drawn with, so the
// server can redraw the poster when the scene moves or the library changes.
async function codeSketch(boardDir, code, b, { base, at, lib, dry }) {
  checkSyntax(code);
  const p = at || place0(b);
  const d = p.duration > 0 ? p.duration : defaultDuration(b);
  const N = 10;
  const times = dry ? [0, d / 2, Math.max(0, d - 1 / b.fps)] : Array.from({ length: N }, (_, i) => ((i + 0.5) * d) / N);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-codesk-'));
  try {
    const cap = await capture(code, b, { duration: d, posterAt: dry ? null : d * 0.4, times, tileWidth: dry ? 160 : Math.round((120 * b.width) / b.height), dir: tmp, at: p, lib });
    if (cap.errors.length) throw new Error(`the code sketch threw an error: ${cap.errors.slice(0, 3).join('; ')}`);
    if (dry) return { kind: 'code', sketch: true, file: '(not prepared in a dry run)', ...canvasWH(b), duration: d };
    const rel = `media/renders/${base}`;
    fs.mkdirSync(path.join(boardDir, 'media/renders'), { recursive: true });
    fs.writeFileSync(path.join(boardDir, `${rel}.js`), code);
    const art = await saveArt(boardDir, rel, cap, N);
    return { kind: 'code', sketch: true, file: `${rel}.js`, ...art, ...canvasWH(b), duration: d, drawn: { start: p.start, duration: d, lib: b.sketchLib || null } };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Poster and filmstrip files from a capture, under fresh names (media files are cached forever).
async function saveArt(boardDir, rel, cap, N) {
  const stem = `${rel}-${stampNow()}`;
  fs.copyFileSync(cap.poster, path.join(boardDir, `${stem}.poster.jpg`));
  const pattern = cap.frames[0].replace(/-0\.jpg$/, '-%d.jpg');
  await new Promise((res, rej) => execFile('ffmpeg', ['-y', '-v', 'error', '-start_number', '0', '-i', pattern, '-vf', `tile=${N}x1`, '-frames:v', '1', path.join(boardDir, `${stem}.strip.jpg`)], err => (err ? rej(err) : res())));
  return { poster: `${stem}.poster.jpg`, strip: `${stem}.strip.jpg`, stripFrames: N };
}
const stampNow = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

// Redraw a code sketch's poster and filmstrip for where its scene now sits (after a retime, a
// reorder or a new shared library). Returns render.set fields.
export async function redrawCode(boardDir, r, b, at) {
  const code = fs.readFileSync(path.join(boardDir, r.file), 'utf8');
  const d = at.duration;
  const N = 10;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-redraw-'));
  try {
    const cap = await capture(code, b, { duration: d, posterAt: d * 0.4, times: Array.from({ length: N }, (_, i) => ((i + 0.5) * d) / N), tileWidth: Math.round((120 * b.width) / b.height), dir: tmp, at, lib: libSource(b, boardDir) });
    if (cap.errors.length) throw new Error(cap.errors[0]);
    const art = await saveArt(boardDir, r.file.replace(/\.js$/, ''), cap, N);
    return { ...art, duration: d, drawn: { start: at.start, duration: d, lib: b.sketchLib || null } };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Does this code sketch's poster still match where its scene sits and the current library?
// (Sketches drawn before this was tracked have no `drawn`, and are left alone.)
export const drawnStale = (r, at, b) =>
  !!r && r.kind === 'code' && !!at && !!r.drawn && ( Math.abs(r.drawn.start - at.start) > 1e-6 || Math.abs(r.drawn.duration - at.duration) > 1e-6 || (r.drawn.lib || null) !== (b.sketchLib || null));

// Draw a sketch to a jpg without adding it to the board, to look at it first (svg or code). For
// code: `seconds` is the moment to draw (default 40% in); `n` > 1 draws a filmstrip of n frames.
export async function previewSketch(src, b, out, { at, lib, seconds, n = 1 } = {}) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (src.svg != null) {
    await check(src.svg);
    const { w, h } = canvas(b);
    await rasterize(sanitize(wrap(src.svg, b, { paper: src.paper })), out, w, h);
    return out;
  }
  if (src.code != null) {
    checkSyntax(src.code);
    const p = at || place0(b);
    const d = p.duration > 0 ? p.duration : defaultDuration(b);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-codeprev-'));
    try {
      if (n > 1) {
        const times = Array.from({ length: n }, (_, i) => (i * Math.max(0, d - 1 / b.fps)) / (n - 1));
        const cap = await capture(src.code, b, { duration: d, times, tileWidth: 560, dir: tmp, at: p, lib });
        if (cap.errors.length) throw new Error(`the code sketch threw an error: ${cap.errors.slice(0, 3).join('; ')}`);
        return await framesSheet(b, cap.frames, times, out, { title: `Preview · ${n} frames across ${+d.toFixed(3)}s`, start: p.start });
      }
      const t = seconds != null ? Math.min(Math.max(0, +seconds), d) : d * 0.4;
      const cap = await capture(src.code, b, { duration: d, posterAt: t, dir: tmp, at: p, lib });
      if (cap.errors.length) throw new Error(`the code sketch threw an error: ${cap.errors.slice(0, 3).join('; ')}`);
      fs.copyFileSync(cap.poster, out);
      return out;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  throw new Error('preview works for "svg" and "code" sketches (a file on disk is already an image you can open)');
}

// Turn sketch conveniences in a batch into plain ops, preparing each sketch on the way. The batch is
// followed op by op on a working copy of the board, so a sketch on a new scene is drawn at the
// place in the cut where that scene will be.
//   {"op":"scene.add","scene":{…,"sketch": "<svg…>" | {"svg"|"code"|"path": …}}} → the scene's first version
//   {"op":"sketch.add","scene":"s3","svg"|"code"|"path": …,"caption":"…"}      → render.add
//   {"op":"sketch.set","scene":"s3","id":"r15","svg"|"code"|"path": …}         → render.set (same version)
//   {"op":"sketchLib.set","code":"…" | null}                                   → board.set sketchLib
export async function prepareOps(ops, b, boardDir, { dry = false, stamp }) {
  if (!Array.isArray(ops)) return ops;
  let work = b;
  let libCode = libSource(b, boardDir);
  const fail = (e, where) => { throw Object.assign(new Error(`${where}: ${e.message}`), { status: e.status || 400 }); };
  const make = async (src, where, stem, at) => {
    try {
      return await makeSketch(boardDir, src, work, { base: `${stem}-sketch-${stamp()}`, at, lib: libCode, dry });
    } catch (e) { fail(e, where); }
  };
  const out = [];
  const push = op => {
    try { work = applyOps(work, [op], { author: 'prepare' }).board; } catch (e) { fail(e, `ops[${out.length}]`); }
    out.push(op);
  };
  // Files an agent attaches by path ({"path": "/abs/file.png"}) are copied into media/refs first.
  const attach = async (files, where) => {
    if (!Array.isArray(files)) return files;
    const outFiles = [];
    for (const [k, f] of files.entries()) {
      if (f?.path == null) { outFiles.push(f); continue; }
      try { outFiles.push(await saveAttachment(boardDir, path.resolve(String(f.path)), f.name || path.basename(String(f.path)), { dry })); } catch (e) { fail(e, `${where}.files[${k}]`); }
    }
    return outFiles;
  };
  for (const [i, op0] of ops.entries()) {
    let op = op0;
    // {"op":"scene.add","scene":{…},"sketch":{…}}: the sketch meant for the new scene
    if (op?.op === 'scene.add' && op.scene && op.sketch != null && op.scene.sketch == null) { const { sketch, ...rest } = op; op = { ...rest, scene: { ...op.scene, sketch } }; }
    if (op?.op === 'note.add' && op.note?.files) op = { ...op, note: { ...op.note, files: await attach(op.note.files, `ops[${i}].note`) } };
    if (op?.op === 'reply.add' && op.reply?.files) op = { ...op, reply: { ...op.reply, files: await attach(op.reply.files, `ops[${i}].reply`) } };
    if (op?.op === 'scene.add' && op.scene && op.scene.sketch != null) {
      const { sketch, sketchCaption, sketchPaper, ...scene } = op.scene;
      const where = `ops[${i}] (scene “${scene.title ?? ''}”)`;
      const src = sourceOf(sketch, where);
      if (sketchPaper && src.paper == null) src.paper = sketchPaper;
      // Place the scene first (without its sketch) to learn where it will sit in the cut.
      let at;
      try {
        const probe = applyOps(work, [{ ...op, scene }], { author: 'prepare' });
        at = placement(probe.board, probe.applied[0].scene.id);
      } catch (e) { fail(e, where); }
      const r = await make(src, where, 'new', at);
      r.caption = src.caption ?? sketchCaption ?? 'idea sketch';
      push({ ...op, scene: { ...scene, renders: [...(scene.renders || []), r] } });
    } else if (op?.op === 'sketch.add' || op?.op === 'sketch.set') {
      const { op: name, scene, id, caption, activate, ...src } = op;
      const where = `ops[${i}] (${name} on ${scene})`;
      if (!scene) fail(new Error(`${name} needs "scene"`), where);
      const target = findScene(work, scene);
      if (!target) fail(Object.assign(new Error(`no scene ${scene} (scenes: ${work.scenes.map(x => x.id).join(', ') || 'none'})`), { status: 404 }), where);
      if (name === 'sketch.set' && !target.renders.some(r => r.id === id)) fail(Object.assign(new Error(`${scene} has no version ${id} (versions: ${target.renders.map(r => r.id).join(', ') || 'none'})`), { status: 404 }), where);
      if (name === 'sketch.add' && id != null) fail(new Error('sketch.add makes a new version; use sketch.set with "id" to replace one'), where);
      const r = await make(sourceOf(src, name), where, String(scene).replace(/[^\w-]/g, ''), placement(work, scene));
      if (name === 'sketch.add') {
        r.caption = caption ?? src.caption ?? 'sketch';
        push({ op: 'render.add', scene, render: r, ...(activate != null ? { activate } : {}) });
      } else {
        const fields = { kind: r.kind, file: r.file, poster: r.poster ?? null, strip: r.strip ?? null, stripFrames: r.stripFrames ?? 0, duration: r.duration ?? null, width: r.width ?? null, height: r.height ?? null, drawn: r.drawn ?? null, source: r.source ?? null, updated: new Date().toISOString() };
        if (caption ?? src.caption) fields.caption = caption ?? src.caption;
        push({ op: 'render.set', scene, id, fields });
      }
    } else if (op?.op === 'sketchLib.set') {
      const { op: _, code, ...rest } = op;
      if (Object.keys(rest).length) fail(new Error(`unknown field "${Object.keys(rest)[0]}"; allowed: op, code`), `ops[${i}] (sketchLib.set)`);
      let file = null;
      if (code != null) {
        try { checkSyntax(code, { lib: true }); } catch (e) { fail(e, `ops[${i}] (sketchLib.set)`); }
        file = dry ? '(not prepared in a dry run)' : `media/shared/lib-${stamp()}.js`;
        if (!dry) {
          fs.mkdirSync(path.join(boardDir, 'media/shared'), { recursive: true });
          fs.writeFileSync(path.join(boardDir, file), code);
        }
      }
      libCode = code ?? null;
      push({ op: 'board.set', fields: { sketchLib: file } });
    } else push(op);
  }
  return out;
}
