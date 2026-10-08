import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSessionIndex, styleForMode } from "../dist/watch.js";
import { buildBrowserHtmlFromPandocFragment } from "../dist/render.js";
import { themeFinisher } from "../dist/theme.js";
import { AGENT_PAGE_STYLE, applyPreviewAppearance } from "../dist/shared/agent-page-style.js";
import { buildTurnDetailsPage } from "../dist/shared/turn-details-page.js";
import { buildHtmlPagePreview } from "../dist/shared/html-page-preview.js";
import { buildLocalPathPage } from "../dist/shared/local-path-page.js";
import { addBrowserWatchLocalPathControls } from "../dist/shared/local-path-controls.js";

test("Overview, working and file-action pages share light/dark palette, type scale, panel borders and width; HTML wrapper shares the utility theme", { timeout: 30_000 }, async t => {
 const base = await mkdtemp(join(tmpdir(), "preview-session-style-")); let index, browser;
 t.after(async () => { await browser?.close(); await index?.close(); await rm(base, { recursive: true, force: true }); });
 index = await startSessionIndex({ cwd: base, agents: ["pi"], roots: { pi: join(base, "absent") }, stateDir: null, style: styleForMode("light"), followSystemTheme: true });
 const working = buildTurnDetailsPage({ events: [{ kind: "result", label: "Tool result: Bash", text: "ok\nok", callId: "one-call" }], notices: ["A recorded-history note."] }, "#", "Synthetic style check");
 const pathPage = addBrowserWatchLocalPathControls(buildLocalPathPage("/example/file.md", "file"), new Map(), "/example/file.md", { url: "/unused", key: "synthetic", kind: "file", previewable: false });
 const wrapper = addBrowserWatchLocalPathControls(buildHtmlPagePreview("about:blank", "demo.html", "<p>Inert source</p>").replace("<body>", '<body><nav class="pi-preview-document-nav"><a href="#">Return to preview</a></nav>'), new Map(), "/example/demo.html");
 const reference = themeFinisher(true,14,()=>{})(buildBrowserHtmlFromPandocFragment("",styleForMode("light"),undefined,[],14));
 const styled = html => applyPreviewAppearance(html,reference);
 const overview = await (await fetch(index.url)).text();
 assert.ok(overview.includes(AGENT_PAGE_STYLE)); assert.ok(working.includes(AGENT_PAGE_STYLE)); assert.ok(pathPage.includes(AGENT_PAGE_STYLE));
 assert.ok(!overview.includes("/*__AGENT_PAGE_STYLE__*/"));
 if (!process.env.PUPPETEER_EXECUTABLE_PATH) return;
 const { default: puppeteer } = await import("puppeteer-core");
 browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ["--no-sandbox"] });
 const a = await browser.newPage(), b = await browser.newPage(), c = await browser.newPage(), d = await browser.newPage(); await a.goto(index.url); await a.waitForSelector("#list > .all"); await b.setContent(styled(working)); await c.setContent(styled(pathPage)); await d.setContent(styled(wrapper));
 const metrics = (page, selector) => page.evaluate(selector => {
  const body = getComputedStyle(document.body), heading = getComputedStyle(document.querySelector("h1")), main = getComputedStyle(document.querySelector("main")), panel = getComputedStyle(document.querySelector(selector));
  return { background: body.backgroundColor, foreground: body.color, font: body.font, heading: heading.font, width: main.maxWidth, padding: main.padding,
   panel: panel.backgroundColor, border: panel.borderColor, radius: panel.borderRadius };
 }, selector);
 for (const scheme of ["light", "dark"]) for (const width of [1000, 360]) {
  for (const page of [a, b, c, d]) { await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]); await page.setViewport({ width, height: 750 }); }
  assert.deepEqual(await metrics(a, "#list"), await metrics(b, ".event"), `${scheme} at ${width}px`);
  const { padding: overviewPadding, ...overviewStyle } = await metrics(a, "#list");
  const { padding: pathPadding, ...pathStyle } = await metrics(c, ".local-path");
  assert.deepEqual(overviewStyle, pathStyle, `File actions: ${scheme} at ${width}px`);
  assert.deepEqual(await d.evaluate(() => {
   const body = getComputedStyle(document.body), nav = getComputedStyle(document.querySelector('.pi-preview-document-nav'));
   return { background: body.backgroundColor, foreground: body.color, font: body.font, panel: nav.backgroundColor, border: nav.borderColor };
  }), Object.fromEntries(['background', 'foreground', 'font', 'panel', 'border'].map(k => [k, overviewStyle[k]])), `HTML toolbar: ${scheme} at ${width}px`);
  assert.equal(await d.$eval('main', e => e.getBoundingClientRect().width), width, 'HTML viewer retains a full-width layout.');
  assert.equal(await b.$eval('.notices', e => getComputedStyle(e).borderLeftWidth), '0px');
  await b.$eval('.result', e => e.open = true);
  assert.equal(await b.$eval('.result pre', e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)', 'Text uses its card surface, not an inverted background.');
  // File actions retain clearance for their floating Return/copy navigation.
  assert.ok(parseFloat(pathPadding) >= 96);
  assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await c.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await c.$eval('[data-native-action="open"]', e => e.getBoundingClientRect().height >= 44));
 }
 assert.equal(await b.$$eval(".result", nodes => nodes.length), 1);
 assert.equal(await b.$eval(".result pre", e => e.textContent), "ok\nok", "Repeated stdout lines are not duplicate cards and must be preserved.");
});
