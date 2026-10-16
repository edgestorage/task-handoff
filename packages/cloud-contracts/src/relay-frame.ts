/**
 * Relay frames are binary. The Relay only ever routes opaque ciphertext, so the
 * previous JSON envelope with a base64url `ciphertext` field paid ~34% wire
 * growth plus a per-frame JSON parse/stringify at the Relay for nothing.
 *
 * Layout (integers big-endian):
 *
 *   byte 0      magic, 0x52 ("R")
 *   byte 1      frame version, currently 2
 *   byte 2      flags, see RELAY_FRAME_FLAG_*
 *   byte 3      kind code, see RELAY_FRAME_KINDS
 *   bytes 4-7   sequence, uint32
 *   bytes 8..   sealed payload, verbatim
 *
 * Flag bit 0 marks a raw-DEFLATE packed payload: the sender compresses the plaintext
 * before sealing it, and the receiver inflates it after opening the secretbox. Relay
 * nodes never inspect the flag; they only validate the header and route the bytes.
 *
 * The channel is implied by the socket: a Relay connection is bound to one
 * channel at attach time, and every frame on it carries that channel's
 * per-direction sequence. Pre-attach control messages (`attach`, `attached`)
 * stay JSON text; every frame after that is binary.
 */

export const RELAY_FRAME_MAGIC = 0x52;
export const RELAY_FRAME_VERSION = 2;
export const RELAY_FRAME_HEADER_BYTES = 8;
export const RELAY_FRAME_FLAG_DEFLATE = 0x01;
const RELAY_FRAME_KNOWN_FLAGS = RELAY_FRAME_FLAG_DEFLATE;
/** Small payloads cost more to compress than they save, so leave them alone. */
export const RELAY_FRAME_DEFLATE_MIN_BYTES = 512;
/** Sealed-payload ceiling; mirrors the Relay's default `maxFrameBytes` limit. */
export const RELAY_FRAME_MAX_PAYLOAD_BYTES = 1024 * 1024;

export const RELAY_FRAME_KINDS = ["handshake", "data", "cancel", "window-update", "close"] as const;
export type RelayFrameKind = (typeof RELAY_FRAME_KINDS)[number];

export interface RelayFramePayload {
  kind: RelayFrameKind;
  sequence: number;
  payload: Uint8Array;
  flags?: number;
}

export function relayFrameKindCode(kind: RelayFrameKind): number {
  const code = RELAY_FRAME_KINDS.indexOf(kind);
  if (code < 0) throw relayFrameError();
  return code;
}

export function encodeRelayFrame(frame: RelayFramePayload): Uint8Array {
  if (!Number.isInteger(frame.sequence) || frame.sequence < 0 || frame.sequence > 0xffff_ffff) throw relayFrameError();
  const flags = frame.flags ?? 0;
  if (flags < 0 || flags > 0xff || (flags & ~RELAY_FRAME_KNOWN_FLAGS) !== 0) throw relayFrameError();
  const payload = frame.payload;
  if (payload.byteLength > RELAY_FRAME_MAX_PAYLOAD_BYTES) throw relayFrameError("RELAY_FRAME_TOO_LARGE");
  const encoded = new Uint8Array(RELAY_FRAME_HEADER_BYTES + payload.byteLength);
  encoded[0] = RELAY_FRAME_MAGIC;
  encoded[1] = RELAY_FRAME_VERSION;
  encoded[2] = flags;
  encoded[3] = relayFrameKindCode(frame.kind);
  new DataView(encoded.buffer).setUint32(4, frame.sequence, false);
  encoded.set(payload, RELAY_FRAME_HEADER_BYTES);
  return encoded;
}

export function decodeRelayFrame(raw: Uint8Array): RelayFramePayload {
  if (raw.byteLength < RELAY_FRAME_HEADER_BYTES || raw[0] !== RELAY_FRAME_MAGIC || raw[1] !== RELAY_FRAME_VERSION) throw relayFrameError();
  const flags = raw[2];
  if ((flags & ~RELAY_FRAME_KNOWN_FLAGS) !== 0) throw relayFrameError();
  const kind = RELAY_FRAME_KINDS[raw[3]];
  if (!kind) throw relayFrameError();
  const payloadLength = raw.byteLength - RELAY_FRAME_HEADER_BYTES;
  if (payloadLength > RELAY_FRAME_MAX_PAYLOAD_BYTES) throw relayFrameError("RELAY_FRAME_TOO_LARGE");
  return { kind, flags, sequence: new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(4, false), payload: raw.subarray(RELAY_FRAME_HEADER_BYTES) };
}

/**
 * Compresses a plaintext payload when that actually shrinks it and returns the frame
 * flags to carry. `deflate` must produce raw DEFLATE on every platform that seals.
 */
export function packRelayPayload(payload: Uint8Array, deflate: (input: Uint8Array) => Uint8Array): { payload: Uint8Array; flags: number } {
  if (payload.byteLength < RELAY_FRAME_DEFLATE_MIN_BYTES) return { payload, flags: 0 };
  const compressed = deflate(payload);
  return compressed.byteLength < payload.byteLength ? { payload: compressed, flags: RELAY_FRAME_FLAG_DEFLATE } : { payload, flags: 0 };
}

export function unpackRelayPayload(payload: Uint8Array, flags: number, inflate: (input: Uint8Array) => Uint8Array): Uint8Array {
  return (flags & RELAY_FRAME_FLAG_DEFLATE) !== 0 ? inflate(payload) : payload;
}

function relayFrameError(code = "RELAY_FRAME_INVALID") {
  return Object.assign(new Error("Relay frame is invalid."), { code, retryable: false });
}
