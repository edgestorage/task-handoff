const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { observeTerminalLifecycle } = require('./fixtures/app-management-terminal-parity.js');

const fixture = JSON.parse(fs.readFileSync(path.join(
  __dirname,
  '../controlled-instance-rs/crates/instance/tests/fixtures/app-management-terminal-parity.json',
), 'utf8'));

for (const scenario of fixture.scenarios) {
  test(`U07.4 ${scenario.name}: terminal lifecycle and notification`, async () => {
    assert.deepEqual(await observeTerminalLifecycle(scenario.name), scenario.expected);
  });
}
