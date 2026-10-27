import crypto from "node:crypto";
import nacl from "tweetnacl";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { z } from "zod";
import { decodeRelayFrame, encodeRelayFrame, packRelayPayload, unpackRelayPayload, RELAY_FRAME_HEADER_BYTES, type RelayFramePayload } from "@task-handoff/cloud-contracts";
import {
  NODE_RELAY_CHANNEL_PROTOCOL_VERSION,
  NODE_RELAY_HANDSHAKE_AUDIENCE,
  NODE_RELAY_DATA_HEADER_BYTES,
  NODE_RELAY_DATA_MAX_BYTES,
  NODE_RELAY_DATA_MAX_MESSAGE_BYTES,
  decodeNodeRelayDataFrame,
  encodeNodeRelayDataFrame,
  isNodeRelayDataFrame,
  NodeRelayHandshakeAcceptPayloadSchema,
  NodeRelayHandshakeAcceptSchema,
  NodeRelayHandshakeInitPayloadSchema,
  NodeRelayHandshakeInitSchema,
  NodeRelaySessionMessageSchema,
  NodeRelayPairingEnvelopeSchema,
  NodeAgentControlPlaneTrustOutcomePayloadSchema,
  NodeAgentControlPlaneTrustOutcomeSchema,
  formatNodeAgentControlPlaneComparisonCode,
  nodeAgentControlPlaneComparisonCodeInput,
  nodeAgentControlPlaneTrustSigningInput,
  nodeRelayHandshakeAcceptSigningInput,
  nodeRelayHandshakeSigningInput,
  nodeRelayPairingTranscript,
  type NodeAgentControlPlaneAccessContext,
  type NodeAgentControlPlaneTrustOutcome,
  type NodeRelayDataFrame,
  type NodeRelaySessionMessage,
} from "@task-handoff/protocol/node-relay-channel";

/**
 * One side of a cloud-relay node channel, below the tunnel protocol and above
 * the raw Relay socket. The Relay only ever sees fixed-header frames; every
 * byte after the handshake is sealed end to end with the X25519 session key
 * derived by the two peers, and the pairing HMAC ties reconnects to the secret
 * the Control Plane pinned when it first claimed the node.
 */
export type NodeRelayFrameSocket = {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (raw: unknown, isBinary: boolean) => void): void;
  on(event: "close", listener: (code?: number, reason?: unknown) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
  off?(event: string, listener: (...args: any[]) => void): void;
  readyState?: number;
  bufferedAmount?: number;
};

type NodeRelayDataAssembly = {
  streamId: number;
  binary: boolean;
  bytes: number;
  sealedBytes: number;
  wireBytes: number;
  fragments: number;
  chunks: Uint8Array[];
  timer?: ReturnType<typeof setTimeout>;
};

type PendingNodeRelayWrite = { payload: Uint8Array; flags: number; bytes: number };

const NODE_RELAY_SOCKET_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const NODE_RELAY_SOCKET_MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const NODE_RELAY_DATA_MAX_ASSEMBLIES = 8;
const NODE_RELAY_DATA_MAX_ASSEMBLED_BYTES = 16 * 1024 * 1024;
const NODE_RELAY_DATA_ASSEMBLY_IDLE_MS = 30_000;
const NODE_RELAY_SECRETBOX_OVERHEAD_BYTES = 16;

export type NodeRelayDataAssemblyLimits = {
  maxStreams?: number;
  maxBytes?: number;
  idleMs?: number;
};

/** One decoded logical frame with the exact relay-frame bytes it occupied. */
export type NodeRelayTraceEvent = {
  direction: "in" | "out";
  kind: string;
  plaintext: Uint8Array;
  sealedBytes: number;
  wireBytes: number;
  detail?: Record<string, unknown>;
};

/** Direction bytes keep the two senders' secretbox counters in disjoint nonce spaces. */
export const NODE_RELAY_DIRECTION_NODE = 1;
export const NODE_RELAY_DIRECTION_CONTROL_PLANE = 2;

export class NodeRelaySessionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message = "Cloud relay node channel is invalid.") {
    super(message);
    this.code = code;
    this.retryable = true;
  }
}

export function nodeRelaySessionError(code: string, message?: string) {
  return new NodeRelaySessionError(code, message);
}

function rawBytes(raw: unknown) {
  if (typeof raw === "string") return Buffer.from(raw, "utf8");
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return bufferView(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw.map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(item))));
  return Buffer.from(raw as ArrayBuffer);
}

function bufferView(value: Uint8Array) {
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
}

/** Writes the single plaintext handshake frame; it must be the sender's sequence 0. */
export function writeNodeRelayHandshakeFrame(socket: NodeRelayFrameSocket, message: Record<string, unknown>) {
  socket.send(encodeRelayFrame({ kind: "handshake", sequence: 0, payload: Buffer.from(JSON.stringify(message)) }));
}

