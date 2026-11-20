const assert = require('node:assert/strict');
const test = require('node:test');
const { observeAttachmentReadGc, assertObservation } = require('./fixtures/attachment-read-gc-parity.js');
const fixture = require('../controlled-instance-rs/crates/instance/tests/fixtures/attachment-read-gc-parity.json');

for (const name of ['C01', 'C02', 'C03']) {
  test(`U03.10 ${name}: HTTP read GC failure, body revision, retry and owner reopen`, async () => {
    const actual = await observeAttachmentReadGc(name);
    assertObservation(name, actual);
    assert.deepEqual(actual, fixture.expected[name]);
  });
}
