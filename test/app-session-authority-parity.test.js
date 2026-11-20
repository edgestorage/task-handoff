const assert = require('node:assert/strict');
const test = require('node:test');
const { observeNodeAppAuthority } = require('./fixtures/app-session-authority-parity.js');
const fixture = require('../controlled-instance-rs/crates/instance/tests/fixtures/app-session-authority-parity.json');

test('U02.2 C01-C05: AppSession HTTP delta retention and snapshot recovery match fixed Node output', async () => {
  assert.deepEqual(await observeNodeAppAuthority(), fixture.expected);
});
