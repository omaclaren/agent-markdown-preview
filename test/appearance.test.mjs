import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveTheme, parseAgentTheme, styleForPreset, PRESETS } from '../dist/appearance.js';
import { BUNDLED_THEMES } from '../dist/pi-theme.js';
import { styleForMode, themeFinisher } from '../dist/theme.js';
import { buildBrowserHtmlFromPandocFragment } from '../dist/render.js';
import { previewAppearanceStyle } from '../dist/shared/agent-page-style.js';
import { startSessionIndex, startResponseWatch } from '../dist/watch.js';
import { claudeProjectDirName, piSessionDirName } from '../dist/sessions.js';
const browserPath=process.env.PUPPETEER_EXECUTABLE_PATH;
const pandoc=!spawnSync(process.env.PANDOC_PATH||'pandoc',['--version'],{stdio:'ignore'}).error;
const line=x=>JSON.stringify(x)+'\n';
const content=text=>[{type:'text',text}];
const time=n=>new Date(Date.now()+n).toISOString();
const pi=(id,parentId,role,text,n)=>({type:'message',id,parentId,timestamp:time(n),message:{role,content:content(text),...(role==='assistant'?{stopReason:'stop'}:{})}});
const claude=(id,parentUuid,role,text,n)=>({type:role,uuid:id,parentUuid,timestamp:time(n),message:{role,id,content:content(text),...(role==='assistant'?{stop_reason:'end_turn'}:{})}});

test('Theme resolution separates appearance and palette, preserves legacy defaults, and handles fixed Pi imports honestly',()=>{
 assert.deepEqual(resolveTheme(),resolveTheme('agent','system'));
 assert.deepEqual(resolveTheme('auto').style,styleForMode('light'));
 assert.deepEqual(resolveTheme('dark').style,styleForMode('dark'));
 assert.equal(resolveTheme('dark').followSystemTheme,false);
 for(const name of PRESETS)for(const appearance of ['system','light','dark']){
  const theme=resolveTheme(name,appearance);
  assert.equal(theme.followSystemTheme,appearance==='system');
  assert.equal(theme.style.themeMode,appearance==='dark'?'dark':'light');
  assert.equal(resolveTheme(`${name}-dark`).style.themeMode,'dark');
  assert.equal(resolveTheme(`${name}-dark`,'light').style.themeMode,'light');
  if(appearance==='system')assert.equal(theme.darkStyle.themeMode,'dark');
  const html=themeFinisher(theme.followSystemTheme,19,()=>{},theme.style,theme.darkStyle)(buildBrowserHtmlFromPandocFragment('<p>Example</p>',theme.style,undefined,[],19));
  const css=previewAppearanceStyle(html);
  assert.ok(css.includes(`--bg:${theme.style.palette.bg};`));
  assert.equal(css.includes('@media'),appearance==='system');
 }
 const byAgent=resolveTheme('agent','dark');
 assert.equal(byAgent.style.palette.bg,styleForPreset('neutral','dark').palette.bg);
 for(const agent of ['claude','codex','opencode','pi'])assert.equal(byAgent.agentThemes[agent].style.palette.bg,styleForPreset(agent,'dark').palette.bg);
 assert.equal(resolveTheme('agent').agentThemes.pi.followSystemTheme,true);
 assert.throws(()=>resolveTheme('unknown'),/Unknown theme/);
 assert.throws(()=>resolveTheme('claude','nope'),/--appearance/);
 assert.equal(resolveTheme(BUNDLED_THEMES['pi-studio-dark']).followSystemTheme,false);
 assert.throws(()=>resolveTheme(BUNDLED_THEMES['pi-studio-dark'],'system'),/single Pi theme file/i);
 assert.throws(()=>resolveTheme(BUNDLED_THEMES['pi-studio-dark'],'light'),/fixed dark/);
});

test('Per-agent overrides leave neutral overview and other agents unchanged; invalid combinations reject',()=>{
 const normal=resolveTheme(),override=resolveTheme('agent',undefined,{pi:'pi-studio'});
 assert.deepEqual(override.style,normal.style);assert.deepEqual(override.agentThemes.claude,normal.agentThemes.claude);
 assert.deepEqual(override.agentThemes.pi,resolveTheme('pi-studio'));
 assert.deepEqual(resolveTheme('agent','light',{pi:'pi-studio-dark'}).agentThemes.pi,resolveTheme('pi-studio','light'));
 assert.deepEqual(parseAgentTheme('pi=/a=b/theme.json'),['pi','/a=b/theme.json']);
 for(const value of ['pi','pi=','=pi','unknown=pi','pi=agent'])assert.throws(()=>parseAgentTheme(value),/--agent-theme/);
 assert.throws(()=>resolveTheme('neutral',undefined,{pi:'pi-studio'}),/requires --theme agent/);
 assert.throws(()=>resolveTheme('agent',undefined,{pi:'agent'}),/recursive/);
 assert.throws(()=>resolveTheme('agent',undefined,{claude:'unknown'}),/Unknown theme/);
 assert.throws(()=>resolveTheme('agent','system',{pi:BUNDLED_THEMES['pi-dark']}),/single Pi theme/);
});

