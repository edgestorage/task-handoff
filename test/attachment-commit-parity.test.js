const assert = require('node:assert/strict');
const test = require('node:test');
const { observeAttachmentCommit } = require('./fixtures/attachment-commit-parity.js');
for (const name of ['C01','C02','C03','C04','C05']) {
  test(`U03.7 ${name}: durable attachment commit and accepted provider action`, async () => {
    const actual = await observeAttachmentCommit(name);
    const fixture = require('../controlled-instance-rs/crates/ai-session/tests/fixtures/attachment-commit-parity.json');
    assert.deepEqual(actual,fixture.expected[name]);
  });
}
