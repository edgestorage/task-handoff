import crypto from "node:crypto";
import {
  CLOUD_DEVICE_AUTH_PROTOCOL_VERSION,
  cloudDeviceAuthSigningInput,
  type ClientHello,
  type CloudDeviceDescriptor,
  type RelaySessionGrant,
  type RelaySessionTranscriptTicket,
} from "@task-handoff/cloud-contracts";
import { TrustedDeviceSessionRegistry } from "../../src/control-plane/device-trust/trusted-device-sessions.ts";

const defaultEphemeralPublicKey = "b".repeat(43);

export function cloudClientDevice(kind = "mobile") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyValue = String((publicKey.export({ format: "jwk" }) as { x: string }).x);
  return {
    publicKey: publicKeyValue,
    hello(input: {
      ticket: RelaySessionTranscriptTicket;
      grant: RelaySessionGrant;
      clientEphemeralPublicKey?: string;
      device?: CloudDeviceDescriptor;
      trustRetry?: true;
    }): ClientHello {
      if (input.grant.clientProofPublicKey !== publicKeyValue) {
        throw new Error("The test grant must bind the generated device public key.");
      }
      const clientEphemeralPublicKey = input.clientEphemeralPublicKey ?? defaultEphemeralPublicKey;
      const device = input.device ?? { name: "Test phone", kind, platform: "test", version: "1.0.0" };
      const signingInput = cloudDeviceAuthSigningInput({
        ticket: input.ticket,
        grant: input.grant,
        clientEphemeralPublicKey,
        device,
        trustRetry: input.trustRetry === true,
      });
      return {
        ticketId: input.ticket.transcriptTicketId,
        deviceSessionId: input.ticket.deviceSessionId,
        clientEphemeralPublicKey,
        deviceAuth: {
          protocolVersion: CLOUD_DEVICE_AUTH_PROTOCOL_VERSION,
          device,
          signature: crypto.sign(null, Buffer.from(signingInput), privateKey).toString("base64url"),
        },
        ...(input.trustRetry ? { trustRetry: true as const } : {}),
      };
    },
  };
}

export function activeDeviceTrust(pinId = "devpin_test") {
  return {
    async observeClient() {
      return {
        kind: "active" as const,
        pin: { id: pinId, authorizationRevision: 1 },
        role: { roleIds: ["role_admin"], permissionIds: ["ai-sessions:read"], authorizationRevision: 1 },
      };
    },
  };
}

export function trustedDeviceSessions() {
  return new TrustedDeviceSessionRegistry();
}

export function cloudRelayIdentity(input: { fingerprint: string; publicKey?: string; sessionKey?: Uint8Array }) {
  return {
    acceptCloudAccessHandshake: () => ({
      response: {
        serverEphemeralPublicKey: "c".repeat(43),
        transcript: "transcript",
        signature: "s".repeat(86),
      },
      sessionKey: input.sessionKey ?? new Uint8Array(32),
    }),
    publicIdentity: () => ({ publicKey: input.publicKey ?? "c".repeat(43), fingerprint: input.fingerprint }),
    signCloudClientTrustOutcome: (outcome: Record<string, unknown>) => ({ ...outcome, signature: "s".repeat(86) }),
    signRelayRoleProof: (payload: Record<string, unknown>) => ({ ...payload, signature: "s".repeat(86) }),
  };
}
