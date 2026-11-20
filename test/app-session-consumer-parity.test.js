const test = require('node:test');
const { compareConsumers } = require('./fixtures/app-session-consumer-parity.js');

test('U02.4 C01-C04: Node authority output survives duplicate, stale, gap and HTTP snapshot recovery in existing consumers', async () => {
  await compareConsumers();
});
