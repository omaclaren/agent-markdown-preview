import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeProjectDirName, piSessionDirName } from "../dist/sessions.js";
import { startFileWatch, startResponseWatch, startSessionIndex, styleForMode } from "../dist/watch.js";

const skip = spawnSync(process.env.PANDOC_PATH || "pandoc", ["--version"], { stdio: "ignore" }).error ? "pandoc not installed" : false;
const line = entry => JSON.stringify(entry) + "\n";
const iso = offsetMs => new Date(Date.now() + offsetMs).toISOString();
const page = async url => (await fetch(url)).text();
const claudeAnswer = (id, text, time) => line({ type: "assistant", timestamp: time, message: { id, stop_reason: "end_turn", content: [{ type: "text", text }] } });
const fast = { rescanMs: 100, tailIntervalMs: 40, stateDir: null };

async function waitFor(check, label, timeoutMs = 10_000) {
	const started = Date.now();
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for " + label);
		await new Promise(done => setTimeout(done, 25));
	}
}

function fixture() {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "amp-watch-")));
	const cwd = join(base, "project");
	mkdirSync(cwd);
	const roots = { claude: join(base, "claude"), codex: join(base, "codex"), pi: join(base, "pi") };
	const claudeDir = join(roots.claude, claudeProjectDirName(cwd));
	mkdirSync(claudeDir, { recursive: true });
	return { base, cwd, roots, claudeDir };
}

