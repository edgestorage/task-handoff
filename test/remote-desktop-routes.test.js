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
const {DesktopManagedSchemas,desktopManagedEndpoint}=require('../packages/runtime-shared/src/remote-desktop-managed.ts');
const owner={actorId:'actor',deviceSessionId:'device'};
function service(t,extra={}){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-service-'));
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  const instance=new DesktopService({dataDir,mode:'local',installedPackage:()=>undefined,canStart:()=>true,...extra});
  t.after(()=>instance.close());return instance;
}
async function appFor(t,instance){
  const app=Fastify({logger:false});await app.register(websocket);
  registerDesktopRoutes(app,instance,()=> 'trusted');await app.ready();
  t.after(async()=>{for(const socket of app.websocketServer.clients)socket.terminate();await app.close();});return app;
}
const headers={authorization:'Bearer trusted'};
const captureSelection={sourceRef:'display-primary'};
test('desktop routes require header credential and validate nested input before invoking component',async t=>{
  const instance=service(t);let calls=0;instance.request=async()=>{calls++;throw Error('unexpected');};
  const app=await appFor(t,instance);
  for(const authorization of [undefined,'Bearer wrong']){
    const r=await app.inject({url:'/api/internal/remote-desktop/settings?token=trusted',headers:authorization?{authorization}:{}});
    assert.equal(r.statusCode,403);assert.equal(r.headers['cache-control'],'no-store');
  }
  for(const payload of [
    {requestId:'r',owner:{...owner,extra:1},captureSelection},
    {requestId:'r',owner,captureSelection:{...captureSelection,windowRef:'forged'}},
    {requestId:'r',owner,captureSelection:{sourceRef:''}},
  ])assert.equal((await app.inject({method:'POST',url:'/api/internal/remote-desktop/reserve',headers,payload})).statusCode,400);
  assert.equal(calls,0);
  assert.equal((await app.inject({method:'PUT',url:'/api/internal/remote-desktop/settings',headers,payload:{enabled:true,extra:1}})).statusCode,400);
  assert.equal(instance.settings.get().enabled,false);
});
test('managed permission operations use fixed endpoints and strict request kinds',async t=>{
  assert.deepEqual(desktopManagedEndpoint('permissions-get'),{method:'GET',path:'/api/internal/remote-desktop/permissions'});
  assert.deepEqual(desktopManagedEndpoint('permissions-request'),{method:'POST',path:'/api/internal/remote-desktop/permissions/request'});
  assert.equal(DesktopManagedSchemas['permissions-request'].safeParse({kind:'screen-capture'}).success,true);
  assert.equal(DesktopManagedSchemas['permissions-request'].safeParse({kind:'screen-capture',executable:'/tmp/forged'}).success,false);

  const instance=service(t),calls=[];
  const snapshot={platform:'darwin',supported:true,screenCapture:'required',inputControl:'granted'};
  instance.permissions=async()=>{calls.push(['get']);return snapshot;};
  instance.requestPermission=async kind=>{calls.push(['request',kind]);return {...snapshot,screenCapture:'granted'};};
  const app=await appFor(t,instance);
  let response=await app.inject({url:'/api/internal/remote-desktop/permissions',headers});
  assert.equal(response.statusCode,200);assert.deepEqual(response.json().data,snapshot);
  assert.equal((await app.inject({method:'POST',url:'/api/internal/remote-desktop/permissions/request',headers,payload:{kind:'screen-capture',extra:1}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/internal/remote-desktop/permissions/request',headers,payload:{kind:'clipboard'}})).statusCode,400);
  response=await app.inject({method:'POST',url:'/api/internal/remote-desktop/permissions/request',headers,payload:{kind:'screen-capture'}});
  assert.equal(response.statusCode,200);assert.equal(response.json().data.screenCapture,'granted');
  assert.deepEqual(calls,[['get'],['request','screen-capture']]);
});
test('macOS permission service invokes only fixed component arguments and normalizes results',{skip:process.platform!=='darwin'},async t=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-permissions-'));
  const binary=path.join(dataDir,'component.js'),logFile=path.join(dataDir,'calls.jsonl'),screenMarker=path.join(dataDir,'screen'),inputMarker=path.join(dataDir,'input');
  fs.writeFileSync(binary,`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(logFile)},JSON.stringify(args)+'\\n');if(args[0]==='--request-screen-permission'){fs.writeFileSync(${JSON.stringify(screenMarker)},'1');console.log(JSON.stringify({screenCaptureAllowed:true}));}else if(args[0]==='--request-input-permission'){fs.writeFileSync(${JSON.stringify(inputMarker)},'1');console.log(JSON.stringify({inputAllowed:true}));}else if(args[0]==='--check-native-permissions')console.log(JSON.stringify({screenCaptureAllowed:fs.existsSync(${JSON.stringify(screenMarker)}),inputAllowed:fs.existsSync(${JSON.stringify(inputMarker)})}));`,{mode:0o700});
  const instance=new DesktopService({dataDir,mode:'local',installedPackage:()=>({binary,version:'test'}),canStart:()=>true});
  t.after(async()=>{await instance.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  assert.deepEqual(await instance.permissions(),{platform:'darwin',supported:true,screenCapture:'required',inputControl:'required'});
  assert.deepEqual(await instance.requestPermission('screen-capture'),{platform:'darwin',supported:true,screenCapture:'granted',inputControl:'required'});
  assert.deepEqual(fs.readFileSync(logFile,'utf8').trim().split('\n').map(line=>JSON.parse(line)),[
    ['--check-native-permissions'],['--request-screen-permission'],['--check-native-permissions'],
  ]);
});
test('no package, disabled state, uninstall and drain never spawn an implicit component',async t=>{
  let installed;const instance=service(t,{installedPackage:()=>installed});
  const command={type:'listSources',owner};
  await assert.rejects(instance.request('r',command),/NOT_INSTALLED/);
  installed={binary:'/must-not-be-executed',version:'1'};
  await assert.rejects(instance.request('r',command),/DISABLED/);
  await instance.packageChanged('update',true);assert.equal(instance.settings.get().enabled,false);
  await instance.packageChanged('install',false);assert.equal(instance.settings.get().enabled,false);
  await instance.packageChanged('install',true);assert.equal(instance.settings.get().enabled,true);
  await instance.setEnabled(false);
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
  const attach={requestId:'r',owner,viewerSessionId:'viewer',captureSelection,attachToken:'invalid'};
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

test('attach forwards the component failure code before closing signaling',{timeout:5000},async t=>{
  const instance=new EventEmitter();
  instance.componentRunning=()=>true;
  instance.request=async(_id,command)=>command.type==='attach'
    ?{type:'error',code:'REMOTE_DESKTOP_WINDOW_UNAVAILABLE'}
    :{type:'acknowledged'};
  const app=await appFor(t,instance);
  const client=await app.injectWS('/api/internal/remote-desktop/attach',{headers});
  const messages=[];
  client.on('message',data=>messages.push(JSON.parse(data.toString())));
  const closed=once(client,'close');
  client.send(JSON.stringify({requestId:'a',owner,viewerSessionId:'viewer',captureSelection,attachToken:'valid'}));
  const [code,reason]=await closed;
  assert.equal(code,1008);
  assert.equal(String(reason),'REMOTE_DESKTOP_WINDOW_UNAVAILABLE');
  assert.deepEqual(messages.at(-1),{type:'error',requestId:'a',code:'REMOTE_DESKTOP_WINDOW_UNAVAILABLE'});
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
  client.send(JSON.stringify({requestId:'a',owner,viewerSessionId:'viewer',captureSelection,attachToken:'valid'}));
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

test('attach accepts a normal trickle ICE burst without closing signaling',{timeout:5000},async t=>{
  const instance=new EventEmitter();const calls=[];const closed=[];
  instance.componentRunning=()=>true;
  instance.request=async(id,command,boot)=>{
    calls.push({id,command,boot});
    if(command.type==='attach')return {type:'snapshot',bootId:'boot',snapshot:{viewerSessionId:'viewer',sessionRevision:1}};
    if(command.type==='candidate')await new Promise(resolve=>setTimeout(resolve,2));
    return {type:'acknowledged'};
  };
  const app=await appFor(t,instance);
  const client=await app.injectWS('/api/internal/remote-desktop/attach',{headers});
  client.on('close',(code,reason)=>closed.push({code,reason:String(reason)}));
  client.send(JSON.stringify({requestId:'a',owner,viewerSessionId:'viewer',captureSelection,attachToken:'valid'}));
  await waitFor(()=>calls.some(call=>call.command.type==='attach'));
  const candidates=20;
  for(let index=0;index<candidates;index++)client.send(JSON.stringify({
    type:'candidate',
    requestId:`d${index}`,
    candidate:{candidate:`candidate:${index+1} 1 UDP 1 127.0.0.1 ${10000+index} typ host`,sdpMid:'0',sdpMLineIndex:0},
  }));
  await waitFor(()=>calls.filter(call=>call.command.type==='candidate').length===candidates);
  assert.deepEqual(closed,[]);
  assert.deepEqual(calls.slice(1).map(call=>call.id),Array.from({length:candidates},(_,index)=>`d${index}`));
  const serverSocket=[...app.websocketServer.clients].at(-1);
  const disconnected=once(serverSocket,'close');serverSocket.terminate();await disconnected;
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
