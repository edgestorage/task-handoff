const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const ts=require('typescript');
require('./workspace-require.js').registerWorkspaceRequire();
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},fileName:filename}).outputText,filename);
const {readManagedDesktopPackage}=require('../packages/app-runtime/src/managed-app-definitions/remote-desktop/index.ts');
const {DesktopSettings}=require('../packages/controlled-instance/src/remote-desktop/settings.ts');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-package-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const base=path.join(dir,'apps'),root=path.join(base,'remote-desktop'),state=path.join(dir,'state'),manifest=path.join(state,'manifests','remote-desktop.json');
 fs.mkdirSync(path.join(root,'bin'),{recursive:true});fs.mkdirSync(path.dirname(manifest),{recursive:true});
 const binary=path.join(root,'bin/task-handoff-desktop-streaming'),metadata=path.join(root,'desktop-component.json');
 fs.writeFileSync(binary,'test-only', {mode:0o700});fs.writeFileSync(metadata,JSON.stringify({version:'1',future:true}));
 const record={appId:'remote-desktop',installRoot:root,files:['bin/task-handoff-desktop-streaming','desktop-component.json']};fs.writeFileSync(manifest,JSON.stringify(record));
 return {dir,base,root,state,manifest,binary,metadata,record};
}
test('desktop package resolver requires complete owned executable and release metadata',t=>{
 const f=fixture(t);assert.deepEqual(readManagedDesktopPackage(f.base,f.state),{binary:f.binary,version:'1'});
 fs.rmSync(f.manifest);assert.throws(()=>readManagedDesktopPackage(f.base,f.state),/PACKAGE_INVALID/);
 fs.writeFileSync(f.manifest,JSON.stringify({...f.record,files:[]}));assert.throws(()=>readManagedDesktopPackage(f.base,f.state),/PACKAGE_INVALID/);
 fs.writeFileSync(f.manifest,JSON.stringify(f.record));fs.writeFileSync(f.metadata,'{"version":""}');assert.throws(()=>readManagedDesktopPackage(f.base,f.state),/PACKAGE_INVALID/);
});
test('desktop package resolver rejects symlinks and incomplete transaction even with no live root',t=>{
 const f=fixture(t);fs.renameSync(f.binary,path.join(f.dir,'external'));fs.symlinkSync(path.join(f.dir,'external'),f.binary);
 assert.throws(()=>readManagedDesktopPackage(f.base,f.state),/PACKAGE_INVALID/);
 fs.rmSync(f.root,{recursive:true});fs.rmSync(f.manifest);assert.equal(readManagedDesktopPackage(f.base,f.state),undefined);
 fs.writeFileSync(`${f.manifest}.transaction`,'{}');assert.throws(()=>readManagedDesktopPackage(f.base,f.state),/PACKAGE_INVALID/);
});
test('desktop settings sanitize historical data without erasing it and uninstall clears persisted intent',t=>{
 const f=fixture(t),store=new DesktopSettings(f.dir),file=path.join(f.dir,'remote-desktop.json');
 assert.deepEqual(store.get(),{enabled:false});
 for(const [raw,enabled] of [['{}',false],['{"enabled":true,"future":1}',true],['{"enabled":"true"}',false],['invalid',false]]){
   fs.writeFileSync(file,raw);assert.deepEqual(store.get(),{enabled});assert.equal(fs.readFileSync(file,'utf8'),raw);
 }
 store.set(true);assert.equal(new DesktopSettings(f.dir).get().enabled,true);
 store.clear();store.clear();assert.equal(store.get().enabled,false);
});
