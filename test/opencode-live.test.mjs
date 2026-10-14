import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
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

test("OpenCode Live: a revert deletes rows; their cards leave the list and a reverted turn is gone", async t => {
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

	// Within the turn: a deleted row's cards leave the list the page receives.
	f.remove("ses_revert", "a2");
	const shrunk = await live.snapshot("u2");
	assert.equal(shrunk.generation, before.generation);
	assert.equal(shrunk.sequence, before.sequence + 1);
	assert.equal(shrunk.loaded, false);
	assert.deepEqual(view(shrunk), ["u2.0 prompt"]);
	// A card that comes back is sent again.
	f.row("ses_revert", "a2", 5, "assistant", f.step([{ type: "text", text: "Working on it." }]));
	const back = await live.snapshot("u2");
	assert.deepEqual(changedAt(back, back.sequence), ["a2.0.0"]);

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

test("OpenCode Live: the answer link follows the history reader's bounds; an output-limit stop is incomplete", async t => {
	const f = fixture(t);
	// 2 MiB + 1 byte of answer text: history leaves it out, so Live must not wait for it.
	f.session("ses_big");
	f.row("ses_big", "big_u", 1, "user", { text: "Write a lot" });
	f.row("ses_big", "big_a", 2, "assistant", f.answer("x".repeat(2 * 1024 * 1024 + 1)));
	f.row("ses_big", "big_i", 3, "idle", { outcome: "succeeded" });
	const big = f.source("ses_big");
	t.after(() => big.close());
	const snapshot = await big.snapshot("big_u");
	assert.equal(snapshot.status, "completed");
	assert.equal(snapshot.finalKey, undefined);
	assert.equal(snapshot.answerUnavailable, true);
	const store = createOpenCodeStore(f.path);
	t.after(() => store.close());
	assert.equal((await store.snapshot(openCodeSessionPath(f.path, "ses_big"))).history.length, 0, "history keeps no answer for that turn either");

	f.session("ses_len");
	f.row("ses_len", "len_u", 1, "user", { text: "Go on" });
	f.row("ses_len", "len_a", 2, "assistant", f.answer("Partial", { finish: "length" }));
	f.row("ses_len", "len_i", 3, "idle", { outcome: "succeeded" });
	const len = f.source("ses_len");
	t.after(() => len.close());
	const cut = await len.snapshot("len_u");
	assert.equal(cut.status, "incomplete", "a successful run whose answer hit the output limit is not an ordinary completion");
	assert.equal(cut.finalKey, "opencode:len_a", "the partial answer history keeps can still be opened");
});

test("OpenCode Live: a replaced database starts again; without the counter, data_version catches equal-length updates", async t => {
	const f = fixture(t);
	f.session("ses_swap");
	f.row("ses_swap", "swap_u", 1, "user", { text: "Original prompt" });
	const live = f.source("ses_swap");
	t.after(() => live.close());
	const before = await live.snapshot("swap_u");
	// Another database with the same ids, counter and metadata, moved over the path.
	const other = `${f.path}.next`;
	const copy = new Database(other);
	copy.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, time_suspended INTEGER, fork_session_id TEXT, revert TEXT);
		CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
		CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER, owner_id TEXT);`);
	for (const table of ["session_v2", "session_message", "event_sequence"]) for (const row of f.db.prepare(`SELECT * FROM ${table}`).all()) copy.prepare(`INSERT INTO ${table} VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
	copy.prepare("UPDATE session_message SET data=? WHERE id='swap_u'").run(JSON.stringify({ text: "Replaced prompt" }));
	copy.close();
	// The old database's WAL would otherwise be read as the new file's (SQLite matches it by name).
	f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	renameSync(other, f.path);
	const after = await live.snapshot("swap_u");
	assert.notEqual(after.generation, before.generation, "a new generation: the page resyncs");
	assert.equal(after.events[0].text, "Replaced prompt");

	const g = fixture(t, { counter: false });
	g.session("ses_flat");
	g.row("ses_flat", "flat_u", 1, "user", { text: "Go" });
	g.row("ses_flat", "flat_a", 2, "assistant", g.step([{ type: "text", text: "aaaa" }]));
	const flat = g.source("ses_flat");
	t.after(() => flat.close());
	await flat.snapshot("flat_u");
	// Same length, same timestamp: no row fingerprint changes.
	const stamp = g.db.prepare("SELECT time_updated FROM session_message WHERE id='flat_a'").get().time_updated;
	g.db.prepare("UPDATE session_message SET data=?, time_updated=? WHERE id='flat_a'").run(JSON.stringify(g.step([{ type: "text", text: "bbbb" }])), stamp);
	assert.equal((await flat.snapshot("flat_u")).events.at(-1).text, "bbbb");
});

