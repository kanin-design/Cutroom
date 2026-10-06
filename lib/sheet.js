// Contact sheets: labelled grids of frames for agents to look at, drawn natively by
// tools/sheet.swift (CoreGraphics and CoreText), which is compiled on first use. The same tool checks
// that a sketch's SVG is well-formed XML.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layout, activeRender, findScene, noScene, musical, kindName, clock, secs, plural, sceneColors } from './ops.js';
import { grabFrame, captureScene, frameSource, POSTER_AT } from './media.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'tools/sheet.swift');
const BIN = path.join(ROOT, 'tools/.bin/sheet');

// The tool, built from its source when that is newer than the last build.
async function sheetTool() {
  if (fs.existsSync(BIN) && fs.statSync(BIN).mtimeMs >= fs.statSync(SRC).mtimeMs) return BIN;
  fs.mkdirSync(path.dirname(BIN), { recursive: true });
  await new Promise((resolve, reject) => execFile('swiftc', ['-O', SRC, '-o', BIN], (err, _out, stderr) => (err ? reject(new Error(`couldn't build the sheet tool: ${String(stderr || err.message).trim()}`)) : resolve())));
  return BIN;
}

// Run the tool with `input` on stdin: its exit code, and what it said on stderr.
async function runTool(args, input) {
  const bin = await sheetTool();
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => resolve({ code, err: err.trim() }));
    p.stdin.end(input);
  });
}

async function drawSheet(spec) {
  const r = await runTool([], JSON.stringify(spec));
  if (r.code) throw new Error(`sheet failed: ${r.err}`);
  return spec.out;
}

// Where an XML document stops being well-formed, as "line:column", or null if it's fine.
export async function xmlError(doc) {
  const r = await runTool(['--check-xml'], doc);
  return r.code ? r.err : null;
}

const two = n => String(n).padStart(2, '0');
const tileWidth = b => (b.width >= b.height ? 480 : 300);
const sheetCols = b => (b.width >= b.height ? 4 : 6);
// A model sees an image at most 1568 px on its long side, so one tall sheet of a long film shrinks
// until no tile can be read. The sheet comes in pages of at most four rows (three of tall tiles),
// split evenly: each page shrinks little.
export function sheetPages(b) {
  const cols = sheetCols(b), n = Math.max(1, b.scenes.length);
  const pages = Math.ceil(n / (cols * (b.width >= b.height ? 4 : 3)));
  return { pages, size: Math.ceil(n / pages / cols) * cols };
}
// The grid for n frames of a board: one row of up to four, else three or four across.
const frameGrid = (b, n) => ({ cols: n <= 4 ? n : n <= 9 ? 3 : 4, tileWidth: b.width >= b.height ? 560 : 320, aspect: b.width / b.height });

// Every scene in order: its active render's poster, or a card drawn from its text.
// With `text`, each tile is captioned with the scene's picture and sound text, which is what makes an
// idea board read as a storyboard. (Tiles without a picture already show their text as a card.)
export async function contactSheet(b, boardDir, out, { slug, text = true, page = 1 } = {}) {
  const all = layout(b);
  if (!all.length) throw new Error('the board has no scenes yet');
  const { pages, size } = sheetPages(b);
  if (!(page >= 1 && page <= pages)) throw Object.assign(new Error(`the sheet has ${plural(pages, 'page')}: page is 1–${pages}`), { status: 400 });
  const rows = all.slice((page - 1) * size, page * size);
  const colors = sceneColors(b);
  const tiles = rows.map(({ scene: s, index, start, end }) => {
    const r = activeRender(s);
    const open = b.notes.filter(n => n.scene === s.id && !n.resolved).length;
    return {
      image: r ? path.join(boardDir, r.poster || r.file) : null,
      num: two(index + 1),
      title: s.title,
      meta: [s.id, `${clock(start)}–${clock(end)}`, musical(b, s.duration), s.status, r ? `${r.kind === 'video' || r.sketch ? `${kindName(r)} ` : ''}${r.id}${s.renders.length > 1 ? ` of ${s.renders.length}` : ''}` : null, open ? plural(open, 'open note') : null].filter(Boolean).join(' · '),
      text: s.picture,
      color: colors.get(s.id),
      caption: text && r ? [s.picture, s.sound && `♪ ${s.sound}`].filter(Boolean).join('\n') : undefined,
    };
  });
  const hasVideo = rows.some(x => activeRender(x.scene)?.kind === 'video');
  const total = all.at(-1).end;
  const part = pages > 1 && `page ${page} of ${pages}: scenes ${rows[0].index + 1}–${rows.at(-1).index + 1}`;
  return drawSheet({
    out, cols: sheetCols(b), tileWidth: tileWidth(b), aspect: b.width / b.height,
    title: b.title,
    subtitle: [slug, `rev ${b.rev}`, part, plural(all.length, 'scene'), secs(total), b.bpm && `${b.bpm} bpm`, hasVideo && `clip posters are taken ${Math.round(POSTER_AT * 100)}% into each clip`].filter(Boolean).join(' · '),
    captionLines: text ? 4 : 0,
    tiles,
  });
}

