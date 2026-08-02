const assert = require("node:assert/strict");
const test = require("node:test");

const { AsyncTtlCache } = require("../packages/control-plane/src/control-plane/chat/gateway/async-ttl-cache.ts");

test("async TTL cache coalesces concurrent loads and refreshes only after expiry", async () => {
  let now = 100;
  let calls = 0;
  let release;
  const firstLoad = new Promise((resolve) => {
    release = resolve;
  });
  const cache = new AsyncTtlCache(50, async () => {
    calls += 1;
    if (calls === 1) return firstLoad;
    return `value-${calls}`;
  }, { now: () => now });

  const first = cache.get();
  const concurrent = cache.get();
  assert.equal(calls, 1);
  release("value-1");
  assert.equal(await first, "value-1");
  assert.equal(await concurrent, "value-1");

  now = 149;
  assert.equal(await cache.get(), "value-1");
  assert.equal(calls, 1);
  now = 150;
  assert.equal(await cache.get(), "value-2");
  assert.equal(calls, 2);
});

test("async TTL cache retries rejected loads instead of caching failures", async () => {
  let calls = 0;
  const cache = new AsyncTtlCache(50, async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary failure");
    return "recovered";
  });

  await assert.rejects(cache.get(), /temporary failure/);
  assert.equal(await cache.get(), "recovered");
  assert.equal(calls, 2);
});

test("async TTL cache invalidation forces a new load", async () => {
  let calls = 0;
  const cache = new AsyncTtlCache(60_000, async () => `value-${++calls}`);

  assert.equal(await cache.get(), "value-1");
  cache.invalidate();
  assert.equal(await cache.get(), "value-2");
});

test("async TTL cache invalidation isolates an in-flight stale load", async () => {
  let calls = 0;
  let releaseFirst;
  const firstLoad = new Promise((resolve) => { releaseFirst = resolve; });
  const cache = new AsyncTtlCache(60_000, async () => {
    calls += 1;
    return calls === 1 ? firstLoad : `value-${calls}`;
  });

  const first = cache.get();
  cache.invalidate();
  assert.equal(await cache.get(), "value-2");
  releaseFirst("stale-value");
  assert.equal(await first, "stale-value");
  assert.equal(await cache.get(), "value-2");
  assert.equal(calls, 2);
});
