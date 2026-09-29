// Editing commands shared by the keyboard, menus and buttons.

import { S, emit, commit, select, here, sceneRange, upload, scene } from './store.js';
import { snapFrame, defaultDuration, layout } from '/lib/ops.js';
import { toast } from './util.js';
import { play, pause, seek } from './player.js';

export const actions = {
  play: () => play(),

  // where: {after: id} | {before: id} | {at: 'end'}; default is after the selection
  async addScene(where = {}) {
    if (!S.board) return;
    const pos = where.before ? { before: where.before } : where.after ? { after: where.after } : where.at === 'end' ? {} : S.sel.scene ? { after: S.sel.scene } : {};
    const j = await commit([{ op: 'scene.add', scene: { title: 'New scene', duration: defaultDuration(S.board) }, ...pos }]);
    if (!j) return;
    const id = j.ops[0].scene.id;
    S.tab = 'scene';
    select(id);
    emit('focus-title');
  },

  async duplicate(id = S.sel.scene) {
    const s = scene(id);
    if (!s) return;
    const copy = structuredClone(s);
    delete copy.id;
    copy.title = `${s.title} copy`;
    copy.renders = s.renders.map(({ id: _, ...r }) => r);
    const activeIdx = s.renders.findIndex(r => r.id === s.activeRender);
    const j = await commit([{ op: 'scene.add', scene: copy, after: s.id }]);
    if (!j) return;
    const added = j.ops[0].scene;
    if (activeIdx >= 0 && added.renders[activeIdx] && added.renders[activeIdx].id !== added.activeRender) {
      await commit([{ op: 'scene.set', id: added.id, fields: { activeRender: added.renders[activeIdx].id } }], { undoable: false });
    }
    select(added.id);
  },

  async split() {
    if (!S.board?.scenes.length) return;
    const hit = here();
    const at = snapFrame(S.board, hit.local);
    const s = hit.scene;
    if (at <= 0 || at >= s.duration - 1e-6) return toast('Put the playhead inside a scene to split it');
    const j = await commit([{ op: 'scene.split', id: s.id, at }]);
    if (j) select(j.ops[0].scene.id, { keepTime: true });
  },

  async remove(id = S.sel.scene) {
    const s = scene(id);
    if (!s) return;
    const rows = layout(S.board);
    const i = rows.findIndex(r => r.scene.id === id);
    const j = await commit([{ op: 'scene.remove', id }]);
    if (!j) return;
    const next = S.board.scenes[Math.min(i, S.board.scenes.length - 1)];
    S.sel = { scene: next?.id ?? null, note: null };
    emit('select');
    toast(`Deleted “${s.title}” — ⌘Z to undo`);
  },

  async setStatus(st, id = S.sel.scene) {
    if (scene(id)) await commit([{ op: 'scene.set', id, fields: { status: st } }]);
  },

  nextCut(dir) {
    if (!S.board?.scenes.length) return;
    const cuts = [0, ...layout(S.board).map(r => r.end)];
    const eps = 1e-6;
    const t = dir > 0 ? cuts.find(c => c > S.t + eps) : [...cuts].reverse().find(c => c < S.t - eps);
    if (t != null) {
      if (S.playing) pause();
      seek(Math.min(t, cuts.at(-1)));
    }
  },

  step(frames) {
    if (!S.board) return;
    if (S.playing) pause();
    seek(Math.round(S.t * S.board.fps + frames) / S.board.fps);
  },

  pickFile(target) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = !target.audio;
    input.accept = target.audio ? 'audio/*' : 'image/*,video/*,.svg,.js';
    input.onchange = async () => { for (const f of input.files) await upload(f, target); };
    input.click();
  },
};
