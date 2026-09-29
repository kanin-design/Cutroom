// The code-sketch runtime, as source text. The editor's sandboxed runner and the server's headless
// Chrome captures both run exactly this, so what an agent sees is what the user sees.
//
//   compileSketch(code, canvas, lib) → draw   the board's shared library (if any) runs first, in an
//                                               outer scope the sketch can see (and shadow)
//   sketchInfo(w, h, t, m) → s                 everything draw(t, s) is told about the moment

export const RUNNER = `
function compileSketch(code, canvas, lib) {
  // The library runs in an outer scope and the sketch inside it: the sketch sees the library's names,
  // may redeclare (shadow) any of them, and falls back to the library's draw if it has none.
  const inner = 'return function (canvas) {\\n' + code + '\\n;return typeof draw === "function" ? draw : null;\\n};';
  const draw = new Function('canvas', (lib || '') + '\\n;' + inner)(canvas)(canvas);
  if (!draw) throw new Error('the code must define function draw(t, s) (or the shared library must)');
  return draw;
}
function sketchInfo(w, h, t, m) {
  const start = m.start || 0, filmT = start + t, per = m.beatsPerBar || 4, off = m.beatOffset || 0;
  const beat = m.bpm ? (t * m.bpm) / 60 : null;
  const filmBeat = m.bpm ? ((filmT - off) * m.bpm) / 60 : null;
  return {
    w, h, t, duration: m.duration, progress: m.duration ? Math.min(1, t / m.duration) : 0,
    start, filmT, filmDuration: m.filmDuration || null, scene: m.scene || null, index: m.index ?? null,
    fps: m.fps, frame: Math.round(t * m.fps), filmFrame: Math.round(filmT * m.fps),
    bpm: m.bpm || null, beatsPerBar: per,
    beat, bar: beat == null ? null : Math.floor(beat / per) + 1,
    filmBeat, filmBar: filmBeat == null ? null : Math.floor(filmBeat / per) + 1,
  };
}`;
