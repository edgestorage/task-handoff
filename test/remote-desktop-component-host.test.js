const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: filename });
  module._compile(output.outputText, filename);
};
const { DesktopComponentHost, DesktopFrameReader, desktopIpcFrame, DESKTOP_IPC_VERSION, MAX_DESKTOP_IPC_FRAME } = require("../packages/controlled-instance/src/remote-desktop/component-host.ts");
const fixture = require("../remote-desktop-rs/crates/desktop-streaming/fixtures/contract.json");
const steps = require("../remote-desktop-rs/crates/desktop-streaming/fixtures/adapter-contract.json");
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
  const binary = path.resolve("remote-desktop-rs/target/debug/task-handoff-desktop-streaming");
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
    assert.equal((await second.request("stale",{ type:"attach",owner:{actorId:"adapter-actor",deviceSessionId:"adapter-device"},viewerSessionId:session,captureTarget:{kind:"display"},attachToken:token })).type,"error");
  } finally { await second.close(); }
});

test("final shutdown response is drained before process exit",{timeout:15000},async()=>{
  const binary=path.resolve('remote-desktop-rs/target/debug/task-handoff-desktop-streaming');
  for(let n=0;n<20;n++){
    const host=await DesktopComponentHost.spawn(binary,'control');
    try{assert.equal((await host.request('shutdown',{type:'shutdown'})).type,'stopped');}
    finally{await host.close();}
  }
});

test('owner takeover, stale callback and trusted force stop consume shared contract',{timeout:15000},async()=>{
  const host=await DesktopComponentHost.spawn(path.resolve('remote-desktop-rs/target/debug/task-handoff-desktop-streaming'),'control');
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
