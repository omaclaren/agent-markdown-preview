// Read-only OpenCode adapters. v1 uses session/message/part; v2 uses
// session_v2/session_message projections. Never boot OpenCode or run migrations.
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentResponse, SessionFile } from "./sessions.js";

type Row = Record<string, any>;
interface Database {
	prepare(sql: string): { all(...params: (string | number)[]): Row[]; get(...params: (string | number)[]): Row | undefined };
	exec(sql: string): unknown;
	close(): void;
}
const record = (value: unknown): Row | null => value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const finiteTime = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
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
	close(): void;
}

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
	let database: Database | null = null, inode = "", closed = false;
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
				const texts = db.prepare(`WITH parts AS (
					SELECT CASE WHEN p.type='object' THEN p.value ELSE '{}' END AS body, CAST(p.key AS INTEGER) AS position
					FROM session_message m, json_each(m.data,'$.content') p WHERE m.session_id=? AND m.id=?
				), texts AS (
					SELECT json_extract(body,'$.text') AS text,position FROM parts WHERE json_extract(body,'$.type')='text'
					AND json_type(body,'$.text')='text' AND COALESCE(json_extract(body,'$.ignored'),0)=0 AND COALESCE(json_extract(body,'$.synthetic'),0)=0
				) SELECT text FROM texts WHERE (SELECT SUM(length(CAST(text AS BLOB))+2) FROM texts)<=? ORDER BY position`).all(id, row.id, MAX_TEXT_BYTES);
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
		close() { closed = true; reset(); },
	};
}
