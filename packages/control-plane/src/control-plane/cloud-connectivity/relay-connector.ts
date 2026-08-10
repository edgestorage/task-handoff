import WebSocket from "ws";
import nacl from "tweetnacl";
import { AccessTicketSchema, RelayAttachCapabilitySchema } from "@task-handoff/cloud-contracts";
import type { ControlPlaneActor } from "../auth/authorization.ts";
import type { ControlPlaneIdentityService } from "../identity/service.ts";

type RelayEnvelope = { type: string; id?: string; status?: number; body?: any; event?: unknown; streamId?: string; data?: unknown; pendingEscape?: unknown; cols?: unknown; rows?: unknown; code?: number | null; signal?: string | null };
export type RelaySessionBridge = {
  request(actor: ControlPlaneActor, input: { path: string; method: string; headers: Record<string, string>; body?: unknown }): Promise<{ status: number; body: unknown }>;
  subscribe(actor: ControlPlaneActor, topics: string[], listener: (event: unknown) => void): () => void;
  openTty?(actor: ControlPlaneActor, input: { instanceId: string; sessionId: string }, listener: (message: RelayEnvelope) => void): Promise<{ send(data: string): void; resize(cols: number, rows: number): void; close(): void }>;
};

export function verifyCoordinatorRelayAllocation(raw: unknown, state: { snapshot(): any }) {
  const event = raw as any;
  const attach = RelayAttachCapabilitySchema.parse(event?.attach);
  const ticket = AccessTicketSchema.parse(event?.ticket);
  const current = state.snapshot();
  const relayUrl = new URL(String(event?.relayUrl));
  if (event?.type !== "relay-allocation" || event?.allocationId !== attach.allocationId || attach.role !== "control-plane" ||
      attach.ticketId !== ticket.ticketId || attach.controlPlaneId !== ticket.controlPlaneId || attach.accountId !== ticket.accountId ||
      attach.deviceSessionId !== ticket.deviceSessionId || attach.bindingId !== ticket.bindingId || attach.bindingRevision !== ticket.bindingRevision ||
      current.status !== "active" || !current.remoteAccessEnabled || current.identity.controlPlaneId !== ticket.controlPlaneId ||
      current.accountId !== ticket.accountId || current.bindingId !== ticket.bindingId || current.bindingRevision !== ticket.bindingRevision ||
      ticket.targetPublicKeyFingerprint !== current.identity.fingerprint || Date.parse(attach.expiresAt) <= Date.now()) throw relayError("RELAY_ALLOCATION_AUTHORITY_INVALID");
  if (!trustedRelayUrl(relayUrl, current.serviceOrigin)) throw relayError("UNTRUSTED_RELAY_URL");
  return { allocationId: attach.allocationId, relayUrl: relayUrl.href, epoch: Date.parse(attach.issuedAt), attach, ticket };
}

export class CloudRelayConnector {
  private readonly options: { identity: ControlPlaneIdentityService; bridge: RelaySessionBridge; webSocket?: typeof WebSocket };
  constructor(options: { identity: ControlPlaneIdentityService; bridge: RelaySessionBridge; webSocket?: typeof WebSocket }) { this.options = options; }

  async connect(input: Record<string, any>) {
    const allocation = input.allocation as any;
    const attach = RelayAttachCapabilitySchema.parse(allocation.attach);
    const ticket = AccessTicketSchema.parse(allocation.ticket);
    const Socket = this.options.webSocket ?? WebSocket;
    const socket = new Socket(input.relayUrl, { followRedirects: false, handshakeTimeout: 10_000, perMessageDeflate: false });
    await socketOpen(socket);
    socket.send(JSON.stringify({ type: "attach", capability: attach }));
    const attached = await socketMessage(socket, (value) => value?.type === "attached");
    return establishEncryptedSession(socket, attached.channelId, ticket, this.options.identity, this.options.bridge);
  }
}

async function establishEncryptedSession(socket: WebSocket, channelId: string, ticket: any, identity: ControlPlaneIdentityService, bridge: RelaySessionBridge) {
  const handshake = await socketMessage(socket, (value) => value?.type === "frame" && value.frame?.kind === "handshake");
  if (handshake.frame.channelId !== channelId || handshake.frame.sequence !== 0) throw relayError("RELAY_HANDSHAKE_SEQUENCE_INVALID");
  const hello = JSON.parse(Buffer.from(handshake.frame.ciphertext, "base64url").toString("utf8"));
  const accepted = identity.acceptCloudAccessHandshake(ticket, hello);
  const response = { ...accepted.response, controlPlanePublicKey: identity.publicIdentity().publicKey };
  socket.send(JSON.stringify({ type: "frame", frame: { protocolVersion: "2026-08-10", channelId, sequence: 0, kind: "handshake", ciphertext: Buffer.from(JSON.stringify(response)).toString("base64url") } }));
  const actor: ControlPlaneActor = { type: "cloud-account", accountId: ticket.accountId, deviceSessionId: ticket.deviceSessionId, bindingId: ticket.bindingId, bindingRevision: ticket.bindingRevision };
  const session = new EncryptedControlPlaneRelaySession(socket, channelId, accepted.sessionKey, actor, bridge);
  session.start();
  return { close: (reason = "normal") => session.close(reason) };
}

