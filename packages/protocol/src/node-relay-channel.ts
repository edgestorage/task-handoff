import { z } from "zod";

/**
 * Control Plane <-> node agent payload protocol carried inside one cloud-relay
 * node channel. The Relay only sees opaque frames; this layer authenticates the
 * two peers end to end (a cloud-signed claim grant on the node side, the
 * claiming Control Plane's cloud identity key and the paired-HMAC on its side)
 * and then multiplexes the tunnel protocol's main socket plus per-stream
 * auxiliary sockets over the single channel.
 */
export const NODE_RELAY_CHANNEL_PROTOCOL_VERSION = "2026-10-22.3";
export const NODE_RELAY_HANDSHAKE_AUDIENCE = "task-handoff:node-relay-handshake";
export const NODE_RELAY_MAIN_CHANNEL_ID = "main";

/**
 * Pre-E2E node-agent -> Control Plane trust result. It shares the existing
 * Relay `handshake` frame sequence 0 with the normal E2E hello, but owns a
 * separate version and lifecycle so a node can explain that the Control Plane
 * must be approved locally without opening the encrypted channel.
 */
export const NODE_AGENT_CONTROL_PLANE_TRUST_PROTOCOL_VERSION = "2026-10-26.1";
export const NODE_AGENT_CONTROL_PLANE_TRUST_AUDIENCE = "task-handoff:node-agent-control-plane-trust";
export const NODE_AGENT_CONTROL_PLANE_TRUST_SIGNING_DOMAIN = "task-handoff:node-agent-control-plane-trust:v1";
export const NODE_AGENT_CONTROL_PLANE_COMPARISON_DOMAIN = "task-handoff:node-agent-control-plane-comparison:v1";

/**
 * Binary tunnel data carried inside the encrypted node channel.
 *
 * Control messages (open/accept/close and heartbeats) remain JSON. Once a
 * stream exists, its payload bytes no longer pay JSON escaping or base64
 * growth. The decrypted plaintext is either a JSON object (first byte `{`) or
 * one of these data frames (first byte `0xB2`):
 *
 *   byte 0      magic, 0xB2
 *   byte 1      frame version, currently 2
 *   byte 2      flags, see NODE_RELAY_DATA_FLAG_*
 *   bytes 3-6   stream id, uint32, 0 is the main tunnel socket
 *   bytes 7..   one fragment of raw UTF-8 text or binary bytes
 *
 * WebSocket already preserves ordering, and the tunnel protocol owns its own
 * request/response reliability, so fragments intentionally carry no offset or
 * acknowledgement fields. A logical message is sent as consecutive frames for
 * that stream; every frame except the last has MORE set. Binary frames are
 * never deflated: payloads are commonly already compressed, and skipping CPU
 * work matters more than a possible small win for text frames.
 */
export const NODE_RELAY_DATA_MAGIC = 0xb2;
export const NODE_RELAY_DATA_VERSION = 2;
export const NODE_RELAY_DATA_HEADER_BYTES = 8;
export const NODE_RELAY_DATA_FLAG_BINARY = 0x01;
/** More fragments of the same logical tunnel message follow this frame. */
export const NODE_RELAY_DATA_FLAG_MORE = 0x02;
export const NODE_RELAY_MAIN_STREAM_ID = 0;
/** Keeps a sealed data frame comfortably below the Relay's 1 MiB frame ceiling. */
export const NODE_RELAY_DATA_MAX_BYTES = 768 * 1024;
/** Largest logical WS/HTTP message one stream may send after reassembly. */
export const NODE_RELAY_DATA_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** One slow auxiliary stream may buffer at most this much before it is closed. */
export const NODE_RELAY_STREAM_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
/** Pause the peer before an auxiliary stream reaches the hard queue ceiling. */
export const NODE_RELAY_STREAM_HIGH_WATER_BYTES = 1024 * 1024;
const NODE_RELAY_DATA_KNOWN_FLAGS = NODE_RELAY_DATA_FLAG_BINARY | NODE_RELAY_DATA_FLAG_MORE;

const IdSchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const PublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const NonceSchema = z.string().trim().min(16).max(256);
const TimestampSchema = z.string().datetime();

/** Opaque account-level node handle; nothing about the node resolves from it. */
export const NodeRelayHandleSchema = z.string().trim().min(8).max(160).regex(/^[a-z][a-z0-9_-]*$/);

const HandshakeBaseShape = {
  protocolVersion: z.literal(NODE_RELAY_CHANNEL_PROTOCOL_VERSION),
  audience: z.literal(NODE_RELAY_HANDSHAKE_AUDIENCE),
  allocationId: IdSchema,
  relayId: IdSchema,
  nodeHandle: NodeRelayHandleSchema,
  controlPlaneId: IdSchema,
  accountId: IdSchema,
  bindingId: IdSchema,
  bindingRevision: z.number().int().positive(),
  /** The node agent's own stable identity; the Control Plane uses it verbatim. */
  nodeId: IdSchema,
  nodePublicKey: PublicKeySchema,
  nodeEphemeralPublicKey: PublicKeySchema,
  nonce: NonceSchema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
};

/** Unsigned body of the node-initiated handshake; the transcript is defined over exactly these fields. */
export const NodeRelayHandshakeInitPayloadSchema = z.strictObject({
  type: z.literal("node-relay.handshake-init"),
  ...HandshakeBaseShape,
  /** Present on reconnects: the pairing the node stored when the Control Plane first claimed it. */
  pairedKeyId: IdSchema.optional(),
  pairedHmac: z.string().trim().min(16).max(256).optional(),
});

export const NodeRelayHandshakeInitSchema = NodeRelayHandshakeInitPayloadSchema.safeExtend({ signature: z.string().trim().min(16).max(512) });

export const NodeAgentControlPlaneAccessContextSchema = z.strictObject({
  accountId: IdSchema,
  ownerAccountId: IdSchema,
  accessMode: z.enum(["owner", "shared"]),
  shareGrantId: IdSchema.optional(),
  shareRole: z.literal("use").optional(),
  shareRevision: z.number().int().positive().optional(),
}).superRefine((value, context) => {
  if (value.accessMode === "owner") {
    if (value.shareGrantId !== undefined || value.shareRole !== undefined || value.shareRevision !== undefined) {
      context.addIssue({ code: "custom", message: "owner access cannot carry share fields" });
    }
    if (value.accountId !== value.ownerAccountId) {
      context.addIssue({ code: "custom", path: ["accountId"], message: "owner access account must equal owner" });
    }
    return;
  }
  if (!value.shareGrantId || !value.shareRole || !value.shareRevision) {
    context.addIssue({ code: "custom", message: "shared access requires grant, role and revision" });
  }
  if (value.accountId === value.ownerAccountId) {
    context.addIssue({ code: "custom", path: ["accountId"], message: "shared access account must differ from owner" });
  }
});

export const NodeAgentControlPlaneTrustStateSchema = z.enum(["pending", "rejected", "expired"]);
export const NodeAgentControlPlaneTrustReasonSchema = z.enum([
  "first-seen",
  "key-changed",
  "access-context-changed",
  "rejected",
  "expired",
]);

/**
 * Diagnostic-only pre-E2E trust result. It carries no grant, ticket, session
 * key, pairing secret or channel capability. The Control Plane may use it to
 * explain an onboarding wait, but it must never use it as an authorization.
 */
