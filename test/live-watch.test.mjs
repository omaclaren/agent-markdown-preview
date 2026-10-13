import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import { claudeProjectDirName, piSessionDirName } from "../dist/sessions.js";
import { createLiveLeases, createLiveSource, startResponseWatch, startSessionIndex, styleForMode } from "../dist/watch.js";

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
	const leases = createLiveLeases();
	const source = createLiveSource(monitor, { id: "session-1", path }, { leaseMs: 150, leases });
	assert.equal(listeners.size, 0, "no subscription or projection before a live page asks");
	assert.equal(leases.active, 0);
	assert.equal(await source.current(), "p1");
	assert.equal(listeners.size, 1);
	assert.equal(leases.active, 1);
	let snapshot = await source.snapshot("p1");
	assert.deepEqual(snapshot.events.map(e => e.id), ["p1:0", "c1:0"]);
	assert.equal(snapshot.loaded, true, "activity read at the start is Loaded, not Updated");
	// New records arrive through the subscription; one already read is ignored.
	for (const listener of listeners) {
		listener(JSON.parse(call("c1", "m1", "k1", "ls")), 100);
		listener(JSON.parse(result("r1", "k1", "file.txt")), 100);
	}
	snapshot = await source.snapshot("p1");
	assert.deepEqual(snapshot.events.map(e => e.id), ["p1:0", "c1:0", "r1:0"]);
	assert.equal(snapshot.loaded, false);
	await waitFor(() => listeners.size === 0, "lease release", 2000);
	assert.equal(leases.active, 0);
	// A later request starts a fresh lease from the file.
	assert.equal(await source.current(), "p1");
	assert.equal(listeners.size, 1);
	source.close();
	assert.equal(listeners.size, 0);
	assert.equal(leases.active, 0);
});

test("Live source: at most four sessions are followed at once", async t => {
	const f = fixture(t);
	const path = join(f.claudeDir, "00000000-0000-4000-8000-0000000lease.jsonl");
	writeFileSync(path, prompt("p", "Start"));
	let subscriptions = 0;
	const monitor = { onRecord() { subscriptions++; return () => { subscriptions--; }; } };
	const leases = createLiveLeases();
	// Pi's bounds probe asked for eight at once.
	const sources = Array.from({ length: 8 }, (_, i) => createLiveSource(monitor, { id: `s${i}`, path }, { leases }));
	t.after(() => { for (const source of sources) source.close(); });
	const outcomes = await Promise.allSettled(sources.map(source => source.current()));
	assert.deepEqual(outcomes.map(o => o.status === "fulfilled" ? o.value : o.reason.code), ["p", "p", "p", "p", "LIVE_BUSY", "LIVE_BUSY", "LIVE_BUSY", "LIVE_BUSY"]);
	assert.equal(subscriptions, 4);
	assert.equal(leases.active, 4);
	sources[0].close();
	assert.equal(await sources[4].current(), "p", "a released lease admits the next session");
	assert.equal(leases.active, 4);
});

test("Live source: a truncated or replaced session file is a new generation, never mixed into the old turn", async t => {
	const f = fixture(t);
	const path = join(f.claudeDir, "00000000-0000-4000-8000-0000000reset.jsonl");
	writeFileSync(path, prompt("p", "Old prompt") + call("c", "m1", "k", "ls"));
	const subscribers = new Set();
	const monitor = { onRecord(id, record, reset) { const s = { record, reset }; subscribers.add(s); return () => subscribers.delete(s); } };
	const leases = createLiveLeases();
	const source = createLiveSource(monitor, { id: "s", path }, { leases });
	t.after(() => source.close());
	const before = await source.snapshot("p");
	writeFileSync(path, prompt("replacement", "Prompt from the replacement file"));
	for (const s of subscribers) { s.reset(); s.record(JSON.parse(prompt("replacement", "Prompt from the replacement file")), 100); }
	assert.equal(subscribers.size, 0, "the old projection and its subscription are dropped");
	assert.equal(leases.active, 0);
	assert.equal(await source.current(), "replacement");
	assert.equal(await source.snapshot("p"), undefined, "the old turn is gone rather than continued");
	const after = await source.snapshot("replacement");
	assert.notEqual(after.generation, before.generation);
	assert.deepEqual(after.events.map(e => e.id), ["replacement:0"]);
});

