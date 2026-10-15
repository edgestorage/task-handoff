import WebSocket from "ws";
import nacl from "tweetnacl";
import { AccessTicketSchema, RelayAttachCapabilitySchema } from "@task-handoff/cloud-contracts";
import { COMPACT_EVENT_ENVELOPE_VERSION, AiSessionTransientSubscriptionSchema, type AiSessionTransientSubscription, type EventEnvelope } from "@task-handoff/protocol/events";
import type { ControlPlaneActor } from "../auth/authorization.ts";
import type { ControlPlaneIdentityService } from "../identity/service.ts";
import { projectCompactPublicEvent } from "../events/bus.ts";
import type { RelayTraceRecorder } from "./relay-trace.ts";
import { cloudEnvironmentForServiceOrigin, isTrustedCloudRelayUrl } from "../../../../../shared/cloud-environments.cjs";

type RelayEnvelope = { type: string; id?: string; status?: number; body?: any; event?: unknown; streamId?: string; data?: unknown; pendingEscape?: unknown; cols?: unknown; rows?: unknown; code?: number | null; signal?: string | null; sentAt?: string; receivedAt?: string };
export type RelaySessionBridge = {
  request(actor: ControlPlaneActor, input: { path: string; method: string; headers: Record<string, string>; body?: unknown }): Promise<{ status: number; body: unknown }>;
  subscribe(actor: ControlPlaneActor, topics: string[], listener: (event: EventEnvelope) => void, aiSessionTransient?: AiSessionTransientSubscription, resourceMetricInstanceIds?: string[]): () => void;
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
  private readonly options: { identity: ControlPlaneIdentityService; bridge: RelaySessionBridge; webSocket?: typeof WebSocket; trace?: RelayTraceRecorder };
  constructor(options: { identity: ControlPlaneIdentityService; bridge: RelaySessionBridge; webSocket?: typeof WebSocket; trace?: RelayTraceRecorder }) { this.options = options; }

  async connect(input: Record<string, any>) {
    const allocation = input.allocation as any;
    const attach = RelayAttachCapabilitySchema.parse(allocation.attach);
    const ticket = AccessTicketSchema.parse(allocation.ticket);
    const Socket = this.options.webSocket ?? WebSocket;
    const socket = new Socket(input.relayUrl, { followRedirects: false, handshakeTimeout: 10_000, perMessageDeflate: false });
    await socketOpen(socket);
    socket.send(JSON.stringify({ type: "attach", capability: attach }));
    const attached = await socketMessage(socket, (value) => value?.type === "attached");
    this.options.trace?.record({
      channelId: String(attached.channelId),
      direction: "in",
      kind: "channel-opened",
      plaintext: Buffer.from(JSON.stringify({ channelId: attached.channelId, allocationId: attached.allocationId, leaseExpiresAt: attached.leaseExpiresAt, at: new Date().toISOString() })),
      sealedBytes: 0,
      wireBytes: 0,
      detail: {
        channelId: boundedText(attached.channelId, 64),
        allocationId: boundedText(attached.allocationId, 64),
        leaseExpiresAt: boundedText(attached.leaseExpiresAt, 40),
        leaseMs: Number.isFinite(Date.parse(String(attached.leaseExpiresAt))) ? Date.parse(String(attached.leaseExpiresAt)) - Date.now() : undefined,
        attachIssuedAt: boundedText(attach.issuedAt, 40),
        attachExpiresAt: boundedText(attach.expiresAt, 40),
        attachMs: Number.isFinite(Date.parse(String(attach.expiresAt))) ? Date.parse(String(attach.expiresAt)) - Date.now() : undefined,
        ticketIssuedAt: boundedText(ticket.issuedAt, 40),
        ticketExpiresAt: boundedText(ticket.expiresAt, 40),
        ticketMs: Number.isFinite(Date.parse(String(ticket.expiresAt))) ? Date.parse(String(ticket.expiresAt)) - Date.now() : undefined,
      },
    });
    return continueEncryptedSession(socket, attached.channelId, ticket, this.options.identity, this.options.bridge, this.options.trace);
  }
}

