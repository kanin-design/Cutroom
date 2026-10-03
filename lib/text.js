// The agent's view of a board: plain text that reads top to bottom like a shot list.
// Ids (s3, r7, n4) are what every `sb` command takes. Paths are absolute so an agent can open
// a poster or a clip directly.

import path from 'node:path';
import { layout, totalDuration, noteTime, activeRender, findScene, musical, kindName, tc, secs, timecode, boardGaps } from './ops.js';

export function boardText(b, { slug, dir, notes = 'open', compact = false } = {}) {
  if (compact) return compactText(b, slug);
  const out = [];
  const total = totalDuration(b);
  out.push(`# ${b.title}`);
  out.push(
    [`board ${slug}`, `rev ${b.rev}`, `${b.width}×${b.height}`, `${b.fps} fps`, b.bpm && `${b.bpm} bpm (${b.beatsPerBar}/4)`, `${b.scenes.length} scenes`, secs(total)]
      .filter(Boolean)
      .join(' · '),
  );
  if (b.owner) out.push(`owner: ${b.owner} (the agent session working on this board)`);
  if (b.project) out.push(`project: ${b.project}`);
  if (b.sketchLib) out.push(`shared sketch library: ${dir ? path.join(dir, b.sketchLib) : b.sketchLib} (runs before every code sketch)`);
  if (b.audio) out.push(`soundtrack: ${b.audio.name} · ${secs(b.audio.duration)}${dir ? ` · ${path.join(dir, b.audio.file)}` : ''}`);
  const gaps = boardGaps(b);
  if (gaps.length) out.push(`TO FILL IN (keep the board current): ${gaps.join(' · ')}`);
  if (b.brief) out.push('', indent(b.brief, ''));

  out.push('', '## Scenes');
  if (!b.scenes.length) out.push('(none yet — `sb add <title>`)');
  for (const row of layout(b)) out.push(...sceneLines(b, row, { dir, full: false }));

  // Notes the user hasn't sent yet are still being written: agents see only that they exist.
  const sent = b.notes.filter(n => n.sent);
  const drafting = b.notes.length - sent.length;
  const shown = sent.filter(n => notes === 'all' || !n.resolved);
  const open = sent.filter(n => !n.resolved).length;
  out.push('', notes === 'all' ? `## Notes (${sent.length}, ${open} open)` : `## Open notes (${open})`);
  if (!shown.length) out.push('(none)');
  for (const n of shown) out.push(...noteLines(b, n, slug, dir));
  if (drafting) out.push(`(The user is still writing ${drafting} more note${drafting > 1 ? 's' : ''}. Wait until they send them: GET /agent/boards/${slug}/wait?on=send)`);

  if (b.markers.length) {
    out.push('', '## Markers');
    for (const m of b.markers) out.push(`${m.id.padEnd(4)} ${tc(m.t)}  ${m.label}`);
  }
  if (b.treatment) out.push('', '## Treatment', b.treatment.trim());
  return out.join('\n');
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
    out.push(`${s.id} ${String(index + 1).padStart(2, '0')} ${tc(start)} ${secs(s.duration)} ${s.status} “${s.title}”${r ? ` · ${r.id} ${r.kind === 'code' ? 'code' : r.sketch ? 'sketch' : r.kind === 'video' ? 'clip' : 'still'}` : ''}`);
  }
  if (sent.length) out.push('open notes:');
  for (const n of sent) {
    const scope = !n.scene ? 'board' : n.at != null ? `${n.scene} frame ${tc(noteTime(b, n))}` : `${n.scene} scene`;
    const t = (n.text || n.markup?.marks.map(k => k.text).filter(Boolean).join(' · ') || '').replace(/\s+/g, ' ');
    out.push(`${n.id} #${b.notes.indexOf(n) + 1} ${n.author} · ${scope}${n.working ? ' · working' : ''}${n.markup ? ` · ${n.markup.marks.length} mark${n.markup.marks.length === 1 ? '' : 's'}` : ''}${n.files ? ` · ${n.files.length} file${n.files.length > 1 ? 's' : ''}` : ''}${n.replies.length ? ` · ${n.replies.length} repl${n.replies.length > 1 ? 'ies' : 'y'}` : ''}: ${t.length > 100 ? t.slice(0, 99) + '…' : t}`);
  }
  if (drafting) out.push(`(user is writing ${drafting} more note${drafting > 1 ? 's' : ''}; they arrive via wait?on=send)`);
  return out.join('\n');
}

