// The agent's view of a board: plain text that reads top to bottom like a shot list.
// Ids (s3, r7, n4) are what every `sb` command takes. Paths are absolute so an agent can open
// a poster or a clip directly.

import path from 'node:path';
import { layout, totalDuration, noteTime, activeRender, findScene, noScene, musical, kindName, clock, secs, plural, timecode, boardGaps, renderWords, renderLabel, renderTypeName, barBeat, aspectName, sceneRender, sceneRenderName, filmRenderTypes, RENDER_TYPES, cutPlan, versionWords, renderQuality } from './ops.js';

export function boardText(b, { slug, dir, notes = 'open', compact = false, treatment = false } = {}) {
  if (compact) return compactText(b, slug);
  const out = [];
  const total = totalDuration(b);
  out.push(`# ${b.title}`);
  out.push(
    [`board ${slug}`, `rev ${b.rev}`, `${aspectName(b)} (${b.width}×${b.height})`, `${b.fps} fps`, b.bpm && `${b.bpm} bpm (${b.beatsPerBar}/4)`, plural(b.scenes.length, 'scene'), secs(total)]
      .filter(Boolean)
      .join(' · '),
  );
  if (b.owner) out.push(`owner: ${b.owner} (the agent session working on this board)`);
  if (b.project) out.push(`project: ${b.project}`);
  const mix = renderMix(b);
  if (mix) out.push(`render: each scene is its own movie, made its own way (the cut joins them): ${mix}`);
  if (b.render) out.push(`default for scenes that don't say: ${renderTypeName(b)}${['draft', 'final'].map(q => (b.render[q] ? ` · ${q}: ${b.render[q]}` : '')).join('')}`);
  if (b.sketchLib) out.push(`shared sketch library: ${dir ? path.join(dir, b.sketchLib) : b.sketchLib} (runs before every code sketch)`);
  if (b.audio) out.push(`soundtrack: ${b.audio.name} · ${secs(b.audio.duration)}${dir ? ` · ${path.join(dir, b.audio.file)}` : ''}`);
  const gaps = boardGaps(b);
  if (gaps.length) out.push(`TO FILL IN (keep the board current): ${gaps.join(' · ')}`);
  if (b.brief) out.push('', indent(b.brief, ''));

  out.push('', '## Scenes');
  if (!b.scenes.length) out.push('(none yet — `sb add <title>`)');
  else if (slug) out.push(`(each scene's every version, full captions, commands and file paths: GET /agent/boards/${slug}/scenes/<s>)`);
  for (const row of layout(b)) out.push(...sceneLines(b, row, { dir, full: false }));

  // Notes the user hasn't sent yet: agents see only that they exist.
  const sent = b.notes.filter(n => n.sent);
  const drafting = b.notes.length - sent.length;
  const shown = sent.filter(n => notes === 'all' || !n.resolved);
  const open = sent.filter(n => !n.resolved).length;
  out.push('', notes === 'all' ? `## Notes (${sent.length}, ${open} open)` : `## Open notes (${open})`);
  if (!shown.length) out.push('(none)');
  for (const n of shown) out.push(...noteLines(b, n, slug, dir));
  if (drafting) out.push(`(The user hasn't sent ${plural(drafting, 'more note')} yet: notes reach you when they press Send to Claude, through GET /agent/boards/${slug}/wait?on=send. If they think they've sent you everything, tell them ${drafting > 1 ? 'these are' : 'it is'} still waiting in the editor.)`);

  if (b.markers.length) {
    out.push('', '## Markers');
    for (const m of b.markers) out.push(`${m.id.padEnd(4)} ${clock(m.t)}  ${m.label}`);
  }
  if (b.treatment) out.push('', ...treatmentLines(b.treatment.trim(), slug, treatment));
  return out.join('\n');
}

