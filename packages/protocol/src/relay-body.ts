import { z } from "zod";

/**
 * Binary bodies inside the encrypted cloud-relay channel.
 *
 * The Relay already moves opaque binary frames, but everything *inside* the
 * ciphertext used to be a JSON envelope: binary request bodies were wrapped in
 * canonical base64, which cost ~33% wire growth and forced the whole file into
 * one sealed frame (1 MiB ceiling). This module defines the chunked binary
 * alternative that mobile and Control Plane speak end to end; the Relay never
 * parses it.
 *
 * The decrypted plaintext of a `data` frame is either a JSON envelope or one of
 * these body frames, and the two are told apart by their first byte: JSON starts
 * with `{` (0x7B), request bodies start with 0xB1 and response bodies with 0xB3.
 *
 * Layout (integers big-endian):
 *
 *   byte 0      magic, 0xB1
 *   byte 1      frame version, currently 1
 *   byte 2      flags, see RELAY_BODY_FLAG_*
 *   bytes 3-6   body id, uint32, matching the JSON request envelope's `binaryBody.bodyId`
 *   bytes 7-10  offset, uint32, byte offset of this chunk inside the body
 *   bytes 11..  raw chunk bytes
 *
 * Upload chunks are acknowledged by a JSON `body-ack` envelope; download chunks
 * use the symmetric `response-ack`. Both carry the cumulative byte offset the
 * receiver has accepted, which is used as a flow-control cursor. WebSocket/TCP
 * already guarantees ordering and delivery for a live connection, so neither
 * side retransmits chunks or reorders them from these offsets.
 */
export const RELAY_BODY_MAGIC = 0xb1;
export const RELAY_BODY_VERSION = 1;
export const RELAY_BODY_HEADER_BYTES = 11;
export const RELAY_BODY_FLAG_FINAL = 0x01;
export const RELAY_RESPONSE_MAGIC = 0xb3;
export const RELAY_RESPONSE_VERSION = 1;
/** Sender chunk size; mirrors the attachment draft-stream chunk so both paths stream alike. */
export const RELAY_BODY_CHUNK_BYTES = 256 * 1024;
/** Receiver ceiling for one chunk; anything above this is a protocol error. */
export const RELAY_BODY_MAX_CHUNK_BYTES = 512 * 1024;
/** Receiver ceiling for one assembled body. Product limits are enforced above this. */
export const RELAY_BODY_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const RELAY_BODY_KNOWN_FLAGS = RELAY_BODY_FLAG_FINAL;

export interface RelayBodyFrame {
  bodyId: number;
  offset: number;
  bytes: Uint8Array;
  final: boolean;
}

export function relayBodyError(code = "RELAY_BODY_FRAME_INVALID") {
  return Object.assign(new Error("Relay body frame is invalid."), { code, retryable: false });
}

export function isRelayBodyFrame(raw: Uint8Array): boolean {
  return raw.byteLength > 0 && raw[0] === RELAY_BODY_MAGIC;
}

export function encodeRelayBodyFrame(frame: RelayBodyFrame): Uint8Array {
  if (!Number.isInteger(frame.bodyId) || frame.bodyId <= 0 || frame.bodyId > 0xffff_ffff) throw relayBodyError();
  if (!Number.isInteger(frame.offset) || frame.offset < 0 || frame.offset > 0xffff_ffff) throw relayBodyError();
  if (frame.bytes.byteLength > RELAY_BODY_MAX_CHUNK_BYTES) throw relayBodyError("RELAY_BODY_FRAME_TOO_LARGE");
  const encoded = new Uint8Array(RELAY_BODY_HEADER_BYTES + frame.bytes.byteLength);
  encoded[0] = RELAY_BODY_MAGIC;
  encoded[1] = RELAY_BODY_VERSION;
  encoded[2] = frame.final ? RELAY_BODY_FLAG_FINAL : 0;
  const view = new DataView(encoded.buffer);
  view.setUint32(3, frame.bodyId, false);
  view.setUint32(7, frame.offset, false);
  encoded.set(frame.bytes, RELAY_BODY_HEADER_BYTES);
  return encoded;
}

export function decodeRelayBodyFrame(raw: Uint8Array): RelayBodyFrame {
  if (raw.byteLength < RELAY_BODY_HEADER_BYTES || raw[0] !== RELAY_BODY_MAGIC || raw[1] !== RELAY_BODY_VERSION) throw relayBodyError();
  const flags = raw[2];
  if ((flags & ~RELAY_BODY_KNOWN_FLAGS) !== 0) throw relayBodyError();
  const bytes = raw.subarray(RELAY_BODY_HEADER_BYTES);
  if (bytes.byteLength > RELAY_BODY_MAX_CHUNK_BYTES) throw relayBodyError("RELAY_BODY_FRAME_TOO_LARGE");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const bodyId = view.getUint32(3, false);
  if (bodyId === 0) throw relayBodyError();
  return { bodyId, offset: view.getUint32(7, false), bytes, final: (flags & RELAY_BODY_FLAG_FINAL) !== 0 };
}

