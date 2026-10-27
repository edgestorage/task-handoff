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
  ControlPlaneResourceAccessSchema,
  NodeResourceAccessSchema,
  RESOURCE_SHARING_CLIENT_CAPABILITY,
  CLOUD_CLIENT_HANDSHAKE_AUDIENCE,
  CLOUD_DEVICE_AUTH_PROTOCOL_VERSION,
  CLOUD_DEVICE_TRUST_AUDIENCE,
  ClientHelloSchema,
  CloudClientHandshakeReplySchema,
  CloudDeviceAuthSchema,
  RELAY_SESSION_PROTOCOL_VERSION,
  RelaySessionAudience,
  acceptControlPlaneHandshake,
  beginClientHandshake,
  cloudClientTranscriptSigningInput,
  cloudClientTrustOutcomeSigningInput,
  cloudDeviceAuthBindings,
  cloudDeviceAuthSigningInput,
  cloudDeviceComparisonCodeInput,
  cloudDeviceFingerprintInput,
  formatCloudDeviceComparisonCode,
  finishClientHandshake,
  type AccessTicket,
  type RelaySessionGrant,
  type RelaySessionTranscriptTicket,
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
  const ticket = { protocolVersion: OUTBOUND_CONNECTION_PROTOCOL_VERSION, audience: OfficialAudience.ControlPlaneAccess, ticketId: "ticket_a", accountId: "account_a", deviceSessionId: "session_mobile", controlPlaneId: "control_plane_a", bindingId: "binding_a", bindingRevision: 2, targetPublicKeyFingerprint: fingerprint, nonce: "n".repeat(16), trafficClasses: ["interactive"], ownerAccountId: "account_a", accessMode: "owner", accessRoleId: "role_admin", issuedAt: at, expiresAt: at, signature: "s".repeat(32) };
  assert.equal(AccessTicketSchema.safeParse(ticket).success, true);
  assert.equal(AccessTicketSchema.safeParse({ ...ticket, endpoint: "tcp://node:1" }).success, false);

  const attach = { protocolVersion: RELAY_FRAMING_PROTOCOL_VERSION, audience: OfficialAudience.RelayClientAttach, allocationId: "allocation_a", relayId: "relay_a", role: "client", controlPlaneId: "control_plane_a", accountId: "account_a", deviceSessionId: "session_mobile", bindingId: "binding_a", ticketId: "ticket_a", bindingRevision: 2, trafficClass: "interactive", nonce: "n".repeat(16), ownerAccountId: "account_a", accessMode: "owner", accessRoleId: "role_admin", issuedAt: at, expiresAt: at, signature: "s".repeat(32) };
  assert.equal(RelayAttachCapabilitySchema.safeParse(attach).success, true);
  assert.equal(RelayAttachCapabilitySchema.safeParse({ ...attach, audience: OfficialAudience.RelayControlPlaneAttach }).success, false);
  assert.equal(RelayChannelSchema.safeParse({ channelId: "channel_a", allocationId: "allocation_a", controlPlaneId: "control_plane_a", bindingRevision: 2, trafficClass: "interactive", state: "waiting-for-peer", clientAttached: true, controlPlaneAttached: false, leaseExpiresAt: at }).success, true);

  const registration = { protocolVersion: CONTROL_PLANE_REGISTRATION_PROTOCOL_VERSION, audience: OfficialAudience.CoordinatorControl, connectionId: "connection_a", processInstanceId: "process_a", reportedControlPlaneId: "control_plane_a", publicKey: "p".repeat(43), publicKeyFingerprint: fingerprint, epoch: 1, capabilities: ["request", "stream", "websocket"], issuedAt: at, expiresAt: at, signature: "s".repeat(32) };
  assert.equal(OutboundConnectionRegistrationSchema.safeParse(registration).success, true);
  assert.equal(OutboundConnectionRegistrationSchema.safeParse({ ...registration, bindingId: "binding_a" }).success, false);
});

