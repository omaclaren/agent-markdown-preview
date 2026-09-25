import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeProjectDirName, createResponseReader, createSessionFinder, detectAgent, piSessionDirName } from "../dist/sessions.js";

const read = (agent, entries) => {
	const reader = createResponseReader(agent, "/s.jsonl");
	return entries.map(entry => reader(entry)).filter(Boolean);
};

test("Claude Code: final message only, blocks of one message accumulate, sidechains and tool turns ignored", () => {
	const at = "2026-09-24T01:00:00.000Z";
	const responses = read("claude", [
		{ type: "user", message: { role: "user", content: "hi" } },
		{ type: "assistant", timestamp: at, message: { id: "m1", stop_reason: "tool_use", content: [{ type: "text", text: "Let me look." }] } },
		{ type: "assistant", isSidechain: true, message: { id: "sub", stop_reason: "end_turn", content: [{ type: "text", text: "subagent" }] } },
		{ type: "assistant", timestamp: at, message: { id: "m2", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "…" }] } },
		{ type: "assistant", timestamp: at, message: { id: "m2", stop_reason: "end_turn", content: [{ type: "text", text: "Part one" }] } },
		{ type: "assistant", timestamp: at, message: { id: "m2", stop_reason: "end_turn", content: [{ type: "text", text: "Part two" }] } },
		{ type: "system", subtype: "turn_duration" },
		"junk", null, { type: "assistant", message: { content: "not blocks" } },
	]);
	assert.deepEqual(responses.map(r => [r.key, r.markdown]), [["claude:m2", "Part one"], ["claude:m2", "Part one\n\nPart two"]]);
	assert.equal(responses[0].time, Date.parse(at));
});

test("Codex: task_complete carries the final message", () => {
	const responses = read("codex", [
		{ type: "session_meta", payload: { cwd: "/p" } },
		{ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "interim" }] } },
		{ type: "event_msg", timestamp: "2026-09-24T02:00:00Z", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "**Done.**" } },
		{ type: "event_msg", payload: { type: "task_complete", turn_id: "t2", last_agent_message: null } },
	]);
	assert.deepEqual(responses.map(r => [r.key, r.markdown]), [["codex:t1", "**Done.**"]]);
});

test("Pi: assistant messages with stopReason stop, not toolUse", () => {
	const responses = read("pi", [
		{ type: "session", cwd: "/p" },
		{ type: "message", id: "a1", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "calling" }] } },
		{ type: "message", id: "a2", timestamp: "2026-09-24T03:00:00Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Answer" }, { type: "text", text: "More" }] } },
	]);
	assert.deepEqual(responses.map(r => [r.key, r.markdown]), [["pi:a2", "Answer\n\nMore"]]);
});

test("session discovery per agent, newest first, and agent detection", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "amp-roots-")));
	const cwd = "/Users/me/Git-Working/my.project";
	const roots = { claude: join(root, "claude"), codex: join(root, "codex"), pi: join(root, "pi") };
	assert.equal(claudeProjectDirName(cwd), "-Users-me-Git-Working-my-project");
	assert.equal(piSessionDirName(cwd), "--Users-me-Git-Working-my.project--");
	const claudeDir = join(roots.claude, claudeProjectDirName(cwd));
	mkdirSync(claudeDir, { recursive: true });
	writeFileSync(join(claudeDir, "old.jsonl"), JSON.stringify({ sessionId: "x", type: "user" }) + "\n");
	await new Promise(done => setTimeout(done, 20));
	writeFileSync(join(claudeDir, "new.jsonl"), JSON.stringify({ sessionId: "y", type: "user" }) + "\n");
	const dayDir = join(roots.codex, "2026", "09", "24");
	mkdirSync(dayDir, { recursive: true });
	writeFileSync(join(dayDir, "rollout-a.jsonl"), JSON.stringify({ type: "session_meta", payload: { cwd: "/elsewhere" } }) + "\n");
	writeFileSync(join(dayDir, "rollout-b.jsonl"), JSON.stringify({ type: "session_meta", payload: { cwd, base_instructions: "x".repeat(200_000) } }) + "\n");
	mkdirSync(join(roots.pi, piSessionDirName(cwd)), { recursive: true });
	writeFileSync(join(roots.pi, piSessionDirName(cwd), "s.jsonl"), JSON.stringify({ type: "session", cwd }) + "\n");

	const find = createSessionFinder(roots);
	assert.deepEqual((await find("claude", cwd)).map(f => f.path.split("/").at(-1)), ["new.jsonl", "old.jsonl"]);
	assert.deepEqual((await find("codex", cwd)).map(f => f.path.split("/").at(-1)), ["rollout-b.jsonl"]);
	assert.deepEqual((await find("pi", cwd)).map(f => f.path.split("/").at(-1)), ["s.jsonl"]);
	assert.deepEqual(await find("claude", "/nowhere"), []);
	assert.equal(await detectAgent(join(dayDir, "rollout-b.jsonl")), "codex");
	assert.equal(await detectAgent(join(roots.pi, piSessionDirName(cwd), "s.jsonl")), "pi");
	assert.equal(await detectAgent(join(claudeDir, "new.jsonl")), "claude");
});

