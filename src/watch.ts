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
import { createOpenCodeStore, openCodeSessionId, openCodeSessionPath } from "./opencode.js";
import {
	buildBrowserHtmlFromPandocFragment, DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX,
	normalizePreviewFontSizePx, prepareFilePreview, renderPreviewHtmlDocument, type PreviewStyle,
} from "./render.js";
import { styleForMode, themeFinisher } from "./theme.js";
import type { PageTheme } from "./appearance.js";
import { AGENT_LABELS, AGENTS, defaultSessionRoots, detectAgent, type AgentKind, type AgentResponse, type SessionRoots } from "./sessions.js";
import { createBrowserWatchServer } from "./shared/browser-watch-server.js";
import { isHtmlPagePath } from "./shared/html-page-preview.js";
import { readLinkedDocument } from "./shared/read-linked-document.js";
import { readTurnDetails } from "./shared/read-turn-details.js";
import { AGENT_PAGE_STYLE, applyPreviewAppearance } from "./shared/agent-page-style.js";
import { createSlotStore, defaultStateDir, startAtSlot, type SlotStore } from "./slots.js";

const PAGE_TEXT = { titleSuffix: "Agent Markdown Preview", expiredHint: "Run agent-markdown-preview again for a fresh link." };
/** Remembered addresses make restarted previews reconnect; `null` disables. */
const slotStore = (stateDir: string | null | undefined, turnDetails = false): SlotStore | null => {
	if (stateDir === null) return null;
	const store = createSlotStore(stateDir ?? defaultStateDir());
	if (!turnDetails) return store;
	// Previously shared ordinary-preview links must not gain trace access.
	const scope = "turn-details|";
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

interface ViewOptions {
	cwd: string;
	turnDetails?: boolean;
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
		// The render pipeline does not pass raw HTML through, so the caption is Markdown.
		return caption ? `*${caption.replace(/[\\`*_[\]<>#|~$]/g, "\\$&")}*\n\n${response.markdown}` : response.markdown;
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
		renderLocalDocument: (path, signal, revision) => {
			const { style, finish } = revisionThemes.get(revision ?? 1) ?? options;
			return localDocumentRenderer(style, options.fontSizePx, finish)(path, signal);
		},
	}));
	if (seeded[0]) rememberTheme(1, seeded[0].response);
	for (const { html, response } of seeded.slice(1)) rememberTheme(server.updateDocument(html, { appendToHistory: true, turnDetails: detailsFor(response) }), response);
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
					const revision = server.updateDocument(html, { appendToHistory, turnDetails: detailsFor(response) });
					rememberTheme(revision, response);
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
	/** Opt-in: expose recorded prompts/tool activity for retained responses. */
	turnDetails?: boolean;
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
		slots: slotStore(options.stateDir, options.turnDetails), slotKey, turnDetails: options.turnDetails, ...themeFor(options, base.fontSizePx),
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
	const started = await mergedView(base.monitor, base, options, label, pinned ? `session|${pinned.path}` : `${base.cwd}|merged`);
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
	const slots = slotStore(options.stateDir, options.turnDetails);
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
			? createResponseView({ cwd: resourceCwd, turnDetails: options.turnDetails, ...themeFor(options, base.fontSizePx), fontSizePx: base.fontSizePx, label: sessionLabel(session), history: session.history.slice(-fillCount(options)),
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
