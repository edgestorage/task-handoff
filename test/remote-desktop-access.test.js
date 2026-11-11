const assert=require('node:assert/strict');const fs=require('node:fs');const test=require('node:test');const ts=require('typescript');require('./workspace-require.js').registerWorkspaceRequire();require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},fileName:f}).outputText,f);
const {DesktopAccess}=require('../packages/control-plane/src/control-plane/remote-desktop/access.ts');
const actor={type:'user',userId:'u1',identityId:'i1',roleIds:[],permissionIds:['instances:interactive'],nodeScope:{kind:'all'},authorizationRevision:3,requiresPasswordChange:false};const principal={actor,deviceSessionId:'login-1',expiresAt:Date.now()+60000};
const selection={sourceRef:'display-primary'};
function fake(options={}){let calls=[];const access=new DesktopAccess({request:async(instance,operation,input)=>{calls.push({instance,operation,input});if(operation==='stop'&&options.stopError)throw options.stopError;if(operation==='reserve')return {type:'reserved',attachToken:'private-attach',snapshot:{viewerSessionId:'viewer_1',sessionRevision:1,phase:'starting',captureSelection:input.captureSelection,sessionExpiresAt:Date.now()+28800000,idleExpiresAt:null,mediaPaused:false,reason:null},attachExpiresAt:Date.now()+30000};if(operation==='snapshot')return {snapshot:{viewerSessionId:input.viewerSessionId,sessionRevision:2,phase:'negotiating',captureSelection:selection,sessionExpiresAt:Date.now()+28800000,idleExpiresAt:null,mediaPaused:false,reason:null}};return {type:'acknowledged'};},attach:async()=>{},renewAuthorization:async()=>true,issueIce:()=>({iceServers:[],iceCredentialsExpiresAt:null}),now:()=>Date.now()});return {access,calls};}
test('desktop access consumes a ticket once and keeps attach token out of public result',async()=>{const {access,calls}=fake();const created=await access.create(principal,'ins_1','node_1','req-1',selection);assert.equal(created.ticket!==undefined,true);assert.equal('attachToken' in created,false);const entry=access.consume(principal,'ins_1','viewer_1',created.ticket);assert.equal(entry.attachToken,'private-attach');assert.throws(()=>access.consume(principal,'ins_1','viewer_1',created.ticket),error=>error.code==='REMOTE_DESKTOP_TICKET_INVALID');assert.equal(calls[0].operation,'reserve');});
test('desktop access invalidation closes the authority and requests an idempotent stop',async()=>{const {access,calls}=fake();await access.create(principal,'ins_1','node_1','req-2',selection);await access.invalidate((_principal,id)=>id==='ins_1');assert.equal(calls.some(call=>call.operation==='stop'),true);assert.throws(()=>access.ownerEntry(principal,'ins_1','viewer_1'),error=>error.code==='REMOTE_DESKTOP_NOT_FOUND');});

test('desktop stop treats a component-restarted session as already stopped',async()=>{
 const {access,calls}=fake({stopError:Object.assign(new Error('Remote desktop operation failed.'),{code:'REMOTE_DESKTOP_NOT_FOUND',statusCode:409})});
 const created=await access.create(principal,'ins_1','node_1','req-stale',selection);
 const result=await access.stop(principal,'ins_1',created.snapshot.viewerSessionId,'req-stop-stale');
 assert.deepEqual(result,{type:'stopped'});
 assert.equal(calls.filter(call=>call.operation==='stop').length,1);
 assert.throws(()=>access.ownerEntry(principal,'ins_1',created.snapshot.viewerSessionId),error=>error.code==='REMOTE_DESKTOP_NOT_FOUND');
});

test('desktop stop does not hide owner or transport failures',async()=>{
 for(const code of ['REMOTE_DESKTOP_FORBIDDEN','REMOTE_DESKTOP_UPSTREAM_UNAVAILABLE']){
  const {access}=fake({stopError:Object.assign(new Error('Remote desktop operation failed.'),{code})});
  const created=await access.create(principal,'ins_1','node_1',`req-${code}`,selection);
  await assert.rejects(()=>access.stop(principal,'ins_1',created.snapshot.viewerSessionId,`req-stop-${code}`),error=>error.code===code);
  assert.equal(access.ownerEntry(principal,'ins_1',created.snapshot.viewerSessionId).viewerSessionId,created.snapshot.viewerSessionId);
 }
});

