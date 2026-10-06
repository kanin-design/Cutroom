---
name: storyboard
description: Cutroom, the user's local storyboard app for films, showreels and videos (shot lists, timing, sketches, renders, the user's notes on frames). Use when planning, reviewing or delivering a film with the user (renders of a film that has a board go on the board), or when they mention Cutroom, the storyboard or a board.
---

# Cutroom

You and the user co-edit storyboards: they use the editor page, you use its HTTP API, never the page.
Run this first. It starts the server if it's down, then prints the overview: the boards, the rules and
every endpoint.

```bash
curl -sf http://127.0.0.1:8840/agent || { ~/dev/storyboard/sb start && curl -sf http://127.0.0.1:8840/agent; }
```

- **Follow its rules.** Above all:
  - When idle, keep `wait` running as a background task, and start it again after handling what it returns.
    It's the only way the user's notes reach you. Don't check on it or read its output file while it runs: it prints
    nothing until it returns, and you're told when it does.
  - Keep the board current without being asked: fill in its fields, put every new render on it right away with
    a caption and the command that made it, and keep one board per film. Reading the board lists what's missing.
  - **Every scene is its own little movie.** Each scene says how it is made in its own `render` (ray traced,
    raster, an edit of 4K footage, a screen capture…: its type, what draft and final mean for it, the command that
    renders it, its own frame rate), so one film mixes them; the board's `render` is only the default. Set it on a
    scene as soon as you know (`sb set s3 render.type=raytrace render.final="64 samples a pixel" render.cmd="…"`).
    The whole film is the cut of its scenes: render the scenes that need it, each its own way, then `sb cut --size
    4k --quality final` joins their renders, conformed to the film.
  - **A finished scene goes on the board as a preview.** When you finish a scene (built it, or changed it for a
    note), render that scene at preview quality (its own draft quality, at 720p) and put it on its scene right
    away, without being asked, so the board always plays the film as it is now. Render only the scenes you changed.
    A final, or a bigger size, only when the user asks (a render request). Ideas stay sketches until the user agrees
    on them.
- **For detail, fetch one topic** (`GET /agent/help/<topic>`) when you need it, never the whole manual.
- **Always end with the board's clickable link,** on its own line, in every reply that delivers or reports work on a
  film, not only the first: `Storyboard: http://127.0.0.1:8840/#<board>`. Work without a board (a sketch, a test, a
  reel in a temp folder) gets one first, so there is always a link to give. (The user, 2026-10-05: "give clickable
  link to storyboard always".)
- **If the server won't start,** use `~/dev/storyboard/sb` (`sb help`). It works on the board files
  directly, except `wait`, `say` and `focus`. Tell the user the server is down.