export const NodeAgentControlPlaneTrustOutcomePayloadSchema = z.strictObject({
  type: z.literal("node-agent.control-plane-trust"),
  protocolVersion: z.literal(NODE_AGENT_CONTROL_PLANE_TRUST_PROTOCOL_VERSION),
  audience: z.literal(NODE_AGENT_CONTROL_PLANE_TRUST_AUDIENCE),
  allocationId: IdSchema,
  relayId: IdSchema,
  nodeHandle: NodeRelayHandleSchema,
  nodeId: IdSchema,
  nodePublicKey: PublicKeySchema,
  nodePublicKeyFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  controlPlaneId: IdSchema,
  controlPlanePublicKeyFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  bindingId: IdSchema,
  bindingRevision: z.number().int().positive(),
  access: NodeAgentControlPlaneAccessContextSchema,
  state: NodeAgentControlPlaneTrustStateSchema,
  reason: NodeAgentControlPlaneTrustReasonSchema,
  requestId: IdSchema.optional(),
  requestedAt: TimestampSchema,
  expiresAt: TimestampSchema.optional(),
  issuedAt: TimestampSchema,
}).superRefine((value, context) => {
  if (value.state === "rejected" && value.reason !== "rejected") {
    context.addIssue({ code: "custom", path: ["reason"], message: "rejected outcomes require the rejected reason" });
  }
  if (value.state === "expired" && value.reason !== "expired") {
    context.addIssue({ code: "custom", path: ["reason"], message: "expired outcomes require the expired reason" });
  }
  if (value.state === "pending" && (value.reason === "rejected" || value.reason === "expired")) {
    context.addIssue({ code: "custom", path: ["reason"], message: "pending outcomes require a pending reason" });
  }
});

export const NodeAgentControlPlaneTrustOutcomeSchema = NodeAgentControlPlaneTrustOutcomePayloadSchema.safeExtend({
  signature: z.string().trim().min(16).max(512),
});

export const NodeRelayHandshakeAcceptPayloadSchema = z.strictObject({
  type: z.literal("node-relay.handshake-accept"),
  protocolVersion: z.literal(NODE_RELAY_CHANNEL_PROTOCOL_VERSION),
  audience: z.literal(NODE_RELAY_HANDSHAKE_AUDIENCE),
  allocationId: IdSchema,
  nodeHandle: NodeRelayHandleSchema,
  controlPlaneId: IdSchema,
  controlPlanePublicKey: PublicKeySchema,
  controlPlaneEphemeralPublicKey: PublicKeySchema,
  nonce: NonceSchema,
  issuedAt: TimestampSchema,
  /**
   * First claim (or a Control Plane that lost its record) pins the pairing here,
   * sealed with a key derived from the handshake session key: the plaintext
   * accept can travel through the Relay, the secret cannot.
   */
  encryptedPairing: z.string().trim().min(1).max(2048).optional(),
});

export const NodeRelayHandshakeAcceptSchema = NodeRelayHandshakeAcceptPayloadSchema.safeExtend({ signature: z.string().trim().min(16).max(512) });

export function nodeRelayHandshakeSigningInput(payload: unknown): string {
  const parsed = NodeRelayHandshakeInitPayloadSchema.parse(payload);
  const { type: _type, ...body } = parsed;
  return `task-handoff:node-relay-handshake:v1\n${JSON.stringify(body)}`;
}

export function nodeRelayHandshakeAcceptSigningInput(payload: unknown): string {
  const parsed = NodeRelayHandshakeAcceptPayloadSchema.parse(payload);
  const { type: _type, ...body } = parsed;
  return `task-handoff:node-relay-handshake-accept:v1\n${JSON.stringify(body)}`;
}

