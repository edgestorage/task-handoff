const assert = require("node:assert/strict");
const test = require("node:test");

const {
  appendAiSessionMessageDelta,
  applyAiSessionUnreadState,
  createControlPlaneClient,
  deriveAiSessionUnreadAfterStreamEvent,
  isAiSessionApprovalPending,
  sortedAiSessions,
  sortedAiSessionInboxEntries,
} = require("../src/index.ts");

test("shared AI Session client owns route encoding, request input, and response schema", async () => {
  const requests = [];
  const transport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      return schema.parse({
        data: {
          runningCount: 0,
          waitingCount: 0,
          staleCount: 0,
          sessions: [],
          updatedAt: "2026-08-05T00:00:00.000Z",
        },
      });
    },
  };
  const api = createControlPlaneClient(transport);

  assert.throws(() => api.aiSessions.sendMessage("instance/unsafe", "session unsafe", { message: " " }));
  transport.request = async (path, schema, init) => {
    requests.push({ path, init });
    return schema.parse({ data: {
      session: {
        id: "session two", agent: "codex", status: "idle", phase: "unknown",
        startedAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z",
      },
      provider: "codex", action: "interrupt",
    } });
  };
  await api.aiSessions.interrupt("instance/one", "session two");

  assert.equal(requests[0].path, "/api/controlled-instances/instance%2Fone/ai-sessions/session%20two/interrupt");
  assert.equal(requests[0].init.method, "POST");
});

test("shared auth client owns Web and mobile authentication contracts", async () => {
  const requests = [];
  const transport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      if (path === "/api/auth/session") {
        return schema.parse({
          data: {
            mode: "password",
            enabled: true,
            requiresBootstrap: false,
            authenticated: true,
            user: {
              id: "user-1",
              username: "admin",
              role: "admin",
              createdAt: "2026-08-05T00:00:00.000Z",
              updatedAt: "2026-08-05T00:00:00.000Z",
            },
          },
        });
      }
      if (path === "/api/auth/mobile/logout") return schema.parse({ data: { ok: true } });
      return schema.parse({
        data: {
          sessionToken: "mobile-token-that-is-at-least-32-characters",
          session: {
            id: "mobile-session-1",
            expiresAt: "2026-09-05T00:00:00.000Z",
            createdAt: "2026-08-05T00:00:00.000Z",
            lastSeenAt: "2026-08-05T00:00:00.000Z",
            device: { id: "device-0001", name: "Phone", platform: "ios" },
            user: {
              id: "user-1",
              username: "admin",
              role: "admin",
              createdAt: "2026-08-05T00:00:00.000Z",
              updatedAt: "2026-08-05T00:00:00.000Z",
            },
          },
        },
      });
    },
  };
  const api = createControlPlaneClient(transport);

  await api.auth.session();
  await api.auth.loginMobile({
    username: "admin",
    password: "secret",
    device: { id: "device-0001", name: "Phone", platform: "ios" },
  });
  await api.auth.logoutMobile();

  assert.equal(requests[0].path, "/api/auth/session");
  assert.equal(requests[1].path, "/api/auth/mobile/login");
  assert.equal(requests[1].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    username: "admin",
    password: "secret",
    device: { id: "device-0001", name: "Phone", platform: "ios" },
  });
  assert.equal(requests[2].path, "/api/auth/mobile/logout");
  assert.equal(requests[2].init.method, "POST");
});

test("shared client owns recovery, desktop lifecycle, and command routes used by Web", async () => {
  const requests = [];
  const transport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      if (path === "/api/ai-sessions?refresh=true") return schema.parse({ data: { updatedAt: "2026-08-05T00:00:00.000Z", instances: [] } });
      if (path.endsWith("/open-app")) return schema.parse({ data: { disposition: "opened", aiSessionId: "session", providerSessionId: "provider", appSessionId: "app", creationSource: "ai-session" } });
      if (path.endsWith("/close")) return schema.parse({ data: { disposition: "closed", aiSessionId: "session", providerSessionId: "provider", creationSource: "ai-session" } });
      return schema.parse({ data: { command: "rename", value: "Renamed" } });
    },
  };
  const api = createControlPlaneClient(transport);
  await api.aiSessions.refresh();
  await api.aiSessions.openApp("instance/1", "session 1", "request-open");
  await api.aiSessions.close("instance/1", "session 1", "request-close");
  await api.aiSessions.executeCommand("instance/1", "session 1", { command: "rename", argument: "Renamed" });
  assert.deepEqual(requests.map((request) => request.path), [
    "/api/ai-sessions?refresh=true",
    "/api/controlled-instances/instance%2F1/ai-sessions/session%201/open-app",
    "/api/controlled-instances/instance%2F1/ai-sessions/session%201/close",
    "/api/controlled-instances/instance%2F1/ai-sessions/session%201/commands",
  ]);
});

