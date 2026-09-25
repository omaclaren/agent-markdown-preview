// Browser views: a session index for a directory, one watch page per session,
// a merged view of all sessions, and single-file watching. Rendering and the
// watch page are pi-markdown-preview's; this module decides what to show when.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, resolve } from "node:path";
import { createSessionMonitor, type SessionMonitor, type SessionState } from "./monitor.js";
import {
	buildBrowserHtmlFromPandocFragment, DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX,
	normalizePreviewFontSizePx, prepareFilePreview, renderPreviewHtmlDocument, type PreviewStyle,
} from "./render.js";
import { styleForMode, themeFinisher } from "./theme.js";
import { AGENT_LABELS, AGENTS, detectAgent, type AgentKind, type AgentResponse, type SessionRoots } from "./sessions.js";
import { createBrowserWatchServer } from "./shared/browser-watch-server.js";
import { createSlotStore, defaultStateDir, startAtSlot, type SlotStore } from "./slots.js";

const PAGE_TEXT = { titleSuffix: "Agent Markdown Preview", expiredHint: "Run agent-markdown-preview again for a fresh link." };
/** Remembered addresses make restarted previews reconnect; `null` disables. */
const slotStore = (stateDir: string | null | undefined): SlotStore | null => stateDir === null ? null : createSlotStore(stateDir ?? defaultStateDir());

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

interface ViewOptions {
	cwd: string;
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
}

/** One watch page following a stream of responses. Same key = revise in place. */
async function createResponseView(options: ViewOptions): Promise<ResponseView> {
	const markdownFor = (response: AgentResponse) => {
		const caption = options.caption?.(response);
		// The render pipeline does not pass raw HTML through, so the caption is Markdown.
		return caption ? `*${caption.replace(/[\\`*_[\]<>#|~$]/g, "\\$&")}*\n\n${response.markdown}` : response.markdown;
	};
	const render = async (response: AgentResponse) => options.finish((await renderPreviewHtmlDocument(markdownFor(response), options.style, options.cwd, false, options.fontSizePx)).html);
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
	}));
	for (const { html } of seeded.slice(1)) server.updateDocument(html, { appendToHistory: true });
	const shown = seeded.at(-1)?.response;
	let shownKey = shown?.key ?? null, shownMarkdown = shown?.markdown ?? "", closed = false;
	let queue = Promise.resolve();
	return {
		url: server.url,
		reused,
		get clientCount() { return server.clientCount; },
		get shownKey() { return shownKey; },
		show(response) {
			if (closed || (response.key === shownKey && response.markdown === shownMarkdown)) return;
			const appendToHistory = response.key !== shownKey;
			shownKey = response.key;
			shownMarkdown = response.markdown;
			queue = queue.then(async () => {
				if (closed) return;
				try {
					const html = await render(response);
					if (closed) return;
					// Not inside the optional call: `f?.(g())` skips g() when f is absent.
					const revision = server.updateDocument(html, { appendToHistory });
					options.onRendered?.(response, revision);
				} catch (error) {
					options.log(`Could not render a ${AGENT_LABELS[response.agent]} response: ${errorMessage(error)}`);
				}
			});
		},
		async close() {
			closed = true;
			await queue.catch(() => {});
			await server.close();
		},
	};
}

interface CommonOptions {
	cwd: string;
	style: PreviewStyle;
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
}

/** Style and page finisher for a set of options. */
const themeFor = (options: { style: PreviewStyle; followSystemTheme?: boolean; darkStyle?: PreviewStyle; log?: (message: string) => void }, fontSizePx: number) => ({
	style: options.style,
	finish: themeFinisher(options.followSystemTheme === true, fontSizePx, options.log ?? (() => {}), options.style, options.darkStyle ?? styleForMode("dark")),
});

const fillCount = (options: CommonOptions) => Math.max(1, Math.min(20, Math.floor(options.historyFill ?? 10)));