test("merged view: latest existing answer first, then new answers from every session and agent", { skip, timeout: 60_000 }, async t => {
	const f = fixture();
	const a = join(f.claudeDir, "00000000-0000-4000-8000-00000000aaaa.jsonl");
	writeFileSync(a, claudeAnswer("m1", "Older answer", iso(-600_000)) + claudeAnswer("m2", "Latest **existing** answer", iso(-300_000)));
	const rendered = [];
	const watch = await startResponseWatch({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), ...fast, onRendered: r => rendered.push(r.key) });
	t.after(() => watch.close());
	assert.match(watch.label, /All sessions · project/);
	const first = await page(watch.url);
	assert.match(first, /Latest <strong>existing<\/strong> answer/);
	assert.match(first, /<em>Claude Code aaaa · [^<]+<\/em>/, "merged answers carry a rendered source caption");
	assert.doesNotMatch(first, /amp-source|&lt;p class|&lt;small/, "no escaped caption markup");
	assert.doesNotMatch(first, /Older answer/);

	// Two concurrent Claude sessions. B finishes first in wall-clock terms but is
	// written second: both must still appear (previously B was dropped as "old").
	const b = join(f.claudeDir, "00000000-0000-4000-8000-00000000bbbb.jsonl");
	writeFileSync(b, line({ type: "user", message: { content: "hello" } }));
	await waitFor(() => false, "rescan", 400).catch(() => {});
	appendFileSync(a, claudeAnswer("a3", "Session A answer", iso(2_000)));
	await waitFor(() => rendered.includes("claude:a3"), "session A");
	appendFileSync(b, claudeAnswer("b1", "Session B answer", iso(1_000)));
	await waitFor(() => rendered.includes("claude:b1"), "session B despite earlier timestamp");
	assert.match(await page(watch.url), /Session B answer/);

	// A Codex session and a Pi session in the same directory.
	const dayDir = join(f.roots.codex, "2026", "09", "24");
	mkdirSync(dayDir, { recursive: true });
	writeFileSync(join(dayDir, "rollout-2026-09-24T01-00-00-00000000-0000-4000-8000-00000000cccc.jsonl"), line({ type: "session_meta", payload: { cwd: f.cwd } })
		+ line({ type: "event_msg", timestamp: iso(3_000), payload: { type: "task_complete", turn_id: "t1", last_agent_message: "Codex *says* hi" } }));
	await waitFor(() => rendered.includes("codex:t1"), "codex");
	assert.match(await page(watch.url), /Codex <em>says<\/em> hi/);
	mkdirSync(join(f.roots.pi, piSessionDirName(f.cwd)), { recursive: true });
	writeFileSync(join(f.roots.pi, piSessionDirName(f.cwd), "2026_00000000-0000-4000-8000-00000000dddd.jsonl"), line({ type: "session", cwd: f.cwd })
		+ line({ type: "message", id: "old", timestamp: iso(-86_400_000), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Ancient history" }] } })
		+ line({ type: "message", id: "p1", timestamp: iso(4_000), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Pi answer" }] } }));
	await waitFor(() => rendered.includes("pi:p1"), "pi");
	assert.equal(rendered.includes("pi:old"), false, "history in a newly discovered log is not replayed");
	assert.match(await page(watch.url), /Pi answer/);
});

test("session index lists sessions with titles and opens per-session and merged previews", { skip, timeout: 60_000 }, async t => {
	const f = fixture();
	const stale = join(f.claudeDir, "00000000-0000-4000-8000-00000000eeee.jsonl");
	writeFileSync(stale, claudeAnswer("old", "Weeks old", iso(-20 * 86_400_000)));
	const { utimesSync } = await import("node:fs");
	utimesSync(stale, new Date(Date.now() - 20 * 86_400_000), new Date(Date.now() - 20 * 86_400_000));
	const a = join(f.claudeDir, "00000000-0000-4000-8000-00000000aaaa.jsonl");
	const b = join(f.claudeDir, "00000000-0000-4000-8000-00000000bbbb.jsonl");
	writeFileSync(a, line({ type: "ai-title", aiTitle: "Hosting review" }) + claudeAnswer("a1", "Answer from A", iso(-60_000)));
	writeFileSync(b, line({ type: "user", timestamp: iso(-1_000), message: { content: "Channel spike please" } }));
	const rendered = [];
	const index = await startSessionIndex({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), ...fast, onRendered: r => rendered.push(r.key) });
	t.after(() => index.close());

	const html = await page(index.url);
	assert.match(html, /Agent sessions/);
	const token = new URL(index.url).searchParams.get("token");
	const api = async () => (await fetch(new URL(`/api/sessions?token=${token}`, index.url))).json();
	const data = await api();
	assert.equal(data.sessions.length, 2, "a session idle for weeks is not listed");
	const byShort = Object.fromEntries(data.sessions.map(s => [s.shortId, s]));
	assert.equal(byShort.aaaa.title, "Hosting review");
	assert.equal(byShort.aaaa.responseCount, 1);
	assert.equal(byShort.bbbb.title, "Channel spike please");
	assert.equal(byShort.bbbb.working, true);
	assert.equal(data.sessions[0].shortId, "bbbb", "most recently active first");

	const open = async id => {
		const response = await fetch(new URL(`/open/${id}?token=${token}`, index.url), { redirect: "manual" });
		assert.equal(response.status, 302);
		return response.headers.get("location");
	};
	const aUrl = await open(byShort.aaaa.id);
	assert.match(await page(aUrl), /Answer from A/);
	assert.equal(await open(byShort.aaaa.id), aUrl, "the same session reuses its preview");
	const bUrl = await open(byShort.bbbb.id);
	assert.match(await page(bUrl), /No completed response in this Claude Code session yet/);
	const allUrl = await open("all");

	appendFileSync(b, claudeAnswer("b1", "B finished", iso(1_000)));
	await waitFor(() => rendered.filter(key => key === "claude:b1").length === 2, "B in its own view and the merged view");
	assert.match(await page(bUrl), /B finished/);
	assert.match(await page(allUrl), /B finished/);
	assert.match(await page(aUrl), /Answer from A/, "other sessions' previews are unaffected");
	assert.equal((await api()).sessions.find(s => s.shortId === "bbbb").working, false);

	// Access control.
	assert.equal((await fetch(new URL("/api/sessions?token=wrong", index.url))).status, 403);
	assert.equal((await fetch(new URL(`/open/0123456789abcdef?token=${token}`, index.url))).status, 404);
});

test("pinned session and waiting page", { skip, timeout: 30_000 }, async t => {
	const f = fixture();
	const empty = await startResponseWatch({ cwd: f.cwd, roots: f.roots, style: styleForMode("dark"), agents: ["codex"], stateDir: null });
	t.after(() => empty.close());
	assert.match(await page(empty.url), /Waiting for the next completed response from Codex/);
	const session = join(f.base, "pinned.jsonl");
	writeFileSync(session, line({ type: "session", cwd: f.cwd }) + line({ type: "message", id: "a", timestamp: iso(-1_000), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Pinned session" }] } }));
	const pinned = await startResponseWatch({ cwd: f.cwd, roots: f.roots, style: styleForMode("dark"), sessionPath: session, stateDir: null });
	t.after(() => pinned.close());
	assert.match(pinned.label, /^Pi pinn/);
	const html = await page(pinned.url);
	assert.match(html, /Pinned session/);
	assert.match(html, /<em>Pi pinn · \d/, "every preview says which session a response came from");
});

test("file watch re-renders on change", { skip, timeout: 30_000 }, async t => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "amp-file-")));
	const file = join(dir, "notes.md");
	writeFileSync(file, "# First\n\nSome *text*.\n");
	const revisions = [];
	const watch = await startFileWatch({ filePath: file, style: styleForMode("light"), intervalMs: 50, debounceMs: 20, stateDir: null, onRendered: r => revisions.push(r) });
	t.after(() => watch.close());
	assert.equal(watch.label, "notes.md");
	assert.match(await page(watch.url), /First/);
	writeFileSync(file, "# Second\n\n$$E = mc^2$$\n");
	await waitFor(() => revisions.length >= 1, "file re-render");
	assert.match(await page(watch.url), /Second/);
});

test("previews update without an onRendered callback (as the CLI runs them)", { skip, timeout: 30_000 }, async t => {
	const f = fixture();
	const file = join(f.claudeDir, "00000000-0000-4000-8000-00000000aaaa.jsonl");
	writeFileSync(file, claudeAnswer("m1", "First answer", iso(-60_000)));
	const index = await startSessionIndex({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), ...fast });
	t.after(() => index.close());
	const token = new URL(index.url).searchParams.get("token");
	const [session] = (await (await fetch(new URL(`/api/sessions?token=${token}`, index.url))).json()).sessions;
	const urls = [];
	for (const id of [session.id, "all"]) urls.push((await fetch(new URL(`/open/${id}?token=${token}`, index.url), { redirect: "manual" })).headers.get("location"));
	const merged = await startResponseWatch({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), ...fast });
	t.after(() => merged.close());
	urls.push(merged.url);
	appendFileSync(file, claudeAnswer("m2", "Second answer", iso(1_000)));
	for (const url of urls) await waitFor(async () => /Second answer/.test(await page(url)), `update at ${url}`);
});

