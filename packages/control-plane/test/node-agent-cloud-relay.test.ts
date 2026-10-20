import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import { createNodeAgentApp } from "../src/node-agent/app.ts";
import { createNodeAgentHmacHeaders } from "../src/shared/security/node-agent-auth.ts";
import type { NodeAgentIdentityService } from "../src/node-agent/identity/service.ts";
import type { NodeAgentCloudRelayClient } from "../src/node-agent/cloud-relay/client.ts";
import type { CloudDiscovery } from "../../../shared/cloud-environments.cjs";
import {
  cloudRelayCloudStub,
  ed25519Identity,
  fakeRelayWebSocket,
  nodeRelayFingerprint,
  startCloudRelayControlPlanePeer,
} from "./support/cloud-relay-node-side-harness.ts";

const AUTH_TOKEN = "cloud-relay-node-test-token";
const SERVICE_ORIGIN = "https://cloud.example.com";

type CloudStub = ReturnType<typeof cloudRelayCloudStub>;
type ControlPlanePeer = Awaited<ReturnType<typeof startCloudRelayControlPlanePeer>>;

type PlaneState = {
  identity: ReturnType<typeof ed25519Identity>;
  peers: Array<Promise<ControlPlanePeer | undefined>>;
  errors: unknown[];
  pairing?: { keyId: string; secret: string };
  createPairing?: () => { keyId: string; secret: string };
};

async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, message: string, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function authorizationHeaders() {
  return { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
}

async function cloudRelayFixture(t: test.TestContext, stub: CloudStub, options: {
  fetchImpl?: typeof fetch;
  cloudDiscovery?: CloudDiscovery;
  discoveryCachePath?: string;
} = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-node-cloud-relay-"));
  const planes = new Map<string, PlaneState>();
  const connections: Array<{ controlPlaneId: string; url: string }> = [];
  const app = await createNodeAgentApp({
    dataDir,
    nodeId: "node_cloud_relay",
    token: AUTH_TOKEN,
    logger: false,
    fetchImpl: options.fetchImpl ?? stub.fetchImpl,
    ...(options.cloudDiscovery ? { cloudDiscovery: options.cloudDiscovery } : {}),
    ...(options.discoveryCachePath ? { discoveryCachePath: options.discoveryCachePath } : {}),
    webSocket: fakeRelayWebSocket({
      onConnection(peer, url) {
        // The Relay routes by the attach capability; the test relay reads the
        // capability to learn which Control Plane dialed before handing the
        // socket to that Control Plane's peer implementation.
        const capture = (raw: unknown) => {
          let value: any;
          try {
            value = JSON.parse(Buffer.from(raw as Buffer).toString("utf8"));
          } catch {
            return;
          }
          if (value?.type !== "attach") return;
          peer.off("message", capture);
          const controlPlaneId = String(value.capability?.controlPlaneId ?? "");
          const plane = planes.get(controlPlaneId);
          if (!plane) {
            peer.close(4404, "unknown-control-plane");
            return;
          }
          const allocation = stub.issuedAllocation(controlPlaneId);
          const binding = app.nodeAgentIdentityService.cloudRelayBinding();
          if (!allocation || !binding) {
            peer.close(4404, "no-allocation");
            return;
          }
          connections.push({ controlPlaneId, url });
          // A real Relay answers asynchronously; the node registers the
          // "attached" listener right after sending the attach frame.
          queueMicrotask(() => {
            plane.peers.push(startCloudRelayControlPlanePeer({
              socket: peer,
              controlPlaneId,
              identity: plane.identity,
              allocation: { ...allocation.claimGrant, nodePublicKeyFingerprint: nodeRelayFingerprint(binding.relayPublicKey) },
              ...(plane.pairing ? { pairing: plane.pairing } : {}),
              ...(plane.createPairing ? { createPairing: plane.createPairing } : {}),
              attachCapability: value.capability,
            }).catch((error: unknown) => {
              plane.errors.push(error);
              return undefined;
            }));
          });
        };
        peer.on("message", capture);
      },
    }),
  });
  // HTTP response streams and proxied WebSockets dial the node agent over
  // loopback, so the fixture needs a real listener rather than inject-only.
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address !== "object") throw new Error("node agent test server did not bind a TCP port");
  app.nodeAgentState!.setListenerPort(address.port);
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const planeFor = (controlPlaneId: string) => {
    const existing = planes.get(controlPlaneId);
    if (existing) return existing;
    const identity = ed25519Identity();
    const plane: PlaneState = { identity, peers: [], errors: [] };
    planes.set(controlPlaneId, plane);
    stub.claimNode({
      controlPlaneId,
      controlPlanePublicKey: identity.publicKey,
      bindingId: `binding_${controlPlaneId}`,
      bindingRevision: 1,
    });
    return plane;
  };
  const connect = async (controlPlaneId: string) => {
    const plane = planes.get(controlPlaneId);
    assert.ok(plane, `control plane ${controlPlaneId} is not registered in this test`);
    await waitFor(() => plane.peers.length > 0, `control plane ${controlPlaneId} to dial the relay`);
    return waitFor(async () => {
      const peer = await plane.peers[plane.peers.length - 1];
      if (!peer && plane.errors.length) throw plane.errors[plane.errors.length - 1];
      return peer;
    }, `control plane ${controlPlaneId} handshake`);
  };
  const relay = app.nodeAgentCloudRelay as NodeAgentCloudRelayClient;
  const identityService = app.nodeAgentIdentityService as NodeAgentIdentityService;
  const hmacFor = (pairing: { keyId: string; secret: string }) => (method: string, url: string, payload?: unknown) => ({
    ...createNodeAgentHmacHeaders({
      nodeId: "node_cloud_relay",
      keyId: pairing.keyId,
      secret: pairing.secret,
      method,
      pathWithQuery: url,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }),
    ...(payload === undefined ? {} : { "content-type": "application/json" }),
  });
  // Once a Control Plane is paired the node rejects unauthenticated local
  // calls, so tests sign with the pairing the relay just enrolled.
  const localHeaders = (method: string, url: string, payload?: unknown) => {
    for (const controlPlaneId of identityService.cloudRelayBinding()?.pairedControlPlaneIds ?? []) {
      const pairing = identityService.cloudRelayPairing(controlPlaneId);
      if (pairing) return hmacFor(pairing)(method, url, payload);
    }
    return authorizationHeaders();
  };
  return { app, stub, relay, identityService, planes, connections, planeFor, connect, hmacFor, localHeaders };
}

