#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { AGENTS, type AgentKind } from "./sessions.js";
import { startFileWatch, startResponseWatch, startSessionIndex, styleForMode, type RunningWatch } from "./watch.js";

const HELP = `agent-markdown-preview: browser preview of coding-agent responses and local files.

Usage:
  agent-markdown-preview [options]          Index of this directory's agent sessions; each opens a live preview
  agent-markdown-preview --merged           One preview: the latest response from any session here
  agent-markdown-preview <file> [options]   Watch a Markdown, LaTeX, code or diff file

Options:
  --agent <claude|codex|pi|all>   Agents to follow (default: all). Repeatable or comma-separated.
  --merged                        Open the merged preview directly instead of the session index.
  --session <path>                Preview one session log directly.
  --cwd <dir>                     Project directory whose sessions to follow (default: current).
  --theme <auto|light|dark>       Page theme (default: auto, following the system light/dark setting live).
  --font-size <px>                Base font size.
  --history <n>                   Earlier responses each preview starts with (default 10, max 20; 0 = only the latest).
  --no-open                       Print the URL without opening a browser.
  -h, --help                      Show this help.
  -v, --version                   Show the version.

Previews update when a turn finishes. Use their history controls for earlier
responses or file versions. Requires pandoc (set PANDOC_PATH if it is not on PATH).`;

function fail(message: string): never {
	process.stderr.write(`agent-markdown-preview: ${message}\n`);
	process.exit(2);
}

function parseArgs(argv: string[]) {
	const options = { agents: [] as AgentKind[], merged: false, history: undefined as number | undefined, session: undefined as string | undefined, cwd: process.cwd(), theme: "auto", fontSize: undefined as number | undefined, open: true, file: undefined as string | undefined };
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
				else fail(`Unknown agent "${name}". Use claude, codex, pi or all.`);
			}
		}
		else if (arg === "--session") options.session = value();
		else if (arg === "--merged") options.merged = true;
		else if (arg === "--cwd") options.cwd = value();
		else if (arg === "--theme") {
			options.theme = value();
			if (!["auto", "light", "dark"].includes(options.theme)) fail("--theme must be auto, light or dark.");
		}
		else if (arg === "--font-size") {
			options.fontSize = Number(value());
			if (!Number.isFinite(options.fontSize)) fail("--font-size needs a number.");
		}
		else if (arg === "--history") {
			options.history = Number(value());
			if (!Number.isInteger(options.history) || options.history < 0 || options.history > 20) fail("--history needs a whole number from 0 to 20.");
		}
		else if (arg === "--no-open") options.open = false;
		else if (arg.startsWith("-")) fail(`Unknown option ${arg}. See --help.`);
		else if (options.file) fail("Only one file can be watched per command.");
		else options.file = arg;
	}
	if (options.file && (options.session || options.merged || options.agents.length)) fail("--agent, --merged and --session apply to agent sessions, not file watching.");
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
	const followSystemTheme = options.theme === "auto";
	const style = styleForMode(followSystemTheme ? "light" : options.theme as "light" | "dark");
	const log = (message: string) => process.stderr.write(message + "\n");
	let watch: RunningWatch;
	try {
		watch = options.file
			? await startFileWatch({ filePath: options.file, style, followSystemTheme, fontSizePx: options.fontSize, log })
			: options.merged || options.session
				? await startResponseWatch({ cwd: options.cwd, style, followSystemTheme, agents: options.agents.length ? options.agents : undefined, sessionPath: options.session, fontSizePx: options.fontSize, historyFill: options.history, log })
				: await startSessionIndex({ cwd: options.cwd, style, followSystemTheme, agents: options.agents.length ? options.agents : undefined, fontSizePx: options.fontSize, historyFill: options.history, log });
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
	process.stdout.write(`Watching ${watch.label}\n${watch.url}\nCtrl+C stops the preview.\n`);
	// After a restart at the same address, an open tab reconnects by itself;
	// only open another if none does within a few seconds.
	if (options.open) {
		if (watch.reused && await watch.waitForViewer(6_000)) process.stdout.write("An open tab reconnected, so no new one was opened.\n");
		else openInBrowser(watch.url);
	}
	const stop = () => { watch.close().finally(() => process.exit(0)); };
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

void main();
