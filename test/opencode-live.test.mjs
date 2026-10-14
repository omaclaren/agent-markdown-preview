import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOpenCodeStore, openCodeSessionPath } from "../dist/opencode.js";
import { createLiveLeases, createOpenCodeLiveSource, startResponseWatch, styleForMode } from "../dist/watch.js";

const sqliteModule = process.versions.bun ? "bun:sqlite" : "node:sqlite";
const { DatabaseSync: NodeDatabase, Database: BunDatabase } = await import(sqliteModule);
const Database = NodeDatabase ?? BunDatabase;
const pandoc = !spawnSync(process.env.PANDOC_PATH || "pandoc", ["--version"], { stdio: "ignore" }).error;
const fast = { tailIntervalMs: 25, rescanMs: 60, stateDir: null };

// OpenCode 2.0.16-2.0.18 v2 tables, as far as Live reads them (see opencode-probe-results.md).
function fixture(t, { counter = true } = {}) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "amp-opencode-live-"))), cwd = join(base, "project"), path = join(base, "opencode.db");
	mkdirSync(cwd);
	const db = new Database(path);
	db.exec(`PRAGMA journal_mode=WAL;
		CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, time_suspended INTEGER, fork_session_id TEXT, revert TEXT);
		CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
		CREATE UNIQUE INDEX session_message_seq ON session_message(session_id,seq); CREATE INDEX session_message_type_seq ON session_message(session_id,type,seq);
		${counter ? "CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER, owner_id TEXT);" : ""}`);
	const stores = [];
	t.after(() => { for (const store of stores) store.close(); db.close(); rmSync(base, { recursive: true, force: true }); });
	let events = 0;
	const bump = id => { if (counter) db.prepare("INSERT INTO event_sequence VALUES (?,?,NULL) ON CONFLICT(aggregate_id) DO UPDATE SET seq=excluded.seq").run(id, ++events); };
	const session = id => {
		const now = Date.now();
		db.prepare("INSERT INTO session_v2 VALUES (?,?,?,NULL,?,?,NULL,NULL,NULL,NULL)").run(id, cwd, `Title ${id}`, now - 100_000, now);
		bump(id);
	};
	const row = (session, id, seq, type, data = {}) => {
		const time = Date.now();
		db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)").run(id, session, type, seq, time, time, JSON.stringify(data));
		bump(session);
	};
	// In place, as OpenCode does: same id and seq, new data.
	const update = (session, id, data) => { db.prepare("UPDATE session_message SET data=?, time_updated=? WHERE id=?").run(JSON.stringify(data), Date.now(), id); bump(session); };
	const remove = (session, ...ids) => { for (const id of ids) db.prepare("DELETE FROM session_message WHERE id=?").run(id); bump(session); };
	const answer = (text, extra = {}) => ({ finish: "stop", time: { created: Date.now() - 10, completed: Date.now() }, content: [{ type: "text", text }], ...extra });
	const step = (content, extra = {}) => ({ time: { created: Date.now() }, content, ...extra });
	const tool = (id, status, extra = {}) => ({ type: "tool", id, tool: "bash", state: { status, input: { command: `run ${id}` }, ...extra } });
	const source = (id, options = {}) => createOpenCodeLiveSource({ path: openCodeSessionPath(path, id) }, {
		leases: createLiveLeases(), leaseMs: 5_000, openStore: database => { const store = createOpenCodeStore(database); stores.push(store); return store; }, ...options,
	});
	return { base, cwd, path, db, session, row, update, remove, answer, step, tool, source, roots: { opencode: path } };
}

const view = snapshot => snapshot.events.map(e => `${e.id} ${e.kind}${e.pending ? " pending" : ""}`);
const changedAt = (snapshot, sequence) => snapshot.events.filter(e => e.changed === sequence).map(e => e.id);

