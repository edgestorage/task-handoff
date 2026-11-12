const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const test=require('node:test');
const tar=require('tar');
const ts=require('typescript');
require('./workspace-require.js').registerWorkspaceRequire();
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},fileName:filename}).outputText,filename);
const {DesktopService}=require('../packages/controlled-instance/src/remote-desktop/service.ts');
const {AppManagementManager}=require('../packages/controlled-instance/src/web/app-management.ts');
const {createAppRecipeExecutor}=require('../packages/controlled-instance/src/web/app-recipe-executor.ts');
const {desktopProvider,readManagedDesktopPackage,removeLegacyManagedDesktopPackage}=require('../packages/app-runtime/src/managed-app-definitions/remote-desktop/index.ts');
const {controlledInstancePackageVersionResolver}=require('../packages/core/src/core/package-version.ts');
const version=controlledInstancePackageVersionResolver({})();
const owner={actorId:'actor',deviceSessionId:'device'};
const quote=value=>`'${value.replaceAll("'","'\\''")}'`;
const integrity=bytes=>`sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;

function mismatchedComponent(directory){
 const binary=path.join(directory,'mismatched-component.js');
 fs.writeFileSync(binary,`#!${process.execPath}\n${[
  'const net=require("node:net");',
  'const args=process.argv.slice(2);',
  'const endpoint=args[args.indexOf("--ipc")+1];',
  'const frame=value=>{const body=Buffer.from(JSON.stringify(value));const head=Buffer.alloc(4);head.writeUInt32BE(body.length);return Buffer.concat([head,body]);};',
  'let buffered=Buffer.alloc(0);',
  'process.stdin.on("data",chunk=>{buffered=Buffer.concat([buffered,chunk]);if(buffered.length<4)return;const length=buffered.readUInt32BE(0);if(buffered.length<length+4)return;const hello=JSON.parse(buffered.subarray(4,length+4).toString("utf8"));process.stdin.pause();const socket=net.createConnection(endpoint);socket.on("connect",()=>socket.write(frame({protocolVersion:"1999-01-01",nonce:hello.nonce})));socket.on("close",()=>process.exit(0));});',
 ].join('\n')}\n`,{mode:0o700});
 return binary;
}

async function nativePackageFixture(dir){
 const binary=path.resolve('remote-desktop-rs/target/debug/task-handoff-desktop-streaming');
 const packageRoot=path.join(dir,'package');fs.mkdirSync(path.join(packageRoot,'bin'),{recursive:true});
 fs.writeFileSync(path.join(packageRoot,'package.json'),JSON.stringify({name:'@task-handoff/remote-desktop-test',version,files:['bin']}));
 fs.writeFileSync(path.join(packageRoot,'bin/task-handoff-desktop-streaming'),`#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${quote(version)}; exit 0; fi\nif [ "$1" = "--native" ] || [ "$1" = "--virtual" ]; then shift; fi\nexec ${quote(binary)} "$@"\n`,{mode:0o700});
 const archive=path.join(dir,'component.tgz');await tar.c({cwd:dir,file:archive,gzip:true,portable:true,noMtime:true},['package']);
 const bytes=fs.readFileSync(archive);return {bytes,archive,integrity:integrity(bytes)};
}

function desktopDefinition(packageIntegrity){
 const definition=desktopProvider([{version,platform:process.platform,arch:process.arch,package:'@task-handoff/remote-desktop-test',integrity:packageIntegrity}]).definition({env:{}});
 assert.equal(definition.launchable,false);
 assert.equal(definition.distribution.recipes.filter(recipe=>recipe.type==='native-package').length,1);
 assert.equal(definition.distribution.recipes.filter(recipe=>recipe.type==='archive-ownership').length,1);
 return definition;
}

function lifecycleManager(options){
 const {stateDir,installBaseDir,definition,bytes,service}=options;
 const completed=new Map(),waiters=new Map();
 const execute=createAppRecipeExecutor({
  installBaseDir,stateDir,
  commandRunner:async command=>command.executable.endsWith('task-handoff-desktop-streaming')?{exitCode:0,stdout:`${version}\n`,stderr:''}:assert.fail('unexpected command'),
  fetcher:async()=>new Response(bytes),
 });
 const manager=new AppManagementManager({stateDir,installBaseDir,definitions:()=>[definition],capabilities:()=>({platform:process.platform,arch:process.arch,installers:[],privilege:'user'}),execute,
  packageLifecycle:()=>({beforeChange:()=>service.beforePackageChange(),changed:(operation,succeeded)=>{if(operation!=='uninstall'&&succeeded)removeLegacyManagedDesktopPackage(installBaseDir,stateDir);return service.packageChanged(operation,succeeded);}}),
  onTerminal:async job=>{await service.refresh();completed.set(job.id,job);waiters.get(job.id)?.(job);},
 });
 const wait=job=>completed.has(job.id)?Promise.resolve(completed.get(job.id)):new Promise(resolve=>waiters.set(job.id,resolve));
 return {manager,run:async(operation,id)=>{const job=manager.request('remote-desktop',operation,id);const result=await wait(job);assert.equal(result.state,'succeeded',JSON.stringify(result.error));return result;}};
}

