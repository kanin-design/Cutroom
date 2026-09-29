// Boards on disk. Each board is a folder:
//   boards/<slug>/board.json   the whole board, pretty-printed so it diffs and reads well
//   boards/<slug>/log.jsonl    one line per change: rev, author, time, sentences, ops
//   boards/<slug>/media/       renders (proxies, posters, filmstrips) and the soundtrack

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newBoard, totalDuration } from './ops.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = process.env.SB_HOME ? path.resolve(process.env.SB_HOME) : path.join(ROOT, 'boards');

export const dir = slug => path.join(HOME, safe(slug));
export const file = slug => path.join(dir(slug), 'board.json');
export const exists = slug => fs.existsSync(file(slug));

export function list() {
  if (!fs.existsSync(HOME)) return [];
  return fs
    .readdirSync(HOME, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(file(d.name)))
    .map(d => {
      const b = read(d.name);
      return { slug: d.name, title: b.title, rev: b.rev, scenes: b.scenes.length, duration: totalDuration(b), updated: fs.statSync(file(d.name)).mtimeMs };
    })
    .sort((a, b) => b.updated - a.updated);
}

export function create(slug, opts) {
  slug = safe(slug);
  if (exists(slug)) throw new Error(`board ${slug} already exists`);
  fs.mkdirSync(path.join(dir(slug), 'media'), { recursive: true });
  fs.mkdirSync(path.join(dir(slug), 'sketches'), { recursive: true });
  const b = newBoard(opts);
  write(slug, b);
  return { slug, board: b };
}

export function read(slug) {
  if (!exists(slug)) throw new Error(`no board "${slug}" (boards: ${list().map(b => b.slug).join(', ') || 'none'})`);
  return migrate(JSON.parse(fs.readFileSync(file(slug), 'utf8')));
}

// Older boards called a render's caption `note`, which read like a board note.
export function migrate(b) {
  for (const s of b.scenes || []) for (const r of s.renders || []) {
    if (r.caption == null) { r.caption = r.note || ''; delete r.note; }
    // Sketches used to be their own kind; now any medium can be a sketch.
    if (r.kind === 'sketch') { r.kind = 'image'; r.sketch = true; }
    r.sketch ??= false;
  }
  b.project ??= '';
  b.treatment ??= '';
  b.owner ??= '';
  // Before Send existed nothing actually delivered the user's notes, so their open ones start unsent
  // (they send them with the button); everything else counts as sent when it was written.
  for (const n of b.notes || []) if (n.sent === undefined) n.sent = n.author === 'you' && !n.resolved ? null : n.created;
  b.sketchLib ??= null;
  return b;
}

export function write(slug, board) {
  const text = JSON.stringify(board, null, 2) + '\n';
  const tmp = file(slug) + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file(slug));
  return text;
}

export function appendLog(slug, entry) {
  fs.appendFileSync(path.join(dir(slug), 'log.jsonl'), JSON.stringify(entry) + '\n');
}

export function readLog(slug, { since = 0, limit = 200 } = {}) {
  const f = path.join(dir(slug), 'log.jsonl');
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  return lines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e && e.rev > since)
    .slice(-limit);
}

export function slugify(title) {
  return (
    String(title)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 48) || 'board'
  );
}

export function uniqueSlug(title) {
  const base = slugify(title);
  let slug = base, i = 2;
  while (exists(slug)) slug = `${base}-${i++}`;
  return slug;
}

function safe(slug) {
  const s = String(slug);
  if (!/^[\w.-]+$/.test(s) || s.startsWith('.')) throw new Error(`bad board name "${s}"`);
  return s;
}
