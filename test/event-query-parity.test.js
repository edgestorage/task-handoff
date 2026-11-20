const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { observeNodeEventQuery } = require('./fixtures/event-query-parity.js');

const fixture = JSON.parse(fs.readFileSync(path.join(
  __dirname,
  '../controlled-instance-rs/crates/instance/tests/fixtures/event-query-parity.json',
), 'utf8'));

test('U02.2 event connection query flags match Node Fastify semantics', async () => {
  for (const scenario of fixture.scenarios) {
    assert.deepEqual(await observeNodeEventQuery(scenario), scenario.expected, scenario.name);
  }
});
