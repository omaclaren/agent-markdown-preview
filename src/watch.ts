// Browser views: a session index for a directory, one watch page per session,
// a merged view of all sessions, and single-file watching. Rendering and the
// watch page are pi-markdown-preview's; this module decides what to show when.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, resolve } from "node:path";
import { createSessionMonitor, type SessionMonitor, type SessionState } from "./monitor.js";
import {
	buildBrowserHtmlFromPandocFragment, DARK_PREVIEW_PALETTE, DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX, LIGHT_PREVIEW_PALETTE,
	normalizePreviewFontSizePx, prepareFilePreview, renderPreviewHtmlDocument, type PreviewStyle, type ThemeMode,
} from "./render.js";
import { AGENT_LABELS, AGENTS, detectAgent, type AgentKind, type AgentResponse, type SessionRoots } from "./sessions.js";
import { createBrowserWatchServer } from "./shared/browser-watch-server.js";

/** Same result as pi-markdown-preview's getPreviewStyle() without a Pi theme. */
export function styleForMode(mode: ThemeMode): PreviewStyle {
	const palette = mode === "dark" ? DARK_PREVIEW_PALETTE : LIGHT_PREVIEW_PALETTE;
	return { themeMode: mode, palette, cacheKey: [mode, ...Object.values(palette)].join("|") };
}

