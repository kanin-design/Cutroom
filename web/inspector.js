// The right-hand panel. Its first tab belongs to the view: in Edit, the scene (the one selected, or
// else the one under the playhead); in Board, the film (how it renders, where it stands, Claude, the
// brief and treatment, its settings). Then every note thread, and the activity feed. It re-renders
// on every change; typing survives because every field has a key, drafts live in `drafts`, and
// focus and caret are put back afterwards.

import { S, on, emit, commit, select, scene, mediaUrl, sceneRange, upload, here, activeSay, hold } from './store.js';
import { STATUSES, COLORS, ASPECTS, RENDER_TYPES, RENDER_QUALITIES, sceneRender, filmRenderTypes, layout, noteTime, noteState, forYou, totalDuration, activeRender, findScene, kindName, renderSize, renderLabel, renderQuality, renderCodec, qualityWords, aspectName, plural } from '/lib/ops.js';
import { $, h, secs, ago, authorName, debounce, autosize, toast, menu, closeMenu, ask, tc as tcFmt } from './util.js';
import { icons } from './icons.js';
import { seek } from './player.js';
import { STATUS_COLOR, sceneColor, versionQuality } from './viewer.js';
import { actions } from './actions.js';
import { wire, chips, takeFiles, pendingFiles, fileRow } from './attach.js';
import { openAnnotator, ink } from './annotate.js';
import { claudeState } from './handoff.js';
import { setView } from './grid.js';

const panel = $('#panel'), tabs = $('#tabs'), notesCount = $('#notesCount');
const drafts = new Map();
hold(() => [...drafts].some(([k, v]) => k.startsWith('reply:') && v.trim())); // a reply being written
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

// Something you changed since you last sent (`key` in the board's edits): Claude hasn't seen it yet. Its field
// gets a dashed edge, like a note not sent, and this says so, with a way to put back what was there.
function unsent(key, putBack, show = v => (v == null || v === '' ? 'It was empty.' : String(v))) {
  const e = S.board.edits?.[key];
  if (!e) return null;
  const back = h('button.link.has-card', { onclick: () => putBack(e.before) }, h('span', { html: icons.undo }), 'Put back');
  back.card = () => [h('div.tip-head', 'What was there'), h('div.tip-text.tip-was', clipText(show(e.before), 320)), h('div.tip-sub', 'Your change goes to Claude with your next Send.')];
  return h('span.unsent-edit', h('span', 'Not sent'), back);
}
const clipText = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
// The field's dashed edge, while its change isn't sent.
const marked = (el, key) => { if (S.board.edits?.[key]) el.classList.add('unsent'); return el; };

