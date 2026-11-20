const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
require('./attachment-route-parity.js'); // Existing TS loader only.
const atomic = require('write-file-atomic');
const { AiSessionHistoryStore } = require('../../packages/ai-session-runtime/src/ai-session-history-store.ts');

function observeHistoryPersistence(name, input) {
  if (name === 'C06') return Object.fromEntries(['after-commit', 'detail-after-commit', 'rollback-failure', 'unverifiable'].map(variant => [variant, observeHistoryPersistence(`C06-${variant}`, input)]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-persistence-parity-'));
  const directory = path.join(root, 'ai-session-history');
  const index = path.join(directory, 'index.json');
  const detailPath = id => path.join(directory, 'details', `${crypto.createHash('sha256').update(id).digest('hex')}.json`);
  const oldDetailPath = detailPath(input.old.id);
  const newDetailPath = detailPath(input.new.id);
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const exists = file => fs.existsSync(file);
  const removed = [];
  const warnings = [];
  const store = () => new AiSessionHistoryStore({ dataDir: root }, { onRemove: id => removed.push(id), onWarning: warning => warnings.push(warning) });
  const capture = () => {
    const reopened = store();
    const items = reopened.list();
    return { items, oldDetail: reopened.detail(input.old.id) ?? null,
      newDetail: reopened.detail(input.new.id) ?? null, index: read(index),
      oldBody: exists(oldDetailPath) ? read(oldDetailPath) : null,
      newBody: exists(newDetailPath) ? read(newDetailPath) : null,
      detailFiles: fs.readdirSync(path.join(directory, 'details')).sort(), removed: [...removed] };
  };
  const obstruct = (file, run) => {
    const before = fs.readFileSync(file);
    const backup = `${file}.before`;
    fs.renameSync(file, backup); fs.mkdirSync(file);
    try { return run(); }
    finally { fs.rmdirSync(file); fs.renameSync(backup, file); assert.deepEqual(fs.readFileSync(file), before); }
  };
  const original = atomic.sync;
  try {
    fs.mkdirSync(path.dirname(oldDetailPath), { recursive: true });
    fs.writeFileSync(index, JSON.stringify(input.n1Index));
    fs.writeFileSync(oldDetailPath, JSON.stringify(input.n1Detail));
    if (name === 'C01') {
      let owner = store();
      owner.upsert(input.updated, input.updatedTurns);
      owner.upsert(input.new, input.newTurns);
      owner = undefined;
      return capture();
    }
    if (name === 'C02') {
      const extendedIndex = structuredClone(input.n1Index);
      extendedIndex.futureIndex = true;
      extendedIndex.items[0].futureItem = true;
      const extendedBody = structuredClone(input.n1Detail);
      extendedBody.futureBody = true;
      extendedBody.turns[0].futureTurn = true;
      extendedBody.turns.push({ broken: true });
      fs.writeFileSync(index, JSON.stringify(extendedIndex));
      fs.writeFileSync(oldDetailPath, JSON.stringify(extendedBody));
      const observed = capture();
      assert.deepEqual(observed.index, input.n1Index);
      assert.deepEqual(observed.oldBody, input.n1Detail);
      return { observed, reopened: capture() };
    }
    let owner = store();
    const indexBefore = fs.readFileSync(index);
    const detailBefore = fs.readFileSync(oldDetailPath);
    if (name === 'C03') {
      let attempted = false;
      atomic.sync = (file, ...args) => {
        if (file === oldDetailPath && !attempted) {
          attempted = true;
          return obstruct(file, () => original(file, ...args));
        }
        return original(file, ...args);
      };
      assert.throws(() => owner.upsert(input.updated, input.updatedTurns), error => ['EISDIR', 'EPERM'].includes(error.code));
      assert.equal(attempted, true, 'C03 must reach the actual detail writer');
      atomic.sync = original;
    } else if (name === 'C04' || name === 'C05' || name.startsWith('C06-')) {
      // Keep the old index readable during list(). Only the actual commit is
      // obstructed, after the real detail write; no mocked I/O success/failure.
      let attempted = false;
      let detailFaulted = false;
      atomic.sync = (file, ...args) => {
        if (name === 'C06-detail-after-commit' && file === oldDetailPath && !detailFaulted) {
          detailFaulted = true;
          original(file, ...args);
          throw Object.assign(new Error('post-detail-commit failure signal'), { code: 'EIO' });
        }
        if (file === index) {
          attempted = true;
          if (name === 'C06-after-commit') {
            original(file, ...args);
            // Report a failure after the real index replacement (Rust's
            // directory-fsync outcome). This is a test signal, not an OS fault.
            throw Object.assign(new Error('post-commit failure signal'), { code: 'EIO' });
          }
          try { return obstruct(index, () => original(file, ...args)); }
          catch (error) {
            if (name === 'C06-rollback-failure') {
              fs.renameSync(oldDetailPath, `${oldDetailPath}.pending`);
              fs.mkdirSync(oldDetailPath);
            } else if (name === 'C06-unverifiable') {
              fs.renameSync(index, `${index}.unverified`);
              fs.mkdirSync(index);
            }
            throw error;
          }
        }
        return original(file, ...args);
      };
      assert.throws(() => owner.upsert(name === 'C05' ? input.new : input.updated,
        name === 'C05' ? input.newTurns : input.updatedTurns), error => {
        if (name === 'C06-rollback-failure') return error instanceof AggregateError && error.errors.length === 2
          && error.errors.every(cause => ['EISDIR', 'EPERM'].includes(cause.code));
        return (['C06-after-commit', 'C06-detail-after-commit'].includes(name) ? error.code === 'EIO' : ['EISDIR', 'EPERM'].includes(error.code));
      });
      assert.equal(attempted, name !== 'C06-detail-after-commit');
      assert.equal(detailFaulted, name === 'C06-detail-after-commit');
      atomic.sync = original;
    } else throw new Error(`Unknown case ${name}`);
    if (name.startsWith('C06-')) {
      if (name === 'C06-rollback-failure') {
        fs.rmdirSync(oldDetailPath); fs.renameSync(`${oldDetailPath}.pending`, oldDetailPath);
      } else if (name === 'C06-unverifiable') {
        fs.rmdirSync(index); fs.renameSync(`${index}.unverified`, index);
        assert.ok(warnings.some(warning => warning.reason.includes('could not be verified')));
      }
      owner = undefined;
      // A second I/O failure can prevent compensation. The errors are exposed;
      // no old-state guarantee is claimed for this branch. A retry must work.
      const afterFailure = capture();
      assert.deepEqual(afterFailure.oldBody.turns, name === 'C06-detail-after-commit' ? input.oldTurns : input.updatedTurns);
      assert.deepEqual(removed, []);
      store().upsert(input.updated, input.updatedTurns);
      return { failed: true, indexCommitted: name === 'C06-after-commit',
        rollbackFailed: name === 'C06-rollback-failure', unverified: name === 'C06-unverifiable',
        afterFailure, afterRetry: capture() };
    }
    assert.deepEqual(fs.readFileSync(index), indexBefore);
    owner = undefined;
    const afterFailure = capture();
    assert.deepEqual(fs.readFileSync(oldDetailPath), detailBefore, 'failed upsert must preserve the previous body bytes');
    assert.equal(exists(newDetailPath), false, 'failed first insert must not leave an orphan body');
    assert.deepEqual(removed, [], 'failed commit cannot release history resources');
    const retry = store();
    retry.upsert(name === 'C05' ? input.new : input.updated,
      name === 'C05' ? input.newTurns : input.updatedTurns);
    return { failed: true, afterFailure, afterRetry: capture() };
  } finally { atomic.sync = original; fs.rmSync(root, { recursive: true, force: true }); }
}
module.exports = { observeHistoryPersistence };
