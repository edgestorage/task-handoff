const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const ts=require('typescript');
require('./workspace-require.js').registerWorkspaceRequire();
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},fileName:filename}).outputText,filename);
const {readManagedDesktopPackage,removeLegacyManagedDesktopPackage}=require('../packages/app-runtime/src/managed-app-definitions/remote-desktop/index.ts');
const {DesktopSettings}=require('../packages/controlled-instance/src/remote-desktop/settings.ts');
const integrity=`sha512-${Buffer.alloc(64,1).toString('base64')}`;
function root(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-package-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return {dir,base:path.join(dir,'apps'),state:path.join(dir,'state')};
}
function nativeFixture(t){
 const f=root(t),installRoot=path.join(f.base,'native','remote-desktop'),binary=path.join(installRoot,'bin/task-handoff-desktop-streaming'),manifest=path.join(installRoot,'managed-app.json');
 fs.mkdirSync(path.dirname(binary),{recursive:true});fs.writeFileSync(binary,'test-only',{mode:0o700});
 const record={schemaVersion:1,appId:'remote-desktop',version:'1',package:'@task-handoff/remote-desktop-linux-x64',packageVersion:'1',integrity,installRoot,launchPath:'bin/task-handoff-desktop-streaming',files:['bin/task-handoff-desktop-streaming','managed-app.json']};
 fs.writeFileSync(manifest,JSON.stringify(record));
 return {...f,installRoot,binary,manifest,record};
}
function archiveFixture(t){
 const f=root(t),installRoot=path.join(f.base,'remote-desktop'),state=path.join(f.dir,'state'),manifest=path.join(state,'manifests','remote-desktop.json');
 fs.mkdirSync(path.join(installRoot,'bin'),{recursive:true});fs.mkdirSync(path.dirname(manifest),{recursive:true});
 const binary=path.join(installRoot,'bin/task-handoff-desktop-streaming'),metadata=path.join(installRoot,'desktop-component.json');
 fs.writeFileSync(binary,'test-only',{mode:0o700});fs.writeFileSync(metadata,JSON.stringify({version:'legacy',future:true}));
 const record={appId:'remote-desktop',installRoot,files:['bin/task-handoff-desktop-streaming','desktop-component.json']};fs.writeFileSync(manifest,JSON.stringify(record));
 return {...f,installRoot,manifest,binary,metadata,record};
}
test('native package resolver owns only its manifest launcher and executable file',t=>{
 const f=nativeFixture(t);assert.deepEqual(readManagedDesktopPackage(f.base,f.state),{binary:f.binary,version:'1'});
 fs.writeFileSync(f.manifest,JSON.stringify({...f.record,launchPath:'bin/../../outside'}));assert.throws(()=>readManagedDesktopPackage(f.base,f.state),/PACKAGE_INVALID/);
 fs.writeFileSync(f.manifest,JSON.stringify(f.record));fs.chmodSync(f.binary,0o600);assert.throws(()=>readManagedDesktopPackage(f.base,f.state),/PACKAGE_INVALID/);
});
test('legacy archive remains usable and is replaced by a complete native package without deleting unowned files',t=>{
 const f=archiveFixture(t);assert.deepEqual(readManagedDesktopPackage(f.base,f.state),{binary:f.binary,version:'legacy'});
 fs.writeFileSync(path.join(f.installRoot,'user.txt'),'preserved');
 const nativeRoot=path.join(f.base,'native','remote-desktop'),binary=path.join(nativeRoot,'bin/task-handoff-desktop-streaming'),manifest=path.join(nativeRoot,'managed-app.json');
 fs.mkdirSync(path.dirname(binary),{recursive:true});fs.writeFileSync(binary,'native',{mode:0o700});
 fs.writeFileSync(manifest,JSON.stringify({...f.record,schemaVersion:1,version:'2',package:'@task-handoff/remote-desktop-linux-x64',packageVersion:'2',integrity,installRoot:nativeRoot,launchPath:'bin/task-handoff-desktop-streaming',files:['bin/task-handoff-desktop-streaming','managed-app.json']}));
 assert.deepEqual(readManagedDesktopPackage(f.base,f.state),{binary,version:'2'});
 assert.equal(removeLegacyManagedDesktopPackage(f.base,f.state),true);
 assert.equal(fs.existsSync(f.binary),false);assert.equal(fs.existsSync(f.metadata),false);assert.equal(fs.existsSync(f.manifest),false);assert.equal(fs.readFileSync(path.join(f.installRoot,'user.txt'),'utf8'),'preserved');
});
test('desktop package resolver rejects symlinks and incomplete archive transactions even with no live root',t=>{
 const f=archiveFixture(t);fs.renameSync(f.binary,path.join(f.dir,'external'));fs.symlinkSync(path.join(f.dir,'external'),f.binary);
 assert.throws(()=>readManagedDesktopPackage(f.base,f.state),/PACKAGE_INVALID/);
 fs.rmSync(f.installRoot,{recursive:true});fs.rmSync(f.manifest);assert.equal(readManagedDesktopPackage(f.base,f.state),undefined);
 fs.writeFileSync(`${f.manifest}.transaction`,'{}');assert.throws(()=>readManagedDesktopPackage(f.base,f.state),/PACKAGE_INVALID/);
});
test('desktop settings sanitize historical data without erasing it and uninstall clears persisted intent',t=>{
 const f=root(t),store=new DesktopSettings(f.dir),file=path.join(f.dir,'remote-desktop.json');
 assert.deepEqual(store.get(),{enabled:false});
 for(const [raw,enabled] of [['{}',false],['{"enabled":true,"future":1}',true],['{"enabled":"true"}',false],['invalid',false]]){
   fs.writeFileSync(file,raw);assert.deepEqual(store.get(),{enabled});assert.equal(fs.readFileSync(file,'utf8'),raw);
 }
 store.set(true);assert.equal(new DesktopSettings(f.dir).get().enabled,true);
 store.clear();store.clear();assert.equal(store.get().enabled,false);
});
