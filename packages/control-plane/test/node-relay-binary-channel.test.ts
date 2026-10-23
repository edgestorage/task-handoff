import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import nacl from "tweetnacl";
import { decodeRelayFrame, encodeRelayFrame } from "@task-handoff/cloud-contracts";
import {
  NODE_RELAY_DATA_HEADER_BYTES,
  NODE_RELAY_DATA_MAGIC,
  NODE_RELAY_DATA_MAX_BYTES,
  NODE_RELAY_DATA_MAX_MESSAGE_BYTES,
  NODE_RELAY_MAIN_STREAM_ID,
  NODE_RELAY_STREAM_HIGH_WATER_BYTES,
  encodeNodeRelayDataFrame,
  type NodeRelayDataFrame,
  type NodeRelaySessionMessage,
} from "@task-handoff/protocol/node-relay-channel";
import {
  EncryptedNodeRelayChannel,
  NODE_RELAY_DIRECTION_CONTROL_PLANE,
  NODE_RELAY_DIRECTION_NODE,
  type NodeRelayDataAssemblyLimits,
} from "../src/shared/cloud-relay/node-relay-session.ts";
import { MultiplexedNodeRelaySocket } from "../src/control-plane/nodes/cloud-relay-transport.ts";
import { NodeRelayNodeChannel } from "../src/node-agent/cloud-relay/channel.ts";
import { linkedFrameSockets } from "./support/cloud-relay-node-harness.ts";

