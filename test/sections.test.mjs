import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { renderPreviewHtmlDocument } from "../dist/render.js";
import { replSnapshotMarkdown } from "../dist/shared/repl-snapshot.js";
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

test("a later section's prefix is one no first-section ID starts with, so the answer's headings keep their IDs and can't take a note's or code's", { skip }, async () => {
	const note = "Note[^n]\n\n[^n]: SECOND_NOTE\n";
	const snapshot = replSnapshotMarkdown({ events: [
		{ kind: "tool", label: "Tool: repl_send", text: JSON.stringify({ code: "x = 1" }), callId: "t0" },
		{ kind: "result", label: "Tool result: repl_send", text: "Submitted code:\nx = 1\n\nOutput:\n1", callId: "t0" },
	], notices: [] });
	for (const [answer, later, prefix] of [["# s1-fn1\n\nAnswer\n", note, "s1-1-"], ["# s1-fn1\n\n# s1-1-fn1\n", note, "s1-2-"], ["# s1-cb1\n\nAnswer\n", snapshot, "s1-1-"]]) {
		const { html } = await renderPreviewHtmlDocument([answer, later], styleForMode("light"), process.cwd(), false, 16);
		const ids = [...body(html).matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
		assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], `${JSON.stringify(answer)}: no duplicate IDs`);
		for (const heading of answer.match(/s1-[\w-]+/g)) assert.ok(ids.includes(heading), `the answer keeps ${heading}`);
		if (later === note) {
			assert.equal(/href="#([^"]+)" class="footnote-ref"/.exec(body(html))?.[1], `${prefix}fn1`);
			assert.match(html, new RegExp(`id="${prefix}fn1"[^>]*>[^]*?SECOND_NOTE`), "the reference links to its own note");
		} else assert.ok(ids.includes(`${prefix}cb1`), "the snapshot's code gets the free prefix");
	}
});

test("an unclosed <div> is shown as text, so its ID can't collide with a later section's or escape a section's prefix", { skip }, async () => {
	const note = "Note[^n]\n\n[^n]: SECOND_NOTE\n";
	for (const sections of [["<div id='s1-fn1'>\n\nBody\n", note], ["<div ID=s1-fn1>\n\nBody\n", note], ["Answer\n", '<div id="target">\n\nx\n', '<div id="target">\n\ny\n']]) {
		const { html } = await renderPreviewHtmlDocument(sections, styleForMode("light"), process.cwd(), false, 16);
		// Only IDs in tags: the text shown, <div id="target">, has its quotes unescaped.
		const ids = [...body(html).matchAll(/<[a-z][^<>]*\sid="([^"]+)"/g)].map(match => match[1]);
		assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], `${JSON.stringify(sections[0])}: no duplicate IDs`);
		assert.doesNotMatch(body(html), /<div\b[^>]*\bid\s*=\s*["']?(?:s1-fn1|target)\b/i, "an unclosed <div> keeps no ID");
		assert.match(body(html), /&lt;div (?:id|ID)=/, "it is shown as text");
		if (sections[1] === note) assert.match(html, /href="#s1-fn1" class="footnote-ref"[^]*id="s1-fn1"[^>]*>[^]*?SECOND_NOTE/, "the later section keeps s1-, and its note link works");
	}
});

test("a free prefix is found in one pass over the first section's IDs, however many prefixes they take", { skip, timeout: 120_000 }, async () => {
	const answer = `# s1-fn1\n\n${Array.from({ length: 32_768 }, (_, k) => `[]{#s1-${k + 1}-}`).join(" ")}\n`;
	let last = performance.now(), gap = 0;
	const heartbeat = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 10);
	let html;
	try { ({ html } = await renderPreviewHtmlDocument([answer, "Note[^n]\n\n[^n]: SECOND_NOTE\n"], styleForMode("light"), process.cwd(), false, 16)); }
	finally { clearInterval(heartbeat); }
	assert.match(html, /href="#s1-32769-fn1" class="footnote-ref"/);
	assert.ok(gap < 2000, `the event loop was blocked for ${Math.round(gap)} ms`);
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