// The Coordinator hands the client its attach capability only after this Control Plane
// acknowledges the allocation, while the encrypted handshake can only finish once that
// client joins the Relay. Acknowledge as soon as the Relay accepted this peer and keep
// completing the handshake in the background so both sides cannot wait on each other.
function continueEncryptedSession(socket: WebSocket, channelId: string, ticket: any, identity: ControlPlaneIdentityService, bridge: RelaySessionBridge, trace?: RelayTraceRecorder) {
  let session: { close(reason?: string): Promise<void> | void } | undefined;
  let closeReason: string | undefined;
  const established = establishEncryptedSession(socket, channelId, ticket, identity, bridge, trace).then((value) => {
    session = value;
    if (closeReason !== undefined) void value.close(closeReason);
    return value;
  });
  void established.catch(() => { if (socket.readyState < WebSocket.CLOSING) socket.close(4400, "relay-handshake-failed"); });
  return {
    async close(reason = "normal") {
      closeReason = reason;
      if (session) return session.close(reason);
      if (socket.readyState < WebSocket.CLOSING) socket.close(1000, String(reason).slice(0, 120));
      return undefined;
    },
  };
}

async function establishEncryptedSession(socket: WebSocket, channelId: string, ticket: any, identity: ControlPlaneIdentityService, bridge: RelaySessionBridge, trace?: RelayTraceRecorder) {
  const handshake = await socketMessage(socket, (value) => value?.type === "frame" && value.frame?.kind === "handshake");
  if (handshake.frame.channelId !== channelId || handshake.frame.sequence !== 0) throw relayError("RELAY_HANDSHAKE_SEQUENCE_INVALID");
  const hello = JSON.parse(Buffer.from(handshake.frame.ciphertext, "base64url").toString("utf8"));
  const accepted = identity.acceptCloudAccessHandshake(ticket, hello);
  const response = { ...accepted.response, controlPlanePublicKey: identity.publicIdentity().publicKey };
  socket.send(JSON.stringify({ type: "frame", frame: { protocolVersion: "2026-08-10", channelId, sequence: 0, kind: "handshake", ciphertext: Buffer.from(JSON.stringify(response)).toString("base64url") } }));
  const actor: ControlPlaneActor = { type: "cloud-account", accountId: ticket.accountId, deviceSessionId: ticket.deviceSessionId, bindingId: ticket.bindingId, bindingRevision: ticket.bindingRevision };
  const session = new EncryptedControlPlaneRelaySession(socket, channelId, accepted.sessionKey, actor, bridge, trace);
  session.start();
  return { close: (reason = "normal") => session.close(reason) };
}

