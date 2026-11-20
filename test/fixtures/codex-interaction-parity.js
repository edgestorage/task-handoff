const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const WebSocket = require('ws');
require('../workspace-require.js').registerWorkspaceRequire();
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: filename,
}).outputText, filename);
const { createAiSessionRegistry } = require('../../packages/ai-session-runtime/src/ai-session-registry.ts');
const { AiSessionController } = require('../../packages/ai-session-runtime/src/ai-session-control.ts');
const { CodexAppServerClient, CodexAppServerSessionBridge } = require('../../packages/ai-session-runtime/src/codex-app-server.ts');
const fixturePath = path.resolve(__dirname, '../../controlled-instance-rs/crates/ai-session/tests/fixtures/codex-interaction-parity.json');
const fields = ['id','providerSessionId','status','phase','activeTurnId','userPrompt','summary','lastMessage','lastMessageItemId','currentTool','toolCallsSinceLastMessage','counters','unread','error'];
// Explicit business projection: no wall-clock fields, snapshotVersion or generated
// capability/actions. Preserve turn revision/source, ordered messages and tool data.
// Only the controller-minted message IDs map bijectively within a scenario.
function projection(session, ids) {
  const identity = id => { if (!ids.has(id)) ids.set(id, `$message${ids.size+1}`); return ids.get(id); };
  const cleanTool = tool => tool ? Object.fromEntries(Object.entries(tool).filter(([k]) => k !== 'startedAt')) : null;
  const out = Object.fromEntries(fields.map(k => [k, session[k] ?? null]));
  out.currentTool = cleanTool(session.currentTool);
  out.turns = (session.turns || []).map(t => Object.fromEntries([
    ...['id','providerTurnId','status','phase','userPrompt','summary','lastMessage','lastMessageItemId','revision','source'].map(k=>[k,t[k]??null]),
    ['currentTool',cleanTool(t.currentTool)], ['toolCallsSinceLastMessage',t.toolCallsSinceLastMessage??null],
    ['userMessages',(t.userMessages||[]).map(m=>({...m,id:identity(m.id)}))],
  ]));
  return JSON.parse(JSON.stringify(out));
}
async function bounded(promise) {
  let timer; try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('U04.1 barrier timeout')),4000);})]); }
  finally { clearTimeout(timer); }
}
async function observe(scenario) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ci-u041-'));
  const server=new WebSocket.WebSocketServer({host:'127.0.0.1',port:0,verifyClient: info=>info.req.headers.authorization==='Bearer fixture-token'});
  let bridge, socket, stop, pendingStart;
  const requests=[], deltas=[], timeline=[], transport=[], responses=[], outcomes=[];
  const rpcReplies=JSON.parse(JSON.stringify(scenario.rpcReplies||{}));
  let wake=()=>{};
  try {
    await bounded(new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);}));
    let starts=0;
    server.on('connection', (ws,req)=>{
      socket=ws;
      transport.push({path:req.url,authorized:true});
      ws.on('message',data=>{
        const rpc=JSON.parse(data.toString());
        if (rpc.method?.startsWith('turn/')) requests.push({method:rpc.method,params:rpc.params});
        if (rpc.method==='turn/start' && scenario.beforeAck) {pendingStart=rpc;wake();return;}
        if (rpc.method==='thread/loaded/list') transport.push({method:rpc.method,params:rpc.params});
        if (!rpc.method && rpc.id!==undefined) { responses.push(rpc);wake();return; }
        if (rpc.id===undefined) return;
        const scripted=rpcReplies[rpc.method]?.shift();
        if(scripted) {ws.send(JSON.stringify({id:rpc.id,...scripted}));return;}
        let result;
        if (rpc.method==='initialize') result={userAgent:'codex_cli_rs/0.161.0 test'};
        else if (rpc.method==='thread/loaded/list') result={data:['thread-u041']};
        else if (rpc.method==='turn/start') {
          if (scenario.rejectFirst && starts++===0) { ws.send(JSON.stringify({id:rpc.id,error:{code:-32000,message:'fixture turn rejected'}}));return; }
          result={turn:{id:'turn-u041',status:'inProgress'}};
        } else if(rpc.method==='turn/steer') result={turnId:rpc.params.expectedTurnId};
        else if(rpc.method==='turn/interrupt') result={};
        else { ws.send(JSON.stringify({id:rpc.id,error:{code:-32601,message:`Unexpected ${rpc.method}`}})); return; }
        ws.send(JSON.stringify({id:rpc.id,result}));
      });
    });
    const tokenFile=path.join(root,'token');fs.writeFileSync(tokenFile,'fixture-token',{mode:0o600});
    const registry=createAiSessionRegistry({dir:path.join(root,'sessions')});
    const initial=registry.start({agent:'codex',providerSessionId:'thread-u041',creationSource:'ai-session',cwd:'/workspace',title:'Existing title'});
    registry.discard(initial.id);
    registry.restoreAuthority({...initial,id:'ses_0000000000001'});
    const ids=new Map();
    const state=()=>projection(registry.get('ses_0000000000001'),ids);
    const client=new CodexAppServerClient({endpoint:`ws://127.0.0.1:${server.address().port}`,tokenFile,command:'missing-u041-cli',resolveVersion:async()=> '0.161.0'});
    bridge=new CodexAppServerSessionBridge(registry,client,{
      onMessageDelta:e=>{deltas.push({...e});wake();},
      onTimelineItem:e=>{timeline.push(JSON.parse(JSON.stringify(e)));wake();},
    });
    stop=registry.onChange(()=>wake());
    const controller=new AiSessionController(registry);controller.register(bridge);
    const checkpoints=[{name:'initial',session:state(),deltas:[],timeline:[]}];
    const capture=name=>checkpoints.push({name,session:state(),deltas:[...deltas],timeline:[...timeline]});
    let rejection=null;
    if(scenario.rejectFirst) {
      try { await controller.sendMessage('ses_0000000000001',{message:' Hello 世界 ',clientRequestId:'rejected-u041'});assert.fail('upstream must reject'); }
      catch(e) { rejection={message:e.message};assert.match(e.message,/fixture turn rejected/); }
      capture('rejected');assert.deepEqual(checkpoints[1].session,checkpoints[0].session);
    }
    let action=null;
    const outcomes=[];
    client.on('event',()=>queueMicrotask(()=>wake()));
    const send=()=>controller.sendMessage('ses_0000000000001',{message:' Hello 世界 ',clientRequestId:'accepted-u041'});
    if(scenario.beforeAck) {
      const pending=send().then(value=>({value}),error=>({error}));
      if(!pendingStart) await bounded(new Promise(resolve=>{wake=()=>{if(pendingStart)resolve();};}));
      wake=()=>{};
      await runSteps(scenario.beforeAck);
      const before=registry.get('ses_0000000000001');
      const beforeTurn=before.turns?.find(t=>t.id==='turn-u041');
      const completion=beforeTurn?.completedAt;
      socket.send(JSON.stringify({id:pendingStart.id,...(scenario.ackReply||{result:{turn:{id:'turn-u041',status:'inProgress'}}})}));
      const result=await bounded(pending);
      if(result.error) {rejection={message:result.error.message};capture('rejected');}
      else {const ack=result.value;action={provider:ack.provider,action:ack.action,turnId:ack.turnId??null,providerTurnId:ack.providerTurnId??null};capture('ack');}
      if(scenario.assertAck) {
        const after=registry.get('ses_0000000000001');
        const afterTurn=after.turns.find(t=>t.id==='turn-u041');
        if(completion) assert.equal(afterTurn.completedAt,completion,'ack preserves provider completion time');
        if(beforeTurn) assert.equal(afterTurn.startedAt,beforeTurn.startedAt,'ack preserves provider start time');
        for(const key of ['status','phase','error','activeTurnId','completedAt','summary','lastMessage','unread']) assert.deepEqual(after[key],before[key],`ack preserves ${key}`);
        if(result.error) assert.deepEqual(JSON.parse(JSON.stringify(after)),JSON.parse(JSON.stringify(before)),'RPC rejection preserves full realtime owner including clocks');
        else {assert.equal(action.turnId,'turn-u041');assert.equal(afterTurn.userMessages.length,1);}
      }
    } else {
      const ack=await send();
      action={provider:ack.provider,action:ack.action,turnId:ack.turnId??null,providerTurnId:ack.providerTurnId??null};
      capture('ack');
    }
    await runSteps(scenario.steps);
    async function runSteps(steps) {
    for(const step of steps) {
      if(step.action) {
        const previous=JSON.parse(JSON.stringify(registry.get('ses_0000000000001')));
        let result;
        try {
          if(step.action==='approval') result=await controller.resolveApproval('ses_0000000000001',step.decision);
          else if(step.action==='interrupt') result=await controller.interrupt('ses_0000000000001');
          else result=await controller.sendMessage('ses_0000000000001',{message:' Follow up ',mode:'steer',clientRequestId:step.name});
          assert.ok(!step.error,`Expected rejection: ${step.name}`);
          const outcome={provider:result.provider,action:result.action};
          if(result.action==='approval') outcome.decision=result.decision;
          else outcome.providerTurnId=result.providerTurnId;
          outcomes.push({name:step.name,result:outcome});
        } catch(error) {
          if(!step.error) throw error;
          const observed={message:error.message};
          if(step.error==='typed') {
            assert.equal(error.code,step.errorCode);
            observed.code=error.code;observed.statusCode=error.statusCode;
          } else {assert.equal(error.message,'fixture control rejected');}
          outcomes.push({name:step.name,error:observed});
          assert.deepEqual(JSON.parse(JSON.stringify(registry.get('ses_0000000000001'))),previous,'rejected control preserves entire persisted owner, including clocks');
        }
        if(step.responses!==undefined && responses.length!==step.responses) {
          let resolve;const gate=new Promise(r=>{resolve=r;});wake=()=>{if(responses.length===step.responses)resolve();};
          await bounded(gate);wake=()=>{};
        }
        capture(step.name);continue;
      }
      const prior=registry.get('ses_0000000000001');
      const completedTurn=step.notification.method==='turn/completed'
        ? prior.turns?.find(turn=>(turn.id===step.notification.params.turn.id||turn.providerTurnId===step.notification.params.turn.id)&&turn.completedAt)
        : undefined;
      const previousCompletion=completedTurn?.completedAt;
      const done=()=>Object.entries(step.wait||{}).every(([key,value])=>JSON.stringify(state()[key])===JSON.stringify(value)) && (step.deltas===undefined||deltas.length===step.deltas) && (step.timeline===undefined||timeline.length===step.timeline);
      let resolve;const gate=new Promise(r=>{resolve=r;});wake=()=>{if(done())resolve();};
      socket.send(JSON.stringify(step.notification));
      try { await bounded(gate); } catch(e) { console.error(step.name,JSON.stringify({session:state(),deltas,timeline}));throw e; } wake=()=>{};
      if(previousCompletion) {
        const after=registry.get('ses_0000000000001');
        assert.equal(after.turns.find(turn=>turn.id===completedTurn.id).completedAt,previousCompletion,'late completion preserves committed turn time');
      }
      capture(step.name);
    }
    }
    const restored=projection(createAiSessionRegistry({dir:path.join(root,'sessions')}).get('ses_0000000000001'),ids);
    assert.deepEqual(restored,state(),'durable owner reopens to final state');
    if(!scenario.controls) {
    assert.equal(deltas.map(d=>d.delta).join(''),'Hello 世界');
    assert.equal(checkpoints.find(c=>c.name==='delta-two').session.lastMessage,null,'deltas stay transient');
    }
    assert.equal(state().currentTool,null);
    if(scenario.controls) {
      const decision=scenario.steps.find(step=>step.action==='approval'&&!step.error)?.decision;
      if(decision) assert.deepEqual(responses,[{id:701,result:{decision:{allow:'accept',deny:'decline',skip:'cancel'}[decision]}}]);
    }
    return {action,rejection,requests,checkpoints,restored,transport,...(scenario.controls?{responses,outcomes}:{})};
  } finally {
    wake=()=>{};stop?.();bridge?.stop();
    for(const ws of server.clients)ws.terminate();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
}
module.exports={observe,fixturePath,projection};
if(require.main===module) (async()=>{
 const selectedPath=process.argv[2]?path.resolve(process.argv[2]):fixturePath;
 const fixture=JSON.parse(fs.readFileSync(selectedPath,'utf8'));
 for(const scenario of fixture.scenarios){const actual=await observe(scenario);scenario.expected=actual;process.stderr.write(`${scenario.id} observed\n`);}
 fs.writeFileSync(selectedPath,JSON.stringify(fixture,null,2)+'\n');
})().catch(e=>{console.error(e);process.exitCode=1;});
