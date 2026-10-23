import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import * as publicContracts from "./src/index.ts";
import {
  AccessTicketSchema,
  AccountApiContextSchema,
  AccountPublicProfileSchema,
  BindingChallengeCapabilitySchema,
  CONTROL_PLANE_SHARED_ACCESS_CAPABILITY,
  ControlPlaneDirectoryEntrySchema,
  DeviceSessionSchema,
  NodeRelayAllocationErrorSchema,
  NodeRelayAllocationEventSchema,
  NodeRelayAllocationRequestSchema,
  NodeRelayAllocationRequestV2Schema,
  NodeRelayClaimGrantPayloadSchema,
  NodeRelayProbeTargetsResponseSchema,
  OfficialAudience,
  OutboundConnectionRegistrationSchema,
  OFFICIAL_ACCOUNT_API_PROTOCOL_VERSION,
  CONTROL_PLANE_BINDING_PROTOCOL_VERSION,
  OUTBOUND_CONNECTION_PROTOCOL_VERSION,
  CONTROL_PLANE_REGISTRATION_PROTOCOL_VERSION,
  RELAY_FRAMING_PROTOCOL_VERSION,
  RelayAttachCapabilitySchema,
  RelayChannelSchema,
  RelayNodeChannelAttachCapabilitySchema,
  RelayRevocationSchema,
  ResourceAccessSchema,
  RESOURCE_SHARING_CLIENT_CAPABILITY,
  acceptControlPlaneHandshake,
  beginClientHandshake,
  finishClientHandshake,
  type AccessTicket,
} from "./src/index.ts";

const at = "2026-08-10T00:00:00.000Z";
const fingerprint = `sha256:${"a".repeat(43)}`;

