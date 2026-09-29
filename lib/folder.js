// The sketches folder: boards/<board>/sketches/. A file named after a scene (s3.jpg, s3-wide.png,
// s3.mp4, s3.svg, s3.js …) becomes a sketch version on that scene; saving it again updates that
// same version in place. Each distinct file is its own version. `_shared.js` is the board's shared
// library, run before every code sketch. Files are picked up while the server runs, and on start.
// Anything that can't be used is kept in `problems` (shown to agents).

import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import { makeSketch } from './sketch.js';
import { checkSyntax } from './codesketch.js';
import { findScene, placement } from './ops.js';
import { stamp, libSource } from './media.js';

const SHARED = '_shared.js';

export const SKETCH_FILE = /^(s\d+)(?:[-_. ][^/]*)?\.(png|jpe?g|webp|gif|avif|svg|js|mp4|mov|m4v|webm)$/i;
export const sketchesDir = slug => path.join(store.dir(slug), 'sketches');

export function watchSketches(L, commit) {
  const dir = sketchesDir(L.slug);
  fs.mkdirSync(dir, { recursive: true });
  L.problems = new Map();
  const timers = new Map(), busy = new Set(), again = new Set();

  const watched = name => name === SHARED || SKETCH_FILE.test(name);
  const schedule = name => {
    clearTimeout(timers.get(name));
    timers.set(name, setTimeout(() => settle(name), 400));
  };

  // Wait until the file has stopped changing, so a half-written render isn't picked up.
  async function settle(name) {
    const f = path.join(dir, name);
    let a, z;
    try { a = fs.statSync(f); } catch {
      L.problems.delete(name);
      if (name === SHARED && L.board.sketchLib?.includes('/lib-folder-')) commit(L, [{ op: 'board.set', fields: { sketchLib: null } }], { author: 'sketches folder' });
      return;
    }
    await new Promise(r => setTimeout(r, 300));
    try { z = fs.statSync(f); } catch { return; }
    if (a.size !== z.size || a.mtimeMs !== z.mtimeMs || !z.size) return schedule(name);
    await sync(name, Math.round(z.mtimeMs));
  }

  async function sync(name, mtime) {
    if (busy.has(name)) return void again.add(name);
    busy.add(name);
    try {
      if (name === SHARED) return await syncShared();
      const sid = SKETCH_FILE.exec(name)?.[1];
      const s = findScene(L.board, sid);
      if (!s) throw new Error(`there is no scene ${sid} (scenes: ${L.board.scenes.map(x => x.id).join(', ') || 'none'})`);
      const file = path.join(dir, name);
      const existing = s.renders.find(r => r.source === file);
      if (existing && existing.sourceMtime === mtime) return L.problems.delete(name);
      const r = await makeSketch(store.dir(L.slug), { path: file }, L.board, { base: `${sid}-folder-${stamp()}`, at: placement(L.board, sid), lib: libSource(L.board, store.dir(L.slug)) });
      const media = { kind: r.kind, file: r.file, poster: r.poster ?? null, strip: r.strip ?? null, stripFrames: r.stripFrames ?? 0, duration: r.duration ?? null, width: r.width ?? null, height: r.height ?? null, drawn: r.drawn ?? null };
      if (existing) commit(L, [{ op: 'render.set', scene: s.id, id: existing.id, fields: { ...media, sourceMtime: mtime, updated: new Date().toISOString() } }], { author: 'sketches folder' });
      else commit(L, [{ op: 'render.add', scene: s.id, render: { ...r, ...media, sketch: true, source: file, sourceMtime: mtime, caption: name } }], { author: 'sketches folder' });
      L.problems.delete(name);
    } catch (e) {
      L.problems.set(name, { error: e.message, at: new Date().toISOString() });
      console.warn(`[${L.slug}] sketches/${name}: ${e.message}`);
    } finally {
      busy.delete(name);
      if (again.delete(name)) schedule(name);
    }
  }

  // _shared.js → a new library file, and the board points at it (unless it's unchanged).
  async function syncShared() {
    const code = fs.readFileSync(path.join(dir, SHARED), 'utf8');
    if (code === libSource(L.board, store.dir(L.slug))) return L.problems.delete(SHARED);
    checkSyntax(code, { lib: true });
    const file = `media/shared/lib-folder-${stamp()}.js`;
    fs.mkdirSync(path.join(store.dir(L.slug), 'media/shared'), { recursive: true });
    fs.writeFileSync(path.join(store.dir(L.slug), file), code);
    commit(L, [{ op: 'board.set', fields: { sketchLib: file } }], { author: 'sketches folder' });
    L.problems.delete(SHARED);
    // Code sketches that failed before the library arrived get another try.
    for (const name of [...L.problems.keys()]) if (/\.js$/i.test(name)) schedule(name);
  }

  const watcher = fs.watch(dir, (_, name) => { if (name && watched(name)) schedule(name); });
  watcher.on('error', () => {});
  for (const name of fs.readdirSync(dir)) if (watched(name)) schedule(name);
  return watcher;
}
