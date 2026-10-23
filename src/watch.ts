// Browser views: a session index for a directory, one watch page per session,
// a merged view of all sessions, and single-file watching. Rendering and the
// watch page are pi-markdown-preview's; this module decides what to show when.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, resolve } from "node:path";
import { ALL_PROJECTS_SESSION_LIMIT, createSessionMonitor, type SessionMonitor, type SessionState } from "./monitor.js";
import { localDocumentRenderer } from "./linked-documents.js";
import { createOpenCodeStore, openCodeSessionId, openCodeSessionPath, type OpenCodeLiveEvent, type OpenCodeLiveTurn, type OpenCodeStore } from "./opencode.js";
import {
	buildBrowserHtmlFromPandocFragment, DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX,
	normalizePreviewFontSizePx, prepareFilePreview, renderPreviewHtmlDocument, type PreviewStyle,
} from "./render.js";
import { styleForMode, themeFinisher } from "./theme.js";
import type { PageTheme } from "./appearance.js";
import { AGENT_LABELS, AGENTS, defaultSessionRoots, detectAgent, modelLabel, type AgentKind, type AgentResponse, type SessionRoots } from "./sessions.js";
import { createBrowserWatchServer } from "./shared/browser-watch-server.js";
import { isHtmlPagePath } from "./shared/html-page-preview.js";
import { readLinkedDocument } from "./shared/read-linked-document.js";
import { readRecordTail, readTurnDetails } from "./shared/read-turn-details.js";
import { createLiveTurnProjector } from "./shared/turn-details.js";
import { AGENT_PAGE_STYLE, applyPreviewAppearance } from "./shared/agent-page-style.js";
import { createSlotStore, defaultStateDir, startAtSlot, type SlotStore } from "./slots.js";

const PAGE_TEXT = { titleSuffix: "Agent Markdown Preview", expiredHint: "Run agent-markdown-preview again for a fresh link." };
/** Remembered addresses make restarted previews reconnect; `null` disables. */
const slotStore = (stateDir: string | null | undefined, turnDetails = false, live = false): SlotStore | null => {
	if (stateDir === null) return null;
	const store = createSlotStore(stateDir ?? defaultStateDir());
	if (!turnDetails && !live) return store;
	// Previously shared ordinary-preview or Working links must not gain trace or live access.
	const scope = live ? "live|" : "turn-details|";
	return { get: key => store.get(scope + key), set: (key, slot) => store.set(scope + key, slot),
		recent: (prefix, ms) => store.recent(scope + prefix, ms).map(key => key.slice(scope.length)) };
};

export { styleForMode };

export interface RunningWatch {
	url: string;
	label: string;
	/** True when this started at a remembered address, where an old tab may reconnect. */
	reused: boolean;
	/** Resolves true once a page is connected (e.g. a reconnecting tab), or false after `timeoutMs`. */
	waitForViewer(timeoutMs: number): Promise<boolean>;
	close(): Promise<void>;
}

async function pollFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) return false;
		await new Promise(done => setTimeout(done, 100));
	}
	return true;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const sessionLabel = (s: SessionState) => `${AGENT_LABELS[s.agent]} ${s.shortId}${s.title ? ` · ${s.title}` : ""}`;
const timeOfDay = (time: number) => new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

interface ResponseView {
	url: string;
	reused: boolean;
	readonly clientCount: number;
	readonly shownKey: string | null;
	show(response: AgentResponse): void;
	close(): Promise<void>;
}

/** Live recorded activity for one session; see createLiveSource. */
export interface LiveSource {
	current(signal?: AbortSignal): Promise<string | undefined>;
	snapshot(anchor: string, signal?: AbortSignal): Promise<object | undefined>;
	close(): void;
}

const LIVE_LEASE_MS = 30_000;
/** Sessions this process follows live at once; each keeps a bounded projection (see createLiveTurnProjector). */
const LIVE_SESSION_LIMIT = 4;
// Records arriving while a backfill reads; more than this means reading the file again.
const LIVE_PENDING_LIMIT = 10_000;
const LIVE_PENDING_BYTES = 1024 * 1024;
const LIVE_READ_ATTEMPTS = 3;

/** Admission for live sources: a few leases at once, and one backfill read at a time. */
export interface LiveLeases {
	take(): boolean;
	give(): void;
	readonly active: number;
	exclusive<T>(read: () => Promise<T>): Promise<T>;
}
export function createLiveLeases(limit = LIVE_SESSION_LIMIT): LiveLeases {
	let active = 0, queue: Promise<unknown> = Promise.resolve();
	return {
		take: () => active < limit ? (active++, true) : false,
		give: () => { active = Math.max(0, active - 1); },
		get active() { return active; },
		// The barrier keeps no result: a read's records belong to its caller alone.
		exclusive<T>(read: () => Promise<T>) { const run = queue.then(read, read); queue = run.then(() => {}, () => {}); return run; },
	};
}
const processLeases = createLiveLeases();
/** The browser watch server answers this with "Live Working is busy". */
class LiveBusyError extends Error { readonly code = "LIVE_BUSY"; }
/** Agents whose recorded turns Live can follow (createLiveTurnProjector; OpenCode: createOpenCodeLiveSource). */
const LIVE_AGENTS: ReadonlySet<AgentKind> = new Set(["claude", "pi", "codex", "opencode"]);
const followsLive = (agent: AgentKind | undefined) => agent !== undefined && LIVE_AGENTS.has(agent);
const liveSourceFor = (monitor: Pick<SessionMonitor, "onRecord">, session: { id: string; path: string; agent?: AgentKind }) =>
	session.agent === "opencode" ? createOpenCodeLiveSource(session) : createLiveSource(monitor, session);

