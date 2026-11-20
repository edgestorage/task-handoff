const assert = require('node:assert/strict');
const test = require('node:test');
const { observeAttachmentCleanup } = require('./fixtures/attachment-cleanup-parity.js');
for (const name of ['C01', 'C02', 'C03', 'C04']) {
  test(`U03.4 ${name}: attachment cleanup preserves durable ownership across unlink failure`, () => {
    const actual = observeAttachmentCleanup(name);
    const fixture = require('../controlled-instance-rs/crates/ai-session/tests/fixtures/attachment-cleanup-parity.json');
    assert.deepEqual(actual, fixture.expected[name]);
  });
}
