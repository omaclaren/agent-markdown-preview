import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createBrowserWatchServer, rewriteBrowserWatchLocalDocumentLinks } from "../dist/shared/browser-watch-server.js";
import { startFileWatch, startResponseWatch, styleForMode } from "../dist/watch.js";

const prefix = "/__pi_markdown_preview_document__/";
const doc = body => `<!doctype html><html><head><title>Test</title><base href="file:///wrong/"></head><body><main id="preview-root">${body}</main><script>window.previewReady = true;</script></body></html>`;
const routes = html => [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map(match => match[1].replaceAll("&amp;", "&"));
const skip = spawnSync(process.env.PANDOC_PATH || "pandoc", ["--version"], { stdio: "ignore" }).error ? "pandoc not installed" : false;
const fixture = () => realpathSync(mkdtempSync(join(tmpdir(), "amp-local-links-")));
const login = async url => {
	const response = await fetch(url);
	return { html: await response.text(), headers: { cookie: response.headers.get("set-cookie").split(";")[0] } };
};

test("local document rewriting preserves fragments and ignores non-links, network and binary targets", () => {
	const seen = [];
	const route = path => { seen.push(path); return `/doc/${seen.length}?identity=test`; };
	const html = rewriteBrowserWatchLocalDocumentLinks([
		'<a href="/other/report%20%26%20notes.md#details" title="Report > other" target="_self" rel="author">Report</a>',
		"<a title=\"see href='private.md'\" href='../docs/résumé.md#intro' download>Other</a>",
		'<a href="file:///outside/notes.tex">TeX</a>',
		'<a href="src/example.py">Code</a>',
		'<a href="notes%23one.md">Hash in filename</a>',
		'<a data-href="private.md" title="href=\'secret.md\'">Not a link</a>',
		'<script>const text = \'<a href="private.md">\';</script>',
		'<style>/* <a href="private.md"> */</style>',
		'<!-- <a href="private.md"> -->',
		'<span title="<a href=\'private.md\'>">Not a link</span>',
		'<textarea><a href="private.md">Text, not a link</textarea>',
	].join("\n"), "/work/project", route, "darwin");
	assert.deepEqual(seen, ["/other/report & notes.md", "/work/docs/résumé.md", "/outside/notes.tex", "/work/project/src/example.py", "/work/project/notes#one.md"]);
	assert.match(html, /href="\/doc\/1\?identity=test#details"/);
	assert.match(html, /href="\/doc\/2\?identity=test#intro"/);
	assert.equal((html.match(/rel="noopener noreferrer"/g) || []).length, 5);
	assert.doesNotMatch(html, /target="_blank"/);
	assert.doesNotMatch(html, /target="_self"|rel="author"| download/);
	for (const href of ["#section", "?revision=2", "https://example.com/report.md", "//example.com/report.md", "file://remote/report.md", "data:text/plain,report.md", "javascript:alert('report.md')", "archive.zip", "../.env", "bad%00.md", "bad%XX.md"]) {
		const input = `<a href="${href}">keep</a>`;
		assert.equal(rewriteBrowserWatchLocalDocumentLinks(input, "/work", () => { throw new Error("unexpected route"); }), input, href);
	}
});

test("document routes require auth and an exact retained link, preserve CSP, and expire with history", { timeout: 15_000 }, async t => {
	const root = fixture();
	writeFileSync(join(root, "report.md"), "report");
	writeFileSync(join(root, "private.md"), "not linked");
	let calls = 0;
	const server = await createBrowserWatchServer(doc('<a href="report.md#part">Report</a>'), root, {
		historyLimit: 1,
		renderLocalDocument: async path => { calls++; assert.equal(path, join(root, "report.md")); return doc('<h1 id="part">Rendered report</h1>'); },
	});
	t.after(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });
	const { html, headers } = await login(server.url);
	const url = new URL(routes(html)[0], server.url);
	assert.equal(url.hash, "#part");
	assert.equal(calls, 0, "merely rendering a response does not read its linked documents");
	assert.equal((await fetch(url)).status, 403);
	const wrong = new URL(url); wrong.searchParams.set("identity", "wrong");
	assert.equal((await fetch(wrong, { headers })).status, 409);
	assert.equal((await fetch(url, { headers, method: "POST" })).status, 405);
	assert.equal((await fetch(url, { headers, method: "HEAD" })).status, 200);
	assert.equal(calls, 0, "HEAD doesn't start rendering either");
	const response = await fetch(url, { headers });
	assert.equal(response.status, 200);
	const preview = await response.text();
	assert.match(preview, /Rendered report/);
	assert.match(preview, /<title>report.md — Markdown Preview<\/title>/);
	assert.doesNotMatch(preview, /<base|data-watch-control/);
	const nonce = preview.match(/<script nonce="([^"]+)"/)[1];
	assert.ok(response.headers.get("content-security-policy").includes(`'nonce-${nonce}'`));
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal(calls, 1);
	for (const route of [`${prefix}${"0".repeat(64)}?path=${join(root, "private.md")}`, `${prefix}${encodeURIComponent(join(root, "private.md"))}`, "/private.md"]) {
		assert.notEqual((await fetch(new URL(route, server.url), { headers })).status, 200);
	}
	server.updateDocument(doc("No links now"));
	assert.equal((await fetch(url, { headers })).status, 404, "opening once isn't an unlimited arbitrary file capability");
});

