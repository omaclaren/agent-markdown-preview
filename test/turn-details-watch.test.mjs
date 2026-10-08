import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { startResponseWatch, startSessionIndex, styleForMode } from "../dist/watch.js";
import { piSessionDirName, claudeProjectDirName } from "../dist/sessions.js";
const pandoc = !spawnSync(process.env.PANDOC_PATH || "pandoc", ["--version"], { stdio: "ignore" }).error;
const line = e => JSON.stringify(e) + "\n";
const text = text => [{ type: "text", text }];
const time = delta => new Date(Date.now() + delta).toISOString();
const pi = (id, parentId, role, content, delta) => ({ type: "message", id, parentId, timestamp: time(delta), message: { role, content: text(content), ...(role === "assistant" ? { stopReason: "stop" } : {}) } });
const detailsLink = html => html.match(/data-watch-control="turn-details" href="([^"]+)"/)?.[1].replaceAll("&amp;", "&");
async function bootstrap(url) {
 const r = await fetch(url); assert.equal(r.status, 200);
 return { html: await r.text(), origin: new URL(url).origin, cookie: r.headers.get("set-cookie").split(";")[0] };
}
async function details(page) {
 const path = detailsLink(page.html); assert.ok(path);
 const r = await fetch(page.origin + path, { headers: { cookie: page.cookie } }); assert.equal(r.status, 200); return r.text();
}
async function indexRequest(index, path) { const url = new URL(index.url); url.pathname = path; return fetch(url, { redirect: "manual" }); }
async function view(index, id) { const r = await indexRequest(index, "/open/" + id); assert.equal(r.status, 302); return bootstrap(r.headers.get("location")); }
async function until(fn) { for (let i = 0; i < 200; i++) { const x = await fn(); if (x) return x; await new Promise(r => setTimeout(r, 20)); } throw new Error("Timed out"); }

test("Agent turn details: session/index/merged/global wiring, history/live capture and separate opt-in credentials", { skip: !pandoc, timeout: 60_000 }, async t => {
 const base = await realpath(await mkdtemp(join(tmpdir(), "preview-turn-watch-"))); t.after(() => rm(base, { recursive: true, force: true }));
 const cwd = join(base, "project"), roots = { pi: join(base, "pi"), claude: join(base, "claude"), codex: join(base, "codex"), opencode: join(base, "absent.db") };
 await mkdir(cwd); await mkdir(join(roots.pi, piSessionDirName(cwd)), { recursive: true }); await mkdir(join(roots.claude, claudeProjectDirName(cwd)), { recursive: true });
 const piPath = join(roots.pi, piSessionDirName(cwd), "trace.jsonl");
 await writeFile(piPath, line({ type: "session", cwd }) + line({ type: "session_info", name: "Synthetic Pi" })
  + line(pi("u1", null, "user", "PI_INPUT_ONE", -6000)) + line(pi("a1", "u1", "assistant", "Pi first answer", -5000))
  + line(pi("u2", "a1", "user", "PI_INPUT_TWO", -4000)) + line(pi("a2", "u2", "assistant", "Pi second answer", -3000)));
 const claudePath = join(roots.claude, claudeProjectDirName(cwd), "trace.jsonl");
 await writeFile(claudePath, line({ type: "ai-title", aiTitle: "Synthetic Claude" })
  + line({ type: "user", uuid: "cu", parentUuid: null, cwd, timestamp: time(-2000), message: { role: "user", content: "CLAUDE_INPUT" } })
  + line({ type: "assistant", uuid: "ca-part", parentUuid: "cu", timestamp: time(-1100), message: { role: "assistant", id: "ca", stop_reason: null, content: text("Claude first block") } })
  + line({ type: "assistant", uuid: "ca", parentUuid: "ca-part", timestamp: time(-1000), message: { role: "assistant", id: "ca", stop_reason: "end_turn", content: text("Claude answer") } }));
 const options = { cwd, roots, agents: ["pi", "claude"], style: styleForMode("light"), stateDir: join(base, "state"), rescanMs: 50, tailIntervalMs: 25 };
 const ordinary = await startSessionIndex(options); t.after(() => ordinary.close());
 const oldToken = new URL(ordinary.url).searchParams.get("token");
 const sessions = (await (await indexRequest(ordinary, "/api/sessions")).json()).sessions;
 const piId = sessions.find(s => s.agent === "pi").id;
 assert.equal(detailsLink((await view(ordinary, piId)).html), undefined);
 await ordinary.close();
 const enabled = await startSessionIndex({ ...options, turnDetails: true }); t.after(() => enabled.close());
 assert.equal(enabled.reused, false);
 assert.ok(oldToken !== new URL(enabled.url).searchParams.get("token"));
 const oldLink = new URL(enabled.url); oldLink.searchParams.set("token", oldToken);
 assert.equal((await fetch(oldLink)).status, 403, "Previously shared ordinary-index credentials cannot expose traces.");
 const piPage = await view(enabled, piId); assert.doesNotMatch(piPage.html, /PI_INPUT/);
 const current = await details(piPage); assert.match(current, /PI_INPUT_TWO/); assert.doesNotMatch(current, /PI_INPUT_ONE|CLAUDE_INPUT/);
 const firstPageResponse = await fetch(piPage.origin + "/?revision=1", { headers: { cookie: piPage.cookie } });
 const oldPage = { ...piPage, html: await firstPageResponse.text() };
 assert.match(await details(oldPage), /PI_INPUT_ONE/);
 const merged = await view(enabled, "all"); assert.match(await details(merged), /CLAUDE_INPUT/);
 await appendFile(piPath, line(pi("u3", "a2", "user", "PI_INPUT_LATEST", 0)) + line(pi("a3", "u3", "assistant", "Newest Pi answer", 1)));
 const latest = await until(async () => {
  const r = await fetch(piPage.origin, { headers: { cookie: piPage.cookie } }); const html = await r.text();
  return html.includes("Newest Pi answer") ? { ...piPage, html } : undefined;
 });
 assert.match(await details(latest), /PI_INPUT_LATEST/); assert.doesNotMatch(await details(piPage), /PI_INPUT_LATEST/);
 const global = await startSessionIndex({ ...options, allProjects: true, turnDetails: true }); t.after(() => global.close());
 const groups = (await (await indexRequest(global, "/api/sessions")).json()).projects;
 assert.equal(groups.length, 1); assert.match(await details(await view(global, groups[0].id)), /PI_INPUT_LATEST/);
 const pinned = await startResponseWatch({ ...options, turnDetails: true, sessionPath: claudePath, sessionAgent: "claude" }); t.after(() => pinned.close());
 const pinnedPage=await bootstrap(pinned.url);assert.match(pinnedPage.html,/Claude first block/);assert.match(pinnedPage.html,/Claude answer/);
 assert.match(await details(pinnedPage), /CLAUDE_INPUT/);
 await enabled.close();
 const restarted = await startSessionIndex({ ...options, turnDetails: true }); t.after(() => restarted.close());
 assert.equal(restarted.reused, true, "Opted-in previews still support quiet reconnects within their own scope.");
});