// A long treatment is the agent's own writing: the board shows its opening and its headings, and
// GET …?treatment=1 (or /treatment) gives it in full.
const TREATMENT_IN_FULL = 2000;
function treatmentLines(t, slug, full) {
  if (full || t.length <= TREATMENT_IN_FULL || !slug) return ['## Treatment', t];
  const lines = t.split('\n');
  const isHead = l => /^#{1,4} /.test(l);
  const first = lines.findIndex(isHead);
  const lead = (first < 0 ? t : lines.slice(0, first).join('\n')).trim();
  const heads = lines.filter(isHead).map(l => l.replace(/^#+ /, ''));
  return [
    `## Treatment (${t.length.toLocaleString('en')} characters; in full: GET /agent/boards/${slug}/treatment)`,
    ...(lead ? [lead.length > 600 ? lead.slice(0, 599) + '…' : lead] : []),
    ...(heads.length ? [`Its sections: ${heads.join(' · ')}`] : []),
  ];
}

// One line per scene and per open note: for re-reading a board cheaply.
function compactText(b, slug) {
  const rows = layout(b);
  const sent = b.notes.filter(n => n.sent && !n.resolved);
  const drafting = b.notes.filter(n => !n.sent).length;
  const out = [`${b.title} · ${slug} · rev ${b.rev} · ${b.fps} fps${b.bpm ? ` · ${b.bpm} bpm` : ''} · ${secs(totalDuration(b))}${b.owner ? ` · owner ${b.owner}` : ''}`];
  const gaps = boardGaps(b);
  if (gaps.length) out.push(`to fill in: ${gaps.join(' · ')}`);
  for (const { scene: s, index, start } of rows) {
    const r = activeRender(s);
    const how = sceneRender(b, s);
    out.push(`${s.id} ${String(index + 1).padStart(2, '0')} ${clock(start)} ${secs(s.duration)} ${s.status} “${s.title}”${how ? ` · ${sceneRenderName(how)}` : ''}${r ? ` · ${r.id} ${r.kind === 'code' ? 'code' : r.sketch ? 'sketch' : r.kind === 'video' ? 'clip' : 'still'}` : ''}`);
  }
  if (sent.length) out.push('open notes:');
  for (const n of sent) {
    const scope = n.render ? `RENDER ${renderLabel(n)} of ${!n.scene ? 'the whole film' : n.at != null ? `${n.scene} frame ${clock(noteTime(b, n))}` : n.scene}`
      : n.soundtrack ? (n.at != null ? `soundtrack ${clock(n.at)}` : 'soundtrack')
      : !n.scene ? 'board' : n.at != null ? `${n.scene} frame ${clock(noteTime(b, n))}` : `${n.scene} scene`;
    const t = (n.text || n.markup?.marks.map(k => k.text).filter(Boolean).join(' · ') || '').replace(/\s+/g, ' ');
    out.push(`${n.id} #${b.notes.indexOf(n) + 1} ${n.author} · ${scope}${n.working ? ' · working' : ''}${n.markup ? ` · ${plural(n.markup.marks.length, 'mark')}` : ''}${n.files ? ` · ${plural(n.files.length, 'file')}` : ''}${n.replies.length ? ` · ${plural(n.replies.length, 'reply', 'replies')}` : ''}${t ? `: ${t.length > 100 ? t.slice(0, 99) + '…' : t}` : ''}`);
  }
  if (drafting) out.push(`(${plural(drafting, 'more note')} not sent yet; sent notes arrive via wait?on=send)`);
  return out.join('\n');
}

export function sceneText(b, id, { dir, slug } = {}) {
  const row = layout(b).find(r => r.scene.id === id);
  if (!row) throw new Error(noScene(b, id));
  const s = row.scene;
  const out = sceneLines(b, row, { dir, full: true });
  if (Object.keys(s.meta || {}).length) out.push(`       meta: ${JSON.stringify(s.meta)}`);
  const ns = b.notes.filter(n => n.scene === s.id && n.sent);
  if (ns.length) {
    out.push('', `## Notes on ${s.id}`);
    for (const n of ns) out.push(...noteLines(b, n, slug, dir));
  }
  return out.join('\n');
}

export function notesText(b, { all = false, slug, ids = null, dir, drafts = false } = {}) {
  const shown = b.notes.filter(n => (n.sent || drafts) && (ids ? ids.includes(n.id) : all || !n.resolved));
  const drafting = b.notes.filter(n => !n.sent).length;
  const tail = drafting && !ids && !drafts ? `\n(The user hasn't sent ${plural(drafting, 'more note')} yet; notes arrive when they press Send to Claude. If they ask you to look now, or think they sent it: GET /agent/boards/${slug}/notes?drafts=1)` : '';
  if (!shown.length) return (all ? 'No notes.' : 'No open notes.') + tail;
  return shown.flatMap(n => noteLines(b, n, slug, dir)).join('\n') + tail;
}

function sceneLines(b, { scene: s, index, start, end }, { dir, full }) {
  const out = [];
  const len = `${secs(s.duration)}${b.bpm ? ` (${musical(b, s.duration)})` : ''}`;
  out.push(`${s.id.padEnd(4)} ${String(index + 1).padStart(2, '0')}  ${clock(start)}–${clock(end)}  ${len.padEnd(b.bpm ? 18 : 8)} ${s.status.padEnd(8)} ${s.title}`);
  const pad = '       ';
  if (s.color) out.push(`${pad}colour: ${s.color}`);
  if (s.picture) out.push(indent(`picture: ${s.picture}`, pad));
  if (s.sound) out.push(indent(`sound: ${s.sound}`, pad));
  const how = sceneRender(b, s);
  if (how?.own) out.push(indent(`made: ${howWords(how, full)}`, pad));
  else if (how && full) out.push(`${pad}made: as the film's default (${howWords(how, true)})`);
  const r = activeRender(s);
  if (full) {
    for (const x of s.renders) out.push(`${pad}${x.id === s.activeRender ? '▸' : ' '} ${renderLine(x, dir)}`);
  } else if (s.renders.length) {
    out.push(`${pad}render: ${r ? renderLine(r, dir, true) : 'none active'}${s.renders.length > 1 ? ` · versions ${s.renders.map(x => x.id).join(', ')}` : ''}`);
  }
  if (!full && Object.keys(s.meta || {}).length) out.push(`${pad}meta: ${JSON.stringify(s.meta)}`);
  const open = b.notes.filter(n => n.scene === s.id && !n.resolved && n.sent);
  if (!full && open.length) out.push(`${pad}open notes: ${open.map(n => n.id).join(', ')}`);
  return out;
}

// How a scene is made, in words: "ray traced · draft: 8 samples a pixel · final: 64 samples a pixel · 24 fps ·
// made with: …". brief (the shot list) leaves out the command and the footage, which the scene's own page has.
function howWords(h, full) {
  const cut = (t, n) => (!full && t.length > n ? t.slice(0, n - 1) + '…' : t);
  return [sceneRenderName(h), h.draft && `draft: ${cut(h.draft, 80)}`, h.final && `final: ${cut(h.final, 80)}`, h.fps && `${h.fps} fps (the cut conforms it)`, full && h.cmd && `made with: ${h.cmd}`, full && h.source && `footage: ${h.source}`].filter(Boolean).join(' · ');
}

// The film's ways, with how many scenes each: "raster ×6, edit ×3, ray traced ×1, not set ×2"; '' with no scenes
// made any way yet.
function renderMix(b) {
  const n = new Map();
  for (const s of b.scenes) { const t = sceneRender(b, s)?.type || null; n.set(t, (n.get(t) || 0) + 1); }
  if (![...n.keys()].some(Boolean)) return '';
  return [...filmRenderTypes(b).filter(t => n.has(t)).map(t => `${sceneRenderName({ type: t })} ×${n.get(t)}`), n.get(null) && `not set ×${n.get(null)}`].filter(Boolean).join(', ');
}

// brief (the board's shot list): the caption cut short, without the command or the poster, which the
// scene's own page has.
function renderLine(r, dir, brief = false) {
  const caption = r.caption && brief && r.caption.length > 80 ? r.caption.slice(0, 79) + '…' : r.caption;
  const bits = [r.id, `${kindName(r)}${r.kind === 'video' ? ` ${secs(r.duration)}` : ''}${r.sketch ? ' (not a render yet)' : ''}`, r.width && `${r.width}×${r.height}`, `by ${r.author}`, caption && `“${caption}”`];
  if (brief) return bits.filter(Boolean).join(' · ');
  bits.push(r.meta?.cmd ? `made with: ${r.meta.cmd}` : r.meta != null && `meta ${JSON.stringify(r.meta)}`);
  if (dir) bits.push(`poster ${path.join(dir, r.poster || r.file)}`);
  return bits.filter(Boolean).join(' · ');
}

// Marks the user drew on the frame, numbered, each where it is (fractions of the frame and pixels
// at the board's size) and what they wrote on it, then the picture with the marks drawn.
function markLines(n, dir, pad) {
  const m = n.markup;
  if (!m?.marks?.length) return [];
  const W = m.w || 1920, H = m.h || 1080;
  const pc = v => `${Math.round(v * 100)}%`;
  const X = v => Math.round(v * W), Y = v => Math.round(v * H);
  const out = [`${pad}marked up on ${m.render || 'the storyboard card'} (${W}×${H}), ${plural(m.marks.length, 'mark')}:`];
  for (const k of m.marks) {
    let where;
    if (k.kind === 'rect') where = `box x ${pc(k.x)}–${pc(k.x + k.w)}, y ${pc(k.y)}–${pc(k.y + k.h)} (px ${X(k.x)}–${X(k.x + k.w)} × ${Y(k.y)}–${Y(k.y + k.h)})`;
    else if (k.kind === 'point') where = `point at ${pc(k.x)} across, ${pc(k.y)} down (px ${X(k.x)}, ${Y(k.y)})`;
    else if (k.kind === 'arrow') where = `arrow from ${pc(k.x1)}, ${pc(k.y1)} to ${pc(k.x2)}, ${pc(k.y2)} (px ${X(k.x1)},${Y(k.y1)} → ${X(k.x2)},${Y(k.y2)})`;
    else {
      const xs = k.points.map(p => p[0]), ys = k.points.map(p => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      where = `brush stroke over x ${pc(x0)}–${pc(x1)}, y ${pc(y0)}–${pc(y1)} (px ${X(x0)}–${X(x1)} × ${Y(y0)}–${Y(y1)})`;
    }
    out.push(`${pad}  ${k.n}. ${where}${k.text ? `: “${k.text}”` : ''}`);
  }
  if (m.image) out.push(`${pad}  the frame with these marks drawn: ${dir ? path.join(dir, m.image) : m.image}`);
  return out;
}

// Files attached to a note or reply, as paths to open (images can be looked at directly).
function fileLines(files, dir, pad) {
  return (files || []).map(f => {
    const where = dir ? path.join(dir, f.file) : f.file;
    const bits = [f.kind, f.width && `${f.width}×${f.height}`, f.duration && secs(f.duration), f.poster && `poster ${dir ? path.join(dir, f.poster) : f.poster}`].filter(Boolean).join(', ');
    return `${pad}attached: ${where} (${bits}) “${f.name}”`;
  });
}

// A note leads with what it's about: FRAME (one exact frame, the user turned Frame on), WHOLE SCENE,
// WHOLE FILM or the SOUNDTRACK, so an agent can't miss whether "this looks bad" means a frame or a
// shot. A RENDER REQUEST says what to render and at what size.
function noteLines(b, n, slug, dir) {
  const s = findScene(b, n.scene);
  const t = noteTime(b, n);
  const music = t != null && barBeat(b, t);
  let about;
  const where = s ? `${s.id} “${s.title}”` : `deleted scene ${n.scene}`;
  if (n.render) about = `RENDER REQUEST: ${!n.scene ? 'the whole film' : n.at != null ? `the frame at ${clock(t)} (${timecode(t, b.fps)} in the editor, frame ${Math.round(t * b.fps)}) in ${where}` : where}, ${renderWords(b, n)}`;
  else if (n.soundtrack) about = t == null ? 'WHOLE SOUNDTRACK' : `SOUNDTRACK at ${clock(t)} (${timecode(t, b.fps)} in the editor${music ? `, bar ${music.bar} beat ${music.beat}` : ''})`;
  else if (!n.scene) about = 'WHOLE FILM';
  else if (!s) about = `DELETED SCENE ${n.scene}`;
  else if (n.at == null) about = `WHOLE SCENE ${s.id} “${s.title}”`;
  else about = `FRAME ${clock(t)} (${timecode(t, b.fps)} in the editor, frame ${Math.round(t * b.fps)} of the cut) in ${s.id} “${s.title}”, +${secs(n.at)} in`;
  const head = [`${n.id.padEnd(4)} #${b.notes.indexOf(n) + 1} ${n.author} · ${about}`, !n.sent && 'NOT SENT: the user hasn\'t sent it to you yet', n.pin && `spot at ${Math.round(n.pin.x * 100)}% across, ${Math.round(n.pin.y * 100)}% down`, n.resolved ? 'resolved' : n.working ? 'you marked it working' : null, short(n.created)]
    .filter(Boolean)
    .join(' · ');
  const out = [head];
  if (n.text) out.push(indent(n.text, '     '));
  out.push(...markLines(n, dir, '     '));
  out.push(...fileLines(n.files, dir, '     '));
  for (const r of n.replies) {
    out.push(indent(`↳ ${r.author}: ${r.text}`, '     '));
    out.push(...fileLines(r.files, dir, '       '));
  }
  if (n.resolved || !slug) return out;
  if (n.render && !n.scene && b.scenes.length) {
    const q = renderQuality(n.render), plan = cutPlan(b, n.render.size, q), miss = plan.filter(p => !p.render);
    const what = p => `${p.scene.id} (${p.how ? sceneRenderName(p.how) : 'how it is made: not set'}; has ${versionWords(p.active)})`;
    out.push(`     the cut: ${plan.length - miss.length} of ${plan.length} scenes have a render that fits${miss.length ? `; render first, each its own way: ${miss.map(what).join(', ')}` : ''}; then cut them together: sb cut --size ${n.render.size} --quality ${q}`);
  }
  if (n.render) out.push(`     how: render exactly this, ${n.scene ? 'the scene its own way' : 'each scene its own way'}: GET /agent/help/requests`);
  else if (n.soundtrack) out.push(`     listen: ${b.audio ? (dir ? path.join(dir, b.audio.file) : b.audio.file) : 'the board has no soundtrack now'}${t != null ? ` · on screen then: GET /agent/boards/${slug}/frame?note=${n.id}&format=path` : ''}`);
  else if (s) out.push(`     look: ${n.at != null ? `GET /agent/boards/${slug}/frame?note=${n.id}&format=path` : `GET /agent/boards/${slug}/scenes/${s.id}/strip?n=6&format=path`}`);
  return out;
}

const indent = (text, pad) => String(text).split('\n').map((l, i) => (i ? pad + '  ' : pad) + l).join('\n');
// Times of day are always UTC, marked with Z, everywhere an agent reads them.
const short = iso => (iso ? `${iso.slice(0, 16).replace('T', ' ')}Z` : '');

// The changes the user made on the board themselves, as Send hands them over: one line each, was → now.
// Long text is cut short; the board has all of it.
export function editsText(b, edits) {
  const quote = v => (v == null || v === '' ? 'empty' : `“${String(v).length > 500 ? String(v).slice(0, 499) + '…' : v}”`);
  const scene = e => `${e.scene} “${e.title ?? ''}”`;
  const NAMES = { title: 'title', duration: 'length', picture: 'picture', sound: 'sound', status: 'status', activeRender: 'the version that plays', render: 'way it is made', brief: 'brief', treatment: 'treatment', fps: 'frame rate', bpm: 'tempo', beatOffset: 'beat offset', beatsPerBar: 'beats per bar', audio: 'soundtrack', width: 'width', height: 'height' };
  const value = (f, v) => (f === 'duration' ? secs(v) : f === 'render' ? (v ? `${RENDER_TYPES[v.type]?.label.toLowerCase() || v.type}${v.final ? ` (final: ${v.final})` : ''}` : "the film's default") : f === 'audio' ? quote(v?.name) : ['status', 'activeRender', 'fps', 'bpm', 'beatOffset', 'beatsPerBar', 'width', 'height'].includes(f) ? String(v ?? 'none') : quote(v));
  return edits.map(e => {
    if (e.field === 'order') return `- the order of the scenes: was ${e.before.join(', ')} → now ${e.now.join(', ')}`;
    if (e.field === 'scene') return `- ${scene(e)}: ${e.now ? 'added' : 'deleted'}`;
    const where = e.scene ? `${scene(e)}, its ${NAMES[e.field]}` : `the board's ${NAMES[e.field]}`;
    return `- ${where}: was ${value(e.field, e.before)} → now ${value(e.field, e.now)}`;
  }).join('\n');
}
