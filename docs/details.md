# Details and limits

Reference material for [agent-markdown-preview](../README.md): what a preview serves, how sessions are found and followed, and the limits on what it reads and shows.

## Security

The index and each preview run their own server on `127.0.0.1` with their own random token. On first load the page exchanges the token for a browser cookie. **Copy link** produces a fresh link for another browser. Working uses separate remembered credentials from ordinary previews. The remembered-addresses file contains the tokens and is readable only by you.

A preview serves its rendered pages, the images and PDFs they reference, and supported documents explicitly linked from retained responses or recently opened documents. These routes require the preview's cookie; there is no directory browser or arbitrary file-path endpoint. Following a session does not expose its log file.

Anyone with a preview's link can follow its local links, see resolved filesystem paths and request open or reveal actions for those linked files and folders, including paths outside the project. Linked tabs may expire as retained history is pruned; reopen an expired tab from its source preview.

File actions need a deliberate click and run on the machine hosting the preview. Opening uses the operating system's file association, so a runnable file may execute or an archive may extract. **Show in folder** reveals the item in Finder on macOS and uses Explorer on Windows; on Linux it opens the containing folder with `xdg-open`, without selecting the file. A desktop and a suitable file association are required. Actions are authenticated same-origin POSTs carrying a per-run action key and a retained link ID, never an arbitrary path or shell command. Reload an old action page after restarting its preview.

HTML files run in an opaque-origin sandbox on a separate loopback server, not inside the authenticated preview page. The selected page is a snapshot; relative CSS, JavaScript modules, images, fonts and Wasm assets are served live from its directory and subdirectories. Canonical containment checks block escapes and symlinks outside that directory, and dot paths, sibling HTML documents, PDFs and non-asset files are not served. HTTPS resources and requests from the page's own scripts are allowed, so this is not network isolation. The viewer itself does not upload local files anywhere. Its capability URLs grant access to the page and these assets, so keep them private. The server stops with its preview. Forms, nested frames, local storage and general web-app hosting are outside the scope of this viewer.

## Local links and files

- Text, Markdown, LaTeX and HTML input is limited to 2 MiB of UTF-8. Spaces and section anchors in paths are preserved. Web links and same-page section links behave normally.
- PDFs stream through byte-range-capable routes to the browser's viewer, or download, depending on browser settings. Office and other non-previewable files open a path page.
- PNG, JPEG, GIF, SVG, WebP, AVIF, BMP and ICO images use the browser's own decoder, with no conversion. SVGs stay image resources, never markup in the preview page. Images stream with their original filenames for saving. Editing an image does not trigger an update; refresh to see it.
- Path pages do not read or download unsupported files, do not execute notebooks and do not list folders. Pages for supported files link back to their preview.
- **Copy local path** copies the resolved absolute path on the preview host, without a URL fragment or shell quoting, keeping symlinked paths as written. If the clipboard is blocked, the path is shown for manual selection. The browser's own **Copy link** still copies the page URL.
- Linked file action, image and HTML viewer pages use their source response's palette; authored HTML inside the sandbox is not restyled.

## Sessions and updates

- The index checks for new sessions every two seconds. An open preview's marker can lapse while a suspended or heavily throttled background tab is not checking in.
- Active preview tabs check for a new response every 200 ms with small, short-lived requests. Background tabs check less often and check again when brought to the foreground, so several tabs do not hold open permanent connections. Previous/Next navigation does not wait for a check.
- Cross-project discovery reads the agents' own storage locations rather than scanning your projects. It looks at up to 512 recent candidate logs per agent per scan, and Codex keeps its 45-date-folder discovery window. Logs without a recognised absolute working directory are left out. Folders are grouped by their recorded full path, so two folders with the same name stay distinct. Rendering starts when you open a preview or request its link.
- In the cross-project index each folder shows its full path under its name, and follows up to eight sessions per agent. Relative images and links use each session's own project directory, not the directory where you started the index. `--all-projects` has its own remembered address.
- **Copy preview link** beside a session or folder in the cross-project index copies only that preview's address, without opening a tab; it does not share the index's wider credentials. If the clipboard is blocked, it shows the link for manual selection.
- Each response has a caption naming the agent, session and time, for example *Claude Code 3f2a · Fit decay model to measurements · 03:05 pm*. The merged view takes the last responses across all sessions in time order.
- Local images in responses resolve against the project directory; absolute paths and web images also work.

## Restarts

- While the command is stopped, a tab shows that it is disconnected, and reconnects when the command restarts.
- A remembered address never opens another tab, even if the old tab is suspended or closed. `--open` asks for one; `--no-open` suppresses opening even for a new address. This applies to the index, merged and session previews, and file previews.
- If another program has taken a remembered port, the preview starts on a new port and you reopen it from the index.

## Working

Details are read only when requested, for the exact retained response. Reads are limited to an 8 MiB JSONL tail, 1 MiB per record and 10,000 records. Display limits are 250 events, 16K characters of recorded text per entry and 256K overall. Clipped entries are marked; missing material is not reconstructed. System and developer entries, known harness-injected context, opaque signatures and prompt or non-image attachments are omitted.

Commands, paths and URLs stay literal: they do not execute or become file links. Known Bash, codemode, read and edit calls show commands or code, requested paths and ranges, and Before/After replacement text. Other options and unknown or malformed argument shapes keep their literal view. Calls and results stay separate. Raw input keeps the prompt's original text when the reading view removes leading blank lines.