async function openMonitor(options: CommonOptions & { sessionPath?: string; sessionAgent?: AgentKind }) {
	const cwd = await realpath(resolve(options.cwd));
	let sessionPaths: { agent: AgentKind; path: string }[] | undefined;
	if (options.sessionPath) {
		const path = await realpath(resolve(options.sessionPath));
		const agent = options.sessionAgent ?? await detectAgent(path) ?? (options.agents?.length === 1 ? options.agents[0] : null);
		if (!agent) throw new Error(`Could not tell which agent wrote ${path}; pass --agent claude|codex|pi.`);
		sessionPaths = [{ agent, path }];
	}
	const monitor = createSessionMonitor({ cwd, agents: options.agents, sessionPaths, roots: options.roots, rescanMs: options.rescanMs,
		tailIntervalMs: options.tailIntervalMs, recentMs: options.recentMs, log: options.log });
	await monitor.ready;
	return { cwd, monitor, fontSizePx: normalizePreviewFontSizePx(options.fontSizePx, DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX), agents: sessionPaths ? sessionPaths.map(s => s.agent) : [...(options.agents ?? AGENTS)] };
}

/** The most recent `count` responses across sessions, oldest first. */
const recentAcross = (sessions: SessionState[], count: number) => sessions.flatMap(s => s.history).sort((a, b) => a.time - b.time).slice(-count);

/** A small line above each response saying where it came from. */
function captionFor(monitor: SessionMonitor) {
	return (response: AgentResponse) => {
		const session = monitor.sessions().find(s => s.path === response.sessionPath);
		const title = session?.title ? (session.title.length > 60 ? session.title.slice(0, 59) + "…" : session.title) : null;
		return [`${AGENT_LABELS[response.agent]}${session ? ` ${session.shortId}` : ""}`, title, timeOfDay(response.time)].filter(Boolean).join(" · ");
	};
}

