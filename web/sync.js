// The sync control, beside Mute: a listening aid for finding by ear how far something in the picture should move
// to sit on the sound (words lighting up with the lyrics, a cut on a hit). Nudge the soundtrack later or earlier
// until it feels right, read the amount, tell Claude, reset. It lives in this browser only: never saved on the
// board, never sent, and back to 0 for every board you open.

import { S, on } from './store.js';
import { $, h, menu, closeMenu } from './util.js';
import { setAudioOffset } from './player.js';

const btn = $('#tSync');
const ms = v => Math.round(v * 1000);

// What the offset means for the picture: the sound later by x feels right, so the picture should be x earlier.
const meaning = v => !v ? 'The sound plays as it is.'
  : `The sound plays ${Math.abs(ms(v))} ms ${v > 0 ? 'later' : 'earlier'}. If it feels right now, what should hit it in the picture belongs ${Math.abs(ms(v))} ms ${v > 0 ? 'earlier' : 'later'}.`;

function label() {
  const v = S.audioOffset || 0;
  btn.textContent = v ? `${v > 0 ? '+' : '−'}${Math.abs(ms(v))} ms` : 'Sync';
  btn.classList.toggle('on', !!v);
  btn.title = v ? `${meaning(v)} Click to adjust or reset.` : 'Sync: play the sound a little later or earlier than the picture, to find by ear how far something should move (this browser only, never saved)';
}

function card() {
  const v = S.audioOffset || 0, frame = 1 / (S.board?.fps || 30);
  const nudge = (d, text) => h('button', { onclick: () => setAudioOffset((S.audioOffset || 0) + d) }, text);
  return h('div.menu.sync-card', { onpointerdown: e => e.stopPropagation() },
    h('div.mhead', 'Sound against the picture'),
    h('div.sync-value', { class: v ? 'on' : '' }, v ? `${v > 0 ? '+' : '−'}${Math.abs(ms(v))} ms` : '0 ms'),
    h('div.sync-means', meaning(v)),
    h('div.sync-row', nudge(-frame, '−1 frame'), nudge(-0.01, '−10 ms'), nudge(0.01, '+10 ms'), nudge(frame, '+1 frame')),
    h('div.sync-row',
      h('input.sync-in', { type: 'number', step: 5, value: ms(v), 'aria-label': 'Offset in milliseconds', onchange: e => setAudioOffset(+e.target.value / 1000) }),
      h('span.sync-unit', 'ms'),
      h('button.sync-reset', { disabled: !v, onclick: () => setAudioOffset(0) }, 'Reset')),
    h('div.sync-hint', '+ plays the sound later, − earlier. Only here, for listening: nothing is saved or sent.'),
  );
}

let open = null, wasOpen = false;
function show() {
  const r = btn.getBoundingClientRect();
  open = menu(r.left, r.bottom + 6, null, { el: card() });
}
// Any press outside an open menu closes it before the click lands; a press on this button that closed the card
// must not open it again (the button toggles it).
addEventListener('pointerdown', e => {
  wasOpen = !!open && e.target.closest?.('#tSync') && !open.isConnected;
  if (open && !open.isConnected) open = null;
}, true);
btn.addEventListener('click', () => { if (wasOpen) { wasOpen = false; return; } if (open?.isConnected) { closeMenu(); open = null; } else show(); });
on('offset', () => {
  label();
  // the card stays open while you nudge: its contents drawn again in place
  if (open?.isConnected) open.replaceChildren(...card().childNodes);
});
label();
