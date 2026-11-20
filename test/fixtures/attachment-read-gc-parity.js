const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withAttachmentApp } = require('./attachment-route-parity.js');
const { files } = require('./history-retention-parity.js');
const { readonly } = require('./attachment-commit-parity.js');
const { AiSessionConversationAttachmentStore } = require('../../packages/ai-session-runtime/src/ai-session-conversation-attachment-store.ts');
const { AiSessionHistoryStore } = require('../../packages/ai-session-runtime/src/ai-session-history-store.ts');
const { createAiSessionRegistry } = require('../../packages/ai-session-runtime/src/ai-session-registry.ts');
const timestamp = '2026-11-06T00:00:00.000Z';
const attachment = { id: 'att_0123456789abcdef01234567', kind: 'image', name: 'read.png', mime: 'image/png', size: 10, contentState: 'available' };
const turn = { id: 'turn-read', providerTurnId: 'turn-read', userPrompt: 'Read', userMessages: [{ id: 'message-read', text: 'Read', attachments: [attachment] }],
  status: 'completed', phase: 'responding', revision: 1, startedAt: timestamp, updatedAt: timestamp, completedAt: timestamp };
const session = { id: 'ses_0000000000310', agent: 'codex', creationSource: 'ai-session', providerSessionId: 'thread-read', title: 'Read', cwd: '/workspace',
  turns: [turn], status: 'idle', phase: 'unknown', startedAt: timestamp, updatedAt: timestamp,
  counters: { toolCalls: 0, edits: 0, approvals: 0 }, toolCallsSinceLastMessage: 0, subAgents: [], queue: { revision: 0, pendingCount: 0, items: [] }, unread: false };
const item = { id: session.id, agent: 'codex', creationSource: 'ai-session', providerSessionId: 'thread-read', title: 'Read', cwd: '/workspace', lastActiveAt: timestamp, archivedAt: timestamp };
const { revision: _revision, ...historyTurn } = turn;
const input = { session, item, turn, historyTurn, attachment, contentHex: Buffer.from('read bytes').toString('hex') };
const paths = { history: `/api/ai-sessions/history/${session.id}`, detail: `/api/ai-sessions/${session.id}`,
  turns: `/api/ai-sessions/${session.id}/turns`, index: `/api/ai-sessions/${session.id}/turns?projection=index`, single: `/api/ai-sessions/${session.id}/turns/turn-read` };

function normalizeClocks(value, seedTime, start, end) {
  let deletionTime;
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'createdAt' || key === 'committedAt') && child === seedTime) value[key] = '<seed-time>';
      else if (key === 'contentDeletedAt') {
        assert.ok(Date.parse(child) >= start && Date.parse(child) <= end);
        deletionTime ??= child; assert.equal(child, deletionTime);
        value[key] = '<gc-time>';
      } else walk(child);
    }
  };
  walk(value); return value;
}

