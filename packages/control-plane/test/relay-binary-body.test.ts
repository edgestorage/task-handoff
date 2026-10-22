import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import nacl from "tweetnacl";
import { decodeRelayFrame, unpackRelayPayload } from "@task-handoff/cloud-contracts";
import { RELAY_BODY_CHUNK_BYTES, decodeRelayResponseFrame, encodeRelayBodyFrame, encodeRelayResponseFrame, isRelayResponseFrame } from "@task-handoff/protocol/relay-body";
import { EncryptedControlPlaneRelaySession } from "../src/control-plane/cloud-connectivity/relay-connector.ts";

function clientNonce(counter: number) {
  const value = new Uint8Array(24);
  value[0] = 1;
  new DataView(value.buffer).setBigUint64(16, BigInt(counter), false);
  return value;
}

function serverNonce(counter: number) {
  const value = new Uint8Array(24);
  value[0] = 2;
  new DataView(value.buffer).setBigUint64(16, BigInt(counter), false);
  return value;
}

function encodeFrame(sealed: Uint8Array, flags = 0, kind = 1, sequence = 1) {
  const frame = new Uint8Array(8 + sealed.byteLength);
  frame[0] = 0x52;
  frame[1] = 2;
  frame[2] = flags;
  frame[3] = kind;
  new DataView(frame.buffer).setUint32(4, sequence, false);
  frame.set(sealed, 8);
  return frame;
}

function harness(bridge: unknown, key = nacl.randomBytes(32)) {
  const listeners = new Map<string, (value?: unknown) => void>();
  const sent: Uint8Array[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    on(event: string, listener: (value?: unknown) => void) { listeners.set(event, listener); },
    once(event: string, listener: (value?: unknown) => void) { listeners.set(event, listener); },
    off() { return undefined; },
    send(value: string | Uint8Array) { sent.push(typeof value === "string" ? new TextEncoder().encode(value) : value); },
    ping() { return undefined; },
    close(code?: number, reason?: string) { closed.push({ code, reason }); },
  };
  const session = new EncryptedControlPlaneRelaySession(socket as never, "channel_binary", key, { type: "cloud-account" } as never, bridge as never);
  session.start();
  let sequence = 0;
  let counter = 0;
  const send = (payload: Uint8Array, flags = 0, kind = 1) => {
    const sealed = nacl.secretbox(payload, clientNonce(counter++), key);
    listeners.get("message")?.(encodeFrame(sealed, flags, kind, ++sequence), true);
  };
  const deliver = (envelope: unknown) => send(new TextEncoder().encode(JSON.stringify(envelope)));
  const deliverChunk = (frame: { bodyId: number; offset: number; bytes: Uint8Array; final: boolean }) => send(encodeRelayBodyFrame(frame));
  const decodeSent = () => sent.map((raw, index) => {
    const frame = decodeRelayFrame(raw);
    const opened = nacl.secretbox.open(frame.payload, serverNonce(index), key);
    assert.ok(opened, "the Control Plane seals every outbound frame");
    const plaintext = Buffer.from(unpackRelayPayload(Buffer.from(opened), frame.flags ?? 0, (input) => inflateRawSync(input)));
    if (isRelayResponseFrame(plaintext)) return { type: "response-frame", ...decodeRelayResponseFrame(plaintext) };
    return JSON.parse(plaintext.toString("utf8"));
  });
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2_000;
    while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return { deliver, deliverChunk, decodeSent, waitFor, closed, session };
}

test("request envelopes forward the HTTP body without leaking routing metadata into it", async () => {
  let seen: { path?: string; method?: string; headers?: Record<string, string>; body?: unknown } | undefined;
  const bridge = {
    async request(_actor: unknown, input: typeof seen) {
      seen = input;
      return { status: 200, body: { data: { ok: true } } };
    },
  };
  const { deliver, decodeSent, waitFor } = harness(bridge);
  deliver({
    type: "request",
    id: "request_body",
    body: { path: "/api/example", method: "POST", headers: { "content-type": "application/json", "x-test": "yes" }, body: { message: "hello" }, responseBinary: true },
  });
  await waitFor(() => decodeSent().some((value) => value.type === "response"));
  assert.deepEqual(seen, {
    path: "/api/example",
    method: "POST",
    headers: { "content-type": "application/json", "x-test": "yes" },
    binaryResponse: true,
    body: { message: "hello" },
  });
});

