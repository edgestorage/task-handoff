const assert = require('node:assert/strict');
const test = require('node:test');
const { observeNodeAppClock, observeClockConsumer } = require('./fixtures/app-session-clock-parity.js');
const fixture = require('../controlled-instance-rs/crates/instance/tests/fixtures/app-session-clock-parity.json');

test('U02.5 C01-C04: exact AppSession timestamps across history expiry, consumer bootstrap and next patch match Node source', async context => {
  const samples = await observeNodeAppClock(context.mock.timers);
  assert.deepEqual(samples, fixture.expected);
  assert.deepEqual(await observeClockConsumer(samples), fixture.consumer);
});