// Just enough markdown for a treatment: headings, lists, bold, italics, code and links. Escaped first.
function markdown(src) {
  // quotes too: a link's address goes inside an attribute
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|\W)_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Lines run on, as in markdown: agents wrap their text at a width. Two spaces or a \ at the end break.
  const lines = ls => ls.map((l, i) => inline(l.replace(/\\$/, '').trim()) + (i === ls.length - 1 ? '' : /( {2}|\\)$/.test(l) ? '<br>' : ' ')).join('');
  const out = [];
  let list = null, item = null, para = [];
  const endItem = () => { if (item) out.push(`<li>${lines(item)}</li>`); item = null; };
  const flush = () => {
    endItem();
    if (para.length) out.push(`<p>${lines(para)}</p>`);
    para = [];
    if (list) { out.push(`</${list}>`); list = null; }
  };
  for (const line of String(src).split('\n')) {
    const hd = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (hd) { flush(); out.push(`<h${Math.min(4, hd[1].length + 2)}>${inline(hd[2])}</h${Math.min(4, hd[1].length + 2)}>`); }
    else if (li) {
      if (para.length) { out.push(`<p>${lines(para)}</p>`); para = []; }
      endItem();
      const kind = li[1] ? 'ol' : 'ul';
      if (list !== kind) { if (list) out.push(`</${list}>`); out.push(`<${kind}>`); list = kind; }
      item = [li[2]];
    } else if (!line.trim()) flush();
    else if (item) item.push(line); // the item, wrapped onto the next line
    else para.push(line);
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
  // The first tab is the view's own: the scene in Edit, the film in Board.
  const film = S.view === 'board', sceneTab = tabs.querySelector('[data-tab="scene"]');
  sceneTab.textContent = film ? 'Film' : 'Scene';
  sceneTab.title = film ? 'The whole film: how it renders, where it stands, the brief, the treatment and its settings' : 'The scene you selected, or else the one under the playhead';
  const open = S.board ? S.board.notes.filter(n => !n.resolved).length : 0;
  notesCount.textContent = open || '';
  if (!S.board) return panel.replaceChildren();

  // keep focus, caret and scroll through the re-render; another tab, scene, board or filter starts at the top
  const active = document.activeElement;
  const key = panel.contains(active) ? active.dataset.key : null;
  const sel = key ? [active.selectionStart, active.selectionEnd] : null;
  const view = [S.slug, S.view, S.tab, S.tab === 'scene' ? shownScene()?.id : S.tab === 'notes' ? noteFilter : ''].join('|');
  const top = view === shownView ? panel.scrollTop : 0;
  shownView = view;

  const body = S.tab === 'notes' ? notesPanel() : S.tab === 'activity' ? activityPanel() : film ? filmPanel() : scenePanel();
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
let lastNote = null, shownView = '';

// ---------------------------------------------------------------- scene

// The scene the Edit pane shows: the one selected, or else the one under the playhead.
const shownScene = () => scene(S.sel.scene) || (S.board?.scenes.length ? here()?.scene : null);

function scenePanel() {
  const s = shownScene();
  if (!s) return h('div.sec', h('div.hint', 'No scenes yet. Add one with N, or hand the board to Claude to lay the idea out.'));
  const following = !scene(S.sel.scene);
  const b = S.board;
  const rows = layout(b);
  const row = rows.find(r => r.scene.id === s.id);
  const set = (fields, key) => commit([{ op: 'scene.set', id: s.id, fields }], { key });
  const beats = b.bpm ? +(s.duration / (60 / b.bpm)).toFixed(2) : null;

  const title = bound(`title:${s.id}`, s.title, (v, k) => v.trim() && set({ title: v }, k), { cls: 'bare scene-title', placeholder: 'Title' });
  const was = (field, show) => unsent(`${s.id}.${field}`, v => set({ [field]: v }), show);
  title.id = 'sceneTitle';
  const dur = marked(bound(`dur:${s.id}`, +s.duration.toFixed(4), (v, k) => { const n = parseFloat(v); if (n > 0) set({ duration: n }, k); }, { cls: 'num', type: 'number' }), `${s.id}.duration`);
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
        h('div', { style: { flex: 1, minWidth: 0 } }, title, timeLine(b, row), following && h('div.scene-id.following', 'At the playhead'), was('title') && h('div.scene-id', 'Title ', was('title'))),
        h('button.icon-btn.more', { title: 'More', html: icons.more, onclick: more }),
      ),
    ),
    h('div.sec',
      h('div.status-row', STATUSES.map((st, i) => h('button', {
        class: s.status === st ? 'on' : i < STATUSES.indexOf(s.status) ? 'past' : '', style: { '--sc': STATUS_COLOR[st] },
        onclick: () => s.status !== st && set({ status: st }),
      }, h('i'), st[0].toUpperCase() + st.slice(1)))),
      was('status') && h('div.now-playing', 'Status ', was('status', v => `${v[0].toUpperCase()}${v.slice(1)}`)),
      playing(s),
    ),
    h('div.sec.props',
      h('span.label', 'Length'),
      h('div.dur-row', dur, h('span.unit', 's'), h('div.facts', h('span', `${Math.round(s.duration * b.fps)}f`), beats != null && h('span', plural(beats, 'beat'))), was('duration', v => secs(v))),
      h('span.label', 'Colour'),
      h('div.swatches',
        h('button.none', { class: !s.color ? 'on' : '', title: 'Automatic: a colour unlike the scenes beside it', style: { '--c': 'var(--faint)' }, onclick: () => s.color && set({ color: null }) }),
        COLORS.slice(1).map(c => h('button', { class: s.color === c ? 'on' : '', style: { '--c': c }, onclick: () => s.color !== c && set({ color: c }) })),
      ),
    ),
    renderAsSection(s, b, set, was),
    h('div.sec',
      h('div.sec-head', h('span.label', 'Picture'), was('picture')),
      marked(bound(`picture:${s.id}`, s.picture, (v, k) => set({ picture: v }, k), { tag: 'textarea', placeholder: 'What we see — framing, action, light, motion…' }), `${s.id}.picture`),
    ),
    h('div.sec',
      h('div.sec-head', h('span.label', 'Sound'), was('sound')),
      marked(bound(`sound:${s.id}`, s.sound, (v, k) => set({ sound: v }, k), { tag: 'textarea', placeholder: 'What we hear — music cue, effects, voice…' }), `${s.id}.sound`),
    ),
    rendersSection(s),
    Object.keys(s.meta || {}).length && h('div.sec',
      h('div.sec-head', h('span.label', 'Agent meta')),
      h('pre.meta', Object.entries(s.meta).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')),
    ),
  ];
}