async function observe(name, endpoint) {
  let owner, history, registry, restore;
  const originalGc = AiSessionConversationAttachmentStore.prototype.gc;
  const originalList = AiSessionHistoryStore.prototype.list;
  let rootPath;
  const start = Date.now(), seedTime = new Date(start).toISOString();
  AiSessionConversationAttachmentStore.prototype.gc = function(...args) {
    if (rootPath && this.root === path.join(rootPath, 'ai-session-attachments')) owner = this;
    return originalGc.apply(this, args);
  };
  AiSessionHistoryStore.prototype.list = function(...args) {
    if (rootPath && this.path() === path.join(rootPath, 'ai-session-history/index.json')) history = this;
    return originalList.apply(this, args);
  };
  try {
    return await withAttachmentApp(async (app, root) => {
      await app.ready(); assert.ok(owner && history);
      // Connect the injected session registry to the actual createWebApp owner;
      // do not create a second attachment authority for the live routes.
      registry.conversationAttachments = owner;
      history.upsert(item, [historyTurn]);
      // Snapshot the JSON persistence model by value. TS reducer objects also
      // contain undefined properties, which have no JSON representation.
      const capture = () => ({ files: files(root), rawTurns: JSON.parse(JSON.stringify(registry.get(session.id).turns)) });
      const get = async revision => {
        const url = paths[endpoint] + (revision ? `${paths[endpoint].includes('?') ? '&' : '?'}revision=${encodeURIComponent(revision)}` : '');
        const response = await app.inject({ method: 'GET', url });
        assert.match(response.headers['content-type'], /^application\/json(?:; charset=utf-8)?$/);
        return { status: response.statusCode, contentType: 'application/json', body: response.json() };
      };
      const output = { before: capture(), initial: await get() };
      assert.equal(output.initial.status, 200);
      const previousRevision = output.initial.body.data.revision;
      if (name !== 'C01') {
        restore = readonly(path.join(root, 'ai-session-attachments/manifests'));
        assert.throws(() => owner.setRetentionDays(0), error => error.code === 'AI_SESSION_ATTACHMENT_IO_FAILED' && error.cause?.code === 'EACCES');
        assert.equal(owner.retentionDays, 0);
        assert.deepEqual(capture(), output.before, 'failed setup GC must preserve every owner and byte');
        if (name === 'C03') { restore(); restore = undefined; }
      }
      try { output.response = await get(previousRevision); output.after = capture(); }
      finally { restore?.(); restore = undefined; }
      console.error(`U03.10 ${name}/${endpoint}: ${JSON.stringify(output.response)}`);
      output.retry = await get(previousRevision); output.afterRetry = capture();
      output.repeated = await get(output.retry.body.data?.revision);
      output.afterRepeated = capture();
      output.fresh = await get(); output.afterFresh = capture();
      const reopened = new AiSessionConversationAttachmentStore({ dataDir: root });
      output.reopened = { files: files(root), attachments: reopened.attachmentsForMessage(session.id, 'message-read') };
      return normalizeClocks(output, seedTime, start, Date.now());
    }, root => {
      rootPath = root;
      const hash = crypto.createHash('sha256').update('read bytes').digest('hex');
      const manifest = { schemaVersion: 1, id: attachment.id, inputId: 'input-read', sessionId: session.id, messageId: 'message-read', turnId: 'turn-read',
        kind: attachment.kind, name: attachment.name, mime: attachment.mime, size: attachment.size, blobHash: hash, sourceType: 'inline', state: 'committed', createdAt: seedTime, committedAt: seedTime };
      for (const [relative, bytes] of Object.entries({ [`ai-session-attachments/manifests/${attachment.id}.json`]: JSON.stringify(manifest, null, 2) + '\n',
        [`ai-session-attachments/blobs/${hash}`]: 'read bytes', [`ai-sessions/${session.id}.json`]: JSON.stringify(session) })) {
        const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
      }
      registry = createAiSessionRegistry({ dir: path.join(root, 'ai-sessions') });
      return { aiSessionRegistry: registry };
    });
  } finally {
    restore?.(); AiSessionConversationAttachmentStore.prototype.gc = originalGc; AiSessionHistoryStore.prototype.list = originalList;
  }
}
async function observeAttachmentReadGc(name) {
  const output = {};
  for (const endpoint of Object.keys(paths)) output[endpoint] = await observe(name, endpoint);
  return output;
}
// Revisions are retained byte-for-byte. U03.11 makes index content identity
// advance when an attachment projection changes, while metadata stays stable.
function assertObservation(name, actual) {
  const initialBodyRevision = 'IrUod86r0Ztqs0_3undKrK';
  const bodyRevision = name === 'C01' ? initialBodyRevision : 'ZVCm3KKYDbHv_-QDQe2AHP';
  for (const [endpoint, observation] of Object.entries(actual)) {
    const { before, initial, response, after, retry, repeated, fresh, afterRetry, afterRepeated, afterFresh, reopened } = observation;
    assert.equal(response.status, name === 'C02' ? 500 : 200);
    if (name === 'C02') {
      assert.deepEqual(response.body, { error: { code: 'AI_SESSION_ATTACHMENT_IO_FAILED', message: 'AI session attachment manifest could not be persisted.' } });
      assert.deepEqual(after, before, `${endpoint}: failed read must preserve manifest/blob/raw turns`);
    }
    assert.equal(retry.status, 200); assert.equal(repeated.status, 200); assert.equal(fresh.status, 200);
    for (const snapshot of [after, afterRetry, afterRepeated, afterFresh]) assert.deepEqual(snapshot.rawTurns, before.rawTurns);
    assert.deepEqual(afterRepeated, afterRetry); assert.deepEqual(afterFresh, afterRetry);
    assert.deepEqual(reopened.files, afterRetry.files);
    assert.equal(reopened.attachments[0].contentState, name === 'C01' ? 'available' : 'expired');
    if (endpoint === 'single') {
      assert.equal(initial.body.data.revision, initialBodyRevision);
      assert.equal(retry.body.data.revision, bodyRevision);
      assert.equal(retry.body.data.kind, name === 'C01' ? 'not-modified' : 'updated');
      assert.deepEqual(repeated.body.data, { kind: 'not-modified', revision: bodyRevision });
      assert.equal(fresh.body.data.body.turn.userMessages[0].attachments[0].contentState, name === 'C01' ? 'available' : 'expired');
    }
    if (endpoint === 'index') {
      assert.equal(fresh.body.data.index.turns[0].bodyRevision, bodyRevision);
      if (name === 'C01') assert.equal(fresh.body.data.revision, initial.body.data.revision);
      else {
        assert.notEqual(fresh.body.data.revision, initial.body.data.revision);
        assert.equal(retry.body.data.kind, 'updated');
      }
    }
  }
}
module.exports = { observeAttachmentReadGc, assertObservation, input };
