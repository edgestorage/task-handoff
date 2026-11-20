const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {observe} = require('./fixtures/codex-interaction-parity.js');
const fixturePath=path.resolve(__dirname,'../controlled-instance-rs/crates/ai-session/tests/fixtures/codex-early-ack-parity.json');
for(const scenario of JSON.parse(fs.readFileSync(fixturePath,'utf8')).scenarios) {
  test(`Codex real WS early ack ${scenario.id}`,{timeout:15000},async()=>{
    assert.deepEqual(await observe({...scenario,assertAck:true}),scenario.expected);
  });
}
