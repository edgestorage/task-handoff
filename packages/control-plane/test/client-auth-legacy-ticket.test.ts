import assert from "node:assert/strict";
import test from "node:test";
import { OUTBOUND_CONNECTION_PROTOCOL_VERSION, OfficialAudience } from "@task-handoff/cloud-contracts";
import { authenticateCloudClient, CloudClientAuthenticationError } from "../src/control-plane/cloud-connectivity/client-auth.ts";

test("an old access ticket without a device proof key returns unsupported-client", () => {
  const fingerprint = `sha256:${"a".repeat(43)}`;
  const ticket = {
    protocolVersion: OUTBOUND_CONNECTION_PROTOCOL_VERSION,
    audience: OfficialAudience.ControlPlaneAccess,
    ticketId: "ticket_legacy",
    accountId: "account_owner",
    deviceSessionId: "device_legacy",
    controlPlaneId: "control_plane_legacy",
    bindingId: "binding_legacy",
    bindingRevision: 1,
    trafficClasses: ["interactive"],
    ownerAccountId: "account_owner",
    accessMode: "owner",
    accessRoleId: "role_admin",
    nonce: "n".repeat(32),
    targetPublicKeyFingerprint: fingerprint,
    issuedAt: "2026-10-26T00:00:00.000Z",
    expiresAt: "2026-10-26T00:05:00.000Z",
    signature: "s".repeat(64),
  };
  assert.throws(() => authenticateCloudClient({
    ticket,
    grant: {},
    clientHello: {},
    controlPlaneFingerprint: fingerprint,
  }), (error) => error instanceof CloudClientAuthenticationError
    && error.trustRequired === "unsupported-client"
    && error.code === "CLOUD_DEVICE_AUTH_UNSUPPORTED_CLIENT");
});
