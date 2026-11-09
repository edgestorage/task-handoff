const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter,once}=require('node:events');
const test=require('node:test');
const Fastify=require('fastify');
const websocket=require('@fastify/websocket');
const {WebSocketServer}=require('ws');
const ts=require('typescript');
require('./workspace-require.js').registerWorkspaceRequire();
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},fileName:filename}).outputText,filename);
const {DesktopService}=require('../packages/controlled-instance/src/remote-desktop/service.ts');
const {registerDesktopRoutes}=require('../packages/controlled-instance/src/remote-desktop/routes.ts');
const {REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL}=require('../packages/protocol/src/remote-desktop.ts');
const owner={actorId:'actor',deviceSessionId:'device'};
function service(t,extra={}){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-service-'));
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  const instance=new DesktopService({dataDir,version:'1',mode:'local',installedPackage:()=>undefined,canStart:()=>true,...extra});
  t.after(()=>instance.close());return instance;
}
async function appFor(t,instance){
  const app=Fastify({logger:false});await app.register(websocket);
  registerDesktopRoutes(app,instance,()=> 'trusted');await app.ready();
  t.after(async()=>{for(const socket of app.websocketServer.clients)socket.terminate();await app.close();});return app;
}
const headers={authorization:'Bearer trusted'};
test('desktop routes require header credential and validate nested input before invoking component',async t=>{
  const instance=service(t);let calls=0;instance.request=async()=>{calls++;throw Error('unexpected');};
  const app=await appFor(t,instance);
  for(const authorization of [undefined,'Bearer wrong']){
    const r=await app.inject({url:'/api/internal/remote-desktop/settings?token=trusted',headers:authorization?{authorization}:{}});
    assert.equal(r.statusCode,403);assert.equal(r.headers['cache-control'],'no-store');
  }
  for(const payload of [
    {requestId:'r',owner:{...owner,extra:1},captureTarget:{kind:'display'}},
    {requestId:'r',owner,captureTarget:{kind:'display',windowRef:'forged'}},
    {requestId:'r',owner,captureTarget:{kind:'window',windowRef:''}},
  ])assert.equal((await app.inject({method:'POST',url:'/api/internal/remote-desktop/reserve',headers,payload})).statusCode,400);
  assert.equal(calls,0);
  assert.equal((await app.inject({method:'PUT',url:'/api/internal/remote-desktop/settings',headers,payload:{enabled:true,extra:1}})).statusCode,400);
  assert.equal(instance.settings.get().enabled,false);
});
test('no package, disabled state, uninstall and drain never spawn an implicit component',async t=>{
  let installed;const instance=service(t,{installedPackage:()=>installed});
  const command={type:'listWindows',owner};
  await assert.rejects(instance.request('r',command),/NOT_INSTALLED/);
  installed={binary:'/must-not-be-executed',version:'1'};
  await assert.rejects(instance.request('r',command),/DISABLED/);
  await instance.setEnabled(true);
  await instance.packageChanged('uninstall',false);assert.equal(instance.settings.get().enabled,true);
  await instance.packageChanged('uninstall',true);assert.equal(instance.settings.get().enabled,false);
  await instance.setEnabled(true);await instance.close();
  await assert.rejects(instance.request('r',command),/UPDATING/);
  await assert.rejects(instance.setEnabled(true),/UPDATING/);
  assert.equal(instance.componentRunning(),false);
});
test('invalid attach cannot close the valid session; disconnect during pending attach closes late success',{timeout:5000},async t=>{
  const instance=new EventEmitter();const calls=[];let release,closedBinding;
  const bindingClosed=new Promise(resolve=>{closedBinding=resolve;});
  instance.componentRunning=()=>true;
  instance.request=async(id,command,boot)=>{
    calls.push({command,boot});
    if(command.type==='attach'){
      if(command.attachToken==='invalid')return {type:'error',code:'ATTACH_INVALID'};
      await new Promise(resolve=>{release=resolve;});
      return {type:'snapshot',bootId:'boot',snapshot:{viewerSessionId:'viewer',sessionRevision:1}};
    }
    if(command.type==='signalClosed')closedBinding();
    return {type:'ok'};
  };
  const app=await appFor(t,instance);
  const attach={requestId:'r',owner,viewerSessionId:'viewer',captureTarget:{kind:'display'},attachToken:'invalid'};
  let client=await app.injectWS('/api/internal/remote-desktop/attach',{headers});
  const closed=once(client,'close');client.send(JSON.stringify(attach));await closed;
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.map(x=>x.command.type),['attach']);
  client=await app.injectWS('/api/internal/remote-desktop/attach',{headers});
  client.send(JSON.stringify({...attach,attachToken:'valid'}));
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  const serverSocket=[...app.websocketServer.clients].at(-1);
  const disconnected=once(serverSocket,'close');serverSocket.terminate();await disconnected;release();
  await bindingClosed;
  assert.deepEqual(calls.map(x=>x.command.type),['attach','attach','signalClosed']);
  assert.equal(calls[2].boot,'boot');
});

