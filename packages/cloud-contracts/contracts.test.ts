import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import * as publicContracts from "./src/index.ts";
import {
  AccessTicketSchema,
  AccountApiContextSchema,
  AccountPublicProfileSchema,
  BindingChallengeCapabilitySchema,
  ControlPlaneDirectoryEntrySchema,
  DeviceSessionSchema,
  OfficialAudience,
  OutboundConnectionRegistrationSchema,
  OFFICIAL_ACCOUNT_API_PROTOCOL_VERSION,
  CONTROL_PLANE_BINDING_PROTOCOL_VERSION,
  OUTBOUND_CONNECTION_PROTOCOL_VERSION,
  RELAY_FRAMING_PROTOCOL_VERSION,
  RelayAttachCapabilitySchema,
  RelayChannelSchema,
  acceptControlPlaneHandshake,
  beginClientHandshake,
  finishClientHandshake,
  type AccessTicket,
} from "./src/index.ts";

const at = "2026-08-10T00:00:00.000Z";
const fingerprint = `sha256:${"a".repeat(43)}`;

test("public protocol versions use independent YYYY-MM-DD constants", () => {
  for (const version of [OFFICIAL_ACCOUNT_API_PROTOCOL_VERSION, CONTROL_PLANE_BINDING_PROTOCOL_VERSION, OUTBOUND_CONNECTION_PROTOCOL_VERSION, RELAY_FRAMING_PROTOCOL_VERSION]) {
    assert.match(version, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(AccountApiContextSchema.safeParse({ protocolVersion: OFFICIAL_ACCOUNT_API_PROTOCOL_VERSION, audience: OfficialAudience.AccountApi }).success, true);
});

test("account API projections contain only client-visible fields", () => {
  const profile = { id: "account_a", email: "USER@example.com", emailVerified: true, hasPassword: true, status: "active", createdAt: at };
  assert.equal(AccountPublicProfileSchema.parse(profile).email, "user@example.com");
  assert.equal(AccountPublicProfileSchema.safeParse({ ...profile, passwordHash: "leak" }).success, false);

  const device = { id: "session_a", kind: "mobile", deviceName: "Phone", createdAt: at, expiresAt: at };
  assert.deepEqual(DeviceSessionSchema.parse(device), device);
  assert.equal(DeviceSessionSchema.safeParse({ ...device, accountId: "account_a", tokenFamilyId: "family_a" }).success, false);
});

test("public package does not export Cloud persistence or credential models", () => {
  for (const internalName of ["OfficialAccountSchema", "TokenFamilySchema", "SecurityEventSchema", "StoredRecordEnvelopeSchema", "parseStoredRecord"]) {
    assert.equal(internalName in publicContracts, false, `${internalName} must remain Cloud-internal`);
  }
});

test("binding directory excludes node, instance, endpoint, and business state", () => {
  const challenge = {
    protocolVersion: CONTROL_PLANE_BINDING_PROTOCOL_VERSION,
    audience: OfficialAudience.Binding,
    challengeId: "challenge_a",
    challenge: "c".repeat(32),
    serviceOrigin: "https://cloud.example.test",
    identity: { controlPlaneId: "control_plane_a", algorithm: "Ed25519", publicKey: "p".repeat(43), fingerprint },
    nonce: "n".repeat(16),
    initiatingAdminSessionId: "session_admin",
    issuedAt: at,
    expiresAt: at,
  };
  assert.equal(BindingChallengeCapabilitySchema.safeParse(challenge).success, true);
  assert.equal(BindingChallengeCapabilitySchema.safeParse({ ...challenge, nodeId: "node_a" }).success, false);

  const entry = { bindingId: "binding_a", controlPlaneId: "control_plane_a", displayName: { default: "Office" }, publicKeyFingerprint: fingerprint, bindingRevision: 1, remoteAccess: "enabled", relayUsageBytes: 0 };
  assert.equal(ControlPlaneDirectoryEntrySchema.safeParse(entry).success, true);
  for (const forbidden of [{ nodeId: "node_a" }, { instanceId: "instance_a" }, { business: "online" }, { endpoint: "http://127.0.0.1:8091" }]) {
    assert.equal(ControlPlaneDirectoryEntrySchema.safeParse({ ...entry, ...forbidden }).success, false);
  }
});

test("ticket, registration, and relay contracts bind authority identities", () => {
  const ticket = { protocolVersion: OUTBOUND_CONNECTION_PROTOCOL_VERSION, audience: OfficialAudience.ControlPlaneAccess, ticketId: "ticket_a", accountId: "account_a", deviceSessionId: "session_mobile", controlPlaneId: "control_plane_a", bindingId: "binding_a", bindingRevision: 2, targetPublicKeyFingerprint: fingerprint, nonce: "n".repeat(16), trafficClasses: ["interactive"], issuedAt: at, expiresAt: at, signature: "s".repeat(32) };
  assert.equal(AccessTicketSchema.safeParse(ticket).success, true);
  assert.equal(AccessTicketSchema.safeParse({ ...ticket, endpoint: "tcp://node:1" }).success, false);

  const attach = { protocolVersion: RELAY_FRAMING_PROTOCOL_VERSION, audience: OfficialAudience.RelayClientAttach, allocationId: "allocation_a", relayId: "relay_a", role: "client", controlPlaneId: "control_plane_a", accountId: "account_a", deviceSessionId: "session_mobile", bindingId: "binding_a", ticketId: "ticket_a", bindingRevision: 2, trafficClass: "interactive", nonce: "n".repeat(16), issuedAt: at, expiresAt: at, signature: "s".repeat(32) };
  assert.equal(RelayAttachCapabilitySchema.safeParse(attach).success, true);
  assert.equal(RelayAttachCapabilitySchema.safeParse({ ...attach, audience: OfficialAudience.RelayControlPlaneAttach }).success, false);
  assert.equal(RelayChannelSchema.safeParse({ channelId: "channel_a", allocationId: "allocation_a", controlPlaneId: "control_plane_a", bindingRevision: 2, trafficClass: "interactive", state: "waiting-for-peer", clientAttached: true, controlPlaneAttached: false, leaseExpiresAt: at }).success, true);

  const registration = { protocolVersion: OUTBOUND_CONNECTION_PROTOCOL_VERSION, audience: OfficialAudience.CoordinatorControl, connectionId: "connection_a", processInstanceId: "process_a", controlPlaneId: "control_plane_a", publicKey: "p".repeat(43), publicKeyFingerprint: fingerprint, epoch: 1, capabilities: ["request", "stream", "websocket"], issuedAt: at, expiresAt: at, signature: "s".repeat(32) };
  assert.equal(OutboundConnectionRegistrationSchema.safeParse(registration).success, true);
  assert.equal(OutboundConnectionRegistrationSchema.safeParse({ ...registration, bindingId: "binding_a" }).success, false);
});

test("X25519 session key is bound to the signed Control Plane and ticket transcript", () => {
  const controlPlane = generateKeyPairSync("ed25519");
  const publicX = controlPlane.publicKey.export({ format: "jwk" }).x;
  assert.ok(publicX);
  const fingerprint = `sha256:${createHash("sha256").update(Buffer.from(publicX, "base64url")).digest("base64url")}`;
  const ticket: AccessTicket = { protocolVersion: OUTBOUND_CONNECTION_PROTOCOL_VERSION, audience: OfficialAudience.ControlPlaneAccess, ticketId: "ticket_a", accountId: "account_a", deviceSessionId: "session_a", controlPlaneId: "control_plane_a", bindingId: "binding_a", bindingRevision: 2, trafficClasses: ["interactive"], nonce: "n".repeat(32), targetPublicKeyFingerprint: fingerprint, issuedAt: at, expiresAt: "2026-08-10T00:05:00.000Z", signature: "s".repeat(64) };
  const client = beginClientHandshake(ticket);
  const accepted = acceptControlPlaneHandshake({ ticket, clientHello: client.hello, controlPlaneFingerprint: fingerprint, controlPlanePrivateKey: controlPlane.privateKey });
  const clientKey = finishClientHandshake(client.privateState, accepted.response, controlPlane.publicKey);
  assert.deepEqual(clientKey, accepted.sessionKey);
  assert.throws(() => finishClientHandshake({ ...client.privateState, ticket: { ...ticket, bindingRevision: 1 } }, accepted.response, controlPlane.publicKey), { code: "E2E_HANDSHAKE_INVALID" });
});