test("OpenCode Live: a running turn's recorded parts; in-place updates change only their own cards", async t => {
	const f = fixture(t);
	f.session("ses_live");
	f.row("ses_live", "u0", 1, "user", { text: "Earlier" });
	f.row("ses_live", "a0", 2, "assistant", f.answer("Earlier answer"));
	f.row("ses_live", "i0", 3, "idle", { outcome: "succeeded" });
	f.row("ses_live", "u1", 4, "user", { text: "Run the checks" });
	f.row("ses_live", "a1", 5, "assistant", f.step([{ type: "text", text: "Checking." }, f.tool("call_1", "running")]));
	const live = f.source("ses_live");
	t.after(() => live.close());

	assert.equal(await live.current(), "u1", "the latest authored prompt starts the current turn");
	const first = await live.snapshot("u1");
	assert.equal(first.status, "running");
	assert.equal(first.sourceAgent, "opencode");
	assert.equal(first.loaded, true, "activity read when the page first asks is Loaded");
	assert.deepEqual(view(first), ["u1.0 prompt", "a1.0.0 progress", "a1.1.0 tool pending"]);
	assert.equal(first.events[0].text, "Run the checks");
	assert.equal(first.events.some(e => e.text.includes("Earlier")), false, "the previous turn is not part of this one");

	const again = await live.snapshot("u1");
	assert.equal(again.sequence, first.sequence, "an unchanged revision is not re-read as a change");

	// The tool completes in place, under the same row id and seq.
	f.update("ses_live", "a1", f.step([{ type: "text", text: "Checking." }, f.tool("call_1", "completed", { content: [{ type: "text", text: "all passed" }] })]));
	const second = await live.snapshot("u1");
	assert.equal(second.generation, first.generation);
	assert.equal(second.sequence, first.sequence + 1);
	assert.equal(second.loaded, false, "later activity is Updated");
	assert.deepEqual(view(second), ["u1.0 prompt", "a1.0.0 progress", "a1.1.0 tool", "a1.1.1 result"]);
	assert.deepEqual(changedAt(second, second.sequence), ["a1.1.0", "a1.1.1"], "only the call and its new result changed");
	assert.match(second.events[3].text, /all passed/);

	// A text block appears whole when OpenCode commits it.
	f.row("ses_live", "a2", 6, "assistant", f.step([{ type: "text", text: "" }]));
	const empty = await live.snapshot("u1");
	assert.deepEqual(view(empty).slice(4), [], "an uncommitted, empty text block shows nothing");
	f.update("ses_live", "a2", f.answer("All green."));
	f.row("ses_live", "i1", 7, "idle", { outcome: "succeeded" });
	const done = await live.snapshot("u1");
	assert.equal(done.status, "completed");
	assert.equal(done.finalKey, "opencode:a2");
	assert.deepEqual(changedAt(done, done.sequence), ["a2.0.0"]);

	// The same answer the history reader keeps for this turn.
	const store = createOpenCodeStore(f.path);
	t.after(() => store.close());
	const history = (await store.snapshot(openCodeSessionPath(f.path, "ses_live"))).history;
	assert.equal(history.at(-1).key, done.finalKey);
});

test("OpenCode Live: endings come only from the turn's idle marker", async t => {
	const f = fixture(t);
	const cases = [
		["ses_ok", "succeeded", [["_a", "assistant", f.answer("Answer")]], "completed", "opencode:ses_ok_a"],
		["ses_esc", "interrupted", [["_a", "assistant", f.step([f.tool("k", "error", { error: { message: "interrupted" } })], { finish: "error", error: { message: "aborted" } })]], "interrupted", undefined],
		["ses_bad", "failed", [], "error", undefined],
		// Tools only, then a successful idle: completed without a final answer.
		["ses_quiet", "succeeded", [["_a", "assistant", f.step([f.tool("k", "completed", { content: [{ type: "text", text: "done" }] })], { finish: "tool-calls" })]], "completed", undefined],
	];
	for (const [id, outcome, rows, status, finalKey] of cases) {
		f.session(id);
		f.row(id, `${id}_u`, 1, "user", { text: "Go" });
		rows.forEach(([suffix, type, data], i) => f.row(id, `${id}${suffix}`, 2 + i, type, data));
		const live = f.source(id);
		t.after(() => live.close());
		assert.equal((await live.snapshot(`${id}_u`)).status, "running", `${id}: no idle marker yet`);
		f.row(id, `${id}_i`, 2 + rows.length, "idle", { outcome });
		const ended = await live.snapshot(`${id}_u`);
		assert.equal(ended.status, status, id);
		assert.equal(ended.finalKey, finalKey, id);
	}
});