// How this scene is made. Every scene is its own little movie: one is ray traced, the next an edit of 4K
// footage. You pick the way; Claude says what draft and final mean for it and the command that renders it. The
// cut fits every scene to the film's frame and frame rate.
function renderAsSection(s, b, set, was) {
  const how = sceneRender(b, s), own = !!s.render;
  const def = b.render?.type?.length === 1 ? RENDER_TYPES[b.render.type[0]].label : null;
  const pick = h('select.field.render-as', { 'aria-label': 'Render as', onchange: e => set({ render: e.target.value ? { type: e.target.value } : null }) },
    h('option', { value: '', selected: !own }, def ? `As the film (${def})` : 'Not set yet'),
    Object.entries(RENDER_TYPES).map(([k, t]) => h('option', { value: k, selected: own && s.render.type === k }, t.label)));
  const rows = how ? [['Draft', how.draft], ['Final', how.final], ['Frame rate', how.fps && `${+how.fps} fps, conformed to ${+b.fps} in the cut`], ['Made with', how.cmd], ['Footage', how.source]].filter(([, v]) => v) : [];
  return h('div.sec',
    h('div.sec-head', h('span.label', 'Render as'), was('render', v => (v ? RENDER_TYPES[v.type]?.label || v.type : 'as the film'))),
    pick,
    h('div.render-what', how ? RENDER_TYPES[how.type].what : 'Pick how this scene is made: each scene is its own movie, and the cut joins them.'),
    rows.length > 0 && h('div.props.wide.render-rows', rows.map(([k, v]) => [h('span.label', k), h('span.render-q', v)])),
    how && !how.draft && !how.final && h('div.hint', 'Claude fills in what draft and final mean for it.'),
  );
}

// What plays for this scene: which version, what it is (the quality it was rendered at, when that's
// known), and when it came.
function playing(s) {
  const r = activeRender(s);
  if (!r) return null;
  return h('div.now-playing', h('span', 'Playing'), h('b', `v${s.renders.indexOf(r) + 1}`), h('span', versionQuality(r) || kindName(r)), h('span', ago(r.created)));
}

// A shot's versions as its history, oldest first: the idea sketches, then renders. One is active.
// While Claude says it's working on this shot, the version it's making shows at the end.
// A version's name on its tile: what the model calls it, except that an SVG sketch is a drawing.
const versionTitle = r => {
  if (r.sketch && /\.svg$/i.test(r.file)) return 'Drawing';
  const k = kindName(r);
  return k[0].toUpperCase() + k.slice(1);
};

