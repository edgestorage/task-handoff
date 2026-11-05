import assert from "node:assert/strict";
import test from "node:test";
import { CloudConnectivityBackgroundRuntime } from "../src/control-plane/cloud-connectivity/coordinator-runtime.ts";
import type { CloudNodeRelayChannelsOptions } from "../src/control-plane/cloud-connectivity/node-relay-channels.ts";
import { nodeRelayAllocationEvent } from "./support/cloud-relay-node-harness.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeIdentity() {
  return {
    publicIdentity: () => ({ controlPlaneId: "control_plane_test", publicKey: "k".repeat(43), fingerprint: "sha256:fingerprint" }),
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

function runtimeFixture(input: { nodeRelay: boolean; handles: string[]; connector?: any; transport?: any; nodes?: CloudNodeRelayChannelsOptions["nodes"]; deferClaimResponses?: boolean; claimResponse?: (payload: any) => any; onChanged?: CloudNodeRelayChannelsOptions["onChanged"]; onTrustChanged?: CloudNodeRelayChannelsOptions["onTrustChanged"]; nodeRelayReconcileIntervalMs?: number; nodeRelayClaimGraceMs?: number }) {
  const sockets: FakeSocket[] = [];
  const deferredClaimResponses: Array<() => void> = [];
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
      if (message.type === "request" && message.operation === "revoke-node-relay-claim") {
        queueMicrotask(() => this.receive({ type: "response", requestId: message.requestId, data: { status: "revoked" } }));
      }
      if (message.type === "request" && message.operation === "claim-node-relay-node") {
        const data = input.claimResponse?.(message.payload) ?? {
          status: "pending",
          ...(message.payload?.trustRetry === true ? { trustRetryQueued: true } : {}),
        };
        const respond = () => this.receive({ type: "response", requestId: message.requestId, data });
        if (input.deferClaimResponses) deferredClaimResponses.push(respond);
        else queueMicrotask(respond);
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
    nodeRelayReconcileIntervalMs: input.nodeRelayReconcileIntervalMs,
    nodeRelayClaimGraceMs: input.nodeRelayClaimGraceMs,
    fetch: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch,
    nodeRelay: {
      nodes: input.nodes ?? cloudRelayNodes(input.handles),
      transport: () => input.transport ?? ({ attachNode: () => undefined, detachNode: () => true, connected: () => false }),
      ...(input.connector ? { connector: input.connector } : {}),
      ...(input.onChanged ? { onChanged: input.onChanged } : {}),
      ...(input.onTrustChanged ? { onTrustChanged: input.onTrustChanged } : {}),
    },
  });
  return {
    runtime,
    sockets,
    releaseClaimResponses: () => {
      for (const respond of deferredClaimResponses.splice(0)) respond();
    },
  };
}

test("a node with an existing original connection cannot be claimed again over the cloud relay", async () => {
  const { runtime, sockets } = runtimeFixture({
    nodeRelay: true,
    handles: [],
    nodes: {
      ...cloudRelayNodes([]),
      resolve: (nodeHandle) => nodeHandle === "nrh_existing"
        ? { nodeId: "node_original", preserveLocalConnection: true } : undefined,
    },
  });
  runtime.start();
  try {
    for (let attempt = 0; attempt < 100 && !sockets[0]?.sent.some((message) => message.type === "register"); attempt += 1) await wait(5);
    for (const options of [{}, { refreshAllocation: true }]) {
      await assert.rejects(runtime.claimAccountNode("nrh_existing", options), {
        code: "CLOUD_NODE_ALREADY_MANAGED", statusCode: 409,
      });
    }
    assert.equal(sockets[0].sent.some((message) => message.operation === "claim-node-relay-node"), false);
    assert.deepEqual(runtime.nodeRelayState().claims, []);

    await runtime.claimAccountNode("nrh_new");
    assert.deepEqual(sockets[0].sent.filter((message) => message.operation === "claim-node-relay-node").map((message) => message.payload.nodeHandle), ["nrh_new"]);
    assert.deepEqual(runtime.nodeRelayState().claims.map((claim) => claim.nodeHandle), ["nrh_new"]);
  } finally {
    await runtime.stop();
  }
});

