import WebSocket from "ws";
import nacl from "tweetnacl";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { PassThrough, type Readable } from "node:stream";
import {
  NodeRelayAllocationEventSchema,
  RELAY_FRAME_HEADER_BYTES,
  RelayAttachCapabilitySchema,
  RelayRoleProofSchema,
  RelaySessionClosedMessageSchema,
  RelaySessionDetachedMessageSchema,
  RelaySessionGrantSchema,
  RELAY_SESSION_PROTOCOL_VERSION,
  decodeRelayFrame,
  encodeRelayFrame,
  packRelayPayload,
  unpackRelayPayload,
  type RelayFramePayload,
  type RelayRoleProofPayload,
  type RelaySessionGrant,
} from "@task-handoff/cloud-contracts";
import { COMPACT_EVENT_ENVELOPE_VERSION, AiSessionTransientSubscriptionSchema, type AiSessionTransientSubscription, type EventEnvelope } from "@task-handoff/protocol/events";
import {
  RELAY_BODY_CHUNK_BYTES,
  RelayBinaryBodySchema,
  RelayBinaryResponseSchema,
  RelayResponseAckSchema,
  decodeRelayBodyFrame,
  decodeRelayResponseFrame,
  encodeRelayResponseFrame,
  isRelayBodyFrame,
  isRelayResponseFrame,
  type RelayBodyFrame,
  type RelayResponseFrame,
} from "@task-handoff/protocol/relay-body";
import type { ControlPlaneActor } from "../auth/authorization.ts";
import type { ControlPlaneIdentityService } from "../identity/service.ts";
import { projectCompactPublicEvent } from "../events/bus.ts";
import type { RelayTraceRecorder } from "./relay-trace.ts";
import { cloudEnvironmentForServiceOrigin, isTrustedCloudRelayUrl } from "../../../../../shared/cloud-environments.cjs";

type RelayEnvelope = { type: string; id?: string; status?: number; body?: any; binaryResponse?: unknown; bodyId?: number; responseId?: number; offset?: number; event?: unknown; streamId?: string; data?: unknown; pendingEscape?: unknown; cols?: unknown; rows?: unknown; code?: number | null; signal?: string | null; sentAt?: string; receivedAt?: string };
export type RelaySessionBridge = {
  request(actor: ControlPlaneActor, input: { path: string; method: string; headers: Record<string, string>; body?: unknown; bodyStream?: Readable; binaryResponse?: boolean }): Promise<{ status: number; body?: unknown; binary?: { bytes: Uint8Array; contentType?: string; filename?: string } }>;
  subscribe(actor: ControlPlaneActor, topics: string[], listener: (event: EventEnvelope) => void, aiSessionTransient?: AiSessionTransientSubscription, resourceMetricInstanceIds?: string[]): () => void;
  openTty?(actor: ControlPlaneActor, input: { instanceId: string; sessionId: string }, listener: (message: RelayEnvelope) => void): Promise<{ send(data: string): void; resize(cols: number, rows: number): void; close(): void }>;
};

/**
 * One binary request body being assembled from `body` frames. The stream is fed
 * straight into the local Fastify instance, so the body is never buffered whole
 * on the Control Plane the way a base64 envelope had to be.
 */
type RelayBodyAssembly = {
  bodyId: number;
  requestId: string;
  size: number;
  received: number;
  acknowledged: number;
  pendingAck?: number;
  drainBound: boolean;
  stream: PassThrough;
  timer?: ReturnType<typeof setTimeout>;
};

