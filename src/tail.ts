import { unwatchFile, watchFile } from "node:fs";
import { open, stat } from "node:fs/promises";

export interface JsonlTail {
	/** Resolves after the existing content (backfill) has been delivered. */
	ready: Promise<void>;
	/** Reads any new complete lines now. */
	poll(): Promise<void>;
	close(): void;
}

/**
 * Follows an append-only JSONL file. Complete lines are parsed and delivered in
 * order, with their length and the byte offset where the line starts; a partial
 * trailing line waits for the rest. When the file is truncated or replaced
 * (another inode at the path), `onReset` is called and reading starts over as
 * for a new file: the last `maxBackfillBytes`, as initially.
 */
export function tailJsonl(path: string, onEntry: (entry: unknown, length: number, offset: number) => void, { intervalMs = 300, maxBackfillBytes = 8_000_000, onError, onReset }: {
	intervalMs?: number; maxBackfillBytes?: number; onError?: (error: unknown) => void; onReset?: () => void;
} = {}): JsonlTail {
	// `remainder` holds the bytes of a partial line, which starts at `remainderAt`.
	let offset: number | null = null, identity = "", remainder = Buffer.alloc(0), remainderAt = 0, skipFirstLine = false;
	let reading = false, again = false, closed = false;

	async function readMore() {
		const info = await stat(path).catch(() => null);
		if (!info || closed) return;
		const file = `${info.dev}:${info.ino}`;
		if (offset !== null && (info.size < offset || file !== identity)) {
			offset = null; remainder = Buffer.alloc(0);
			onReset?.();
		}
		identity = file;
		if (offset === null) {
			offset = remainderAt = Math.max(0, info.size - maxBackfillBytes);
			skipFirstLine = offset > 0;
		}
		if (info.size === offset) return;
		const handle = await open(path, "r");
		let data: Buffer;
		try {
			const buffer = Buffer.alloc(info.size - offset);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
			offset += bytesRead;
			data = remainder.length ? Buffer.concat([remainder, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
		} finally { await handle.close(); }
		// Split on newline bytes, which never occur inside a UTF-8 sequence, so offsets are exact.
		let start = 0;
		for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
			const lineAt = remainderAt + start, line = data.toString("utf8", start, end);
			start = end + 1;
			if (skipFirstLine) { skipFirstLine = false; continue; }
			if (closed) return;
			if (!line.trim()) continue;
			let entry: unknown;
			try { entry = JSON.parse(line); } catch { continue; }
			onEntry(entry, line.length, lineAt);
		}
		remainder = Buffer.from(data.subarray(start));
		remainderAt += start;
	}
	async function drain() {
		if (reading) { again = true; return; }
		reading = true;
		try { do { again = false; await readMore(); } while (again && !closed); }
		catch (error) { onError?.(error); }
		finally { reading = false; }
	}
	const listener = () => void drain();
	watchFile(path, { interval: intervalMs, persistent: false }, listener);
	return { ready: drain(), poll: drain, close() { closed = true; unwatchFile(path, listener); } };
}
