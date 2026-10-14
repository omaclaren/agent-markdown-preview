// Read-only OpenCode adapters. v1 uses session/message/part; v2 uses
// session_v2/session_message projections. Never boot OpenCode or run migrations.
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentResponse, SessionFile } from "./sessions.js";
import { createTurnDetails, TURN_EVENT_LIMIT, TURN_TOTAL_LIMIT } from "./shared/turn-details.js";
import { TURN_READ_BYTES, TURN_RECORD_BYTES } from "./shared/read-turn-details.js";

type Row = Record<string, any>;
interface Database {
	prepare(sql: string): { all(...params: (string | number)[]): Row[]; get(...params: (string | number)[]): Row | undefined };
	exec(sql: string): unknown;
	close(): void;
}
const record = (value: unknown): Row | null => value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const finiteTime = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
/** v2 records a shell's output as { output, cursor, size, truncated }; v1 as text. */
const shellOutput = (t: { note(message: string): void }, value: unknown) => {
	const output = record(value);
	if (!output) return value;
	if (output.truncated) t.note("OpenCode recorded only part of a shell command's output.");
	return output.output;
};
/** A call card added at `from` whose result is not recorded yet. */
const pending = (events: Row[], from: number) => { if (events[from]?.kind === "tool") events[from].pending = true; };
const terminal = new Set(["stop", "length", "content-filter"]);
export const isOpenCodeSessionId = (value: string) => /^ses_[a-zA-Z0-9]+$/.test(value);
/** Stable across v1 -> v2 migration; not a filesystem path or a browser URL. */
export const openCodeSessionPath = (database: string, id: string) => `${resolve(database)}#${id}`;
export function openCodeSessionId(path: string): string | null {
	const id = path.slice(path.lastIndexOf("#") + 1);
	return isOpenCodeSessionId(id) ? id : null;
}

/** Parse a completed assistant message, excluding tools, reasoning and summaries.
 * v2 turn settlement is additionally checked by the database reader below. */
export function readOpenCodeResponse(entry: unknown, sessionPath: string): AgentResponse | null {
	const e = record(entry);
	const info = record(e?.info) ?? e;
	if (!info || (info.type ?? info.role) !== "assistant" || typeof info.id !== "string") return null;
	if (info.error || info.summary || !terminal.has(info.finish)) return null;
	const time = finiteTime(info.time?.completed);
	if (time === null) return null;
	const content = info.content ?? e?.parts;
	if (!Array.isArray(content)) return null;
	const markdown = content.filter(part => part?.type === "text" && !part.synthetic && !part.ignored && typeof part.text === "string")
		.map(part => part.text).join("\n\n");
	return markdown.trim() ? { agent: "opencode", key: `opencode:${info.id}`, markdown, time, sessionPath } : null;
}

export interface OpenCodeSnapshot {
	title: string | null;
	working: boolean;
	lastActivity: number;
	history: AgentResponse[];
	/** Source order (v1 ID / v2 seq), independent of clock skew. */
	order: ReadonlyMap<string, string | number>;
}
export interface OpenCodeStore {
	/** Omit cwd to discover across projects (metadata only). */
	list(cwd?: string): Promise<SessionFile[]>;
	snapshot(path: string): Promise<OpenCodeSnapshot | null>;
	turnDetails(response: AgentResponse, signal: AbortSignal): Promise<ReturnType<typeof createTurnDetails>["result"]>;
	/** The recorded activity of one v2 turn for Live, or null when the session has none. */
	live(sessionPath: string, anchor: string | undefined, since: string | undefined, signal: AbortSignal): Promise<OpenCodeLiveRead | null>;
	close(): void;
}

export type OpenCodeLiveEvent = ReturnType<typeof createTurnDetails>["result"]["events"][number] & { id: string; pending?: boolean };
export interface OpenCodeLiveTurn {
	/** The turn's first authored prompt row. */
	anchor: string;
	status: "running" | "completed" | "incomplete" | "interrupted" | "error";
	/** Response key of the turn's answer, as the history reader keys it. */
	finalKey?: string;
	/** The turn recorded an answer larger than Preview keeps. */
	answerUnavailable?: boolean;
	/** A later authored turn exists. */
	newerAnchor?: string;
	/** The latest cards; `omitted` earlier ones in the rows read are not shown. */
	events: OpenCodeLiveEvent[];
	omitted: number;
	notices: string[];
}
export interface OpenCodeLiveRead {
	/** Changes whenever this session's recorded rows or lifecycle change, or the database is replaced. */
	revision: string;
	/** The database file and opening the revision belongs to. */
	database: string;
	/** Anchor of the latest authored turn, if any. */
	current?: string;
	/** The requested (or current) turn; absent when unchanged since `since` or no longer recorded. */
	turn?: OpenCodeLiveTurn;
	unchanged?: true;
}

