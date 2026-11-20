const assert = require('node:assert/strict');
const test = require('node:test');
const { observeNodeRemoval } = require('./fixtures/session-removal-source.js');
const { runRemovalScenario } = require('./fixtures/session-removal-consumers.js');
const { expected } = require('../controlled-instance-rs/crates/instance/tests/fixtures/session-removal-parity.json');

test('U02.8 source: Node close/removal, full tombstone and exact retention match fixed output', async context => {
  assert.deepEqual(await observeNodeRemoval(context.mock.timers), expected);
});

for (const topic of ['ai', 'app']) {
  for (const name of topic === 'ai' ? ['C01', 'C02', 'C03', 'C04', 'C05'] : ['C01', 'C02', 'C03', 'C04']) {
    for (const kind of ['cp', 'ui']) {
      test(`U02.8 ${topic} ${name} ${kind}: removal, stale replay and authoritative recovery`, async () => {
        await runRemovalScenario(topic, kind, name, expected.samples[topic]);
      });
    }
  }
}
