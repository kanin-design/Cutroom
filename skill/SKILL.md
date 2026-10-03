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
    It's the only way the user's notes reach you.
  - Keep the board current without being asked: fill in its fields, put every new render on it right away with
    a caption and the command that made it, and keep one board per film. Reading the board lists what's missing.
- **For detail, fetch one topic** (`GET /agent/help/<topic>`) when you need it, never the whole manual.
- **The first time you work on a board in a conversation,** end that reply with its link on its own line:
  `Storyboard: http://127.0.0.1:8840/#<board>`.
- **If the server won't start,** use `~/dev/storyboard/sb` (`sb help`). It works on the board files
  directly, except `wait`, `say` and `focus`. Tell the user the server is down.
