const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const ts = require('typescript');
require('../workspace-require.js').registerWorkspaceRequire();
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},fileName:filename,
}).outputText,filename);
const {createAiSessionRegistry}=require('../../packages/ai-session-runtime/src/ai-session-registry.ts');
const {AiSessionController}=require('../../packages/ai-session-runtime/src/ai-session-control.ts');
const {OpenCodeSessionBridge}=require('../../packages/ai-session-runtime/src/opencode.ts');
const fixturePath=path.resolve(__dirname,'../../controlled-instance-rs/crates/ai-session/tests/fixtures/opencode-interaction-parity.json');
const SESSION='ses_0000000000001', PROVIDER='s-u045';
// Same business fields as Codex parity. Random user message IDs map bijectively
// across wire/action/turn/message/event references. Wall clock owner metadata is
// excluded, but turn revisions/source, counters, sequence and array order stay.
// Provider start/completion timestamps are compared separately in final clocks.
// Only the isolated temporary workspace path maps to /workspace.
const fields=['id','providerSessionId','status','phase','activeTurnId','userPrompt','summary','lastMessage','lastMessageItemId','currentTool','toolCallsSinceLastMessage','counters','unread','error'];
function project(session) {
 const tool=t=>t?Object.fromEntries(Object.entries(t).filter(([k])=>k!=='startedAt')):null;
 return {...Object.fromEntries(fields.map(k=>[k,k==='currentTool'?tool(session[k]):session[k]??null])),turns:(session.turns||[]).map(t=>({...Object.fromEntries(['id','providerTurnId','status','phase','userPrompt','summary','lastMessage','lastMessageItemId','revision','source','toolCallsSinceLastMessage'].map(k=>[k,t[k]??null])),currentTool:tool(t.currentTool),userMessages:t.userMessages||[]}))};
}
function replace(value,from,to) {
 if(typeof value==='string')return value===from?to:value;
 if(Array.isArray(value))return value.map(v=>replace(v,from,to));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v,from,to)]));
 return value;
}
async function bounded(promise,label='barrier') {let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`U04.5 ${label} timeout`)),5000);})]);}finally{clearTimeout(timer);}}
async function observe(scenario) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ci-u045-'));let bridge,stop,sse,wake=()=>{},userId,attempts=0;
 const requests=[],transport=[],deltas=[],timeline=[],timelineDeltas=[],pending=[];
 const cwd=path.join(root,'workspace');fs.mkdirSync(cwd);
 let snapshot={messages:[],status:'idle',updated:1793923200000},hold=false;
 const provider=()=>({id:PROVIDER,directory:cwd,title:'Existing title',version:'1.18.21',time:{created:1793923200000,updated:snapshot.updated}});
 const serve=(req,res,url)=>{
  const body=url.pathname==='/session/status'?{[PROVIDER]:{type:snapshot.status}}:url.pathname.endsWith('/message')?snapshot.messages:url.pathname==='/permission'?[]:provider();
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body));
 };
 const server=http.createServer(async(req,res)=>{
  try {
   assert.equal(req.headers.authorization,'Basic Zml4dHVyZTpzZWNyZXQ=');
   const url=new URL(req.url,'http://fixture');let bytes='';for await(const chunk of req)bytes+=chunk;
   if(url.pathname==='/global/event') {
    assert.equal(req.headers.accept,'text/event-stream');transport.push({path:url.pathname,authorized:true});sse=res;
    res.writeHead(200,{'content-type':'text/event-stream'});res.write('\ufeff: fixture\r\n\r\n');wake();return;
   }
   if(url.pathname==='/global/health') {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({healthy:true,version:'1.18.21'}));return;}
   assert.equal(url.searchParams.get('directory'),cwd);
   if(url.pathname.endsWith('/prompt_async')) {
    assert.equal(req.method,'POST');assert.equal(req.headers['content-type'],'application/json');
    const body=JSON.parse(bytes);requests.push({method:req.method,path:url.pathname,query:[...url.searchParams],body});attempts++;
    if(scenario.rejectFirst&&attempts===1){res.writeHead(503,{'content-type':'text/plain'});res.end('fixture prompt rejected');return;}
    userId=body.messageID;res.writeHead(204);res.end();wake();return;
   }
   assert.equal(req.method,'GET');assert.ok(['/session/status','/permission',`/session/${PROVIDER}`,`/session/${PROVIDER}/message`].includes(url.pathname),`Unexpected ${req.url}`);
   if(url.pathname.endsWith('/message'))assert.equal(url.searchParams.get('limit'),'1000');
   if(hold)pending.push([req,res,url]);else serve(req,res,url);
  }catch(error){res.writeHead(500);res.end(error.message);wake();}
 });
 try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const registry=createAiSessionRegistry({dir:path.join(root,'sessions')});
  const seed=registry.start({agent:'opencode',providerSessionId:PROVIDER,creationSource:'ai-session',cwd,title:'Existing title'});
  registry.discard(seed.id);registry.restoreAuthority({...seed,id:SESSION});
  bridge=new OpenCodeSessionBridge(registry,{
   connection:()=>({endpoint:`http://127.0.0.1:${server.address().port}`,headers:{authorization:'Basic Zml4dHVyZTpzZWNyZXQ='}}),workspaceRoots:()=>[cwd],
   onMessageDelta:e=>{deltas.push(e);wake();},onTimelineItemDelta:e=>{timelineDeltas.push(e);wake();},
  });
  bridge.subscribeTimelineItems(e=>{timeline.push(e);wake();});stop=registry.onChange(()=>wake());
  const controller=new AiSessionController(registry);controller.register(bridge);
  const wait=async(predicate,label)=>{if(predicate())return;await bounded(new Promise(resolve=>{wake=()=>{if(predicate())resolve();};}),label);wake=()=>{};};
  await bridge.readSession(PROVIDER);await wait(()=>!!sse,'SSE connected');
  hold=true;
  const state=()=>project(registry.get(SESSION));const checkpoints=[];
  const capture=name=>checkpoints.push({name,session:state(),deltas:[...deltas],timeline:[...timeline],timelineDeltas:[...timelineDeltas]});
  capture('initial');let rejection=null;
  if(scenario.rejectFirst){const before=JSON.parse(JSON.stringify(registry.get(SESSION)));try{await controller.sendMessage(SESSION,{message:' Hello 世界 ',clientRequestId:'rejected-u045'});assert.fail('must reject');}catch(e){assert.equal(e.message,'fixture prompt rejected');rejection={message:e.message,statusCode:e.statusCode};}assert.deepEqual(JSON.parse(JSON.stringify(registry.get(SESSION))),before);capture('rejected');}
  const ack=await controller.sendMessage(SESSION,{message:' Hello 世界 ',clientRequestId:'accepted-u045'});
  const action={provider:ack.provider,action:ack.action,turnId:ack.turnId,providerTurnId:ack.providerTurnId};capture('ack');
  const acceptedOwner=JSON.parse(JSON.stringify(registry.get(SESSION)));
  hold=false;for(const args of pending.splice(0))serve(...args);
  await bridge.readSession(PROVIDER);
  assert.deepEqual(JSON.parse(JSON.stringify(registry.get(SESSION))),acceptedOwner,'empty pre-transcript snapshot preserves accepted owner including clocks');
  capture('empty-snapshot');hold=true;
  for(const raw of scenario.steps){
   const step=replace(replace(raw,'$user',userId),'/workspace',cwd);snapshot={messages:step.messages,status:step.status,updated:snapshot.updated+1000};
   for(const event of step.events){const bytes=Buffer.from(`data: ${JSON.stringify(event)}\r\n\r\n`);for(const byte of bytes)sse.write(Buffer.from([byte]));}
   hold=false;for(const args of pending.splice(0))serve(...args);
   const done=()=>Object.entries(step.wait).every(([k,v])=>JSON.stringify(state()[k])===JSON.stringify(v))&&deltas.length===step.deltas&&timeline.length===step.timeline&&timelineDeltas.length===step.timelineDeltas;
   try{await wait(done,step.name);}catch(e){console.error(step.name,JSON.stringify({session:state(),deltas,timeline,timelineDeltas}));throw e;}
   // Observe the authoritative read twice so delayed/coalesced reconciles
   // cannot make an intermediate checkpoint depend on SSE scheduling.
   await bridge.readSession(PROVIDER);await bridge.readSession(PROVIDER);
   capture(step.name);hold=true;
  }
  const final=registry.get(SESSION);const finalTurn=final.turns.at(-1);
  const clocks=final.status==='idle'?{startedAt:finalTurn.startedAt,completedAt:finalTurn.completedAt}:null;
  if(clocks){assert.equal(clocks.startedAt,new Date(1793923201000).toISOString());assert.equal(clocks.completedAt,new Date(1793923206000).toISOString());}
  const beforeRead=state();const beforeClocks={startedAt:finalTurn.startedAt,completedAt:finalTurn.completedAt};
  hold=false;for(const args of pending.splice(0))serve(...args);
  await bridge.readSession(PROVIDER);
  const afterRead=registry.get(SESSION).turns.at(-1);
  assert.deepEqual({startedAt:afterRead.startedAt,completedAt:afterRead.completedAt},beforeClocks,'reread preserves lifecycle clocks');
  // Snapshot provenance may converge on first read after a realtime error.
  // All business fields and revision must remain equal.
  const withoutSource=s=>({...s,turns:s.turns.map(({source,...t})=>t)});
  assert.deepEqual(withoutSource(state()),withoutSource(beforeRead));capture('reread');
  const reopened=createAiSessionRegistry({dir:path.join(root,'sessions')}).get(SESSION);
  assert.deepEqual(JSON.parse(JSON.stringify(reopened)),JSON.parse(JSON.stringify(registry.get(SESSION))),'full owner reopens including clocks');
  const restored=project(createAiSessionRegistry({dir:path.join(root,'sessions')}).get(SESSION));assert.deepEqual(restored,state());
  const actual={action,rejection,requests,transport,checkpoints,restored,clocks};
  // Minted IDs are distinct even for rejected and accepted submissions.
  for(let i=0;i<requests.length;i++){const id=requests[i].body.messageID;assert.ok(id);if(i)assert.notEqual(id,requests[0].body.messageID);}
  let normalized=actual;for(let i=0;i<requests.length;i++)normalized=replace(normalized,requests[i].body.messageID,i===requests.length-1?'$user':'$rejectedUser');
  return JSON.parse(JSON.stringify(replace(normalized,cwd,'/workspace')));
 }finally{wake=()=>{};stop?.();bridge?.close();for(const [,res]of pending)res.destroy();sse?.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
}
module.exports={observe,fixturePath,project,replace};
if(require.main===module)(async()=>{const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));for(const scenario of fixture.scenarios){scenario.expected=await observe(scenario);fs.writeFileSync(`/tmp/ci-u045-${scenario.id}-node.json`,JSON.stringify(scenario.expected,null,2)+'\n');process.stderr.write(`${scenario.id} observed\n`);}fs.writeFileSync(fixturePath,JSON.stringify(fixture,null,2)+'\n');})().catch(e=>{console.error(e);process.exitCode=1;});
