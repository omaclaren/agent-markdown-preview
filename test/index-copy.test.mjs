import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startSessionIndex, styleForMode } from "../dist/watch.js";
import { piSessionDirName } from "../dist/sessions.js";
const pandoc = !spawnSync(process.env.PANDOC_PATH || "pandoc", ["--version"], { stdio: "ignore" }).error;
const line = value => JSON.stringify(value) + "\n";
for (const allProjects of [false, true]) test(`Overview copy links: scoped credentials, no navigation, truthful clipboard handling and polling (${allProjects ? "grouped" : "local"})`, { skip: !pandoc, timeout: 45_000 }, async t => {
 const base = await realpath(await mkdtemp(join(tmpdir(), "preview-index-copy-"))), roots = { pi: join(base, "pi") };
 let index, browser;
 t.after(async () => { await browser?.close(); await index?.close(); await rm(base, { recursive: true, force: true }); });
 const cwd = join(base, "project-one");
 for (const [i, folder] of [cwd, join(base, "project-two")].entries()) {
  await mkdir(folder); const dir = join(roots.pi, piSessionDirName(folder)); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "session.jsonl"), line({ type: "session", cwd: folder }) + line({ type: "session_info", name: "Synthetic project " + i })
   + line({ type: "message", id: "u", parentId: null, message: { role: "user", content: [{ type: "text", text: "Input for project " + i }] } })
   + line({ type: "message", id: "a", parentId: "u", timestamp: new Date().toISOString(), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Answer for project " + i }] } }));
 }
 index = await startSessionIndex({ cwd, roots, agents: ["pi"], allProjects, turnDetails: true, style: styleForMode("light"), followSystemTheme: true, stateDir: null, rescanMs: 50 });
 const baseUrl = new URL(index.url), token = baseUrl.searchParams.get("token");
 const url = path => { const u = new URL(baseUrl); u.pathname = path; return u; };
 const data = await (await fetch(url("/api/sessions"))).json();
 const ids = [data.sessions.find(s => s.cwd === cwd).id, allProjects ? data.projects.find(p => p.cwd === cwd).id : "all"];
 const caps = new Map();
 for (const id of ids) {
  const endpoint = url("/api/preview-link/" + id), bad = new URL(endpoint); bad.searchParams.set("token", "wrong");
  assert.equal((await fetch(bad)).status, 403);
  assert.equal((await fetch(endpoint, { method: "POST" })).status, 405);
  assert.equal((await fetch(endpoint, { method: "HEAD" })).status, 405);
  const response = await fetch(endpoint); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const target = (await response.json()).url, privateUrl = new URL(target); caps.set(id, target);
  assert.ok(privateUrl.searchParams.get("token") !== token, "Copy must not disclose overview credentials.");
  const wider = url("/api/sessions"); wider.searchParams.set("token", privateUrl.searchParams.get("token"));
  assert.equal((await fetch(wider)).status, 403, "The copied capability cannot access the overview.");
  const redirected = await fetch(url("/open/" + id), { redirect: "manual" });
  assert.equal(redirected.status, 302); assert.ok(redirected.headers.get("location") === target);
  const html = await (await fetch(target)).text(); assert.match(html, /Answer for project 0/); assert.doesNotMatch(html, /Answer for project 1/);
  assert.match(html, />Working<\/a>/); assert.ok(!html.includes(token));
 }
 assert.equal((await fetch(url("/api/preview-link/0123456789abcdef"))).status, 404);
 assert.equal((await fetch(url("/api/preview-link/..%2Fsecret"))).status, 404);
 if (allProjects) assert.equal((await fetch(url("/api/preview-link/all"))).status, 404);
 if (!process.env.PUPPETEER_EXECUTABLE_PATH) return;
 const { default: puppeteer } = await import("puppeteer-core");
 browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true, args: ["--no-sandbox"] });
 const page = await browser.newPage(), errors = []; page.on("pageerror", e => errors.push(e.message));
 let requests = 0; page.on("request", r => { if (new URL(r.url()).pathname.startsWith("/api/preview-link/")) requests++; });
 await page.evaluateOnNewDocument(() => {
  const state = window.__copy = { mode: "modern", modern: [], legacy: [] };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => {
   state.modern.push(value); if (state.mode === "pending") return new Promise((resolve, reject) => { state.finish = resolve; state.reject = reject; });
   if (state.mode !== "modern") throw new Error("denied");
  } } });
  document.execCommand = name => {
   if (name !== "copy") throw new Error("unexpected command");
   const event = new ClipboardEvent("copy", { cancelable: true, clipboardData: new DataTransfer() }); document.dispatchEvent(event);
   state.legacy.push({ value: event.clipboardData.getData("text/plain"), types: [...event.clipboardData.types] }); return state.mode === "fallback";
  };
 });
 await page.setViewport({ width: 1000, height: 850 }); await page.goto(index.url); await page.waitForSelector(".copy-preview-link");
 assert.equal(requests, 0, "Merely viewing the overview must not prepare share links.");
 assert.equal(await page.$eval('footer', e => e.textContent), 'Recent sessions (last 3 days). Keep preview links private.');
 const pageCount = (await browser.pages()).length;
 const button = id => `li[data-preview-id="${id}"] > .copy-preview-link`;
 const rowSelector = `li[data-preview-id="${ids[0]}"]`;
 const look = () => page.$eval(rowSelector, row => {
  const a=row.querySelector('a.row'), b=row.querySelector('.copy-preview-link');
  const rect=e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height];};
  const style=e=>{const s=getComputedStyle(e);return {background:s.backgroundColor,border:s.borderColor};};
  return {row:style(row),link:style(a),copy:style(b),rects:[rect(row),rect(a),rect(b)]};
 });
 for (const scheme of ['light','dark']) {
  await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:scheme}]); await page.mouse.move(0,0);
  const before=await look();
  await page.hover(`${rowSelector} > a.row`); const onLink=await look();
  await page.hover(button(ids[0])); const onCopy=await look();
  assert.notEqual(onLink.row.background,before.row.background);
  assert.equal(onCopy.row.background,onLink.row.background,'Crossing onto Copy keeps one continuous row highlight.');
  for(const current of [onLink,onCopy]) {
   assert.equal(current.link.background,'rgba(0, 0, 0, 0)');
   assert.equal(current.copy.background,'rgba(0, 0, 0, 0)');
   assert.equal(current.copy.border,'rgba(0, 0, 0, 0)','Hover does not add a separate button box.');
   assert.deepEqual(current.rects,before.rects,'Hover causes no layout movement.');
  }
  await page.evaluate(()=>refresh()); assert.deepEqual(await look(),onCopy,'Polling preserves the hovered row.');
  assert.ok(await page.$eval(rowSelector,row=>{
   const b=row.querySelector('.copy-preview-link').getBoundingClientRect(),r=row.getBoundingClientRect(),a=row.querySelector('a.row');
   return a.getBoundingClientRect().width===r.width && document.elementFromPoint(b.x+b.width/2,b.y+b.height/2).closest('button')===row.querySelector('button') && document.elementFromPoint(b.x+b.width/2,r.bottom-3).closest('a')===a;
  }),'Copy is a separate hit target; surrounding space remains part of the normal link.');
 }
 await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:'light'}]); await page.mouse.move(0,0);
 if(process.env.INDEX_HOVER_SCREENSHOT_PREFIX && !allProjects) {
  const main=await page.$('main');
  await page.hover(`${rowSelector} > a.row`); await main.screenshot({path:process.env.INDEX_HOVER_SCREENSHOT_PREFIX+'-row.png'});
  await page.hover(button(ids[0])); await main.screenshot({path:process.env.INDEX_HOVER_SCREENSHOT_PREFIX+'-copy.png'});
 }
 const state = (selector, expected) => page.waitForFunction((selector, expected) => document.querySelector(selector)?.dataset.copyState === expected && !document.querySelector(selector)?.hasAttribute("aria-busy"), {}, selector, expected);
 for (const id of ids) {
  const selector = button(id); await page.focus(selector); await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  assert.ok(await page.$eval(`li[data-preview-id="${id}"] > a`,e=>e===document.activeElement && e.matches(':focus-visible') && getComputedStyle(e).outlineWidth==='2px' && getComputedStyle(e).outlineOffset==='-4px'),'Keyboard navigation visibly identifies the link separately from Copy.');
  await page.keyboard.press("Tab");
  assert.ok(await page.$eval(selector, e => e === document.activeElement));
  assert.ok(await page.$eval(selector,e=>e.matches(':focus-visible') && getComputedStyle(e).outlineWidth==='2px' && getComputedStyle(e).outlineOffset==='-3px'),'Keyboard focus remains visible on the actual copy control.');
  await page.keyboard.press("Enter"); await state(selector, "copied");
  assert.ok(await page.evaluate(value => window.__copy.modern.at(-1) === value, caps.get(id)));
  assert.ok(page.url() === index.url); assert.equal((await browser.pages()).length, pageCount, "Copying must not open a tab.");
 }
 const selector = button(ids[0]);
 await page.evaluate(() => { window.__copy.mode = "pending"; }); await page.click(selector); await page.waitForFunction(() => typeof window.__copy.finish === "function");
 const count = requests;
 await page.$eval(selector, e => { window.__button = e; e.click(); e.click(); });
 await page.evaluate(async () => { await refresh(); await refresh(); });
 assert.equal(requests, count); assert.ok(await page.$eval(selector, e => e === window.__button && e === document.activeElement && e.getAttribute("aria-busy") === "true"));
 await page.evaluate(() => window.__copy.finish()); await state(selector, "copied");
 for (const mode of ["fallback", "failed"]) {
  await page.evaluate(mode => { window.__copy.mode = mode; }, mode);
  await page.$eval(selector, e => e.addEventListener("click", () => { const r = document.createRange(); r.selectNodeContents(document.querySelector("h1")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }, { once: true }));
  await page.click(selector); await state(selector, mode === "fallback" ? "copied" : "failed");
  assert.ok(await page.evaluate(value => window.__copy.legacy.at(-1).value === value, caps.get(ids[0])));
  assert.deepEqual(await page.evaluate(() => window.__copy.legacy.at(-1).types), ["text/plain"]);
  assert.equal(await page.$(".copy-buffer"), null);
  if (mode === "fallback") assert.match(await page.evaluate(() => getSelection().toString()), /Agent sessions/);
  else {
   assert.ok(await page.$eval("#copy-panel textarea", (e, value) => e.value === value && e === document.activeElement, caps.get(ids[0])));
   await page.evaluate(() => refresh()); assert.ok(await page.$eval("#copy-panel textarea", e => e === document.activeElement));
   await page.keyboard.press("Escape"); assert.ok(await page.$eval("#copy-panel", e => e.hidden)); assert.ok(await page.$eval(selector, e => e === document.activeElement));
  }
 }
 await page.evaluate(() => { window.__copy.mode = "pending"; window.__copy.reject = undefined; }); await page.click(selector);
 await page.waitForFunction(() => typeof window.__copy.reject === "function"); await page.keyboard.press("Tab");
 const oldLegacy = await page.evaluate(() => window.__copy.legacy.length); await page.evaluate(() => window.__copy.reject(new Error("late denial"))); await state(selector, "failed");
 assert.equal(await page.evaluate(() => window.__copy.legacy.length), oldLegacy); assert.ok(await page.$eval("#copy-panel", e => e.hidden));
 const copiedBeforeFailure = await page.evaluate(() => window.__copy.modern.length);
 await page.evaluate(() => { window.__fetch = window.fetch; window.fetch = (url, options) => String(url).includes('/api/preview-link/') ? Promise.resolve(new Response('Unavailable', { status: 503 })) : window.__fetch(url, options); });
 await page.click(selector); await state(selector, "failed");
 assert.equal(await page.evaluate(() => window.__copy.modern.length), copiedBeforeFailure, "Server errors must not fall back to copying the wider overview link.");
 assert.ok(await page.$eval("#copy-panel", e => e.hidden));
 await page.evaluate(() => { window.fetch = window.__fetch; });
 await page.setViewport({ width: 360, height: 800, isMobile: true, hasTouch: true }); await page.reload(); await page.waitForSelector(selector);
 assert.ok(await page.$eval(selector, e => e.getBoundingClientRect().width >= 44 && e.getBoundingClientRect().height >= 44));
 assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.tap(selector); await state(selector, "copied");
 assert.ok(await page.$eval(`li[data-preview-id="${ids[0]}"] > a`, e => e.target === "_blank" && e.dispatchEvent(new MouseEvent("contextmenu", { cancelable: true, bubbles: true }))));
 if (process.env.INDEX_COPY_SCREENSHOT && allProjects) { await page.setViewport({ width: 1000, height: 780 }); await page.screenshot({ path: process.env.INDEX_COPY_SCREENSHOT, fullPage: true }); }
 assert.deepEqual(errors, []);
});
