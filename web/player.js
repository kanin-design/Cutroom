// The clock. While playing, the soundtrack is the master clock when there is one (so picture
// sits on the music); otherwise the wall clock is. Everything else follows S.t via 'time' events.

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

function syncAudio() {
  if (!audioSrc) return;
  audio.muted = S.muted;
  if (S.playing && audioLive() && !audioBlocked) {
    if (Math.abs(audio.currentTime - S.t) > 0.03) audio.currentTime = S.t;
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
  if (S.t >= b - 1 / S.board.fps || S.t < a) S.t = a;
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
  audio.pause();
  cancelAnimationFrame(raf);
  document.body.classList.remove('playing');
  S.t = Math.round(S.t * S.board.fps) / S.board.fps;
  emit('play');
  emit('time');
}

export const toggle = () => (S.playing ? pause() : play());

export function setMuted(m) {
  S.muted = m;
  audio.muted = m;
  emit('mute');
}

function tick() {
  if (!S.playing) return;
  const now = performance.now();
  let t;
  if (audioRunning && !audio.paused && audioLive()) {
    t = audio.currentTime;
    wallStart = now;
    tStart = t;
  } else t = tStart + (now - wallStart) / 1000;
  const [a, b] = range();
  if (t >= b) {
    if (S.loop) {
      S.t = a;
      wallStart = now;
      tStart = a;
      syncAudio();
    } else {
      S.t = b;
      return pause();
    }
  } else {
    S.t = t;
    if (audioLive() && audio.paused && !audioBlocked) syncAudio();
  }
  emit('time');
  raf = requestAnimationFrame(tick);
}
