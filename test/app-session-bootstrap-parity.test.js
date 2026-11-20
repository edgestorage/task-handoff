const assert = require('node:assert/strict');
const test = require('node:test');
const { observeNodeAppBootstrap } = require('./fixtures/app-session-bootstrap-parity.js');
const fixture = require('../controlled-instance-rs/crates/instance/tests/fixtures/app-session-bootstrap-parity.json');

for (const [name, renameBeforeConnect] of [['normal', false], ['changedBeforeConnect', true]]) {
  test(`U02.3 ${name}: HTTP snapshot, hello and next AppSession patch match Node wire output`, async () => {
    assert.deepEqual(await observeNodeAppBootstrap(renameBeforeConnect), fixture.expected[name]);
  });
}