// Exported so tests can drive the decrypted envelope path (sequence, nonce and
// metric scope parsing) without standing up a Relay socket.
export class EncryptedControlPlaneRelaySession {
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
  private readonly trace?: RelayTraceRecorder;
  constructor(socket: WebSocket, channelId: string, key: Uint8Array, actor: ControlPlaneActor, bridge: RelaySessionBridge, trace?: RelayTraceRecorder) { this.socket = socket; this.channelId = channelId; this.key = key; this.actor = actor; this.bridge = bridge; this.trace = trace; }
  start() {
    this.socket.on("message", (raw) => { void this.receive(raw).catch(() => this.socket.close(4400, "encrypted-protocol-error")); });
    this.socket.once("close", (code, reason) => {
      this.trace?.record({
        channelId: this.channelId,
        direction: "in",
        kind: "channel-closed",
        plaintext: Buffer.from(JSON.stringify({ code, reason: reason?.toString(), at: new Date().toISOString() })),
        sealedBytes: 0,
        wireBytes: 0,
        detail: { code, reason: boundedText(reason?.toString(), 120) },
      });
      this.unsubscribe?.();
      for (const tty of this.ttys.values()) tty.close();
      this.ttys.clear();
    });
  }
  async close(reason: string) { this.unsubscribe?.(); for (const tty of this.ttys.values()) tty.close(); this.ttys.clear(); if (this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, reason.slice(0, 120)); }
  private async receive(raw: WebSocket.RawData) {
    const message = JSON.parse(raw.toString()); const frame = message?.frame;
    if (message?.type !== "frame" || frame?.channelId !== this.channelId || frame.sequence !== this.receiveSequence++) throw relayError("RELAY_FRAME_SEQUENCE_INVALID");
    const sealed = Buffer.from(frame.ciphertext, "base64url");
    const opened = nacl.secretbox.open(sealed, nonce(1, this.receiveCounter++), this.key);
    if (!opened) throw relayError("RELAY_E2E_DECRYPT_FAILED");
    const envelope = JSON.parse(Buffer.from(opened).toString("utf8"));
    // Captured before dispatch so a failing handler still leaves the evidence behind.
    this.trace?.record({ channelId: this.channelId, direction: "in", kind: typeof envelope?.type === "string" ? envelope.type : "unknown", plaintext: opened, sealedBytes: sealed.byteLength, wireBytes: typeof frame.ciphertext === "string" ? frame.ciphertext.length : 0, detail: envelopeDetail(envelope) });
    await this.dispatch(envelope);
  }
  private async dispatch(value: RelayEnvelope) {
    if (value.type === "request" && value.id) {
      try { const result = await this.bridge.request(this.actor, value.body); this.send({ type: "response", id: value.id, status: result.status, body: result.body }); }
      catch (error) { this.send({ type: "response", id: value.id, status: Number((error as any)?.statusCode) || 500, body: { error: { code: (error as any)?.code ?? "CONTROL_PLANE_ERROR", message: "Control Plane request failed." } } }); }
      return;
    }
    if (value.type === "event-subscribe") {
      this.unsubscribe?.();
      const topics = Array.isArray(value.body?.topics) ? value.body.topics.map(String) : ["*"];
      const transient = AiSessionTransientSubscriptionSchema.safeParse(value.body?.aiSessionTransient);
      // Resource metrics ride the `instances` topic even though they are pure
      // telemetry, so they need their own scope. Absence keeps the legacy full
      // metrics stream; an explicit list (including an empty one) narrows it.
      const resourceMetricInstanceIds = Array.isArray(value.body?.metricInstanceIds)
        ? value.body.metricInstanceIds.map(String).filter(Boolean)
        : undefined;
      const compact = value.body?.eventEnvelopeVersion === COMPACT_EVENT_ENVELOPE_VERSION;
      this.unsubscribe = this.bridge.subscribe(this.actor, topics, (event) => this.send({ type: "event", event: compact ? projectCompactPublicEvent(event) : event }), transient.success ? transient.data : undefined, resourceMetricInstanceIds);
      return;
    }
    // The Relay carries an idle channel to nothing, so a client that only
    // listens (every mobile event stream) has to keep the channel warm. The
    // direct event transport answers the same frame so both paths behave alike.
    if (value.type === "ping") { this.send({ type: "pong", sentAt: value.sentAt, receivedAt: new Date().toISOString() }); return; }
    if (value.type === "tty-open" && value.streamId && this.bridge.openTty) { const streamId = value.streamId; const tty = await this.bridge.openTty(this.actor, value.body, (event) => this.send({ ...event, streamId })); this.ttys.set(streamId, tty); this.send({ type: "tty-opened", streamId }); return; }
    const tty = value.streamId ? this.ttys.get(value.streamId) : undefined;
    if (tty && value.type === "tty-input") return tty.send(String(value.data ?? ""));
    if (tty && value.type === "tty-resize") return tty.resize(Number(value.body?.cols), Number(value.body?.rows));
    if (tty && value.type === "tty-close") { tty.close(); this.ttys.delete(value.streamId!); this.send({ type: "tty-closed", streamId: value.streamId }); return; }
    if (value.type !== "cancel") throw relayError("RELAY_ENVELOPE_UNSUPPORTED");
  }
  private send(value: RelayEnvelope) {
    if (this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 2 * 1024 * 1024) throw relayError("RELAY_BACKPRESSURE_LIMIT");
    const plaintext = Buffer.from(JSON.stringify(value));
    const sealed = nacl.secretbox(plaintext, nonce(2, this.sendCounter++), this.key);
    const ciphertext = Buffer.from(sealed).toString("base64url");
    // plaintextBytes against wireBytes is the point of the trace: every relayed byte
    // pays secretbox MAC plus base64 expansion before it reaches the Relay.
    this.trace?.record({ channelId: this.channelId, direction: "out", kind: value.type, plaintext, sealedBytes: sealed.byteLength, wireBytes: ciphertext.length, detail: envelopeDetail(value) });
    this.socket.send(JSON.stringify({ type: "frame", frame: { protocolVersion: "2026-08-10", channelId: this.channelId, sequence: this.sendSequence++, kind: value.type === "cancel" ? "cancel" : "data", ciphertext } }));
  }
}