/** Creates the merged view over all monitored sessions (or one pinned session). */
async function mergedView(monitor: SessionMonitor, base: { cwd: string; fontSizePx: number; agents: AgentKind[] }, options: CommonOptions, label: string, slotKey: string) {
	return createResponseView({
		slots: slotStore(options.stateDir), slotKey, ...themeFor(options, base.fontSizePx),
		cwd: base.cwd, fontSizePx: base.fontSizePx, label, history: recentAcross(monitor.sessions(), fillCount(options)),
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
	const started = await mergedView(base.monitor, base, options, label, pinned ? `session|${pinned.path}` : `${base.cwd}|merged`);
	view = started;
	for (const response of arrivedDuringStart.splice(0)) started.show(response);
	return { url: started.url, label, reused: started.reused, waitForViewer: ms => pollFor(() => started.clientCount > 0, ms), async close() { base.monitor.close(); await started.close(); } };
}

const INDEX_PAGE = readFileSync(new URL("./index-page.html", import.meta.url), "utf8");

/**
 * A small index of the sessions in `cwd`. Each session (and "all, merged")
 * opens its own watch page, started on first use.
 */
export async function startSessionIndex(options: CommonOptions): Promise<RunningWatch> {
	const base = await openMonitor(options);
	const { cwd, monitor } = base;
	const log = options.log ?? (() => {});
	const slots = slotStore(options.stateDir);
	let token = "", lastPollAt = 0;
	const views = new Map<string, Promise<ResponseView>>();
	const started = new Map<string, ResponseView>();
	const hasOpenTab = (id: string) => (started.get(id)?.clientCount ?? 0) > 0;
	const label = `${basename(cwd) || cwd}`;
	const viewPrefix = `${cwd}|index-view|`;

	function view(id: string): Promise<ResponseView> | null {
		const existing = views.get(id);
		if (existing) return existing;
		const session = id === "all" ? null : monitor.get(id);
		if (id !== "all" && !session) return null;
		const created = session
			? createResponseView({ cwd, ...themeFor(options, base.fontSizePx), fontSizePx: base.fontSizePx, label: sessionLabel(session), history: session.history.slice(-fillCount(options)),
				waitingText: `No completed response in this ${AGENT_LABELS[session.agent]} session yet.`, log, onRendered: options.onRendered,
				caption: captionFor(monitor),
				slots, slotKey: `${viewPrefix}session|${session.path}` })
			: mergedView(monitor, base, options, `All sessions · ${label}`, `${viewPrefix}all`);
		views.set(id, created);
		created.then(v => started.set(id, v), () => views.delete(id));
		return created;
	}
	monitor.onResponse((session, response, fresh) => {
		for (const id of [session.id, "all"]) {
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
				return send(200, INDEX_PAGE, "text/html; charset=utf-8", {
					"Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
				});
			}
			if (url.pathname === "/api/sessions") {
				lastPollAt = Date.now();
				const sessions = monitor.sessions().map(s => ({
					id: s.id, agent: s.agent, agentLabel: AGENT_LABELS[s.agent], shortId: s.shortId, title: s.title, working: s.working,
					lastActivity: s.lastActivity, responseCount: s.responseCount, file: basename(s.path), open: hasOpenTab(s.id),
				}));
				return send(200, JSON.stringify({ cwd, label, now: Date.now(), sessions, mergedOpen: hasOpenTab("all") }), "application/json");
			}
			const open = url.pathname.match(/^\/open\/(all|[0-9a-f]{16})$/);
			if (open) {
				const pending = view(open[1]!);
				if (!pending) return send(404, "That session is no longer followed. Reload the index.");
				const target = await pending;
				return send(302, "", "text/plain; charset=utf-8", { Location: target.url });
			}
			return send(404, "Not found");
		} catch (error) {
			log(`Index request failed: ${errorMessage(error)}`);
			if (!res.headersSent) send(500, "Could not open that view: " + errorMessage(error));
		}
	});
	const { reused } = await startAtSlot(slots, `${cwd}|index`, (slotPort, slotToken) => new Promise<void>((done, fail) => {
		const onError = (error: Error) => { server.off("listening", onListening); fail(error); };
		const onListening = () => { server.off("error", onError); token = slotToken; done(); };
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(slotPort, "127.0.0.1");
	}));
	port = (server.address() as { port: number }).port;
	// Bring back previews that were open in the previous run, so their tabs
	// reconnect on their own. Only sessions that are still followed.
	for (const key of slots?.recent(viewPrefix, 24 * 60 * 60 * 1000) ?? []) {
		const rest = key.slice(viewPrefix.length);
		const id = rest === "all" ? "all" : rest.startsWith("session|") ? monitor.sessions().find(s => s.path === rest.slice("session|".length))?.id : undefined;
		if (id) view(id)?.catch(error => log(`Could not restore a preview: ${errorMessage(error)}`));
	}
	const startedAt = Date.now();
	return {
		url: `http://127.0.0.1:${port}/?token=${token}`,
		label: `sessions in ${label}`,
		reused,
		waitForViewer: ms => pollFor(() => lastPollAt >= startedAt, ms),
		async close() {
			monitor.close();
			await Promise.all([...views.values()].map(v => v.then(x => x.close(), () => {})));
			await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections?.(); });
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
	const snapshot = async () => {
		const content = await readFile(path, "utf8");
		return { ...prepareFilePreview(path, content), contentHash: createHash("sha256").update(content).digest("hex") };
	};
	const { style, finish } = themeFor(options, fontSizePx);
	const first = await snapshot();
	const initial = { html: finish((await renderPreviewHtmlDocument(first.markdown, style, resourcePath, first.isLatex, fontSizePx)).html) };
	const label = basename(path);
	const { started: server, reused } = await startAtSlot(slotStore(options.stateDir), `file|${path}`, (port, token) => createBrowserWatchServer(initial.html, resourcePath, {
		initialDocumentIsHistory: true, sourceLabel: label, preserveReadingPosition: true, port, token, ...PAGE_TEXT,
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
					const html = finish((await renderPreviewHtmlDocument(next.markdown, style, resourcePath, next.isLatex, fontSizePx)).html);
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
