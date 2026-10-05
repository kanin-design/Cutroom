// Full screen, two ways. The button in the top bar puts the whole editor on the screen, like an app;
// in Chrome, Esc then stays with the editor (hold it to leave full screen). Full-screen playback
// (⇧F, or the button under the picture) shows the picture alone, for watching the cut.

import { S, on, here } from './store.js';
import { $, h, tc, toast } from './util.js';
import { icons } from './icons.js';

const btn = $('#fullBtn');
const hud = h('div.cinema-hud');
let cinemaOwnsScreen = false, hudTimer = 0;

export const inCinema = () => document.body.classList.contains('cinema');
const isFull = () => !!document.fullscreenElement;

async function enterFull(keepEsc) {
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch (e) {
    toast(`Full screen isn't available here: ${e.message}`, { err: true });
    return false;
  }
  if (keepEsc) try { await navigator.keyboard?.lock?.(['Escape']); } catch {}
  return true;
}

async function toggleFullScreen() {
  if (isFull()) {
    cinemaOwnsScreen = false;
    return document.exitFullscreen().catch(() => {});
  }
  await enterFull(true);
}

// Playback on the whole screen. If the editor isn't full screen already, this makes it so, and
// leaving puts it back.
export async function setCinema(want) {
  if (want === inCinema() || (want && !S.board?.scenes.length)) return;
  document.body.classList.toggle('cinema', want);
  if (want) {
    $('#viewer').append(hud);
    renderHud();
    showHud();
    if (!isFull()) cinemaOwnsScreen = await enterFull(false);
  } else {
    hud.remove();
    clearTimeout(hudTimer);
    document.body.classList.remove('hud');
    if (cinemaOwnsScreen && isFull()) document.exitFullscreen().catch(() => {});
    cinemaOwnsScreen = false;
  }
}

// Where you are, shown while the mouse moves; the pointer hides when it's still.
function renderHud() {
  if (!inCinema() || !S.board?.scenes.length) return;
  const hit = here();
  hud.replaceChildren(
    h('span.n', String(hit.index + 1).padStart(2, '0')),
    h('b', hit.scene.title),
    h('span.hint', 'Esc to leave · double-click to mark up a frame'),
    h('span.ch-tc', tc(S.t, S.board.fps)),
  );
}
function showHud() {
  document.body.classList.add('hud');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => document.body.classList.remove('hud'), 1800);
}
addEventListener('pointermove', () => { if (inCinema()) showHud(); });
on('time', renderHud);

document.addEventListener('fullscreenchange', () => {
  const full = isFull();
  btn.innerHTML = full ? icons.shrink : icons.expand;
  btn.title = full ? 'Leave full screen' : 'Full screen: the editor fills the screen, like an app';
  if (full) return;
  navigator.keyboard?.unlock?.();
  if (inCinema()) {
    cinemaOwnsScreen = false;
    setCinema(false);
  }
});
btn.addEventListener('click', toggleFullScreen);
$('#tFull').addEventListener('click', () => setCinema(true));
