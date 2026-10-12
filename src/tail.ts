import { unwatchFile, watchFile } from "node:fs";
import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

export interface JsonlTail {
	/** Resolves after the existing content (backfill) has been delivered. */
	ready: Promise<void>;
	/** Reads any new complete lines now. */
	poll(): Promise<void>;
	close(): void;
}

/**
 * Follows an append-only JSONL file. Complete lines are parsed and delivered in
 * order, with their length; a partial trailing line waits for the rest. When the
 * file is truncated or replaced (another inode at the path), `onReset` is called
 * and reading starts over as for a new file: the last `maxBackfillBytes`, as
 * initially.
 */
export function tailJsonl(path: string, onEntry: (entry: unknown, length: number) => void, { intervalMs = 300, maxBackfillBytes = 8_000_000, onError, onReset }: {
	intervalMs?: number; maxBackfillBytes?: number; onError?: (error: unknown) => void; onReset?: () => void;
} = {}): JsonlTail {
	let offset: number | null = null, identity = "", decoder = new StringDecoder("utf8"), remainder = "", skipFirstLine = false;
	let reading = false, again = false, closed = false;

	async function readMore() {
		const info = await stat(path).catch(() => null);
		if (!info || closed) return;
		const file = `${info.dev}:${info.ino}`;
		if (offset !== null && (info.size < offset || file !== identity)) {
			offset = null; remainder = ""; decoder = new StringDecoder("utf8");
			onReset?.();
		}
		identity = file;
		if (offset === null) {
			offset = Math.max(0, info.size - maxBackfillBytes);
			skipFirstLine = offset > 0;
		}
		if (info.size === offset) return;
		const handle = await open(path, "r");
		try {
			const buffer = Buffer.alloc(info.size - offset);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
			offset += bytesRead;
			remainder += decoder.write(buffer.subarray(0, bytesRead));
		} finally { await handle.close(); }
		const lines = remainder.split("\n");
		remainder = lines.pop() ?? "";
		if (skipFirstLine && lines.length) { lines.shift(); skipFirstLine = false; }
		for (const line of lines) {
			if (closed) return;
			if (!line.trim()) continue;
			let entry: unknown;
			try { entry = JSON.parse(line); } catch { continue; }
			onEntry(entry, line.length);
		}
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
