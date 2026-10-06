// Hover cards: a quiet card that says more about something small (a light, say) when the pointer rests
// on it. An element gets one with data-tip (its words), or with a `card` function and the has-card class
// (built fresh each time it opens, so it's current). It opens after a short pause, stays while the
// pointer is on the element or the card (so a button in it can be pressed), and sits under the element,
// or over it when there's no room below.

import { h, clamp } from './util.js';

let cur = null; // { el, card }
let showTimer = 0, hideTimer = 0;
const owner = node => node?.closest?.('[data-tip], .has-card');
const body = el => (el.card ? el.card() : h('div.tip-text', el.dataset.tip));

function place({ el, card }) {
  const r = el.getBoundingClientRect(), c = card.getBoundingClientRect();
  const below = r.bottom + 8, above = r.top - 8 - c.height;
  card.style.top = `${below + c.height > innerHeight - 8 && above > 8 ? above : below}px`;
  card.style.left = `${clamp(r.left + r.width / 2 - c.width / 2, 8, innerWidth - c.width - 8)}px`;
}

function show(el) {
  hide();
  if (!el.isConnected) return;
  const content = body(el);
  if (!content) return;
  cur = { el, card: h('div.tipcard', { role: 'tooltip', class: el.card ? 'rich' : '' }, content) };
  document.body.append(cur.card);
  place(cur);
}

export function hide() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  cur?.card.remove();
  cur = null;
}

// The open card again, if it belongs to `el` (or to anything, without one): what it shows has changed. With
// nothing left to show, it closes.
export function refreshTip(el = null) {
  if (!cur || (el && cur.el !== el)) return;
  if (!cur.el.isConnected) return hide();
  const content = body(cur.el);
  if (!content) return hide();
  cur.card.replaceChildren(...[content].flat(Infinity).filter(Boolean));
  place(cur);
}

addEventListener('pointerover', e => {
  if (cur && !cur.el.isConnected) hide();
  if (cur?.card.contains(e.target)) return clearTimeout(hideTimer);
  const el = owner(e.target);
  if (!el) return;
  clearTimeout(hideTimer);
  if (cur?.el === el) return;
  clearTimeout(showTimer);
  showTimer = setTimeout(() => show(el), cur ? 60 : 280); // moving between tips: no second wait
});
addEventListener('pointerout', e => {
  const to = e.relatedTarget;
  if (cur && (cur.el.contains(to) || cur.card.contains(to))) return;
  if (owner(e.target)?.contains(to)) return;
  clearTimeout(showTimer);
  if (cur) hideTimer = setTimeout(hide, 200);
});
addEventListener('pointerdown', e => { if (cur && !cur.card.contains(e.target) && !cur.el.contains(e.target)) hide(); }, true);
addEventListener('scroll', hide, true);
addEventListener('keydown', e => { if (e.key === 'Escape' && cur) hide(); });