export function nodeAgentControlPlaneTrustSigningInput(payload: unknown): string {
  const parsed = NodeAgentControlPlaneTrustOutcomePayloadSchema.parse(payload);
  const body = {
    type: parsed.type,
    protocolVersion: parsed.protocolVersion,
    audience: parsed.audience,
    allocationId: parsed.allocationId,
    relayId: parsed.relayId,
    nodeHandle: parsed.nodeHandle,
    nodeId: parsed.nodeId,
    nodePublicKey: parsed.nodePublicKey,
    nodePublicKeyFingerprint: parsed.nodePublicKeyFingerprint,
    controlPlaneId: parsed.controlPlaneId,
    controlPlanePublicKeyFingerprint: parsed.controlPlanePublicKeyFingerprint,
    bindingId: parsed.bindingId,
    bindingRevision: parsed.bindingRevision,
    access: {
      accountId: parsed.access.accountId,
      ownerAccountId: parsed.access.ownerAccountId,
      accessMode: parsed.access.accessMode,
      ...(parsed.access.shareGrantId ? { shareGrantId: parsed.access.shareGrantId } : {}),
      ...(parsed.access.shareRole ? { shareRole: parsed.access.shareRole } : {}),
      ...(parsed.access.shareRevision ? { shareRevision: parsed.access.shareRevision } : {}),
    },
    state: parsed.state,
    reason: parsed.reason,
    ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
    requestedAt: parsed.requestedAt,
    ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}),
    issuedAt: parsed.issuedAt,
  };
  return `${NODE_AGENT_CONTROL_PLANE_TRUST_SIGNING_DOMAIN}\n${JSON.stringify(body)}`;
}

export function nodeAgentControlPlaneComparisonCodeInput(controlPlaneId: string, publicKey: string): Uint8Array {
  return new TextEncoder().encode(`${NODE_AGENT_CONTROL_PLANE_COMPARISON_DOMAIN}\0${IdSchema.parse(controlPlaneId)}\0${PublicKeySchema.parse(publicKey)}`);
}

const NODE_AGENT_COMPARISON_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function formatNodeAgentControlPlaneComparisonCode(digest: Uint8Array): string {
  if (digest.byteLength < 10) throw new Error("A Control Plane comparison code requires at least ten digest bytes.");
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of digest.subarray(0, 10)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += NODE_AGENT_COMPARISON_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) encoded += NODE_AGENT_COMPARISON_ALPHABET[(value << (5 - bits)) & 31];
  return encoded.match(/.{1,4}/g)!.join("-");
}

/** The pairing HMAC binds the stored secret to this exact peer pair and allocation. */
export function nodeRelayPairingTranscript(payload: unknown): string {
  const parsed = NodeRelayHandshakeInitPayloadSchema.parse(payload);
  const { type: _type, pairedHmac: _hmac, ...body } = parsed;
  return `task-handoff:node-relay-pairing:v1\n${JSON.stringify(body)}`;
}

const AuxStreamIdSchema = z.number().int().positive().max(0xffff_ffff);

export const NodeRelayChannelOpenSchema = z.strictObject({ type: z.literal("channel-open"), channelId: IdSchema, streamId: AuxStreamIdSchema });
export const NodeRelayChannelAcceptSchema = z.strictObject({ type: z.literal("channel-accept"), channelId: IdSchema, streamId: AuxStreamIdSchema });
export const NodeRelayChannelRejectSchema = z.strictObject({ type: z.literal("channel-reject"), channelId: IdSchema, code: z.string().trim().min(1).max(120), message: z.string().trim().max(512).optional() });
export const NodeRelayChannelCloseSchema = z.strictObject({ type: z.literal("channel-close"), channelId: IdSchema, code: z.number().int().optional(), reason: z.string().trim().max(512).optional() });
export const NodeRelayKeepaliveSchema = z.strictObject({ type: z.literal("relay-ping") });
export const NodeRelayKeepaliveAckSchema = z.strictObject({ type: z.literal("relay-pong") });
const StreamIdSchema = z.number().int().nonnegative().max(0xffff_ffff);
export const NodeRelayStreamPauseSchema = z.strictObject({ type: z.literal("stream-pause"), streamId: StreamIdSchema });
export const NodeRelayStreamResumeSchema = z.strictObject({ type: z.literal("stream-resume"), streamId: StreamIdSchema });

export interface NodeRelayDataFrame {
  streamId: number;
  data: Uint8Array;
  binary: boolean;
  /** This frame is followed by more frames for the same logical message. */
  more?: boolean;
}