/**
 * Live recorded activity for one Claude Code, Pi or Codex session (OpenCode: see
 * createOpenCodeLiveSource). Nothing is allocated
 * until a live page asks; each request renews a lease, and 30 s without one
 * drops the projection and the record subscription. A truncated or replaced
 * file drops it too: the next request reads the file as it is now, as a new
 * generation. Exported for tests.
 */
export function createLiveSource(monitor: Pick<SessionMonitor, "onRecord">, session: { id: string; path: string; agent?: AgentKind }, { leaseMs = LIVE_LEASE_MS, leases = processLeases }: { leaseMs?: number; leases?: LiveLeases } = {}): LiveSource {
	type Projector = ReturnType<typeof createLiveTurnProjector>;
	type Lease = { projector?: Projector; ready: Promise<void>; unsubscribe: () => void; timer?: NodeJS.Timeout };
	let lease: Lease | undefined;
	const release = () => {
		if (!lease) return;
		clearTimeout(lease.timer);
		lease.unsubscribe();
		lease = undefined;
		leases.give();
	};
	const start = (): Lease => {
		if (!leases.take()) throw new LiveBusyError("Live Working is following as many sessions as it allows.");
		let pending: { record: unknown; offset?: number }[] = [], pendingBytes = 0, overflow = false, end = Infinity;
		const created: Lease = { ready: Promise.resolve(), unsubscribe: () => {} };
		// Subscribe before backfilling; records read twice are ignored by their ids. A
		// line that starts before the backfill's end is not newer than it: a lagging
		// tail can deliver an earlier line, which must never be projected after newer
		// ones. A tail that stops or starts again resets the subscription (see onRecord).
		const older = (offset?: number) => offset !== undefined && offset < end;
		created.unsubscribe = monitor.onRecord(session.id, (record, length, offset) => {
			if (created.projector) { if (!older(offset)) created.projector.push(record, Date.now()); return; }
			if (overflow) return;
			pendingBytes += length;
			if (pending.length >= LIVE_PENDING_LIMIT || pendingBytes > LIVE_PENDING_BYTES) { overflow = true; pending = []; return; }
			pending.push({ record, offset });
		}, () => {
			// This projection describes the old file: never mix the two.
			if (lease === created) release();
		});
		created.ready = (async () => {
			for (let attempt = 1; ; attempt++) {
				const read = await leases.exclusive(() => readRecordTail(session.path));
				// Records dropped while reading are in the file now: read it again. Never
				// accept a read that missed records; a later request starts over.
				if (overflow) {
					if (attempt >= LIVE_READ_ATTEMPTS) throw new Error("Recorded activity is arriving faster than it can be read; try again shortly.");
					overflow = false; pendingBytes = 0; continue;
				}
				const projector = createLiveTurnProjector(session.agent ?? "claude", { partialStart: read.startsMidway });
				const loadedAt = Date.now();
				for (const record of read.records) projector.push(record, loadedAt, true);
				end = read.end;
				for (const { record, offset } of pending.splice(0)) if (!older(offset)) projector.push(record, Date.now());
				created.projector = projector;
				return;
			}
		})();
		created.ready.catch(() => { if (lease === created) release(); });
		return created;
	};
	const ensure = async () => {
		for (let attempt = 1; ; attempt++) {
			lease ??= start();
			const active = lease;
			clearTimeout(active.timer);
			active.timer = setTimeout(() => { if (lease === active) release(); }, leaseMs);
			active.timer.unref();
			await active.ready;
			if (lease === active && active.projector) return active.projector;
			// The file was reset while reading: start again from the file as it is now.
			if (attempt >= LIVE_READ_ATTEMPTS) throw new Error("The session file keeps changing; try again shortly.");
		}
	};
	return {
		current: async () => (await ensure()).current(),
		snapshot: async anchor => (await ensure()).snapshot(anchor),
		close: release,
	};
}

/** What the page compares to decide whether a card changed: everything a card shows, image bytes included. */
function liveCardVersion(event: OpenCodeLiveEvent) {
	const { id: _id, ...shown } = event;
	return createHash("sha256").update(JSON.stringify(shown)).digest("base64url").slice(0, 22);
}

