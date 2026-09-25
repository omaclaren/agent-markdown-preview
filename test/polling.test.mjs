import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserWatchServer } from "../dist/shared/browser-watch-server.js";

const statePath = "/__pi_markdown_preview_state__";
const doc = text => `<!doctype html><html><head><title>Test</title></head><body><main id="preview-root"><p id="body">${text}</p></main></body></html>`;

test("polling is finite, authenticated and identity-bound, with expiring viewer leases", { timeout: 15_000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "amp-polling-"));
	const server = await createBrowserWatchServer(doc("First"), root);
	t.after(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });
	const first = await fetch(server.url);
	const cookie = first.headers.get("set-cookie").split(";")[0];
	const html = await first.text();
	assert.doesNotMatch(html, /new EventSource/);
	assert.match(html, /document.hidden \? 1000 : 200/);
	const url = new URL(statePath, server.url);
	assert.equal((await fetch(url)).status, 403);
	const initial = await (await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(1000) })).json();
	assert.equal(initial.revision, 1);
	assert.equal(server.clientCount, 0);
	url.searchParams.set("client", "a".repeat(32));
	url.searchParams.set("identity", "wrong");
	assert.equal((await fetch(url, { headers: { cookie } })).status, 409);
	assert.equal(server.clientCount, 0);
	url.searchParams.set("identity", initial.identity);
	await (await fetch(url, { headers: { cookie } })).json();
	assert.equal(server.clientCount, 1);
	server.updateDocument(doc("Second"));
	const updated = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(1000) });
	assert.equal(updated.headers.get("cache-control"), "no-store");
	assert.deepEqual((await updated.json()).revisions, [1, 2]);
	assert.equal(server.clientCount, 1, "a poll renews one lease rather than adding a new client");
	url.searchParams.set("closed", "1");
	assert.equal((await fetch(url, { method: "POST", headers: { cookie } })).status, 204);
	assert.equal(server.clientCount, 0);
	url.searchParams.delete("closed");
	await (await fetch(url, { headers: { cookie } })).json();
	await new Promise(done => setTimeout(done, 5100));
	assert.equal(server.clientCount, 0, "a vanished page cannot keep an open indicator indefinitely");
});

const browserPath = process.env.PUPPETEER_EXECUTABLE_PATH;
test("eight tabs can load, navigate and follow updates without starving browser connections", {
	skip: !browserPath && "set PUPPETEER_EXECUTABLE_PATH to a test browser", timeout: 45_000,
}, async t => {
	const { default: puppeteer } = await import("puppeteer-core");
	const root = mkdtempSync(join(tmpdir(), "amp-polling-browser-"));
	const server = await createBrowserWatchServer(doc("Waiting"), root, { initialDocumentIsHistory: false });
	let browser;
	t.after(async () => { await browser?.close(); await server.close(); rmSync(root, { recursive: true, force: true }); });
	browser = await puppeteer.launch({ executablePath: browserPath, headless: true, userDataDir: join(root, "profile") });
	const waiting = await browser.newPage();
	await waiting.goto(server.url, { waitUntil: "load" });
	for (let n = 0; n < 2; n++) await waiting.waitForResponse(response => new URL(response.url()).pathname === statePath);
	assert.equal(await waiting.$eval('[data-watch-control="count"]', el => el.textContent), "Waiting", "unchanged polls preserve the waiting state");
	const firstAnswer = waiting.waitForNavigation({ waitUntil: "load" });
	server.updateDocument(doc("First"));
	await firstAnswer;
	assert.equal(await waiting.$eval('[data-watch-control="count"]', el => el.textContent), "1/1");
	await waiting.close();
	server.updateDocument(doc("Second"));
	const tabs = [], errors = [], legacyStreams = [];
	for (let n = 0; n < 8; n++) {
		const tab = await browser.newPage();
		tabs.push(tab);
		tab.on("pageerror", error => errors.push(String(error)));
		tab.on("request", request => { if (new URL(request.url()).pathname.endsWith("_events__")) legacyStreams.push(request.url()); });
		await tab.goto(server.url, { waitUntil: "load", timeout: 3000 });
	}
	assert.deepEqual(legacyStreams, []);
	const page = tabs.at(-1);
	await page.bringToFront();
	await page.click('[data-watch-control="toggle"]');
	await Promise.all([page.waitForNavigation({ waitUntil: "load", timeout: 3000 }), page.click('[data-watch-control="previous"]')]);
	assert.equal(await page.$eval("#body", el => el.textContent), "First");
	server.updateDocument(doc("Third"));
	await page.waitForFunction(() => !document.querySelector('[data-watch-control="new"]').hidden);
	assert.equal(await page.$eval("#body", el => el.textContent), "First", "reading history must not auto-follow");
	await Promise.all([page.waitForNavigation({ waitUntil: "load", timeout: 3000 }), page.click('[data-watch-control="latest"]')]);
	assert.equal(await page.$eval("#body", el => el.textContent), "Third");
	const updated = page.waitForNavigation({ waitUntil: "load", timeout: 3000 });
	server.updateDocument(doc("Fourth"));
	await updated;
	assert.equal(await page.$eval("#body", el => el.textContent), "Fourth");
	assert.deepEqual(errors, []);
});