/** Reads frames until the peer's handshake frame arrives; a data frame before it is a protocol error. */
export function readNodeRelayHandshakeFrame(socket: NodeRelayFrameSocket, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      socket.off?.("message", onMessage);
      socket.off?.("close", onClose);
      socket.off?.("error", onError);
    };
    const timer = setTimeout(() => { if (settled) return; cleanup(); reject(nodeRelaySessionError("NODE_RELAY_HANDSHAKE_TIMEOUT")); }, timeoutMs);
    timer.unref?.();
    const onMessage = (raw: unknown, isBinary: boolean) => {
      if (settled) return;
      try {
        if (!isBinary) throw nodeRelaySessionError("NODE_RELAY_FRAME_ENCODING_INVALID");
        const frame = decodeRelayFrame(rawBytes(raw));
        if (frame.kind !== "handshake") throw nodeRelaySessionError("NODE_RELAY_HANDSHAKE_EXPECTED");
        if (frame.sequence !== 0) throw nodeRelaySessionError("NODE_RELAY_HANDSHAKE_SEQUENCE_INVALID");
        const message = JSON.parse(Buffer.from(frame.payload).toString("utf8")) as Record<string, unknown>;
        cleanup();
        resolve(message);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onClose = () => { if (settled) return; cleanup(); reject(nodeRelaySessionError("NODE_RELAY_CHANNEL_CLOSED")); };
    const onError = (error: unknown) => { if (settled) return; cleanup(); reject(error instanceof Error ? error : nodeRelaySessionError("NODE_RELAY_CHANNEL_ERROR")); };
    socket.on("message", onMessage);
    socket.on("close", onClose);
    socket.on("error", onError);
  });
}

export function nodeRelayFingerprint(publicKey: string) {
  return `sha256:${crypto.createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url")}`;
}

export function nodeAgentControlPlaneComparisonCode(controlPlaneId: string, publicKey: string) {
  const digest = crypto.createHash("sha256").update(nodeAgentControlPlaneComparisonCodeInput(controlPlaneId, publicKey)).digest();
  return formatNodeAgentControlPlaneComparisonCode(digest);
}

export function writeNodeAgentControlPlaneTrustOutcome(options: {
  socket: NodeRelayFrameSocket;
  node: { publicKey: string; sign(input: string): string };
  outcome: z.input<typeof NodeAgentControlPlaneTrustOutcomePayloadSchema>;
}) {
  const outcome = NodeAgentControlPlaneTrustOutcomePayloadSchema.parse(options.outcome);
  writeNodeRelayHandshakeFrame(options.socket, {
    ...outcome,
    signature: options.node.sign(nodeAgentControlPlaneTrustSigningInput(outcome)),
  });
  return outcome;
}

export function verifyNodeAgentControlPlaneTrustOutcome(options: {
  outcome: unknown;
  expectation: NodeRelayHandshakeExpectation;
  now?: number;
}): NodeAgentControlPlaneTrustOutcome {
  const parsed = NodeAgentControlPlaneTrustOutcomeSchema.safeParse(options.outcome);
  if (!parsed.success) throw nodeRelaySessionError("NODE_AGENT_CONTROL_PLANE_TRUST_OUTCOME_INVALID");
  const { signature, ...outcome } = parsed.data;
  if (nodeRelayFingerprint(outcome.nodePublicKey) !== outcome.nodePublicKeyFingerprint ||
      outcome.nodePublicKeyFingerprint !== options.expectation.nodePublicKeyFingerprint) {
    throw nodeRelaySessionError("NODE_AGENT_CONTROL_PLANE_TRUST_NODE_KEY_MISMATCH");
  }
  const expected = options.expectation;
  if (outcome.allocationId !== expected.allocationId || outcome.relayId !== expected.relayId ||
      outcome.nodeHandle !== expected.nodeHandle || outcome.controlPlaneId !== expected.controlPlaneId ||
      outcome.bindingId !== expected.bindingId || outcome.bindingRevision !== expected.bindingRevision ||
      outcome.controlPlanePublicKeyFingerprint !== nodeRelayFingerprint(expected.controlPlanePublicKey)) {
    throw nodeRelaySessionError("NODE_AGENT_CONTROL_PLANE_TRUST_OUTCOME_MISMATCH");
  }
  const expectedAccess = normalizedAccessContext(expected);
  if (!sameAccessContext(outcome.access, expectedAccess)) {
    throw nodeRelaySessionError("NODE_AGENT_CONTROL_PLANE_TRUST_ACCESS_MISMATCH");
  }
  const now = options.now ?? Date.now();
  if (Date.parse(outcome.issuedAt) > now + 60_000 || (outcome.expiresAt && outcome.state === "pending" && Date.parse(outcome.expiresAt) <= now)) {
    throw nodeRelaySessionError("NODE_AGENT_CONTROL_PLANE_TRUST_OUTCOME_EXPIRED");
  }
  let verified = false;
  try {
    verified = crypto.verify(
      null,
      Buffer.from(nodeAgentControlPlaneTrustSigningInput(outcome)),
      crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: outcome.nodePublicKey }, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    verified = false;
  }
  if (!verified) throw nodeRelaySessionError("NODE_AGENT_CONTROL_PLANE_TRUST_OUTCOME_SIGNATURE_INVALID");
  return parsed.data;
}

