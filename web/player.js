// The clock. While playing, the soundtrack is the master clock when there is one (so picture
// sits on the music); otherwise the wall clock is. Everything else follows S.t via 'time' events.
// S.rate is the speed: 1 normally, and 2, 4, 8 or backwards while shuttling with J and L.

import { S, on, emit, total, mediaUrl, sceneRange } from './store.js';
import { clamp } from './util.js';

const audio = new Audio();
audio.preload = 'auto';
let raf = 0, wallStart = 0, tStart = 0, audioSrc = null;
// The soundtrack only drives the clock while it is really advancing; if the browser blocks it
// or it stalls, the wall clock carries on and the audio catches up when it runs again.
let audioRunning = false, audioBlocked = false;
audio.addEventListener('playing', () => {
  audioRunning = true;
  if (S.playing && Math.abs(audio.currentTime - S.t) > 0.05) audio.currentTime = S.t;
});
for (const e of ['pause', 'waiting', 'ended', 'emptied']) audio.addEventListener(e, () => { audioRunning = false; });

on('board', () => {
  const src = S.board?.audio ? mediaUrl(S.board.audio.file) : null;
  if (src !== audioSrc) {
    audioSrc = src;
    audio.pause();
    if (src) audio.src = src;
    else audio.removeAttribute('src');
    if (S.playing) syncAudio();
  }
  // the film got shorter (a scene removed or trimmed): keep the playhead inside it
  if (S.board && !S.playing && S.t > end()) seek(end());
});
on('seek', t => seek(t));

export const end = () => {
  const d = total();
  return d > 0 ? d : S.board?.audio?.duration || 0;
};

function range() {
  if (S.loop && S.sel.scene) {
    const r = sceneRange(S.sel.scene);
    if (r.end > r.start) return [r.start, r.end];
  }
  return [0, end()];
}

const audioLive = () => audioSrc && S.board.audio && S.t < (S.board.audio.duration || 0) - 0.02;
// The soundtrack plays along forwards up to 4×; faster, or backwards, it is silent.
const audioRate = () => (S.rate > 0 && S.rate <= 4 ? S.rate : 0);

function syncAudio() {
  if (!audioSrc) return;
  audio.muted = S.muted;
  const r = audioRate();
  if (S.playing && r && audioLive() && !audioBlocked) {
    if (audio.playbackRate !== r) audio.playbackRate = r;
    if (Math.abs(audio.currentTime - S.t) > 0.03 * r) audio.currentTime = S.t;
    if (audio.paused) audio.play().catch(() => { audioBlocked = true; });
  } else if (!audio.paused) audio.pause();
}

export function seek(t) {
  const [a, b] = S.playing ? range() : [0, end()];
  S.t = clamp(t, S.playing ? a : 0, Math.max(b, 0));
  if (S.playing) {
    wallStart = performance.now();
    tStart = S.t;
    syncAudio();
  }
  emit('time');
}

export function play() {
  if (!S.board || end() <= 0) return;
  const [a, b] = range();
  if (S.rate < 0) {
    // backwards from the start: round to the end when looping, otherwise there's nothing to play
    if (S.t <= a + 0.5 / S.board.fps || S.t > b) {
      if (!S.loop) { S.rate = 1; return emit('rate'); }
      S.t = b;
    }
  } else if (S.t >= b - 1 / S.board.fps || S.t < a) S.t = a;
  S.playing = true;
  audioBlocked = false;
  wallStart = performance.now();
  tStart = S.t;
  syncAudio();
  document.body.classList.add('playing');
  emit('play');
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

export function pause() {
  S.playing = false;
  S.rate = 1;
  audio.pause();
  cancelAnimationFrame(raf);
  document.body.classList.remove('playing');
  S.t = Math.round(S.t * S.board.fps) / S.board.fps;
  emit('play');
  emit('rate');
  emit('time');
}

export const toggle = () => (S.playing ? pause() : play());

// J and L: play backwards or forwards. Pressing the same one again doubles the speed (up to 8×);
// the other one turns round at normal speed. K (or Space) stops.
export function shuttle(dir) {
  if (!S.board || end() <= 0) return;
  if (!S.playing) {
    S.rate = dir;
    play();
  } else {
    S.rate = Math.sign(S.rate) === dir ? clamp(S.rate * 2, -8, 8) : dir;
    wallStart = performance.now();
    tStart = S.t;
    syncAudio();
  }
  emit('rate');
}

export function setMuted(m) {
  S.muted = m;
  audio.muted = m;
  emit('mute');
}

function tick() {
  if (!S.playing) return;
  const now = performance.now();
  let t;
  if (audioRate() && audioRunning && !audio.paused && audioLive()) {
    t = audio.currentTime;
    wallStart = now;
    tStart = t;
  } else t = tStart + ((now - wallStart) / 1000) * S.rate;
  const [a, b] = range();
  if (S.rate > 0 ? t >= b : t <= a) {
    if (S.loop) {
      S.t = S.rate > 0 ? a : b;
      wallStart = now;
      tStart = S.t;
      syncAudio();
    } else {
      S.t = S.rate > 0 ? b : a;
      return pause();
    }
  } else {
    S.t = t;
    if (audioRate() && audioLive() && audio.paused && !audioBlocked) syncAudio();
  }
  emit('time');
  raf = requestAnimationFrame(tick);
}