export interface RunningWatch {
	url: string;
	label: string;
	close(): Promise<void>;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const sessionLabel = (s: SessionState) => `${AGENT_LABELS[s.agent]} ${s.shortId}${s.title ? ` · ${s.title}` : ""}`;
const timeOfDay = (time: number) => new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

interface ResponseView {
	url: string;
	readonly shownKey: string | null;
	show(response: AgentResponse): void;
	close(): Promise<void>;
}

interface ViewOptions {
	cwd: string;
	style: PreviewStyle;
	fontSizePx: number;
	label: string;
	initial: AgentResponse | null;
	waitingText: string;
	/** Prefix each response with its source (merged views). */
	caption?: (response: AgentResponse) => string | null;
	log: (message: string) => void;
	onRendered?: (response: AgentResponse, revision: number) => void;
}

/** One watch page following a stream of responses. Same key = revise in place. */
async function createResponseView(options: ViewOptions): Promise<ResponseView> {
	const markdownFor = (response: AgentResponse) => {
		const caption = options.caption?.(response);
		// The render pipeline does not pass raw HTML through, so the caption is Markdown.
		return caption ? `*${caption.replace(/[\\`*_[\]<>#|~$]/g, "\\$&")}*\n\n${response.markdown}` : response.markdown;
	};
	const render = async (response: AgentResponse) => (await renderPreviewHtmlDocument(markdownFor(response), options.style, options.cwd, false, options.fontSizePx)).html;
	const initialHtml = options.initial ? await render(options.initial)
		: buildBrowserHtmlFromPandocFragment(`<p>${escapeHtml(options.waitingText)}</p>`, options.style, options.cwd, [], options.fontSizePx);
	const server = await createBrowserWatchServer(initialHtml, options.cwd, { initialDocumentIsHistory: Boolean(options.initial), sourceLabel: options.label });
	let shownKey = options.initial?.key ?? null, shownMarkdown = options.initial?.markdown ?? "", closed = false;
	let queue = Promise.resolve();
	return {
		url: server.url,
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
}

async function openMonitor(options: CommonOptions & { sessionPath?: string; sessionAgent?: AgentKind }) {
	const cwd = await realpath(resolve(options.cwd));
	let sessionPaths: { agent: AgentKind; path: string }[] | undefined;
	if (options.sessionPath) {
		const path = await realpath(resolve(options.sessionPath));
		const agent = options.sessionAgent ?? await detectAgent(path);
		if (!agent) throw new Error(`Could not tell which agent wrote ${path}; pass --agent claude|codex|pi.`);
		sessionPaths = [{ agent, path }];
	}
	const monitor = createSessionMonitor({ cwd, agents: options.agents, sessionPaths, roots: options.roots, rescanMs: options.rescanMs,
		tailIntervalMs: options.tailIntervalMs, recentMs: options.recentMs, log: options.log });
	await monitor.ready;
	return { cwd, monitor, fontSizePx: normalizePreviewFontSizePx(options.fontSizePx, DEFAULT_BROWSER_PREVIEW_FONT_SIZE_PX), agents: sessionPaths ? sessionPaths.map(s => s.agent) : [...(options.agents ?? AGENTS)] };
}

const latestOf = (sessions: SessionState[]) => sessions.map(s => s.latest).filter((r): r is AgentResponse => r !== null).reduce<AgentResponse | null>((best, r) => !best || r.time >= best.time ? r : best, null);

/** Creates the merged view over all monitored sessions (or one pinned session). */
async function mergedView(monitor: SessionMonitor, base: { cwd: string; fontSizePx: number; agents: AgentKind[] }, options: CommonOptions, label: string, captions = true) {
	return createResponseView({
		cwd: base.cwd, style: options.style, fontSizePx: base.fontSizePx, label, initial: latestOf(monitor.sessions()),
		waitingText: `Waiting for the next completed response from ${base.agents.map(a => AGENT_LABELS[a]).join(", ")} in ${base.cwd}…`,
		caption: captions ? response => {
			const session = monitor.sessions().find(s => s.path === response.sessionPath);
			return `${AGENT_LABELS[response.agent]}${session ? ` ${session.shortId}` : ""} · ${timeOfDay(response.time)}`;
		} : undefined,
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
	const view = await mergedView(base.monitor, base, options, label, !pinned);
	base.monitor.onResponse((_session, response, fresh) => { if (fresh || response.key === view.shownKey) view.show(response); });
	return { url: view.url, label, async close() { base.monitor.close(); await view.close(); } };
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
	const token = randomBytes(24).toString("base64url");
	const views = new Map<string, Promise<ResponseView>>();
	const label = `${basename(cwd) || cwd}`;

	function view(id: string): Promise<ResponseView> | null {
		const existing = views.get(id);
		if (existing) return existing;
		const session = id === "all" ? null : monitor.get(id);
		if (id !== "all" && !session) return null;
		const created = session
			? createResponseView({ cwd, style: options.style, fontSizePx: base.fontSizePx, label: sessionLabel(session), initial: session.latest,
				waitingText: `No completed response in this ${AGENT_LABELS[session.agent]} session yet.`, log, onRendered: options.onRendered })
			: mergedView(monitor, base, options, `All sessions · ${label}`);
		views.set(id, created);
		created.catch(() => views.delete(id));
		return created;
	}
	monitor.onResponse((session, response, fresh) => {
		for (const id of [session.id, "all"]) {
			void views.get(id)?.then(v => { if (fresh || response.key === v.shownKey) v.show(response); }, () => {});
		}
	});

	const tokenMatches = (value: string | null) => typeof value === "string" && value.length === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token));
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
				const sessions = monitor.sessions().map(s => ({
					id: s.id, agent: s.agent, agentLabel: AGENT_LABELS[s.agent], shortId: s.shortId, title: s.title, working: s.working,
					lastActivity: s.lastActivity, responseCount: s.responseCount, file: basename(s.path),
				}));
				return send(200, JSON.stringify({ cwd, label, now: Date.now(), sessions }), "application/json");
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
	await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
	port = (server.address() as { port: number }).port;
	return {
		url: `http://127.0.0.1:${port}/?token=${token}`,
		label: `sessions in ${label}`,
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
	const first = await snapshot();
	const initial = await renderPreviewHtmlDocument(first.markdown, options.style, resourcePath, first.isLatex, fontSizePx);
	const label = basename(path);
	const server = await createBrowserWatchServer(initial.html, resourcePath, { initialDocumentIsHistory: true, sourceLabel: label, preserveReadingPosition: true });

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
					const rendered = await renderPreviewHtmlDocument(next.markdown, options.style, resourcePath, next.isLatex, fontSizePx);
					if (closed) return;
					const revision = server.updateDocument(rendered.html, { appendToHistory: true });
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
		async close() {
			if (closed) return;
			closed = true;
			if (debounce) clearTimeout(debounce);
			unwatchFile(path, listener);
			await server.close();
		},
	};
}
