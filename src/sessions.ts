// Read-only adapters for coding-agent session histories (JSONL and SQLite).
// These formats are internal to each CLI and may change, so
// every reader ignores entries it does not recognise rather than failing.
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { extractAssistantMarkdownContent } from "./render.js";
import { createOpenCodeStore, openCodeSessionId, readOpenCodeResponse } from "./opencode.js";

export type AgentKind = "claude" | "codex" | "pi" | "opencode";
export const AGENTS: readonly AgentKind[] = ["claude", "codex", "pi", "opencode"];
export const AGENT_LABELS: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode" };

export interface AgentResponse {
	agent: AgentKind;
	/** Stable per response; a later entry with the same key revises that response. */
	key: string;
	markdown: string;
	/** Milliseconds since the epoch, from the log entry when available. */
	time: number;
	sessionPath: string;
}

export interface SessionFile {
	agent: AgentKind;
	/** JSONL path, or database-path#ses_id for OpenCode. */
	path: string;
	mtimeMs: number;
	/** Recorded project directory; always present in cross-project discovery. */
	cwd?: string;
}

export interface SessionRoots {
	claude?: string;
	codex?: string;
	pi?: string;
	/** SQLite database file, not the legacy JSON storage directory. */
	opencode?: string;
}

export function defaultSessionRoots(env: NodeJS.ProcessEnv = process.env): Required<SessionRoots> {
	return {
		claude: join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"),
		codex: join(env.CODEX_HOME || join(homedir(), ".codex"), "sessions"),
		pi: join(homedir(), ".pi", "agent", "sessions"),
		opencode: join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db"),
	};
}

const record = (value: unknown): Record<string, any> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
const entryTime = (value: unknown, fallback: number) => {
	const parsed = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
};

export type SessionEvent =
	| { kind: "response"; response: AgentResponse }
	| { kind: "working"; working: boolean; time: number }
	| { kind: "title"; title: string; named: boolean };

const TITLE_CHARS = 100;
const cleanTitle = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS);
const userText = (content: unknown) => typeof content === "string" ? content
	: Array.isArray(content) ? content.filter(b => b && typeof b === "object" && (b.type === "text" || b.type === "input_text") && typeof b.text === "string").map(b => b.text).join("\n") : "";
// Injected context rather than something the user typed.
const isInjectedPrompt = (text: string) => !text.trim() || /^\s*</.test(text) || /^# AGENTS\.md instructions/.test(text);

/**
 * Returns a stateful reader: feed it each parsed JSONL entry in order and it
 * reports completed (or revised) final answers, turn start/end and the
 * session title. Titles: the agent's own title when it has one, otherwise the
 * first prompt the user typed.
 */
