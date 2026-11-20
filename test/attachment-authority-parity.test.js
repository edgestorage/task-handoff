const assert = require('node:assert/strict');
const test = require('node:test');
const { observeAttachmentAuthority, assertAuthority } = require('./fixtures/attachment-authority-parity.js');
const fixture = require('../controlled-instance-rs/crates/instance/tests/fixtures/attachment-authority-parity.json');

for (const name of ['C01', 'C02', 'C03']) {
  test(`U03.11 ${name}: GC authority HTTP/WS revisions, recovery and existing cache`, async () => {
    const actual = await observeAttachmentAuthority(name);
    assertAuthority(name, actual);
    assert.deepEqual(actual, fixture.expected[name]);
  });
}
