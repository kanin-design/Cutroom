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
  sound. Double-click the monitor to play or pause.
- **Timeline.**
  - Scenes sit end to end. Drag one to reorder it.
  - Drag a scene's right edge to change its length. With snapping on, the length lands on the beat
    grid, or on cuts and markers. Alt-drag an edge to roll the cut between two scenes instead.
  - Pinch or ⌘-scroll to zoom. The ruler counts bars when the board has a tempo.
  - The Notes lane shows every note in time. The Audio lane shows the soundtrack's waveform.
  - Right-click the ruler to add a marker.
- **Notes to Claude.** Write in the bar under the monitor (press C).
  - It always shows what the message is about: the scene you're in, with its colour, number and title.
    Click it to pick another scene or the whole board.
  - Turn on **Frame** (F) to make it about the exact frame you're on; the timecode and frame number show
    in the bar. Press P, or the pin in the bar, to also mark a spot on the frame.
  - Enter sends. Typing pauses playback, so the frame doesn't move.
  - Open notes stay on the timeline until they're resolved. A frame note is a pin with a line down
    through the clip at its exact frame; a scene note is a bar across the scene. Hover to read one, and
    click to open its thread.
  - Paused on a frame note's frame, you see the note on the monitor.
  - The Notes panel groups every note by scene, in the order of the cut. Each note is labelled FRAME
    (with its timecode, click to go there) or WHOLE SCENE. The scene you're in is marked.
  - Claude reads the same labels, can look at the exact frame you meant, replies in the thread, and
    resolves the note when it's done.
- **Renders.** Drop a still or a clip onto a scene, onto the monitor, or onto a scene's Renders list.
  Every version is kept; click one to make it the one that plays. Drop onto empty timeline to make
  a new scene from the file, or onto the Audio lane to set the soundtrack.
- **Board view (G).** The classic storyboard wall: one panel per scene, with the text underneath.
  Drag panels to reorder.
- **Activity.** Every change, whether yours or Claude's, with who made it and when. Scenes Claude has
  just touched glow on the timeline. The pill in the top bar shows what Claude is doing, and
  whether it is waiting for your edits.

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
- **Renders and sound:** put a still or a clip on a scene from a path on disk, and set the soundtrack.
- **Talking to you:** a status line in your top bar, and moving your playhead to what it's talking about.
- **Waiting:** a long-poll that returns when you edit the board.

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
