import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationConnectionRegistry } from "../src/control-plane/auth/authorization-connections.ts";

test("authorization connection invalidation closes only stale revisions for one user", () => {
  const registry = new AuthorizationConnectionRegistry();
  const closed: string[] = [];
  registry.track({ userId: "user-a", authorizationRevision: 2 }, () => closed.push("a-old"));
  registry.track({ userId: "user-a", authorizationRevision: 3 }, () => closed.push("a-current"));
  registry.track({ userId: "user-b", authorizationRevision: 1 }, () => closed.push("b"));
  assert.equal(registry.invalidate("user-a", 3), 1);
  assert.deepEqual(closed, ["a-old"]);
  assert.equal(registry.size(), 2);
});

test("released authorization connections are not invalidated", () => {
  const registry = new AuthorizationConnectionRegistry();
  const release = registry.track({ userId: "user-a", authorizationRevision: 1 }, () => assert.fail("released connection closed"));
  release();
  assert.equal(registry.invalidate("user-a", 2), 0);
});
