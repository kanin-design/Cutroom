// The right-hand panel: the selected scene (or the board when nothing is selected), every
// note thread, and the activity feed. It re-renders on every change; typing survives because
// every field has a key, drafts live in `drafts`, and focus and caret are put back afterwards.

import { S, on, emit, commit, select, scene, mediaUrl, sceneRange, upload, here, activeSay } from './store.js';
import { STATUSES, COLORS, activeRender, layout, noteTime, findScene } from '/lib/ops.js';
import { $, h, secs, short, ago, debounce, autosize, toast, menu, closeMenu, ask, tc as tcFmt } from './util.js';
import { icons } from './icons.js';
import { seek } from './player.js';
import { STATUS_COLOR, sceneColor } from './viewer.js';
import { actions } from './actions.js';
import { wire, chips, takeFiles, pendingFiles, fileRow } from './attach.js';

const panel = $('#panel'), tabs = $('#tabs'), notesCount = $('#notesCount');
const drafts = new Map();
let noteFilter = 'open';
let focusSession = 0;
let restoring = false;

tabs.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  S.tab = b.dataset.tab;
  render();
});

// ---------------------------------------------------------------- field binding

// A text field that commits (debounced) as you type, merged into one undo step per focus.
function bound(key, value, save, { tag = 'input', cls = '', placeholder = '', type = 'text', onEnter } = {}) {
  const el = h(`${tag}.field`, { class: cls, placeholder, 'data-key': key, spellcheck: tag === 'textarea' });
  if (tag === 'input') el.type = type;
  el.value = drafts.has(key) ? drafts.get(key) : value ?? '';
  if (drafts.get(key) === String(value ?? '')) drafts.delete(key);
  const push = debounce(v => save(v, `${key}#${focusSession}`), 450);
  el.addEventListener('focus', () => { if (!restoring) focusSession++; });
  el.addEventListener('input', () => { drafts.set(key, el.value); push(el.value); });
  el.addEventListener('blur', () => { if (drafts.has(key)) push.flush(el.value); });
  el.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') el.blur();
    if (e.key === 'Enter' && tag === 'input') { e.preventDefault(); onEnter?.(); el.blur(); }
  });
  if (tag === 'textarea') autosize(el);
  return el;
}

// Long prose an agent often writes in markdown (the brief, the treatment): shown formatted, edited
// as text. Click it to edit; leaving the field shows it formatted again.
const editing = new Set();
function prose(key, value, save, placeholder) {
  if (editing.has(key) || !String(value || '').trim()) {
    const ta = bound(key, value, save, { tag: 'textarea', placeholder });
    ta.addEventListener('blur', () => { if (editing.delete(key)) requestAnimationFrame(render); });
    if (editing.has(key)) requestAnimationFrame(() => { if (!restoring && document.activeElement !== ta) ta.focus(); });
    return ta;
  }
  return h('div.md', { title: 'Click to edit', html: markdown(value), onclick: e => { if (e.target.closest('a')) return; editing.add(key); render(); } });
}

