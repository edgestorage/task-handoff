const assert = require('node:assert/strict');
const test = require('node:test');
const { observeSharedOwner, assertSharedOwner } = require('./fixtures/codex-shared-owner-parity.js');
const fixture = require('../controlled-instance-rs/crates/app-runtime/tests/fixtures/codex-shared-owner-parity.json');
for (const name of ['C01', 'C02', 'C03']) {
  test(`U05.1 ${name}: shared owner, process groups, failure and replacement`, { timeout: 30000 }, async () => {
    const actual = await observeSharedOwner(name);
    assertSharedOwner(name, actual);
    assert.deepEqual(actual, fixture.expected[name]);
  });
}