test("restarts reuse remembered addresses and restore previews that were open", { skip, timeout: 60_000 }, async t => {
	const f = fixture();
	const stateDir = join(f.base, "state");
	const file = join(f.claudeDir, "00000000-0000-4000-8000-00000000aaaa.jsonl");
	writeFileSync(file, claudeAnswer("m1", "Before restart", iso(-60_000)));
	const options = { cwd: f.cwd, roots: f.roots, style: styleForMode("light"), rescanMs: 100, tailIntervalMs: 40, stateDir };
	const openView = async (index, id) => (await fetch(new URL(`/open/${id}?token=${new URL(index.url).searchParams.get("token")}`, index.url), { redirect: "manual" })).headers.get("location");

	const first = await startSessionIndex(options);
	const token = new URL(first.url).searchParams.get("token");
	const [session] = (await (await fetch(new URL(`/api/sessions?token=${token}`, first.url))).json()).sessions;
	const sessionUrl = await openView(first, session.id);
	const mergedUrl = await openView(first, "all");
	await first.close();

	const second = await startSessionIndex(options);
	t.after(() => second.close());
	assert.equal(second.url, first.url, "the index comes back at the same address");
	// Views open last time are restored without visiting the index, so old tabs reconnect.
	await waitFor(async () => { try { return /Before restart/.test(await page(sessionUrl)); } catch { return false; } }, "restored session preview");
	assert.match(await page(mergedUrl), /Before restart/);
	assert.equal(await openView(second, session.id), sessionUrl, "same preview address after a restart");
	appendFileSync(file, claudeAnswer("m2", "After restart", iso(1_000)));
	await waitFor(async () => /After restart/.test(await page(sessionUrl)), "restored preview keeps updating");

	// A remembered port taken by something else falls back to a new address.
	const other = await startSessionIndex({ ...options, stateDir: join(f.base, "state-2") });
	t.after(() => other.close());
	const { createSlotStore } = await import("../dist/slots.js");
	const store = createSlotStore(join(f.base, "state-2"));
	const key = `${realpathSync(f.cwd)}|index`;
	const port = Number(new URL(second.url).port);
	store.set(key, { port, token: "x".repeat(40) });
	const fallback = await startSessionIndex({ ...options, stateDir: join(f.base, "state-2"), cwd: f.cwd });
	t.after(() => fallback.close());
	assert.notEqual(new URL(fallback.url).port, String(port));
	assert.equal(store.get(key).port, Number(new URL(fallback.url).port), "the new address is remembered");
});