test('desktop tickets are bound to actor, device, instance and expiry',async()=>{
 let now=Date.now();const calls=[];const access=new DesktopAccess({now:()=>now,request:async(instance,operation,input)=>{calls.push({instance,operation,input});return {type:'reserved',attachToken:'private',snapshot:{viewerSessionId:'viewer_bound',sessionRevision:1,phase:'starting',captureSelection:input.captureSelection,sessionExpiresAt:now+10000,idleExpiresAt:null,mediaPaused:false,reason:null},attachExpiresAt:now+1000};},attach:async()=>{},renewAuthorization:async()=>true,issueIce:()=>({iceServers:[],iceCredentialsExpiresAt:null})});
 const created=await access.create(principal,'ins_1','node_1','req-bound',selection);
 const other={...principal,deviceSessionId:'other-device'};
 assert.throws(()=>access.consume(other,'ins_1','viewer_bound',created.ticket),error=>error.code==='REMOTE_DESKTOP_TICKET_INVALID');
 assert.throws(()=>access.consume(principal,'ins_2','viewer_bound',created.ticket),error=>error.code==='REMOTE_DESKTOP_TICKET_INVALID');
 now+=1001;assert.throws(()=>access.consume(principal,'ins_1','viewer_bound',created.ticket),error=>error.code==='REMOTE_DESKTOP_TICKET_INVALID');
 await access.shutdown();
});

test('desktop BUSY and owner state never expose the current owner',async()=>{
 const {access}=fake();const created=await access.create(principal,'ins_1','node_1','req-busy',selection);
 const stranger={...principal,actor:{...principal.actor,userId:'u2'}};
 assert.throws(()=>access.ownerEntry(stranger,'ins_1',created.snapshot.viewerSessionId),error=>error.code==='REMOTE_DESKTOP_NOT_FOUND');
 await access.shutdown();
});

test('component negotiation errors stay on the live session for fallback',async()=>{
 const EventEmitter=require('node:events');
 let relay;
 const access=new DesktopAccess({
  request:async(instance,operation,input)=>{
   if(operation==='reserve')return {type:'reserved',attachToken:'private-attach',snapshot:{viewerSessionId:'viewer_1',sessionRevision:1,phase:'starting',captureSelection:input.captureSelection,sessionExpiresAt:Date.now()+28800000,idleExpiresAt:null,mediaPaused:false,reason:null},attachExpiresAt:Date.now()+30000};
   return {type:'acknowledged'};
  },
  attach:async(_instance,socket)=>{relay=socket;},
  renewAuthorization:async()=>true,
  issueIce:()=>({iceServers:[],iceCredentialsExpiresAt:null}),
 });
 const created=await access.create(principal,'ins_1','node_1','req-negotiation',selection);
 const entry=access.consume(principal,'ins_1','viewer_1',created.ticket);
 const socket=new EventEmitter();const sent=[];
 socket.readyState=1;socket.send=(data)=>sent.push(JSON.parse(data));socket.close=()=>socket.emit('close');
 await access.connect(entry,socket);
 relay.send(JSON.stringify({type:'snapshot',snapshot:{viewerSessionId:'viewer_1',sessionRevision:2,phase:'negotiating',captureSelection:selection,sessionExpiresAt:Date.now()+28800000,idleExpiresAt:null,mediaPaused:false,reason:null}}));
 const configure=sent.find(message=>message.type==='configureIce');
 assert.ok(configure);
 relay.send(JSON.stringify({type:'acknowledged',requestId:configure.requestId}));
 assert.equal(sent.some(message=>message.type==='ready'),true);
 const sdp='v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
 socket.emit('message',JSON.stringify({type:'offer',requestId:'offer-1',sdp}),false);
 relay.send(JSON.stringify({type:'error',requestId:'offer-1',code:'REMOTE_DESKTOP_NEGOTIATION_FAILED'}));
 assert.equal(sent.some(message=>message.type==='error'&&message.code==='REMOTE_DESKTOP_NEGOTIATION_FAILED'),true);
 assert.equal(sent.some(message=>message.type==='error'&&message.code==='REMOTE_DESKTOP_SIGNAL_INVALID'),false);
 assert.equal(access.ownerEntry(principal,'ins_1','viewer_1').closed,false);
 await access.shutdown();
});