test("Live source: records arriving faster than a backfill reads are read again from the file", async t => {
	const f = fixture(t);
	const path = join(f.claudeDir, "00000000-0000-4000-8000-0000000flood.jsonl");
	writeFileSync(path, prompt("p", "Start"));
	const subscribers = new Set();
	const monitor = { onRecord(id, record) { subscribers.add(record); return () => subscribers.delete(record); } };
	let reads = 0;
	const leases = createLiveLeases();
	const exclusive = leases.exclusive;
	leases.exclusive = read => {
		if (reads++ === 0) {
			// Before the first read finishes, more than the pending allowance arrives (and is in the file).
			const lines = Array.from({ length: 20 }, (_, i) => result(`r${i}`, `k${i}`, "x".repeat(64 * 1024)));
			appendFileSync(path, lines.join(""));
			for (const record of subscribers) for (const text of lines) record(JSON.parse(text), text.length);
		}
		return exclusive(read);
	};
	const source = createLiveSource(monitor, { id: "s", path }, { leases });
	t.after(() => source.close());
	assert.equal(await source.current(), "p");
	assert.equal(reads, 2, "the overflow is recovered by reading the file again");
	assert.equal((await source.snapshot("p")).events.length, 21, "nothing that arrived during the first read is lost");
});

test("Live source: a backfill that keeps overflowing is refused, never accepted with records missing", async t => {
	const f = fixture(t);
	const path = join(f.claudeDir, "00000000-0000-4000-8000-0000000flod2.jsonl");
	writeFileSync(path, prompt("p", "Start"));
	const subscribers = new Set();
	const monitor = { onRecord(id, record) { subscribers.add(record); return () => subscribers.delete(record); } };
	const leases = createLiveLeases();
	const exclusive = leases.exclusive;
	let flooding = true, burst = 0;
	leases.exclusive = read => {
		if (flooding) {
			// Pi's finalOverflow probe: two records just under the per-record limit, every attempt.
			const lines = Array.from({ length: 2 }, (_, i) => result(`b${burst}-${i}`, `k${burst}-${i}`, "x".repeat(600 * 1024)));
			burst++;
			appendFileSync(path, lines.join(""));
			for (const record of subscribers) for (const text of lines) record(JSON.parse(text), text.length);
		}
		return exclusive(read);
	};
	const source = createLiveSource(monitor, { id: "s", path }, { leases });
	t.after(() => source.close());
	await assert.rejects(source.current(), /faster than it can be read/);
	assert.equal(burst, 3);
	assert.equal(leases.active, 0, "the incomplete lease is released");
	assert.equal(subscribers.size, 0);
	flooding = false;
	assert.equal(await source.current(), "p", "a later request reads the file again");
	assert.deepEqual((await source.snapshot("p")).events.filter(e => e.id.startsWith("b2-")).length, 2, "the last burst is not lost");
});

test("Live source: nothing read for a backfill is kept once its lease ends", async t => {
	v8.setFlagsFromString("--expose-gc");
	const gc = vm.runInNewContext("gc");
	const settle = async () => { for (let i = 0; i < 3; i++) { await new Promise(done => setImmediate(done)); gc(); } };
	const f = fixture(t);
	const path = join(f.claudeDir, "00000000-0000-4000-8000-000000retain.jsonl");
	// Pi's lease-retention probe: a backfill of about 7 MB.
	writeFileSync(path, prompt("p", "Start") + Array.from({ length: 700 }, (_, i) => result(`r${i}`, `k${i}`, "x".repeat(10_000))).join(""));
	const leases = createLiveLeases();
	const monitor = { onRecord() { return () => {}; } };
	await settle();
	const before = process.memoryUsage().heapUsed;
	const source = createLiveSource(monitor, { id: "s", path }, { leaseMs: 100, leases });
	assert.equal(await source.current(), "p");
	await waitFor(() => leases.active === 0, "lease expiry", 2000);
	await settle();
	const retained = process.memoryUsage().heapUsed - before;
	assert.ok(retained < 2 * 1024 * 1024, `retained ${(retained / 1048576).toFixed(2)} MiB after the lease ended`);
	source.close();
});