test("OpenCode Live: steering stays in its turn; maintenance is not a turn; a new prompt is a newer turn", async t => {
	const f = fixture(t);
	f.session("ses_turns");
	f.row("ses_turns", "u1", 1, "user", { text: "Start" });
	f.row("ses_turns", "a1", 2, "assistant", f.step([f.tool("k1", "completed", { content: [{ type: "text", text: "one" }] })], { finish: "tool-calls" }));
	f.row("ses_turns", "u2", 3, "user", { text: "Also check the docs" });
	const live = f.source("ses_turns");
	t.after(() => live.close());
	assert.equal(await live.current(), "u1", "a prompt sent while the turn runs belongs to it");
	f.row("ses_turns", "a2", 4, "assistant", f.answer("Both done."));
	f.row("ses_turns", "i1", 5, "idle", { outcome: "succeeded" });
	const turn = await live.snapshot("u1");
	assert.deepEqual(turn.events.filter(e => e.kind === "prompt").map(e => e.text), ["Start", "Also check the docs"]);
	assert.equal(turn.finalKey, "opencode:a2");

	// A compaction and its idle marker, with no prompt.
	f.row("ses_turns", "c1", 6, "compaction", { status: "completed", summary: "Summary" });
	f.row("ses_turns", "i2", 7, "idle", { outcome: "succeeded" });
	assert.equal(await live.current(), "u1", "maintenance does not start a turn");
	assert.equal((await live.snapshot("u1")).status, "completed", "nor does its idle marker change the turn");

	f.row("ses_turns", "u3", 8, "user", { text: "Next" });
	assert.equal(await live.current(), "u3");
	const older = await live.snapshot("u1");
	assert.equal(older.newerAnchor, "u3");
	assert.equal((await live.snapshot("u3")).status, "running");
	assert.equal(await live.snapshot("a2"), undefined, "only an authored prompt anchors a turn");
	assert.equal(await live.snapshot("u2"), undefined, "a steering prompt does not start a turn");
});

test("OpenCode Live: a revert deletes rows; vanished cards start a new generation", async t => {
	const f = fixture(t);
	f.session("ses_revert");
	f.row("ses_revert", "u1", 1, "user", { text: "First" });
	f.row("ses_revert", "a1", 2, "assistant", f.answer("First answer"));
	f.row("ses_revert", "i1", 3, "idle", { outcome: "succeeded" });
	f.row("ses_revert", "u2", 4, "user", { text: "Second" });
	f.row("ses_revert", "a2", 5, "assistant", f.step([{ type: "text", text: "Working on it." }, f.tool("k", "running")]));
	const live = f.source("ses_revert");
	t.after(() => live.close());
	const before = await live.snapshot("u2");
	assert.equal(before.events.length, 3);

	// Within the turn: a deleted row's cards are gone, so the page must resync.
	f.remove("ses_revert", "a2");
	const shrunk = await live.snapshot("u2");
	assert.notEqual(shrunk.generation, before.generation);
	assert.equal(shrunk.loaded, false);
	assert.deepEqual(view(shrunk), ["u2.0 prompt"]);

	// The whole turn reverted: its anchor no longer identifies a turn.
	f.remove("ses_revert", "u2");
	assert.equal(await live.snapshot("u2"), undefined);
	assert.equal(await live.current(), "u1");
});

