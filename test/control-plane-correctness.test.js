const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CONTROL_PLANE_PROTOCOL_VERSION } = require("../packages/protocol/src/control-plane.ts");
const { NodeConnectionManager } = require("../packages/control-plane/src/control-plane/nodes/connection-manager.ts");
const { AiSessionActionService } = require("../packages/control-plane/src/control-plane/sessions/ai-session-actions.ts");
const { createNodeAgentApp } = require("../packages/control-plane/src/node-agent.ts");
const { NodeAgentIdentityStore } = require("../packages/control-plane/src/node-agent/identity/store.ts");
const { nodeAgentStorePaths } = require("../packages/control-plane/src/node-agent/persistence/paths.ts");

const pairingSecret = "pairing-secret-must-not-leak-123456";

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function pairingManager(input = {}) {
  const requests = [];
  const logs = { info: [], warn: [] };
  const writes = [];
  const nodeRecords = input.nodeRecords || new Map();
  const pendingRecords = input.pendingRecords || new Map();
  const nodes = {
    put: (node) => {
      writes.push(node);
      const stored = input.put ? input.put(node) : node;
      nodeRecords.set(stored.id, stored);
      return stored;
    },
    get: (id) => nodeRecords.get(id),
  };
  const pendingPairingRevokes = {
    put: (record) => { pendingRecords.set(record.id, record); return record; },
    list: () => [...pendingRecords.values()],
    delete: (id) => pendingRecords.delete(id),
  };
  const fetchImpl = async (url, init = {}) => {
    const request = { url: String(url), method: init.method || "GET", headers: init.headers, body: init.body };
    requests.push(request);
    const pathname = new URL(String(url)).pathname;
    if (pathname.endsWith("/pairing/complete")) {
      return input.pairing?.() || response({
        data: {
          nodeId: "node_paired",
          keyId: "key_paired",
          secret: pairingSecret,
          pairedAt: new Date().toISOString(),
        },
      }, 201);
    }
    if (pathname.endsWith("/health")) return input.health?.() || response({ data: {
      nodeId: "node_paired",
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    } });
    if (pathname.endsWith("/pairing/current")) {
      return input.revoke?.() || response({ data: {
        keyId: "key_paired",
        revoked: true,
        revokedAt: new Date().toISOString(),
      } });
    }
    throw new Error(`Unexpected request ${pathname}`);
  };
  return {
    manager: new NodeConnectionManager({
      nodes,
      pendingPairingRevokes,
      fetchImpl,
      localNodeLabel: "local",
      builtinNodeLabel: "builtin",
      info: input.info || ((data, message) => logs.info.push({ data, message })),
      warn: input.warn || ((data, message) => logs.warn.push({ data, message })),
    }),
    requests,
    logs,
    writes,
    pendingRecords,
    nodeRecords,
  };
}

function createNode(manager, patch = {}) {
  return manager.create({
    name: "Paired node",
    connectionMode: "direct-http",
    endpoint: "https://node.example.test",
    joinToken: "one-time-join-token",
    ...patch,
  });
}

test("direct node pairing revokes the new credential after every post-pair creation failure", async (t) => {
  const cases = [
    {
      name: "health failure",
      options: { health: () => response({ error: { message: "health unavailable" } }, 503) },
      expectedCode: "NODE_AGENT_HEALTH_FAILED",
    },
    {
      name: "node id mismatch",
      options: {},
      patch: { id: "node_requested" },
      expectedCode: "NODE_AGENT_ID_MISMATCH",
    },
    {
      name: "local persistence failure",
      options: { put: () => { throw Object.assign(new Error("disk unavailable"), { code: "LOCAL_PERSIST_FAILED" }); } },
      expectedCode: "LOCAL_PERSIST_FAILED",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { manager, requests, logs } = pairingManager(entry.options);
      await assert.rejects(createNode(manager, entry.patch), (error) => error.code === entry.expectedCode);
      assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
        "/api/node-agent/pairing/complete",
        "/api/node-agent/health",
        "/api/node-agent/pairing/current",
      ]);
      const revoke = requests[2];
      assert.equal(revoke.method, "DELETE");
      assert.equal(revoke.headers["x-taskhandoff-node-id"], "node_paired");
      assert.equal(revoke.headers["x-taskhandoff-key-id"], "key_paired");
      assert.equal(JSON.stringify({ requests, logs }).includes(pairingSecret), false);
      assert.equal(logs.info.at(-1).data.originalErrorCode, entry.expectedCode);
    });
  }
});