test("shared authority fields are complete and resource-role scoped", () => {
  assert.equal(RESOURCE_SHARING_CLIENT_CAPABILITY, "resource-sharing-v1");
  assert.equal(CONTROL_PLANE_SHARED_ACCESS_CAPABILITY, "shared-access-v1");
  assert.equal(ControlPlaneResourceAccessSchema.safeParse({ kind: "owner" }).success, true);
  assert.equal(ControlPlaneResourceAccessSchema.safeParse({ kind: "shared", shareId: "share_a", revision: 2, role: "role_viewer", expiresAt: at }).success, true);
  assert.equal(ControlPlaneResourceAccessSchema.safeParse({ kind: "shared", shareId: "share_a", revision: 2, role: "viewer", expiresAt: at }).success, false);
  assert.equal(ControlPlaneResourceAccessSchema.safeParse({ kind: "shared", shareId: "share_a", revision: 2, role: "use", expiresAt: at }).success, false);
  assert.equal(NodeResourceAccessSchema.safeParse({ kind: "shared", shareId: "share_a", revision: 2, role: "use", expiresAt: at }).success, true);
  assert.equal(NodeResourceAccessSchema.safeParse({ kind: "shared", shareId: "share_a", revision: 2, role: "role_viewer", expiresAt: at }).success, false);
  assert.equal(NodeResourceAccessSchema.safeParse({ kind: "shared", shareId: "share_a", revision: 2, expiresAt: at }).success, false);

  const ownerTicket = { protocolVersion: OUTBOUND_CONNECTION_PROTOCOL_VERSION, audience: OfficialAudience.ControlPlaneAccess, ticketId: "ticket_owner", accountId: "account_owner", deviceSessionId: "session_a", controlPlaneId: "control_plane_a", bindingId: "binding_a", bindingRevision: 2, targetPublicKeyFingerprint: fingerprint, nonce: "n".repeat(32), trafficClasses: ["interactive"], issuedAt: at, expiresAt: at, signature: "s".repeat(64), ownerAccountId: "account_owner", accessMode: "owner", accessRoleId: "role_admin" };
  const sharedTicket = { ...ownerTicket, ticketId: "ticket_shared", accountId: "account_grantee", accessMode: "shared", shareGrantId: "share_a", shareRevision: 3, accessRoleId: "role_operator" };
  assert.equal(AccessTicketSchema.safeParse(ownerTicket).success, true);
  assert.equal(AccessTicketSchema.safeParse(sharedTicket).success, true);
  assert.equal(AccessTicketSchema.safeParse({ ...ownerTicket, accessRoleId: undefined }).success, false);
  assert.equal(AccessTicketSchema.safeParse({ ...ownerTicket, accessMode: undefined }).success, false);
  assert.equal(AccessTicketSchema.safeParse({ ...ownerTicket, ownerAccountId: undefined }).success, false);
  assert.equal(AccessTicketSchema.safeParse({ ...ownerTicket, accessMode: "shared" }).success, false);
  assert.equal(AccessTicketSchema.safeParse({ ...sharedTicket, shareRevision: undefined }).success, false);
  assert.equal(AccessTicketSchema.safeParse({ ...sharedTicket, accessRoleId: "viewer" }).success, false);
  assert.equal(AccessTicketSchema.safeParse({ ...sharedTicket, shareRole: "use" }).success, false);
  assert.equal(AccessTicketSchema.safeParse({ ...sharedTicket, ownerAccountId: "account_grantee" }).success, false);

  const attach = { protocolVersion: RELAY_FRAMING_PROTOCOL_VERSION, audience: OfficialAudience.RelayClientAttach, allocationId: "allocation_a", relayId: "relay_a", role: "client", controlPlaneId: "control_plane_a", accountId: "account_grantee", deviceSessionId: "session_a", bindingId: "binding_a", ticketId: "ticket_shared", bindingRevision: 2, trafficClass: "interactive", nonce: "n".repeat(16), issuedAt: at, expiresAt: at, signature: "s".repeat(32), ownerAccountId: "account_owner", accessMode: "shared", shareGrantId: "share_a", shareRevision: 3, accessRoleId: "role_operator" };
  assert.equal(RelayAttachCapabilitySchema.safeParse(attach).success, true);
  assert.equal(RelayAttachCapabilitySchema.safeParse({ ...attach, accessRoleId: undefined }).success, false);
  assert.equal(RelayAttachCapabilitySchema.safeParse({ ...attach, accessRoleId: "operator" }).success, false);
  assert.equal(RelayAttachCapabilitySchema.safeParse({ ...attach, shareRole: "use" }).success, false);
  assert.equal(RelayAttachCapabilitySchema.safeParse({ ...attach, shareGrantId: undefined }).success, false);
  assert.equal(RelayAttachCapabilitySchema.safeParse({ ...attach, shareRole: "use" }).success, false);
});

