const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {observe,fixturePath} = require('./fixtures/codex-reconnect-parity.js');
for(const scenario of JSON.parse(fs.readFileSync(fixturePath,'utf8')).scenarios) {
  test(`Codex real WS reconnect ${scenario.id}`,{timeout:15000},async()=>{
    assert.deepEqual(await observe(scenario),scenario.expected);
  });
}
