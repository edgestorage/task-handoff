import assert from "node:assert/strict";
import test from "node:test";
import { decodeRelayFrame, encodeRelayFrame, RELAY_SESSION_PROTOCOL_VERSION, RelaySessionAudience, type RelayFramePayload } from "@task-handoff/cloud-contracts";
import { CloudRelayConnector } from "../src/control-plane/cloud-connectivity/relay-connector.ts";

test("relay resume does not drop a handshake coalesced with the attach acknowledgement", { timeout: 2_000 }, async () => {
  const sockets: CoalescedSocket[] = [];
  let disconnected = false;

  class CoalescedSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = CoalescedSocket.CONNECTING;
    frames: RelayFramePayload[] = [];
    private listeners = new Map<string, ((...args: any[]) => void)[]>();

    constructor(_url: string) {
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = CoalescedSocket.OPEN;
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
        channelId: "channel_coalesced",
        generation: message.grant.generation,
        state: "open",
        leaseExpiresAt: message.grant.expiresAt,
      }));
      const handshake = Buffer.from(encodeRelayFrame({
        kind: "handshake",
        sequence: 0,
        payload: Buffer.from(JSON.stringify({
          ticketId: message.grant.sessionTranscriptTicket.transcriptTicketId,
          deviceSessionId: message.grant.sessionTranscriptTicket.deviceSessionId,
          clientEphemeralPublicKey: "b".repeat(43),
        })),
      }));
      queueMicrotask(() => {
        this.emit("message", attached, false);
        this.emit("message", handshake, true);
      });
    }

    close(code?: number, reason?: string) {
      this.readyState = CoalescedSocket.CLOSED;
      queueMicrotask(() => this.emit("close", code, reason));
    }
  }

  const now = Date.now();
  const fingerprint = `sha256:${"a".repeat(43)}`;
  const issuedAt = new Date(now - 1_000).toISOString();
  const expiresAt = new Date(now + 14 * 60_000).toISOString();
  const transcriptTicket = {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    audience: RelaySessionAudience.Transcript,
    transcriptTicketId: "transcript_ticket_coalesced",
    accountId: "account_coalesced",
    ownerAccountId: "account_coalesced",
    accessMode: "owner",
    accessRoleId: "role_admin",
    deviceSessionId: "device_coalesced",
    controlPlaneId: "control_plane_coalesced",
    bindingId: "binding_coalesced",
    bindingRevision: 1,
    targetPublicKeyFingerprint: fingerprint,
    nonce: "t".repeat(24),
    issuedAt,
    expiresAt,
  };
  const grant = {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    audience: RelaySessionAudience.Grant,
    sessionId: "session_coalesced",
    grantId: "grant_coalesced",
    generation: 1,
    allocationId: "allocation_coalesced",
    accessTicketId: "access_ticket_coalesced",
    relayId: "relay_coalesced",
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
    clientProofPublicKey: "b".repeat(43),
    controlPlaneProofPublicKey: "c".repeat(43),
    trafficClass: "interactive",
    sessionTranscriptTicket: transcriptTicket,
    revocationEpoch: 0,
    issuedAt,
    expiresAt,
    signature: "s".repeat(86),
  };
  const connector = new CloudRelayConnector({
    identity: {
      acceptCloudAccessHandshake: () => ({ response: {}, transcript: "transcript", signature: "s".repeat(32) }),
      publicIdentity: () => ({ publicKey: "c".repeat(43) }),
      signRelayRoleProof: (payload: Record<string, unknown>) => ({ ...payload, signature: "s".repeat(86) }),
    },
    bridge: { request: async () => ({ status: 200 }) } as any,
    webSocket: CoalescedSocket as any,
    resolveAccessRole: async () => ({ roleIds: ["role_admin"], permissionIds: ["ai-sessions:read"], authorizationRevision: 1 }),
    handshakeTimeoutMs: 100,
  });

  const connection = await connector.resume({
    relayUrl: grant.relayUrl,
    grant,
    onDisconnected: () => { disconnected = true; },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(disconnected, false);
  assert.ok(sockets[0]?.frames.some((frame) => frame.kind === "handshake"), "the handshake response must be sent");
  await connection.close("test-done");
});