test("shared resource client requests strict mobile-safe directory projections", async () => {
  const requests = [];
  const transport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      if (path.startsWith("/api/nodes")) {
        return schema.parse({ data: [{
          id: "node-1",
          name: "Node",
          status: "online",
          health: "ok",
          connectionMode: "direct-http",
          observedAt: "2026-08-05T00:00:00.000Z",
          capabilities: ["agent"],
        }] });
      }
      if (path === "/api/controlled-instances/instance%2F1") {
        return schema.parse({ data: { config: { defaultCodexPermissionMode: "auto-review" } } });
      }
      return schema.parse({ data: [{
        id: "instance-1",
        name: "Instance",
        nodeId: "node-1",
        status: "running",
        health: "ok",
        connectionStatus: "online",
        ready: true,
        config: { defaultCodexPermissionMode: "full-access" },
        observedAt: "2026-08-05T00:00:00.000Z",
        runtime: { id: "runtime-1", name: "Docker", type: "docker" },
        workspace: { status: "ready", path: "/workspace" },
        protocol: { version: "2026-08-01", compatible: true },
        aiSessions: {
          runningCount: 0,
          waitingCount: 0,
          staleCount: 0,
          idleCount: 0,
          problemCount: 0,
          updatedAt: "2026-08-05T00:00:00.000Z",
        },
        availableAgents: [],
      }] });
    },
  };
  const api = createControlPlaneClient(transport);

  await api.resources.nodes();
  const instances = await api.resources.instanceBoard();
  const savedPermission = await api.resources.updateInstanceDefaultPermissionMode("instance/1", "auto-review");

  assert.equal(instances[0].config.defaultCodexPermissionMode, "full-access");
  assert.equal(savedPermission, "auto-review");

  assert.deepEqual(requests.map((request) => request.path), [
    "/api/nodes?projection=directory",
    "/api/instance-board?projection=directory",
    "/api/controlled-instances/instance%2F1",
  ]);
  assert.equal(requests[2].init.method, "PATCH");
  assert.deepEqual(JSON.parse(requests[2].init.body), { config: { defaultCodexPermissionMode: "auto-review" } });

  const unsafeApi = createControlPlaneClient({
    request(path, schema) {
      return Promise.resolve(schema.parse({ data: [{
        id: "node-1",
        name: "Node",
        status: "online",
        health: "ok",
        connectionMode: "direct-http",
        observedAt: "2026-08-05T00:00:00.000Z",
        capabilities: [],
        endpoint: "https://node.internal",
      }] }));
    },
  });
  await assert.rejects(() => unsafeApi.resources.nodes());
});

test("shared AI Session state preserves Web sorting, unread, approval, and delta behavior", () => {
  const idle = { id: "idle", status: "idle", phase: "ready", updatedAt: "2026-08-05T00:00:00.000Z", unread: true };
  const running = { id: "running", status: "running", phase: "responding", updatedAt: "2026-08-05T00:01:00.000Z", unread: true };
  const approval = { id: "approval", status: "waiting", phase: "approval", updatedAt: "2026-08-05T00:02:00.000Z", unread: true };

  assert.deepEqual(sortedAiSessions([idle, running, approval]).map((session) => session.id), ["approval", "running", "idle"]);
  assert.equal(isAiSessionApprovalPending(approval), true);
  assert.equal(deriveAiSessionUnreadAfterStreamEvent(running, true), false);
  assert.equal(deriveAiSessionUnreadAfterStreamEvent(idle, true), true);
  assert.equal(applyAiSessionUnreadState(idle, {
    instanceId: "instance-1",
    sessionId: "idle",
    sessionUpdatedAt: idle.updatedAt,
    unread: false,
    updatedAt: "2026-08-05T00:03:00.000Z",
  }).unread, false);

  assert.deepEqual(appendAiSessionMessageDelta({
    receivedText: "hel",
    status: "waiting",
    receivedAt: "old",
    settledAt: "old",
    updatedAt: "old",
  }, "lo", "new"), {
    receivedText: "hello",
    status: "streaming",
    receivedAt: "new",
    settledAt: undefined,
    updatedAt: "new",
  });
});

test("AI Session inbox sorts by the latest user message instead of status or assistant activity", () => {
  const recentIdle = {
    id: "recent-idle",
    agent: "codex",
    status: "idle",
    phase: "ready",
    startedAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:03:00.000Z",
    turns: [
      { id: "recent-turn", userPrompt: "Recent", startedAt: "2026-08-05T00:02:00.000Z" },
      { id: "older-turn-returned-last", userPrompt: "Older in an unordered snapshot", startedAt: "2026-08-05T00:00:30.000Z" },
    ],
  };
  const activeWithLaterAssistantUpdate = {
    id: "old-active",
    agent: "codex",
    status: "running",
    phase: "responding",
    startedAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:10:00.000Z",
    turns: [{ id: "old-turn", userPrompt: "Older", startedAt: "2026-08-05T00:01:00.000Z", updatedAt: "2026-08-05T00:10:00.000Z" }],
  };

  assert.deepEqual(sortedAiSessionInboxEntries([
    { instanceId: "instance-1", session: activeWithLaterAssistantUpdate },
    { instanceId: "instance-1", session: recentIdle },
  ]).map((entry) => entry.session.id), ["recent-idle", "old-active"]);
});
