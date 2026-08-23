import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizationCacheEpoch,
  authorizationCacheEpochChanged,
  preserveAcrossAuthorizationChange,
} from "../src/api/authorizationCache.ts";

const access = (userId, revision) => ({
  userId,
  identityId: `identity-${userId}`,
  roleIds: ["role_operator"],
  permissionIds: ["nodes:read"],
  nodeScope: { kind: "selected", nodeIds: ["node-a"] },
  authorizationRevision: revision,
});

test("authorization cache epoch isolates users and every authorization revision", () => {
  const admin = authorizationCacheEpoch(access("admin", 1));
  const operator = authorizationCacheEpoch(access("operator", 1));
  const viewer = authorizationCacheEpoch(access("viewer", 1));

  assert.equal(authorizationCacheEpochChanged(admin, operator), true);
  assert.equal(authorizationCacheEpochChanged(operator, viewer), true);
  assert.equal(authorizationCacheEpochChanged(viewer, authorizationCacheEpoch(access("viewer", 2))), true);
  assert.equal(authorizationCacheEpochChanged(viewer, viewer), false);
  assert.equal(authorizationCacheEpochChanged("", viewer), false);
});

test("authorization changes preserve only identity queries", () => {
  assert.equal(preserveAcrossAuthorizationChange(["auth-session"]), true);
  assert.equal(preserveAcrossAuthorizationChange(["control-plane-current-access"]), true);
  assert.equal(preserveAcrossAuthorizationChange(["instance-board", "instance-a"]), false);
  assert.equal(preserveAcrossAuthorizationChange(["control-plane-ai-sessions"]), false);
});
