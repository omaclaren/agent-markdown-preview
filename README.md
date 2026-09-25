# agent-markdown-preview

A browser preview of **coding-agent responses** and **local files**, with math, Mermaid diagrams, syntax highlighting and annotation markers. It works with Claude Code, Codex and Pi, and doesn't need any of them to be running inside it. It reads the session logs each agent already writes.

The renderer is [pi-markdown-preview](https://github.com/omaclaren/pi-markdown-preview)'s browser renderer, extracted so it no longer depends on Pi. Output is byte-identical (see "Keeping the renderer identical").

## Use

```bash
agent-markdown-preview                 # in a project: index of its agent sessions
agent-markdown-preview --merged        # one preview: latest response from any session here
agent-markdown-preview notes.md        # follow a Markdown, LaTeX, code or diff file
```

By default the command opens a small **session index** for the directory. It lists the recently active Claude Code, Codex and Pi sessions, most recent first, each with its title (the agent's own title, or the first prompt), whether it is working, and when it was last active. The list updates live, so sessions started later appear automatically.

- Clicking a session opens its own live preview in a separate tab. Clicking it again returns to that tab.
- **All sessions (merged)** shows the latest finished response from any session. Each response is labelled with its source, e.g. `Claude Code 3f2a · 14:02`.
- Every response carries a small line saying where it came from, e.g. *Claude Code 3f2a · Review the hosting core · 14:02*.
- Every preview updates when a turn finishes. The page's history controls step back through earlier responses or file versions.
- Each preview starts with **recent history** from the logs: the last 10 finished responses (for the merged view, across all sessions, by time), with the newest shown. So the history is there as soon as a tab opens, and again after a restart. `--history <n>` changes the count (0–20; 0 = only the latest). File previews start with the current version only.
- Keyboard: **Option+←/→** steps through history; add **Shift** to jump to the oldest or latest revision.
- **Restarts don't strand tabs.** Each preview keeps its address (port and token) across restarts, and previews that were open are brought back when the index restarts. Open tabs reconnect by themselves, and a restart doesn't open a duplicate tab when an existing one reconnects. While the preview isn't running, a tab says so beside its controls. Addresses are remembered in `~/.agent-markdown-preview/servers.json` (private to you; `AGENT_MARKDOWN_PREVIEW_HOME` overrides the location). If a remembered port has been taken, the preview picks a new one and you reopen it from the index.

| Option | |
|---|---|
| `--merged` | Open the merged preview directly, without the index |
| `--session <path>` | Preview one session log directly (agent detected from its path or first line) |
| `--agent claude,codex,pi` | Agents to follow (default: all) |
| `--cwd <dir>` | Project directory whose sessions to follow |
| `--theme auto\|light\|dark` | Default `auto`: follow the system (browser) light/dark setting live; `light`/`dark` fix it |
| `--font-size <px>` | Base font size |
| `--history <n>` | Earlier responses each preview starts with (default 10, max 20; 0 = only the latest) |
| `--no-open` | Print the URL instead of opening a browser |

Requirements: Node 20+ and [pandoc](https://pandoc.org/installing.html) (`brew install pandoc`; set `PANDOC_PATH` if it isn't on `PATH`). Mermaid, MathJax fallbacks and PDF figures load from jsdelivr/unpkg in the browser, so those need a network connection.

Install from a checkout:

```bash
npm install && npm run build && npm link     # provides the agent-markdown-preview command
```

## How responses are found

Each agent appends its session to a JSONL file. For the directory, the tool follows every recently active session log: modified in the last 3 days, up to 8 per agent. Older sessions are not listed; they may be resumable in their agent, but nothing is running. Each log is read continuously from where it left off, so concurrent sessions of the same or different agents are all observed. It rescans every 2 s for new sessions (including `/clear`).

When the preview starts, it shows existing responses as history: each preview opens on the most recent one. After that, every newly finished response is shown in the order it is noticed. A log that appears later, such as a resumed old session, only contributes responses newer than the preview's start.

| Agent | Session logs | Final response of a turn |
|---|---|---|
| Claude Code | `~/.claude/projects/<dir>/*.jsonl` (`CLAUDE_CONFIG_DIR` respected) | the assistant message ending with `stop_reason: end_turn`; its content blocks are joined |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`CODEX_HOME` respected), matched by the header's `cwd` | `event_msg` → `task_complete.last_agent_message` |
| Pi | `~/.pi/agent/sessions/--<dir>--/*.jsonl` | assistant message with `stopReason: "stop"` |

The tool only shows each turn's final response, not the interim text written between tool calls, which matches pi-markdown-preview's watch mode. Subagent (sidechain) messages are ignored.

These log formats are internal to each CLI and can change without notice. Unknown entries are ignored, so a format change shows up as "no new response" rather than an error. The tests pin the current shapes.

## Keeping the renderer identical

`src/render.ts` is **generated**. Never edit it by hand:

```bash
npm run extract     # regenerate from ../pi-markdown-preview
cp ../pi-markdown-preview/client/* src/client/ && cp ../pi-markdown-preview/shared/*.{js,lua} src/shared/
npm test
```

`scripts/extract-render-core.cjs` uses the TypeScript compiler to copy exactly the top-level declarations the browser renderer depends on, verbatim and in their original order. It replaces Pi's `Theme` type with a structural `PreviewTheme`, which Pi's `Theme` still satisfies. It currently takes 94 of index.ts's 236 declarations.

`src/shared/browser-watch-server.js` and `src/client/watch-controls.css` currently come from pi-markdown-preview's `watch-page-improvements` branch (shortcut, status line, optional fixed port/token), pending a pi-markdown-preview release. Every file in `src/shared` and `src/client` must stay identical to pi-markdown-preview.

`test/equivalence.test.mjs` renders pi-markdown-preview's own test fixtures, plus a code file, in both themes. It checks that the HTML is **byte-identical** to what the original produces, using a temporary copy of `../pi-markdown-preview` (or `AMP_REFERENCE`). The test is skipped if the reference or pandoc is missing.

The long-term plan is the reverse direction: pi-markdown-preview (and Pi Studio's preview) import this package's renderer, and the extraction script goes away.

## Scope and limitations

- Browser only. Terminal image previews, PDF export and Pi theme colours stay in pi-markdown-preview.
- OpenCode stores sessions in SQLite and Gemini/agy logs have not been examined. Neither is supported yet.

## Development

```bash
npm test          # builds, then runs all tests (equivalence, session readers, live watch, themes)
PUPPETEER_EXECUTABLE_PATH=/path/to/chrome-headless-shell npm test   # also runs the real-browser theme test
npm run typecheck
```

Source is TypeScript in `src/`, compiled to `dist/`. `src/client` and `src/shared` are copied verbatim because the renderer reads them as text or runs them as-is.