// Relay trust follows the environment bound to the persisted service origin:
// registered environments use their declared Relay hosts, ad-hoc local clouds keep
// the legacy "same host, plain ws allowed over HTTP" behaviour.
function trustedRelayUrl(url: URL, serviceOrigin: string) {
  return isTrustedCloudRelayUrl(cloudEnvironmentForServiceOrigin(serviceOrigin), url);
}
function socketOpen(socket: WebSocket) { return new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); socket.once("close", () => reject(relayError("RELAY_SOCKET_CLOSED"))); }); }
function socketMessage(socket: WebSocket, predicate: (value: any) => boolean) { return new Promise<any>((resolve, reject) => { const onMessage = (raw: WebSocket.RawData) => { try { const value = JSON.parse(raw.toString()); if (predicate(value)) { cleanup(); resolve(value); } } catch (error) { cleanup(); reject(error); } }; const onClose = () => { cleanup(); reject(relayError("RELAY_SOCKET_CLOSED")); }; const cleanup = () => { socket.off("message", onMessage); socket.off("close", onClose); }; socket.on("message", onMessage); socket.once("close", onClose); }); }
// Only shape metadata is captured here; the payload itself becomes the trace entry body.
function envelopeDetail(value: any): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const detail: Record<string, unknown> = {};
  if (typeof value.id === "string") detail.id = value.id.slice(0, 64);
  if (typeof value.streamId === "string") detail.streamId = value.streamId.slice(0, 64);
  if (value.type === "request") { detail.path = boundedText(value.body?.path, 512); detail.method = boundedText(value.body?.method, 16); }
  if (value.type === "response" && typeof value.status === "number") detail.status = value.status;
  if (value.type === "event") detail.eventType = boundedText(value.event?.type, 96);
  if (value.type === "event-subscribe") {
    const topics = value.body?.topics;
    detail.topics = Array.isArray(topics) ? topics.slice(0, 24).map((topic: unknown) => boundedText(topic, 64)) : "*";
    if (Array.isArray(value.body?.metricInstanceIds)) detail.metricInstanceIds = value.body.metricInstanceIds.length;
    const transient = value.body?.aiSessionTransient;
    if (transient && typeof transient === "object") detail.aiSessionTransient = {
      ...(boundedText(transient.replaySince, 40) ? { replaySince: boundedText(transient.replaySince, 40) } : {}),
      ...(transient.messageDeltas ? { messageDeltas: { allInstances: transient.messageDeltas.allInstances === true, instances: Array.isArray(transient.messageDeltas.instanceIds) ? transient.messageDeltas.instanceIds.length : 0 } } : {}),
      ...(Array.isArray(transient.timelineSessions) ? { timelineSessions: transient.timelineSessions.length } : {}),
      ...(transient.timelineAllSessions ? { timelineAllSessions: true } : {}),
    };
  }
  return Object.fromEntries(Object.entries(detail).filter(([, item]) => item !== undefined));
}
function boundedText(value: unknown, limit: number) { return typeof value === "string" ? value.slice(0, limit) : undefined; }
function nonce(direction: number, counter: number) { const value = new Uint8Array(24); value[0] = direction; new DataView(value.buffer).setBigUint64(16, BigInt(counter), false); return value; }
function relayError(code: string) { return Object.assign(new Error("Cloud Relay session is invalid."), { code, retryable: true }); }
