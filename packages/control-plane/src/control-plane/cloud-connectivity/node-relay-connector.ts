import WebSocket from "ws";
import type { ControlPlaneIdentityService } from "../identity/service.ts";
import type { NodeRelayFrameSocket } from "../../shared/cloud-relay/node-relay-session.ts";
import { acceptNodeRelayHandshake } from "../../shared/cloud-relay/node-relay-session.ts";
import { trustedRelayUrl } from "./relay-connector.ts";
import { observeRelaySocketErrors } from "./relay-socket.ts";

const DEFAULT_ATTACH_TIMEOUT_MS = 15_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

export type VerifiedNodeRelayAllocation = {
  allocationId: string;
  relayUrl: string;
  epoch: number;
  channelKind: "node";
  attach: Record<string, any>;
  event: Record<string, any>;
  nodeHandle: string;
  nodeId?: string;
  nodePublicKeyFingerprint: string;
  displayName?: string;
};

export type ConnectedNodeRelayChannel = {
  socket: NodeRelayFrameSocket;
  key: Uint8Array;
  nodeId: string;
  paired: boolean;
  issuedPairing?: { keyId: string; secret: string };
  allocationId: string;
  channelId?: string;
};

/**
 * Dials the Relay for one pushed node allocation, attaches as the
 * `control-plane` peer, and completes the end-to-end handshake with the node.
 * The Relay learns nothing beyond the fixed frame headers; the pairing secret
 * (first claim) is sealed inside the handshake accept.
 */
export class CloudNodeRelayConnector {
  private readonly options: { identity: ControlPlaneIdentityService; webSocket?: typeof WebSocket; attachTimeoutMs?: number; handshakeTimeoutMs?: number };
  constructor(options: { identity: ControlPlaneIdentityService; webSocket?: typeof WebSocket; attachTimeoutMs?: number; handshakeTimeoutMs?: number }) {
    this.options = options;
  }

  async connect(input: {
    allocation: VerifiedNodeRelayAllocation;
    serviceOrigin: string;
    pairing?: { keyId: string; secret: string };
    createPairing(): { keyId: string; secret: string };
  }): Promise<ConnectedNodeRelayChannel> {
    const allocation = input.allocation;
    const relayUrl = new URL(allocation.relayUrl);
    if (!trustedRelayUrl(relayUrl, input.serviceOrigin)) throw channelError("UNTRUSTED_RELAY_URL");
    const attach = input.allocation.attach;
    const event = input.allocation.event;
    const Socket = this.options.webSocket ?? WebSocket;
    const socket = new Socket(relayUrl.href, { followRedirects: false, handshakeTimeout: 10_000, perMessageDeflate: false });
    observeRelaySocketErrors(socket);
    const attachTimeoutMs = positiveDuration(this.options.attachTimeoutMs, DEFAULT_ATTACH_TIMEOUT_MS);
    const handshakeTimeoutMs = positiveDuration(this.options.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS);
    try {
      await socketOpen(socket, attachTimeoutMs);
      socket.send(JSON.stringify({ type: "attach", capability: attach }));
      const attached = await socketMessage(socket, (value) => value?.type === "attached", attachTimeoutMs);
      const accepted = await acceptNodeRelayHandshake({
        socket: socket as unknown as NodeRelayFrameSocket,
        identity: {
          controlPlaneId: event.controlPlaneId,
          publicKey: this.options.identity.publicIdentity().publicKey,
          signNodeRelayHandshake: (signingInput) => this.options.identity.signNodeRelayHandshake(signingInput),
        },
        expectation: {
          allocationId: event.allocationId,
          relayId: event.relayId,
          nodeHandle: event.nodeHandle,
          controlPlaneId: event.controlPlaneId,
          accountId: attach.accountId,
          bindingId: event.bindingId,
          bindingRevision: event.bindingRevision,
          nodePublicKeyFingerprint: allocation.nodePublicKeyFingerprint,
        },
        ...(input.pairing ? { pairing: input.pairing } : {}),
        createPairing: input.createPairing,
        timeoutMs: handshakeTimeoutMs,
      });
      return {
        socket: socket as unknown as NodeRelayFrameSocket,
        key: accepted.key,
        nodeId: accepted.init.nodeId,
        paired: accepted.paired,
        ...(accepted.issuedPairing ? { issuedPairing: accepted.issuedPairing } : {}),
        allocationId: allocation.allocationId,
        channelId: typeof attached.channelId === "string" ? attached.channelId : undefined,
      };
    } catch (error) {
      try { if (socket.readyState < WebSocket.CLOSING) socket.close(4400, "node-relay-handshake-failed"); } catch { /* already gone */ }
      throw error;
    }
  }
}

function socketOpen(socket: WebSocket, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onOpen = () => { if (settled) return; cleanup(); resolve(); };
    const onError = (error: Error) => { if (settled) return; cleanup(); reject(error); };
    const onClose = () => { if (settled) return; cleanup(); reject(channelError("NODE_RELAY_SOCKET_CLOSED")); };
    const timer = setTimeout(() => { if (settled) return; cleanup(); reject(channelError("NODE_RELAY_ATTACH_TIMEOUT")); }, timeoutMs);
    timer.unref?.();
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function socketMessage(socket: WebSocket, predicate: (value: any) => boolean, timeoutMs: number) {
  return new Promise<any>((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const value = JSON.parse(raw.toString());
        if (predicate(value)) { cleanup(); resolve(value); }
      } catch (error) { cleanup(); reject(error); }
    };
    const onClose = () => { cleanup(); reject(channelError("NODE_RELAY_SOCKET_CLOSED")); };
    const cleanup = () => { clearTimeout(timer); socket.off("message", onMessage); socket.off("close", onClose); };
    const timer = setTimeout(() => { cleanup(); reject(channelError("NODE_RELAY_ATTACH_TIMEOUT")); }, timeoutMs);
    timer.unref?.();
    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

function channelError(code: string) {
  return Object.assign(new Error("Cloud relay node channel is unavailable."), { code, retryable: true });
}

function positiveDuration(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