/**
 * The pairing envelope uses a key derived from the session key and a fresh
 * (per-key, single-use) zero nonce, so it can never collide with the ordered
 * data-frame nonce space on the same session key.
 */
function pairingEnvelopeKey(sessionKey: Uint8Array) {
  return crypto.createHmac("sha256", Buffer.from(sessionKey)).update("task-handoff:node-relay-pairing-envelope:v1").digest().subarray(0, 32);
}

export function sealNodeRelayPairing(sessionKey: Uint8Array, pairing: { keyId: string; secret: string }) {
  const plaintext = Buffer.from(JSON.stringify(NodeRelayPairingEnvelopeSchema.parse({ type: "pairing-envelope", keyId: pairing.keyId, secret: pairing.secret })));
  return Buffer.from(nacl.secretbox(plaintext, new Uint8Array(24), pairingEnvelopeKey(sessionKey))).toString("base64url");
}

export function openNodeRelayPairing(sessionKey: Uint8Array, sealed: string) {
  const opened = nacl.secretbox.open(Buffer.from(sealed, "base64url"), new Uint8Array(24), pairingEnvelopeKey(sessionKey));
  if (!opened) throw nodeRelaySessionError("NODE_RELAY_PAIRING_ENVELOPE_INVALID");
  return NodeRelayPairingEnvelopeSchema.parse(JSON.parse(Buffer.from(opened).toString("utf8")));
}

export type NodeRelayHandshakeExpectation = {
  allocationId: string;
  relayId: string;
  nodeHandle: string;
  controlPlaneId: string;
  controlPlanePublicKey: string;
  accountId: string;
  ownerAccountId?: string;
  accessMode?: "owner" | "shared";
  shareGrantId?: string;
  shareRole?: "use";
  shareRevision?: number;
  bindingId: string;
  bindingRevision: number;
  nodePublicKeyFingerprint: string;
  now?: () => number;
};

export type AcceptNodeRelayHandshakeResult =
  | { status: "accepted"; init: ReturnType<typeof NodeRelayHandshakeInitPayloadSchema.parse>; key: Uint8Array; paired: boolean; issuedPairing?: { keyId: string; secret: string } }
  | { status: "trust-required"; outcome: NodeAgentControlPlaneTrustOutcome };

function normalizedAccessContext(expectation: NodeRelayHandshakeExpectation): NodeAgentControlPlaneAccessContext {
  const accessMode = expectation.accessMode ?? "owner";
  const ownerAccountId = expectation.ownerAccountId ?? expectation.accountId;
  return {
    accountId: expectation.accountId,
    ownerAccountId,
    accessMode,
    ...(accessMode === "shared" && expectation.shareGrantId ? { shareGrantId: expectation.shareGrantId } : {}),
    ...(accessMode === "shared" && expectation.shareRole ? { shareRole: expectation.shareRole } : {}),
    ...(accessMode === "shared" && expectation.shareRevision ? { shareRevision: expectation.shareRevision } : {}),
  };
}

function sameAccessContext(left: NodeAgentControlPlaneAccessContext, right: NodeAgentControlPlaneAccessContext) {
  return left.accountId === right.accountId
    && left.ownerAccountId === right.ownerAccountId
    && left.accessMode === right.accessMode
    && left.shareGrantId === right.shareGrantId
    && left.shareRole === right.shareRole
    && left.shareRevision === right.shareRevision;
}

/**
 * Control Plane side of the handshake: waits for the node's signed hello,
 * verifies key possession against the claimed fingerprint, answers with the
 * Control Plane's cloud identity signature, and derives the session key.
 */