export function nodeRelayDataFrameError(code = "NODE_RELAY_DATA_FRAME_INVALID") {
  return Object.assign(new Error("Node relay data frame is invalid."), { code, retryable: false });
}

export function isNodeRelayDataFrame(raw: Uint8Array) {
  return raw.byteLength > 0 && raw[0] === NODE_RELAY_DATA_MAGIC;
}

export function encodeNodeRelayDataFrame(frame: NodeRelayDataFrame): Uint8Array {
  if (!Number.isInteger(frame.streamId) || frame.streamId < 0 || frame.streamId > 0xffff_ffff) throw nodeRelayDataFrameError();
  if (frame.data.byteLength > NODE_RELAY_DATA_MAX_BYTES) throw nodeRelayDataFrameError("NODE_RELAY_DATA_FRAME_TOO_LARGE");
  const encoded = new Uint8Array(NODE_RELAY_DATA_HEADER_BYTES + frame.data.byteLength);
  encoded[0] = NODE_RELAY_DATA_MAGIC;
  encoded[1] = NODE_RELAY_DATA_VERSION;
  encoded[2] = (frame.binary ? NODE_RELAY_DATA_FLAG_BINARY : 0) | (frame.more ? NODE_RELAY_DATA_FLAG_MORE : 0);
  new DataView(encoded.buffer).setUint32(3, frame.streamId, false);
  encoded.set(frame.data, NODE_RELAY_DATA_HEADER_BYTES);
  return encoded;
}

export function decodeNodeRelayDataFrame(raw: Uint8Array): NodeRelayDataFrame {
  if (raw.byteLength < NODE_RELAY_DATA_HEADER_BYTES || raw[0] !== NODE_RELAY_DATA_MAGIC || raw[1] !== NODE_RELAY_DATA_VERSION) throw nodeRelayDataFrameError();
  const flags = raw[2];
  if ((flags & ~NODE_RELAY_DATA_KNOWN_FLAGS) !== 0) throw nodeRelayDataFrameError();
  const data = raw.subarray(NODE_RELAY_DATA_HEADER_BYTES);
  if (data.byteLength > NODE_RELAY_DATA_MAX_BYTES) throw nodeRelayDataFrameError("NODE_RELAY_DATA_FRAME_TOO_LARGE");
  const streamId = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(3, false);
  return { streamId, data, binary: (flags & NODE_RELAY_DATA_FLAG_BINARY) !== 0, more: (flags & NODE_RELAY_DATA_FLAG_MORE) !== 0 };
}

/** The pairing envelope sealed inside the handshake accept. */
export const NodeRelayPairingEnvelopeSchema = z.strictObject({
  type: z.literal("pairing-envelope"),
  keyId: IdSchema,
  secret: z.string().trim().min(32).max(512),
});
export type NodeRelayPairingEnvelope = z.infer<typeof NodeRelayPairingEnvelopeSchema>;

export const NodeRelaySessionMessageSchema = z.discriminatedUnion("type", [
  NodeRelayChannelOpenSchema,
  NodeRelayChannelAcceptSchema,
  NodeRelayChannelRejectSchema,
  NodeRelayChannelCloseSchema,
  NodeRelayKeepaliveSchema,
  NodeRelayKeepaliveAckSchema,
  NodeRelayStreamPauseSchema,
  NodeRelayStreamResumeSchema,
]);

export type NodeRelayHandshakeInit = z.infer<typeof NodeRelayHandshakeInitSchema>;
export type NodeRelayHandshakeAccept = z.infer<typeof NodeRelayHandshakeAcceptSchema>;
export type NodeAgentControlPlaneAccessContext = z.infer<typeof NodeAgentControlPlaneAccessContextSchema>;
export type NodeAgentControlPlaneTrustOutcome = z.infer<typeof NodeAgentControlPlaneTrustOutcomeSchema>;
export type NodeRelaySessionMessage = z.infer<typeof NodeRelaySessionMessageSchema>;