test("Live source: only a backfill that starts partway shows activity before its first prompt", async t => {
	const f = fixture(t);
	const linked = (text, parentUuid) => line({ ...JSON.parse(text), parentUuid });
	const filler = prompt("old", "x".repeat(9 * 1024 * 1024));
	const tail = linked(call("c", "m1", "k", "ls"), "earlier") + linked(answer("f", "m2", "Done"), "c") + linked(prompt("next", "Next prompt"), "f");
	const partial = join(f.claudeDir, "00000000-0000-4000-8000-000000partial.jsonl");
	writeFileSync(partial, filler + tail);
	const monitor = { onRecord() { return () => {}; } };
	const leases = createLiveLeases();
	const cut = createLiveSource(monitor, { id: "a", path: partial }, { leases });
	t.after(() => cut.close());
	assert.deepEqual((await cut.snapshot("c")).events.map(e => e.id), ["c:0", "f:0"], "the backfill began mid-turn");
	assert.equal((await cut.snapshot("c")).status, "completed");
	assert.equal(await cut.current(), "next");
	assert.match((await cut.snapshot("c")).notices.join(" "), /prompt is not in the retained recorded activity/);
	const whole = join(f.claudeDir, "00000000-0000-4000-8000-00000000whole.jsonl");
	writeFileSync(whole, tail);
	const full = createLiveSource(monitor, { id: "b", path: whole }, { leases });
	t.after(() => full.close());
	assert.equal(await full.snapshot("c"), undefined, "an unlinked record in a complete read is not a turn");
	assert.equal(await full.current(), "next");
});

