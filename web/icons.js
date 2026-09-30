// 16px line icons, drawn on a 16 grid with 1.5 strokes.
const I = (d, extra = '') => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;

export const icons = {
  play: `<svg viewBox="0 0 16 16"><path d="M4.5 2.8v10.4c0 .6.6.9 1.1.6l8.2-5.2a.7.7 0 0 0 0-1.2L5.6 2.2c-.5-.3-1.1 0-1.1.6Z" fill="currentColor"/></svg>`,
  pause: `<svg viewBox="0 0 16 16"><rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/></svg>`,
  toStart: I('<path d="M3.5 3v10"/><path d="m12.5 3.5-6 4.5 6 4.5z" fill="currentColor"/>'),
  prev: I('<path d="M10 3.5 5.5 8l4.5 4.5"/>'),
  next: I('<path d="m6 3.5 4.5 4.5L6 12.5"/>'),
  loop: I('<path d="M11 2.5 13 4.5 11 6.5"/><path d="M3 8V7a2.5 2.5 0 0 1 2.5-2.5H13"/><path d="M5 13.5 3 11.5 5 9.5"/><path d="M13 8v1a2.5 2.5 0 0 1-2.5 2.5H3"/>'),
  pin: I('<path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 9.8 8 14 8 14Z"/><circle cx="8" cy="6.5" r="1.5"/>'),
  volume: I('<path d="M2.5 6v4h2.5l3.5 3V3L5 6z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5"/><path d="M12.8 3.5a6.2 6.2 0 0 1 0 9"/>'),
  mute: I('<path d="M2.5 6v4h2.5l3.5 3V3L5 6z"/><path d="m11 6 3.5 4M14.5 6 11 10"/>'),
  plus: I('<path d="M8 3v10M3 8h10"/>'),
  minus: I('<path d="M3 8h10"/>'),
  fit: I('<path d="M2.5 5.5v-3h3M13.5 5.5v-3h-3M2.5 10.5v3h3M13.5 10.5v3h-3"/>'),
  split: I('<circle cx="4.5" cy="4.5" r="2"/><circle cx="4.5" cy="11.5" r="2"/><path d="M6.2 5.6 13.5 12M6.2 10.4 13.5 4"/>'),
  magnet: I('<path d="M3.5 2.5v5a4.5 4.5 0 0 0 9 0v-5"/><path d="M3.5 5h3M9.5 5h3"/><path d="M6.5 2.5v5a1.5 1.5 0 0 0 3 0v-5"/>'),
  chevron: I('<path d="m4 6 4 4 4-4"/>'),
  film: I('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 3v10M11 3v10M2 6h3M2 10h3M11 6h3M11 10h3"/>'),
  image: I('<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="m2.5 12 3.5-3.5 2.5 2.5 2-2 3 3"/>'),
  note: I('<path d="M3 3.5h10v7H8l-3 2.5v-2.5H3z"/>'),
  wave: I('<path d="M2 8h1M4.5 5.5v5M7 3v10M9.5 5v6M12 6.5v3M14 8h0"/>'),
  sound: I('<path d="M6 12.5V3.5l7-1.5v9"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="11" r="1.5"/>'),
  edit: I('<path d="M10.5 3.5 12.5 5.5 6 12H4v-2z"/><path d="M9.5 4.5 11.5 6.5"/>'),
  trash: I('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
  check: I('<path d="m3.5 8.5 3 3 6-7"/>', 'stroke-width="2.2"'),
  x: I('<path d="m4 4 8 8M12 4l-8 8"/>'),
  clip: I('<path d="M13 7.5 8.2 12.3a3.2 3.2 0 0 1-4.5-4.5l5-5a2.1 2.1 0 0 1 3 3l-5 5a1.1 1.1 0 0 1-1.5-1.5L9.6 4.9"/>'),
  archive: I('<rect x="2" y="3" width="12" height="3" rx="1"/><path d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 8.5h3"/>'),
  unarchive: I('<rect x="2" y="3" width="12" height="3" rx="1"/><path d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M8 12V8.5M6.3 10.2 8 8.5l1.7 1.7"/>'),
  file: I('<path d="M9 2.5H4.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6z"/><path d="M9 2.5V6h3.5"/>'),
  more: `<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.25" fill="currentColor"/><circle cx="8" cy="8" r="1.25" fill="currentColor"/><circle cx="12.5" cy="8" r="1.25" fill="currentColor"/></svg>`,
  copy: I('<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M11 5V3.5A1 1 0 0 0 10 2.5H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5"/>'),
  keyboard: I('<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6"/>'),
  reply: I('<path d="M6.5 4 3 7.5 6.5 11"/><path d="M3 7.5h6.5a4 4 0 0 1 4 4v1"/>'),
  play2: I('<path d="M5 3.5v9l7-4.5z"/>'),
  insertL: I('<path d="M6 3v10"/><rect x="8.5" y="4.5" width="5" height="7" rx="1"/><path d="M2 8h2"/>'),
  insertR: I('<path d="M10 3v10"/><rect x="2.5" y="4.5" width="5" height="7" rx="1"/><path d="M12 8h2"/>'),
  flag: I('<path d="M3.5 14V2.5M3.5 3h8l-1.5 3 1.5 3h-8"/>'),
  upload: I('<path d="M8 10.5V2.5M4.5 6 8 2.5 11.5 6"/><path d="M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/>'),
  spark: `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 .8c.4 0 .7.3.7.7l.3 4.2 3-3a.7.7 0 0 1 1 1l-3 3 4.2.3a.7.7 0 0 1 0 1.4L10 8.7l3 3a.7.7 0 1 1-1 1l-3-3-.3 4.2a.7.7 0 0 1-1.4 0L7 9.7l-3 3a.7.7 0 1 1-1-1l3-3-4.2-.3a.7.7 0 0 1 0-1.4L6 6.7l-3-3a.7.7 0 0 1 1-1l3 3 .3-4.2c0-.4.3-.7.7-.7Z"/></svg>`,
};

export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.dataset.hydrated) continue;
    el.insertAdjacentHTML('afterbegin', icons[el.dataset.icon] || '');
    el.dataset.hydrated = '1';
  }
}