function rendersSection(s) {
  const say = activeSay();
  const arriving = say?.scene === s.id ? say : null;
  const tiles = s.renders.map((r, i) => h('div.vtile', {
    class: r.id === s.activeRender ? 'on' : '',
    title: [`Version ${i + 1} of ${s.renders.length} (${r.id})`, versionQuality(r), r.caption, r.source, r.id === s.activeRender ? 'The active version' : 'Click to make this the active version'].filter(Boolean).join('\n'),
    onclick: () => r.id !== s.activeRender && commit([{ op: 'scene.set', id: s.id, fields: { activeRender: r.id } }]),
  },
    h('div.vthumb', { style: { backgroundImage: `url("${mediaUrl(r.poster || r.file)}")` } },
      r.kind === 'video' && h('span.k', secs(r.duration)),
      r.id === s.activeRender && h('span.vact', 'Active'),
      h('button.icon-btn.rm', { title: 'Remove this version', html: icons.x, onclick: e => { e.stopPropagation(); commit([{ op: 'render.remove', scene: s.id, id: r.id }]); } }),
    ),
    h('div.vname', h('span.vn', `v${i + 1}`), versionTitle(r)),
    h('div.vmeta', `${r.meta?.quality || authorName(r.author)} · ${ago(r.created)}`),
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
  const len = whole && nb % per === 0 ? plural(nb / per, 'bar') : whole ? plural(nb, 'beat') : plural(+beats.toFixed(2), 'beat');
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

// The film, beside the wall: how it renders, where it stands, the brief and the treatment (Claude is in the
// top bar, always). The
// settings it rarely changes once it's set up come last, folded, with their values summed up beside them.
let settingsOpen = (() => { try { return localStorage.getItem('sb.film.settings') === '1'; } catch { return false; } })();
const openSettings = v => { settingsOpen = v; try { localStorage.setItem('sb.film.settings', v ? '1' : '0'); } catch {} };

function filmPanel() {
  const b = S.board;
  const set = (fields, key) => commit([{ op: 'board.set', fields }], { key });
  const numField = (k, v, opts = {}) => bound(`board:${k}`, v ?? '', (val, key) => set({ [k]: val === '' ? null : +val }, key), { cls: 'num', type: 'number', placeholder: opts.placeholder || '' });
  const summary = [aspectName(b), `${+b.fps} fps`, b.bpm && `${+b.bpm} bpm`, b.audio?.name].filter(Boolean).join(' · ');
  return [
    h('div.sec',
      bound('board:title', b.title, (v, k) => v.trim() && set({ title: v }, k), { cls: 'bare scene-title', placeholder: 'Board title' }),
      unsent('board.title', v => set({ title: v })) && h('div.scene-id', 'Title ', unsent('board.title', v => set({ title: v }))),
    ),
    h('div.sec',
      h('div.sec-head', h('span.label', 'Render'), h('span.hint', 'scene by scene')),
      renderInfo(b),
    ),
    h('div.sec',
      h('div.sec-head', h('span.label', 'Progress')),
      progress(b),
    ),
    h('div.sec',
      h('div.sec-head', h('span.label', 'Brief'), unsent('board.brief', v => set({ brief: v }))),
      marked(prose('board:brief', b.brief, (v, k) => set({ brief: v }, k), 'The idea, the tone, the rules — what the film is.'), 'board.brief'),
    ),
    h('div.sec',
      h('div.sec-head', h('span.label', 'Treatment'), unsent('board.treatment', v => set({ treatment: v }))),
      marked(prose('board:treatment', b.treatment, (v, k) => set({ treatment: v }, k), 'The film thought through: the idea, the style, the shape, every scene, how it’s made.'), 'board.treatment'),
    ),
    h('div.sec',
      h('button.fold', { class: settingsOpen ? 'open' : '', 'aria-expanded': String(settingsOpen), onclick: () => { openSettings(!settingsOpen); render(); } },
        h('span.label', 'Settings'), !settingsOpen && h('span.fold-sum', summary), h('span.chev', { html: icons.chevron })),
    ),
    settingsOpen && [
      h('div.sec',
        h('div.sec-head', h('span.label', 'Project folder')),
        bound('board:project', b.project, (v, k) => set({ project: v }, k), { cls: 'num', placeholder: '/Users/…/dev/my-film — where the code that renders it lives' }),
      ),
      h('div.sec',
        h('div.sec-head', h('span.label', 'Shape')),
        shapePicker(b, set),
      ),
      h('div.sec.props.wide',
        h('span.label', 'Frame rate'), h('div.dur-row', numField('fps', b.fps), h('span.unit', 'fps')),
        h('span.label', 'Tempo'), h('div.dur-row', numField('bpm', b.bpm, { placeholder: 'none' }), h('span.unit', 'bpm')),
        b.bpm && [h('span.label', 'Meter'), h('div.dur-row', numField('beatsPerBar', b.beatsPerBar), h('span.unit', 'beats a bar'))],
        b.bpm && [h('span.label', 'First beat'), h('div.dur-row', numField('beatOffset', b.beatOffset), h('span.unit', 's'))],
      ),
      h('div.sec',
        h('div.sec-head', h('span.label', 'Soundtrack')),
        b.audio
          ? h('div.row', h('span', { style: { flex: 1 } }, b.audio.name, h('span.hint', ` · ${secs(b.audio.duration)}`)),
              h('button.text-btn', { onclick: () => actions.pickFile({ audio: true }) }, 'Replace'),
              h('button.text-btn.danger', { onclick: () => commit([{ op: 'audio.set', audio: null }]) }, 'Remove'))
          : h('div', h('button.text-btn', { onclick: () => actions.pickFile({ audio: true }) }, h('span', { html: icons.wave }), 'Add a soundtrack…'), h('div.hint', 'or drop one on the Audio lane, in Edit')),
      ),
      b.markers.length > 0 && h('div.sec',
        h('div.sec-head', h('span.label', 'Markers')),
        b.markers.map(m => h('div.row',
          h('span.chip', { onclick: () => seek(m.t) }, tcOf(m.t)),
          bound(`marker:${m.id}`, m.label, (v, k) => v.trim() && commit([{ op: 'marker.set', id: m.id, fields: { label: v } }], { key: k }), { cls: 'bare' }),
          h('button.icon-btn', { title: 'Delete marker', html: icons.x, onclick: () => commit([{ op: 'marker.remove', id: m.id }]) }),
        )),
      ),
    ],
  ];
}

// Where the film stands: its scenes by status, as a bar in the status colours and in words, its length,
// and the notes waiting for you (which open the Notes tab).
const STATUS_WORD = { idea: n => plural(n, 'idea'), draft: n => plural(n, 'draft'), review: n => `${n} in review`, approved: n => `${n} approved` };
function progress(b) {
  if (!b.scenes.length) return h('div.hint', 'No scenes yet.');
  const counts = STATUSES.map(st => [st, b.scenes.filter(s => s.status === st).length]).filter(([, n]) => n);
  const len = Math.round(totalDuration(b));
  const waiting = b.notes.filter(forYou).length, open = b.notes.filter(n => !n.resolved).length;
  return [
    h('div.film-bar', counts.map(([st, n]) => h('i', { style: { flex: n, '--sc': STATUS_COLOR[st] }, 'data-tip': STATUS_WORD[st](n) }))),
    h('div.film-facts', [plural(b.scenes.length, 'scene'), `${Math.floor(len / 60)}:${String(len % 60).padStart(2, '0')}`, ...counts.map(([st, n]) => STATUS_WORD[st](n))].join(' · ')),
    open > 0 && h('button.link.film-notes', { class: waiting ? 'waiting' : '', onclick: () => { S.tab = 'notes'; render(); } },
      waiting ? `${plural(waiting, 'note')} waiting for you` : plural(open, 'open note')),
  ];
}

// How the film is made: scene by scene, each its own movie, each its own way (set on the scene). The ways it
// mixes, with how many scenes each (what each is, on hover); the default for scenes that don't say, as Claude
// set it; and what the cut does with them.
function renderInfo(b) {
  const types = filmRenderTypes(b);
  const n = t => b.scenes.filter(s => sceneRender(b, s)?.type === t).length, unset = b.scenes.filter(s => !sceneRender(b, s)).length;
  const def = b.render && `${b.render.type.map(t => RENDER_TYPES[t].label).join(' · ')}${RENDER_QUALITIES.filter(q => b.render[q]).map(q => ` · ${q}: ${b.render[q]}`).join('')}`;
  return h('div.render-info',
    types.length > 0 && b.scenes.length > 0 && h('div.render-kind', types.filter(n).map(t => h('span', { 'data-tip': RENDER_TYPES[t].what }, RENDER_TYPES[t].label, h('em', String(n(t)))))),
    unset > 0 && b.scenes.length > 0 && h('div.hint', `${plural(unset, 'scene')} not set yet`),
    h('div.render-q', `Each scene is its own movie, made its own way (set it on the scene). The cut fits them all to the film: ${aspectName(b)} at ${+b.fps} fps.`),
    def && h('div.props.wide', h('span.label', 'Default'), h('span.render-q', { title: 'For scenes that don’t say how they are made (set by Claude)' }, def)),
  );
}

// ---------------------------------------------------------------- notes

function whoEl(author) {
  const you = author === 'you';
  return h('span.who', h('span.avatar', { class: you ? '' : 'claude', html: you ? 'Y' : icons.spark }), authorName(author));
}

// The board's shape: the usual ones, or any other as w:h.
function shapePicker(b, set) {
  const name = aspectName(b), other = !ASPECTS.includes(name);
  const custom = async e => {
    const r = e.currentTarget.getBoundingClientRect();
    const v = await ask(r.left, r.bottom + 6, { value: other ? name : '', placeholder: 'w:h, e.g. 3:2 or 1.85:1', ok: 'Set' });
    if (v) set({ aspect: v });
  };
  return h('div.seg.small.shapes',
    ASPECTS.map(a => h('button', { class: a === name ? 'on' : '', onclick: () => a !== name && set({ aspect: a }) }, a)),
    h('button', { class: other ? 'on' : '', title: 'Another shape, as w:h', onclick: custom }, other ? name : 'Other…'));
}

// The film pane: Board view, its first tab.
export function openFilm() {
  emit('panel');
  if (S.view !== 'board') setView('board');
  S.tab = 'scene';
  render();
}

// A board's settings: the film pane with its settings unfolded, the title ready to rename. Another
// board opens first.
let settingsFor = null;
export function openBoardSettings(slug = S.slug) {
  if (slug !== S.slug) { settingsFor = slug; location.hash = slug; return; }
  openSettings(true);
  openFilm();
  requestAnimationFrame(() => panel.querySelector('[data-key="board:title"]')?.focus());
}
on('open', () => { if (settingsFor === S.slug) { settingsFor = null; openBoardSettings(); } });

// What a note is about, as a pill: the exact frame (click to go there), the whole scene, the board,
// or the soundtrack (a moment in it, or all of it).
function scopePill(n) {
  const b = S.board;
  const s = findScene(b, n.scene);
  const t = noteTime(b, n);
  if (n.soundtrack && t == null) return h('span.scope.is-board', 'Whole soundtrack');
  if (n.soundtrack) {
    return h('span.scope.is-frame', { title: 'Go to this moment', onclick: () => { select(null, { note: n.id, keepTime: true }); seek(t); } },
      h('span', { html: icons.wave, style: { display: 'inline-grid' } }), `Soundtrack ${tcOf(t)}`);
  }
  if (!n.scene) return h('span.scope.is-board', 'Whole film');
  if (!s) return h('span.scope.is-board', 'Deleted scene');
  if (n.at == null) return h('span.scope.is-scene', { title: 'Go to the scene', onclick: () => { select(s.id, { note: n.id, keepTime: true }); seek(sceneRange(s.id).start); } }, 'Whole scene');
  return h('span.scope.is-frame', { title: `Go to this exact frame (f${Math.round(t * b.fps)})`, onclick: () => { select(s.id, { note: n.id, keepTime: true }); seek(t); } },
    h('span', { html: icons.pin, style: { display: 'inline-grid' } }),
    `Frame ${tcOf(t)}`, n.pin && h('em', '· spot'));
}
const tcOf = t => tcFmt(t, S.board.fps);

// Where a note is in its life, from the user's side: not sent, sent, read by Claude, being worked on,
// answered, done. Shown as a light; the tip says it in words.
export function noteStatus(n) {
  const key = noteState(n);
  switch (key) {
    case 'done': return { key, light: 'is-done', label: 'Resolved', tip: `Resolved${n.resolvedBy ? ` by ${authorName(n.resolvedBy)}` : ''}. Reopen it if it isn’t done.` };
    case 'draft': return { key, light: 'is-unsent', label: 'Not sent', tip: 'Not sent yet: it goes to Claude with your other notes when you press Send to Claude.' };
    case 'working': return { key, light: 'is-work', label: 'Working', tip: `${authorName(n.readBy || 'claude')} is working on it.` };
    case 'replied': return { key, light: 'is-ask', label: 'Replied', tip: `${authorName(n.replies.at(-1).author)} replied: read it, then reply or mark it done.` };
    case 'read': return { key, light: 'is-read', label: 'Read', tip: `Read by ${authorName(n.readBy || 'claude')} ${ago(n.read)}.` };
    case 'sent': return { key, light: 'is-sent', label: 'Sent', tip: 'Sent: Claude hasn’t picked it up yet.' };
    default: return { key, light: 'is-ask', label: `From ${authorName(n.author)}`, tip: `${authorName(n.author)} wrote this note to you.` };
  }
}
export const statusLight = n => { const st = noteStatus(n); return h('i.light', { class: st.light, 'data-tip': st.tip }); };

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
      // Picking a frame note takes you to its frame; picking it again there lets go.
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
        draft && h('button.icon-btn', { title: 'Edit this note (it isn’t sent yet)', html: icons.edit, onclick: editText }),
        h('button.icon-btn', { title: 'Delete note', html: icons.trash, onclick: () => commit([{ op: 'note.remove', id: n.id }]) }),
      ),
      statusLight(n),
    ),
    n.render && requestLine(n),
    n.text && longText(n.id, h('div.note-text', n.text), n.text),
    n.markup && markupBlock(n),
    fileRow(n.files),
    n.replies.length > 0 && h('div.replies', n.replies.map((r, i) => h('div.reply', whoEl(r.author), r.text && longText(`${n.id}.${i}`, h('div.reply-text', r.text), r.text), fileRow(r.files)))),
    h('div.note-foot',
      h('span.when', ago(n.created), n.resolved && n.resolvedBy && ` · resolved by ${n.resolvedBy === 'you' ? 'you' : authorName(n.resolvedBy)}`),
      h('span.grow'),
      !draft && !n.resolved && !selected && h('button.link', { onclick: () => { S.sel = { scene: S.sel.scene, note: n.id }; emit('select'); } }, 'Reply'),
      !draft && h('button.link', { class: n.resolved ? 'reopen' : 'done', onclick: () => commit([{ op: 'note.set', id: n.id, fields: { resolved: !n.resolved } }]) }, n.resolved ? 'Reopen' : 'Mark done'),
    ),
    selected && !draft && !n.resolved && h('div.reply-box', draftBox(`reply:${n.id}`, 'Reply…', (text, files) => commit([{ op: 'reply.add', note: n.id, reply: { text, ...(files.length ? { files } : {}) } }]), { label: 'Reply' })),
  );
}

