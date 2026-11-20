const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withAttachmentApp } = require('./attachment-route-parity.js');
const { files } = require('./history-retention-parity.js');
const { AiSessionHistoryStore } = require('../../packages/ai-session-runtime/src/ai-session-history-store.ts');
const { AiSessionConversationAttachmentStore } = require('../../packages/ai-session-runtime/src/ai-session-conversation-attachment-store.ts');
const { AiSessionPersistenceSettingsStore } = require('../../packages/ai-session-runtime/src/ai-session-persistence-settings.ts');
const input = require('../../controlled-instance-rs/crates/ai-session/tests/fixtures/history-retention-parity.json').input;
const initial = { historyLimit: 10, attachmentRetentionDays: 30, maxFileAttachmentBytes: 512000 };
const baseDesired = { historyLimit: 1, attachmentRetentionDays: 14, maxFileAttachmentBytes: 2048 };
const applyError = { error: { code: 'AI_SESSION_PERSISTENCE_SETTINGS_APPLY_FAILED', message: 'AI session persistence settings could not be applied.' } };

async function observeSettingsApply(name, assertContract = true) {
  const desired = name === 'C05' ? { ...baseDesired, attachmentRetentionDays: 0 } : baseDesired;
  const clockStart = Date.now();
  assert.notEqual(process.getuid?.(), 0, 'permission fault fixture requires a non-root Unix user');
  assert.equal(typeof process.getuid, 'function', 'Unix permissions are an explicit fixture prerequisite');
  const originalList = AiSessionHistoryStore.prototype.list;
  const originalGc = AiSessionConversationAttachmentStore.prototype.gc;
  let dataRoot, history, attachments, reopenedApp;
  // These observers call the original methods unchanged. They expose the
  // actual route-owned policy, without adding production getters or owners.
  AiSessionHistoryStore.prototype.list = function(...args) {
    if (dataRoot && this.path() === path.join(dataRoot, 'ai-session-history/index.json')) history = this;
    return originalList.apply(this, args);
  };
  AiSessionConversationAttachmentStore.prototype.gc = function(...args) {
    if (dataRoot && this.root === path.join(dataRoot, 'ai-session-attachments')) attachments = this;
    return originalGc.apply(this, args);
  };
  try {
    return await withAttachmentApp(async (app, root) => {
      try {
        let activeApp = app;
        await app.ready();
        assert.ok(history && attachments, 'real createWebApp owners observed at startup');
        const capture = () => ({
          settings: new AiSessionPersistenceSettingsStore({ dataDir: root }).get(),
          live: { historyLimit: history.retentionLimit(), attachmentRetentionDays: attachments.retentionDays,
            maxFileAttachmentBytes: attachments.maxFileAttachmentBytes },
          items: history.list(), files: files(root),
        });
        const put = async (target, payload = desired) => {
          const response = await target.inject({ method: 'PUT', url: '/api/internal/ai-session-persistence-settings',
            headers: { authorization: 'Bearer source-test-token' }, payload });
          // JSON is UTF-8 on both transports; Fastify spells the optional
          // charset parameter while Axum omits it. Compare the media type.
          assert.match(response.headers['content-type'], /^application\/json(?:; charset=utf-8)?$/);
          return { status: response.statusCode, contentType: 'application/json', body: response.json() };
        };
        const reopen = async () => {
          await activeApp.close();
          const { createWebApp } = require('../../packages/controlled-instance/src/web/server.ts');
          reopenedApp = await createWebApp({ staticDir: path.join(root, 'missing-ui'), logger: false });
          await reopenedApp.ready();
          activeApp = reopenedApp;
          return reopenedApp;
        };
        const output = { before: capture() };
        let current = app;
        if (name === 'C01') {
          output.response = await put(app); output.after = capture();
          output.repeated = await put(app); output.afterRepeated = capture();
          output.legacy = await put(app, { historyLimit: 2 }); output.afterLegacy = capture();
        } else {
          if (name === 'C02') {
            // Rust deliberately hardens its settings directory to 0700. A
            // readonly-directory fixture would not keep that writer blocked.
            const file = path.join(root, 'ai-session-persistence/settings.json');
            const bytes = fs.readFileSync(file);
            fs.renameSync(file, `${file}.before`); fs.mkdirSync(file);
            try { output.response = await put(app); }
            finally { fs.rmdirSync(file); fs.renameSync(`${file}.before`, file); }
            assert.deepEqual(fs.readFileSync(file), bytes);
          } else {
            const directory = path.join(root, name === 'C05' ? 'ai-session-attachments/manifests' : 'ai-session-history');
            const permissions = fs.statSync(directory).mode;
            fs.chmodSync(directory, 0o500);
            try {
              assert.throws(() => fs.writeFileSync(path.join(directory, 'fault-probe'), ''), { code: 'EACCES' }, 'real temporary-file write must be denied');
              output.response = await put(app);
            } finally { fs.chmodSync(directory, permissions); }
          }
          output.afterFailure = capture();
          if (assertContract) {
            assert.equal(output.response.status, 500, 'valid desired policy failing at disk apply is not invalid input');
            assert.deepEqual(output.response.body, applyError);
            if (name === 'C02') assert.deepEqual(output.afterFailure, output.before, 'failed desired write cannot mutate owners');
            else {
              assert.deepEqual(output.afterFailure.settings, { schemaVersion: 3, ...desired });
              assert.deepEqual(output.afterFailure.live, { ...desired, historyLimit: 10, ...(name === 'C05' ? { maxFileAttachmentBytes: initial.maxFileAttachmentBytes } : {}) });
              assert.deepEqual(output.afterFailure.items, output.before.items);
              assert.deepEqual(output.afterFailure.files, output.before.files, 'failed history commit cannot delete owned bytes');
            }
          }
          if (name === 'C04') { current = await reopen(); output.reopenedFailure = capture(); }
          output.retry = await put(current); output.after = capture();
        }
        await reopen();
        output.reopened = capture();
        if (assertContract) {
          assert.equal((output.retry ?? output.response).status, 200);
          assert.deepEqual(output.reopened, name === 'C01' ? output.afterLegacy : output.after);
          assert.deepEqual(output.reopened.items.map(item => item.id), ['history-new-root']);
          assert.equal((output.retry ?? output.response).body.data.removedHistoryCount, name === 'C04' ? 0 : 2);
        }
        if (name === 'C05') {
          // Only GC-generated timestamps vary. Verify their clock bounds and
          // same-batch identity before replacing that one field; preserve all
          // other timestamps, IDs, arrays, bytes and policy values.
          const clockEnd = Date.now(); let deletionTime;
          const normalize = value => {
            if (!value || typeof value !== 'object') return;
            for (const [key, child] of Object.entries(value)) {
              if (key === 'contentDeletedAt') {
                assert.ok(Date.parse(child) >= clockStart && Date.parse(child) <= clockEnd);
                deletionTime ??= child; assert.equal(child, deletionTime);
                value[key] = '<gc-time>';
              } else normalize(child);
            }
          };
          normalize(output); assert.ok(deletionTime, 'retry must commit expiration');
        }
        return output;
      } finally { await reopenedApp?.close(); reopenedApp = undefined; }
    }, root => {
      dataRoot = root;
      process.env.TASK_HANDOFF_REGISTRATION_TOKEN = 'source-test-token';
      for (const [relative, hex] of Object.entries(input.files)) {
        const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(hex, 'hex'));
      }
      new AiSessionPersistenceSettingsStore({ dataDir: root }).put(initial);
      return {};
    });
  } finally {
    await reopenedApp?.close();
    AiSessionHistoryStore.prototype.list = originalList;
    AiSessionConversationAttachmentStore.prototype.gc = originalGc;
  }
}
module.exports = { observeSettingsApply, initial, desired: baseDesired, applyError };
