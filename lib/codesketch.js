// Code sketches: a shot sketched in JavaScript. The code gets a canvas and defines draw(t, s),
// which draws the whole frame from t alone (no state carried between frames, like a render
// pipeline), so any frame can be drawn on its own. The editor runs it live in a sandboxed frame,
// synced to the playhead. For an agent's eyes (posters, filmstrips, frames) the server draws
// frames in headless Chrome, in a single launch.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { sketchCanvas as canvasSize } from './ops.js';

const CHROMES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

export const chrome = () => CHROMES.find(p => fs.existsSync(p)) || null;

// At most three headless Chromes at once. Twelve sketches landing together draw faster three at a
// time (about 18 s rather than 24 s for twelve), the first ones appear within seconds, and memory
// stays reasonable.
const MAX_CHROMES = 3;
let running = 0;
const waiting = [];
const acquire = () => new Promise(res => (running < MAX_CHROMES ? (running++, res()) : waiting.push(res)));
const release = () => { const next = waiting.shift(); next ? next() : running--; };

export { RUNNER } from './sketch-runtime.js';
import { RUNNER } from './sketch-runtime.js';

// Syntax only (the code runs in a browser, so it isn't executed here). A shared library is the
// same, minus the need for draw().
export function checkSyntax(code, { lib = false } = {}) {
  if (!String(code ?? '').trim()) throw new Error(`the ${lib ? 'shared library' : 'code sketch'} is empty`);
  if (/^\s*(import|export)\s/m.test(code)) throw new Error(`a ${lib ? 'shared library' : 'code sketch'} is a plain script: no import or export`);
  try {
    // Wrapped the way the runner wraps it; lineOffset makes line numbers point into the code itself.
    new vm.Script(`(function (canvas) {\n${code}\n})`, { filename: 'sketch.js', lineOffset: -1 });
  } catch (e) {
    const lines = String(code).split('\n').length;
    const line = +(/sketch\.js:(\d+)/.exec(e.stack || '')?.[1] || 0);
    const where = !line ? '' : line > lines ? ' (at the end: something opened earlier is never closed)' : ` (line ${line})`;
    throw new Error(`the ${lib ? 'shared library' : 'code sketch'} doesn't parse${where}: ${e.message}`);
  }
  // Whether draw() exists is checked when the sketch runs: the shared library may supply it.
}

