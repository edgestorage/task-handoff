const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const WebSocket = require('ws');
const { withAttachmentApp } = require('./attachment-route-parity.js');
const { readonly } = require('./attachment-commit-parity.js');
const { files } = require('./history-retention-parity.js');
const { input: readInput } = require('./attachment-read-gc-parity.js');
const { AiSessionConversationAttachmentStore } = require('../../packages/ai-session-runtime/src/ai-session-conversation-attachment-store.ts');
const { createAiSessionRegistry } = require('../../packages/ai-session-runtime/src/ai-session-registry.ts');
const { AiSessionConversationCache } = require('../../packages/control-plane-client/src/ai-session-conversation-cache.ts');
const { applyAiSessionStreamEvent } = require('../../packages/protocol/src/ai-sessions.ts');
const clone = value => JSON.parse(JSON.stringify(value));
function inputFor(name) {
  const input = clone(readInput);
  if (name === 'C03') input.session.turns.push({ id: 'turn-latest', providerTurnId: 'turn-latest', userPrompt: 'Later', userMessages: [],
    status: 'completed', phase: 'responding', revision: 1, startedAt: '2026-11-06T00:01:00.000Z', updatedAt: '2026-11-06T00:01:00.000Z', completedAt: '2026-11-06T00:01:00.000Z' });
  return input;
}
async function connect(base) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/events?aiSessionAuthoritySnapshot=1');
  const queue = []; let wake, previous = 0;
  socket.on('message', bytes => { const value = JSON.parse(String(bytes)); assert.ok(value.seq > previous); previous = value.seq; queue.push(value); wake?.(); });
  await once(socket, 'open');
  return { async next(type, optional = false) {
    const deadline = AbortSignal.timeout(3000);
    while (!deadline.aborted) {
      while (queue.length) { const value = queue.shift(); if (value.type === type) return { type: value.type, payload: value.payload }; }
      await new Promise(resolve => { wake = resolve; deadline.addEventListener('abort', resolve, { once: true }); });
      wake = undefined;
    }
    if (!optional) throw new Error(`missing ${type}`);
    return null;
  }, async close() { const closed = once(socket, 'close'); socket.close(); await closed; } };
}
function consume(output) {
  const cache = new AiSessionConversationCache();
  const initial = output.initial.body.data;
  const summary = initial.snapshot.sessions[0];
  const index = output.initialIndex.body.data;
  const body = output.initialBody.body.data;
  cache.setTurnIndex('instance', index.revision, clone(index.index));
  assert.equal(cache.setTurn('instance', summary.id, body.revision, body.body.turn), true);
  const applied = output.patch ? applyAiSessionStreamEvent(initial, output.patch) : { kind: 'no-event', projection: initial };
  const nextSummary = applied.projection.snapshot.sessions[0];
  const needsIndex = !cache.hasTurnIndex('instance', nextSummary);
  const next = output.retry.body.data;
  if (next.kind === 'updated') cache.setTurnIndex('instance', next.revision, clone(next.index));
  const fresh = output.freshBody.body.data;
  const accepted = cache.setTurn('instance', summary.id, fresh.revision, fresh.body.turn);
  return { applyKind: applied.kind, needsIndex, accepted, current: cache.hasCurrentTurn('instance', summary.id, 'turn-read'),
    contentState: cache.projection('instance', nextSummary).turns[0].userMessages[0].attachments[0].contentState };
}
function normalize(output, seed, start, end) {
  const stream = output.initial.body.data.streamId;
  const event1 = output.initial.body.data.lastEventAt;
  const event2 = output.patch?.payload.meta.generatedAt;
  const instance = output.bootstrap.payload.meta.instanceId;
  const traces = new Map(); let gc;
  for (const [key, marker] of [['bootstrap', '<bootstrap-time>'], ['reconnect', '<reconnect-time>']]) {
    const meta = output[key].payload.meta;
    assert.ok(Date.parse(meta.generatedAt) >= start && Date.parse(meta.generatedAt) <= end);
    meta.generatedAt = marker;
  }
  if (event2) assert.equal(output.after.body.data.lastEventAt, event2);
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'streamId') { assert.equal(child, stream); value[key] = '<stream>'; }
      else if (key === 'instanceId') { assert.equal(child, instance); value[key] = '<instance>'; }
      else if (key === 'traceId') { if (!traces.has(child)) traces.set(child, `<trace-${traces.size + 1}>`); value[key] = traces.get(child); }
      else if (key === 'generatedAt' && ['<bootstrap-time>', '<reconnect-time>'].includes(child)) continue;
      else if (key === 'generatedAt' || key === 'lastEventAt') {
        assert.ok(Date.parse(child) >= start && Date.parse(child) <= end);
        assert.ok(child === event1 || child === event2); value[key] = child === event2 ? '<event-2>' : '<event-1>';
      } else if (key === 'updatedAt' && value.sessions) {
        assert.ok(Date.parse(child) >= start && Date.parse(child) <= end); value[key] = '<snapshot-time>';
      } else if ((key === 'createdAt' || key === 'committedAt') && child === seed) value[key] = '<seed-time>';
      else if (key === 'contentDeletedAt') { assert.ok(Date.parse(child) >= start && Date.parse(child) <= end); gc ??= child; assert.equal(child, gc); value[key] = '<gc-time>'; }
      else walk(child);
    }
  };
  walk(output); return output;
}
async function observeAttachmentAuthority(name) {
  const input = inputFor(name), start = Date.now(), seed = new Date(start).toISOString();
  let registry, owner, rootPath, restore, client, stopOwnerChanges;
  const originalGc = AiSessionConversationAttachmentStore.prototype.gc;
  AiSessionConversationAttachmentStore.prototype.gc = function(...args) { if (rootPath && this.root === path.join(rootPath, 'ai-session-attachments')) owner = this; return originalGc.apply(this, args); };
  try {
    return await withAttachmentApp(async (app, root) => {
      await app.ready(); assert.ok(owner); registry.conversationAttachments = owner;
      await app.listen({ host: '127.0.0.1', port: 0 });
      const base = `http://127.0.0.1:${app.server.address().port}`;
      const get = async url => { const response = await fetch(base + url); return { status: response.status, body: await response.json() }; };
      const sessionPath = `/api/ai-sessions/${input.session.id}`;
      const output = { initial: await get('/api/ai-sessions/state'), initialIndex: await get(sessionPath + '/turns?projection=index'), initialBody: await get(sessionPath + '/turns/turn-read') };
      const initial = output.initial.body.data;
      assert.equal(initial.revision, 1);
      client = await connect(base); await client.next('streams.hello'); output.bootstrap = await client.next('ai-session.snapshot');
      const capture = () => ({ files: files(root), rawTurns: clone(registry.get(input.session.id).turns) });
      let contentChanges = 0;
      stopOwnerChanges = owner.onContentChange(() => { contentChanges += 1; });
      output.before = capture();
      restore = readonly(path.join(root, 'ai-session-attachments/manifests'));
      assert.throws(() => owner.setRetentionDays(0), error => error.code === 'AI_SESSION_ATTACHMENT_IO_FAILED');
      assert.deepEqual(capture(), output.before);
      assert.equal(contentChanges, 0, "failed policy GC must not notify content change");
      const conditional = sessionPath + '/turns?projection=index&revision=' + output.initialIndex.body.data.revision;
      if (name === 'C02') { output.failure = await get(conditional); output.afterFailure = await get('/api/ai-sessions/state'); output.failureDisk = capture(); output.computedFailure = clone(registry.boundSnapshot([])); }
      assert.equal(contentChanges, 0, "failed read must not notify content change");
      restore(); restore = undefined;
      output.retry = await get(conditional);
      assert.equal(contentChanges, 1, "one durable expiry must notify");
      output.patch = await client.next('ai-session.patch', true);
      output.after = await get('/api/ai-sessions/state');
      output.computed = clone(registry.boundSnapshot([]));
      output.freshIndex = await get(sessionPath + '/turns?projection=index'); output.freshBody = await get(sessionPath + '/turns/turn-read');
      output.repeated = await get(sessionPath + '/turns?projection=index&revision=' + output.freshIndex.body.data.revision);
      assert.equal(contentChanges, 1, "unchanged reads must not re-notify");
      output.afterRepeated = await get('/api/ai-sessions/state'); output.afterDisk = capture();
      output.delta = await get(`/api/ai-sessions?streamId=${initial.streamId}&sinceRevision=${initial.revision}`);
      await client.close(); client = await connect(base); await client.next('streams.hello'); output.reconnect = await client.next('ai-session.snapshot');
      output.consumer = consume(output);
      console.error(`U03.11 ${name}: ${JSON.stringify({ retry: output.retry.body.data, patch: output.patch, computed: output.computed.sessions[0], consumer: output.consumer })}`);
      return normalize(output, seed, start, Date.now());
    }, root => {
      rootPath = root;
      const hash = crypto.createHash('sha256').update('read bytes').digest('hex');
      const attachment = input.attachment;
      const manifest = { schemaVersion: 1, id: attachment.id, inputId: 'input-read', sessionId: input.session.id, messageId: 'message-read', turnId: 'turn-read',
        kind: attachment.kind, name: attachment.name, mime: attachment.mime, size: attachment.size, blobHash: hash, sourceType: 'inline', state: 'committed', createdAt: seed, committedAt: seed };
      for (const [relative, bytes] of Object.entries({ [`ai-session-attachments/manifests/${attachment.id}.json`]: JSON.stringify(manifest, null, 2) + '\n',
        [`ai-session-attachments/blobs/${hash}`]: 'read bytes', [`ai-sessions/${input.session.id}.json`]: JSON.stringify(input.session) })) {
        const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
      }
      registry = createAiSessionRegistry({ dir: path.join(root, 'ai-sessions') });
      return { aiSessionRegistry: registry, aiSessionDiscovery: { register() {}, async refresh() {} } };
    });
  } finally { stopOwnerChanges?.(); await client?.close(); restore?.(); AiSessionConversationAttachmentStore.prototype.gc = originalGc; }
}
function assertAuthority(name, output) {
  const initial = output.initial.body.data, after = output.after.body.data;
  assert.equal(output.retry.status, 200); assert.equal(output.retry.body.data.kind, 'updated');
  assert.ok(output.patch, 'GC must notify the authority without discovery/polling');
  assert.equal(output.patch.type, 'ai-session.patch'); assert.equal(after.revision, initial.revision + 1);
  assert.equal(output.patch.payload.meta.previousRevision, initial.revision); assert.equal(output.patch.payload.meta.revision, after.revision);
  const summary = after.snapshot.sessions[0];
  assert.equal(summary.turnsRevision, output.freshIndex.body.data.revision);
  assert.notEqual(summary.turnsRevision, initial.snapshot.sessions[0].turnsRevision);
  assert.deepEqual(output.computed.sessions, after.snapshot.sessions);
  assert.deepEqual(output.afterRepeated, output.after);
  assert.equal(output.repeated.body.data.kind, 'not-modified');
  if (name === 'C03') assert.deepEqual(summary.latestTurnRef, initial.snapshot.sessions[0].latestTurnRef);
  else assert.equal(summary.latestTurnRef.bodyRevision, output.freshBody.body.data.revision);
  assert.deepEqual(output.afterDisk.rawTurns, output.before.rawTurns);
  assert.equal(output.delta.body.data.events.length, 1); assert.deepEqual(output.delta.body.data.events[0], output.patch);
  assert.deepEqual(output.reconnect.payload.snapshot.sessions, after.snapshot.sessions);
  assert.deepEqual(output.consumer, { applyKind: 'applied', needsIndex: true, accepted: true, current: true, contentState: 'expired' });
  if (name === 'C02') { assert.equal(output.failure.status, 500); assert.deepEqual(output.afterFailure, output.initial); assert.deepEqual(output.failureDisk, output.before); assert.deepEqual(output.computedFailure.sessions, initial.snapshot.sessions); }
}
module.exports = { observeAttachmentAuthority, inputFor, assertAuthority, consume };
