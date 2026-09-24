// The extracted renderer must produce exactly the HTML pi-markdown-preview does.
// The reference is a temporary copy of ../pi-markdown-preview (or
// AMP_REFERENCE) with its internal render functions exported, loaded through
// Node's TypeScript transform. Skipped when the reference or pandoc is missing.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, appendFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getPreviewStyle, prepareFilePreview, renderPreviewHtmlDocument, buildBrowserHtmlFromPandocFragment } from "../dist/render.js";
import { styleForMode } from "../dist/watch.js";

const here = dirname(fileURLToPath(import.meta.url));
const reference = resolve(process.env.AMP_REFERENCE ?? join(here, "..", "..", "pi-markdown-preview"));
const hasPandoc = !spawnSync(process.env.PANDOC_PATH || "pandoc", ["--version"], { stdio: "ignore" }).error;
const skip = !existsSync(join(reference, "index.ts")) ? `reference not found at ${reference}` : !hasPandoc ? "pandoc not installed" : false;

const FIXTURES = ["sample.md", "sample.tex", "annotation-markdownish.md", "code-wrapping.md", "pagination.md", "smoke_annotation_math.md", "smoke_annotation_math.diff"];

function referenceRenders(files, styles) {
	const copy = mkdtempSync(join(tmpdir(), "amp-reference-"));
	cpSync(reference, copy, { recursive: true, filter: source => !/[/\\](node_modules|\.git|attachments|context|screenshots)$/.test(source) });
	symlinkSync(join(reference, "node_modules"), join(copy, "node_modules"));
	appendFileSync(join(copy, "index.ts"), "\nexport { renderPreviewHtmlDocument as __render, prepareFilePreview as __prepare, getPreviewStyle as __style, buildBrowserHtmlFromPandocFragment as __fragment };\n");
	const script = join(copy, "__render.mts");
	writeFileSync(script, `
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
const m = await import("./index.ts");
const { files, styles } = JSON.parse(process.argv[2]);
const out = { defaultStyle: m.__style(), results: [] };
for (const style of styles) {
	out.results.push({ name: "waiting", mode: style.themeMode, html: m.__fragment("<p>Waiting</p>", style, "/tmp", [], 16) });
	for (const file of files) {
		const prepared = m.__prepare(file, readFileSync(file, "utf8"));
		const rendered = await m.__render(prepared.markdown, style, dirname(file), prepared.isLatex, 16);
		out.results.push({ name: file, mode: style.themeMode, html: rendered.html });
	}
}
process.stdout.write(JSON.stringify(out));
`);
	const stdout = execFileSync(process.execPath, ["--experimental-transform-types", "--no-warnings", script, JSON.stringify({ files, styles })], { cwd: copy, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
	return JSON.parse(stdout);
}

test("extracted renderer output is byte-identical to pi-markdown-preview's", { skip, timeout: 180_000 }, async () => {
	const files = FIXTURES.map(name => join(reference, "test", name)).filter(existsSync);
	files.push(fileURLToPath(new URL("../src/sessions.ts", import.meta.url))); // a code file
	const styles = [styleForMode("dark"), styleForMode("light")];
	const expected = referenceRenders(files, styles);
	assert.deepEqual(styleForMode("dark"), expected.defaultStyle, "dark style equals pi-markdown-preview's no-theme style");
	assert.deepEqual(getPreviewStyle(), expected.defaultStyle);
	let index = 0;
	for (const style of styles) {
		const waiting = expected.results[index++];
		assert.equal(buildBrowserHtmlFromPandocFragment("<p>Waiting</p>", style, "/tmp", [], 16), waiting.html, `waiting page (${style.themeMode})`);
		for (const file of files) {
			const reference = expected.results[index++];
			const prepared = prepareFilePreview(file, readFileSync(file, "utf8"));
			const rendered = await renderPreviewHtmlDocument(prepared.markdown, style, dirname(file), prepared.isLatex, 16);
			assert.equal(rendered.html.length > 1000, true);
			assert.equal(rendered.html, reference.html, `${basename(file)} (${style.themeMode})`);
		}
	}
	assert.equal(index, expected.results.length);
});