export function createSessionReader(agent: AgentKind, sessionPath: string): (entry: unknown) => SessionEvent[] {
	const responses = createResponseReader(agent, sessionPath);
	let namedTitle = false, promptTitle = false;
	const title = (text: string, named: boolean): SessionEvent[] => {
		const cleaned = cleanTitle(text);
		if (!cleaned || (!named && (namedTitle || promptTitle))) return [];
		if (named) namedTitle = true; else promptTitle = true;
		return [{ kind: "title", title: cleaned, named }];
	};
	return entry => {
		const events: SessionEvent[] = [];
		const response = responses(entry);
		if (response) events.push({ kind: "response", response }, { kind: "working", working: false, time: response.time });
		const e = record(entry);
		if (!e) return events;
		const time = entryTime(e.timestamp, Date.now());
		if (agent === "claude") {
			if (e.type === "ai-title" && typeof e.aiTitle === "string") events.push(...title(e.aiTitle, true));
			if (e.type === "system" && e.subtype === "turn_duration") events.push({ kind: "working", working: false, time });
			if (e.type === "user" && e.isSidechain !== true) {
				const text = userText(e.message?.content);
				const channel = /<channel\s/.test(text);
				if (e.isMeta !== true || channel) events.push({ kind: "working", working: true, time });
				if (e.isMeta !== true && !isInjectedPrompt(text)) events.push(...title(text, false));
			}
		} else if (agent === "codex") {
			const payload = record(e.payload);
			if (e.type === "event_msg" && payload?.type === "task_started") events.push({ kind: "working", working: true, time });
			if (e.type === "response_item" && payload?.type === "message" && payload.role === "user") {
				for (const block of Array.isArray(payload.content) ? payload.content : []) {
					if (typeof block?.text === "string" && !isInjectedPrompt(block.text)) { events.push(...title(block.text, false)); break; }
				}
			}
		} else if (agent === "opencode") {
			if (e.type === "session" && typeof e.title === "string") events.push(...title(e.title, true));
			if (e.type === "idle") events.push({ kind: "working", working: false, time: entryTime(e.time?.created, time) });
			if ((e.type ?? e.info?.role) === "user") {
				events.push({ kind: "working", working: true, time: entryTime(e.time?.created, time) });
				const text = e.text ?? userText(e.parts);
				if (typeof text === "string" && !isInjectedPrompt(text)) events.push(...title(text, false));
			}
		} else {
			if (e.type === "session_info" && typeof e.name === "string") events.push(...title(e.name, true));
			const message = record(e.message);
			if (e.type === "message" && message?.role === "user") {
				events.push({ kind: "working", working: true, time });
				const text = userText(message.content);
				if (!isInjectedPrompt(text)) events.push(...title(text, false));
			}
			if (e.type === "message" && message?.role === "assistant" && ["stop", "error", "aborted"].includes(message.stopReason)) events.push({ kind: "working", working: false, time });
		}
		return events;
	};
}

/**
 * Short display id for a session log: the end of its UUID. Codex and Pi use
 * time-ordered (v7) UUIDs, whose leading characters are shared by sessions
 * started around the same time; the trailing characters are random.
 */
export function sessionShortId(path: string): string {
	const opencode = openCodeSessionId(path);
	if (opencode) return opencode.slice(-4);
	const name = path.split(/[/\\]/).at(-1) ?? path;
	const uuid = name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
	return uuid ? uuid[0].slice(-4) : name.replace(/\.jsonl$/, "").slice(0, 4);
}

/**
 * Returns a stateful reader: feed it each parsed JSONL entry in order and it
 * returns a response when an entry completes (or revises) a final answer.
 */
export function createResponseReader(agent: AgentKind, sessionPath: string): (entry: unknown) => AgentResponse | null {
	if (agent === "opencode") return entry => readOpenCodeResponse(entry, sessionPath);
	if (agent === "claude") {
		// Claude Code writes one line per content block. The turn's final message is
		// the assistant message whose stop_reason ends the turn (not "tool_use").
		let currentId: string | null = null;
		let parts: string[] = [];
		return entry => {
			const e = record(entry);
			const message = record(e?.message);
			if (e?.type !== "assistant" || e.isSidechain === true || !message || !Array.isArray(message.content)) return null;
			if (!["end_turn", "stop_sequence", "max_tokens"].includes(message.stop_reason)) return null;
			const id = typeof message.id === "string" ? message.id : typeof e.uuid === "string" ? e.uuid : null;
			if (!id) return null;
			if (id !== currentId) { currentId = id; parts = []; }
			const text = extractAssistantMarkdownContent(message.content);
			if (!text) return null;
			parts.push(text);
			return { agent, key: `claude:${id}`, markdown: parts.join("\n\n"), time: entryTime(e.timestamp, Date.now()), sessionPath };
		};
	}
	if (agent === "codex") {
		return entry => {
			const e = record(entry);
			const payload = record(e?.payload);
			if (e?.type !== "event_msg" || payload?.type !== "task_complete") return null;
			const markdown = payload.last_agent_message;
			if (typeof markdown !== "string" || !markdown.trim()) return null;
			const turn = typeof payload.turn_id === "string" ? payload.turn_id : String(e.timestamp ?? Date.now());
			return { agent, key: `codex:${turn}`, markdown, time: entryTime(e.timestamp, Date.now()), sessionPath };
		};
	}
	return entry => {
		// Pi: the final assistant message of a turn has stopReason "stop"; tool
		// handoffs use "toolUse".
		const e = record(entry);
		const message = record(e?.message);
		if (e?.type !== "message" || message?.role !== "assistant" || message.stopReason !== "stop") return null;
		const markdown = extractAssistantMarkdownContent(message.content);
		if (!markdown) return null;
		const id = typeof e.id === "string" ? e.id : String(e.timestamp ?? Date.now());
		return { agent, key: `pi:${id}`, markdown, time: entryTime(e.timestamp ?? message.timestamp, Date.now()), sessionPath };
	};
}

