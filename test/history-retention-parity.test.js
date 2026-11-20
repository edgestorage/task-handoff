const assert = require('node:assert/strict');
const test = require('node:test');
const { observeHistoryRetention } = require('./fixtures/history-retention-parity.js');
const fixture = require('../controlled-instance-rs/crates/ai-session/tests/fixtures/history-retention-parity.json');
for (const name of ['C01', 'C02', 'C03', 'C04', 'C05']) {
  test(`U03.3 ${name}: history retention, removal and resource ownership`, () => {
    assert.deepEqual(observeHistoryRetention(name, fixture.input), fixture.expected[name]);
  });
}