// Just enough markdown for a treatment: headings, lists, bold, italics, code and links. Escaped first.
function markdown(src) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|\W)_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null, para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
    if (list) { out.push(`</${list}>`); list = null; }
  };
  for (const line of String(src).split('\n')) {
    const hd = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (hd) { flush(); out.push(`<h${Math.min(4, hd[1].length + 2)}>${inline(hd[2])}</h${Math.min(4, hd[1].length + 2)}>`); }
    else if (li) {
      if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; }
      const kind = li[1] ? 'ol' : 'ul';
      if (list !== kind) { if (list) out.push(`</${list}>`); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(li[2])}</li>`);
    } else if (!line.trim()) flush();
    else { if (list) { out.push(`</${list}>`); list = null; } para.push(line); }
  }
  flush();
  return out.join('');
}

// A free text box (a reply) whose draft and attached files survive re-renders.
function draftBox(key, placeholder, submit, { rows = 1, label = 'Send' } = {}) {
  const ta = h('textarea.field', { placeholder, rows, 'data-key': key });
  ta.value = drafts.get(key) || '';
  const go = async () => {
    const v = ta.value.trim();
    if (!v && !pendingFiles(key).length) return;
    drafts.delete(key);
    ta.value = '';
    await submit(v, await takeFiles(key));
  };
  ta.addEventListener('input', () => drafts.set(key, ta.value));
  ta.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
    if (e.key === 'Escape') ta.blur();
  });
  autosize(ta);
  const clip = h('button.icon-btn.clip', { title: 'Attach a file (or drop or paste one)', html: icons.clip });
  const box = h('div.composer', ta, clip, h('button.text-btn.primary.send', { onclick: go }, label));
  wire(key, { button: clip, zone: box, field: ta, onchange: () => render() });
  return [chips(key, () => render()), box];
}

function render() {
  for (const b of tabs.querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === S.tab);
  const open = S.board ? S.board.notes.filter(n => !n.resolved).length : 0;
  notesCount.textContent = open || '';
  if (!S.board) return panel.replaceChildren();

  // keep focus, caret and scroll through the re-render
  const active = document.activeElement;
  const key = panel.contains(active) ? active.dataset.key : null;
  const sel = key ? [active.selectionStart, active.selectionEnd] : null;
  const top = panel.scrollTop;

  const body = S.tab === 'notes' ? notesPanel() : S.tab === 'activity' ? activityPanel() : scenePanel();
  panel.replaceChildren(...[body].flat(Infinity).filter(x => x instanceof Node));

  if (key) {
    const el = panel.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (el) {
      restoring = true;
      el.focus({ preventScroll: true });
      restoring = false;
      try { el.setSelectionRange(...sel); } catch {}
    }
  }
  panel.scrollTop = top;
  // A note picked on the timeline or the monitor scrolls into view.
  if (S.sel.note && S.sel.note !== lastNote) panel.querySelector(`[data-note="${CSS.escape(S.sel.note)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  lastNote = S.sel.note;
}
let lastNote = null;

// ---------------------------------------------------------------- scene

function scenePanel() {
  const s = scene(S.sel.scene);
  if (!s) return boardPanel();
  const b = S.board;
  const rows = layout(b);
  const row = rows.find(r => r.scene.id === s.id);
  const set = (fields, key) => commit([{ op: 'scene.set', id: s.id, fields }], { key });
  const beats = b.bpm ? +(s.duration / (60 / b.bpm)).toFixed(2) : null;

  const title = bound(`title:${s.id}`, s.title, (v, k) => v.trim() && set({ title: v }, k), { cls: 'bare scene-title', placeholder: 'Title' });
  title.id = 'sceneTitle';
  const dur = bound(`dur:${s.id}`, +s.duration.toFixed(4), (v, k) => { const n = parseFloat(v); if (n > 0) set({ duration: n }, k); }, { cls: 'num', type: 'number' });
  dur.step = String(1 / b.fps);
  dur.min = '0';

  const more = e => {
    const r = e.currentTarget.getBoundingClientRect();
    menu(r.right - 210, r.bottom + 4, [
      { label: 'Add a still or clip…', icon: 'upload', onclick: () => actions.pickFile({ scene: s.id }) },
      { label: 'Duplicate', icon: 'copy', key: '⌘D', onclick: () => actions.duplicate(s.id) },
      '-',
      { label: 'Delete scene', icon: 'trash', key: '⌫', danger: true, onclick: () => actions.remove(s.id) },
    ]);
  };

  return [
    h('div.sec',
      h('div.scene-head',
        h('span.scene-num', String(row.index + 1).padStart(2, '0')),
        h('div', { style: { flex: 1, minWidth: 0 } }, title, timeLine(b, row)),
        h('button.icon-btn.more', { title: 'More', html: icons.more, onclick: more }),
      ),
    ),
    h('div.sec',
      h('div.status-row', STATUSES.map((st, i) => h('button', {
        class: s.status === st ? 'on' : i < STATUSES.indexOf(s.status) ? 'past' : '', style: { '--sc': STATUS_COLOR[st] },
        onclick: () => s.status !== st && set({ status: st }),
      }, h('i'), st[0].toUpperCase() + st.slice(1)))),
    ),
    h('div.sec.props',
      h('span.label', 'Length'),
      h('div.dur-row', dur, h('span.unit', 's'), h('div.facts', h('span', `${Math.round(s.duration * b.fps)}f`), beats != null && h('span', `${beats} beats`))),
      h('span.label', 'Colour'),
      h('div.swatches',
        h('button.none', { class: !s.color ? 'on' : '', title: 'Default', style: { '--c': 'var(--faint)' }, onclick: () => s.color && set({ color: null }) }),
        COLORS.slice(1).map(c => h('button', { class: s.color === c ? 'on' : '', style: { '--c': c }, onclick: () => s.color !== c && set({ color: c }) })),
      ),
    ),
    h('div.sec',
      h('div.sec-head', h('span.label', 'Picture')),
      bound(`picture:${s.id}`, s.picture, (v, k) => set({ picture: v }, k), { tag: 'textarea', placeholder: 'What we see — framing, action, light, motion…' }),
    ),
    h('div.sec',
      h('div.sec-head', h('span.label', 'Sound')),
      bound(`sound:${s.id}`, s.sound, (v, k) => set({ sound: v }, k), { tag: 'textarea', placeholder: 'What we hear — music cue, effects, voice…' }),
    ),
    rendersSection(s),
    Object.keys(s.meta || {}).length && h('div.sec',
      h('div.sec-head', h('span.label', 'Agent meta')),
      h('pre.meta', Object.entries(s.meta).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')),
    ),
  ];
}

// A shot's versions as its history, oldest first: the idea sketches, then renders. One is active.
// While Claude says it's working on this shot, the version it's making shows at the end.
const versionTitle = r =>
  r.kind === 'code' ? 'Code sketch' : r.sketch && /\.svg$/i.test(r.file) ? 'Drawing' : r.sketch ? (r.kind === 'video' ? 'Sketch clip' : 'Sketch') : r.kind === 'video' ? 'Clip' : 'Still';

function rendersSection(s) {
  const say = activeSay();
  const arriving = say?.scene === s.id ? say : null;
  const tiles = s.renders.map(r => h('div.vtile', {
    class: r.id === s.activeRender ? 'on' : '',
    title: [r.caption, r.source, r.id === s.activeRender ? 'The active version' : 'Click to make this the active version'].filter(Boolean).join('\n'),
    onclick: () => r.id !== s.activeRender && commit([{ op: 'scene.set', id: s.id, fields: { activeRender: r.id } }]),
  },
    h('div.vthumb', { style: { backgroundImage: `url("${mediaUrl(r.poster || r.file)}")` } },
      r.kind === 'video' && h('span.k', secs(r.duration)),
      r.id === s.activeRender && h('span.vact', 'Active'),
      h('button.icon-btn.rm', { title: 'Remove this version', html: icons.x, onclick: e => { e.stopPropagation(); commit([{ op: 'render.remove', scene: s.id, id: r.id }]); } }),
    ),
    h('div.vname', versionTitle(r)),
    h('div.vmeta', `${r.id} · ${r.author === 'you' ? 'you' : r.author} · ${ago(r.created)}`),
  ));
  if (arriving) tiles.push(h('div.vtile.arriving', { title: arriving.text },
    h('div.vthumb', h('div.work', { class: arriving.progress == null ? 'spin' : '', style: { '--p': arriving.progress ?? 0.25 } }),
      h('span.vpct', arriving.progress != null ? `${Math.round(arriving.progress * 100)}%` : '')),
    h('div.vname', 'Arriving'),
    h('div.vmeta', arriving.text),
  ));
  tiles.push(h('button.vtile.vadd', { title: 'Add a still or clip (or drop one here)', onclick: () => actions.pickFile({ scene: s.id }) },
    h('div.vthumb', h('span', { html: icons.plus })), h('div.vname', 'Add'), h('div.vmeta', 'still or clip')));
  const sec = h('div.sec',
    h('div.sec-head',
      h('span.label', 'Versions', h('em', s.renders.length ? String(s.renders.length) : ''), arriving && h('em.arr', '· one arriving')),
    ),
    h('div.versions', { style: { '--ar': `${S.board.width} / ${S.board.height}` } }, tiles),
    !s.renders.length && !arriving && h('div.hint', { style: { marginTop: '8px' } }, 'Drop a still or clip here, on the monitor or on the scene, or ask Claude for a sketch.'),
  );
  sec.addEventListener('dragover', e => { e.preventDefault(); sec.classList.add('drop-target'); });
  sec.addEventListener('dragleave', () => sec.classList.remove('drop-target'));
  sec.addEventListener('drop', async e => {
    e.preventDefault();
    sec.classList.remove('drop-target');
    for (const f of e.dataTransfer.files) await upload(f, { scene: s.id });
  });
  return sec;
}

// Where the scene sits, and with a tempo, its length in bars and whether its cuts land on the beat.
function timeLine(b, row) {
  const d = row.scene.duration;
  const where = [h('span', row.scene.id), h('span', `${tcOf(row.start)}–${tcOf(row.end)}`)];
  if (!b.bpm) return h('div.scene-id', where, h('span', `${secs(d)} · ${Math.round(d * b.fps)}f`));
  const beat = 60 / b.bpm, per = b.beatsPerBar || 4, off = b.beatOffset || 0;
  const beats = d / beat;
  const whole = Math.abs(beats - Math.round(beats)) * beat < 0.5 / b.fps;
  const nb = Math.round(beats);
  const len = whole && nb % per === 0 ? `${nb / per} bar${nb / per === 1 ? '' : 's'}` : whole ? `${nb} beat${nb === 1 ? '' : 's'}` : `${+beats.toFixed(2)} beats`;
  // bar.beat of the nearest beat, and how many frames the cut is off it
  const pos = t => {
    const x = (t - off) / beat;
    const k = Math.round(x);
    const bar = Math.floor(k / per) + 1;
    return { off: Math.round((x - k) * beat * b.fps), text: `${bar}.${k - (bar - 1) * per + 1}` };
  };
  const a = pos(row.start), z = pos(row.end);
  const worst = Math.max(Math.abs(a.off), Math.abs(z.off));
  return [
    h('div.scene-id', where),
    h('div.scene-id', h('span', { title: secs(d) }, len), h('span', `bar ${a.text} → ${z.text}`),
      worst > 0 && h('span.off', { title: `In ${a.off ? `${a.off > 0 ? '+' : ''}${a.off}f` : 'on the beat'}, out ${z.off ? `${z.off > 0 ? '+' : ''}${z.off}f` : 'on the beat'}` }, `${worst}f off the beat`)),
  ];
}

// ---------------------------------------------------------------- board

function boardPanel() {
  const b = S.board;
  const set = (fields, key) => commit([{ op: 'board.set', fields }], { key });
  const numField = (k, v, opts = {}) => {
    const el = bound(`board:${k}`, v ?? '', (val, key) => set({ [k]: val === '' ? null : +val }, key), { cls: 'num', type: 'number', placeholder: opts.placeholder || '' });
    return el;
  };
  const cmd = `sb -b ${S.slug}`;
  return [
    h('div.sec',
      bound('board:title', b.title, (v, k) => v.trim() && set({ title: v }, k), { cls: 'bare scene-title', placeholder: 'Board title' }),
      h('div.board-hint', 'The whole board. Select a scene to edit it.'),
    ),
    h('div.sec',
      h('div.sec-head', h('span.label', 'Brief')),
      prose('board:brief', b.brief, (v, k) => set({ brief: v }, k), 'The idea, the tone, the rules — what the film is.'),
    ),
    h('div.sec',
      h('div.sec-head', h('span.label', 'Treatment')),
      prose('board:treatment', b.treatment, (v, k) => set({ treatment: v }, k), 'The full plan: story beats, look, rules, references…'),
    ),
    h('div.sec',
      h('div.sec-head', h('span.label', 'Project folder')),
      bound('board:project', b.project, (v, k) => set({ project: v }, k), { cls: 'num', placeholder: '/Users/…/dev/my-film — where the code that renders it lives' }),
    ),
    h('div.sec.board-form',
      h('div.sec-head', h('span.label', 'Format')),
      h('div.three', numField('width', b.width), h('span.hint', '×'), numField('height', b.height)),
      h('div.two',
        h('label', h('span.hint', 'Frames per second'), numField('fps', b.fps)),
        h('label', h('span.hint', 'Tempo (bpm)'), numField('bpm', b.bpm, { placeholder: 'none' })),
      ),
      b.bpm && h('div.two',
        h('label', h('span.hint', 'Beats per bar'), numField('beatsPerBar', b.beatsPerBar)),
        h('label', h('span.hint', 'First beat at (s)'), numField('beatOffset', b.beatOffset)),
      ),
    ),
    h('div.sec',
      h('div.sec-head', h('span.label', 'Soundtrack')),
      b.audio
        ? h('div.row', h('span', { style: { flex: 1 } }, b.audio.name, h('span.hint', ` · ${secs(b.audio.duration)}`)),
            h('button.text-btn', { onclick: () => actions.pickFile({ audio: true }) }, 'Replace'),
            h('button.text-btn.danger', { onclick: () => commit([{ op: 'audio.set', audio: null }]) }, 'Remove'))
        : h('div.row', h('button.text-btn', { onclick: () => actions.pickFile({ audio: true }) }, h('span', { html: icons.wave }), 'Add a soundtrack…'), h('span.hint', 'or drop one on the Audio lane')),
    ),
    b.markers.length > 0 && h('div.sec',
      h('div.sec-head', h('span.label', 'Markers')),
      b.markers.map(m => h('div.row',
        h('span.chip', { onclick: () => seek(m.t) }, short(m.t)),
        bound(`marker:${m.id}`, m.label, (v, k) => v.trim() && commit([{ op: 'marker.set', id: m.id, fields: { label: v } }], { key: k }), { cls: 'bare' }),
        h('button.icon-btn', { title: 'Delete marker', html: icons.x, onclick: () => commit([{ op: 'marker.remove', id: m.id }]) }),
      )),
    ),
    h('div.sec',
      h('div.sec-head', h('span.label', 'For Claude')),
      h('div.agent-line', h('code', `${location.origin}/agent`),
        h('button.icon-btn', { title: 'Copy', html: icons.copy, onclick: e => { navigator.clipboard?.writeText(`${location.origin}/agent`); toast('Copied'); } })),
      h('div.hint', 'Claude works on the board through this address, never through this page.'),
    ),
  ];
}

// ---------------------------------------------------------------- notes

function whoEl(author) {
  const you = author === 'you';
  return h('span.who', h('span.avatar', { class: you ? '' : 'claude', html: you ? 'Y' : icons.spark }), you ? 'You' : author[0].toUpperCase() + author.slice(1));
}

// What a note is about, as a pill: the exact frame (click to go there), the whole scene, or the board.
function scopePill(n) {
  const b = S.board;
  const s = findScene(b, n.scene);
  const t = noteTime(b, n);
  if (!n.scene) return h('span.scope.is-board', 'Whole board');
  if (!s) return h('span.scope.is-board', 'Deleted scene');
  if (n.at == null) return h('span.scope.is-scene', { title: 'Go to the scene', onclick: () => { select(s.id, { note: n.id, keepTime: true }); seek(sceneRange(s.id).start); } }, 'Whole scene');
  return h('span.scope.is-frame', { title: 'Go to this exact frame', onclick: () => { select(s.id, { note: n.id, keepTime: true }); seek(t); } },
    h('span', { html: icons.pin, style: { display: 'inline-grid' } }),
    `Frame ${tcOf(t)}`, h('em', `f${Math.round(t * b.fps)}`), n.pin && h('em', '· spot'));
}
const tcOf = t => tcFmt(t, S.board.fps);

// Where a note is in its life, from the user's side: a draft, sent, read by Claude, being worked on,
// answered, done.
export function noteStatus(n) {
  if (n.resolved) return { key: 'done', label: 'Resolved', tip: `${n.resolvedBy ? `Resolved by ${nameOf(n.resolvedBy)}` : 'Done'}. Reopen it if it isn’t.` };
  if (n.author === 'you' && !n.sent) return { key: 'draft', label: 'Draft', tip: 'Not sent yet. Claude gets it when you press Send to Claude.' };
  const last = n.replies.at(-1);
  const answered = last && last.author !== 'you';
  // A reply written after work started is news; before that, the work is.
  if (n.working && !(answered && last.created > n.working)) return { key: 'working', label: 'Working', tip: `${nameOf(n.readBy || 'claude')} is working on it.` };
  if (answered) return { key: 'replied', label: 'Replied', tip: `${nameOf(last.author)} replied. Read it, then reply or mark it done.` };
  if (n.author === 'you' && n.read) return { key: 'read', label: 'Read', tip: `${nameOf(n.readBy || 'claude')} has read it${n.read ? ` (${ago(n.read)})` : ''}.` };
  if (n.author === 'you') return { key: 'sent', label: 'Sent', tip: 'Sent. Claude hasn’t picked it up yet.' };
  return { key: 'agent', label: `From ${nameOf(n.author)}`, tip: `${nameOf(n.author)} wrote this note to you.` };
}
const nameOf = a => (a === 'you' ? 'You' : a[0].toUpperCase() + a.slice(1));

function noteCard(n) {
  const b = S.board;
  const idx = b.notes.indexOf(n) + 1;
  const selected = S.sel.note === n.id;
  const st = noteStatus(n);
  const draft = st.key === 'draft';
  const editText = async e => {
    const r = e.currentTarget.getBoundingClientRect();
    const v = await ask(r.left, r.bottom + 6, { value: n.text, multiline: true, ok: 'Save' });
    if (v && v !== n.text) commit([{ op: 'note.set', id: n.id, fields: { text: v } }]);
  };
  return h('div.note', {
    class: `${selected ? 'sel' : ''} st-${st.key}`,
    'data-note': n.id,
    onclick: e => {
      if (e.target.closest('button, textarea, .scope, a')) return;
      // Picking a frame note takes you to its frame (where its pin is); picking it again there lets go.
      const t = n.at != null ? noteTime(b, n) : null;
      const away = t != null && Math.round(S.t * b.fps) !== Math.round(t * b.fps);
      S.sel = { scene: S.sel.scene, note: selected && !away ? null : n.id };
      if (away) seek(t);
      emit('select');
    },
  },
    h('div.note-top',
      h('span.note-num', `#${idx}`),
      scopePill(n),
      h('span.grow'),
      h('div.note-actions',
        draft && h('button.icon-btn', { title: 'Edit this draft', html: icons.edit, onclick: editText }),
        h('button.icon-btn', { title: 'Delete note', html: icons.trash, onclick: () => commit([{ op: 'note.remove', id: n.id }]) }),
      ),
      h('span.note-status', { class: `s-${st.key}`, title: st.tip }, st.label),
    ),
    n.text && longText(n.id, h('div.note-text', n.text), n.text),
    fileRow(n.files),
    n.replies.length > 0 && h('div.replies', n.replies.map((r, i) => h('div.reply', whoEl(r.author), r.text && longText(`${n.id}.${i}`, h('div.reply-text', r.text), r.text), fileRow(r.files)))),
    h('div.note-foot',
      h('span.when', ago(n.created), n.resolved && n.resolvedBy && ` · resolved by ${n.resolvedBy === 'you' ? 'you' : nameOf(n.resolvedBy)}`),
      h('span.grow'),
      !draft && !n.resolved && !selected && h('button.link', { onclick: () => { S.sel = { scene: S.sel.scene, note: n.id }; emit('select'); } }, 'Reply'),
      !draft && h('button.link', { class: n.resolved ? 'reopen' : 'done', onclick: () => commit([{ op: 'note.set', id: n.id, fields: { resolved: !n.resolved } }]) }, n.resolved ? 'Reopen' : 'Mark done'),
    ),
    selected && !draft && !n.resolved && h('div.reply-box', draftBox(`reply:${n.id}`, 'Reply…', (text, files) => commit([{ op: 'reply.add', note: n.id, reply: { text, ...(files.length ? { files } : {}) } }]), { label: 'Reply' })),
  );
}

// Long text (an agent's plan, say) shows five lines until asked for more.
const expanded = new Set();
function longText(key, el, text) {
  if (text.length < 320 && text.split('\n').length <= 5) return el;
  const open = expanded.has(key);
  el.classList.toggle('clamp', !open);
  return [el, h('button.link.more', { onclick: e => { e.stopPropagation(); open ? expanded.delete(key) : expanded.add(key); render(); } }, open ? 'Show less' : 'Show more')];
}

// All notes, grouped by what they're about, in the order of the cut.
function notesPanel() {
  const b = S.board;
  const shown = b.notes.filter(n => noteFilter === 'all' || (noteFilter === 'done' ? n.resolved : !n.resolved));
  const cur = S.board.scenes.length ? here()?.scene.id : null;
  const byTime = (x, y) => (x.at ?? -1) - (y.at ?? -1) || x.created.localeCompare(y.created);
  const groups = [];
  const boardNotes = shown.filter(n => !n.scene);
  if (boardNotes.length) groups.push({ key: 'board', head: h('div.ngroup-head', h('i', { style: { '--c': 'var(--faint)' } }), h('b', 'Whole board')), notes: boardNotes });
  for (const { scene: s, index, start, end } of layout(b)) {
    const ns = shown.filter(n => n.scene === s.id).sort(byTime);
    if (!ns.length) continue;
    groups.push({
      key: s.id, current: s.id === cur,
      head: h('div.ngroup-head', { onclick: () => select(s.id), title: 'Go to this scene' },
        h('i', { style: { '--c': sceneColor(s) } }), h('span.n', String(index + 1).padStart(2, '0')), h('b', s.title),
        h('span.range', { title: s.id === cur ? 'The playhead is in this scene' : '' }, `${tcOf(start)}–${tcOf(end)}`)),
      notes: ns,
    });
  }
  const orphans = shown.filter(n => n.scene && !findScene(b, n.scene));
  if (orphans.length) groups.push({ key: 'gone', head: h('div.ngroup-head', h('b', 'Deleted scenes')), notes: orphans });
  const open = b.notes.filter(n => !n.resolved).length;
  return [
    h('div.sec',
      h('div.sec-head',
        h('div.seg.small.filter',
          h('button', { class: noteFilter === 'open' ? 'on' : '', onclick: () => { noteFilter = 'open'; render(); } }, `Open ${open}`),
          h('button', { class: noteFilter === 'done' ? 'on' : '', onclick: () => { noteFilter = 'done'; render(); } }, `Resolved ${b.notes.length - open}`),
          h('button', { class: noteFilter === 'all' ? 'on' : '', onclick: () => { noteFilter = 'all'; render(); } }, `All ${b.notes.length}`),
        ),
      ),
    ),
    groups.length
      ? groups.map(g => h('div.ngroup', { class: g.current ? 'current' : '' }, g.head, g.notes.map(noteCard)))
      : h('div.sec', h('div.empty-notes', noteFilter === 'open' ? 'Nothing open. Pause where something’s off, press C and write it down; add as many as you like, then Send to Claude.' : noteFilter === 'done' ? 'Nothing resolved yet.' : 'No notes yet.')),
  ];
}

// ---------------------------------------------------------------- activity

// Every change, newest first. An agent's change can be reverted from here (your own undo is ⌘Z).
function activityPanel() {
  if (!S.activity.length) return h('div.hint', 'Nothing has happened yet.');
  // Show what reverting would do before doing it; the revert is then your own (undoable) change.
  const revert = async (e, ev) => {
    const at = ev.currentTarget.getBoundingClientRect();
    const r = await fetch(`/api/boards/${encodeURIComponent(S.slug)}/revert`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rev: e.rev }) });
    const j = await r.json();
    if (!r.ok) return toast(j.error, { err: true, ms: 6000 });
    const lines = j.summaries.slice(0, 6);
    const pop = h('div.pop.revert-pop',
      h('h3', `Revert rev ${e.rev}?`),
      h('p', 'This will:'),
      h('ul', lines.map(s => h('li', s)), j.summaries.length > lines.length && h('li.more', `and ${j.summaries.length - lines.length} more`)),
      j.later > 0 && h('p.warn', `${j.later} later change${j.later > 1 ? 's' : ''} came after this one. Anything built on it goes too.`),
      h('div.row', h('button.text-btn', { onclick: () => closeMenu() }, 'Cancel'),
        h('button.text-btn.primary', { onclick: async () => { closeMenu(); if (await commit(j.ops)) toast(`Reverted rev ${e.rev} · ⌘Z brings it back`); } }, 'Revert')),
    );
    menu(Math.max(8, at.right - 330), at.bottom + 6, [], { el: pop });
  };
  return h('div.activity', S.activity.slice(0, 150).map(e => {
    const you = e.author === 'you';
    const agent = !you && e.author !== 'storyboard';
    return h('div.act-row',
      h('span.avatar', { class: you ? '' : 'claude', html: you ? 'Y' : icons.spark }),
      h('div',
        h('div.what', e.summaries.map((s, i) => h('div', i === 0 && h('b', you ? 'You ' : `${e.author[0].toUpperCase()}${e.author.slice(1)} `), s))),
        h('div.when', `${ago(e.created)} · rev ${e.rev}`, agent && h('button.link.revert', { title: 'Undo this change (shows what it will do first)', onclick: ev => revert(e, ev) }, 'Revert')),
      ),
    );
  }));
}

// ---------------------------------------------------------------- wiring

on('board', render);
on('select', render);
// Claude starting or finishing work on this scene changes its versions.
let sayKey = '';
on('presence', () => {
  const s = activeSay();
  const k = s ? `${s.scene}|${s.progress}|${s.text}` : '';
  if (k === sayKey) return;
  sayKey = k;
  if (S.tab === 'scene') render();
});
// Keep "you are here" true in the Notes panel as the playhead crosses into another scene.
let hereId = null;
on('time', () => {
  const id = S.board?.scenes.length ? here()?.scene.id : null;
  if (id === hereId) return;
  hereId = id;
  if (S.tab === 'notes' && !panel.contains(document.activeElement)) render();
});
on('activity', () => { if (S.tab === 'activity') render(); });
on('focus-title', () => requestAnimationFrame(() => { const t = $('#sceneTitle'); if (t) { t.focus(); t.select(); } }));
setInterval(() => { if (!panel.contains(document.activeElement)) render(); }, 30000);
