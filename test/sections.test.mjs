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

test("sections parsed on their own keep distinct footnote and code-line IDs", { skip }, async () => {
	const section = (word, note, code) => `${word}[^1]\n\n[^1]: ${note}\n\n\`\`\`python\n${code}\n\`\`\`\n`;
	const { html } = await renderPreviewHtmlDocument([section("Answer", "FIRST_NOTE", "x = 1"), section("Snapshot", "SECOND_NOTE", "y = 2")], styleForMode("light"), process.cwd(), false, 16);
	const ids = [...body(html).matchAll(/\sid="([^"]+)"/g)].map(match => match[1]).filter(id => id !== "preview-root");
	assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], "no duplicate IDs");
	for (const [prefix, note] of [["", "FIRST_NOTE"], ["s1-", "SECOND_NOTE"]]) {
		assert.match(html, new RegExp(`href="#${prefix}fn1"`), `${prefix || "first"}: the reference links to its own note`);
		assert.match(html, new RegExp(`id="${prefix}fn1"[^>]*>[^]*?${note}`));
		assert.match(html, new RegExp(`id="${prefix}cb1"`));
	}
});

test("annotation placeholders are never substituted inside code, highlighted or not, in one section or several", { skip: skip || (!browserPath && "no test browser"), timeout: 30_000 }, async t => {
	const dir = mkdtempSync(join(tmpdir(), "amp-sections-"));
	const { default: puppeteer } = await import("puppeteer-core");
	const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ["--no-sandbox"] });
	t.after(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });
	const answer = "Answer [an: ANSWER_NOTE]";
	const code = '```python\nprint("PIMDPREVIEWANNOT0TOKEN")\n```\n\n`PIMDPREVIEWANNOT0TOKEN`\n';
	for (const [name, markdown] of [["one section", `${answer}\n\n${code}`], ["two sections", [answer, code]]]) {
		const file = join(dir, `${name.replace(" ", "-")}.html`);
		writeFileSync(file, (await renderPreviewHtmlDocument(markdown, styleForMode("light"), dir, false, 16)).html);
		const page = await browser.newPage();
		await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
		await page.waitForFunction(() => window.__mermaidDone === true);
		const seen = await page.evaluate(() => ({ marker: document.querySelector(".annotation-marker")?.textContent, block: document.querySelector("pre")?.textContent, inline: document.querySelector("p code")?.textContent }));
		assert.equal(seen.marker, "ANSWER_NOTE", `${name}: the answer's annotation is rendered`);
		assert.equal(seen.block, 'print("PIMDPREVIEWANNOT0TOKEN")', `${name}: highlighted code is unchanged`);
		assert.equal(seen.inline, "PIMDPREVIEWANNOT0TOKEN", `${name}: inline code is unchanged`);
		await page.close();
	}
});
