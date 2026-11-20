const assert = require('node:assert/strict');
const test = require('node:test');
const { observeAttachmentControlHttp } = require('./fixtures/attachment-control-http-parity.js');
const fixture = require('../controlled-instance-rs/crates/instance/tests/fixtures/attachment-control-http-parity.json');

for (const name of ['C01', 'C02', 'C03', 'C04']) {
  test(`U03.9 ${name}: public HTTP failure and attachment authority`, async () => {
    const actual = await observeAttachmentControlHttp(name);
    for (const [action, observation] of Object.entries(actual)) {
      const ioFailure = name === 'C02' || name === 'C03' || (name === 'C04' && action === 'accept');
      assert.equal(observation.response.status, ioFailure ? 500 : 503);
      assert.deepEqual(observation.response.body, { error: ioFailure
        ? { code: 'AI_SESSION_ATTACHMENT_IO_FAILED', message: 'AI session attachment manifest could not be persisted.' }
        : { code: 'PROVIDER_REJECTED', message: 'provider rejected' } });
    }
    assert.deepEqual(actual, fixture.expected[name]);
  });
}