export function sceneText(b, id, { dir, slug } = {}) {
  const row = layout(b).find(r => r.scene.id === id);
  if (!row) throw new Error(`no scene ${id}`);
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
  const tail = drafting && !ids && !drafts ? `\n(The user is still writing ${drafting} more note${drafting > 1 ? 's' : ''}; they'll arrive when sent. If they ask you to look at them now: GET /agent/boards/${slug}/notes?drafts=1)` : '';
  if (!shown.length) return (all ? 'No notes.' : 'No open notes.') + tail;
  return shown.flatMap(n => noteLines(b, n, slug, dir)).join('\n') + tail;
}

function sceneLines(b, { scene: s, index, start, end }, { dir, full }) {
  const out = [];
  const len = `${secs(s.duration)}${b.bpm ? ` (${musical(b, s.duration)})` : ''}`;
  out.push(`${s.id.padEnd(4)} ${String(index + 1).padStart(2, '0')}  ${tc(start)}–${tc(end)}  ${len.padEnd(b.bpm ? 18 : 8)} ${s.status.padEnd(8)} ${s.title}`);
  const pad = '       ';
  if (s.color) out.push(`${pad}colour: ${s.color}`);
  if (s.picture) out.push(indent(`picture: ${s.picture}`, pad));
  if (s.sound) out.push(indent(`sound: ${s.sound}`, pad));
  const r = activeRender(s);
  if (full) {
    for (const x of s.renders) out.push(`${pad}${x.id === s.activeRender ? '▸' : ' '} ${renderLine(x, dir)}`);
  } else if (s.renders.length) {
    out.push(`${pad}render: ${r ? renderLine(r, dir) : 'none active'}${s.renders.length > 1 ? ` · versions ${s.renders.map(x => x.id).join(', ')}` : ''}`);
  }
  if (!full && Object.keys(s.meta || {}).length) out.push(`${pad}meta: ${JSON.stringify(s.meta)}`);
  const open = b.notes.filter(n => n.scene === s.id && !n.resolved && n.sent);
  if (!full && open.length) out.push(`${pad}open notes: ${open.map(n => n.id).join(', ')}`);
  return out;
}

function renderLine(r, dir) {
  const bits = [r.id, `${kindName(r)}${r.kind === 'video' ? ` ${secs(r.duration)}` : ''}${r.sketch ? ' (not a render yet)' : ''}`, r.width && `${r.width}×${r.height}`, `by ${r.author}`, r.caption && `“${r.caption}”`,
    r.meta?.cmd ? `made with: ${r.meta.cmd}` : r.meta != null && `meta ${JSON.stringify(r.meta)}`];
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
  const out = [`${pad}marked up on ${m.render || 'the storyboard card'} (${W}×${H}), ${m.marks.length} mark${m.marks.length === 1 ? '' : 's'}:`];
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

// A note leads with what it's about: FRAME (one exact frame, the user turned Frame on), WHOLE SCENE
// or WHOLE BOARD, so an agent can't miss whether "this looks bad" means a frame or a shot.
function noteLines(b, n, slug, dir) {
  const s = findScene(b, n.scene);
  const t = noteTime(b, n);
  let about;
  if (!n.scene) about = 'WHOLE BOARD';
  else if (!s) about = `DELETED SCENE ${n.scene}`;
  else if (n.at == null) about = `WHOLE SCENE ${s.id} “${s.title}”`;
  else about = `FRAME ${tc(t)} (${timecode(t, b.fps)} in the editor, frame ${Math.round(t * b.fps)} of the cut) in ${s.id} “${s.title}”, +${secs(n.at)} in`;
  const head = [`${n.id.padEnd(4)} #${b.notes.indexOf(n) + 1} ${n.author} · ${about}`, !n.sent && 'DRAFT: not sent yet, the user is still writing it', n.pin && `spot at ${Math.round(n.pin.x * 100)}% across, ${Math.round(n.pin.y * 100)}% down`, n.resolved ? 'resolved' : n.working ? 'you marked it working' : null, short(n.created)]
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
  if (slug && s && !n.resolved) out.push(`     look: ${n.at != null ? `GET /agent/boards/${slug}/frame?note=${n.id}&format=path` : `GET /agent/boards/${slug}/scenes/${s.id}/strip?n=6&format=path`}`);
  return out;
}

const indent = (text, pad) => String(text).split('\n').map((l, i) => (i ? pad + '  ' : pad) + l).join('\n');
// Times of day are always UTC, marked with Z, everywhere an agent reads them.
const short = iso => (iso ? `${iso.slice(0, 16).replace('T', ' ')}Z` : '');
