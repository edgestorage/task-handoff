import assert from "node:assert/strict";
import test from "node:test";
import { CloudConnectivityBackgroundRuntime } from "../src/control-plane/cloud-connectivity/coordinator-runtime.ts";
import { RelayLinkProbeLoop, relayEndpointProbeUrl, relayProbeUrl, type RelayLinkMeasurement } from "../src/control-plane/cloud-connectivity/relay-link-probe.ts";
import { ed25519Identity, nodeRelayAllocationEvent, nodeRelayFingerprint } from "./support/cloud-relay-node-harness.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function probeResponse(relayId: string) {
  return { ok: true, status: 200, json: async () => ({ relayId, region: null, now: new Date().toISOString(), draining: false, loadBucket: "low" }) };
}

function fakeIdentity() {
  return { publicIdentity: () => ({ controlPlaneId: "control_plane_test", publicKey: "key", fingerprint: "sha256:fingerprint" }), signCloudOutboundRegistration: () => "signature" };
}

type Responders = Record<string, () => Promise<any> | any>;

function probeFixture(options: { responses: Responders; fetchImpl?: () => Promise<any>; report?: (links: readonly RelayLinkMeasurement[]) => void; serviceOrigin?: string }) {
  const calls: string[] = [];
  const reported: RelayLinkMeasurement[][] = [];
  let clock = 0;
  const instance = new RelayLinkProbeLoop({
    serviceOrigin: () => options.serviceOrigin ?? "https://cloud.example.test",
    fetch: (async (url: URL) => {
      calls.push(String(url));
      if (options.fetchImpl) return options.fetchImpl();
      const responder = options.responses[new URL(String(url)).hostname];
      return responder ? responder() : { ok: false, status: 502, json: async () => ({}) };
    }) as unknown as typeof fetch,
    clock: () => clock,
    samples: 2,
    report: (links) => { reported.push([...links]); options.report?.(links); },
  });
  instance.observe("wss://relay.example.test/connect");
  return { instance, calls, reported, advance: (ms: number) => { clock += ms; } };
}

test("probe URLs keep an ad-hoc origin's port", () => {
  assert.equal(relayProbeUrl("https://cloud.example.test", "relay.example.test").href, "https://relay.example.test/probe");
  // An ad-hoc cloud serves the Relay from its own origin: dropping the port there would
  // point every probe at port 80 and silently disable linkage measurement.
  assert.equal(relayProbeUrl("http://127.0.0.1:8787", "127.0.0.1").href, "http://127.0.0.1:8787/probe");
  assert.equal(relayProbeUrl("https://cloud.example.test", "relay1.relay.example.test").href, "https://relay1.relay.example.test/probe");
});

test("an allocated Relay becomes the probe target", async () => {
  const probed: string[] = [];
  const instance = new RelayLinkProbeLoop({
    serviceOrigin: () => "https://cloud.example.test",
    fetch: (async (url: URL) => {
      probed.push(String(url));
      if (new URL(String(url)).hostname !== "relay1.relay.example.test") throw new Error("ENOTFOUND");
      return probeResponse("relay_a");
    }) as unknown as typeof fetch,
    samples: 1,
  });
  assert.deepEqual(await instance.refresh(), [], "nothing is probed before an allocation");
  instance.observe("wss://relay1.relay.example.test/connect");
  const measured = await instance.refresh();
  assert.equal(measured.length, 1);
  assert.equal(measured[0].relayId, "relay_a");
  assert.equal(probed.at(-1), "https://relay1.relay.example.test/probe");
  // A malformed or non-http allocation URL is ignored instead of poisoning the cycle.
  instance.observe(undefined);
  instance.observe("not a url");
  assert.equal((await instance.refresh()).length, 1);
  assert.equal(relayEndpointProbeUrl("ws://localhost:8080/connect").href, "http://localhost:8080/probe");
});

test("a probe cycle caches one measurement per Relay and reports the wire shape", async () => {
  const { instance, calls, reported } = probeFixture({ responses: { "relay.example.test": () => probeResponse("relay_a") } });
  const measured = await instance.refresh();
  assert.deepEqual(calls, ["https://relay.example.test/probe", "https://relay.example.test/probe"]);
  assert.equal(measured.length, 1);
  assert.equal(measured[0].relayId, "relay_a");
  assert.equal(measured[0].rttMs, 0);
  assert.equal(measured[0].updatedAt, new Date(0).toISOString());
  assert.deepEqual(reported, [[{ relayId: "relay_a", rttMs: 0, updatedAt: new Date(0).toISOString() }]]);
  assert.deepEqual(instance.links(), measured);
});

