// The full agent manual, served in topics at GET /agent/help/<topic> (and whole at /agent/help/all,
// or `sb manual all`). It is generated, so the board list, URLs and example ids are always real ones
// from this machine. GET /agent itself serves the short overview below.

import { totalDuration } from './ops.js';
import { STYLE_KIT, canvas } from './sketch.js';

export function manual({ base, boards = [], root, home = `${root}/boards`, read }) {
  const sample = boards[0] && read ? read(boards[0].slug) : null;
  const b = boards[0]?.slug || 'my-film';
  const sc = sample?.scenes || [];
  const S1 = sc[0]?.id || 's1', S2 = sc[1]?.id || 's2', S3 = sc[2]?.id || sc[0]?.id || 's3', SL = sc.at(-1)?.id || 's4';
  const N1 = sample?.notes[0]?.id || 'n1';
  const A = `${base}/agent`;
  const B = `${A}/boards/${b}`;
  const J = `-H 'content-type: application/json'`;
  const rows = boards.length
    ? boards.map(x => `| \`${x.slug}\` | ${x.title} | ${x.scenes} | ${x.duration.toFixed(2)}s | ${x.open} | ${x.rev} | ${base}/#${x.slug} |`).join('\n')
    : '| (none yet) | create one with `POST /agent/boards` | | | | | |';

  return `# Storyboard: the agent manual

This is a storyboard the user and you (an AI agent) edit together. The user works in a video-editor
style page in their browser; you work through this HTTP API. **You never need the page.** Every
change you make shows up in the user's editor immediately, and theirs show up here.

- This is the full manual (\`GET ${A}/help/all\`). \`GET ${A}\` is the short overview, and
  \`GET ${A}/help/<topic>\` serves one part of this (${Object.keys(TOPICS).join(', ')}).
- The user's editor for a board: \`${base}/#<board>\`. Give them that link when you want them to look.
- CLI: \`${root}/sb\` does the same things from a shell (\`sb help\`). It also works when the server is
  down, by writing board.json directly. It uses the server on port 8840 and the boards in
  \`${root}/boards\`, unless \`SB_PORT\` and \`SB_HOME\` say otherwise.${home !== `${root}/boards` ? ` **This server keeps its boards in \`${home}\`, so run sb with \`SB_HOME=${home} SB_PORT=${base.split(':').pop()}\`.**` : ''}
- If a request is refused because nothing is listening, run \`${root}/sb start\`. It starts the server in
  the background and returns once the server is up.
${sample ? `- The examples below use real ids from the board \`${b}\`.\n` : ''}
## Boards right now

| board | title | scenes | length | open notes | rev | user's link |
|---|---|---|---|---|---|---|
${rows}

## Start from the idea; you don't need renders

