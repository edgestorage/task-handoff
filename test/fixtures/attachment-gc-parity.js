const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { files } = require('./history-retention-parity.js');
const { AiSessionConversationAttachmentStore } = require('../../packages/ai-session-runtime/src/ai-session-conversation-attachment-store.ts');
const input = require('../../controlled-instance-rs/crates/ai-session/tests/fixtures/history-retention-parity.json').input;
const NOW = Date.parse('2026-11-05T00:00:00.000Z');
function observeAttachmentGc(name) {
  assert.equal(typeof process.getuid, 'function', 'Unix fixture');
  assert.notEqual(process.getuid(), 0, 'non-root permission fixture');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-gc-parity-'));
  let owner;
  const open = () => new AiSessionConversationAttachmentStore({ dataDir: root }, { now: () => NOW, retentionDays: 30 });
  // Reading the actual owner records avoids retrying GC while observing a failed commit.
  const capture = () => ({ retentionDays: owner.retentionDays,
    manifests: [...owner.manifests.values()].sort((a,b) => a.id.localeCompare(b.id)), files: files(root) });
  const apply = () => {
    try { return { ok: true, ...owner.setRetentionDays(0) }; }
    catch (error) { assert.equal(error.code, 'AI_SESSION_ATTACHMENT_IO_FAILED'); assert.equal(error.cause?.code, 'EACCES'); return { ok: false, kind: 'permission-denied' }; }
  };
  try {
    for (const [relative, hex] of Object.entries(input.files)) {
      const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(hex, 'hex'));
    }
    owner = open(); const output = { before: capture() };
    if (name === 'C01') { output.result = apply(); }
    else {
      const directory = path.join(root, 'ai-session-attachments/manifests');
      const permissions = fs.statSync(directory).mode;
      fs.chmodSync(directory, 0o500);
      try {
        assert.throws(() => fs.writeFileSync(path.join(directory, 'fault-probe'), ''), { code: 'EACCES' });
        output.failure = apply(); output.afterFailure = capture();
      } finally { fs.chmodSync(directory, permissions); }
      assert.deepEqual(output.failure, { ok: false, kind: 'permission-denied' });
      assert.deepEqual(output.afterFailure.files, output.before.files);
      assert.deepEqual(output.afterFailure.manifests, output.before.manifests);
      assert.equal(output.afterFailure.retentionDays, 0, 'policy changes before collection, so retry applies the same target');
      if (name === 'C03') { owner = open(); output.reopenedFailure = capture(); assert.deepEqual(output.reopenedFailure, output.before); }
      output.retry = apply();
    }
    output.after = capture(); output.repeated = owner.gc(); owner = open(); output.reopened = capture();
    assert.deepEqual(output.result ?? output.retry, { ok: true, removedDrafts: 0, expiredContent: 3 });
    assert.deepEqual(output.repeated, { removedDrafts: 0, expiredContent: 0 });
    assert.deepEqual(output.reopened, { ...output.after, retentionDays: 30 });
    assert.ok(!Object.keys(output.after.files).some(file => file.includes('/blobs/')));
    assert.ok(output.after.manifests.every(m => m.contentDeletedAt === new Date(NOW).toISOString() && m.contentDeletionReason === 'expired'));
    return output;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
module.exports = { observeAttachmentGc };