// A render request: what was asked for, at what size and quality.
function requestLine(n) {
  const d = renderSize(S.board, n.render.size), still = n.at != null;
  return h('div.note-render', h('span.nr-icon', { html: icons.render }), h('b', `Render ${renderLabel(n)}`),
    h('span.nr-spec', still ? `one ${d.w}×${d.h} still · PNG` : `${d.w}×${d.h} · ${qualityWords(S.board, renderQuality(n.render))} · ${renderCodec(n.render, false)}`));
}

// A marked-up frame: the picture with the marks, and each mark's words by number. Click to open it.
function markupBlock(n) {
  const open = e => { e.stopPropagation(); openAnnotator({ note: n.id }); };
  const editable = n.author === 'you' && !n.sent;
  return h('div.note-marks',
    n.markup.image && h('button.nm-pic', { title: editable ? 'Open the marks to change them' : 'Open the marks', onclick: open }, h('img', { src: mediaUrl(n.markup.image), alt: '', loading: 'lazy' })),
    h('ol.nm-list', n.markup.marks.map(m => h('li', { onclick: open },
      h('span.mk-n', { style: { '--mc': m.color, color: ink(m.color) } }, String(m.n)),
      h('span', m.text || h('em', `${m.kind === 'rect' ? 'a box' : m.kind === 'stroke' ? 'a stroke' : m.kind === 'arrow' ? 'an arrow' : 'a point'}, no words`))))),
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
  const boardNotes = shown.filter(n => !n.scene && !n.soundtrack);
  if (boardNotes.length) groups.push({ key: 'board', head: h('div.ngroup-head', h('i', { style: { '--c': 'var(--faint)' } }), h('b', 'Whole film')), notes: boardNotes });
  const soundNotes = shown.filter(n => n.soundtrack).sort(byTime);
  if (soundNotes.length) groups.push({ key: 'soundtrack', head: h('div.ngroup-head', h('span.ng-icon', { html: icons.wave }), h('b', 'Soundtrack')), notes: soundNotes });
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
      : h('div.sec', h('div.empty-notes', { title: 'Write as many notes as you like; Send to Claude sends them all at once' }, noteFilter === 'open' ? 'No open notes. Press C to write one.' : noteFilter === 'done' ? 'Nothing resolved yet.' : 'No notes yet.')),
  ];
}

