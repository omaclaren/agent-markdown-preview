#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { AGENTS, defaultSessionRoots, type AgentKind } from "./sessions.js";
import { resolveTheme, parseAgentTheme, type Appearance } from "./appearance.js";
import { startFileWatch, startResponseWatch, startSessionIndex, type RunningWatch } from "./watch.js";

const HELP = `agent-markdown-preview: browser preview of coding-agent responses and local files.

Usage:
  agent-markdown-preview [options]          Index of this directory's agent sessions; each opens a live preview
  agent-markdown-preview --merged           One preview: the latest response from any session here
  agent-markdown-preview <file> [options]   Watch a Markdown, LaTeX, code or diff file

Options:
  --agent <name|all>              claude, codex, pi, opencode (default: all). Repeatable/comma-separated.
  -a, --all-projects             Index recent sessions across folders, grouped by project.
  --merged                        Open the merged preview directly instead of the session index.
  --session <path|ses_id>         Preview one JSONL log or OpenCode session ID directly.
  --opencode-db <path>            Custom OpenCode SQLite database (default: XDG data/opencode/opencode.db).
  --cwd <dir>                     Project directory whose sessions to follow (default: current).
  --theme <name|file>             agent (default, by source), neutral, claude, codex, opencode, auto,
                                  pi, pi-studio, a -light/-dark variant, or a Pi theme .json file.
  --agent-theme <agent=theme>     Override one agent, e.g. pi=pi-studio. Repeatable; requires agent mode.
  --appearance <mode>             system (default for pairs), light or dark. Overrides theme appearance.
                                  Single Pi theme files keep their own fixed appearance.
  --font-size <px>                Base font size.
  --history <n>                   Earlier responses each preview starts with (default 10, max 20; 0 = only the latest).
  --working                       Opt in to Working: recorded prompts, tool output and images (may contain sensitive content).
  --open                          Open a browser tab even at a remembered address.
  --no-open                       Never open a browser tab (the URL is still printed).
  -h, --help                      Show this help.
  -v, --version                   Show the version.

A new address opens in the browser by default; restarting at a remembered address
only reconnects existing tabs. Use --open to request another tab.
Previews update when a turn finishes. Use their history controls for earlier
responses or file versions. Requires pandoc (set PANDOC_PATH if it is not on PATH).`;

function fail(message: string): never {
	process.stderr.write(`agent-markdown-preview: ${message}\n`);
	process.exit(2);
}

