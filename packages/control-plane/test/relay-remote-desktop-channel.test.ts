import assert from "node:assert/strict";
import test from "node:test";
import nacl from "tweetnacl";
import { encodeRelayFrame } from "@task-handoff/cloud-contracts";
import { REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL } from "@task-handoff/protocol/remote-desktop";
import {
  RELAY_REMOTE_DESKTOP_CHANNEL_PROTOCOL_VERSION,
  type RelayChannelTarget,
} from "@task-handoff/protocol/relay-browser-channel";
import { EncryptedControlPlaneRelaySession } from "../src/control-plane/cloud-connectivity/relay-connector.ts";

function clientNonce(counter: number) {
  const value = new Uint8Array(24);
  value[0] = 1;
  new DataView(value.buffer).setBigUint64(16, BigInt(counter), false);
  return value;
}

function harness() {
  const key = nacl.randomBytes(32);
  const listeners = new Map<string, (value?: unknown) => void>();
  const closes: Array<{ code?: number; reason?: string }> = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    on(event: string, listener: (value?: unknown) => void) { listeners.set(event, listener); },
    once(event: string, listener: (value?: unknown) => void) { listeners.set(event, listener); },
    off() { return undefined; },
    send() { return undefined; },
    ping() { return undefined; },
    close(code?: number, reason?: string) { closes.push({ code, reason }); },
  };
  const opened: RelayChannelTarget[] = [];
  const bridge = {
    async openRemoteDesktop(_actor: unknown, input: { path: string; protocols: string[] }) {
      opened.push({ kind: "remote-desktop", ...input });
      return { async send() {}, close() {} };
    },
  };
  const session = new EncryptedControlPlaneRelaySession(socket as never, "relay_channel_desktop", key, { type: "cloud-account" } as never, bridge as never);
  session.start();
  const deliver = (envelope: unknown, sequence = 1, counter = 0) => {
    const sealed = nacl.secretbox(new TextEncoder().encode(JSON.stringify(envelope)), clientNonce(counter), key);
    listeners.get("message")?.(Buffer.from(encodeRelayFrame({ kind: "data", sequence, payload: sealed })), true);
  };
  return { deliver, opened, closes };
}

test("a remote-desktop open frame reaches the multiplexer instead of closing the Relay", async () => {
  const h = harness();
  const path = "/api/controlled-instances/inst_a/remote-desktop-sessions/rdv_a/fallback/media?ticket=ticket_a";
  h.deliver({
    type: "remote-desktop-channel-open",
    tunnelId: 1,
    path,
    protocols: [REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL],
    protocolVersion: RELAY_REMOTE_DESKTOP_CHANNEL_PROTOCOL_VERSION,
  });
  const deadline = Date.now() + 2_000;
  while (!h.opened.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(h.opened, [{
    kind: "remote-desktop",
    path,
    protocols: [REMOTE_DESKTOP_FALLBACK_MEDIA_SUBPROTOCOL],
  }]);
  assert.deepEqual(h.closes, [], "opening a channel must not tear down the shared encrypted Relay");
});
