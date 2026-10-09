// Bringing files into a board. Stills are copied; clips get a light H.264 proxy with short
// keyframe spacing so scrubbing is instant, plus a poster and a filmstrip for the timeline.
// Soundtracks are copied (or transcoded when a browser can't play them) and get a peaks file
// for the waveform. Everything uses ffmpeg/ffprobe.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { locate, activeRender, findScene, noScene, placement, clock, plural } from './ops.js';
import { capture, sketchThrew } from './codesketch.js';

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
export const frameSource = r => (/\.svg$/i.test(r.file) ? r.poster : r.file);
const BROWSER_AUDIO = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus'];
// Clips and code sketches get a poster this far in, and a filmstrip for the timeline.
export const POSTER_AT = 0.4;
export const STRIP_FRAMES = 10;
export const STRIP_HEIGHT = 120;

export function mediaKind(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return Object.keys(KINDS).find(k => KINDS[k].includes(ext)) || null;
}

// Run ffmpeg or ffprobe: resolves with what it printed, or fails with its last words.
export function run(cmd, args) {
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
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(d * POSTER_AT), '-i', abs(file), '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", abs(`${rel}.poster.jpg`)]);
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

// The soundtrack's parts, for the sound view: a folder (or its sound.json, format "cutroom-sound/1") with a stem
// per layer and every sound listed. The stems are kept as FLAC (lossless and sample-exact, so they stay in sync
// with each other and the mix), each with its peaks; the sounds go to their own file in media, sorted by time,
// because a score has thousands. Returns the board's `sound` (see the manual, "Sound").
export async function ingestSound(boardDir, src, { base }) {
  if (!fs.existsSync(src)) throw new Error(`no such file or folder: ${src}`);
  const json = fs.statSync(src).isDirectory() ? path.join(src, 'sound.json') : src;
  if (!fs.existsSync(json)) throw new Error(`no sound.json in ${src}`);
  let spec;
  try { spec = JSON.parse(fs.readFileSync(json, 'utf8')); } catch (e) { throw new Error(`${json} isn't JSON: ${e.message}`); }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`${json}: not a sound.json (an object with "layers" and "events")`);
  if (spec.format && spec.format !== 'cutroom-sound/1') throw new Error(`${json}: format "${spec.format}"; Cutroom reads "cutroom-sound/1"`);
  const root = path.dirname(json);
  if (!Array.isArray(spec.layers) || !spec.layers.length) throw new Error('sound.json: "layers" lists the layers, each {id, label, stem}');
  if (!Array.isArray(spec.events)) throw new Error('sound.json: "events" lists every sound, each {id, layer, t, dur, note, label}');
  const ids = new Set();
  for (const [i, l] of spec.layers.entries()) {
    if (!l?.id || !/^[\w.-]+$/.test(String(l.id))) throw new Error(`sound.json: layers[${i}] needs an id of letters, digits, - _ or .`);
    if (ids.has(String(l.id))) throw new Error(`sound.json: two layers called "${l.id}"`);
    ids.add(String(l.id)); // ids are names: a layer 1 and an event on layer "1" are the same layer
    if (!l.stem) throw new Error(`sound.json: layer ${l.id} has no stem`);
    const f = path.resolve(root, l.stem);
    if (!fs.existsSync(f)) throw new Error(`sound.json: layer ${l.id}'s stem isn't there: ${f}`);
    if (mediaKind(f) !== 'audio') throw new Error(`sound.json: layer ${l.id}'s stem isn't audio: ${f}`);
  }
  const seen = new Set();
  const round = x => Math.round(x * 1e6) / 1e6;
  const events = spec.events.map((e, i) => {
    if (!e || typeof e !== 'object') throw new Error(`sound.json: events[${i}] isn't an object`);
    if (!ids.has(String(e.layer))) throw new Error(`sound.json: events[${i}]${e.id != null ? ` (${e.id})` : ''} is on layer "${e.layer}", which isn't in "layers"`);
    // a time must be given: null, "" or true are not 0 s
    const num = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? +v : NaN);
    const t = num(e.t), dur = e.dur == null ? null : num(e.dur);
    if (!Number.isFinite(t) || t < 0 || t > 86400) throw new Error(`sound.json: events[${i}]${e.id != null ? ` (${e.id})` : ''} needs a time "t" in seconds`);
    const id = e.id != null && e.id !== '' ? String(e.id) : `${e.layer}-${i}`;
    if (seen.has(id)) throw new Error(`sound.json: two sounds with the id "${id}" (ids must be unique)`);
    seen.add(id);
    return { id, layer: String(e.layer), t: round(t), dur: dur != null && Number.isFinite(dur) && dur > 0 ? round(dur) : null, note: e.note == null || e.note === '' ? null : String(e.note), ...(Array.isArray(e.notes) && e.notes.length ? { notes: e.notes.slice(0, 16).map(String) } : {}), label: e.label ? String(e.label).trim() : '' };
  }).sort((p, q) => p.t - q.t);
  const dir = `media/sound/${base}`;
  fs.mkdirSync(path.join(boardDir, dir), { recursive: true });
  // four layers at a time: a score has 17, each an ffmpeg encode and a decode for its peaks
  const pool = async (items, n, fn) => { const out = []; let next = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const k = next++; out[k] = await fn(items[k]); } })); return out; };
  const layers = await pool(spec.layers, 4, async l => {
    const stem = path.resolve(root, l.stem), file = `${dir}/${l.id}.flac`, peaks = `${file}.peaks.json`;
    await run('ffmpeg', ['-y', '-v', 'error', '-i', stem, '-map', '0:a:0', '-c:a', 'flac', path.join(boardDir, file)]); // its own bit depth (16 or 24)
    fs.writeFileSync(path.join(boardDir, peaks), JSON.stringify(await computePeaks(stem)));
    return { id: String(l.id), label: l.label ? String(l.label) : String(l.id), file, peaks, ...(l.color ? { color: String(l.color) } : {}), count: events.filter(e => e.layer === String(l.id)).length };
  });
  const eventsFile = `${dir}/events.json`;
  fs.writeFileSync(path.join(boardDir, eventsFile), JSON.stringify(events));
  const duration = Number.isFinite(+spec.duration) && +spec.duration > 0 ? +spec.duration : (await probe(path.resolve(root, spec.layers[0].stem))).duration;
  return { name: spec.name ? String(spec.name) : path.basename(root), duration, layers, events: eventsFile, count: events.length, source: json };
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