test("a fresher measurement replaces the cached one using the median of the successful samples", async () => {
  const timings = [10, 30];
  let sample = 0;
  const { instance, advance } = probeFixture({ responses: {}, fetchImpl: async () => { const value = timings[sample++ % timings.length]; advance(value); return probeResponse("relay_a"); } });
  const first = await instance.refresh();
  assert.equal(first[0].rttMs, 20);
  advance(5_000);
  const second = await instance.refresh();
  assert.equal(second[0].rttMs, 20);
  assert.ok(Date.parse(second[0].updatedAt) > Date.parse(first[0].updatedAt));
  assert.equal(instance.links().length, 1, "one Relay keeps one cache entry");
});

test("an unreachable Relay keeps its last known measurement and a silent one is never invented", async () => {
  let healthy = true;
  const { instance } = probeFixture({ responses: {}, fetchImpl: async () => { if (!healthy) throw new Error("ECONNREFUSED"); return probeResponse("relay_a"); } });
  const good = await instance.refresh();
  assert.equal(good.length, 1);
  healthy = false;
  assert.deepEqual(await instance.refresh(), [], "a failed cycle reports nothing new");
  assert.deepEqual(instance.links(), good, "the last known measurement survives; staleness is judged downstream");

  const silent = probeFixture({ responses: {} });
  assert.deepEqual(await silent.instance.refresh(), [], "a Relay that does not identify itself is not reported");
});

test("concurrent probe cycles share one round of requests", async () => {
  let calls = 0;
  const instance = new RelayLinkProbeLoop({
    serviceOrigin: () => "https://cloud.example.test",
    fetch: (async () => { calls += 1; await wait(5); return probeResponse("relay_a"); }) as unknown as typeof fetch,
    samples: 2,
  });
  instance.observe("wss://relay.example.test/connect");
  const [left, right] = await Promise.all([instance.probeOnce(), instance.probeOnce()]);
  assert.equal(calls, 2, "two samples, not four");
  assert.deepEqual(left, right);
});

test("the runtime reports its own Relay RTT hints over the control channel once bound", async () => {
  const sockets: any[] = [];
  const requests: any[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = FakeSocket.OPEN;
    listeners = new Map<string, ((...args: any[]) => void)[]>();
    sent: any[] = [];
    url: string;
    constructor(url: string) { this.url = url; sockets.push(this); queueMicrotask(() => this.emit("open")); }
    on(event: string, listener: (...args: any[]) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
    send(data: string) {
      const message = JSON.parse(data);
      this.sent.push(message);
      if (message.type === "register") queueMicrotask(() => this.emit("message", { toString: () => JSON.stringify({ type: "registered", controlPlaneId: "control_plane_test", reportedControlPlaneId: "control_plane_test", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }) }));
      if (message.type === "request" && message.operation === "report-relay-links") requests.push(message.payload);
    }
    close() { this.readyState = 3; queueMicrotask(() => this.emit("close", 1000, "closed")); }
    emit(event: string, ...args: any[]) { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args); }
  }
  const identity = fakeIdentity();
  const state = {
    snapshot: () => ({ status: "active", scopes: { deviceAccess: true, nodeRelay: false }, remoteAccessEnabled: true, serviceOrigin: "https://cloud.example.test", identity: identity.publicIdentity(), accountId: "account_a", bindingId: "binding_a", bindingRevision: 1 }),
    backgroundCredential: () => "c".repeat(43), nextConnectionEpoch: () => 1, setCloudControlPlaneId: () => undefined,
  };
  const probed: string[] = [];
  const runtime = new CloudConnectivityBackgroundRuntime({
    state, identity, webSocket: FakeSocket as any,
    relayLinkProbeIntervalMs: 10,
    fetch: (async (url: URL) => { probed.push(String(url)); return probeResponse("relay_a"); }) as unknown as typeof fetch,
  });
  runtime.start();
  runtime.relayLinks.observe("wss://relay.example.test/connect");
  for (let index = 0; index < 200 && !requests.length; index += 1) await wait(10);
  void runtime.stop();
  assert.deepEqual(probed.slice(0, 1), ["https://relay.example.test/probe"]);
  assert.equal(requests.length >= 1, true);
  assert.deepEqual(Object.keys(requests[0].links[0]).sort(), ["relayId", "rttMs", "updatedAt"]);
  assert.equal(requests[0].links[0].relayId, "relay_a");
  assert.equal(Number.isFinite(requests[0].links[0].rttMs), true);
  assert.equal(Number.isFinite(Date.parse(requests[0].links[0].updatedAt)), true);
});