export async function acceptNodeRelayHandshake(options: {
  socket: NodeRelayFrameSocket;
  identity: { controlPlaneId: string; publicKey: string; /** Signs the given signing input text. */ signNodeRelayHandshake(input: string): string };
  expectation: NodeRelayHandshakeExpectation;
  pairing?: { keyId: string; secret: string };
  /** Called when this channel must pin a new pairing (first claim, or a lost record). */
  createPairing?: () => { keyId: string; secret: string };
  timeoutMs?: number;
}): Promise<AcceptNodeRelayHandshakeResult> {
  const now = (options.expectation.now ?? Date.now)();
  const raw = await readNodeRelayHandshakeFrame(options.socket, options.timeoutMs);
  if (NodeAgentControlPlaneTrustOutcomeSchema.safeParse(raw).success) {
    return {
      status: "trust-required",
      outcome: verifyNodeAgentControlPlaneTrustOutcome({ outcome: raw, expectation: options.expectation, now }),
    };
  }
  const parsed = NodeRelayHandshakeInitSchema.safeParse(raw);
  if (!parsed.success) throw nodeRelaySessionError("NODE_RELAY_HANDSHAKE_INVALID");
  const { signature, ...init } = parsed.data;
  const expected = options.expectation;
  if (init.controlPlaneId !== expected.controlPlaneId || init.allocationId !== expected.allocationId || init.relayId !== expected.relayId ||
      init.nodeHandle !== expected.nodeHandle || init.accountId !== expected.accountId || init.bindingId !== expected.bindingId ||
      init.bindingRevision !== expected.bindingRevision || Date.parse(init.expiresAt) <= now) throw nodeRelaySessionError("NODE_RELAY_HANDSHAKE_MISMATCH");
  if (nodeRelayFingerprint(init.nodePublicKey) !== expected.nodePublicKeyFingerprint) throw nodeRelaySessionError("NODE_RELAY_NODE_KEY_MISMATCH");
  const verified = crypto.verify(null, Buffer.from(nodeRelayHandshakeSigningInput(init)), crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: init.nodePublicKey }, format: "jwk" }), Buffer.from(signature, "base64url"));
  if (!verified) throw nodeRelaySessionError("NODE_RELAY_HANDSHAKE_SIGNATURE_INVALID");
  let paired = false;
  if (init.pairedHmac) {
    // A Control Plane that lost its pairing record cannot verify the proof; the
    // grant and the node's key signature still authorize a fresh enrollment.
    if (options.pairing) {
      if (init.pairedKeyId !== options.pairing.keyId) throw nodeRelaySessionError("NODE_RELAY_PAIRING_INVALID");
      const expectedHmac = crypto.createHmac("sha256", Buffer.from(options.pairing.secret, "base64url")).update(nodeRelayPairingTranscript(init)).digest("base64url");
      if (!crypto.timingSafeEqual(Buffer.from(expectedHmac), Buffer.from(init.pairedHmac))) throw nodeRelaySessionError("NODE_RELAY_PAIRING_INVALID");
      paired = true;
    }
  }
  const ephemeral = nacl.box.keyPair();
  const key = nacl.box.before(Buffer.from(init.nodeEphemeralPublicKey, "base64url"), ephemeral.secretKey);
  const issuedPairing = paired ? undefined : options.createPairing?.();
  const acceptPayload = NodeRelayHandshakeAcceptPayloadSchema.parse({
    type: "node-relay.handshake-accept",
    protocolVersion: init.protocolVersion,
    audience: init.audience,
    allocationId: init.allocationId,
    nodeHandle: init.nodeHandle,
    controlPlaneId: init.controlPlaneId,
    controlPlanePublicKey: options.identity.publicKey,
    controlPlaneEphemeralPublicKey: Buffer.from(ephemeral.publicKey).toString("base64url"),
    nonce: crypto.randomBytes(24).toString("base64url"),
    issuedAt: new Date(now).toISOString(),
    ...(issuedPairing ? { encryptedPairing: sealNodeRelayPairing(key, issuedPairing) } : {}),
  });
  writeNodeRelayHandshakeFrame(options.socket, { ...acceptPayload, signature: options.identity.signNodeRelayHandshake(nodeRelayHandshakeAcceptSigningInput(acceptPayload)) });
  return { status: "accepted", init, key, paired, ...(issuedPairing ? { issuedPairing } : {}) };
}

/**
 * Node side of the handshake: signs the hello with the relay key the cloud
 * registered at redemption, proves the stored pairing on reconnects, and
 * verifies the answering Control Plane against the key pinned in the grant.
 */
export async function initiateNodeRelayHandshake(options: {
  socket: NodeRelayFrameSocket;
  grant: { allocationId: string; relayId: string; nodeHandle: string; controlPlaneId: string; accountId: string; bindingId: string; bindingRevision: number; controlPlanePublicKey: string };
  node: { nodeId: string; publicKey: string; /** Signs the given signing input text. */ sign(input: string): string };
  pairing?: { keyId: string; secret: string };
  timeoutMs?: number;
  now?: () => number;
}): Promise<{ init: ReturnType<typeof NodeRelayHandshakeInitPayloadSchema.parse>; accept: ReturnType<typeof NodeRelayHandshakeAcceptPayloadSchema.parse>; key: Uint8Array; paired: boolean; pairing?: { keyId: string; secret: string } }> {
  const now = (options.now ?? Date.now)();
  if (!options.grant.controlPlanePublicKey) throw nodeRelaySessionError("NODE_RELAY_GRANT_KEY_MISSING");
  const ephemeral = nacl.box.keyPair();
  const base = {
    type: "node-relay.handshake-init" as const,
    protocolVersion: NODE_RELAY_CHANNEL_PROTOCOL_VERSION,
    audience: NODE_RELAY_HANDSHAKE_AUDIENCE,
    allocationId: options.grant.allocationId,
    relayId: options.grant.relayId,
    nodeHandle: options.grant.nodeHandle,
    controlPlaneId: options.grant.controlPlaneId,
    accountId: options.grant.accountId,
    bindingId: options.grant.bindingId,
    bindingRevision: options.grant.bindingRevision,
    nodeId: options.node.nodeId,
    nodePublicKey: options.node.publicKey,
    nodeEphemeralPublicKey: Buffer.from(ephemeral.publicKey).toString("base64url"),
    nonce: crypto.randomBytes(24).toString("base64url"),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5 * 60_000).toISOString(),
    ...(options.pairing ? { pairedKeyId: options.pairing.keyId } : {}),
  };
  const unsigned = NodeRelayHandshakeInitPayloadSchema.parse(options.pairing
    ? { ...base, pairedHmac: crypto.createHmac("sha256", Buffer.from(options.pairing.secret, "base64url")).update(nodeRelayPairingTranscript({ ...base })).digest("base64url") }
    : base);
  writeNodeRelayHandshakeFrame(options.socket, { ...unsigned, signature: options.node.sign(nodeRelayHandshakeSigningInput(unsigned)) });
  const raw = await readNodeRelayHandshakeFrame(options.socket, options.timeoutMs);
  const parsed = NodeRelayHandshakeAcceptSchema.safeParse(raw);
  if (!parsed.success) throw nodeRelaySessionError("NODE_RELAY_HANDSHAKE_INVALID");
  const { signature, ...accept } = parsed.data;
  if (accept.controlPlaneId !== options.grant.controlPlaneId || accept.allocationId !== options.grant.allocationId || accept.nodeHandle !== options.grant.nodeHandle ||
      accept.controlPlanePublicKey !== options.grant.controlPlanePublicKey) throw nodeRelaySessionError("NODE_RELAY_HANDSHAKE_MISMATCH");
  const verified = crypto.verify(null, Buffer.from(nodeRelayHandshakeAcceptSigningInput(accept)), crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: accept.controlPlanePublicKey }, format: "jwk" }), Buffer.from(signature, "base64url"));
  if (!verified) throw nodeRelaySessionError("NODE_RELAY_HANDSHAKE_SIGNATURE_INVALID");
  const key = nacl.box.before(Buffer.from(accept.controlPlaneEphemeralPublicKey, "base64url"), ephemeral.secretKey);
  const issued = accept.encryptedPairing ? openNodeRelayPairing(key, accept.encryptedPairing) : undefined;
  return { init: unsigned, accept, key, paired: Boolean(unsigned.pairedHmac), ...(issued ? { pairing: { keyId: issued.keyId, secret: issued.secret } } : {}) };
}

