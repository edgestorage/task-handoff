import { createHash, createPublicKey, verify } from "node:crypto";
import {
  AccessTicketSchema,
  ClientHelloSchema,
  RelaySessionGrantSchema,
  RelaySessionTranscriptTicketSchema,
  cloudDeviceAuthBindings,
  cloudDeviceAuthSigningInput,
  cloudDeviceComparisonCodeInput,
  cloudDeviceFingerprintInput,
  formatCloudDeviceComparisonCode,
  type CloudDeviceDescriptor,
  type RelaySessionGrant,
  type RelaySessionTranscriptTicket,
} from "@task-handoff/cloud-contracts";
import type { CloudDeviceAccessContext } from "../device-trust/access-context.ts";

export type CloudClientAuthContext = {
  ticket: RelaySessionTranscriptTicket;
  grant: RelaySessionGrant;
  device: CloudDeviceDescriptor;
  devicePublicKey: string;
  deviceFingerprint: string;
  comparisonCode: string;
  accessContext: CloudDeviceAccessContext;
  trustRetry: boolean;
};

export class CloudClientAuthenticationError extends Error {
  readonly code: string;
  readonly trustRequired: "unsupported-client" | undefined;

  constructor(code: string, message: string, trustRequired?: "unsupported-client") {
    super(message);
    this.name = "CloudClientAuthenticationError";
    this.code = code;
    this.trustRequired = trustRequired;
  }
}

/**
 * The only Control Plane device-authentication path. Connector allocation
 * validation proves the grant came from the Coordinator; this function proves
 * the connecting client holds the installation key the grant names.
 */
export function authenticateCloudClient(input: {
  ticket: unknown;
  grant: unknown;
  clientHello: unknown;
  controlPlaneFingerprint: string;
  now?: number;
}): CloudClientAuthContext {
  const now = input.now ?? Date.now();
  // Compatibility for the Stage A rollout: clients still presenting the old
  // one-time access ticket cannot bind a device key. Give them the explicit
  // unsupported outcome rather than treating a malformed transcript as trust.
  const legacyTicket = AccessTicketSchema.safeParse(input.ticket);
  if (legacyTicket.success && legacyTicket.data.clientProofPublicKey === undefined) {
    throw new CloudClientAuthenticationError("CLOUD_DEVICE_AUTH_UNSUPPORTED_CLIENT", "The access ticket does not bind a device proof key.", "unsupported-client");
  }
  const ticket = RelaySessionTranscriptTicketSchema.parse(input.ticket);
  const grant = RelaySessionGrantSchema.parse(input.grant);
  const hello = ClientHelloSchema.parse(input.clientHello);
  if (hello.ticketId !== ticket.transcriptTicketId || hello.deviceSessionId !== ticket.deviceSessionId) {
    throw new CloudClientAuthenticationError("CLOUD_DEVICE_AUTH_INVALID", "The signed hello does not belong to this grant.");
  }
  if (ticket.targetPublicKeyFingerprint !== input.controlPlaneFingerprint || grant.targetPublicKeyFingerprint !== input.controlPlaneFingerprint) {
    throw new CloudClientAuthenticationError("CLOUD_DEVICE_AUTH_INVALID", "The grant targets a different Control Plane identity.");
  }
  if (Date.parse(ticket.expiresAt) <= now || Date.parse(grant.expiresAt) <= now) {
    throw new CloudClientAuthenticationError("CLOUD_DEVICE_AUTH_INVALID", "The grant has expired.");
  }
  if (!ticket.accessMode || !ticket.ownerAccountId || !ticket.accessRoleId) {
    throw new CloudClientAuthenticationError("CLOUD_DEVICE_AUTH_INVALID", "The grant does not carry a complete access context.");
  }
  if (!hello.deviceAuth) {
    throw new CloudClientAuthenticationError("CLOUD_DEVICE_AUTH_UNSUPPORTED_CLIENT", "The client did not provide device authentication.", "unsupported-client");
  }
  const devicePublicKey = grant.clientProofPublicKey;
  const signingInput = cloudDeviceAuthSigningInput({
    ticket,
    grant,
    clientEphemeralPublicKey: hello.clientEphemeralPublicKey,
    device: hello.deviceAuth.device,
    trustRetry: hello.trustRetry === true,
  });
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: devicePublicKey }, format: "jwk" });
  if (!verify(null, Buffer.from(signingInput), publicKey, Buffer.from(hello.deviceAuth.signature, "base64url"))) {
    throw new CloudClientAuthenticationError("CLOUD_DEVICE_AUTH_INVALID", "The device authentication signature is invalid.");
  }
  const deviceFingerprint = fingerprintDevicePublicKey(devicePublicKey);
  return {
    ticket,
    grant,
    device: hello.deviceAuth.device,
    devicePublicKey,
    deviceFingerprint,
    comparisonCode: deviceComparisonCode(ticket.bindingId, devicePublicKey),
    trustRetry: hello.trustRetry === true,
    accessContext: {
      bindingId: ticket.bindingId,
      accountId: ticket.accountId,
      ownerAccountId: ticket.ownerAccountId,
      accessMode: ticket.accessMode,
      ...(ticket.shareGrantId === undefined ? {} : { shareGrantId: ticket.shareGrantId }),
      cloudAccessRoleId: ticket.accessRoleId,
      devicePublicKey,
    },
  };
}

export function fingerprintDevicePublicKey(publicKey: string): string {
  return `sha256:${createHash("sha256").update(cloudDeviceFingerprintInput(publicKey)).digest("base64url")}`;
}

export function deviceComparisonCode(bindingId: string, publicKey: string): string {
  const digest = createHash("sha256").update(cloudDeviceComparisonCodeInput(bindingId, publicKey)).digest();
  return formatCloudDeviceComparisonCode(digest);
}