test("linked file previews resolve nested links and images from the file, reread on refresh, and reject unsafe inputs", { skip, timeout: 45_000 }, async t => {
	const root = fixture();
	const project = join(root, "project"), other = join(root, "other");
	mkdirSync(project); mkdirSync(other);
	const report = join(other, "report & résumé.md");
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1kAAAAASUVORK5CYII=", "base64");
	writeFileSync(join(other, "figure.png"), png);
	writeFileSync(join(other, "code.py"), "print('linked code')\n");
	writeFileSync(report, "# Report\n\n## Details\n\n![Figure](figure.png)\n\n[Code](code.py)\n");
	writeFileSync(join(project, "large.md"), "x".repeat(2 * 1024 * 1024 + 1));
	writeFileSync(join(project, "binary.txt"), Buffer.from([0, 1, 2]));
	writeFileSync(join(project, "invalid.txt"), Buffer.from([0xff, 0xfe]));
	writeFileSync(join(project, "safe.html"), '<script>window.bad = true;</script>\n');
	writeFileSync(join(project, "math.tex"), "\\section{Linked math}\n$E=mc^2$\n");
	const file = join(project, "main.md");
	writeFileSync(file, `[Report](<${report}#details>)\n\n[Relative](<../other/report & résumé.md>)\n\n[File URL](<${pathToFileURL(report).href}>)\n\n[Large](large.md) [Binary](binary.txt) [Invalid](invalid.txt) [Missing](missing.md) [HTML](safe.html) [TeX](math.tex)`);
	const watch = await startFileWatch({ filePath: file, style: styleForMode("light"), stateDir: null });
	t.after(async () => { await watch.close(); rmSync(root, { recursive: true, force: true }); });
	const { html, headers } = await login(watch.url);
	const links = routes(html).filter(href => href.startsWith(prefix)).map(href => new URL(href, watch.url));
	assert.equal(links.length, 9);
	assert.equal(links[0].pathname, links[1].pathname);
	assert.equal(links[0].pathname, links[2].pathname);
	assert.equal(links[0].hash, "#details");
	const rendered = await (await fetch(links[0], { headers })).text();
	assert.match(rendered, /<h1 id="report">Report<\/h1>/);
	assert.match(rendered, /<h2 id="details">Details<\/h2>/);
	const image = rendered.match(/<img\b[^>]*src="([^"]+)"/)[1];
	const imageResponse = await fetch(new URL(image, watch.url), { headers });
	assert.equal(imageResponse.status, 200);
	assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png);
	const codeLink = routes(rendered).find(href => href.startsWith(prefix));
	assert.match(await (await fetch(new URL(codeLink, watch.url), { headers })).text(), /linked code/);
	writeFileSync(report, "# Revised report\n");
	assert.match(await (await fetch(links[0], { headers })).text(), /Revised report/);
	for (const [index, status] of [[3, 413], [4, 415], [5, 415], [6, 404]]) assert.equal((await fetch(links[index], { headers })).status, status);
	const codeHtml = await (await fetch(links[7], { headers })).text();
	assert.doesNotMatch(codeHtml, /<script>window.bad/);
	assert.match(codeHtml.replace(/<[^>]*>/g, ""), /window.bad/);
	assert.match(await (await fetch(links[8], { headers })).text(), /Linked math/);
});

