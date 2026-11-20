const assert = require('node:assert/strict');
const test = require('node:test');
const { observeSessionPersistence } = require('./fixtures/session-persistence-parity.js');
const fixture = require('../controlled-instance-rs/crates/ai-session/tests/fixtures/session-persistence-parity.json');
for (const name of ['C01', 'C02', 'C03', 'C04', 'C05']) {
  test(`U03.1 ${name}: session/settings persistence, reopen and atomic failure match fixed Node output`, () => {
    const actual = observeSessionPersistence(name, fixture.input);
    assert.deepEqual(actual, fixture.expected[name]);
  });
}