test("file watch comes back at the same address after a restart", { skip, timeout: 30_000 }, async t => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "amp-file-")));
	const file = join(dir, "notes.md");
	writeFileSync(file, "# Notes\n");
	const stateDir = join(dir, "state");
	const first = await startFileWatch({ filePath: file, style: styleForMode("light"), stateDir });
	const url = first.url;
	await first.close();
	const second = await startFileWatch({ filePath: file, style: styleForMode("light"), stateDir });
	t.after(() => second.close());
	assert.equal(second.url, url);
	assert.match(await page(url), /Notes/);
	assert.match(await page(url), /Agent Markdown Preview<\/title>/);
});

const revisionsOf = async url => JSON.parse((await page(url)).match(/let revisions = (\[[^\]]*\])/)[1]);
const atRevision = async (url, revision) => {
	// The first request carries the token and sets the cookie; later ones may use ?revision=.
	const first = await fetch(url);
	const cookie = first.headers.get("set-cookie").split(";")[0];
	return (await fetch(new URL(`/?revision=${revision}`, url), { headers: { cookie } })).text();
};

test("previews start with recent history from the logs, oldest first, newest shown", { skip, timeout: 60_000 }, async t => {
	const f = fixture();
	const a = join(f.claudeDir, "00000000-0000-4000-8000-00000000aaaa.jsonl");
	const b = join(f.claudeDir, "00000000-0000-4000-8000-00000000bbbb.jsonl");
	let content = "";
	for (let n = 1; n <= 12; n++) content += claudeAnswer(`a${n}`, `Answer A${n}`, iso(-600_000 + n * 20_000));
	writeFileSync(a, content);
	writeFileSync(b, claudeAnswer("b1", "Answer B1", iso(-600_000 + 5.5 * 20_000)) + claudeAnswer("b2", "Answer B2", iso(-600_000 + 11.5 * 20_000)));
	const index = await startSessionIndex({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), ...fast });
	t.after(() => index.close());
	const token = new URL(index.url).searchParams.get("token");
	const sessions = (await (await fetch(new URL(`/api/sessions?token=${token}`, index.url))).json()).sessions;
	const open = async id => (await fetch(new URL(`/open/${id}?token=${token}`, index.url), { redirect: "manual" })).headers.get("location");

	const aUrl = await open(sessions.find(s => s.shortId === "aaaa").id);
	const aRevisions = await revisionsOf(aUrl);
	assert.equal(aRevisions.length, 10, "last 10 of 12 responses");
	assert.match(await page(aUrl), /Answer A12/, "newest is shown");
	assert.match(await atRevision(aUrl, aRevisions[0]), /Answer A3/, "oldest retained is A3");
	assert.doesNotMatch(await atRevision(aUrl, aRevisions[0]), /Answer B/, "a session preview holds only its own responses");

	// Merged: the most recent 10 across sessions, in time order, captioned.
	const allUrl = await open("all");
	const all = await revisionsOf(allUrl);
	assert.equal(all.length, 10);
	const texts = [];
	for (const revision of all) texts.push((await atRevision(allUrl, revision)).match(/Answer [AB]\d+/)[0]);
	assert.deepEqual(texts, ["Answer A5", "Answer B1", "Answer A6", "Answer A7", "Answer A8", "Answer A9", "Answer A10", "Answer A11", "Answer B2", "Answer A12"]);
	assert.match(await atRevision(allUrl, all[1]), /<em>Claude Code bbbb · /);

	// Live answers still append after the fill.
	appendFileSync(a, claudeAnswer("a13", "Answer A13", iso(1_000)));
	await waitFor(async () => /Answer A13/.test(await page(aUrl)), "live update after fill");
	assert.equal((await revisionsOf(aUrl)).length, 11);
});

test("history fill can be turned off", { skip, timeout: 30_000 }, async t => {
	const f = fixture();
	const a = join(f.claudeDir, "00000000-0000-4000-8000-00000000aaaa.jsonl");
	writeFileSync(a, claudeAnswer("a1", "One", iso(-60_000)) + claudeAnswer("a2", "Two", iso(-30_000)));
	const watch = await startResponseWatch({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), ...fast, historyFill: 0 });
	t.after(() => watch.close());
	assert.equal((await revisionsOf(watch.url)).length, 1);
	assert.match(await page(watch.url), /Two/);
});