test("agent response links resolve against the monitored project", { skip, timeout: 30_000 }, async t => {
	const root = fixture();
	writeFileSync(join(root, "REPORT.md"), "# Agent report\n");
	const session = join(root, "pinned.jsonl");
	writeFileSync(session, JSON.stringify({ type: "session", cwd: root }) + "\n" + JSON.stringify({
		type: "message", id: "a", timestamp: new Date().toISOString(), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "[Report](REPORT.md)" }] },
	}) + "\n");
	const watch = await startResponseWatch({ cwd: root, sessionPath: session, sessionAgent: "pi", style: styleForMode("dark"), stateDir: null });
	t.after(async () => { await watch.close(); rmSync(root, { recursive: true, force: true }); });
	const { html, headers } = await login(watch.url);
	const link = routes(html).find(href => href.startsWith(prefix));
	assert.ok(link);
	assert.match(await (await fetch(new URL(link, watch.url), { headers })).text(), /Agent report/);
});

const browserPath = process.env.PUPPETEER_EXECUTABLE_PATH;
test("middle-clicking a report opens an isolated new tab with working anchors, images and nested links", {
	skip: skip || (!browserPath && "set PUPPETEER_EXECUTABLE_PATH to a test browser"), timeout: 45_000,
}, async t => {
	const root = fixture();
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "main.md"), "# Source\n\n[Open report](<docs/report with spaces.md#details>)\n");
	writeFileSync(join(root, "docs", "report with spaces.md"), "# Report\n\n## Details\n\n[Next](next.md)\n\n![Figure](figure.svg)\n");
	writeFileSync(join(root, "docs", "next.md"), "# Next document\n");
	writeFileSync(join(root, "docs", "figure.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="green"/></svg>');
	const watch = await startFileWatch({ filePath: join(root, "main.md"), style: styleForMode("light"), stateDir: null });
	let browser;
	t.after(async () => { await browser?.close(); await watch.close(); rmSync(root, { recursive: true, force: true }); });
	const { default: puppeteer } = await import("puppeteer-core");
	browser = await puppeteer.launch({ executablePath: browserPath, headless: true, userDataDir: join(root, "browser") });
	const page = await browser.newPage();
	await page.goto(watch.url, { waitUntil: "load" });
	const popup = browser.waitForTarget(target => target.type() === "page" && target !== page.target() && target.url().includes(prefix), { timeout: 10000 });
	await page.click('#preview-root a[href^="/__pi_markdown_preview_document__/"]', { button: "middle" });
	const report = await (await popup).page();
	await report.waitForSelector("#details");
	assert.equal(new URL(report.url()).hash, "#details");
	assert.equal(await report.evaluate(() => window.opener), null);
	assert.equal(await report.title(), "report with spaces.md — Agent Markdown Preview");
	await report.waitForFunction(() => document.querySelector("#preview-root img")?.naturalWidth === 16);
	assert.equal(await page.$eval("#source", el => el.textContent), "Source", "the response stays in its original tab");
	const nextPopup = browser.waitForTarget(target => target.type() === "page" && target !== page.target() && target !== report.target() && target.url().includes(prefix), { timeout: 10000 });
	await report.click('#preview-root a[href^="/__pi_markdown_preview_document__/"]', { button: "middle" });
	const next = await (await nextPopup).page();
	await next.waitForSelector("#next-document");
	assert.equal(await next.$eval("#next-document", el => el.textContent), "Next document");
	assert.equal(await next.$('[data-watch-control="previous"]'), null, "snapshots don't acquire the source session's history controls");
});