test("an unbound Control Plane never probes and never reports", async () => {
  const probed: string[] = [];
  const runtime = new CloudConnectivityBackgroundRuntime({
    state: { snapshot: () => ({ status: "unbound", remoteAccessEnabled: false, serviceOrigin: "https://cloud.example.test" }), backgroundCredential: () => undefined, nextConnectionEpoch: () => 1 } as any,
    identity: fakeIdentity() as any,
    relayLinkProbeIntervalMs: 5,
    fetch: (async (url: URL) => { probed.push(String(url)); return probeResponse("relay_a"); }) as unknown as typeof fetch,
  });
  runtime.start();
  await wait(40);
  void runtime.stop();
  assert.deepEqual(probed, []);
});

test("a pushed node allocation starts attaching through the event path", async () => {
  const sockets: any[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = FakeSocket.OPEN;
    listeners = new Map<string, ((...args: any[]) => void)[]>();
    sent: any[] = [];
    constructor() { sockets.push(this); queueMicrotask(() => this.emit("open")); }
    on(event: string, listener: (...args: any[]) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
    send(data: string) {
      const message = JSON.parse(data);
      this.sent.push(message);
      if (message.type === "register") queueMicrotask(() => this.emit("message", { toString: () => JSON.stringify({ type: "registered", controlPlaneId: "control_plane_test", reportedControlPlaneId: "control_plane_test", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }) }));
    }
    close() { this.readyState = 3; queueMicrotask(() => this.emit("close", 1000, "closed")); }
    emit(event: string, ...args: any[]) { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args); }
    receive(value: any) { this.emit("message", { toString: () => JSON.stringify(value) }); }
  }

  const identity = fakeIdentity();
  const node = ed25519Identity();
  const state = {
    snapshot: () => ({ status: "active", scopes: { deviceAccess: false, nodeRelay: true }, identity: identity.publicIdentity(), cloudControlPlaneId: "control_plane_test", accountId: "account_a", bindingId: "binding_a", bindingRevision: 1, serviceOrigin: "https://cloud.example.com" }),
    backgroundCredential: () => "c".repeat(43),
    nextConnectionEpoch: () => 1,
    setCloudControlPlaneId: () => undefined,
  };
  let releaseAttach!: () => void;
  const attachGate = new Promise<void>((resolve) => { releaseAttach = resolve; });
  const connected: string[] = [];
  const nodes = {
    resolve: () => undefined,
    ensure: () => ({ nodeId: "node_alpha" }),
    savePairing: () => undefined,
    connected: (nodeId: string) => connected.push(nodeId),
    disconnected: () => undefined,
  };
  const transport = {
    attachNode: (nodeId: string) => { connected.push(`transport:${nodeId}`); return true; },
    detachNode: () => true,
    connected: () => false,
  };
  const runtime = new CloudConnectivityBackgroundRuntime({
    state, identity, webSocket: FakeSocket as any,
    fetch: (async () => probeResponse("relay_a")) as unknown as typeof fetch,
    relayLinkProbeIntervalMs: 60_000,
    nodeRelay: {
      connector: {
        async connect(input: any) {
          await attachGate;
          const pairing = input.createPairing();
          return { socket: {}, key: new Uint8Array(32), paired: false, issuedPairing: pairing, allocationId: input.allocation.allocationId, channelId: "channel_a" };
        },
      },
      transport: () => transport,
      nodes,
    },
  });
  runtime.start();
  for (let index = 0; index < 100 && !sockets.length; index += 1) await wait(5);
  const event = nodeRelayAllocationEvent({
    allocationId: "node_allocation_event",
    nodeHandle: "nrh_node_alpha",
    controlPlaneId: "control_plane_test",
    accountId: "account_a",
    bindingId: "binding_a",
    nodePublicKeyFingerprint: nodeRelayFingerprint(node.publicKey),
    relayUrl: "wss://relay.cloud.example.com/connect",
  });
  sockets[0].receive({ type: "event", event });
  await wait(10);
  assert.deepEqual(connected, [], "the attach remains asynchronous while the handshake waits");
  releaseAttach();
  for (let index = 0; index < 100 && !connected.includes("transport:node_alpha"); index += 1) await wait(5);
  assert.ok(connected.includes("node_alpha"));
  assert.ok(connected.includes("transport:node_alpha"));
  void runtime.stop();
});
