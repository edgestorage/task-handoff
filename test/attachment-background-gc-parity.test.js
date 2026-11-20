const assert = require('node:assert/strict');
const test = require('node:test');
const { observeBackgroundGc, assertBackground, runCrashProbe } = require('./fixtures/attachment-background-gc-parity.js');
const fixture = require('../controlled-instance-rs/crates/instance/tests/fixtures/attachment-background-gc-parity.json');

for (const name of ['C01', 'C02', 'C03']) {
  test(`U03.12 ${name}: scheduled GC, failure retry and shutdown`, async () => {
    const actual = await observeBackgroundGc(name);
    assertBackground(name, actual);
    assert.deepEqual(actual, fixture.expected[name]);
  });
}
test('U03.12 C04: real timer I/O failure leaves the process alive', () => {
  const result = runCrashProbe();
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.survived, true);
});
