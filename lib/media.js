// Bringing files into a board. Stills are copied; clips get a light H.264 proxy with short
// keyframe spacing so scrubbing is instant, plus a poster and a filmstrip for the timeline.
// Soundtracks are copied (or transcoded when a browser can't play them) and get a peaks file
// for the waveform. Everything uses ffmpeg/ffprobe.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layout, locate, activeRender, findScene, musical, kindName, placement, tc, secs, sceneColors } from './ops.js';
import { capture } from './codesketch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const KINDS = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'tif', 'tiff'],
  video: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'],
  audio: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'aif', 'aiff', 'opus'],
  sketch: ['svg'],
  code: ['js'],
};

// The shared library as it is right now, for previews: the sketches folder's _shared.js when it is
// newer than the board's copy (an agent may have saved it a moment ago), otherwise the board's copy.
export function currentLib(b, boardDir) {
  const f = path.join(boardDir, 'sketches', '_shared.js');
  const stored = b.sketchLib && !b.sketchLib.startsWith('(') ? path.join(boardDir, b.sketchLib) : null;
  try {
    if (fs.existsSync(f) && (!stored || fs.statSync(f).mtimeMs > fs.statSync(stored).mtimeMs)) return fs.readFileSync(f, 'utf8');
  } catch {}
  return libSource(b, boardDir);
}

// The board's shared library source, which runs before every code sketch (or null).
export const libSource = (b, boardDir) => (b.sketchLib && !b.sketchLib.startsWith('(') ? fs.readFileSync(path.join(boardDir, b.sketchLib), 'utf8') : null);

// The file to take frames from: a drawn SVG's poster, otherwise the media itself.
const frameSource = r => (/\.svg$/i.test(r.file) ? r.poster : r.file);
const BROWSER_AUDIO = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus'];
const STRIP_FRAMES = 10;
const STRIP_HEIGHT = 120;

export function mediaKind(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return Object.keys(KINDS).find(k => KINDS[k].includes(ext)) || null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 1 << 29, encoding: 'buffer' }, (err, stdout, stderr) =>
      err ? reject(new Error(err.code === 'ENOENT' ? `${cmd} isn't installed: clips, stills and soundtracks need ffmpeg (brew install ffmpeg)` : `${cmd} failed: ${String(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`)) : resolve(stdout),
    ),
  );
}

export async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out.toString());
  const v = j.streams.find(s => s.codec_type === 'video');
  const [fn, fd] = String(v?.r_frame_rate || '0/1').split('/').map(Number);
  return {
    duration: Number(v?.duration) || Number(j.format?.duration) || null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    fps: fd ? fn / fd : null,
    hasAudio: j.streams.some(s => s.codec_type === 'audio'),
  };
}

