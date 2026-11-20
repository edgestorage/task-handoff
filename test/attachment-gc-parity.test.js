const assert = require('node:assert/strict');
const test = require('node:test');
const { observeAttachmentGc } = require('./fixtures/attachment-gc-parity.js');
const { observeSettingsApply } = require('./fixtures/settings-apply-parity.js');
for (const name of ['C01', 'C02', 'C03', 'C04']) {
  test(`U03.6 ${name}: attachment GC durable failure, retry and reopen`, async () => {
    const actual = name === 'C04' ? await observeSettingsApply('C05') : observeAttachmentGc(name);
    const fixture = require('../controlled-instance-rs/crates/ai-session/tests/fixtures/attachment-gc-parity.json');
    assert.deepEqual(actual, fixture.expected[name]);
  });
}