// Directory naming used by each CLI for a working directory.
export const claudeProjectDirName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
export const piSessionDirName = (cwd: string) => `--${cwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`;

async function jsonlFilesNewestFirst(dir: string, agent: AgentKind, filter = (name: string) => name.endsWith(".jsonl")): Promise<SessionFile[]> {
	let names: string[];
	try { names = await readdir(dir); } catch { return []; }
	const files = await Promise.all(names.filter(filter).map(async name => {
		const path = join(dir, name);
		try {
			const info = await stat(path);
			return info.isFile() ? { agent, path, mtimeMs: info.mtimeMs } : null;
		} catch { return null; }
	}));
	return files.filter((file): file is SessionFile => file !== null).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Reads the first JSONL line (bounded), e.g. a session header. */
export async function readFirstJsonLine(path: string, limitBytes = 1_000_000): Promise<unknown> {
	const handle = await open(path, "r");
	try {
		const chunks: Buffer[] = [];
		let total = 0;
		while (total < limitBytes) {
			const buffer = Buffer.alloc(Math.min(65_536, limitBytes - total));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
			if (bytesRead === 0) break;
			const chunk = buffer.subarray(0, bytesRead);
			const newline = chunk.indexOf(0x0a);
			if (newline >= 0) { chunks.push(chunk.subarray(0, newline)); break; }
			chunks.push(chunk);
			total += bytesRead;
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} finally { await handle.close(); }
}

/** Read a recorded project path, never guess it from a lossy directory name.
 * Claude can put title/file-history records before the first entry with cwd. */
async function readSessionCwd(path: string, agent: AgentKind): Promise<string | null> {
	const handle = await open(path, "r");
	try {
		let remainder = "";
		const inspect = (line: string): string | null | undefined => {
			let e;
			try { e = record(JSON.parse(line)); } catch { return undefined; }
			if (!e) return undefined;
			if (agent === "claude" && e.isSidechain === true) return null;
			if (agent === "codex" && e.type === "session_meta" && record(e.payload?.source)?.subagent) return null;
			const cwd = agent === "codex" ? (e.type === "session_meta" ? e.payload?.cwd : undefined)
				: agent === "pi" ? (e.type === "session" ? e.cwd : undefined) : e.cwd;
			return typeof cwd === "string" && isAbsolute(cwd) ? cwd : undefined;
		};
		// Keep UTF-8 byte sequences intact across chunk boundaries.
		const decoder = new TextDecoder();
		for (let offset = 0; offset < 1_000_000;) {
			const buffer = Buffer.alloc(Math.min(65_536, 1_000_000 - offset));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
			if (!bytesRead) { remainder += decoder.decode(); break; }
			offset += bytesRead;
			remainder += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
			const lines = remainder.split("\n"); remainder = lines.pop() ?? "";
			for (const line of lines) { const cwd = inspect(line); if (cwd !== undefined) return cwd; }
		}
		return inspect(remainder) ?? null;
	} finally { await handle.close(); }
}

/** Finds session logs for one directory, or recent candidates across projects. */
export function createSessionFinder(roots: SessionRoots = defaultSessionRoots(), { codexDayLimit = 45 } = {}) {
	// Cache header reads until a log changes, including failed/partial reads.
	// Bound this cache as the all-projects index may visit many folders over time.
	const cwdCache = new Map<string, { stamp: string; cwd: string | null }>();
	async function recordedCwd(file: SessionFile): Promise<string | null> {
		const info = await stat(file.path).catch(() => null);
		if (!info) return null;
		const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
		const cached = cwdCache.get(file.path);
		if (cached?.stamp === stamp) return cached.cwd;
		const cwd = await readSessionCwd(file.path, file.agent).catch(() => null);
		cwdCache.delete(file.path); cwdCache.set(file.path, { stamp, cwd });
		while (cwdCache.size > 2048) cwdCache.delete(cwdCache.keys().next().value!);
		return cwd;
	}
	async function codexFiles(): Promise<SessionFile[]> {
		if (!roots.codex) return [];
		const matches: SessionFile[] = [];
		const listDesc = async (dir: string) => { try { return (await readdir(dir)).filter(n => /^\d+$/.test(n)).sort().reverse(); } catch { return []; } };
		let days = 0;
		for (const year of await listDesc(roots.codex)) {
			for (const month of await listDesc(join(roots.codex, year))) {
				for (const day of await listDesc(join(roots.codex, year, month))) {
					if (++days > codexDayLimit) return matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
					const files = await jsonlFilesNewestFirst(join(roots.codex, year, month, day), "codex", name => name.startsWith("rollout-") && name.endsWith(".jsonl"));
					matches.push(...files);
				}
			}
		}
		// A session stays in the folder of the day it started, so a still-active
		// session from an earlier day must not be hidden by today's.
		return matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
	}
	const opencode = roots.opencode ? createOpenCodeStore(roots.opencode) : null;
	async function find(agent: AgentKind, cwd: string): Promise<SessionFile[]> {
		if (agent === "claude") return roots.claude ? jsonlFilesNewestFirst(join(roots.claude, claudeProjectDirName(cwd)), agent) : [];
		if (agent === "pi") return roots.pi ? jsonlFilesNewestFirst(join(roots.pi, piSessionDirName(cwd)), agent) : [];
		if (agent === "opencode") return opencode?.list(cwd) ?? [];
		const matches: SessionFile[] = [];
		for (const file of await codexFiles()) if (await recordedCwd(file) === cwd) matches.push(file);
		return matches;
	}
	async function all(agent: AgentKind, { since = -Infinity, limit = 512 } = {}): Promise<SessionFile[]> {
		let files: SessionFile[] = [];
		if (agent === "opencode") files = await opencode?.list() ?? [];
		else if (agent === "codex") files = await codexFiles();
		else {
			const root = roots[agent];
			if (!root) return [];
			const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
			// Only the agent's own direct project directories, never a filesystem crawl
			// or nested subagent trees. Encoded directory names are not reversible.
			for (const dir of dirs) if (dir.isDirectory()) files.push(...await jsonlFilesNewestFirst(join(root, dir.name), agent));
		}
		const matches: SessionFile[] = [];
		for (const file of files.filter(file => file.mtimeMs >= since).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)) {
			const cwd = file.cwd ?? await recordedCwd(file);
			if (cwd && isAbsolute(cwd)) matches.push({ ...file, cwd: normalize(cwd) });
		}
		return matches;
	}
	return Object.assign(find, { all, opencode, close: () => { cwdCache.clear(); opencode?.close(); } });
}

/** Guesses which agent wrote a session log, from its path or first line. */
export async function detectAgent(path: string): Promise<AgentKind | null> {
	if (/[/\\]\.claude[/\\]/.test(path)) return "claude";
	if (/[/\\]\.codex[/\\]/.test(path)) return "codex";
	if (/[/\\]\.pi[/\\]/.test(path)) return "pi";
	try {
		const first = record(await readFirstJsonLine(path));
		if (first?.type === "session_meta") return "codex";
		if (first?.type === "session") return "pi";
		if (first && ("sessionId" in first || "session_id" in first)) return "claude";
	} catch {}
	return null;
}