// n frames spread across one scene's active render, first to last, with pinned notes marked
// on the frame nearest their time.
export async function sceneStrip(b, boardDir, sceneId, n, out) {
  const s = findScene(b, sceneId);
  if (!s) throw new Error(noScene(b, sceneId));
  const r = activeRender(s);
  if (!r) throw Object.assign(new Error(`${s.id} has no render or sketch yet, so the user sees a storyboard card (title, picture, sound)`), { status: 409 });
  const row = layout(b).find(x => x.scene.id === s.id);
  const moves = r.kind === 'video' || r.kind === 'code';
  const d = r.kind === 'video' ? Math.min(s.duration, r.duration || s.duration) : r.kind === 'code' ? s.duration : 0;
  const count = moves ? Math.max(1, Math.min(24, n)) : 1;
  const times = count === 1 ? [d / 2] : Array.from({ length: count }, (_, i) => (i * Math.max(0, d - 1 / b.fps)) / (count - 1));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-strip-'));
  try {
    const tiles = [];
    let codeFrames = null;
    if (r.kind === 'code') codeFrames = (await captureScene(b, boardDir, s, r, { times, tileWidth: 560, dir: tmp })).frames;
    for (const [i, t] of times.entries()) {
      const f = codeFrames ? codeFrames[i] : path.join(tmp, `${i}.jpg`);
      if (!codeFrames) await grabFrame(path.join(boardDir, frameSource(r)), r.kind === 'video' ? t : null, f);
      tiles.push({ image: f, num: two(i + 1), title: moves ? `+${t.toFixed(2)}s` : kindName(r), meta: `${clock(row.start + t)} · frame ${Math.round(t * b.fps)}`, marks: [] });
    }
    for (const note of b.notes.filter(x => x.scene === s.id && x.pin)) {
      const at = note.at ?? 0;
      const k = times.reduce((best, t, i) => (Math.abs(t - at) < Math.abs(times[best] - at) ? i : best), 0);
      tiles[k].marks.push({ x: note.pin.x, y: note.pin.y, label: note.id });
    }
    return await drawSheet({
      out, ...frameGrid(b, count),
      title: `${s.id} “${s.title}” · ${plural(count, 'frame')} across ${secs(d || s.duration)}`,
      subtitle: `${kindName(r)} ${r.id} by ${r.author}${r.caption ? ` (“${r.caption}”)` : ''} · scene ${clock(row.start)}–${clock(row.end)} · orange dots are pinned notes`,
      tiles,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// A labelled row of frames (a code sketch preview filmstrip, say).
export async function framesSheet(b, frames, times, out, { title, start = 0 } = {}) {
  return drawSheet({
    out, ...frameGrid(b, frames.length),
    title, subtitle: 'preview · nothing was added to the board',
    tiles: frames.map((f, i) => ({ image: f, num: two(i + 1), title: `+${times[i].toFixed(2)}s`, meta: `${clock(start + times[i])} in the cut · frame ${Math.round(times[i] * b.fps)}` })),
  });
}

// Several moments of the cut on one labelled image: shots are {t, path, label} from frameAt.
export async function timesSheet(b, shots, out, { title } = {}) {
  return drawSheet({
    out, ...frameGrid(b, shots.length),
    title: title || b.title, subtitle: `${plural(shots.length, 'moment')} of the cut`,
    tiles: shots.map((s, i) => ({ image: s.path, num: two(i + 1), title: clock(s.t), meta: s.label })),
  });
}
