import { z } from "zod";

/**
 * Control Plane <-> node agent payload protocol carried inside one cloud-relay
 * node channel. The Relay only sees opaque frames; this layer authenticates the
 * two peers end to end (a cloud-signed claim grant on the node side, the
 * claiming Control Plane's cloud identity key and the paired-HMAC on its side)
 * and then multiplexes the tunnel protocol's main socket plus per-stream
 * auxiliary sockets over the single channel.
 */
export const NODE_RELAY_CHANNEL_PROTOCOL_VERSION = "2026-10-17";
export const NODE_RELAY_HANDSHAKE_AUDIENCE = "task-handoff:node-relay-handshake";
export const NODE_RELAY_MAIN_CHANNEL_ID = "main";

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

/** The pairing HMAC binds the stored secret to this exact peer pair and allocation. */
export function nodeRelayPairingTranscript(payload: unknown): string {
  const parsed = NodeRelayHandshakeInitPayloadSchema.parse(payload);
  const { type: _type, pairedHmac: _hmac, ...body } = parsed;
  return `task-handoff:node-relay-pairing:v1\n${JSON.stringify(body)}`;
}

export const NodeRelayChannelOpenSchema = z.strictObject({ type: z.literal("channel-open"), channelId: IdSchema });
export const NodeRelayChannelAcceptSchema = z.strictObject({ type: z.literal("channel-accept"), channelId: IdSchema });
export const NodeRelayChannelRejectSchema = z.strictObject({ type: z.literal("channel-reject"), channelId: IdSchema, code: z.string().trim().min(1).max(120), message: z.string().trim().max(512).optional() });
export const NodeRelayChannelDataSchema = z.strictObject({ type: z.literal("channel-data"), channelId: IdSchema, data: z.string(), binary: z.boolean().optional() });
export const NodeRelayChannelCloseSchema = z.strictObject({ type: z.literal("channel-close"), channelId: IdSchema, code: z.number().int().optional(), reason: z.string().trim().max(512).optional() });
export const NodeRelayKeepaliveSchema = z.strictObject({ type: z.literal("relay-ping") });
export const NodeRelayKeepaliveAckSchema = z.strictObject({ type: z.literal("relay-pong") });

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
  NodeRelayChannelDataSchema,
  NodeRelayChannelCloseSchema,
  NodeRelayKeepaliveSchema,
  NodeRelayKeepaliveAckSchema,
]);

export type NodeRelayHandshakeInit = z.infer<typeof NodeRelayHandshakeInitSchema>;
export type NodeRelayHandshakeAccept = z.infer<typeof NodeRelayHandshakeAcceptSchema>;
export type NodeRelaySessionMessage = z.infer<typeof NodeRelaySessionMessageSchema>;
export type NodeRelayChannelData = z.infer<typeof NodeRelayChannelDataSchema>;