A storyboard comes before the work. When a film is just an idea, lay the whole thing out right away,
with nothing rendered:
- One **idea scene** per shot or beat of the story. Give each a title, a duration (in bars, if there
  is music), the \`picture\` (what we see) and the \`sound\` (what we hear).
- Give each one a **sketch**, a rough version in whatever medium fits the shot. See "Sketches" below.
  - A **code sketch**: a few lines of canvas or WebGL that draw the motion from \`t\`. It plays live in the
    user's editor.
  - An **SVG drawing** of the composition.
  - Any quick **still or clip**.
- One \`POST /ops\` request can create the board's whole layout, sketches included.

The user sees it straight away in their editor. Scenes with a sketch show it; scenes without one show a
text card. They can then play it against the music, reorder it and leave notes. Render a shot only
once the idea holds. The render becomes a new version and the sketch stays as the earlier one.

## The loop

1. **Read.** \`GET ${B}\` gives the board as a shot list: every scene with its id, times, status,
   picture and sound text, its active render, and the open notes. It also says whether the user has
   the editor open right now. Note the \`rev\` in its second line.
2. **Look.** You can see the film without playing it. Open these images:
   - \`GET ${B}/sheet?format=path\`: every scene in order on one page.
   - \`GET ${B}/scenes/${S3}/strip?n=6&format=path\`: six frames across one scene, with pinned notes marked.
   - \`GET ${B}/frame?note=${N1}&format=path\`: the exact frame a note points at, with its pin.
3. **Act.** \`POST ${B}/ops\` changes the cut: add, edit, move, split or remove scenes, set statuses
   and text, and draw sketches. \`POST ${B}/renders\` puts a still or a clip from disk onto a scene as a
   new version.
4. **Answer.** The user sees where each note stands. Notes you've been given show as read by themselves.
   When you start on one, \`note.set\` with \`working: true\`. When it's done, send \`reply.add\`, then \`note.set\`
   with \`resolved: true\`.
   If you disagree or need a decision, reply and leave the note open.
5. **Tell.** During slow work, \`POST ${B}/say\` puts a status line in the user's top bar.
   \`POST ${B}/focus\` moves their playhead to what you are talking about.
6. **Listen.** Whenever you aren't actively working on the board, keep \`${root}/sb -b ${b} wait\` running
   **in the background**. The user adds notes, then presses **Send to Claude**; it returns at that moment
   with the notes they sent. Handle them, then start it again. It's the only way the user's notes reach you:
   nothing else notifies your session. It survives server restarts; the plain HTTP form
   (\`GET ${B}/wait?on=send&timeout=86400\`) doesn't.

**Own the board.** When you create a board, or start working on one, set yourself as its owner:
\`{"op":"board.set","fields":{"owner":"<your session's name>"}}\`. Your session's name is the one other
sessions use to message you. The user sees it, and it's who their notes are addressed to.

**Don't start on notes the user hasn't sent; start on sent ones at once.** The user annotates first and
sends when they're done. Unsent notes don't appear anywhere you read, and the shot list only says how many
are still being written. Sending means the notes are ready to work on: begin on those scenes without
asking. Don't re-render anything unless a note asks for it.

## Concepts

- **Board.** It has:
  - \`title\`, a short \`brief\` saying what the film is, and a longer \`treatment\` (the full plan).
  - \`project\`: the folder with the code that renders the film.
  - \`owner\`: the agent session working on the board (set it to your session's name).
  - \`fps\`, \`width\` and \`height\`.
  - \`bpm\`: null if the film isn't tempo-locked. Also \`beatsPerBar\` and \`beatOffset\`.
  - A soundtrack, scenes, notes and markers.
- **rev.** Goes up by exactly one per write request, whoever makes it. A batch of 10 ops is one rev.
  Status lines and focus don't change it.
- **Scene.** One shot or section. Scenes play end to end in order, with no gaps; a scene's start time
  is the sum of the durations before it. Its fields:
  - \`title\`, and \`duration\` in seconds.
  - \`picture\` (what we see) and \`sound\` (what we hear).
  - \`status\`: \`idea\`, \`draft\`, \`review\` or \`approved\`.
  - \`color\`: a label colour as hex (\`"#6f8ed6"\`), or null. The user sees it on the timeline, and the
    contact sheet and shot list show it. Good for marking acts. The editor's palette is #8b8f98, #c47a5a,
    #cfa25a, #8aa86a, #5fa39b, #6f8ed6, #977dcf and #c3719a.
  - \`renders\` (every version, oldest first) and \`activeRender\` (the one that plays).
  - \`meta\`: free JSON for you, for example the command that made the render.
- **Render.** A still or a clip on a scene.
  - A clip plays from the scene's start; if it is shorter than the scene, its last frame holds.
  - A scene with no render shows as a storyboard card (title, picture and sound text).
  - Clips are stored as scrub-friendly proxies up to 1920 wide. \`source\` is the original path, and
    \`caption\` is a short label for the version.
- **Note.** A message from the user (or from you), with \`replies\`. The user writes notes in a bar under
  the editor's monitor, so every note says what it's about, and the shot list leads each one with that:
  - **FRAME**: \`at\` is set. The note is about that one exact frame, for example "this frame looks bad".
    Look at it with \`GET ${B}/frame?note=<n>\`; a spot the user marked is drawn on it.
  - **WHOLE SCENE**: \`at\` is null. The note is about the whole shot, for example "this scene needs to be
    redone". Look at \`/scenes/<s>/strip\`.
  - **WHOLE BOARD**: \`scene\` is null.

  Open notes show on the user's timeline until they're resolved: a pin for a frame note, a bar across the
  scene for a scene note. The user adds notes while they review and sends them together; you only ever see
  sent notes (\`sent\` is when). The fields:
  - \`scene\`, or null for the whole board.
  - \`at\`: seconds into the scene, so the note moves with its scene.
  - \`pin\`: \`{x, y}\` from 0 to 1 across and down the frame.
  - \`resolved\`.
- **Marker.** A labelled absolute time on the music (\`t\`, \`label\`). Markers don't move with scenes.
- **Ids.** Scenes are \`s1…\`, renders \`r1…\`, notes \`n1…\`, markers \`m1…\`. They never change and are
  never reused, even after a delete. Unknown ids produce errors that list the valid ones.
- **Authors.** The user is \`you\`. You are \`claude\` unless you pass \`"as": "<name>"\` in a write and
  \`as=<name>\` in a wait. If several agents work on one board, give each its own name.

## Timing

- All times and durations are in seconds. Durations snap to whole frames at the board's fps.
- With a bpm, one beat is \`60 / bpm\` seconds.
  - Beats are counted from 0: beat n is at \`beatOffset + n × 60 / bpm\`. When the picture or sound text
    says "b8", it means beat 8.
  - Bars are counted from 1, as on the editor's ruler: bar m starts at beat \`(m − 1) × beatsPerBar\`.
- Anywhere a length in seconds is expected (a \`duration\`, a split's \`at\`, a note's \`at\`), you can
  give musical time instead: \`{"bars": 1}\`, \`{"beats": 2}\`, or both (\`{"bars": 1, "beats": 2}\`).
- A marker's \`t\` is a position: \`{"beat": 30}\` (counted from 0) or \`{"bar": 8}\` (the bar's first beat).
- Musical time needs a board with a bpm. Results snap to whole frames, so they can land up to half a
  frame off the exact beat.
- \`GET ${B}/at?t=12.4\`, \`?beat=30\` or \`?bar=8\` converts between seconds, beats, bars and scenes.
  Its "bar 8, beat 3 of 4" counts beats within a bar from 1, as musicians do. So beat 30, counted from 0,
  is the third beat of bar 8.
- Times of day (created, and log entries) are UTC, marked with Z.

## Reading

Every GET returns text meant for you to read. Add \`?format=json\` for the same data as JSON.

| request | returns |
|---|---|
| \`GET ${A}/boards\` | every board, with counts |
| \`GET ${B}\` | the shot list. \`?notes=all\` includes resolved notes; \`?format=json\` returns the whole board.json |
| \`GET ${B}/scenes/${S1}\` | one scene, with every render version and every note on it |
| \`GET ${B}/notes\` | open notes with replies. \`?all=1\` includes resolved ones |
| \`GET ${B}/log?since=0\` | changes after a rev, oldest first: rev, UTC time, author, and one sentence per op. \`&author=you\` gives the user's only. The JSON entries are \`{rev, author, created, changes, inverse}\` |
| \`GET ${B}/wait?since=<rev>&timeout=600\` | see "Waiting" below |
| \`GET ${B}/at?t=12.4\` | the scene, and the beat and bar, at a time (also \`?beat=\` or \`?bar=\`) |
| \`GET ${B}/presence\` | whether the user has the editor open, how many agents are waiting, and the current status line |

## Seeing (images)

Each image request saves a jpg under the board's \`frames/\` folder. By default it returns the jpg
itself. \`format=path\` returns only the file's path as plain text; \`format=json\` returns
\`{"path", "caption"}\`. Use one of those if your image viewer reads files.

| request | image |
|---|---|
| \`GET ${B}/sheet\` | a contact sheet of every scene in order, 480 px per tile. Each tile is labelled with its colour, id, times, length in bars, status, render and open notes, and captioned with its picture and sound text (\`?text=0\` leaves the captions off). Clip posters are taken 40% into each clip |
| \`GET ${B}/scenes/${S3}/strip?n=6\` | n frames (1–24) from the first frame to the last of one scene's active render, 560 px each, with pinned notes marked on the frame nearest their time |
| \`GET ${B}/frame?note=${N1}\` | the frame a note points at, with its pin as an orange square, up to 1280 px wide |
| \`GET ${B}/frame?scene=${S1}&at=1.2\` | a scene's frame 1.2 s in |
| \`GET ${B}/frame?t=12.4\` | the frame at 12.4 s into the cut |
| \`GET ${B}/frames?t=1,2.5,4\` | several moments (1–24 times in the cut) on one labelled image, to compare or check motion |
| \`GET ${B}/animatic?scale=0.5\` | **video**: the whole cut as one mp4 with the soundtrack. Clips are trimmed to their scenes, stills and SVG sketches hold, code sketches are drawn frame by frame, and empty scenes show their card. \`fps\` defaults to the board's. It's cached per rev. A long film of code sketches takes a minute or two; the request waits until it's ready. \`format=path\` or \`format=json\` return where it was saved. Use it to review motion and timing as a video, or to share the cut |

A scene without a render has no frames to show. These requests answer 409 and say so, but the
contact sheet draws such a scene as its card.

## Writing

### POST ${B}/ops

\`\`\`json
{ "ops": [ … ], "as": "claude", "expectRev": 42, "dryRun": false }
\`\`\`

- The ops apply atomically, in order: all of them or none.
- Fields are strict. An unknown field, on the op or on any object in it, is an error that suggests the
  nearest valid name. Nothing is silently dropped.
- \`expectRev\` (optional): if the board is no longer at that rev, nothing is applied, and you get a
  409 listing what changed since. Use it whenever you edit based on something you read earlier.
- \`dryRun: true\` checks the ops and reports what would happen, without applying anything.
- The response gives:
  - \`rev\`.
  - \`changes\`: one sentence per op.
  - \`created\`: the new ids, by kind.
  - \`inverse\`: ops that would undo this batch. POST them to take it back.
- Every rev's inverse is also kept in \`GET /log?format=json\`, so you can undo later. An inverse restores
  absolute values, so it also overwrites anything changed since. Check the log (or send
  \`expectRev\`) before undoing an old rev.

\`\`\`bash
curl -s -X POST ${B}/ops ${J} -d '{"expectRev": ${sample?.rev ?? 0}, "ops":[
  {"op":"scene.add","scene":{"title":"New shot","duration":2,"picture":"What we see…","status":"idea"},"after":"${S1}"},
  {"op":"scene.set","id":"${S2}","fields":{"status":"review","sound":"The drop lands on b8"}},
  {"op":"reply.add","note":"${N1}","reply":{"text":"Done: moved the sweep to b30"}},
  {"op":"note.set","id":"${N1}","fields":{"resolved":true}}
]}'
\`\`\`

Every op:

| op | shape and notes |
|---|---|
| \`scene.add\` | \`{"op":"scene.add","scene":{"title":…,"duration":…,"picture":…,"sound":…,"status":…,"color":…,"meta":{…}},"after":"${S1}"}\`. Place it with \`after\` or \`before\` (a scene id), or \`index\` (0-based: 0 is the start). The default is the end. Only title is needed; duration defaults to one bar (or 2 s without a bpm), and status to \`idea\`. \`"duration": {"bars": 1}\` also works |
| \`scene.set\` | \`{"op":"scene.set","id":"${S1}","fields":{…}}\` with any of title, duration, picture, sound, status, color, activeRender, meta. \`meta\` replaces the whole object, so include the keys you want to keep |
| \`scene.move\` | \`{"op":"scene.move","id":"${SL}","before":"${S1}"}\`. \`after\`, \`index\` (0-based), and \`"before": null\` for the end also work |
| \`scene.split\` | \`{"op":"scene.split","id":"${S1}","at":1.5}\` splits the scene 1.5 s in, or \`"at": {"beats": 2}\`. The second part comes right after it with the same text, no renders, and a new id (\`created\`); \`"title"\` names it |
| \`scene.remove\` | \`{"op":"scene.remove","id":"${SL}"}\`. Its notes stay, marked as belonging to a deleted scene; the inverse brings everything back |
| \`render.add\` | Use \`POST /renders\` instead: it prepares the media and then sends this op |
| \`render.remove\` | \`{"op":"render.remove","scene":"${S1}","id":"r1"}\`. The files stay on disk |
| \`note.add\` | \`{"op":"note.add","note":{"scene":"${S1}","text":"…","at":1.2,"pin":{"x":0.4,"y":0.6}}}\`. Only text is required; \`scene: null\` is a note on the whole board |
| files on notes | \`note.add\` and \`reply.add\` take \`"files": [{"path": "/abs/ref.png"}]\` (any file: stills, clips, PDFs); it's copied into the board. Notes with files list each as \`attached: <path>\`, so open it to see what the user means |
| \`note.set\` | \`{"op":"note.set","id":"${N1}","fields":{"resolved":true}}\`; \`{"working":true}\` shows the user you've started on it (resolving clears it); or text, scene, at or pin |
| \`note.remove\` | \`{"op":"note.remove","id":"${N1}"}\` |
| \`reply.add\` / \`reply.remove\` | \`{"op":"reply.add","note":"${N1}","reply":{"text":"…"}}\` / \`{"op":"reply.remove","note":"${N1}","index":0}\` |
| \`marker.add\` | \`{"op":"marker.add","marker":{"t":15,"label":"drop 2"}}\` |
| \`marker.set\` / \`marker.remove\` | \`{"op":"marker.set","id":"m1","fields":{"t":15.2,"label":"…"}}\` / \`{"op":"marker.remove","id":"m1"}\` |
| \`board.set\` | \`{"op":"board.set","fields":{…}}\` with any of title, brief, treatment, project, fps, width, height, bpm (null for none), beatsPerBar, beatOffset |
| \`sketch.add\` | \`{"op":"sketch.add","scene":"${S1}","code":"…","caption":"…"}\` (or \`"svg"\`, or \`"path"\`) adds a sketch to a scene as a new version, which becomes the active one (\`"activate": false\` keeps the current one). See "Sketches". A \`scene.add\` can also carry \`"sketch"\` |
| \`sketch.set\` | \`{"op":"sketch.set","scene":"${S1}","id":"r1","code":"…"}\` replaces that version's sketch in place: same id, no new version |
| \`sketchLib.set\` | \`{"op":"sketchLib.set","code":"…"}\` sets the board's shared library for code sketches (\`null\` removes it) |
| \`render.set\` | \`{"op":"render.set","scene":"${S1}","id":"r1","fields":{"caption":"…","sketch":false}}\` changes a version in place. Its fields are caption and sketch, plus the media fields the sketches folder uses |
| \`audio.set\` | Use \`POST /audio\` instead; \`{"op":"audio.set","audio":null}\` removes the soundtrack |

### POST ${B}/renders: put a still or a clip on a scene

\`\`\`bash
curl -s -X POST ${B}/renders ${J} -d '{"scene":"${S3}","path":"/abs/path/out/shot_v2.mp4","caption":"wave starts at the left edge"}'
\`\`\`

- \`path\` is a file on this machine: png, jpg, webp, gif, tif or avif for a still; mp4, mov, m4v, webm, mkv
  or avi for a clip. \`~\` is expanded.
- The file is added as a new version and becomes the one that plays (\`"activate": false\` to skip that).
- \`"fit": true\` sets the scene's duration to the clip's length, rounded up to a whole frame so all of
  the clip shows. For example, 3.75 s at 25 fps is 93.75 frames, which becomes 94 frames, or 3.76 s.
- \`"keep": true\` stores the clip as it is instead of making a proxy.
- To make a new scene from the file, send
  \`{"new": {"title": "…", "after": "${S1}", "picture": "…", "duration": 2}, "path": "…"}\`.
  - Place it with \`after\`, \`before\` or \`index\`, as for \`scene.add\`.
  - A clip's duration defaults to its length, a still's to one bar.
  - The new scene's status defaults to \`draft\`, since it already has a picture.
- \`expectRev\` and \`dryRun\` work as they do for ops. A dry run checks the file and the placement, but
  doesn't prepare the media.
- A clip takes a few seconds to prepare, and the response comes back when it is ready.
  \`created.renders\` holds the new render id.
- **A whole film at once:** \`{"path": "/abs/out/film.mp4", "split": true}\` cuts the film at the scenes'
  times in the cut and puts each piece on its scene as a new version, in one rev (a few seconds per scene).
  \`"offset": 12.5\` if the file starts 12.5 s into the cut; \`"scenes": ["${S1}", "${S2}"]\` for just those.
  Scenes the file doesn't reach keep their versions, and the reply names them. Re-render a film, split it
  again, and the board shows the film as it is now.
- \`caption\` (or \`label\`) names the version; \`meta\` (any JSON) is kept with it.

### Other writes

| request | body |
|---|---|
| \`POST ${A}/boards\` | \`{"title":"…","fps":24,"width":1920,"height":1080,"bpm":120,"beatsPerBar":4,"brief":"…","project":"/abs/path"}\`. Only title is required; the defaults are 30 fps, 1920×1080, no bpm and 4 beats per bar. \`"size":"2560x1440"\` also works. The slug is made from the title (\`-2\` is added if it is taken), or from \`"slug"\`. Boards can't be deleted through the API; ask the user |
| \`POST ${B}/audio\` | \`{"path":"/abs/path/score.wav"}\` sets the soundtrack (wav, mp3, m4a, aac, flac, ogg, aif). \`{"clear":true}\` removes it. \`expectRev\` and \`dryRun\` work here too |
| \`POST ${B}/say\` | \`{"text":"Rendering a key frame","scene":"${S3}","progress":0.4}\` sets your status line in the user's top bar until you replace or clear it (\`{"text":null}\`). \`scene\` (optional) marks that shot as being worked on, on the timeline and in its versions; \`progress\` (optional, 0–1 or a percentage) shows how far along you are. Post again to update it. The editor hides it after 30 minutes. Read it back with \`GET /presence\` |
| \`POST ${B}/focus\` | \`{"scene":"${S3}"}\` (optionally with \`"t"\`: seconds into the scene), \`{"note":"${N1}"}\` or \`{"t":12.4}\`. Selects it in every open editor and moves the playhead there. The response says how many pages were open |

## Sketches: a rough version of a shot, in whatever medium fits

A sketch is a version of a shot marked as rough, not the final render. It plays in the editor like any
other version, and the shot list, the contact sheet and the version list all mark it as a sketch. When
the real render arrives it becomes the active version, and the sketch stays in the list. Choose the
medium by what the shot needs:

### 1. Code sketches, for motion

A short plain script, written the way the film's motion will be written. The user's editor runs it
live, synced to the playhead, so an idea board plays as a rough animatic.

\`\`\`js
const ctx = canvas.getContext('2d');          // or canvas.getContext('webgl2')
function draw(t, s) {
  // t: seconds into the scene. s.filmT: seconds into the whole cut (see below).
  ctx.fillStyle = '#0b0b0d';
  ctx.fillRect(0, 0, s.w, s.h);
  const r = 60 + 40 * Math.sin(s.beat * Math.PI);   // pulses on the beat
  ctx.fillStyle = '#f1ece4';
  ctx.beginPath(); ctx.arc(s.w / 2, s.h / 2, r, 0, Math.PI * 2); ctx.fill();
}
\`\`\`

- \`canvas\` is ${sample ? `${canvas(sample).w}×${canvas(sample).h}` : '1600 wide'}: 1600 wide, at the board's aspect.
- \`s\` tells the sketch where it is, both in the scene and in the film:

  | field | meaning |
  |---|---|
  | \`t\`, \`duration\`, \`progress\` | seconds into the scene, the scene's length, and 0–1 through it |
  | \`start\`, \`filmT\`, \`filmDuration\` | where the scene starts in the cut, seconds into the whole cut (\`start + t\`), and the cut's length |
  | \`frame\`, \`filmFrame\`, \`fps\` | the frame number in the scene and in the cut |
  | \`beat\`, \`bar\` | beats and bars into the scene (from 0 and from 1), if the board has a bpm |
  | \`filmBeat\`, \`filmBar\` | beats and bars into the cut, counting from \`beatOffset\` |
  | \`scene\`, \`index\`, \`w\`, \`h\` | the scene's id, its position (from 0), and the canvas size |

  These follow the cut: when a scene is retimed or reordered, the same code draws the new moment.
- **One continuous world** (a one-take film, a camera move across scenes): put the world in the board's
  shared library, and make each scene's sketch one line:
  \`function draw(t, s) { world(s.filmT, s); }\`.
- **The shared library** is a plain script that runs before every code sketch on the board. It can
  hold helpers, the palette, the world, \`ctx\`, and even a default \`draw\`.
  - The library runs in an outer scope and each sketch inside it. A sketch sees every library name and
    may redeclare (shadow) any of them, so self-contained sketches keep working.
  - A sketch with no \`draw\` of its own uses the library's.
  - Set it by saving \`sketches/_shared.js\`, or with the op \`{"op":"sketchLib.set","code":"…"}\`
    (\`"code": null\` removes it).
  - When the library changes, or a scene moves, the server redraws the affected posters and filmstrips
    by itself. The editor always runs the current code live.
- **\`draw(t, s)\` draws the whole frame from \`t\` alone.** No state may be carried between calls: the editor
  jumps around, and frames are drawn out of order. It's the same rule as a render pipeline.
- It must be a plain script, with no \`import\` or \`export\`. For canvas text, use \`"Helvetica Neue"\` or
  \`system-ui\`.
- The server checks that it parses, then draws it in headless Chrome to make its poster and filmstrip.
  If \`draw\` throws, the sketch is refused with the error and the time it happened at.
- In the editor, if a browser can't run the live frame, the monitor shows the drawn poster instead and
  says so.
- Frames, filmstrips and the contact sheet draw code sketches at the right times, so you can look at the
  motion. Try \`/scenes/<s>/strip\`.
- In the editor it runs sandboxed, with no access to the page or the API.

### 2. SVG drawings, for composition and layout

A rough drawing on storyboard paper. You send only the drawing: SVG elements on a canvas
**1600 wide and \`1600 × height / width\` high**${sample ? ` (${canvas(sample).w}×${canvas(sample).h} for \`${b}\`)` : ' (1600×900 for 16:9)'}.
The server puts it on paper, marks it SKETCH, and gives you these styles as \`class="…"\`:

${Object.entries(STYLE_KIT.classes).map(([k, v]) => `- \`${k}\`: ${v}`).join('\n')}