/**
 * Live recorded activity for one OpenCode v2 session. OpenCode updates its rows in
 * place instead of appending, so a request re-reads the turn when the session's
 * revision moves and compares its cards by id: only changed cards carry the new
 * sequence, and cards no longer in the turn leave the page's list. A replaced
 * database starts every view again in a new generation, which the page resyncs to.
 * Leases as createLiveSource. Exported for tests.
 */
export function createOpenCodeLiveSource(session: { path: string }, { leaseMs = LIVE_LEASE_MS, leases = processLeases, openStore = createOpenCodeStore }: { leaseMs?: number; leases?: LiveLeases; openStore?: (database: string) => Pick<OpenCodeStore, "live" | "close"> } = {}): LiveSource {
	type View = { revision: string; generation: string; sequence: number; versions: Map<string, string>; changed: Map<string, number>; summary: string; updatedAt: number; loaded: boolean; snapshot?: object };
	type Lease = { store: Pick<OpenCodeStore, "live" | "close">; views: Map<string, View>; database?: string; replaced?: boolean; current?: { revision: string; anchor?: string }; timer?: NodeJS.Timeout };
	const database = session.path.slice(0, session.path.lastIndexOf("#"));
	let lease: Lease | undefined;
	const release = () => {
		if (!lease) return;
		clearTimeout(lease.timer);
		lease.store.close();
		lease = undefined;
		leases.give();
	};
	const renew = () => {
		if (!lease) {
			if (!leases.take()) throw new LiveBusyError("Live Working is following as many sessions as it allows.");
			lease = { store: openStore(database), views: new Map() };
		}
		const active = lease;
		clearTimeout(active.timer);
		active.timer = setTimeout(() => { if (lease === active) release(); }, leaseMs);
		active.timer.unref();
		return active;
	};
	const apply = (active: Lease, turn: OpenCodeLiveTurn, revision: string) => {
		const existing = active.views.get(turn.anchor);
		// Activity read when the page first asks is Loaded; anything after is Updated.
		const view: View = existing ?? { revision, generation: Math.random().toString(36).slice(2, 10), sequence: 0, versions: new Map(), changed: new Map(), summary: "", updatedAt: Date.now(), loaded: !active.replaced };
		view.revision = revision;
		const next = view.sequence + 1;
		let moved = false;
		const ids = new Set<string>();
		for (const event of turn.events) {
			ids.add(event.id);
			const version = liveCardVersion(event);
			if (view.versions.get(event.id) !== version) { view.versions.set(event.id, version); view.changed.set(event.id, next); moved = true; }
		}
		// Cards no longer shown (revert, or older than the window): forget them, so one that
		// comes back is sent again.
		for (const id of view.versions.keys()) if (!ids.has(id)) { view.versions.delete(id); view.changed.delete(id); moved = true; }
		const summary = JSON.stringify([turn.status, turn.finalKey ?? null, turn.answerUnavailable === true, turn.newerAnchor ?? null, turn.omitted, turn.notices]);
		if (summary !== view.summary) { view.summary = summary; moved = true; }
		if (moved) {
			view.sequence = next;
			if (view.snapshot) { view.loaded = false; view.updatedAt = Date.now(); }
		}
		view.snapshot = {
			generation: view.generation, anchor: turn.anchor, sourceAgent: "opencode", status: turn.status, finalKey: turn.finalKey,
			...(turn.answerUnavailable ? { answerUnavailable: true } : {}),
			sequence: view.sequence, updatedAt: view.updatedAt, loaded: view.loaded, omitted: turn.omitted, notices: turn.notices,
			events: turn.events.map(event => ({ ...event, changed: view.changed.get(event.id) ?? 0, version: view.versions.get(event.id) })),
			...(turn.newerAnchor ? { newerAnchor: turn.newerAnchor } : {}),
		};
		active.views.delete(turn.anchor);
		active.views.set(turn.anchor, view);
		while (active.views.size > 4) active.views.delete(active.views.keys().next().value!);
		return view.snapshot;
	};
	const read = async (anchor: string | undefined, signal = new AbortController().signal) => {
		const active = renew();
		const view = anchor === undefined ? undefined : active.views.get(anchor);
		const since = anchor === undefined ? active.current?.revision : view?.revision;
		const result = await leases.exclusive(() => active.store.live(session.path, anchor, since, signal));
		if (lease !== active) return { current: undefined, snapshot: undefined };
		if (!result) { active.current = undefined; active.views.clear(); return { current: undefined, snapshot: undefined }; }
		// Another database at the same path: nothing read from the old one carries over.
		if (active.database !== undefined && active.database !== result.database) { active.views.clear(); active.current = undefined; active.replaced = true; }
		active.database = result.database;
		if (result.unchanged) {
			const cached = anchor === undefined ? undefined : active.views.get(anchor);
			return { current: active.current?.anchor, snapshot: cached?.snapshot };
		}
		active.current = { revision: result.revision, anchor: result.current };
		if (!result.turn) { if (anchor !== undefined) active.views.delete(anchor); return { current: result.current, snapshot: undefined }; }
		return { current: result.current, snapshot: apply(active, result.turn, result.revision) };
	};
	return {
		current: async signal => (await read(undefined, signal)).current,
		snapshot: async (anchor, signal) => (await read(anchor, signal)).snapshot,
		close: release,
	};
}

