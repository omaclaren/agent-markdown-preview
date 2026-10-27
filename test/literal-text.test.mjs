import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { renderPreviewHtmlDocument } from "../dist/render.js";
import { styleForMode } from "../dist/watch.js";

const skip = spawnSync(process.env.PANDOC_PATH || "pandoc", ["--version"], { stdio: "ignore" }).error ? "pandoc not installed" : false;
const browserPath = process.env.PUPPETEER_EXECUTABLE_PATH;
const body = html => html.slice(html.indexOf('id="preview-root"'));

test("an unclosed <div>, which Pandoc passes through as raw HTML, is shown as text with no ID or attributes", { skip }, async () => {
	for (const markdown of ["<div id='x' onclick=\"alert(1)\">\n\nBody\n", "<div ID=x>\n\nBody\n", "Text\n\n<div id=\"x\">\n<div class=\"kept\">\n\nInner\n\n</div>\n"]) {
		const { html } = await renderPreviewHtmlDocument(markdown, styleForMode("light"), process.cwd(), false, 16);
		assert.doesNotMatch(body(html), /<div\b[^>]*\b(?:id\s*=\s*["']?x\b|onclick)/i, `${JSON.stringify(markdown)}: no element gets the raw ID or handler`);
		assert.match(body(html), /<p>&lt;div (?:id|ID)=/, `${JSON.stringify(markdown)}: the tag is shown as text`);
	}
	const { html } = await renderPreviewHtmlDocument("Text\n\n<div id=\"x\">\n<div class=\"kept\">\n\nInner\n\n</div>\n", styleForMode("light"), process.cwd(), false, 16);
	assert.match(body(html), /<div class="kept">\s*<p>Inner<\/p>\s*<\/div>/, "a balanced div is still a div");
});

test("annotation placeholders are never substituted inside code, highlighted or not", { skip: skip || (!browserPath && "no test browser"), timeout: 30_000 }, async t => {
	const dir = mkdtempSync(join(tmpdir(), "amp-literal-"));
	const { default: puppeteer } = await import("puppeteer-core");
	const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox"] });
	t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });
	const file = join(dir, "page.html");
	writeFileSync(file, (await renderPreviewHtmlDocument('Answer [an: ANSWER_NOTE]\n\n```python\nprint("PIMDPREVIEWANNOT0TOKEN")\n```\n\n`PIMDPREVIEWANNOT0TOKEN`\n', styleForMode("light"), dir, false, 16)).html);
	const page = await browser.newPage();
	await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
	await page.waitForFunction(() => window.__mermaidDone === true);
	const seen = await page.evaluate(() => ({ marker: document.querySelector(".annotation-marker")?.textContent, block: document.querySelector("pre")?.textContent, inline: document.querySelector("p code")?.textContent }));
	assert.equal(seen.marker, "ANSWER_NOTE", "the answer's annotation is rendered");
	assert.equal(seen.block, 'print("PIMDPREVIEWANNOT0TOKEN")', "highlighted code is unchanged");
	assert.equal(seen.inline, "PIMDPREVIEWANNOT0TOKEN", "inline code is unchanged");
});
