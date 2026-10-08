/**
 * Local compiler/AST fixtures for the EXACT error shape reported in the build log.
 * These are reconstructed fixtures, NOT a copy of the user's missing source file.
 * This suite uses the installed TypeScript package; production keeps the pinned
 * whole-project tsc check as a separate mandatory step.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {repairLegacyPagesContext} from '../../scripts/compat/legacy-pages-context.mjs';
import {sourceFingerprint} from '../../scripts/upgrade/cloudflare-checkpoints.mjs';
import {RELEASE_CHECKS} from '../../scripts/upgrade/release-checks.mjs';
const require=createRequire(import.meta.url),ts=require('typescript');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
console.log('# Context regression TypeScript: '+ts.version+'; declarations below are a minimal diagnostic fixture, not full Workers types');
const legacy=`// @ts-check\n// synthetic legacy fixture; no production credential or source file\nexport function onRequest(context) {\n  const executionContext = {\n    waitUntil(promise) { context.waitUntil(promise); },\n    passThroughOnException() { context.passThroughOnException(); }\n  };\n  return worker.fetch(context.request, context.env, executionContext);\n}\n`;
function fixture(t,{text=legacy,props='unknown'}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'subs-context-fixture-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
 fs.writeFileSync(path.join(root,'jsconfig.json'),JSON.stringify({compilerOptions:{allowJs:true,checkJs:true,noEmit:true,target:'ES2022',lib:['ES2022'],module:'ESNext',moduleResolution:'Bundler',strict:false,types:[]},include:['src/**/*.js','fixture.d.ts']}));
 fs.writeFileSync(path.join(root,'fixture.d.ts'),`interface ExecutionContext {waitUntil(promise: Promise<unknown>): void;passThroughOnException(): void;readonly props: ${props};}\ndeclare const worker: {fetch(request: unknown, env: unknown, ctx: ExecutionContext): unknown};\n`);
 const file=path.join(root,'src/pages-handler.js');fs.writeFileSync(file,text);return {root,file};
}
function diagnostics(root){
 const cfg=ts.readConfigFile(path.join(root,'jsconfig.json'),ts.sys.readFile);const parsed=ts.parseJsonConfigFileContent(cfg.config,ts.sys,root);
 const p=ts.createProgram({rootNames:parsed.fileNames,options:parsed.options});return ts.getPreEmitDiagnostics(p);
}
function messages(ds){return ds.map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')).join('\n');}

test('reproduces missing-props TS2345, patches it, then REAL compiler accepts the fixture',t=>{
 const {root,file}=fixture(t);const before=diagnostics(root);assert.equal(before.length,1,messages(before));assert.equal(before[0].code,2345);assert.match(messages(before),/props/);
 const result=repairLegacyPagesContext(root,ts);assert.equal(result.status,'repaired');assert.equal(result.changed,1);assert.match(fs.readFileSync(file,'utf8'),/props: \{\}/);
 assert.equal(diagnostics(root).length,0,messages(diagnostics(root)));
 const checked=spawnSync(process.execPath,[require.resolve('typescript/bin/tsc'),'--noEmit','-p',path.join(root,'jsconfig.json')],{encoding:'utf8'});assert.equal(checked.status,0,checked.stdout+checked.stderr);
});
test('preserves every original byte except the property insertion and saves an exact original',t=>{
 const {root,file}=fixture(t);const r=repairLegacyPagesContext(root,ts);const now=fs.readFileSync(file,'utf8');assert.equal(now.replace(' props: {},',''),legacy);assert.equal(fs.readFileSync(path.join(root,r.backup),'utf8'),legacy);
});
test('idempotent on repeat build and restart: no duplicate props, backups or fingerprint drift',t=>{
 const {root,file}=fixture(t);repairLegacyPagesContext(root,ts);const expected=fs.readFileSync(file,'utf8'),hash=sourceFingerprint(root),names=fs.readdirSync(path.join(root,'.compat-backups'));
 for(let n=0;n<2;n++){assert.equal(repairLegacyPagesContext(root,ts).changed,0);assert.equal(fs.readFileSync(file,'utf8'),expected);assert.equal(sourceFingerprint(root),hash);}
 assert.deepEqual(fs.readdirSync(path.join(root,'.compat-backups')),names);
});
test('forwards original request/env, preserves this-bound methods, and provides empty props',t=>{
 const {root,file}=fixture(t);repairLegacyPagesContext(root,ts);const calls=[];
 const context={request:{url:'/synthetic'},env:{notASecret:'fixture'},waitUntil(p){assert.equal(this,context);calls.push(p);},passThroughOnException(){assert.equal(this,context);calls.push('pass');}};
 const fake={fetch(req,env,ctx){assert.equal(req,context.request);assert.equal(env,context.env);assert.equal(Object.keys(ctx.props).length,0);const p=Promise.resolve();ctx.waitUntil(p);ctx.passThroughOnException();return 'response';}};
 const result=vm.runInNewContext(fs.readFileSync(file,'utf8').replace('export function','function')+'\nonRequest(context)',{context,worker:fake});assert.equal(result,'response');assert.equal(calls.length,2);assert.equal(calls[1],'pass');
});
test('inline third-argument object is repaired',t=>{
 const text=`// @ts-check\nexport function onRequest(c){return worker.fetch(c.request,c.env,{waitUntil(p){c.waitUntil(p);},passThroughOnException(){c.passThroughOnException();}});}`;
 const {root}=fixture(t,{text});assert.equal(repairLegacyPagesContext(root,ts).changed,1);assert.equal(diagnostics(root).length,0);
});
test('bound-method property assignments and CRLF/comments are preserved',t=>{
 const text=legacy.replace('waitUntil(promise) { context.waitUntil(promise); }','waitUntil: context.waitUntil.bind(context)').replace('passThroughOnException() { context.passThroughOnException(); }','passThroughOnException: context.passThroughOnException.bind(context)').replaceAll('\n','\r\n');
 const {root,file}=fixture(t,{text});assert.equal(repairLegacyPagesContext(root,ts).changed,1);assert.equal(fs.readFileSync(file,'utf8').replace(' props: {},',''),text);
});
test('parenthesized const and quoted property names are handled',t=>{
 const text=legacy.replace('= {','= ({').replace('  };','  });').replace('waitUntil(promise)','"waitUntil"(promise)').replace('passThroughOnException() {','"passThroughOnException"() {');
 const {root}=fixture(t,{text});assert.equal(repairLegacyPagesContext(root,ts).changed,1);assert.equal(diagnostics(root).length,0);
});
test('same object referenced by two calls is patched just once',t=>{
 const text=legacy.replace('  return worker.fetch','  worker.fetch(context.request, context.env, executionContext);\n  return worker.fetch');const {root}=fixture(t,{text});assert.equal(diagnostics(root).length,2);assert.equal(repairLegacyPagesContext(root,ts).changed,1);assert.equal(diagnostics(root).length,0);
});
test('existing nonempty props are preserved exactly',t=>{
 const text=legacy.replace('= {','= {props:{tenant:"original"},');const {root,file}=fixture(t,{text});assert.equal(repairLegacyPagesContext(root,ts).changed,0);assert.equal(fs.readFileSync(file,'utf8'),text);
});
test('no repair of an unused or unrelated two-method object without compiler error',t=>{
 const text=legacy.replace('  return worker.fetch(context.request, context.env, executionContext);','  return executionContext;');const {root,file}=fixture(t,{text});assert.equal(repairLegacyPagesContext(root,ts).changed,0);assert.equal(fs.readFileSync(file,'utf8'),text);
});
test('clean release without the legacy file is a nonmutating no-op',t=>{
 const {root,file}=fixture(t);fs.unlinkSync(file);assert.equal(repairLegacyPagesContext(root,ts).status,'absent');assert.equal(fs.existsSync(file),false);assert.equal(fs.existsSync(path.join(root,'.compat-backups')),false);
});
test('does not patch a similarly named file outside src/pages-handler.js',t=>{
 const {root,file}=fixture(t);fs.renameSync(file,path.join(root,'src/other.js'));assert.equal(repairLegacyPagesContext(root,ts).status,'absent');assert.equal(fs.readFileSync(path.join(root,'src/other.js'),'utf8'),legacy);
});
test('refuses mutable declarations instead of guessing assignments',t=>{
 const text=legacy.replace('const executionContext','let executionContext');const {root,file}=fixture(t,{text});assert.throws(()=>repairLegacyPagesContext(root,ts),/不是已验证/);assert.equal(fs.readFileSync(file,'utf8'),text);
});
test('refuses spreads or additional properties instead of rewriting an unknown custom adapter',t=>{
 const text=legacy.replace('= {','= {...{},');const {root,file}=fixture(t,{text});assert.throws(()=>repairLegacyPagesContext(root,ts),/不是已验证/);assert.equal(fs.readFileSync(file,'utf8'),text);
});
test('does not invent required props values: compiler validates candidate before write',t=>{
 const {root,file}=fixture(t,{props:'{tenant: string}'});assert.throws(()=>repairLegacyPagesContext(root,ts),/空 props/);assert.equal(fs.readFileSync(file,'utf8'),legacy);assert.equal(fs.existsSync(path.join(root,'.compat-backups')),false);
});
test('syntax failure leaves original file untouched',t=>{
 const text=legacy+'\nconst incomplete = {';const {root,file}=fixture(t,{text});assert.throws(()=>repairLegacyPagesContext(root,ts),/语法错误/);assert.equal(fs.readFileSync(file,'utf8'),text);
});
test('unrelated type errors remain errors after the context-only fix',t=>{
 const text=legacy+'\n/** @type {number} */ const otherError = "not-a-number";';const {root}=fixture(t,{text});assert.equal(repairLegacyPagesContext(root,ts).changed,1);const ds=diagnostics(root);assert.equal(ds.length,1);assert.equal(ds[0].code,2322);
});
test('symbolic-link target is refused',t=>{
 const {root,file}=fixture(t);const actual=path.join(root,'original.js');fs.renameSync(file,actual);fs.symlinkSync(actual,file);assert.throws(()=>repairLegacyPagesContext(root,ts),/符号链接/);assert.equal(fs.readFileSync(actual,'utf8'),legacy);
});
test('full lint is still exact tsc, prelint and release test are mandatory, jsconfig not weakened',()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(repo,'package.json')));assert.equal(pkg.scripts.lint,'tsc --noEmit -p jsconfig.json');assert.equal(pkg.scripts.prelint,'node scripts/repair-pages-context.mjs');assert.ok(RELEASE_CHECKS.includes('lint'));assert.ok(RELEASE_CHECKS.includes('test:context'));
 const cfg=JSON.parse(fs.readFileSync(path.join(repo,'jsconfig.json')));assert.deepEqual(cfg.include,['src/**/*.js']);assert.ok(!cfg.exclude.some(x=>x.includes('pages')));
 const build=fs.readFileSync(path.join(repo,'scripts/build.mjs'),'utf8');assert.ok(build.indexOf("['lint'")<build.indexOf("['check-bundle.mjs'"));
});

