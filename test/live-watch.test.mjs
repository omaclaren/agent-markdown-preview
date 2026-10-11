import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeProjectDirName } from "../dist/sessions.js";
import { createLiveSource, startResponseWatch, startSessionIndex, styleForMode } from "../dist/watch.js";

const skip = spawnSync(process.env.PANDOC_PATH || "pandoc", ["--version"], { stdio: "ignore" }).error ? "pandoc not installed" : false;
const line = entry => JSON.stringify(entry) + "\n";
const iso = offsetMs => new Date(Date.now() + offsetMs).toISOString();
const fast = { rescanMs: 100, tailIntervalMs: 40, stateDir: null };
const prompt = (uuid, text) => line({ type: "user", uuid, timestamp: iso(0), message: { role: "user", content: text } });
const call = (uuid, id, callId, command) => line({ type: "assistant", uuid, timestamp: iso(0), message: { role: "assistant", id, stop_reason: "tool_use", content: [{ type: "tool_use", id: callId, name: "Bash", input: { command } }] } });
const result = (uuid, callId, text) => line({ type: "user", uuid, timestamp: iso(0), message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: text }] } });
const answer = (uuid, id, text) => line({ type: "assistant", uuid, timestamp: iso(0), message: { role: "assistant", id, stop_reason: "end_turn", content: [{ type: "text", text }] } });

async function waitFor(check, label, timeoutMs = 10_000) {
	const started = Date.now();
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for " + label);
		await new Promise(done => setTimeout(done, 25));
	}
}

function fixture(t) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "amp-live-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const cwd = join(base, "project");
	mkdirSync(cwd);
	const roots = { claude: join(base, "claude"), codex: join(base, "codex"), pi: join(base, "pi") };
	const claudeDir = join(roots.claude, claudeProjectDirName(cwd));
	mkdirSync(claudeDir, { recursive: true });
	return { base, cwd, roots, claudeDir };
}

test("Live source: nothing until asked, backfill then follow, release after the lease", async t => {
	const f = fixture(t);
	const path = join(f.claudeDir, "00000000-0000-4000-8000-00000000live.jsonl");
	writeFileSync(path, prompt("p1", "Start") + call("c1", "m1", "k1", "ls"));
	const listeners = new Set();
	const monitor = { onRecord(id, listener) { assert.equal(id, "session-1"); listeners.add(listener); return () => listeners.delete(listener); } };
	const source = createLiveSource(monitor, { id: "session-1", path }, { leaseMs: 150 });
	assert.equal(listeners.size, 0, "no subscription or projection before a live page asks");
	assert.equal(await source.current(), "p1");
	assert.equal(listeners.size, 1);
	assert.deepEqual((await source.snapshot("p1")).events.map(e => e.id), ["p1:0", "c1:0"]);
	// New records arrive through the subscription; one already read is ignored.
	for (const listener of listeners) {
		listener(JSON.parse(call("c1", "m1", "k1", "ls")));
		listener(JSON.parse(result("r1", "k1", "file.txt")));
	}
	assert.deepEqual((await source.snapshot("p1")).events.map(e => e.id), ["p1:0", "c1:0", "r1:0"]);
	await waitFor(() => listeners.size === 0, "lease release", 2000);
	// A later request starts a fresh lease from the file.
	assert.equal(await source.current(), "p1");
	assert.equal(listeners.size, 1);
	source.close();
	assert.equal(listeners.size, 0);
});