type PendingRelayResponse = {
  responseId: number;
  requestId: string;
  data: Buffer;
  size: number;
  acked: number;
  nextOffset: number;
  resolve(): void;
  reject(error: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
};

/** How long a partially received body may sit idle before the Control Plane aborts it. */
const RELAY_BODY_IDLE_TIMEOUT_MS = 60_000;
const RELAY_RESPONSE_WINDOW_BYTES = 4 * RELAY_BODY_CHUNK_BYTES;
// Keep the aggregate in-flight response bytes under the Relay socket's 2 MiB
// backpressure guard when several downloads are active at once. The window is
// shared fairly across responses instead of granting each one 1 MiB.
const RELAY_RESPONSE_GLOBAL_WINDOW_BYTES = 4 * RELAY_BODY_CHUNK_BYTES;
const RELAY_RESPONSE_STALL_TIMEOUT_MS = 15_000;
// `ws` answers a ping with a pong from the event loop, so a half-open TCP socket
// is detected even when the operating system has not reported a close.
const RELAY_HEARTBEAT_INTERVAL_MS = 15_000;
const RELAY_HEARTBEAT_TIMEOUT_MS = 10_000;
// The Coordinator waits 15 seconds for the allocation request. Timing out here
// first turns a silent Relay attach into a definite failure instead of leaving
// the request pending until the Coordinator has to treat delivery as unknown.
const DEFAULT_RELAY_ATTACH_TIMEOUT_MS = 10_000;
// After the Relay accepts the channel, the client still has to complete the
// end-to-end handshake. Bound that background wait too, otherwise a client that
// disappears after attach leaves the socket and session pending indefinitely.
const DEFAULT_RELAY_HANDSHAKE_TIMEOUT_MS = 15_000;

export function verifyCoordinatorRelayAllocation(raw: unknown, state: { snapshot(): any }) {
  const event = raw as any;
  const attach = RelayAttachCapabilitySchema.parse(event?.attach);
  const grant = RelaySessionGrantSchema.parse(event?.grant);
  const ticket = grant.sessionTranscriptTicket;
  const current = state.snapshot();
  const relayUrl = new URL(String(event?.relayUrl));
  const ownerAccountId = grant.ownerAccountId ?? grant.accountId;
  const accessMode = grant.accessMode ?? "owner";
  const sharedIdentityMatches = sameOptional(attach.ownerAccountId, grant.ownerAccountId)
    && sameOptional(attach.accessMode, grant.accessMode)
    && sameOptional(attach.shareGrantId, grant.shareGrantId)
    && sameOptional(attach.shareRevision, grant.shareRevision)
    && sameOptional(attach.shareRole, grant.shareRole);
  if (event?.type !== "relay-allocation" || event?.allocationId !== grant.allocationId || attach.allocationId !== grant.allocationId ||
      attach.role !== "control-plane" || attach.relayId !== grant.relayId ||
      attach.controlPlaneId !== grant.controlPlaneId || attach.accountId !== grant.accountId ||
      attach.deviceSessionId !== grant.deviceSessionId || attach.bindingId !== grant.bindingId || attach.bindingRevision !== grant.bindingRevision ||
      attach.ticketId !== grant.accessTicketId ||
      !sharedIdentityMatches ||
      current.status !== "active" || current.scopes.deviceAccess !== true || current.cloudControlPlaneId !== grant.controlPlaneId ||
      current.accountId !== ownerAccountId || current.bindingId !== grant.bindingId || current.bindingRevision !== grant.bindingRevision ||
      grant.targetPublicKeyFingerprint !== current.identity.fingerprint || ticket.controlPlaneId !== grant.controlPlaneId ||
      Date.parse(attach.expiresAt) <= Date.now() || Date.parse(grant.expiresAt) <= Date.now() || Date.parse(ticket.expiresAt) <= Date.now()) throw relayError("RELAY_ALLOCATION_AUTHORITY_INVALID");
  if (accessMode === "shared" && !grant.shareGrantId) throw relayError("RELAY_ALLOCATION_AUTHORITY_INVALID");
  if (!trustedRelayUrl(relayUrl, current.serviceOrigin)) throw relayError("UNTRUSTED_RELAY_URL");
  if (new URL(grant.relayUrl).href !== relayUrl.href) throw relayError("RELAY_ALLOCATION_AUTHORITY_INVALID");
  return { allocationId: grant.allocationId, relayUrl: relayUrl.href, epoch: Date.parse(grant.issuedAt), channelKind: "access" as const, attach, grant, ticket };
}

/** A replayed grant may arrive before this Control Plane has a local channel. */
export function verifyCoordinatorRelaySessionGrant(raw: unknown, state: { snapshot(): any }) {
  const event = raw as any;
  const grant = RelaySessionGrantSchema.parse(event?.type === "relay-session-grant" ? event.grant : event?.grant ?? event);
  const current = state.snapshot();
  const relayUrl = new URL(grant.relayUrl);
  const ownerAccountId = grant.ownerAccountId ?? grant.accountId;
  const accessMode = grant.accessMode ?? "owner";
  if ((event?.type && event.type !== "relay-session-grant") || current.status !== "active" || current.scopes.deviceAccess !== true ||
      current.cloudControlPlaneId !== grant.controlPlaneId || current.accountId !== ownerAccountId ||
      current.bindingId !== grant.bindingId || current.bindingRevision !== grant.bindingRevision ||
      grant.targetPublicKeyFingerprint !== current.identity.fingerprint || Date.parse(grant.expiresAt) <= Date.now()) throw relayError("RELAY_SESSION_AUTHORITY_INVALID");
  if (accessMode === "shared" && !grant.shareGrantId) throw relayError("RELAY_SESSION_AUTHORITY_INVALID");
  if (!trustedRelayUrl(relayUrl, current.serviceOrigin)) throw relayError("UNTRUSTED_RELAY_URL");
  return { allocationId: grant.allocationId, relayUrl: relayUrl.href, epoch: Date.parse(grant.issuedAt), channelKind: "access" as const, grant, ticket: grant.sessionTranscriptTicket };
}

/**
 * Node-relay allocation pushed to this Control Plane. The node-relay scope and
 * the local binding identity gate it exactly like the device-access path; the
 * claim grant itself is verified by the node agent, never here.
 */
export function verifyCoordinatorNodeRelayAllocation(raw: unknown, state: { snapshot(): any }) {
  const event = NodeRelayAllocationEventSchema.parse(raw);
  const attach = event.controlPlaneAttach;
  const current = state.snapshot();
  const relayUrl = new URL(event.relayUrl);
  const accessMode = event.accessMode ?? attach.accessMode ?? "owner";
  const granteeAccountId = event.accountId ?? attach.accountId;
  const ownerAccountId = event.ownerAccountId ?? attach.ownerAccountId ?? (accessMode === "owner" ? granteeAccountId : undefined);
  const sharedIdentityMatches = sameOptional(attach.ownerAccountId, event.ownerAccountId)
    && sameOptional(attach.accessMode, event.accessMode)
    && sameOptional(attach.shareGrantId, event.shareGrantId)
    && sameOptional(attach.shareRevision, event.shareRevision)
    && sameOptional(attach.shareRole, event.shareRole);
  const sharedAuthorityValid = accessMode === "owner"
    ? Boolean(ownerAccountId) && ownerAccountId === granteeAccountId && attach.shareGrantId === undefined && attach.shareRevision === undefined && attach.shareRole === undefined
    : Boolean(ownerAccountId && granteeAccountId && ownerAccountId !== granteeAccountId && event.shareGrantId && event.shareRevision && event.shareRole === "use");
  if (current.status !== "active" || current.scopes.nodeRelay !== true || current.cloudControlPlaneId !== event.controlPlaneId ||
      attach.channelKind !== "node" || attach.role !== "control-plane" || attach.controlPlaneId !== event.controlPlaneId ||
      attach.accountId !== granteeAccountId || !sharedIdentityMatches || !sharedAuthorityValid ||
      attach.bindingId !== event.bindingId || attach.bindingRevision !== event.bindingRevision ||
      current.accountId !== granteeAccountId || current.bindingId !== event.bindingId || current.bindingRevision !== event.bindingRevision ||
      // The fingerprint is what pins the node's handshake key to the claimed
      // registry entry; an event without it cannot be authenticated end to end.
      typeof event.nodePublicKeyFingerprint !== "string" ||
      Date.parse(attach.expiresAt) <= Date.now() || Date.parse(event.expiresAt) <= Date.now()) throw relayError("RELAY_ALLOCATION_AUTHORITY_INVALID");
  if (!trustedRelayUrl(relayUrl, current.serviceOrigin)) throw relayError("UNTRUSTED_RELAY_URL");
  return {
    allocationId: event.allocationId,
    relayUrl: relayUrl.href,
    epoch: Date.parse(attach.issuedAt),
    channelKind: "node" as const,
    attach,
    event,
    nodeHandle: event.nodeHandle,
    ...(event.nodeId ? { nodeId: event.nodeId } : {}),
    nodePublicKeyFingerprint: event.nodePublicKeyFingerprint,
    displayName: event.displayName,
  };
}

type CloudRelayConnectorOptions = {
  identity: ControlPlaneIdentityService;
  bridge: RelaySessionBridge;
  webSocket?: typeof WebSocket;
  trace?: RelayTraceRecorder;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  attachTimeoutMs?: number;
  handshakeTimeoutMs?: number;
};

export class CloudRelayConnector {
  private readonly options: CloudRelayConnectorOptions;
  constructor(options: CloudRelayConnectorOptions) { this.options = options; }

  async connect(input: Record<string, any>) {
    const allocation = input.allocation as any;
    const attach = RelayAttachCapabilitySchema.parse(allocation.attach);
    const grant = RelaySessionGrantSchema.parse(allocation.grant);
    const ticket = grant.sessionTranscriptTicket;
    const Socket = this.options.webSocket ?? WebSocket;
    const socket = new Socket(input.relayUrl, { followRedirects: false, handshakeTimeout: 10_000, perMessageDeflate: false });
    await socketOpen(socket);
    startRelayHeartbeat(socket, this.options.heartbeatIntervalMs, this.options.heartbeatTimeoutMs);
    try {
      socket.send(JSON.stringify({ type: "attach", capability: attach, grant, proof: this.roleProof(grant) }));
      const attached = await socketMessage(socket, (value) => value?.type === "attached", positiveDuration(this.options.attachTimeoutMs, DEFAULT_RELAY_ATTACH_TIMEOUT_MS));
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
      return continueEncryptedSession(socket, attached.channelId, ticket, grant, this.options.identity, this.options.bridge, input.onDisconnected, this.options.trace, positiveDuration(this.options.handshakeTimeoutMs, DEFAULT_RELAY_HANDSHAKE_TIMEOUT_MS));
    } catch (error) {
      if (socket.readyState < WebSocket.CLOSING) socket.close(4400, "relay-attach-failed");
      throw error;
    }
  }

  async resume(input: { relayUrl: string; grant: unknown; onDisconnected?: () => void }) {
    const grant = RelaySessionGrantSchema.parse(input.grant);
    const Socket = this.options.webSocket ?? WebSocket;
    const socket = new Socket(input.relayUrl, { followRedirects: false, handshakeTimeout: 10_000, perMessageDeflate: false });
    await socketOpen(socket);
    startRelayHeartbeat(socket, this.options.heartbeatIntervalMs, this.options.heartbeatTimeoutMs);
    try {
      socket.send(JSON.stringify({ type: "session-attach", grant, proof: this.roleProof(grant) }));
      const attached = await socketMessage(socket, (value) => value?.type === "attached", positiveDuration(this.options.attachTimeoutMs, DEFAULT_RELAY_ATTACH_TIMEOUT_MS));
      this.options.trace?.record({
        channelId: String(attached.channelId),
        direction: "in",
        kind: "channel-resumed",
        plaintext: Buffer.from(JSON.stringify({ channelId: attached.channelId, allocationId: attached.allocationId, leaseExpiresAt: attached.leaseExpiresAt, at: new Date().toISOString() })),
        sealedBytes: 0,
        wireBytes: 0,
        detail: { channelId: boundedText(attached.channelId, 64), allocationId: boundedText(attached.allocationId, 64), generation: grant.generation },
      });
      return continueEncryptedSession(socket, attached.channelId, grant.sessionTranscriptTicket, grant, this.options.identity, this.options.bridge, input.onDisconnected, this.options.trace, positiveDuration(this.options.handshakeTimeoutMs, DEFAULT_RELAY_HANDSHAKE_TIMEOUT_MS));
    } catch (error) {
      if (socket.readyState < WebSocket.CLOSING) socket.close(4400, "relay-attach-failed");
      throw error;
    }
  }

  private roleProof(grant: RelaySessionGrant) {
    return RelayRoleProofSchema.parse(this.options.identity.signRelayRoleProof(relayRoleProofPayload(grant)));
  }
}

// The Coordinator hands the client its attach capability only after this Control Plane
// acknowledges the allocation, while the encrypted handshake can only finish once that
// client joins the Relay. Acknowledge as soon as the Relay accepted this peer and keep
// completing the handshake in the background so both sides cannot wait on each other.
function continueEncryptedSession(socket: WebSocket, channelId: string, ticket: any, grant: RelaySessionGrant, identity: ControlPlaneIdentityService, bridge: RelaySessionBridge, onDisconnected?: () => void, trace?: RelayTraceRecorder, handshakeTimeoutMs = DEFAULT_RELAY_HANDSHAKE_TIMEOUT_MS) {
  let session: { close(reason?: string): Promise<void> | void } | undefined;
  let closeReason: string | undefined;
  let intentional = false;
  let disconnected = false;
  let latestGrant = grant;
  // Relay control messages can arrive before the close frame is observed by the
  // peer. Treat either signal as one logical disconnect so the session manager
  // can resume immediately without waiting on socket teardown.
  const reportDisconnected = () => {
    if (intentional || disconnected) return;
    disconnected = true;
    onDisconnected?.();
  };
  socket.once("close", reportDisconnected);
  const established = establishEncryptedSession(socket, channelId, ticket, identity, bridge, reportDisconnected, trace, handshakeTimeoutMs).then((value) => {
    session = value;
    if (closeReason !== undefined) void value.close(closeReason);
    return value;
  });
  void established.catch(() => { if (socket.readyState < WebSocket.CLOSING) socket.close(4400, "relay-handshake-failed"); });
  return {
    renew(nextGrant: unknown) {
      latestGrant = RelaySessionGrantSchema.parse(nextGrant);
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "session-renew", grant: latestGrant, proof: RelayRoleProofSchema.parse(identity.signRelayRoleProof(relayRoleProofPayload(latestGrant))) }));
    },
    async close(reason = "normal") {
      intentional = true;
      closeReason = reason;
      if (session) return session.close(reason);
      if (socket.readyState < WebSocket.CLOSING) socket.close(1000, String(reason).slice(0, 120));
      return undefined;
    },
  };
}

