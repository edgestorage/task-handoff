import assert from "node:assert/strict";
import test from "node:test";
import nacl from "tweetnacl";
import { randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { decodeRelayFrame, encodeRelayFrame, unpackRelayPayload } from "@task-handoff/cloud-contracts";
import { EncryptedControlPlaneRelaySession } from "../src/control-plane/cloud-connectivity/relay-connector.ts";

function clientNonce(counter: number) {
  const value = new Uint8Array(24);
  value[0] = 1;
  new DataView(value.buffer).setBigUint64(16, BigInt(counter), false);
  return value;
}

function harness(bridge: unknown) {
  const key = nacl.randomBytes(32);
  const listeners = new Map<string, (...args: any[]) => void>();
  const sent: Uint8Array[] = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    on(event: string, listener: (...args: any[]) => void) { listeners.set(event, listener); },
    once(event: string, listener: (...args: any[]) => void) { listeners.set(event, listener); },
    off() { return undefined; },
    send(value: string | Uint8Array) { sent.push(typeof value === "string" ? new TextEncoder().encode(value) : value); },
    close(code?: number, reason?: string) {
      socket.readyState = 3;
      listeners.get("close")?.(code, reason);
    },
  };
  const diagnostics: unknown[] = [];
  const session = new EncryptedControlPlaneRelaySession(socket as never, "channel_close", key, { type: "cloud-account" } as never, bridge as never, undefined, undefined, { onProtocolError: (details) => diagnostics.push(details), onResponseSent: (details) => diagnostics.push(details) });
  session.start();
  let sequence = 0;
  let counter = 0;
  const deliver = (envelope: unknown) => {
    const sealed = nacl.secretbox(new TextEncoder().encode(JSON.stringify(envelope)), clientNonce(counter++), key);
    listeners.get("message")?.(encodeRelayFrame({ kind: "data", sequence: ++sequence, payload: sealed }), true);
  };
  return { deliver, sent, socket, listeners, diagnostics, session, key };
}

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
};

test("relay channel close does not send tty-closed back through the closed socket", async () => {
  let ttyClosed = 0;
  const bridge = {
    async openTty(_actor: unknown, _input: unknown, listener: (message: unknown) => void) {
      return {
        send() { return undefined; },
        resize() { return undefined; },
        close() {
          ttyClosed += 1;
          listener({ type: "tty-closed" });
        },
      };
    },
  };
  const { deliver, sent, socket } = harness(bridge);
  deliver({ type: "tty-open", streamId: "stream_a", body: { instanceId: "instance_a", sessionId: "session_a" } });
  await waitFor(() => sent.length === 1);
  assert.equal(sent.length, 1, "the TTY open acknowledgement is the only outbound frame");

  assert.doesNotThrow(() => socket.close(1006, "relay-disconnected"));
  assert.equal(ttyClosed, 1);
  assert.equal(sent.length, 1, "closing the relay must not append a frame to a dead socket");
});

test("a bridge event under backpressure closes the session instead of throwing into the event source", async () => {
  let emit: ((event: unknown) => void) | undefined;
  const bridge = {
    subscribe(_actor: unknown, _topics: string[], listener: (event: unknown) => void) {
      emit = listener;
      return () => undefined;
    },
  };
  const { deliver, sent, socket } = harness(bridge);
  deliver({ type: "event-subscribe", body: { topics: ["instances"] } });
  await waitFor(() => emit !== undefined);
  socket.bufferedAmount = 3 * 1024 * 1024;

  assert.doesNotThrow(() => emit?.({ type: "instance.checked", payload: {} }));
  assert.equal(socket.readyState, 3);
  assert.equal(sent.length, 0);
});

test("invalid receive sequence logs the original expectation and preserves receive counters", async () => {
  const { listeners, socket, diagnostics, session } = harness({});
  listeners.get("message")?.(encodeRelayFrame({ kind: "data", sequence: 9, payload: Buffer.from("secret") }), true);
  await waitFor(() => socket.readyState === 3);
  assert.deepEqual(diagnostics, [{
    errorCode: "RELAY_FRAME_SEQUENCE_INVALID", channelId: "channel_close", role: "client",
    expectedSequence: 1, actualSequence: 9, receiveCounter: 0, frameKind: "data", frameBytes: 14,
  }]);
  assert.equal((session as any).receiveSequence, 1);
  assert.equal((session as any).receiveCounter, 0);
});

test("large JSON response diagnostics report sizes and sequence without response contents", async () => {
  const { deliver, sent, diagnostics } = harness({ async request() { return { status: 200, body: { output: "private-timeline-text".repeat(5000) } }; } });
  deliver({ type: "request", id: "timeline_request", body: { path: "/api/timeline" } });
  await waitFor(() => sent.length === 1);
  assert.equal(diagnostics.length, 1);
  const entry = diagnostics[0] as Record<string, unknown>;
  assert.equal(entry.requestId, "timeline_request");
  assert.equal(entry.sequence, 1);
  assert.equal(entry.minimumChunks, 1);
  assert.ok(Number(entry.plaintextBytes) > 64 * 1024);
  assert.ok(Number(entry.wireBytes) < Number(entry.plaintextBytes));
  assert.ok(!JSON.stringify(entry).includes("private-timeline-text"));
});
// Compatibility for v0.0.51: legacy JSON callers cannot consume chunk metadata,
// but an oversized response must leave their channel sequence and nonce usable.
test("an oversized legacy JSON response fails only its request without skipping sequence or nonce", async () => {
  const output = randomBytes(2 * 1024 * 1024).toString("base64");
  const { deliver, sent, socket, key } = harness({ async request() { return { status: 200, body: { output } }; } });
  deliver({ type: "request", id: "large", body: { path: "/api/timeline" } });
  await waitFor(() => sent.length === 1);
  assert.equal(sent.length, 1);
  const frame = decodeRelayFrame(sent[0]);
  assert.equal(frame.sequence, 1);
  const serverNonce = clientNonce(0); serverNonce[0] = 2;
  const opened = nacl.secretbox.open(frame.payload, serverNonce, key);
  assert.ok(opened, "a rejected frame must not consume an encryption nonce");
  const response = JSON.parse(Buffer.from(unpackRelayPayload(opened, frame.flags ?? 0, inflateRawSync)).toString());
  assert.equal(response.id, "large");
  assert.equal(response.body.error.code, "RELAY_FRAME_TOO_LARGE");
  deliver({ type: "ping", sentAt: new Date().toISOString() });
  await waitFor(() => sent.length === 2);
  assert.equal(decodeRelayFrame(sent[1]).sequence, 2);
  assert.equal(socket.readyState, 1);
  socket.close();
});