class EncryptedControlPlaneRelaySession {
  private receiveSequence = 1;
  private sendSequence = 1;
  private receiveCounter = 0;
  private sendCounter = 0;
  private unsubscribe?: () => void;
  private readonly ttys = new Map<string, { send(data: string): void; resize(cols: number, rows: number): void; close(): void }>();
  private readonly socket: WebSocket;
  private readonly channelId: string;
  private readonly key: Uint8Array;
  private readonly actor: ControlPlaneActor;
  private readonly bridge: RelaySessionBridge;
  constructor(socket: WebSocket, channelId: string, key: Uint8Array, actor: ControlPlaneActor, bridge: RelaySessionBridge) { this.socket = socket; this.channelId = channelId; this.key = key; this.actor = actor; this.bridge = bridge; }
  start() {
    this.socket.on("message", (raw) => { void this.receive(raw).catch(() => this.socket.close(4400, "encrypted-protocol-error")); });
    this.socket.once("close", () => { this.unsubscribe?.(); for (const tty of this.ttys.values()) tty.close(); this.ttys.clear(); });
  }
  async close(reason: string) { this.unsubscribe?.(); for (const tty of this.ttys.values()) tty.close(); this.ttys.clear(); if (this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, reason.slice(0, 120)); }
  private async receive(raw: WebSocket.RawData) {
    const message = JSON.parse(raw.toString()); const frame = message?.frame;
    if (message?.type !== "frame" || frame?.channelId !== this.channelId || frame.sequence !== this.receiveSequence++) throw relayError("RELAY_FRAME_SEQUENCE_INVALID");
    const opened = nacl.secretbox.open(Buffer.from(frame.ciphertext, "base64url"), nonce(1, this.receiveCounter++), this.key);
    if (!opened) throw relayError("RELAY_E2E_DECRYPT_FAILED");
    const envelope = JSON.parse(Buffer.from(opened).toString("utf8"));
    await this.dispatch(envelope);
  }
  private async dispatch(value: RelayEnvelope) {
    if (value.type === "request" && value.id) {
      try { const result = await this.bridge.request(this.actor, value.body); this.send({ type: "response", id: value.id, status: result.status, body: result.body }); }
      catch (error) { this.send({ type: "response", id: value.id, status: Number((error as any)?.statusCode) || 500, body: { error: { code: (error as any)?.code ?? "CONTROL_PLANE_ERROR", message: "Control Plane request failed." } } }); }
      return;
    }
    if (value.type === "event-subscribe") { this.unsubscribe?.(); const topics = Array.isArray(value.body?.topics) ? value.body.topics.map(String) : ["*"]; this.unsubscribe = this.bridge.subscribe(this.actor, topics, (event) => this.send({ type: "event", event })); return; }
    if (value.type === "tty-open" && value.streamId && this.bridge.openTty) { const streamId = value.streamId; const tty = await this.bridge.openTty(this.actor, value.body, (event) => this.send({ ...event, streamId })); this.ttys.set(streamId, tty); this.send({ type: "tty-opened", streamId }); return; }
    const tty = value.streamId ? this.ttys.get(value.streamId) : undefined;
    if (tty && value.type === "tty-input") return tty.send(String(value.data ?? ""));
    if (tty && value.type === "tty-resize") return tty.resize(Number(value.body?.cols), Number(value.body?.rows));
    if (tty && value.type === "tty-close") { tty.close(); this.ttys.delete(value.streamId!); this.send({ type: "tty-closed", streamId: value.streamId }); return; }
    if (value.type !== "cancel") throw relayError("RELAY_ENVELOPE_UNSUPPORTED");
  }
  private send(value: RelayEnvelope) {
    if (this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 2 * 1024 * 1024) throw relayError("RELAY_BACKPRESSURE_LIMIT");
    const sealed = nacl.secretbox(Buffer.from(JSON.stringify(value)), nonce(2, this.sendCounter++), this.key);
    this.socket.send(JSON.stringify({ type: "frame", frame: { protocolVersion: "2026-08-10", channelId: this.channelId, sequence: this.sendSequence++, kind: value.type === "cancel" ? "cancel" : "data", ciphertext: Buffer.from(sealed).toString("base64url") } }));
  }
}

function trustedRelayUrl(url: URL, serviceOrigin: string) {
  if (url.protocol !== "wss:") return false;
  if (url.hostname === "relay.thandoff.com" || url.hostname.endsWith(".relay.thandoff.com")) return true;
  const service = new URL(serviceOrigin);
  return service.hostname !== "cloud.thandoff.com" && url.hostname === service.hostname;
}
function socketOpen(socket: WebSocket) { return new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); socket.once("close", () => reject(relayError("RELAY_SOCKET_CLOSED"))); }); }
function socketMessage(socket: WebSocket, predicate: (value: any) => boolean) { return new Promise<any>((resolve, reject) => { const onMessage = (raw: WebSocket.RawData) => { try { const value = JSON.parse(raw.toString()); if (predicate(value)) { cleanup(); resolve(value); } } catch (error) { cleanup(); reject(error); } }; const onClose = () => { cleanup(); reject(relayError("RELAY_SOCKET_CLOSED")); }; const cleanup = () => { socket.off("message", onMessage); socket.off("close", onClose); }; socket.on("message", onMessage); socket.once("close", onClose); }); }
function nonce(direction: number, counter: number) { const value = new Uint8Array(24); value[0] = direction; new DataView(value.buffer).setBigUint64(16, BigInt(counter), false); return value; }
function relayError(code: string) { return Object.assign(new Error("Cloud Relay session is invalid."), { code, retryable: true }); }
