/** TEST ONLY: controlled tool stand-in for transport tests, NOT a Wrangler bundling test.
 * Production resolves the real root dependency; this fixture supplies a clearly fake executable
 * only inside a fresh, synthetic temporary project. No production skip flags exist.
 */
import fs from 'node:fs';
import path from 'node:path';
export function installFakeToolchain(source,root){
 for(const name of ['package.json','package-lock.json'])fs.copyFileSync(path.join(source,name),path.join(root,name));
 const pkg=JSON.parse(fs.readFileSync(path.join(source,'package.json')));
 for(const [name,version] of Object.entries({...pkg.dependencies,...pkg.devDependencies})){
   const folder=path.join(root,'node_modules',name);fs.mkdirSync(folder,{recursive:true});
   fs.writeFileSync(path.join(folder,'package.json'),JSON.stringify({name,version,...(name==='wrangler'?{bin:{wrangler:'bin/wrangler.js'}}:{})}));
 }
 const folder=path.join(root,'node_modules/wrangler/bin');fs.mkdirSync(folder,{recursive:true});
 fs.writeFileSync(path.join(folder,'wrangler.js'),`// TEST-ONLY Wrangler upload stand-in; executes the REAL backup guard.\nconst fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=process.env.FAKE_UPGRADE_ROOT,state=process.env.FAKE_UPGRADE_STATE;
if(!root||!state)throw new Error('fake Wrangler may only run in a synthetic test project');
const r=spawnSync(process.execPath,[path.join(root,'scripts/require-safe-upgrade.mjs')],{env:process.env,stdio:'inherit'});
if(r.status!==0)process.exit(r.status||1);
fs.copyFileSync(path.join(root,'src/upgrade-release.js'),path.join(state,'deployed-release.js'));
fs.writeFileSync(path.join(state,'deployed'),'1');fs.appendFileSync(path.join(state,'deploy-count'),'deploy\\n');
if(process.env.FAKE_DEPLOY_LOST_ACK==='1')process.exit(1);
`);
}