test("node grants and revocations carry complete shared node authority", () => {
  const shared = { ownerAccountId: "account_owner", accessMode: "shared", shareGrantId: "share_node_a", shareRevision: 4, shareRole: "use" };
  const nodeAttach = { protocolVersion: RELAY_FRAMING_PROTOCOL_VERSION, channelKind: "node", audience: OfficialAudience.RelayControlPlaneAttach, allocationId: "allocation_node", relayId: "relay_a", role: "control-plane", controlPlaneId: "control_plane_a", accountId: "account_grantee", bindingId: "binding_a", bindingRevision: 2, nodeHandle: "node_alpha", trafficClass: "interactive", nonce: "n".repeat(16), issuedAt: at, expiresAt: at, signature: "s".repeat(32), ...shared };
  assert.equal(RelayNodeChannelAttachCapabilitySchema.safeParse(nodeAttach).success, true);
  assert.equal(RelayNodeChannelAttachCapabilitySchema.safeParse({ ...nodeAttach, shareRole: "viewer" }).success, false);
  assert.equal(RelayNodeChannelAttachCapabilitySchema.safeParse({ ...nodeAttach, accessRoleId: "role_admin" }).success, false);
  assert.equal(RelayNodeChannelAttachCapabilitySchema.safeParse({ ...nodeAttach, accessMode: undefined }).success, false);

  const claimGrant = { protocolVersion: RELAY_FRAMING_PROTOCOL_VERSION, audience: OfficialAudience.RelayNodeClaimGrant, grantId: "grant_a", allocationId: "allocation_node", nodeHandle: "node_alpha", controlPlaneId: "control_plane_a", accountId: "account_grantee", bindingId: "binding_a", bindingRevision: 2, relayId: "relay_a", relayRegion: "test", relayUrl: "https://relay.example.test", nonce: "n".repeat(16), issuedAt: at, expiresAt: at, controlPlanePublicKey: "p".repeat(43), ...shared };
  assert.equal(NodeRelayClaimGrantPayloadSchema.safeParse(claimGrant).success, true);
  assert.equal(NodeRelayClaimGrantPayloadSchema.safeParse({ ...claimGrant, shareRevision: undefined }).success, false);

  const allocationEvent = { type: "node-relay-allocation", protocolVersion: OUTBOUND_CONNECTION_PROTOCOL_VERSION, allocationId: "allocation_node", relayId: "relay_a", relayRegion: "test", relayUrl: "https://relay.example.test", nodeHandle: "node_alpha", accountId: "account_grantee", controlPlaneId: "control_plane_a", bindingId: "binding_a", bindingRevision: 2, controlPlaneAttach: nodeAttach, expiresAt: at, ...shared };
  assert.equal(NodeRelayAllocationEventSchema.safeParse(allocationEvent).success, true);
  assert.equal(NodeRelayAllocationEventSchema.safeParse({ ...allocationEvent, ownerAccountId: undefined }).success, false);

  const revocation = { protocolVersion: RELAY_FRAMING_PROTOCOL_VERSION, audience: OfficialAudience.RelayRevocation, revocationId: "revocation_share", channelKind: "node", shareGrantId: "share_node_a", shareRevision: 4, accessMode: "shared", shareRole: "use", issuedAt: at, expiresAt: at, signature: "s".repeat(32) };
  assert.equal(RelayRevocationSchema.safeParse(revocation).success, true);
  assert.equal(RelayRevocationSchema.safeParse({ ...revocation, shareRevision: undefined }).success, false);
  assert.equal(RelayRevocationSchema.safeParse({ ...revocation, shareRole: "role_viewer" }).success, false);
  assert.equal(RelayRevocationSchema.safeParse({ ...revocation, accessRoleId: "role_viewer" }).success, false);

  const ownerRevocation = { protocolVersion: RELAY_FRAMING_PROTOCOL_VERSION, audience: OfficialAudience.RelayRevocation, revocationId: "revocation_owner", channelKind: "access", bindingId: "binding_a", ownerAccountId: "account_owner", accessMode: "owner", issuedAt: at, expiresAt: at, signature: "s".repeat(32) };
  assert.equal(RelayRevocationSchema.safeParse(ownerRevocation).success, true);
  assert.equal(RelayRevocationSchema.safeParse({ ...ownerRevocation, ownerAccountId: undefined }).success, false);
  assert.equal(RelayRevocationSchema.safeParse({ ...ownerRevocation, shareGrantId: "share_a", shareRevision: 1 }).success, false);
  assert.equal(RelayRevocationSchema.safeParse({ ...ownerRevocation, channelKind: "node" }).success, false);

  const accessRevocation = { ...revocation, revocationId: "revocation_access", channelKind: "access", shareGrantId: "share_a", shareRole: undefined, accessRoleId: "role_viewer" };
  assert.equal(RelayRevocationSchema.safeParse(accessRevocation).success, true);
  assert.equal(RelayRevocationSchema.safeParse({ ...accessRevocation, accessRoleId: undefined }).success, false);
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
  const ticket: AccessTicket = { protocolVersion: OUTBOUND_CONNECTION_PROTOCOL_VERSION, audience: OfficialAudience.ControlPlaneAccess, ticketId: "ticket_a", accountId: "account_a", deviceSessionId: "session_a", controlPlaneId: "control_plane_a", bindingId: "binding_a", bindingRevision: 2, trafficClasses: ["interactive"], ownerAccountId: "account_a", accessMode: "owner", accessRoleId: "role_admin", nonce: "n".repeat(32), targetPublicKeyFingerprint: fingerprint, issuedAt: at, expiresAt: "2026-08-10T00:05:00.000Z", signature: "s".repeat(64) };
  const client = beginClientHandshake(ticket);
  const accepted = acceptControlPlaneHandshake({ authenticated: { ticket, clientEphemeralPublicKey: client.hello.clientEphemeralPublicKey }, controlPlaneFingerprint: fingerprint, controlPlanePrivateKey: controlPlane.privateKey });
  const clientKey = finishClientHandshake(client.privateState, accepted.response, controlPlane.publicKey);
  assert.deepEqual(clientKey, accepted.sessionKey);
  assert.throws(() => finishClientHandshake({ ...client.privateState, ticket: { ...ticket, bindingRevision: 1 } }, accepted.response, controlPlane.publicKey), { code: "E2E_HANDSHAKE_INVALID" });

  const sharedTicket: AccessTicket = { ...ticket, accountId: "account_grantee", ownerAccountId: "account_owner", accessMode: "shared", shareGrantId: "share_a", shareRevision: 3, accessRoleId: "role_viewer" };
  const sharedClient = beginClientHandshake(sharedTicket);
  const sharedAccepted = acceptControlPlaneHandshake({ authenticated: { ticket: sharedTicket, clientEphemeralPublicKey: sharedClient.hello.clientEphemeralPublicKey }, controlPlaneFingerprint: fingerprint, controlPlanePrivateKey: controlPlane.privateKey });
  assert.deepEqual(finishClientHandshake(sharedClient.privateState, sharedAccepted.response, controlPlane.publicKey), sharedAccepted.sessionKey);
  assert.throws(() => finishClientHandshake({ ...sharedClient.privateState, ticket: { ...sharedTicket, shareRevision: 4 } }, sharedAccepted.response, controlPlane.publicKey), { code: "E2E_HANDSHAKE_INVALID" });
});