test("--live: a pinned Claude session follows its current turn through the server", { skip, timeout: 60_000 }, async t => {
	const f = fixture(t);
	const session = join(f.claudeDir, "00000000-0000-4000-8000-0000000live2.jsonl");
	writeFileSync(session, prompt("old", "Earlier") + answer("oldf", "m0", "Earlier answer") + prompt("p", "Run the checks"));
	const watch = await startResponseWatch({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), sessionPath: session, agents: ["claude"], turnDetails: true, live: true, ...fast });
	t.after(() => watch.close());
	const first = await fetch(watch.url);
	const cookie = first.headers.get("set-cookie").split(";")[0];
	const root = await first.text();
	const entry = root.match(/data-watch-control="live" href="([^"]+)"/)?.[1].replaceAll("&amp;", "&");
	assert.ok(entry, "a pinned Claude session offers the Live tab");
	const origin = new URL(watch.url).origin;
	const get = path => fetch(new URL(path, origin), { headers: { cookie }, redirect: "manual" });
	const redirect = await get(entry);
	assert.equal(redirect.status, 302);
	const livePage = redirect.headers.get("location");
	assert.match(livePage, /^\/__pi_markdown_preview_live__\/p\?/);
	const html = await (await get(livePage)).text();
	assert.match(html, /<h1>Live · recorded activity<\/h1>/);
	assert.match(html, /Run the checks/);
	const cursor = html.match(/data-live-cursor="([^"]+)"/)[1];
	const updates = path => get(`${livePage.replace("?", "/updates?")}&cursor=${encodeURIComponent(path)}`).then(r => r.json());
	appendFileSync(session, call("c", "m1", "k", "npm test"));
	const grown = await waitFor(async () => { const u = await updates(cursor); return u.upserts?.length ? u : null; }, "the new call");
	assert.deepEqual(grown.upserts.map(u => u.id), ["c:0"]);
	appendFileSync(session, result("r", "k", "ok") + answer("f", "m2", "All green."));
	const done = await waitFor(async () => { const u = await updates(grown.cursor); return /Open its response/.test(u.statusHtml ?? "") ? u : null; }, "completion linked to the retained response", 15_000);
	assert.match(done.statusHtml, /Turn completed\. <a href="\/\?revision=\d+&amp;identity=/);
});

test("--live is offered only where it applies: not for merged views, not without the flag", { skip, timeout: 60_000 }, async t => {
	const f = fixture(t);
	writeFileSync(join(f.claudeDir, "00000000-0000-4000-8000-0000000live3.jsonl"), prompt("p", "Hello") + answer("a", "m1", "Hi"));
	const merged = await startResponseWatch({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), turnDetails: true, live: true, ...fast });
	t.after(() => merged.close());
	assert.doesNotMatch(await (await fetch(merged.url)).text(), /<a data-watch-control="live"/, "merged views have no single current turn");
	const plain = await startSessionIndex({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), turnDetails: true, ...fast });
	t.after(() => plain.close());
	const index = await fetch(plain.url);
	const cookie = index.headers.get("set-cookie")?.split(";")[0] ?? "";
	const sessions = await (await fetch(new URL("/api/sessions?token=" + new URL(plain.url).searchParams.get("token"), plain.url), { headers: { cookie } })).json();
	const opened = await fetch(new URL(`/open/${sessions.sessions[0].id}?token=${new URL(plain.url).searchParams.get("token")}`, plain.url), { redirect: "manual" });
	const sessionUrl = opened.headers.get("location");
	assert.ok(sessionUrl);
	assert.doesNotMatch(await (await fetch(sessionUrl)).text(), /<a data-watch-control="live"/, "without --live there is no live entry");
	// With --live, a Claude session opened from the index offers it, on fresh credentials.
	const withLive = await startSessionIndex({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), turnDetails: true, live: true, ...fast });
	t.after(() => withLive.close());
	const liveToken = new URL(withLive.url).searchParams.get("token");
	const liveSessions = await (await fetch(new URL("/api/sessions?token=" + liveToken, withLive.url))).json();
	const liveOpened = await fetch(new URL(`/open/${liveSessions.sessions[0].id}?token=${liveToken}`, withLive.url), { redirect: "manual" });
	assert.match(await (await fetch(liveOpened.headers.get("location"))).text(), /<a data-watch-control="live"/);
});
