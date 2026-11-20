const assert = require('node:assert/strict');
const test = require('node:test');
const { observeNodeAiClock, observeAiClockConsumer } = require('./fixtures/ai-session-clock-parity.js');
const fixture = require('../controlled-instance-rs/crates/instance/tests/fixtures/ai-session-clock-parity.json');

test('U02.6 C01-C04: AI Session history expiry, exact timestamps and CP bootstrap match Node source', async context => {
  const samples = await observeNodeAiClock(context.mock.timers);
  assert.deepEqual(samples, fixture.expected);
  assert.deepEqual(await observeAiClockConsumer(samples), fixture.consumer);
});
