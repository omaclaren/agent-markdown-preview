// Follows every recently active agent session in one directory. Each session log
// is tailed continuously from where it left off, so several concurrent sessions
// (of one agent or several) are all observed without switching or re-reading.
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { AGENTS, createSessionFinder, createSessionReader, sessionShortId, type AgentKind, type AgentResponse, type SessionRoots } from "./sessions.js";
import { tailJsonl, type JsonlTail } from "./tail.js";

export interface SessionState {
	/** URL-safe id, derived from the log path. */
	id: string;
	agent: AgentKind;
	path: string;
	shortId: string;
	title: string | null;
	working: boolean;
	lastActivity: number;
	/** Most recent completed response, including history from before the watch started. */
	latest: AgentResponse | null;
	/** Recent completed responses, oldest first, one entry (latest revision) per response. */
	history: AgentResponse[];
	responseCount: number;
}

export interface MonitorOptions {
	cwd: string;
	agents?: readonly AgentKind[];
	/** Follow exactly these logs (no discovery). */
	sessionPaths?: { agent: AgentKind; path: string }[];
	roots?: SessionRoots;
	/** Only sessions whose log was modified within this window are followed. */
	recentMs?: number;
	maxPerAgent?: number;
	rescanMs?: number;
	tailIntervalMs?: number;
	maxBackfillBytes?: number;
	/**
	 * A log first seen after start-up may hold older history (e.g. a resumed
	 * session). Only its responses newer than start-up minus this skew are new.
	 */
	clockSkewMs?: number;
	log?: (message: string) => void;
}

export interface SessionMonitor {
	/** Resolves once the initial logs have been read. */
	ready: Promise<void>;
	sessions(): SessionState[];
	get(id: string): SessionState | undefined;
	/**
	 * `fresh` is false for history found in logs at start-up. A response with an
	 * already-seen key is a revision (e.g. another content block of that message).
	 */
	onResponse(listener: (session: SessionState, response: AgentResponse, fresh: boolean) => void): () => void;
	onChange(listener: () => void): () => void;
	close(): void;
}

const sessionId = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 16);
/** Enough for any preview's history fill; the watch page keeps at most 20. */
const SESSION_HISTORY = 20;

/**
 * Finished responses from the end of a log, reading further back (up to
 * `maxBytes`) until `count` are found or the file starts. Long sessions with
 * large tool output can hold only a few responses in their last megabytes.
 */
async function recentResponses(agent: AgentKind, path: string, count: number, maxBytes = 64 * 1024 * 1024): Promise<AgentResponse[]> {
	const info = await stat(path);
	for (let window = 4 * 1024 * 1024; ; window *= 4) {
		const start = Math.max(0, info.size - Math.min(window, maxBytes));
		const handle = await open(path, "r");
		let text: string;
		try {
			const buffer = Buffer.alloc(info.size - start);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
			text = buffer.subarray(0, bytesRead).toString("utf8");
		} finally { await handle.close(); }
		const lines = text.split("\n");
		if (start > 0) lines.shift(); // Partial first line.
		const read = createSessionReader(agent, path);
		const byKey = new Map<string, AgentResponse>();
		for (const line of lines) {
			if (!line.trim()) continue;
			let entry: unknown;
			try { entry = JSON.parse(line); } catch { continue; }
			for (const event of read(entry)) if (event.kind === "response") { byKey.delete(event.response.key); byKey.set(event.response.key, event.response); }
		}
		const responses = [...byKey.values()];
		if (responses.length >= count || start === 0 || window >= maxBytes) return responses.slice(-count);
	}
}

/** Title from the first prompt at the start of a log (reads at most `limitBytes`). */
async function firstPromptTitle(agent: AgentKind, path: string, limitBytes = 1_000_000): Promise<string | null> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(limitBytes);
		const { bytesRead } = await handle.read(buffer, 0, limitBytes, 0);
		const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
		if (bytesRead === limitBytes) lines.pop();
		const read = createSessionReader(agent, path);
		for (const line of lines) {
			let entry: unknown;
			try { entry = JSON.parse(line); } catch { continue; }
			const title = read(entry).find(event => event.kind === "title");
			if (title && title.kind === "title") return title.title;
		}
		return null;
	} finally { await handle.close(); }
}

