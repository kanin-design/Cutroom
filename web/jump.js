// ← →, like a media player. Stopped: one frame (⇧ ten), to go through a shot frame by frame. Playing (full screen
// too): jump a second (⇧ ten) and play on; held, the jumps grow, and the picture says how far you've gone.

import { S } from './store.js';
import { $, h } from './util.js';
import { seek } from './player.js';
import { actions } from './actions.js';

const EVERY = 150; // ms between jumps while the key is held (the key repeats faster)
// how far one jump goes, in seconds, by how long the key has been held
const grow = held => (held < 0.6 ? 1 : held < 1.5 ? 2 : held < 3 ? 3 : 5);

const flash = h('div.jump-flash');
$('#viewer').append(flash);
let hold = null, fade = 0;

export function arrow(e, dir) {
  if (!S.playing) {
    // a held jump that ran the film to its end: the key still down mustn't turn into frame steps
    if (e.repeat && hold) return;
    hold = null;
    return actions.step(dir * (e.shiftKey ? 10 : 1));
  }
  const now = performance.now();
  if (!e.repeat || hold?.dir !== dir) hold = { dir, at: now, total: 0, last: 0 };
  else if (now - hold.last < EVERY) return;
  const s = (e.shiftKey ? 10 : 1) * grow((now - hold.at) / 1000);
  hold.last = now;
  hold.total += s;
  seek(S.t + dir * s);
  flash.textContent = `${dir > 0 ? '»' : '«'} ${hold.total} s`;
  flash.classList.add('on');
  clearTimeout(fade);
  fade = setTimeout(() => flash.classList.remove('on'), 700);
}

addEventListener('keyup', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') hold = null; });
