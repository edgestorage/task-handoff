const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { projection } = require('./codex-interaction-parity.js');
const { createAiSessionRegistry } = require('../../packages/ai-session-runtime/src/ai-session-registry.ts');
const { AiSessionController } = require('../../packages/ai-session-runtime/src/ai-session-control.ts');
const { CodexAppServerClient, CodexAppServerSessionBridge } = require('../../packages/ai-session-runtime/src/codex-app-server.ts');
const fixturePath = path.resolve(__dirname, '../../controlled-instance-rs/crates/ai-session/tests/fixtures/codex-reconnect-parity.json');
const SESSION = 'ses_0000000000001';
function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('U04.3 barrier timeout')), 4000); })]).finally(() => clearTimeout(timer));
}
function approval(id, reason) {
  return {id, method:'item/commandExecution/requestApproval', params:{threadId:'thread-u041',turnId:'turn-u041',itemId:'command-u043',command:'echo test',reason}};
}
const completion = {method:'turn/completed',params:{threadId:'thread-u041',turn:{id:'turn-u041',status:'completed'}}};
async function observe(scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-u043-'));
  const servers = [], sockets = [], clients = [], requests = [], responses = [], raw = [], deltas = [], timeline = [], outcomes = [], checkpoints = [];
  let bridge, stop, wake = () => {}, apps, held;
  try {
    async function server() {
      const wss = new WebSocket.WebSocketServer({host:'127.0.0.1',port:0,verifyClient:info=>info.req.headers.authorization==='Bearer fixture-token'});
      servers.push(wss);
      await bounded(new Promise((resolve,reject)=>{wss.once('listening',resolve);wss.once('error',reject);}));
      wss.on('connection', (ws,req) => {
        const connection = sockets.push(ws);
        raw.push({connection,path:req.url,authorized:true});
        ws.on('message', data => {
          const rpc = JSON.parse(data.toString());
          if (!rpc.method && rpc.id !== undefined) {responses.push({connection,...rpc});wake();return;}
          if (rpc.id === undefined) return;
          raw.push({connection,...rpc});
          if (rpc.method.startsWith('turn/')) requests.push({connection,method:rpc.method,params:rpc.params});
          if (scenario.id === 'C01' && connection === 1 && rpc.method === 'turn/start') {held=rpc;wake();return;}
          const result = rpc.method === 'initialize' ? {userAgent:'codex_cli_rs/0.161.0 test'}
            : rpc.method === 'thread/loaded/list' ? {data:['thread-u041']}
            : rpc.method === 'turn/start' ? {turn:{id:'turn-u041',status:'inProgress'}} : undefined;
          assert.notEqual(result,undefined,`Unexpected RPC ${rpc.method}`);
          ws.send(JSON.stringify({id:rpc.id,result}));
        });
      });
      return `ws://127.0.0.1:${wss.address().port}`;
    }
    const endpoint = await server();
    const tokenFile = path.join(root,'token');fs.writeFileSync(tokenFile,'fixture-token',{mode:0o600});
    const app = endpoint => [{id:'app-fixture',appId:'codex',status:'running',ai:{appServer:{transport:'ws',endpoint,tokenFile,command:'missing-u043-cli'}}}];
    apps = app(endpoint);
    const registry = createAiSessionRegistry({dir:path.join(root,'sessions')});
    const initial = registry.start({agent:'codex',providerSessionId:'thread-u041',creationSource:'ai-session',cwd:'/workspace',title:'Existing title'});
    registry.discard(initial.id);registry.restoreAuthority({...initial,id:SESSION});
    const ids = new Map(), state = () => projection(registry.get(SESSION),ids);
    const capture = name => checkpoints.push({name,session:state(),deltas:[...deltas],timeline:JSON.parse(JSON.stringify(timeline))});
    async function until(predicate) {
      if (predicate()) return;
      await bounded(new Promise(resolve => {wake=()=>{if(predicate()) resolve();};}));wake=()=>{};
    }
    bridge = new CodexAppServerSessionBridge(registry,{
      createClient:options=>{const client=new CodexAppServerClient({...options,resolveVersion:async()=> '0.161.0'});clients.push(client);client.on('event',()=>queueMicrotask(()=>wake()));return client;},
      ensureAppSessions:async()=>apps,
      onMessageDelta:event=>{deltas.push(event);wake();},onTimelineItem:event=>{timeline.push(event);wake();},
    });
    stop=registry.onChange(()=>wake());
    const controller=new AiSessionController(registry);controller.register(bridge);
    await bridge.ensureReady(apps);capture('initial');
    const send = request => controller.sendMessage(SESSION,{message:' Hello 世界 ',clientRequestId:request});
    async function notify(connection,frame,predicate) {
      sockets[connection-1].send(JSON.stringify(frame));
      await until(predicate);
    }
    if (scenario.id === 'C01') {
      const before=JSON.parse(JSON.stringify(registry.get(SESSION)));
      const attempt = send('pending-u043').then(()=>{throw new Error('pending request must fail');},error=>error);
      await until(()=>Boolean(held));
      const closed=new Promise(resolve=>clients[0].once('disconnect',resolve));sockets[0].terminate();await bounded(closed);
      outcomes.push({name:'disconnected',error:{message:(await bounded(attempt)).message}});capture('disconnected');
      assert.deepEqual(JSON.parse(JSON.stringify(registry.get(SESSION))),before,'pending disconnect preserves complete owner including clocks');
      assert.deepEqual(checkpoints[0].session,checkpoints[1].session,'no phantom turn/message');
      await send('retry-u043');capture('retry');
    } else {
      await send('accepted-u043');capture('ack');
      await notify(1,approval(701,'Old command'),()=>state().phase==='approval');capture('old-approval');
      if (scenario.id === 'C02') {
        const closed=new Promise(resolve=>clients[0].once('disconnect',resolve));sockets[0].terminate();await bounded(closed);capture('disconnected');
        const before=JSON.parse(JSON.stringify(registry.get(SESSION)));
        try {await controller.resolveApproval(SESSION,'allow');assert.fail('approval requires replay');}
        catch(error) {assert.equal(error.code,'AI_SESSION_APPROVAL_NOT_ATTACHED');outcomes.push({name:'not-attached',error:{code:error.code,message:error.message,statusCode:error.statusCode}});}
        assert.deepEqual(JSON.parse(JSON.stringify(registry.get(SESSION))),before);capture('not-attached');
        assert.deepEqual(responses,[]);
        await notify(2,approval(702,'New command'),()=>state().summary==='New command · Command: echo test');capture('replayed');
      } else {
        // Delay the old close handshake at the real peer. No fake client/events.
        sockets[0]._socket.pause();
        const oldSocket=clients[0].socket;
        apps=app(await server());await bridge.ensureReady(apps);
        await notify(2,approval(701,'New command'),()=>state().summary==='New command · Command: echo test');capture('new-approval');
        const before=JSON.parse(JSON.stringify(registry.get(SESSION)));
        const sentinel={method:'fixture/barrier',params:{}};
        const delivered=bounded(new Promise(resolve=>oldSocket.on('message',data=>{if(JSON.parse(data.toString()).method==='fixture/barrier')resolve();})));
        // Observe wire delivery after production stop removed its old listeners.
        for(const frame of [...scenario.lateFrames,sentinel]) await new Promise((resolve,reject)=>sockets[0].send(JSON.stringify(frame),error=>error?reject(error):resolve()));
        await delivered;
        const closed=bounded(new Promise(resolve=>oldSocket.once('close',resolve)));sockets[0]._socket.resume();await closed;
        assert.deepEqual(JSON.parse(JSON.stringify(registry.get(SESSION))),before,'old connection preserves entire current owner');
        capture('late-ignored');
      }
      const action=await controller.resolveApproval(SESSION,'allow');outcomes.push({name:'approved',result:{provider:action.provider,action:action.action,decision:action.decision}});
      await until(()=>responses.length===1);capture('approved');
    }
    await notify(2,completion,()=>state().status==='idle');capture('completed');
    const restored=projection(createAiSessionRegistry({dir:path.join(root,'sessions')}).get(SESSION),ids);assert.deepEqual(restored,state());
    // Every new transport must rediscover the persisted thread before control.
    const readiness=[1,2].map(connection=>raw.some(r=>r.connection===connection&&r.method==='thread/loaded/list'));
    // C03's second connection only resolves an already-replayed request.
    assert.deepEqual(readiness,scenario.id==='C03'?[true,false]:[true,true]);
    return {requests,responses,outcomes,checkpoints,restored,readiness};
  } finally {
    wake=()=>{};stop?.();bridge?.stop();
    for(const ws of sockets) {ws._socket?.resume();ws.terminate();}
    await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));fs.rmSync(root,{recursive:true,force:true});
  }
}
module.exports={observe,fixturePath};
if(require.main===module) (async()=>{
 const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
 for(const scenario of fixture.scenarios){scenario.expected=await observe(scenario);process.stderr.write(`${scenario.id} observed\n`);}
 fs.writeFileSync(fixturePath,JSON.stringify(fixture,null,2)+'\n');
})().catch(error=>{console.error(error);process.exitCode=1;});