test("Live source: a Codex rollout backfills then follows; a line delivered twice is ignored by its ordinal", async t => {
	const f = fixture(t);
	const dayDir = join(f.roots.codex, "2026", "10", "14");
	mkdirSync(dayDir, { recursive: true });
	const path = join(dayDir, "rollout-2026-10-14T00-00-00-00000000-0000-4000-8000-00000000c0de.jsonl");
	let ordinal = 0;
	const record = (type, payload) => line({ timestamp: iso(0), ordinal: ordinal++, type, payload });
	const header = record("session_meta", { id: "thread", cwd: f.cwd }) + record("event_msg", { type: "task_started", turn_id: "t1" });
	const prompt = record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Run it" }] });
	writeFileSync(path, header + prompt);
	const listeners = new Set();
	const monitor = { onRecord(id, listener) { listeners.add(listener); return () => listeners.delete(listener); } };
	const source = createLiveSource(monitor, { id: "codex-1", path, agent: "codex" }, { leaseMs: 5_000, leases: createLiveLeases() });
	t.after(() => source.close());
	assert.equal(await source.current(), "turn-t1");
	const call = record("response_item", { type: "custom_tool_call", name: "exec", call_id: "k1", status: "completed", input: "ls" });
	for (const listener of listeners) { listener(JSON.parse(prompt), 100); listener(JSON.parse(call), 100); listener(JSON.parse(call), 100); }
	const snapshot = await source.snapshot("turn-t1");
	assert.deepEqual(snapshot.events.map(e => [e.id, e.kind]), [["o2:0", "prompt"], ["o3:0", "tool"]]);
	assert.equal(snapshot.events[1].pending, true);
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
	const entry = root.match(/data-live-state="([^"]+)"/)?.[1].replaceAll("&amp;", "&").replace(/&format=json$/, "");
	assert.ok(entry, "a pinned Claude session offers Follow activity with live Working");
	const origin = new URL(watch.url).origin;
	const get = path => fetch(new URL(path, origin), { headers: { cookie }, redirect: "manual" });
	const redirect = await get(entry);
	assert.equal(redirect.status, 302);
	const livePage = redirect.headers.get("location");
	assert.match(livePage, /^\/__pi_markdown_preview_live__\/p\?/);
	const html = await (await get(livePage)).text();
	assert.match(html, /<h1>Working · live<\/h1>/);
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

test("--live: truncating or replacing the session file never mixes the new file into the old turn", { skip, timeout: 60_000 }, async t => {
	const f = fixture(t);
	const session = join(f.claudeDir, "00000000-0000-4000-8000-0000000live4.jsonl");
	// Pi's truncation probe: the original is larger than its replacement.
	writeFileSync(session, prompt("old", "Old prompt") + answer("oldf", "m0", "Old final") + prompt("p", "Current prompt") + call("call", "m1", "k", "ls") + line({ type: "assistant", uuid: "progress", timestamp: iso(0), message: { role: "assistant", id: "m2", content: [{ type: "text", text: "Recorded progress ".repeat(100) }] } }));
	const watch = await startResponseWatch({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), sessionPath: session, agents: ["claude"], turnDetails: true, live: true, ...fast });
	t.after(() => watch.close());
	const first = await fetch(watch.url);
	const cookie = first.headers.get("set-cookie").split(";")[0];
	const state = new URL((await first.text()).match(/data-live-state="([^"]+)"/)[1].replaceAll("&amp;", "&"), watch.url);
	const get = async url => { const r = await fetch(url, { headers: { cookie } }); return { status: r.status, body: await r.json() }; };
	const before = await get(state);
	assert.equal(before.body.anchor, "p");
	const oldUpdates = new URL(before.body.liveHref.replace("?", "/updates?") + "&cursor=", watch.url);
	assert.equal((await get(oldUpdates)).status, 200);
	writeFileSync(session, prompt("replacement", "Prompt from the replacement file"));
	await waitFor(async () => (await get(state)).body.anchor === "replacement", "the truncated file's own turn");
	assert.equal((await get(oldUpdates)).status, 404, "the old turn is gone, not continued with the new file's records");
	// Replacing the file (another inode at the same path, here larger) is a reset too.
	const next = join(f.base, "next.jsonl");
	writeFileSync(next, prompt("other", "Prompt from another file " + "x".repeat(2000)) + call("oc", "m3", "k3", "pwd"));
	renameSync(next, session);
	await waitFor(async () => (await get(state)).body.anchor === "other", "the replaced file's own turn");
	const replaced = await get(new URL((await get(state)).body.liveHref.replace("?", "/updates?") + "&cursor=", watch.url));
	assert.deepEqual(replaced.body.ids, ["other:0", "oc:0"]);
});

test("--live: a pinned Pi session follows its current turn through the server", { skip, timeout: 60_000 }, async t => {
	const f = fixture(t);
	const piDir = join(f.roots.pi, piSessionDirName(f.cwd));
	mkdirSync(piDir, { recursive: true });
	const session = join(piDir, "2026-10-13T00-00-00-000Z_00000000-0000-4000-8000-00000000pi01.jsonl");
	const entry = (id, parentId, message) => line({ type: "message", id, parentId, timestamp: iso(0), message: { timestamp: Date.now(), ...message } });
	const text = value => [{ type: "text", text: value }];
	writeFileSync(session, line({ type: "session", version: 3, id: "s1", timestamp: iso(0), cwd: f.cwd })
		+ entry("u0", null, { role: "user", content: text("Earlier") })
		+ entry("f0", "u0", { role: "assistant", content: text("Earlier answer"), stopReason: "stop" })
		+ entry("u1", "f0", { role: "user", content: text("Run the checks") }));
	const watch = await startResponseWatch({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), sessionPath: session, agents: ["pi"], turnDetails: true, live: true, ...fast });
	t.after(() => watch.close());
	const first = await fetch(watch.url);
	const cookie = first.headers.get("set-cookie").split(";")[0];
	const live = (await first.text()).match(/data-live-state="([^"]+)"/)?.[1].replaceAll("&amp;", "&").replace(/&format=json$/, "");
	assert.ok(live, "a pinned Pi session offers Follow activity with live Working");
	const get = path => fetch(new URL(path, new URL(watch.url).origin), { headers: { cookie }, redirect: "manual" });
	const redirect = await get(live);
	assert.equal(redirect.status, 302);
	const page = redirect.headers.get("location");
	assert.match(page, /^\/__pi_markdown_preview_live__\/u1\?/);
	assert.match(await (await get(page)).text(), /Run the checks/);
	const updates = cursor => get(`${page.replace("?", "/updates?")}&cursor=${encodeURIComponent(cursor)}`).then(r => r.json());
	const start = await updates("");
	appendFileSync(session, entry("a1", "u1", { role: "assistant", content: [{ type: "toolCall", id: "k1", name: "bash", arguments: { command: "npm test" } }], stopReason: "toolUse" }));
	const grown = await waitFor(async () => { const u = await updates(start.cursor); return u.upserts?.length ? u : null; }, "the new call");
	assert.deepEqual(grown.upserts.map(u => u.id), ["a1:0"]);
	assert.match(grown.upserts[0].html, /No result recorded yet/);
	appendFileSync(session, entry("r1", "a1", { role: "toolResult", toolCallId: "k1", toolName: "bash", content: text("ok"), isError: false })
		+ entry("f1", "r1", { role: "assistant", content: text("All green."), stopReason: "stop" }));
	const done = await waitFor(async () => { const u = await updates(grown.cursor); return /Open its response/.test(u.statusHtml ?? "") ? u : null; }, "completion linked to the retained response", 15_000);
	assert.match(done.statusHtml, /Turn completed\. <a href="\/\?revision=\d+&amp;identity=/);
});