async function bind(app: FastifyInstance, stub: CloudStub, displayName?: string, headers: Record<string, string> = authorizationHeaders()) {
  const response = await app.inject({
    method: "POST",
    url: "/api/node-agent/cloud-relay/bind",
    headers,
    payload: { cloudOrigin: SERVICE_ORIGIN, bindingToken: stub.state.bindingToken, ...(displayName ? { displayName } : {}) },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().data;
}

async function status(app: FastifyInstance, headers: Record<string, string> = authorizationHeaders()) {
  const response = await app.inject({ method: "GET", url: "/api/node-agent/cloud-relay", headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().data;
}

test("binding redeems the token, persists the account binding and never exposes secrets in status", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  const { app, relay, identityService } = await cloudRelayFixture(t, stub);

  const response = await app.inject({
    method: "POST",
    url: "/api/node-agent/cloud-relay/bind",
    headers: authorizationHeaders(),
    payload: { cloudOrigin: "http://cloud.example.com", bindingToken: stub.state.bindingToken },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error.code, "NODE_AGENT_CLOUD_RELAY_ORIGIN_INSECURE");

  const bound = await bind(app, stub, "Build box");
  assert.equal(bound.bound, true);
  assert.equal(bound.nodeHandle, "nrh_test_node_handle");
  assert.equal(bound.accountId, "account_test");
  assert.equal(bound.cloudOrigin, SERVICE_ORIGIN);
  assert.deepEqual(stub.state.redemptions, [{ displayName: "Build box" }]);

  const binding = identityService.cloudRelayBinding();
  assert.ok(binding, "binding persisted");
  assert.equal(binding.status, "active");
  assert.equal(binding.credential, "thnc_test_credential_000000000000");
  assert.equal(binding.serviceSigningKey?.kid, stub.signingKey.kid);
  assert.match(binding.relayPublicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(binding.credentialExpiresAt > new Date().toISOString());

  const snapshot = await status(app);
  assert.equal(snapshot.bound, true);
  assert.deepEqual(snapshot.channels, []);
  const serialized = JSON.stringify(snapshot);
  for (const secret of [binding.credential, binding.relayPrivateKey, binding.serviceSigningKey!.publicKey]) {
    assert.equal(serialized.includes(secret), false, "status must not expose binding secrets");
  }
  assert.equal(relay.binding()?.nodeHandle, "nrh_test_node_handle");
});

test("node agent discovers the cloud origin from TXT before binding", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    calls.push(url.href);
    if (url.hostname === "dns.alidns.com") {
      return new Response(JSON.stringify({ Answer: [{ type: 16, data: "v1 backup.cloud.example.com" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return stub.fetchImpl(input, init);
  };
  const { app, identityService } = await cloudRelayFixture(t, stub, {
    fetchImpl,
    cloudDiscovery: {
      record: "_cloud.example.com",
      fallbackOrigin: SERVICE_ORIGIN,
      allowedHostSuffixes: ["example.com"],
    },
  });

  const bound = await bind(app, stub);
  assert.equal(bound.cloudOrigin, SERVICE_ORIGIN);
  assert.equal(identityService.cloudRelayBinding()?.cloudOrigin, SERVICE_ORIGIN);
  assert.ok(calls.some((url) => url.startsWith("https://dns.alidns.com/")), "the node must resolve the discovery TXT record");
  assert.ok(calls.some((url) => url === "https://backup.cloud.example.com/api/v1/node-relay/v1/redeem"), "redemption must use the discovered origin");
  assert.equal(calls.some((url) => url === `${SERVICE_ORIGIN}/api/v1/node-relay/v1/redeem`), false);
});

test("a claiming Control Plane gets a paired channel, tunnel requests round-trip and the pairing survives reconnect", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  const { app, relay, identityService, planeFor, connect, localHeaders } = await cloudRelayFixture(t, stub);
  const controlPlaneId = "control_plane_one";
  const plane = planeFor(controlPlaneId);
  await bind(app, stub);

  relay.pollNow();
  const first = await connect(controlPlaneId);
  const hello = await first.waitForMessage((message) => message.type === "node-agent.identify");
  assert.equal(hello.nodeId, "node_cloud_relay");
  assert.equal(first.paired, false, "the first claim enrolls a fresh pairing");
  assert.ok(first.issuedPairing, "the Control Plane issued the pairing");
  const request = await first.request("/health");
  assert.equal(request.status, 200, JSON.stringify(request));
  const body = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
  assert.equal(body.data.role, "node-agent");

  const pairing = identityService.cloudRelayPairing(controlPlaneId);
  assert.deepEqual(pairing, first.issuedPairing);
  const initialAllocationId = stub.issuedAllocation(controlPlaneId).allocationId;
  assert.deepEqual(identityService.cloudRelayBinding()?.pairedControlPlaneIds, [controlPlaneId]);
  const connected = await status(app, localHeaders("GET", "/api/node-agent/cloud-relay"));
  assert.equal(connected.channels[0]?.controlPlaneId, controlPlaneId);
  assert.equal(connected.channels[0]?.status, "connected");

  // The node reconnects with the stored pairing; the Control Plane verifies the
  // paired HMAC instead of enrolling a second pairing.
  plane.pairing = pairing!;
  first.close("test-drop");
  relay.pollNow();
  await waitFor(() => {
    const issued = stub.issuedAllocation(controlPlaneId);
    return issued?.allocationId !== initialAllocationId ? issued : undefined;
  }, "a fresh allocation after the one-time attach was consumed");
  assert.ok(stub.state.allocationRequests.some((request) =>
    Array.isArray(request.refreshControlPlaneIds) && request.refreshControlPlaneIds.includes(controlPlaneId)));
  const second = await waitFor(async () => {
    if (plane.peers.length < 2) return undefined;
    return plane.peers[1] as Promise<ControlPlanePeer | undefined>;
  }, "reconnect after drop");
  assert.ok(second);
  assert.equal(second!.paired, true);
  assert.equal(second!.issuedPairing, undefined);
  assert.deepEqual(identityService.cloudRelayBinding()?.pairedControlPlaneIds, [controlPlaneId]);
  const reconnected = await second!.request("/health");
  assert.equal(reconnected.status, 200);
});

test("two Control Planes claim one node and run independent channels", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  const { app, relay, identityService, planeFor, connect, localHeaders } = await cloudRelayFixture(t, stub);
  const one = planeFor("control_plane_one");
  const two = planeFor("control_plane_two");
  await bind(app, stub);
  relay.pollNow();

  const [peerOne, peerTwo] = await Promise.all([connect("control_plane_one"), connect("control_plane_two")]);
  both: {
    const [healthOne, healthTwo] = await Promise.all([peerOne.request("/health"), peerTwo.request("/health")]);
    assert.equal(healthOne.status, 200);
    assert.equal(healthTwo.status, 200);
  }
  const bothConnected = await waitFor(async () => {
    const snapshot = await status(app, localHeaders("GET", "/api/node-agent/cloud-relay"));
    return snapshot.channels.filter((channel: any) => channel.status === "connected").length === 2 ? snapshot : undefined;
  }, "both channels connected");
  assert.deepEqual(bothConnected.channels.map((channel: any) => channel.controlPlaneId), ["control_plane_one", "control_plane_two"]);

  // Losing one claim only reaps that channel; the other keeps working.
  stub.dropClaim("control_plane_one");
  // The withdrawal must be observed on two consecutive polls before the node
  // tears the channel down, so keep polling until the state converges.
  await waitFor(async () => {
    relay.pollNow();
    const snapshot = await status(app, localHeaders("GET", "/api/node-agent/cloud-relay"));
    return snapshot.channels.every((channel: any) => channel.controlPlaneId !== "control_plane_one") ? snapshot : undefined;
  }, "first channel released");
  const remaining = await peerTwo.request("/health");
  assert.equal(remaining.status, 200);
  const final = await status(app, localHeaders("GET", "/api/node-agent/cloud-relay"));
  assert.deepEqual(final.channels.map((channel: any) => channel.controlPlaneId), ["control_plane_two"]);
  assert.equal(one.errors.length, 0);
  assert.equal(two.errors.length, 0);
});

test("an account relay streams HTTP bodies and bridges websockets over auxiliary channels", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  const { app, relay, planeFor, connect } = await cloudRelayFixture(t, stub);
  planeFor("control_plane_streams");
  await bind(app, stub);
  relay.pollNow();
  const peer = await connect("control_plane_streams");
  await peer.waitForMessage((message) => message.type === "node-agent.identify");

  const stream = await peer.openHttpStream("stream_health", "/health");
  assert.equal(stream.error, undefined, stream.error);
  assert.equal(stream.head?.status, 200);
  assert.equal(stream.ended, true);
  assert.equal(JSON.parse(stream.body.toString("utf8")).data.role, "node-agent");

  const socket = await peer.openWebSocket("ws_events", "/events");
  const connected = await socket.waitForText((value) => value.type === "node-agent.events.connected");
  assert.equal(connected.nodeId, "node_cloud_relay");
  socket.send(JSON.stringify({ type: "subscribe", aiSessionTransient: false }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(peer.messages.filter((message) => message.type === "node-agent.websocket.error"), []);
  socket.close();
});

test("a shared node allocation keeps the owner credential local and binds the grantee Control Plane", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN, accountId: "account_owner" });
  const { app, relay, identityService, planeFor, connect, localHeaders } = await cloudRelayFixture(t, stub);
  const plane = planeFor("control_plane_grantee");
  stub.claimNode({
    controlPlaneId: "control_plane_grantee",
    controlPlanePublicKey: plane.identity.publicKey,
    accountId: "account_grantee",
    ownerAccountId: "account_owner",
    accessMode: "shared",
    shareGrantId: "share_node_a",
    shareRevision: 3,
    shareRole: "use",
    bindingId: "binding_control_plane_grantee",
    bindingRevision: 1,
  });
  await bind(app, stub);
  relay.pollNow();
  const peer = await connect("control_plane_grantee");
  assert.equal((await peer.request("/health")).status, 200);
  const snapshot = await status(app, localHeaders("GET", "/api/node-agent/cloud-relay"));
  assert.equal(snapshot.channels[0]?.controlPlaneId, "control_plane_grantee");
  assert.equal(snapshot.channels[0]?.status, "connected");
  const serialized = JSON.stringify({ snapshot, allocation: stub.issuedAllocation("control_plane_grantee") });
  const binding = identityService.cloudRelayBinding();
  assert.ok(binding);
  assert.equal(serialized.includes(binding.credential), false);
  assert.equal(serialized.includes(binding.relayPrivateKey), false);
  assert.equal(serialized.includes(binding.serviceSigningKey!.publicKey), false, "even the public signing key stays out of the allocation");
});

test("a signed node grant cannot claim another node owner", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN, accountId: "account_owner" });
  const { app, relay, planeFor, connections } = await cloudRelayFixture(t, stub);
  planeFor("control_plane_grantee");
  stub.claimNode({
    controlPlaneId: "control_plane_grantee",
    controlPlanePublicKey: planeFor("control_plane_grantee").identity.publicKey,
    accountId: "account_grantee",
    ownerAccountId: "account_owner",
    accessMode: "shared",
    shareGrantId: "share_node_a",
    shareRevision: 3,
    shareRole: "use",
    bindingId: "binding_control_plane_grantee",
    bindingRevision: 1,
  });
  stub.setAllocationTransform((allocation) => {
    const { signature, ...payload } = allocation.claimGrant;
    const forged = { ...payload, ownerAccountId: "account_forged" };
    return { ...allocation, claimGrant: { ...forged, signature: stub.signingKey.sign("node-relay-claim-grant", forged) } };
  });
  await bind(app, stub);
  relay.pollNow();
  const failed = await waitFor(async () => {
    const snapshot = await status(app);
    return snapshot.lastError?.code === "NODE_AGENT_CLOUD_RELAY_ALLOCATION_MISMATCH" ? snapshot : undefined;
  }, "forged owner grant to be rejected");
  assert.equal(failed.lastError.retryable, true);
  assert.equal(connections.length, 0);
});

test("an allocation whose claim grant fails verification is recorded and never dialed", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  const { app, relay, planeFor, connections } = await cloudRelayFixture(t, stub);
  planeFor("control_plane_one");
  stub.setAllocationTransform((allocation) => ({
    ...allocation,
    claimGrant: { ...allocation.claimGrant, controlPlaneId: "control_plane_forged" },
  }));
  await bind(app, stub);
  relay.pollNow();

  const failed = await waitFor(async () => {
    const snapshot = await status(app);
    return snapshot.lastError?.code === "NODE_RELAY_CLAIM_GRANT_SIGNATURE_INVALID" ? snapshot : undefined;
  }, "tampered grant to be rejected");
  assert.equal(failed.lastError.retryable, true);
  assert.equal(connections.length, 0);
  assert.deepEqual(failed.channels.map((channel: any) => channel.controlPlaneId), ["control_plane_forged"]);
  assert.equal(failed.channels[0].status, "failed");
});

test("a refused credential stops the channels and requires rebinding", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  const { app, relay, planeFor, connect, localHeaders } = await cloudRelayFixture(t, stub);
  planeFor("control_plane_one");
  await bind(app, stub);
  relay.pollNow();
  await connect("control_plane_one");

  stub.revokeCredential();
  relay.pollNow();
  const revoked = await waitFor(async () => {
    const snapshot = await status(app, localHeaders("GET", "/api/node-agent/cloud-relay"));
    return snapshot.rebindRequired === true ? snapshot : undefined;
  }, "credential rejection to require rebinding");
  assert.equal(revoked.bound, true);
  assert.deepEqual(revoked.channels, []);
  assert.equal(revoked.lastError.code, "NODE_RELAY_CREDENTIAL_INVALID");
  assert.equal(relay.binding()?.status, "rebind-required");
});

