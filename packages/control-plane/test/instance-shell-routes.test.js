import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { INSTANCE_SHELL_PROTOCOL_VERSION, INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL } from "@task-handoff/protocol/instance-shell";
import { AuthorizationConnectionRegistry } from "../src/control-plane/auth/authorization-connections.ts";
import { ControlledInstanceGateway } from "../src/control-plane/instances/gateway.ts";
import { NodeAgentTransportResolver } from "../src/control-plane/nodes/transport-resolver.ts";
import { ControlPlaneEventBus } from "../src/control-plane/events/bus.ts";
import { registerInstanceShellRoutes } from "../src/control-plane/http/instance-shell-routes.ts";
import { setControlPlaneRequestActor } from "../src/control-plane/http/request-actor.ts";

async function closeApp(app) {
  for (const socket of app.websocketServer.clients) socket.terminate();
  await app.close();
}

const baseActor = {
  type: "user",
  userId: "user_shell",
  identityId: "identity_shell",
  roleIds: [],
  permissionIds: ["instances:interactive"],
  nodeScope: { kind: "all" },
  instanceScope: { kind: "inherit-node-scope" },
  authorizationRevision: 4,
  requiresPasswordChange: false,
};

const cloudActor = {
  type: "cloud-account",
  accountId: "account_shell",
  ownerAccountId: "account_owner",
  deviceSessionId: "device_shell",
  bindingId: "binding_shell",
  bindingRevision: 3,
  accessMode: "owner",
  accessRoleId: "role_shell",
  roleIds: ["role_shell"],
  permissionIds: ["instances:interactive"],
  ownerUserId: "user_shell",
  ownerAuthorizationRevision: 4,
  nodeScope: { kind: "all" },
  instanceScope: { kind: "inherit-node-scope" },
  authorizationRevision: 4,
};

const instance = {
  id: "instance_shell",
  nodeId: "node_shell",
  name: "Shell target",
  capabilities: {
    features: {
      instanceShell: {
        protocolVersion: INSTANCE_SHELL_PROTOCOL_VERSION,
        interactive: true,
        exec: true,
        execTty: true,
      },
    },
  },
};

async function harness(options = {}) {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  const authorizationConnections = new AuthorizationConnectionRegistry();
  const events = new ControlPlaneEventBus();
  const proxied = [];
  let actor = options.actor === null ? null : options.actor ?? baseActor;
  let target = options.instance ?? instance;
  const instanceError = options.instanceError;
  app.addHook("onRequest", (request, _reply, done) => {
    setControlPlaneRequestActor(request, actor);
    done();
  });
  registerInstanceShellRoutes({
    app,
    authorizationConnections,
    events,
    service: {
      async requireControlledInstance(id) {
        assert.equal(id, target.id);
        if (instanceError) throw instanceError;
        return target;
      },
      async proxyInstanceWebSocket(id, socket, path, protocols, headers) {
        proxied.push({ id, socket, path, protocols, headers });
      },
    },
  });
  return {
    app,
    authorizationConnections,
    events,
    proxied,
    setActor(value) { actor = value; },
    setInstance(value) { target = value; },
  };
}

test("instance shell route requires its exact subprotocol before upgrade", async (t) => {
  const h = await harness();
  await h.app.ready();
  t.after(() => closeApp(h.app));
  await assert.rejects(
    h.app.injectWS(`/api/controlled-instances/${instance.id}/shell`),
    /Unexpected server response: 400/,
  );
  await assert.rejects(
    h.app.injectWS(`/api/controlled-instances/${instance.id}/shell`, {
      headers: { "sec-websocket-protocol": "other, task-handoff.instance-shell.2026-10-31" },
    }),
    /Unexpected server response: 400/,
  );
  assert.equal(h.proxied.length, 0);
});