test("failed pairing compensation remains durable and is retried", async () => {
  let revokeAttempts = 0;
  const harness = pairingManager({
    health: () => response({ error: { message: "health unavailable" } }, 503),
    revoke: () => {
      revokeAttempts += 1;
      return revokeAttempts === 1
        ? response({ error: { code: "TEMPORARY_REVOKE_FAILURE" } }, 503)
        : response({ data: {
          keyId: "key_paired",
          revoked: true,
          revokedAt: new Date().toISOString(),
        } });
    },
  });

  await assert.rejects(createNode(harness.manager), (error) => (
    error.code === "NODE_AGENT_PAIRING_COMPENSATION_FAILED" && error.retryable === true
  ));
  assert.equal(harness.pendingRecords.size, 1);

  await harness.manager.recoverPendingPairingRevokes();
  assert.equal(revokeAttempts, 2);
  assert.equal(harness.pendingRecords.size, 0);
});

test("pairing recovery does not revoke a credential while its node creation is active", async () => {
  let resolveHealth;
  const health = new Promise((resolve) => { resolveHealth = resolve; });
  const harness = pairingManager({ health: () => health });
  const creating = createNode(harness.manager);
  while (harness.pendingRecords.size === 0) await new Promise((resolve) => setImmediate(resolve));

  await harness.manager.recoverPendingPairingRevokes();
  assert.equal(harness.requests.some((request) => new URL(request.url).pathname.endsWith("/pairing/current")), false);

  resolveHealth(response({ data: {
    nodeId: "node_paired",
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
  } }));
  await creating;
  assert.equal(harness.pendingRecords.size, 0);
});

test("pairing identity is checked even when reverse-wss skips health inspection", async () => {
  const { manager, requests, pendingRecords } = pairingManager();
  await assert.rejects(createNode(manager, {
    connectionMode: "reverse-wss",
    id: "node_requested",
  }), (error) => error.code === "NODE_AGENT_ID_MISMATCH");
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    "/api/node-agent/pairing/complete",
    "/api/node-agent/pairing/current",
  ]);
  assert.equal(pendingRecords.size, 0);
});

test("direct node pairing reports sanitized compensation failure diagnostics", async () => {
  const { manager, requests, logs } = pairingManager({
    health: () => response({ error: { message: "health unavailable" } }, 503),
    revoke: () => response({ error: { code: "PAIRING_REVOKE_UNAVAILABLE" } }, 503),
  });

  await assert.rejects(createNode(manager), (error) => {
    assert.equal(error.code, "NODE_AGENT_PAIRING_COMPENSATION_FAILED");
    assert.equal(error.retryable, true);
    assert.deepEqual(error.details, {
      nodeId: "node_paired",
      keyId: "key_paired",
      originalErrorCode: "NODE_AGENT_HEALTH_FAILED",
      compensationErrorCode: "PAIRING_REVOKE_UNAVAILABLE",
    });
    assert.equal(JSON.stringify(error.details).includes(pairingSecret), false);
    return true;
  });
  assert.equal(requests.length, 3);
  assert.deepEqual(logs.warn.at(-1).data, {
    nodeId: "node_paired",
    keyId: "key_paired",
    originalErrorCode: "NODE_AGENT_HEALTH_FAILED",
    compensationErrorCode: "PAIRING_REVOKE_UNAVAILABLE",
  });
  assert.equal(JSON.stringify(logs).includes(pairingSecret), false);
});

