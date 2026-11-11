const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const {execFileSync}=require('node:child_process');
const test=require('node:test');
const ts=require('typescript');
require('./workspace-require.js').registerWorkspaceRequire();
function compile(source,filename){return ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},fileName:filename}).outputText;}
require.extensions['.ts']=(module,filename)=>module._compile(compile(fs.readFileSync(filename,'utf8'),filename),filename);
const {unsupportedRemoteDesktopCapabilities}=require('../packages/protocol/src/remote-desktop.ts');
const {controlledInstanceRemoteDesktopCapabilities,normalizeControlledInstanceCapabilities,ControlledInstanceCapabilitiesSchema}=require('../packages/protocol/src/control-plane.ts');
const fixture=require('../shared/remote-desktop-capability-fixture.json');
test('desktop uses shared disabled capability and malformed data cannot disable base features',()=>{
  assert.deepEqual(unsupportedRemoteDesktopCapabilities(),fixture);
  for(const remoteDesktop of [undefined,null,{}, {...fixture,sourceProviders:undefined},{...fixture,capture:{cursor:'true'}}]){
    const document={features:{tty:true,browserTunnel:true,remoteDesktop}};
    const normalized=normalizeControlledInstanceCapabilities(document);
    assert.equal(normalized.features.tty,true);assert.equal(normalized.features.browserTunnel,true);
    assert.deepEqual(controlledInstanceRemoteDesktopCapabilities(document),fixture);
    assert.equal(ControlledInstanceCapabilitiesSchema.parse(document).features.tty,true);
  }
});
test('future dates, diagnostics, backends and valid limits remain readable',()=>{
  const remoteDesktop={...fixture,available:true,status:'future-status',reason:null,protocolVersion:'2030-01-01',platform:'future-os',sourceProviders:[{kind:'display',available:true,reason:null},{kind:'future-source',available:false,reason:'REMOTE_DESKTOP_FUTURE_PROVIDER'}],capture:{backends:['future-capture'],cursor:true},video:{codecs:['future-codec'],maxWidth:16384,maxHeight:16384,maxFrameRate:240},future:{extra:true}};
  const result=controlledInstanceRemoteDesktopCapabilities({features:{remoteDesktop}});
  assert.equal(result.available,true);assert.equal(result.protocolVersion,'2030-01-01');
  assert.deepEqual(result.sourceProviders.map(provider=>provider.kind),['display','future-source']);assert.equal(result.video.maxFrameRate,240);
  assert.equal(result.future,undefined);
});
test('older components without fallback keep WebRTC available and close only fallback',()=>{
  const legacy={...fixture,available:true,status:'ready',reason:null};
  delete legacy.fallback;
  const result=controlledInstanceRemoteDesktopCapabilities({features:{remoteDesktop:legacy}});
  assert.equal(result.available,true);
  assert.equal(result.fallback.available,false);
  assert.equal(result.fallback.reason,'REMOTE_DESKTOP_FALLBACK_UNSUPPORTED');
});
test('v0.0.50 capability reader accepts additive desktop while new reader accepts old document',()=>{
  const source=execFileSync('git',['show','v0.0.50:packages/protocol/src/control-plane.ts'],{encoding:'utf8'});
  const filename=path.resolve('packages/protocol/src/__v0_0_50_capabilities.ts');
  const baseline=new Module(filename,module);baseline.filename=filename;baseline.paths=Module._nodeModulePaths(path.dirname(filename));baseline._compile(compile(source,filename),filename);
  const old=baseline.exports.ControlledInstanceCapabilitiesSchema.parse({features:{tty:true,remoteDesktop:fixture}});
  assert.equal(old.features.tty,true);
  assert.equal(controlledInstanceRemoteDesktopCapabilities({features:{tty:true}}).available,false);
});