test('package metadata version never gates a protocol-compatible component',{timeout:20000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-version-compat-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const binary=path.resolve('remote-desktop-rs/target/debug/task-handoff-desktop-streaming');
 const service=new DesktopService({dataDir:dir,mode:'local',canStart:()=>true,installedPackage:()=>({binary,version:'component-previous'})});
 t.after(()=>service.close());
 service.settings.set(true);
 assert.equal(service.status().reason,'REMOTE_DESKTOP_NOT_PROBED');
 await service.refresh();
 assert.equal(service.componentRunning(),true);
 assert.notEqual(service.status().reason,'REMOTE_DESKTOP_VERSION_MISMATCH');
});

test('protocol mismatch requests one App update until the package changes',{timeout:20000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-protocol-update-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let requests=0;const service=new DesktopService({dataDir:dir,mode:'local',canStart:()=>true,installedPackage:()=>({binary:mismatchedComponent(dir),version:'same'}),requestUpdate:()=>{requests++;}});t.after(()=>service.close());
 service.settings.set(true);
 await service.refresh();await new Promise(setImmediate);
 assert.equal(service.status().reason,'REMOTE_DESKTOP_PROTOCOL_MISMATCH');assert.equal(requests,1);
 await service.refresh();await new Promise(setImmediate);assert.equal(requests,1);
 await service.packageChanged('install',true);
 await service.refresh();await new Promise(setImmediate);assert.equal(requests,2);
});

test('native npm package install, real component lifecycle and uninstall share the App ownership boundary',{timeout:20000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-native-lifecycle-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const installBaseDir=path.join(dir,'apps'),stateDir=path.join(dir,'state');
 const fixture=await nativePackageFixture(dir),definition=desktopDefinition(fixture.integrity);
 let manager;
 const service=new DesktopService({dataDir:dir,mode:'local',installedPackage:()=>readManagedDesktopPackage(installBaseDir,stateDir),canStart:()=>!manager.hasActiveOperation('remote-desktop')});
 t.after(()=>service.close());
 const lifecycle=lifecycleManager({stateDir,installBaseDir,definition,bytes:fixture.bytes,service});manager=lifecycle.manager;
 await manager.refreshSnapshot();
 let app=manager.snapshot().apps[0];assert.equal(app.state,'not-installed');assert.equal(app.canInstall,true);
 await lifecycle.run('install','install');
 assert.equal(readManagedDesktopPackage(installBaseDir,stateDir).version,version);
 await service.setEnabled(true);assert.equal(service.componentRunning(),true);
 const first=await service.request('first',{type:'reserve',owner,captureSelection:{sourceRef:'display'}});
 assert.equal(first.type,'reserved');
 await service.request('attach',{type:'attach',owner,viewerSessionId:first.snapshot.viewerSessionId,captureSelection:{sourceRef:'display'},attachToken:first.attachToken});
 await lifecycle.run('uninstall','uninstall');
 assert.equal(service.componentRunning(),false);assert.equal(service.settings.get().enabled,false);assert.equal(readManagedDesktopPackage(installBaseDir,stateDir),undefined);
});

test('legacy archive stays detectable and updates into the native layout without deleting unowned files',{timeout:20000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-archive-migration-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const installBaseDir=path.join(dir,'apps'),stateDir=path.join(dir,'state'),legacyRoot=path.join(installBaseDir,'remote-desktop'),manifestFile=path.join(stateDir,'manifests','remote-desktop.json');
 fs.mkdirSync(path.join(legacyRoot,'bin'),{recursive:true});fs.mkdirSync(path.dirname(manifestFile),{recursive:true});
 fs.writeFileSync(path.join(legacyRoot,'bin/task-handoff-desktop-streaming'),'legacy',{mode:0o700});fs.writeFileSync(path.join(legacyRoot,'desktop-component.json'),JSON.stringify({version:'previous'}));fs.writeFileSync(path.join(legacyRoot,'user.txt'),'preserved');
 fs.writeFileSync(manifestFile,JSON.stringify({appId:'remote-desktop',installRoot:legacyRoot,files:['bin/task-handoff-desktop-streaming','desktop-component.json']}));
 const fixture=await nativePackageFixture(dir),definition=desktopDefinition(fixture.integrity);
 let manager;
 const service=new DesktopService({dataDir:dir,mode:'local',installedPackage:()=>readManagedDesktopPackage(installBaseDir,stateDir),canStart:()=>!manager.hasActiveOperation('remote-desktop')});t.after(()=>service.close());
 const lifecycle=lifecycleManager({stateDir,installBaseDir,definition,bytes:fixture.bytes,service});manager=lifecycle.manager;
 await manager.refreshSnapshot();
 const app=manager.snapshot().apps[0];assert.equal(app.state,'installed');assert.equal(app.canUpdate,true);assert.equal(app.canUninstall,true);
 await lifecycle.run('update','migrate');
 assert.equal(readManagedDesktopPackage(installBaseDir,stateDir).version,version);
 assert.equal(fs.existsSync(path.join(legacyRoot,'bin/task-handoff-desktop-streaming')),false);
 assert.equal(fs.existsSync(path.join(legacyRoot,'desktop-component.json')),false);
 assert.equal(fs.existsSync(manifestFile),false);
 assert.equal(fs.readFileSync(path.join(legacyRoot,'user.txt'),'utf8'),'preserved');
});