test("a node binding hint publishes a relay change before its claim completes", async () => {
  const changes: Array<{ revision: number; reason: string; nodeHandle?: string; nodeId?: string }> = [];
  const { runtime, sockets, releaseClaimResponses } = runtimeFixture({
    nodeRelay: true,
    handles: [],
    deferClaimResponses: true,
    onChanged: (change) => changes.push(change),
  });
  runtime.start();
  try {
    for (let attempt = 0; attempt < 100 && !sockets[0]?.sent.some((message) => message.type === "register"); attempt += 1) {
      await wait(5);
    }
    sockets[0].receive({
      type: "event",
      event: { type: "node-relay-node-bound", nodeHandle: "nrh_new", tokenId: "token_new" },
    });
    for (let attempt = 0; attempt < 100 && !changes.some((change) => change.reason === "onboarding-hint"); attempt += 1) {
      await new Promise(setImmediate);
    }

    assert.equal(changes[0]?.reason, "onboarding-hint");
    assert.equal(changes[0]?.nodeHandle, "nrh_new");
    assert.deepEqual(runtime.nodeRelayState().onboarding.map((hint: any) => hint.nodeHandle), ["nrh_new"]);
  } finally {
    releaseClaimResponses();
    await runtime.stop();
  }
});

test("an explicit reapply queued behind another claim still carries its trust retry directive", async () => {
  const { runtime, sockets } = runtimeFixture({ nodeRelay: true, handles: [] });
  runtime.start();
  try {
    for (let attempt = 0; attempt < 100 && !sockets[0]?.sent.some((message) => message.type === "register"); attempt += 1) await wait(5);
    await Promise.all([
      runtime.claimAccountNode("nrh_reapply"),
      runtime.reapplyAccountNodeClaim("nrh_reapply"),
    ]);
    const claims = sockets[0].sent.filter((message) => message.operation === "claim-node-relay-node");
    assert.equal(claims.length, 2, "a concurrent reapply must not be collapsed into a no-op pending result");
    assert.equal(claims[0].payload.trustRetry, undefined);
    assert.equal(claims[1].payload.trustRetry, true);
  } finally {
    await runtime.stop();
  }
});

test("a legacy Coordinator cannot turn a trust retry into a false success", async () => {
  const { runtime, sockets } = runtimeFixture({
    nodeRelay: true,
    handles: [],
    claimResponse: () => ({ claimed: true, status: "pending" }),
  });
  runtime.start();
  try {
    for (let attempt = 0; attempt < 100 && !sockets[0]?.sent.some((message) => message.type === "register"); attempt += 1) await wait(5);
    await assert.rejects(runtime.reapplyAccountNodeClaim("nrh_reapply_legacy"), {
      code: "CLOUD_NODE_TRUST_RETRY_COORDINATOR_UNSUPPORTED",
      statusCode: 409,
    });
  } finally {
    await runtime.stop();
  }
});

test("a Coordinator identifies a Node Agent that cannot consume a trust retry", async () => {
  const { runtime, sockets } = runtimeFixture({
    nodeRelay: true,
    handles: [],
    claimResponse: (payload) => payload?.trustRetry === true
      ? { claimed: true, status: "pending", trustRetryQueued: false, trustRetryUnsupportedReason: "node-agent-upgrade-required" }
      : { claimed: true, status: "pending" },
  });
  runtime.start();
  try {
    for (let attempt = 0; attempt < 100 && !sockets[0]?.sent.some((message) => message.type === "register"); attempt += 1) await wait(5);
    await assert.rejects(runtime.reapplyAccountNodeClaim("nrh_reapply_old_agent"), {
      code: "CLOUD_NODE_TRUST_RETRY_NODE_AGENT_UNSUPPORTED",
      statusCode: 409,
    });
  } finally {
    await runtime.stop();
  }
});

test("a revoke waits for an in-flight claim before reaching the Coordinator", async () => {
  const { runtime, sockets, releaseClaimResponses } = runtimeFixture({ nodeRelay: true, handles: [], deferClaimResponses: true });
  runtime.start();
  try {
    for (let attempt = 0; attempt < 100 && !sockets[0]?.sent.some((message) => message.type === "register"); attempt += 1) await wait(5);
    const claim = runtime.claimAccountNode("nrh_race");
    for (let attempt = 0; attempt < 100 && !sockets[0]?.sent.some((message) => message.operation === "claim-node-relay-node"); attempt += 1) await wait(5);

    const revoke = runtime.revokeAccountNodeClaim("nrh_race");
    await new Promise(setImmediate);
    assert.equal(sockets[0].sent.some((message) => message.operation === "revoke-node-relay-claim"), false);

    releaseClaimResponses();
    await claim;
    await revoke;
    assert.deepEqual(
      sockets[0].sent.filter((message) => ["claim-node-relay-node", "revoke-node-relay-claim"].includes(message.operation)).map((message) => message.operation),
      ["claim-node-relay-node", "revoke-node-relay-claim"],
    );
    assert.deepEqual(runtime.nodeRelayState().claims, []);
  } finally {
    await runtime.stop();
  }
});

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

