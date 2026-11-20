const assert=require('node:assert/strict');
const test=require('node:test');
const {observeAttachmentRollback}=require('./fixtures/attachment-rollback-parity.js');
for(const name of ['C01','C02','C03','C04']) test(`U03.8 ${name}: direct rollback and queue ownership`,async()=>{
 const actual=await observeAttachmentRollback(name);
 const fixture=require('../controlled-instance-rs/crates/ai-session/tests/fixtures/attachment-rollback-parity.json');
 assert.deepEqual(actual,fixture.expected[name]);
});