test("--live: a pinned Codex session follows its current task through the server", { skip, timeout: 60_000 }, async t => {
	const f = fixture(t);
	const dayDir = join(f.roots.codex, "2026", "10", "14");
	mkdirSync(dayDir, { recursive: true });
	const session = join(dayDir, "rollout-2026-10-14T00-00-00-00000000-0000-4000-8000-00000000c0d1.jsonl");
	let ordinal = 0;
	const record = (type, payload) => line({ timestamp: iso(0), ordinal: ordinal++, type, payload });
	const message = (role, text, extra = {}) => record("response_item", { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }], ...extra });
	const event = payload => record("event_msg", payload);
	writeFileSync(session, record("session_meta", { id: "thread", cwd: f.cwd, history_mode: "paginated" })
		+ event({ type: "task_started", turn_id: "t0" }) + message("user", "Earlier") + message("assistant", "Earlier answer", { phase: "final_answer" })
		+ event({ type: "task_complete", turn_id: "t0", last_agent_message: "Earlier answer" })
		+ event({ type: "task_started", turn_id: "t1" }) + message("developer", "SECRET DEVELOPER") + message("user", "Run the checks")
		+ event({ type: "item_completed", thread_id: "thread", turn_id: "t1", item: { type: "UserMessage", content: [{ type: "text", text: "Run the checks" }] } }));
	const watch = await startResponseWatch({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), sessionPath: session, agents: ["codex"], turnDetails: true, live: true, ...fast });
	t.after(() => watch.close());
	const first = await fetch(watch.url);
	const cookie = first.headers.get("set-cookie").split(";")[0];
	const live = (await first.text()).match(/data-live-state="([^"]+)"/)?.[1].replaceAll("&amp;", "&").replace(/&format=json$/, "");
	assert.ok(live, "a pinned Codex session offers Follow activity with live Working");
	const get = path => fetch(new URL(path, new URL(watch.url).origin), { headers: { cookie }, redirect: "manual" });
	const redirect = await get(live);
	assert.equal(redirect.status, 302);
	const page = redirect.headers.get("location");
	assert.match(page, /^\/__pi_markdown_preview_live__\/turn-t1\?/, "the running task is the current turn");
	const text = await (await get(page)).text();
	assert.match(text, /Run the checks/);
	assert.equal(text.match(/Run the checks/g).length, 1, "the prompt's event copy is not shown again");
	assert.doesNotMatch(text, /SECRET/);
	const updates = cursor => get(`${page.replace("?", "/updates?")}&cursor=${encodeURIComponent(cursor)}`).then(r => r.json());
	const start = await updates("");
	const callOrdinal = ordinal;
	appendFileSync(session, record("response_item", { type: "custom_tool_call", name: "exec", call_id: "k1", status: "completed", input: "npm test" }));
	const grown = await waitFor(async () => { const u = await updates(start.cursor); return u.upserts?.length ? u : null; }, "the new call");
	assert.deepEqual(grown.upserts.map(u => u.id), [`o${callOrdinal}:0`]);
	assert.match(grown.upserts[0].html, /No result recorded yet/);
	appendFileSync(session, record("response_item", { type: "custom_tool_call_output", call_id: "k1", output: [{ type: "input_text", text: "ok" }] })
		+ message("assistant", "All green.", { phase: "final_answer" })
		+ event({ type: "task_complete", turn_id: "t1", last_agent_message: "All green." }));
	const done = await waitFor(async () => { const u = await updates(grown.cursor); return /Open its response/.test(u.statusHtml ?? "") ? u : null; }, "completion linked to the retained response", 15_000);
	assert.match(done.statusHtml, /Turn completed\. <a href="\/\?revision=\d+&amp;identity=/);
	// A compaction task records no final answer: it says so and offers the latest Preview.
	appendFileSync(session, event({ type: "task_started", turn_id: "t2" }) + record("compacted", { message: "" })
		+ event({ type: "task_complete", turn_id: "t2", last_agent_message: null }));
	const maintenance = await waitFor(async () => { const u = await (await get(`${live}&format=json`)).json(); return u.anchor === "turn-t2" && u.status === "completed" ? u : null; }, "the compaction task");
	const after = await (await get(`${maintenance.liveHref.replace("?", "/updates?")}&cursor=`)).json();
	assert.match(after.statusHtml, /Turn completed without a final answer\. <a href="\/\?revision=\d+&amp;identity=/);
	assert.equal(after.completedHref, undefined);
});

