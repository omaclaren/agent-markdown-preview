import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { claudeProjectDirName, createSessionFinder, piSessionDirName } from "../dist/sessions.js";
import { ALL_PROJECTS_SESSION_LIMIT, createSessionMonitor } from "../dist/monitor.js";
import { startSessionIndex, styleForMode } from "../dist/watch.js";

const sleep = ms => new Promise(done => setTimeout(done, ms));
const line = entry => JSON.stringify(entry) + "\n";
const fast = { rescanMs: 50, tailIntervalMs: 25, stateDir: null };
const pandoc = !spawnSync(process.env.PANDOC_PATH || "pandoc", ["--version"], { stdio: "ignore" }).error;
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
async function until(check, label) {
	for (let n = 0; n < 400; n++) { const result = await check(); if (result) return result; await sleep(20); }
	throw new Error("Timed out waiting for " + label);
}
const answer = (id, text, time = Date.now()) => line({ type: "assistant", timestamp: new Date(time).toISOString(), message: { id, stop_reason: "end_turn", content: [{ type: "text", text }] } });
function fixture(t) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "amp-projects-"))), cleanups = [];
	const roots = { claude: join(base, "claude", "projects"), pi: join(base, "pi"), codex: join(base, "codex") };
	const own = resource => { cleanups.push(() => resource.close()); return resource; };
	t.after(async () => { for (const close of cleanups.reverse()) await close(); rmSync(base, { recursive: true, force: true }); });
	const write = (path, text, mtime = Date.now()) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); utimesSync(path, new Date(mtime), new Date(mtime)); return path; };
	const claude = (cwd, id, text = "Existing answer", mtime = Date.now()) => {
		mkdirSync(cwd, { recursive: true });
		return write(join(roots.claude, claudeProjectDirName(cwd), id + ".jsonl"), line({ type: "file-history-snapshot", snapshot: {} })
			+ line({ type: "ai-title", aiTitle: "Review " + id }) + line({ type: "user", cwd, timestamp: new Date(mtime - 60000).toISOString(), message: { content: "Please review this project" } })
			+ answer(id, text, mtime - 30000), mtime);
	};
	const pi = (cwd, id, mtime = Date.now()) => {
		mkdirSync(cwd, { recursive: true });
		return write(join(roots.pi, piSessionDirName(cwd), id + ".jsonl"), line({ type: "session", cwd }) + line({ type: "session_info", name: "Plan " + id })
			+ line({ type: "message", id, timestamp: new Date(mtime - 30000).toISOString(), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Pi answer " + id }] } }), mtime);
	};
	return { base, roots, own, write, claude, pi };
}

test("all-project discovery uses recorded paths, not lossy names, and ignores old/child/unidentified logs", async t => {
	const f = fixture(t), now = Date.now();
	const a = join(f.base, "a-b"), b = join(f.base, "a", "b");
	assert.equal(claudeProjectDirName(a), claudeProjectDirName(b), "fixture has an encoded-name collision");
	f.claude(a, "aaa", "A", now); f.claude(b, "bbb", "B", now - 1000); f.claude(a, "old", "old", now - 10 * 86400000);
	f.write(join(f.roots.claude, claudeProjectDirName(a), "child.jsonl"), line({ type: "user", cwd: a, isSidechain: true }));
	f.write(join(f.roots.claude, "unknown-folder", "unknown.jsonl"), line({ type: "user", message: { content: '"cwd":"/invented"' } }));
	f.write(join(f.roots.claude, claudeProjectDirName(a), "subagents", "nested.jsonl"), line({ type: "user", cwd: a }));
	f.pi(b, "pi1");
	f.write(join(f.roots.codex, "2026", "09", "27", "rollout-one.jsonl"), line({ type: "session_meta", payload: { cwd: a } }));
	f.write(join(f.roots.codex, "2026", "09", "28", "rollout-two.jsonl"), line({ type: "session_meta", payload: { cwd: b } }));
	f.write(join(f.roots.codex, "2026", "09", "28", "rollout-child.jsonl"), line({ type: "session_meta", payload: { cwd: b, source: { subagent: { thread_spawn: {} } } } }));
	const find = f.own(createSessionFinder(f.roots));
	const options = { since: now - 3 * 86400000 };
	assert.deepEqual((await find.all("claude", options)).map(s => s.cwd), [a, b]);
	assert.deepEqual((await find.all("pi", options)).map(s => s.cwd), [b]);
	assert.deepEqual(new Set((await find.all("codex", options)).map(s => s.cwd)), new Set([a, b]));
	f.claude(a, "newest", "newest", now + 5000);
	assert.equal((await find.all("claude", { ...options, limit: 1 })).length, 1, "candidate header reads are bounded");
});

test("cross-project discovery retries partial headers, preserves UTF-8 and notices newly created folders", async t => {
	const f = fixture(t), cwd = join(f.base, "résumé folder"); mkdirSync(cwd);
	const path = f.write(join(f.roots.pi, "encoded", "partial.jsonl"), '{"type":"session","cwd":');
	const find = f.own(createSessionFinder(f.roots));
	assert.deepEqual(await find.all("pi"), []);
	appendFileSync(path, JSON.stringify(cwd) + "}\n");
	assert.equal((await find.all("pi"))[0].cwd, cwd);
	const prefix = line({ type: "file-history-snapshot", filler: "x".repeat(65_440) });
	f.write(join(f.roots.claude, "not-decodable", "utf8.jsonl"), prefix + line({ type: "user", cwd }));
	assert.equal((await find.all("claude"))[0].cwd, cwd);
	const next = join(f.base, "new folder"); f.pi(next, "later");
	assert.deepEqual(new Set((await find.all("pi")).map(s => s.cwd)), new Set([cwd, next]));
});

test("all-project monitor: per-folder agent limits, global bound, late folders and no history replay", async t => {
	const f = fixture(t), now = Date.now(), a = join(f.base, "a"), b = join(f.base, "b"), c = join(f.base, "c");
	f.claude(a, "a1", "a1", now - 100); f.claude(a, "a2", "a2", now - 200);
	f.claude(b, "b1", "b1", now - 300); f.pi(a, "p1", now - 400);
	const monitor = f.own(createSessionMonitor({ cwd: f.base, roots: f.roots, allProjects: true, maxSessions: 3, maxPerAgent: 1, ...fast }));
	const fresh = []; monitor.onResponse((_s, r, isFresh) => { if (isFresh) fresh.push(r.markdown); }); await monitor.ready;
	assert.equal(monitor.sessions().length, 3); assert.deepEqual(new Set(monitor.sessions().map(s => s.cwd)), new Set([a, b]));
	assert.equal(monitor.sessions().filter(s => s.agent === "claude" && s.cwd === a).length, 1); assert.deepEqual(fresh, []);
	const later = f.claude(c, "c1", "old resumed history", now + 1000);
	await until(() => monitor.sessions().some(s => s.cwd === c), "new project"); assert.equal(monitor.sessions().length, 3); assert.deepEqual(fresh, []);
	appendFileSync(later, answer("c2", "fresh project response"));
	await until(() => fresh.includes("fresh project response"), "new project response");
	monitor.close(); const count = fresh.length; appendFileSync(later, answer("c3", "closed")); await sleep(100); assert.equal(fresh.length, count);
});

test("all-project default budget is 64 total, rather than eight total or every historical session", async t => {
	const f = fixture(t);
	for (let i = 0; i < 70; i++) f.pi(join(f.base, "projects", String(i)), "session" + i);
	const monitor = f.own(createSessionMonitor({ cwd: f.base, roots: f.roots, agents: ["pi"], allProjects: true, rescanMs: 60_000 }));
	await monitor.ready; assert.equal(monitor.sessions().length, ALL_PROJECTS_SESSION_LIMIT); assert.equal(ALL_PROJECTS_SESSION_LIMIT, 64);
});

test("grouped index: duplicate folder names, scoped previews/resources/live updates, auth and restart", { skip: !pandoc, timeout: 60_000 }, async t => {
	const f = fixture(t), now = Date.now();
	const a = join(f.base, "alpha", "app"), b = join(f.base, "beta <team>", "app");
	const fa = f.claude(a, "aaaa", "Folder A answer. [Notes](notes.md)", now - 1000);
	f.claude(b, "bbbb", "Folder B answer. [Notes](notes.md)", now - 500);
	f.pi(a, "pppp", now - 2000);
	writeFileSync(join(a, "notes.md"), "# Document in folder A"); writeFileSync(join(b, "notes.md"), "# Document in folder B");
	writeFileSync(join(f.base, "notes.md"), "WRONG launch directory");
	const options = { cwd: f.base, allProjects: true, roots: f.roots, style: styleForMode("light"), ...fast, stateDir: join(f.base, "state") };
	const index = f.own(await startSessionIndex(options));
	const token = new URL(index.url).searchParams.get("token");
	const api = async () => (await (await fetch(new URL(`/api/sessions?token=${token}`, index.url))).json());
	const data = await api();
	assert.equal(data.allProjects, true); assert.equal(data.cwd, null); assert.equal(data.sessionLimit, 64);
	assert.deepEqual(data.projects.map(p => p.label), ["app", "app"]); assert.deepEqual(data.projects.map(p => p.cwd), [b, a]);
	assert.notEqual(data.projects[0].id, data.projects[1].id); assert.equal(data.sessions.length, 3);
	assert.equal((await fetch(new URL("/api/sessions?token=wrong", index.url))).status, 403);
	assert.equal((await fetch(new URL(`/open/all?token=${token}`, index.url))).status, 404, "no accidental cross-folder merged resource root");
	assert.equal((await fetch(new URL(`/open/project-0000000000000000?token=${token}`, index.url))).status, 404);
	const open = async id => { const r = await fetch(new URL(`/open/${id}?token=${token}`, index.url), { redirect: "manual" }); assert.equal(r.status, 302); return r.headers.get("location"); };
	const pa = data.projects.find(p => p.cwd === a), pb = data.projects.find(p => p.cwd === b);
	const aSession = pa.sessions.find(s => s.agent === "claude"), bSession = pb.sessions[0];
	const aUrl = await open(aSession.id), bUrl = await open(bSession.id), aMerged = await open(pa.id), bMerged = await open(pb.id);
	const page = async url => (await fetch(url)).text();
	for (const [url, folder] of [[aUrl, "A"], [aMerged, "A"], [bUrl, "B"], [bMerged, "B"]]) {
		const response = await fetch(url), html = await response.text();
		assert.match(html, new RegExp(`Folder ${folder} answer`));
		assert.doesNotMatch(html, new RegExp(`Folder ${folder === "A" ? "B" : "A"} answer`));
		const href = html.match(/href="([^\"]*\/__pi_markdown_preview_document__\/[^\"]+)"/)[1].replaceAll("&amp;", "&");
		const headers = { cookie: response.headers.get("set-cookie").split(";")[0] };
		const doc = await (await fetch(new URL(href, url), { headers })).text();
		assert.match(doc, new RegExp(`Document in folder ${folder}`)); assert.doesNotMatch(doc, /WRONG launch directory/);
	}
	appendFileSync(fa, answer("newA", "New answer only in A"));
	for (const url of [aUrl, aMerged]) await until(async () => (await page(url)).includes("New answer only in A"), "scoped A update");
	for (const url of [bUrl, bMerged]) assert.doesNotMatch(await page(url), /New answer only in A/);
	assert.equal((await api()).projects[0].cwd, a, "group moves up when its sessions become active");

	if (process.env.PUPPETEER_EXECUTABLE_PATH) {
		const { default: puppeteer } = await import("puppeteer-core");
		const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ["--no-sandbox"] });
		try {
			const tab = await browser.newPage(); await tab.setViewport({ width: 1000, height: 850 }); await tab.goto(index.url);
			await tab.waitForFunction(() => document.querySelectorAll(".project").length === 2);
			assert.equal(await tab.$eval("#list", e => e.hidden), true);
			assert.deepEqual(await tab.$$eval(".project-path", nodes => nodes.map(e => e.textContent)), [a, b]);
			assert.equal(await tab.$$eval(".project-path team", nodes => nodes.length), 0, "folder paths are text, not HTML");
			assert.equal(await tab.$$eval(".project .all", nodes => nodes.length), 2);
			if (process.env.AMP_PROJECTS_SCREENSHOT) await tab.screenshot({ path: process.env.AMP_PROJECTS_SCREENSHOT, fullPage: true });
			await tab.setViewport({ width: 375, height: 800 });
			assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "long paths fit a narrow screen");
		} finally { await browser.close(); }
	}
	await index.close();
	const restarted = f.own(await startSessionIndex({ ...options, cwd: a }));
	assert.equal(restarted.url, index.url, "all-project address is independent of launch directory"); assert.equal(restarted.reused, true);
	for (const [url, text] of [[aUrl, "New answer only in A"], [aMerged, "New answer only in A"], [bMerged, "Folder B answer"]]) {
		await until(async () => { try { return (await page(url)).includes(text); } catch { return false; } }, "restored scoped preview");
	}
	const local = f.own(await startSessionIndex({ ...options, cwd: a, allProjects: false }));
	assert.notEqual(local.url, index.url, "local and global indexes have separate slots");
});