test("public protocol versions use independent YYYY-MM-DD constants", () => {
  for (const version of [OFFICIAL_ACCOUNT_API_PROTOCOL_VERSION, CONTROL_PLANE_BINDING_PROTOCOL_VERSION, CONTROL_PLANE_REGISTRATION_PROTOCOL_VERSION, OUTBOUND_CONNECTION_PROTOCOL_VERSION, RELAY_FRAMING_PROTOCOL_VERSION]) {
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
  // Control Planes sign in as their own device session, so the public device list must
  // keep accepting the kind the cloud service returns for them.
  assert.equal(DeviceSessionSchema.safeParse({ ...device, kind: "control-plane", platform: "control-plane" }).success, true);
  assert.equal(DeviceSessionSchema.safeParse({ ...device, kind: "cli" }).success, false);
});

test("public package does not export Cloud persistence or credential models", () => {
  for (const internalName of ["OfficialAccountSchema", "TokenFamilySchema", "SecurityEventSchema", "StoredRecordEnvelopeSchema", "parseStoredRecord"]) {
    assert.equal(internalName in publicContracts, false, `${internalName} must remain Cloud-internal`);
  }
});

test("node relay v2 contracts are additive and keep the allocation winner opaque", () => {
  const v1Request = { nodeId: "node_machine", refreshControlPlaneIds: ["control_plane_a"] };
  assert.equal(NodeRelayAllocationRequestSchema.safeParse(v1Request).success, true);
  assert.equal(NodeRelayAllocationRequestSchema.safeParse({ ...v1Request, probeEvidence: { measurements: [] } }).success, false);

  const targets = {
    targets: [
      { relayId: "relay_a", relayUrl: "wss://relay-a.example.test/connect" },
      { relayId: "relay_b", relayUrl: "wss://relay-b.example.test/connect" },
      { relayId: "relay_c", relayUrl: "wss://relay-c.example.test/connect" },
    ],
  };
  assert.deepEqual(NodeRelayProbeTargetsResponseSchema.parse(targets), targets);
  assert.equal(NodeRelayProbeTargetsResponseSchema.safeParse({ targets: [...targets.targets, targets.targets[0]] }).success, false);
  assert.equal(NodeRelayProbeTargetsResponseSchema.safeParse({ targets: [{ ...targets.targets[0], claimGrant: "leak" }] }).success, false);

  const v2Request = {
    nodeId: "node_machine",
    refreshControlPlaneIds: ["control_plane_a"],
    probeEvidence: {
      measurements: [{ relayId: "relay_a", rttMs: 24.5, sampleCount: 2, failureCount: 0, measuredAt: at }],
    },
  };
  assert.deepEqual(NodeRelayAllocationRequestV2Schema.parse(v2Request), v2Request);
  assert.equal(NodeRelayAllocationRequestV2Schema.safeParse({ ...v2Request, batchId: "batch_a" }).success, false);
  assert.equal(NodeRelayAllocationRequestV2Schema.safeParse({ ...v2Request, unexpected: true }).success, false);
  assert.equal(NodeRelayAllocationRequestV2Schema.safeParse({ ...v2Request, probeEvidence: { measurements: [{ ...v2Request.probeEvidence.measurements[0], rttMs: -1 }] } }).success, false);
  assert.equal(NodeRelayAllocationErrorSchema.safeParse({ error: { code: "NODE_RELAY_ADAPTIVE_SELECTION_UNSUPPORTED", message: "Not available." } }).success, true);
  assert.equal(NodeRelayAllocationErrorSchema.safeParse({ error: { code: "NO", message: "Not available.", secret: "leak" } }).success, false);
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

  const registration = { protocolVersion: CONTROL_PLANE_REGISTRATION_PROTOCOL_VERSION, audience: OfficialAudience.CoordinatorControl, connectionId: "connection_a", processInstanceId: "process_a", reportedControlPlaneId: "control_plane_a", publicKey: "p".repeat(43), publicKeyFingerprint: fingerprint, epoch: 1, capabilities: ["request", "stream", "websocket"], issuedAt: at, expiresAt: at, signature: "s".repeat(32) };
  assert.equal(OutboundConnectionRegistrationSchema.safeParse(registration).success, true);
  assert.equal(OutboundConnectionRegistrationSchema.safeParse({ ...registration, bindingId: "binding_a" }).success, false);
});

test("shared authority fields are additive, complete, and resource-role scoped", () => {
  assert.equal(RESOURCE_SHARING_CLIENT_CAPABILITY, "resource-sharing-v1");
  assert.equal(CONTROL_PLANE_SHARED_ACCESS_CAPABILITY, "shared-access-v1");
  assert.equal(ResourceAccessSchema.safeParse({ kind: "owner" }).success, true);
  assert.equal(ResourceAccessSchema.safeParse({ kind: "shared", shareId: "share_a", revision: 2, role: "viewer", expiresAt: at }).success, true);
  assert.equal(ResourceAccessSchema.safeParse({ kind: "shared", shareId: "share_a", revision: 2, role: "use", expiresAt: at }).success, true);
  assert.equal(ResourceAccessSchema.safeParse({ kind: "shared", shareId: "share_a", revision: 2, expiresAt: at }).success, false);

  const ownerTicket = { protocolVersion: OUTBOUND_CONNECTION_PROTOCOL_VERSION, audience: OfficialAudience.ControlPlaneAccess, ticketId: "ticket_owner", accountId: "account_owner", deviceSessionId: "session_a", controlPlaneId: "control_plane_a", bindingId: "binding_a", bindingRevision: 2, targetPublicKeyFingerprint: fingerprint, nonce: "n".repeat(32), trafficClasses: ["interactive"], issuedAt: at, expiresAt: at, signature: "s".repeat(64) };
  const sharedTicket = { ...ownerTicket, ticketId: "ticket_shared", accountId: "account_grantee", ownerAccountId: "account_owner", accessMode: "shared", shareGrantId: "share_a", shareRevision: 3, shareRole: "viewer" };
  assert.equal(AccessTicketSchema.safeParse(ownerTicket).success, true);
  assert.equal(AccessTicketSchema.safeParse(sharedTicket).success, true);
  assert.equal(AccessTicketSchema.safeParse({ ...ownerTicket, ownerAccountId: "account_owner" }).success, false);
  assert.equal(AccessTicketSchema.safeParse({ ...sharedTicket, shareRevision: undefined }).success, false);
  assert.equal(AccessTicketSchema.safeParse({ ...sharedTicket, shareRole: "use" }).success, false);
  assert.equal(AccessTicketSchema.safeParse({ ...sharedTicket, ownerAccountId: "account_grantee" }).success, false);

  const attach = { protocolVersion: RELAY_FRAMING_PROTOCOL_VERSION, audience: OfficialAudience.RelayClientAttach, allocationId: "allocation_a", relayId: "relay_a", role: "client", controlPlaneId: "control_plane_a", accountId: "account_grantee", deviceSessionId: "session_a", bindingId: "binding_a", ticketId: "ticket_shared", bindingRevision: 2, trafficClass: "interactive", nonce: "n".repeat(16), issuedAt: at, expiresAt: at, signature: "s".repeat(32), ownerAccountId: "account_owner", accessMode: "shared", shareGrantId: "share_a", shareRevision: 3, shareRole: "operator" };
  assert.equal(RelayAttachCapabilitySchema.safeParse(attach).success, true);
  assert.equal(RelayAttachCapabilitySchema.safeParse({ ...attach, shareGrantId: undefined }).success, false);
  assert.equal(RelayAttachCapabilitySchema.safeParse({ ...attach, shareRole: "use" }).success, false);
});

test("node grants and revocations carry complete shared node authority", () => {
  const shared = { ownerAccountId: "account_owner", accessMode: "shared", shareGrantId: "share_node_a", shareRevision: 4, shareRole: "use" };
  const nodeAttach = { protocolVersion: RELAY_FRAMING_PROTOCOL_VERSION, channelKind: "node", audience: OfficialAudience.RelayControlPlaneAttach, allocationId: "allocation_node", relayId: "relay_a", role: "control-plane", controlPlaneId: "control_plane_a", accountId: "account_grantee", bindingId: "binding_a", bindingRevision: 2, nodeHandle: "node_alpha", trafficClass: "interactive", nonce: "n".repeat(16), issuedAt: at, expiresAt: at, signature: "s".repeat(32), ...shared };
  assert.equal(RelayNodeChannelAttachCapabilitySchema.safeParse(nodeAttach).success, true);
  assert.equal(RelayNodeChannelAttachCapabilitySchema.safeParse({ ...nodeAttach, shareRole: "viewer" }).success, false);
  assert.equal(RelayNodeChannelAttachCapabilitySchema.safeParse({ ...nodeAttach, accessMode: undefined }).success, false);

  const claimGrant = { protocolVersion: RELAY_FRAMING_PROTOCOL_VERSION, audience: OfficialAudience.RelayNodeClaimGrant, grantId: "grant_a", allocationId: "allocation_node", nodeHandle: "node_alpha", controlPlaneId: "control_plane_a", accountId: "account_grantee", bindingId: "binding_a", bindingRevision: 2, relayId: "relay_a", relayRegion: "test", relayUrl: "https://relay.example.test", nonce: "n".repeat(16), issuedAt: at, expiresAt: at, controlPlanePublicKey: "p".repeat(43), ...shared };
  assert.equal(NodeRelayClaimGrantPayloadSchema.safeParse(claimGrant).success, true);
  assert.equal(NodeRelayClaimGrantPayloadSchema.safeParse({ ...claimGrant, shareRevision: undefined }).success, false);

  const allocationEvent = { type: "node-relay-allocation", protocolVersion: OUTBOUND_CONNECTION_PROTOCOL_VERSION, allocationId: "allocation_node", relayId: "relay_a", relayRegion: "test", relayUrl: "https://relay.example.test", nodeHandle: "node_alpha", accountId: "account_grantee", controlPlaneId: "control_plane_a", bindingId: "binding_a", bindingRevision: 2, controlPlaneAttach: nodeAttach, expiresAt: at, ...shared };
  assert.equal(NodeRelayAllocationEventSchema.safeParse(allocationEvent).success, true);
  assert.equal(NodeRelayAllocationEventSchema.safeParse({ ...allocationEvent, ownerAccountId: undefined }).success, false);

  const revocation = { protocolVersion: RELAY_FRAMING_PROTOCOL_VERSION, audience: OfficialAudience.RelayRevocation, revocationId: "revocation_share", channelKind: "node", shareGrantId: "share_node_a", shareRevision: 4, accessMode: "shared", issuedAt: at, expiresAt: at, signature: "s".repeat(32) };
  assert.equal(RelayRevocationSchema.safeParse(revocation).success, true);
  assert.equal(RelayRevocationSchema.safeParse({ ...revocation, shareRevision: undefined }).success, false);
  assert.equal(RelayRevocationSchema.safeParse({ ...revocation, accessMode: "owner" }).success, false);
});

test("capability negotiation accepts only the shared-access registration capability", () => {
  const registration = { protocolVersion: CONTROL_PLANE_REGISTRATION_PROTOCOL_VERSION, audience: OfficialAudience.CoordinatorControl, connectionId: "connection_a", processInstanceId: "process_a", reportedControlPlaneId: "control_plane_a", publicKey: "p".repeat(43), publicKeyFingerprint: fingerprint, epoch: 1, capabilities: ["request", CONTROL_PLANE_SHARED_ACCESS_CAPABILITY], issuedAt: at, expiresAt: at, signature: "s".repeat(32) };
  assert.equal(OutboundConnectionRegistrationSchema.safeParse(registration).success, true);
  assert.equal(OutboundConnectionRegistrationSchema.safeParse({ ...registration, capabilities: ["resource-sharing-v1"] }).success, false);
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

  const sharedTicket: AccessTicket = { ...ticket, accountId: "account_grantee", ownerAccountId: "account_owner", accessMode: "shared", shareGrantId: "share_a", shareRevision: 3, shareRole: "viewer" };
  const sharedClient = beginClientHandshake(sharedTicket);
  const sharedAccepted = acceptControlPlaneHandshake({ ticket: sharedTicket, clientHello: sharedClient.hello, controlPlaneFingerprint: fingerprint, controlPlanePrivateKey: controlPlane.privateKey });
  assert.deepEqual(finishClientHandshake(sharedClient.privateState, sharedAccepted.response, controlPlane.publicKey), sharedAccepted.sessionKey);
  assert.throws(() => finishClientHandshake({ ...sharedClient.privateState, ticket: { ...sharedTicket, shareRevision: 4 } }, sharedAccepted.response, controlPlane.publicKey), { code: "E2E_HANDSHAKE_INVALID" });
});
