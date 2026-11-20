const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const atomic = require('write-file-atomic');
const { fixtureRoot, readonly, normalizer, capture, projectSession, inline, NOW } = require('./attachment-commit-parity.js');
const { AiSessionConversationAttachmentStore } = require('../../packages/ai-session-runtime/src/ai-session-conversation-attachment-store.ts');
const { AiSessionController } = require('../../packages/ai-session-runtime/src/ai-session-control.ts');
const { createAiSessionRegistry } = require('../../packages/ai-session-runtime/src/ai-session-registry.ts');
const { CodexAppServerSessionControl } = require('../../packages/ai-session-runtime/src/codex-app-server/session/control.ts');
async function observe(action, name) {
  const root = fixtureRoot(); let restore, stop;
  const original = atomic.sync; let faultCount = 0;
  try {
    const open = () => new AiSessionConversationAttachmentStore({ dataDir: root }, { now: () => NOW });
    const owner = open();
    const registry = createAiSessionRegistry({ dir: path.join(root,'sessions'), conversationAttachments: owner });
    const session = registry.applyAdapterSnapshot({ source:'control', agent:'codex', creationSource:'ai-session', providerSessionId:'thread-commit', cwd:root,
      status:action==='steer'?'running':'idle', phase:action==='steer'?'thinking':'unknown', ...(action==='steer'?{activeTurnId:'turn-commit'}:{}) });
    const calls = [];
    const accept = async (thread,message,inputs) => {
      const image = inputs.find(input=>input.type==='localImage'); assert.ok(image);
      calls.push({action,providerSessionId:thread,message,contentHex:fs.readFileSync(image.path).toString('hex')});
      if (name === 'C02') {
        atomic.sync = (file, bytes, ...args) => {
          if (!String(file).startsWith(path.join(root,'ai-session-attachments/manifests/')) || JSON.parse(bytes).state !== 'committed' || faultCount) return original(file,bytes,...args);
          faultCount++; const undo = readonly(path.dirname(file));
          try { return original(file,bytes,...args); } finally { undo(); }
        };
        return {turnId:'turn-commit'};
      }
      if (name === 'C03') restore = readonly(path.join(root,'ai-session-attachments/manifests'));
      throw Object.assign(new Error('provider rejected'),{code:'PROVIDER_REJECTED',statusCode:503});
    };
    const control = new CodexAppServerSessionControl({registry,readyThreadClient:async()=>({startTurn:accept,steerTurn:(thread,turn,message,inputs)=>accept(thread,message,inputs)})});
    const controller = new AiSessionController(registry);
    controller.register({agent:'codex',startMessage:control.startMessage.bind(control),steerMessage:control.steerMessage.bind(control)});
    let queueId;
    if (name === 'C04') queueId = (await controller.sendMessage(session.id,{message:'Commit',mode:'queue',attachments:[inline]})).queueId;
    let lastChange = null;
    const project = () => { const s=projectSession(registry,session.id); return {...s,activeTurnId:s.activeTurnId??null,userPrompt:s.userPrompt??null}; };
    stop = registry.onChange(()=>{ lastChange=project(); });
    let outcome;
    try {
      if (name === 'C04') { if(action==='start') await controller.sendNextQueuedMessage(session.id); else await controller.steerQueuedMessage(session.id,queueId); }
      else await controller.sendMessage(session.id,{message:'Commit',mode:action==='steer'?'steer':'auto',attachments:[inline]});
      assert.fail('fault scenario must fail');
    } catch (error) {
      if (name==='C02'||name==='C03') { assert.equal(error.code,'AI_SESSION_ATTACHMENT_IO_FAILED'); assert.equal(error.cause?.code,'EACCES'); outcome={ok:false,kind:'permission-denied'}; }
      else { assert.equal(error.code,'PROVIDER_REJECTED'); assert.equal(error.statusCode,503);outcome={ok:false,code:error.code,message:error.message,statusCode:error.statusCode}; }
    } finally { restore?.(); restore=undefined; atomic.sync=original; }
    const manifest=[...owner.manifests.values()][0];assert.ok(manifest);
    const output={outcome,calls,session:project(),lastChange,after:capture(root,owner),faultCount};
    if (name==='C04') output.queue=registry.get(session.id).queue.items.map(item=>({status:item.status,messageId:item.messageId,message:item.message,attachments:item.attachments,error:item.error??null}));
    else {
      output.rollbackRetry=owner.rollbackMessage(session.id,manifest.messageId);output.afterRetry=capture(root,owner);
      assert.equal(output.rollbackRetry,name==='C03'?1:0);
    }
    output.reopened=capture(root,open());
    assert.equal(calls.length,1);
    assert.equal(output.after.manifests[0].state,(name==='C03'||name==='C04')?'staged':'draft');
    if(name==='C02') { assert.equal(faultCount,1); assert.equal(output.session.status,'running'); assert.equal(output.session.messages.length,1); }
    return normalizer([[session.id,'<session>'],[manifest.messageId,'<message>'],[manifest.id,'<attachment>']])(output);
  } finally { stop?.();restore?.();atomic.sync=original;fs.rmSync(root,{recursive:true,force:true}); }
}
async function observeAttachmentRollback(name) { return {start:await observe('start',name),steer:await observe('steer',name)}; }
module.exports={observeAttachmentRollback};
