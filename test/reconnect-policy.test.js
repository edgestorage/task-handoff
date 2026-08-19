const assert = require("node:assert/strict");
const test = require("node:test");

const {
  STANDARD_RECONNECT_MAX_DELAY_MS,
  StandardReconnectBackoff,
  standardReconnectDelayMs,
} = require("../packages/core/src/core/reconnect.ts");

test("shared reconnect policy retries immediately, then at 250ms, then uses jittered exponential backoff", () => {
  assert.equal(standardReconnectDelayMs(1, () => 0.5), 0);
  assert.equal(standardReconnectDelayMs(2, () => 0.5), 250);
  assert.equal(standardReconnectDelayMs(3, () => 0), 375);
  assert.equal(standardReconnectDelayMs(3, () => 0.5), 500);
  assert.equal(standardReconnectDelayMs(3, () => 1), 625);
  assert.equal(standardReconnectDelayMs(20, () => 1), STANDARD_RECONNECT_MAX_DELAY_MS);
});

test("shared reconnect backoff resets to an immediate retry", () => {
  const backoff = new StandardReconnectBackoff(() => 0.5);
  assert.deepEqual(backoff.next(), { attempt: 1, delay: 0 });
  assert.deepEqual(backoff.next(), { attempt: 2, delay: 250 });
  assert.deepEqual(backoff.next(), { attempt: 3, delay: 500 });
  backoff.reset();
  assert.deepEqual(backoff.next(), { attempt: 1, delay: 0 });
});
