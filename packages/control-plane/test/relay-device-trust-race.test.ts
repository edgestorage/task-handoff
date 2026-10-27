import assert from "node:assert/strict";
import test from "node:test";
import { decodeRelayFrame, encodeRelayFrame, RELAY_SESSION_PROTOCOL_VERSION, RelaySessionAudience } from "@task-handoff/cloud-contracts";
import { CloudRelayConnector } from "../src/control-plane/cloud-connectivity/relay-connector.ts";
import { cloudClientDevice, cloudRelayIdentity, trustedDeviceSessions } from "./support/cloud-relay-client-auth.ts";

test("a revoke between active observation and registration cannot send a success handshake", { timeout: 2_000 }, async () => {
  const sockets: RaceSocket[] = [];

  class RaceSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = RaceSocket.CONNECTING;
    frames: ReturnType<typeof decodeRelayFrame>[] = [];
    closedReason = "";
    private listeners = new Map<string, ((...args: any[]) => void)[]>();

    constructor() {
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = RaceSocket.OPEN;
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
        channelId: "channel_race",
        generation: message.grant.generation,
        state: "open",
        leaseExpiresAt: message.grant.expiresAt,
      }));
      const handshake = Buffer.from(encodeRelayFrame({
        kind: "handshake",
        sequence: 0,
        payload: Buffer.from(JSON.stringify(hello)),
      }));
      queueMicrotask(() => {
        this.emit("message", attached, false);
        this.emit("message", handshake, true);
      });
    }

    close(code?: number, reason?: string) {
      this.closedReason = reason ?? "";
      this.readyState = RaceSocket.CLOSED;
      queueMicrotask(() => this.emit("close", code, reason));
    }
  }

  const now = Date.now();
  const fingerprint = `sha256:${"a".repeat(43)}`;
  const device = cloudClientDevice();
  const issuedAt = new Date(now - 1_000).toISOString();
  const expiresAt = new Date(now + 14 * 60_000).toISOString();
  const transcriptTicket = {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    audience: RelaySessionAudience.Transcript,
    transcriptTicketId: "transcript_ticket_race",
    accountId: "account_race",
    ownerAccountId: "account_race",
    accessMode: "owner",
    accessRoleId: "role_admin",
    deviceSessionId: "device_race",
    controlPlaneId: "control_plane_race",
    bindingId: "binding_race",
    bindingRevision: 1,
    targetPublicKeyFingerprint: fingerprint,
    nonce: "r".repeat(24),
    issuedAt,
    expiresAt,
  };
  const grant = {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    audience: RelaySessionAudience.Grant,
    sessionId: "session_race",
    grantId: "grant_race",
    generation: 1,
    allocationId: "allocation_race",
    accessTicketId: "access_ticket_race",
    relayId: "relay_race",
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
  let releaseObservation!: () => void;
  let observationStarted!: () => void;
  const observationGate = new Promise<void>((resolve) => { releaseObservation = resolve; });
  const observationEntered = new Promise<void>((resolve) => { observationStarted = resolve; });
  const registry = trustedDeviceSessions();
  const connector = new CloudRelayConnector({
    identity: cloudRelayIdentity({ fingerprint }),
    bridge: { request: async () => ({ status: 200 }) } as any,
    webSocket: RaceSocket as any,
    deviceTrust: {
      async observeClient() {
        observationStarted();
        await observationGate;
        return {
          kind: "active" as const,
          pin: { id: "devpin_race", authorizationRevision: 1 },
          role: { roleIds: ["role_admin"], permissionIds: ["ai-sessions:read"], authorizationRevision: 1 },
        };
      },
    } as any,
    trustedSessions: registry,
    handshakeTimeoutMs: 200,
  });

  const connection = await connector.resume({ relayUrl: grant.relayUrl, grant });
  await observationEntered;
  await registry.closePin("devpin_race", 2, "device-trust-revoked");
  releaseObservation();
  for (let attempt = 0; attempt < 100 && !sockets[0]?.closedReason; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(sockets[0]?.closedReason, "device-trust-state-changed");
  assert.equal(sockets[0]?.frames.some((frame) => frame.kind === "handshake"), false);
  await connection.close("test-done");
});