function sequenceNonce(direction: number, counter: number) {
  const value = new Uint8Array(24);
  value[0] = direction;
  new DataView(value.buffer).setBigUint64(16, BigInt(counter), false);
  return value;
}

/**
 * Sealed, ordered transport over an attached Relay socket. The first data
 * frame of each direction carries sequence 1; the handshake consumed 0.
 * Control messages remain compact JSON and are deflate-packed when that is
 * smaller. Tunnel payloads use the binary frame format from the protocol
 * package and skip JSON/base64/deflate entirely.
 */
export class EncryptedNodeRelayChannel {
  private sendSequence = 1;
  private sendCounter = 0;
  private receiveSequence = 1;
  private receiveCounter = 0;
  private started = false;
  private closed = false;
  private readonly dataAssemblies = new Map<number, NodeRelayDataAssembly>();
  private readonly outboundControl: PendingNodeRelayWrite[] = [];
  private readonly outboundData: PendingNodeRelayWrite[] = [];
  private readonly outboundCapacityWaiters: Array<() => void> = [];
  private outboundBytes = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private readonly socket: NodeRelayFrameSocket;
  private readonly key: Uint8Array;
  private readonly sendDirection: number;
  private readonly receiveDirection: number;
  private readonly onMessage: (message: NodeRelaySessionMessage) => void | Promise<void>;
  private readonly onData?: (frame: NodeRelayDataFrame) => void | Promise<void>;
  private readonly onClosed?: (reason: string) => void;
  private readonly onError?: (error: Error) => void;
  private readonly onTrace?: (event: NodeRelayTraceEvent) => void;
  private readonly dataAssemblyMaxStreams: number;
  private readonly dataAssemblyMaxBytes: number;
  private readonly dataAssemblyIdleMs: number;

  constructor(options: {
    socket: NodeRelayFrameSocket;
    key: Uint8Array;
    sendDirection: number;
    receiveDirection: number;
    onMessage(message: NodeRelaySessionMessage): void | Promise<void>;
    onData?(frame: NodeRelayDataFrame): void | Promise<void>;
    onClosed?(reason: string): void;
    onError?(error: Error): void;
    onTrace?(event: NodeRelayTraceEvent): void;
    dataAssemblyLimits?: NodeRelayDataAssemblyLimits;
  }) {
    this.socket = options.socket;
    this.key = options.key;
    this.sendDirection = options.sendDirection;
    this.receiveDirection = options.receiveDirection;
    this.onMessage = options.onMessage;
    this.onData = options.onData;
    this.onClosed = options.onClosed;
    this.onError = options.onError;
    this.onTrace = options.onTrace;
    this.dataAssemblyMaxStreams = positiveInteger(options.dataAssemblyLimits?.maxStreams, NODE_RELAY_DATA_MAX_ASSEMBLIES);
    this.dataAssemblyMaxBytes = positiveInteger(options.dataAssemblyLimits?.maxBytes, NODE_RELAY_DATA_MAX_ASSEMBLED_BYTES);
    this.dataAssemblyIdleMs = positiveInteger(options.dataAssemblyLimits?.idleMs, NODE_RELAY_DATA_ASSEMBLY_IDLE_MS);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.socket.on("message", (raw, isBinary) => { void this.receive(raw, isBinary).catch((error) => this.fail(error)); });
    this.socket.on("close", () => this.finish("channel-closed"));
    this.socket.on("error", (error) => this.fail(error));
  }