test("claim restoration follows the binding even when an N-1 file says node relay is off", async () => {
  const { runtime, sockets } = runtimeFixture({ nodeRelay: false, handles: ["nrh_macmini"] });
  runtime.start();
  try {
    for (let attempt = 0; attempt < 100 && !sockets[0]?.sent.some((message) => message.operation === "claim-node-relay-node"); attempt += 1) await wait(5);
    assert.equal(sockets[0]?.sent.some((message) => message.operation === "claim-node-relay-node"), true);
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
    assert.equal(refresh.payload.failedRelayId, event.relayId, "a real attach failure must identify the failed Relay");
    const error = runtime.nodeRelayState().errors.find((entry: any) => entry.nodeHandle === "nrh_macmini");
    assert.equal(error?.code, "RELAY_ATTACH_REPLAYED");
  } finally {
    await runtime.stop();
  }
});

test("a live node channel closing refreshes the Coordinator claim", async () => {
  let closeChannel: ((reason: string) => void) | undefined;
  const connector = {
    async connect(input: any) {
      return {
        socket: {
          readyState: 1,
          bufferedAmount: 0,
          send() {},
          close() {},
          on() {},
          off() {},
        },
        key: new Uint8Array(32),
        nodeId: "node_macmini",
        paired: true,
        allocationId: input.allocation.allocationId,
      };
    },
  };
  const transport = {
    attachNode(_nodeId: string, input: { onClosed?(reason: string): void }) {
      closeChannel = input.onClosed;
    },
    detachNode: () => true,
    connected: () => true,
  };
  const { runtime, sockets } = runtimeFixture({ nodeRelay: true, handles: ["nrh_macmini"], connector, transport });
  runtime.start();
  try {
    for (let attempt = 0; attempt < 100 && runtime.nodeRelayState().claims.length === 0; attempt += 1) await wait(5);
    const event = nodeRelayAllocationEvent({
      allocationId: "allocation_live_channel",
      nodeHandle: "nrh_macmini",
      nodeId: "node_macmini",
      controlPlaneId: "control_plane_test",
      accountId: "account_a",
      bindingId: "binding_a",
      nodePublicKeyFingerprint: `sha256:${"b".repeat(43)}`,
      relayUrl: "wss://cloud.example.test/relay",
    });
    sockets[0].receive({ type: "event", event });
    for (let attempt = 0; attempt < 100 && (!closeChannel || runtime.nodeRelayState().channels.length === 0); attempt += 1) await wait(5);
    assert.ok(closeChannel, "the allocation must reach the transport");
    assert.equal(runtime.nodeRelayState().channels[0]?.nodeHandle, "nrh_macmini");

    closeChannel!("relay-lost");

    let refresh: any;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      refresh = sockets[0].sent.find((message) => message.operation === "claim-node-relay-node" && message.payload.refreshAllocation === true);
      if (refresh) break;
      await wait(5);
    }
    assert.ok(refresh, "a closed live channel must request a fresh allocation");
    assert.equal(refresh.payload.nodeHandle, "nrh_macmini");
    assert.equal(refresh.payload.failedRelayId, event.relayId, "a lost live socket must identify the failed Relay");
    assert.equal(runtime.nodeRelayState().channels.length, 0);
  } finally {
    await runtime.stop();
  }
});

test("reconciliation refreshes a stale claim that never became a live channel", async () => {
  const { runtime, sockets } = runtimeFixture({
    nodeRelay: true,
    handles: ["nrh_macmini"],
    nodeRelayReconcileIntervalMs: 10,
    nodeRelayClaimGraceMs: 1,
  });
  runtime.start();
  try {
    for (let attempt = 0; attempt < 100 && runtime.nodeRelayState().claims.length === 0; attempt += 1) await wait(5);
    assert.deepEqual(runtime.nodeRelayState().claims.map((claim) => claim.nodeHandle), ["nrh_macmini"]);

    let refresh: any;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      refresh = sockets[0].sent.find((message) => message.operation === "claim-node-relay-node" && message.payload.refreshAllocation === true);
      if (refresh) break;
      await wait(5);
    }
    assert.ok(refresh, "a claim without a live channel must not suppress recovery forever");
    assert.equal(refresh.payload.nodeHandle, "nrh_macmini");
  } finally {
    await runtime.stop();
  }
});

