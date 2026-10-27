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
  relayProbeFetch?: typeof fetch;
  cloudDiscovery?: CloudDiscovery;
  discoveryCachePath?: string;
  cloudRelayAttachTimeoutMs?: number;
  relaySocketCloseDelayMs?: number;
  relayAttach?: (input: { controlPlaneId: string; allocationId: string; attempt: number }) => boolean;
} = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-node-cloud-relay-"));
  const planes = new Map<string, PlaneState>();
  const connections: Array<{ controlPlaneId: string; url: string; allocationId: string; attempt: number }> = [];
  let attachmentSequence = 0;
  const app = await createNodeAgentApp({
    dataDir,
    nodeId: "node_cloud_relay",
    token: AUTH_TOKEN,
    logger: false,
    fetchImpl: options.fetchImpl ?? stub.fetchImpl,
    ...(options.relayProbeFetch ? { relayProbeFetch: options.relayProbeFetch } : {}),
    ...(options.cloudDiscovery ? { cloudDiscovery: options.cloudDiscovery } : {}),
    ...(options.discoveryCachePath ? { discoveryCachePath: options.discoveryCachePath } : {}),
    ...(options.cloudRelayAttachTimeoutMs ? { cloudRelayAttachTimeoutMs: options.cloudRelayAttachTimeoutMs } : {}),
    webSocket: fakeRelayWebSocket({
      ...(options.relaySocketCloseDelayMs ? { closeDelayMs: options.relaySocketCloseDelayMs } : {}),
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
          const allocationId = String(value.capability?.allocationId ?? allocation.allocationId);
          const attempt = ++attachmentSequence;
          connections.push({ controlPlaneId, url, allocationId, attempt });
          if (options.relayAttach && !options.relayAttach({ controlPlaneId, allocationId, attempt })) return;
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

async function bind(app: FastifyInstance, stub: CloudStub, displayName?: string, headers: Record<string, string> = authorizationHeaders(), autoApproveTrust = true) {
  const response = await app.inject({
    method: "POST",
    url: "/api/node-agent/cloud-relay/bind",
    headers,
    payload: { cloudOrigin: SERVICE_ORIGIN, bindingToken: stub.state.bindingToken, ...(displayName ? { displayName } : {}) },
  });
  assert.equal(response.statusCode, 201, response.body);
  if (autoApproveTrust) {
    const identity = (app as FastifyInstance & { nodeAgentIdentityService: NodeAgentIdentityService }).nodeAgentIdentityService;
    const binding = identity.cloudRelayBinding();
    assert.ok(binding, "the relay trust fixture requires a cloud binding");
    for (const claim of stub.state.claims.values()) {
      const accountId = claim.accountId ?? binding.accountId;
      const ownerAccountId = claim.ownerAccountId ?? accountId;
      const accessMode = claim.accessMode ?? "owner";
      const context = {
        nodeId: "node_cloud_relay",
        nodeHandle: binding.nodeHandle,
        controlPlaneId: claim.controlPlaneId,
        controlPlanePublicKey: claim.controlPlanePublicKey,
        bindingId: claim.bindingId ?? "binding_test",
        bindingRevision: claim.bindingRevision ?? 1,
        accountId,
        ownerAccountId,
        accessMode,
        ...(claim.shareGrantId ? { shareGrantId: claim.shareGrantId } : {}),
        ...(claim.shareRole ? { shareRole: claim.shareRole } : {}),
        ...(claim.shareRevision ? { shareRevision: claim.shareRevision } : {}),
      };
      const observation = identity.observeCloudControlPlaneTrust(context);
      if (observation.kind === "active") continue;
      assert.equal(observation.kind, "pending", `unexpected trust state for ${claim.controlPlaneId}`);
      identity.decideCloudControlPlaneTrust({
        action: "approve",
        requestId: observation.request.id,
        expectedFingerprint: nodeRelayFingerprint(claim.controlPlanePublicKey),
        expectedRevision: observation.request.revision,
        actor: { type: "local", id: "test-fixture" },
      });
    }
  }
  return response.json().data;
}

async function status(app: FastifyInstance, headers: Record<string, string> = authorizationHeaders()) {
  const response = await app.inject({ method: "GET", url: "/api/node-agent/cloud-relay", headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().data;
}

function relayProbeFetch(idsByHost: Record<string, string>, calls: Array<{ url: string; init?: RequestInit }> = []) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    calls.push({ url: url.href, init });
    const relayId = idsByHost[url.hostname];
    if (!relayId) throw new Error(`unexpected probe host ${url.hostname}`);
    return new Response(JSON.stringify({ relayId, region: null, now: new Date().toISOString(), draining: false, loadBucket: "low" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
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
  assert.deepEqual(stub.state.redemptions, [{ nodeId: "node_cloud_relay", displayName: "Build box" }]);

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
  assert.ok(stub.state.allocationRequests.length > 0);
  assert.ok(stub.state.allocationRequests.every((request) => request.nodeId === "node_cloud_relay"), "every allocation poll identifies the original node agent");
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

test("a stalled relay attach times out and reconnects with a fresh allocation", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  let acceptAttachments = false;
  const { app, relay, planeFor, connect, localHeaders, connections } = await cloudRelayFixture(t, stub, {
    cloudRelayAttachTimeoutMs: 100,
    relayAttach: () => acceptAttachments,
  });
  const controlPlaneId = "control_plane_attach_timeout";
  planeFor(controlPlaneId);
  await bind(app, stub);
  relay.pollNow();

  const failed = await waitFor(async () => {
    const snapshot = await status(app, localHeaders("GET", "/api/node-agent/cloud-relay"));
    const channel = snapshot.channels.find((item: any) => item.controlPlaneId === controlPlaneId);
    return channel?.status === "failed" && /timed out/i.test(channel.error ?? "") ? snapshot : undefined;
  }, "the stalled attach to time out");
  assert.equal(failed.channels[0].status, "failed");

  acceptAttachments = true;
  relay.pollNow();
  const peer = await connect(controlPlaneId);
  assert.equal((await peer.request("/health")).status, 200);
  const recovered = await waitFor(async () => {
    const snapshot = await status(app, localHeaders("GET", "/api/node-agent/cloud-relay"));
    const channel = snapshot.channels.find((item: any) => item.controlPlaneId === controlPlaneId);
    return channel?.status === "connected" ? snapshot : undefined;
  }, "the attach timeout to refresh the allocation and recover");
  assert.equal(recovered.channels[0].error, undefined);
  assert.ok(connections.length >= 2);
  assert.notEqual(connections[connections.length - 1].allocationId, connections[0].allocationId);
  assert.ok(stub.state.allocationRequests.some((request) =>
    request.refreshControlPlaneIds?.includes(controlPlaneId)), "the timeout must request a fresh attach capability");
});

test("a stale allocation returned after refresh is never attached a second time", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  stub.setIgnoreRefresh(true);
  let acceptAttachments = false;
  const { app, relay, planeFor, connect, localHeaders, connections } = await cloudRelayFixture(t, stub, {
    cloudRelayAttachTimeoutMs: 60,
    relayAttach: () => acceptAttachments,
  });
  const controlPlaneId = "control_plane_stale_refresh";
  planeFor(controlPlaneId);
  await bind(app, stub);
  relay.pollNow();

  await waitFor(async () => {
    const snapshot = await status(app, localHeaders("GET", "/api/node-agent/cloud-relay"));
    const channel = snapshot.channels.find((item: any) => item.controlPlaneId === controlPlaneId);
    return channel?.status === "failed" ? snapshot : undefined;
  }, "the stalled attach to fail before the refresh");
  assert.equal(connections.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(connections.length, 1, "the consumed allocation must not be dialed again while it is still cached");
  assert.ok(stub.state.allocationRequests.some((request) =>
    request.refreshControlPlaneIds?.includes(controlPlaneId)), "the failed attach must keep requesting a fresh allocation");

  acceptAttachments = true;
  stub.setIgnoreRefresh(false);
  relay.pollNow();
  const peer = await connect(controlPlaneId);
  assert.equal((await peer.request("/health")).status, 200);
  await waitFor(async () => {
    const snapshot = await status(app, localHeaders("GET", "/api/node-agent/cloud-relay"));
    const channel = snapshot.channels.find((item: any) => item.controlPlaneId === controlPlaneId);
    return channel?.status === "connected" ? snapshot : undefined;
  }, "the node to recover once the Coordinator issues a new allocation");
  assert.ok(connections.length >= 2);
  assert.notEqual(connections[connections.length - 1].allocationId, connections[0].allocationId);
});

test("an unapproved Control Plane receives only a pending outcome; local approval connects without rebinding", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  const { app, relay, identityService, planeFor, connect, localHeaders } = await cloudRelayFixture(t, stub);
  const controlPlaneId = "control_plane_waiting_for_trust";
  const pendingPlane = planeFor(controlPlaneId);
  await bind(app, stub, undefined, authorizationHeaders(), false);

  relay.pollNow();
  const pending = await connect(controlPlaneId) as any;
  assert.equal(pending.status, "trust-required");
  assert.equal(pending.outcome.state, "pending");
  assert.equal(pending.outcome.reason, "first-seen");
  assert.equal(pending.outcome.controlPlaneId, controlPlaneId);
  assert.equal(identityService.cloudRelayPairing(controlPlaneId), undefined);
  assert.deepEqual(identityService.listControlPlanePairings(), []);
  const beforeApproval = await status(app);
  assert.equal(beforeApproval.channels.some((channel: any) => channel.status === "connected"), false);

  const listed = await app.inject({ method: "GET", url: "/api/node-agent/control-plane-trust", headers: authorizationHeaders() });
  assert.equal(listed.statusCode, 200, listed.body);
  const trust = listed.json().data;
  assert.deepEqual(trust.pins, []);
  const request = trust.requests.find((item: any) => item.requestId === pending.outcome.requestId);
  assert.equal(request?.status, "pending");
  assert.equal(request?.controlPlaneId, controlPlaneId);
  assert.equal(request?.fingerprint, nodeRelayFingerprint(pendingPlane.identity.publicKey));

  const decisionPayload = {
    action: "approve",
    expectedFingerprint: request.fingerprint,
    expectedRevision: request.revision,
  };
  const decided = await app.inject({
    method: "POST",
    url: `/api/node-agent/control-plane-trust/requests/${encodeURIComponent(request.requestId)}/decision`,
    headers: authorizationHeaders(),
    payload: decisionPayload,
  });
  assert.equal(decided.statusCode, 200, decided.body);
  assert.equal(decided.json().data.pins.filter((pin: any) => pin.status === "active").length, 1);

  const approvedPeer = await waitFor(async () => {
    if (pendingPlane.peers.length < 2) return undefined;
    const peer = await pendingPlane.peers[pendingPlane.peers.length - 1] as any;
    return peer?.status === "trust-required" ? undefined : peer;
  }, "the approved Control Plane to reconnect and complete the handshake");
  assert.equal((await approvedPeer.request("/health")).status, 200);
  assert.ok(identityService.cloudRelayPairing(controlPlaneId));
  assert.equal(stub.state.redemptions.length, 1, "approval must not redeem or rotate the cloud binding token");
  const connected = await status(app, localHeaders("GET", "/api/node-agent/cloud-relay"));
  assert.equal(connected.channels.find((channel: any) => channel.controlPlaneId === controlPlaneId)?.status, "connected");
});

test("revoking one Control Plane pin closes only that channel and clears only its relay pairing", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  const { app, relay, identityService, planeFor, connect, hmacFor, localHeaders } = await cloudRelayFixture(t, stub);
  planeFor("control_plane_revoke_one");
  const two = planeFor("control_plane_revoke_two");
  await bind(app, stub);
  relay.pollNow();
  const [peerOne, peerTwo] = await Promise.all([connect("control_plane_revoke_one"), connect("control_plane_revoke_two")]);
  assert.equal((await peerOne.request("/health")).status, 200);
  assert.equal((await peerTwo.request("/health")).status, 200);

  const trustHeaders = localHeaders("GET", "/api/node-agent/control-plane-trust");
  const listed = await app.inject({ method: "GET", url: "/api/node-agent/control-plane-trust", headers: trustHeaders });
  assert.equal(listed.statusCode, 200, listed.body);
  const pin = listed.json().data.pins.find((item: any) => item.controlPlaneId === "control_plane_revoke_one" && item.status === "active");
  assert.ok(pin);
  const revokePath = `/api/node-agent/control-plane-trust/pins/${pin.pinId}/revoke`;
  const revokePayload = { expectedFingerprint: pin.fingerprint, expectedRevision: pin.revision, reason: "test revoke" };
  const selfPairing = identityService.cloudRelayPairing("control_plane_revoke_one");
  const otherPairing = identityService.cloudRelayPairing("control_plane_revoke_two");
  assert.ok(selfPairing);
  assert.ok(otherPairing);
  const selfRevoke = await app.inject({
    method: "POST",
    url: revokePath,
    headers: hmacFor(selfPairing)("POST", revokePath, revokePayload),
    payload: revokePayload,
  });
  assert.equal(selfRevoke.statusCode, 403, selfRevoke.body);
  assert.equal(selfRevoke.json().error.code, "NODE_AGENT_CONTROL_PLANE_TRUST_SELF_REVOKE_FORBIDDEN");

  const revoked = await app.inject({
    method: "POST",
    url: revokePath,
    headers: hmacFor(otherPairing)("POST", revokePath, revokePayload),
    payload: revokePayload,
  });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal(revoked.json().data.pins.find((item: any) => item.pinId === pin.pinId)?.status, "revoked");

  await waitFor(async () => {
    const snapshot = await status(app, localHeaders("GET", "/api/node-agent/cloud-relay"));
    const oneChannel = snapshot.channels.find((channel: any) => channel.controlPlaneId === "control_plane_revoke_one");
    const twoChannel = snapshot.channels.find((channel: any) => channel.controlPlaneId === "control_plane_revoke_two");
    return oneChannel?.status !== "connected" && twoChannel?.status === "connected" ? snapshot : undefined;
  }, "only the revoked Control Plane channel to close");
  assert.equal(identityService.cloudRelayPairing("control_plane_revoke_one"), undefined);
  assert.ok(identityService.cloudRelayPairing("control_plane_revoke_two"));
  assert.equal((await peerTwo.request("/health")).status, 200);
});

test("an already connected Control Plane can approve a different pending CP; the authenticated key, not a spoofed header, is audited", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  const { app, relay, identityService, planeFor, connect, hmacFor } = await cloudRelayFixture(t, stub);
  const approverId = "control_plane_approver";
  const targetId = "control_plane_target";
  planeFor(approverId);
  await bind(app, stub);
  relay.pollNow();
  const approver = await connect(approverId);
  assert.equal((await approver.request("/health")).status, 200);
  const approverPairing = identityService.cloudRelayPairing(approverId);
  assert.ok(approverPairing);

  const targetPlane = planeFor(targetId);
  relay.pollNow();
  const pending = await connect(targetId) as any;
  assert.equal(pending.status, "trust-required");
  assert.equal(pending.outcome.controlPlaneId, targetId);

  const listPath = "/api/node-agent/control-plane-trust";
  const listed = await app.inject({ method: "GET", url: listPath, headers: hmacFor(approverPairing)( "GET", listPath) });
  assert.equal(listed.statusCode, 200, listed.body);
  const request = listed.json().data.requests.find((item: any) => item.requestId === pending.outcome.requestId);
  assert.ok(request);
  const decisionPath = `/api/node-agent/control-plane-trust/requests/${encodeURIComponent(request.requestId)}/decision`;
  const payload = { action: "approve", expectedFingerprint: request.fingerprint, expectedRevision: request.revision };
  const decided = await app.inject({
    method: "POST",
    url: decisionPath,
    headers: {
      ...hmacFor(approverPairing)("POST", decisionPath, payload),
      "x-task-handoff-control-plane-id": targetId,
    },
    payload,
  });
  assert.equal(decided.statusCode, 200, decided.body);
  const pin = decided.json().data.pins.find((item: any) => item.controlPlaneId === targetId && item.status === "active");
  assert.equal(pin?.approvedByActorType, "control-plane");
  assert.equal(pin?.approvedByActorId, approverId);
  assert.notEqual(pin?.approvedByActorId, targetId);

  const targetPeer = await waitFor(async () => {
    if (targetPlane.peers.length < 2) return undefined;
    const peer = await targetPlane.peers[targetPlane.peers.length - 1] as any;
    return peer?.status === "trust-required" ? undefined : peer;
  }, "the proxy-approved target Control Plane to connect");
  assert.equal((await targetPeer.request("/health")).status, 200);
});

test("a new allocation supersedes a stalled attach before the old socket closes", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  let attachments = 0;
  const { app, relay, planeFor, connect, localHeaders, connections } = await cloudRelayFixture(t, stub, {
    cloudRelayAttachTimeoutMs: 5_000,
    relaySocketCloseDelayMs: 1_000,
    relayAttach: () => ++attachments > 1,
  });
  const controlPlaneId = "control_plane_attach_superseded";
  planeFor(controlPlaneId);
  await bind(app, stub);
  relay.pollNow();
  await waitFor(() => connections.length === 1 ? connections[0] : undefined, "the first attach to stall");
  const firstAllocationId = connections[0].allocationId;

  stub.invalidateAllocation(controlPlaneId);
  relay.pollNow();
  const second = await waitFor(() => connections.length >= 2 ? connections[1] : undefined,
    "the new allocation to attach without waiting for the old socket close", 700);
  assert.notEqual(second.allocationId, firstAllocationId);

  const peer = await connect(controlPlaneId);
  assert.equal((await peer.request("/health")).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const snapshot = await status(app, localHeaders("GET", "/api/node-agent/cloud-relay"));
  const channel = snapshot.channels.find((item: any) => item.controlPlaneId === controlPlaneId);
  assert.equal(channel?.status, "connected", "the superseded attempt must not overwrite the recovered channel");
  assert.equal(channel?.error, undefined);
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

test("first connect never probes and an old Coordinator is retried through v1 only once", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  const { app, relay, planes, planeFor, connect } = await cloudRelayFixture(t, stub);
  const plane = planeFor("control_plane_legacy_server");
  await bind(app, stub);
  relay.pollNow();
  const first = await connect("control_plane_legacy_server");
  assert.equal(stub.state.probeTargetRequests.length, 0, "a first bind uses the fast v1 allocation path");

  first.close("legacy-server-drop-one");
  relay.pollNow();
  await waitFor(() => stub.state.probeTargetRequests.length === 1 ? true : undefined, "the first adaptive discovery attempt");
  const second = await waitFor(() => plane.peers.length >= 2 ? plane.peers[1] : undefined, "v1 fallback reconnect");
  assert.ok(second);
  assert.ok(stub.state.allocationRequests.length >= 2, "the unsupported v2 route fell back to v1");

  second!.close("legacy-server-drop-two");
  relay.pollNow();
  await waitFor(() => plane.peers.length >= 3 ? plane.peers[2] : undefined, "second v1 fallback reconnect");
  assert.equal(stub.state.probeTargetRequests.length, 1, "an unsupported server is remembered for the service origin");
});

test("a business 404 during probe discovery does not disable adaptive selection", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  stub.setAdaptiveSelection(true);
  stub.state.probeTargetFailure = { status: 404, code: "NODE_RELAY_PAIRING_NOT_FOUND", message: "No active pairing for this Control Plane." };
  const { app, relay, planes, planeFor, connect } = await cloudRelayFixture(t, stub);
  planeFor("control_plane_pairing_404");
  await bind(app, stub);
  relay.pollNow();
  const first = await connect("control_plane_pairing_404");
  first.close("pairing-404-drop-one");
  relay.pollNow();
  const second = await waitFor(() => planes.get("control_plane_pairing_404")!.peers.length >= 2
    ? planes.get("control_plane_pairing_404")!.peers[1]
    : undefined, "v1 fallback after a business 404");
  assert.ok(second);

  second!.close("pairing-404-drop-two");
  relay.pollNow();
  await waitFor(() => planes.get("control_plane_pairing_404")!.peers.length >= 3
    ? planes.get("control_plane_pairing_404")!.peers[2]
    : undefined, "adaptive discovery after a business 404");
  assert.equal(stub.state.probeTargetRequests.length, 2, "a business 404 must not be cached as unsupported");
  assert.equal(stub.state.allocationV2Requests.length, 0);
});

test("one probe batch serves two Control Planes and each reconnect attaches only its selected Relay", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  stub.setAdaptiveSelection(true);
  const probeCalls: Array<{ url: string; init?: RequestInit }> = [];
  const { app, relay, planes, planeFor, connect } = await cloudRelayFixture(t, stub, {
    relayProbeFetch: relayProbeFetch({
      "relay-a.cloud.example.com": "relay_a",
      "relay-c.cloud.example.com": "relay_c",
    }, probeCalls),
  });
  const one = planeFor("control_plane_adaptive_one");
  const two = planeFor("control_plane_adaptive_two");
  stub.setRelayForControlPlane("control_plane_adaptive_one", { relayId: "relay_a", relayUrl: "wss://relay-a.cloud.example.com/connect" });
  stub.setRelayForControlPlane("control_plane_adaptive_two", { relayId: "relay_a", relayUrl: "wss://relay-a.cloud.example.com/connect" });
  await bind(app, stub);
  relay.pollNow();
  const [firstOne, firstTwo] = await Promise.all([connect("control_plane_adaptive_one"), connect("control_plane_adaptive_two")]);
  assert.equal(stub.state.probeTargetRequests.length, 0);

  stub.setRelayForControlPlane("control_plane_adaptive_one", { relayId: "relay_c", relayUrl: "wss://relay-c.cloud.example.com/connect" });
  stub.setRelayForControlPlane("control_plane_adaptive_two", { relayId: "relay_a", relayUrl: "wss://relay-a.cloud.example.com/connect" });
  stub.setProbeTargets([
    { relayId: "relay_a", relayUrl: "wss://relay-a.cloud.example.com/connect" },
    { relayId: "relay_c", relayUrl: "wss://relay-c.cloud.example.com/connect" },
  ]);
  firstOne.close("adaptive-drop-one");
  firstTwo.close("adaptive-drop-two");
  relay.pollNow();

  await waitFor(() => stub.state.allocationV2Requests.length === 1 ? true : undefined, "one v2 allocation with shared evidence");
  assert.equal(stub.state.probeTargetRequests.length, 1);
  assert.deepEqual(stub.state.probeTargetRequests[0].controlPlaneIds?.sort(), ["control_plane_adaptive_one", "control_plane_adaptive_two"]);
  assert.equal(probeCalls.length, 4, "two targets by two samples in one reconnect attempt");
  const evidence = stub.state.allocationV2Requests[0].probeEvidence;
  assert.deepEqual(evidence.measurements.map((measurement: any) => [measurement.relayId, measurement.sampleCount, measurement.failureCount]).sort(), [
    ["relay_a", 2, 0],
    ["relay_c", 2, 0],
  ]);
  assert.equal(stub.state.allocationRequests.filter((request) => request.refreshControlPlaneIds?.length).length, 0, "successful v2 never falls back to a refresh request on v1");

  const [secondOne, secondTwo] = await Promise.all([
    waitFor(() => one.peers.length >= 2 ? one.peers[1] : undefined, "adaptive relay-a peer reconnect"),
    waitFor(() => two.peers.length >= 2 ? two.peers[1] : undefined, "adaptive relay-c peer reconnect"),
  ]);
  assert.ok(secondOne);
  assert.ok(secondTwo);
  assert.equal(stub.issuedAllocation("control_plane_adaptive_one").relayUrl, "wss://relay-c.cloud.example.com/connect");
  assert.equal(stub.issuedAllocation("control_plane_adaptive_two").relayUrl, "wss://relay-a.cloud.example.com/connect");
  assert.equal((await secondOne!.request("/health")).status, 200);
  assert.equal((await secondTwo!.request("/health")).status, 200);
});

test("a v2 allocation failure falls back to v1 while an all-failure probe still reports evidence", async (t) => {
  const stub = cloudRelayCloudStub({ serviceOrigin: SERVICE_ORIGIN });
  stub.setAdaptiveSelection(true);
  stub.setProbeTargets([{ relayId: "relay_test_1", relayUrl: "wss://relay.cloud.example.com/relay" }]);
  stub.state.failAdaptiveAllocations = true;
  const { app, relay, planes, planeFor, connect } = await cloudRelayFixture(t, stub, {
    relayProbeFetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch,
  });
  planeFor("control_plane_fallback");
  await bind(app, stub);
  relay.pollNow();
  const first = await connect("control_plane_fallback");
  first.close("v2-failure-drop");
  relay.pollNow();

  await waitFor(() => stub.state.allocationV2Requests.length === 1 ? true : undefined, "v2 allocation attempt");
  assert.deepEqual(stub.state.allocationV2Requests[0].probeEvidence?.measurements, [
    { relayId: "relay_test_1", sampleCount: 2, failureCount: 2 },
  ]);
  const second = await waitFor(() => planes.get("control_plane_fallback")!.peers.length >= 2
    ? planes.get("control_plane_fallback")!.peers[1]
    : undefined, "v1 fallback after a failed v2 allocation");
  assert.ok(second);
  assert.equal((await second!.request("/health")).status, 200);
});
