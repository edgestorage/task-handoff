import assert from "node:assert/strict";
import test from "node:test";
import { CloudConnectivityBackgroundRuntime } from "../src/control-plane/cloud-connectivity/coordinator-runtime.ts";
import { nodeRelayAllocationEvent } from "./support/cloud-relay-node-harness.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeIdentity() {
  return {
    publicIdentity: () => ({ controlPlaneId: "control_plane_test", publicKey: "key", fingerprint: "sha256:fingerprint" }),
    signCloudOutboundRegistration: () => "signature",
  };
}

function cloudRelayNodes(handles: string[]) {
  return {
    listForClaim: () => handles.map((nodeHandle) => ({ nodeHandle })),
    resolve: () => undefined,
    ensure: (input: { nodeId: string }) => ({ nodeId: input.nodeId }),
    savePairing: () => undefined,
    connected: () => undefined,
    disconnected: () => undefined,
  };
}

function runtimeFixture(input: { nodeRelay: boolean; handles: string[]; connector?: any }) {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = FakeSocket.OPEN;
    listeners = new Map<string, ((...args: any[]) => void)[]>();
    sent: any[] = [];
    constructor() {
      sockets.push(this);
      queueMicrotask(() => this.emit("open"));
    }
    on(event: string, listener: (...args: any[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }
    send(data: string) {
      const message = JSON.parse(data);
      this.sent.push(message);
      if (message.type === "register") {
        queueMicrotask(() => this.receive({
          type: "registered",
          controlPlaneId: "control_plane_test",
          reportedControlPlaneId: "control_plane_test",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }));
      }
      if (message.type === "request" && message.operation === "claim-node-relay-node") {
        queueMicrotask(() => this.receive({ type: "response", requestId: message.requestId, data: { status: "pending" } }));
      }
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.emit("close", 1000, "closed"));
    }
    emit(event: string, ...args: any[]) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }
    receive(value: any) {
      this.emit("message", { toString: () => JSON.stringify(value) });
    }
  }

  const identity = fakeIdentity();
  const state = {
    snapshot: () => ({
      status: "active",
      scopes: { deviceAccess: true, nodeRelay: input.nodeRelay },
      identity: identity.publicIdentity(),
      cloudControlPlaneId: "control_plane_test",
      accountId: "account_a",
      bindingId: "binding_a",
      bindingRevision: 1,
      serviceOrigin: "https://cloud.example.test",
    }),
    backgroundCredential: () => "c".repeat(43),
    nextConnectionEpoch: () => 1,
    setCloudControlPlaneId: () => undefined,
  };
  const runtime = new CloudConnectivityBackgroundRuntime({
    state,
    identity,
    webSocket: FakeSocket as any,
    fetch: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch,
    nodeRelay: {
      nodes: cloudRelayNodes(input.handles),
      transport: () => ({ attachNode: () => undefined, detachNode: () => true, connected: () => false }),
      ...(input.connector ? { connector: input.connector } : {}),
    },
  });
  return { runtime, sockets };
}

test("a fresh Coordinator connection restores existing cloud-relay node claims", async () => {
  const handles = ["nrh_macmini", "nrh_second"];
  const { runtime, sockets } = runtimeFixture({ nodeRelay: true, handles });
  runtime.start();
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (sockets[0]?.sent.filter((message) => message.operation === "claim-node-relay-node").length === handles.length) break;
      await wait(5);
    }
    const claims = sockets[0].sent.filter((message) => message.operation === "claim-node-relay-node");
    assert.deepEqual(claims.map((message) => message.payload.nodeHandle), handles);
    assert.deepEqual(claims.map((message) => message.payload.bindingId), ["binding_a", "binding_a"]);
    for (let attempt = 0; attempt < 100 && runtime.nodeRelayState().claims.length < handles.length; attempt += 1) await wait(5);
    assert.deepEqual(runtime.nodeRelayState().claims.map((claim) => claim.nodeHandle), handles);
  } finally {
    await runtime.stop();
  }
});

test("claim restoration does not run while node management is disabled", async () => {
  const { runtime, sockets } = runtimeFixture({ nodeRelay: false, handles: ["nrh_macmini"] });
  runtime.start();
  try {
    for (let attempt = 0; attempt < 100 && !sockets[0]?.sent.some((message) => message.type === "register"); attempt += 1) await wait(5);
    await wait(20);
    assert.equal(sockets[0]?.sent.some((message) => message.operation === "claim-node-relay-node"), false);
  } finally {
    await runtime.stop();
  }
});

test("an attach failure refreshes the Coordinator claim instead of waiting for a restart", async () => {
  const connector = {
    async connect() {
      throw Object.assign(new Error("The relay rejected a replayed attach capability."), { code: "RELAY_ATTACH_REPLAYED", retryable: true });
    },
  };
  const { runtime, sockets } = runtimeFixture({ nodeRelay: true, handles: ["nrh_macmini"], connector });
  runtime.start();
  try {
    for (let attempt = 0; attempt < 100 && runtime.nodeRelayState().claims.length === 0; attempt += 1) await wait(5);
    const event = nodeRelayAllocationEvent({
      allocationId: "allocation_stale_attach",
      nodeHandle: "nrh_macmini",
      controlPlaneId: "control_plane_test",
      accountId: "account_a",
      bindingId: "binding_a",
      nodePublicKeyFingerprint: `sha256:${"a".repeat(43)}`,
      relayUrl: "wss://cloud.example.test/relay",
    });
    sockets[0].receive({ type: "event", event });

    let refresh: any;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      refresh = sockets[0].sent.find((message) => message.operation === "claim-node-relay-node" && message.payload.refreshAllocation === true);
      if (refresh) break;
      await wait(5);
    }
    assert.ok(refresh, "the Control Plane must ask the Coordinator to retire the consumed attach capability");
    assert.equal(refresh.payload.nodeHandle, "nrh_macmini");
    const error = runtime.nodeRelayState().errors.find((entry: any) => entry.nodeHandle === "nrh_macmini");
    assert.equal(error?.code, "RELAY_ATTACH_REPLAYED");
  } finally {
    await runtime.stop();
  }
});
