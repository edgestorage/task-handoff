import assert from "node:assert/strict";
import test from "node:test";
import nacl from "tweetnacl";
import { encodeRelayFrame } from "@task-handoff/cloud-contracts";
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
  const session = new EncryptedControlPlaneRelaySession(socket as never, "channel_close", key, { type: "cloud-account" } as never, bridge as never);
  session.start();
  let sequence = 0;
  let counter = 0;
  const deliver = (envelope: unknown) => {
    const sealed = nacl.secretbox(new TextEncoder().encode(JSON.stringify(envelope)), clientNonce(counter++), key);
    listeners.get("message")?.(encodeRelayFrame({ kind: "data", sequence: ++sequence, payload: sealed }), true);
  };
  return { deliver, sent, socket, listeners };
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