export function createSessionMonitor(options: MonitorOptions): SessionMonitor {
	const cwd = options.cwd;
	const agents = options.agents ?? AGENTS;
	const log = options.log ?? (() => {});
	const find = createSessionFinder(options.roots);
	const startedAt = Date.now();
	const recentMs = options.recentMs ?? 3 * 24 * 60 * 60 * 1000;
	const maxPerAgent = options.maxPerAgent ?? 8;
	const clockSkewMs = options.clockSkewMs ?? 5_000;
	const tracked = new Map<string, { state: SessionState; tail: JsonlTail; initial: boolean }>();
	const responseListeners = new Set<(session: SessionState, response: AgentResponse, fresh: boolean) => void>();
	const changeListeners = new Set<() => void>();
	let initialScanDone = false, closed = false, scanning = false;

	const changed = () => { for (const listener of changeListeners) listener(); };
	// Sessions whose title came from the agent itself (not a prompt).
	const named = new Set<string>();
	const namedTitleSeen = (state: SessionState) => named.has(state.id);
	// Newest response time already seen in sessions that dropped out of the
	// window, so a session that becomes active again does not replay them.
	const seenBeforeDrop = new Map<string, number>();

	async function track(agent: AgentKind, path: string, mtimeMs: number) {
		const id = sessionId(path);
		if (tracked.has(id) || closed) return;
		const state: SessionState = { id, agent, path, shortId: sessionShortId(path), title: null, working: false, lastActivity: mtimeMs, latest: null, history: [], responseCount: 0 };
		const initial = !initialScanDone;
		const read = createSessionReader(agent, path);
		const entry = { state, tail: null as unknown as JsonlTail, initial };
		tracked.set(id, entry);
		let backfilling = true;
		// Hold tail notifications until the deeper history is merged, so recovered
		// answers are delivered before any newer answers already found in the tail.
		let pendingResponses: { response: AgentResponse; fresh: boolean }[] | null = [];
		const backfillIsFresh = (response: AgentResponse) => {
			const seen = seenBeforeDrop.get(path);
			return !initial && response.time >= startedAt - clockSkewMs && (seen === undefined || response.time > seen);
		};
		const notifyResponse = (response: AgentResponse, fresh: boolean) => {
			for (const listener of responseListeners) listener(state, response, fresh);
		};
		entry.tail = tailJsonl(path, value => {
			for (const event of read(value)) {
				if (event.kind === "title") { state.title = event.title; if (event.named) named.add(id); }
				else if (event.kind === "working") { state.working = event.working; state.lastActivity = Math.max(state.lastActivity, event.time); }
				else {
					const response = event.response;
					const revision = state.latest?.key === response.key;
					state.latest = response;
					const known = state.history.findIndex(r => r.key === response.key);
					if (known >= 0) state.history[known] = response;
					else {
						state.history.push(response);
						if (state.history.length > SESSION_HISTORY) state.history.shift();
					}
					if (!revision) state.responseCount++;
					state.lastActivity = Math.max(state.lastActivity, response.time);
					// History: anything read while catching up with a log that existed at
					// start-up, or older entries in a log discovered later.
					const fresh = !backfilling || backfillIsFresh(response);
					if (pendingResponses) pendingResponses.push({ response, fresh });
					else notifyResponse(response, fresh);
				}
			}
			if (!pendingResponses) changed();
		}, { intervalMs: options.tailIntervalMs, maxBackfillBytes: options.maxBackfillBytes ?? 2_000_000, onError: error => log(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`) });
		await entry.tail.ready;
		if (closed) return;
		backfilling = false;
		// The tail starts near the end of the log; fill the history from further
		// back when that part held too few responses.
		if (state.history.length < SESSION_HISTORY) {
			const earlier = await recentResponses(agent, path, SESSION_HISTORY).catch(() => []);
			if (closed) return;
			const known = new Set(state.history.map(r => r.key));
			const older = earlier.filter(r => !known.has(r.key) && (state.history.length === 0 || r.time <= state.history[0]!.time));
			if (older.length) {
				state.history = [...older, ...state.history].slice(-SESSION_HISTORY);
				state.responseCount = Math.max(state.responseCount, state.history.length);
				if (!state.latest) state.latest = state.history.at(-1) ?? null;
				pendingResponses.unshift(...older.map(response => ({ response, fresh: backfillIsFresh(response) })));
			}
		}
		// The tail starts near the end of long logs, so a prompt-based title would
		// come from mid-session. The agent's own title (from the tail) still wins.
		if (!state.title || !namedTitleSeen(state)) {
			const first = await firstPromptTitle(agent, path).catch(() => null);
			if (first && !namedTitleSeen(state)) state.title = first;
		}
		if (closed) return;
		const pending = pendingResponses;
		pendingResponses = null;
		for (const { response, fresh } of pending) {
			if (closed) return;
			notifyResponse(response, fresh);
		}
		changed();
	}

	async function scan() {
		if (scanning || closed) return;
		scanning = true;
		try {
			if (options.sessionPaths) {
				for (const { agent, path } of options.sessionPaths) {
					const info = await stat(path).catch(() => null);
					await track(agent, path, info?.mtimeMs ?? Date.now());
				}
				return;
			}
			const now = Date.now();
			for (const agent of agents) {
				const files = await find(agent, cwd);
				const chosen = files.filter(file => now - file.mtimeMs <= recentMs).slice(0, maxPerAgent);
				for (const file of chosen) await track(agent, file.path, file.mtimeMs);
				// Stop following sessions that left the window (too old, or displaced
				// by newer ones), so the limits hold for the whole run.
				const keep = new Set(chosen.map(file => file.path));
				let dropped = false;
				for (const [id, entry] of tracked) {
					if (entry.state.agent !== agent || keep.has(entry.state.path)) continue;
					entry.tail.close();
					tracked.delete(id);
					named.delete(id);
					seenBeforeDrop.set(entry.state.path, Math.max(seenBeforeDrop.get(entry.state.path) ?? -Infinity, ...entry.state.history.map(r => r.time)));
					dropped = true;
				}
				if (dropped) changed();
			}
		} catch (error) {
			log(`Session scan failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally { scanning = false; }
	}

	const ready = scan().then(() => { initialScanDone = true; });
	const timer = setInterval(() => void scan(), options.rescanMs ?? 2_000);
	timer.unref();

	return {
		ready,
		sessions: () => [...tracked.values()].map(t => t.state).sort((a, b) => b.lastActivity - a.lastActivity),
		get: id => tracked.get(id)?.state,
		onResponse(listener) { responseListeners.add(listener); return () => responseListeners.delete(listener); },
		onChange(listener) { changeListeners.add(listener); return () => changeListeners.delete(listener); },
		close() {
			closed = true;
			clearInterval(timer);
			for (const { tail } of tracked.values()) tail.close();
		},
	};
}
