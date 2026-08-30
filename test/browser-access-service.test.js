const assert = require("node:assert/strict");
const test = require("node:test");
const { BrowserAccessService } = require("../packages/control-plane/src/control-plane/instances/browser-access-service.ts");

test("browser access handshake tokens are memory-only and single use", () => {
  const access = new BrowserAccessService(1000);
  const created = access.create({ instanceId: "instance_1", authorization: { userId: "user_1", authorizationRevision: 4 } });
  assert.equal(access.pendingCount(), 1);
  assert.equal(access.consume(created.token).instanceId, "instance_1");
  assert.equal(access.pendingCount(), 0);
  assert.throws(() => access.consume(created.token), (error) => error.code === "BROWSER_ACCESS_TOKEN_INVALID");
  assert.deepEqual(access.diagnostics(), {
    pending: 0, active: 0, issued: 1, consumed: 1, rejected: 1, expired: 0, closed: 0,
  });
});

test("browser access closes channels by access and instance idempotently", () => {
  const access = new BrowserAccessService();
  let closes = 0;
  const first = access.create({ instanceId: "instance_1", authorization: { userId: "user_1", authorizationRevision: 1 } });
  const second = access.create({ instanceId: "instance_2", authorization: { userId: "user_1", authorizationRevision: 1 } });
  access.track(access.consume(first.token), () => { closes += 1; });
  access.track(access.consume(second.token), () => { closes += 1; });
  assert.equal(access.closeInstance("instance_1"), 1);
  assert.equal(access.closeInstance("instance_1"), 0);
  assert.equal(closes, 1);
  assert.equal(access.activeCount(), 1);
  assert.equal(access.diagnostics().closed, 1);
});

test("browser access diagnostics count expiration without retaining credentials", async () => {
  const access = new BrowserAccessService(5);
  const created = access.create({ instanceId: "instance_1", authorization: { userId: "user_1", authorizationRevision: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.throws(() => access.consume(created.token), (error) => error.code === "BROWSER_ACCESS_TOKEN_INVALID");
  assert.deepEqual(access.diagnostics(), {
    pending: 0, active: 0, issued: 1, consumed: 0, rejected: 1, expired: 1, closed: 0,
  });
  assert.doesNotMatch(JSON.stringify(access.diagnostics()), new RegExp(created.token));
});
