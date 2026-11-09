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
const {desktopProvider,readManagedDesktopPackage}=require('../packages/app-runtime/src/managed-app-definitions/remote-desktop/index.ts');
const {controlledInstancePackageVersionResolver}=require('../packages/core/src/core/package-version.ts');
const version=controlledInstancePackageVersionResolver({})();
const owner={actorId:'actor',deviceSessionId:'device'};
const quote=value=>`'${value.replaceAll("'","'\\''")}'`;
test('provider archive, App queue and real component preserve optional lifecycle and isolate package changes',{timeout:20000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-lifecycle-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const installBaseDir=path.join(dir,'apps'),stateDir=path.join(dir,'state'),root=path.join(installBaseDir,'remote-desktop');
 const artifactRoot=path.join(dir,'artifact');fs.mkdirSync(path.join(artifactRoot,'bin'),{recursive:true});
 // The same production binary runs its control fixture mode; no native input or
 // desktop capture is needed to verify installer/adapter ownership contracts.
 const binary=path.resolve('remote-desktop-rs/target/debug/task-handoff-desktop-streaming');
 fs.writeFileSync(path.join(artifactRoot,'bin/task-handoff-desktop-streaming'),`#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${quote(version)}; exit 0; fi\nif [ "$1" = "--native" ] || [ "$1" = "--virtual" ]; then shift; fi\nexec ${quote(binary)} "$@"\n`,{mode:0o700});
 fs.writeFileSync(path.join(artifactRoot,'desktop-component.json'),JSON.stringify({version}));
 const archive=path.join(dir,'component.tar.gz');await tar.c({cwd:artifactRoot,file:archive,gzip:true},['bin','desktop-component.json']);
 const bytes=fs.readFileSync(archive),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
 const definition=desktopProvider([{version,platform:process.platform,arch:process.arch,url:'https://fixtures.invalid/component.tar.gz',sha256}]).definition({env:{}});
 assert.equal(definition.launchable,false);assert.equal(definition.distribution.recipes.filter(recipe=>recipe.type==="archive").length,1);
 let manager,updates=0,releaseDownload;
 const completed=new Map(),waiters=new Map();
 const service=new DesktopService({dataDir:dir,version,mode:'local',installedPackage:()=>readManagedDesktopPackage(installBaseDir,stateDir),canStart:()=>!manager.hasActiveOperation('remote-desktop'),requestUpdate:()=>{updates++;manager.request('remote-desktop','update');}});
 t.after(()=>service.close());
 const execute=createAppRecipeExecutor({installBaseDir,stateDir,commandRunner:async()=>assert.fail('no system tar'),fetcher:async()=>{if(releaseDownload)await releaseDownload;return new Response(bytes);}});
 manager=new AppManagementManager({stateDir,installBaseDir,definitions:()=>[definition],capabilities:()=>({platform:process.platform,arch:process.arch,installers:[],privilege:'user'}),execute,
  packageLifecycle:()=>({beforeChange:()=>service.beforePackageChange(),changed:(operation,succeeded)=>service.packageChanged(operation,succeeded)}),
  onTerminal:async job=>{await service.refresh();completed.set(job.id,job);waiters.get(job.id)?.(job);},
 });
 const wait=job=>completed.has(job.id)?Promise.resolve(completed.get(job.id)):new Promise(resolve=>waiters.set(job.id,resolve));
 const run=async(operation,id)=>{const job=manager.request('remote-desktop',operation,id);const result=await wait(job);assert.equal(result.state,'succeeded',JSON.stringify(result.error));return result;};
 await manager.refreshSnapshot();await service.reconcile();assert.equal(updates,0);assert.equal(service.componentRunning(),false);
 await run('install','install');assert.equal(service.settings.get().enabled,false);assert.equal(service.componentRunning(),false);
 await service.setEnabled(true);assert.equal(service.componentRunning(),true);
 const first=await service.request('first',{type:'reserve',owner,captureTarget:{kind:'display'}});
 assert.equal(first.type,'reserved');const oldBoot=first.bootId;
 await service.request('attach',{type:'attach',owner,viewerSessionId:first.snapshot.viewerSessionId,captureTarget:{kind:'display'},attachToken:first.attachToken});
 let unlock;releaseDownload=new Promise(resolve=>{unlock=resolve;});
 fs.writeFileSync(path.join(root,'desktop-component.json'),JSON.stringify({version:'older-installed'}));
 await service.reconcile();assert.equal(updates,1);
 await assert.rejects(service.request('during-update',{type:'reserve',owner,captureTarget:{kind:'display'}}),/UPDATING/);
 const update=manager.snapshot().activeJobs.find(job=>job.operation==='update');assert.ok(update);
 unlock();releaseDownload=undefined;assert.equal((await wait(update)).state,'succeeded');
 assert.equal(readManagedDesktopPackage(installBaseDir,stateDir).version,version);assert.equal(service.settings.get().enabled,true);
 await assert.rejects(service.request('old-close',{type:'signalClosed',owner,viewerSessionId:first.snapshot.viewerSessionId},oldBoot),/COMPONENT_UNAVAILABLE/);
 const next=await service.request('next',{type:'reserve',owner,captureTarget:{kind:'display'}});assert.equal(next.type,'reserved');assert.notEqual(next.bootId,oldBoot);
 // A removed/unpublished download recipe must not orphan an owned install.
 definition.distribution.recipes=definition.distribution.recipes.filter(recipe=>recipe.type==='archive-ownership');
 await manager.refreshSnapshot();assert.equal(manager.snapshot().apps[0].canUninstall,true);assert.equal(manager.snapshot().apps[0].canUpdate,false);
 fs.writeFileSync(path.join(root,'user.txt'),'preserved');
 await run('uninstall','uninstall');assert.equal(service.componentRunning(),false);assert.equal(service.settings.get().enabled,false);
 assert.equal(readManagedDesktopPackage(installBaseDir,stateDir),undefined);assert.equal(fs.readFileSync(path.join(root,'user.txt'),'utf8'),'preserved');
 definition.distribution.recipes.push({type:'archive',platforms:[process.platform],arches:[process.arch],privilege:'user',url:'https://fixtures.invalid/component.tar.gz',sha256,format:'tar.gz',installRoot:'remote-desktop'});
 await run('install','reinstall');assert.equal(service.settings.get().enabled,false);assert.equal(service.componentRunning(),false);
 assert.equal(fs.readFileSync(path.join(root,'user.txt'),'utf8'),'preserved');
 const restarted=new DesktopService({dataDir:dir,version,mode:'local',installedPackage:()=>readManagedDesktopPackage(installBaseDir,stateDir),canStart:()=>true});
 assert.equal(restarted.settings.get().enabled,false);await restarted.close();
});

