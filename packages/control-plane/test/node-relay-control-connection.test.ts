import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { NODE_RELAY_CONTROL_PROTOCOL_VERSION } from "@task-handoff/cloud-contracts";
import { NodeRelayControlConnection } from "../src/node-agent/cloud-relay/control-connection.ts";

class FakeControlSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeControlSocket[] = [];
  readyState = FakeControlSocket.OPEN;
  readonly sent: any[] = [];
  readonly url: string;
  readonly options: any;

  constructor(url: string, options?: unknown) {
    super();
    this.url = url;
    this.options = options;
    FakeControlSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }

  send(raw: string) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.type === "register") {
      queueMicrotask(() => this.push({
        type: "registered",
        protocolVersion: NODE_RELAY_CONTROL_PROTOCOL_VERSION,
        nodeHandle: "nrh_node",
        leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
      }));
    }
    if (message.type === "heartbeat") {
      queueMicrotask(() => this.push({
        type: "heartbeat-ack",
        protocolVersion: NODE_RELAY_CONTROL_PROTOCOL_VERSION,
        leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
      }));
    }
  }

  close(code = 1000, reason = "closed") {
    if (this.readyState === FakeControlSocket.CLOSED) return;
    this.readyState = FakeControlSocket.CLOSED;
    queueMicrotask(() => this.emit("close", code, Buffer.from(reason)));
  }

  terminate() { this.close(1006, "terminated"); }
  push(value: unknown) { this.emit("message", { toString: () => JSON.stringify(value) }); }
}

async function waitFor(check: () => boolean, message: string) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("the node control connection snapshots after registration and every wake, then reconnects", async () => {
  FakeControlSocket.instances.length = 0;
  let snapshots = 0;
  const connection = new NodeRelayControlConnection({
    resolveTarget: async () => ({ origin: "https://cloud.example.test", credential: "node_credential", nodeId: "node_a" }),
    onSnapshotRequired: () => { snapshots += 1; },
    webSocket: FakeControlSocket as any,
    random: () => 0.5,
  });
  connection.start();
  await waitFor(() => snapshots === 1, "registration snapshot");
  const first = FakeControlSocket.instances[0];
  assert.equal(first.url, "wss://cloud.example.test/api/v1/node-relay/v1/connect");
  assert.equal(first.options.headers.authorization, "Bearer node_credential");
  assert.deepEqual(first.sent[0], { type: "register", protocolVersion: NODE_RELAY_CONTROL_PROTOCOL_VERSION, nodeId: "node_a" });

  first.push({ type: "node-relay-changed", protocolVersion: NODE_RELAY_CONTROL_PROTOCOL_VERSION, reason: "claim-changed" });
  await waitFor(() => snapshots === 2, "change snapshot");
  first.close(1006, "network-lost");
  await waitFor(() => FakeControlSocket.instances.length === 2 && snapshots === 3, "reconnect snapshot");
  connection.stop();
});

test("a rejected node credential is surfaced instead of retrying the control socket", async () => {
  FakeControlSocket.instances.length = 0;
  const rejected: any[] = [];
  const connection = new NodeRelayControlConnection({
    resolveTarget: async () => ({ origin: "https://cloud.example.test", credential: "stale", nodeId: "node_a" }),
    onSnapshotRequired: () => undefined,
    onCredentialRejected: (error) => rejected.push(error),
    webSocket: class extends FakeControlSocket {
      send(raw: string) {
        const message = JSON.parse(raw);
        this.sent.push(message);
        if (message.type !== "register") return;
        queueMicrotask(() => {
          this.push({ type: "error", protocolVersion: NODE_RELAY_CONTROL_PROTOCOL_VERSION, code: "NODE_RELAY_CREDENTIAL_INVALID", message: "credential is invalid" });
          this.close(4401, "NODE_RELAY_CREDENTIAL_INVALID");
        });
      }
    } as any,
  });
  connection.start();
  await waitFor(() => rejected.length === 1, "credential rejection");
  assert.equal(rejected[0].code, "NODE_RELAY_CREDENTIAL_INVALID");
  assert.equal(FakeControlSocket.instances.length, 1, "a rejected credential must not churn reconnects");
});

test("a restart during target resolution reconnects instead of leaving the control channel stopped", async () => {
  FakeControlSocket.instances.length = 0;
  let attempts = 0;
  let resolveFirstTarget: ((target: { origin: string; credential: string; nodeId: string }) => void) | undefined;
  let snapshots = 0;
  const target = { origin: "https://cloud.example.test", credential: "node_credential", nodeId: "node_a" };
  const connection = new NodeRelayControlConnection({
    resolveTarget: () => {
      attempts += 1;
      if (attempts === 1) return new Promise((resolve) => { resolveFirstTarget = resolve; });
      return Promise.resolve(target);
    },
    onSnapshotRequired: () => { snapshots += 1; },
    webSocket: FakeControlSocket as any,
    random: () => 0.5,
  });

  connection.start();
  await waitFor(() => Boolean(resolveFirstTarget), "first target resolution");
  connection.restart();
  resolveFirstTarget!(target);
  await waitFor(() => FakeControlSocket.instances.length === 1 && snapshots === 1, "replacement connection");
  assert.equal(attempts, 2);
  connection.stop();
});