test("revoking a credential while a bridged websocket is open does not crash the node agent", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  const { app, relay, planeFor, connect, localHeaders } = await cloudRelayFixture(t, stub);
  planeFor("control_plane_revoke_open_stream");
  await bind(app, stub);
  relay.pollNow();
  const peer = await connect("control_plane_revoke_open_stream");
  await peer.waitForMessage((message) => message.type === "node-agent.identify");
  const eventsSocket = await peer.openWebSocket("ws_events_revoke", "/events");
  await eventsSocket.waitForText((value) => value.type === "node-agent.events.connected");

  stub.revokeCredential();
  relay.pollNow();

  const revoked = await waitFor(async () => {
    const snapshot = await status(app, localHeaders("GET", "/api/node-agent/cloud-relay"));
    return snapshot.rebindRequired === true ? snapshot : undefined;
  }, "credential revocation with an open websocket to complete cleanly");
  assert.equal(revoked.bound, true);
  assert.deepEqual(revoked.channels, []);
  assert.equal(revoked.lastError.code, "NODE_RELAY_CREDENTIAL_INVALID");
});

test("a cloud outage keeps the binding and the live channel, then recovers on the next poll", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  const { app, relay, planeFor, connect, localHeaders } = await cloudRelayFixture(t, stub);
  planeFor("control_plane_one");
  await bind(app, stub);
  relay.pollNow();
  const peer = await connect("control_plane_one");
  const snapshotNow = () => status(app, localHeaders("GET", "/api/node-agent/cloud-relay"));

  stub.setUnreachable(true);
  relay.pollNow();
  const degraded = await waitFor(async () => {
    const snapshot = await snapshotNow();
    return snapshot.lastError ? snapshot : undefined;
  }, "cloud outage to be recorded");
  assert.equal(degraded.lastError.code, "NODE_AGENT_CLOUD_RELAY_UNREACHABLE");
  assert.equal(degraded.bound, true);
  assert.equal(degraded.rebindRequired, undefined);
  assert.equal((await peer.request("/health")).status, 200, "the established channel survives a poll outage");

  stub.setUnreachable(false);
  relay.pollNow();
  const recovered = await waitFor(async () => {
    const snapshot = await snapshotNow();
    return snapshot.lastError ? undefined : snapshot;
  }, "poll recovery");
  assert.equal(recovered.channels[0]?.controlPlaneId, "control_plane_one");
  assert.equal(recovered.channels[0]?.status, "connected");
  assert.deepEqual(stub.state.claims.size, 1);
});