Images come only from recorded inline bytes, never from current files, URLs or attachment IDs. Static PNG, JPEG and WebP are supported; missing, unsupported or oversized images show an unavailable message. Thumbnails decode when their result card opens. Limits are eight candidates per turn, 512 KiB and 8 Mi pixels per image, 2 MiB and 16 Mi pixels overall, and 8192 pixels per dimension. Record and read limits still apply, so an oversized source record may be absent altogether. Nothing is converted or stored.

Complete Claude paste wrappers are hidden in the reading view and kept in Raw input. Claude response blocks with a pending stop reason are assembled with their completed message, using the same rules in Preview and Working. Assembly is limited to 2 Mi characters per message; a message over the limit is omitted rather than silently truncated.

Claude `AskUserQuestion` records include option descriptions and single or multiple selection. Answers and annotations are shown when the log supplies unambiguous data matched to the call; otherwise the original reply is shown as written. Commas and quotes are not parsed into selections. Raw output and bounded answer JSON stay expandable, and option previews are inert text. Answer data shares the text budget, and missing or malformed data is not reconstructed.

OpenCode details come from read-only database snapshots, reading message and part records one at a time, up to 1 MiB each and 8 MiB in total.

Working inherits its response's palette and text size. Each view remembers its reading position, and expanded cards and wrapping choices survive refreshes within the tab. Working stays on the selected turn as new responses arrive. Missing data offers a link to the same response in Preview, and expired links offer a way to reconnect.

## OpenCode

- The adapter follows the v1 SQLite layout and the refactored v2.0.16 [session tables](https://github.com/anomalyco/opencode/blob/v2.0.16/packages/core/src/session/sql.ts) and [message schema](https://github.com/anomalyco/opencode/blob/v2.0.16/packages/schema/src/session-message.ts). An unsupported schema is reported without stopping the other agents being followed.
- When both schemas contain a migrated session, v2 wins and the session appears once. Imported v1 answers keep their history even though they predate v2's idle markers. Reasoning, tool output, compaction summaries and unfinished responses are left out.
- Discovery matches the stored working directory exactly and leaves out archived sessions. `--session ses_…` opens any session by ID, including archived and child sessions, and can be combined with `--opencode-db`.
- Unrecognised log entries are ignored for every agent.
- The database is opened read-only, with no OpenCode process, server, export or migration command. Short snapshot reads include committed WAL updates, and polling every 300 ms detects in-place message edits and waits for v2 turns to settle.
- At most 20 answers are kept, chosen from the newest 256 completed candidates, with a 2 MiB text limit per answer. These are the stored transcript answers, not a reconstruction of the model's compacted context or staged undo state.
- The old pre-SQLite `storage/session`, `storage/message` and `storage/part` JSON directories and JSON exports are not read.
- **Live (v2 sessions only):**
  - A turn runs from the first prompt after an idle marker to the next idle marker; prompts sent while it runs belong to it. An answer imported from v1, which has no idle marker, also closes its exchange.
  - The idle marker's outcome ends the turn: succeeded, interrupted or failed. A completed turn links to the same answer the history keeps for it; one without a text answer returns to the latest Preview. An answer that stopped at the model's output limit is shown as incomplete, with a link to the partial answer. An answer larger than Preview keeps (2 MiB of text) is reported as too large, with a link back to Preview.
  - Compaction and other maintenance that ends in an idle marker without a prompt is not a turn. Queued input that OpenCode has not yet admitted is not shown.
  - OpenCode updates its rows in place, so Live re-reads the turn, up to its latest 250 rows, whenever the session's event counter changes, and updates only the cards whose content changed (images included). It shows the latest 250 cards within the usual text limits and counts the earlier ones. A replaced database file starts the view again.
  - A committed revert deletes rows, and their cards leave the page; a reverted turn is no longer available. While a revert is only staged, its activity is not the current turn, and a page that shows it says the revert is staged. If Live can't place the staged boundary, it picks no current turn.
  - Live shows only what is in the database: text blocks once recorded whole, and tool output when the tool finishes. It does not fetch streaming output from OpenCode's server. A subagent runs in its own child session, which has its own turns. What Live leaves out or can't interpret is listed in its status line.

## Themes

- `--theme agent` picks a palette from each response's recorded source, including in merged previews and as new responses arrive. The index, waiting pages and file previews use the neutral palette. The palettes are built into the preview; they don't follow an agent's live terminal theme.
- `--agent-theme` works only with the default `--theme agent`, and not in file previews. An explicit `--appearance` overrides paired choices.
- A Pi theme `.json` file is a single fixed theme, so `--appearance system`, or an appearance that contradicts the file, is rejected.
- `pi` uses bundled stock Pi colours (Pi 1.0.4's named light/dark pair), resolved ahead of time with Pi's own colour code and export backgrounds, with no Pi runtime dependency. `pi-studio` is a separate optional palette. The stock pair is a pinned snapshot, not Pi's terminal-derived `system` theme; `src/themes/README.md` gives its provenance and how to regenerate it.
- Pi theme `.json` files can use six-digit hex and 256-colour values; OKHSL and OKLCH values are not yet supported.
- `--theme auto` keeps the original preview light/dark pair. `light`, `dark` and fixed names such as `pi-studio-dark` keep their own appearance unless `--appearance` overrides them.
- When `--agent-theme` is repeated for the same agent, the last value wins.
- Changing appearance reloads pages that contain Mermaid diagrams, to redraw them in the new colours.
- Layout and controls are the same in every palette, and the index keeps compact interface typography.