const luminance=hex=>{const c=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;};
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
test('New preview palettes keep body, muted, link and code text readable on every surface',()=>{
 for(const name of ['neutral','claude','codex','opencode'])for(const mode of ['light','dark']){
  const p=styleForPreset(name,mode).palette;
  for(const foreground of ['text','muted','accent','mdHeading','mdLink','mdCode','mdCodeBlock','mdQuote'])for(const background of ['bg','card','panel2'])
   assert.ok(contrast(p[foreground],p[background])>=4.5,`${name}/${mode}: ${foreground} on ${background}: ${contrast(p[foreground],p[background])}`);
 }
});

async function fixture(t){
 const base=await realpath(await mkdtemp(join(tmpdir(),'amp-appearance-'))),cwd=join(base,'project');await mkdir(cwd);
 const roots={pi:join(base,'pi'),claude:join(base,'claude'),codex:join(base,'codex'),opencode:join(base,'absent.db')};
 await mkdir(join(roots.pi,piSessionDirName(cwd)),{recursive:true});await mkdir(join(roots.claude,claudeProjectDirName(cwd)),{recursive:true});
 const piPath=join(roots.pi,piSessionDirName(cwd),'demo.jsonl'),claudePath=join(roots.claude,claudeProjectDirName(cwd),'demo.jsonl');
 const answer=name=>`# ${name} example\n\nA synthetic answer. [Notes](notes.md) [File](sample.zip) [HTML](page.html)\n\n\`\`\`python\nprint("example")\n\`\`\`\n`;
 await writeFile(piPath,line({type:'session',cwd})+line(pi('p1',null,'user','Pi input',-5000))+line(pi('p2','p1','assistant',answer('Pi'),-4000)));
 await writeFile(claudePath,line({...claude('c1',null,'user','Claude input',-3000),cwd})+line(claude('c2','c1','assistant',answer('Claude'),-2000)));
 await writeFile(join(cwd,'notes.md'),'# Linked notes\n\nKeep the source palette.');await writeFile(join(cwd,'sample.zip'),'Synthetic non-previewable fixture');await writeFile(join(cwd,'page.html'),'<p>Authored HTML stays isolated.</p>');
 const owned=[];let browser;
 t.after(async()=>{await browser?.close();for(const w of owned.reverse())await w.close();await rm(base,{recursive:true,force:true});});
 if(browserPath){const {default:puppeteer}=await import('puppeteer-core');browser=await puppeteer.launch({executablePath:browserPath,headless:true,args:['--no-sandbox']});}
 return {base,cwd,roots,piPath,claudePath,browser,own:x=>(owned.push(x),x),options:{cwd,roots,agents:['pi','claude'],turnDetails:true,stateDir:null,rescanMs:50,tailIntervalMs:25}};
}
test('CLI defaults select stock Pi per response and allow a Pi-only Studio override', {skip:!pandoc,timeout:30000},async t=>{
 const f=await fixture(t);
 for(const override of [false,true]){
  const child=spawn(process.execPath,[new URL('../dist/cli.js',import.meta.url).pathname,'--agent','pi','--session',f.piPath,'--turn-details','--no-open',...(override?['--agent-theme','pi=neutral','--agent-theme','pi=pi-studio']:[])],{env:{...process.env,AGENT_MARKDOWN_PREVIEW_HOME:join(f.base,'state')}});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  const exited=new Promise(resolve=>child.once('exit',resolve));
  try{
   let url;for(let n=0;n<200&&!url;n++){
    if(child.exitCode!==null)throw new Error('CLI exited: '+err);
    url=out.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0];if(!url)await new Promise(r=>setTimeout(r,25));
   }
   assert.ok(url);const response=await fetch(url),cookie=response.headers.get('set-cookie').split(';')[0],html=await response.text();
   const expected=styleForPreset(override?'pi-studio':'pi','light').palette.bg;
   assert.ok(previewAppearanceStyle(html).includes(`--bg:${expected};`));
   const route=html.match(/data-watch-control="turn-details" href="([^"]+)"/)[1].replaceAll('&amp;','&');
   const working=await (await fetch(new URL(route,url),{headers:{cookie}})).text();assert.ok(working.includes(`--bg:${expected};`));
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);await exited;clearTimeout(timer);}
 }
});