async function establishEncryptedSession(socket: WebSocket, channelId: string, ticket: any, identity: ControlPlaneIdentityService, bridge: RelaySessionBridge, onPeerDetached?: () => void, trace?: RelayTraceRecorder, handshakeTimeoutMs = DEFAULT_RELAY_HANDSHAKE_TIMEOUT_MS) {
  const handshake = await socketFrame(socket, (frame) => frame.kind === "handshake", handshakeTimeoutMs);
  if (handshake.sequence !== 0) throw relayError("RELAY_HANDSHAKE_SEQUENCE_INVALID");
  const hello = JSON.parse(Buffer.from(handshake.payload).toString("utf8"));
  const accepted = identity.acceptCloudAccessHandshake(ticket, hello);
  const response = { ...accepted.response, controlPlanePublicKey: identity.publicIdentity().publicKey };
  socket.send(encodeRelayFrame({ kind: "handshake", sequence: 0, payload: Buffer.from(JSON.stringify(response)) }));
  const actor: ControlPlaneActor = {
    type: "cloud-account",
    accountId: ticket.accountId,
    deviceSessionId: ticket.deviceSessionId,
    bindingId: ticket.bindingId,
    bindingRevision: ticket.bindingRevision,
    ownerAccountId: ticket.ownerAccountId ?? ticket.accountId,
    accessMode: ticket.accessMode ?? "owner",
    ...(ticket.accessMode === "shared" ? {
      shareGrantId: ticket.shareGrantId,
      shareRevision: ticket.shareRevision,
      shareRole: ticket.shareRole,
    } : {}),
  };
  const session = new EncryptedControlPlaneRelaySession(socket, channelId, accepted.sessionKey, actor, bridge, trace, onPeerDetached);
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
  private nextResponseId = 0;
  private closing = false;
  private pumpingResponses = false;
  private readonly ttys = new Map<string, { send(data: string): void; resize(cols: number, rows: number): void; close(): void }>();
  private readonly bodies = new Map<number, RelayBodyAssembly>();
  private readonly bodyByRequest = new Map<string, number>();
  private readonly responses = new Map<number, PendingRelayResponse>();
  private readonly responseByRequest = new Map<string, number>();
  private readonly socket: WebSocket;
  private readonly channelId: string;
  private readonly key: Uint8Array;
  private readonly actor: ControlPlaneActor;
  private readonly bridge: RelaySessionBridge;
  private readonly trace?: RelayTraceRecorder;
  private readonly onPeerDetached?: () => void;
  constructor(socket: WebSocket, channelId: string, key: Uint8Array, actor: ControlPlaneActor, bridge: RelaySessionBridge, trace?: RelayTraceRecorder, onPeerDetached?: () => void) { this.socket = socket; this.channelId = channelId; this.key = key; this.actor = actor; this.bridge = bridge; this.trace = trace; this.onPeerDetached = onPeerDetached; }
  start() {
    this.socket.on("message", (raw, isBinary) => { void this.receive(raw, isBinary).catch(() => this.socket.close(4400, "encrypted-protocol-error")); });
    this.socket.once("close", (code, reason) => {
      this.closing = true;
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
      for (const assembly of [...this.bodies.values()]) this.abortBody(assembly, "RELAY_CHANNEL_CLOSED");
      for (const response of [...this.responses.values()]) this.abortResponse(response, relayError("RELAY_CHANNEL_CLOSED"));
    });
  }
  async close(reason: string) { this.closing = true; this.unsubscribe?.(); for (const tty of this.ttys.values()) tty.close(); this.ttys.clear(); for (const assembly of [...this.bodies.values()]) this.abortBody(assembly, "RELAY_CHANNEL_CLOSED"); for (const response of [...this.responses.values()]) this.abortResponse(response, relayError("RELAY_CHANNEL_CLOSED")); if (this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, reason.slice(0, 120)); }
  private async receive(raw: WebSocket.RawData, isBinary: boolean) {
    if (!isBinary) {
      const control = JSON.parse(rawBytes(raw).toString("utf8"));
      // Relay control text is separate from the E2E data path. Grant updates
      // arrive over the Coordinator channel; this is only an acknowledgement.
      if (control?.type === "session-closed") { RelaySessionClosedMessageSchema.parse(control); return; }
      if (control?.type === "peer-detached") {
        RelaySessionDetachedMessageSchema.parse(control);
        this.onPeerDetached?.();
        if (this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, "peer-detached");
        return;
      }
      if (control?.type === "renewed") return;
      throw relayError("RELAY_FRAME_ENCODING_INVALID");
    }
    const frame = decodeRelayFrame(rawBytes(raw));
    if (frame.sequence !== this.receiveSequence++) throw relayError("RELAY_FRAME_SEQUENCE_INVALID");
    const opened = nacl.secretbox.open(frame.payload, nonce(1, this.receiveCounter++), this.key);
    if (!opened) throw relayError("RELAY_E2E_DECRYPT_FAILED");
    const plaintext = unpackRelayPayload(opened, frame.flags ?? 0, (input) => inflateRawSync(input));
    // Binary bodies replace the base64 envelope for large payloads; the first
    // byte tells the two apart (`{` for JSON, the body magic otherwise).
    if (isRelayBodyFrame(plaintext)) {
      const chunk = decodeRelayBodyFrame(plaintext);
      this.trace?.record({ channelId: this.channelId, direction: "in", kind: "body", plaintext: Buffer.alloc(0), sealedBytes: frame.payload.byteLength, wireBytes: RELAY_FRAME_HEADER_BYTES + frame.payload.byteLength, detail: { bodyId: chunk.bodyId, offset: chunk.offset, bytes: chunk.bytes.byteLength, final: chunk.final } });
      this.acceptBodyChunk(chunk);
      return;
    }
    if (isRelayResponseFrame(plaintext)) {
      decodeRelayResponseFrame(plaintext);
      throw relayError("RELAY_RESPONSE_FRAME_UNSUPPORTED");
    }
    const envelope = JSON.parse(Buffer.from(plaintext).toString("utf8"));
    // Captured before dispatch so a failing handler still leaves the evidence behind.
    this.trace?.record({ channelId: this.channelId, direction: "in", kind: typeof envelope?.type === "string" ? envelope.type : "unknown", plaintext, sealedBytes: frame.payload.byteLength, wireBytes: RELAY_FRAME_HEADER_BYTES + frame.payload.byteLength, detail: envelopeDetail(envelope) });
    await this.dispatch(envelope);
  }
  private async dispatch(value: RelayEnvelope) {
    if (value.type === "response-ack") {
      const ack = RelayResponseAckSchema.safeParse(value);
      if (!ack.success) throw relayError("RELAY_RESPONSE_ACK_INVALID");
      this.acceptResponseAck(ack.data.responseId, ack.data.offset);
      return;
    }
    if (value.type === "request" && value.id) {
      const binaryBody = value.body?.binaryBody === undefined ? undefined : RelayBinaryBodySchema.parse(value.body.binaryBody);
      // Register the assembly before the first await so chunks that arrive while
      // the route is still starting up are accepted in order.
      const assembly = binaryBody ? this.openBody(value.id, binaryBody) : undefined;
      let responseStarted = false;
      try {
        const result = await this.bridge.request(this.actor, {
          path: String(value.body?.path ?? ""),
          method: String(value.body?.method ?? "GET"),
          headers: (value.body?.headers ?? {}) as Record<string, string>,
          binaryResponse: value.body?.responseBinary === true,
          ...(assembly ? { bodyStream: assembly.stream } : { body: value.body?.body }),
        });
        if (assembly) this.flushBodyAck(assembly);
        if (result.binary) {
          responseStarted = true;
          await this.sendBinaryResponse(value.id, result.status, result.binary);
        } else {
          this.send({ type: "response", id: value.id, status: result.status, body: result.body });
        }
      }
      catch (error) {
        const detail = error && typeof error === "object" ? error as { statusCode?: unknown; code?: unknown; message?: unknown; retryable?: unknown } : {};
        if (responseStarted) {
          if (detail.code !== "RELAY_RESPONSE_CANCELLED" && this.socket.readyState < WebSocket.CLOSING) this.socket.close(4413, "response-transfer-failed");
        } else {
          this.send({
            type: "response",
            id: value.id,
            status: Number(detail.statusCode) || 500,
            body: {
              error: {
                code: typeof detail.code === "string" ? detail.code : "CONTROL_PLANE_ERROR",
                message: typeof detail.message === "string" && detail.message ? detail.message : "Control Plane request failed.",
                ...(typeof detail.retryable === "boolean" ? { retryable: detail.retryable } : {}),
              },
            },
          });
        }
      }
      finally { if (assembly) this.closeBody(assembly); }
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
    // A client that aborts an upload sends `cancel`; unwinding the stream stops
    // the local route (and its controlled-instance draft) immediately.
    if (value.type === "cancel" && value.id) {
      const bodyId = this.bodyByRequest.get(value.id);
      const assembly = bodyId === undefined ? undefined : this.bodies.get(bodyId);
      if (assembly) this.abortBody(assembly, "RELAY_BODY_CANCELLED");
      const responseId = this.responseByRequest.get(value.id);
      const response = responseId === undefined ? undefined : this.responses.get(responseId);
      if (response) this.abortResponse(response, relayError("RELAY_RESPONSE_CANCELLED"));
      return;
    }
    if (value.type !== "cancel") throw relayError("RELAY_ENVELOPE_UNSUPPORTED");
  }
  private send(value: RelayEnvelope) {
    if (this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 2 * 1024 * 1024) throw relayError("RELAY_BACKPRESSURE_LIMIT");
    const plaintext = Buffer.from(JSON.stringify(value));
    const packed = packRelayPayload(plaintext, (input) => deflateRawSync(input));
    const sealed = nacl.secretbox(packed.payload, nonce(2, this.sendCounter++), this.key);
    const wire = encodeRelayFrame({ kind: value.type === "cancel" ? "cancel" : "data", sequence: this.sendSequence++, payload: sealed, flags: packed.flags });
    // plaintextBytes against wireBytes is the point of the trace: every relayed byte
    // pays the secretbox MAC and the fixed frame header before it reaches the Relay.
    this.trace?.record({ channelId: this.channelId, direction: "out", kind: value.type, plaintext, sealedBytes: sealed.byteLength, wireBytes: wire.byteLength, detail: envelopeDetail(value) });
    this.socket.send(wire);
  }
  private sendBinaryResponse(requestId: string, status: number, binary: { bytes: Uint8Array; contentType?: string; filename?: string }) {
    const responseId = ++this.nextResponseId;
    const metadata = RelayBinaryResponseSchema.parse({
      responseId,
      size: binary.bytes.byteLength,
      ...(binary.contentType ? { contentType: binary.contentType } : {}),
      ...(binary.filename ? { filename: binary.filename } : {}),
    });
    const data = Buffer.isBuffer(binary.bytes)
      ? binary.bytes
      : Buffer.from(binary.bytes.buffer as ArrayBuffer, binary.bytes.byteOffset, binary.bytes.byteLength);
    this.send({ type: "response", id: requestId, status, binaryResponse: metadata });
    if (data.byteLength === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const transfer: PendingRelayResponse = {
        responseId,
        requestId,
        data,
        size: data.byteLength,
        acked: 0,
        nextOffset: 0,
        resolve,
        reject,
      };
      this.responses.set(responseId, transfer);
      this.responseByRequest.set(requestId, responseId);
      this.pumpResponses();
    });
  }

  /** Sends at most one chunk per response per round, within a channel-wide window. */
  private pumpResponses() {
    if (this.closing || this.pumpingResponses) return;
    this.pumpingResponses = true;
    try {
      const progressed = new Set<PendingRelayResponse>();
      let advanced = true;
      while (advanced) {
        advanced = false;
        const transfers = [...this.responses.values()]
          .filter((transfer) => transfer.nextOffset < transfer.size)
          .sort((left, right) => (left.nextOffset - left.acked) - (right.nextOffset - right.acked));
        for (const transfer of transfers) {
          if (this.responses.get(transfer.responseId) !== transfer) continue;
          if (transfer.nextOffset - transfer.acked >= RELAY_RESPONSE_WINDOW_BYTES) continue;
          const available = RELAY_RESPONSE_GLOBAL_WINDOW_BYTES - this.responseInFlightBytes();
          if (available <= 0) break;
          const end = Math.min(transfer.nextOffset + RELAY_BODY_CHUNK_BYTES, transfer.size, transfer.nextOffset + available);
          try {
            this.sendResponseFrame({ responseId: transfer.responseId, offset: transfer.nextOffset, bytes: transfer.data.subarray(transfer.nextOffset, end), final: end >= transfer.size });
          } catch (error) {
            this.abortResponse(transfer, error);
            continue;
          }
          transfer.nextOffset = end;
          progressed.add(transfer);
          advanced = true;
        }
      }
      for (const transfer of this.responses.values()) this.armResponseStallTimer(transfer, progressed.has(transfer));
    } finally {
      this.pumpingResponses = false;
    }
  }

  private responseInFlightBytes() {
    let bytes = 0;
    for (const transfer of this.responses.values()) bytes += transfer.nextOffset - transfer.acked;
    return bytes;
  }
  private sendResponseFrame(frame: RelayResponseFrame) {
    if (this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 2 * 1024 * 1024) throw relayError("RELAY_BACKPRESSURE_LIMIT");
    const plaintext = encodeRelayResponseFrame(frame);
    const sealed = nacl.secretbox(plaintext, nonce(2, this.sendCounter++), this.key);
    const wire = encodeRelayFrame({ kind: "data", sequence: this.sendSequence++, payload: sealed, flags: 0 });
    this.trace?.record({
      channelId: this.channelId,
      direction: "out",
      kind: "response-body",
      plaintext: Buffer.alloc(0),
      sealedBytes: sealed.byteLength,
      wireBytes: wire.byteLength,
      detail: { responseId: frame.responseId, offset: frame.offset, bytes: frame.bytes.byteLength, final: frame.final },
    });
    this.socket.send(wire);
  }
  private armResponseStallTimer(transfer: PendingRelayResponse, refresh = false) {
    if (transfer.nextOffset <= transfer.acked) {
      if (transfer.timer) clearTimeout(transfer.timer);
      transfer.timer = undefined;
      return;
    }
    // Silencing one response's idle timer must not happen just because another
    // response made progress on the shared channel.
    if (transfer.timer && !refresh) return;
    if (transfer.timer) clearTimeout(transfer.timer);
    transfer.timer = setTimeout(() => {
      if (this.responses.get(transfer.responseId) !== transfer) return;
      this.abortResponse(transfer, relayError("RELAY_RESPONSE_STALLED"));
    }, RELAY_RESPONSE_STALL_TIMEOUT_MS);
    transfer.timer.unref?.();
  }
  private acceptResponseAck(responseId: number, offset: number) {
    const transfer = this.responses.get(responseId);
    if (!transfer) return;
    if (offset <= transfer.acked || offset > transfer.size) return this.abortResponse(transfer, relayError("RELAY_RESPONSE_ACK_INVALID"));
    if (offset > transfer.nextOffset) return this.abortResponse(transfer, relayError("RELAY_RESPONSE_ACK_INVALID"));
    transfer.acked = offset;
    if (transfer.timer) clearTimeout(transfer.timer);
    transfer.timer = undefined;
    if (transfer.acked >= transfer.size) {
      this.finishResponse(transfer);
      this.pumpResponses();
      return;
    }
    this.pumpResponses();
  }
  private finishResponse(transfer: PendingRelayResponse) {
    if (this.responses.get(transfer.responseId) !== transfer) return;
    this.responses.delete(transfer.responseId);
    this.responseByRequest.delete(transfer.requestId);
    if (transfer.timer) clearTimeout(transfer.timer);
    transfer.timer = undefined;
    transfer.resolve();
  }
  private abortResponse(transfer: PendingRelayResponse, error: unknown) {
    if (this.responses.get(transfer.responseId) !== transfer) return;
    this.responses.delete(transfer.responseId);
    this.responseByRequest.delete(transfer.requestId);
    if (transfer.timer) clearTimeout(transfer.timer);
    transfer.timer = undefined;
    transfer.reject(error);
    // A cancelled or stalled response releases its share of the shared window.
    // Waiting responses may have no in-flight bytes and therefore no timer of
    // their own; without this pump they would wait for an unrelated ACK.
    this.pumpResponses();
  }
  private openBody(requestId: string, input: { bodyId: number; size: number }) {
    const stream = new PassThrough({ highWaterMark: RELAY_BODY_CHUNK_BYTES });
    // An early route rejection (for example a size limit) abandons the payload
    // while chunks may still be in flight; the no-op listener keeps a stray
    // write error from crashing the process, and `destroyed` stops those writes.
    stream.on("error", () => undefined);
    const assembly: RelayBodyAssembly = { bodyId: input.bodyId, requestId, size: input.size, received: 0, acknowledged: 0, drainBound: false, stream };
    assembly.timer = setTimeout(() => this.abortBody(assembly, "RELAY_BODY_IDLE_TIMEOUT"), RELAY_BODY_IDLE_TIMEOUT_MS);
    assembly.timer.unref?.();
    this.bodies.set(assembly.bodyId, assembly);
    this.bodyByRequest.set(requestId, assembly.bodyId);
    return assembly;
  }
  private acceptBodyChunk(chunk: RelayBodyFrame) {
    const assembly = this.bodies.get(chunk.bodyId);
    // A chunk that races a completed or aborted body is dropped: the sender
    // stops on the response, and a new request always gets a fresh body id.
    if (!assembly || assembly.stream.destroyed) return;
    // WebSocket/TCP already preserves ordering. A non-contiguous offset means
    // the peer violated this protocol, not that chunks need reordering.
    if (chunk.offset !== assembly.received) throw relayError("RELAY_BODY_OFFSET_INVALID");
    assembly.received += chunk.bytes.byteLength;
    if (assembly.received > assembly.size) throw relayError("RELAY_BODY_SIZE_MISMATCH");
    const writable = assembly.stream.write(chunk.bytes);
    if (assembly.timer) assembly.timer.refresh();
    assembly.pendingAck = assembly.received;
    if (writable) this.flushBodyAck(assembly);
    else this.armBodyDrain(assembly);
    if (chunk.final) {
      if (assembly.received !== assembly.size) throw relayError("RELAY_BODY_SIZE_MISMATCH");
      assembly.stream.end();
    }
  }
  private armBodyDrain(assembly: RelayBodyAssembly) {
    if (assembly.drainBound) return;
    assembly.drainBound = true;
    assembly.stream.once("drain", () => {
      assembly.drainBound = false;
      if (this.bodies.get(assembly.bodyId) !== assembly) return;
      this.flushBodyAck(assembly);
    });
  }
  private flushBodyAck(assembly: RelayBodyAssembly) {
    if (assembly.pendingAck === undefined || assembly.pendingAck <= assembly.acknowledged) return;
    assembly.acknowledged = assembly.pendingAck;
    assembly.pendingAck = undefined;
    this.send({ type: "body-ack", bodyId: assembly.bodyId, offset: assembly.acknowledged });
  }
  private closeBody(assembly: RelayBodyAssembly) {
    if (this.bodies.get(assembly.bodyId) !== assembly) return;
    this.bodies.delete(assembly.bodyId);
    this.bodyByRequest.delete(assembly.requestId);
    if (assembly.timer) clearTimeout(assembly.timer);
    if (!assembly.stream.destroyed) assembly.stream.destroy();
  }
  private abortBody(assembly: RelayBodyAssembly, reason: string) {
    if (this.bodies.get(assembly.bodyId) !== assembly) return;
    this.bodies.delete(assembly.bodyId);
    this.bodyByRequest.delete(assembly.requestId);
    if (assembly.timer) clearTimeout(assembly.timer);
    // Destroying with an error rejects the pending `inject`, which unwinds the
    // local route and the controlled-instance draft it was streaming into.
    if (!assembly.stream.destroyed) assembly.stream.destroy(relayError(reason));
  }
}

