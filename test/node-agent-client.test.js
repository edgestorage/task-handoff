const assert = require("node:assert/strict");
const test = require("node:test");

const { NodeAgentRegistrationClient, nodeAgentRegistrationConfigFromEnv } = require("../packages/controlled-instance/src/web/node-agent-client.ts");

function snapshot() {
  return {
    status: "running",
    health: "ok",
    instanceVersion: "0.1.0",
    protocolVersion: "2026-06-23",
    build: {
      component: "controlled-instance",
      packageVersion: "0.1.0",
      buildId: "build-test",
      imageRef: "task-handoff-web:test",
    },
    controlMode: "controlled",
    capabilities: {
      apps: [{ id: "terminal-tty" }],
    },
    target: {
      strategy: "direct-port",
      status: "reachable",
      web: "http://instance.local",
    },
    workspace: {
      status: "ready",
      path: "/workspace",
    },
    apps: {
      runningCount: 1,
      sessions: [{ id: "app_1", appId: "terminal-tty" }],
    },
  };
}

test("controlled instance node agent client posts register and heartbeat payloads", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({
      url,
      method: init.method,
      authorization: init.headers.authorization,
      body: JSON.parse(init.body),
    });
    const data = url.endsWith("/register") ? { id: "inst_registered" } : { ok: true };
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const client = new NodeAgentRegistrationClient(
    {
      controlMode: "controlled",
      nodeAgentUrl: "http://node.local",
      registrationToken: "secret-token",
      instanceId: "inst_env",
      instanceName: "worker-1",
      projectId: "proj_1",
      heartbeatIntervalMs: 10_000,
    },
    async () => snapshot(),
    fetchImpl,
  );

  assert.equal(client.enabled(), true);
  await client.register();
  await client.heartbeat();

  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, "http://node.local/api/node-agent/instances/inst_env/register");
  assert.equal(requests[0].authorization, "Bearer secret-token");
  assert.equal(requests[0].body.instanceId, "inst_env");
  assert.equal(requests[0].body.name, "worker-1");
  assert.equal(requests[0].body.projectId, "proj_1");
  assert.equal(requests[0].body.protocolVersion, "2026-06-23");
  assert.equal(requests[0].body.build.buildId, "build-test");
  assert.equal(requests[0].body.build.imageRef, "task-handoff-web:test");
  assert.deepEqual(requests[0].body.capabilities.apps, [{ id: "terminal-tty" }]);
  assert.equal(requests[0].body.endpoints, undefined);
  assert.deepEqual(requests[0].body.target, {
    strategy: "direct-port",
    status: "reachable",
    web: "http://instance.local",
  });

  assert.equal(requests[1].url, "http://node.local/api/node-agent/instances/inst_registered/heartbeat");
  assert.equal(requests[1].body.protocolVersion, "2026-06-23");
  assert.equal(requests[1].body.build.buildId, "build-test");
  assert.deepEqual(requests[1].body.capabilities.apps, [{ id: "terminal-tty" }]);
  assert.equal(requests[1].body.endpoints, undefined);
  assert.equal(requests[1].body.target.web, "http://instance.local");
  assert.equal(requests[1].body.receiver, undefined);
  assert.equal(requests[1].body.apps.runningCount, 1);
  assert.equal(requests[2].url, "http://node.local/api/node-agent/instances/inst_registered/heartbeat");
});

test("controlled instance node agent config reads env and stays disabled for standalone", () => {
  const standalone = nodeAgentRegistrationConfigFromEnv({
    TASK_HANDOFF_CONTROL_MODE: "standalone",
    TASK_HANDOFF_NODE_AGENT_URL: "http://node.local",
    TASK_HANDOFF_REGISTRATION_TOKEN: "secret",
    TASK_HANDOFF_PROJECT_ID: "proj_1",
  });
  const standaloneClient = new NodeAgentRegistrationClient(standalone, async () => snapshot());
  assert.equal(standaloneClient.enabled(), false);

  const controlled = nodeAgentRegistrationConfigFromEnv({
    TASK_HANDOFF_CONTROL_MODE: "controlled",
    TASK_HANDOFF_NODE_AGENT_URL: "http://node.local",
    TASK_HANDOFF_REGISTRATION_TOKEN: "secret",
    TASK_HANDOFF_PROJECT_ID: "proj_1",
    TASK_HANDOFF_INSTANCE_ID: "inst_1",
    TASK_HANDOFF_INSTANCE_NAME: "worker",
    TASK_HANDOFF_HEARTBEAT_INTERVAL_MS: "1234",
  });
  assert.equal(controlled.controlMode, "controlled");
  assert.equal(controlled.instanceId, "inst_1");
  assert.equal(controlled.instanceName, "worker");
  assert.equal(controlled.heartbeatIntervalMs, 1234);
  assert.equal(new NodeAgentRegistrationClient(controlled, async () => snapshot()).enabled(), true);
});
