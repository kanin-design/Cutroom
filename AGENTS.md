# Cutroom, for agents

You work on boards through the agent API, never the web page. This starts the server if needed and
prints the overview (boards, rules, endpoints); topics are at `/agent/help/<topic>`:

```bash
curl -sf http://127.0.0.1:8840/agent || { ~/dev/storyboard/sb start && curl -sf http://127.0.0.1:8840/agent; }
```

Without the server, `sb help` (and `sb manual [topic]`) work on the board files directly.
