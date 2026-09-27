import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createOpenCodeStore, openCodeSessionPath } from "../dist/opencode.js";
import { createResponseReader, createSessionFinder, defaultSessionRoots, piSessionDirName, sessionShortId } from "../dist/sessions.js";
import { createSessionMonitor } from "../dist/monitor.js";
import { startResponseWatch, startSessionIndex, styleForMode } from "../dist/watch.js";

const sqliteModule = process.versions.bun ? "bun:sqlite" : "node:sqlite";
const { DatabaseSync: NodeDatabase, Database: BunDatabase } = await import(sqliteModule);
const Database = NodeDatabase ?? BunDatabase;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fast = { tailIntervalMs: 25, rescanMs: 60, stateDir: null };
const pandoc = !spawnSync(process.env.PANDOC_PATH || "pandoc", ["--version"], { stdio: "ignore" }).error;
async function until(check, label) {
	for (let n = 0; n < 300; n++) { const value = await check(); if (value) return value; await sleep(20); }
	throw new Error("Timed out waiting for " + label);
}
function fixture(t, layouts = [1, 2]) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "amp-opencode-"))), cwd = join(base, "project"), path = join(base, "opencode.db");
	mkdirSync(cwd);
	const db = new Database(path);
	db.exec("PRAGMA journal_mode=WAL");
	if (!layouts.length) db.exec("CREATE TABLE unrelated (id TEXT)");
	const sessionColumns = "id TEXT PRIMARY KEY, directory TEXT, title TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, time_suspended INTEGER, fork_session_id TEXT";
	if (layouts.includes(1)) db.exec(`CREATE TABLE session (${sessionColumns});
		CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
		CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
		CREATE INDEX message_session ON message(session_id,id); CREATE INDEX part_message ON part(message_id,id);`);
	if (layouts.includes(2)) db.exec(`CREATE TABLE session_v2 (${sessionColumns});
		CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
		CREATE UNIQUE INDEX session_message_seq ON session_message(session_id,seq); CREATE INDEX session_message_type_seq ON session_message(session_id,type,seq);`);
	const store = createOpenCodeStore(path);
	t.after(() => { store.close(); db.close(); rmSync(base, { recursive: true, force: true }); });
	const session = (version, id, props = {}) => {
		const now = Date.now();
		const row = { id, directory: cwd, title: `Title ${id}`, parent_id: null, time_created: now - 100_000, time_updated: now, time_archived: null, time_suspended: null, fork_session_id: null, ...props };
		db.prepare(`INSERT INTO ${version === 1 ? "session" : "session_v2"} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
	};
	const v2 = (session, id, seq, type, data = {}) => {
		const time = data.time?.created ?? Date.now();
		db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)").run(id, session, type, seq, time, time, JSON.stringify(data));
	};
	const answer = (text, time = Date.now(), extra = {}) => ({ finish: "stop", time: { created: time - 10, completed: time }, content: [{ type: "text", text }], ...extra });
	const v1 = (session, id, text, extra = {}) => {
		const data = { role: "assistant", finish: "stop", time: { created: Date.now() - 10, completed: Date.now() }, ...extra };
		db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(id, session, data.time.created, data.time.completed ?? data.time.created, JSON.stringify(data));
		db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(`prt_${id}`, session, id, data.time.created, data.time.created, JSON.stringify({ type: "text", text }));
	};
	return { base, cwd, path, db, store, session, v1, v2, answer, source: id => openCodeSessionPath(path, id), roots: { opencode: path } };
}

test("OpenCode message adapters: v1 parts / v2 content, completed text only, stable revision keys", () => {
	const read = createResponseReader("opencode", "/db#ses_abcd");
	const data = { id: "msg_1", finish: "stop", time: { completed: 123 }, content: [{ type: "text", text: "First" }, { type: "reasoning", text: "private" }, { type: "tool", text: "output" }, { type: "text", text: "ignore", ignored: true }, { type: "text", text: "synthetic", synthetic: true }, { type: "text", text: "Second" }] };
	assert.equal(read({ type: "assistant", ...data }).markdown, "First\n\nSecond");
	assert.equal(read({ info: { role: "assistant", ...data, content: undefined }, parts: data.content }).key, "opencode:msg_1");
	for (const extra of [{ type: "compaction" }, { type: "user" }, { time: {} }, { time: { completed: "123" } }, { finish: "tool-calls" }, { finish: "error" }, { error: { message: "fail" } }, { summary: true }]) assert.equal(read({ type: "assistant", ...data, ...extra }), null);
	assert.equal(sessionShortId("/db#ses_timestampabcd"), "abcd");
	assert.equal(defaultSessionRoots({ XDG_DATA_HOME: "/custom" }).opencode, "/custom/opencode/opencode.db");
});

test("OpenCode discovery: both schemas, v2 wins migrations, directory/child/archive filtering, read-only", async t => {
	const f = fixture(t);
	f.session(1, "ses_v1"); f.v1("ses_v1", "msg_v1", "v1 text");
	f.session(1, "ses_both"); f.session(2, "ses_both");
	f.session(1, "ses_moved"); f.session(2, "ses_moved", { directory: "/other" });
	f.session(2, "ses_child", { parent_id: "ses_both" });
	f.session(2, "ses_archived", { time_archived: Date.now() });
	f.session(2, "ses_other", { directory: f.cwd + "-other" });
	const before = [f.path, f.path + "-wal"].map(path => readFileSync(path));
	const find = createSessionFinder(f.roots); t.after(() => find.close());
	assert.deepEqual((await find("opencode", f.cwd)).map(row => row.path).sort(), [f.source("ses_v1"), f.source("ses_both")].sort());
	const global = await find.all("opencode");
	assert.equal(global.length, 4, "global discovery includes other folders, not children or archived rows");
	assert.equal(global.filter(row => row.path === f.source("ses_both")).length, 1);
	assert.equal(global.find(row => row.path === f.source("ses_moved")).cwd, "/other", "v2 remains authoritative globally");
	assert.equal((await f.store.snapshot(f.source("ses_v1"))).history[0].markdown, "v1 text");
	assert.deepEqual([f.path, f.path + "-wal"].map(path => readFileSync(path)), before, "opening/discovery/snapshot must not write the database or WAL");
});

test("OpenCode v1-only SQLite: final text parts, not tool calls, reasoning, compaction or errors", async t => {
	const f = fixture(t, [1]); f.session(1, "ses_old");
	f.v1("ses_old", "msg_001", "old final"); f.v1("ses_old", "msg_002", "tool preamble", { finish: "tool-calls" });
	f.v1("ses_old", "msg_003", "summary", { summary: true }); f.v1("ses_old", "msg_004", "failed", { error: { name: "abort" } });
	f.v1("ses_old", "msg_005", "streaming", { time: { created: Date.now() } });
	let snapshot = await f.store.snapshot(f.source("ses_old"));
	assert.deepEqual(snapshot.history.map(r => r.markdown), ["old final"]); assert.equal(snapshot.working, true);
	f.db.prepare("UPDATE message SET data=? WHERE id='msg_005'").run(JSON.stringify({ role: "assistant", finish: "stop", time: { completed: Date.now() } }));
	f.db.prepare("UPDATE part SET data=? WHERE message_id='msg_005'").run(JSON.stringify({ type: "text", text: "finished" }));
	snapshot = await f.store.snapshot(f.source("ses_old"));
	assert.equal(snapshot.history.at(-1).markdown, "finished"); assert.equal(snapshot.working, false);
});

test("OpenCode v2-only: seq order, idle settlement, one answer per turn, no tools or reasoning", async t => {
	const f = fixture(t, [2]); f.session(2, "ses_new", { title: null, time_suspended: Date.now() });
	f.v2("ses_new", "msg_z", 1, "user", { text: "First prompt title" });
	f.v2("ses_new", "msg_y", 2, "assistant", f.answer("Preamble", Date.now(), { finish: "tool-calls" }));
	f.v2("ses_new", "msg_x", 3, "assistant", f.answer("Earlier step"));
	f.v2("ses_new", "msg_b", 4, "assistant", f.answer("Final **answer**", Date.now(), { content: [{ type: "reasoning", text: "hidden" }, { type: "tool", name: "bash", state: { output: "hidden" } }, { type: "text", text: "Final **answer**" }] }));
	let snapshot = await f.store.snapshot(f.source("ses_new"));
	assert.equal(snapshot.history.length, 0, "provider completion is not v2 turn completion"); assert.equal(snapshot.working, true); assert.equal(snapshot.title, "First prompt title");
	f.v2("ses_new", "msg_a", 5, "idle", { outcome: "succeeded" });
	f.db.exec("UPDATE session_v2 SET time_suspended=NULL WHERE id='ses_new'");
	snapshot = await f.store.snapshot(f.source("ses_new"));
	assert.deepEqual(snapshot.history.map(r => r.markdown), ["Final **answer**"]); assert.equal(snapshot.working, false);
	f.v2("ses_new", "msg_0", 6, "compaction", { status: "completed", summary: "not an answer" });
	assert.deepEqual((await f.store.snapshot(f.source("ses_new"))).history, snapshot.history);
});

test("OpenCode migrated history: retain multiple imported answers before the first v2 idle", async t => {
	const f = fixture(t); f.session(1, "ses_migrated"); f.session(2, "ses_migrated");
	for (let i = 1; i <= 3; i++) {
		f.v1("ses_migrated", `msg_${i}`, "old copy");
		f.v2("ses_migrated", `msg_${i}`, i, "assistant", f.answer(`migrated ${i}`));
	}
	f.v2("ses_migrated", "msg_4", 4, "user", { text: "resumed" });
	f.v2("ses_migrated", "msg_5", 5, "assistant", f.answer("native v2"));
	assert.deepEqual((await f.store.snapshot(f.source("ses_migrated"))).history.map(r => r.markdown), ["migrated 1", "migrated 2", "migrated 3"]);
	f.v2("ses_migrated", "msg_6", 6, "idle", { outcome: "succeeded" });
	assert.deepEqual((await f.store.snapshot(f.source("ses_migrated"))).history.map(r => r.markdown), ["migrated 1", "migrated 2", "migrated 3", "native v2"]);
});

test("OpenCode malformed entries and oversized answers are skipped, never partially rendered", async t => {
	const f = fixture(t), big = "x".repeat(1_100_000);
	f.session(1, "ses_bad1"); f.session(2, "ses_bad2");
	f.v1("ses_bad1", "msg_001", "kept");
	f.v1("ses_bad1", "msg_002", big);
	f.db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run("prt_extra", "ses_bad1", "msg_002", 1, 1, JSON.stringify({ type: "text", text: big }));
	f.db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run("prt_broken", "ses_bad1", "msg_001", 1, 1, "{broken");
	f.v2("ses_bad2", "msg_kept", 1, "assistant", f.answer("", Date.now(), { content: ["not an object", null, 17, { type: "tool", state: { output: big + big + big } }, { type: "reasoning", text: "hidden" }, { type: "text", text: "kept" }] }));
	f.v2("ses_bad2", "msg_idle1", 2, "idle", { outcome: "succeeded" });
	f.v2("ses_bad2", "msg_large", 3, "assistant", f.answer("", Date.now(), { content: [{ type: "text", text: big }, { type: "text", text: big }, { type: "text", text: "do not show a partial answer" }] }));
	f.v2("ses_bad2", "msg_idle2", 4, "idle", { outcome: "succeeded" });
	f.db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)").run("msg_broken", "ses_bad2", "assistant", 5, 1, 1, "{broken");
	for (const id of ["ses_bad1", "ses_bad2"]) assert.deepEqual((await f.store.snapshot(f.source(id))).history.map(r => r.markdown), ["kept"]);
});

test("OpenCode v2: incomplete imports still need idle; forked historical answers survive without old IDs", async t => {
	const f = fixture(t);
	f.session(1, "ses_resume"); f.session(2, "ses_resume");
	f.v1("ses_resume", "msg_import", "partial", { time: { created: Date.now() } });
	f.v2("ses_resume", "msg_import", 1, "assistant", f.answer("completed after migration"));
	const waiting = await f.store.snapshot(f.source("ses_resume"));
	assert.equal(waiting.history.length, 0); assert.equal(waiting.working, true, "before idle is busy even without a claim");
	f.v2("ses_resume", "msg_finished", 2, "idle", { outcome: "succeeded" });
	assert.equal((await f.store.snapshot(f.source("ses_resume"))).history[0].markdown, "completed after migration");
	f.session(2, "ses_fork", { fork_session_id: "ses_resume", time_created: Date.now() });
	f.v2("ses_fork", "msg_copy1", 1, "assistant", f.answer("fork history 1", Date.now() - 10_000));
	f.v2("ses_fork", "msg_copy2", 2, "assistant", f.answer("fork history 2", Date.now() - 5_000));
	assert.deepEqual((await f.store.snapshot(f.source("ses_fork"))).history.map(r => r.markdown), ["fork history 1", "fork history 2"]);
});

test("OpenCode live v1-to-v2 migration keeps its selector and prefers the new content", async t => {
	const f = fixture(t, [1]); f.session(1, "ses_upgrade"); f.v1("ses_upgrade", "msg_same", "old projection");
	const first = await f.store.snapshot(f.source("ses_upgrade"));
	f.db.exec("CREATE TABLE session_v2 AS SELECT * FROM session; CREATE TABLE session_message (id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,time_updated INTEGER,data TEXT)");
	f.v2("ses_upgrade", "msg_same", 1, "assistant", f.answer("new projection"));
	const after = await f.store.snapshot(f.source("ses_upgrade"));
	assert.equal(after.history[0].key, first.history[0].key); assert.equal(after.history[0].markdown, "new projection");
	assert.equal((await f.store.list(f.cwd)).length, 1);
});

test("OpenCode WAL snapshots: committed in-place revisions, same timestamp, cache and bounded history", async t => {
	const f = fixture(t, [2]); f.session(2, "ses_wal");
	for (let i = 0; i < 25; i++) { f.v2("ses_wal", `msg_a${i}`, i * 2, "assistant", f.answer(`answer ${i}`)); f.v2("ses_wal", `msg_i${i}`, i * 2 + 1, "idle", { outcome: "succeeded" }); }
	const before = await f.store.snapshot(f.source("ses_wal"));
	assert.equal(before.history.length, 20); assert.equal(before.history[0].markdown, "answer 5"); assert.equal(before.history.at(-1).markdown, "answer 24");
	assert.equal(await f.store.snapshot(f.source("ses_wal")), before, "unchanged database reuses snapshot");
	f.db.exec("BEGIN");
	f.db.prepare("UPDATE session_message SET data=? WHERE id='msg_a24'").run(JSON.stringify(f.answer("revised")));
	assert.equal(await f.store.snapshot(f.source("ses_wal")), before, "uncommitted WAL data is invisible");
	f.db.exec("COMMIT");
	const revised = await f.store.snapshot(f.source("ses_wal"));
	assert.equal(revised.history.at(-1).key, before.history.at(-1).key); assert.equal(revised.history.at(-1).markdown, "revised");
});

test("OpenCode absent/unknown database does not create files or break other agent discovery", async t => {
	const f = fixture(t, []);
	const absent = createOpenCodeStore(join(f.base, "absent.db")); t.after(() => absent.close());
	assert.deepEqual(await absent.list(f.cwd), []);
	assert.throws(() => readFileSync(join(f.base, "absent.db")), { code: "ENOENT" });
	const piRoot = join(f.base, "pi"), dir = join(piRoot, piSessionDirName(f.cwd)); mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "test.jsonl"), JSON.stringify({ type: "message", id: "p1", timestamp: new Date().toISOString(), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Pi still works" }] } }) + "\n");
	const logs = [], monitor = createSessionMonitor({ cwd: f.cwd, roots: { ...f.roots, pi: piRoot }, agents: ["opencode", "pi"], ...fast, log: s => logs.push(s) });
	t.after(() => monitor.close()); await monitor.ready; await sleep(180);
	assert.equal(monitor.sessions()[0].latest.markdown, "Pi still works"); assert.equal(logs.length, 1); assert.match(logs[0], /Unrecognised OpenCode SQLite schema/);
});

test("OpenCode monitor: startup suppression, live idle, revisions, discovery, title/activity and close", async t => {
	const f = fixture(t, [2]); f.session(2, "ses_live");
	f.v2("ses_live", "msg_1", 1, "assistant", f.answer("history")); f.v2("ses_live", "msg_2", 2, "idle", { outcome: "succeeded" });
	const monitor = createSessionMonitor({ cwd: f.cwd, roots: f.roots, agents: ["opencode"], ...fast });
	t.after(() => monitor.close()); const responses = [];
	monitor.onResponse((s, r, fresh) => responses.push({ text: r.markdown, key: r.key, fresh })); await monitor.ready;
	assert.deepEqual(responses.map(r => r.fresh), [false]);
	f.v2("ses_live", "msg_3", 3, "user", { text: "new question" });
	f.db.exec("UPDATE session_v2 SET title='Renamed',time_suspended=1 WHERE id='ses_live'");
	await until(() => monitor.sessions()[0].working && monitor.sessions()[0].title === "Renamed", "working/title");
	f.v2("ses_live", "msg_4", 4, "assistant", f.answer("live final")); await sleep(100);
	assert.equal(responses.length, 1);
	f.v2("ses_live", "msg_5", 5, "idle", { outcome: "succeeded" }); f.db.exec("UPDATE session_v2 SET time_suspended=NULL");
	await until(() => responses.length === 2, "idle answer"); assert.equal(responses[1].fresh, true);
	f.db.prepare("UPDATE session_message SET data=? WHERE id='msg_4'").run(JSON.stringify(f.answer("revised final")));
	await until(() => responses.length === 3, "revision"); assert.equal(responses[2].key, responses[1].key); assert.equal(monitor.sessions()[0].responseCount, 2);
	f.v2("ses_live", "msg_skewed", 6, "assistant", f.answer("clock moved backwards", Date.now() - 60_000));
	f.v2("ses_live", "msg_skewedidle", 7, "idle", { time: { created: Date.now() - 59_000 }, outcome: "succeeded" });
	await until(() => responses.length === 4, "backdated live answer"); assert.equal(responses[3].fresh, true, "live delivery uses sequence, not wall-clock time");
	f.session(2, "ses_later"); f.v2("ses_later", "msg_later", 1, "assistant", f.answer("later")); f.v2("ses_later", "msg_idle", 2, "idle", { outcome: "succeeded" });
	await until(() => responses.some(r => r.text === "later" && r.fresh), "new session");
	monitor.close(); const count = responses.length;
	f.v2("ses_later", "msg_closed", 3, "assistant", f.answer("closed")); f.v2("ses_later", "msg_closedidle", 4, "idle", { outcome: "succeeded" }); await sleep(100);
	assert.equal(responses.length, count);
});

test("OpenCode monitor bounds concurrent sessions and does not replay answers after eviction", async t => {
	const f = fixture(t, [2]), now = Date.now(); f.session(2, "ses_return", { time_updated: now });
	f.v2("ses_return", "msg_old", 1, "assistant", f.answer("already seen", now - 1000)); f.v2("ses_return", "msg_oldidle", 2, "idle", { time: { created: now - 900 }, outcome: "succeeded" });
	const monitor = createSessionMonitor({ cwd: f.cwd, roots: f.roots, agents: ["opencode"], maxPerAgent: 1, ...fast });
	t.after(() => monitor.close()); const seen = [];
	monitor.onResponse((s, r, fresh) => seen.push({ text: r.markdown, fresh })); await monitor.ready;
	f.session(2, "ses_displace", { time_updated: now + 1000 });
	await until(() => monitor.sessions()[0]?.path === f.source("ses_displace"), "eviction"); assert.equal(monitor.sessions().length, 1);
	f.v2("ses_return", "msg_new", 3, "assistant", f.answer("new after eviction", now + 2000)); f.v2("ses_return", "msg_newidle", 4, "idle", { outcome: "succeeded" });
	f.db.prepare("UPDATE session_v2 SET time_updated=? WHERE id='ses_return'").run(now + 2000);
	await until(() => seen.some(r => r.text === "new after eviction" && r.fresh), "returning answer");
	assert.equal(seen.some(r => r.text === "already seen" && r.fresh), false); assert.equal(monitor.sessions().length, 1);
});

test("OpenCode index, merged/per-session previews, ID pinning and CLI database override", { skip: !pandoc, timeout: 60_000 }, async t => {
	const f = fixture(t, [2]); f.session(2, "ses_view");
	f.v2("ses_view", "msg_view", 1, "assistant", f.answer("## OpenCode answer\n\n**Rendered** $x^2$")); f.v2("ses_view", "msg_idle", 2, "idle", { outcome: "succeeded" });
	const options = { cwd: f.cwd, roots: f.roots, agents: ["opencode"], style: styleForMode("light"), ...fast };
	const index = await startSessionIndex(options); t.after(() => index.close());
	const token = new URL(index.url).searchParams.get("token");
	const sessions = (await (await fetch(new URL(`/api/sessions?token=${token}`, index.url))).json()).sessions;
	assert.equal(sessions.length, 1); assert.equal(sessions[0].agentLabel, "OpenCode");
	const urls = [];
	for (const id of [sessions[0].id, "all"]) {
		const response = await fetch(new URL(`/open/${id}?token=${token}`, index.url), { redirect: "manual" });
		assert.equal(response.status, 302); urls.push(response.headers.get("location"));
	}
	const pinned = await startResponseWatch({ ...options, sessionPath: "ses_view" }); t.after(() => pinned.close()); urls.push(pinned.url);
	for (const url of urls) assert.match(await (await fetch(url)).text(), /<strong>Rendered<\/strong>/);
	await assert.rejects(startResponseWatch({ ...options, sessionPath: "ses_missing" }), /was not found/);
	f.v2("ses_view", "msg_final", 3, "assistant", f.answer("After the idle marker")); f.v2("ses_view", "msg_finalidle", 4, "idle", { outcome: "succeeded" });
	for (const url of urls) await until(async () => (await (await fetch(url)).text()).includes("After the idle marker"), "live rendered view");

	const cli = spawn(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "--agent", "opencode", "--session", "ses_view", "--opencode-db", f.path, "--cwd", f.cwd, "--no-open"], { env: { ...process.env, AGENT_MARKDOWN_PREVIEW_HOME: join(f.base, "state") }, stdio: ["ignore", "pipe", "pipe"] });
	let output = "", errors = ""; cli.stdout.on("data", chunk => output += chunk); cli.stderr.on("data", chunk => errors += chunk);
	const exited = new Promise(resolve => cli.once("exit", resolve));
	t.after(async () => { if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGTERM"); const kill = setTimeout(() => cli.kill("SIGKILL"), 3000); try { await exited; } finally { clearTimeout(kill); } });
	await until(() => { if (cli.exitCode !== null) throw new Error(errors); return output.includes("Watching OpenCode"); }, "OpenCode CLI");
	assert.match(output, /Watching OpenCode view/);
	if (process.env.PUPPETEER_EXECUTABLE_PATH) {
		const { default: puppeteer } = await import("puppeteer-core");
		const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ["--no-sandbox"] });
		try { const page = await browser.newPage(); await page.goto(index.url); await page.waitForFunction(() => document.querySelector("#list").textContent.includes("OpenCode")); await page.goto(pinned.url); await page.waitForFunction(() => document.body.textContent.includes("After the idle marker")); }
		finally { await browser.close(); }
	}
});