// ---------------------------------------------------------------- activity

// Every change, newest first. An agent's change can be reverted from here (your own undo is ⌘Z).
// A long batch (thirty titles at once, say) shows its first lines until asked for the rest, and a run of
// the same kind of change (an agent taking old versions off a scene one by one) shows as one row, with
// how many more like it, until asked for them.
const unfolded = new Set();
const kindOf = s => s.replace(/\b[rsnm]\d+\b/g, '#').replace(/\d+(\.\d+)?/g, '0');
function runs(list) {
  const out = [];
  for (const e of list) {
    const last = out.at(-1), one = e.summaries.length === 1;
    if (last && one && last.head.summaries.length === 1 && e.author === last.head.author && kindOf(e.summaries[0]) === kindOf(last.head.summaries[0])) last.more.push(e);
    else out.push({ head: e, more: [] });
  }
  return out;
}
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
      j.later > 0 && h('p.warn', `${plural(j.later, 'later change')} came after this one. Anything built on it goes too.`),
      h('div.row', h('button.text-btn', { onclick: () => closeMenu() }, 'Cancel'),
        h('button.text-btn.primary', { onclick: async () => { closeMenu(); if (await commit(j.ops)) toast(`Reverted rev ${e.rev} · ⌘Z brings it back`); } }, 'Revert')),
    );
    menu(Math.max(8, at.right - 330), at.bottom + 6, [], { el: pop });
  };
  const row = e => {
    const you = e.author === 'you';
    const agent = !you && e.author !== 'storyboard';
    const long = e.summaries.length > 5, folded = long && !unfolded.has(e.rev);
    return h('div.act-row',
      h('span.avatar', { class: you ? '' : 'claude', html: you ? 'Y' : icons.spark }),
      h('div',
        h('div.what', (folded ? e.summaries.slice(0, 3) : e.summaries).map((s, i) => h('div', i === 0 && h('b', `${authorName(e.author)} `), s)),
          long && h('button.link.more', { onclick: () => { folded ? unfolded.add(e.rev) : unfolded.delete(e.rev); render(); } }, folded ? `and ${e.summaries.length - 3} more` : 'Show less')),
        h('div.when', `${ago(e.created)} · rev ${e.rev}`, agent && h('button.link.revert', { title: 'Undo this change (shows what it will do first)', onclick: ev => revert(e, ev) }, 'Revert')),
      ),
    );
  };
  return h('div.activity', runs(S.activity.slice(0, 150)).map(({ head, more }) => {
    if (!more.length) return row(head);
    const key = `run:${head.rev}`, open = unfolded.has(key);
    return [row(head),
      h('button.link.more.act-run', { onclick: () => { open ? unfolded.delete(key) : unfolded.add(key); render(); } }, open ? 'Show less' : `and ${plural(more.length, 'more change')} like it`),
      open && more.map(row)];
  }));
}