const select=name=>`[data-watch-control="${name}"]`;
const bg=page=>page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
const mode=(page,value)=>page.emulateMediaFeatures([{name:'prefers-color-scheme',value}]);
async function indexData(index){const u=new URL(index.url);u.pathname='/api/sessions';return (await fetch(u)).json();}
async function target(index,id){const u=new URL(index.url);u.pathname='/api/preview-link/'+id;return (await (await fetch(u)).json()).url;}

test('Overview, response, Working and linked shells honour fixed and system palettes, without changing authored HTML', {skip:!pandoc||!browserPath,timeout:60000},async t=>{
 const f=await fixture(t),a=await f.browser.newPage(),b=await f.browser.newPage();
 for(const appearance of ['light','dark','system']){
  const index=f.own(await startSessionIndex({...f.options,...resolveTheme('claude',appearance)}));
  const sessions=(await indexData(index)).sessions, url=await target(index,sessions.find(s=>s.agent==='claude').id);
  await a.goto(index.url);await b.goto(url,{waitUntil:'domcontentloaded'});
  for(const system of ['dark','light']){
   await mode(a,system);await mode(b,system);const expected=styleForPreset('claude',appearance==='system'?system:appearance).palette.bg;
   assert.equal(await bg(a),expected,'Overview respects selected appearance, not always system');assert.equal(await bg(b),expected);
   const preview=b.url();await b.click(select('turn-details'));await b.waitForSelector('.prompt');assert.equal(await bg(b),expected);
   assert.equal(await b.$eval('h1',e=>e.textContent),'Working');
   assert.equal(await b.$eval(select('toggle'),e=>e.textContent.includes('Response')),false);
   assert.ok(await b.$eval(select('copy-link'),e=>e.getClientRects().length&&e.parentElement.tagName==='NAV'));
   await b.goto(preview,{waitUntil:'domcontentloaded'});
   const links=await b.$$eval('#preview-root a',nodes=>nodes.map(n=>n.href));
   for(const link of links){await b.goto(link,{waitUntil:'domcontentloaded'});assert.equal(await bg(b),expected,'Linked text/path/HTML shell uses source palette');}
   await b.goto(preview,{waitUntil:'domcontentloaded'});
  }
  await index.close();
 }
});

test('Agent selection follows each retained and live response in merged history; Working and linked documents retain that selection', {skip:!pandoc||!browserPath,timeout:60000},async t=>{
 const f=await fixture(t),page=await f.browser.newPage();
 const watch=f.own(await startResponseWatch({...f.options,...resolveTheme('agent'),historyFill:20}));
 await mode(page,'dark');await page.goto(watch.url,{waitUntil:'domcontentloaded'});
 assert.equal(await bg(page),styleForPreset('claude','dark').palette.bg);
 await page.click(select('toggle'));await page.click(select('previous'));await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='Pi example');
 assert.equal(await bg(page),styleForPreset('pi','dark').palette.bg);
 const piUrl=page.url();await page.click(select('turn-details'));await page.waitForSelector('.prompt');assert.equal(await bg(page),styleForPreset('pi','dark').palette.bg);
 await page.goto(piUrl,{waitUntil:'domcontentloaded'});const notes=await page.$eval('#preview-root a',e=>e.href);await page.goto(notes,{waitUntil:'domcontentloaded'});
 assert.equal(await bg(page),styleForPreset('pi','dark').palette.bg,'Not the newest response\'s Claude theme');
 await page.goto(watch.url,{waitUntil:'domcontentloaded'});
 await appendFile(f.piPath,line(pi('p3','p2','user','New Pi input',0))+line(pi('p4','p3','assistant','# New Pi response',1)));
 await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='New Pi response');assert.equal(await bg(page),styleForPreset('pi','dark').palette.bg);
 await mode(page,'light');assert.equal(await bg(page),styleForPreset('pi','light').palette.bg);
 const index=f.own(await startSessionIndex({...f.options,...resolveTheme('agent','dark')}));await page.goto(index.url);assert.equal(await bg(page),styleForPreset('neutral','dark').palette.bg,'Mixed overview remains neutral but honours forced dark');
});
