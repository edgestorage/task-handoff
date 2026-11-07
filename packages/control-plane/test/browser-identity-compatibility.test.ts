import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPublicKey, verify, sign, generateKeyPairSync } from "node:crypto";
import { ControlPlaneIdentityService } from "../src/control-plane/identity/service.ts";
import { ControlPlanePublicIdentityDocumentSchema, controlPlaneIdentitySigningInput, normalizeControlPlanePublicCapabilities, supportsControlPlaneBrowserChannel, requestsExtendedControlPlaneCapabilities } from "@task-handoff/protocol/control-plane-access";
import { parseResponse } from "@task-handoff/protocol/response-validation";

test("mobile-v0.0.12 / v0.0.49 identity consumers keep their original signed projection unless extensions are requested", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "browser-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const identity = new ControlPlaneIdentityService(path.join(directory, "identity.json"), () => "control_plane_test");
  identity.init();
  const legacy = identity.publicDocument("required");
  assert.equal(legacy.data.payload.capabilities.browserTunnel, undefined);
  // Frozen schema order from v0.0.49 / mobile-v0.0.12. An additive field signed
  // by default would fail this reconstruction even when the reader strips it.
  const p = legacy.data.payload;
  const c = p.capabilities;
  const reconstructed = {
    version: p.version, kind: p.kind, controlPlaneId: p.controlPlaneId,
    publicKey: p.publicKey,
    capabilities: { authentication: c.authentication, aiSessions: c.aiSessions, nodes: c.nodes, instanceBoard: c.instanceBoard, triggers: c.triggers, stories: c.stories, cliSessions: c.cliSessions, localCliSessions: c.localCliSessions, accessManagement: c.accessManagement },
    protocolVersion: p.protocolVersion, issuedAt: p.issuedAt, expiresAt: p.expiresAt,
  };
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: p.publicKey.value }, format: "jwk" });
  assert.equal(verify(null, Buffer.from(JSON.stringify(reconstructed)), key, Buffer.from(legacy.data.signature, "base64url")), true);
  const extended = identity.publicDocument("required", Date.now(), true);
  assert.equal(supportsControlPlaneBrowserChannel(extended.data.payload.capabilities), true);
  assert.equal(verify(null, Buffer.from(controlPlaneIdentitySigningInput(extended.data.payload)), key, Buffer.from(extended.data.signature, "base64url")), true);
  assert.equal(requestsExtendedControlPlaneCapabilities("future, control-plane-identity-extensions-v1"), true);
  assert.equal(requestsExtendedControlPlaneCapabilities(undefined), false);
  assert.equal(supportsControlPlaneBrowserChannel(c), false);
});

test("future signed fields retain their wire order through response parsing, then normalize separately", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "browser-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const identity = new ControlPlaneIdentityService(path.join(directory, "identity.json"), () => "control_plane_test");
  identity.init();
  const base = identity.publicDocument("required").data.payload;
  const payload = { futureBeforeVersion: { nested: true }, ...base, capabilities: { futureBeforeAuthentication: "new", ...base.capabilities, browserTunnel: { cloudRelay: true, future: "new" } }, futureAfterExpiry: 123 };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signature = sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString("base64url");
  const parsed = parseResponse(ControlPlanePublicIdentityDocumentSchema, { data: { payload, signature } });
  assert.equal(controlPlaneIdentitySigningInput(parsed.data.payload), JSON.stringify(payload));
  assert.equal(verify(null, Buffer.from(controlPlaneIdentitySigningInput(parsed.data.payload)), publicKey, Buffer.from(signature, "base64url")), true);
  assert.equal(supportsControlPlaneBrowserChannel(parsed.data.payload.capabilities), true);
  assert.equal("futureBeforeAuthentication" in normalizeControlPlanePublicCapabilities(parsed.data.payload.capabilities)!, false);
  assert.throws(() => parseResponse(ControlPlanePublicIdentityDocumentSchema, { data: { payload: { ...payload, capabilities: { ...payload.capabilities, aiSessions: "invalid" } }, signature } }));
});
