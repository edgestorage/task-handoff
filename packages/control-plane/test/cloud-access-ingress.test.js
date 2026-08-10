import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlaneIdentityService } from "../src/control-plane/identity/service.ts";
import { CloudAccessIngress } from "../src/control-plane/cloud-connectivity/access-ingress.ts";
import { CloudConnectivityService } from "../src/control-plane/cloud-connectivity/service.ts";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "cloud-ingress-"));
  const identity = new ControlPlaneIdentityService(path.join(directory, "identity.json"), () => "control_plane_a"); identity.init();
  const state = new CloudConnectivityService({ statePath: path.join(directory, "cloud.json"), identity, serviceOrigin: "https://cloud.example.test" }); state.init();
  const challenge = state.createChallenge(); state.consumeChallenge({ challengeCode: challenge.challengeCode, controlPlaneId: challenge.payload.controlPlaneId, fingerprint: challenge.payload.publicKeyFingerprint });
  state.activate({ accountId: "account_a", bindingId: "binding_a", bindingRevision: 4, backgroundCredential: "x".repeat(48) });
  const assertion = { accountId: "account_a", deviceSessionId: "device_a", controlPlaneId: challenge.payload.controlPlaneId, bindingId: "binding_a", bindingRevision: 4, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  return { state, assertion };
}

test("cloud ingress maps verified account assertion to existing authorization without a parallel business API", async () => {
  const { state, assertion } = await fixture();
  const ingress = new CloudAccessIngress({ state, verifyAssertion: (value) => value });
  assert.equal((await ingress.authorize(assertion, "read", { type: "node" })).type, "cloud-account");
  await ingress.authorize(assertion, "start", { type: "instance", id: "instance_a" });
  await ingress.authorize(assertion, "send-message", { type: "ai-session", id: "session_a" });
  await assert.rejects(() => ingress.authorize(assertion, "manage-settings", { type: "control-plane-settings" }), { code: "CONTROL_PLANE_FORBIDDEN" });
  await assert.rejects(() => ingress.authorize(assertion, "manage-secrets", { type: "secret" }), { code: "CONTROL_PLANE_FORBIDDEN" });
});

test("cloud ingress rejects stale revision, disabled remote access and expired assertions", async () => {
  const { state, assertion } = await fixture(); const ingress = new CloudAccessIngress({ state, verifyAssertion: (value) => value });
  await assert.rejects(() => ingress.actor({ ...assertion, bindingRevision: 3 }), { code: "CLOUD_ASSERTION_NOT_AUTHORIZED" });
  state.setRemoteAccess(false);
  await assert.rejects(() => ingress.actor(assertion), { code: "CLOUD_ASSERTION_NOT_AUTHORIZED" });
});
