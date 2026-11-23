// Read-only discovery of agy (Antigravity CLI) conversations. Each conversation keeps a
// transcript under brain/<id>/ (shared/agy-transcript.js) and a SQLite database,
// conversations/<id>.db, whose metadata blob (a protobuf message, read here without its
// schema) names the conversation's workspace and, for a subagent, its parent. Both are
// internal to agy (seen in 1.3) and may change: a conversation whose metadata can't be read
// has no recorded folder, so it isn't followed. Also loads the images agy saves beside a
// transcript for Working and Live (see addAgyMedia).
import { constants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { openReadOnly } from "./opencode.js";
import { agyConversation, agyPrompt, agyStep } from "./shared/agy-transcript.js";
import { readRecordTail } from "./shared/read-turn-details.js";
import { TURN_IMAGE_BYTES, TURN_IMAGE_LIMIT } from "./shared/recorded-images.js";
import { agyTurnRows, turnDetailsFromRecords } from "./shared/turn-details.js";

const CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A subagent's metadata carries its configuration, tens of kilobytes; far more is not agy's. */
const METADATA_BYTES = 4 * 1024 * 1024;
const KNOWN_LIMIT = 4096;

export const agyTranscriptPath = (root: string, conversation: string) => join(root, "brain", conversation, ".system_generated", "logs", "transcript_full.jsonl");

/**
 * The first value of each wanted length-delimited field of a protobuf message, or null when
 * the bytes aren't one. Other fields are skipped, so memory stays bounded whatever the input.
 */
export function protobufStrings(data: Uint8Array, wanted: ReadonlySet<number>): Map<number, Uint8Array> | null {
	const fields = new Map<number, Uint8Array>();
	let at = 0;
	// Up to ten bytes: a 64-bit value, exact only up to 2^53, which only sizes and keys need.
	const varint = (): number | null => {
		let value = 0;
		for (let shift = 0; shift < 70; shift += 7) {
			if (at >= data.length) return null;
			const byte = data[at++]!;
			value += (byte & 0x7f) * 2 ** shift;
			if (!(byte & 0x80)) return value;
		}
		return null;
	};
	while (at < data.length) {
		const key = varint();
		if (key === null || key > 0xffffffff) return null;
		const field = Math.floor(key / 8), wire = key % 8;
		if (field < 1) return null;
		if (wire === 0) { if (varint() === null) return null; }
		else if (wire === 1) at += 8;
		else if (wire === 5) at += 4;
		else if (wire === 2) {
			const length = varint();
			if (length === null || at + length > data.length) return null;
			if (wanted.has(field) && !fields.has(field)) fields.set(field, data.subarray(at, at + length));
			at += length;
		} else return null;
		if (at > data.length) return null;
	}
	return fields;
}

const utf8 = (bytes: Uint8Array | undefined) => bytes ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : "";
const workspacePath = (uri: string): string | null => {
	if (!uri.startsWith("file:///")) return null;
	try {
		const path = fileURLToPath(uri);
		if (!isAbsolute(path)) return null;
		// Without a trailing separator, as the folder it is compared with.
		const folder = normalize(path);
		return folder === parse(folder).root ? folder : folder.replace(/[\\/]+$/, "");
	} catch { return null; }
};
const METADATA_FIELDS: ReadonlySet<number> = new Set([1, 5, 6, 7]), WORKSPACE_FIELDS: ReadonlySet<number> = new Set([1]);

/**
 * The folder a conversation's metadata records, or null for a subagent (field 5 names its
 * parent; field 6, the root conversation, is the conversation itself only at the top) or a
 * conversation without a workspace. Field 7 is the workspace URI; field 1 lists workspaces.
 * Undefined while the metadata can't be read: empty, or not a protobuf message.
 */
export function agyMetadataCwd(data: Uint8Array, conversation: string): string | null | undefined {
	const fields = data.length ? protobufStrings(data, METADATA_FIELDS) : null;
	if (!fields) return undefined;
	if (utf8(fields.get(5))) return null;
	const root = utf8(fields.get(6));
	if (root && root.toLowerCase() !== conversation.toLowerCase()) return null;
	const listed = fields.get(1);
	return workspacePath(utf8(fields.get(7))) ?? (listed ? workspacePath(utf8(protobufStrings(listed, WORKSPACE_FIELDS)?.get(1))) : null);
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

// ---- Images a tool read ----
// agy saves a copy of each image a tool reads beside the transcript, in logs/media/, and
// records only a reference to it ({ mime_type, uri }). Only such a copy is read: a file
// directly in that folder once symbolic links are resolved, never the file the tool read or
// anything else a reference names. Its bytes are added to the record (`data`), or why it
// can't be shown (`unavailable`), and shown with the limits of images other agents record.
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** A result card shows up to nine images (turn-details.js). */
const MEDIA_PER_RESULT = 9;
type Media = Record<string, unknown>;

async function savedImage(media: Media, folder: string): Promise<Media> {
	if (typeof media.data === "string" || typeof media.uri !== "string" || !media.uri.startsWith("file:///")) return media;
	const type = typeof media.mime_type === "string" ? media.mime_type.toLowerCase() : "";
	if (!type.startsWith("image/")) return media;
	if (!MEDIA_TYPES.has(type)) return { ...media, unavailable: "format" };
	let file;
	try {
		const [path, inside] = await Promise.all([realpath(fileURLToPath(media.uri)), realpath(folder)]);
		if (dirname(path) !== inside) return media;
		file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
		const info = await file.stat();
		if (!info.isFile()) return media;
		if (info.size > TURN_IMAGE_BYTES) return { ...media, unavailable: "size" };
		const bytes = Buffer.alloc(info.size);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		return offset === bytes.length ? { ...media, data: bytes.toString("base64") } : media;
	} catch { return media; }
	finally { await file?.close().catch(() => {}); }
}

/** A tool result's step with the images agy saved for it, as far as they can be read. */
export async function withAgyMedia(record: unknown, transcriptPath: string): Promise<unknown> {
	const e = agyStep(record);
	if (e?.type !== "GENERIC" || !Array.isArray(e.media) || !e.media.length) return record;
	const folder = join(dirname(transcriptPath), "media");
	const media = await Promise.all(e.media.slice(0, MEDIA_PER_RESULT).map((m: unknown) => m && typeof m === "object" && !Array.isArray(m) ? savedImage(m as Media, folder) : m));
	return { ...e, media };
}

/**
 * Adds saved images to the tool results in rows `from` to `to` of a transcript, in place, up to
 * the images one turn shows (TURN_IMAGE_LIMIT); later results keep their references only.
 */
export async function addAgyMedia(rows: unknown[], transcriptPath: string, from = 0, to = rows.length - 1): Promise<void> {
	let left = TURN_IMAGE_LIMIT;
	for (let i = Math.max(0, from); i <= to && i < rows.length && left > 0; i++) {
		const e = agyStep(rows[i]);
		if (e?.type !== "GENERIC" || !Array.isArray(e.media) || !e.media.length) continue;
		left -= Math.min(e.media.length, MEDIA_PER_RESULT);
		rows[i] = await withAgyMedia(rows[i], transcriptPath);
	}
}

/** Adds saved images to the turns Live keeps from a backfill: the last two, each from its prompt. */
export async function addAgyLiveMedia(rows: unknown[], transcriptPath: string): Promise<void> {
	const starts = [...rows.keys()].filter(i => agyPrompt(rows[i]) !== undefined).slice(-2);
	if (starts.length < 2) starts.unshift(0);
	for (const [k, from] of starts.entries()) await addAgyMedia(rows, transcriptPath, from, (starts[k + 1] ?? rows.length) - 1);
}

/** Working for an agy answer: its turn as recorded, with the images agy saved for it. */
export async function readAgyTurnDetails(path: string, target: { key: string; markdown: string }, signal?: AbortSignal) {
	const { records, incomplete } = await readRecordTail(path, signal);
	const turn = agyTurnRows(records, target);
	if (turn) await addAgyMedia(records, path, turn.start, turn.end);
	signal?.throwIfAborted();
	return turnDetailsFromRecords("agy", records, target, incomplete);
}
