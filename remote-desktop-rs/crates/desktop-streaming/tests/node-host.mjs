// Component contract test only: no instance/CP adapter or product API.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, chmod, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
const fixture=JSON.parse(await readFile(new URL('../fixtures/contract.json',import.meta.url),'utf8'));
const timeout=setTimeout(()=>{console.error('Node host contract timed out');process.exit(1);},15000);
const binary=process.argv[2];
assert.ok(binary,'pass the compiled component path');
function frame(value) {
  const body=Buffer.from(JSON.stringify(value));
  assert.ok(body.length>0 && body.length<=fixture.maxIpcFrame);
  const header=Buffer.alloc(4); header.writeUInt32BE(body.length);
  return Buffer.concat([header,body]);
}
assert.equal(frame(fixture.framing.json).toString('hex'),fixture.framing.hex);
assert.deepEqual(fixture.channels.map(({label,id,negotiated,ordered,maxRetransmits})=>({label,id,negotiated,ordered,maxRetransmits})),[
  {label:'control',id:0,negotiated:true,ordered:true,maxRetransmits:null},
  {label:'input',id:1,negotiated:true,ordered:true,maxRetransmits:null},
  {label:'pointer',id:2,negotiated:true,ordered:false,maxRetransmits:0},
  {label:'clipboard',id:3,negotiated:true,ordered:true,maxRetransmits:null},
]);

const directory=await mkdtemp(join(process.platform==='darwin'?'/private/tmp':tmpdir(),'th-desk-node-'));
await chmod(directory,0o700);
const endpoint=process.platform==='win32'?`\\\\.\\pipe\\th-desktop-${randomBytes(16).toString('hex')}`:join(directory,'host.sock');
const server=createServer();
let child,socket;
try {
  server.listen(endpoint); await once(server,'listening');
  const connection=once(server,'connection');
  child=spawn(binary,['--ipc',endpoint],{stdio:['pipe','ignore','pipe']});
  const exit=once(child,'exit');
  // Never print component stderr, which might include private implementation errors.
  child.stderr.resume();
  const nonce=randomBytes(32).toString('hex');
  const hello={protocolVersion:fixture.ipcVersion,nonce};
  child.stdin.write(frame(hello));
  [socket]=await connection;
  const packets=[]; let buffered=Buffer.alloc(0),wakeup;
  socket.on('data',chunk=>{
    buffered=Buffer.concat([buffered,chunk]);
    assert.ok(buffered.length<=fixture.maxIpcFrame+4);
    while(buffered.length>=4) {
      const length=buffered.readUInt32BE(); assert.ok(length>0 && length<=fixture.maxIpcFrame);
      if(buffered.length<length+4) break;
      packets.push(JSON.parse(buffered.subarray(4,4+length))); buffered=buffered.subarray(4+length);
    }
    wakeup?.();
  });
  async function next() {
    while(!packets.length) await new Promise(resolve=>{wakeup=resolve;});
    return packets.shift();
  }
  assert.deepEqual(await next(),hello);
  socket.write(frame(hello));
  const welcome=await next(); assert.equal(welcome.protocolVersion,fixture.ipcVersion); assert.equal(welcome.capability.available,false);
  const owner={actorId:'node-test-actor',deviceSessionId:'node-test-device'};
  let event;
  async function request(requestId,command) {
    socket.write(frame({requestId,bootId:welcome.bootId,...command}));
    while(true) {
      const packet=await next();
      if(packet.kind==='event') {event=packet.payload;assert.equal(event.bootId,welcome.bootId);continue;}
      assert.equal(packet.kind,'response');assert.equal(packet.payload.requestId,requestId);return packet.payload;
    }
  }
  const reserved=await request('create',{type:'reserve',owner,captureTarget:{kind:'display'}});
  assert.equal(reserved.type,'reserved'); assert.equal(event.snapshot.phase,'starting');
  const retry=await request('create',{type:'reserve',owner,captureTarget:{kind:'display'}});
  assert.equal(retry.attachToken,reserved.attachToken);
  assert.equal((await request('busy',{type:'reserve',owner,captureTarget:{kind:'display'}})).code,'REMOTE_DESKTOP_BUSY');
  const attach={type:'attach',owner,captureTarget:{kind:'display'},viewerSessionId:reserved.snapshot.viewerSessionId,attachToken:reserved.attachToken};
  assert.equal((await request('attach',attach)).snapshot.phase,'negotiating');
  assert.equal((await request('replay',attach)).code,'REMOTE_DESKTOP_ATTACH_INVALID');
  assert.equal((await request('stop',{type:'stop',owner,viewerSessionId:reserved.snapshot.viewerSessionId})).type,'stopped');
  assert.equal(event.snapshot.phase,'stopped');
  // A partially written IPC frame must not disable independent parent supervision.
  socket.write(Buffer.from([0,0,1,0,123]));
  child.stdin.end();
  const [code]=await exit; assert.equal(code,0);
  console.log('Node host: shared framing, reserve/retry/BUSY/attach/replay/events/stop and stdin EOF passed');
} finally {
  clearTimeout(timeout);socket?.destroy();child?.kill();server.close();await rm(directory,{recursive:true,force:true});
}
