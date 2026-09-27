// Follows recently active agent sessions in one directory or across projects. Each session log
// is tailed continuously; OpenCode's mutable SQLite projections are polled via
// read-only snapshots. Several concurrent sessions can be followed together.
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { AGENTS, createSessionFinder, createSessionReader, sessionShortId, type AgentKind, type AgentResponse, type SessionRoots, type SessionFile } from "./sessions.js";
import { tailJsonl, type JsonlTail } from "./tail.js";

export interface SessionState {
	/** URL-safe id, derived from the log path. */
	id: string;
	agent: AgentKind;
	path: string;
	/** Resource root for this session, never the global index's launch directory. */
	cwd: string;
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
	allProjects?: boolean;
	agents?: readonly AgentKind[];
	/** Follow exactly these log paths / OpenCode selectors (no discovery). */
	sessionPaths?: { agent: AgentKind; path: string }[];
	roots?: SessionRoots;
	/** Only sessions whose log was modified within this window are followed. */
	recentMs?: number;
	/** Per agent per project in all-projects mode. */
	maxPerAgent?: number;
	/** Total followed sessions (default 64 across projects; no extra cap locally). */
	maxSessions?: number;
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
export const ALL_PROJECTS_SESSION_LIMIT = 64;

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
	const agents = [...new Set(options.agents ?? AGENTS)];
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
	const scanErrors = new Map<AgentKind, string>();

	async function track(agent: AgentKind, path: string, mtimeMs: number, sessionCwd = cwd) {
		const id = sessionId(options.allProjects ? `${sessionCwd}\0${path}` : path);
		if (tracked.has(id) || closed) return;
		const state: SessionState = { id, agent, path, cwd: sessionCwd, shortId: sessionShortId(path), title: null, working: false, lastActivity: mtimeMs, latest: null, history: [], responseCount: 0 };
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
		if (agent === "opencode") {
			let stopped = false, polling = false, initialized = false, lastError = "";
			let seenTime = seenBeforeDrop.get(path) ?? -Infinity;
			let seenOrder: string | number | undefined;
			let lastSnapshot: unknown;
			const poll = async () => {
				if (stopped || closed || polling) return;
				polling = true;
				try {
					if (!find.opencode) throw new Error("No OpenCode database configured.");
					const snapshot = await find.opencode.snapshot(path);
					if (stopped || closed || !snapshot || snapshot === lastSnapshot) return;
					lastSnapshot = snapshot;
					lastError = "";
					const old = new Map(state.history.map(response => [response.key, response]));
					const responses = snapshot.history.filter(response => old.get(response.key)?.markdown !== response.markdown);
					const dirty = responses.length > 0 || state.history.length !== snapshot.history.length || state.title !== snapshot.title
						|| state.working !== snapshot.working || state.lastActivity !== snapshot.lastActivity;
					state.title = snapshot.title;
					state.working = snapshot.working;
					state.lastActivity = snapshot.lastActivity;
					state.history = snapshot.history.slice();
					state.latest = state.history.at(-1) ?? null;
					for (const response of responses) {
						if (closed || stopped) return;
						if (!old.has(response.key)) state.responseCount++;
						const order = snapshot.order.get(response.key);
						const advanced = order !== undefined && seenOrder !== undefined && typeof order === typeof seenOrder
							? order > seenOrder : response.time >= seenTime;
						const fresh = initialized ? old.has(response.key) || advanced : backfillIsFresh(response);
						notifyResponse(response, fresh);
					}
					const newestOrder = state.latest && snapshot.order.get(state.latest.key);
					if (newestOrder != null && (seenOrder === undefined || typeof newestOrder !== typeof seenOrder || newestOrder > seenOrder)) seenOrder = newestOrder;
					seenTime = Math.max(seenTime, ...state.history.map(response => response.time));
					initialized = true;
					if (dirty && !closed && !stopped) changed();
				} catch (error) {
					const message = `Could not read OpenCode history: ${error instanceof Error ? error.message : String(error)}`;
					if (!stopped && !closed && message !== lastError) { lastError = message; log(message); }
				} finally { polling = false; }
			};
			const timer = setInterval(() => void poll(), options.tailIntervalMs ?? 300);
			timer.unref();
			entry.tail = { ready: poll(), poll, close() { stopped = true; clearInterval(timer); } };
			await entry.tail.ready;
			return;
		}
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
			const candidates: SessionFile[] = [];
			for (const agent of agents) {
				let files;
				try { files = options.allProjects ? await find.all(agent, { since: now - recentMs }) : await find(agent, cwd); scanErrors.delete(agent); }
				catch (error) {
					const message = `Could not discover ${agent} sessions: ${error instanceof Error ? error.message : String(error)}`;
					if (scanErrors.get(agent) !== message) { scanErrors.set(agent, message); log(message); }
					// Keep the last good selection on a transient error, within the limits.
					files = [...tracked.values()].filter(entry => entry.state.agent === agent).map(({ state }) => ({ agent, path: state.path, cwd: state.cwd, mtimeMs: state.lastActivity }));
				}
				candidates.push(...files.filter(file => now - file.mtimeMs <= recentMs));
			}
			const counts = new Map<string, number>();
			const chosen: SessionFile[] = [];
			const maxSessions = options.maxSessions ?? (options.allProjects ? ALL_PROJECTS_SESSION_LIMIT : Infinity);
			for (const file of candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
				const project = options.allProjects ? file.cwd : cwd;
				if (!project) continue;
				const key = JSON.stringify([file.agent, project]);
				if ((counts.get(key) ?? 0) >= maxPerAgent) continue;
				if (chosen.length >= maxSessions) break;
				counts.set(key, (counts.get(key) ?? 0) + 1);
				chosen.push({ ...file, cwd: project });
			}
			const keep = new Set(chosen.map(file => sessionId(options.allProjects ? `${file.cwd}\0${file.path}` : file.path)));
			let dropped = false;
			for (const [id, entry] of tracked) {
				if (keep.has(id)) continue;
				entry.tail.close(); tracked.delete(id); named.delete(id);
				seenBeforeDrop.set(entry.state.path, Math.max(seenBeforeDrop.get(entry.state.path) ?? -Infinity, ...entry.state.history.map(r => r.time)));
				dropped = true;
			}
			while (seenBeforeDrop.size > 4096) seenBeforeDrop.delete(seenBeforeDrop.keys().next().value!);
			if (dropped) changed();
			// Drop before adding, so even a full rotation respects the global bound.
			for (const file of chosen) await track(file.agent, file.path, file.mtimeMs, file.cwd);
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
			find.close();
		},
	};
}
