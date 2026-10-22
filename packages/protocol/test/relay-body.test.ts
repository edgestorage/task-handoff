import assert from "node:assert/strict";
import test from "node:test";
import {
  RELAY_BODY_CHUNK_BYTES,
  RELAY_BODY_FLAG_FINAL,
  RELAY_BODY_HEADER_BYTES,
  RELAY_BODY_MAGIC,
  RELAY_BODY_MAX_CHUNK_BYTES,
  RELAY_RESPONSE_MAGIC,
  RelayBinaryBodySchema,
  RelayBinaryResponseSchema,
  RelayBodyAckSchema,
  RelayResponseAckSchema,
  decodeRelayBodyFrame,
  decodeRelayResponseFrame,
  encodeRelayBodyFrame,
  encodeRelayResponseFrame,
  isRelayBodyFrame,
  isRelayResponseFrame,
} from "../src/relay-body.ts";

test("relay body frames round-trip binary chunks with idempotent offsets", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  const encoded = encodeRelayBodyFrame({ bodyId: 7, offset: RELAY_BODY_CHUNK_BYTES, bytes, final: true });
  assert.equal(encoded[0], RELAY_BODY_MAGIC);
  assert.equal(encoded[2], RELAY_BODY_FLAG_FINAL);
  const decoded = decodeRelayBodyFrame(encoded);
  assert.equal(decoded.bodyId, 7);
  assert.equal(decoded.offset, RELAY_BODY_CHUNK_BYTES);
  assert.equal(decoded.final, true);
  assert.deepEqual(Buffer.from(decoded.bytes), Buffer.from(bytes));
});

test("relay body frames never collide with JSON envelopes", () => {
  const envelope = new TextEncoder().encode(JSON.stringify({ type: "request" }));
  assert.equal(envelope[0], 0x7b);
  assert.equal(isRelayBodyFrame(envelope), false);
  assert.equal(isRelayBodyFrame(encodeRelayBodyFrame({ bodyId: 1, offset: 0, bytes: new Uint8Array(0), final: false })), true);
});

test("relay response frames mirror request chunks without colliding with them", () => {
  const bytes = new Uint8Array([0, 1, 2, 123, 255]);
  const encoded = encodeRelayResponseFrame({ responseId: 9, offset: 512, bytes, final: true });
  assert.equal(encoded[0], RELAY_RESPONSE_MAGIC);
  assert.equal(isRelayResponseFrame(encoded), true);
  assert.equal(isRelayBodyFrame(encoded), false);
  const decoded = decodeRelayResponseFrame(encoded);
  assert.deepEqual({ ...decoded, bytes: Buffer.from(decoded.bytes) }, { responseId: 9, offset: 512, bytes: Buffer.from(bytes), final: true });
  assert.throws(() => encodeRelayResponseFrame({ responseId: 0, offset: 0, bytes, final: true }), /invalid/);
});

test("relay body frames reject malformed headers, ids, and oversize chunks", () => {
  const valid = encodeRelayBodyFrame({ bodyId: 1, offset: 0, bytes: new Uint8Array(3), final: false });
  assert.throws(() => decodeRelayBodyFrame(valid.subarray(0, RELAY_BODY_HEADER_BYTES - 1)), /invalid/);
  const badVersion = Uint8Array.from(valid);
  badVersion[1] = 99;
  assert.throws(() => decodeRelayBodyFrame(badVersion), /invalid/);
  const badFlags = Uint8Array.from(valid);
  badFlags[2] = 0x80;
  assert.throws(() => decodeRelayBodyFrame(badFlags), /invalid/);
  const zeroId = Uint8Array.from(valid);
  new DataView(zeroId.buffer).setUint32(3, 0, false);
  assert.throws(() => decodeRelayBodyFrame(zeroId), /invalid/);
  assert.throws(() => encodeRelayBodyFrame({ bodyId: 1, offset: 0, bytes: new Uint8Array(RELAY_BODY_MAX_CHUNK_BYTES + 1), final: false }), /too large|invalid/i);
  assert.throws(() => encodeRelayBodyFrame({ bodyId: 0, offset: 0, bytes: new Uint8Array(1), final: false }), /invalid/);
});

test("relay body envelope schemas keep the wire vocabulary strict", () => {
  assert.equal(RelayBinaryBodySchema.parse({ bodyId: 3, size: 1024 }).size, 1024);
  assert.throws(() => RelayBinaryBodySchema.parse({ bodyId: 3, size: 1024, extra: true }));
  assert.equal(RelayBodyAckSchema.parse({ type: "body-ack", bodyId: 3, offset: 512 }).offset, 512);
  assert.throws(() => RelayBodyAckSchema.parse({ type: "body-ack", bodyId: 0, offset: 0 }));
  assert.deepEqual(RelayBinaryResponseSchema.parse({ responseId: 3, size: 1024, contentType: "image/png", filename: "a.png" }), { responseId: 3, size: 1024, contentType: "image/png", filename: "a.png" });
  assert.throws(() => RelayBinaryResponseSchema.parse({ responseId: 3, size: 1024, extra: true }));
  assert.equal(RelayResponseAckSchema.parse({ type: "response-ack", responseId: 3, offset: 512 }).offset, 512);
  assert.throws(() => RelayResponseAckSchema.parse({ type: "response-ack", responseId: 0, offset: 0 }));
});
