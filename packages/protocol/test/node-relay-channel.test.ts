import assert from "node:assert/strict";
import test from "node:test";
import {
  NODE_RELAY_DATA_FLAG_BINARY,
  NODE_RELAY_DATA_FLAG_MORE,
  NODE_RELAY_DATA_HEADER_BYTES,
  NODE_RELAY_DATA_MAGIC,
  NODE_RELAY_DATA_MAX_BYTES,
  NODE_RELAY_DATA_VERSION,
  NODE_RELAY_MAIN_STREAM_ID,
  NodeRelayChannelAcceptSchema,
  NodeRelayChannelOpenSchema,
  NodeRelaySessionMessageSchema,
  decodeNodeRelayDataFrame,
  encodeNodeRelayDataFrame,
  isNodeRelayDataFrame,
} from "../src/node-relay-channel.ts";

test("node relay data frames carry raw bytes and stream ids without JSON or base64", () => {
  const bytes = Uint8Array.from([0, 1, 2, 0x7b, 0xb2, 250, 255]);
  const encoded = encodeNodeRelayDataFrame({ streamId: 7, data: bytes, binary: true });
  assert.equal(encoded[0], NODE_RELAY_DATA_MAGIC);
  assert.equal(encoded[1], NODE_RELAY_DATA_VERSION);
  assert.equal(encoded[2], NODE_RELAY_DATA_FLAG_BINARY);
  assert.equal(encoded.byteLength, NODE_RELAY_DATA_HEADER_BYTES + bytes.byteLength);
  assert.equal(encoded.includes(0x7b), true, "the payload is copied verbatim");
  const decoded = decodeNodeRelayDataFrame(encoded);
  assert.equal(decoded.streamId, 7);
  assert.equal(decoded.binary, true);
  assert.equal(decoded.more, false);
  assert.deepEqual(Buffer.from(decoded.data), Buffer.from(bytes));
});

test("text data frames use the same binary envelope and are distinguishable from JSON", () => {
  const encoded = encodeNodeRelayDataFrame({ streamId: NODE_RELAY_MAIN_STREAM_ID, data: Buffer.from("hello"), binary: false });
  assert.equal(isNodeRelayDataFrame(encoded), true);
  assert.equal(isNodeRelayDataFrame(Buffer.from('{"type":"relay-ping"}')), false);
  const decoded = decodeNodeRelayDataFrame(encoded);
  assert.equal(decoded.streamId, NODE_RELAY_MAIN_STREAM_ID);
  assert.equal(decoded.binary, false);
  assert.equal(Buffer.from(decoded.data).toString("utf8"), "hello");
});

test("node relay data frames mark every non-final fragment with MORE", () => {
  const first = encodeNodeRelayDataFrame({ streamId: 3, data: new Uint8Array(1), binary: true, more: true });
  const last = encodeNodeRelayDataFrame({ streamId: 3, data: new Uint8Array(1), binary: true, more: false });
  assert.equal(decodeNodeRelayDataFrame(first).more, true);
  assert.notEqual(first[2] & NODE_RELAY_DATA_FLAG_MORE, 0);
  assert.equal(decodeNodeRelayDataFrame(last).more, false);
});

test("node relay data frames reject malformed headers, unknown flags and oversized payloads", () => {
  const valid = encodeNodeRelayDataFrame({ streamId: 1, data: new Uint8Array([1, 2, 3]), binary: false });
  assert.throws(() => decodeNodeRelayDataFrame(valid.subarray(0, NODE_RELAY_DATA_HEADER_BYTES - 1)), /invalid/);
  const badVersion = Uint8Array.from(valid);
  badVersion[1] = 99;
  assert.throws(() => decodeNodeRelayDataFrame(badVersion), /invalid/);
  const badFlags = Uint8Array.from(valid);
  badFlags[2] = 0x80;
  assert.throws(() => decodeNodeRelayDataFrame(badFlags), /invalid/);
  assert.throws(() => encodeNodeRelayDataFrame({ streamId: -1, data: new Uint8Array(1), binary: false }), /invalid/);
  assert.throws(() => encodeNodeRelayDataFrame({ streamId: 0x1_0000_0000, data: new Uint8Array(1), binary: false }), /invalid/);
  assert.throws(() => encodeNodeRelayDataFrame({ streamId: 1, data: new Uint8Array(NODE_RELAY_DATA_MAX_BYTES + 1), binary: false }), /too large|invalid/i);
});

test("node relay channel control schemas bind auxiliary channels to a numeric stream id", () => {
  assert.deepEqual(NodeRelayChannelOpenSchema.parse({ type: "channel-open", channelId: "http:1", streamId: 4 }), { type: "channel-open", channelId: "http:1", streamId: 4 });
  assert.deepEqual(NodeRelayChannelAcceptSchema.parse({ type: "channel-accept", channelId: "http:1", streamId: 4 }), { type: "channel-accept", channelId: "http:1", streamId: 4 });
  assert.throws(() => NodeRelayChannelOpenSchema.parse({ type: "channel-open", channelId: "http:1", streamId: 0 }));
  assert.throws(() => NodeRelayChannelOpenSchema.parse({ type: "channel-open", channelId: "http:1" }));
  assert.throws(() => NodeRelaySessionMessageSchema.parse({ type: "channel-data", channelId: "main", data: "legacy" }));
});