function relayRoleProofPayload(grant: RelaySessionGrant): RelayRoleProofPayload {
  return {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    role: "control-plane",
    sessionId: grant.sessionId,
    grantId: grant.grantId,
    generation: grant.generation,
    allocationId: grant.allocationId,
    relayId: grant.relayId,
    nonce: Buffer.from(nacl.randomBytes(24)).toString("base64url"),
    issuedAt: new Date().toISOString(),
  };
}

// Relay trust follows the environment bound to the persisted service origin:
// registered environments use their declared Relay hosts, ad-hoc local clouds keep
// the legacy "same host, plain ws allowed over HTTP" behaviour.
export function trustedRelayUrl(url: URL, serviceOrigin: string) {
  return isTrustedCloudRelayUrl(cloudEnvironmentForServiceOrigin(serviceOrigin), url);
}
function startRelayHeartbeat(socket: WebSocket, intervalOption?: number, timeoutOption?: number) {
  const intervalMs = positiveDuration(intervalOption, RELAY_HEARTBEAT_INTERVAL_MS);
  const timeoutMs = positiveDuration(timeoutOption, RELAY_HEARTBEAT_TIMEOUT_MS);
  let closed = false;
  let pingTimer: ReturnType<typeof setTimeout> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;
  function cleanup() {
    if (closed) return;
    closed = true;
    if (pingTimer) clearTimeout(pingTimer);
    if (pongTimer) clearTimeout(pongTimer);
    pingTimer = undefined;
    pongTimer = undefined;
    socket.off("pong", onPong);
    socket.off("close", cleanup);
    socket.off("error", cleanup);
  }
  function fail() {
    cleanup();
    try { socket.terminate(); }
    catch { if (socket.readyState < WebSocket.CLOSING) socket.close(4408, "heartbeat-timeout"); }
  }
  function schedulePing() {
    if (closed) return;
    pingTimer = setTimeout(() => {
      pingTimer = undefined;
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      try { socket.ping(); }
      catch { fail(); return; }
      pongTimer = setTimeout(fail, timeoutMs);
      unrefTimer(pongTimer);
    }, intervalMs);
    unrefTimer(pingTimer);
  }
  function onPong() {
    if (closed || !pongTimer) return;
    clearTimeout(pongTimer);
    pongTimer = undefined;
    schedulePing();
  }
  socket.on("pong", onPong);
  socket.once("close", cleanup);
  socket.once("error", cleanup);
  schedulePing();
}
function positiveDuration(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}
function unrefTimer(timer: ReturnType<typeof setTimeout>) { (timer as unknown as { unref?(): void }).unref?.(); }
function socketOpen(socket: WebSocket) { return new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); socket.once("close", (code, reason) => reject(relaySocketClosedError(code, reason))); }); }
function socketMessage(socket: WebSocket, predicate: (value: any) => boolean, timeoutMs: number) {
  return new Promise<any>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const value = JSON.parse(raw.toString());
        if (predicate(value)) finish(() => resolve(value));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    const onClose = (code: number, reason: Buffer) => finish(() => reject(relaySocketClosedError(code, reason)));
    const timer = setTimeout(() => finish(() => reject(Object.assign(new Error("Cloud Relay attach timed out."), {
      code: "RELAY_ATTACH_TIMEOUT",
      retryable: true,
    }))), timeoutMs);
    unrefTimer(timer);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}