test('attach binding forwards configureIce and candidates to the component',{timeout:5000},async t=>{
  const instance=new EventEmitter();const calls=[];const replies=[];
  instance.componentRunning=()=>true;
  instance.request=async(id,command,boot)=>{
    calls.push({id,command,boot});
    if(command.type==='attach')return {type:'snapshot',bootId:'boot',snapshot:{viewerSessionId:'viewer',sessionRevision:1}};
    return {type:'acknowledged'};
  };
  const app=await appFor(t,instance);
  const client=await app.injectWS('/api/internal/remote-desktop/attach',{headers});
  client.on('message',data=>replies.push(JSON.parse(data.toString())));
  client.send(JSON.stringify({requestId:'a',owner,viewerSessionId:'viewer',captureTarget:{kind:'display'},attachToken:'valid'}));
  const wait=async(predicate)=>{while(!predicate())await new Promise(resolve=>setImmediate(resolve));};
  await wait(()=>replies.some(message=>message.type==='snapshot'));
  client.send(JSON.stringify({type:'configureIce',requestId:'c1',iceServers:[],iceCredentialsExpiresAt:null}));
  client.send(JSON.stringify({type:'candidate',requestId:'d1',candidate:{candidate:'candidate:1 1 UDP 1 127.0.0.1 9 typ host',sdpMid:'0',sdpMLineIndex:0}}));
  await wait(()=>calls.length>=3);
  assert.deepEqual(calls.map(call=>call.command.type),['attach','configureIce','candidate']);
  for(const call of calls.slice(1)){
    assert.equal(call.boot,'boot');
    assert.deepEqual(call.command.owner,owner);
    assert.equal(call.command.viewerSessionId,'viewer');
  }
  assert.equal(replies.filter(message=>message.type==='acknowledged').length,2);
  const serverSocket=[...app.websocketServer.clients].at(-1);
  const disconnected=once(serverSocket,'close');serverSocket.terminate();await disconnected;
  await wait(()=>calls.some(call=>call.command.type==='signalClosed'));
});

test('fallback proxy forwards the role protocol and frames to the loopback component',{timeout:5000},async t=>{
  const upstreamServer=new WebSocketServer({host:'127.0.0.1',port:0});
  await once(upstreamServer,'listening');
  t.after(()=>{for(const socket of upstreamServer.clients)socket.terminate();upstreamServer.close();});
  const url=new URL(`ws://127.0.0.1:${upstreamServer.address().port}`);
  const upstreamFrames=[];let upstreamRequest;
  upstreamServer.on('connection',(socket,request)=>{
    upstreamRequest=request;collect(socket,upstreamFrames);
    socket.send(Buffer.from([4,5]));
  });
  const instance=new EventEmitter();
  instance.fallbackEndpoint=async()=>({url:url.origin,token:'loopback secret'});
  const app=await appFor(t,instance);
  const client=await app.injectWS('/api/internal/remote-desktop/fallback/media',{headers:{...headers,'sec-websocket-protocol':REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL}});
  const clientFrames=[];collect(client,clientFrames);
  client.send(Buffer.from([1,2,3]));
  await waitFor(()=>upstreamFrames.length===1&&clientFrames.length===1);
  assert.equal(upstreamRequest.url,'/fallback/media?token=loopback%20secret');
  assert.equal(upstreamRequest.headers['sec-websocket-protocol'],REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL);
  assert.deepEqual(upstreamFrames[0],Buffer.from([1,2,3]));
  assert.deepEqual(clientFrames[0],Buffer.from([4,5]));
  client.terminate();
});

test('fallback proxy rejects a role/protocol mismatch and unavailable endpoints',{timeout:5000},async t=>{
  let connections=0;
  const upstreamServer=new WebSocketServer({host:'127.0.0.1',port:0});
  upstreamServer.on('connection',()=>{connections++;});
  await once(upstreamServer,'listening');
  t.after(()=>{for(const socket of upstreamServer.clients)socket.terminate();upstreamServer.close();});
  const url=new URL(`ws://127.0.0.1:${upstreamServer.address().port}`);
  const instance=service(t,{fallbackEndpoint:async()=>({url:url.origin,token:'token'})});
  const app=await appFor(t,instance);
  let client=await app.injectWS('/api/internal/remote-desktop/fallback/control',{headers:{...headers,'sec-websocket-protocol':REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL}});
  await once(client,'close');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(connections,0);
  instance.fallbackEndpoint=async()=>undefined;
  client=await app.injectWS('/api/internal/remote-desktop/fallback/media',{headers:{...headers,'sec-websocket-protocol':REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL}});
  await once(client,'close');
});

function collect(socket,frames){
  socket.on('message',(data,isBinary)=>frames.push(isBinary?Buffer.from(data):data.toString()));
}

async function waitFor(predicate){
  while(!predicate())await new Promise(resolve=>setImmediate(resolve));
}