for (const mode of ["--all-projects", "-a"]) test(`all-project empty state and CLI validation/agent filter (${mode})`, { skip: !pandoc, timeout: 30_000 }, async t => {
	const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
	assert.equal(help.status, 0); assert.match(help.stdout, /-a, --all-projects/);
	for (const flags of [["--merged"], ["--cwd", "/tmp"], ["--session", "ses_test"], ["notes.md"]]) {
		const result = spawnSync(process.execPath, [cli, mode, ...flags], { encoding: "utf8" });
		assert.equal(result.status, 2); assert.match(result.stderr, /--all-projects/);
	}
	const f = fixture(t), index = f.own(await startSessionIndex({ cwd: f.base, roots: {}, allProjects: true, style: styleForMode("light"), ...fast }));
	const empty = await (await fetch(new URL(`/api/sessions?token=${new URL(index.url).searchParams.get("token")}`, index.url))).json();
	assert.deepEqual(empty.projects, []); assert.deepEqual(empty.sessions, []);
	const a = join(f.base, "a"), b = join(f.base, "b"); f.claude(a, "a"); f.claude(b, "b"); f.pi(b, "pi");
	const child = spawn(process.execPath, [cli, mode, "--agent", "claude", "--no-open"], { cwd: f.base,
		env: { ...process.env, CLAUDE_CONFIG_DIR: join(f.base, "claude"), AGENT_MARKDOWN_PREVIEW_HOME: join(f.base, "cli-state") }, stdio: ["ignore", "pipe", "pipe"] });
	let output = "", errors = ""; child.stdout.on("data", data => output += data); child.stderr.on("data", data => errors += data);
	const exited = new Promise(resolve => child.once("exit", resolve));
	f.own({ async close() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); const kill = setTimeout(() => child.kill("SIGKILL"), 3000); try { await exited; } finally { clearTimeout(kill); } } });
	await until(() => { if (child.exitCode !== null) throw new Error(errors); return output.includes("Watching sessions across projects"); }, "global CLI");
	const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)[0];
	const data = await (await fetch(new URL(`/api/sessions?token=${new URL(url).searchParams.get("token")}`, url))).json();
	assert.equal(data.projects.length, 2); assert.equal(data.sessions.length, 2); assert.ok(data.sessions.every(s => s.agent === "claude"));
});