interface ViewOptions {
	cwd: string;
	turnDetails?: boolean;
	/** Live recorded activity for this view's single session. */
	live?: LiveSource;
	style: PreviewStyle;
	fontSizePx: number;
	label: string;
	/** Responses to start with, oldest first; the last one is shown. */
	history: AgentResponse[];
	waitingText: string;
	/** Prefix each response with its source (merged views). */
	caption?: (response: AgentResponse) => string | null;
	log: (message: string) => void;
	onRendered?: (response: AgentResponse, revision: number) => void;
	slots: SlotStore | null;
	slotKey: string;
	/** Final touch to every page (light/dark following). */
	finish: (html: string) => string;
	agentThemes?: Record<AgentKind, RenderTheme>;
}

/** One watch page following a stream of responses. Same key = revise in place. */
async function createResponseView(options: ViewOptions): Promise<ResponseView> {
	const markdownFor = (response: AgentResponse) => {
		const caption = options.caption?.(response);
		// The render pipeline does not pass raw HTML through, so the caption is
		// Markdown: one line, with all ASCII punctuation as character references so
		// that it reads as recorded (no entities, links, math or smart quotes).
		// Backslash escapes are not enough: the math step pairs \( and \[ with a
		// closing delimiter anywhere later, even in the answer.
		return caption ? `*${caption.replace(/\s+/g, " ").trim().replace(/[!-/:-@[-`{-~]/g, c => `&#${c.charCodeAt(0)};`)}*\n\n${response.markdown}` : response.markdown;
	};
	const detailsFor = (response?: AgentResponse) => options.turnDetails && response ? async (signal: AbortSignal) => {
		if (response.agent !== "opencode") return readTurnDetails(response.sessionPath, response.agent, response, signal);
		const store = createOpenCodeStore(response.sessionPath.slice(0, response.sessionPath.lastIndexOf("#")));
		try { return await store.turnDetails(response, signal); } finally { store.close(); }
	} : undefined;
	const responseTheme = (response: AgentResponse) => options.agentThemes?.[response.agent] ?? options;
	const render = async (response: AgentResponse) => {
		const { style, finish } = responseTheme(response);
		return finish((await renderPreviewHtmlDocument(markdownFor(response), style, options.cwd, false, options.fontSizePx)).html);
	};
	// Keep linked documents tied to their source revision in mixed-agent history.
	// Stores theme objects only, not response text. More than the server's retained history.
	const revisionThemes = new Map<number, RenderTheme>();
	const rememberTheme = (revision: number, response: AgentResponse) => {
		revisionThemes.set(revision, responseTheme(response));
		while (revisionThemes.size > 128) revisionThemes.delete(revisionThemes.keys().next().value!);
	};
	// Fill the page history from the logs (up to 4 pandoc runs at once), in order.
	const rendered: ({ response: AgentResponse; html: string } | null)[] = new Array(options.history.length).fill(null);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(4, options.history.length) }, async () => {
		while (next < options.history.length) {
			const index = next++;
			const response = options.history[index]!;
			try { rendered[index] = { response, html: await render(response) }; }
			catch (error) { options.log(`Could not render an earlier ${AGENT_LABELS[response.agent]} response: ${errorMessage(error)}`); }
		}
	}));
	const seeded = rendered.filter((entry): entry is { response: AgentResponse; html: string } => entry !== null);
	const initialHtml = seeded[0]?.html
		?? options.finish(buildBrowserHtmlFromPandocFragment(`<p>${escapeHtml(options.waitingText)}</p>`, options.style, options.cwd, [], options.fontSizePx));
	const { started: server, reused } = await startAtSlot(options.slots, options.slotKey, (port, token) => createBrowserWatchServer(initialHtml, options.cwd, {
		initialDocumentIsHistory: seeded.length > 0, sourceLabel: options.label, port, token, ...PAGE_TEXT,
		initialTurnDetails: detailsFor(seeded[0]?.response),
		initialResponseKey: seeded[0]?.response.key,
		...(options.live ? { live: options.live } : {}),
		renderLocalDocument: (path, signal, revision) => {
			const { style, finish } = revisionThemes.get(revision ?? 1) ?? options;
			return localDocumentRenderer(style, options.fontSizePx, finish)(path, signal);
		},
	}));
	if (seeded[0]) rememberTheme(1, seeded[0].response);
	for (const { html, response } of seeded.slice(1)) rememberTheme(server.updateDocument(html, { appendToHistory: true, turnDetails: detailsFor(response), responseKey: response.key }), response);
	const shown = seeded.at(-1)?.response;
	let shownKey = shown?.key ?? null, shownMarkdown = shown?.markdown ?? "", shownModel = shown?.model, closed = false;
	let queue = Promise.resolve();
	return {
		url: server.url,
		reused,
		get clientCount() { return server.clientCount; },
		get shownKey() { return shownKey; },
		show(response) {
			// The caption names the model, so a model-only change revises it too.
			if (closed || (response.key === shownKey && response.markdown === shownMarkdown && response.model === shownModel)) return;
			const appendToHistory = response.key !== shownKey;
			shownKey = response.key;
			shownMarkdown = response.markdown;
			shownModel = response.model;
			queue = queue.then(async () => {
				if (closed) return;
				try {
					const html = await render(response);
					if (closed) return;
					// Not inside the optional call: `f?.(g())` skips g() when f is absent.
					const revision = server.updateDocument(html, { appendToHistory, turnDetails: detailsFor(response), responseKey: response.key });
					rememberTheme(revision, response);
					options.onRendered?.(response, revision);
				} catch (error) {
					options.log(`Could not render a ${AGENT_LABELS[response.agent]} response: ${errorMessage(error)}`);
				}
			});
		},
		async close() {
			closed = true;
			options.live?.close();
			await queue.catch(() => {});
			await server.close();
		},
	};
}

interface CommonOptions {
	cwd: string;
	/** Opt-in: expose recorded prompts/tool activity for retained responses. */
	turnDetails?: boolean;
	/** Opt-in: follow a session's current turn as it is recorded (implies turnDetails). */
	live?: boolean;
	style: PreviewStyle;
	/** Cross-project grouped index; response watches stay folder-scoped. */
	allProjects?: boolean;
	agents?: readonly AgentKind[];
	fontSizePx?: number;
	roots?: SessionRoots;
	rescanMs?: number;
	tailIntervalMs?: number;
	recentMs?: number;
	log?: (message: string) => void;
	onRendered?: (response: AgentResponse, revision: number) => void;
	/** Where preview addresses are remembered (default ~/.agent-markdown-preview; null: don't). */
	stateDir?: string | null;
	/** Earlier responses each preview starts with, from the logs (default 10; 0: only the latest). */
	historyFill?: number;
	/** Follow the system light/dark setting live: `style` is used for light, `darkStyle` for dark. */
	followSystemTheme?: boolean;
	/** Dark counterpart of `style` when following the system (default: the built-in dark palette). */
	darkStyle?: PreviewStyle;
	/** Optional source-specific palettes; the overview and waiting pages use `style`. */
	agentThemes?: Record<AgentKind, PageTheme>;
}

interface RenderTheme { style: PreviewStyle; finish: (html: string) => string }
/** Style and page finisher for a set of options. */
const themeFor = (options: { style: PreviewStyle; followSystemTheme?: boolean; darkStyle?: PreviewStyle; agentThemes?: Record<AgentKind, PageTheme>; log?: (message: string) => void }, fontSizePx: number): RenderTheme & { agentThemes?: Record<AgentKind, RenderTheme> } => ({
	style: options.style,
	finish: themeFinisher(options.followSystemTheme === true, fontSizePx, options.log ?? (() => {}), options.style, options.darkStyle ?? styleForMode("dark")),
	agentThemes: options.agentThemes && Object.fromEntries(AGENTS.map(agent => [agent, themeFor({ ...options.agentThemes![agent], log: options.log }, fontSizePx)])) as Record<AgentKind, RenderTheme> | undefined,
});

const fillCount = (options: CommonOptions) => Math.max(1, Math.min(20, Math.floor(options.historyFill ?? 10)));

async function openMonitor(options: CommonOptions & { sessionPath?: string; sessionAgent?: AgentKind }) {
	const cwd = await realpath(resolve(options.cwd));
	let sessionPaths: { agent: AgentKind; path: string }[] | undefined;
	let roots = options.roots;
	if (options.sessionPath) {
		const id = openCodeSessionId(options.sessionPath);
		if (id) {
			const separator = options.sessionPath.lastIndexOf("#");
			const database = await realpath(resolve(separator >= 0 ? options.sessionPath.slice(0, separator) : roots?.opencode ?? defaultSessionRoots().opencode));
			const path = openCodeSessionPath(database, id);
			const store = createOpenCodeStore(database);
			try { if (!await store.snapshot(path)) throw new Error(`OpenCode session ${id} was not found in ${database}.`); }
			finally { store.close(); }
			roots = { ...(roots ?? defaultSessionRoots()), opencode: database };
			sessionPaths = [{ agent: "opencode", path }];
		} else {
			const path = await realpath(resolve(options.sessionPath));
			const agent = options.sessionAgent ?? await detectAgent(path) ?? (options.agents?.length === 1 ? options.agents[0] : null);
			if (!agent) throw new Error(`Could not tell which agent wrote ${path}; pass --agent claude|codex|pi.`);
			if (agent === "opencode") throw new Error("Use --session ses_… for OpenCode, with --opencode-db for a custom database.");
			sessionPaths = [{ agent, path }];
		}
	}
	const monitor = createSessionMonitor({ cwd, allProjects: options.allProjects, agents: options.agents, sessionPaths, roots, rescanMs: options.rescanMs,
		tailIntervalMs: options.tailIntervalMs, recentMs: options.recentMs, log: options.log });
	await monitor.ready;
	return { cwd, monitor, fontSizePx: normalizePreviewFontSizePx(options.fontSizePx, DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX), agents: sessionPaths ? sessionPaths.map(s => s.agent) : [...(options.agents ?? AGENTS)] };
}

/** The most recent `count` responses across sessions, oldest first. */
const recentAcross = (sessions: SessionState[], count: number) => sessions.flatMap(s => s.history).sort((a, b) => a.time - b.time).slice(-count);

/** A small line above each response saying where it came from and which model wrote it. */
function captionFor(monitor: SessionMonitor) {
	return (response: AgentResponse) => {
		const session = monitor.sessions().find(s => s.path === response.sessionPath);
		const title = session?.title ? (session.title.length > 60 ? session.title.slice(0, 59) + "…" : session.title) : null;
		return [`${AGENT_LABELS[response.agent]}${session ? ` ${session.shortId}` : ""}`, response.model ? modelLabel(response.model) : null, title, timeOfDay(response.time)].filter(Boolean).join(" · ");
	};
}

/** Creates the merged view over all monitored sessions (or one pinned session). */
async function mergedView(monitor: SessionMonitor, base: { cwd: string; fontSizePx: number; agents: AgentKind[] }, options: CommonOptions, label: string, slotKey: string, live?: LiveSource) {
	return createResponseView({
		slots: slotStore(options.stateDir, options.turnDetails, options.live), slotKey, turnDetails: options.turnDetails, live, ...themeFor(options, base.fontSizePx),
		cwd: base.cwd, fontSizePx: base.fontSizePx, label, history: recentAcross(monitor.sessions().filter(s => s.cwd === base.cwd), fillCount(options)),
		waitingText: `Waiting for the next completed response from ${base.agents.map(a => AGENT_LABELS[a]).join(", ")} in ${base.cwd}…`,
		caption: captionFor(monitor),
		log: options.log ?? (() => {}), onRendered: options.onRendered,
	});
}

/**
 * One page with the latest response from every followed session in `cwd`
 * (captioned by source), or from a single `sessionPath`.
 */
export async function startResponseWatch(options: CommonOptions & { sessionPath?: string; sessionAgent?: AgentKind }): Promise<RunningWatch> {
	if (options.allProjects) throw new Error("Use the all-projects index and choose Merged within a folder.");
	const base = await openMonitor(options);
	const pinned = options.sessionPath ? base.monitor.sessions()[0] : null;
	const label = pinned ? sessionLabel(pinned) : `All sessions · ${basename(base.cwd) || base.cwd}`;
	// Listen before rendering the history: a turn can finish while it renders.
	let view: ResponseView | null = null;
	const arrivedDuringStart: AgentResponse[] = [];
	base.monitor.onResponse((_session, response, fresh) => {
		if (!view) { if (fresh) arrivedDuringStart.push(response); }
		else if (fresh || response.key === view.shownKey) view.show(response);
	});
	// Live follows one session: only a pinned session gets it.
	const live = options.live && followsLive(pinned?.agent) ? liveSourceFor(base.monitor, pinned!) : undefined;
	const started = await mergedView(base.monitor, base, options, label, pinned ? `session|${pinned.path}` : `${base.cwd}|merged`, live);
	view = started;
	for (const response of arrivedDuringStart.splice(0)) started.show(response);
	return { url: started.url, label, reused: started.reused, waitForViewer: ms => pollFor(() => started.clientCount > 0, ms), async close() { base.monitor.close(); await started.close(); } };
}

const INDEX_PAGE = readFileSync(new URL("./index-page.html", import.meta.url), "utf8").replace("/*__AGENT_PAGE_STYLE__*/", () => AGENT_PAGE_STYLE);

/**
 * An index for cwd, or grouped across projects. Session and folder-merged
 * pages start on first use; each uses its own project's resource directory.
 */
export async function startSessionIndex(options: CommonOptions): Promise<RunningWatch> {
	const base = await openMonitor(options);
	const { cwd, monitor } = base;
	const overviewTheme = themeFor(options, 14);
	const indexPage = applyPreviewAppearance(INDEX_PAGE, overviewTheme.finish(buildBrowserHtmlFromPandocFragment("", overviewTheme.style, undefined, [], 14)));
	const log = options.log ?? (() => {});
	const slots = slotStore(options.stateDir, options.turnDetails, options.live);
	let token = "", lastPollAt = 0, closed = false;
	const views = new Map<string, Promise<ResponseView>>();
	const started = new Map<string, ResponseView>();
	const hasOpenTab = (id: string) => (started.get(id)?.clientCount ?? 0) > 0;
	const allProjects = options.allProjects === true;
	const label = allProjects ? "All projects" : `${basename(cwd) || cwd}`;
	const indexScope = allProjects ? "all-projects" : cwd;
	const viewPrefix = `${indexScope}|index-view|`;
	const projectId = (path: string) => `project-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`;
	const sessionKey = (s: SessionState) => `${viewPrefix}session|${allProjects ? s.cwd + "|" : ""}${s.path}`;
	const mergedKey = (path: string) => allProjects ? `${viewPrefix}project|${path}` : `${viewPrefix}all`;
	function projects() {
		const grouped = new Map<string, SessionState[]>();
		for (const session of monitor.sessions()) {
			const sessions = grouped.get(session.cwd) ?? [];
			sessions.push(session); grouped.set(session.cwd, sessions);
		}
		return [...grouped].map(([cwd, sessions]) => ({ id: projectId(cwd), cwd, label: basename(cwd) || cwd, sessions, lastActivity: sessions[0]!.lastActivity }))
			.sort((a, b) => b.lastActivity - a.lastActivity || a.cwd.localeCompare(b.cwd));
	}

	function view(id: string): Promise<ResponseView> | null {
		if (closed) return null;
		const existing = views.get(id);
		if (existing) return existing;
		const session = monitor.get(id);
		const project = allProjects ? projects().find(p => p.id === id) : undefined;
		if (!session && !project && !(id === "all" && !allProjects)) return null;
		const resourceCwd = session?.cwd ?? project?.cwd ?? cwd;
		const created = session
			? createResponseView({ cwd: resourceCwd, turnDetails: options.turnDetails, live: options.live && followsLive(session.agent) ? liveSourceFor(monitor, session) : undefined, ...themeFor(options, base.fontSizePx), fontSizePx: base.fontSizePx, label: sessionLabel(session), history: session.history.slice(-fillCount(options)),
				waitingText: `No completed response in this ${AGENT_LABELS[session.agent]} session yet.`, log, onRendered: options.onRendered,
				caption: captionFor(monitor),
				slots, slotKey: sessionKey(session) })
			: mergedView(monitor, { ...base, cwd: resourceCwd }, options, `All sessions · ${project?.cwd ?? label}`, mergedKey(resourceCwd));
		views.set(id, created);
		created.then(v => started.set(id, v), () => views.delete(id));
		return created;
	}
	monitor.onResponse((session, response, fresh) => {
		for (const id of [session.id, allProjects ? projectId(session.cwd) : "all"]) {
			void views.get(id)?.then(v => { if (fresh || response.key === v.shownKey) v.show(response); }, () => {});
		}
	});

	const tokenMatches = (value: string | null) => token.length > 0 && typeof value === "string" && value.length === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token));
	let port = 0;
	const server = createServer(async (req, res) => {
		const send = (status: number, body: string, type = "text/plain; charset=utf-8", extra: Record<string, string> = {}) => {
			res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...extra });
			res.end(body);
		};
		try {
			if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return send(403, "Forbidden host");
			const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
			if (!tokenMatches(url.searchParams.get("token"))) return send(403, "Invalid or expired link. Use the URL printed by agent-markdown-preview.");
			if (url.pathname === "/") {
				return send(200, indexPage, "text/html; charset=utf-8", {
					"Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
				});
			}
			if (url.pathname === "/api/sessions") {
				lastPollAt = Date.now();
				const info = (s: SessionState) => ({
					id: s.id, agent: s.agent, agentLabel: AGENT_LABELS[s.agent], shortId: s.shortId, title: s.title, working: s.working, cwd: s.cwd,
					lastActivity: s.lastActivity, responseCount: s.responseCount, file: basename(s.path), open: hasOpenTab(s.id),
				});
				const groups = allProjects ? projects().map(p => ({ ...p, sessions: p.sessions.map(info), mergedOpen: hasOpenTab(p.id) })) : undefined;
				return send(200, JSON.stringify({ cwd: allProjects ? null : cwd, label, allProjects, now: Date.now(), sessions: monitor.sessions().map(info),
					projects: groups, sessionLimit: allProjects ? ALL_PROJECTS_SESSION_LIMIT : undefined, mergedOpen: hasOpenTab("all") }), "application/json");
			}
			const open = url.pathname.match(/^\/(open|api\/preview-link)\/(all|project-[0-9a-f]{16}|[0-9a-f]{16})$/);
			if (open) {
				const copyLink = open[1] === "api/preview-link";
				if (copyLink && req.method !== "GET") return send(405, "Method not allowed", "text/plain; charset=utf-8", { Allow: "GET" });
				const pending = view(open[2]!);
				if (!pending) return send(404, "That session is no longer followed. Reload the index.");
				const target = await pending;
				// Share only this preview's credentials, never the overview token.
				if (copyLink) return send(200, JSON.stringify({ url: target.url }), "application/json");
				return send(302, "", "text/plain; charset=utf-8", { Location: target.url });
			}
			return send(404, "Not found");
		} catch (error) {
			log(`Index request failed: ${errorMessage(error)}`);
			if (!res.headersSent) send(500, "Could not open that view: " + errorMessage(error));
		}
	});
	const { reused } = await startAtSlot(slots, `${indexScope}|index`, (slotPort, slotToken) => new Promise<void>((done, fail) => {
		const onError = (error: Error) => { server.off("listening", onListening); fail(error); };
		const onListening = () => { server.off("error", onError); token = slotToken; done(); };
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(slotPort, "127.0.0.1");
	}));
	port = (server.address() as { port: number }).port;
	// Bring back previews that were open in the previous run, so their tabs
	// reconnect on their own. Only sessions that are still followed.
	const restorable = new Map(monitor.sessions().map(s => [sessionKey(s), s.id]));
	if (allProjects) for (const p of projects()) restorable.set(mergedKey(p.cwd), p.id);
	else restorable.set(mergedKey(cwd), "all");
	for (const key of slots?.recent(viewPrefix, 24 * 60 * 60 * 1000) ?? []) {
		const id = restorable.get(key);
		if (id) view(id)?.catch(error => log(`Could not restore a preview: ${errorMessage(error)}`));
	}
	const startedAt = Date.now();
	return {
		url: `http://127.0.0.1:${port}/?token=${token}`,
		label: allProjects ? "sessions across projects" : `sessions in ${label}`,
		reused,
		waitForViewer: ms => pollFor(() => lastPollAt >= startedAt, ms),
		async close() {
			if (closed) return;
			closed = true;
			monitor.close();
			await Promise.all([...views.values()].map(v => v.then(x => x.close(), () => {})));
			await new Promise<void>(done => {
				// Bun's close() discards the native server handle, so force-close
				// first there. Keep Node's stop-accepting-before-force-close order.
				if (process.versions.bun) server.closeAllConnections?.();
				server.close(() => done());
				server.closeAllConnections?.();
			});
		},
	};
}