test("OpenCode Live: the latest cards stay visible past the display limit; dropped ones are counted", async t => {
	const f = fixture(t);
	f.session("ses_long");
	f.row("ses_long", "long_u", 1, "user", { text: "Many steps" });
	for (let i = 0; i < 130; i++) f.row("ses_long", `long_a${i}`, 2 + i, "assistant", f.step([f.tool(`k${i}`, "completed", { content: [{ type: "text", text: `ok ${i}` }] })], { finish: "tool-calls" }));
	const live = f.source("ses_long");
	t.after(() => live.close());
	const before = await live.snapshot("long_u");
	assert.equal(before.events.length, 250);
	assert.equal(before.omitted, 11, "the prompt and 260 tool cards: 11 earlier cards are not shown");
	assert.equal(before.events.at(-1).id, "long_a129.0.1");
	f.row("ses_long", "long_new", 200, "assistant", f.step([f.tool("k_new", "running")]));
	const after = await live.snapshot("long_u");
	assert.equal(after.sequence, before.sequence + 1);
	assert.equal(after.events.at(-1).id, "long_new.0.0");
	assert.equal(after.events.at(-1).pending, true);
	assert.equal(after.omitted, 12);
});

test("OpenCode Live: an image whose bytes change at the same length is sent again", async t => {
	const f = fixture(t);
	// Two 1×1 PNGs of equal length: red and blue.
	const red = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
	const blue = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";
	assert.equal(red.length, blue.length);
	const image = data => f.step([f.tool("shot", "completed", { content: [{ type: "text", text: "Screenshot" }, { type: "file", mime: "image/png", uri: `data:image/png;base64,${data}` }] })]);
	f.session("ses_img");
	f.row("ses_img", "img_u", 1, "user", { text: "Show it" });
	f.row("ses_img", "img_a", 2, "assistant", image(red));
	const live = f.source("ses_img");
	t.after(() => live.close());
	const before = await live.snapshot("img_u");
	assert.equal(before.events.at(-1).images?.length, 1);
	f.update("ses_img", "img_a", image(blue));
	const after = await live.snapshot("img_u");
	assert.equal(after.sequence, before.sequence + 1);
	assert.notEqual(after.events.at(-1).version, before.events.at(-1).version);
	assert.deepEqual(changedAt(after, after.sequence), ["img_a.0.1"]);
});