test('real npm prelint repairs a legacy checkout, runs real tsc, and a fresh retry is stable',t=>{
 const {root,file}=fixture(t);
 fs.mkdirSync(path.join(root,'scripts/compat'),{recursive:true});
 fs.copyFileSync(path.join(repo,'scripts/repair-pages-context.mjs'),path.join(root,'scripts/repair-pages-context.mjs'));
 fs.copyFileSync(path.join(repo,'scripts/compat/legacy-pages-context.mjs'),path.join(root,'scripts/compat/legacy-pages-context.mjs'));
 fs.mkdirSync(path.join(root,'node_modules/.bin'),{recursive:true});
 const tsDir=path.dirname(require.resolve('typescript/package.json'));
 fs.symlinkSync(tsDir,path.join(root,'node_modules/typescript'),'dir');
 fs.symlinkSync(path.join(tsDir,'bin/tsc'),path.join(root,'node_modules/.bin/tsc'));
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({type:'module',scripts:{prelint:'node scripts/repair-pages-context.mjs',lint:'tsc --noEmit -p jsconfig.json'}}));
 const npm=process.platform==='win32'?'npm.cmd':'npm';
 const run=()=>spawnSync(npm,['--prefix',root,'run','lint'],{cwd:os.tmpdir(),encoding:'utf8',timeout:30000});
 const first=run();assert.equal(first.status,0,first.stdout+first.stderr);assert.match(first.stdout,/ST_CONTEXT_REPAIRED/);assert.match(first.stdout,/tsc --noEmit -p jsconfig.json/);
 const text=fs.readFileSync(file,'utf8'),hash=sourceFingerprint(root);
 const second=run();assert.equal(second.status,0,second.stdout+second.stderr);assert.match(second.stdout,/ST_CONTEXT_UNCHANGED/);assert.equal(fs.readFileSync(file,'utf8'),text);assert.equal(sourceFingerprint(root),hash);
});
