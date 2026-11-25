const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("../workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { AppRuntimeManager } = require("../../packages/app-runtime/src/runtime.ts");
const { AiSessionHistoryStore } = require("../../packages/ai-session-runtime/src/ai-session-history-store.ts");
const { createAiSessionRegistry } = require("../../packages/ai-session-runtime/src/ai-session-registry.ts");
const { createWebApp } = require("../../packages/controlled-instance/src/web/server.ts");

function pathsFor(root) {
  return {
    configPath: path.join(root, "config.json"),
    dataDir: root,
    appCatalogDir: path.join(root, "app-catalog"),
    appSessionsDir: path.join(root, "app-sessions"),
    runtimeDir: path.join(root, "runtime"),
    eventsDir: path.join(root, "events"),
    artifactDir: path.join(root, "artifacts"),
    logDir: path.join(root, "logs"),
    webTokenPath: path.join(root, "web-token"),
  };
}

function setEnvironment(paths) {
  const patch = {
    TASK_HANDOFF_CONFIG: paths.configPath,
    TASK_HANDOFF_DATA_DIR: paths.dataDir,
    TASK_HANDOFF_APP_CATALOG_DIR: paths.appCatalogDir,
    TASK_HANDOFF_APP_SESSION_DIR: paths.appSessionsDir,
    TASK_HANDOFF_RUNTIME_DIR: paths.runtimeDir,
    TASK_HANDOFF_EVENTS_DIR: paths.eventsDir,
    TASK_HANDOFF_ARTIFACT_DIR: paths.artifactDir,
    TASK_HANDOFF_LOG_DIR: paths.logDir,
    TASK_HANDOFF_WEB_TOKEN_FILE: paths.webTokenPath,
    TASK_HANDOFF_WEB_AUTH: "off",
    TASK_HANDOFF_WORKSPACE_ROOTS: paths.dataDir,
    TASK_HANDOFF_AI_SESSION_SCAN: "0",
    TASK_HANDOFF_AI_PROCESS_SCAN: "0",
    TASK_HANDOFF_CODEX_APP_SERVER: "0",
    TASK_HANDOFF_INSTANCE_ID: "inst_session_http_parity",
    TASK_HANDOFF_NODE_ID: undefined,
    TASK_HANDOFF_CONTROL_MODE: undefined,
    TASK_HANDOFF_CONTROL_PLANE_URL: undefined,
    TASK_HANDOFF_NODE_AGENT_URL: undefined,
    TASK_HANDOFF_AGENT_TOOLS_ENDPOINT: undefined,
    TASK_HANDOFF_AGENT_TOOLS_TOKEN: undefined,
    TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON: undefined,
    TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: undefined,
    TASK_HANDOFF_RUNTIME_KIND: undefined,
  };
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function codexBridge(registry, scenario, calls) {
  let sequence = 0;
  return {
    id: "session-http-parity-codex",
    agent: "codex",
    refresh() {},
    async ensureReady() {},
    async sync() {},
    stop() {},
    async createSession(input) {
      calls.push({ action: "create", cwd: input.cwd });
      if (scenario.failure === "create") {
        throw Object.assign(new Error("provider create rejected"), { code: "PROVIDER_CREATE_REJECTED", statusCode: 409 });
      }
      sequence += 1;
      return {
        providerSessionId: `provider-http-${sequence}`,
        cwd: input.cwd,
        creationSource: "ai-session",
      };
    },
    async readSession() {},
    async archiveSession() {},
    async deleteSession(providerSessionId) {
      calls.push({ action: "delete", providerSessionId });
    },
    async unsubscribeSession(providerSessionId) {
      calls.push({ action: "unsubscribe", providerSessionId });
    },
    async mentionCatalog() { return { candidates: [], diagnostics: [] }; },
    async searchMentionFiles() { return { candidates: [], complete: true }; },
    async executeCommand() { throw new Error("not used"); },
    async startMessage(session, input) {
      calls.push({ action: "start", sessionId: session.id, message: input.message });
      if (scenario.failure === "start") {
        throw Object.assign(new Error("provider start rejected"), { code: "PROVIDER_START_REJECTED", statusCode: 502 });
      }
      const turnId = `turn-http-${calls.filter((call) => call.action === "start").length}`;
      const updated = registry.patch(session.id, {
        status: "running",
        phase: "thinking",
        activeTurnId: turnId,
        userPrompt: input.message,
        turns: [
          ...(session.turns || []),
          {
            id: turnId,
            providerTurnId: turnId,
            status: "running",
            phase: "thinking",
            userMessages: [{ id: input.messageId, text: input.message, attachments: [] }],
          },
        ],
      });
      return { session: updated, provider: "codex", action: "send", turnId };
    },
    async steerMessage(session, input) {
      calls.push({ action: "steer", sessionId: session.id, message: input.message });
      if (scenario.failure === "steer") {
        throw Object.assign(new Error("provider steer rejected"), { code: "PROVIDER_STEER_REJECTED", statusCode: 502 });
      }
      const updated = registry.applyRealtimeEvent(session.id, {
        kind: "user-message",
        activeTurnId: "turn-steer-active",
        providerTurnId: "turn-steer-active",
        userPrompt: input.message,
        userMessage: input.messageId
          ? { id: input.messageId, text: input.message, attachments: input.userMessageAttachments || [] }
          : undefined,
        source: "control",
      }, { persistence: "strict" }) || session;
      return { session: updated, provider: "codex", action: "steer", turnId: updated.activeTurnId, providerTurnId: "turn-steer-active" };
    },
    async interrupt(session) {
      return { session, provider: "codex", action: "interrupt" };
    },
  };
}

async function createRuntime(scenario) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-session-http-")));
  const paths = pathsFor(root);
  const restore = setEnvironment(paths);
  const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
  const appRuntime = new AppRuntimeManager(paths);
  appRuntime.ensureSharedResource = async () => undefined;
  appRuntime.listSessions = () => [];
  const calls = [];
  const app = await createWebApp({
    staticDir: path.join(root, "missing-static"),
    logger: false,
    appRuntime,
    aiSessionRegistry: registry,
    codexAppServer: codexBridge(registry, scenario, calls),
  });
  return { root, registry, app, appRuntime, calls, restore };
}

function responseBody(response) {
  return { status: response.statusCode, body: response.json() };
}

function stateResponse(response) {
  const body = response.json();
  const data = body.data;
  return {
    status: response.statusCode,
    body: {
      data: {
        streamId: data.streamId,
        revision: data.revision,
        lastEventAt: data.lastEventAt,
        snapshot: {
          runningCount: data.snapshot.runningCount,
          waitingCount: data.snapshot.waitingCount,
          staleCount: data.snapshot.staleCount,
          updatedAt: data.snapshot.updatedAt,
          sessions: data.snapshot.sessions.map((session) => ({
            id: session.id,
            creationSource: session.creationSource,
            providerSessionId: session.providerSessionId,
            cwd: session.cwd,
            cwdFolderId: session.cwdFolderId,
            status: session.status,
            phase: session.phase,
            activeTurnId: session.activeTurnId,
            userPrompt: session.userPrompt,
            unread: session.unread,
            queue: session.queue,
          })),
        },
      },
    },
  };
}

async function startupState(app) {
  const deadline = Date.now() + 3000;
  let latest;
  while (Date.now() < deadline) {
    latest = stateResponse(await app.inject({ method: "GET", url: "/api/ai-sessions/state" }));
    if (latest.body.data.revision > 0) return latest;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`AI session startup snapshot was not published: ${JSON.stringify(latest)}`);
}

function detailResponse(response) {
  const body = response.json();
  return {
    status: response.statusCode,
    body: body.error ? body : {
      data: {
        kind: body.data.kind,
        detail: {
          id: body.data.detail.id,
          appBindingKeys: body.data.detail.appBindingKeys,
          cwd: body.data.detail.cwd,
          error: body.data.detail.error,
          providerMeta: body.data.detail.providerMeta,
          queue: body.data.detail.queue,
          subAgents: body.data.detail.subAgents,
        },
      },
    },
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function projectPersistedSessions(registry) {
  return registry.all().map((session) => ({
    id: session.id,
    providerSessionId: session.providerSessionId,
    creationSource: session.creationSource,
    status: session.status,
    phase: session.phase,
    activeTurnId: session.activeTurnId ?? null,
    turns: (session.turns || []).map((turn) => ({
      id: turn.id,
      providerTurnId: turn.providerTurnId ?? null,
      status: turn.status,
      phase: turn.phase,
      userPrompt: turn.userPrompt ?? null,
      userMessages: (turn.userMessages || []).map((message) => ({ id: message.id, text: message.text })),
    })),
    queue: session.queue,
  }));
}

function normalize(value, context) {
  if (Array.isArray(value)) return value.map((item) => normalize(item, context));
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    if (value === context.root || value.startsWith(`${context.root}${path.sep}`)) {
      return `<root>${value.slice(context.root.length)}`;
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
      return "<time>";
    }
    return value;
  }
  const normalized = {};
  for (const [key, item] of Object.entries(value)) {
    if (["id", "sessionId", "aiSessionId", "queueId", "messageId", "turnId", "streamId"].includes(key)
      && typeof item === "string") {
      const kind = key === "sessionId" || key === "aiSessionId"
        ? "session"
        : key === "queueId"
        ? "queue"
        : key === "messageId"
        ? "message"
        : key === "turnId"
        ? "turn"
        : key === "streamId"
        ? "stream"
        : value.providerSessionId !== undefined
        ? "session"
        : value.providerTurnId !== undefined || value.userMessages !== undefined
        ? "turn"
        : value.message !== undefined && value.createdAt !== undefined
        ? "queue"
        : "id";
      const identity = `${kind}:${item}`;
      if (!context.ids.has(identity)) {
        const count = [...context.ids.keys()].filter((candidate) => candidate.startsWith(`${kind}:`)).length + 1;
        context.ids.set(identity, `<${kind}-${count}>`);
      }
      normalized[key] = context.ids.get(identity);
    } else {
      normalized[key] = normalize(item, context);
    }
  }
  return normalized;
}

async function observeCreate(scenario) {
  const runtime = await createRuntime(scenario);
  try {
    const stateBefore = await startupState(runtime.app);
    const payload = {
      agent: "codex",
      cwd: { type: "runtime-path", path: runtime.root },
      cwdFolderId: "folder-session-http",
      message: "Start over HTTP",
      clientRequestId: "request-create-http",
    };
    const created = responseBody(await runtime.app.inject({ method: "POST", url: "/api/ai-sessions", payload }));
    const stateAfterCreate = stateResponse(await runtime.app.inject({ method: "GET", url: "/api/ai-sessions/state" }));
    const replayed = responseBody(await runtime.app.inject({ method: "POST", url: "/api/ai-sessions", payload }));
    const state = stateResponse(await runtime.app.inject({ method: "GET", url: "/api/ai-sessions/state" }));
    const reopened = createAiSessionRegistry({ dir: path.join(runtime.root, "ai-sessions") });
    return {
      root: runtime.root,
      stateBefore,
      created,
      stateAfterCreate,
      replayed,
      state,
      persisted: projectPersistedSessions(runtime.registry),
      reopened: projectPersistedSessions(reopened),
      calls: runtime.calls,
    };
  } finally {
    await runtime.app.close();
    runtime.restore();
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
}

async function observeCreateFailure(scenario) {
  const runtime = await createRuntime(scenario);
  try {
    const stateBefore = await startupState(runtime.app);
    const created = responseBody(await runtime.app.inject({
      method: "POST",
      url: "/api/ai-sessions",
      payload: {
        agent: "codex",
        cwd: { type: "runtime-path", path: runtime.root },
        message: "Fail during materialization",
        clientRequestId: "request-create-failure-http",
      },
    }));
    const state = stateResponse(await runtime.app.inject({ method: "GET", url: "/api/ai-sessions/state" }));
    const reopened = createAiSessionRegistry({ dir: path.join(runtime.root, "ai-sessions") });
    return { root: runtime.root, stateBefore, created, state, persisted: projectPersistedSessions(runtime.registry), reopened: projectPersistedSessions(reopened), calls: runtime.calls };
  } finally {
    await runtime.app.close();
    runtime.restore();
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
}

async function observeSend(scenario) {
  const runtime = await createRuntime(scenario);
  try {
    const session = runtime.registry.start({
      agent: "codex",
      creationSource: "ai-session",
      providerSessionId: "provider-send-http",
      cwd: runtime.root,
      status: "idle",
      phase: "unknown",
      unread: false,
    }, { timestamp: "2026-11-20T00:00:00.000Z" });
    const stateBefore = await startupState(runtime.app);
    const sent = responseBody(await runtime.app.inject({
      method: "POST",
      url: `/api/ai-sessions/${session.id}/messages`,
      payload: { message: "Send over HTTP", clientRequestId: "request-send-http" },
    }));
    const detail = detailResponse(await runtime.app.inject({ method: "GET", url: `/api/ai-sessions/${session.id}` }));
    const state = stateResponse(await runtime.app.inject({ method: "GET", url: "/api/ai-sessions/state" }));
    const reopened = createAiSessionRegistry({ dir: path.join(runtime.root, "ai-sessions") });
    const missing = responseBody(await runtime.app.inject({
      method: "POST",
      url: "/api/ai-sessions/ais_missing/messages",
      payload: { message: "Missing session" },
    }));
    return {
      root: runtime.root,
      stateBefore,
      sent,
      detail,
      state,
      persisted: projectPersistedSessions(runtime.registry),
      reopened: projectPersistedSessions(reopened),
      missing,
      calls: runtime.calls,
    };
  } finally {
    await runtime.app.close();
    runtime.restore();
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
}

async function observeRead(scenario) {
  const runtime = await createRuntime(scenario);
  try {
    const session = runtime.registry.start({
      agent: "codex",
      creationSource: "ai-session",
      providerSessionId: "provider-read-http",
      cwd: runtime.root,
      status: "running",
      phase: "thinking",
      activeTurnId: "turn-read",
    }, { timestamp: "2026-11-20T00:00:00.000Z" });
    runtime.registry.complete(session.id, "done");
    const stateBefore = await startupState(runtime.app);
    const before = runtime.registry.get(session.id);
    assert.equal(before.unread, true);
    const first = responseBody(await runtime.app.inject({ method: "POST", url: `/api/ai-sessions/${session.id}/read` }));
    const afterFirst = runtime.registry.get(session.id);
    const second = responseBody(await runtime.app.inject({ method: "POST", url: `/api/ai-sessions/${session.id}/read` }));
    const afterSecond = runtime.registry.get(session.id);
    const missing = responseBody(await runtime.app.inject({ method: "POST", url: "/api/ai-sessions/ais_missing/read" }));
    const unreadFirst = responseBody(await runtime.app.inject({ method: "POST", url: `/api/ai-sessions/${session.id}/unread` }));
    const afterUnreadFirst = runtime.registry.get(session.id);
    const unreadSecond = responseBody(await runtime.app.inject({ method: "POST", url: `/api/ai-sessions/${session.id}/unread` }));
    const afterUnreadSecond = runtime.registry.get(session.id);
    const missingUnread = responseBody(await runtime.app.inject({ method: "POST", url: "/api/ai-sessions/ais_missing/unread" }));
    return {
      root: runtime.root,
      stateBefore,
      first,
      second,
      missing,
      unreadFirst,
      unreadSecond,
      missingUnread,
      unread: [before.unread, afterFirst.unread, afterSecond.unread, afterUnreadFirst.unread, afterUnreadSecond.unread],
      updatedAtPreserved: [
        afterFirst.updatedAt === before.updatedAt,
        afterSecond.updatedAt === afterFirst.updatedAt,
        afterUnreadFirst.updatedAt === afterSecond.updatedAt,
        afterUnreadSecond.updatedAt === afterUnreadFirst.updatedAt,
      ],
      state: stateResponse(await runtime.app.inject({ method: "GET", url: "/api/ai-sessions/state" })),
    };
  } finally {
    await runtime.app.close();
    runtime.restore();
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
}

async function observeQueue(scenario) {
  const runtime = await createRuntime(scenario);
  try {
    const session = runtime.registry.start({
      agent: "codex",
      creationSource: "ai-session",
      providerSessionId: "provider-queue-http",
      cwd: runtime.root,
      status: "running",
      phase: "thinking",
    }, { timestamp: "2026-11-20T00:00:00.000Z" });
    runtime.registry.patch(session.id, { activeTurnId: "turn-active" });
    runtime.registry.enqueueMessage(session.id, "Queued while paused");
    const stateBefore = await startupState(runtime.app);
    const initialQueue = responseBody(await runtime.app.inject({ method: "GET", url: `/api/ai-sessions/${session.id}/queue` }));
    const paused = responseBody(await runtime.app.inject({ method: "POST", url: `/api/ai-sessions/${session.id}/queue/pause`, payload: { paused: true } }));
    const pausedQueue = responseBody(await runtime.app.inject({ method: "GET", url: `/api/ai-sessions/${session.id}/queue` }));
    runtime.registry.complete(session.id, "done");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const completedQueue = responseBody(await runtime.app.inject({ method: "GET", url: `/api/ai-sessions/${session.id}/queue` }));
    const sentWhilePaused = runtime.calls.filter((call) => call.action === "start").length;
    const resumed = responseBody(await runtime.app.inject({ method: "POST", url: `/api/ai-sessions/${session.id}/queue/pause`, payload: { paused: false } }));
    assert.equal(await waitFor(() => runtime.calls.filter((call) => call.action === "start").length === 1), true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      root: runtime.root,
      stateBefore,
      initialQueue,
      paused,
      pausedQueue,
      completedQueue,
      sentWhilePaused,
      resumed,
      drainedQueue: responseBody(await runtime.app.inject({ method: "GET", url: `/api/ai-sessions/${session.id}/queue` })),
      sentMessages: runtime.calls.filter((call) => call.action === "start").map((call) => call.message),
      missing: responseBody(await runtime.app.inject({ method: "POST", url: "/api/ai-sessions/ais_missing/queue/pause", payload: { paused: true } })),
      state: stateResponse(await runtime.app.inject({ method: "GET", url: "/api/ai-sessions/state" })),
    };
  } finally {
    await runtime.app.close();
    runtime.restore();
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
}

async function observeQueueMutations(scenario) {
  const runtime = await createRuntime(scenario);
  try {
    const session = runtime.registry.start({
      agent: "codex",
      creationSource: "ai-session",
      providerSessionId: "provider-queue-mutations-http",
      cwd: runtime.root,
      status: "running",
      phase: "thinking",
    }, { timestamp: "2026-11-20T00:00:00.000Z" });
    runtime.registry.patch(session.id, { activeTurnId: "turn-queue-mutations" });
    const first = runtime.registry.enqueueMessage(session.id, "first queued").item;
    const second = runtime.registry.enqueueMessage(session.id, "second queued").item;
    const third = runtime.registry.enqueueMessage(session.id, "third queued").item;
    runtime.registry.markQueuedMessageFailed(session.id, third.id, new Error("temporary"));

    const stateBefore = await startupState(runtime.app);
    const queueUri = `/api/ai-sessions/${session.id}/queue`;
    const initialQueue = responseBody(await runtime.app.inject({ method: "GET", url: queueUri }));
    const initialRevision = runtime.registry.get(session.id).queue.revision;
    const edited = responseBody(await runtime.app.inject({
      method: "PATCH",
      url: `${queueUri}/${second.id}`,
      payload: { expectedRevision: initialRevision, message: "edited second" },
    }));
    const stale = responseBody(await runtime.app.inject({
      method: "PATCH",
      url: `${queueUri}/${second.id}`,
      payload: { expectedRevision: initialRevision, message: "stale edit" },
    }));
    const reorderRevision = runtime.registry.get(session.id).queue.revision;
    const reordered = responseBody(await runtime.app.inject({
      method: "PATCH",
      url: `${queueUri}/reorder`,
      payload: { expectedRevision: reorderRevision, queueIds: [second.id, first.id] },
    }));
    const invalid = responseBody(await runtime.app.inject({
      method: "PATCH",
      url: `${queueUri}/reorder`,
      payload: { expectedRevision: runtime.registry.get(session.id).queue.revision, queueIds: [second.id, second.id] },
    }));
    const failedEdit = responseBody(await runtime.app.inject({
      method: "PATCH",
      url: `${queueUri}/${third.id}`,
      payload: { expectedRevision: runtime.registry.get(session.id).queue.revision, message: "edit failed item" },
    }));
    const retried = responseBody(await runtime.app.inject({
      method: "POST",
      url: `${queueUri}/${third.id}/retry`,
    }));
    const removed = responseBody(await runtime.app.inject({
      method: "DELETE",
      url: `${queueUri}/${first.id}`,
    }));
    const missingItem = responseBody(await runtime.app.inject({
      method: "POST",
      url: `${queueUri}/queue-missing/retry`,
    }));
    const missingSession = responseBody(await runtime.app.inject({
      method: "DELETE",
      url: "/api/ai-sessions/ais_missing/queue/queue-missing",
    }));
    const reopened = createAiSessionRegistry({ dir: path.join(runtime.root, "ai-sessions") });
    return {
      root: runtime.root,
      stateBefore,
      initialQueue,
      edited,
      stale,
      reordered,
      invalid,
      failedEdit,
      retried,
      removed,
      missingItem,
      missingSession,
      state: stateResponse(await runtime.app.inject({ method: "GET", url: "/api/ai-sessions/state" })),
      persisted: projectPersistedSessions(runtime.registry),
      reopened: projectPersistedSessions(reopened),
      calls: runtime.calls,
    };
  } finally {
    await runtime.app.close();
    runtime.restore();
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
}

async function observeQueueSteer(scenario) {
  const runtime = await createRuntime(scenario);
  try {
    const session = runtime.registry.start({
      agent: "codex",
      creationSource: "ai-session",
      providerSessionId: "provider-queue-steer-http",
      cwd: runtime.root,
      status: "running",
      phase: "thinking",
    }, { timestamp: "2026-11-20T00:00:00.000Z" });
    runtime.registry.patch(session.id, {
      activeTurnId: "turn-steer-active",
      userPrompt: "Initial steer target",
      turns: [{
        id: "turn-steer-active",
        providerTurnId: "turn-steer-active",
        status: "running",
        phase: "thinking",
        revision: 1,
        startedAt: "2026-11-20T00:00:00.000Z",
        updatedAt: "2026-11-20T00:00:00.000Z",
        userPrompt: "Initial steer target",
        userMessages: [{ id: "message-steer-initial", text: "Initial steer target", attachments: [] }],
      }],
    });
    const queued = runtime.registry.enqueueMessage(
      session.id,
      "Steer this into the turn",
      [],
      [],
      undefined,
      "message-steer-queued",
    ).item;
    const stateBefore = await startupState(runtime.app);
    const queueUri = `/api/ai-sessions/${session.id}/queue`;
    const initialQueue = responseBody(await runtime.app.inject({ method: "GET", url: queueUri }));
    const steered = responseBody(await runtime.app.inject({
      method: "POST",
      url: `${queueUri}/${queued.id}/steer`,
    }));
    const queue = responseBody(await runtime.app.inject({ method: "GET", url: queueUri }));
    const state = stateResponse(await runtime.app.inject({ method: "GET", url: "/api/ai-sessions/state" }));
    const reopened = createAiSessionRegistry({ dir: path.join(runtime.root, "ai-sessions") });
    return {
      root: runtime.root,
      stateBefore,
      initialQueue,
      steered,
      queue,
      state,
      persisted: projectPersistedSessions(runtime.registry),
      reopened: projectPersistedSessions(reopened),
      calls: runtime.calls,
    };
  } finally {
    await runtime.app.close();
    runtime.restore();
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
}

async function observeReadQueryFallbacks(scenario) {
  const runtime = await createRuntime(scenario);
  try {
    const transcriptPath = path.join(runtime.root, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "first\nsecond\nthird");
    const session = runtime.registry.start({
      agent: "codex",
      creationSource: "ai-session",
      providerSessionId: "provider-read-query-http",
      cwd: runtime.root,
      status: "running",
      phase: "thinking",
      activeTurnId: "turn-read-query",
      turns: [{
        id: "turn-read-query",
        providerTurnId: "turn-read-query",
        status: "running",
        phase: "thinking",
        revision: 1,
        startedAt: "2026-11-20T00:00:00.000Z",
        updatedAt: "2026-11-20T00:00:00.000Z",
        userPrompt: "Read query fallback",
        userMessages: [],
      }],
    }, { timestamp: "2026-11-20T00:00:00.000Z" });
    runtime.registry.patch(session.id, { activeTurnId: "turn-read-query" });
    runtime.registry.attachTranscript(session.id, transcriptPath);
    const stateBefore = await startupState(runtime.app);
    const detail = responseBody(await runtime.app.inject({ method: "GET", url: `/api/ai-sessions/${session.id}` }));
    const detailRevision = detail.body.data.revision;
    const turn = responseBody(await runtime.app.inject({ method: "GET", url: `/api/ai-sessions/${session.id}/turns/turn-read-query` }));
    const turnRevision = turn.body.data.revision;
    const duplicateRevision = encodeURIComponent(detailRevision);
    const duplicateTurnRevision = encodeURIComponent(turnRevision);
    const labelRevision = (value, source, label) => JSON.parse(JSON.stringify(value).replaceAll(source, label));
    return {
      root: runtime.root,
      stateBefore,
      detailRevision: "<detail-revision>",
      duplicateDetailRevision: labelRevision(responseBody(await runtime.app.inject({
        method: "GET",
        url: `/api/ai-sessions/${session.id}?revision=${duplicateRevision}&revision=${duplicateRevision}`,
      })), detailRevision, "<detail-revision>"),
      turnRevision: "<turn-revision>",
      duplicateTurnRevision: labelRevision(responseBody(await runtime.app.inject({
        method: "GET",
        url: `/api/ai-sessions/${session.id}/turns/turn-read-query?revision=${duplicateTurnRevision}&revision=${duplicateTurnRevision}`,
      })), turnRevision, "<turn-revision>"),
      turnsDuplicateProjection: responseBody(await runtime.app.inject({
        method: "GET",
        url: `/api/ai-sessions/${session.id}/turns?projection=index&projection=index`,
      })),
      turnsDuplicateAfterRevision: responseBody(await runtime.app.inject({
        method: "GET",
        url: `/api/ai-sessions/${session.id}/turns?afterTurnId=turn-read-query&afterRevision=0&afterRevision=1`,
      })),
      timelineDuplicateRevision: responseBody(await runtime.app.inject({
        method: "GET",
        url: "/api/ai-sessions/ais_missing/timeline?revision=a&revision=b",
      })),
      turnTimelineDuplicateRevision: responseBody(await runtime.app.inject({
        method: "GET",
        url: "/api/ai-sessions/ais_missing/turns/turn-read-query/timeline?revision=a&revision=b",
      })),
      transcript: responseBody(await runtime.app.inject({
        method: "GET",
        url: `/api/ai-sessions/${session.id}/transcript?tail=1`,
      })),
      duplicateTranscriptTail: responseBody(await runtime.app.inject({
        method: "GET",
        url: `/api/ai-sessions/${session.id}/transcript?tail=1&tail=1`,
      })),
    };
  } finally {
    await runtime.app.close();
    runtime.restore();
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
}

async function observeHistoryAndLogQueryFallbacks(scenario) {
  const runtime = await createRuntime(scenario);
  try {
    const history = new AiSessionHistoryStore({ dataDir: runtime.root });
    for (const [id, agent, title, minute] of [
      ["ai-query-codex", "codex", "Codex history", "00"],
      ["ai-query-claude", "claude", "Claude history", "01"],
    ]) {
      history.upsert({
        id,
        agent,
        creationSource: "ai-session",
        providerSessionId: `provider-${id}`,
        title,
        cwd: runtime.root,
        lastActiveAt: `2026-11-20T00:${minute}:00.000Z`,
        archivedAt: `2026-11-20T00:${minute}:00.000Z`,
      }, []);
    }
    const historyResponse = async (query = "") => responseBody(await runtime.app.inject({
      method: "GET",
      url: `/api/ai-sessions/history${query}`,
    }));

    const appSessionId = "aps_query_logs";
    const logDir = path.join(runtime.root, "logs", "app-sessions", appSessionId);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "main.log"), "0123456789abcdef");
    runtime.appRuntime.getSession = (id) => id === appSessionId ? {
      id: appSessionId,
      appId: "terminal-tty",
      title: "Query logs",
      kind: "tty",
      status: "running",
      createdAt: "2026-11-20T00:00:00.000Z",
      updatedAt: "2026-11-20T00:00:00.000Z",
      workspace: { cwd: runtime.root },
      paths: { sessionDir: path.join(runtime.root, "sessions", appSessionId), logDir },
    } : undefined;
    const logsResponse = async (query = "") => responseBody(await runtime.app.inject({
      method: "GET",
      url: `/api/apps/sessions/${appSessionId}/logs${query}`,
    }));

    return {
      root: runtime.root,
      history: {
        default: await historyResponse(),
        codexOnly: await historyResponse("?agents=codex"),
        duplicateAgents: await historyResponse("?agents=codex&agents=claude"),
        duplicateHierarchy: await historyResponse("?hierarchy=subagents&hierarchy=subagents"),
        detailDuplicateHierarchy: await historyResponse("/ai-query-codex?hierarchy=subagents&hierarchy=subagents"),
      },
      logs: {
        default: await logsResponse(),
        single: await logsResponse("?maxBytes=2048"),
        duplicate: await logsResponse("?maxBytes=2048&maxBytes=4096"),
        duplicateEmpty: await logsResponse("?maxBytes=&maxBytes="),
        invalid: await logsResponse("?maxBytes=not-a-number"),
      },
    };
  } finally {
    await runtime.app.close();
    runtime.restore();
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
}

async function observeNovncResizeQuery(scenario) {
  const runtime = await createRuntime(scenario);
  try {
    const sessionId = "aps_novnc_query";
    runtime.appRuntime.getSession = (id) => id === sessionId ? {
      id: sessionId,
      appId: "terminal-tty",
      title: "VNC query",
      kind: "gui",
      status: "running",
      createdAt: "2026-11-20T00:00:00.000Z",
      updatedAt: "2026-11-20T00:00:00.000Z",
      workspace: { cwd: runtime.root },
      paths: { sessionDir: path.join(runtime.root, "sessions", sessionId), logDir: path.join(runtime.root, "logs", sessionId) },
      vnc: { webPath: "/vnc/index.html" },
    } : undefined;
    const redirect = async (query = "") => {
      const response = await runtime.app.inject({
        method: "GET",
        url: `/api/apps/sessions/${sessionId}/novnc/vnc.html${query}`,
      });
      return { status: response.statusCode, location: response.headers.location };
    };
    return {
      root: runtime.root,
      novnc: {
        default: await redirect(),
        remote: await redirect("?resize=remote"),
        duplicate: await redirect("?resize=remote&resize=remote"),
        duplicateMixed: await redirect("?resize=remote&resize=scale"),
      },
    };
  } finally {
    await runtime.app.close();
    runtime.restore();
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
}

async function observeNodeSessionHttp(scenario) {
  const observers = {
    "create-success-replay-restart": observeCreate,
    "create-first-turn-failure": observeCreateFailure,
    "send-success-and-missing": observeSend,
    "read-clears-unread-and-unknown": observeRead,
    "queue-pause-resume-and-unknown": observeQueue,
    "queue-mutations-and-errors": observeQueueMutations,
    "queue-steer-success": observeQueueSteer,
    "queue-steer-failure": observeQueueSteer,
    "read-query-fallbacks": observeReadQueryFallbacks,
    "history-and-log-query-fallbacks": observeHistoryAndLogQueryFallbacks,
    "novnc-resize-query": observeNovncResizeQuery,
  };
  const observe = observers[scenario.name];
  assert.ok(observe, `unknown session HTTP scenario ${scenario.name}`);
  const observed = await observe(scenario);
  const { root, ...actual } = observed;
  return JSON.parse(JSON.stringify(normalize(actual, { root, ids: new Map() })));
}

module.exports = { observeNodeSessionHttp };
