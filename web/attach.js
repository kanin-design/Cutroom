// Files on notes and replies: references the user attaches while writing ("like this", "check this
// clip"). A file is picked, dropped or pasted, uploaded at once, and shown as a chip until the note
// is added. Pending files live here by key, so they survive the panels re-rendering.

import { S, mediaUrl } from './store.js';
import { h, toast, modal } from './util.js';
import { icons } from './icons.js';

const pending = new Map(); // key -> [{ name, promise, file? }]

export const pendingFiles = key => pending.get(key) || [];

// The uploaded files for a key, waiting for any still on their way. Clears the key.
export async function takeFiles(key) {
  const list = pendingFiles(key);
  pending.delete(key);
  const done = await Promise.all(list.map(p => p.promise));
  return done.filter(Boolean);
}

export function addFiles(key, files, onchange) {
  const list = pending.get(key) || [];
  for (const f of files) {
    const item = { name: f.name || 'pasted image.png', file: null };
    item.promise = upload(f, item.name).then(a => { item.file = a; onchange?.(); return a; }, e => {
      toast(`Couldn't attach ${item.name}: ${e.message}`, { err: true, ms: 5000 });
      pending.set(key, (pending.get(key) || []).filter(x => x !== item));
      onchange?.();
      return null;
    });
    list.push(item);
  }
  pending.set(key, list);
  onchange?.();
}

// Any blob into the board's media/refs (the annotator saves its pictures this way).
export const uploadFile = (blob, name) => upload(blob, name);

async function upload(file, name) {
  const r = await fetch(`/api/boards/${encodeURIComponent(S.slug)}/attach?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'x-storyboard': '1' }, body: file });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j.file;
}

// The chips for a key's pending files, each removable.
export function chips(key, onchange) {
  const list = pendingFiles(key);
  if (!list.length) return null;
  return h('div.att-pending', list.map(item => h('span.att-chip', { class: item.file ? '' : 'loading', title: item.name },
    item.file ? thumb(item.file, 'sm') : h('span.spin'),
    h('span.nm', item.name),
    h('button', { title: 'Remove', html: icons.x, onclick: e => { e.stopPropagation(); pending.set(key, pendingFiles(key).filter(x => x !== item)); onchange?.(); } }),
  )));
}

// The paperclip, and dropping or pasting files onto `zone` / into `field`.
export function wire(key, { button, zone, field, onchange }) {
  if (button) button.addEventListener('click', () => {
    const input = h('input', { type: 'file', multiple: true });
    input.addEventListener('change', () => addFiles(key, [...input.files], onchange));
    input.click();
  });
  if (zone) {
    zone.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.stopPropagation(); zone.classList.add('att-over'); } });
    zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('att-over'); });
    zone.addEventListener('drop', e => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('att-over');
      addFiles(key, [...e.dataTransfer.files], onchange);
    });
  }
  if (field) field.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    // Text copied along with a picture still pastes as text; a bare picture only attaches.
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    addFiles(key, files, onchange);
  });
}

// ---------------------------------------------------------------- showing attached files

const pictured = f => (f.kind === 'image' ? f.file : f.poster);

function thumb(f, size = '') {
  const src = pictured(f);
  if (src) return h('span.att-thumb', { class: size, style: { backgroundImage: `url("${mediaUrl(src)}")` } }, f.kind === 'video' && h('i', { html: icons.play }));
  return h('span.att-thumb.file', { class: size, html: icons.file });
}

// The files on a note or reply: pictures as thumbnails, anything else as a named chip. Click to open.
export function fileRow(files) {
  if (!files?.length) return null;
  return h('div.att-row', files.map(f => {
    const open = e => { e.stopPropagation(); view(f); };
    return pictured(f)
      ? h('button.att-pic', { title: f.name, onclick: open }, thumb(f))
      : h('button.att-file', { title: f.name, onclick: open }, h('span', { html: icons.file }), h('span.nm', f.name));
  }));
}

// Stills and clips open over the page; anything else in a new tab.
function view(f) {
  const url = mediaUrl(f.file);
  if (f.kind !== 'image' && f.kind !== 'video') return window.open(url, '_blank', 'noopener');
  const media = f.kind === 'image' ? h('img', { src: url, alt: f.name }) : h('video', { src: url, controls: true, autoplay: true, loop: true });
  const close = modal([h('div.att-view', media, h('div.att-cap', h('span', f.name), h('a', { href: url, target: '_blank', rel: 'noopener', onclick: () => close() }, 'Open in a new tab')))]);
  document.querySelector('.modal-back:last-of-type .modal')?.classList.add('bare');
}
