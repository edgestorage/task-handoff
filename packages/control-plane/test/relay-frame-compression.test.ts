import assert from "node:assert/strict";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import nacl from "tweetnacl";
import { RELAY_FRAME_FLAG_DEFLATE, decodeRelayFrame } from "@task-handoff/cloud-contracts";
import { EncryptedControlPlaneRelaySession } from "../src/control-plane/cloud-connectivity/relay-connector.ts";

// Mirrors `nonce()` in relay-connector.ts so the Control Plane decrypts the client frame.
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

function harness(bridge: unknown, key = nacl.randomBytes(32)) {
  const listeners = new Map<string, (value?: unknown) => void>();
  const sent: Uint8Array[] = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    on(event: string, listener: (value?: unknown) => void) { listeners.set(event, listener); },
    once(event: string, listener: (value?: unknown) => void) { listeners.set(event, listener); },
    off() { return undefined; },
    send(value: string | Uint8Array) { sent.push(typeof value === "string" ? new TextEncoder().encode(value) : value); },
    ping() { return undefined; },
    close() { return undefined; },
  };
  const session = new EncryptedControlPlaneRelaySession(socket as never, "channel_compressed", key, { type: "cloud-account" } as never, bridge as never);
  session.start();
  const deliver = (envelope: unknown, sequence = 1, counter = 0) => {
    const sealed = nacl.secretbox(new TextEncoder().encode(JSON.stringify(envelope)), clientNonce(counter), key);
    listeners.get("message")?.(encodeFrame(sealed), true);
  };
  return { deliver, sent, key };
}

// The client half of the frame format: a seven-to-eight byte header with magic, version, flags, kind and sequence.
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

const waitForSend = async (sent: Uint8Array[]) => {
  const deadline = Date.now() + 2_000;
  while (!sent.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  return sent.shift()!;
};

test("large responses are deflate-packed before sealing and stay opaque to the Relay", async () => {
  const body = { data: { items: Array.from({ length: 400 }, (_, index) => ({ id: `item-${index}`, text: "task-handoff-response-payload" })) } };
  const { deliver, sent, key } = harness({ request: async () => ({ status: 200, body }) });
  deliver({ type: "request", id: "request_large", body: { path: "/api/ai-sessions", method: "GET", headers: {} } });
  const frame = decodeRelayFrame(await waitForSend(sent));
  assert.equal(frame.flags, RELAY_FRAME_FLAG_DEFLATE);
  assert.equal(frame.kind, "data");
  const opened = nacl.secretbox.open(frame.payload, serverNonce(0), key);
  assert.ok(opened, "the Control Plane seals the compressed payload");
  const decoded = JSON.parse(Buffer.from(inflateRawSync(Buffer.from(opened))).toString("utf8"));
  assert.deepEqual(decoded.body, body);
  assert.ok(frame.payload.byteLength + 16 < JSON.stringify(decoded).length, "compression has to beat the secretbox MAC it pays for");
});

test("small responses stay uncompressed so the flag is only paid when it shrinks the wire", async () => {
  const { deliver, sent, key } = harness({ request: async () => ({ status: 200, body: { ok: true } }) });
  deliver({ type: "request", id: "request_small", body: { path: "/api/health", method: "GET", headers: {} } });
  const frame = decodeRelayFrame(await waitForSend(sent));
  assert.equal(frame.flags, 0);
  const opened = nacl.secretbox.open(frame.payload, serverNonce(0), key);
  assert.ok(opened);
  assert.deepEqual(JSON.parse(Buffer.from(opened).toString("utf8")).body, { ok: true });
});
