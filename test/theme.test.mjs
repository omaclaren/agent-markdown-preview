import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DARK_PREVIEW_PALETTE, LIGHT_PREVIEW_PALETTE, renderPreviewHtmlDocument } from "../dist/render.js";
import { makeThemeAdaptive, styleForMode, themeFinisher } from "../dist/theme.js";
import { startFileWatch } from "../dist/watch.js";

const hasPandoc = !spawnSync(process.env.PANDOC_PATH || "pandoc", ["--version"], { stdio: "ignore" }).error;
const DOC = "# Title\n\nText with `code` and $x^2$.\n\n```python\nprint('hi')\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n```mermaid\nflowchart LR\n  A --> B\n```\n";

test("light and dark pages differ only in colour variables and the Mermaid configuration", { skip: !hasPandoc && "pandoc not installed" }, async () => {
	// The adaptive page relies on this. If the renderer starts baking other
	// theme-specific output into pages, this fails at regeneration time.
	const strip = html => html.replace(/<style>\n:root \{\n[\s\S]*?\n\}/, "ROOT").replace(/\{"startOnLoad":false,"theme":"base","themeVariables":\{[^{}]*\}\}/, "MERMAID");
	const light = await renderPreviewHtmlDocument(DOC, styleForMode("light"), "/tmp", false, 16);
	const dark = await renderPreviewHtmlDocument(DOC, styleForMode("dark"), "/tmp", false, 16);
	assert.notEqual(light.html, dark.html);
	assert.equal(strip(light.html), strip(dark.html));
});

test("adaptive pages carry both palettes and choose Mermaid colours by scheme", { skip: !hasPandoc && "pandoc not installed" }, async () => {
	const light = (await renderPreviewHtmlDocument(DOC, styleForMode("light"), "/tmp", false, 16)).html;
	const adaptive = makeThemeAdaptive(light, 16);
	assert.ok(adaptive);
	assert.match(adaptive, new RegExp(`:root \\{\\n[\\s\\S]*--bg: ${LIGHT_PREVIEW_PALETTE.bg};[\\s\\S]*@media \\(prefers-color-scheme: dark\\) \\{\\n:root \\{\\n[\\s\\S]*--bg: ${DARK_PREVIEW_PALETTE.bg};`));
	assert.match(adaptive, /mermaid\.initialize\(\(window\.matchMedia\?\.\("\(prefers-color-scheme: dark\)"\)\.matches \? \{/);
	assert.match(adaptive, /<meta name="color-scheme" content="light dark" \/>/);
	const dark = (await renderPreviewHtmlDocument(DOC, styleForMode("dark"), "/tmp", false, 16)).html;
	assert.equal(makeThemeAdaptive(dark, 16), null, "only light-rendered pages are converted");
	assert.equal(themeFinisher(false, 16, () => {})(light), light, "fixed themes pass through");
	const logs = [];
	assert.equal(themeFinisher(true, 16, m => logs.push(m))("<html><head></head><body></body></html>"), "<html><head></head><body></body></html>");
	assert.equal(logs.length, 1, "an unexpected page is shown unchanged, with one warning");
});

const browserPath = process.env.PUPPETEER_EXECUTABLE_PATH;
test("a preview follows the system light/dark setting live in a real browser", { skip: (!hasPandoc && "pandoc not installed") || (!browserPath && "set PUPPETEER_EXECUTABLE_PATH to a test browser"), timeout: 60_000 }, async t => {
	const { default: puppeteer } = await import("puppeteer-core");
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "amp-theme-")));
	const file = join(dir, "doc.md");
	writeFileSync(file, DOC);
	const watch = await startFileWatch({ filePath: file, style: styleForMode("light"), followSystemTheme: true, stateDir: null });
	t.after(() => watch.close());
	const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, userDataDir: mkdtempSync(join(tmpdir(), "amp-profile-")) });
	t.after(() => browser.close());
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", error => errors.push(String(error)));
	const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
	await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
	await page.goto(watch.url, { waitUntil: "domcontentloaded" });
	assert.equal(await bg(), DARK_PREVIEW_PALETTE.bg);
	assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), "dark");
	// Mermaid diagrams are redrawn by reloading; plain colours switch in place.
	const diagrams = await page.waitForFunction(() => document.querySelector(".mermaid-container, .mermaid"), { timeout: 15_000 }).then(() => true, () => false);
	const switched = diagrams ? page.waitForNavigation({ waitUntil: "domcontentloaded" }) : Promise.resolve();
	await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
	await switched;
	assert.equal(await bg(), LIGHT_PREVIEW_PALETTE.bg);
	if (!diagrams) t.diagnostic("Mermaid did not load (offline?); reload-on-switch not exercised");
	assert.deepEqual(errors, []);
});

const piThemeModule = (() => {
	for (const root of [process.env.PI_CODING_AGENT_DIR_FOR_TESTS, join(import.meta.dirname, "..", "..", "pi-markdown-preview", "node_modules", "@earendil-works", "pi-coding-agent")].filter(Boolean)) {
		const path = join(root, "dist", "modes", "interactive", "theme", "theme.js");
		if (existsSync(path)) return path;
	}
	return null;
})();

