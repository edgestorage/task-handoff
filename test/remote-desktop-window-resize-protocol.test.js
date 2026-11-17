const assert=require('node:assert/strict');
const fs=require('node:fs');
const test=require('node:test');
const ts=require('typescript');
require('./workspace-require.js').registerWorkspaceRequire();
function compile(source,filename){return ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},fileName:filename}).outputText;}
require.extensions['.ts']=(module,filename)=>module._compile(compile(fs.readFileSync(filename,'utf8'),filename),filename);
const {
  RemoteDesktopWindowResizeFailedPayloadSchema,
  RemoteDesktopWindowResizeRequestSchema,
  RemoteDesktopWindowResizedPayloadSchema,
  normalizeRemoteDesktopCapabilities,
  normalizeRemoteDesktopWindowResize,
  remoteDesktopSupportsWindowResize,
  unsupportedRemoteDesktopCapabilities,
}=require('../packages/protocol/src/remote-desktop.ts');
const fixture=require('../shared/remote-desktop-capability-fixture.json');

test('window resize capability is disabled by default and stays additive',()=>{
  assert.deepEqual(normalizeRemoteDesktopWindowResize(undefined),{available:false,presets:[],fitToViewport:false});
  const legacy=structuredClone(fixture);
  legacy.available=true;
  legacy.status='ready';
  legacy.reason=null;
  delete legacy.features.windowResize;
  const normalized=normalizeRemoteDesktopCapabilities(legacy);
  assert.equal(normalized.available,true);
  assert.deepEqual(normalized.features.windowResize,{available:false,presets:[],fitToViewport:false});
  assert.equal(remoteDesktopSupportsWindowResize(normalized),false);
  assert.deepEqual(unsupportedRemoteDesktopCapabilities(),fixture);
});

test('window resize presets are sanitized without invalidating the capability',()=>{
  const value=normalizeRemoteDesktopWindowResize({
    available:true,
    presets:[
      {width:1280,height:720},
      {width:1280,height:720},
      {width:159,height:900},
      {width:1600.5,height:900},
      {width:1920,height:1080},
    ],
    fitToViewport:true,
    future:true,
  });
  assert.deepEqual(value,{available:true,presets:[{width:1280,height:720},{width:1920,height:1080}],fitToViewport:true});
  assert.deepEqual(normalizeRemoteDesktopWindowResize({available:true,presets:[],fitToViewport:false}),{available:false,presets:[],fitToViewport:false});
});

test('window resize requests require a discriminated valid mode and bounded id',()=>{
  assert.deepEqual(RemoteDesktopWindowResizeRequestSchema.parse({requestId:'r1',mode:'viewport',width:1440,height:900}),{requestId:'r1',mode:'viewport',width:1440,height:900});
  assert.equal(RemoteDesktopWindowResizeRequestSchema.safeParse({requestId:'r1',mode:'preset',width:1280,height:720}).success,true);
  assert.equal(RemoteDesktopWindowResizeRequestSchema.safeParse({requestId:'r1',mode:'preset',width:100,height:720}).success,false);
  assert.equal(RemoteDesktopWindowResizeRequestSchema.safeParse({requestId:'r1',mode:'viewport',width:100,height:900}).success,false);
  assert.equal(RemoteDesktopWindowResizeRequestSchema.safeParse({requestId:'',mode:'viewport',width:1440,height:900}).success,false);
  assert.equal(RemoteDesktopWindowResizeRequestSchema.safeParse({requestId:'x'.repeat(129),mode:'viewport',width:1440,height:900}).success,false);
  assert.equal(RemoteDesktopWindowResizeRequestSchema.safeParse({requestId:'r1',mode:'fit'}).success,false);
  assert.equal(RemoteDesktopWindowResizeRequestSchema.safeParse({requestId:'r1',mode:'other'}).success,false);
});

test('window resize results are strict and carry actual dimensions or a stable failure code',()=>{
  assert.deepEqual(
    RemoteDesktopWindowResizedPayloadSchema.parse({requestId:'r1',mode:'preset',width:1900,height:1060}),
    {requestId:'r1',mode:'preset',width:1900,height:1060},
  );
  assert.deepEqual(
    RemoteDesktopWindowResizedPayloadSchema.parse({requestId:'r1',mode:'viewport',width:1440,height:900}),
    {requestId:'r1',mode:'viewport',width:1440,height:900},
  );
  assert.equal(RemoteDesktopWindowResizedPayloadSchema.safeParse({requestId:'r1',mode:'viewport',width:0,height:900}).success,false);
  assert.equal(RemoteDesktopWindowResizedPayloadSchema.safeParse({requestId:'r1',mode:'viewport',width:1440,height:900,extra:true}).success,false);
  assert.deepEqual(
    RemoteDesktopWindowResizeFailedPayloadSchema.parse({requestId:'r1',code:'REMOTE_DESKTOP_WINDOW_RESIZE_DENIED'}),
    {requestId:'r1',code:'REMOTE_DESKTOP_WINDOW_RESIZE_DENIED'},
  );
  assert.equal(RemoteDesktopWindowResizeFailedPayloadSchema.safeParse({requestId:'r1',code:''}).success,false);
});
