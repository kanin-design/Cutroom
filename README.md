# Storyboard

A storyboard that you and Claude edit together. You work in an editor laid out like a video editor
(timeline, monitor, inspector). Claude works through an HTTP API made for agents (or `sb`, the same
thing as a command line). Changes from either side show up for the other right away.

```bash
node ~/dev/storyboard/server.js          # then open http://127.0.0.1:8840
~/dev/storyboard/sb start                # or in the background (sb stop to stop it)
curl -s http://127.0.0.1:8840/agent      # the agent overview (topics: /agent/help/<topic>)
```

There is nothing to install: Node 22 and ffmpeg are all it needs.

## The editor

- **Monitor.** Plays the cut, with the soundtrack as the master clock. Scenes with a render play that
  clip or show that still. Scenes without one show a storyboard card with their title, picture and
  sound. The timecode reads hours:minutes:seconds:frames; click it to type a time (2115 is
  00:00:21:15, +12 is twelve frames on). J K L play backwards, stop and play forwards (press again for
  2×, 4×, 8×). ⇧F plays it full screen.
- **Timeline.**
  - Scenes sit end to end. Drag one to reorder it.
  - Drag a scene's right edge to change its length. With snapping on, the length lands on the beat
    grid, or on cuts and markers. Alt-drag an edge to roll the cut between two scenes instead.
  - Pinch or ⌘-scroll to zoom. The ruler counts bars when the board has a tempo, or timecode.
  - Each scene has a colour line on top: its own colour, or one the editor picks so neighbours differ.
  - The Notes lane shows every note in time. The Audio lane shows the soundtrack's waveform.
  - Right-click the ruler to add a marker.
- **Notes to Claude.** Write in the bar under the monitor (press C).
  - It always shows what the note is about: the scene you're in (click to pick another, or the whole
    board). Turn on **Frame** (F) for the exact frame you're on.
  - **Mark up a frame** (double-click the picture, A, or the markup button): the frame opens large over the editor, zoomable. Draw
    boxes, brush strokes, arrows and points; each mark is numbered and asks what it's about ("this area is
    empty, looks bad"). ← → step frames. It saves as one note; Claude gets every mark with its exact place
    and the frame with the marks drawn on it. Marks show on the monitor on their frame; click to reopen.
  - Attach references: the paperclip, a drop, or ⌘V a screenshot. Stills and clips show as thumbnails.
  - Enter adds a note as a draft. Claude sees nothing until you press **Send to Claude** (⌘⏎); sending
    means it can start work (without re-rendering, unless a note asks for that).
  - Each note shows where it stands: Draft, Sent, Read (Claude has it), Working, Replied, Resolved.
  - Open notes sit on the timeline with their words: a frame note at its frame (a pin shape when it
    marks a spot), a scene note across its scene. A pin shows on the picture only on its own frame.
  - The Notes panel groups notes by scene, in the order of the cut; picking one takes you to it.
    ⇧↑ ⇧↓ jump from note to note.
- **Versions.** Every still, clip or sketch on a scene is kept, oldest to newest; click one to make it
  the one that plays. Drop a file onto a scene, the monitor or the Versions list to add one, onto empty
  timeline for a new scene, or onto the Audio lane for the soundtrack.
- **Board view (G).** The classic storyboard wall: one panel per scene, with the text underneath.
  Drag panels to reorder.
- **Claude, in the top bar.** Who owns the board, whether it's listening for your notes, and what it's
  doing, on which shot, and how far along (that shot shows it on the timeline too).
- **Activity.** Every change, yours or Claude's. Any agent change can be **reverted**: it shows what the
  revert will do first, and ⌘Z undoes the revert.
- **Boards.** The switcher lists boards newest first, with their owner, a dot when an agent is
  listening, and how many notes wait on you. Archive old boards to hide them (nothing is deleted).
- **Full screen.** The button at the top right puts the whole editor on the screen, like an app. In
  Chrome, Esc stays with the editor there: hold Esc, or click the button, to leave. For its own window
  and Dock icon, install it: Chrome's install button in the address bar, or Safari's File → Add to Dock.

Press `?` in the editor for every shortcut.

## Agents

An agent never uses the page. `GET /agent` serves a short overview (the current boards, the rules and
one line per capability); `GET /agent/help/<topic>` serves the detail for one topic, and
`/agent/help/all` the complete manual. (`curl http://127.0.0.1:8840/` gives the overview; browsers get
the editor.) The API covers:
- **Reading:** a shot-list view of a board, one scene, the notes, the change log.
- **Sketching:** a rough version of a shot, so a whole idea can be laid out before anything is rendered.
  It can be:
  - a code sketch: JS that draws the frame from `t`, which plays live in the editor;
  - an SVG drawing on storyboard paper;
  - any still or clip.

  To add one, save `s3.js`, `s3.svg`, `s3.png` or `s3.mp4` into the board's `sketches/` folder; saving it again
  updates it. The API works too. A sketch stays as an earlier version once the real render arrives.
- **Seeing:** a contact sheet of the whole board, frames across a scene, and the exact frame a note
  points at with its pin drawn. The sheets are drawn natively by `tools/sheet.swift`.
- **Changing:** atomic batches of ops, with dry runs, a check that the board hasn't changed since
  you read it, and ops that undo each batch.
- **Renders and sound:** put a still or a clip on a scene from a path on disk, cut a whole film into a
  new version of every scene in one call, and set the soundtrack.
- **Talking to you:** a status line in your top bar (optionally about one shot, with progress), and
  moving your playhead to what it's talking about. Replies and notes can carry files.
- **Listening:** `sb wait` returns when you send notes, and rides out server restarts.

The server started by `sb start` restarts itself when its own code changes (after checking the new code
parses, and falling back if it doesn't start), so agents never talk to an out-of-date server.

How agents find out about it:
- `AGENTS.md` and `CLAUDE.md` point any agent working in this folder to the manual.
- `skill/SKILL.md` is a Claude Code skill for agents working anywhere else. Link it into
  `~/.claude/skills/storyboard` to install it.
- A `.storyboard` file in a film's folder (`sb use <board>`) names its board, and a board's
  `project` field points back at the film's folder.

## How it works

- `server.js` keeps each open board in memory and applies every change as an op.
  - It saves `boards/<slug>/board.json` after each op.
  - It appends each op to `log.jsonl`.
  - It sends each op to every open page over Server-Sent Events.
  - It also notices when `board.json` is edited by hand.
- `lib/ops.js` is the only code that changes a board. The server, the CLI and the browser all use
  it, so the same ops in the same order always give the same board. Each op also returns its
  inverse, which is what undo uses.
- Media (`lib/media.js`):
  - Clips get a 1080p H.264 proxy with a keyframe every 12 frames, so scrubbing is instant.
  - Every clip gets a poster and a 10-frame filmstrip for the timeline.
  - Soundtracks get a peaks file for the waveform.
- Only this machine can reach the server: it listens on 127.0.0.1 and answers only to local host
  names.