  send(message: NodeRelaySessionMessage) {
    const parsed = NodeRelaySessionMessageSchema.parse(message);
    const plaintext = Buffer.from(JSON.stringify(parsed));
    const packed = packRelayPayload(plaintext, (input) => deflateRawSync(input));
    // Most control frames are small but latency-sensitive: channel accepts,
    // stream resumes and heartbeats must not sit behind a multi-megabyte data
    // burst. `channel-close` is ordered with data so a close cannot overtake
    // bytes already accepted from the local stream.
    this.enqueuePlaintext(packed.payload, packed.flags, parsed.type !== "channel-close");
    const sealedBytes = packed.payload.byteLength + NODE_RELAY_SECRETBOX_OVERHEAD_BYTES;
    this.emitTrace({
      direction: "out",
      kind: parsed.type,
      plaintext,
      sealedBytes,
      wireBytes: sealedBytes + RELAY_FRAME_HEADER_BYTES,
      detail: {
        flags: packed.flags,
        ...("streamId" in parsed ? { streamId: parsed.streamId } : {}),
        ...("channelId" in parsed ? { channelId: parsed.channelId } : {}),
      },
    });
  }

  /** Sends one tunnel payload without JSON or base64; text frames use outer-frame deflate when it shrinks them. */
  sendData(streamId: number, data: string | Uint8Array, binary: boolean) {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : bufferView(data);
    if (bytes.byteLength > NODE_RELAY_DATA_MAX_MESSAGE_BYTES) throw nodeRelaySessionError("NODE_RELAY_DATA_MESSAGE_TOO_LARGE");
    if (bytes.byteLength === 0) {
      this.enqueuePlaintext(encodeNodeRelayDataFrame({ streamId, data: bytes, binary, more: false }), 0, false);
      this.traceData("out", streamId, bytes, binary, 1);
      return;
    }
    // Reserve the whole logical message before enqueueing its first fragment.
    // Otherwise a queue-limit failure mid-message leaves the receiver waiting
    // for a final fragment that can never be sent.
    const fragments = Math.ceil(bytes.byteLength / NODE_RELAY_DATA_MAX_BYTES);
    const wireBytes = bytes.byteLength + fragments * (NODE_RELAY_DATA_HEADER_BYTES + 40);
    if (this.outboundBytes + wireBytes > NODE_RELAY_SOCKET_MAX_QUEUED_BYTES) throw nodeRelaySessionError("NODE_RELAY_BACKPRESSURE_LIMIT");
    let sealedBytes = 0;
    let measuredWireBytes = 0;
    let compressedFragments = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += NODE_RELAY_DATA_MAX_BYTES) {
      const end = Math.min(offset + NODE_RELAY_DATA_MAX_BYTES, bytes.byteLength);
      const plaintext = encodeNodeRelayDataFrame({ streamId, data: bytes.subarray(offset, end), binary, more: end < bytes.byteLength });
      // JSON event and HTTP payloads dominate relay traffic and compress well.
      // Binary tunnel data usually carries already-compressed app content, so
      // paying another deflate pass there only adds latency.
      const packed = binary ? { payload: plaintext, flags: 0 } : packRelayPayload(plaintext, (input) => deflateRawSync(input));
      this.enqueuePlaintext(packed.payload, packed.flags, false);
      sealedBytes += packed.payload.byteLength + NODE_RELAY_SECRETBOX_OVERHEAD_BYTES;
      measuredWireBytes += packed.payload.byteLength + NODE_RELAY_SECRETBOX_OVERHEAD_BYTES + RELAY_FRAME_HEADER_BYTES;
      if (packed.flags) compressedFragments += 1;
    }
    this.traceData("out", streamId, bytes, binary, fragments, { sealedBytes, wireBytes: measuredWireBytes, compressedFragments });
  }

  close(reason = "normal") {
    if (this.closed) return;
    this.finish(reason);
    try {
      if (this.socket.readyState === undefined || this.socket.readyState < 2) this.socket.close(1000, String(reason).slice(0, 120));
    } catch {
      // The socket may already be gone; the local state is finalized regardless.
    }
  }

  /**
   * Large HTTP/WebSocket streams read from local disk or memory much faster
   * than a cloud link drains. Pause those readers at a small queue high-water
   * mark instead of letting them fill the hard 16 MiB safety limit and fail.
   */
  waitForOutboundCapacity() {
    if (this.closed || this.outboundBytes <= NODE_RELAY_SOCKET_MAX_BUFFERED_BYTES) return Promise.resolve();
    return new Promise<void>((resolve) => this.outboundCapacityWaiters.push(resolve));
  }

  /** Drops a partial message when its multiplexed stream is closed. */
  discardDataAssembly(streamId: number) {
    const assembly = this.dataAssemblies.get(streamId);
    if (!assembly) return;
    if (assembly.timer) clearTimeout(assembly.timer);
    this.dataAssemblies.delete(streamId);
  }

  private async receive(raw: unknown, isBinary: boolean) {
    if (this.closed) return;
    if (!isBinary) throw nodeRelaySessionError("NODE_RELAY_FRAME_ENCODING_INVALID");
    const rawFrame = rawBytes(raw);
    const wireBytes = rawFrame.byteLength;
    const frame: RelayFramePayload = decodeRelayFrame(rawFrame);
    if (frame.kind === "close") return this.finish("peer-closed");
    if (frame.kind !== "data") throw nodeRelaySessionError("NODE_RELAY_FRAME_KIND_INVALID");
    if (frame.sequence !== this.receiveSequence++) throw nodeRelaySessionError("NODE_RELAY_FRAME_SEQUENCE_INVALID");
    const opened = nacl.secretbox.open(frame.payload, sequenceNonce(this.receiveDirection, this.receiveCounter++), this.key);
    if (!opened) throw nodeRelaySessionError("NODE_RELAY_DECRYPT_FAILED");
    const plaintext = unpackRelayPayload(bufferView(opened), frame.flags ?? 0, (input) => inflateRawSync(input));
    if (isNodeRelayDataFrame(plaintext)) {
      if (!this.onData) throw nodeRelaySessionError("NODE_RELAY_DATA_FRAME_UNSUPPORTED");
      const dataFrame = decodeNodeRelayDataFrame(plaintext);
      if (dataFrame.more) {
        const assembly = this.dataAssemblies.get(dataFrame.streamId);
        if (assembly && assembly.binary !== dataFrame.binary) throw nodeRelaySessionError("NODE_RELAY_DATA_FRAGMENT_INVALID");
        if (!assembly && this.dataAssemblies.size >= this.dataAssemblyMaxStreams) {
          throw nodeRelaySessionError("NODE_RELAY_DATA_ASSEMBLY_LIMIT");
        }
        if (this.assembledBytes() + dataFrame.data.byteLength > this.dataAssemblyMaxBytes) {
          throw nodeRelaySessionError("NODE_RELAY_DATA_ASSEMBLY_BYTES_LIMIT");
        }
        const next = assembly ?? this.beginDataAssembly(dataFrame.streamId, dataFrame.binary);
        next.bytes += dataFrame.data.byteLength;
        next.sealedBytes += frame.payload.byteLength;
        next.wireBytes += wireBytes;
        next.fragments += 1;
        if (next.bytes > NODE_RELAY_DATA_MAX_MESSAGE_BYTES) throw nodeRelaySessionError("NODE_RELAY_DATA_MESSAGE_TOO_LARGE");
        next.chunks.push(dataFrame.data);
        this.armDataAssemblyTimer(next);
        this.dataAssemblies.set(dataFrame.streamId, next);
        return;
      }
      const assembly = this.dataAssemblies.get(dataFrame.streamId);
      if (assembly) {
        if (assembly.binary !== dataFrame.binary) throw nodeRelaySessionError("NODE_RELAY_DATA_FRAGMENT_INVALID");
        assembly.bytes += dataFrame.data.byteLength;
        assembly.sealedBytes += frame.payload.byteLength;
        assembly.wireBytes += wireBytes;
        assembly.fragments += 1;
        if (assembly.bytes > NODE_RELAY_DATA_MAX_MESSAGE_BYTES) throw nodeRelaySessionError("NODE_RELAY_DATA_MESSAGE_TOO_LARGE");
        assembly.chunks.push(dataFrame.data);
        this.discardDataAssembly(dataFrame.streamId);
        const data = Buffer.concat(assembly.chunks, assembly.bytes);
        this.traceData("in", dataFrame.streamId, data, assembly.binary, assembly.fragments, assembly);
        await this.onData({ streamId: dataFrame.streamId, binary: assembly.binary, more: false, data });
        return;
      }
      this.traceData("in", dataFrame.streamId, dataFrame.data, dataFrame.binary, 1, { sealedBytes: frame.payload.byteLength, wireBytes });
      await this.onData(dataFrame);
      return;
    }
    const json = bufferView(plaintext);
    if (json.byteLength === 0 || json[0] !== 0x7b) throw nodeRelaySessionError("NODE_RELAY_FRAME_PAYLOAD_INVALID");
    const message = NodeRelaySessionMessageSchema.parse(JSON.parse(json.toString("utf8")));
    this.emitTrace({
      direction: "in",
      kind: message.type,
      plaintext: json,
      sealedBytes: frame.payload.byteLength,
      wireBytes,
      detail: {
        flags: frame.flags ?? 0,
        ...("streamId" in message ? { streamId: message.streamId } : {}),
        ...("channelId" in message ? { channelId: message.channelId } : {}),
      },
    });
    await this.onMessage(message);
  }

  private traceData(direction: "in" | "out", streamId: number, data: Uint8Array, binary: boolean, fragments: number, measured?: { sealedBytes: number; wireBytes: number; compressedFragments?: number }) {
    const sealedBytes = measured?.sealedBytes
      ?? data.byteLength + fragments * (NODE_RELAY_DATA_HEADER_BYTES + NODE_RELAY_SECRETBOX_OVERHEAD_BYTES);
    this.emitTrace({
      direction,
      kind: relayPayloadKind(data),
      plaintext: data,
      sealedBytes,
      wireBytes: measured?.wireBytes ?? sealedBytes + fragments * RELAY_FRAME_HEADER_BYTES,
      detail: { streamId, binary, fragments, ...(measured?.compressedFragments ? { compressedFragments: measured.compressedFragments } : {}) },
    });
  }

  private emitTrace(event: NodeRelayTraceEvent) {
    if (!this.onTrace) return;
    try { this.onTrace(event); }
    catch { /* Diagnostics must never interfere with the relay session. */ }
  }

  private sendPlaintext(payload: Uint8Array, flags: number) {
    if (this.closed) throw nodeRelaySessionError("NODE_RELAY_CHANNEL_CLOSED");
    const sealed = nacl.secretbox(payload, sequenceNonce(this.sendDirection, this.sendCounter++), this.key);
    this.socket.send(encodeRelayFrame({ kind: "data", sequence: this.sendSequence++, payload: sealed, flags }));
  }

  private enqueuePlaintext(payload: Uint8Array, flags: number, control: boolean) {
    if (this.closed) throw nodeRelaySessionError("NODE_RELAY_CHANNEL_CLOSED");
    const bytes = payload.byteLength + 40;
    if (this.outboundBytes + bytes > NODE_RELAY_SOCKET_MAX_QUEUED_BYTES) throw nodeRelaySessionError("NODE_RELAY_BACKPRESSURE_LIMIT");
    (control ? this.outboundControl : this.outboundData).push({ payload, flags, bytes });
    this.outboundBytes += bytes;
    this.flushOutbound();
  }

  private flushOutbound() {
    if (this.closed || (this.outboundControl.length === 0 && this.outboundData.length === 0)) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    while (this.outboundControl.length || this.outboundData.length) {
      if ((this.socket.bufferedAmount ?? 0) > NODE_RELAY_SOCKET_MAX_BUFFERED_BYTES) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = undefined;
          try { this.flushOutbound(); }
          catch (error) { this.fail(error); }
        }, 5);
        this.flushTimer.unref?.();
        return;
      }
      const next = this.outboundControl.shift() ?? this.outboundData.shift()!;
      this.outboundBytes -= next.bytes;
      this.releaseOutboundCapacity();
      try { this.sendPlaintext(next.payload, next.flags); }
      catch (error) { this.fail(error); return; }
    }
  }

  private fail(error: unknown) {
    if (this.closed) return;
    this.onError?.(error instanceof Error ? error : new Error(String(error)));
    this.finish(error instanceof Error ? error.message : "channel-error", true);
  }

  private finish(reason: string, failed = false) {
    if (this.closed) return;
    this.closed = true;
    for (const assembly of this.dataAssemblies.values()) {
      if (assembly.timer) clearTimeout(assembly.timer);
    }
    this.dataAssemblies.clear();
    this.outboundControl.length = 0;
    this.outboundData.length = 0;
    this.outboundBytes = 0;
    this.releaseOutboundCapacity();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.onClosed?.(reason);
    if (failed) {
      try {
        if (this.socket.readyState === undefined || this.socket.readyState < 2) this.socket.close(4400, reason.slice(0, 120));
      } catch {
      // Local state is already finalized.
      }
    }
  }

  private releaseOutboundCapacity() {
    if (this.outboundBytes > NODE_RELAY_SOCKET_MAX_BUFFERED_BYTES || this.outboundCapacityWaiters.length === 0) return;
    for (const resolve of this.outboundCapacityWaiters.splice(0)) resolve();
  }

  private beginDataAssembly(streamId: number, binary: boolean): NodeRelayDataAssembly {
    return { streamId, binary, bytes: 0, sealedBytes: 0, wireBytes: 0, fragments: 0, chunks: [] };
  }

  private armDataAssemblyTimer(assembly: NodeRelayDataAssembly) {
    if (assembly.timer) clearTimeout(assembly.timer);
    const timer = setTimeout(() => {
      const current = this.dataAssemblies.get(assembly.streamId);
      if (!current || current.timer !== timer) return;
      this.dataAssemblies.delete(assembly.streamId);
      this.fail(nodeRelaySessionError("NODE_RELAY_DATA_ASSEMBLY_TIMEOUT"));
    }, this.dataAssemblyIdleMs);
    timer.unref?.();
    assembly.timer = timer;
  }

  private assembledBytes() {
    let bytes = 0;
    for (const assembly of this.dataAssemblies.values()) bytes += assembly.bytes;
    return bytes;
  }
}

function positiveInteger(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Reads the envelope's leading `type` without parsing a potentially multi-megabyte payload. */
function relayPayloadKind(bytes: Uint8Array) {
  if (bytes.byteLength === 0 || bytes[0] !== 0x7b) return "data";
  const prefix = Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, Math.min(bytes.byteLength, 4 * 1024)).toString("utf8");
  return /^\s*\{\s*"type"\s*:\s*"([^"]{1,120})"/.exec(prefix)?.[1] ?? "data";
}
