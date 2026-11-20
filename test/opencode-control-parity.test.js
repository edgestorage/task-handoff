const assert=require('node:assert/strict');
const fs=require('node:fs');
const test=require('node:test');
const {observe,fixturePath}=require('./fixtures/opencode-control-parity.js');
for(const scenario of JSON.parse(fs.readFileSync(fixturePath,'utf8')).scenarios){
 test(`OpenCode control real HTTP/SSE ${scenario.id}`,{timeout:15000},async()=>{
  assert.deepEqual(await observe(scenario),scenario.expected);
 });
}