// Draw frames at the given times. Returns { poster?: jpgPath, frames: [jpgPaths], errors: [strings] }.
// posterAt: a time for a 1280-wide poster; times: frames of tileWidth each.
// `at` describes where the scene sits in the cut: { start, filmDuration, scene, index }. `lib` is the
// board's shared library source (or null).
export async function capture(code, b, { duration, posterAt = null, times = [], tileWidth = 560, dir, timeout = 45000, at = {}, lib = null }) {
  const exe = chrome();
  if (!exe) throw Object.assign(new Error('drawing code sketches needs Google Chrome (or set CHROME to a Chromium-based browser)'), { status: 501 });
  const { w, h } = canvasSize(b);
  const meta = { duration, fps: b.fps, bpm: b.bpm, beatsPerBar: b.beatsPerBar, beatOffset: b.beatOffset || 0, start: at.start || 0, filmDuration: at.filmDuration || null, scene: at.scene || null, index: at.index ?? null };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-code-'));
  const page = path.join(tmp, 'capture.html');
  // The code sits in an inert <script type="text/plain"> ahead of the runner, which reads it.
  const inert = String(code).replace(/<\/script/gi, '<\\/script');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><body><pre id="out"></pre>
<script type="text/plain" id="code">${inert}</script>
<script type="text/plain" id="lib">${String(lib || '').replace(/<\/script/gi, '<\\/script')}</script>
<script>${RUNNER}
// In headless Chrome a GPU-backed 2D canvas makes every frame read-back stall (~100 ms a frame);
// CPU-backed 2D canvases read back in a few ms. WebGL keeps the GPU.
const getContext0 = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (type, opts) {
  return getContext0.call(this, type, type === '2d' ? { willReadFrequently: true, ...(opts || {}) } : opts);
};
const W = ${w}, H = ${h}, M = ${JSON.stringify(meta)}, POSTER = ${JSON.stringify(posterAt)}, TIMES = ${JSON.stringify(times)}, TILE = ${tileWidth};
const out = { poster: null, frames: [], errors: [] };
const main = document.createElement('canvas'); main.width = W; main.height = H;
const shot = (t, width) => {
  const c = document.createElement('canvas'); c.width = width; c.height = Math.round(width * H / W);
  const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
  try { draw(t, sketchInfo(W, H, t, M)); x.drawImage(main, 0, 0, c.width, c.height); }
  catch (e) { out.errors.push('at t=' + t.toFixed(3) + ': ' + (e && e.message || e)); x.fillStyle = '#ff6b52'; x.font = '20px Helvetica Neue, sans-serif'; x.fillText(String(e && e.message || e).slice(0, 90), 16, 36); }
  return c.toDataURL('image/jpeg', 0.9);
};
let draw = null;
try { draw = compileSketch(document.getElementById('code').textContent, main, document.getElementById('lib').textContent); } catch (e) { out.errors.push(String(e && e.message || e)); }
if (draw) {
  if (POSTER != null) out.poster = shot(POSTER, Math.min(1280, W));
  for (const t of TIMES) out.frames.push(shot(t, TILE));
}
document.getElementById('out').textContent = '@@' + JSON.stringify(out) + '@@';
</script></body>`);
  try {
    await acquire();
    let dom;
    try {
      dom = await dumpDom(exe, `file://${page}`, { timeout, profile: path.join(tmp, 'profile') });
    } finally {
      release();
    }
    const m = /<pre id="out">@@([\s\S]*?)@@<\/pre>/.exec(dom);
    if (!m) throw new Error("the code sketch didn't finish drawing (Chrome's page never reported a result)");
    const res = JSON.parse(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));
    fs.mkdirSync(dir, { recursive: true });
    const save = (dataUrl, name) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, Buffer.from(dataUrl.split(',')[1], 'base64'));
      return p;
    };
    const stem = `code-${Date.now().toString(36)}`;
    return {
      poster: res.poster ? save(res.poster, `${stem}-poster.jpg`) : null,
      frames: res.frames.map((f, i) => save(f, `${stem}-${i}.jpg`)),
      errors: res.errors,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Run headless Chrome and return the page's DOM as soon as it has been printed, without waiting
// for Chrome to exit: on some machines (no display for the process, say) Chrome prints the DOM
// in a couple of seconds and then hangs for ~45 s in teardown. Each run gets its own profile, and
// the whole process group is killed once the output is complete.
function dumpDom(exe, url, { timeout, profile }) {
  return new Promise((resolve, reject) => {
    const args = ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--virtual-time-budget=8000', '--dump-dom', url];
    const p = spawn(exe, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const complete = () => /<\/html>\s*$/.test(out);
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { process.kill(-p.pid, 'SIGKILL'); } catch {}
      fn(v);
    };
    p.stdout.on('data', d => { out += d; if (complete()) finish(resolve, out); });
    p.stderr.on('data', d => { err = (err + d).slice(-8000); });
    p.on('error', e => finish(reject, new Error(`couldn't start Chrome: ${e.message}`)));
    p.on('close', code => {
      if (complete()) return finish(resolve, out);
      const last = err.trim().split('\n').filter(l => !/CVDisplayLink/.test(l)).slice(-2).join(' ').slice(0, 300);
      finish(reject, new Error(`Chrome exited (code ${code}) before the sketch finished drawing${last ? `: ${last}` : ''}`));
    });
    const timer = setTimeout(() => finish(reject, new Error(out
      ? 'Chrome printed part of the page and then stalled; try again'
      : `the code sketch didn't finish drawing in ${Math.round(timeout / 1000)} s: an endless loop in draw() or at the top level, or Chrome couldn't run here`)), timeout);
  });
}