test("direct node pairing treats an invalid compensation receipt as deterministic and never exposes remote strings", async () => {
  const { manager, logs } = pairingManager({
    health: () => response({ error: { message: "health unavailable" } }, 503),
    revoke: () => response({ data: { keyId: pairingSecret, revoked: true, revokedAt: "invalid" } }),
  });

  await assert.rejects(createNode(manager), (error) => {
    assert.equal(error.code, "NODE_AGENT_PAIRING_COMPENSATION_FAILED");
    assert.equal(error.retryable, false);
    assert.equal(error.details.compensationErrorCode, "NODE_AGENT_PAIRING_REVOKE_RECEIPT_INVALID");
    assert.equal("cause" in error, false);
    assert.equal(JSON.stringify(error.details).includes(pairingSecret), false);
    return true;
  });
  assert.equal(JSON.stringify(logs).includes(pairingSecret), false);
});

test("pairing compensation diagnostics cannot change revoke semantics", async (t) => {
  await t.test("successful revoke survives an info logger failure", async () => {
    const { manager } = pairingManager({
      health: () => response({ error: { message: "health unavailable" } }, 503),
      info: () => { throw new Error("logger unavailable"); },
    });
    await assert.rejects(createNode(manager), (error) => error.code === "NODE_AGENT_HEALTH_FAILED");
  });

  await t.test("failed revoke preserves its sanitized error when warn throws", async () => {
    const { manager } = pairingManager({
      health: () => response({ error: { message: "health unavailable" } }, 503),
      revoke: () => response({ error: { code: "PAIRING_REVOKE_UNAVAILABLE" } }, 503),
      warn: () => { throw new Error("logger unavailable"); },
    });
    await assert.rejects(createNode(manager), (error) => {
      assert.equal(error.code, "NODE_AGENT_PAIRING_COMPENSATION_FAILED");
      assert.equal(error.details.compensationErrorCode, "PAIRING_REVOKE_UNAVAILABLE");
      return true;
    });
  });
});

test("pairing compensation redacts reflected secret identifiers and remote error text", async () => {
  const { manager, requests, logs } = pairingManager({
    pairing: () => response({ data: {
      nodeId: "node_paired",
      keyId: pairingSecret,
      secret: pairingSecret,
      pairedAt: new Date().toISOString(),
    } }, 201),
    revoke: () => response({ data: {
      keyId: pairingSecret,
      revoked: true,
      revokedAt: new Date().toISOString(),
    } }),
  });

  await assert.rejects(createNode(manager), (error) => {
    assert.equal(error.code, "NODE_AGENT_PAIRING_RESPONSE_INVALID");
    assert.equal(JSON.stringify(error).includes(pairingSecret), false);
    return true;
  });
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    "/api/node-agent/pairing/complete",
    "/api/node-agent/pairing/current",
  ]);
  assert.equal(JSON.stringify(logs).includes(pairingSecret), false);

  const remoteError = pairingManager({
    health: () => response({ error: { message: `remote reflected ${pairingSecret}` } }, 503),
  });
  await assert.rejects(createNode(remoteError.manager), (error) => {
    assert.equal(error.code, "NODE_AGENT_HEALTH_FAILED");
    assert.equal(error.message.includes(pairingSecret), false);
    return true;
  });
  assert.equal(JSON.stringify(remoteError.logs).includes(pairingSecret), false);
});

test("post-pairing health cannot persist reflected credential material", async () => {
  const { manager, logs, requests, writes } = pairingManager({
    health: () => response({ data: {
      nodeId: "node_paired",
      protocolVersion: pairingSecret,
      build: {
        component: "node-agent",
        packageVersion: pairingSecret,
        buildId: `build-${pairingSecret}`,
      },
    } }),
  });

  await assert.rejects(createNode(manager), (error) => error.code === "NODE_AGENT_PAIRING_SECRET_REFLECTED");
  assert.equal(writes.length, 0);
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    "/api/node-agent/pairing/complete",
    "/api/node-agent/health",
    "/api/node-agent/pairing/current",
  ]);
  assert.equal(JSON.stringify(logs).includes(pairingSecret), false);
  assert.equal(JSON.stringify(logs).includes("[redacted]"), true);
});

