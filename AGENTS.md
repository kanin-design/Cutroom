# Cutroom, for agents

You work on boards through the agent API, never the web page. This starts the server if needed and
prints the overview (boards, rules, endpoints); topics are at `/agent/help/<topic>`:

```bash
curl -sf http://127.0.0.1:8840/agent || { ~/dev/storyboard/sb start && curl -sf http://127.0.0.1:8840/agent; }
```

Without the server, `sb help` (and `sb manual [topic]`) work on the board files directly.

**Never make a project in this folder. This is forbidden.** It (and any worktree of it under `.claude/worktrees/`)
holds only Cutroom's code and the board files Cutroom writes itself: no film, edit, render, sound, scratch file or
project folder, here or in `boards/`. A film gets its own folder, `~/dev/#VIDEO/<name>/` (the layout is in
`~/dev/#VIDEO/README.md`). If this session started here and the task is a film, make or open that folder, work there
by absolute paths, and tell the user the session was started in the wrong folder. Change Cutroom's code only when the
user asks for work on Cutroom itself.