test("per-session previews caption responses with agent, session and title", { skip, timeout: 30_000 }, async t => {
	const f = fixture();
	writeFileSync(join(f.claudeDir, "00000000-0000-4000-8000-00000000aaaa.jsonl"), line({ type: "ai-title", aiTitle: "Review the hosting core" }) + claudeAnswer("a1", "Body text", iso(-1_000)));
	const index = await startSessionIndex({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), ...fast });
	t.after(() => index.close());
	const token = new URL(index.url).searchParams.get("token");
	const [session] = (await (await fetch(new URL(`/api/sessions?token=${token}`, index.url))).json()).sessions;
	const url = (await fetch(new URL(`/open/${session.id}?token=${token}`, index.url), { redirect: "manual" })).headers.get("location");
	assert.match(await page(url), /<em>Claude Code aaaa · Review the hosting core · [^<]+<\/em>/);
});

test("a restarted preview notices a reconnecting tab instead of needing a new one", { skip, timeout: 30_000 }, async t => {
	const f = fixture();
	writeFileSync(join(f.claudeDir, "00000000-0000-4000-8000-00000000aaaa.jsonl"), claudeAnswer("a1", "Hi", iso(-1_000)));
	const stateDir = join(f.base, "state");
	const options = { cwd: f.cwd, roots: f.roots, style: styleForMode("light"), rescanMs: 100, tailIntervalMs: 40, stateDir };
	const first = await startSessionIndex(options);
	assert.equal(first.reused, false, "a first run gets a new address");
	await first.close();
	const second = await startSessionIndex(options);
	t.after(() => second.close());
	assert.equal(second.reused, true);
	assert.equal(await second.waitForViewer(300), false, "no tab yet");
	const token = new URL(second.url).searchParams.get("token");
	setTimeout(() => void fetch(new URL(`/api/sessions?token=${token}`, second.url)), 100); // the old index tab polling
	assert.equal(await second.waitForViewer(3_000), true);

	const dir = realpathSync(mkdtempSync(join(tmpdir(), "amp-file-")));
	const file = join(dir, "notes.md");
	writeFileSync(file, "# Notes\n");
	const watch = await startFileWatch({ filePath: file, style: styleForMode("light"), stateDir });
	t.after(() => watch.close());
	assert.equal(await watch.waitForViewer(200), false);
	const pageResponse = await fetch(watch.url);
	const cookie = pageResponse.headers.get("set-cookie").split(";")[0];
	await pageResponse.text();
	await (await fetch(new URL(`/__pi_markdown_preview_state__?client=${"a".repeat(32)}`, watch.url), { headers: { cookie } })).json();
	assert.equal(await watch.waitForViewer(3_000), true, "a recently polling page counts as a viewer");
});

test("a response finishing while a preview renders its history is not lost", { skip, timeout: 60_000 }, async t => {
	const f = fixture();
	// A slow pandoc widens the start-up window deterministically.
	const real = spawnSync("sh", ["-c", "command -v pandoc"], { encoding: "utf8" }).stdout.trim() || "pandoc";
	const slow = join(f.base, "slow-pandoc");
	writeFileSync(slow, `#!/bin/sh\nsleep 0.5\nexec "${process.env.PANDOC_PATH || real}" "$@"\n`, { mode: 0o755 });
	const previous = process.env.PANDOC_PATH;
	process.env.PANDOC_PATH = slow;
	t.after(() => { if (previous === undefined) delete process.env.PANDOC_PATH; else process.env.PANDOC_PATH = previous; });
	const file = join(f.claudeDir, "00000000-0000-4000-8000-00000000aaaa.jsonl");
	writeFileSync(file, claudeAnswer("a1", "First", iso(-60_000)) + claudeAnswer("a2", "Second", iso(-30_000)));
	const starting = startResponseWatch({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), ...fast });
	await new Promise(done => setTimeout(done, 250)); // monitor ready, history still rendering
	appendFileSync(file, claudeAnswer("a3", "Finished during start-up", iso(1_000)));
	const watch = await starting;
	t.after(() => watch.close());
	await waitFor(async () => /Finished during start-up/.test(await page(watch.url)), "response from the start-up window", 15_000);
});