test("session reader: titles from the agent's own name, else the first typed prompt; working state per turn", async () => {
	const { createSessionReader, sessionShortId } = await import("../dist/sessions.js");
	const events = (agent, entries) => { const read = createSessionReader(agent, "/s.jsonl"); return entries.flatMap(entry => read(entry)); };
	const summary = list => list.map(e => e.kind === "title" ? `title:${e.title}` : e.kind === "working" ? `working:${e.working}` : `response:${e.response.key}`);
	assert.deepEqual(summary(events("claude", [
		{ type: "user", isMeta: true, message: { content: "<local-command-caveat>x</local-command-caveat>" } },
		{ type: "user", message: { content: "Review   the hosting\ncore" } },
		{ type: "user", message: { content: "second prompt" } },
		{ type: "ai-title", aiTitle: "Hosting review" },
		{ type: "assistant", message: { id: "m", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } },
		{ type: "user", isMeta: true, message: { content: '<channel source="studio">hi</channel>' } },
		{ type: "system", subtype: "turn_duration" },
	])), ["working:true", "title:Review the hosting core", "working:true", "title:Hosting review", "response:claude:m", "working:false", "working:true", "working:false"]);
	assert.deepEqual(summary(events("codex", [
		{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n..." }, { type: "input_text", text: "<environment_context>" }] } },
		{ type: "event_msg", payload: { type: "task_started", turn_id: "t" } },
		{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the tests" }] } },
		{ type: "event_msg", payload: { type: "task_complete", turn_id: "t", last_agent_message: "done" } },
	])), ["working:true", "title:Fix the tests", "response:codex:t", "working:false"]);
	assert.deepEqual(summary(events("pi", [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "Plan the week" }] } },
		{ type: "session_info", name: "Weekly plan" },
		{ type: "message", id: "a", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Plan" }] } },
	])), ["working:true", "title:Plan the week", "title:Weekly plan", "response:pi:a", "working:false", "working:false"]);
	assert.equal(sessionShortId("/x/3f2a9c1e-1111-4222-8333-444455556666.jsonl"), "6666");
	assert.equal(sessionShortId("/x/rollout-2026-09-24T01-02-03-01a0e000-1111-7222-8333-4444555591bc.jsonl"), "91bc");
});

test("Codex sessions are found in every recent date folder, not just the newest match", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "amp-codex-")));
	const cwd = "/work/project";
	const yesterday = join(root, "2026", "09", "24"), today = join(root, "2026", "09", "25");
	mkdirSync(yesterday, { recursive: true });
	mkdirSync(today, { recursive: true });
	const header = JSON.stringify({ type: "session_meta", payload: { cwd } }) + "\n";
	writeFileSync(join(yesterday, "rollout-a.jsonl"), header);
	writeFileSync(join(today, "rollout-b.jsonl"), header);
	writeFileSync(join(today, "rollout-c.jsonl"), JSON.stringify({ type: "session_meta", payload: { cwd: "/elsewhere" } }) + "\n");
	const found = await createSessionFinder({ codex: root })("codex", cwd);
	assert.deepEqual(found.map(file => file.path.split("/").at(-1)).sort(), ["rollout-a.jsonl", "rollout-b.jsonl"]);
});

test("the monitor stops following sessions that leave its window and does not replay them on return", async () => {
	const { createSessionMonitor } = await import("../dist/monitor.js");
	const root = realpathSync(mkdtempSync(join(tmpdir(), "amp-monitor-")));
	const cwd = "/work/project";
	const dir = join(root, claudeProjectDirName(cwd));
	mkdirSync(dir, { recursive: true });
	const answer = (id, text, offset) => JSON.stringify({ type: "assistant", timestamp: new Date(Date.now() + offset).toISOString(), message: { id, stop_reason: "end_turn", content: [{ type: "text", text }] } }) + "\n";
	const a = join(dir, "00000000-0000-4000-8000-00000000aaaa.jsonl"), b = join(dir, "00000000-0000-4000-8000-00000000bbbb.jsonl");
	writeFileSync(a, answer("a1", "A one", -60_000));
	const monitor = createSessionMonitor({ cwd, roots: { claude: root }, agents: ["claude"], maxPerAgent: 1, rescanMs: 50, tailIntervalMs: 30 });
	const fresh = [];
	monitor.onResponse((session, response, isFresh) => { if (isFresh) fresh.push(response.key); });
	await monitor.ready;
	const until = async (check, label) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(done => setTimeout(done, 25)); assert.ok(check(), label); };
	await new Promise(done => setTimeout(done, 20));
	writeFileSync(b, answer("b1", "B one", 0));
	await until(() => monitor.sessions().length === 1 && monitor.sessions()[0].shortId === "bbbb", "A displaced by B");
	await new Promise(done => setTimeout(done, 20));
	appendFileSync(a, answer("a2", "A two", 1_000));
	await until(() => monitor.sessions()[0]?.shortId === "aaaa", "A back when it becomes newest");
	await until(() => fresh.includes("claude:a2"), "A's new answer is fresh");
	monitor.close();
	assert.equal(monitor.sessions().length, 1);
	assert.deepEqual(fresh.filter(key => key.startsWith("claude:a")), ["claude:a2"], "A's earlier answer is not replayed");
});