/** Rows read per Live turn; a longer turn shows its latest activity. */
const LIVE_ROWS = 250;

async function openReadOnly(path: string): Promise<Database> {
	let db: Database;
	if (process.versions.bun) {
		// Variable import keeps the optional Bun module out of Node's resolution.
		const module = "bun:sqlite";
		const { Database } = await import(module);
		db = new Database(path, { readonly: true, create: false });
	} else {
		let sqlite: typeof import("node:sqlite");
		const module = "node:sqlite";
		try { sqlite = await import(module); }
		catch { throw new Error("OpenCode history needs Node 22.13+ (node:sqlite) or Bun (bun:sqlite)."); }
		db = new sqlite.DatabaseSync(path, { readOnly: true }) as Database;
	}
	try { db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 50;"); }
	catch (error) { db.close(); throw error; }
	return db;
}

/** Only a bounded text projection crosses into JS, never tool outputs or blobs. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const HISTORY = 20;
const CANDIDATES = 256;
const safeData = "CASE WHEN json_valid(data) THEN data ELSE '{}' END";
const field = (name: string) => `json_extract(${safeData}, '$.${name}')`;
const completed = `${field("time.completed")} IS NOT NULL AND ${field("finish")} IN ('stop','length','content-filter') AND ${field("error")} IS NULL AND COALESCE(${field("summary")},0) = 0`;

export function createOpenCodeStore(databasePath: string): OpenCodeStore {
	const path = resolve(databasePath);
	let database: Database | null = null, inode = "", closed = false, opens = 0;
	let opening: Promise<Database | null> | null = null;
	let tables = new Set<string>();
	const columns = new Map<string, Set<string>>();
	const cache = new Map<string, { version: number; value: OpenCodeSnapshot | null }>();
	const hasV2 = () => tables.has("session_v2") && tables.has("session_message");
	const hasV1 = () => ["session", "message", "part"].every(table => tables.has(table));
	const reset = () => { database?.close(); database = null; inode = ""; tables.clear(); columns.clear(); cache.clear(); };
	const connect = (): Promise<Database | null> => {
		if (closed) return Promise.resolve(null);
		if (opening) return opening;
		opening = (async () => {
			let info;
			try { info = await stat(path); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { reset(); return null; } throw error; }
			if (closed) return null;
			if (!info.isFile()) throw new Error("OpenCode database is not a regular file.");
			const key = `${info.dev}:${info.ino}`;
			if (database && inode !== key) reset();
			if (!database) {
				const opened = await openReadOnly(path);
				if (closed) { opened.close(); return null; }
				database = opened;
				inode = key;
				opens++;
			}
			// Discover newly migrated schemas too, not just the tables at startup.
			tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
			for (const table of ["session", "session_v2"]) if (tables.has(table)) {
				columns.set(table, new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)));
			}
			if (!hasV1() && !hasV2()) throw new Error("Unrecognised OpenCode SQLite schema; expected v1 or v2 session tables.");
			return database;
		})().finally(() => { opening = null; });
		return opening;
	};
	const optional = (table: string, name: string) => columns.get(table)?.has(name) ? name : `NULL AS ${name}`;
	const sessionColumns = (table: string) => ["id", "title", "directory", "parent_id", "time_created", "time_updated",
		...(["time_archived", "time_suspended", "fork_session_id"] as const).map(name => optional(table, name))].join(",");

	/** An answer row's text parts as Preview keeps them; none, and `oversized`, beyond MAX_TEXT_BYTES. */
	function answerTexts(db: Database, id: string, rowId: string): { texts: Row[]; oversized: boolean } {
		const parts = `WITH parts AS (
			SELECT CASE WHEN p.type='object' THEN p.value ELSE '{}' END AS body, CAST(p.key AS INTEGER) AS position
			FROM session_message m, json_each(m.data,'$.content') p WHERE m.session_id=? AND m.id=?
		), texts AS (
			SELECT json_extract(body,'$.text') AS text,position FROM parts WHERE json_extract(body,'$.type')='text'
			AND json_type(body,'$.text')='text' AND COALESCE(json_extract(body,'$.ignored'),0)=0 AND COALESCE(json_extract(body,'$.synthetic'),0)=0
		)`;
		const bytes = db.prepare(`${parts} SELECT COALESCE(SUM(length(CAST(text AS BLOB))+2),0) AS bytes FROM texts`).get(id, rowId)?.bytes ?? 0;
		if (bytes > MAX_TEXT_BYTES) return { texts: [], oversized: true };
		return { texts: db.prepare(`${parts} SELECT text FROM texts ORDER BY position`).all(id, rowId), oversized: false };
	}

	function readSnapshot(db: Database, id: string): OpenCodeSnapshot | null {
		const v2 = hasV2() ? db.prepare(`SELECT ${sessionColumns("session_v2")} FROM session_v2 WHERE id=?`).get(id) : undefined;
		const session = v2 ?? (hasV1() ? db.prepare(`SELECT ${sessionColumns("session")} FROM session WHERE id=?`).get(id) : undefined);
		if (!session) return null; // Explicit selectors may open archived/child sessions.
		const source = openCodeSessionPath(path, id);
		const history: AgentResponse[] = [];
		const order = new Map<string, string | number>();
		const isImported = (row: Row) => hasV1() && Boolean(db.prepare(`SELECT id FROM message WHERE session_id=? AND id=? AND ${completed}`).get(id, row.id));
		const isForkedHistory = (row: Row) => Boolean(v2?.fork_session_id) && row.time_created < v2!.time_created;
		if (v2) {
			// Projection order is seq, NOT ID or wall-clock time. Idle markers close
			// turns (including steered prompts). Imported v1 answers have no marker.
			const rows = db.prepare(`SELECT id,seq,time_created,${field("time.completed")} AS completed,${field("finish")} AS finish
				FROM session_message WHERE session_id=? AND type='assistant' AND ${completed} ORDER BY seq DESC LIMIT ?`).all(id, CANDIDATES);
			const usedTurns = new Set<number>();
			for (const row of rows) {
				const imported = isImported(row);
				const forkedHistory = isForkedHistory(row);
				const idle = db.prepare("SELECT seq,time_created FROM session_message WHERE session_id=? AND type='idle' AND seq>? ORDER BY seq LIMIT 1").get(id, row.seq);
				if (!imported && !forkedHistory) {
					if (!idle || usedTurns.has(idle.seq)) continue;
					usedTurns.add(idle.seq);
				}
				const { texts } = answerTexts(db, id, row.id);
				addResponse(row, texts, !imported && !forkedHistory ? idle?.time_created : undefined);
				if (history.length === HISTORY) break;
			}
		} else {
			const rows = db.prepare(`SELECT id,time_created,${field("time.completed")} AS completed,${field("finish")} AS finish
				FROM message WHERE session_id=? AND ${field("role")}='assistant' AND ${completed} ORDER BY id DESC LIMIT ?`).all(id, CANDIDATES);
			for (const row of rows) {
				const texts = db.prepare(`WITH texts AS (
					SELECT id,${field("text")} AS text FROM part WHERE session_id=? AND message_id=? AND ${field("type")}='text'
					AND json_type(${safeData},'$.text')='text' AND COALESCE(${field("ignored")},0)=0 AND COALESCE(${field("synthetic")},0)=0
				) SELECT text FROM texts WHERE (SELECT SUM(length(CAST(text AS BLOB))+2) FROM texts)<=? ORDER BY id`).all(id, row.id, MAX_TEXT_BYTES);
				addResponse(row, texts);
				if (history.length === HISTORY) break;
			}
		}
		function addResponse(row: Row, texts: Row[], settledAt?: number) {
			if (texts.reduce((size, part) => size + (typeof part.text === "string" ? Buffer.byteLength(part.text) : 0), 0) > MAX_TEXT_BYTES) return;
			const response = readOpenCodeResponse({ type: "assistant", id: row.id, finish: row.finish,
				time: { completed: row.completed }, content: texts.map(part => ({ type: "text", text: part.text })) }, source);
			if (response) {
				if (settledAt !== undefined) response.time = Math.max(response.time, settledAt);
				history.push(response);
				order.set(response.key, v2 ? row.seq : row.id);
			}
		}
		history.reverse();
		const latest = v2
			? db.prepare(`SELECT id,type,time_created,${field("time.completed")} AS completed FROM session_message WHERE session_id=? AND type IN ('user','assistant','idle') ORDER BY seq DESC LIMIT 1`).get(id)
			: db.prepare(`SELECT ${field("role")} AS type,${field("time.completed")} AS completed,${field("finish")} AS finish FROM message WHERE session_id=? ORDER BY id DESC LIMIT 1`).get(id);
		const prompt = session.title ? undefined : v2
			? db.prepare(`SELECT substr(${field("text")},1,100) AS text FROM session_message WHERE session_id=? AND type='user' ORDER BY seq LIMIT 1`).get(id)
			: db.prepare(`SELECT substr(${field("text")},1,100) AS text FROM part WHERE session_id=? AND message_id=(SELECT id FROM message WHERE session_id=? AND ${field("role")}='user' ORDER BY id LIMIT 1) AND ${field("type")}='text' ORDER BY id LIMIT 1`).get(id, id);
		const title = typeof (session.title ?? prompt?.text) === "string" ? String(session.title ?? prompt?.text).replace(/\s+/g, " ").trim().slice(0, 100) : null;
		return {
			title: title || null,
			working: Boolean(session.time_suspended) || latest?.type === "user" || (latest?.type === "assistant" && (v2
				? !isImported(latest) && !isForkedHistory(latest)
				: latest.completed == null || latest.finish === "tool-calls")),
			lastActivity: Math.max(session.time_updated, history.at(-1)?.time ?? 0), history, order,
		};
	}

	return {
		async list(cwd) {
			const db = await connect();
			if (!db) return [];
			const byId = new Map<string, Row>();
			// v2 is authoritative even if a migrated row is archived, moved or a child.
			for (const table of [hasV2() && "session_v2", hasV1() && "session"].filter((v): v is string => Boolean(v))) {
				const exclude = table === "session" && hasV2() ? "AND NOT EXISTS (SELECT 1 FROM session_v2 WHERE session_v2.id=session.id)" : "";
				const archived = columns.get(table)?.has("time_archived") ? "AND time_archived IS NULL" : "";
				const directory = cwd === undefined ? "" : "AND directory=?";
				const rows = db.prepare(`SELECT id,directory,time_updated FROM ${table} WHERE parent_id IS NULL ${directory} ${archived} ${exclude} ORDER BY time_updated DESC LIMIT ${cwd === undefined ? 512 : 256}`).all(...(cwd === undefined ? [] : [cwd]));
				for (const row of rows) byId.set(row.id, row);
			}
			return [...byId.values()].filter(row => isOpenCodeSessionId(row.id)).map(row => ({ agent: "opencode" as const, path: openCodeSessionPath(path, row.id), mtimeMs: row.time_updated, cwd: row.directory }))
				.sort((a, b) => b.mtimeMs - a.mtimeMs);
		},
		async snapshot(source) {
			const id = openCodeSessionId(source);
			if (!id || source !== openCodeSessionPath(path, id)) throw new Error("Invalid OpenCode session selector.");
			const db = await connect();
			if (!db) return null;
			db.exec("BEGIN");
			try {
				const version = Number(db.prepare("PRAGMA data_version").get()?.data_version);
				const cached = cache.get(id);
				if (cached?.version === version) return cached.value;
				const value = readSnapshot(db, id);
				cache.delete(id); cache.set(id, { version, value });
				// Fit the default all-projects roster without idle-session cache thrash.
				while (cache.size > 64) cache.delete(cache.keys().next().value!);
				return value;
			} finally { db.exec("ROLLBACK"); }
		},
		async turnDetails(response, signal) {
			const id = openCodeSessionId(response.sessionPath);
			if (!id || response.sessionPath !== openCodeSessionPath(path, id)) throw new Error("Invalid OpenCode session selector.");
			signal.throwIfAborted();
			const t = createTurnDetails();
			const db = await connect();
			if (!db) { t.note("The session database is no longer available."); return t.result; }
			db.exec("BEGIN");
			try {
				const snapshot = readSnapshot(db, id);
				if (!snapshot?.history.some(r => r.key === response.key && r.markdown === response.markdown)) {
					t.note("This response cannot be matched to the recent completed OpenCode history."); return t.result;
				}
				const v2 = hasV2() && Boolean(db.prepare("SELECT id FROM session_v2 WHERE id=?").get(id));
				const messageId = response.key.slice("opencode:".length);
				const target = v2 ? db.prepare("SELECT seq FROM session_message WHERE session_id=? AND id=?").get(id, messageId) : undefined;
				// Select metadata first, then read selected records one at a time. Larger
				// inline images must not turn a 251-row query into a large blob allocation.
				const projection = `CASE WHEN length(CAST(data AS BLOB))<=? THEN data ELSE NULL END AS data`;
				const messageData = db.prepare(`SELECT ${projection} FROM ${v2 ? "session_message" : "message"} WHERE session_id=? AND id=?`);
				const partData = v2 ? undefined : db.prepare(`SELECT ${projection} FROM part WHERE session_id=? AND id=?`);
				const metadata = `${field("finish")} AS finish,${field("time.completed")} AS completed,(${field("error")} IS NOT NULL) AS errored,COALESCE(${field("summary")},0) AS summary`;
				const rows = v2
					? db.prepare(`SELECT id,type,${metadata} FROM session_message WHERE session_id=? AND seq<=? AND type IN ('user','assistant','idle','compaction','shell') ORDER BY seq DESC LIMIT 251`).all(id, target!.seq)
					: db.prepare(`SELECT id,${field("role")} AS type,${metadata} FROM message WHERE session_id=? AND id<=? ORDER BY id DESC LIMIT 251`).all(id, messageId);
				const selected: Row[] = [];
				for (const row of rows) {
					if (row.type === "compaction" || row.summary) { t.note("A compaction boundary occurs here; earlier activity is not reconstructed."); break; }
					if (row.id !== messageId && row.type === "assistant" && (row.errored || ["error", "aborted", "cancelled"].includes(row.finish))) {
						t.note("Earlier activity before a recorded interruption/failure is omitted."); break;
					}
					if (row.id !== messageId && (row.type === "idle" || (!v2 && row.type === "assistant" && row.completed != null && terminal.has(row.finish)) || snapshot.history.some(r => r.key === `opencode:${row.id}`))) break;
					selected.push(row);
				}
				if (selected.length === 251) t.note("The turn exceeds the bounded history window; earlier activity is omitted.");
				let partBudget = 250, bytes = 0;
				for (const row of selected.reverse()) {
					signal.throwIfAborted();
					if (!["user", "assistant", "shell"].includes(row.type)) continue;
					if (bytes >= TURN_READ_BYTES) { t.note("The read-size limit was reached; remaining activity is omitted."); break; }
					const recorded = messageData.get(Math.min(TURN_RECORD_BYTES, TURN_READ_BYTES - bytes), id, row.id)?.data;
					if (typeof recorded !== "string") { t.note("A recorded message exceeded the record or remaining read-size limit and was omitted."); continue; }
					bytes += Buffer.byteLength(recorded);
					let data: Row | null = null;
					try { data = record(JSON.parse(recorded)); } catch { /* Reported below. */ }
					if (!data) { t.note("An invalid recorded message was omitted."); continue; }
					if (row.type === "shell") {
						t.add("tool", "User shell command", data.command);
						t.add("result", "Shell output", shellOutput(t, data.output));
						continue;
					}
					if (Array.isArray(data.files) && data.files.length) t.note("Prompt file attachments are omitted.");
					let parts = data.content;
					if (!v2) {
						const raw = db.prepare(`SELECT id FROM part WHERE session_id=? AND message_id=? ORDER BY id LIMIT ?`).all(id, row.id, Math.max(0, partBudget));
						partBudget -= raw.length;
						parts = [];
						for (const p of raw) {
							signal.throwIfAborted();
							if (bytes >= TURN_READ_BYTES) { t.note("The read-size limit was reached; remaining activity is omitted."); break; }
							const recordedPart = partData!.get(Math.min(TURN_RECORD_BYTES, TURN_READ_BYTES - bytes), id, p.id)?.data;
							if (typeof recordedPart !== "string") { t.note("A recorded part exceeded the record or remaining read-size limit and was omitted."); continue; }
							bytes += Buffer.byteLength(recordedPart);
							try { parts.push(JSON.parse(recordedPart)); } catch { t.note("An invalid recorded part was omitted."); }
						}
						if (partBudget <= 0) t.note("The part limit was reached; remaining activity may be omitted.");
					}
					if (row.type === "user" && typeof data.text === "string" && !parts?.length) t.content(data.text, "user");
					for (const p of Array.isArray(parts) ? parts : []) {
						if (!p || p.ignored || p.synthetic) continue;
						if (p.type === "tool") {
							t.add("tool", `Tool: ${String(p.tool ?? p.name ?? "")}`, JSON.stringify(p.state?.input ?? p.input ?? {}, null, 2), p.callID ?? p.callId ?? p.id);
							const error = typeof p.state?.error === "string" ? p.state.error : p.state?.error?.message;
							const content = Array.isArray(p.state?.content) ? p.state.content : undefined;
							const output = p.state?.output ?? content ?? error;
							const attachments = [...(output === content ? [] : content ?? []), ...(Array.isArray(p.state?.attachments) ? p.state.attachments : [])];
							t.toolResult(`Tool result${p.state?.status === "error" ? " (error)" : ""}`, output, p.callID ?? p.callId ?? p.id, attachments);
						} else t.content([p], row.type, row.id === messageId);
					}
				}
				if (!t.result.events.some(e => e.kind === "prompt")) t.note("The input prompt is not available in this recorded portion of the turn.");
				return t.result;
			} finally { db.exec("ROLLBACK"); }
		},
		async live(sessionPath, anchor, since, signal) {
			const id = openCodeSessionId(sessionPath);
			const db = id ? await connect() : null;
			if (!id || !db || !hasV2()) return null;
			// Which file, and which opening of it: a replaced database can repeat every value inside it.
			const database = `${inode}:${opens}`;
			// One snapshot: the revision and the rows it describes must agree.
			db.exec("BEGIN");
			try {
				const session = db.prepare(`SELECT id,${optional("session_v2", "revert")},${optional("session_v2", "time_suspended")} FROM session_v2 WHERE id=?`).get(id);
				if (!session) return null;
				// OpenCode updates assistant rows in place under the same seq, so neither the
				// highest seq nor the row count reveals every change. Its per-session event
				// counter does, and moves in the same transaction as the rows. Without it,
				// SQLite's data_version moves on every commit by another connection (database-
				// wide, so it re-reads more often than needed, but never misses a change).
				const counter = tables.has("event_sequence") ? db.prepare("SELECT seq FROM event_sequence WHERE aggregate_id=?").get(id)?.seq : undefined;
				const top = db.prepare("SELECT MAX(seq) AS seq FROM session_message WHERE session_id=?").get(id)?.seq ?? null;
				const commits = counter === undefined ? db.prepare("PRAGMA data_version").get()?.data_version ?? null : null;
				const revision = JSON.stringify([database, counter ?? null, commits, session.revert ?? null, session.time_suspended ?? null, top]);
				if (since === revision) return { revision, database, unchanged: true };
				// A staged revert leaves its rows in place until it is committed. Activity from
				// its message on is not the current turn; if the boundary can't be found, Live
				// does not pick a current turn at all.
				let boundary: number | undefined, unclear = false;
				if (session.revert != null) {
					let staged: Row | null = null;
					try { staged = record(typeof session.revert === "string" ? JSON.parse(session.revert) : session.revert); } catch { /* Unclear. */ }
					const at = typeof staged?.messageID === "string" ? db.prepare("SELECT seq FROM session_message WHERE session_id=? AND id=?").get(id, staged.messageID)?.seq : undefined;
					if (typeof at === "number") boundary = at; else unclear = true;
				}
				// A turn runs from the first authored prompt after an idle marker to the next
				// idle marker; prompts sent while it runs belong to it. Answers imported from
				// v1 have no idle marker but close their exchange all the same. Maintenance
				// (compaction, a resume, a user shell command) can end in an idle marker with
				// no prompt and is not a turn. Queued input stays out of session_message until
				// it is promoted.
				const imported = hasV1() ? db.prepare(`SELECT id FROM message WHERE session_id=? AND id=? AND ${completed}`) : undefined;
				const turnStart = (seq: number) => {
					const idle = db.prepare("SELECT MAX(seq) AS seq FROM session_message WHERE session_id=? AND type='idle' AND seq<?").get(id, seq)?.seq;
					let floor = typeof idle === "number" ? idle : Number.MIN_SAFE_INTEGER;
					if (imported) for (const row of db.prepare(`SELECT id,seq FROM session_message WHERE session_id=? AND type='assistant' AND seq<? AND seq>? AND ${completed} ORDER BY seq DESC LIMIT ?`).all(id, seq, floor, CANDIDATES)) {
						if (imported.get(id, row.id)) { floor = row.seq; break; }
					}
					return db.prepare("SELECT id,seq FROM session_message WHERE session_id=? AND type='user' AND seq>? ORDER BY seq LIMIT 1").get(id, floor);
				};
				const latest = unclear ? undefined : db.prepare("SELECT id,seq FROM session_message WHERE session_id=? AND type='user' AND seq<? ORDER BY seq DESC LIMIT 1").get(id, boundary ?? Number.MAX_SAFE_INTEGER);
				const current = latest ? turnStart(latest.seq) : undefined;
				const target = anchor === undefined ? current : db.prepare("SELECT id,seq FROM session_message WHERE session_id=? AND id=? AND type='user'").get(id, anchor);
				// A reverted turn's rows are deleted; its anchor no longer identifies a turn.
				if (!target || (anchor !== undefined && turnStart(target.seq)?.id !== target.id)) return { revision, database, current: current?.id };
				// The turn ends at its idle marker, or at an imported answer, which has none.
				const idle = db.prepare(`SELECT seq,${field("outcome")} AS outcome FROM session_message WHERE session_id=? AND type='idle' AND seq>? ORDER BY seq LIMIT 1`).get(id, target.seq);
				let end: { seq: number; outcome: unknown; answer?: string } | undefined = idle ? { seq: idle.seq, outcome: idle.outcome } : undefined;
				if (imported) for (const row of db.prepare(`SELECT id,seq FROM session_message WHERE session_id=? AND type='assistant' AND seq>? AND seq<? AND ${completed} ORDER BY seq LIMIT ?`).all(id, target.seq, idle?.seq ?? Number.MAX_SAFE_INTEGER, CANDIDATES)) {
					if (imported.get(id, row.id)) { end = { seq: row.seq, outcome: "succeeded", answer: row.id }; break; }
				}
				const rows = db.prepare("SELECT id,type,seq,length(CAST(data AS BLOB)) AS bytes FROM session_message WHERE session_id=? AND seq>=? AND seq<=? ORDER BY seq DESC LIMIT ?")
					.all(id, target.seq, end?.seq ?? Number.MAX_SAFE_INTEGER, LIVE_ROWS + 1).reverse();
				// Collect every card from the rows read, then keep the latest ones (below).
				const t = createTurnDetails([], { eventLimit: Number.MAX_SAFE_INTEGER, totalLimit: Number.MAX_SAFE_INTEGER });
				if (rows.length > LIVE_ROWS) { rows.shift(); t.note("This turn is longer than Live reads; earlier activity is omitted."); }
				if (unclear) t.note("OpenCode has a staged revert that Live can't place; this activity may be removed.");
				else if (boundary !== undefined && target.seq >= boundary) t.note("OpenCode has staged a revert that removes this turn.");
				else if (boundary !== undefined && (end?.seq ?? rows.at(-1)?.seq ?? target.seq) >= boundary) t.note("OpenCode has staged a revert of this turn's later activity.");
				// The read budget goes to the newest rows first; older rows beyond it are omitted.
				const admitted = new Set<string>();
				let bytes = 0;
				for (let i = rows.length - 1; i >= 0; i--) {
					const row = rows[i];
					if (!["user", "assistant", "shell"].includes(row.type) || row.bytes > TURN_RECORD_BYTES) continue;
					if (bytes + row.bytes > TURN_READ_BYTES) { t.note("The read-size limit was reached; earlier activity is omitted."); break; }
					bytes += row.bytes;
					admitted.add(row.id);
				}
				const recorded = db.prepare(`SELECT CASE WHEN length(CAST(data AS BLOB))<=? THEN data ELSE NULL END AS data FROM session_message WHERE session_id=? AND id=?`);
				const events: OpenCodeLiveEvent[] = [];
				// A card's id is its slot: the row, the part's position in it, and the card's
				// index within that part. OpenCode updates parts in place (and can replace a
				// row's content); a slot whose content changes is redrawn, never merged.
				const collect = (key: string, from: number) => t.result.events.slice(from).forEach((event, i) => events.push({ ...event, id: `${key}.${i}` }));
				for (const row of rows) {
					signal.throwIfAborted();
					if (row.type === "compaction") { t.note("Context was compacted during this turn."); continue; }
					if (!["user", "assistant", "shell"].includes(row.type)) continue;
					if (row.bytes > TURN_RECORD_BYTES) { t.note("A recorded message exceeded the record size limit and was omitted."); continue; }
					if (!admitted.has(row.id)) continue;
					const text = recorded.get(TURN_RECORD_BYTES, id, row.id)?.data;
					if (typeof text !== "string") { t.note("A recorded message exceeded the record size limit and was omitted."); continue; }
					let data: Row | null = null;
					try { data = record(JSON.parse(text)); } catch { /* Reported below. */ }
					if (!data) { t.note("An invalid recorded message was omitted."); continue; }
					if (row.type === "shell") {
						const from = t.result.events.length;
						t.add("tool", "User shell command", data.command);
						if (data.status === "running") pending(t.result.events, from);
						else t.add("result", "Shell output", shellOutput(t, data.output));
						collect(row.id, from);
						continue;
					}
					if (Array.isArray(data.files) && data.files.length) t.note("Prompt file attachments are omitted.");
					const parts = Array.isArray(data.content) ? data.content : [];
					if (row.type === "user" && typeof data.text === "string" && !parts.length) { const from = t.result.events.length; t.content(data.text, "user"); collect(row.id, from); }
					parts.forEach((p: Row, position: number) => {
						if (!p || p.ignored || p.synthetic) return;
						const from = t.result.events.length;
						if (p.type === "tool") {
							const callId = p.callID ?? p.callId ?? p.id;
							// While its input streams, a tool has no recorded arguments yet.
							const input = p.state?.input ?? p.input;
							t.add("tool", `Tool: ${String(p.tool ?? p.name ?? "")}`, input && typeof input === "object" ? JSON.stringify(input, null, 2) : "", callId);
							if (p.state?.status === "completed" || p.state?.status === "error") {
								const error = typeof p.state.error === "string" ? p.state.error : p.state.error?.message;
								const content = Array.isArray(p.state.content) ? p.state.content : undefined;
								const output = p.state.output ?? content ?? error;
								const attachments = [...(output === content ? [] : content ?? []), ...(Array.isArray(p.state.attachments) ? p.state.attachments : [])];
								t.toolResult(`Tool result${p.state.status === "error" ? " (error)" : ""}`, output, callId, attachments);
							} else pending(t.result.events, from);
						} else t.content([p], row.type);
						collect(`${row.id}.${position}`, from);
					});
				}
				// The latest cards within the usual display limits; the rest are counted, not shown.
				let kept = 0, size = 0;
				while (kept < events.length && kept < TURN_EVENT_LIMIT) {
					const cost = events[events.length - 1 - kept].text.length;
					if (size + cost > TURN_TOTAL_LIMIT) break;
					size += cost; kept++;
				}
				let status: OpenCodeLiveTurn["status"] = "running", finalKey: string | undefined, answerUnavailable = false;
				if (end) {
					status = end.outcome === "succeeded" ? "completed" : end.outcome === "interrupted" ? "interrupted" : "error";
					// The same answer the history reader keeps for this turn: the latest completed
					// assistant row before the idle marker, with its text read under the same bound.
					const answer = status !== "completed" ? undefined
						: end.answer ? db.prepare(`SELECT id,${field("finish")} AS finish FROM session_message WHERE session_id=? AND id=?`).get(id, end.answer)
						: db.prepare(`SELECT id,${field("finish")} AS finish FROM session_message WHERE session_id=? AND type='assistant' AND seq>? AND seq<? AND ${completed} ORDER BY seq DESC LIMIT 1`).get(id, target.seq, end.seq);
					if (answer) {
						const { texts, oversized } = answerTexts(db, id, answer.id);
						if (oversized) answerUnavailable = true;
						else if (texts.some(part => typeof part.text === "string" && part.text.trim())) finalKey = `opencode:${answer.id}`;
						// The idle outcome describes the run; the answer's own finish says it was cut short.
						if (answer.finish === "length") status = "incomplete";
					}
				}
				if (!events.some(e => e.kind === "prompt")) t.note("The input prompt is not available in this recorded portion of the turn.");
				return {
					revision, database, current: current?.id,
					turn: {
						anchor: target.id, status, finalKey, ...(answerUnavailable ? { answerUnavailable } : {}),
						...(current && current.id !== target.id && current.seq > target.seq ? { newerAnchor: current.id } : {}),
						events: events.slice(events.length - kept), omitted: events.length - kept, notices: t.result.notices,
					},
				};
			} finally { db.exec("ROLLBACK"); }
		},
		close() { closed = true; reset(); },
	};
}
