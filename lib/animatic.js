// The animatic: the whole cut as one mp4, with the soundtrack. Clips are trimmed to their scene (the
// last frame holds if a clip is short), stills and SVG sketches hold, code sketches are drawn frame
// by frame in headless Chrome, and scenes with nothing yet show their storyboard card.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { layout, activeRender, placement, sceneColors } from './ops.js';
import { capture, sketchThrew } from './codesketch.js';
import { libSource, run } from './media.js';

const even = x => Math.max(2, Math.round(x / 2) * 2);
const CHUNK = 240; // frames per Chrome launch (about 10 s of film; each frame is a few ms to capture)

const ffmpeg = args => run('ffmpeg', ['-y', '-v', 'error', ...args]);

// A scene with nothing on it yet, drawn as its storyboard card (the same look as the editor's).
function cardCode(s, index, color) {
  const card = { num: String(index + 1).padStart(2, '0'), title: s.title, picture: s.picture || '', sound: s.sound || '', status: s.status, color };
  return `const ctx = canvas.getContext('2d');
const C = ${JSON.stringify(card)};
function lines(text, maxW) {
  const out = [];
  for (const para of text.split('\\n')) {
    let line = '';
    for (const word of para.split(/\\s+/)) {
      const next = line ? line + ' ' + word : word;
      if (ctx.measureText(next).width > maxW && line) { out.push(line); line = word; } else line = next;
    }
    out.push(line);
  }
  return out;
}
function draw(t, s) {
  const W = s.w, H = s.h, u = W / 100;
  ctx.fillStyle = '#0d0d10'; ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W * .3, H * .35, 0, W * .3, H * .35, W * .6);
  g.addColorStop(0, C.color + '33'); g.addColorStop(1, 'transparent');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const x = 8 * u; let y = H * .3;
  ctx.fillStyle = '#86858c'; ctx.font = '500 ' + (1.35 * u) + 'px ui-monospace, Menlo, monospace';
  ctx.fillText(C.num + '   ' + C.status.toUpperCase(), x, y);
  ctx.fillStyle = '#ecebe8'; ctx.font = 'italic 400 ' + (6.4 * u) + 'px "New York", Georgia, serif';
  y += 7.4 * u; ctx.fillText(C.title, x, y);
  ctx.fillStyle = '#b9b8bd'; ctx.font = (1.75 * u) + 'px "Helvetica Neue", system-ui, sans-serif';
  y += 3.4 * u;
  for (const l of lines(C.picture || 'No picture described yet.', 62 * u).slice(0, 6)) { ctx.fillText(l, x, y); y += 2.7 * u; }
  if (C.sound) {
    ctx.fillStyle = '#86858c'; ctx.font = (1.45 * u) + 'px "Helvetica Neue", system-ui, sans-serif';
    y += 1.2 * u;
    for (const l of lines('♪ ' + C.sound, 62 * u).slice(0, 2)) { ctx.fillText(l, x, y); y += 2.3 * u; }
  }
}`;
}

// Frames of a code sketch at fps F, in chunks, as numbered jpgs in dir. Returns the ffmpeg pattern.
async function codeFrames(code, b, { n, F, W, at, lib, dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const jobs = [];
  for (let from = 0; from < n; from += CHUNK) {
    const times = Array.from({ length: Math.min(CHUNK, n - from) }, (_, i) => (from + i) / F);
    // Each chunk captures into its own folder, so chunks drawing at the same time can't collide.
    jobs.push(capture(code, b, { duration: at.duration, times, tileWidth: W, dir: path.join(dir, `chunk${from}`), at, lib, timeout: 120000 }).then(cap => {
      if (cap.errors.length) throw sketchThrew(cap.errors, at.scene);
      cap.frames.forEach((f, i) => fs.renameSync(f, path.join(dir, `f${String(from + i).padStart(6, '0')}.jpg`)));
    }));
  }
  await Promise.all(jobs); // capture() itself keeps to three Chromes at a time
  return path.join(dir, 'f%06d.jpg');
}

// The animatic for a board as it is now, cached per rev and settings; one render per board at a time.
export function exportAnimatic(L, boardDir, { scale = 0.5, fps } = {}) {
  const b = L.board;
  const F = fps || b.fps;
  const out = path.join(boardDir, 'exports', `animatic-rev${b.rev}-${Math.round(scale * 100)}pct-${F}fps.mp4`);
  if (fs.existsSync(out)) return Promise.resolve({ path: out, cached: true });
  L.exports ??= new Map();
  if (!L.exports.has(out)) {
    L.exports.set(out, renderAnimatic(b, boardDir, out, { scale, fps: F }).finally(() => L.exports.delete(out)));
  }
  return L.exports.get(out);
}

// Render the cut to `out`. scale: fraction of the board's size; fps: frames per second (board's by default).
async function renderAnimatic(b, boardDir, out, { scale = 0.5, fps } = {}) {
  const rows = layout(b);
  if (!rows.length) throw new Error('the board has no scenes yet');
  const F = fps || b.fps;
  const W = even(b.width * scale), H = even(b.height * scale);
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`;
  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-r', String(F), '-video_track_timescale', String(F * 1000), '-an'];
  const lib = libSource(b, boardDir);
  const colors = sceneColors(b);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-animatic-'));
  try {
    const segs = [];
    let frames = 0;
    for (const [i, { scene: s }] of rows.entries()) {
      const r = activeRender(s);
      const n = Math.max(1, Math.round(s.duration * F));
      const seg = path.join(tmp, `seg${String(i).padStart(3, '0')}.mp4`);
      const at = placement(b, s.id);
      if (r?.kind === 'code') {
        const pattern = await codeFrames(fs.readFileSync(path.join(boardDir, r.file), 'utf8'), b, { n, F, W, at, lib, dir: path.join(tmp, `f${i}`) });
        await ffmpeg(['-framerate', String(F), '-i', pattern, '-vf', fit, '-frames:v', String(n), ...enc, seg]);
      } else if (r?.kind === 'video') {
        await ffmpeg(['-i', path.join(boardDir, r.file), '-vf', `fps=${F},${fit},tpad=stop_mode=clone:stop_duration=${s.duration + 1}`, '-frames:v', String(n), ...enc, seg]);
      } else {
        // A still, an SVG sketch (its drawn poster), or the scene's card.
        let img;
        if (r) img = path.join(boardDir, /\.svg$/i.test(r.file) ? r.poster : r.file);
        else {
          const cap = await capture(cardCode(s, i, colors.get(s.id)), b, { duration: s.duration, posterAt: 0, dir: path.join(tmp, `c${i}`), at });
          if (cap.errors.length) throw new Error(`${s.id}: couldn't draw its card: ${cap.errors[0]}`);
          img = cap.poster;
        }
        await ffmpeg(['-loop', '1', '-framerate', String(F), '-i', img, '-vf', fit, '-frames:v', String(n), ...enc, seg]);
      }
      segs.push(seg);
      frames += n;
    }
    const list = path.join(tmp, 'list.txt');
    fs.writeFileSync(list, segs.map(p => `file '${p}'`).join('\n'));
    const picture = path.join(tmp, 'picture.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', picture]);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const length = frames / F;
    if (b.audio) {
      await ffmpeg(['-i', picture, '-i', path.join(boardDir, b.audio.file), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', length.toFixed(3), '-movflags', '+faststart', out]);
    } else {
      await ffmpeg(['-i', picture, '-c', 'copy', '-movflags', '+faststart', out]);
    }
    return { path: out, width: W, height: H, fps: F, seconds: length, scenes: rows.length };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
