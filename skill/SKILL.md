---
name: storyboard
description: The user's local storyboard app for films, showreels and videos (shot lists, timing, sketches, renders, the user's notes on frames). Use when planning, reviewing or delivering a film with the user (renders of a film that has a board go on the board), or when they mention the storyboard or a board.
---

# Storyboard

You and the user co-edit storyboards: they use the editor page, you use its HTTP API, never the page.

Run this first. It starts the server if it's down, then prints the overview: the boards, the rules
and every endpoint.

```bash
curl -sf http://127.0.0.1:8840/agent || { ~/dev/storyboard/sb start && curl -sf http://127.0.0.1:8840/agent; }
```

- **Follow its rules.** Above all, keep the background `wait` running whenever you're idle. It is the only
  way the user's notes reach you.
- **For detail, fetch one topic** (`GET /agent/help/<topic>`) only when you need it. Don't fetch the whole manual.
- **The first time you take up or create a board,** end that reply with its link on its own line:
  `Storyboard: http://127.0.0.1:8840/#<board>`.
- **If it won't start,** use `~/dev/storyboard/sb` (`sb help`). It works on the board files directly,
  except `wait`, `say` and `focus`. Tell the user the server is down.