test("unbind confirms with the cloud, drops only relay pairings and leaves bound channels closed", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  const { app, relay, identityService, planeFor, connect, hmacFor } = await cloudRelayFixture(t, stub);
  planeFor("control_plane_one");
  await bind(app, stub);
  relay.pollNow();
  await connect("control_plane_one");
  assert.ok(identityService.cloudRelayPairing("control_plane_one"));
  // A pre-existing direct pairing must survive unbinding the account binding.
  const invite = identityService.createPairingInvite({ controlPlaneName: "Direct Control Plane" });
  const direct = identityService.completePairingInvite({ joinToken: invite.token, controlPlaneId: "control_plane_direct" });
  assert.ok(direct.keyId);
  const directHeaders = hmacFor(direct);

  const instancesBefore = app.nodeAgentState!.controlledInstances.list().map((instance: any) => instance.id);
  const response = await app.inject({ method: "DELETE", url: "/api/node-agent/cloud-relay", headers: directHeaders("DELETE", "/api/node-agent/cloud-relay") });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().data, { unbound: true, nodeHandle: "nrh_test_node_handle", cloudUnbind: "confirmed" });
  assert.equal(stub.state.unbinds, 1);
  assert.equal(identityService.cloudRelayBinding(), undefined);
  assert.equal(identityService.cloudRelayPairing("control_plane_one"), undefined);
  assert.ok(identityService.cloudRelayPairing("control_plane_direct"), "direct pairings survive unbind");
  assert.deepEqual(app.nodeAgentState!.controlledInstances.list().map((instance: any) => instance.id), instancesBefore, "unbind never touches local instances");
  const unbound = await status(app, directHeaders("GET", "/api/node-agent/cloud-relay"));
  assert.equal(unbound.bound, false);
  assert.deepEqual(unbound.channels, []);

  const repeat = await app.inject({ method: "DELETE", url: "/api/node-agent/cloud-relay", headers: directHeaders("DELETE", "/api/node-agent/cloud-relay") });
  assert.equal(repeat.statusCode, 200, repeat.body);
  assert.deepEqual(repeat.json().data, { unbound: false, cloudUnbind: "not-bound" });
  assert.equal(stub.state.unbinds, 1);
});
