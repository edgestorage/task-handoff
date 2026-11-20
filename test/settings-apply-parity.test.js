const assert = require('node:assert/strict');
const test = require('node:test');
const { observeSettingsApply } = require('./fixtures/settings-apply-parity.js');
for (const name of ['C01', 'C02', 'C03', 'C04']) {
  test(`U03.5 ${name}: desired settings application, partial failure, retry and reopen`, async (context) => {
    context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T00:00:00Z') });
    const actual = await observeSettingsApply(name);
    const fixture = require('../controlled-instance-rs/crates/instance/tests/fixtures/settings-apply-parity.json');
    assert.deepEqual(actual, fixture.expected[name]);
  });
}
