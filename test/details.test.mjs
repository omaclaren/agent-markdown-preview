import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { renderPreviewHtmlDocument } from "../dist/render.js";
import { styleForMode } from "../dist/watch.js";

const skip = spawnSync(process.env.PANDOC_PATH || "pandoc", ["--version"], { stdio: "ignore" }).error ? "pandoc not installed" : false;

test("a <details> block renders collapsible, with raw HTML still off; quoted and attributed tags stay literal", { skip }, async () => {
	const markdown = "<details>\n<summary>Argument aliases</summary>\n\n- Pick: `-p`\n\n</details>\n\n`<details>`\n\n<details onclick=\"x\">\nUnsafe\n</details>\n";
	const { html } = await renderPreviewHtmlDocument(markdown, styleForMode("light"), process.cwd(), false, 16);
	assert.match(html, /<details class="pi-preview-details"><summary>Argument aliases<\/summary>\s*<ul>\s*<li>Pick: <code>-p<\/code><\/li>/);
	assert.match(html, /<code>&lt;details&gt;<\/code>/, "code stays literal");
	assert.match(html, /&lt;details onclick=/, "an attributed tag stays literal text");
	assert.doesNotMatch(html, /<details onclick/);
});

test("rendered content can't carry event handlers or script URLs, from Markdown or LaTeX", { skip }, async () => {
	const style = styleForMode("light");
	const markdown = '::: {.review onclick="x" ONMOUSEOVER="y"}\nTRIGGER [link](#){onclick="x"} `code`{onclick="x"}\n:::\n\n[js](javascript:alert(1)) ![img](javascript:alert(1)) [ok](https://example.com)\n\n# Heading {onclick="x"}\n';
	const body = html => html.slice(html.indexOf('id="preview-root"'));
	const rendered = (await renderPreviewHtmlDocument(markdown, style, process.cwd(), false, 16)).html;
	assert.doesNotMatch(body(rendered), /\son[a-z]+=|javascript:/i);
	assert.match(rendered, /<a href="https:\/\/example\.com">ok<\/a>/);
	const latex = (await renderPreviewHtmlDocument("\\href{javascript:alert(1)}{latex link} \\href{https://example.com}{ok}", style, process.cwd(), true, 16)).html;
	assert.doesNotMatch(body(latex), /javascript:/i);
});
