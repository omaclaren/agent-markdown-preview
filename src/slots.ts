// Remembers the port and token of each preview so a restarted preview comes
// back at the same address. Open tabs then reconnect by themselves (the watch
// page retries servers started on a fixed port). The file holds bearer tokens,
// so it is private to this user.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Slot {
	port: number;
	token: string;
	usedAt: number;
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SLOTS = 500;

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.AGENT_MARKDOWN_PREVIEW_HOME || join(homedir(), ".agent-markdown-preview");
}

export interface SlotStore {
	get(key: string): Slot | undefined;
	set(key: string, slot: { port: number; token: string }): void;
	/** Keys (with a given prefix) used within `withinMs`, most recent first. */
	recent(prefix: string, withinMs: number): string[];
}

export function createSlotStore(dir: string = defaultStateDir()): SlotStore {
	const file = join(dir, "servers.json");
	const read = (): Record<string, Slot> => {
		try {
			const value = JSON.parse(readFileSync(file, "utf8"));
			return value && typeof value === "object" && !Array.isArray(value) ? value : {};
		} catch { return {}; }
	};
	const valid = (slot: unknown): slot is Slot => {
		const s = slot as Slot;
		return Boolean(s) && Number.isInteger(s.port) && s.port > 0 && s.port < 65536
			&& typeof s.token === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(s.token) && Number.isFinite(s.usedAt);
	};
	const write = (slots: Record<string, Slot>) => {
		const now = Date.now();
		const kept = Object.entries(slots).filter(([, slot]) => valid(slot) && now - slot.usedAt < MAX_AGE_MS)
			.sort((a, b) => b[1].usedAt - a[1].usedAt).slice(0, MAX_SLOTS);
		try {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			chmodSync(dir, 0o700);
			const tmp = `${file}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)), { mode: 0o600 });
			renameSync(tmp, file);
		} catch { /* Remembering addresses is a convenience; previews still work. */ }
	};
	return {
		get(key) {
			const slot = read()[key];
			return valid(slot) ? slot : undefined;
		},
		set(key, slot) {
			const slots = read();
			slots[key] = { ...slot, usedAt: Date.now() };
			write(slots);
		},
		recent(prefix, withinMs) {
			const now = Date.now();
			return Object.entries(read()).filter(([key, slot]) => key.startsWith(prefix) && valid(slot) && now - slot.usedAt < withinMs)
				.sort((a, b) => b[1].usedAt - a[1].usedAt).map(([key]) => key);
		},
	};
}

export const newToken = () => randomBytes(24).toString("base64url");

/** A currently free localhost port (tiny race until the caller binds it). */
export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			probe.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port")));
		});
	});
}

/**
 * Starts `start(port, token)` at the remembered address for `key`, or at a new
 * fixed address when there is none or it is taken. Always a fixed port, so
 * the page knows to reconnect after a restart.
 */
export async function startAtSlot<T>(store: SlotStore | null, key: string, start: (port: number, token: string) => Promise<T>): Promise<T> {
	const saved = store?.get(key);
	if (saved) {
		try {
			const started = await start(saved.port, saved.token);
			store?.set(key, saved);
			return started;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EADDRINUSE") throw error;
		}
	}
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		const port = await freePort(), token = newToken();
		try {
			const started = await start(port, token);
			store?.set(key, { port, token });
			return started;
		} catch (error) {
			lastError = error;
			if ((error as NodeJS.ErrnoException)?.code !== "EADDRINUSE") throw error;
		}
	}
	throw lastError;
}