- Text sizes on the canvas: 44 px by default, \`title\` 64, \`note\` 36 and \`label\` 28. At 44 px, a
  character is about 24 px wide, so keep text 60 px or more from the edges.
- Arrowheads: \`url(#arrow)\` (red), \`url(#arrow-cam)\` (blue) and \`url(#arrow-ink)\` (the ink colour).
- \`"paper": "dark"\` gives dark paper with light ink, for films that are light on black.
- You can send a whole \`<svg>\` instead. Scripts, event handlers and outside links are removed.
- Broken XML is refused with the line and column.

\`\`\`xml
<ellipse class="mass" cx="800" cy="760" rx="520" ry="70"/>
<rect x="700" y="250" width="200" height="480" rx="14"/>
<path class="move" d="M260 420 Q 480 300 680 420" marker-end="url(#arrow)"/>
<text class="note" x="80" y="860">slow push in · lights on b24, b25, b26</text>
\`\`\`

### 3. A still or a clip, for everything else

A quick low-res render from the project's own pipeline (for example \`node render.js stills 3.9 --scale .25\`
or a short clip), a reference image, a frame grab. It's the same as a render, just marked as a sketch.

### How to add a sketch

- **The sketches folder.** This is the easiest: save a file named after the scene into
  \`${home}/<board>/sketches/\`, for example \`s3.js\`, \`s3.svg\`, \`s3.png\` or \`s3-wide.mp4\`.
  - It appears on s3 as a sketch version within a second or two.
  - Saving the same file again updates that version in place. A new file name makes a new version.
  - Files that can't be used, such as a code sketch that throws or a scene that doesn't exist, are listed at
    the end of \`GET /agent/boards/<b>\`.
- **In a batch.** Put \`"sketch"\` on a \`scene.add\`'s scene: \`{"code": "…"}\`, \`{"svg": "…"}\` or
  \`{"path": "/abs/file.png"}\`, optionally with \`"caption"\` and \`"paper"\`. A bare string means SVG.
  - A sketch on a new scene is drawn at the place in the cut where the batch puts that scene.
  - To add a sketch to an existing scene, use \`{"op":"sketch.add","scene":"${S1}","code":"…","caption":"…"}\`.
    The new version becomes the active one; \`"activate": false\` keeps the current one.
  - To **replace a version in place** (same id, no extra version), use
    \`{"op":"sketch.set","scene":"${S1}","id":"r1","code":"…"}\`.
- **As its own request.** \`POST ${B}/sketches\` with \`"scene":"${S1}"\`, or \`"new":{"title":…,"after":…,"duration":{"bars":1},"picture":…}\`
  for a new idea scene, plus one of \`svg\`, \`code\` or \`path\`.
  - \`"replace": "r1"\` swaps that version in place.
  - \`"preview": true\` draws an svg or code sketch to a jpg and returns its path, without touching the board:
    - It doesn't need a scene. Without one, the sketch is drawn as a scene starting at 0, lasting
      \`"duration"\` (default one bar).
    - With a scene, it's drawn at that scene's place in the cut.
    - \`"at": 1.5\` draws that moment (seconds into the scene). By default it's 40% in.
    - \`"n": 6\` draws a filmstrip of 6 frames instead (1 to 24).
  - \`expectRev\` and \`dryRun\` work here.
- **A file from disk.** \`POST /renders\` with \`"sketch": true\` marks a still or clip as a sketch.
  \`.svg\` and \`.js\` files are always sketches.

\`\`\`bash
curl -s -X POST ${A}/boards ${J} -d '{"title":"My film","fps":30,"bpm":120}'
curl -s -X POST ${A}/boards/my-film/ops ${J} -d '{"ops":[
  {"op":"scene.add","scene":{"title":"Pulse","duration":{"bars":2},"picture":"A white dot pulsing on the kick","sound":"Kick alone","sketch":{"code":"const ctx = canvas.getContext(\"2d\");\nfunction draw(t, s) {\n  ctx.fillStyle = \"#000\"; ctx.fillRect(0, 0, s.w, s.h);\n  const r = 30 + 30 * Math.exp(-6 * (s.beat % 1));\n  ctx.fillStyle = \"#fff\"; ctx.beginPath(); ctx.arc(s.w / 2, s.h / 2, r, 0, 7); ctx.fill();\n}"}}},
  {"op":"scene.add","scene":{"title":"Horizon","duration":{"bars":1},"picture":"The dot stretches into a line","sketch":"<line x1=\"200\" y1=\"450\" x2=\"1400\" y2=\"450\"/><path class=\"move\" d=\"M800 450 L1350 450\" marker-end=\"url(#arrow)\"/>"}}
]}'
\`\`\`

## Waiting

\`${root}/sb -b ${b} wait\` (in the background) is the way to listen: it asks the endpoint below in stretches
from one fixed rev, carries on through server restarts and dropped connections, and exits with the reply
(exit 2 after \`--timeout\` seconds, a day by default, with nothing).

\`GET ${B}/wait?on=send&since=<rev>&timeout=86400&as=claude\`
- \`on=send\` (the default) returns when the user presses **Send to Claude**. The reply lists the notes they
  sent, in full, each with what it's about and how to look at it, plus any message sent with them.
  **This is how you receive notes.**
- \`on=change\` returns when anyone other than \`as\` changes anything on the board.
  - It gives the changes, one sentence each, and the new rev.
  - If there are already such changes when you call, it returns at once.
  - After the first change it waits 2.5 s more, so a burst of edits arrives together.
- \`since\` defaults to the current rev.
- Your own changes (those made as \`as\`) never wake a wait, and the reply says which revs were yours.
  Nor do the server's own poster redraws (author \`storyboard\`).
- \`timeout\` is in seconds, from 1 to 86400 (a day), default 600. On timeout it answers 200 and says there
  were no changes (with \`format=json\`: \`{"changed": false, …}\`); start it again to keep listening.
- To wait again without missing anything, call wait again with \`since\` set to the rev it returned.
- While a wait is open, the user's top bar says the board's owner is listening. When they press Send with
  nobody listening, the editor tells them so and gives them a message to paste into your session.

## Errors

Every error is JSON, \`{"error": "…"}\`, and names what was wrong and the valid choices. Request bodies are
checked as strictly as ops, so a misspelled field is an error, not ignored. The statuses:
- 400: a bad request.
- 404: an unknown board, id or endpoint.
- 409: a stale \`expectRev\`, or a scene with no frames to show.
- 415: the body wasn't sent as JSON. Send \`Content-Type: application/json\`.

## Etiquette

- Add renders as new versions. Don't remove the user's versions; they can switch between them.
- Don't delete or reorder the user's scenes unless they asked. Propose it in a note instead.
- Reply before you resolve, so the user can see what you did.
- Keep the picture and sound text like a shot list: concrete, visual and short. Timing is the durations.
- Record how each render was made in \`meta\`, for example \`{"cmd": "node render.js clip --from 7.5 --to 11.25"}\`,
  so you or another agent can remake it.
- If the board has a \`project\`, that folder holds the code that renders the film.

## Files

Boards live in \`${home}/<board>/\`:
- \`board.json\`: the whole board, pretty-printed.
- \`log.jsonl\`: every change.
- \`media/\`: proxies, posters, filmstrips and the soundtrack.
- \`frames/\`: the images from the requests above.

Hand edits to board.json are picked up while the server runs, but only the API checks them.
`;
}

