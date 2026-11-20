const {project,replace}=require('./opencode-interaction-parity.js');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {createAiSessionRegistry}=require('../../packages/ai-session-runtime/src/ai-session-registry.ts');
const {AiSessionController}=require('../../packages/ai-session-runtime/src/ai-session-control.ts');
const {OpenCodeSessionBridge}=require('../../packages/ai-session-runtime/src/opencode.ts');
const fixturePath=path.resolve(__dirname,'../../controlled-instance-rs/crates/ai-session/tests/fixtures/opencode-control-parity.json');
const SESSION='ses_0000000000001',PROVIDER='s-u045';
// U04.6 shares the U04.5 explicit business projection. Actions preserve missing
// IDs as null on both sides; only generated prompt IDs and temp cwd are mapped.
// Error code uses sendAiSessionControlError's AI_SESSION_CONTROL_FAILED fallback;
// the provider HTTP exception itself has no Node .code. No error is stripped.
async function observe(scenario){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ci-u046-')),cwd=path.join(root,'workspace');fs.mkdirSync(cwd);
 let bridge,stop,sse,wake=()=>{},hold=false,snapshot=structuredClone(scenario.initial),failure=null,post=null;
 const pending=[],requests=[],transport=[],checkpoints=[],results=[];
 const provider=()=>({id:PROVIDER,directory:cwd,title:'Existing title',version:'1.18.21',time:{created:1793923200000,updated:snapshot.updated}});
 const serve=(req,res,url)=>{
  if(failure?.path===url.pathname){const message=failure.message;failure=null;res.writeHead(503);res.end(message);return;}
  const body=url.pathname==='/session/status'?{[PROVIDER]:{type:snapshot.status}}:url.pathname.endsWith('/message')?snapshot.messages:url.pathname==='/permission'?snapshot.permissions:provider();
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body));
 };
 const server=http.createServer(async(req,res)=>{try{
  assert.equal(req.headers.authorization,'Basic Zml4dHVyZTpzZWNyZXQ=');const url=new URL(req.url,'http://fixture');let bytes='';for await(const chunk of req)bytes+=chunk;
  if(url.pathname==='/global/event'){assert.equal(req.headers.accept,'text/event-stream');transport.push({path:url.pathname,authorized:true});sse=res;res.writeHead(200,{'content-type':'text/event-stream'});res.write('\ufeff: fixture\r\n\r\n');wake();return;}
  if(url.pathname==='/global/health'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({healthy:true,version:'1.18.21'}));return;}
  assert.equal(url.searchParams.get('directory'),cwd);
  if(req.method==='POST'){
   const body=bytes?JSON.parse(bytes):null;requests.push({method:req.method,path:url.pathname,query:[...url.searchParams],body});
   if(failure?.path===url.pathname){const message=failure.message;failure=null;res.writeHead(503);res.end(message);return;}
   if(post){snapshot=structuredClone(post.snapshot||snapshot);failure=post.failure||null;post=null;}
   if(url.pathname.endsWith('/prompt_async')){res.writeHead(204);res.end();}else{assert.ok(url.pathname.endsWith('/abort')||url.pathname.endsWith('/reply'));res.writeHead(200,{'content-type':'application/json'});res.end('true');}wake();return;
  }
  assert.equal(req.method,'GET');assert.ok(['/session/status','/permission',`/session/${PROVIDER}`,`/session/${PROVIDER}/message`].includes(url.pathname));
  if(url.pathname.endsWith('/message'))assert.equal(url.searchParams.get('limit'),'1000');
  if(hold)pending.push([req,res,url]);else serve(req,res,url);
 }catch(e){res.writeHead(500);res.end(e.message);wake();}});
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const registry=createAiSessionRegistry({dir:path.join(root,'sessions')});
  const seed=registry.start({agent:'opencode',providerSessionId:PROVIDER,creationSource:'ai-session',cwd,title:'Existing title'});registry.discard(seed.id);registry.restoreAuthority({...seed,id:SESSION});
  bridge=new OpenCodeSessionBridge(registry,{connection:()=>({endpoint:`http://127.0.0.1:${server.address().port}`,headers:{authorization:'Basic Zml4dHVyZTpzZWNyZXQ='}}),workspaceRoots:()=>[cwd]});
  stop=registry.onChange(()=>wake());const controller=new AiSessionController(registry);controller.register(bridge);
  const wait=async(predicate,label)=>{if(predicate())return;let timer;try{await Promise.race([new Promise(resolve=>{wake=()=>{if(predicate())resolve();};}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`U04.6 ${label} timeout`)),5000);})]);}finally{clearTimeout(timer);wake=()=>{};}};
  const state=()=>({...project(registry.get(SESSION)),actions:registry.get(SESSION).actions});
  const capture=name=>checkpoints.push({name,session:state()});
  const release=()=>{hold=false;for(const args of pending.splice(0))serve(...args);};
  await bridge.readSession(PROVIDER);await wait(()=>!!sse,'connected');await bridge.readSession(PROVIDER);capture('initial');
  for(const step of scenario.steps){
   if(step.snapshot)snapshot=structuredClone(step.snapshot);
   if(step.event){release();const event=replace(step.event,'/workspace',cwd);sse.write(`data: ${JSON.stringify(event)}\r\n\r\n`);await wait(()=>Object.entries(step.wait).every(([k,v])=>JSON.stringify(state()[k])===JSON.stringify(v)),step.name);capture(step.name);continue;}
   hold=!!step.hold;failure=step.failure||null;post=step.post||null;
   const before=JSON.parse(JSON.stringify(registry.get(SESSION)));let result;
   try{
    const ack=step.action==='steer'?await controller.sendMessage(SESSION,{message:step.message,mode:'steer'}):step.action==='interrupt'?await controller.interrupt(SESSION):await controller.resolveApproval(SESSION,step.decision);
    result={provider:ack.provider,action:ack.action,turnId:ack.turnId??null,providerTurnId:ack.providerTurnId??null,decision:ack.decision??null,session:({...project(ack.session),actions:ack.session.actions})};
   }catch(e){result={error:{message:e.message,statusCode:e.statusCode,code:e.code||(e.statusCode?'AI_SESSION_CONTROL_FAILED':null)}};}
   if(step.unchanged)assert.deepEqual(JSON.parse(JSON.stringify(registry.get(SESSION))),before,`${step.name} preserves full owner`);
   results.push({name:step.name,...result});capture(step.name);
  }
  release();await bridge.readSession(PROVIDER);capture('reread');
  const current=registry.get(SESSION),reopened=createAiSessionRegistry({dir:path.join(root,'sessions')}).get(SESSION);
  assert.deepEqual(JSON.parse(JSON.stringify(reopened)),JSON.parse(JSON.stringify(current)),'full owner reopens including clocks');
  let actual={results,requests,transport,checkpoints,restored:{...project(reopened),actions:reopened.actions}};
  const ids=requests.filter(r=>r.path.endsWith('/prompt_async')).map(r=>r.body.messageID);assert.equal(new Set(ids).size,ids.length);
  ids.forEach((id,i)=>{actual=replace(actual,id,`$prompt${i+1}`);});return JSON.parse(JSON.stringify(replace(actual,cwd,'/workspace')));
 }finally{stop?.();bridge?.close();for(const[,res]of pending)res.destroy();sse?.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
}
module.exports={observe,fixturePath};
if(require.main===module)(async()=>{const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));for(const s of fixture.scenarios){s.expected=await observe(s);fs.writeFileSync(`/tmp/ci-u046-${s.id}-node.json`,JSON.stringify(s.expected,null,2)+'\n');process.stderr.write(`${s.id} observed\n`);}fs.writeFileSync(fixturePath,JSON.stringify(fixture,null,2)+'\n');})().catch(e=>{console.error(e);process.exitCode=1;});
