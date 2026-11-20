const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { files } = require('./history-retention-parity.js');
const { AiSessionHistoryStore } = require('../../packages/ai-session-runtime/src/ai-session-history-store.ts');
const { AiSessionConversationAttachmentStore } = require('../../packages/ai-session-runtime/src/ai-session-conversation-attachment-store.ts');
const input = require('../../controlled-instance-rs/crates/ai-session/tests/fixtures/history-retention-parity.json').input;
const NOW = Date.parse('2026-11-05T00:00:00.000Z');
const roles = ['old-child', 'old-root', 'new-root'];
const manifests = Object.entries(input.files).filter(([file]) => file.includes('/manifests/'))
  .map(([file, bytes]) => ({ file, record: JSON.parse(Buffer.from(bytes, 'hex')) }));

function observeAttachmentCleanup(name, assertInvariant = true) {
  if (name === 'C02') return Object.fromEntries(['live', 'reopen'].map(variant => [variant, observeAttachmentCleanup(`C02-${variant}`, assertInvariant)]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-cleanup-parity-'));
  const unlink = fs.unlinkSync;
  const warnings = [];
  let owner;
  const open = () => new AiSessionConversationAttachmentStore({ dataDir: root }, { now: () => NOW, onWarning: warning => warnings.push(warning) });
  const history = () => new AiSessionHistoryStore({ dataDir: root }, { limit: 10, onRemove: id => owner.releaseSession(id) });
  const manifest = manifests.find(({ record }) => record.sessionId === 'history-old-child');
  assert.ok(manifest);
  const target = path.join(root, manifest.file);
  const targetId = manifest.record.id;
  function capture() {
    const messages = Object.fromEntries(roles.map(role => {
      const session = `history-${role}`, message = `message-${session}`;
      const id = manifests.find(({ record }) => record.sessionId === session).record.id;
      const attachments = owner.attachmentsForMessage(session, message);
      let content;
      try {
        const result = owner.content(session, message, id);
        content = { attachment: result.attachment, path: path.relative(root, result.path),
          bytes: fs.readFileSync(result.path).toString('hex'), etag: result.etag, cacheUntil: result.cacheUntil };
      } catch (error) { content = { code: error.code, statusCode: error.statusCode, message: error.message }; }
      return [role, { attachments, content }];
    }));
    return { items: history().list(), messages, files: files(root) };
  }
  const failUnlink = run => {
    let attempted = false;
    fs.unlinkSync = file => {
      if (file !== target) return unlink(file);
      attempted = true;
      fs.renameSync(target, `${target}.before`); fs.mkdirSync(target);
      try { return unlink(file); }
      finally { fs.rmdirSync(target); fs.renameSync(`${target}.before`, target); }
    };
    let result;
    try { result = run(); } finally { fs.unlinkSync = unlink; }
    assert.equal(attempted, true, 'must reach real filesystem unlink');
    return result;
  };
  try {
    for (const [file, bytes] of Object.entries(input.files)) {
      const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, Buffer.from(bytes, 'hex'));
    }
    owner = open();
    const output = {};
    const before = files(root, true);
    if (name.startsWith('C02-') || name === 'C04') {
      output.result = failUnlink(() => name === 'C04' ? history().remove('history-old-root') : owner.releaseSession('history-old-child'));
      output.afterFailure = capture();
      if (assertInvariant) {
        assert.equal(output.afterFailure.messages['old-child'].content.attachment?.contentState, 'available', 'failed unlink must retain durable ownership and content');
        assert.equal(output.result, name === 'C04' ? true : 0, 'only completed releases count');
        if (name.startsWith('C02-')) assert.deepEqual(files(root, true), before, 'a failed unlink cannot alter owned bytes');
        else assert.deepEqual(output.afterFailure.items.map(item => item.id), ['history-new-root'], 'history index commit is not rolled back by cleanup failure');
      }
      if (name === 'C02-reopen' || name === 'C04') {
        owner = open(); output.reopenedFailure = capture();
        if (assertInvariant) assert.deepEqual(output.reopenedFailure, output.afterFailure, 'reopen cannot resurrect or lose ownership');
      }
      output.retry = owner.releaseSession('history-old-child');
      if (assertInvariant) assert.equal(output.retry, 1, 'the retained owner must be retryable');
    } else if (name === 'C01' || name === 'C03') {
      if (name === 'C03') unlink(target);
      output.result = owner.releaseSession('history-old-child');
    } else throw new Error(`unknown case ${name}`);
    output.after = capture();
    output.repeated = owner.releaseSession('history-old-child');
    owner = open(); output.reopened = capture();
    if (assertInvariant) assert.deepEqual(output.reopened, output.after);
    if (assertInvariant) assert.equal(output.repeated, 0);
    output.warnings = warnings;
    if (assertInvariant) {
      assert.deepEqual(warnings, name.startsWith('C02-') || name === 'C04' ? [`attachment manifest cleanup failed for ${targetId}`] : []);
      assert.deepEqual(output.after.messages['old-child'].attachments, []);
      assert.equal(output.after.messages['old-child'].content.code, 'AI_SESSION_ATTACHMENT_NOT_FOUND');
      assert.equal(output.after.messages['new-root'].content.bytes, Buffer.from('shared bytes').toString('hex'), 'shared survivor content is immutable');
      assert.equal(fs.existsSync(target), false);
    }
    return output;
  } finally { fs.unlinkSync = unlink; fs.rmSync(root, { recursive: true, force: true }); }
}

module.exports = { observeAttachmentCleanup };