export interface RelayResponseFrame {
  responseId: number;
  offset: number;
  bytes: Uint8Array;
  final: boolean;
}

export function isRelayResponseFrame(raw: Uint8Array): boolean {
  return raw.byteLength > 0 && raw[0] === RELAY_RESPONSE_MAGIC;
}

export function encodeRelayResponseFrame(frame: RelayResponseFrame): Uint8Array {
  if (!Number.isInteger(frame.responseId) || frame.responseId <= 0 || frame.responseId > 0xffff_ffff) throw relayBodyError();
  if (!Number.isInteger(frame.offset) || frame.offset < 0 || frame.offset > 0xffff_ffff) throw relayBodyError();
  if (frame.bytes.byteLength > RELAY_BODY_MAX_CHUNK_BYTES) throw relayBodyError("RELAY_RESPONSE_FRAME_TOO_LARGE");
  const encoded = new Uint8Array(RELAY_BODY_HEADER_BYTES + frame.bytes.byteLength);
  encoded[0] = RELAY_RESPONSE_MAGIC;
  encoded[1] = RELAY_RESPONSE_VERSION;
  encoded[2] = frame.final ? RELAY_BODY_FLAG_FINAL : 0;
  const view = new DataView(encoded.buffer);
  view.setUint32(3, frame.responseId, false);
  view.setUint32(7, frame.offset, false);
  encoded.set(frame.bytes, RELAY_BODY_HEADER_BYTES);
  return encoded;
}

export function decodeRelayResponseFrame(raw: Uint8Array): RelayResponseFrame {
  if (raw.byteLength < RELAY_BODY_HEADER_BYTES || raw[0] !== RELAY_RESPONSE_MAGIC || raw[1] !== RELAY_RESPONSE_VERSION) throw relayBodyError();
  const flags = raw[2];
  if ((flags & ~RELAY_BODY_KNOWN_FLAGS) !== 0) throw relayBodyError();
  const bytes = raw.subarray(RELAY_BODY_HEADER_BYTES);
  if (bytes.byteLength > RELAY_BODY_MAX_CHUNK_BYTES) throw relayBodyError("RELAY_RESPONSE_FRAME_TOO_LARGE");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const responseId = view.getUint32(3, false);
  if (responseId === 0) throw relayBodyError();
  return { responseId, offset: view.getUint32(7, false), bytes, final: (flags & RELAY_BODY_FLAG_FINAL) !== 0 };
}

/** `body.binaryBody` on a JSON request envelope: metadata for the frames that follow. */
export const RelayBinaryBodySchema = z.object({
  bodyId: z.number().int().positive().max(0xffff_ffff),
  size: z.number().int().nonnegative().max(RELAY_BODY_MAX_TOTAL_BYTES),
}).strict();
export type RelayBinaryBody = z.infer<typeof RelayBinaryBodySchema>;

/** `binaryResponse` on a JSON response envelope: metadata for the frames that follow. */
export const RelayBinaryResponseSchema = z.object({
  responseId: z.number().int().positive().max(0xffff_ffff),
  size: z.number().int().nonnegative().max(RELAY_BODY_MAX_TOTAL_BYTES),
  contentType: z.string().trim().min(1).max(255).optional(),
  filename: z.string().trim().min(1).max(512).optional(),
}).strict();
export type RelayBinaryResponse = z.infer<typeof RelayBinaryResponseSchema>;

/** Receiver acknowledgement: cumulative bytes accepted for one body. */
export const RelayBodyAckSchema = z.object({
  type: z.literal("body-ack"),
  bodyId: z.number().int().positive().max(0xffff_ffff),
  offset: z.number().int().nonnegative().max(RELAY_BODY_MAX_TOTAL_BYTES),
}).strict();
export type RelayBodyAck = z.infer<typeof RelayBodyAckSchema>;

/** Receiver acknowledgement for one download body. */
export const RelayResponseAckSchema = z.object({
  type: z.literal("response-ack"),
  responseId: z.number().int().positive().max(0xffff_ffff),
  offset: z.number().int().nonnegative().max(RELAY_BODY_MAX_TOTAL_BYTES),
}).strict();
export type RelayResponseAck = z.infer<typeof RelayResponseAckSchema>;
