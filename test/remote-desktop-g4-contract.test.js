const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');const test=require('node:test');const ts=require('typescript');require('./workspace-require.js').registerWorkspaceRequire();require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},fileName:f}).outputText,f);
const protocol=require('../packages/protocol/src/remote-desktop.ts');const {DesktopTurnIssuer}=require('../packages/control-plane/src/control-plane/remote-desktop/turn.ts');
test('public desktop schemas project bounded snapshot, SDP and candidates',()=>{
 const snapshot=protocol.DesktopSessionSnapshotSchema.parse({viewerSessionId:'v',sessionRevision:1,controlRevision:2,isController:false,hasController:false,viewerCount:3,transport:'websocket-fallback',phase:'starting',captureSelection:{sourceRef:'display-primary'},sessionExpiresAt:1,idleExpiresAt:null,mediaPaused:false,reason:null,inputEpoch:3});
 assert.equal(snapshot.controlRevision,2);assert.equal(snapshot.isController,false);assert.equal(snapshot.hasController,false);assert.equal(snapshot.viewerCount,3);assert.equal(snapshot.transport,'websocket-fallback');assert.equal('inputEpoch' in snapshot,false);
 const legacy=protocol.DesktopSessionSnapshotSchema.parse({viewerSessionId:'v',sessionRevision:1,phase:'starting',captureSelection:{sourceRef:'display-primary'},sessionExpiresAt:1,idleExpiresAt:null,mediaPaused:false,reason:null});
 assert.equal(legacy.controlRevision,0);assert.equal(legacy.isController,true);assert.equal(legacy.hasController,true);assert.equal(legacy.viewerCount,1);assert.equal(legacy.transport,'webrtc');
const stopped=protocol.DesktopSessionSnapshotSchema.parse({viewerSessionId:'v',sessionRevision:2,controlRevision:2,isController:false,hasController:false,viewerCount:0,transport:'webrtc',phase:'stopped',captureSelection:{sourceRef:'display-primary'},sessionExpiresAt:1,idleExpiresAt:null,mediaPaused:true,reason:null});
assert.equal(stopped.viewerCount,0);assert.equal(stopped.phase,'stopped');
 assert.equal(protocol.desktopSdpAllowed('v=0\nm=video 9 UDP/TLS/RTP/SAVPF 96\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel'),true);
 assert.equal(protocol.desktopSdpAllowed('v=0\nm=audio 9 UDP/TLS/RTP/SAVPF 111\nm=video 9 UDP/TLS/RTP/SAVPF 96\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel'),false);
 assert.equal(protocol.DesktopSignalSchema.safeParse({type:'candidate',requestId:'r',candidate:{candidate:'x',sdpMid:'0',sdpMLineIndex:0}}).success,true);
});
test('TURN issuer uses deployment secret and rejects unhealthy clock or unsupported URL',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'turn-'));const clock=path.join(dir,'clock.json');fs.writeFileSync(clock,JSON.stringify({measuredAt:Date.now(),offsetMs:0,synchronized:true}));
 const config={region:'sg',regions:{sg:{urls:['turn:turn.example:3478?transport=udp','turn:turn.example:3478?transport=tcp','turns:turn.example:5349?transport=tcp']}},clockHealthFile:clock,maxClockSkewMs:5000};
 const issued=new DesktopTurnIssuer(config,'secret').issue();assert.equal(issued.iceServers[0].urls.length,3);const [username,credential]=[issued.iceServers[0].username,issued.iceServers[0].credential];assert.equal(credential,crypto.createHmac('sha1','secret').update(username).digest('base64'));assert.ok(issued.iceCredentialsExpiresAt-Date.now()<=600000);
 fs.writeFileSync(clock,JSON.stringify({measuredAt:Date.now()-120000,offsetMs:0,synchronized:true}));assert.throws(()=>new DesktopTurnIssuer(config,'secret').issue(),/TURN/);fs.rmSync(dir,{recursive:true,force:true});
});

test('source directory is bounded and contains no operating-system handles',()=>{
 const valid={sourceRef:'src_opaque_1',kind:'window',title:'Editor',subtitle:'Code',width:1280,height:720,capturable:true,reason:null};
 assert.equal(protocol.DesktopSourceSchema.safeParse(valid).success,true);
 assert.equal(protocol.DesktopSourcesSchema.safeParse([valid]).success,true);
 assert.equal(protocol.DesktopSourcesSchema.safeParse(Array.from({length:257},(_,i)=>({...valid,sourceRef:`w${i}`}))).success,false);
 assert.equal(protocol.DesktopSourceSchema.safeParse({...valid,hwnd:12}).success,true);
 const projected=protocol.DesktopSourceSchema.parse({...valid,hwnd:12,pid:3,path:'/tmp/secret'});
 assert.equal('hwnd' in projected,false);assert.equal('pid' in projected,false);assert.equal('path' in projected,false);
});

test('capability absence disables only remote desktop and malformed source refs are rejected',()=>{
 const unavailable=protocol.normalizeRemoteDesktopCapabilities({available:true,windowCapture:{available:true}});
 assert.equal(unavailable.available,false);assert.equal(unavailable.sourceProviders.length,0);
 assert.equal(protocol.DesktopCaptureSelectionSchema.safeParse({sourceRef:''}).success,false);
 assert.equal(protocol.DesktopCaptureSelectionSchema.safeParse({sourceRef:'x',windowRef:'forged'}).success,false);
});

