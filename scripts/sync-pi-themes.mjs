// Maintenance only: resolve Pi's named stock themes with Pi's own colour code.
// No Pi dependency, terminal-theme probing or colour converter ships at runtime.
// Usage: node scripts/sync-pi-themes.mjs /path/to/pi-coding-agent [--check]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const PIN='1.0.4';
const root=process.argv[2];
if(!root)throw new Error('Supply the installed Pi package root (version '+PIN+').');
const packagePath=join(resolve(root),'package.json');
const pkg=JSON.parse(await readFile(packagePath,'utf8'));
assert.equal(pkg.version,PIN,'Update the pin and provenance deliberately when refreshing themes.');
const require=createRequire(packagePath);
const {colorToHex,parseColor}=await import(pathToFileURL(require.resolve('@earendil-works/pi-tui')).href);
const pi=await import(pathToFileURL(join(resolve(root),'dist/modes/interactive/theme/theme.js')).href);
const metadata={package:pkg.name,version:PIN,themes:{}};
for(const mode of ['light','dark']){
 const source=await readFile(join(resolve(root),`dist/modes/interactive/theme/${mode}.json`),'utf8');
 const raw=JSON.parse(source);
 const colour=(value,seen=new Set())=>{
  if(typeof value==='string'&&Object.hasOwn(raw.vars??{},value)){
   assert.ok(!seen.has(value),'Circular colour variable');seen.add(value);return colour(raw.vars[value],seen);
  }
  return value===''?'':colorToHex(parseColor(value));
 };
 const theme={name:mode,appearance:mode,vars:Object.fromEntries(Object.entries(raw.vars??{}).map(([k,v])=>[k,colour(v)])),colors:pi.getResolvedThemeColors(mode),export:pi.getThemeExportColors(mode)};
 const content=JSON.stringify(theme,null,2)+'\n',file=new URL(`../src/themes/pi-${mode}.json`,import.meta.url);
 metadata.themes[mode]={sourceSha256:createHash('sha256').update(source).digest('hex'),resolvedSha256:createHash('sha256').update(content).digest('hex')};
 if(process.argv.includes('--check'))assert.equal(await readFile(file,'utf8'),content,`Stock ${mode} theme has drifted`);
 else await writeFile(file,content);
}
const content=JSON.stringify(metadata,null,2)+'\n',file=new URL('../src/themes/pi-provenance.json',import.meta.url);
if(process.argv.includes('--check'))assert.equal(await readFile(file,'utf8'),content);
else await writeFile(file,content);
console.log('Verified Pi '+PIN+' stock light/dark colours and export backgrounds.');