test("OpenCode Live: a staged revert is not the current turn and is labelled; an unplaceable one suspends the current turn", async t => {
	const f = fixture(t);
	f.session("ses_stage");
	f.row("ses_stage", "st_u1", 1, "user", { text: "First" });
	f.row("ses_stage", "st_a1", 2, "assistant", f.answer("First answer"));
	f.row("ses_stage", "st_i1", 3, "idle", { outcome: "succeeded" });
	f.row("ses_stage", "st_u2", 4, "user", { text: "Second" });
	f.row("ses_stage", "st_a2", 5, "assistant", f.answer("Second answer"));
	f.row("ses_stage", "st_i2", 6, "idle", { outcome: "succeeded" });
	const live = f.source("ses_stage");
	t.after(() => live.close());
	assert.equal(await live.current(), "st_u2");
	const stage = revert => { f.db.prepare("UPDATE session_v2 SET revert=? WHERE id='ses_stage'").run(revert); f.db.prepare("UPDATE event_sequence SET seq=seq+1 WHERE aggregate_id='ses_stage'").run(); };
	stage(JSON.stringify({ messageID: "st_u2", files: [] }));
	assert.equal(await live.current(), "st_u1", "the staged-away turn is not current");
	const staged = await live.snapshot("st_u2");
	assert.ok(staged, "a reader who opened it still sees what is recorded");
	assert.ok(staged.notices.includes("OpenCode has staged a revert that removes this turn."));
	assert.equal((await live.snapshot("st_u1")).notices.some(n => /revert/.test(n)), false);
	stage(JSON.stringify({ messageID: "msg_gone" }));
	assert.equal(await live.current(), undefined, "a boundary Live can't place suspends the current turn");
	assert.ok((await live.snapshot("st_u2")).notices.some(n => /can't place/.test(n)));
	stage(null);
	assert.equal(await live.current(), "st_u2");
});

test("OpenCode Live: an answer imported from v1 closes its exchange; a new native prompt starts its own turn", async t => {
	const f = fixture(t);
	f.db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, time_suspended INTEGER, fork_session_id TEXT);
		CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
		CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
	f.session("ses_mig");
	const old = f.answer("Imported answer");
	f.db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run("mig_a", "ses_mig", old.time.created, old.time.completed, JSON.stringify({ role: "assistant", ...old }));
	// The v2 copy of the v1 exchange has no idle marker.
	f.row("ses_mig", "mig_u", 1, "user", { text: "Imported prompt" });
	f.row("ses_mig", "mig_a", 2, "assistant", old);
	f.row("ses_mig", "native_u", 3, "user", { text: "Native prompt" });
	f.row("ses_mig", "native_a", 4, "assistant", f.step([f.tool("k", "running")]));
	const live = f.source("ses_mig");
	t.after(() => live.close());
	assert.equal(await live.current(), "native_u");
	const turn = await live.snapshot("native_u");
	assert.deepEqual(turn.events.filter(e => e.kind === "prompt").map(e => e.text), ["Native prompt"]);
	assert.equal(turn.events.some(e => /Imported answer/.test(e.text)), false);
});

test("OpenCode Live: native shell output, malformed rows and replaced content slots", async t => {
	const f = fixture(t);
	f.session("ses_misc");
	f.row("ses_misc", "misc_u", 1, "user", { text: "Go" });
	f.row("ses_misc", "misc_s", 2, "shell", { status: "completed", command: "ls", output: { output: "file.txt", cursor: 8, size: 8, truncated: true } });
	f.db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)").run("misc_bad", "ses_misc", "assistant", 3, Date.now(), Date.now(), "null");
	f.row("ses_misc", "misc_a", 4, "assistant", f.step([f.tool("k", "completed", { content: [{ type: "text", text: "tool out" }] }), { type: "text", text: "after" }]));
	const live = f.source("ses_misc");
	t.after(() => live.close());
	const first = await live.snapshot("misc_u");
	assert.deepEqual(view(first), ["misc_u.0 prompt", "misc_s.0 tool", "misc_s.1 result", "misc_a.0.0 tool", "misc_a.0.1 result", "misc_a.1.0 progress"]);
	assert.equal(first.events[2].text, "file.txt", "v2 records shell output as an object");
	assert.ok(first.notices.includes("OpenCode recorded only part of a shell command's output."));
	assert.ok(first.notices.includes("An invalid recorded message was omitted."), "a non-object row is reported, not thrown");
	// OpenCode can replace a row's whole content: slots are redrawn, never merged.
	f.update("ses_misc", "misc_a", f.step([{ type: "text", text: "rewritten" }]));
	const second = await live.snapshot("misc_u");
	assert.deepEqual(view(second).slice(3), ["misc_a.0.0 progress"]);
	assert.equal(second.events[3].text, "rewritten");
	assert.deepEqual(changedAt(second, second.sequence), ["misc_a.0.0"]);
});

test("--live: an OpenCode answer too large for Preview says so, and the status line shows the turn's notices", { skip: !pandoc, timeout: 60_000 }, async t => {
	const f = fixture(t);
	f.session("ses_note");
	f.row("ses_note", "note_u0", 1, "user", { text: "Earlier" });
	f.row("ses_note", "note_a0", 2, "assistant", f.answer("Earlier answer"));
	f.row("ses_note", "note_i0", 3, "idle", { outcome: "succeeded" });
	f.row("ses_note", "note_u", 4, "user", { text: "Go" });
	f.row("ses_note", "note_s", 5, "shell", { status: "completed", command: "ls", output: { output: "x", truncated: true } });
	const watch = await startResponseWatch({ cwd: f.cwd, roots: f.roots, agents: ["opencode"], style: styleForMode("light"), sessionPath: "ses_note", turnDetails: true, live: true, ...fast });
	t.after(() => watch.close());
	const first = await fetch(watch.url);
	const cookie = first.headers.get("set-cookie").split(";")[0];
	const root = await first.text();
	const get = path => fetch(new URL(path, new URL(watch.url).origin), { headers: { cookie }, redirect: "manual" });
	const state = await (await get(root.match(/data-live-state="([^"]+)"/)[1].replaceAll("&amp;", "&"))).json();
	const html = await (await get(state.liveHref)).text();
	assert.match(html, /<span class="live-notice">OpenCode recorded only part of a shell command&#39;s output\.<\/span>/);
	const cursor = html.match(/data-live-cursor="([^"]+)"/)[1];
	f.row("ses_note", "note_a", 6, "assistant", f.answer("y".repeat(2 * 1024 * 1024 + 1)));
	f.row("ses_note", "note_i", 7, "idle", { outcome: "succeeded" });
	const updates = await (await get(`${state.liveHref.replace("?", "/updates?")}&cursor=${encodeURIComponent(cursor)}`)).json();
	assert.match(updates.statusHtml, /^Turn completed, but its answer is too large to show in Preview\. <a href=/);
	assert.ok(updates.previewHref, "Follow activity returns to the latest Preview");
});
