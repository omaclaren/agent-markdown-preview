// Read-only discovery of agy (Antigravity CLI) conversations. Each conversation keeps a
// transcript under brain/<id>/ (shared/agy-transcript.js) and a SQLite database,
// conversations/<id>.db, whose metadata blob (a protobuf message, read here without its
// schema) names the conversation's workspace and, for a subagent, its parent. Both are
// internal to agy (seen in 1.3) and may change: a conversation whose metadata can't be read
// has no recorded folder, so it isn't followed.
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { openReadOnly } from "./opencode.js";
import { agyConversation } from "./shared/agy-transcript.js";

const CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A subagent's metadata carries its configuration, tens of kilobytes; far more is not agy's. */
const METADATA_BYTES = 4 * 1024 * 1024;
const KNOWN_LIMIT = 4096;

export const agyTranscriptPath = (root: string, conversation: string) => join(root, "brain", conversation, ".system_generated", "logs", "transcript_full.jsonl");

/** A protobuf message's length-delimited fields by number, or null when the bytes aren't one. */
export function protobufStrings(data: Uint8Array): Map<number, Uint8Array[]> | null {
	const fields = new Map<number, Uint8Array[]>();
	let at = 0;
	const varint = (): number | null => {
		let value = 0;
		for (let shift = 0; shift < 49; shift += 7) {
			if (at >= data.length) return null;
			const byte = data[at++]!;
			value += (byte & 0x7f) * 2 ** shift;
			if (!(byte & 0x80)) return value;
		}
		return null;
	};
	while (at < data.length) {
		const key = varint();
		if (key === null) return null;
		const field = Math.floor(key / 8), wire = key % 8;
		if (field < 1) return null;
		if (wire === 0) { if (varint() === null) return null; }
		else if (wire === 1) at += 8;
		else if (wire === 5) at += 4;
		else if (wire === 2) {
			const length = varint();
			if (length === null || at + length > data.length) return null;
			const values = fields.get(field) ?? [];
			values.push(data.subarray(at, at + length));
			fields.set(field, values);
			at += length;
		} else return null;
		if (at > data.length) return null;
	}
	return fields;
}

const utf8 = (bytes: Uint8Array | undefined) => bytes ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : "";
const workspacePath = (uri: string): string | null => {
	if (!uri.startsWith("file:///")) return null;
	try { const path = fileURLToPath(uri); return isAbsolute(path) ? normalize(path) : null; } catch { return null; }
};

/**
 * The folder a conversation's metadata records, or null for a subagent (field 5 names its
 * parent; field 6, the root conversation, is the conversation itself only at the top) or a
 * conversation without a workspace. Field 7 is the workspace URI; field 1 lists workspaces.
 */
export function agyMetadataCwd(data: Uint8Array, conversation: string): string | null {
	const fields = protobufStrings(data);
	if (!fields) return null;
	if (utf8(fields.get(5)?.[0])) return null;
	const root = utf8(fields.get(6)?.[0]);
	if (root && root.toLowerCase() !== conversation.toLowerCase()) return null;
	const listed = fields.get(1)?.[0];
	return workspacePath(utf8(fields.get(7)?.[0])) ?? (listed ? workspacePath(utf8(protobufStrings(listed)?.get(1)?.[0])) : null);
}

export interface AgyTranscript { path: string; mtimeMs: number }

/** Conversations under one agy data directory (~/.gemini/antigravity-cli). */
export function createAgyStore(root: string) {
	// Metadata is set when a conversation is created, so a definite answer is kept.
	const known = new Map<string, string | null>();
	/** Transcripts, newest first. */
	async function transcripts(): Promise<AgyTranscript[]> {
		const names = await readdir(join(root, "brain")).catch(() => [] as string[]);
		const found = await Promise.all(names.filter(name => CONVERSATION.test(name)).map(async name => {
			const path = agyTranscriptPath(root, name);
			const info = await stat(path).catch(() => null);
			return info?.isFile() ? { path, mtimeMs: info.mtimeMs } : null;
		}));
		return found.filter((file): file is AgyTranscript => file !== null).sort((a, b) => b.mtimeMs - a.mtimeMs);
	}
	/** The folder of a top-level conversation; null for a subagent, or while its metadata can't be read. */
	async function cwd(path: string): Promise<string | null> {
		const conversation = agyConversation(path);
		if (!conversation) return null;
		if (known.has(conversation)) return known.get(conversation)!;
		let db;
		try { db = await openReadOnly(join(root, "conversations", `${conversation}.db`), "agy history"); }
		catch { return null; }
		let result: string | null | undefined;
		try {
			const row = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' AND length(data) <= ?").get(METADATA_BYTES);
			if (row?.data instanceof Uint8Array) result = agyMetadataCwd(row.data, conversation);
		} catch { /* Being written, or another layout: try again later. */ }
		finally { db.close(); }
		if (result === undefined) return null;
		known.delete(conversation); known.set(conversation, result);
		while (known.size > KNOWN_LIMIT) known.delete(known.keys().next().value!);
		return result;
	}
	return { transcripts, cwd };
}
