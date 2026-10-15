import assert from "node:assert/strict";
import test from "node:test";
import nacl from "tweetnacl";
import { EncryptedControlPlaneRelaySession } from "../src/control-plane/cloud-connectivity/relay-connector.ts";

// Mirrors `nonce()` in relay-connector.ts: direction byte followed by a big-endian
// counter, so the Control Plane decrypts the first client frame with counter 0.
function clientNonce(counter: number) {
  const value = new Uint8Array(24);
  value[0] = 1;
  new DataView(value.buffer).setBigUint64(16, BigInt(counter), false);
  return value;
}

function harness() {
  const key = nacl.randomBytes(32);
  const channelId = "relay_channel_test";
  const listeners = new Map<string, (value?: unknown) => void>();
  const socket = {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    sent: [] as string[],
    on(event: string, listener: (value?: unknown) => void) { listeners.set(event, listener); },
    once(event: string, listener: (value?: unknown) => void) { listeners.set(event, listener); },
    off() { return undefined; },
    send(value: string) { socket.sent.push(value); },
    ping() { return undefined; },
    close() { return undefined; },
  };
  const subscriptions: Array<{ topics: string[]; metricInstanceIds?: string[] }> = [];
  const bridge = {
    subscribe(_actor: unknown, topics: string[], _send: unknown, _transient: unknown, metricInstanceIds?: string[]) {
      subscriptions.push({ topics, metricInstanceIds });
      return () => undefined;
    },
  };
  const session = new EncryptedControlPlaneRelaySession(socket as never, channelId, key, { type: "cloud-account" } as never, bridge as never);
  session.start();
  const deliver = (envelope: unknown, sequence = 1, counter = 0) => {
    const sealed = nacl.secretbox(new TextEncoder().encode(JSON.stringify(envelope)), clientNonce(counter), key);
    listeners.get("message")?.(Buffer.from(JSON.stringify({ type: "frame", frame: { protocolVersion: "2026-08-10", channelId, sequence, kind: "data", ciphertext: Buffer.from(sealed).toString("base64url") } })));
  };
  return { deliver, subscriptions };
}

const subscribeEnvelope = (body: Record<string, unknown>) => ({ type: "event-subscribe", body: { eventEnvelopeVersion: "2026-08-25", topics: ["instances", "nodes"], ...body } });

test("a relay event-subscribe that states an empty resource metric scope reaches the bridge as an explicit empty list", async () => {
  const { deliver, subscriptions } = harness();
  deliver(subscribeEnvelope({ metricInstanceIds: [] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subscriptions.length, 1);
  assert.deepEqual(subscriptions[0].metricInstanceIds, []);
});

test("a relay event-subscribe that omits the field asks for the legacy full metrics stream", async () => {
  const { deliver, subscriptions } = harness();
  deliver(subscribeEnvelope({}));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].metricInstanceIds, undefined);
});

test("a relay event-subscribe keeps the listed metric instances and drops blank ids", async () => {
  const { deliver, subscriptions } = harness();
  deliver(subscribeEnvelope({ metricInstanceIds: ["inst_a", "", "inst_b"] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(subscriptions[0].metricInstanceIds, ["inst_a", "inst_b"]);
});
