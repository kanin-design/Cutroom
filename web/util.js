import { icons } from './icons.js';

export const $ = (s, r = document) => r.querySelector(s);
export const clamp = (x, a, z) => Math.min(z, Math.max(a, x));

// h('div.cls#id', {attrs, onclick, style}, ...children)
export function h(sel, attrs, ...kids) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs != null) kids.unshift(attrs);
    attrs = {};
  }
  const [, tag = 'div', rest = ''] = /^([a-z0-9]*)(.*)$/i.exec(sel);
  const el = document.createElement(tag || 'div');
  for (const m of rest.matchAll(/([.#])([\w-]+)/g)) m[1] === '.' ? el.classList.add(m[2]) : (el.id = m[2]);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') for (const [p, x] of Object.entries(v)) p.startsWith('--') ? el.style.setProperty(p, x) : (el.style[p] = x);
    else if (k === 'class') el.className += ' ' + v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'icon') el.insertAdjacentHTML('afterbegin', icons[v] || '');
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}

const icon = name => h('span', { html: icons[name] || '', style: { display: 'inline-grid' } });

// 00:01:11:15, as editors write it (hours:minutes:seconds:frames)
export { timecode as tc } from '/lib/ops.js';

export const secs = t => `${+(+t).toFixed(t < 10 ? 2 : 1)}s`;
// An author as the editor shows them: "You", "Claude".
export const authorName = a => a[0].toUpperCase() + a.slice(1);

export function ago(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function debounce(fn, ms) {
  let t;
  const f = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  f.flush = (...a) => { clearTimeout(t); fn(...a); };
  f.cancel = () => clearTimeout(t);
  return f;
}

export function autosize(ta) {
  const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
  ta.addEventListener('input', fit);
  requestAnimationFrame(fit);
  return fit;
}

export const typing = e => {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) && t.type !== 'range';
};

// ---------------------------------------------------------------- toasts, menus, popovers

export function toast(msg, { err = false, spin = false, ms = 2600, onclick = null } = {}) {
  const el = h('div.toast', { class: `${err ? 'err' : ''} ${onclick ? 'clickable' : ''}`, onclick: onclick ? () => { onclick(); el.remove(); } : null }, spin && h('span.spin'), msg);
  document.getElementById('toasts').append(el);
  const done = () => { el.style.transition = 'opacity .25s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 260); };
  if (!spin) setTimeout(done, ms);
  return { done, set: m => { el.lastChild.textContent = m; } };
}

let openMenu = null;
export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

// items: [{label, icon, key, danger, onclick} | '-' | {head}]
export function menu(x, y, items, { cls = '', el: custom } = {}) {
  closeMenu();
  const el = custom || h('div.menu', { class: cls }, items.map(it => {
    if (it === '-') return h('hr');
    if (it.head) return h('div.mhead', it.head);
    if (it.node) return it.node;
    return h('button', { class: `${it.danger ? 'danger' : ''} ${it.cls || ''}`, onclick: () => { closeMenu(); it.onclick?.(); } },
      it.dot ? h('i.sd', { style: { '--sc': it.dot } }) : it.icon ? icon(it.icon) : h('span', { style: { width: '14px' } }),
      it.label, it.key && h('span.k', it.key), it.meta && h('span.bmeta', it.meta));
  }));
  document.getElementById('overlays').append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  el.style.top = (y + r.height > innerHeight - 8 ? Math.max(8, y - r.height) : y) + 'px';
  openMenu = el;
  return el;
}
addEventListener('pointerdown', e => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
addEventListener('keydown', e => { if (e.key === 'Escape' && openMenu) { closeMenu(); e.stopPropagation(); } }, true);

// A small text prompt anchored at x,y. Resolves to the text or null.
export function ask(x, y, { value = '', placeholder = '', ok = 'Save', multiline = false } = {}) {
  return new Promise(resolve => {
    const input = multiline ? h('textarea.field', { placeholder, rows: 3 }) : h('input.field', { placeholder });
    input.value = value;
    const finish = v => { closeMenu(); resolve(v); };
    const el = h('div.pop', input, h('div.row', h('button.text-btn', { onclick: () => finish(null) }, 'Cancel'), h('button.text-btn.primary', { onclick: () => finish(input.value.trim() || null) }, ok)));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (!multiline || e.metaKey || !e.shiftKey)) { e.preventDefault(); finish(input.value.trim() || null); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
      e.stopPropagation();
    });
    menu(x, y, [], { el });
    const mo = new MutationObserver(() => { if (!el.isConnected) { mo.disconnect(); resolve(null); } });
    mo.observe(document.getElementById('overlays'), { childList: true });
    input.focus();
    input.select();
  });
}

export function modal(content) {
  const back = h('div.modal-back', h('div.modal', content));
  const close = () => { back.remove(); removeEventListener('keydown', key, true); };
  const key = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  back.addEventListener('pointerdown', e => { if (e.target === back) close(); });
  addEventListener('keydown', key, true);
  document.body.append(back);
  return close;
}
