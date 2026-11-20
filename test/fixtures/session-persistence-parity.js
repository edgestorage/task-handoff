const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('./attachment-route-parity.js'); // Existing workspace TS loader only.
const { createAiSessionRegistry } = require('../../packages/ai-session-runtime/src/ai-session-registry.ts');
const { AiSessionPersistenceSettingsStore } = require('../../packages/ai-session-runtime/src/ai-session-persistence-settings.ts');

const INPUT_TIME = '2026-11-02T00:00:00.000Z';
function isSessionPersistenceFailure(error) {
  return error?.name === 'AiSessionPersistenceError'
    && error.code === 'AI_SESSION_PERSISTENCE_FAILED'
    && error.statusCode === 500
    && error.storageFailure === false
    && (error.storageCode === 'EISDIR' || error.storageCode === 'EPERM');
}
function normalize(value, queueId, key = '') {
  if (key === 'id' && value === queueId) return '<new-queue>';
  if (['createdAt', 'updatedAt'].includes(key) && value !== INPUT_TIME) {
    assert.ok(Number.isFinite(Date.parse(value)));
    return '<operation-time>';
  }
  if (Array.isArray(value)) return value.map(item => normalize(item, queueId));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalize(item, queueId, name)]));
  return value;
}

function observeSessionPersistence(name, input) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-persistence-parity-'));
  const dir = path.join(root, 'ai-sessions');
  fs.mkdirSync(dir);
  const sessionPath = path.join(dir, `${input.session.id}.json`);
  const settingsPath = path.join(root, 'ai-session-persistence/settings.json');
  const newSettings = () => new AiSessionPersistenceSettingsStore({ dataDir: root });
  const newRegistry = () => createAiSessionRegistry({ dir });
  const disk = () => JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const writeSettings = value => { fs.mkdirSync(path.dirname(settingsPath), { recursive: true }); fs.writeFileSync(settingsPath, JSON.stringify(value)); };
  const obstruct = (file, run) => {
    const before = fs.readFileSync(file);
    const backup = `${file}.before`;
    fs.renameSync(file, backup);
    fs.mkdirSync(file);
    try { run(); assert.deepEqual(fs.readFileSync(backup), before); }
    finally { fs.rmdirSync(file); fs.renameSync(backup, file); }
    assert.deepEqual(fs.readFileSync(file), before);
  };
  fs.writeFileSync(sessionPath, JSON.stringify(input.session));
  try {
    if (name === 'C01') {
      let registry = newRegistry();
      const queued = registry.enqueueMessage(input.session.id, 'queued after restart', [], input.references, 'auto-review', 'message-new');
      assert.match(queued.item.id, /^aiq_[a-f0-9]{20}$/);
      const queueId = queued.item.id;
      registry.setQueuePaused(input.session.id, true);
      const live = registry.get(input.session.id);
      const persisted = disk();
      assert.deepEqual(live, persisted);
      registry = undefined; // No old owner is consulted after reopening.
      const reopened = newRegistry().get(input.session.id);
      assert.deepEqual(reopened, live);
      let settings = newSettings();
      const writtenSettings = settings.put(input.settings);
      settings = undefined;
      assert.deepEqual(newSettings().get(), writtenSettings);
      return normalize({ live, persisted, reopened, settings: writtenSettings }, queueId);
    }
    if (name === 'C02') {
      const extended = structuredClone(input.session);
      extended.futureSession = { opaque: true };
      extended.queue.futureQueue = true;
      extended.queue.items[0].futureItem = true;
      fs.writeFileSync(sessionPath, JSON.stringify(extended));
      let registry = newRegistry();
      const loaded = registry.get(input.session.id);
      assert.equal(loaded.futureSession, undefined);
      assert.equal(loaded.queue.futureQueue, undefined);
      assert.equal(loaded.queue.items[0].futureItem, undefined);
      registry.setQueuePaused(input.session.id, true);
      const persisted = disk();
      registry = undefined;
      const reopened = newRegistry().get(input.session.id);
      assert.deepEqual(reopened, persisted);
      return normalize({ loaded, persisted, reopened });
    }
    if (name === 'C03') {
      const results = input.settingsVersions.map(raw => {
        writeSettings({ ...raw, futureSetting: { opaque: true } });
        let store = newSettings();
        const loaded = store.get();
        assert.equal(loaded.historyLimit, raw.historyLimit, 'unknown fields cannot reset valid stored settings');
        assert.equal(loaded.attachmentRetentionDays, raw.attachmentRetentionDays ?? 30);
        assert.equal(loaded.maxFileAttachmentBytes, raw.maxFileAttachmentBytes ?? 512000);
        const updated = store.put({ historyLimit: raw.historyLimit + 1 });
        assert.equal(updated.attachmentRetentionDays, loaded.attachmentRetentionDays);
        assert.equal(updated.maxFileAttachmentBytes, loaded.maxFileAttachmentBytes);
        store = undefined;
        const reopened = newSettings().get();
        const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        assert.deepEqual(reopened, updated);
        assert.deepEqual(persisted, updated);
        return { loaded, updated, reopened, persisted };
      });
      assert.throws(() => newSettings().put({ historyLimit: 12, futureRequest: true }));
      const defaults = { schemaVersion: 3, historyLimit: 50, attachmentRetentionDays: 30, maxFileAttachmentBytes: 512000 };
      for (const raw of [
        { ...input.settings, schemaVersion: 3, historyLimit: 0, futureSetting: true },
        { ...input.settings, schemaVersion: 3, attachmentRetentionDays: 'nine' },
        { schemaVersion: 3, historyLimit: 17, attachmentRetentionDays: 9 },
      ]) {
        writeSettings(raw);
        assert.deepEqual(newSettings().get(), defaults, 'unknown-field tolerance still validates known required fields');
      }
      return results;
    }
    if (name === 'C04') {
      let registry = newRegistry();
      const before = registry.get(input.session.id);
      const changes = [];
      const unsubscribe = registry.onChange(reason => changes.push(reason));
      obstruct(sessionPath, () => {
        assert.throws(() => registry.setQueuePaused(input.session.id, true), isSessionPersistenceFailure);
        assert.deepEqual(registry.get(input.session.id), before);
        assert.deepEqual(changes, []);
      });
      unsubscribe();
      registry = undefined;
      const reopenedRegistry = newRegistry();
      const reopenedBeforeRetry = reopenedRegistry.get(input.session.id);
      assert.deepEqual(reopenedBeforeRetry, before);
      const retried = reopenedRegistry.setQueuePaused(input.session.id, true);
      assert.deepEqual(newRegistry().get(input.session.id), retried);
      assert.deepEqual(fs.readdirSync(dir).sort(), [path.basename(sessionPath)]);
      return normalize({ failed: true, changes, before, reopenedBeforeRetry, retried, persisted: disk() });
    }
    if (name === 'C05') {
      let store = newSettings();
      const before = store.put(input.settings);
      obstruct(settingsPath, () => {
        assert.throws(() => store.put({ historyLimit: 23 }), error => error.code === 'EISDIR' || error.code === 'EPERM');
      });
      store = undefined;
      const reopened = newSettings().get();
      assert.deepEqual(reopened, before);
      const retried = newSettings().put({ historyLimit: 23 });
      const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.deepEqual(newSettings().get(), retried);
      assert.deepEqual(persisted, retried);
      assert.deepEqual(fs.readdirSync(path.dirname(settingsPath)), ['settings.json']);
      return { failed: true, before, reopened, retried, persisted };
    }
    throw new Error(`Unknown case ${name}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
module.exports = { observeSessionPersistence };
