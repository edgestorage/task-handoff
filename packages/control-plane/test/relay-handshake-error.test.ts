import assert from "node:assert/strict";
import test from "node:test";
import { RELAY_SESSION_PROTOCOL_VERSION, RelaySessionAudience, decodeRelayFrame, encodeRelayFrame, type RelayFramePayload } from "@task-handoff/cloud-contracts";
import { CloudRelayConnector } from "../src/control-plane/cloud-connectivity/relay-connector.ts";
import { cloudClientDevice, cloudRelayIdentity, trustedDeviceSessions } from "./support/cloud-relay-client-auth.ts";

test("relay handshake failures are reported with bounded channel identity", { timeout: 2_000 }, async () => {
  const now = Date.now();
  const fingerprint = `sha256:${"a".repeat(43)}`;
  const device = cloudClientDevice();
  const issuedAt = new Date(now - 1_000).toISOString();
  const expiresAt = new Date(now + 14 * 60_000).toISOString();
  const transcriptTicket = {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    audience: RelaySessionAudience.Transcript,
    transcriptTicketId: "transcript_ticket_handshake_error",
    accountId: "account_handshake_error",
    ownerAccountId: "account_handshake_error",
    accessMode: "owner" as const,
    accessRoleId: "role_admin",
    deviceSessionId: "device_handshake_error",
    controlPlaneId: "control_plane_handshake_error",
    bindingId: "binding_handshake_error",
    bindingRevision: 1,
    targetPublicKeyFingerprint: fingerprint,
    nonce: "t".repeat(24),
    issuedAt,
    expiresAt,
  };
  const grant = {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    audience: RelaySessionAudience.Grant,
    sessionId: "session_handshake_error",
    grantId: "grant_handshake_error",
    generation: 1,
    allocationId: "allocation_handshake_error",
    accessTicketId: "access_ticket_handshake_error",
    relayId: "relay_handshake_error",
    relayRegion: "test",
    relayUrl: "ws://localhost:8080/connect",
    accountId: transcriptTicket.accountId,
    ownerAccountId: transcriptTicket.ownerAccountId,
    accessMode: transcriptTicket.accessMode,
    accessRoleId: transcriptTicket.accessRoleId,
    deviceSessionId: transcriptTicket.deviceSessionId,
    controlPlaneId: transcriptTicket.controlPlaneId,
    bindingId: transcriptTicket.bindingId,
    bindingRevision: transcriptTicket.bindingRevision,
    targetPublicKeyFingerprint: fingerprint,
    clientProofPublicKey: device.publicKey,
    controlPlaneProofPublicKey: "c".repeat(43),
    trafficClass: "interactive",
    sessionTranscriptTicket: transcriptTicket,
    revocationEpoch: 0,
    issuedAt,
    expiresAt,
    signature: "s".repeat(86),
  };
  const hello = device.hello({ ticket: transcriptTicket, grant });
  hello.deviceAuth.signature = "A".repeat(86);

  class HandshakeErrorSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = HandshakeErrorSocket.CONNECTING;
    frames: RelayFramePayload[] = [];
    closedReason?: string;
    private listeners = new Map<string, ((...args: any[]) => void)[]>();

    constructor(_url: string) {
      queueMicrotask(() => {
        this.readyState = HandshakeErrorSocket.OPEN;
        this.emit("open");
      });
    }

    on(event: string, listener: (...args: any[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }

    once(event: string, listener: (...args: any[]) => void) {
      const wrapper = (...args: any[]) => {
        this.off(event, wrapper);
        listener(...args);
      };
      this.on(event, wrapper);
    }

    off(event: string, listener: (...args: any[]) => void) {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener));
    }

    emit(event: string, ...args: any[]) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }

    send(data: string | Uint8Array) {
      if (typeof data !== "string") {
        this.frames.push(decodeRelayFrame(data));
        return;
      }
      const message = JSON.parse(data);
      if (message.type !== "session-attach") return;
      const attached = Buffer.from(JSON.stringify({
        type: "attached",
        role: "control-plane",
        sessionId: message.grant.sessionId,
        allocationId: message.grant.allocationId,
        channelId: "channel_handshake_error",
        generation: message.grant.generation,
        state: "open",
        leaseExpiresAt: message.grant.expiresAt,
      }));
      const handshake = Buffer.from(encodeRelayFrame({ kind: "handshake", sequence: 0, payload: Buffer.from(JSON.stringify(hello)) }));
      queueMicrotask(() => {
        this.emit("message", attached, false);
        this.emit("message", handshake, true);
      });
    }

    close(_code?: number, reason?: string) {
      this.closedReason = reason;
      this.readyState = HandshakeErrorSocket.CLOSED;
      queueMicrotask(() => this.emit("close"));
    }
  }

  let reported: { error: unknown; context: { allocationId: string; controlPlaneId: string; bindingId: string; deviceSessionId: string } } | undefined;
  const reportedPromise = new Promise<void>((resolve) => {
    const connector = new CloudRelayConnector({
      identity: cloudRelayIdentity({ fingerprint }),
      bridge: { request: async () => ({ status: 200 }) } as any,
      deviceTrust: { observeClient: async () => { throw new Error("unexpected trust observation"); } } as any,
      trustedSessions: trustedDeviceSessions(),
      webSocket: HandshakeErrorSocket as any,
      handshakeTimeoutMs: 200,
      onHandshakeError: (error, context) => {
        reported = { error, context };
        resolve();
      },
    });
    void connector.resume({ relayUrl: grant.relayUrl, grant });
  });
  await reportedPromise;

  assert.equal((reported?.error as { code?: string }).code, "CLOUD_DEVICE_AUTH_INVALID");
  assert.deepEqual(reported?.context, {
    allocationId: grant.allocationId,
    controlPlaneId: grant.controlPlaneId,
    bindingId: grant.bindingId,
    deviceSessionId: grant.deviceSessionId,
  });
});