test('fallback media frames validate their fixed header and payload boundary',()=>{
 const header=protocol.REMOTE_DESKTOP_FALLBACK_HEADER_BYTES;
 const frame=new Uint8Array(header+4);const view=new DataView(frame.buffer);
 frame[0]=0x52;frame[1]=0x44;frame[2]=1;frame[3]=protocol.DESKTOP_FALLBACK_FRAME_VIDEO;frame[4]=protocol.DESKTOP_FALLBACK_FLAG_KEYFRAME;
 view.setUint32(5,7);view.setBigUint64(9,99n);view.setUint16(17,1);view.setUint16(19,2);view.setUint32(21,4);frame.set([0,0,0,1],header);
 const decoded=protocol.decodeDesktopFallbackFrame(frame);
 assert.equal(decoded.frameId,7);assert.equal(decoded.timestampUs,99n);assert.equal(decoded.keyframe,true);assert.equal(decoded.chunkIndex,1);assert.equal(decoded.chunkCount,2);assert.deepEqual(decoded.payload,new Uint8Array([0,0,0,1]));
 for(const mutate of [
   value=>{value[0]=0x00;},
   value=>{new DataView(value.buffer).setUint16(17,2);},
   value=>{new DataView(value.buffer).setUint16(19,0);},
   value=>{new DataView(value.buffer).setUint32(21,3);},
   value=>value.slice(0,header-1),
 ]){
   const invalid=frame.slice();const next=mutate(invalid);assert.throws(()=>protocol.decodeDesktopFallbackFrame(next??invalid),/FRAME_INVALID/);
 }
});

function encodeFallbackChunk({frameId,timestampUs,keyframe=false,chunkIndex=0,chunkCount=1,payload}){
 const header=protocol.REMOTE_DESKTOP_FALLBACK_HEADER_BYTES;
 const frame=new Uint8Array(header+payload.byteLength);const view=new DataView(frame.buffer);
 frame[0]=0x52;frame[1]=0x44;frame[2]=1;frame[3]=protocol.DESKTOP_FALLBACK_FRAME_VIDEO;
 if(keyframe)frame[4]=protocol.DESKTOP_FALLBACK_FLAG_KEYFRAME;
 view.setUint32(5,frameId);view.setBigUint64(9,timestampUs);view.setUint16(17,chunkIndex);view.setUint16(19,chunkCount);view.setUint32(21,payload.byteLength);
 frame.set(payload,header);return protocol.decodeDesktopFallbackFrame(frame);
}

test('fallback frame assembler handles chunk order, duplicates, gaps and generation reset',()=>{
 const assembler=new protocol.DesktopFallbackFrameAssembler();
 const first=payload=>({frameId:1,timestampUs:100n,keyframe:true,chunkIndex:payload.index,chunkCount:2,payload:payload.bytes});
 assert.deepEqual(assembler.push(encodeFallbackChunk(first({index:1,bytes:new Uint8Array([2,3])}))),{type:'pending'});
 assert.deepEqual(assembler.push(encodeFallbackChunk(first({index:0,bytes:new Uint8Array([0,0,0,1])}))),{
   type:'frame',frameId:1,timestampUs:100n,keyframe:true,payload:new Uint8Array([0,0,0,1,2,3]),skippedFrames:false,
 });
 assert.deepEqual(assembler.push(encodeFallbackChunk(first({index:0,bytes:new Uint8Array([0,0,0,1])}))),{type:'stale'});
 const skipped=assembler.push(encodeFallbackChunk({frameId:3,timestampUs:300n,payload:new Uint8Array([9])}));
 assert.equal(skipped.type,'frame');assert.equal(skipped.skippedFrames,true);
 assert.deepEqual(assembler.push(encodeFallbackChunk({frameId:3,timestampUs:400n,payload:new Uint8Array([9])})),{type:'stale'});

 assembler.push(encodeFallbackChunk({frameId:10,timestampUs:1000n,chunkIndex:0,chunkCount:2,payload:new Uint8Array([1])}));
 assembler.reset();
 const afterReset=assembler.push(encodeFallbackChunk({frameId:2,timestampUs:2000n,payload:new Uint8Array([4,5])}));
 assert.equal(afterReset.type,'frame');assert.equal(afterReset.skippedFrames,false);assert.deepEqual(afterReset.payload,new Uint8Array([4,5]));
});

test('fallback frame assembler rejects inconsistent metadata and excessive chunk counts',()=>{
 const assembler=new protocol.DesktopFallbackFrameAssembler();
 assembler.push(encodeFallbackChunk({frameId:4,timestampUs:400n,chunkIndex:0,chunkCount:2,payload:new Uint8Array([1])}));
 assert.throws(()=>assembler.push(encodeFallbackChunk({frameId:4,timestampUs:401n,chunkIndex:1,chunkCount:2,payload:new Uint8Array([2])})),/FRAME_INVALID/);

 const frame=new Uint8Array(protocol.REMOTE_DESKTOP_FALLBACK_HEADER_BYTES);const view=new DataView(frame.buffer);
 frame[0]=0x52;frame[1]=0x44;frame[2]=1;frame[3]=protocol.DESKTOP_FALLBACK_FRAME_VIDEO;
 view.setUint16(17,0);view.setUint16(19,protocol.REMOTE_DESKTOP_FALLBACK_MAX_CHUNKS+1);view.setUint32(21,0);
 assert.throws(()=>protocol.decodeDesktopFallbackFrame(frame),/FRAME_INVALID/);
});