function directionNonce(direction: number, counter: number) {
  const value = new Uint8Array(24);
  value[0] = direction;
  new DataView(value.buffer).setBigUint64(16, BigInt(counter), false);
  return value;
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function relayDataFragment(socket: { send(data: string | Uint8Array): void }, key: Uint8Array, sequence: number, streamId: number, data: Uint8Array, more: boolean) {
  const plaintext = encodeNodeRelayDataFrame({ streamId, data, binary: true, more });
  const sealed = nacl.secretbox(plaintext, directionNonce(NODE_RELAY_DIRECTION_CONTROL_PLANE, sequence - 1), key);
  socket.send(encodeRelayFrame({ kind: "data", sequence, payload: sealed, flags: 0 }));
}

function sessionPair(options: { dataAssemblyLimits?: NodeRelayDataAssemblyLimits } = {}) {
  const key = nacl.randomBytes(32);
  const sockets = linkedFrameSockets();
  const sent: Buffer[] = [];
  const errors: Error[] = [];
  const originalSend = sockets.left.send.bind(sockets.left);
  sockets.left.send = (data: string | Uint8Array) => {
    sent.push(Buffer.from(data));
    originalSend(data);
  };
  const received: NodeRelayDataFrame[] = [];
  const control: NodeRelaySessionMessage[] = [];
  const order: Array<"control" | "data"> = [];
  const controlPlane = new EncryptedNodeRelayChannel({
    socket: sockets.left,
    key,
    sendDirection: NODE_RELAY_DIRECTION_CONTROL_PLANE,
    receiveDirection: NODE_RELAY_DIRECTION_NODE,
    onMessage: () => undefined,
    onData: () => undefined,
  });
  const node = new EncryptedNodeRelayChannel({
    socket: sockets.right,
    key,
    sendDirection: NODE_RELAY_DIRECTION_NODE,
    receiveDirection: NODE_RELAY_DIRECTION_CONTROL_PLANE,
    onMessage: (message) => { control.push(message); order.push("control"); },
    onData: (frame) => { received.push(frame); order.push("data"); },
    onError: (error) => { errors.push(error); },
    ...(options.dataAssemblyLimits ? { dataAssemblyLimits: options.dataAssemblyLimits } : {}),
  });
  controlPlane.start();
  node.start();
  return { controlPlane, node, key, sent, received, control, order, sockets, errors };
}

test("node relay binary data is sealed verbatim without base64 or deflate", async () => {
  const { controlPlane, key, sent, received } = sessionPair();
  const content = Buffer.alloc(600 * 1024);
  for (let index = 0; index < content.length; index += 1) content[index] = index % 251;

  controlPlane.sendData(3, content, true);
  await waitFor(() => received.length === 1, "the node to receive binary data");

  const frame = decodeRelayFrame(sent[0]!);
  assert.equal(frame.kind, "data");
  assert.equal(frame.sequence, 1);
  assert.equal(frame.flags, 0, "binary tunnel data must not be deflated");
  const opened = nacl.secretbox.open(frame.payload, directionNonce(NODE_RELAY_DIRECTION_CONTROL_PLANE, 0), key);
  assert.ok(opened, "the Control Plane frame opens with the shared session key");
  assert.equal(opened[0], NODE_RELAY_DATA_MAGIC);
  assert.equal(opened.byteLength, NODE_RELAY_DATA_HEADER_BYTES + content.length, "the payload is not base64-expanded");
  assert.deepEqual(Buffer.from(received[0]!.data), content);
  assert.equal(received[0]!.streamId, 3);
  assert.equal(received[0]!.binary, true);
});

test("node relay stream ids multiplex main text, auxiliary text and auxiliary binary frames", async () => {
  const { controlPlane, received, control } = sessionPair();
  controlPlane.sendData(NODE_RELAY_MAIN_STREAM_ID, JSON.stringify({ type: "relay-ping" }), false);
  controlPlane.sendData(1, "stream one text", false);
  controlPlane.sendData(2, Uint8Array.from([9, 8, 7]), true);
  controlPlane.send({ type: "relay-ping" });
  await waitFor(() => received.length === 3 && control.length === 1, "all relay frames to arrive");

  assert.deepEqual(received.map((frame) => frame.streamId), [NODE_RELAY_MAIN_STREAM_ID, 1, 2]);
  assert.deepEqual(received.map((frame) => frame.binary), [false, false, true]);
  assert.equal(Buffer.from(received[0]!.data).toString("utf8"), '{"type":"relay-ping"}');
  assert.equal(Buffer.from(received[1]!.data).toString("utf8"), "stream one text");
  assert.deepEqual(Buffer.from(received[2]!.data), Buffer.from([9, 8, 7]));
  assert.deepEqual(control, [{ type: "relay-ping" }]);
});

test("node relay fragments messages above one frame and reassembles them in order", async () => {
  const { controlPlane, received } = sessionPair();
  const content = Buffer.alloc(NODE_RELAY_DATA_MAX_BYTES * 2 + 123);
  for (let index = 0; index < content.length; index += 1) content[index] = index % 251;

  controlPlane.sendData(5, content, true);
  await waitFor(() => received.length === 1, "the fragmented binary message to be reassembled");

  assert.equal(Buffer.from(received[0]!.data).equals(content), true);
  assert.equal(received[0]!.streamId, 5);
  assert.equal(received[0]!.binary, true);
  assert.equal(received[0]!.more, false);
});

test("node relay bounds the number of concurrent partial messages", async () => {
  const { key, sockets, node, errors } = sessionPair({ dataAssemblyLimits: { maxStreams: 2 } });
  relayDataFragment(sockets.left, key, 1, 1, Uint8Array.from([1]), true);
  relayDataFragment(sockets.left, key, 2, 2, Uint8Array.from([2]), true);
  await waitFor(() => (node as any).dataAssemblies.size === 2, "two partial assemblies");

  relayDataFragment(sockets.left, key, 3, 3, Uint8Array.from([3]), true);
  await waitFor(() => errors.length === 1, "the assembly-count failure");
  assert.equal((errors[0] as Error & { code?: string }).code, "NODE_RELAY_DATA_ASSEMBLY_LIMIT");
});

test("node relay bounds the total bytes held by partial messages", async () => {
  const { key, sockets, errors } = sessionPair({ dataAssemblyLimits: { maxBytes: 8 } });
  relayDataFragment(sockets.left, key, 1, 1, new Uint8Array(5), true);
  relayDataFragment(sockets.left, key, 2, 2, new Uint8Array(4), true);
  await waitFor(() => errors.length === 1, "the assembly-byte failure");
  assert.equal((errors[0] as Error & { code?: string }).code, "NODE_RELAY_DATA_ASSEMBLY_BYTES_LIMIT");
});

test("node relay expires partial messages that stop making progress", async () => {
  const { key, sockets, errors } = sessionPair({ dataAssemblyLimits: { idleMs: 20 } });
  relayDataFragment(sockets.left, key, 1, 1, Uint8Array.from([1]), true);
  await waitFor(() => errors.length === 1, "the idle assembly timeout", 1_000);
  assert.equal((errors[0] as Error & { code?: string }).code, "NODE_RELAY_DATA_ASSEMBLY_TIMEOUT");
});

test("discarding a partial message cancels its idle timer", async () => {
  const { key, sockets, node, errors } = sessionPair({ dataAssemblyLimits: { idleMs: 20 } });
  relayDataFragment(sockets.left, key, 1, 1, Uint8Array.from([1]), true);
  await waitFor(() => (node as any).dataAssemblies.size === 1, "the partial assembly");
  node.discardDataAssembly(1);
  assert.equal((node as any).dataAssemblies.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(errors, []);
});

test("an auxiliary channel close discards its partial message immediately", async () => {
  const sockets = linkedFrameSockets();
  const key = nacl.randomBytes(32);
  const controlPlane = new EncryptedNodeRelayChannel({
    socket: sockets.left,
    key,
    sendDirection: NODE_RELAY_DIRECTION_CONTROL_PLANE,
    receiveDirection: NODE_RELAY_DIRECTION_NODE,
    onMessage: () => undefined,
    onData: () => undefined,
  });
  const node = new NodeRelayNodeChannel({
    nodeId: "node_agent_test",
    pairing: { keyId: "pairing_test", secret: nacl.randomBytes(32).toString("base64url") },
    host: {
      log: { warn: () => undefined },
      currentListenerPort: () => 1,
      inject: async () => { throw new Error("unexpected inject"); },
    },
    socket: sockets.right,
    key,
    onClosed: () => undefined,
  });
  controlPlane.start();
  node.start();
  (controlPlane as any).sendPlaintext(encodeNodeRelayDataFrame({ streamId: 42, data: Uint8Array.from([1]), binary: true, more: true }), 0);
  const session = (node as any).session as EncryptedNodeRelayChannel;
  await waitFor(() => (session as any).dataAssemblies.size === 1, "the partial assembly");

  let remoteClosed = false;
  const socket = { streamId: 42, remoteClosed: () => { remoteClosed = true; } };
  (node as any).aux.set("aux_42", socket);
  (node as any).auxByStreamId.set(42, socket);
  controlPlane.send({ type: "channel-close", channelId: "aux_42", code: 1000, reason: "done" });

  await waitFor(() => (session as any).dataAssemblies.size === 0 && remoteClosed, "the channel close cleanup");
  assert.equal((node as any).aux.has("aux_42"), false);
});

test("node relay data frames reject payloads that would exceed the relay ceiling", () => {
  const { controlPlane, sent } = sessionPair();
  assert.throws(() => controlPlane.sendData(1, Buffer.alloc(NODE_RELAY_DATA_MAX_MESSAGE_BYTES + 1), true), /too large|invalid/i);
  assert.equal(sent.length, 0);
});

test("control frames overtake queued bulk data", async () => {
  const { controlPlane, sockets, control, received, order } = sessionPair();
  sockets.left.bufferedAmount = 3 * 1024 * 1024;
  for (let index = 0; index < 4; index += 1) controlPlane.sendData(7, Buffer.alloc(64 * 1024), true);
  controlPlane.send({ type: "relay-ping" });

  sockets.left.bufferedAmount = 0;
  await waitFor(() => control.length === 1 && received.length === 4, "the queued control and data frames to flush");

  assert.deepEqual(control, [{ type: "relay-ping" }]);
  assert.equal(order[0], "control", "a heartbeat must not wait behind a bulk data burst");
  assert.deepEqual(order.slice(1), ["data", "data", "data", "data"]);
});

test("channel close follows data already queued for the stream", async () => {
  const { controlPlane, sockets, control, received, order } = sessionPair();
  sockets.left.bufferedAmount = 3 * 1024 * 1024;
  controlPlane.sendData(7, Buffer.alloc(64 * 1024), true);
  controlPlane.send({ type: "channel-close", channelId: "aux_close", code: 1000, reason: "done" });

  sockets.left.bufferedAmount = 0;
  await waitFor(() => control.length === 1 && received.length === 1, "the queued data before the close");
  assert.deepEqual(order, ["data", "control"], "close must not overtake bytes already accepted from the stream");
});

test("a queue-limit failure does not enqueue half of a fragmented message", async () => {
  const { controlPlane, sockets, received, sent } = sessionPair();
  sockets.left.bufferedAmount = 3 * 1024 * 1024;
  const message = Buffer.alloc(NODE_RELAY_DATA_MAX_MESSAGE_BYTES);
  controlPlane.sendData(7, message, true);
  assert.throws(
    () => controlPlane.sendData(8, message, true),
    (error: { code?: string }) => error.code === "NODE_RELAY_BACKPRESSURE_LIMIT",
  );

  sockets.left.bufferedAmount = 0;
  await waitFor(() => received.length === 1, "the complete first message to flush");
  assert.equal(received[0]!.streamId, 7);
  assert.equal(sent.length, Math.ceil(message.byteLength / NODE_RELAY_DATA_MAX_BYTES));
});

test("node relay pauses writers at the outbound queue high-water mark", async () => {
  const { controlPlane, sockets, received } = sessionPair();
  sockets.left.bufferedAmount = 3 * 1024 * 1024;
  controlPlane.sendData(7, Buffer.alloc(3 * 1024 * 1024, 7), true);

  let released = false;
  const capacity = controlPlane.waitForOutboundCapacity().then(() => { released = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(released, false, "the writer waits while the channel queue is above its high-water mark");

  sockets.left.bufferedAmount = 0;
  await capacity;
  assert.equal(released, true);
  await waitFor(() => received.length === 1, "the queued message to finish flushing");
  assert.equal(received[0]!.streamId, 7);
});

test("a delayed stream listener drains queued frames and resumes its peer", () => {
  const control: string[] = [];
  const channel = {
    sendData: () => undefined,
    sendStreamPause: (streamId: number) => control.push(`pause:${streamId}`),
    sendStreamResume: (streamId: number) => control.push(`resume:${streamId}`),
    sendPing: () => undefined,
    emitChannelClose: () => undefined,
  };
  const socket = new MultiplexedNodeRelaySocket(channel as never, "main", NODE_RELAY_MAIN_STREAM_ID);
  const half = Math.ceil(NODE_RELAY_STREAM_HIGH_WATER_BYTES / 2) + 1;
  socket.deliver(Buffer.alloc(half), false);
  socket.deliver(Buffer.alloc(half), false);
  assert.deepEqual(control, [`pause:${NODE_RELAY_MAIN_STREAM_ID}`]);

  const received: unknown[] = [];
  socket.on("message", (raw) => received.push(raw));
  assert.equal(received.length, 2);
  assert.deepEqual(control, [`pause:${NODE_RELAY_MAIN_STREAM_ID}`, `resume:${NODE_RELAY_MAIN_STREAM_ID}`]);
});

test("node relay starts an auxiliary request before channel-accept returns", async () => {
  let requestSeen = false;
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const server = http.createServer((_request, response) => {
    requestSeen = true;
    void responseGate.then(() => {
      response.writeHead(200, { "content-type": "text/plain", "content-length": "2", connection: "close" });
      response.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const sockets = linkedFrameSockets();
  const key = nacl.randomBytes(32);
  const messages: NodeRelaySessionMessage[] = [];
  const responseFrames: NodeRelayDataFrame[] = [];
  let opened: Extract<NodeRelaySessionMessage, { type: "channel-open" }> | undefined;
  const controlPlane = new EncryptedNodeRelayChannel({
    socket: sockets.left,
    key,
    sendDirection: NODE_RELAY_DIRECTION_CONTROL_PLANE,
    receiveDirection: NODE_RELAY_DIRECTION_NODE,
    onMessage: (message) => {
      messages.push(message);
      if (message.type === "channel-open") opened = message;
    },
    onData: (frame) => { responseFrames.push(frame); },
  });
  const node = new NodeRelayNodeChannel({
    nodeId: "node_agent_test",
    pairing: { keyId: "pairing_test", secret: nacl.randomBytes(32).toString("base64url") },
    host: {
      log: { warn: () => undefined },
      currentListenerPort: () => (address as { port: number }).port,
      inject: async () => { throw new Error("unexpected inject"); },
    },
    socket: sockets.right,
    key,
    onClosed: () => undefined,
  });
  controlPlane.start();
  node.start();

  controlPlane.sendData(NODE_RELAY_MAIN_STREAM_ID, JSON.stringify({
    type: "control-plane.http.open",
    streamId: "stream_optimistic",
    route: "/health",
    init: { method: "GET", headers: {} },
  }), false);
  await waitFor(() => requestSeen && opened !== undefined, "the node to start the local request before accept");

  controlPlane.send({ type: "channel-accept", channelId: "stream_optimistic", streamId: opened!.streamId });
  releaseResponse();
  await waitFor(() => responseFrames.some((frame) => frame.binary && Buffer.from(frame.data).toString("utf8") === "ok"), "the response body");
  assert.equal(messages.some((message) => message.type === "channel-accept"), false);

  node.close("test-complete");
  controlPlane.close("test-complete");
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