// src: a file on disk. base: file name stem inside media/renders. proxy=false copies a clip as is.
// cut: {start, duration} takes just that stretch of a clip (a scene's worth of a whole film).
export async function ingestRender(boardDir, src, { base, proxy = true, cut = null } = {}) {
  const kind = mediaKind(src);
  if (kind !== 'image' && kind !== 'video') throw new Error(`can't use ${path.basename(src)} as a render (stills: ${KINDS.image.join(', ')}; clips: ${KINDS.video.join(', ')})`);
  const rel = `media/renders/${base}`;
  const abs = p => path.join(boardDir, p);
  fs.mkdirSync(path.join(boardDir, 'media/renders'), { recursive: true });
  const info = await probe(src);

  if (kind === 'image') {
    const ext = path.extname(src).toLowerCase();
    fs.copyFileSync(src, abs(rel + ext));
    await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vf', "scale='min(640,iw)':-2", '-frames:v', '1', abs(`${rel}.poster.jpg`)]);
    return { kind, file: rel + ext, poster: `${rel}.poster.jpg`, width: info.width, height: info.height, duration: null };
  }

  const ext = path.extname(src).toLowerCase();
  const file = proxy || cut || !['.mp4', '.webm', '.m4v'].includes(ext) ? `${rel}.mp4` : rel + ext;
  if (file === `${rel}.mp4` && (proxy || cut || ext !== '.mp4')) {
    await run('ffmpeg', [
      '-y', '-v', 'error', ...(cut ? ['-ss', String(cut.start), '-t', String(cut.duration)] : []), '-i', src, '-an',
      '-vf', "scale='min(1920,iw)':-2:flags=lanczos,format=yuv420p",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '12', '-movflags', '+faststart',
      abs(file),
    ]);
  } else {
    fs.copyFileSync(src, abs(file));
  }
  const d = (cut ? (await probe(abs(file))).duration : info.duration) || (await probe(abs(file))).duration || 1;
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(d * 0.4), '-i', abs(file), '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", abs(`${rel}.poster.jpg`)]);
  const rate = (STRIP_FRAMES / d) * 1.04;
  await run('ffmpeg', ['-y', '-v', 'error', '-i', abs(file), '-vf', `fps=${rate},scale=-2:${STRIP_HEIGHT},tile=${STRIP_FRAMES}x1`, '-frames:v', '1', abs(`${rel}.strip.jpg`)]);
  return { kind, file, poster: `${rel}.poster.jpg`, strip: `${rel}.strip.jpg`, stripFrames: STRIP_FRAMES, duration: d, width: info.width, height: info.height };
}

export async function ingestAudio(boardDir, src, { base }) {
  if (mediaKind(src) !== 'audio') throw new Error(`can't use ${path.basename(src)} as a soundtrack (${KINDS.audio.join(', ')})`);
  const ext = path.extname(src).slice(1).toLowerCase();
  fs.mkdirSync(path.join(boardDir, 'media/audio'), { recursive: true });
  const file = `media/audio/${base}.${BROWSER_AUDIO.includes(ext) ? ext : 'm4a'}`;
  if (BROWSER_AUDIO.includes(ext)) fs.copyFileSync(src, path.join(boardDir, file));
  else await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-c:a', 'aac', '-b:a', '256k', path.join(boardDir, file)]);
  const info = await probe(src);
  const peaks = `${file}.peaks.json`;
  fs.writeFileSync(path.join(boardDir, peaks), JSON.stringify(await computePeaks(src)));
  return { file, name: path.basename(src), duration: info.duration, peaks };
}