// ---------------------------------------------------------------- wiring

on('board', render);
on('select', render);
// Claude starting or finishing work on this scene changes its versions.
let sayKey = '';
on('presence', () => {
  const s = activeSay();
  const k = `${claudeState(S.board?.owner).key}|${s ? `${s.scene}|${s.progress}|${s.text}` : ''}`;
  if (k === sayKey) return;
  sayKey = k;
  if (S.tab === 'scene') render();
});
// As the playhead crosses into another scene: "you are here" in the Notes panel, and the Edit pane when
// it follows the playhead (no scene selected). Never while you're typing in the pane.
let hereId = null;
on('time', () => {
  const id = S.board?.scenes.length ? here()?.scene.id : null;
  if (id === hereId) return;
  hereId = id;
  if (panel.contains(document.activeElement)) return;
  // The playhead moved on to another scene: the one you clicked was where you were, and now the pane (and the
  // timeline's highlight) follow where you are.
  if (S.sel.scene && id && S.sel.scene !== id) { S.sel = { scene: null, note: null }; emit('select'); }
  if (S.tab === 'notes' || (S.tab === 'scene' && S.view === 'edit' && !scene(S.sel.scene))) render();
});
on('view', render);
on('activity', () => { if (S.tab === 'activity') render(); });
on('focus-title', () => requestAnimationFrame(() => { const t = $('#sceneTitle'); if (t) { t.focus(); t.select(); } }));
setInterval(() => { if (!panel.contains(document.activeElement)) render(); }, 30000);
