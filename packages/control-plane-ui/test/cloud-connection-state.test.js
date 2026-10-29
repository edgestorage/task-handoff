import assert from "node:assert/strict";
import test from "node:test";
import { resolveCloudConnectionStage } from "../src/apps/control-plane/settings/cloudConnectionState.ts";

test("cloud connection authority states take precedence over pending account requests", () => {
  assert.equal(resolveCloudConnectionStage({ status: "clone-conflict", signedIn: true, pendingScope: "account:sign-in" }), "conflict");
  assert.equal(resolveCloudConnectionStage({ status: "pending-revocation", signedIn: true, pendingScope: "control-plane:bind" }), "revoking");
  assert.equal(resolveCloudConnectionStage({ status: "active", signedIn: false, pendingScope: "account:sign-in" }), "active");
});

test("login-only and binding-pending states are distinct", () => {
  assert.equal(resolveCloudConnectionStage({ status: "unbound", signedIn: false, pendingScope: "account:sign-in" }), "awaiting-sign-in");
  assert.equal(resolveCloudConnectionStage({ status: "pending-claim", signedIn: true, pendingScope: "control-plane:bind" }), "awaiting-binding");
  assert.equal(resolveCloudConnectionStage({ status: "unbound", signedIn: true }), "signed-in-unbound");
  assert.equal(resolveCloudConnectionStage({ status: "unbound", signedIn: false }), "signed-out");
});