test("binary body chunks stream into the bridge and are acknowledged cumulatively", async () => {
  const received: Buffer[] = [];
  const bridge = {
    async request(_actor: unknown, input: { bodyStream?: AsyncIterable<Uint8Array> }) {
      assert.ok(input.bodyStream, "the request envelope opens a stream");
      for await (const chunk of input.bodyStream) received.push(Buffer.from(chunk));
      return { status: 201, body: { data: { bytes: received.reduce((total, chunk) => total + chunk.length, 0) } } };
    },
  };
  const { deliver, deliverChunk, decodeSent, waitFor } = harness(bridge);
  const content = Buffer.alloc(RELAY_BODY_CHUNK_BYTES + 5, 7);
  deliver({ type: "request", id: "request_1", body: { path: "/api/upload", method: "POST", headers: { "content-type": "application/octet-stream" }, binaryBody: { bodyId: 4, size: content.length } } });
  deliverChunk({ bodyId: 4, offset: 0, bytes: content.subarray(0, RELAY_BODY_CHUNK_BYTES), final: false });
  deliverChunk({ bodyId: 4, offset: RELAY_BODY_CHUNK_BYTES, bytes: content.subarray(RELAY_BODY_CHUNK_BYTES), final: true });
  await waitFor(() => decodeSent().some((value) => value.type === "response"));
  assert.equal(Buffer.concat(received).length, content.length);
  assert.deepEqual(Buffer.concat(received), content);
  const envelopes = decodeSent();
  assert.deepEqual(envelopes.filter((value) => value.type === "body-ack").map((value) => value.offset), [content.length]);
  const response = envelopes.find((value) => value.type === "response");
  assert.equal(response.status, 201);
  assert.deepEqual(response.body, { data: { bytes: content.length } });
});

