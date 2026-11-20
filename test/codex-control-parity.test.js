const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { observe } = require('./fixtures/codex-interaction-parity.js');
const fixturePath = path.resolve(__dirname, '../controlled-instance-rs/crates/ai-session/tests/fixtures/codex-control-parity.json');
for(const scenario of JSON.parse(fs.readFileSync(fixturePath,'utf8')).scenarios) {
  test(`Codex real WS control ${scenario.id}`, {timeout:15000}, async()=> {
    assert.deepEqual(await observe(scenario),scenario.expected);
  });
}