for (const withTailResponse of [false, true]) {
	test(`deep backfill updates open merged previews in response order: ${withTailResponse ? "with a newer response in the tail" : "all responses outside the tail"}`, { skip, timeout: 60_000 }, async t => {
		const f = fixture();
		const directRendered = [], indexRendered = [];
		const options = { cwd: f.cwd, roots: f.roots, style: styleForMode("light"), ...fast };
		const direct = await startResponseWatch({ ...options, onRendered: r => directRendered.push(r.key) });
		t.after(() => direct.close());
		const index = await startSessionIndex({ ...options, onRendered: r => indexRendered.push(r.key) });
		t.after(() => index.close());
		const token = new URL(index.url).searchParams.get("token");
		const mergedUrl = (await fetch(new URL(`/open/all?token=${token}`, index.url), { redirect: "manual" })).headers.get("location");
		const urls = [direct.url, mergedUrl];
		for (const url of urls) assert.match(await page(url), /Waiting for the next completed response/);

		const file = join(f.claudeDir, "00000000-0000-4000-8000-00000000aaaa.jsonl");
		const toolOutput = line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(50_000) }] } }).repeat(50);
		// Both fresh answers precede 2.5 MB of tool output, outside the 2 MB tail.
		writeFileSync(file, claudeAnswer("old", "Historical answer", iso(-86_400_000))
			+ claudeAnswer("a1", "Recovered answer one", iso(1_000))
			+ claudeAnswer("a2", "Recovered answer two", iso(2_000)) + toolOutput
			+ (withTailResponse ? claudeAnswer("a3", "Newer tail answer", iso(3_000)) : ""));
		const expectedKeys = ["claude:a1", "claude:a2", ...(withTailResponse ? ["claude:a3"] : [])];
		const expectedText = ["Recovered answer one", "Recovered answer two", ...(withTailResponse ? ["Newer tail answer"] : [])];
		await waitFor(() => directRendered.length >= expectedKeys.length && indexRendered.length >= expectedKeys.length, "fresh answers recovered by deep backfill");
		assert.deepEqual(directRendered, expectedKeys);
		assert.deepEqual(indexRendered, expectedKeys, "the index's merged preview also receives the recovered answers");

		appendFileSync(file, claudeAnswer("a4", "Subsequent live answer", iso(4_000)));
		await waitFor(() => directRendered.includes("claude:a4") && indexRendered.includes("claude:a4"), "subsequent live answer");
		for (const url of urls) {
			const texts = [];
			for (const revision of await revisionsOf(url)) {
				const html = await atRevision(url, revision);
				assert.doesNotMatch(html, /Historical answer/);
				texts.push(html.match(/Recovered answer (?:one|two)|Newer tail answer|Subsequent live answer/)?.[0]);
			}
			assert.deepEqual(texts, [...expectedText, "Subsequent live answer"], "history stays ordered, without duplicates or old answers");
			assert.match(await page(url), /Subsequent live answer/);
		}
	});
}

test("--session with a single --agent works when the log's agent cannot be detected", { skip, timeout: 30_000 }, async t => {
	const f = fixture();
	const session = join(f.base, "exported.jsonl");
	writeFileSync(session, line({ type: "summary", summary: "exported" }) + claudeAnswer("a1", "From an exported log", iso(-1_000)));
	await assert.rejects(startResponseWatch({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), sessionPath: session, stateDir: null }), /pass --agent/);
	const watch = await startResponseWatch({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), sessionPath: session, agents: ["claude"], stateDir: null });
	t.after(() => watch.close());
	assert.match(await page(watch.url), /From an exported log/);
});

test("the index marks sessions whose preview is open in a tab", { skip, timeout: 30_000 }, async t => {
	const f = fixture();
	writeFileSync(join(f.claudeDir, "00000000-0000-4000-8000-00000000aaaa.jsonl"), claudeAnswer("a1", "Hello", iso(-1_000)));
	const index = await startSessionIndex({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), ...fast });
	t.after(() => index.close());
	const token = new URL(index.url).searchParams.get("token");
	const api = async () => (await fetch(new URL(`/api/sessions?token=${token}`, index.url))).json();
	const before = await api();
	assert.equal(before.sessions[0].open, false);
	assert.equal(before.mergedOpen, false);
	const url = (await fetch(new URL(`/open/${before.sessions[0].id}?token=${token}`, index.url), { redirect: "manual" })).headers.get("location");
	assert.equal((await api()).sessions[0].open, false, "a started preview with no tab is not open");
	const first = await fetch(url);
	const cookie = first.headers.get("set-cookie").split(";")[0];
	await first.text();
	const stateUrl = new URL(`/__pi_markdown_preview_state__?client=${"a".repeat(32)}`, url);
	await (await fetch(stateUrl, { headers: { cookie } })).json();
	await waitFor(async () => (await api()).sessions[0].open, "open once a tab polls");
	assert.equal((await api()).mergedOpen, false);
	stateUrl.searchParams.set("closed", "1");
	await fetch(stateUrl, { method: "POST", headers: { cookie } });
	await waitFor(async () => !(await api()).sessions[0].open, "not open after the tab releases its lease");
});