test('disabled installed versions reconcile without spawning; missing packages never install and explicit retry survives failure',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-reconcile-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let installed,requests=0;const service=new DesktopService({dataDir:dir,version:'new',mode:'local',canStart:()=>true,installedPackage:()=>installed,requestUpdate:()=>{requests++;throw Error('fixture unavailable');}});t.after(()=>service.close());
 await service.reconcile();assert.equal(requests,0);
 installed={binary:'/must-not-execute',version:'old'};
 await service.reconcile();assert.equal(requests,1);assert.equal(service.status().reason,'REMOTE_DESKTOP_DISABLED');
 await service.refresh();assert.equal(requests,1);await service.reconcile();assert.equal(requests,2);
 assert.equal(service.componentRunning(),false);
});

test('real Node server projects capability snapshots and publishes only authoritative changes',async t=>{
 const {createWebApp}=require('../packages/controlled-instance/src/web/server.ts');
 const {WebEventBus}=require('../packages/controlled-instance/src/web/events.ts');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-producer-'));
 const keys=['TASK_HANDOFF_DATA_DIR','TASK_HANDOFF_LOG_DIR','TASK_HANDOFF_CONFIG','TASK_HANDOFF_WEB_AUTH','TASK_HANDOFF_AI_SESSION_SCAN','TASK_HANDOFF_NODE_AGENT_URL','TASK_HANDOFF_WEB_TOKEN','TASK_HANDOFF_CONTROL_MODE'];
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 Object.assign(process.env,{TASK_HANDOFF_DATA_DIR:dir,TASK_HANDOFF_LOG_DIR:path.join(dir,'logs'),TASK_HANDOFF_CONFIG:path.join(dir,'config.json'),TASK_HANDOFF_WEB_AUTH:'off',TASK_HANDOFF_AI_SESSION_SCAN:'0',TASK_HANDOFF_WEB_TOKEN:'fixture-web-token',TASK_HANDOFF_CONTROL_MODE:'standalone'});delete process.env.TASK_HANDOFF_NODE_AGENT_URL;
 let installed;const service=new DesktopService({dataDir:dir,version:'1',mode:'local',installedPackage:()=>installed,canStart:()=>true});
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