// Draw a scene's code render, placed where the scene sits in the cut and with the board's library.
export async function captureScene(b, boardDir, s, r, opts) {
  const cap = await capture(fs.readFileSync(path.join(boardDir, r.file), 'utf8'), b, { duration: s.duration, at: placement(b, s.id), lib: libSource(b, boardDir), ...opts });
  if (cap.errors.length) throw sketchThrew(cap.errors);
  return cap;
}

// The frame a note points at ({note}), a scene at a time ({scene, at}) or a point in the cut ({t}).
// Returns {path, label}; throws with status 409 when the scene has no render (the user sees a card).
export async function frameAt(b, boardDir, { note, scene, at, t }, out, { width = 1280 } = {}) {
  let s, local, pin = null, label;
  if (note) {
    const n = b.notes.find(x => x.id === note);
    if (!n) throw Object.assign(new Error(`no note ${note} (notes: ${b.notes.map(x => x.id).join(', ') || 'none'})`), { status: 404 });
    // A moment in the soundtrack: whatever is on screen then.
    if (n.soundtrack) {
      if (n.at == null) throw new Error(`${note} is about the whole soundtrack, not a moment`);
      const f = await frameAt(b, boardDir, { t: n.at }, out, { width });
      return { ...f, label: `${note} on the soundtrack: ${f.label}` };
    }
    if (!n.scene) throw new Error(`${note} is about the whole film, not a frame`);
    s = findScene(b, n.scene);
    if (!s) throw Object.assign(new Error(`${note} is on a deleted scene (${n.scene})`), { status: 404 });
    local = n.at ?? 0;
    pin = n.pin;
    label = `${note} on ${s.id} “${s.title}” +${+local.toFixed(3)}s`;
    // A marked-up note: the frame as the user saw it, with their marks drawn on it.
    const marked = n.markup?.image && path.join(boardDir, n.markup.image);
    if (marked && fs.existsSync(marked)) return { path: marked, label: `${label} · marked up on ${n.markup.render || 'the card'} with ${plural(n.markup.marks.length, 'numbered mark')}` };
  } else if (scene) {
    s = findScene(b, scene);
    if (!s) throw Object.assign(new Error(noScene(b, scene)), { status: 404 });
    local = Math.min(Math.max(0, +(at || 0)), s.duration);
    label = `${s.id} “${s.title}” +${+local.toFixed(3)}s`;
  } else {
    if (t == null || !Number.isFinite(+t)) throw new Error('say which frame: note=nX, scene=sX (&at=seconds) or t=seconds');
    const hit = locate(b, +t);
    if (!hit) throw new Error('the board has no scenes');
    s = hit.scene;
    local = Math.min(hit.local, s.duration);
    label = `${clock(+t)} → ${s.id} “${s.title}” +${local.toFixed(3)}s`;
  }
  const r = activeRender(s);
  if (!r) throw Object.assign(new Error(`${label}: no render or sketch yet, so the user sees the storyboard card (title, picture and sound text)`), { status: 409 });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (r.kind === 'code') {
    const cap = await captureScene(b, boardDir, s, r, { posterAt: local, posterWidth: width, dir: path.dirname(out) });
    await grabFrame(cap.poster, null, out, pin, width);
    fs.rmSync(cap.poster, { force: true });
  } else await grabFrame(path.join(boardDir, frameSource(r)), r.kind === 'video' ? Math.min(local, (r.duration || local) - 0.5 / b.fps) : null, out, pin, width);
  if (pin) label += ` · pin at ${Math.round(pin.x * 100)}% across, ${Math.round(pin.y * 100)}% down (orange square)`;
  return { path: out, label: `${label} · render ${r.id}` };
}

export const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
