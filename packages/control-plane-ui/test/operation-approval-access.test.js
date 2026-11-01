import assert from "node:assert/strict";
import test from "node:test";

import { canReadOperationApprovals } from "../src/apps/control-plane/action-inbox/operationApprovalState.ts";

test("disabled authentication recovers approvals from the local administrator session", () => {
  assert.equal(canReadOperationApprovals({
    authenticated: true,
    enabled: false,
    user: { id: "user_local" },
    authorization: { permissionIds: ["settings:manage"] },
  }), true);
  assert.equal(canReadOperationApprovals({ authenticated: true, enabled: false }), true);
});

test("operation approvals require the administrator permission", () => {
  assert.equal(canReadOperationApprovals({
    authenticated: true,
    enabled: true,
    authorization: { permissionIds: [] },
  }), false);
  assert.equal(canReadOperationApprovals({
    authenticated: true,
    enabled: true,
    user: { id: "usr_owner" },
    authorization: { permissionIds: ["settings:manage"] },
  }), true);
  assert.equal(canReadOperationApprovals({
    authenticated: true,
    enabled: false,
    user: { id: "user_local" },
    authorization: { permissionIds: ["instances:read"] },
  }), false);
  assert.equal(canReadOperationApprovals(undefined), false);
});
