const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const Fastify = require("fastify");
const websocket = require("@fastify/websocket");
const { AuthorizationConnectionRegistry } = require("../packages/control-plane/src/control-plane/auth/authorization-connections.ts");
const { ControlPlaneEventBus } = require("../packages/control-plane/src/control-plane/events/bus.ts");
const { BrowserAccessService } = require("../packages/control-plane/src/control-plane/instances/browser-access-service.ts");
const { registerBrowserRelayRoutes } = require("../packages/control-plane/src/control-plane/http/browser-relay-routes.ts");
const { setControlPlaneRequestActor } = require("../packages/control-plane/src/control-plane/http/request-actor.ts");

const actor = {
  type: "user", userId: "user_1", identityId: "identity_1", roleIds: [],
  permissionIds: ["instances:interactive"], nodeScope: { kind: "all" },
  instanceScope: { kind: "inherit-node-scope" }, authorizationRevision: 3, requiresPasswordChange: false,
};
const instance = {
  id: "instance_1", nodeId: "node_1", name: "Instance", connectionStatus: "online", agentStatus: "online",
  capabilities: { features: { browserTunnel: true } }, target: { web: "http://instance.local" },
};

test("browser relay consumes a header token once and uses the existing instance websocket proxy", async (t) => {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  app.addHook("onRequest", (request, _reply, done) => { setControlPlaneRequestActor(request, actor); done(); });
  const paths = [];
  const browserAccess = new BrowserAccessService();
  registerBrowserRelayRoutes({
    app,
    browserAccess,
    authorizationConnections: new AuthorizationConnectionRegistry(),
    events: new ControlPlaneEventBus(),
    auth: { async assertAppAccessAuthorization(binding) { assert.equal(binding.authorizationRevision, 3); } },
    service: {
      async requireControlledInstance(id) { assert.equal(id, instance.id); return instance; },
      async proxyInstanceWebSocket(id, socket, path) {
        paths.push({ id, path });
        await new Promise((resolve) => setTimeout(resolve, 20));
        socket.on("message", (data) => socket.send(data));
        setImmediate(() => socket.send("connected"));
      },
    },
  });
  await app.ready();
  t.after(() => app.close());
  const handshake = await app.inject({ method: "POST", url: `/api/controlled-instances/${instance.id}/browser-access`, payload: {} });
  assert.equal(handshake.statusCode, 200);
  const access = handshake.json().data;
  const client = await app.injectWS(access.relayPath, { headers: { authorization: `Browser ${access.token}` } });
  client.send("hello");
  assert.equal((await once(client, "message"))[0].toString(), "hello");
  assert.equal((await once(client, "message"))[0].toString(), "connected");
  assert.deepEqual(paths, [{ id: instance.id, path: "/api/browser-tunnel" }]);
  client.close();
  await once(client, "close");
  const replay = await app.injectWS(access.relayPath, { headers: { authorization: `Browser ${access.token}` } });
  const replayClose = await once(replay, "close");
  assert.equal(replayClose[0], 1008);
});

test("browser access is additive and rejected for an N-1 controlled instance", async (t) => {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  app.addHook("onRequest", (request, _reply, done) => { setControlPlaneRequestActor(request, actor); done(); });
  registerBrowserRelayRoutes({
    app,
    authorizationConnections: new AuthorizationConnectionRegistry(),
    events: new ControlPlaneEventBus(),
    auth: { async assertAppAccessAuthorization() {} },
    service: {
      async requireControlledInstance() { return { ...instance, capabilities: { features: {} } }; },
      async proxyInstanceWebSocket() { throw new Error("must not proxy"); },
    },
  });
  await app.ready();
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: `/api/controlled-instances/${instance.id}/browser-access`, payload: {} });
  assert.equal(response.statusCode, 409);
});

test("browser access works for the local auth-disabled Control Plane", async (t) => {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  const browserAccess = new BrowserAccessService();
  registerBrowserRelayRoutes({
    app,
    browserAccess,
    authorizationConnections: new AuthorizationConnectionRegistry(),
    events: new ControlPlaneEventBus(),
    auth: { enabled: () => false, async assertAppAccessAuthorization() { throw new Error("must not assert user auth"); } },
    service: {
      async requireControlledInstance() { return instance; },
      async proxyInstanceWebSocket() {},
    },
  });
  await app.ready();
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: `/api/controlled-instances/${instance.id}/browser-access`, payload: {} });
  assert.equal(response.statusCode, 200);
});