test("pending node trust keeps probing without timing out human approval", async (t) => {
  const trustChanges: Array<{ nodeHandle: string; nodeId: string; requestId?: string; state?: "pending" | "rejected" | "expired" }> = [];
  const connector = {
    async connect(input: any) {
      return {
        status: "trust-required",
        outcome: {
          nodeId: "node_macmini",
          state: "pending",
          reason: "first-seen",
          controlPlaneId: "control_plane_test",
          controlPlanePublicKeyFingerprint: `sha256:${"c".repeat(43)}`,
          requestId: "cptreq_pending",
          requestedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          allocationId: input.allocation.allocationId,
        },
      };
    },
  };
  const { runtime, sockets } = runtimeFixture({
    nodeRelay: true,
    handles: ["nrh_macmini"],
    connector,
    onTrustChanged: (change) => trustChanges.push(change),
  });
  runtime.start();
  try {
    for (let attempt = 0; attempt < 100 && runtime.nodeRelayState().claims.length === 0; attempt += 1) await wait(5);
    const event = nodeRelayAllocationEvent({
      allocationId: "allocation_pending_probe",
      nodeHandle: "nrh_macmini",
      nodeId: "node_macmini",
      controlPlaneId: "control_plane_test",
      accountId: "account_a",
      bindingId: "binding_a",
      nodePublicKeyFingerprint: `sha256:${"d".repeat(43)}`,
      relayUrl: "wss://cloud.example.test/relay",
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    sockets[0].receive({ type: "event", event });
    for (let attempt = 0; attempt < 100 && runtime.nodeRelayState().trust.length === 0; attempt += 1) await new Promise(setImmediate);
    t.mock.timers.tick(250);

    let refresh: any;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      refresh = sockets[0].sent.find((message) => message.operation === "claim-node-relay-node" && message.payload.refreshAllocation === true);
      if (refresh) break;
      await new Promise(setImmediate);
    }
    assert.ok(refresh, "pending trust must keep requesting fresh allocations");
    assert.equal(refresh.payload.failedRelayId, undefined, "pending approval must not cool down a healthy Relay");

    // Advance beyond the former 20-second transport timeout. The node has
    // answered; only its signed trust outcome may end the approval wait.
    t.mock.timers.tick(25_000);
    assert.equal(runtime.nodeRelayState().trust[0]?.state, "pending");
    assert.deepEqual(runtime.nodeRelayState().errors, []);
    assert.deepEqual(trustChanges, [{
      nodeHandle: "nrh_macmini",
      nodeId: "node_macmini",
      requestId: "cptreq_pending",
      state: "pending",
    }]);
    await runtime.revokeAccountNodeClaim("nrh_macmini");
    const claimsAfterCancel = sockets[0].sent.filter((message) => message.operation === "claim-node-relay-node").length;
    sockets[0].receive({ type: "event", event: { ...event, allocationId: "late_after_cancel" } });
    t.mock.timers.tick(60_000);
    await new Promise(setImmediate);
    assert.deepEqual(runtime.nodeRelayState().trust, []);
    assert.deepEqual(runtime.nodeRelayState().claims, []);
    assert.deepEqual(trustChanges[1], {
      nodeHandle: "nrh_macmini",
      nodeId: "node_macmini",
      requestId: "cptreq_pending",
    });
    assert.equal(sockets[0].sent.filter((message) => message.operation === "claim-node-relay-node").length, claimsAfterCancel);
  } finally {
    await runtime.stop();
  }
});

test("a rejected node trust outcome stays terminal without automatic probing", async () => {
  const connector = {
    async connect(input: any) {
      return {
        status: "trust-required",
        outcome: {
          nodeId: "node_macmini",
          state: "rejected",
          reason: "rejected",
          controlPlaneId: "control_plane_test",
          controlPlanePublicKeyFingerprint: `sha256:${"e".repeat(43)}`,
          requestId: "cptreq_rejected",
          requestedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          allocationId: input.allocation.allocationId,
        },
      };
    },
  };
  const { runtime, sockets } = runtimeFixture({
    nodeRelay: true,
    handles: ["nrh_macmini"],
    connector,
  });
  runtime.start();
  try {
    for (let attempt = 0; attempt < 100 && runtime.nodeRelayState().claims.length === 0; attempt += 1) await wait(5);
    const event = nodeRelayAllocationEvent({
      allocationId: "allocation_rejected_probe",
      nodeHandle: "nrh_macmini",
      nodeId: "node_macmini",
      controlPlaneId: "control_plane_test",
      accountId: "account_a",
      bindingId: "binding_a",
      nodePublicKeyFingerprint: `sha256:${"f".repeat(43)}`,
      relayUrl: "wss://cloud.example.test/relay",
    });
    sockets[0].receive({ type: "event", event });
    for (let attempt = 0; attempt < 100 && runtime.nodeRelayState().trust[0]?.state !== "rejected"; attempt += 1) await wait(5);
    await wait(120);
    assert.equal(runtime.nodeRelayState().trust[0]?.state, "rejected");
    assert.equal(sockets[0].sent.some((message) => message.operation === "claim-node-relay-node" && message.payload.refreshAllocation === true), false);
    assert.equal(runtime.nodeRelayState().errors.some((entry: any) => entry.code === "NODE_RELAY_TRUST_TIMEOUT"), false);
  } finally {
    await runtime.stop();
  }
});