test("OpenCode Live: without the event counter, a coarser fingerprint still sees in-place updates", async t => {
	const f = fixture(t, { counter: false });
	f.session("ses_plain");
	f.row("ses_plain", "u", 1, "user", { text: "Go" });
	f.row("ses_plain", "a", 2, "assistant", f.step([f.tool("k", "running")]));
	const live = f.source("ses_plain");
	t.after(() => live.close());
	assert.equal((await live.snapshot("u")).events.at(-1).pending, true);
	f.update("ses_plain", "a", f.step([f.tool("k", "completed", { content: [{ type: "text", text: "finished" }] })]));
	const updated = await live.snapshot("u");
	assert.equal(updated.events.at(-1).kind, "result");
});

test("OpenCode Live: a missing session has no live turn; leases are bounded", async t => {
	const f = fixture(t);
	f.session("ses_one");
	f.row("ses_one", "u", 1, "user", { text: "Go" });
	const missing = f.source("ses_absent");
	t.after(() => missing.close());
	assert.equal(await missing.current(), undefined);
	const leases = createLiveLeases(1);
	const a = f.source("ses_one", { leases, leaseMs: 100 }), b = f.source("ses_one", { leases, leaseMs: 100 });
	t.after(() => { a.close(); b.close(); });
	assert.equal(await a.current(), "u");
	await assert.rejects(b.current(), error => error.code === "LIVE_BUSY");
	await new Promise(resolve => setTimeout(resolve, 200));
	assert.equal(leases.active, 0, "an unrenewed lease is released");
	assert.equal(await b.current(), "u");
});

test("--live: a pinned OpenCode session offers Follow activity and live Working through the server", { skip: !pandoc, timeout: 60_000 }, async t => {
	const f = fixture(t);
	f.session("ses_view");
	f.row("ses_view", "u0", 1, "user", { text: "Earlier" });
	f.row("ses_view", "a0", 2, "assistant", f.answer("Earlier answer"));
	f.row("ses_view", "i0", 3, "idle", { outcome: "succeeded" });
	f.row("ses_view", "u1", 4, "user", { text: "Run the checks" });
	f.row("ses_view", "a1", 5, "assistant", f.step([f.tool("k1", "running")]));
	const watch = await startResponseWatch({ cwd: f.cwd, roots: f.roots, agents: ["opencode"], style: styleForMode("light"), sessionPath: "ses_view", turnDetails: true, live: true, ...fast });
	t.after(() => watch.close());
	const first = await fetch(watch.url);
	const cookie = first.headers.get("set-cookie").split(";")[0];
	const root = await first.text();
	assert.match(root, /<button data-watch-control="follow-activity"/);
	const origin = new URL(watch.url).origin;
	const get = path => fetch(new URL(path, origin), { headers: { cookie }, redirect: "manual" });
	const state = await (await get(root.match(/data-live-state="([^"]+)"/)[1].replaceAll("&amp;", "&"))).json();
	assert.equal(state.anchor, "u1");
	assert.equal(state.status, "running");
	const html = await (await get(state.liveHref)).text();
	assert.match(html, /<h1>Working · live<\/h1>/);
	assert.match(html, /Run the checks/);
	assert.match(html, /No result recorded yet/);
	const cursor = html.match(/data-live-cursor="([^"]+)"/)[1];
	f.update("ses_view", "a1", f.step([f.tool("k1", "completed", { content: [{ type: "text", text: "ok" }] })]));
	const updates = await (await get(`${state.liveHref.replace("?", "/updates?")}&cursor=${encodeURIComponent(cursor)}`)).json();
	assert.equal(updates.resync, false);
	assert.deepEqual(updates.upserts.map(u => u.id), ["a1.0.0", "a1.0.1"]);
});
