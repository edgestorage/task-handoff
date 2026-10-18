import WebSocket from "ws";
import type { ControlPlaneIdentityService } from "../identity/service.ts";
import type { NodeRelayFrameSocket } from "../../shared/cloud-relay/node-relay-session.ts";
import { acceptNodeRelayHandshake } from "../../shared/cloud-relay/node-relay-session.ts";
import { trustedRelayUrl } from "./relay-connector.ts";

export type VerifiedNodeRelayAllocation = {
  allocationId: string;
  relayUrl: string;
  epoch: number;
  channelKind: "node";
  attach: Record<string, any>;
  event: Record<string, any>;
  nodeHandle: string;
  nodePublicKeyFingerprint: string;
  displayName?: string;
};

export type ConnectedNodeRelayChannel = {
  socket: NodeRelayFrameSocket;
  key: Uint8Array;
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
  private readonly options: { identity: ControlPlaneIdentityService; webSocket?: typeof WebSocket };
  constructor(options: { identity: ControlPlaneIdentityService; webSocket?: typeof WebSocket }) {
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
    try {
      await socketOpen(socket);
      socket.send(JSON.stringify({ type: "attach", capability: attach }));
      const attached = await socketMessage(socket, (value) => value?.type === "attached");
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
      });
      return {
        socket: socket as unknown as NodeRelayFrameSocket,
        key: accepted.key,
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

function socketOpen(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("close", () => reject(channelError("NODE_RELAY_SOCKET_CLOSED")));
  });
}

function socketMessage(socket: WebSocket, predicate: (value: any) => boolean) {
  return new Promise<any>((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const value = JSON.parse(raw.toString());
        if (predicate(value)) { cleanup(); resolve(value); }
      } catch (error) { cleanup(); reject(error); }
    };
    const onClose = () => { cleanup(); reject(channelError("NODE_RELAY_SOCKET_CLOSED")); };
    const cleanup = () => { socket.off("message", onMessage); socket.off("close", onClose); };
    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

function channelError(code: string) {
  return Object.assign(new Error("Cloud relay node channel is unavailable."), { code, retryable: true });
}