test("post-pairing health identity must match the completed pairing", async () => {
  const { manager, requests, writes } = pairingManager({
    health: () => response({ data: {
      nodeId: "node_other",
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    } }),
  });

  await assert.rejects(createNode(manager), (error) => error.code === "NODE_AGENT_PAIRING_IDENTITY_MISMATCH");
  assert.equal(writes.length, 0);
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    "/api/node-agent/pairing/complete",
    "/api/node-agent/health",
    "/api/node-agent/pairing/current",
  ]);
});

test("direct node creation failure self-revokes the pairing on a real node-agent", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-pairing-compensation-"));
  const nodeAgent = await createNodeAgentApp({
    dataDir,
    logger: false,
    nodeId: "node_real_compensation",
    token: "agent-secret",
  });
  t.after(() => nodeAgent.close());
  const invite = await nodeAgent.inject({
    method: "POST",
    url: "/api/node-agent/pairing/invites",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
    remoteAddress: "127.0.0.1",
  });
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/node-agent/health") {
      return response({ error: { message: "health failed after pairing" } }, 503);
    }
    const injected = await nodeAgent.inject({
      method: init.method || "GET",
      url: pathname,
      headers: init.headers,
      payload: init.body,
      remoteAddress: "203.0.113.10",
    });
    return new Response(injected.body, {
      status: injected.statusCode,
      headers: { "content-type": injected.headers["content-type"] || "application/json" },
    });
  };
  const manager = new NodeConnectionManager({
    nodes: { get: () => undefined, put: (node) => node },
    fetchImpl,
    localNodeLabel: "local",
    builtinNodeLabel: "builtin",
    info: () => undefined,
    warn: () => undefined,
  });

  await assert.rejects(createNode(manager, {
    endpoint: "https://real-node-agent.test",
    joinToken: invite.json().data.joinToken,
  }), (error) => error.code === "NODE_AGENT_HEALTH_FAILED");
  const stored = new NodeAgentIdentityStore(nodeAgentStorePaths(dataDir)).read();
  assert.equal(stored.controlPlanePairings.length, 1);
  assert.ok(stored.controlPlanePairings[0].revokedAt);
  assert.equal(stored.pairingInvites, undefined);
  const localHealth = await nodeAgent.inject({
    method: "GET",
    url: "/api/node-agent/health",
    headers: { authorization: "Bearer agent-secret" },
    remoteAddress: "127.0.0.1",
  });
  assert.equal(localHealth.statusCode, 200, localHealth.body);
});

test("AI session resume returns the committed result without refreshing the shared projection", async () => {
  let requests = 0;
  const service = new AiSessionActionService({
    requireInstance: async () => ({}),
    request: async (_instance, route) => {
      requests += 1;
      assert.equal(route, "/ai-sessions/ai_session_1/resume");
      return {
        disposition: "resumed",
        aiSessionId: "ai_session_1",
        providerSessionId: "provider_session_1",
        appSessionId: "app_session_1",
        creationSource: "app-session",
      };
    },
    requireRuntime: async () => ({}),
  });

  const result = await service.resume("instance_1", "ai_session_1");
  assert.equal(result.disposition, "resumed");
  assert.equal(requests, 1);
  assert.equal(service.diagnostics().resumeSnapshotRefreshFailures, 0);
});

test("AI session fork returns the committed result without refreshing the shared projection", async () => {
  let requests = 0;
  const service = new AiSessionActionService({
    requireInstance: async () => ({}),
    request: async (_instance, route) => {
      requests += 1;
      assert.equal(route, "/ai-sessions/ai_session_1/fork");
      return {
        disposition: "created",
        aiSessionId: "ai_session_2",
        providerSessionId: "provider_session_2",
        creationSource: "ai-session",
      };
    },
    requireRuntime: async () => ({}),
  });

  const result = await service.fork("instance_1", "ai_session_1", { clientRequestId: "fork-1", workspace: { mode: "current" } });
  assert.equal(result.disposition, "created");
  assert.equal(requests, 1);
});

