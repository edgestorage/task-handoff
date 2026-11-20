const assert = require('node:assert/strict');
const test = require('node:test');
const { observeHistoryPersistence } = require('./fixtures/history-persistence-parity.js');
const fixture = require('../controlled-instance-rs/crates/ai-session/tests/fixtures/history-persistence-parity.json');
for (const name of ['C01','C02','C03','C04','C05','C06']) {
  test(`U03.2 ${name}: history index/body consistency and reopen`, () => {
    const result = observeHistoryPersistence(name, fixture.input);
    assert.deepEqual(result, fixture.expected[name]);
  });
}
