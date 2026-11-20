const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
require('./attachment-route-parity.js');
const atomic = require('write-file-atomic');
const { AiSessionHistoryStore } = require('../../packages/ai-session-runtime/src/ai-session-history-store.ts');
const { AiSessionConversationAttachmentStore } = require('../../packages/ai-session-runtime/src/ai-session-conversation-attachment-store.ts');

const NOW = Date.parse('2026-11-05T00:00:00.000Z');
const directories = ['ai-session-history', 'ai-session-attachments'];
const names = ['old-root', 'old-child', 'new-root', 'newest-root'];
const id = name => `history-${name}`;
const body = (root, name) => path.join(root, 'ai-session-history/details', `${crypto.createHash('sha256').update(id(name)).digest('hex')}.json`);

function files(root, raw = false) {
  const result = {};
  const walk = relative => {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).isDirectory()) {
      for (const child of fs.readdirSync(file).sort()) walk(`${relative}/${child}`);
    } else {
      const bytes = fs.readFileSync(file);
      result[relative] = raw || !relative.endsWith('.json') ? bytes.toString('hex') : JSON.parse(bytes);
    }
  };
  directories.forEach(walk);
  return result;
}

function seedHistoryRetention() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-retention-seed-'));
  try {
    const owner = new AiSessionHistoryStore({ dataDir: root }, { limit: 10 });
    const attachments = new AiSessionConversationAttachmentStore({ dataDir: root }, { now: () => NOW });
    const items = names.map((name, index) => ({ id: id(name), agent: 'codex', creationSource: 'ai-session',
      providerSessionId: `provider-${name}`, title: name, cwd: '/workspace',
      ...(name === 'old-child' ? { lineage: { kind: 'subagent', parentProviderSessionId: 'provider-old-root' } } : {}),
      lastActiveAt: new Date(NOW + index * 1000).toISOString(), archivedAt: new Date(NOW + index * 1000).toISOString() }));
    for (const item of items.slice(0, 3)) {
      const content = item.id === id('old-child') ? 'child bytes' : 'shared bytes';
      const messageId = `message-${item.id}`;
      const staged = attachments.stageMessage({ sessionId: item.id, messageId,
        attachments: [{ id: 'input', kind: 'image', name: 'input.png', mime: 'image/png', size: Buffer.byteLength(content),
          source: { type: 'inline', data: Buffer.from(content).toString('base64') } }] });
      attachments.commitMessage(item.id, messageId, `turn-${item.id}`);
      owner.upsert(item, [{ id: `turn-${item.id}`, status: 'completed',
        userMessages: [{ id: messageId, text: item.title, attachments: staged.attachments }] }]);
    }
    return { items, files: files(root, true) };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function observeHistoryRetention(name, input) {
  if (name === 'C01') return Object.fromEntries(['limit', 'upsert'].map(variant => [variant, observeHistoryRetention(`C01-${variant}`, input)]));
  if (name === 'C02' || name === 'C04') return Object.fromEntries(['remove', 'activate', 'identity'].map(variant => [variant, observeHistoryRetention(`${name}-${variant}`, input)]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-retention-parity-'));
  const index = path.join(root, 'ai-session-history/index.json');
  const original = atomic.sync;
  const originalUnlink = fs.unlinkSync;
  const removed = [];
  const warnings = [];
  const attachments = () => new AiSessionConversationAttachmentStore({ dataDir: root }, { now: () => NOW });
  let resourceOwner;
  const store = limit => new AiSessionHistoryStore({ dataDir: root }, { limit,
    onWarning: warning => warnings.push(warning), onRemove: sessionId => {
      assert.ok(!JSON.parse(fs.readFileSync(index, 'utf8')).items.some(item => item.id === sessionId), 'resources must follow index commit');
      removed.push(sessionId); resourceOwner.releaseSession(sessionId);
    } });
  const capture = owner => ({ limit: owner.retentionLimit(), items: owner.list(), files: files(root) });
  const remove = (owner, variant) => variant === 'remove' ? owner.remove(id('old-root'))
    : variant === 'activate' ? owner.activate(id('old-root')) : owner.activateIdentity('codex', 'provider-old-root');
  const rejectIndex = run => {
    let attempted = false;
    atomic.sync = (file, ...args) => {
      if (file !== index) return original(file, ...args);
      attempted = true;
      const bytes = fs.readFileSync(index);
      fs.renameSync(index, `${index}.before`); fs.mkdirSync(index);
      try { return original(file, ...args); }
      finally { fs.rmdirSync(index); fs.renameSync(`${index}.before`, index); assert.deepEqual(fs.readFileSync(index), bytes); }
    };
    try { assert.throws(run, error => ['EISDIR', 'EPERM'].includes(error.code)); }
    finally { atomic.sync = original; }
    assert.equal(attempted, true, 'failure must reach the real index writer');
  };
  try {
    for (const [relative, hex] of Object.entries(input.files)) {
      const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(hex, 'hex'));
    }
    resourceOwner = attachments();
    let owner = store(10);
    let result;
    if (name.startsWith('C01-')) {
      if (name === 'C01-limit') {
        const applied = owner.setRetentionLimit(1);
        result = { limit: applied.limit, removedIds: applied.removed.map(item => item.id) };
      } else {
        owner.setRetentionLimit(2);
        result = owner.upsert(input.items[3], []);
      }
      assert.deepEqual(removed, [id('old-child'), id('old-root')]);
    } else if (name.startsWith('C02-')) {
      const variant = name.slice(4);
      result = remove(owner, variant);
      assert.equal(result, true);
      assert.deepEqual(removed, variant === 'remove' ? [id('old-child'), id('old-root')] : []);
    } else if (name === 'C03' || name.startsWith('C04-')) {
      const before = files(root, true);
      rejectIndex(() => name === 'C03' ? owner.setRetentionLimit(1) : remove(owner, name.slice(4)));
      // Failure must not publish a new destructive policy that a later read
      // could apply without the failed caller's consent.
      assert.equal(owner.retentionLimit(), 10, 'failed index commit must preserve the active retention limit');
      assert.deepEqual(removed, []);
      assert.deepEqual(files(root, true), before, 'all owned bytes must survive a rejected index commit');
      const afterFailure = capture(owner);
      assert.deepEqual(files(root, true), before, 'ordinary reads after failure must not evict data');
      owner = store(10); resourceOwner = attachments();
      const reopened = capture(owner);
      const applied = name === 'C03' ? owner.setRetentionLimit(1) : remove(owner, name.slice(4));
      result = { failed: true, afterFailure, reopened, retry: name === 'C03' ? { limit: applied.limit, removedIds: applied.removed.map(item => item.id) } : applied };
    } else if (name === 'C05') {
      const target = body(root, 'old-child');
      let attempted = false;
      fs.unlinkSync = file => {
        if (file === target) {
          attempted = true;
          const backup = `${target}.before`;
          fs.renameSync(target, backup); fs.mkdirSync(target);
          try { return originalUnlink(file); }
          finally { fs.rmdirSync(target); fs.renameSync(backup, target); }
        }
        return originalUnlink(file);
      };
      try { result = owner.remove(id('old-root')); }
      finally { fs.unlinkSync = originalUnlink; }
      assert.equal(attempted, true);
      assert.ok(warnings.some(warning => warning.id === id('old-child') && warning.reason === 'detail cleanup failed'));
      assert.equal(fs.existsSync(target), true);
      assert.deepEqual(removed, [id('old-child'), id('old-root')]);
      result = { removed: result, cleanupWarned: true, repeated: owner.remove(id('old-root')) };
    } else throw new Error(`Unknown case ${name}`);
    const after = capture(owner);
    owner = store(owner.retentionLimit()); resourceOwner = attachments();
    const reopened = capture(owner);
    assert.deepEqual(reopened, after);
    return { result, after, reopened };
  } finally { atomic.sync = original; fs.unlinkSync = originalUnlink; fs.rmSync(root, { recursive: true, force: true }); }
}

module.exports = { seedHistoryRetention, observeHistoryRetention, files };
