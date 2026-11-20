const assert = require('node:assert/strict');
const test = require('node:test');
const { observeNodeAuthority } = require('./fixtures/ai-session-authority-parity.js');
const fixture = require('../controlled-instance-rs/crates/instance/tests/fixtures/ai-session-authority-parity.json');

test('U02.1 C01-C05: HTTP/WS revisions, reconnect and expired delta match fixed Node output', async () => {
  assert.deepEqual(await observeNodeAuthority(), fixture.expected);
});
