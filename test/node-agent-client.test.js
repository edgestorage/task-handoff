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
      features: { tty: true },
    },
    appInventory: {
      observedAt: "2026-07-15T00:00:00.000Z",
      items: [{ id: "terminal-tty", name: "Terminal", kind: "tty", source: "builtin", availability: "available", capabilities: { supportsCwdSelection: true } }],
      issues: [],
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
      signal: init.signal,
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
  assert.equal(requests[0].signal instanceof AbortSignal, true);
  assert.equal(requests[0].body.instanceId, "inst_env");
  assert.equal(requests[0].body.name, undefined);
  assert.equal(requests[0].body.projectId, "proj_1");
  assert.equal(requests[0].body.protocolVersion, "2026-06-23");
  assert.equal(requests[0].body.build.buildId, "build-test");
  assert.equal(requests[0].body.build.imageRef, "task-handoff-web:test");
  assert.deepEqual(requests[0].body.appInventory, snapshot().appInventory);
  assert.equal(requests[0].body.endpoints, undefined);
  assert.equal(requests[0].body.target, undefined);

  assert.equal(requests[1].url, "http://node.local/api/node-agent/instances/inst_registered/heartbeat");
  assert.equal(requests[1].body.protocolVersion, "2026-06-23");
  assert.equal(requests[1].body.build.buildId, "build-test");
  assert.deepEqual(requests[1].body.appInventory, snapshot().appInventory);
  assert.equal(requests[1].body.endpoints, undefined);
  assert.equal(requests[1].body.target, undefined);
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
    TASK_HANDOFF_HEARTBEAT_INTERVAL_MS: "1234",
  });
  assert.equal(controlled.controlMode, "controlled");
  assert.equal(controlled.instanceId, "inst_1");
  assert.equal(controlled.heartbeatIntervalMs, 1234);
  assert.equal(new NodeAgentRegistrationClient(controlled, async () => snapshot()).enabled(), true);
});

test("controlled instance starts serving while registration retries in the background", async () => {
  const requests = [];
  const client = new NodeAgentRegistrationClient(
    {
      controlMode: "controlled",
      nodeAgentUrl: "http://node.local",
      registrationToken: "secret-token",
      instanceId: "inst_retry",
      heartbeatIntervalMs: 50,
    },
    async () => snapshot(),
    async (url) => {
      requests.push(url);
      if (requests.length === 1) throw new TypeError("node agent is not listening yet");
      return new Response(JSON.stringify({ data: url.endsWith("/register") ? { id: "inst_retry" } : { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  await client.start();
  await waitFor(() => requests.length >= 3);
  client.stop();

  assert.match(requests[0], /\/register$/);
  assert.match(requests[1], /\/register$/);
  assert.match(requests[2], /\/heartbeat$/);
});

test("controlled instance serializes concurrent heartbeat requests", async () => {
  let heartbeatRequests = 0;
  let releaseHeartbeat;
  const heartbeatGate = new Promise((resolve) => { releaseHeartbeat = resolve; });
  const client = new NodeAgentRegistrationClient(
    {
      controlMode: "controlled",
      nodeAgentUrl: "http://node.local",
      registrationToken: "secret-token",
      instanceId: "inst_serial",
      heartbeatIntervalMs: 10_000,
    },
    async () => snapshot(),
    async (url) => {
      if (url.endsWith("/heartbeat")) {
        heartbeatRequests += 1;
        if (heartbeatRequests > 1) await heartbeatGate;
      }
      return new Response(JSON.stringify({ data: url.endsWith("/register") ? { id: "inst_serial" } : { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  await client.register();

  const first = client.heartbeat();
  const second = client.heartbeat();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(heartbeatRequests, 2, "the registration heartbeat plus one shared heartbeat should be sent");
  releaseHeartbeat();
  await Promise.all([first, second]);
  assert.equal(heartbeatRequests, 2);
});

test("controlled instance requests and sanitizes paginated Story content", async () => {
  const requests = [];
  const client = new NodeAgentRegistrationClient(
    {
      controlMode: "controlled",
      nodeAgentUrl: "http://node.local",
      registrationToken: "secret-token",
      instanceId: "inst_story",
      heartbeatIntervalMs: 10_000,
    },
    async () => snapshot(),
    async (url, init) => {
      requests.push({ url, method: init.method });
      return new Response(JSON.stringify({ data: {
        storyCreatedAt: "2026-09-05T00:00:00.000Z",
        documents: [{ title: "Document", storyPath: "document.md", revision: "ignored" }],
        pagination: { page: 2, pageSize: 7, totalItems: 9, totalPages: 2, hasMore: false, cursor: "ignored" },
        internal: "ignored",
      } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  );

  const result = await client.listStoryContent("session / 1", 2, 7);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://node.local/api/node-agent/instances/inst_story/ai-sessions/session%20%2F%201/story-content?page=2&pageSize=7");
  assert.equal(requests[0].method, "GET");
  assert.deepEqual(result, {
    storyCreatedAt: "2026-09-05T00:00:00.000Z",
    documents: [{ title: "Document", storyPath: "document.md" }],
    pagination: { page: 2, pageSize: 7, totalItems: 9, totalPages: 2, hasMore: false },
  });
});

test("controlled instance does not fall back when Story pagination fails", async () => {
  for (const outcome of [
    () => new Response(JSON.stringify({ error: { code: "NODE_AGENT_UNAUTHORIZED", message: "unauthorized" } }), { status: 401, headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify({ error: { code: "STORY_SCOPE_INVALID", message: "wrong scope" } }), { status: 409, headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify({ error: { code: "STORY_STORAGE_FAILED", message: "storage failed" } }), { status: 500, headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify({ data: { documents: [], pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0, hasMore: false } } }), { status: 200, headers: { "content-type": "application/json" } }),
    () => { throw Object.assign(new Error("timed out"), { name: "AbortError" }); },
  ]) {
    const requests = [];
    const client = new NodeAgentRegistrationClient(
      {
        controlMode: "controlled",
        nodeAgentUrl: "http://node.local",
        registrationToken: "secret-token",
        instanceId: "inst_story",
        heartbeatIntervalMs: 10_000,
      },
      async () => snapshot(),
      async (url) => { requests.push(url); return outcome(); },
    );
    await assert.rejects(() => client.listStoryContent("session_1", 1, 20));
    assert.equal(requests.length, 1);
  }
});

test("a missing heartbeat registration automatically returns to the register flow", async () => {
  const paths = [];
  let heartbeatCount = 0;
  const client = new NodeAgentRegistrationClient(
    {
      controlMode: "controlled",
      nodeAgentUrl: "http://node.local",
      registrationToken: "secret-token",
      instanceId: "inst_reregister",
      heartbeatIntervalMs: 2,
    },
    async () => snapshot(),
    async (url) => {
      const pathname = new URL(url).pathname;
      paths.push(pathname);
      if (pathname.endsWith("/heartbeat")) {
        heartbeatCount += 1;
        if (heartbeatCount === 2) {
          return new Response(JSON.stringify({ error: { message: "registration was lost" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return new Response(JSON.stringify({ data: pathname.endsWith("/register") ? { id: "inst_reregister" } : { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  await client.start();
  await waitFor(() => paths.filter((path) => path.endsWith("/register")).length >= 2);
  client.stop();

  assert.deepEqual(paths.slice(0, 4).map((path) => path.split("/").at(-1)), ["register", "heartbeat", "heartbeat", "register"]);
});

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
