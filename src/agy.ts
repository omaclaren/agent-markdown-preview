// Read-only discovery of agy (Antigravity CLI) conversations. Each conversation keeps a
// transcript under brain/<id>/ (shared/agy-transcript.js) and a SQLite database,
// conversations/<id>.db, whose metadata blob (a protobuf message, read here without its
// schema) names the conversation's workspace and, for a subagent, its parent. Both are
// internal to agy (seen in 1.3) and may change: a conversation whose metadata can't be read
// has no recorded folder, so it isn't followed. Also loads the images agy saves beside a
// transcript for Working and Live (see addAgyMedia).
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { openReadOnly } from "./opencode.js";
import { agyConversation, agyPrompt, agyStep, isAgyFinal } from "./shared/agy-transcript.js";
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
// records only a reference to it ({ mime_type, uri }). Only such a copy is read, and only for
// a transcript in agy's own layout (brain/<conversation>/.system_generated/logs/): a file
// directly in that media folder, itself a real folder, once symbolic links are resolved; the
// file opened is checked again to be the one there. Never the file the tool read or anything
// else a reference names. Its bytes are added to the record (`data`), or why it can't be shown
// (`unavailable`), and shown with the limits of images other agents record. Reads are bounded
// by the images a turn shows (TURN_IMAGE_LIMIT).
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const AGY_TRANSCRIPT = /[/\\]brain[/\\][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[/\\]\.system_generated[/\\]logs[/\\]transcript_full\.jsonl$/i;
/** Live's backfill reads at most this many saved images, for the turns it keeps. */
const LIVE_BACKFILL_IMAGES = 4 * TURN_IMAGE_LIMIT;
type Media = Record<string, unknown>;

const isSavedImage = (m: unknown): m is Media & { mime_type: string } => Boolean(m) && typeof m === "object" && !Array.isArray(m)
	&& typeof (m as Media).mime_type === "string" && ((m as Media).mime_type as string).toLowerCase().startsWith("image/");
/** The images a tool result's step references. */
const savedImages = (record: unknown): number => {
	const e = agyStep(record);
	return e?.type === "GENERIC" && Array.isArray(e.media) ? e.media.filter(isSavedImage).length : 0;
};

/** The media folder beside a transcript in agy's layout, as a real path, or null. */
async function mediaFolder(transcriptPath: string): Promise<string | null> {
	if (!AGY_TRANSCRIPT.test(transcriptPath)) return null;
	try {
		const folder = join(await realpath(dirname(transcriptPath)), "media");
		return (await lstat(folder)).isDirectory() ? folder : null;
	} catch { return null; }
}

async function savedImage(media: Media & { mime_type: string }, folder: string): Promise<Media> {
	if (typeof media.data === "string" || typeof media.uri !== "string" || !media.uri.startsWith("file:///")) return media;
	if (!MEDIA_TYPES.has(media.mime_type.toLowerCase())) return { ...media, unavailable: "format" };
	let file;
	try {
		const path = await realpath(fileURLToPath(media.uri));
		if (dirname(path) !== folder) return media;
		file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
		// The file opened is the one in the folder: no folder on the way was replaced meanwhile.
		const [info, there, still] = await Promise.all([file.stat(), lstat(join(folder, basename(path))), realpath(folder)]);
		if (!info.isFile() || info.dev !== there.dev || info.ino !== there.ino || still !== folder) return media;
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

/** A tool result's step with the first `limit` images agy saved for it, as far as they can be read. */
export async function withAgyMedia(record: unknown, transcriptPath: string, limit = TURN_IMAGE_LIMIT): Promise<unknown> {
	const e = agyStep(record);
	if (limit < 1 || !savedImages(e)) return record;
	const folder = await mediaFolder(transcriptPath);
	if (!folder) return record;
	let left = limit;
	return { ...e, media: await Promise.all(e.media.map((m: unknown) => isSavedImage(m) && left-- > 0 ? savedImage(m, folder) : m)) };
}

/**
 * How many saved images each record, in file order, may have read: the images a turn shows,
 * counted again from each typed prompt and after each answer, where Live can start a turn.
 */
export function createAgyMediaBudget(): (record: unknown) => number {
	let left = TURN_IMAGE_LIMIT, answered = false;
	return record => {
		const e = agyStep(record);
		if (!e) return 0;
		if (answered || agyPrompt(e) !== undefined) left = TURN_IMAGE_LIMIT;
		answered = isAgyFinal(e);
		const n = Math.min(left, savedImages(e));
		left -= n;
		return n;
	};
}

/** Adds saved images to the turns Live keeps from a backfill (from the last two prompts); returns the budget to go on with. */
export async function addAgyLiveMedia(rows: unknown[], transcriptPath: string): Promise<(record: unknown) => number> {
	const budget = createAgyMediaBudget();
	const prompts = [...rows.keys()].filter(i => agyPrompt(rows[i]) !== undefined);
	let reads = LIVE_BACKFILL_IMAGES;
	for (let i = prompts.length >= 2 ? prompts.at(-2)! : 0; i < rows.length; i++) {
		const n = Math.min(budget(rows[i]), reads);
		if (n) { rows[i] = await withAgyMedia(rows[i], transcriptPath, n); reads -= n; }
	}
	return budget;
}

/** Working for an agy answer: its turn as recorded, with the images agy saved for the cards it shows. */
export async function readAgyTurnDetails(path: string, target: { key: string; markdown: string }, signal?: AbortSignal) {
	const { records, incomplete } = await readRecordTail(path, signal);
	let left = TURN_IMAGE_LIMIT;
	for (const i of agyTurnRows(records, target)?.shown ?? []) {
		const n = Math.min(left, savedImages(records[i]));
		if (n) { records[i] = await withAgyMedia(records[i], path, n); left -= n; }
		signal?.throwIfAborted();
	}
	return turnDetailsFromRecords("agy", records, target, incomplete);
}