test("bundled pi-studio themes resolve exactly as Pi resolves them", { skip: !piThemeModule && "Pi's theme loader not found beside this checkout" }, async () => {
	const { getPreviewStyle } = await import("../dist/render.js");
	const { BUNDLED_THEMES, loadPiTheme } = await import("../dist/pi-theme.js");
	const pi = await import(piThemeModule);
	for (const path of Object.values(BUNDLED_THEMES)) {
		assert.deepEqual(getPreviewStyle(loadPiTheme(path)), getPreviewStyle(pi.loadThemeFromPath(path, "truecolor")), path);
	}
});

test("the pi-studio pair switches live like the default pair", { skip: !hasPandoc && "pandoc not installed" }, async () => {
	const { styleForPiTheme } = await import("../dist/pi-theme.js");
	const light = styleForPiTheme("pi-studio-light"), dark = styleForPiTheme("pi-studio-dark");
	assert.equal(light.themeMode, "light");
	assert.equal(dark.themeMode, "dark");
	const strip = html => html.replace(/<style>\n:root \{\n[\s\S]*?\n\}/, "ROOT").replace(/\{"startOnLoad":false,"theme":"base","themeVariables":\{[^{}]*\}\}/, "MERMAID");
	const lightHtml = (await renderPreviewHtmlDocument(DOC, light, "/tmp", false, 16)).html;
	const darkHtml = (await renderPreviewHtmlDocument(DOC, dark, "/tmp", false, 16)).html;
	assert.equal(strip(lightHtml), strip(darkHtml));
	const adaptive = makeThemeAdaptive(lightHtml, 16, light, dark);
	assert.ok(adaptive);
	assert.match(adaptive, new RegExp(`@media \\(prefers-color-scheme: dark\\) \\{\\n:root \\{\\n[\\s\\S]*--bg: ${dark.palette.bg};`));
	assert.equal(makeThemeAdaptive(lightHtml, 16), null, "a page is only converted with the pair it was rendered for");
});

test("the CLI accepts the pi-studio themes and rejects unknown ones", { skip: !hasPandoc && "pandoc not installed", timeout: 30_000 }, async () => {
	const { spawn } = await import("node:child_process");
	const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "amp-cli-theme-")));
	const file = join(dir, "doc.md");
	writeFileSync(file, "# Hi\n");
	const bad = spawnSync(process.execPath, [cli, file, "--theme", "nope", "--no-open"], { encoding: "utf8" });
	assert.equal(bad.status, 2);
	assert.match(bad.stderr, /Unknown theme "nope"/);
	const { styleForPiTheme } = await import("../dist/pi-theme.js");
	for (const [theme, bg] of [["pi-studio-dark", styleForPiTheme("pi-studio-dark").palette.bg], ["pi-studio", styleForPiTheme("pi-studio-light").palette.bg]]) {
		const child = spawn(process.execPath, [cli, file, "--theme", theme, "--no-open"], { env: { ...process.env, AGENT_MARKDOWN_PREVIEW_HOME: join(dir, "state") } });
		const url = await new Promise((resolve, reject) => {
			let out = "";
			child.stdout.on("data", chunk => { out += chunk; const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/); if (m) resolve(m[0]); });
			child.once("exit", code => reject(new Error(`CLI exited ${code}`)));
		});
		const html = await (await fetch(url)).text();
		child.kill("SIGINT");
		assert.match(html, new RegExp(`--bg: ${bg};`), theme);
		assert.equal(/prefers-color-scheme: dark/.test(html), theme === "pi-studio", `${theme} follows the system only as a pair`);
	}
});

test("the pi-studio pair follows the system setting in a real browser", { skip: (!hasPandoc && "pandoc not installed") || (!browserPath && "set PUPPETEER_EXECUTABLE_PATH to a test browser"), timeout: 60_000 }, async t => {
	const { default: puppeteer } = await import("puppeteer-core");
	const { styleForPiTheme } = await import("../dist/pi-theme.js");
	const light = styleForPiTheme("pi-studio-light"), dark = styleForPiTheme("pi-studio-dark");
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "amp-theme-")));
	const file = join(dir, "doc.md");
	writeFileSync(file, "# Plain page\n\nNo diagrams, so switching happens in place.\n");
	const watch = await startFileWatch({ filePath: file, style: light, darkStyle: dark, followSystemTheme: true, stateDir: null });
	t.after(() => watch.close());
	const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, userDataDir: mkdtempSync(join(tmpdir(), "amp-profile-")) });
	t.after(() => browser.close());
	const page = await browser.newPage();
	const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
	await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
	await page.goto(watch.url, { waitUntil: "domcontentloaded" });
	assert.equal(await bg(), light.palette.bg);
	await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
	assert.equal(await bg(), dark.palette.bg, "switches in place, without a reload");
});
