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

test("shared AI Session client owns revisioned queue edit and reorder routes", async () => {
  const requests = [];
  const transport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      return schema.parse({ data: {
        id: "session-1", agent: "codex", status: "running", phase: "thinking",
        startedAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z",
        queue: { revision: 4, pendingCount: 2, items: [] },
      } });
    },
  };
  const api = createControlPlaneClient(transport);
  await api.aiSessions.editQueue("instance/1", "session/1", "queue/1", { expectedRevision: 3, message: "  revised  " });
  await api.aiSessions.reorderQueue("instance/1", "session/1", { expectedRevision: 4, queueIds: ["queue-2", "queue-1"] });
  assert.deepEqual(requests.map((request) => request.path), [
    "/api/controlled-instances/instance%2F1/ai-sessions/session%2F1/queue/queue%2F1",
    "/api/controlled-instances/instance%2F1/ai-sessions/session%2F1/queue/reorder",
  ]);
  assert.deepEqual(requests.map((request) => request.init.method), ["PATCH", "PATCH"]);
  assert.deepEqual(JSON.parse(requests[0].init.body), { expectedRevision: 3, message: "revised" });
  assert.deepEqual(JSON.parse(requests[1].init.body), { expectedRevision: 4, queueIds: ["queue-2", "queue-1"] });
});

test("shared App Session client owns aggregate, launch, stop, rename, and delta routes", async () => {
  const requests = [];
  const transport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      if (path.includes("sinceRevision")) return schema.parse({ data: { streamId: "stream-1", instanceId: "instance-1", sinceRevision: 4, latestRevision: 4, earliestRetainedRevision: 0, syncRequired: false, events: [] } });
      if (path.endsWith("/access")) return schema.parse({ data: init.method === "DELETE" ? { revoked: true } : { mode: "vnc", url: "/apps/access/vnc?token=lease", token: "lease", expiresAt: "2026-08-07T00:15:00.000Z" } });
      if (path.includes("/apps/sessions")) return schema.parse({ data: { id: "app-session-1", appId: "terminal-tty", kind: "tty", status: "running", bindings: [] } });
      return schema.parse({ data: { updatedAt: "2026-08-07T00:00:00.000Z", instances: [] } });
    },
  };
  const api = createControlPlaneClient(transport);
  await api.appSessions.list();
  await api.appSessions.launch("instance/1", { appId: "terminal-tty", cwdFolderId: "folder/1" });
  await api.appSessions.stop("instance/1", "session/1");
  await api.appSessions.rename("instance/1", "session/1", "  Terminal  ");
  const access = await api.appSessions.access("instance/1", "session/1");
  await api.appSessions.revokeAccess("instance/1", "session/1", access.token);
  await api.appSessions.delta("instance/1", "stream/1", 4);
  assert.deepEqual(requests.map((request) => request.path), [
    "/api/app-sessions",
    "/api/controlled-instances/instance%2F1/apps/sessions",
    "/api/controlled-instances/instance%2F1/apps/sessions/session%2F1/stop",
    "/api/controlled-instances/instance%2F1/apps/sessions/session%2F1",
    "/api/controlled-instances/instance%2F1/apps/sessions/session%2F1/access",
    "/api/controlled-instances/instance%2F1/apps/sessions/session%2F1/access",
    "/api/app-sessions?instanceId=instance%2F1&streamId=stream%2F1&sinceRevision=4",
  ]);
  assert.equal(requests[1].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[1].init.body), { appId: "terminal-tty", cwdFolderId: "folder/1" });
  assert.equal(requests[2].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[2].init.body), {});
  assert.equal(requests[3].init.method, "PATCH");
  assert.deepEqual(JSON.parse(requests[3].init.body), { title: "Terminal" });
  assert.equal(requests[4].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[4].init.body), {});
  assert.equal(requests[5].init.method, "DELETE");
  assert.deepEqual(JSON.parse(requests[5].init.body), { token: "lease" });
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

test("shared resource client validates declared fields and drops unknown response fields", async () => {
  const requests = [];
  const transport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      if (path.startsWith("/api/nodes")) {
        if (init?.method === "PATCH") return schema.parse({ data: { id: "node-1", name: "Renamed Node", ignored: true } });
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
        if (JSON.parse(init.body).name) return schema.parse({ data: { id: "instance-1", name: "Renamed Instance", ignored: true } });
        return schema.parse({ data: { config: { defaultCodexPermissionMode: "auto-review" } } });
      }
      if (path === "/api/controlled-instances/instance%2F1/restart") {
        return schema.parse({ data: { id: "instance-1", status: "starting", ignored: true } });
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
        availableApps: [{ id: "terminal-tty", name: "Terminal", kind: "tty", supportsCwdSelection: true }],
        availableAgents: [],
      }] });
    },
  };
  const api = createControlPlaneClient(transport);

  await api.resources.nodes();
  const instances = await api.resources.instanceBoard();
  const savedPermission = await api.resources.updateInstanceDefaultPermissionMode("instance/1", "auto-review");
  const renamedInstance = await api.resources.updateInstanceName("instance/1", "Renamed Instance");
  const renamedNode = await api.resources.updateNodeName("node-1", "Renamed Node");
  const restarted = await api.resources.instanceAction("instance/1", "restart");

  assert.equal(instances[0].config.defaultCodexPermissionMode, "full-access");
  assert.equal(instances[0].availableApps[0].id, "terminal-tty");
  assert.equal(savedPermission, "auto-review");
  assert.deepEqual(renamedInstance, { id: "instance-1", name: "Renamed Instance" });
  assert.deepEqual(renamedNode, { id: "node-1", name: "Renamed Node" });
  assert.deepEqual(restarted, { id: "instance-1", status: "starting" });

  assert.deepEqual(requests.map((request) => request.path), [
    "/api/nodes?projection=directory",
    "/api/instance-board?projection=directory",
    "/api/controlled-instances/instance%2F1",
    "/api/controlled-instances/instance%2F1",
    "/api/nodes/node-1",
    "/api/controlled-instances/instance%2F1/restart",
  ]);
  assert.equal(requests[2].init.method, "PATCH");
  assert.deepEqual(JSON.parse(requests[2].init.body), { config: { defaultCodexPermissionMode: "auto-review" } });
  assert.deepEqual(JSON.parse(requests[3].init.body), { name: "Renamed Instance" });
  assert.deepEqual(JSON.parse(requests[4].init.body), { name: "Renamed Node" });
  assert.equal(requests[5].init.method, "POST");

  const compatibleApi = createControlPlaneClient({
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
  const compatibleNodes = await compatibleApi.resources.nodes();
  assert.equal(compatibleNodes[0].id, "node-1");
  assert.equal("endpoint" in compatibleNodes[0], false);

  const invalidApi = createControlPlaneClient({
    request(path, schema) {
      return Promise.resolve(schema.parse({ data: [{
        id: "node-1",
        name: "Node",
        status: 123,
        health: "ok",
        connectionMode: "direct-http",
        observedAt: "2026-08-05T00:00:00.000Z",
        capabilities: [],
      }] }));
    },
  });
  await assert.rejects(() => invalidApi.resources.nodes());
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