function parseArgs(argv: string[]) {
	const options = { agents: [] as AgentKind[], allProjects: false, turnDetails: false, cwdExplicit: false, merged: false, history: undefined as number | undefined, session: undefined as string | undefined, opencodeDb: undefined as string | undefined, cwd: process.cwd(), theme: "agent", agentThemes: {} as Partial<Record<AgentKind, string>>, appearance: undefined as Appearance | undefined, fontSize: undefined as number | undefined, open: "auto" as "auto" | "always" | "never", file: undefined as string | undefined };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		const value = () => {
			const next = argv[++i];
			if (next === undefined) fail(`${arg} needs a value.`);
			return next;
		};
		if (arg === "-h" || arg === "--help") { process.stdout.write(HELP + "\n"); process.exit(0); }
		else if (arg === "-v" || arg === "--version") {
			const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
			process.stdout.write(pkg.version + "\n");
			process.exit(0);
		}
		else if (arg === "--agent") {
			for (const name of value().split(",")) {
				if (name === "all") options.agents.push(...AGENTS);
				else if ((AGENTS as readonly string[]).includes(name)) options.agents.push(name as AgentKind);
				else fail(`Unknown agent "${name}". Use claude, codex, pi, opencode or all.`);
			}
		}
		else if (arg === "--session") options.session = value();
		else if (arg === "--opencode-db") options.opencodeDb = value();
		else if (arg === "--merged") options.merged = true;
		// --turn-details is the undocumented 0.5.x spelling of --working.
		else if (arg === "--working" || arg === "--turn-details") options.turnDetails = true;
		else if (arg === "--all-projects" || arg === "-a") options.allProjects = true;
		else if (arg === "--cwd") { options.cwd = value(); options.cwdExplicit = true; }
		else if (arg === "--theme") {
			options.theme = value();
		}
		else if (arg === "--agent-theme") {
			try { const [agent, theme] = parseAgentTheme(value()); options.agentThemes[agent] = theme; }
			catch (error) { fail(error instanceof Error ? error.message : String(error)); }
		}
		else if (arg === "--appearance") {
			const mode = value();
			if (!["system", "light", "dark"].includes(mode)) fail("--appearance must be system, light or dark.");
			options.appearance = mode as Appearance;
		}
		else if (arg === "--font-size") {
			options.fontSize = Number(value());
			if (!Number.isFinite(options.fontSize)) fail("--font-size needs a number.");
		}
		else if (arg === "--history") {
			options.history = Number(value());
			if (!Number.isInteger(options.history) || options.history < 0 || options.history > 20) fail("--history needs a whole number from 0 to 20.");
		}
		else if (arg === "--open") options.open = "always";
		else if (arg === "--no-open") options.open = "never";
		else if (arg.startsWith("-")) fail(`Unknown option ${arg}. See --help.`);
		else if (options.file) fail("Only one file can be watched per command.");
		else options.file = arg;
	}
	if (options.file && Object.keys(options.agentThemes).length) fail("--agent-theme applies to agent sessions, not file watching.");
	if (options.file && options.turnDetails) fail("--working applies to agent sessions, not file watching.");
	if (options.file && (options.session || options.merged || options.agents.length || options.opencodeDb || options.allProjects)) fail("--agent, --merged, --session, --all-projects and --opencode-db apply to agent sessions, not file watching.");
	if (options.allProjects && (options.session || options.merged || options.cwdExplicit)) fail("--all-projects is an index mode; do not combine with --cwd, --session or --merged. Choose Merged within a folder in the index.");
	return options;
}

function openInBrowser(url: string) {
	const [command, args] = process.platform === "darwin" ? ["open", [url]]
		: process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
		: ["xdg-open", [url]];
	try { spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const pandoc = process.env.PANDOC_PATH?.trim() || "pandoc";
	if (spawnSync(pandoc, ["--version"], { stdio: "ignore" }).error) {
		fail(`pandoc was not found (${pandoc}). Install it (e.g. brew install pandoc) or set PANDOC_PATH.`);
	}
	const log = (message: string) => process.stderr.write(message + "\n");
	const roots = options.opencodeDb ? { ...defaultSessionRoots(), opencode: options.opencodeDb } : undefined;
	let watch: RunningWatch;
	try {
		const theme = resolveTheme(options.theme, options.appearance, options.agentThemes);
		watch = options.file
			? await startFileWatch({ filePath: options.file, ...theme, fontSizePx: options.fontSize, log })
			: options.merged || options.session
				? await startResponseWatch({ cwd: options.cwd, ...theme, agents: options.agents.length ? options.agents : undefined, sessionPath: options.session, roots, turnDetails: options.turnDetails, fontSizePx: options.fontSize, historyFill: options.history, log })
				: await startSessionIndex({ cwd: options.cwd, allProjects: options.allProjects, turnDetails: options.turnDetails, roots, ...theme, agents: options.agents.length ? options.agents : undefined, fontSizePx: options.fontSize, historyFill: options.history, log });
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
	if (options.turnDetails) process.stdout.write("Working enabled: prompts, tool output and recorded images may contain sensitive content. Only share this link with trusted viewers.\n");
	else if (!options.file) process.stdout.write("Tip: start with --working to see prompts and activity.\n");
	process.stdout.write(`Watching ${watch.label}\n${watch.url}\nCtrl+C stops the preview.\n`);
	const stop = () => { watch.close().finally(() => process.exit(0)); };
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	// Background/suspended tabs may not check in promptly. Do not infer that
	// they were closed from a timeout; opening again is explicit on restarts.
	if (options.open === "always" || (options.open === "auto" && !watch.reused)) openInBrowser(watch.url);
	else if (options.open === "auto") process.stdout.write("Reusing the saved address; no new tab opened. Use --open if you need one.\n");
}

void main();
