const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const tar=require('tar');
const crypto=require('node:crypto');

test('remote desktop npm packages use their component version, preserve the binary and produce install metadata',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-npm-package-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const binary=path.join(dir,'task-handoff-desktop-streaming');fs.writeFileSync(binary,'#!/bin/sh\nexit 0\n',{mode:0o700});
 const output=path.join(dir,'packages');
 const {packRemoteDesktopPackage,collectRemoteDesktopPackages}=await import('../scripts/remote-desktop-packages.mjs');
 const version='1.2.3';
 const packed=await packRemoteDesktopPackage({version,platform:'linux',arch:'arm64',binary,output});
 assert.equal(packed.metadata.package,'@task-handoff/remote-desktop-linux-arm64');
 assert.equal(packed.metadata.version,version);
 assert.equal(path.basename(packed.archive),`task-handoff-remote-desktop-linux-arm64-${version}.tgz`);
 assert.match(packed.metadata.integrity,/^sha512-/);
 assert.equal(packed.metadata.integrity,`sha512-${crypto.createHash('sha512').update(fs.readFileSync(packed.archive)).digest('base64')}`);
 const entries=[];let manifestSource='';await tar.list({file:packed.archive,onReadEntry:entry=>{entries.push([entry.path,entry.mode]);if(entry.path==='package/package.json')entry.on('data',chunk=>{manifestSource+=chunk});}});
 const executable=entries.find(([name])=>name==='package/bin/task-handoff-desktop-streaming');
 assert.ok(executable);assert.ok((executable[1]&0o111)!==0);
 const packageManifest=JSON.parse(manifestSource);
 assert.deepEqual(packageManifest.repository,require('../package.json').repository);
 const manifest=await collectRemoteDesktopPackages(output,path.join(dir,'metadata.json'));
 assert.deepEqual(manifest.packages,[packed.metadata]);
 await assert.rejects(()=>collectRemoteDesktopPackages(output,path.join(dir,'complete.json'),{complete:true}),/incomplete/i);
 await assert.rejects(()=>packRemoteDesktopPackage({version:'1.2',platform:'linux',arch:'arm64',binary,output}),/semver/i);
});

test('npm is used for distribution while the native installer only downloads verified archives',()=>{
 const root=path.resolve(__dirname,'..');
 const script=fs.readFileSync(path.join(root,'scripts','remote-desktop-packages.mjs'),'utf8');
 const resolver=fs.readFileSync(path.join(root,'packages','app-runtime','src','registry-native-package.ts'),'utf8');
 const executor=fs.readFileSync(path.join(root,'packages','controlled-instance','src','web','app-recipe-executor.ts'),'utf8');
 assert.match(script,/npm", \["pack"/);
 assert.doesNotMatch(resolver,/spawn|execFile|npm (?:install|pack)/);
 assert.doesNotMatch(executor,/executeNativePackage[\s\S]{0,4000}npm (?:install|pack)/);
 assert.match(executor,/if \(recipe\.tarballUrl\)/);
});