function socketFrame(socket: WebSocket, predicate: (frame: RelayFramePayload) => boolean, timeoutMs: number) {
  return new Promise<RelayFramePayload>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onMessage = (raw: WebSocket.RawData, isBinary: boolean) => {
      try {
        if (!isBinary) throw relayError("RELAY_FRAME_ENCODING_INVALID");
        const frame = decodeRelayFrame(rawBytes(raw));
        if (predicate(frame)) finish(() => resolve(frame));
      } catch (error) { finish(() => reject(error)); }
    };
    const onClose = (code: number, reason: Buffer) => finish(() => reject(relaySocketClosedError(code, reason)));
    const timer = setTimeout(() => finish(() => reject(Object.assign(new Error("Cloud Relay encrypted handshake timed out."), {
      code: "RELAY_HANDSHAKE_TIMEOUT",
      retryable: true,
    }))), timeoutMs);
    unrefTimer(timer);
    const cleanup = () => { clearTimeout(timer); socket.off("message", onMessage); socket.off("close", onClose); };
    socket.on("message", onMessage); socket.once("close", onClose);
  });
}
function rawBytes(raw: WebSocket.RawData) { return Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer); }
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
function sameOptional<T>(left: T | undefined, right: T | undefined) { return left === right; }
function nonce(direction: number, counter: number) { const value = new Uint8Array(24); value[0] = direction; new DataView(value.buffer).setBigUint64(16, BigInt(counter), false); return value; }
function relayError(code: string) { return Object.assign(new Error("Cloud Relay session is invalid."), { code, retryable: true }); }
function relaySocketClosedError(code?: number, reason?: Buffer) {
  const closeReason = boundedText(reason?.toString(), 120);
  const detail = Number.isFinite(code) ? `${code}${closeReason ? `: ${closeReason}` : ""}` : closeReason || "unknown";
  return Object.assign(new Error(`Cloud Relay closed the session (${detail}).`), {
    code: "RELAY_SOCKET_CLOSED",
    retryable: true,
    ...(Number.isFinite(code) ? { relayCloseCode: code } : {}),
    ...(closeReason ? { relayCloseReason: closeReason } : {}),
  });
}