test("AI session create, Open App, and close proxy strict controlled-instance results", async () => {
  const requests = [];
  const instance = { config: { defaultCodexPermissionMode: "auto-review" } };
  const service = new AiSessionActionService({
    requireInstance: async () => instance,
    request: async (_instance, route, init) => {
      requests.push({ route, body: init?.body ? JSON.parse(init.body) : undefined });
      if (route === "/ai-sessions") return { disposition: "created", aiSessionId: "ai-direct", providerSessionId: "thread-direct", creationSource: "ai-session" };
      if (route.endsWith("/open-app")) return { disposition: "opened", aiSessionId: "ai-direct", providerSessionId: "thread-direct", appSessionId: "app-direct", creationSource: "ai-session" };
      return { disposition: "closed", aiSessionId: "ai-direct", providerSessionId: "thread-direct", creationSource: "ai-session" };
    },
    requireRuntime: async () => ({ type: "local" }),
  });
  const created = await service.create("instance-direct", {
    agent: "codex",
    cwd: { type: "runtime-path", path: "/workspace" },
    message: "Start",
    clientRequestId: "request-create",
  });
  const opened = await service.openApp("instance-direct", created.aiSessionId, "request-open");
  const closed = await service.close("instance-direct", created.aiSessionId, "request-close");
  assert.equal(opened.appSessionId, "app-direct");
  assert.equal(closed.disposition, "closed");
  assert.deepEqual(requests.map((request) => request.route), [
    "/ai-sessions",
    "/ai-sessions/ai-direct/open-app",
    "/ai-sessions/ai-direct/close",
  ]);
  assert.equal(requests[0].body.permissionMode, "auto-review");
  assert.deepEqual(requests[1].body, { clientRequestId: "request-open" });
});

test("AI session workspace identity is capability-gated for v0.0.21 controlled instances", async () => {
  const requests = [];
  const legacy = { capabilities: {}, config: { defaultCodexPermissionMode: "ask" } };
  const current = {
    capabilities: { features: { aiSessionWorkspaceSelection: true } },
    config: { defaultCodexPermissionMode: "ask" },
  };
  let instance = legacy;
  const service = new AiSessionActionService({
    requireInstance: async () => instance,
    request: async (_instance, route, init) => {
      requests.push({ route, body: init?.body ? JSON.parse(init.body) : undefined });
      if (route.endsWith("/inspect")) return { availability: "not-worktree", dirty: false, branches: [] };
      return { disposition: "created", aiSessionId: "ai-capability", providerSessionId: "thread-capability", creationSource: "ai-session" };
    },
    requireRuntime: async () => ({ type: "local" }),
  });

  await service.create("instance-legacy", {
    agent: "codex",
    cwd: { type: "runtime-path", path: "/workspace" },
    cwdFolderId: "folder-1",
    message: "Legacy",
    clientRequestId: "request-legacy",
  });
  assert.equal(requests[0].body.cwdFolderId, undefined);
  await assert.rejects(
    service.inspectWorkspace("instance-legacy", { type: "runtime-path", path: "/workspace" }),
    (error) => error.code === "AI_SESSION_WORKSPACE_SELECTION_UNSUPPORTED",
  );

  instance = current;
  await service.create("instance-current", {
    agent: "codex",
    cwd: { type: "runtime-path", path: "/workspace" },
    cwdFolderId: "folder-1",
    message: "Current",
    clientRequestId: "request-current",
  });
  await service.inspectWorkspace("instance-current", { type: "runtime-path", path: "/workspace" });
  assert.equal(requests[1].body.cwdFolderId, "folder-1");
  assert.equal(requests[2].route, "/repository/ai-session-workspace/inspect");
});