test("a slow bridge consumer is not acknowledged before it accepts the bytes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const received: Buffer[] = [];
  const bridge = {
    async request(_actor: unknown, input: { bodyStream?: AsyncIterable<Uint8Array> }) {
      await gate;
      for await (const chunk of input.bodyStream!) received.push(Buffer.from(chunk));
      return { status: 201, body: { data: { ok: true } } };
    },
  };
  const { deliver, deliverChunk, decodeSent, waitFor } = harness(bridge);
  const content = Buffer.alloc(RELAY_BODY_CHUNK_BYTES, 9);
  deliver({ type: "request", id: "request_slow", body: { path: "/api/upload", method: "POST", headers: {}, binaryBody: { bodyId: 10, size: content.length } } });
  deliverChunk({ bodyId: 10, offset: 0, bytes: content, final: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(decodeSent().some((value) => value.type === "body-ack"), false, "a blocked bridge must not acknowledge the body");

  release();
  await waitFor(() => decodeSent().some((value) => value.type === "response"));
  assert.deepEqual(Buffer.concat(received), content);
  assert.deepEqual(decodeSent().filter((value) => value.type === "body-ack").map((value) => value.offset), [content.length]);
});

test("binary responses are framed, acknowledged and reassembled byte-exact", async () => {
  for (const size of [5 * 1024 * 1024, 20 * 1024 * 1024]) {
    const content = Buffer.alloc(size);
    for (let index = 0; index < content.length; index += 1) content[index] = index % 251;
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    const bridge = {
      async request() {
        return { status: 200, binary: { bytes: content, contentType: "application/octet-stream", filename: "archive.bin" } };
      },
    };
    const { deliver, decodeSent, waitFor } = harness(bridge);
    deliver({ type: "request", id: `request_download_${size}`, body: { path: "/api/download", method: "GET", headers: {}, responseBinary: true } });
    await waitFor(() => decodeSent().some((value) => value.type === "response"));
    const metadata = decodeSent().find((value) => value.type === "response").binaryResponse;
    assert.deepEqual(metadata, { responseId: 1, size, contentType: "application/octet-stream", filename: "archive.bin" });

    let acknowledged = 0;
    while (acknowledged < size) {
      await waitFor(() => decodeSent().some((value) => value.type === "response-frame" && value.offset + value.bytes.byteLength > acknowledged));
      const frames = decodeSent().filter((value) => value.type === "response-frame");
      const tail = frames.at(-1);
      assert.ok(tail);
      const end = tail.offset + tail.bytes.byteLength;
      assert.ok(end > acknowledged);
      acknowledged = end;
      deliver({ type: "response-ack", responseId: metadata.responseId, offset: acknowledged });
    }

    const frames = decodeSent().filter((value) => value.type === "response-frame");
    assert.equal(frames.length, Math.ceil(size / RELAY_BODY_CHUNK_BYTES));
    assert.equal(frames.every((value, index) => value.offset === index * RELAY_BODY_CHUNK_BYTES), true);
    assert.equal(frames.at(-1)?.final, true);
    assert.equal(crypto.createHash("sha256").update(Buffer.concat(frames.map((value) => Buffer.from(value.bytes)))).digest("hex"), digest);
  }
});

test("concurrent binary responses share one channel-wide in-flight window", async () => {
  const content = Buffer.alloc(RELAY_BODY_CHUNK_BYTES * 8, 4);
  const bridge = {
    async request(_actor: unknown, input: { path?: string }) {
      return { status: 200, binary: { bytes: content, contentType: input.path === "/a" ? "application/a" : "application/b" } };
    },
  };
  const { deliver, decodeSent, waitFor, session } = harness(bridge);
  deliver({ type: "request", id: "request_a", body: { path: "/a", method: "GET", headers: {}, responseBinary: true } });
  await waitFor(() => decodeSent().some((value) => value.type === "response" && value.id === "request_a"));
  const firstResponseId = decodeSent().find((value) => value.type === "response" && value.id === "request_a").binaryResponse.responseId;
  deliver({ type: "request", id: "request_b", body: { path: "/b", method: "GET", headers: {}, responseBinary: true } });

  await waitFor(() => decodeSent().filter((value) => value.type === "response").length === 2);
  let frames = decodeSent().filter((value) => value.type === "response-frame");
  assert.ok(frames.length > 0);
  assert.ok(
    frames.reduce((total, value) => total + value.bytes.byteLength, 0) <= RELAY_BODY_CHUNK_BYTES * 4,
    "the aggregate in-flight window stays below the Relay socket guard",
  );
  assert.equal(frames.every((value) => value.responseId === firstResponseId), true, "the first response already owns the full window");

  deliver({ type: "response-ack", responseId: firstResponseId, offset: RELAY_BODY_CHUNK_BYTES });
  await waitFor(() => decodeSent().some((value) => value.type === "response-frame" && value.responseId !== firstResponseId));
  frames = decodeSent().filter((value) => value.type === "response-frame");
  assert.equal(new Set(frames.map((value) => value.responseId)).size, 2, "an acknowledgement lets the waiting response make progress");
  session.close("test-complete");
});

test("a cancelled response releases the shared window to waiting transfers", async () => {
  const content = Buffer.alloc(RELAY_BODY_CHUNK_BYTES * 8, 4);
  const bridge = {
    async request(_actor: unknown, input: { path?: string }) {
      return { status: 200, binary: { bytes: content, contentType: input.path === "/a" ? "application/a" : "application/b" } };
    },
  };
  const { deliver, decodeSent, waitFor, session } = harness(bridge);
  deliver({ type: "request", id: "request_a", body: { path: "/a", method: "GET", headers: {}, responseBinary: true } });
  await waitFor(() => decodeSent().some((value) => value.type === "response" && value.id === "request_a"));
  const firstResponseId = decodeSent().find((value) => value.type === "response" && value.id === "request_a").binaryResponse.responseId;
  deliver({ type: "request", id: "request_b", body: { path: "/b", method: "GET", headers: {}, responseBinary: true } });
  await waitFor(() => decodeSent().filter((value) => value.type === "response").length === 2);
  assert.equal(decodeSent().some((value) => value.type === "response-frame" && value.responseId !== firstResponseId), false);

  deliver({ type: "cancel", id: "request_a" });
  await waitFor(() => decodeSent().some((value) => value.type === "response-frame" && value.responseId !== firstResponseId));
  const secondFrames = decodeSent().filter((value) => value.type === "response-frame" && value.responseId !== firstResponseId);
  assert.ok(secondFrames.length > 0, "the waiting response resumes as soon as the cancelled response releases its window");
  session.close("test-complete");
});

test("a duplicate chunk offset fails instead of being re-acknowledged", async () => {
  const received: Buffer[] = [];
  const bridge = {
    async request(_actor: unknown, input: { bodyStream?: AsyncIterable<Uint8Array> }) {
      for await (const chunk of input.bodyStream!) received.push(Buffer.from(chunk));
      return { status: 200, body: { data: { ok: true } } };
    },
  };
  const { deliver, deliverChunk, decodeSent, closed } = harness(bridge);
  deliver({ type: "request", id: "request_1", body: { path: "/api/upload", method: "POST", headers: {}, binaryBody: { bodyId: 9, size: 6 } } });
  deliverChunk({ bodyId: 9, offset: 0, bytes: new Uint8Array([1, 2, 3]), final: false });
  deliverChunk({ bodyId: 9, offset: 0, bytes: new Uint8Array([1, 2, 3]), final: false });
  const deadline = Date.now() + 2_000;
  while (!closed.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(closed[0]?.code, 4400);
  assert.deepEqual([...Buffer.concat(received)], [1, 2, 3]);
  assert.deepEqual(decodeSent().filter((value) => value.type === "body-ack").map((value) => value.offset), [3]);
});

test("an offset gap fails the channel instead of corrupting the body", async () => {
  const bridge = { async request() { return { status: 200, body: {} }; } };
  const { deliver, deliverChunk, closed } = harness(bridge);
  deliver({ type: "request", id: "request_1", body: { path: "/api/upload", method: "POST", headers: {}, binaryBody: { bodyId: 2, size: 6 } } });
  deliverChunk({ bodyId: 2, offset: 3, bytes: new Uint8Array([4, 5, 6]), final: true });
  const deadline = Date.now() + 2_000;
  while (!closed.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(closed[0]?.code, 4400);
});

test("cancel unwinds a half-received body and reports the failure back to the client", async () => {
  let streamFailure: unknown;
  const bridge = {
    async request(_actor: unknown, input: { bodyStream?: AsyncIterable<Uint8Array> }) {
      try { for await (const _chunk of input.bodyStream!) { /* consume until aborted */ } }
      catch (error) { streamFailure = error; throw error; }
      return { status: 200, body: {} };
    },
  };
  const { deliver, deliverChunk, decodeSent, waitFor } = harness(bridge);
  deliver({ type: "request", id: "request_1", body: { path: "/api/upload", method: "POST", headers: {}, binaryBody: { bodyId: 6, size: 6 } } });
  deliverChunk({ bodyId: 6, offset: 0, bytes: new Uint8Array([1, 2, 3]), final: false });
  deliver({ type: "cancel", id: "request_1" });
  await waitFor(() => decodeSent().some((value) => value.type === "response"));
  assert.ok(streamFailure, "the stream is destroyed so the route unwinds");
  const response = decodeSent().find((value) => value.type === "response");
  assert.equal(response.status, 500);
});
