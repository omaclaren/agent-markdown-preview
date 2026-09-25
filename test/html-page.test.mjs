import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { startFileWatch, styleForMode } from "../dist/watch.js";

test("HTML file watch renders an isolated page, refreshes and retains historical snapshots", {
	skip: !process.env.PUPPETEER_EXECUTABLE_PATH && "set a dedicated test browser", timeout: 45000,
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "amp-html-page-"));
	const file = join(root, "page.html");
	let watch, browser;
	try {
		const original = '<!doctype html><html><body><h1>Original HTML</h1><script>window.authoredPage=true;</script></body></html>';
		await writeFile(file, original);
		watch = await startFileWatch({ filePath: file, style: styleForMode("light"), stateDir: null, intervalMs: 50, debounceMs: 20 });
		browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, userDataDir: join(root, "browser") });
		const page = await browser.newPage();
		await page.goto(watch.url, { waitUntil: "load" });
		const frame = await (await page.$("iframe")).contentFrame();
		await frame.waitForFunction(() => window.authoredPage === true);
		assert.equal(await page.evaluate(() => window.authoredPage), undefined);
		assert.notEqual(new URL(frame.url()).origin, new URL(page.url()).origin);
		await writeFile(file, original.replace("Original HTML", "Updated HTML"));
		await page.waitForFunction(() => new URL(location.href).searchParams.get("revision") === "2");
		await page.waitForSelector("iframe");
		await (await (await page.$("iframe")).contentFrame()).waitForFunction(() => document.querySelector("h1")?.textContent === "Updated HTML");
		await page.click('[data-watch-control="toggle"]');
		await Promise.all([page.waitForNavigation(), page.click('[data-watch-control="previous"]')]);
		await page.waitForSelector("iframe");
		const historical = await (await page.$("iframe")).contentFrame();
		await historical.waitForFunction(() => document.querySelector("h1")?.textContent === "Original HTML");
		const oldUrl = historical.url();
		await rm(file);
		assert.match(await (await fetch(oldUrl)).text(), /Original HTML/, "the snapshot survives removal of its source file");
		await watch.close();
		await assert.rejects(fetch(oldUrl));
	} finally {
		await browser?.close();
		await watch?.close();
		await rm(root, { recursive: true, force: true });
	}
});
