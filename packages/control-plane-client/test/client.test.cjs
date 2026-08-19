const assert = require("node:assert/strict");
const test = require("node:test");

const {
  appendAiSessionMessageDelta,
  aiSessionElapsedSeconds,
  applyAiSessionUnreadState,
  createControlPlaneClient,
  deriveAiSessionUnreadAfterStreamEvent,
  isAiSessionApprovalPending,
  sortedAiSessions,
  sortedAiSessionInboxEntries,
} = require("../src/index.ts");

test("shared AI Session elapsed time requires a terminal timestamp once inactive", () => {
  const startedAt = "2026-08-17T00:00:00.000Z";
  assert.equal(aiSessionElapsedSeconds(startedAt, undefined, false, Date.parse("2026-08-21T00:00:00.000Z")), undefined);
  assert.equal(aiSessionElapsedSeconds(startedAt, undefined, true, Date.parse("2026-08-17T00:00:09.900Z")), 9);
  assert.equal(aiSessionElapsedSeconds(startedAt, "2026-08-17T00:00:07.500Z", false), 7);
});

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

test("shared AI Session client sends a node folder identity for server-side runtime path resolution", async () => {
  const requests = [];
  const transport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      return schema.parse({ data: {
        disposition: "created",
        aiSessionId: "session-1",
        providerSessionId: "thread-1",
        creationSource: "ai-session",
      } });
    },
  };
  const api = createControlPlaneClient(transport);
  await api.aiSessions.create("instance/1", {
    agent: "codex",
    cwdFolderId: "folder/1",
    message: "Implement it",
    clientRequestId: "request-1",
  });
  assert.equal(requests[0].path, "/api/controlled-instances/instance%2F1/ai-sessions");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    agent: "codex",
    cwdFolderId: "folder/1",
    message: "Implement it",
    attachments: [],
    references: [],
    clientRequestId: "request-1",
  });
});

test("shared AI Session client inspects either a node folder or the instance runtime workspace", async () => {
  const requests = [];
  const transport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      return schema.parse({ data: { availability: "not-worktree", dirty: false, branches: [] } });
    },
  };
  const api = createControlPlaneClient(transport);

  await api.aiSessions.workspace("instance/1", "folder/1");
  await api.aiSessions.workspace("instance/1");

  assert.deepEqual(requests.map((request) => request.path), [
    "/api/controlled-instances/instance%2F1/ai-sessions/workspace?cwdFolderId=folder%2F1",
    "/api/controlled-instances/instance%2F1/ai-sessions/workspace",
  ]);
});

test("shared resource client reads the instance workspace source used for default project selection", async () => {
  const requests = [];
  const transport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      return schema.parse({ data: {
        source: { type: "local-folder", localFolderId: "folder/1", path: "/workspace/project" },
      } });
    },
  };
  const api = createControlPlaneClient(transport);
  assert.deepEqual(await api.resources.instanceWorkspaceSource("instance/1"), {
    type: "local-folder",
    localFolderId: "folder/1",
    path: "/workspace/project",
  });
  assert.equal(requests[0].path, "/api/controlled-instances/instance%2F1");
  assert.equal(requests[0].init.method, undefined);
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
      if (path === "/api/auth/password") {
        return schema.parse({ data: { user: {
          id: "user-1",
          username: "admin",
          role: "admin",
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T00:00:00.000Z",
        } } });
      }
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
  await api.auth.changePassword({ currentPassword: "password123", newPassword: "password456" });
  await api.auth.loginMobile({
    username: "admin",
    password: "secret",
    device: { id: "device-0001", name: "Phone", platform: "ios" },
  });
  await api.auth.logoutMobile();

  assert.equal(requests[0].path, "/api/auth/session");
  assert.equal(requests[1].path, "/api/auth/password");
  assert.equal(requests[1].init.method, "PATCH");
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    currentPassword: "password123",
    newPassword: "password456",
  });
  assert.equal(requests[2].path, "/api/auth/mobile/login");
  assert.equal(requests[2].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[2].init.body), {
    username: "admin",
    password: "secret",
    device: { id: "device-0001", name: "Phone", platform: "ios" },
  });
  assert.equal(requests[3].path, "/api/auth/mobile/logout");
  assert.equal(requests[3].init.method, "POST");
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

test("shared trigger client owns template, binding, and run routes", async () => {
  const requests = [];
  const timestamp = "2026-08-09T00:00:00.000Z";
  const config = {
    configHash: "trg_1234567890abcdef12345678",
    name: "Hourly",
    source: { type: "schedule", scheduleKind: "interval", intervalMs: 3_600_000 },
    action: { promptTemplate: "Continue" },
    policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const deployment = {
    configHash: config.configHash,
    deploymentId: `session:session/1:${config.configHash}`,
    instanceId: "instance/1",
    origin: "control-plane",
    enabled: true,
    target: { type: "ai-session", aiSessionId: "session/1" },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const transport = {
    async request(path, schema, init) {
      requests.push({ path, init });
      if (path === "/api/triggers" && !init?.method) return schema.parse({ data: { updatedAt: timestamp, triggers: [{ configHash: config.configHash, config, deploymentCount: 0, enabledCount: 0, runningCount: 0, errorCount: 0, ownedByControlPlane: true, controlPlaneDeploymentCount: 0, deployments: [], recentRuns: [], futureField: true }] } });
      if (path === "/api/triggers" && init.method === "POST") return schema.parse({ data: { ...config, id: config.configHash } });
      if (path.includes("/ai-sessions/") && init.method === "POST") return schema.parse({ data: { config, deployment } });
      if (path.includes("/ai-sessions/") && init.method === "DELETE") return schema.parse({ data: { deleted: true } });
      if (path.endsWith("/run")) return schema.parse({ data: { status: "completed" } });
      return schema.parse({ data: init.method === "PUT" ? { previousConfigHash: config.configHash, trigger: { ...config, id: config.configHash }, results: [] } : { configHash: config.configHash, deletedTemplate: true, results: [] } });
    },
  };
  const api = createControlPlaneClient(transport);
  const input = { name: config.name, source: config.source, action: config.action, policy: config.policy };
  const listed = await api.triggers.list();
  await api.triggers.create(input);
  await api.triggers.update(config.configHash, input);
  await api.triggers.bindSession("instance/1", "session/1", config.configHash);
  await api.triggers.run("instance/1", config.configHash, deployment.deploymentId);
  await api.triggers.unbindSession("instance/1", "session/1", config.configHash);
  await api.triggers.remove(config.configHash);

  assert.equal("futureField" in listed.triggers[0], false);
  assert.deepEqual(requests.map((request) => request.path), [
    "/api/triggers",
    "/api/triggers",
    `/api/triggers/${config.configHash}`,
    `/api/controlled-instances/instance%2F1/ai-sessions/session%2F1/triggers`,
    `/api/controlled-instances/instance%2F1/triggers/${config.configHash}/run`,
    `/api/controlled-instances/instance%2F1/ai-sessions/session%2F1/triggers/${config.configHash}`,
    `/api/triggers/${config.configHash}`,
  ]);
  assert.deepEqual(JSON.parse(requests[4].init.body), { deploymentId: deployment.deploymentId });
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