test("instance shell reuses the instance websocket proxy with the shared path and protocol", async (t) => {
  const h = await harness();
  await h.app.ready();
  t.after(() => closeApp(h.app));
  const client = await h.app.injectWS(`/api/controlled-instances/${instance.id}/shell`, {
    headers: { "sec-websocket-protocol": INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL },
  });
  t.after(() => client.terminate());
  assert.equal(h.proxied.length, 1);
  assert.equal(h.proxied[0].id, instance.id);
  assert.equal(h.proxied[0].path, "/api/internal/instance-shell");
  assert.deepEqual(h.proxied[0].protocols, [INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL]);
  assert.deepEqual(h.proxied[0].headers, {});
  client.terminate();
  await closeApp(h.app);
});

test("instance shell uses one Control Plane gateway across every node transport", async (t) => {
  for (const connectionMode of ["direct-http", "reverse-wss", "control-plane-proxy", "cloud-relay"]) {
    const app = Fastify({ logger: false });
    await app.register(websocket);
    app.addHook("onRequest", (request, _reply, done) => {
      setControlPlaneRequestActor(request, baseActor);
      done();
    });
    const calls = [];
    const transport = {
      async request() { throw new Error("unexpected request"); },
      async requestStream() { throw new Error("unexpected stream"); },
      proxyWebSocket(node, _socket, path, protocols, headers) {
        calls.push({ mode: connectionMode, nodeId: node.id, path, protocols, headers });
      },
    };
    const resolver = new NodeAgentTransportResolver({
      direct: connectionMode === "direct-http" ? transport : { ...transport, proxyWebSocket() { throw new Error("wrong direct transport"); } },
      tunnel: connectionMode === "reverse-wss" ? transport : { ...transport, proxyWebSocket() { throw new Error("wrong tunnel transport"); } },
      proxy: connectionMode === "control-plane-proxy" ? transport : { ...transport, proxyWebSocket() { throw new Error("wrong proxy transport"); } },
      cloudRelay: connectionMode === "cloud-relay" ? transport : { ...transport, proxyWebSocket() { throw new Error("wrong cloud transport"); } },
    });
    const node = { id: `node_${connectionMode}`, connectionMode, connectionEnabled: true };
    const target = {
      ...instance,
      nodeId: node.id,
      connectionStatus: "online",
      agentStatus: "online",
      target: { web: "http://instance.internal" },
    };
    const gateway = new ControlledInstanceGateway({
      requireNode: () => node,
      nodeAgentTransport: (candidate) => resolver.resolve(candidate),
    });
    registerInstanceShellRoutes({
      app,
      authorizationConnections: new AuthorizationConnectionRegistry(),
      events: new ControlPlaneEventBus(),
      service: {
        async requireControlledInstance() { return target; },
        async proxyInstanceWebSocket(id, socket, path, protocols, headers) {
          gateway.proxyWebSocket(target, socket, path, protocols, headers);
        },
      },
    });
    await app.ready();
    const client = await app.injectWS(`/api/controlled-instances/${instance.id}/shell`, {
      headers: { "sec-websocket-protocol": INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [{
      mode: connectionMode,
      nodeId: node.id,
      path: `/instances/${encodeURIComponent(instance.id)}/proxy/ws/api/internal/instance-shell`,
      protocols: [INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL],
      headers: {},
    }]);
    client.terminate();
    await closeApp(app);
  }
});

test("instance shell rejects unauthenticated and offline instances before upgrade", async (t) => {
  const unauthenticated = await harness({ actor: null });
  await unauthenticated.app.ready();
  await assert.rejects(
    unauthenticated.app.injectWS(`/api/controlled-instances/${instance.id}/shell`, {
      headers: { "sec-websocket-protocol": INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL },
    }),
    /Unexpected server response: 401/,
  );
  assert.equal(unauthenticated.proxied.length, 0);
  await closeApp(unauthenticated.app);

  const offline = await harness({
    instanceError: Object.assign(new Error("Instance is not ready."), {
      statusCode: 409,
      code: "INSTANCE_NOT_READY",
    }),
  });
  await offline.app.ready();
  await assert.rejects(
    offline.app.injectWS(`/api/controlled-instances/${instance.id}/shell`, {
      headers: { "sec-websocket-protocol": INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL },
    }),
    /Unexpected server response: 409/,
  );
  assert.equal(offline.proxied.length, 0);
  await closeApp(offline.app);
});

test("instance shell rejects missing permission, user and cloud scopes, and N-1 capability before upgrade", async (t) => {
  for (const [label, actorOverride, instanceOverride, status] of [
    ["permission", { ...baseActor, permissionIds: ["instances:read"] }, instance, 403],
    ["user-node-visibility", { ...baseActor, nodeScope: { kind: "nodes", nodeIds: ["node_other"] } }, instance, 404],
    ["user-instance-visibility", { ...baseActor, instanceScope: { kind: "instances", instanceIds: ["instance_other"] } }, instance, 404],
    ["cloud-node-visibility", { ...cloudActor, nodeScope: { kind: "nodes", nodeIds: ["node_other"] } }, instance, 404],
    ["cloud-instance-visibility", { ...cloudActor, instanceScope: { kind: "instances", instanceIds: ["instance_other"] } }, instance, 404],
    ["capability", baseActor, { ...instance, capabilities: { features: {} } }, 409],
  ]) {
    const h = await harness({ actor: actorOverride, instance: instanceOverride });
    await h.app.ready();
    await assert.rejects(
      h.app.injectWS(`/api/controlled-instances/${instance.id}/shell`, {
        headers: { "sec-websocket-protocol": INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL },
      }),
      new RegExp(`Unexpected server response: ${status}`),
      label,
    );
    assert.equal(h.proxied.length, 0, label);
    await closeApp(h.app);
  }
});

test("cloud account instance shell access tracks the owning local user's authorization revision", async (t) => {
  const h = await harness({ actor: cloudActor });
  await h.app.ready();
  const client = await h.app.injectWS(`/api/controlled-instances/${instance.id}/shell`, {
    headers: { "sec-websocket-protocol": INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL },
  });
  assert.equal(h.proxied.length, 1);
  assert.equal(h.authorizationConnections.size(), 1);
  assert.equal(h.authorizationConnections.invalidate(cloudActor.ownerUserId, cloudActor.ownerAuthorizationRevision + 1), 1);
  const [code, reason] = await once(client, "close");
  assert.equal(code, 4001);
  assert.match(String(reason), /Authorization changed/);
  client.terminate();
  await closeApp(h.app);
});

test("instance lifecycle and authorization revision changes close active shell sockets", async (t) => {
  const lifecycle = await harness();
  await lifecycle.app.ready();
  const lifecycleClient = await lifecycle.app.injectWS(`/api/controlled-instances/${instance.id}/shell`, {
    headers: { "sec-websocket-protocol": INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL },
  });
  assert.equal(lifecycle.authorizationConnections.size(), 1);
  lifecycle.events.publish("instance.restarted", { instanceId: instance.id });
  const [lifecycleCode, lifecycleReason] = await once(lifecycleClient, "close");
  assert.equal(lifecycleCode, 4001);
  assert.match(String(lifecycleReason), /Instance lifecycle changed/);
  lifecycleClient.terminate();

  const authorization = await harness();
  await authorization.app.ready();
  const authorizationClient = await authorization.app.injectWS(`/api/controlled-instances/${instance.id}/shell`, {
    headers: { "sec-websocket-protocol": INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL },
  });
  assert.equal(authorization.authorizationConnections.invalidate(baseActor.userId, baseActor.authorizationRevision + 1), 1);
  const [authorizationCode, authorizationReason] = await once(authorizationClient, "close");
  assert.equal(authorizationCode, 4001);
  assert.match(String(authorizationReason), /Authorization changed/);
  authorizationClient.terminate();
  await closeApp(lifecycle.app);
  await closeApp(authorization.app);
});
