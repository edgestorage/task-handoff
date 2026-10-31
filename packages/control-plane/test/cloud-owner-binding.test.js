import assert from "node:assert/strict";
import test from "node:test";

import { assertCloudOwnerChangeAllowed } from "../src/control-plane/cloud-connectivity/owner-binding.ts";

test("an active Cloud binding keeps its original local administrator", () => {
  assert.doesNotThrow(() => assertCloudOwnerChangeAllowed({
    bindingStatus: "active",
    currentOwnerUserId: "user_admin_a",
    nextOwnerUserId: "user_admin_a",
  }));
  for (const bindingStatus of ["pending-claim", "active", "pending-revocation", "clone-conflict"]) {
    assert.throws(() => assertCloudOwnerChangeAllowed({
      bindingStatus,
      currentOwnerUserId: "user_admin_a",
      nextOwnerUserId: "user_admin_b",
    }), { code: "CLOUD_BINDING_OWNER_CONFLICT", statusCode: 409 });
  }
});

test("unbinding allows the administrator who binds next to become the owner", () => {
  assert.doesNotThrow(() => assertCloudOwnerChangeAllowed({
    bindingStatus: "unbound",
    currentOwnerUserId: "user_admin_a",
    nextOwnerUserId: "user_admin_b",
  }));
});

test("a bound session without a trustworthy owner must be rebound", () => {
  assert.throws(() => assertCloudOwnerChangeAllowed({
    bindingStatus: "active",
    currentOwnerUserId: undefined,
    nextOwnerUserId: "user_admin_b",
  }), { code: "CLOUD_BINDING_OWNER_CONFLICT" });
});
