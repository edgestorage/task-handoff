const assert = require('node:assert/strict');
const test = require('node:test');
const { observeNodeEpochs } = require('./fixtures/session-epoch-source.js');
const { runScenario } = require('./fixtures/session-epoch-consumers.js');
const { expected } = require('../controlled-instance-rs/crates/instance/tests/fixtures/session-epoch-parity.json');

test('U02.7 source: two Node HTTP/event owners match fixed epoch samples exactly', async context => {
  assert.deepEqual(await observeNodeEpochs(context.mock.timers), expected);
});

for (const topic of ['ai', 'app']) {
  for (const name of ['C01', 'C02', 'C03', 'C04']) {
    for (const kind of name === 'C01' ? ['cp'] : ['cp', 'ui']) {
      test(`U02.7 ${topic} ${name} ${kind}: obsolete epoch and recovery ordering`, async () => {
        await runScenario(topic, kind, name, expected[topic]);
      });
    }
  }
}
