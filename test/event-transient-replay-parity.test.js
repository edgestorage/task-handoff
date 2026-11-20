const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { observeNodeTransientReplay } = require('./fixtures/event-transient-replay-parity.js');

const fixture = JSON.parse(fs.readFileSync(path.join(
  __dirname,
  '../controlled-instance-rs/crates/instance/tests/fixtures/event-transient-replay-parity.json',
), 'utf8'));

test('U02.2 transient delta replay matches the shared Node golden', async () => {
  for (const scenario of fixture.scenarios) {
    assert.deepEqual(
      await observeNodeTransientReplay(scenario),
      scenario.expected,
      scenario.name,
    );
  }
});