// ---------------------------------------------------------------- the short overview and topics
// GET /agent is deliberately short: the boards, the rules and one line per capability. Anything
// deeper is a topic, fetched only when an agent needs it (GET /agent/help/<topic>).

export function overview({ base, boards = [], root = '~/dev/storyboard' }) {
  const A = `${base}/agent`;
  const current = boards.filter(x => !x.archived);
  const more = current.length - 10;
  const rows = current.length
    ? current.slice(0, 10).map(x => `- \`${x.slug}\` ${x.title} · ${x.scenes} scenes${x.open ? ` · ${x.open} open note${x.open > 1 ? 's' : ''}` : ''}${x.owner ? ` · owner ${x.owner}` : ''}`).join('\n') + (more > 0 ? `\n- …and ${more} older (GET ${A}/boards)` : '')
    : '- none yet (create one: POST /agent/boards)';
  return `# Storyboard agent API
You and the user share storyboards. They use the editor (${base}/#<board>); you use this API, never the page.
All paths below are under ${A}/boards/<board>.

Boards:
${rows}

Rules:
- New film: lay out the idea first, before building anything: idea scenes, each with a sketch (a code sketch
  for motion, SVG for composition, or a quick still). Then look at /sheet and let the user react.
- Own the board you work on: POST /ops {"ops":[{"op":"board.set","fields":{"owner":"<your session name>"}}]}
- When idle, keep \`${root}/sb -b <board> wait\` running in the background, and start it again when it returns.
  It returns when the user presses Send to Claude, with their notes, and it rides out server restarts.
  Nothing else delivers notes to you. (GET /wait?on=send&timeout=86400 is the same over HTTP, but dies with the server.)
- Sent notes are a go-ahead: start work on those scenes right away, without asking. Don't re-render unless a note asks for it.
- For each note: when you start it, {"op":"note.set","id":"n2","fields":{"working":true}}; look at it (the note gives
  the URL) and fix it; then {"op":"reply.add","note":"n2","reply":{"text":"…"}} and {"op":"note.set","id":"n2","fields":{"resolved":true}}.
  The user sees each step (reading marks notes read by itself).
- The first time you take up or create a board, end that reply with its link: Storyboard: ${base}/#<board>

Endpoints:
- read: GET (the shot list; ?compact=1 is shorter) · /scenes/<s> · /notes · /log?since=<rev>
- look (add ?format=path): /sheet (every shot) · /scenes/<s>/strip?n=6 · /frame?note=<n> or ?t=<s> · /frames?t=1,2.5,4 (several moments, one image)
- change: POST /ops {"ops":[…],"expectRev":<rev>} (all or nothing; dryRun:true to check)
- renders: POST /renders {"scene","path"} (a still or clip on disk becomes a new version);
  {"path":"/abs/film.mp4","split":true} cuts a whole film into a new version of every scene it covers
- sketches: POST /sketches {"scene","code"|"svg"|"path"}, or save sketches/s3.js|.svg|.png in the board folder
  (then GET /sketches?wait=1 waits until they're drawn and says what became of each file)
- tell the user: POST /say {"text","scene"?,"progress"?} (a status line; scene marks the shot you're on) · POST /focus {"scene"|"note"|"t"}
- video of the cut: GET /animatic?format=path
- new board: POST ${A}/boards {"title","fps","width","height","bpm"}

Details, only when needed: GET ${A}/help/<topic>, where <topic> is one of ${Object.keys(TOPICS).join(', ')} or all.
`;
}