export interface FileWatchOptions {
	filePath: string;
	style: PreviewStyle;
	fontSizePx?: number;
	intervalMs?: number;
	debounceMs?: number;
	log?: (message: string) => void;
	onRendered?: (revision: number) => void;
	/** Where preview addresses are remembered (default ~/.agent-markdown-preview; null: don't). */
	stateDir?: string | null;
	/** Follow the system light/dark setting live: `style` is used for light, `darkStyle` for dark. */
	followSystemTheme?: boolean;
	darkStyle?: PreviewStyle;
}

/** Re-renders a Markdown/LaTeX/code/diff file whenever it changes. */
export async function startFileWatch(options: FileWatchOptions): Promise<RunningWatch> {
	const path = await realpath(resolve(options.filePath));
	const resourcePath = dirname(path);
	const log = options.log ?? (() => {});
	const fontSizePx = normalizePreviewFontSizePx(options.fontSizePx, DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX);
	const htmlPage = isHtmlPagePath(path);
	const snapshot = async () => {
		const content = htmlPage ? await readLinkedDocument(path, new AbortController().signal) : await readFile(path, "utf8");
		return { ...prepareFilePreview(path, content), content, contentHash: createHash("sha256").update(content).digest("hex") };
	};
	const { style, finish } = themeFor(options, fontSizePx);
	const first = await snapshot();
	const initial = { html: htmlPage ? first.content : finish((await renderPreviewHtmlDocument(first.markdown, style, resourcePath, first.isLatex, fontSizePx)).html) };
	const label = basename(path);
	const { started: server, reused } = await startAtSlot(slotStore(options.stateDir), `file|${path}`, (port, token) => createBrowserWatchServer(initial.html, resourcePath, {
		initialDocumentIsHistory: true, sourceLabel: label, preserveReadingPosition: true, htmlFile: htmlPage ? path : undefined, port, token, ...PAGE_TEXT,
		renderLocalDocument: localDocumentRenderer(style, fontSizePx, finish),
	}));

	let lastHash = first.contentHash, lastError: string | undefined, closed = false, inFlight = false, queued = false;
	let debounce: ReturnType<typeof setTimeout> | undefined;
	async function refresh() {
		if (inFlight) { queued = true; return; }
		inFlight = true;
		try {
			do {
				queued = false;
				try {
					const next = await snapshot();
					if (next.contentHash === lastHash) { lastError = undefined; continue; }
					const html = htmlPage ? next.content : finish((await renderPreviewHtmlDocument(next.markdown, style, resourcePath, next.isLatex, fontSizePx)).html);
					if (closed) return;
					const revision = server.updateDocument(html, { appendToHistory: true });
					lastHash = next.contentHash;
					lastError = undefined;
					options.onRendered?.(revision);
				} catch (error) {
					const message = errorMessage(error);
					if (message !== lastError && !closed) log(`Refresh failed for ${path}; keeping the last good preview: ${message}`);
					lastError = message;
				}
			} while (queued && !closed);
		} finally { inFlight = false; }
	}
	const listener = () => {
		if (debounce) clearTimeout(debounce);
		debounce = setTimeout(() => void refresh(), options.debounceMs ?? 150);
	};
	watchFile(path, { interval: options.intervalMs ?? 300 }, listener);
	return {
		url: server.url,
		label,
		reused,
		waitForViewer: ms => pollFor(() => server.clientCount > 0, ms),
		async close() {
			if (closed) return;
			closed = true;
			if (debounce) clearTimeout(debounce);
			unwatchFile(path, listener);
			await server.close();
		},
	};
}