test('disabled packages never auto-update from a version difference and explicit retry remains App-owned',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-reconcile-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let installed,requests=0;const service=new DesktopService({dataDir:dir,mode:'local',canStart:()=>true,installedPackage:()=>installed,requestUpdate:()=>{requests++;throw Error('fixture unavailable');}});t.after(()=>service.close());
 await service.reconcile();assert.equal(requests,0);
 installed={binary:'/must-not-execute',version:'old'};
 await service.reconcile();assert.equal(requests,0);assert.equal(service.status().reason,'REMOTE_DESKTOP_DISABLED');
 await service.refresh();assert.equal(requests,0);await service.reconcile();assert.equal(requests,0);
 service.settings.set(true);assert.equal(service.status().reason,'REMOTE_DESKTOP_NOT_PROBED');
 assert.equal(service.componentRunning(),false);
});

test('real Node server projects capability snapshots and publishes only authoritative changes',async t=>{
 const {createWebApp}=require('../packages/controlled-instance/src/web/server.ts');
 const {WebEventBus}=require('../packages/controlled-instance/src/web/events.ts');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-producer-'));
 const keys=['TASK_HANDOFF_DATA_DIR','TASK_HANDOFF_LOG_DIR','TASK_HANDOFF_CONFIG','TASK_HANDOFF_WEB_AUTH','TASK_HANDOFF_AI_SESSION_SCAN','TASK_HANDOFF_NODE_AGENT_URL','TASK_HANDOFF_WEB_TOKEN','TASK_HANDOFF_CONTROL_MODE'];
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 Object.assign(process.env,{TASK_HANDOFF_DATA_DIR:dir,TASK_HANDOFF_LOG_DIR:path.join(dir,'logs'),TASK_HANDOFF_CONFIG:path.join(dir,'config.json'),TASK_HANDOFF_WEB_AUTH:'off',TASK_HANDOFF_AI_SESSION_SCAN:'0',TASK_HANDOFF_WEB_TOKEN:'fixture-web-token',TASK_HANDOFF_CONTROL_MODE:'standalone'});delete process.env.TASK_HANDOFF_NODE_AGENT_URL;
 let installed;const service=new DesktopService({dataDir:dir,mode:'local',installedPackage:()=>installed,canStart:()=>true});
 const events=[],publish=WebEventBus.prototype.publish;
 WebEventBus.prototype.publish=function(type,payload){if(type==='instance.capabilities.changed')events.push(payload);return publish.call(this,type,payload);};
 let web;
 try {
  web=await createWebApp({staticDir:path.join(dir,'missing-static'),logger:false,desktopService:service});await web.ready();
  const capability=async()=>JSON.parse((await web.inject({url:'/api/instance/capabilities'})).payload).data.features.remoteDesktop;
  assert.equal((await capability()).reason,'REMOTE_DESKTOP_NOT_INSTALLED');
  assert.equal((await web.inject({url:'/api/internal/remote-desktop/settings',headers:{authorization:'Bearer fixture-web-token'}})).statusCode,403);
  const initial=events.length;
  await service.refresh();assert.equal(events.length,initial);
  installed={binary:'/must-not-execute',version:'1'};await service.refresh();
  assert.equal(events.length,initial+1);assert.deepEqual(events.at(-1),{});
  const current=await capability();assert.equal(current.reason,'REMOTE_DESKTOP_DISABLED');
  const status=JSON.parse((await web.inject({url:'/api/instance/status'})).payload).data;
  assert.deepEqual(status.capabilities.features.remoteDesktop,current);
  assert.equal(service.componentRunning(),false);
 } finally {
  if(web)await web.close();await service.close();WebEventBus.prototype.publish=publish;
  for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
