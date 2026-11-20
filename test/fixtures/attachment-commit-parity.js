const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { files } = require('./history-retention-parity.js');
const { AiSessionConversationAttachmentStore } = require('../../packages/ai-session-runtime/src/ai-session-conversation-attachment-store.ts');
const { AiSessionController } = require('../../packages/ai-session-runtime/src/ai-session-control.ts');
const { createAiSessionRegistry } = require('../../packages/ai-session-runtime/src/ai-session-registry.ts');
const { CodexAppServerSessionControl } = require('../../packages/ai-session-runtime/src/codex-app-server/session/control.ts');
const NOW = Date.parse('2026-11-06T00:00:00.000Z');
const inline = { id: 'input-commit', kind: 'image', name: 'input.png', mime: 'image/png', size: 12,
  source: { type: 'inline', encoding: 'base64', data: Buffer.from('commit bytes').toString('base64') } };
function fixtureRoot() {
  assert.equal(typeof process.getuid, 'function'); assert.notEqual(process.getuid(), 0);
  return fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-commit-parity-'));
}
function readonly(directory) {
  const permissions = fs.statSync(directory).mode; fs.chmodSync(directory, 0o500);
  try { assert.throws(() => fs.writeFileSync(path.join(directory, 'fault-probe'), ''), { code: 'EACCES' }); }
  catch (error) { fs.chmodSync(directory, permissions); throw error; }
  return () => fs.chmodSync(directory, permissions);
}
function normalizer(identities) {
  // This is a bijection for the one actual identity of each domain. Every
  // reference and manifest filename uses it; timestamps and bytes stay exact.
  return function normalize(value) {
    if (typeof value === 'string') {
      for (const [id, label] of identities) value = value.split(id).join(label);
      return value;
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,child]) => [normalize(key),normalize(child)]));
    return value;
  };
}
const capture = (root, owner) => ({ files: files(root), manifests: [...owner.manifests.values()].sort((a,b) => a.id.localeCompare(b.id)), drafts: [...owner.drafts.values()].sort((a,b) => a.id.localeCompare(b.id)) });
function projectSession(registry, id) {
  const current = registry.get(id);
  return { status: current.status, phase: current.phase, activeTurnId: current.activeTurnId, userPrompt: current.userPrompt,
    messages: (current.turns || []).flatMap(turn => (turn.userMessages || []).map(message => ({ turnId: turn.providerTurnId || turn.id, id: message.id, text: message.text, attachments: message.attachments }))) };
}
function result(call) {
  try { return { ok: true, count: call() }; }
  catch (error) { assert.equal(error.code, 'AI_SESSION_ATTACHMENT_IO_FAILED'); assert.equal(error.cause?.code, 'EACCES'); return { ok: false, kind: 'permission-denied' }; }
}
function observeCommitOwner(name) {
  const root = fixtureRoot(); const open = () => new AiSessionConversationAttachmentStore({ dataDir: root }, { now: () => NOW });
  try {
    let owner = open();
    const staged = owner.stageMessage({ sessionId: 'session-commit', messageId: 'message-commit', attachments: [inline] });
    const normalize = normalizer([[staged.attachments[0].id, '<attachment>']]);
    const commit = () => result(() => owner.commitMessage('session-commit', 'message-commit', 'turn-commit'));
    const output = { before: capture(root, owner) };
    if (name === 'C01') output.result = commit();
    else {
      const restore = readonly(path.join(root, 'ai-session-attachments/manifests'));
      try { output.failure = commit(); output.afterFailure = capture(root, owner); }
      finally { restore(); }
      assert.deepEqual(output.failure, { ok: false, kind: 'permission-denied' });
      assert.deepEqual(output.afterFailure, output.before);
      if (name === 'C03') { owner = open(); output.reopenedFailure = capture(root, owner); }
      output.retry = commit();
    }
    output.after = capture(root, owner); owner.now = () => NOW + 3600000; output.repeated = commit(); owner = open(); output.reopened = capture(root, owner);
    assert.deepEqual(output.reopened, output.after);
    assert.deepEqual(output.result ?? output.retry, { ok: true, count: 1 });
    return normalize(output);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
async function observeCommitProvider(action, fail) {
  const root = fixtureRoot(); let restore, stop;
  try {
    const owner = new AiSessionConversationAttachmentStore({ dataDir: root }, { now: () => NOW });
    const registry = createAiSessionRegistry({ dir: path.join(root, 'sessions'), conversationAttachments: owner });
    const session = registry.applyAdapterSnapshot({ source: 'control', agent: 'codex', creationSource: 'ai-session',
      providerSessionId: 'thread-commit', cwd: root, status: action === 'steer' ? 'running' : 'idle',
      phase: action === 'steer' ? 'thinking' : 'unknown', ...(action === 'steer' ? { activeTurnId: 'turn-commit' } : {}) });
    const calls = [];
    const accept = async (thread, message, inputs) => {
      const image = inputs.find(input => input.type === 'localImage'); assert.ok(image);
      calls.push({ action, providerSessionId: thread, message, contentHex: fs.readFileSync(image.path).toString('hex') });
      if (fail) restore = readonly(path.join(root, 'ai-session-attachments/manifests'));
      return { turnId: 'turn-commit' };
    };
    const client = { startTurn: accept, steerTurn: (thread, turn, message, inputs) => { assert.equal(turn, 'turn-commit'); return accept(thread,message,inputs); } };
    const control = new CodexAppServerSessionControl({ registry, readyThreadClient: async () => client });
    const controller = new AiSessionController(registry);
    controller.register({ agent: 'codex', startMessage: control.startMessage.bind(control), steerMessage: control.steerMessage.bind(control) });
    let lastChange = null;
    stop = registry.onChange(() => { lastChange = projectSession(registry,session.id); });
    let outcome;
    try { const sent = await controller.sendMessage(session.id, { message: 'Commit', mode: action === 'steer' ? 'steer' : 'auto', attachments: [inline] }); outcome = { ok: true, action: sent.action }; }
    catch (error) { assert.equal(error.code, 'AI_SESSION_ATTACHMENT_IO_FAILED'); assert.equal(error.cause?.code, 'EACCES'); outcome = { ok: false, kind: 'permission-denied' }; }
    finally { restore?.(); restore = undefined; }
    const manifest = [...owner.manifests.values()][0]; assert.ok(manifest);
    const normalize = normalizer([[session.id,'<session>'],[manifest.messageId,'<message>'],[manifest.id,'<attachment>']]);
    const project = () => projectSession(registry,session.id);
    const output = { outcome, calls, session: project(), lastChange, after: capture(root, owner) };
    assert.equal(calls.length, 1); assert.equal(output.session.status, 'running'); assert.equal(output.session.messages.length, 1);
    assert.deepEqual(outcome, fail ? { ok: false, kind: 'permission-denied' } : { ok: true, action: action === 'start' ? 'send' : 'steer' });
    if (fail) { output.retry = result(() => owner.commitMessage(session.id, manifest.messageId, 'turn-commit')); output.afterRetry = capture(root, owner); output.sessionAfterRetry = project(); assert.deepEqual(output.sessionAfterRetry,output.session); }
    const reopenedOwner = new AiSessionConversationAttachmentStore({ dataDir: root }, { now: () => NOW }); output.reopened = capture(root, reopenedOwner);
    assert.deepEqual(output.reopened, output.afterRetry ?? output.after);
    return normalize(output);
  } finally { stop?.(); restore?.(); fs.rmSync(root, { recursive: true, force: true }); }
}
async function observeAttachmentCommit(name) {
  if (name === 'C04' || name === 'C05') {
    const action = name === 'C04' ? 'start' : 'steer';
    return { success: await observeCommitProvider(action,false), failure: await observeCommitProvider(action,true) };
  }
  return observeCommitOwner(name);
}
module.exports = { observeAttachmentCommit, fixtureRoot, readonly, normalizer, capture, projectSession, inline, NOW };