// topic → the manual's sections (matched by the start of their heading)
const TOPICS = {
  ops: ['## Writing'],
  renders: [/^### POST \S+\/renders/],
  sketches: ['## Sketches'],
  code: ['### 1. Code sketches'],
  svg: ['### 2. SVG drawings'],
  notes: ['## Concepts', '## Waiting'],
  concepts: ['## Concepts'],
  timing: ['## Timing'],
  reading: ['## Reading'],
  images: ['## Seeing'],
  wait: ['## Waiting'],
  idea: ['## Start from the idea'],
  errors: ['## Errors'],
  etiquette: ['## Etiquette'],
  files: ['## Files'],
};

export function topic(name, opts) {
  const full = manual(opts);
  if (name === 'all') return full;
  const heads = TOPICS[name];
  if (!heads) return null;
  const lines = full.split('\n');
  // a heading is a # line outside code fences (bash comments inside them are not)
  let fence = false;
  const heading = lines.map(l => (l.startsWith('```') ? ((fence = !fence), 0) : !fence && /^#+ /.test(l) ? l.indexOf(' ') : 0));
  const out = [];
  for (const head of heads) {
    const level = head instanceof RegExp ? 3 : head.indexOf(' ');
    const i = lines.findIndex((l, k) => heading[k] && (head instanceof RegExp ? head.test(l) : l.startsWith(head)));
    if (i < 0) continue;
    let j = i + 1;
    while (j < lines.length && !(heading[j] && heading[j] <= level)) j++;
    out.push(lines.slice(i, j).join('\n').trim());
  }
  return out.join('\n\n') + '\n';
}
export const topicNames = () => [...Object.keys(TOPICS), 'all'];

// Board rows for the manual and GET /agent/boards.
export const boardRows = (list, read) =>
  list.map(x => {
    const b = read(x.slug);
    return { ...x, open: b.notes.filter(n => !n.resolved && n.sent !== null).length, owner: b.owner || '', duration: totalDuration(b) };
  });