test("--live is offered only where it applies: not for merged views, not without the flag", { skip, timeout: 60_000 }, async t => {
	const f = fixture(t);
	writeFileSync(join(f.claudeDir, "00000000-0000-4000-8000-0000000live3.jsonl"), prompt("p", "Hello") + answer("a", "m1", "Hi"));
	const merged = await startResponseWatch({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), turnDetails: true, live: true, ...fast });
	t.after(() => merged.close());
	assert.doesNotMatch(await (await fetch(merged.url)).text(), /<button data-watch-control="follow-activity"/, "merged views have no single current turn");
	const plain = await startSessionIndex({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), turnDetails: true, ...fast });
	t.after(() => plain.close());
	const index = await fetch(plain.url);
	const cookie = index.headers.get("set-cookie")?.split(";")[0] ?? "";
	const sessions = await (await fetch(new URL("/api/sessions?token=" + new URL(plain.url).searchParams.get("token"), plain.url), { headers: { cookie } })).json();
	const opened = await fetch(new URL(`/open/${sessions.sessions[0].id}?token=${new URL(plain.url).searchParams.get("token")}`, plain.url), { redirect: "manual" });
	const sessionUrl = opened.headers.get("location");
	assert.ok(sessionUrl);
	assert.doesNotMatch(await (await fetch(sessionUrl)).text(), /<button data-watch-control="follow-activity"/, "without --live there is no live entry");
	// With --live, a Claude session opened from the index offers it, on fresh credentials.
	const withLive = await startSessionIndex({ cwd: f.cwd, roots: f.roots, style: styleForMode("light"), turnDetails: true, live: true, ...fast });
	t.after(() => withLive.close());
	const liveToken = new URL(withLive.url).searchParams.get("token");
	const liveSessions = await (await fetch(new URL("/api/sessions?token=" + liveToken, withLive.url))).json();
	const liveOpened = await fetch(new URL(`/open/${liveSessions.sessions[0].id}?token=${liveToken}`, withLive.url), { redirect: "manual" });
	assert.match(await (await fetch(liveOpened.headers.get("location"))).text(), /<button data-watch-control="follow-activity"/);
});