test("device auth canonical input binds the full device and access context", () => {
  const sessionAt = "2026-10-26T00:00:00.000Z";
  const expiresAt = "2026-10-26T00:10:00.000Z";
  const ticket: RelaySessionTranscriptTicket = {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    audience: RelaySessionAudience.Transcript,
    transcriptTicketId: "rtt_ticket_a",
    accountId: "account_a",
    deviceSessionId: "device_a",
    controlPlaneId: "control_plane_a",
    bindingId: "binding_a",
    bindingRevision: 2,
    targetPublicKeyFingerprint: fingerprint,
    nonce: "n".repeat(24),
    ownerAccountId: "account_a",
    accessMode: "owner",
    accessRoleId: "role_admin",
    issuedAt: sessionAt,
    expiresAt,
  };
  const grant: RelaySessionGrant = {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    audience: RelaySessionAudience.Grant,
    sessionId: "session_a",
    grantId: "grant_a",
    generation: 1,
    allocationId: "allocation_a",
    accessTicketId: "ticket_a",
    relayId: "relay_a",
    relayRegion: "test",
    relayUrl: "wss://relay.example.test/connect",
    accountId: "account_a",
    deviceSessionId: "device_a",
    controlPlaneId: "control_plane_a",
    bindingId: "binding_a",
    bindingRevision: 2,
    targetPublicKeyFingerprint: fingerprint,
    clientProofPublicKey: "p".repeat(43),
    controlPlaneProofPublicKey: "q".repeat(43),
    trafficClass: "interactive",
    sessionTranscriptTicket: ticket,
    revocationEpoch: 0,
    ownerAccountId: "account_a",
    accessMode: "owner",
    accessRoleId: "role_admin",
    issuedAt: sessionAt,
    expiresAt,
    signature: "s".repeat(86),
  };
  const device = { name: "Alice's phone", kind: "mobile", platform: "ios", version: "1.2.3" };
  const input = { ticket, grant, clientEphemeralPublicKey: "e".repeat(43), device };
  const bindings = cloudDeviceAuthBindings(input);
  assert.deepEqual(bindings, {
    protocolVersion: CLOUD_DEVICE_AUTH_PROTOCOL_VERSION,
    audience: "task-handoff:cloud-device-auth",
    ticketId: "rtt_ticket_a",
    accountId: "account_a",
    deviceSessionId: "device_a",
    controlPlaneId: "control_plane_a",
    bindingId: "binding_a",
    bindingRevision: 2,
    targetPublicKeyFingerprint: fingerprint,
    nonce: "n".repeat(24),
    ownerAccountId: "account_a",
    accessMode: "owner",
    accessRoleId: "role_admin",
    clientProofPublicKey: "p".repeat(43),
    clientEphemeralPublicKey: "e".repeat(43),
    device,
  });
  assert.equal(cloudDeviceAuthBindings({ ...input, device: { ...device, name: "Other name" } }).clientEphemeralPublicKey, "e".repeat(43));
  assert.notEqual(cloudDeviceAuthSigningInput(input), cloudDeviceAuthSigningInput({ ...input, device: { ...device, name: "Other name" } }));
  assert.notEqual(cloudDeviceAuthSigningInput(input), cloudDeviceAuthSigningInput({ ...input, trustRetry: true }));
  assert.match(cloudDeviceAuthSigningInput({ ...input, trustRetry: true }), /"trustRetry":true/);
  assert.throws(() => cloudDeviceAuthBindings({
    ...input,
    grant: { ...grant, targetPublicKeyFingerprint: `sha256:${"z".repeat(43)}` },
  }), { code: "CLOUD_DEVICE_AUTH_INVALID" });

  const sharedTicket: RelaySessionTranscriptTicket = {
    ...ticket,
    accountId: "account_guest",
    ownerAccountId: "account_owner",
    accessMode: "shared",
    shareGrantId: "share_docs",
    shareRevision: 3,
    accessRoleId: "role_operator",
  };
  const sharedGrant: RelaySessionGrant = {
    ...grant,
    accountId: sharedTicket.accountId,
    ownerAccountId: sharedTicket.ownerAccountId,
    accessMode: sharedTicket.accessMode,
    shareGrantId: sharedTicket.shareGrantId,
    shareRevision: sharedTicket.shareRevision,
    accessRoleId: sharedTicket.accessRoleId,
    sessionTranscriptTicket: sharedTicket,
  };
  const sharedInput = { ...input, ticket: sharedTicket, grant: sharedGrant };
  const sharedSigningInput = cloudDeviceAuthSigningInput(sharedInput);
  const tamperedContext = (
    ticketChanges: Partial<RelaySessionTranscriptTicket>,
    grantChanges: Partial<RelaySessionGrant> = {},
  ) => {
    const ticket = { ...sharedTicket, ...ticketChanges };
    return { ticket, grant: { ...sharedGrant, ...grantChanges, sessionTranscriptTicket: ticket } };
  };
  const tamperedContexts: Array<[string, { ticket: RelaySessionTranscriptTicket; grant: RelaySessionGrant }]> = [
    ["device proof key", tamperedContext({}, { clientProofPublicKey: "k".repeat(43) })],
    ["account", tamperedContext({ accountId: "account_other_guest" }, { accountId: "account_other_guest" })],
    ["binding", tamperedContext({ bindingId: "binding_b" }, { bindingId: "binding_b" })],
    ["owner", tamperedContext({ ownerAccountId: "account_other_owner" }, { ownerAccountId: "account_other_owner" })],
    ["share grant", tamperedContext({ shareGrantId: "share_other" }, { shareGrantId: "share_other" })],
    ["share revision", tamperedContext({ shareRevision: 4 }, { shareRevision: 4 })],
    ["cloud role", tamperedContext({ accessRoleId: "role_cloud_admin" }, { accessRoleId: "role_cloud_admin" })],
  ];
  for (const [name, tampered] of tamperedContexts) {
    assert.notEqual(cloudDeviceAuthSigningInput({ ...sharedInput, ...tampered }), sharedSigningInput, `${name} must be signed`);
  }

  const accessTicket: AccessTicket = {
    protocolVersion: OUTBOUND_CONNECTION_PROTOCOL_VERSION,
    audience: OfficialAudience.ControlPlaneAccess,
    ticketId: "rtt_ticket_a",
    accountId: "account_a",
    deviceSessionId: "device_a",
    controlPlaneId: "control_plane_a",
    bindingId: "binding_a",
    bindingRevision: 2,
    trafficClasses: ["interactive"],
    ownerAccountId: "account_a",
    accessMode: "owner",
    accessRoleId: "role_admin",
    nonce: "n".repeat(32),
    targetPublicKeyFingerprint: fingerprint,
    issuedAt: sessionAt,
    expiresAt,
    signature: "s".repeat(64),
  };
  assert.throws(() => cloudDeviceAuthBindings({ ...input, ticket: accessTicket }), { code: "CLOUD_DEVICE_AUTH_UNSUPPORTED_CLIENT" });

  assert.deepEqual(new TextDecoder().decode(cloudDeviceFingerprintInput("p".repeat(43))), "p".repeat(43));
  const comparisonInput = new TextDecoder().decode(cloudDeviceComparisonCodeInput("binding_a", "p".repeat(43)));
  assert.equal(comparisonInput, `task-handoff:cloud-device-sas:v1\0binding_a\0${"p".repeat(43)}`);
  assert.match(formatCloudDeviceComparisonCode(createHash("sha256").update(comparisonInput).digest()), /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
});

test("device auth, trust outcomes and handshake replies reject unsupported wire shapes", () => {
  const device = { name: "Future device", kind: "embedded-client", platform: "harmony.next" };
  assert.equal(CloudDeviceAuthSchema.safeParse({ protocolVersion: CLOUD_DEVICE_AUTH_PROTOCOL_VERSION, device, signature: "s".repeat(86) }).success, true);
  assert.equal(CloudDeviceAuthSchema.safeParse({ protocolVersion: CLOUD_DEVICE_AUTH_PROTOCOL_VERSION, device, signature: "s".repeat(85) }).success, false);
  assert.equal(CloudDeviceAuthSchema.safeParse({ protocolVersion: CLOUD_DEVICE_AUTH_PROTOCOL_VERSION, device, signature: "s".repeat(86), secret: "leak" }).success, false);
  assert.equal(ClientHelloSchema.safeParse({ ticketId: "ticket_a", deviceSessionId: "device_a", clientEphemeralPublicKey: "e".repeat(43) }).success, true);
  assert.equal(ClientHelloSchema.safeParse({ ticketId: "ticket_a", deviceSessionId: "device_a", clientEphemeralPublicKey: "e".repeat(43), trustRetry: true }).success, true);
  assert.equal(ClientHelloSchema.safeParse({ ticketId: "ticket_a", deviceSessionId: "device_a", clientEphemeralPublicKey: "e".repeat(43), trustRetry: false }).success, false);

  const outcome = {
    protocolVersion: CLOUD_DEVICE_AUTH_PROTOCOL_VERSION,
    audience: CLOUD_DEVICE_TRUST_AUDIENCE,
    state: "pending",
    reason: "first-seen",
    requestId: "devtrust_a",
    controlPlaneId: "control_plane_a",
    bindingId: "binding_a",
    ticketId: "rtt_ticket_a",
    accountId: "account_a",
    deviceSessionId: "device_a",
    controlPlanePublicKey: "q".repeat(43),
    device,
    devicePublicKeyFingerprint: fingerprint,
    comparisonCode: "ABCD-EFGH-JKMN-NPQR",
    issuedAt: at,
    expiresAt: "2026-10-26T00:05:00.000Z",
    signature: "s".repeat(86),
  };
  assert.equal(CloudClientHandshakeReplySchema.safeParse(outcome).success, true);
  assert.match(cloudClientTrustOutcomeSigningInput(outcome), /"state":"pending"/);
  assert.doesNotMatch(cloudClientTrustOutcomeSigningInput(outcome), /"signature"/);
  assert.equal(CloudClientHandshakeReplySchema.safeParse({ ...outcome, state: "rejected", reason: "admin-rejected", requestId: undefined }).success, true);
  assert.equal(CloudClientHandshakeReplySchema.safeParse({ ...outcome, state: "rejected", reason: "authorization-stale", requestId: undefined }).success, true);
  assert.equal(CloudClientHandshakeReplySchema.safeParse({ ...outcome, reason: undefined }).success, false);
  assert.equal(CloudClientHandshakeReplySchema.safeParse({ ...outcome, unexpected: true }).success, false);
  assert.equal(CloudClientHandshakeReplySchema.safeParse({
    protocolVersion: CLOUD_DEVICE_AUTH_PROTOCOL_VERSION,
    audience: CLOUD_CLIENT_HANDSHAKE_AUDIENCE,
    state: "accepted",
    controlPlaneId: "control_plane_a",
    bindingId: "binding_a",
    ticketId: "rtt_ticket_a",
    deviceSessionId: "device_a",
    controlPlanePublicKey: "q".repeat(43),
    serverEphemeralPublicKey: "s".repeat(43),
    transcript: "t".repeat(43),
    signature: "v".repeat(86),
  }).success, true);
});
