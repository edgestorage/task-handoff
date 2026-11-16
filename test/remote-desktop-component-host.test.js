const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
require("./workspace-require.js").registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: filename });
  module._compile(output.outputText, filename);
};
const { DesktopComponentHost, DesktopFrameReader, desktopIpcFrame, DESKTOP_IPC_VERSION, MAX_DESKTOP_IPC_FRAME } = require("../packages/controlled-instance/src/remote-desktop/component-host.ts");
const fixture = require("../remote-desktop-rs/crates/desktop-streaming/fixtures/contract.json");
const steps = require("../remote-desktop-rs/crates/desktop-streaming/fixtures/adapter-contract.json");
const componentBinary = path.resolve(`remote-desktop-rs/target/debug/task-handoff-desktop-streaming${process.platform === "win32" ? ".exe" : ""}`);

function fakeHandshakeBinary(directory, protocolVersion, nonce) {
  const binary = path.join(directory, `fake-component-${protocolVersion}-${nonce || "echo"}.js`);
  const responseNonce = nonce === undefined ? "hello.nonce" : JSON.stringify(nonce);
  fs.writeFileSync(binary, `#!${process.execPath}\n${[
    'const net=require("node:net");',
    'const args=process.argv.slice(2);',
    'const endpoint=args[args.indexOf("--ipc")+1];',
    'const frame=value=>{const body=Buffer.from(JSON.stringify(value));const head=Buffer.alloc(4);head.writeUInt32BE(body.length);return Buffer.concat([head,body]);};',
    'let buffered=Buffer.alloc(0);',
    'const connect=hello=>{const socket=net.createConnection(endpoint);socket.on("connect",()=>socket.write(frame({protocolVersion:' + JSON.stringify(protocolVersion) + ',nonce:' + responseNonce + '})));socket.on("close",()=>process.exit(0));};',
    'process.stdin.on("data",chunk=>{buffered=Buffer.concat([buffered,chunk]);if(buffered.length<4)return;const length=buffered.readUInt32BE(0);if(buffered.length<length+4)return;const hello=JSON.parse(buffered.subarray(4,length+4).toString("utf8"));process.stdin.pause();connect(hello);});',
  ].join("\n")}\n`, { mode: 0o755 });
  return binary;
}

test("private IPC distinguishes protocol mismatch and authentication failure", { skip: process.platform === "win32" }, async () => {
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "desktop-handshake-"));
  try {
    await assert.rejects(DesktopComponentHost.spawn(fakeHandshakeBinary(directory, "1999-01-01"), "control"), /REMOTE_DESKTOP_PROTOCOL_MISMATCH/);
    await assert.rejects(DesktopComponentHost.spawn(fakeHandshakeBinary(directory, DESKTOP_IPC_VERSION, "wrong-nonce"), "control"), /REMOTE_DESKTOP_IPC_AUTH_FAILED/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("private IPC consumes shared framing, fragmented/coalesced packets, and rejects oversized frames", () => {
  assert.equal(DESKTOP_IPC_VERSION, fixture.ipcVersion);
  assert.equal(MAX_DESKTOP_IPC_FRAME, fixture.maxIpcFrame);
  assert.equal(desktopIpcFrame(fixture.framing.json).toString("hex"), fixture.framing.hex);
  const reader = new DesktopFrameReader(); const received = [];
  const frames = Buffer.concat([desktopIpcFrame({a:1}), desktopIpcFrame({b:2})]);
  for (const byte of frames) reader.push(Buffer.from([byte]), (v) => received.push(v));
  reader.push(frames, (v) => received.push(v));
  assert.deepEqual(received, [{a:1},{b:2},{a:1},{b:2}]);
  const invalid = Buffer.alloc(4); invalid.writeUInt32BE(MAX_DESKTOP_IPC_FRAME+1);
  assert.throws(() => reader.push(invalid, () => {}), /IPC_LIMIT/);
});
test("production Node host consumes shared session contract and restart invalidates references", { timeout:30000 }, async () => {
  const binary = componentBinary;
  const host = await DesktopComponentHost.spawn(binary,"control");
  const events = []; host.on("session", (event) => events.push(event));
  let session = "", token = "";
  try {
    for (const step of steps) {
      const command = JSON.parse(JSON.stringify(step.command), (_,value) => value === "$session" ? session : value === "$token" ? token : value);
      const result = await host.request(step.id,command);
      assert.equal(result.type,step.expectType);
      if (step.expectCode) assert.equal(result.code,step.expectCode);
      if (result.type === "reserved") {
        if (session) { assert.equal(result.snapshot.viewerSessionId,session); assert.equal(result.attachToken,token); }
        session = result.snapshot.viewerSessionId; token = result.attachToken;
      }
    }
    assert.ok(events.length >= 3);
    for (let i=1;i<events.length;i++) assert.ok(events[i].snapshot.sessionRevision > events[i-1].snapshot.sessionRevision);
    assert.ok(events.every(event => event.bootId === host.bootId));
    await host.request("shutdown",{type:"shutdown"});
  } finally { await host.close(); }
  assert.equal(host.closed,true);
  await assert.rejects(host.request("late",{type:"shutdown"}), /COMPONENT_UNAVAILABLE/);
  const second = await DesktopComponentHost.spawn(binary,"control");
  try {
    assert.notEqual(second.bootId,host.bootId);
    assert.equal((await second.request("stale",{ type:"attach",owner:{actorId:"adapter-actor",deviceSessionId:"adapter-device"},viewerSessionId:session,captureSelection:{sourceRef:"display"},attachToken:token })).type,"error");
  } finally { await second.close(); }
});

test("final shutdown response is drained before process exit",{timeout:15000},async()=>{
  const binary=componentBinary;
  for(let n=0;n<20;n++){
    const host=await DesktopComponentHost.spawn(binary,'control');
    try{assert.equal((await host.request('shutdown',{type:'shutdown'})).type,'stopped');}
    finally{await host.close();}
  }
});

test('owner takeover, stale callback and trusted force stop consume shared contract',{timeout:15000},async()=>{
  const host=await DesktopComponentHost.spawn(componentBinary,'control');
  const values={};
  try{
    for(const step of require('../remote-desktop-rs/crates/desktop-streaming/fixtures/ownership-contract.json')){
      const command=JSON.parse(JSON.stringify(step.command),(_,value)=>typeof value==='string' && value.startsWith('$') ? values[value.slice(1)] : value);
      const result=await host.request(step.id,command);assert.equal(result.type,step.expectType);
      if(step.expectCode)assert.equal(result.code,step.expectCode);
      if(step.expectPhase)assert.equal(result.snapshot.phase,step.expectPhase);
      if(step.save){
        if(values[`${step.save}Session`])assert.equal(result.snapshot.viewerSessionId,values[`${step.save}Session`]);
        values[`${step.save}Session`]=result.snapshot.viewerSessionId;values[`${step.save}Token`]=result.attachToken;
      }
      if(result.code==='REMOTE_DESKTOP_BUSY')assert.deepEqual(Object.keys(result).sort(),['bootId','code','requestId','type']);
    }
    assert.notEqual(values.firstSession,values.secondSession);
  }finally{await host.close();}
});

test('Windows private IPC authenticates over a named pipe', { skip: process.platform !== "win32" || !fs.existsSync(componentBinary), timeout: 30000 }, async () => {
  const host = await DesktopComponentHost.spawn(componentBinary, "control");
  try {
    assert.ok(host.bootId);
    assert.ok(host.capability);
    assert.equal((await host.request("probe", { type: "probe" })).type, "capability");
  } finally {
    await host.close();
  }
});