// 100 buckets a second of peak and RMS, 0–255.
async function computePeaks(src, rate = 100) {
  const SR = 8000;
  const raw = await run('ffmpeg', ['-v', 'error', '-i', src, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-']);
  const n = Math.floor(raw.length / 4);
  const per = SR / rate;
  const buckets = Math.ceil(n / per);
  const peak = new Array(buckets), rms = new Array(buckets);
  for (let i = 0; i < buckets; i++) {
    let p = 0, sq = 0, c = 0;
    const end = Math.min(n, (i + 1) * per);
    for (let j = i * per; j < end; j++) {
      const x = raw.readFloatLE(j * 4);
      const a = Math.abs(x);
      if (a > p) p = a;
      sq += x * x;
      c++;
    }
    peak[i] = Math.min(255, Math.round(p * 255));
    rms[i] = Math.min(255, Math.round(Math.sqrt(sq / Math.max(1, c)) * 255));
  }
  return { rate, peak, rms };
}

// A file attached to a note or reply (a reference still, a clip, a PDF…), copied into media/refs.
// Clips get a poster so the editor can show them small. dry: describe it without copying.
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'];
export async function saveAttachment(boardDir, src, name = path.basename(src), { dry = false } = {}) {
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw Object.assign(new Error(`no file at ${src}`), { status: 404 });
  const ext = path.extname(name).slice(1).toLowerCase();
  const kind = IMAGE_EXT.includes(ext) ? 'image' : KINDS.video.includes(ext) ? 'video' : KINDS.audio.includes(ext) ? 'audio' : ext === 'pdf' ? 'pdf' : 'file';
  const base = `${stamp()}-${name.replace(/\s+/g, '-').replace(/[^\w.\-]+/g, '_').slice(-80)}`;
  const a = { file: `media/refs/${base}`, name, kind, size: fs.statSync(src).size };
  if (dry) return a;
  const abs = path.join(boardDir, a.file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.copyFileSync(src, abs);
  if (kind === 'video' || (kind === 'image' && ext !== 'svg')) {
    try {
      const p = await probe(abs);
      Object.assign(a, { width: p.width, height: p.height });
      if (kind === 'video') {
        a.duration = p.duration;
        a.poster = `media/refs/${base}.poster.jpg`;
        await grabFrame(abs, Math.min(1, (p.duration || 0) / 2), path.join(boardDir, a.poster));
      }
    } catch {}
  }
  return a;
}

// One frame as a jpg, 1280 wide, with an optional pin ring at {x, y} (0–1).
export async function grabFrame(file, t, out, pin, width = 1280) {
  const vf = [`scale='min(${Math.round(width)},iw)':-2`];
  if (pin) {
    const at = (v, d) => `${d}*${v}-18`;
    vf.push(`drawbox=x=${at(pin.x, 'iw')}:y=${at(pin.y, 'ih')}:w=36:h=36:color=0xff5b35@0.95:t=4`);
    vf.push(`drawbox=x=iw*${pin.x}-3:y=ih*${pin.y}-3:w=6:h=6:color=0xff5b35@0.95:t=fill`);
  }
  await run('ffmpeg', ['-y', '-v', 'error', ...(t != null ? ['-ss', String(Math.max(0, t))] : []), '-i', file, '-frames:v', '1', '-vf', vf.join(','), '-q:v', '3', out]);
  return out;
}

// The frame a note points at ({note}), a scene at a time ({scene, at}) or a point in the cut ({t}).
// Returns {path, label}; throws with status 409 when the scene has no render (the user sees a card).
export async function frameAt(b, boardDir, { note, scene, at, t }, out, { width = 1280 } = {}) {
  let s, local, pin = null, label;
  if (note) {
    const n = b.notes.find(x => x.id === note);
    if (!n) throw Object.assign(new Error(`no note ${note} (notes: ${b.notes.map(x => x.id).join(', ') || 'none'})`), { status: 404 });
    if (!n.scene) throw new Error(`${note} is about the whole board, not a frame`);
    s = findScene(b, n.scene);
    if (!s) throw Object.assign(new Error(`${note} is on a deleted scene (${n.scene})`), { status: 404 });
    local = n.at ?? 0;
    pin = n.pin;
    label = `${note} on ${s.id} “${s.title}” +${+local.toFixed(3)}s`;
    // A marked-up note: the frame as the user saw it, with their marks drawn on it.
    const marked = n.markup?.image && path.join(boardDir, n.markup.image);
    if (marked && fs.existsSync(marked)) return { path: marked, label: `${label} · marked up on ${n.markup.render || 'the card'} with ${n.markup.marks.length} numbered mark${n.markup.marks.length === 1 ? '' : 's'}` };
  } else if (scene) {
    s = findScene(b, scene);
    if (!s) throw Object.assign(new Error(`no scene ${scene} (scenes: ${b.scenes.map(x => x.id).join(', ') || 'none'})`), { status: 404 });
    local = Math.min(Math.max(0, +(at || 0)), s.duration);
    label = `${s.id} “${s.title}” +${+local.toFixed(3)}s`;
  } else {
    if (t == null || !Number.isFinite(+t)) throw new Error('say which frame: note=nX, scene=sX (&at=seconds) or t=seconds');
    const hit = locate(b, +t);
    if (!hit) throw new Error('the board has no scenes');
    s = hit.scene;
    local = Math.min(hit.local, s.duration);
    label = `${tc(+t)} → ${s.id} “${s.title}” +${local.toFixed(3)}s`;
  }
  const r = activeRender(s);
  if (!r) throw Object.assign(new Error(`${label}: no render or sketch yet, so the user sees the storyboard card (title, picture and sound text)`), { status: 409 });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (r.kind === 'code') {
    const cap = await capture(fs.readFileSync(path.join(boardDir, r.file), 'utf8'), b, { duration: s.duration, posterAt: local, posterWidth: width, dir: path.dirname(out), at: placement(b, s.id), lib: libSource(b, boardDir) });
    if (cap.errors.length) throw new Error(`the code sketch threw an error: ${cap.errors[0]}`);
    await grabFrame(cap.poster, null, out, pin, width);
    fs.rmSync(cap.poster, { force: true });
  } else await grabFrame(path.join(boardDir, frameSource(r)), r.kind === 'video' ? Math.min(local, (r.duration || local) - 0.5 / b.fps) : null, out, pin, width);
  if (pin) label += ` · pin at ${Math.round(pin.x * 100)}% across, ${Math.round(pin.y * 100)}% down (orange square)`;
  return { path: out, label: `${label} · render ${r.id}` };
}

// ---------------------------------------------------------------- contact sheets

const SHEET_SRC = path.join(ROOT, 'tools/sheet.swift');
const SHEET_BIN = path.join(ROOT, 'tools/.bin/sheet');

// The sheet drawer is a tiny Swift program (CoreGraphics + CoreText), compiled on first use.
async function sheetTool() {
  const stale = !fs.existsSync(SHEET_BIN) || fs.statSync(SHEET_BIN).mtimeMs < fs.statSync(SHEET_SRC).mtimeMs;
  if (stale) {
    fs.mkdirSync(path.dirname(SHEET_BIN), { recursive: true });
    await run('swiftc', ['-O', SHEET_SRC, '-o', SHEET_BIN]);
  }
  return SHEET_BIN;
}

async function drawSheet(spec) {
  const bin = await sheetTool();
  await new Promise((resolve, reject) => {
    const p = spawn(bin, [], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => (code ? reject(new Error(`sheet failed: ${err.trim()}`)) : resolve()));
    p.stdin.end(JSON.stringify(spec));
  });
  return spec.out;
}

const two = n => String(n).padStart(2, '0');
const tileWidth = b => (b.width >= b.height ? 480 : 300);

// Every scene in order: its active render's poster, or a card drawn from its text.
// With `text`, each tile is captioned with the scene's picture and sound text, which is what makes an
// idea board read as a storyboard. (Tiles without a picture already show their text as a card.)
export async function contactSheet(b, boardDir, out, { slug, text = true } = {}) {
  const rows = layout(b);
  if (!rows.length) throw new Error('the board has no scenes yet');
  const colors = sceneColors(b);
  const tiles = rows.map(({ scene: s, index, start, end }) => {
    const r = activeRender(s);
    const open = b.notes.filter(n => n.scene === s.id && !n.resolved).length;
    return {
      image: r ? path.join(boardDir, r.poster || r.file) : null,
      num: two(index + 1),
      title: s.title,
      meta: [s.id, `${tc(start)}–${tc(end)}`, musical(b, s.duration), s.status, r ? `${r.kind === 'video' || r.sketch ? `${kindName(r)} ` : ''}${r.id}${s.renders.length > 1 ? ` of ${s.renders.length}` : ''}` : null, open ? `${open} open note${open > 1 ? 's' : ''}` : null].filter(Boolean).join(' · '),
      text: s.picture,
      color: colors.get(s.id),
      caption: text && r ? [s.picture, s.sound && `♪ ${s.sound}`].filter(Boolean).join('\n') : undefined,
    };
  });
  const hasVideo = rows.some(x => activeRender(x.scene)?.kind === 'video');
  const total = rows.at(-1).end;
  return drawSheet({
    out, cols: b.width >= b.height ? 4 : 6, tileWidth: tileWidth(b), aspect: b.width / b.height,
    title: b.title,
    subtitle: [slug, `rev ${b.rev}`, `${rows.length} scenes`, secs(total), b.bpm && `${b.bpm} bpm`, hasVideo && 'clip posters are taken 40% into each clip'].filter(Boolean).join(' · '),
    captionLines: text ? 4 : 0,
    tiles,
  });
}

// n frames spread across one scene's active render, first to last, with pinned notes marked
// on the frame nearest their time.
export async function sceneStrip(b, boardDir, sceneId, n, out) {
  const s = findScene(b, sceneId);
  if (!s) throw new Error(`no scene ${sceneId}`);
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
    if (r.kind === 'code') {
      const cap = await capture(fs.readFileSync(path.join(boardDir, r.file), 'utf8'), b, { duration: s.duration, times, tileWidth: 560, dir: tmp, at: placement(b, s.id), lib: libSource(b, boardDir) });
      if (cap.errors.length) throw new Error(`the code sketch threw an error: ${cap.errors[0]}`);
      codeFrames = cap.frames;
    }
    for (const [i, t] of times.entries()) {
      const f = codeFrames ? codeFrames[i] : path.join(tmp, `${i}.jpg`);
      if (!codeFrames) await grabFrame(path.join(boardDir, frameSource(r)), r.kind === 'video' ? t : null, f);
      tiles.push({ image: f, num: two(i + 1), title: moves ? `+${t.toFixed(2)}s` : kindName(r), meta: `${tc(row.start + t)} · frame ${Math.round(t * b.fps)}`, marks: [] });
    }
    for (const note of b.notes.filter(x => x.scene === s.id && x.pin)) {
      const at = note.at ?? 0;
      const k = times.reduce((best, t, i) => (Math.abs(t - at) < Math.abs(times[best] - at) ? i : best), 0);
      tiles[k].marks.push({ x: note.pin.x, y: note.pin.y, label: note.id });
    }
    return await drawSheet({
      out, cols: count <= 4 ? count : count <= 9 ? 3 : 4, tileWidth: b.width >= b.height ? 560 : 320, aspect: b.width / b.height,
      title: `${s.id} “${s.title}” · ${count} frame${count > 1 ? 's' : ''} across ${secs(d || s.duration)}`,
      subtitle: `${kindName(r)} ${r.id} by ${r.author}${r.caption ? ` (“${r.caption}”)` : ''} · scene ${tc(row.start)}–${tc(row.end)} · orange dots are pinned notes`,
      tiles,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// A labelled row of frames (a code sketch preview filmstrip, say).
export async function framesSheet(b, frames, times, out, { title, start = 0 } = {}) {
  return drawSheet({
    out, cols: frames.length <= 4 ? frames.length : frames.length <= 9 ? 3 : 4, tileWidth: b.width >= b.height ? 560 : 320, aspect: b.width / b.height,
    title, subtitle: 'preview · nothing was added to the board',
    tiles: frames.map((f, i) => ({ image: f, num: two(i + 1), title: `+${times[i].toFixed(2)}s`, meta: `${tc(start + times[i])} in the cut · frame ${Math.round(times[i] * b.fps)}` })),
  });
}

// Several moments of the cut on one labelled image: shots are {t, path, label} from frameAt.
export async function timesSheet(b, shots, out, { title } = {}) {
  return drawSheet({
    out, cols: shots.length <= 4 ? shots.length : shots.length <= 9 ? 3 : 4, tileWidth: b.width >= b.height ? 560 : 320, aspect: b.width / b.height,
    title: title || b.title, subtitle: `${shots.length} moment${shots.length > 1 ? 's' : ''} of the cut`,
    tiles: shots.map((s, i) => ({ image: s.path, num: two(i + 1), title: tc(s.t), meta: s.label })),
  });
}

export const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
