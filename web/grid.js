// Board view: the classic storyboard wall. One panel per scene, in order, with its picture
// and sound written underneath. Drag panels to reorder; drop a file on a panel to give it a render.

import { S, on, commit, select, mediaUrl, upload } from './store.js';
import { activeRender, layout } from '/lib/ops.js';
import { $, h, secs } from './util.js';
import { icons } from './icons.js';
import { cardNode, STATUS_COLOR, versionLabel } from './viewer.js';
import { actions } from './actions.js';

const root = $('#gridView');
let dragId = null;

function render() {
  if (S.view !== 'board' || !S.board) return;
  const b = S.board;
  const ar = `${b.width} / ${b.height}`;
  const top = root.scrollTop;
  const cards = layout(b).map(({ scene: s, index }) => {
    const r = activeRender(s);
    const el = h('div.gcard', {
      class: S.sel.scene === s.id ? 'sel' : '', draggable: true, 'data-id': s.id,
      onclick: () => select(s.id),
      ondblclick: () => { select(s.id); setView('edit'); },
    },
      h('div.gframe', { style: { '--ar': ar } },
        r ? h('img', { src: mediaUrl(/\.svg$/i.test(r.file) ? r.file : r.poster || r.file), alt: '', loading: 'lazy' }) : cardNode(s, index),
        r && h('span.k', versionLabel(r)),
      ),
      h('div.gmeta',
        h('span.n', String(index + 1).padStart(2, '0')),
        h('span.t', s.title),
        h('i.sdot', { style: { '--sc': STATUS_COLOR[s.status] }, title: s.status }),
        h('span.d', secs(s.duration)),
      ),
      s.picture && h('div.gtext', s.picture),
      s.sound && h('div.gsound', { html: icons.sound }, h('span', s.sound)),
    );
    el.addEventListener('dragstart', e => {
      dragId = s.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/x-scene', s.id);
      requestAnimationFrame(() => el.classList.add('dragging'));
    });
    el.addEventListener('dragend', () => { dragId = null; el.classList.remove('dragging'); clearMarks(); });
    el.addEventListener('dragover', e => {
      e.preventDefault();
      clearMarks();
      if (dragId) {
        if (dragId === s.id) return;
        const rect = el.getBoundingClientRect();
        el.classList.add(e.clientX < rect.left + rect.width / 2 ? 'drag-over-before' : 'drag-over-after');
      } else el.querySelector('.gframe').classList.add('drop-target');
    });
    el.addEventListener('drop', async e => {
      e.preventDefault();
      const before = el.classList.contains('drag-over-before');
      clearMarks();
      if (dragId && dragId !== s.id) {
        const ids = b.scenes.map(x => x.id);
        const i = ids.indexOf(s.id);
        const target = before ? s.id : ids[i + 1] === dragId ? ids[i + 2] ?? null : ids[i + 1] ?? null;
        await commit([{ op: 'scene.move', id: dragId, before: target }]);
      } else if (e.dataTransfer.files.length) {
        for (const f of e.dataTransfer.files) await upload(f, { scene: s.id });
      }
    });
    return el;
  });
  root.replaceChildren(h('div.grid', cards));
  root.scrollTop = top;
}

function clearMarks() {
  for (const el of root.querySelectorAll('.drag-over-before, .drag-over-after')) el.classList.remove('drag-over-before', 'drag-over-after');
  for (const el of root.querySelectorAll('.drop-target')) el.classList.remove('drop-target');
}

export function setView(v) {
  S.view = v;
  $('#stage').hidden = v !== 'edit';
  root.hidden = v !== 'board';
  for (const b of document.querySelectorAll('#viewSeg button')) b.classList.toggle('on', b.dataset.view === v);
  try { localStorage.setItem('sb.view', v); } catch {}
  render();
  if (v === 'board') {
    const el = root.querySelector('.gcard.sel');
    el?.scrollIntoView({ block: 'nearest' });
  }
}

on('board', render);
on('select', render);
