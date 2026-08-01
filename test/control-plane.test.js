const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const WebSocket = require("ws");
const { z } = require("zod");

const { createControlPlaneApp, routeAuthorization } = require("../packages/control-plane/src/server.ts");
const { connectReverseTunnel, createNodeAgentApp, createReverseTunnelManager, listenNodeAgentIpcServer, mergeRuntimeLifecycleResult, NodeAgentExternalListenerManager, requestRuntimeAppSessionDrain, resolvedDockerImageUpdatePatch, runtimeVersionStateForActual } = require("../packages/control-plane/src/node-agent.ts");
const { ControlPlaneChatGatewayRuntime, aiSessionDeliveryText, createDingdingStreamClient } = require("../packages/control-plane/src/chat-gateway.ts");
const { ControlledInstanceGateway } = require("../packages/control-plane/src/control-plane/instances/gateway.ts");
const { parseDingdingCardEvent, sendDingdingActionsCard } = require("../packages/control-plane/src/control-plane/chat/adapters/dingding.ts");
const { DingdingProgressStore } = require("../packages/control-plane/src/control-plane/chat/gateway/dingding-progress-store.ts");
const { DingdingBridgeRuntimeManager } = require("../packages/control-plane/src/control-plane/chat/gateway/dingding-bridge-runtime.ts");
const { ControlPlaneEventBus } = require("../packages/control-plane/src/control-plane/events/bus.ts");
const { ControlPlaneAiSessionAggregator } = require("../packages/control-plane/src/control-plane/sessions/ai-session-aggregator.ts");
const { ControlPlaneAppSessionAggregator } = require("../packages/control-plane/src/control-plane/sessions/app-session-aggregator.ts");
const { NodeAgentInstanceEventForwarder } = require("../packages/control-plane/src/node-agent/events.ts");
const { AiSessionMessageDeltaCoalescer } = require("../packages/controlled-instance/src/web/ai-session-message-delta-coalescer.ts");
const { NodeAgentPairedHmacVerifier } = require("../packages/control-plane/src/node-agent/identity/hmac-verifier.ts");
const { NodeAgentIdentityService } = require("../packages/control-plane/src/node-agent/identity/service.ts");
const { NodeAgentIdentityStore } = require("../packages/control-plane/src/node-agent/identity/store.ts");
const { ControlPlaneNodeAgentTunnelTransport } = require("../packages/control-plane/src/control-plane/nodes/tunnel.ts");
const { createNodeAgentHmacHeaders, NODE_AGENT_HMAC_TIMESTAMP_WINDOW_MS } = require("../packages/control-plane/src/shared/security/node-agent-auth.ts");
const { fetchNodeAgentIpc, nodeAgentIpcEndpoint, nodeAgentIpcPath, prepareNodeAgentIpcPath } = require("../packages/control-plane/src/shared/transport/node-agent-ipc.ts");
const { can } = require("../packages/control-plane/src/control-plane/auth/authorization.ts");
const { LocalDockerExecutor, dockerRunArgs } = require("../packages/control-plane/src/node-agent/runtimes/docker.ts");
const { checkNodeAgentUpdate, isNewerVersion, resolveNodeAgentUpdateWorker, resolveNodeUpdatePackage, sanitizeStoredUpdateJob } = require("../packages/control-plane/src/node-agent/updates.ts");
const { ProcessSingletonError, acquireProcessSingletonLock } = require("../packages/control-plane/src/shared/process/singleton-lock.ts");
const { processStartIdentity, verifiedProcessLockOwnerPid } = require("../packages/core/src/core/process-singleton-lock.ts");
const { acquireLocalControlledInstanceLock, localControlledInstanceLockPath, readLocalControlledInstanceLockOwner } = require("../packages/core/src/core/local-controlled-instance-lock.ts");
const { acquireControlPlaneSingletonLock } = require("../packages/control-plane/src/control-plane/process/singleton-lock.ts");
const { acquireNodeAgentSingletonLock } = require("../packages/control-plane/src/node-agent/process/singleton-lock.ts");
const { EventConnectionRetryTimer, eventConnectionRetryDelay, eventConnectionSafetyIntervalMs } = require("../packages/control-plane/src/shared/events/connection-retry.ts");
const { JsonCollection, JsonFile } = require("../packages/control-plane/src/shared/persistence/store.ts");
const { nodeAgentStorePaths } = require("../packages/control-plane/src/node-agent/persistence/paths.ts");
const { aiSessionUserPrompts, displayAiSessionMessage, displayAiSessionTitle, launchableAppsForInstance: uiLaunchableAppsForInstance } = require("../packages/control-plane-ui/src/apps/control-plane/useInstanceSessions.ts");
const { launchableAppsForInstance: chatLaunchableAppsForInstance } = require("../packages/control-plane/src/control-plane/chat/rendering.ts");
const { appSessionStatus } = require("../packages/control-plane-ui/src/apps/control-plane/appSessionVisibility.ts");
const { AiSessionEventType, AiSessionEventTopic, AiSessionUnreadEventType } = require("../packages/protocol/src/ai-sessions.ts");
const { AppSessionEventType, normalizeAppSessionRecord } = require("../packages/protocol/src/app-sessions.ts");
const { ApplyUpdateRequestSchema, CONTROL_PLANE_PROTOCOL_VERSION, ControlledInstanceHeartbeatSchema, ControlledInstanceRegisterSchema, ControlledInstanceSchema, InstanceAppInventorySchema, InstanceLifecycleEventType, RuntimeArtifactIdentitySchema, RuntimeVersionStateSchema, UpdateCheckRequestSchema, UpdateJobSchema, decodeNodeTunnelRequestBody, modelConfigHash, parseStoredControlledInstance, sanitizeStoredControlledInstance } = require("../packages/protocol/src/control-plane.ts");
const { ChatActionTokenService, parsePendingDecisionCallbackData, pendingDecisionRouteFingerprint } = require("../packages/control-plane/src/control-plane/chat/action-token-service.ts");

const controlledProcessIdentityRouteStubLines = [
  "  if (req.url === '/api/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: { ok: true } })); return; }",
  "  if (req.url === '/api/internal/node-agent/process-identity' && req.headers.authorization === `Bearer ${process.env.TASK_HANDOFF_REGISTRATION_TOKEN}`) {",
  "    let startIdentity;",
  "    try {",
  "      if (process.platform === 'linux') { const stat = require('node:fs').readFileSync(`/proc/${process.pid}/stat`, 'utf8'); startIdentity = `linux:${stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19]}`; }",
  "      else { startIdentity = `${process.platform}:${require('node:child_process').execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' }).trim().replace(/\\s+/g, ' ')}`; }",
  "    } catch {}",
  "    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: { instanceId: process.env.TASK_HANDOFF_INSTANCE_ID, pid: process.pid, processNonce: process.env.TASK_HANDOFF_LOCAL_PROCESS_NONCE, startIdentity } })); return;",
  "  }",
];

test("node agent uses an explicit packaged version as the runtime convergence target", () => {
  const previousVersion = process.env.TASK_HANDOFF_VERSION;
  process.env.TASK_HANDOFF_VERSION = "9.8.7";
  try {
    const state = runtimeVersionStateForActual("9.8.7");
    assert.equal(state.desiredVersion, "9.8.7");
    assert.equal(state.actualVersion, "9.8.7");
    assert.equal(state.phase, "matched");
    assert.equal(state.attempt, 0);
  } finally {
    if (previousVersion === undefined) delete process.env.TASK_HANDOFF_VERSION;
    else process.env.TASK_HANDOFF_VERSION = previousVersion;
  }
});

test("runtime app-session drain prefers managed bulk drain and falls back across older snapshots", async () => {
  const baseInstance = {
    id: "inst_drain",
    target: { strategy: "direct-port", web: "http://127.0.0.1:19000" },
    registrationToken: "registration-token",
    apps: { runningCount: 2, problemCount: 0 },
  };
  const bulkCalls = [];
  const bulk = await requestRuntimeAppSessionDrain(async (url, init) => {
    bulkCalls.push([String(url), init?.method, init?.headers]);
    return new Response(JSON.stringify({ data: { drained: true } }), { status: 200, headers: { "content-type": "application/json" } });
  }, baseInstance);
  assert.equal(bulk.requested, 2);
  assert.deepEqual(bulk.failures, []);
  assert.equal(bulkCalls.length, 1);
  assert.match(bulkCalls[0][0], /\/api\/internal\/node-agent\/drain$/);
  assert.deepEqual(bulkCalls[0][2], { authorization: "Bearer registration-token" });

  const fallbackCalls = [];
  const fallback = await requestRuntimeAppSessionDrain(async (url, init) => {
    const path = new URL(String(url)).pathname;
    fallbackCalls.push([path, init?.method]);
    if (path === "/api/internal/node-agent/drain") return new Response("not found", { status: 404 });
    if (path === "/api/apps/sessions") {
      return new Response(JSON.stringify({
        data: {
          snapshot: {
            sessions: [
              { id: "app_running", status: "running" },
              { id: "app_stopped", status: "stopped" },
            ],
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: { status: "stopped" } }), { status: 200, headers: { "content-type": "application/json" } });
  }, baseInstance);
  assert.equal(fallback.requested, 1);
  assert.deepEqual(fallback.failures, []);
  assert.deepEqual(fallbackCalls, [
    ["/api/internal/node-agent/drain", "POST"],
    ["/api/apps/sessions", "GET"],
    ["/api/apps/sessions/app_running/stop", "POST"],
  ]);
});

test("control plane reports the explicit packaged version in health", async (t) => {
  const previousVersion = process.env.TASK_HANDOFF_VERSION;
  process.env.TASK_HANDOFF_VERSION = "9.8.7";
  const app = await createControlPlaneApp({ dataDir: tempDataDir("control-plane-explicit-version"), logger: false });
  t.after(async () => {
    if (previousVersion === undefined) delete process.env.TASK_HANDOFF_VERSION;
    else process.env.TASK_HANDOFF_VERSION = previousVersion;
    await app.close();
  });
  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().data.build.packageVersion, "9.8.7");
});

test("pending decision callbacks are stable and resolved from the current route", () => {
  const first = new ChatActionTokenService();
  const second = new ChatActionTokenService();
  const routeId = "inst_12345678901234567890:ai:session-with-a-long-provider-generated-id";
  const callbackData = first.pendingDecisionCallbackData(routeId, "allow");

  assert.equal(callbackData, second.pendingDecisionCallbackData(routeId, "allow"));
  assert.ok(Buffer.byteLength(callbackData, "utf8") <= 64);
  assert.deepEqual(parsePendingDecisionCallbackData(callbackData), {
    routeFingerprint: pendingDecisionRouteFingerprint(routeId),
    decision: "allow",
  });
});

function emptyAppInventory(observedAt = new Date().toISOString()) {
  return { items: [], observedAt, issues: [] };
}

const npmIntegrityFixture = `sha512-${Buffer.from("task-handoff-node-agent-integrity").toString("base64")}`;

function testInstanceImage(reference = "task-handoff-web:local", id = "img_1", name = "Image") {
  const timestamp = new Date().toISOString();
  const at = reference.indexOf("@");
  const digest = at >= 0 ? reference.slice(at + 1) : undefined;
  const base = at >= 0 ? reference.slice(0, at) : reference;
  const slash = base.lastIndexOf("/");
  const colon = base.lastIndexOf(":");
  const tag = colon > slash ? base.slice(colon + 1) : undefined;
  const repository = tag ? base.slice(0, colon) : base;
  return {
    id,
    origin: "custom",
    name,
    repository,
    ...(tag ? { tag } : {}),
    requestedReference: reference,
    ...(digest ? { resolvedDigest: digest } : {}),
    pullPolicy: "if-not-present",
    capabilities: [],
    optionalApps: [],
    defaultEnv: {},
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test("runtime lifecycle result preserves a newer registration heartbeat", () => {
  const baseline = ControlledInstanceSchema.parse({
    id: "inst_start_race",
    name: "start race",
    source: { type: "local-folder", path: "/workspace" },
    sourceSnapshot: {},
    modelSelection: {},
    nodeId: "node_1",
    runtimeId: "runtime_1",
    status: "starting",
    health: "unknown",
    connectionStatus: "offline",
    agentStatus: "offline",
    targetStatus: "unknown",
    uiAccessStatus: "unknown",
    controlMode: "controlled",
    ready: false,
    capabilities: {},
    config: {},
    workspace: { status: "pending" },
    target: { strategy: "node-proxy", status: "unknown" },
    apps: { runningCount: 0, problemCount: 0 },
    aiSessions: { runningCount: 0, waitingCount: 0, sessions: [], updatedAt: "2026-07-28T00:00:00.000Z" },
    runtime: { kind: "docker", containerId: "container_1", labels: {} },
    stateRevision: 4,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  });
  const running = ControlledInstanceSchema.parse({
    ...baseline,
    status: "running",
    health: "ok",
    connectionStatus: "online",
    agentStatus: "online",
    targetStatus: "reachable",
    uiAccessStatus: "reachable",
    ready: true,
    target: { ...baseline.target, status: "reachable", web: "http://instance:8080" },
    workspace: { status: "ready", path: "/workspace" },
    stateRevision: 6,
    lastHeartbeatAt: "2026-07-28T00:00:01.000Z",
  });

  const merged = mergeRuntimeLifecycleResult(baseline, running, {
    status: "registering",
    health: "unknown",
    connectionStatus: "online",
    agentStatus: "unknown",
    targetStatus: "reachable",
    uiAccessStatus: "unknown",
    target: { strategy: "direct-port", status: "reachable", web: "http://127.0.0.1:32000" },
    workspace: { status: "pending" },
    runtime: { containerName: "task-handoff-inst_start_race", containerId: "container_1" },
  });

  assert.equal(merged.status, "running");
  assert.equal(merged.health, "ok");
  assert.equal(merged.agentStatus, "online");
  assert.equal(merged.ready, true);
  assert.equal(merged.target.web, "http://instance:8080");
  assert.equal(merged.workspace.status, "ready");
  assert.equal(merged.runtime.containerName, "task-handoff-inst_start_race");
});

function resolvedRuntimeArtifact(version, platform, arch) {
  return {
    archivePath: "/cache/controlled-instance-runtime.tar.gz",
    cacheHit: true,
    identity: {
      packageName: "@task-handoff/controlled-instance",
      version,
      platform,
      arch,
      formatVersion: 1,
      launcherAbi: 1,
      entrypoint: "dist/controlled-instance-cli.js",
      sha256: "a".repeat(64),
    },
  };
}

function managedDockerRuntimeCommand(app, instanceId, web, args) {
  const desiredVersion = runtimeVersionStateForActual().desiredVersion;
  if (args[0] === "inspect" && args.includes("{{json .}}")) return {
    stdout: JSON.stringify({
      Id: "container-1",
      Platform: "linux",
      Image: "sha256:image",
      Config: { Labels: { "task-handoff.instance-id": instanceId } },
    }),
    stderr: "",
  };
  if (args[0] === "image" && args[1] === "inspect") return { stdout: JSON.stringify({ Os: "linux", Architecture: "amd64" }), stderr: "" };
  if (args[0] === "inspect") return { stdout: "container-1", stderr: "" };
  if (args[0] === "exec" && args.includes("verify-active")) {
    return { stdout: JSON.stringify(resolvedRuntimeArtifact(desiredVersion, "linux", "x64").identity), stderr: "" };
  }
  if (args[0] === "restart" && app) {
    const instance = app.nodeAgentState.controlledInstances.get(instanceId);
    setImmediate(() => app.nodeAgentState.registerInstance(instanceId, {
      instanceId,
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      appInventory: emptyAppInventory(),
      controlMode: "controlled",
      capabilities: {},
      build: { component: "controlled-instance", packageVersion: desiredVersion },
      target: { strategy: "direct-port", status: "reachable", web },
      workspace: { status: "ready" },
    }, instance.registrationToken));
  }
  return undefined;
}

function testAppInventory(apps, observedAt = new Date().toISOString()) {
  return {
    observedAt,
    issues: [],
    items: apps.map((app) => ({
      id: app.id,
      name: app.name,
      kind: app.kind || "tty",
      source: "builtin",
      availability: app.availability || "available",
      capabilities: { supportsCwdSelection: ["terminal-tty", "codex", "claude"].includes(app.id) },
    })),
  };
}

test("controlled instance heartbeat protocol rejects legacy receiver projection", () => {
  assert.equal(CONTROL_PLANE_PROTOCOL_VERSION, "2026-08-01");
  assert.equal(ControlledInstanceHeartbeatSchema.safeParse({ protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION, receiver: { status: "running", pendingCount: 1 } }).success, false);
  assert.equal(ControlledInstanceHeartbeatSchema.safeParse({ protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION, apps: { runningCount: 1 } }).success, false);
  assert.equal(ControlledInstanceHeartbeatSchema.safeParse({ protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION, appInventory: emptyAppInventory(), apps: { runningCount: 1 } }).success, true);
  assert.equal(ControlledInstanceRegisterSchema.safeParse({
    name: "runtime-owned-name",
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    appInventory: emptyAppInventory(),
  }).success, false);
  assert.equal(ControlledInstanceRegisterSchema.safeParse({
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    appInventory: emptyAppInventory(),
    imageId: "img_legacy",
  }).success, false);
});

test("managed runtime convergence protocol is strict and Node-scoped", () => {
  const sha256 = "a".repeat(64);
  const artifact = {
    packageName: "@task-handoff/controlled-instance",
    version: "1.2.3",
    platform: "linux",
    arch: "x64",
    formatVersion: 1,
    launcherAbi: 1,
    entrypoint: "dist/controlled-instance.js",
    sha256,
  };
  assert.equal(RuntimeArtifactIdentitySchema.safeParse(artifact).success, true);
  assert.equal(RuntimeArtifactIdentitySchema.safeParse({ ...artifact, registryToken: "secret" }).success, false);
  assert.equal(RuntimeArtifactIdentitySchema.safeParse({ ...artifact, sha256: `sha256:${sha256}` }).success, false);
  const apply = { channel: "stable", targetVersion: "1.2.3", preflightToken: "preflight_1234567890" };
  assert.equal(ApplyUpdateRequestSchema.safeParse(apply).success, true);
  assert.equal(ApplyUpdateRequestSchema.safeParse({ channel: "stable" }).success, false);
  assert.equal(ApplyUpdateRequestSchema.safeParse({ ...apply, target: { component: "controlled-instance", instanceId: "inst_old" } }).success, false);

  const versionState = {
    desiredVersion: "1.2.3",
    actualVersion: "1.2.2",
    phase: "pending",
    attempt: 0,
    error: {
      code: "INSTANCE_RUNTIME_VERSION_MISMATCH",
      message: "Expected 1.2.3, received 1.2.2.",
      expectedVersion: "1.2.3",
      actualVersion: "1.2.2",
      retryable: true,
    },
  };
  assert.equal(RuntimeVersionStateSchema.safeParse(versionState).success, true);
  assert.equal(RuntimeVersionStateSchema.safeParse({ ...versionState, displayStatus: "warning" }).success, false);
  assert.deepEqual(UpdateCheckRequestSchema.parse({}), { channel: "stable" });
  assert.equal(UpdateCheckRequestSchema.safeParse({ target: { component: "controlled-instance", instanceId: "inst_1" } }).success, false);
});

test("stored legacy instance update jobs are retained as retired failures", () => {
  const timestamp = new Date().toISOString();
  const migrated = sanitizeStoredUpdateJob({
    id: "update_legacy",
    nodeId: "node_1",
    target: { component: "controlled-instance", instanceId: "inst_1" },
    source: "docker-registry",
    channel: "stable",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    status: "updating",
    error: "old error",
    createdAt: timestamp,
    updatedAt: timestamp,
    futureField: true,
  });
  const parsed = UpdateJobSchema.strip().parse(migrated);
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.error.code, "LEGACY_INSTANCE_UPDATE_RETIRED");
  assert.equal(parsed.rollout.phase, "failed");
  assert.equal(parsed.source, "npm");
  assert.equal("target" in migrated, false);
});

test("stored update jobs sanitize nested future fields without dropping the job", () => {
  const timestamp = new Date().toISOString();
  const sanitized = sanitizeStoredUpdateJob({
    id: "update_future",
    nodeId: "node_1",
    source: "npm",
    channel: "stable",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    status: "converging-instances",
    impact: {
      runningInstanceCount: 0,
      stoppedInstanceCount: 0,
      activeInstanceCount: 0,
      restartInstanceCount: 0,
      runningInstanceIds: [],
      stoppedInstanceIds: [],
      activeInstanceIds: [],
      futureImpactField: true,
    },
    runtimeArtifacts: [{
      packageName: "@task-handoff/controlled-instance",
      version: "1.1.0",
      platform: "linux",
      arch: "x64",
      formatVersion: 1,
      launcherAbi: 1,
      entrypoint: "dist/controlled-instance.js",
      sha256: "a".repeat(64),
      futureArtifactField: true,
    }],
    rollout: {
      phase: "converging-instances",
      desiredVersion: "1.1.0",
      expectedInstanceIds: [],
      expectedInstanceCount: 0,
      matchedInstanceCount: 0,
      pendingInstanceCount: 0,
      failedInstanceCount: 0,
      futureRolloutField: true,
    },
    error: { code: "FUTURE_UPDATE_ERROR", message: "future failure", retryable: true, futureErrorField: true },
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  const parsed = UpdateJobSchema.parse(sanitized);
  assert.equal(parsed.id, "update_future");
  assert.equal(parsed.runtimeArtifacts.length, 1);
  assert.equal(parsed.error.code, "NODE_UPDATE_FAILED");
  assert.equal(parsed.error.message, "future failure");
  assert.equal("futureRolloutField" in parsed.rollout, false);
});

test("app inventory protocol is strict and stored legacy app capability is discarded", () => {
  const observedAt = new Date().toISOString();
  const inventory = {
    observedAt,
    items: [{
      id: "codex",
      name: "Codex",
      kind: "tty",
      source: "builtin",
      availability: "available",
      capabilities: { supportsCwdSelection: true },
    }],
    issues: [],
  };
  assert.equal(InstanceAppInventorySchema.safeParse(inventory).success, true);
  assert.equal(InstanceAppInventorySchema.safeParse({ ...inventory, env: { SECRET: "nope" } }).success, false);
  assert.equal(InstanceAppInventorySchema.safeParse({ ...inventory, items: [{ ...inventory.items[0], command: "codex" }] }).success, false);
  assert.equal(InstanceAppInventorySchema.safeParse(emptyAppInventory(observedAt)).success, true);

  const warnings = [];
  const timestamp = new Date().toISOString();
  const parsed = parseStoredControlledInstance({
    id: "inst_legacy_apps",
    name: "Legacy",
    source: { type: "local-folder", path: "/tmp/workspace" },
    sourceSnapshot: {},
    modelSelection: {},
    nodeId: "node_1",
    runtimeId: "runtime_1",
    status: "running",
    capabilities: { apps: [{ id: "codex" }], features: { tty: true } },
    config: { autoImportAgentConfigs: true },
    workspace: { status: "ready" },
    target: { strategy: "node-proxy", status: "unknown" },
    access: { strategy: "control-plane-proxy", status: "unknown" },
    apps: { runningCount: 0, problemCount: 0 },
    runtime: { labels: {} },
    createdAt: timestamp,
    updatedAt: timestamp,
  }, (warning) => warnings.push(warning));
  assert.equal(parsed.appInventory, undefined);
  assert.deepEqual(parsed.capabilities, { features: { tty: true } });
  assert.deepEqual(warnings, [{ instanceId: "inst_legacy_apps", field: "capabilities.apps" }]);
});

test("UI and chat launchers consume only the current authoritative app inventory", () => {
  const instance = {
    id: "inst_inventory",
    name: "Inventory",
    connectionStatus: "online",
    capabilities: { apps: [{ id: "legacy-app", name: "Legacy" }] },
    image: { optionalApps: ["image-app"] },
    sourceSnapshot: { apps: [{ id: "snapshot-app", name: "Snapshot" }] },
    appInventory: testAppInventory([
      { id: "codex", name: "Codex" },
      { id: "missing-app", name: "Missing App", availability: "missing-dependency" },
    ]),
  };
  assert.deepEqual(uiLaunchableAppsForInstance(instance), [{ id: "codex", label: "Codex", supportsCwdSelection: true }]);
  assert.deepEqual(chatLaunchableAppsForInstance(instance), [{ id: "codex", label: "Codex" }]);
  assert.deepEqual(uiLaunchableAppsForInstance({ ...instance, connectionStatus: "offline" }), []);
  assert.deepEqual(chatLaunchableAppsForInstance({ ...instance, connectionStatus: "offline" }), []);
  assert.deepEqual(uiLaunchableAppsForInstance({ ...instance, appInventory: undefined }), []);
  assert.deepEqual(chatLaunchableAppsForInstance({ ...instance, appInventory: undefined }), []);
});

function tempDataDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `task-handoff-${name}-`));
}

async function json(app, method, url, payload, headers) {
  const response = await app.inject({
    method,
    url,
    payload,
    headers,
  });
  return {
    statusCode: response.statusCode,
    body: response.json(),
  };
}

async function createAndAssignNodeModel(app, instanceId, overrides = {}) {
  const model = {
    name: overrides.name || "Test Codex model",
    endpoint: overrides.endpoint || "https://openai.example/v1",
    key: overrides.key || "test-codex-key",
    model: overrides.model || "gpt-test",
    app: "codex",
    enabled: true,
    order: 100,
    labels: {},
  };
  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/models",
    headers: { authorization: "Bearer agent-secret" },
    payload: model,
  });
  assert.equal(created.statusCode, 201);
  const modelHash = created.json().data.id;
  const assigned = await app.inject({
    method: "PUT",
    url: `/api/node-agent/instances/${instanceId}/model-assignment`,
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      modelSelection: { codexModelHash: modelHash },
      codexModelHash: modelHash,
    },
  });
  assert.equal(assigned.statusCode, 200);
  return created.json().data;
}

function onceWebSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (message) => {
      try {
        resolve(JSON.parse(String(message)));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

function waitTelegramAggregate() {
  return new Promise((resolve) => setTimeout(resolve, 1050));
}

function onceRawWebSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (message) => resolve(String(message)));
    socket.once("error", reject);
  });
}

function onceWebSocketMessageFrame(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (message, isBinary) => resolve({ message: String(message), isBinary }));
    socket.once("error", reject);
  });
}

function waitForWebSocketOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function withTimeout(promise, label, timeoutMs = 2000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let aiSessionTestRevision = 0;
function aiSessionSnapshotPayload(snapshot, input = {}) {
  const timestamp = input.generatedAt || new Date().toISOString();
  return {
    meta: {
      instanceId: input.instanceId || "inst_1",
      nodeId: input.nodeId,
      streamId: input.streamId || "ai_test_stream",
      revision: input.revision ?? ++aiSessionTestRevision,
      previousRevision: input.previousRevision,
      traceId: input.traceId || `test_ai_evt_${aiSessionTestRevision}`,
      generatedAt: timestamp,
      reason: input.reason || "provider-event",
    },
    snapshot: {
      runningCount: snapshot.runningCount ?? 0,
      waitingCount: snapshot.waitingCount ?? 0,
      staleCount: snapshot.staleCount ?? 0,
      sessions: snapshot.sessions || [],
      updatedAt: snapshot.updatedAt || timestamp,
    },
  };
}

function publishAiSessionSnapshotForTest(events, snapshot, options = {}) {
  const instanceId = options.scope?.instanceId || options.instanceId || "inst_1";
  events.publish(AiSessionEventType.Snapshot, aiSessionSnapshotPayload(snapshot, { ...options, instanceId }), options.scope ? { scope: options.scope } : undefined);
}

function aiSessionGatewayOptions(events, options = {}) {
  const aiSessions = new ControlPlaneAiSessionAggregator({ bootstrap: async () => ({ instances: [] }) });
  events.on((event) => aiSessions.handleEvent(event));
  return { ...options, aiSessions };
}

let appSessionTestRevision = 0;
function appSessionSnapshotPayload(snapshot, input = {}) {
  const timestamp = input.generatedAt || new Date().toISOString();
  const sessions = snapshot.sessions || [];
  return {
    meta: {
      instanceId: input.instanceId || "inst_1",
      nodeId: input.nodeId,
      streamId: input.streamId || "app_test_stream",
      revision: input.revision ?? ++appSessionTestRevision,
      previousRevision: input.previousRevision,
      traceId: input.traceId || `test_app_evt_${appSessionTestRevision}`,
      generatedAt: timestamp,
      reason: input.reason || "app-session-updated",
    },
    snapshot: {
      runningCount: snapshot.runningCount ?? sessions.filter((session) => session.status === "running").length,
      problemCount: snapshot.problemCount ?? sessions.filter((session) => session.status === "failed").length,
      sessions,
      updatedAt: snapshot.updatedAt || timestamp,
    },
  };
}

function publishAppSessionSnapshotForTest(events, snapshot, options = {}) {
  const instanceId = options.scope?.instanceId || options.instanceId || "inst_1";
  events.publish(AppSessionEventType.Snapshot, appSessionSnapshotPayload(snapshot, { ...options, instanceId }), options.scope ? { scope: options.scope } : undefined);
}

test("session aggregators never let an older bootstrap overwrite realtime state", async () => {
  const timestamp = new Date().toISOString();
  const appAggregator = new ControlPlaneAppSessionAggregator({
    bootstrap: async () => ({
      instances: [{
        instanceId: "inst_revision",
        streamId: "app_revision_stream",
        revision: 1,
        lastEventAt: timestamp,
        appSessions: appSessionSnapshotPayload({ sessions: [{ id: "old", status: "running" }] }, { generatedAt: timestamp }).snapshot,
      }],
    }),
  });
  appAggregator.applySnapshot(appSessionSnapshotPayload(
    { sessions: [{ id: "current", status: "running" }] },
    { instanceId: "inst_revision", streamId: "app_revision_stream", revision: 2, previousRevision: 1, generatedAt: timestamp },
  ));

  const refreshed = await appAggregator.list({ refresh: true });
  assert.equal(refreshed.instances[0].revision, 2);
  assert.deepEqual(refreshed.instances[0].appSessions.sessions.map((session) => session.id), ["current"]);
});

test("controlled instance gateway preserves structured remote errors for every proxied route", async () => {
  const gateway = new ControlledInstanceGateway({
    requireNode: () => ({ id: "node_1" }),
    nodeAgentTransport: () => ({
      request: async () => new Response(JSON.stringify({
        error: {
          code: "APP_SESSION_NOT_FOUND",
          message: "App session not found.",
          details: { appSessionId: "app_missing" },
        },
      }), { status: 404, headers: { "content-type": "application/json" } }),
      requestStream: async () => new Response(),
      proxyWebSocket() {},
    }),
  });
  const instance = {
    id: "inst_1",
    name: "Instance 1",
    nodeId: "node_1",
    connectionStatus: "online",
    target: { web: "http://instance.test" },
  };

  await assert.rejects(
    () => gateway.request(instance, "/apps/sessions/app_missing"),
    (error) => {
      assert.equal(error.code, "APP_SESSION_NOT_FOUND");
      assert.equal(error.statusCode, 404);
      assert.equal(error.instanceId, "inst_1");
      assert.equal(error.nodeId, "node_1");
      assert.equal(error.route, "/apps/sessions/app_missing");
      assert.equal(error.message, "App session not found.");
      return true;
    },
  );
});

test("JSON collections isolate invalid records and strip unknown stored fields", () => {
  const directory = tempDataDir("schema-store");
  const warnings = [];
  const schema = z.object({
    id: z.string(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    name: z.string(),
  }).strict();
  const collection = new JsonCollection(directory, { schema, logger: (message, details) => warnings.push({ message, details }) });
  const timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(directory, "valid.json"), JSON.stringify({ id: "valid", name: "kept", createdAt: timestamp, updatedAt: timestamp, futureField: true }));
  fs.writeFileSync(path.join(directory, "broken.json"), "{not json");

  assert.deepEqual(collection.list(), [{ id: "valid", name: "kept", createdAt: timestamp, updatedAt: timestamp }]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0].message + warnings[1].message, /could not be read/);
  assert.match(warnings[0].message + warnings[1].message, /unknown stored fields were ignored/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, "valid.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(directory, "broken.json")).mode & 0o777, 0o600);

    const originalChmodSync = fs.chmodSync;
    const repeatedReadChmods = [];
    fs.chmodSync = (filePath, mode) => {
      repeatedReadChmods.push({ filePath, mode });
      return originalChmodSync(filePath, mode);
    };
    try {
      collection.get("valid");
      collection.list();
    } finally {
      fs.chmodSync = originalChmodSync;
    }
    assert.deepEqual(repeatedReadChmods, []);
  }
});

test("session aggregators apply patch and removed events as one revisioned stream", async () => {
  const timestamp = new Date().toISOString();
  const appAggregator = new ControlPlaneAppSessionAggregator({ bootstrap: async () => ({ instances: [] }) });
  appAggregator.applySnapshot(appSessionSnapshotPayload(
    { sessions: [{ id: "app_1", status: "running" }] },
    { instanceId: "inst_events", streamId: "app_events_stream", revision: 1, generatedAt: timestamp },
  ));
  assert.equal(appAggregator.applyPatch({
    meta: { instanceId: "inst_events", streamId: "app_events_stream", revision: 2, previousRevision: 1, traceId: "app_patch", generatedAt: timestamp, reason: "app-session-updated" },
    session: { id: "app_1", status: "failed" },
  }), true);
  assert.equal(appAggregator.applyRemoved({
    meta: { instanceId: "inst_events", streamId: "app_events_stream", revision: 3, previousRevision: 2, traceId: "app_removed", generatedAt: timestamp, reason: "app-session-deleted" },
    sessionId: "app_1",
  }), true);
  const appDelta = await appAggregator.delta({ instanceId: "inst_events", streamId: "app_events_stream", sinceRevision: 1 });
  assert.deepEqual(appDelta.events.map((event) => event.type), [AppSessionEventType.Patch, AppSessionEventType.Removed]);
  const appDeltaAtHead = await appAggregator.delta({ instanceId: "inst_events", streamId: "app_events_stream", sinceRevision: 3 });
  assert.equal(appDeltaAtHead.syncRequired, false);
  assert.deepEqual(appDeltaAtHead.events, []);
  const appDeltaPastHead = await appAggregator.delta({ instanceId: "inst_events", streamId: "app_events_stream", sinceRevision: 4 });
  assert.equal(appDeltaPastHead.syncRequired, true);
  assert.deepEqual(appDeltaPastHead.events, []);

  const aiAggregator = new ControlPlaneAiSessionAggregator({ bootstrap: async () => ({ instances: [] }) });
  const aiUpdates = [];
  aiAggregator.onSnapshot((update) => aiUpdates.push({
    revision: update.revision,
    sessionIds: update.aiSessions.sessions.map((session) => session.id),
    toolActivity: update.aiSessions.sessions[0]
      ? {
          currentTool: update.aiSessions.sessions[0].currentTool,
          toolCallsSinceLastMessage: update.aiSessions.sessions[0].toolCallsSinceLastMessage,
        }
      : undefined,
  }));
  aiAggregator.applySnapshot(aiSessionSnapshotPayload(
    { sessions: [] },
    { instanceId: "inst_events", streamId: "ai_events_stream", revision: 1, generatedAt: timestamp },
  ));
  assert.equal(aiAggregator.applyPatch({
    meta: { instanceId: "inst_events", streamId: "ai_events_stream", revision: 2, previousRevision: 1, traceId: "ai_patch", generatedAt: timestamp, reason: "provider-event" },
    upserted: [{
      id: "ai_1",
      agent: "codex",
      status: "running",
      phase: "tool",
      currentTool: { id: "tool_1", kind: "commandExecution", name: "Command", inputPreview: "pnpm test", startedAt: timestamp },
      toolCallsSinceLastMessage: 2,
      startedAt: timestamp,
      updatedAt: timestamp,
      queue: { pendingCount: 0, items: [] },
    }],
    removed: [],
  }), true);
  assert.equal(aiAggregator.applyRemoved({
    meta: { instanceId: "inst_events", streamId: "ai_events_stream", revision: 3, previousRevision: 2, traceId: "ai_removed", generatedAt: timestamp, reason: "provider-event" },
    sessionIds: ["ai_1"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), true);
  const aiDelta = await aiAggregator.delta({ instanceId: "inst_events", streamId: "ai_events_stream", sinceRevision: 1 });
  assert.deepEqual(aiDelta.events.map((event) => event.type), [AiSessionEventType.Patch, AiSessionEventType.Removed]);
  const aiDeltaAtHead = await aiAggregator.delta({ instanceId: "inst_events", streamId: "ai_events_stream", sinceRevision: 3 });
  assert.equal(aiDeltaAtHead.syncRequired, false);
  assert.deepEqual(aiDeltaAtHead.events, []);
  const aiDeltaPastHead = await aiAggregator.delta({ instanceId: "inst_events", streamId: "ai_events_stream", sinceRevision: 4 });
  assert.equal(aiDeltaPastHead.syncRequired, true);
  assert.deepEqual(aiDeltaPastHead.events, []);
  assert.deepEqual(aiUpdates, [
    { revision: 1, sessionIds: [], toolActivity: undefined },
    {
      revision: 2,
      sessionIds: ["ai_1"],
      toolActivity: {
        currentTool: { id: "tool_1", kind: "commandExecution", name: "Command", inputPreview: "pnpm test", startedAt: timestamp },
        toolCallsSinceLastMessage: 2,
      },
    },
    { revision: 3, sessionIds: [], toolActivity: undefined },
  ]);

  const normalizedAppSession = normalizeAppSessionRecord({
    id: "legacy_workspace",
    status: "RUNNING",
    workspace: {
      path: "/legacy/path",
      extra: true,
    },
    tty: {
      cwd: "/workspace/current",
    },
  });
  assert.equal(normalizedAppSession.status, "running");
  assert.deepEqual(normalizedAppSession.workspace, { cwd: "/workspace/current" });
  assert.equal(appSessionStatus({ status: "future-state" }), "unknown");
});

test("AI session aggregator recovers advertised gaps from instance deltas and rejects obsolete bootstrap streams", async () => {
  const timestamp = new Date().toISOString();
  let bootstrapStreamId = "ai_obsolete_stream";
  const recovered = [];
  const aggregator = new ControlPlaneAiSessionAggregator({
    bootstrap: async () => ({
      instances: [{
        instanceId: "inst_recovery",
        streamId: bootstrapStreamId,
        revision: 0,
        lastEventAt: timestamp,
        aiSessions: aiSessionSnapshotPayload({ sessions: [] }, { generatedAt: timestamp }).snapshot,
      }],
    }),
    recoverDelta: async (instanceId, streamId, sinceRevision) => ({
      instanceId,
      streamId,
      sinceRevision,
      latestRevision: 3,
      earliestRetainedRevision: 2,
      syncRequired: false,
      events: [2, 3].filter((revision) => revision > sinceRevision).map((revision) => ({
        type: AiSessionEventType.Patch,
        payload: {
          meta: { instanceId, streamId, revision, previousRevision: revision - 1, traceId: `recover_${revision}`, generatedAt: timestamp, reason: "provider-event" },
          upserted: [{ id: `ai_${revision}`, agent: "codex", status: "idle", phase: "unknown", startedAt: timestamp, updatedAt: timestamp, queue: { pendingCount: 0, items: [] } }],
          removed: [],
        },
      })),
    }),
    recoverSnapshot: async () => { throw new Error("snapshot fallback should not be used"); },
    onRecoveredEvent: (event) => recovered.push(event.payload.meta.revision),
  });
  aggregator.applySnapshot(aiSessionSnapshotPayload({ sessions: [] }, { instanceId: "inst_recovery", streamId: "ai_current_stream", revision: 1, generatedAt: timestamp }));
  await aggregator.advertiseStream("inst_recovery", { topic: "ai.sessions", instanceId: "inst_recovery", streamId: "ai_current_stream", latestRevision: 3, earliestRetainedRevision: 2 });
  assert.deepEqual(recovered, [2, 3]);
  assert.equal((await aggregator.list()).instances[0].revision, 3);
  assert.equal(aggregator.diagnostics().deltaRecoveries, 1);

  await aggregator.list({ refresh: true });
  assert.equal((await aggregator.list()).instances[0].streamId, "ai_current_stream");
  bootstrapStreamId = "ai_current_stream";
});

test("AI session aggregator validates message deltas without copying snapshots or notifying snapshot listeners", async () => {
  const timestamp = new Date().toISOString();
  const aggregator = new ControlPlaneAiSessionAggregator({ bootstrap: async () => ({ instances: [] }) });
  const snapshot = aiSessionSnapshotPayload({
    sessions: [{
      id: "session_delta",
      agent: "codex",
      providerSessionId: "thread_delta",
      activeTurnId: "turn_delta",
      status: "running",
      phase: "thinking",
      startedAt: timestamp,
      updatedAt: timestamp,
      turns: [{ id: "turn_delta", providerTurnId: "turn_delta", status: "running", revision: 1 }],
      queue: { pendingCount: 0, items: [] },
    }],
  }, { instanceId: "inst_delta", streamId: "stream_delta", revision: 7, generatedAt: timestamp });
  aggregator.applySnapshot(snapshot);
  const storedBeforeDelta = (await aggregator.list()).instances[0];
  const updates = [];
  aggregator.onSnapshot((update) => updates.push(update));
  aggregator.handleEvent({
    v: 1,
    id: "event_delta",
    seq: 1,
    type: AiSessionEventType.MessageDelta,
    topic: "ai.sessions",
    createdAt: timestamp,
    payload: {
      instanceId: "inst_delta",
      sessionId: "session_delta",
      providerSessionId: "thread_delta",
      turnId: "turn_delta",
      itemId: "item_delta",
      delta: "hello",
      generatedAt: timestamp,
    },
  });

  assert.deepEqual(updates, []);
  const stored = (await aggregator.list()).instances[0];
  assert.equal(stored.revision, 7);
  assert.strictEqual(stored.aiSessions, storedBeforeDelta.aiSessions);
  assert.strictEqual(stored.aiSessions.sessions[0], storedBeforeDelta.aiSessions.sessions[0]);
  assert.equal(stored.aiSessions.sessions[0].lastMessage, undefined);
});

test("app session aggregator clears retained history when a new stream snapshot is accepted", async () => {
  const timestamp = new Date().toISOString();
  const aggregator = new ControlPlaneAppSessionAggregator({ bootstrap: async () => ({ instances: [] }) });
  aggregator.applySnapshot(appSessionSnapshotPayload({ sessions: [] }, { instanceId: "inst_epoch", streamId: "app_old_stream", revision: 1, generatedAt: timestamp }));
  aggregator.applySnapshot(appSessionSnapshotPayload({ sessions: [] }, { instanceId: "inst_epoch", streamId: "app_new_stream", revision: 1, generatedAt: timestamp }));
  assert.equal(aggregator.diagnostics().streamResets, 1);
  const delta = await aggregator.delta({ instanceId: "inst_epoch", streamId: "app_new_stream", sinceRevision: 0 });
  assert.equal(delta.events.length, 1);
  assert.equal(delta.events[0].payload.meta.streamId, "app_new_stream");
});

test("control-plane aggregator restart bootstraps the authoritative stream and ignores duplicate delivery", async () => {
  const timestamp = new Date().toISOString();
  const snapshot = aiSessionSnapshotPayload({ sessions: [] }, { instanceId: "inst_restart", streamId: "ai_restart_stream", revision: 5, generatedAt: timestamp });
  const aggregator = new ControlPlaneAiSessionAggregator({
    bootstrap: async () => ({
      instances: [{ instanceId: "inst_restart", streamId: "ai_restart_stream", revision: 5, lastEventAt: timestamp, aiSessions: snapshot.snapshot }],
    }),
  });
  const restarted = await aggregator.list();
  assert.equal(restarted.instances[0].streamId, "ai_restart_stream");
  assert.equal(restarted.instances[0].revision, 5);
  assert.equal(aggregator.applySnapshot(snapshot), false);
  assert.equal((await aggregator.list()).instances[0].revision, 5);
});

test("session aggregator is the public event boundary for obsolete forwarded streams", async () => {
  const timestamp = new Date().toISOString();
  const events = new ControlPlaneEventBus();
  const published = [];
  events.connect({
    readyState: 1,
    OPEN: 1,
    send: (value) => published.push(JSON.parse(String(value))),
    on: () => undefined,
  });
  const aggregator = new ControlPlaneAiSessionAggregator({ bootstrap: async () => ({ instances: [] }) });
  await aggregator.advertiseStream("inst_boundary", {
    topic: "ai.sessions",
    instanceId: "inst_boundary",
    streamId: "new-stream",
    latestRevision: 7,
    earliestRetainedRevision: 1,
  });
  aggregator.applySnapshot(aiSessionSnapshotPayload(
    { sessions: [] },
    { instanceId: "inst_boundary", streamId: "new-stream", revision: 7, generatedAt: timestamp },
  ));
  const transport = new ControlPlaneNodeAgentTunnelTransport(events, {
    validateInstanceScope: () => true,
    onSessionEvent: (event) => aggregator.handleEvent(event),
  });

  transport.handleMessage("node_boundary", {
    type: "node-agent.event.forwarded",
    event: {
      type: AiSessionEventType.Snapshot,
      topic: "ai.sessions",
      scope: { instanceId: "inst_boundary" },
      payload: aiSessionSnapshotPayload(
        { sessions: [{ id: "obsolete", agent: "codex", status: "idle", phase: "unknown", startedAt: timestamp, updatedAt: timestamp, queue: { pendingCount: 0, items: [] } }] },
        { instanceId: "inst_boundary", streamId: "old-stream", revision: 2, generatedAt: timestamp },
      ),
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(published.length, 0);
  const current = (await aggregator.list()).instances[0];
  assert.equal(current.streamId, "new-stream");
  assert.equal(current.revision, 7);
});

test("AI session aggregator ignores obsolete epoch events during active recovery", async () => {
  const timestamp = new Date().toISOString();
  let releaseDelta;
  const deltaReady = new Promise((resolve) => { releaseDelta = resolve; });
  let deltaRequests = 0;
  const aggregator = new ControlPlaneAiSessionAggregator({
    bootstrap: async () => ({ instances: [] }),
    recoverDelta: async (instanceId, streamId, sinceRevision) => {
      deltaRequests += 1;
      await deltaReady;
      return {
        instanceId,
        streamId,
        sinceRevision,
        latestRevision: 2,
        earliestRetainedRevision: 2,
        syncRequired: false,
        events: [{
          type: AiSessionEventType.Patch,
          payload: {
            meta: { instanceId, streamId, revision: 2, previousRevision: 1, traceId: "current_2", generatedAt: timestamp, reason: "provider-event" },
            upserted: [],
            removed: [],
          },
        }],
      };
    },
    recoverSnapshot: async () => { throw new Error("snapshot fallback should not be used"); },
  });
  aggregator.applySnapshot(aiSessionSnapshotPayload({ sessions: [] }, { instanceId: "inst_epoch_delay", streamId: "ai_current", revision: 1, generatedAt: timestamp }));
  const recovery = aggregator.advertiseStream("inst_epoch_delay", { topic: "ai.sessions", instanceId: "inst_epoch_delay", streamId: "ai_current", latestRevision: 2, earliestRetainedRevision: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  aggregator.applyPatch({
    meta: { instanceId: "inst_epoch_delay", streamId: "ai_obsolete", revision: 50, previousRevision: 49, traceId: "obsolete_50", generatedAt: timestamp, reason: "provider-event" },
    upserted: [],
    removed: [],
  });
  releaseDelta();
  await recovery;

  assert.equal(deltaRequests, 1);
  const current = (await aggregator.list()).instances[0];
  assert.equal(current.streamId, "ai_current");
  assert.equal(current.revision, 2);
});

test("session aggregators remove projections and descriptors for deleted instances", async () => {
  const timestamp = new Date().toISOString();
  const ai = new ControlPlaneAiSessionAggregator({ bootstrap: async () => ({ instances: [] }) });
  const apps = new ControlPlaneAppSessionAggregator({ bootstrap: async () => ({ instances: [] }) });
  ai.applySnapshot(aiSessionSnapshotPayload({ sessions: [] }, { instanceId: "inst_deleted", streamId: "ai_deleted", revision: 1, generatedAt: timestamp }));
  apps.applySnapshot(appSessionSnapshotPayload({ sessions: [] }, { instanceId: "inst_deleted", streamId: "app_deleted", revision: 1, generatedAt: timestamp }));
  ai.removeInstance("inst_deleted");
  apps.removeInstance("inst_deleted");

  assert.deepEqual((await ai.list()).instances, []);
  assert.deepEqual((await apps.list()).instances, []);
  assert.deepEqual(await ai.streamDescriptors(), []);
  assert.deepEqual(await apps.streamDescriptors(), []);
});

async function waitForProcessExit(pid, label, timeoutMs = 3000) {
  await withTimeout(
    (async () => {
      for (;;) {
        try {
          process.kill(pid, 0);
        } catch {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })(),
    label,
    timeoutMs,
  );
}

async function waitForCondition(check, label, timeoutMs = 2000) {
  const startedAt = Date.now();
  for (;;) {
    const result = await check();
    if (result) {
      return result;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function freePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

test("local IPC can rebind the node agent TCP listener without changing the socket", async (t) => {
  const dataDir = tempDataDir("external-listener");
  const paths = nodeAgentStorePaths(dataDir);
  const firstPort = await freePort();
  const secondPort = await freePort();
  const ipcPath = path.join(dataDir, "node-agent.sock");
  const app = await createNodeAgentApp({ dataDir, logger: false, connectionMode: "local-ipc", port: firstPort });
  const settings = new JsonFile(paths.settingsPath, () => ({ version: 1, externalListener: { bindScope: "loopback", port: firstPort } }));
  const manager = new NodeAgentExternalListenerManager({
    app,
    state: app.nodeAgentState,
    settings,
    config: { bindScope: "loopback", port: firstPort },
    source: "bootstrap",
  });
  app.decorate("nodeAgentListenerManager", manager);
  await app.ready();
  const ipcServer = await listenNodeAgentIpcServer(app, ipcPath);
  await manager.start();
  t.after(async () => {
    await manager.shutdown();
    await new Promise((resolve) => ipcServer.close(resolve));
    await app.close();
  });

  const initial = await fetchNodeAgentIpc(ipcPath, "/settings/external-listener");
  assert.equal(initial.status, 200);
  assert.deepEqual((await initial.json()).data, {
    bindScope: "loopback",
    host: "127.0.0.1",
    port: firstPort,
    status: "listening",
    source: "bootstrap",
  });

  const updated = await fetchNodeAgentIpc(ipcPath, "/settings/external-listener", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bindScope: "loopback", port: secondPort }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).data.port, secondPort);
  assert.equal((await fetch(`http://127.0.0.1:${secondPort}/api/node-agent/health`)).status, 200);
  await assert.rejects(() => fetch(`http://127.0.0.1:${firstPort}/api/node-agent/health`));

  const remoteSettings = await fetch(`http://127.0.0.1:${secondPort}/api/node-agent/settings/external-listener`);
  assert.equal(remoteSettings.status, 403);
  assert.equal((await remoteSettings.json()).error.code, "NODE_AGENT_LISTENER_LOCAL_IPC_ONLY");
  assert.equal(JSON.parse(fs.readFileSync(paths.settingsPath, "utf8")).externalListener.port, secondPort);

  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => occupied.close());
  const occupiedAddress = occupied.address();
  assert.equal(typeof occupiedAddress, "object");
  const rejected = await fetchNodeAgentIpc(ipcPath, "/settings/external-listener", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bindScope: "loopback", port: occupiedAddress.port }),
  });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error.code, "NODE_AGENT_LISTENER_BIND_FAILED");
  assert.equal((await fetchNodeAgentIpc(ipcPath, "/settings/external-listener")).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${secondPort}/api/node-agent/health`)).status, 200);

  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    payload: {
      id: "inst_listener_blocker",
      name: "listener blocker",
      runtimeId: "runtime_local_host",
      source: { type: "local-folder", path: "/tmp/listener-blocker" },
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  app.nodeAgentState.controlledInstances.put({ ...created.json().data, status: "running" });
  const blockedPort = await freePort();
  const blocked = await fetchNodeAgentIpc(ipcPath, "/settings/external-listener", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bindScope: "loopback", port: blockedPort }),
  });
  assert.equal(blocked.status, 409);
  assert.deepEqual((await blocked.json()).error, {
    code: "NODE_AGENT_LISTENER_PORT_IN_USE_BY_INSTANCES",
    message: "Cannot change the node agent port while 1 controlled instance(s) are running.",
    blockingInstanceCount: 1,
  });
});

function createMockNodeAgentFetch(options = {}) {
  const timestamp = new Date().toISOString();
  const nodeId = options.nodeId || "node_mock";
  const runtimes = options.runtimes || [
    {
      id: "runtime_local_docker",
      nodeId,
      name: "Local Docker",
      type: "docker",
      status: "unknown",
      accessStrategy: "direct-port",
      capabilities: {},
      labels: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  const folders = [...(options.localFolders || [])];
  const nodeModels = new Map((options.nodeModels || []).map((model) => [model.id, model]));
  const nodeModelKeys = new Map(Object.entries(options.nodeModelKeys || {}));
  const instances = new Map((options.instances || []).map((instance) => [instance.id, instance]));
  let externalListener = options.externalListener || { bindScope: "loopback", host: "127.0.0.1", port: 8091, status: "listening", source: "bootstrap" };
  const requests = [];
  const jsonResponse = (data, status = 200) =>
    new Response(JSON.stringify({ data }), {
      status,
      headers: { "content-type": "application/json" },
    });
  const errorResponse = (message, status = 404, code) =>
    new Response(JSON.stringify({ error: { ...(code ? { code } : {}), message } }), {
      status,
      headers: { "content-type": "application/json" },
    });

  async function fetchImpl(url, init = {}) {
    const parsedUrl = new URL(String(url));
    const path = parsedUrl.pathname.replace(/^\/api\/node-agent/, "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body, path });

    if (path === "/health") {
      return jsonResponse({ ok: true, role: "node-agent", nodeId, protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION, ...(options.health || {}) });
    }
    if (path === "/settings/external-listener" && (!init.method || init.method === "GET")) {
      return jsonResponse(externalListener);
    }
    if (path === "/settings/external-listener" && init.method === "PATCH") {
      externalListener = {
        ...body,
        host: body.bindScope === "all-ipv4" ? "0.0.0.0" : "127.0.0.1",
        status: "listening",
        source: "persisted",
      };
      return jsonResponse(externalListener);
    }
    if (path === "/runtimes" && (!init.method || init.method === "GET")) {
      return jsonResponse(runtimes);
    }
    if (path === "/runtimes" && init.method === "POST") {
      const runtime = {
        id: body.id || `runtime_${runtimes.length + 1}`,
        nodeId,
        name: body.name,
        type: body.type,
        status: body.status || "unknown",
        accessStrategy: body.accessStrategy || (body.type === "docker" ? "direct-port" : "node-proxy"),
        capabilities: body.type === "local"
          ? {
              requiresImage: false,
              supportsControlledInstanceApi: true,
              supportsContainerLifecycle: false,
              supportsAppSessions: true,
              supportsHostSessions: true,
              artifactKind: "none",
              isolation: "none",
              ...(body.capabilities || {}),
            }
          : body.capabilities || {},
        labels: body.labels || {},
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      runtimes.push(runtime);
      return jsonResponse(runtime, 201);
    }
    const runtimeUpdate = path.match(/^\/runtimes\/([^/]+)$/);
    if (runtimeUpdate && init.method === "PATCH") {
      const id = decodeURIComponent(runtimeUpdate[1]);
      const index = runtimes.findIndex((runtime) => runtime.id === id);
      if (index < 0) return errorResponse(`Runtime ${id} was not found.`);
      runtimes[index] = { ...runtimes[index], ...body, id, nodeId, updatedAt: timestamp };
      return jsonResponse(runtimes[index]);
    }
    if (runtimeUpdate && init.method === "DELETE") {
      const id = decodeURIComponent(runtimeUpdate[1]);
      const index = runtimes.findIndex((runtime) => runtime.id === id);
      if (index >= 0) runtimes.splice(index, 1);
      return jsonResponse({ deleted: index >= 0 });
    }
    const runtimeCheck = path.match(/^\/runtimes\/([^/]+)\/check$/);
    if (runtimeCheck && init.method === "POST") {
      const id = decodeURIComponent(runtimeCheck[1]);
      const index = runtimes.findIndex((runtime) => runtime.id === id);
      if (index < 0) return errorResponse(`Runtime ${id} was not found.`);
      runtimes[index] = {
        ...runtimes[index],
        status: "online",
        capabilities: {
          ...runtimes[index].capabilities,
          apps: {
            terminal: true,
            codex: { available: false },
            claude: { available: false },
          },
        },
        updatedAt: timestamp,
      };
      return jsonResponse(runtimes[index]);
    }
    if (path === "/docker/images") {
      if (options.dockerImagesError) throw options.dockerImagesError;
      return jsonResponse(options.dockerImages || []);
    }
    if (path === "/local-folders" && (!init.method || init.method === "GET")) {
      return jsonResponse(folders);
    }
    if (path === "/folders/tree") {
      return jsonResponse(options.folderTree || []);
    }
    if (path === "/local-folders" && init.method === "POST") {
      const folder = {
        id: body.id || `folder_${folders.length + 1}`,
        nodeId,
        name: body.name,
        path: body.path,
        defaultImageSelection: body.defaultImageSelection,
        labels: body.labels || {},
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      folders.push(folder);
      return jsonResponse(folder, 201);
    }
    if (path === "/models" && (!init.method || init.method === "GET")) {
      if (options.modelsError) throw options.modelsError;
      return jsonResponse([...nodeModels.values()]);
    }
    if (path === "/models" && init.method === "POST") {
      const id = modelConfigHash(body);
      const model = {
        ...body,
        id,
        enabled: body.enabled ?? true,
        order: body.order ?? (nodeModels.size + 1) * 100,
        labels: body.labels || {},
        createdAt: timestamp,
        updatedAt: timestamp,
        keyPreview: "set",
        keySet: true,
        referenceCount: 0,
      };
      delete model.key;
      nodeModels.set(id, model);
      nodeModelKeys.set(id, body.key);
      return jsonResponse(model, 201);
    }
    const modelDeploy = path.match(/^\/models\/([^/]+)\/deploy$/);
    if (modelDeploy && init.method === "PUT") {
      if (options.deployModelError) throw options.deployModelError;
      const id = decodeURIComponent(modelDeploy[1]);
      const model = {
        ...body,
        id,
        keyPreview: "set",
        keySet: true,
        referenceCount: nodeModels.get(id)?.referenceCount || 0,
      };
      delete model.key;
      nodeModels.set(id, model);
      nodeModelKeys.set(id, body.key);
      return jsonResponse(model);
    }
    const modelRoute = path.match(/^\/models\/([^/]+)$/);
    if (modelRoute && init.method === "PATCH") {
      const id = decodeURIComponent(modelRoute[1]);
      const current = nodeModels.get(id);
      if (!current) return errorResponse(`Model ${id} was not found.`, 404, "NODE_MODEL_NOT_FOUND");
      const candidate = { ...current, ...body, updatedAt: timestamp };
      const nextKey = body.key || nodeModelKeys.get(id) || "mock-private-key";
      const nextId = modelConfigHash({ ...candidate, key: nextKey });
      const model = { ...candidate, id: nextId };
      delete model.key;
      nodeModels.set(nextId, model);
      nodeModelKeys.set(nextId, nextKey);
      return jsonResponse(model);
    }
    if (modelRoute && init.method === "DELETE") {
      if (options.modelDeleteError) throw options.modelDeleteError;
      const id = decodeURIComponent(modelRoute[1]);
      const current = nodeModels.get(id);
      if (current?.referenceCount) return errorResponse(`Model ${id} is in use.`, 409, "NODE_MODEL_IN_USE");
      nodeModelKeys.delete(id);
      return jsonResponse({ deleted: nodeModels.delete(id) });
    }
    const folderDelete = path.match(/^\/local-folders\/([^/]+)$/);
    if (folderDelete && init.method === "DELETE") {
      const index = folders.findIndex((folder) => folder.id === decodeURIComponent(folderDelete[1]));
      if (index >= 0) folders.splice(index, 1);
      return jsonResponse({ deleted: index >= 0 });
    }
    if (path === "/instances" && (!init.method || init.method === "GET")) {
      if (options.instancesError) throw options.instancesError;
      return jsonResponse([...instances.values()]);
    }
    if (path === "/instances" && init.method === "POST") {
      const id = body.id || `inst_${instances.size + 1}`;
      const instance = {
        id,
        name: body.name || `instance-${id.replace(/^inst_?/, "").slice(0, 6)}`,
        projectId: body.projectId,
        source: body.source,
        sourceSnapshot: body.sourceSnapshot || {},
        modelSelection: body.modelSelection || {},
        nodeId,
        runtimeId: body.runtimeId,
        imageSelection: body.imageSelection,
        imageSnapshot: body.image,
        status: "created",
        health: "unknown",
        connectionStatus: "unknown",
        controlMode: "controlled",
        capabilities: {},
        config: body.config || { autoImportAgentConfigs: true },
        workspace: { status: "unknown" },
        target: { strategy: "node-proxy", status: "unknown" },
        apps: { runningCount: 0 },
        runtime: { labels: {} },
        registrationToken: `token_${id}`,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      instances.set(id, instance);
      return jsonResponse(instance, 201);
    }
    const instanceUpdate = path.match(/^\/instances\/([^/]+)$/);
    if (instanceUpdate && init.method === "PATCH") {
      const id = decodeURIComponent(instanceUpdate[1]);
      const current = instances.get(id);
      if (!current) return errorResponse(`Instance ${id} was not found.`);
      const { modelEnv: _modelEnv, ...instancePatch } = body;
      const updated = {
        ...current,
        ...instancePatch,
        ...(instancePatch.config ? { config: { ...current.config, ...instancePatch.config } } : {}),
        id,
        nodeId,
        updatedAt: timestamp,
      };
      instances.set(id, updated);
      return jsonResponse(updated);
    }
    const instanceModelAssignment = path.match(/^\/instances\/([^/]+)\/model-assignment$/);
    if (instanceModelAssignment && init.method === "PUT") {
      if (options.assignmentError) throw options.assignmentError;
      const id = decodeURIComponent(instanceModelAssignment[1]);
      const current = instances.get(id);
      if (!current) return errorResponse(`Instance ${id} was not found.`, 404, "NODE_INSTANCE_NOT_FOUND");
      const instance = { ...current, modelSelection: body.modelSelection, updatedAt: timestamp };
      instances.set(id, instance);
      for (const modelHash of [body.codexModelHash, body.claudeModelHash]) {
        if (modelHash && nodeModels.has(modelHash)) {
          const model = nodeModels.get(modelHash);
          nodeModels.set(modelHash, { ...model, referenceCount: model.referenceCount + 1 });
        }
      }
      return jsonResponse({
        assignment: { instanceId: id, codexModelHash: body.codexModelHash, claudeModelHash: body.claudeModelHash, updatedAt: timestamp },
        instance,
      });
    }
    const instanceMetrics = path.match(/^\/instances\/([^/]+)\/metrics$/);
    if (instanceMetrics && (!init.method || init.method === "GET")) {
      const id = decodeURIComponent(instanceMetrics[1]);
      const current = instances.get(id);
      if (!current) return errorResponse(`Instance ${id} was not found.`, 404, "NODE_INSTANCE_NOT_FOUND");
      return options.metrics
        ? options.metrics({ url, init, body, instance: current, requests, jsonResponse, errorResponse })
        : jsonResponse({
            instanceId: id,
            runtimeKind: "docker",
            state: "available",
            sampledAt: timestamp,
            cpu: { usagePercent: 1.25 },
            memory: { usageBytes: 134_217_728, limitBytes: 536_870_912, usagePercent: 25 },
          });
    }
    const proxyRaw = path.match(/^\/instances\/([^/]+)\/proxy\/raw$/);
    if (proxyRaw) {
      const id = decodeURIComponent(proxyRaw[1]);
      const current = instances.get(id);
      if (!current) return errorResponse(`Instance ${id} was not found.`);
      return options.proxy ? options.proxy({ url, init, body, instance: current, requests, jsonResponse, errorResponse }) : jsonResponse({ ok: true });
    }
    const proxyStream = path.match(/^\/instances\/([^/]+)\/proxy\/stream$/);
    if (proxyStream) {
      const id = decodeURIComponent(proxyStream[1]);
      const current = instances.get(id);
      if (!current) return errorResponse(`Instance ${id} was not found.`);
      if (!options.proxy) return new Response("", { status: 200 });
      const mocked = await options.proxy({ url, init, body, instance: current, requests, jsonResponse, errorResponse });
      const payload = await mocked.json();
      const data = payload.data || payload;
      return new Response(Buffer.from(data.bodyBase64 || "", "base64"), { status: data.status || mocked.status, headers: data.headers || {} });
    }
    const lifecycle = path.match(/^\/instances\/([^/]+)\/(start|stop|restart|delete|proxy|register|heartbeat)$/);
    if (lifecycle) {
      const id = decodeURIComponent(lifecycle[1]);
      const action = lifecycle[2];
      const current = instances.get(id);
      if (!current) return errorResponse(`Instance ${id} was not found.`);
      if ((action === "start" || action === "restart") && options.startError) {
        instances.set(id, {
          ...current,
          status: "failed",
          health: "failed",
          connectionStatus: "offline",
          workspace: { ...current.workspace, error: options.startError.message },
          updatedAt: timestamp,
        });
        return errorResponse(options.startError.message, options.startError.status || 503, options.startError.code || "NODE_INSTANCE_START_FAILED");
      }
      if (action === "delete") {
        instances.delete(id);
        return jsonResponse({ deleted: true });
      }
      if (action === "proxy") {
        return options.proxy ? options.proxy({ url, init, body, instance: current, requests, jsonResponse, errorResponse }) : jsonResponse({ ok: true });
      }
      if (action === "heartbeat" && options.heartbeat) {
        return options.heartbeat({ url, init, body, instance: current, requests, jsonResponse, errorResponse });
      }
      const desiredRuntimeVersion = runtimeVersionStateForActual().desiredVersion;
      const reportedRuntimeVersion = body?.build?.packageVersion || body?.instanceVersion || desiredRuntimeVersion;
      const updated = {
        ...current,
        ...(action === "start" || action === "restart"
          ? {
              status: "registering",
              connectionStatus: "online",
              target: { ...current.target, strategy: "direct-port", status: "reachable", web: `http://127.0.0.1/${id}`, api: `http://127.0.0.1/${id}/api` },
              workspace: { ...current.workspace, status: "pending", path: "/workspace" },
              runtime: { ...current.runtime, kind: "docker", containerName: `task-handoff-${id}`, containerId: `container-${id}` },
            }
          : {}),
        ...(action === "stop" ? { status: "stopped", connectionStatus: "offline", target: { ...current.target, status: "unknown" } } : {}),
        ...(action === "register"
          ? {
              name: body.name || current.name,
              status: "registered",
              health: "ok",
              ready: reportedRuntimeVersion === desiredRuntimeVersion,
              build: body.build || { component: "controlled-instance", packageVersion: reportedRuntimeVersion },
              runtimeVersion: runtimeVersionStateForActual(reportedRuntimeVersion),
              connectionStatus: "online",
              agentStatus: "online",
              targetStatus: body.target?.status === "endpoint-unreachable" ? "endpoint-unreachable" : body.target?.status === "reachable" ? "reachable" : current.targetStatus,
              target: { ...current.target, ...(body.target || {}) },
              workspace: body.workspace || current.workspace,
            }
          : {}),
        ...(action === "heartbeat"
          ? {
              ...body,
              target: { ...current.target, ...(body.target || {}) },
              connectionStatus: "online",
              agentStatus: "online",
              targetStatus: body.target?.status === "endpoint-unreachable" ? "endpoint-unreachable" : body.target?.status === "reachable" ? "reachable" : current.targetStatus,
            }
          : {}),
        updatedAt: timestamp,
      };
      instances.set(id, updated);
      return jsonResponse(updated, action === "register" ? 201 : 200);
    }
    return errorResponse(`Unhandled node agent route ${path}`);
  }

  return { fetchImpl, requests, instances, folders, runtimes, nodeModels };
}

test("control plane auth is disabled by default", async () => {
  const app = await createControlPlaneApp({ dataDir: tempDataDir("cp-auth-disabled") });
  try {
    const session = await json(app, "GET", "/api/auth/session");
    assert.equal(session.statusCode, 200);
    assert.equal(session.body.data.mode, "disabled");
    assert.equal(session.body.data.authenticated, true);

    const projects = await json(app, "GET", "/api/projects");
    assert.equal(projects.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("control plane persists one update channel for server and node updates", async () => {
  const dataDir = tempDataDir("cp-update-channel-setting");
  fs.writeFileSync(path.join(dataDir, "control-plane-settings.json"), JSON.stringify({
    publicBaseUrl: "https://legacy-control.example.test",
  }));
  let app = await createControlPlaneApp({ dataDir });
  try {
    const defaults = await json(app, "GET", "/api/control-plane/settings");
    assert.equal(defaults.statusCode, 200);
    assert.equal(defaults.body.data.updateChannel, "stable");
    assert.equal(defaults.body.data.mentionTrigger, "@");
    assert.equal(defaults.body.data.commandTrigger, "/");
    assert.equal(defaults.body.data.publicBaseUrl, "https://legacy-control.example.test");

    const publicUrl = await json(app, "PATCH", "/api/control-plane/settings", {
      publicBaseUrl: "https://control.example.test",
    });
    assert.equal(publicUrl.statusCode, 200);
    assert.equal(publicUrl.body.data.updateChannel, "stable");

    const channel = await json(app, "PATCH", "/api/control-plane/settings", { updateChannel: "beta" });
    assert.equal(channel.statusCode, 200);
    assert.equal(channel.body.data.updateChannel, "beta");
    assert.equal(channel.body.data.publicBaseUrl, "https://control.example.test");

    const mention = await json(app, "PATCH", "/api/control-plane/settings", { mentionTrigger: "#" });
    assert.equal(mention.statusCode, 200);
    assert.equal(mention.body.data.mentionTrigger, "#");
    const command = await json(app, "PATCH", "/api/control-plane/settings", { commandTrigger: "!" });
    assert.equal(command.statusCode, 200);
    assert.equal(command.body.data.commandTrigger, "!");
    for (const invalid of ["", "a", "12", "/", "\\", " "]) {
      const rejected = await json(app, "PATCH", "/api/control-plane/settings", { mentionTrigger: invalid });
      assert.equal(rejected.statusCode, 400);
    }
    for (const invalid of ["", "a", "12", "\\", " "]) {
      const rejected = await json(app, "PATCH", "/api/control-plane/settings", { commandTrigger: invalid });
      assert.equal(rejected.statusCode, 400);
    }
    const duplicateTrigger = await json(app, "PATCH", "/api/control-plane/settings", { commandTrigger: "#" });
    assert.equal(duplicateTrigger.statusCode, 400);
  } finally {
    await app.close();
  }

  app = await createControlPlaneApp({ dataDir });
  try {
    const persisted = await json(app, "GET", "/api/control-plane/settings");
    assert.equal(persisted.statusCode, 200);
    assert.equal(persisted.body.data.updateChannel, "beta");
    assert.equal(persisted.body.data.publicBaseUrl, "https://control.example.test");
    assert.equal(persisted.body.data.mentionTrigger, "#");
    assert.equal(persisted.body.data.commandTrigger, "!");
  } finally {
    await app.close();
  }
});

test("control plane password auth protects APIs and supports bootstrap login logout", async () => {
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("cp-auth-password"),
    auth: { mode: "password" },
  });
  try {
    const anonymousSession = await json(app, "GET", "/api/auth/session");
    assert.equal(anonymousSession.statusCode, 200);
    assert.equal(anonymousSession.body.data.mode, "password");
    assert.equal(anonymousSession.body.data.requiresBootstrap, true);
    assert.equal(anonymousSession.body.data.authenticated, false);

    const health = await json(app, "GET", "/api/health");
    assert.equal(health.statusCode, 200);

    const blocked = await json(app, "GET", "/api/projects");
    assert.equal(blocked.statusCode, 401);

    const encodedApiBlocked = await json(app, "GET", "/%61pi/projects");
    assert.equal(encodedApiBlocked.statusCode, 401);
    const encodedInstanceBlocked = await json(app, "GET", "/%69nstances/inst_unknown/");
    assert.equal(encodedInstanceBlocked.statusCode, 401);
    await assert.rejects(app.injectWS("/%61pi/events"), /Unexpected server response: 401/);

    const bootstrap = await json(app, "POST", "/api/auth/bootstrap-admin", {
      username: "admin",
      password: "password123",
    });
    assert.equal(bootstrap.statusCode, 201);
    assert.equal(bootstrap.body.data.username, "admin");

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "password123" },
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers["set-cookie"];
    assert.ok(cookie);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);

    const authorized = await json(app, "GET", "/api/projects", undefined, { cookie });
    assert.equal(authorized.statusCode, 200);
    const encodedAuthorized = await json(app, "GET", "/%61pi/projects", undefined, { cookie });
    assert.equal(encodedAuthorized.statusCode, 200);

    const session = await json(app, "GET", "/api/auth/session", undefined, { cookie });
    assert.equal(session.statusCode, 200);
    assert.equal(session.body.data.authenticated, true);
    assert.equal(session.body.data.user.username, "admin");
    assert.equal(session.body.data.user.role, "admin");

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });
    assert.equal(logout.statusCode, 200);
    assert.match(logout.headers["set-cookie"], /Max-Age=0/);

    const blockedAfterLogout = await json(app, "GET", "/api/projects", undefined, { cookie });
    assert.equal(blockedAfterLogout.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("control plane auth exemptions belong to explicit routes and are not inherited by path prefixes", async (t) => {
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("cp-auth-explicit-boundaries"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    auth: { mode: "password" },
  });
  t.after(() => app.close());

  for (const url of [
    "/api/auth/future-sensitive",
    "/api/node-tunnel/future-sensitive",
    "/api/node-proxy/bindings/fake/future-sensitive",
    "/apps/access/future-sensitive",
  ]) {
    app.get(url, async () => ({ data: { reached: true } }));
  }

  for (const url of [
    "/api/auth/future-sensitive",
    "/api/node-tunnel/future-sensitive",
    "/api/node-proxy/bindings/fake/future-sensitive",
    "/apps/access/future-sensitive",
  ]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 401, `${url}: ${response.body}`);
    assert.equal(response.json().error.code, "CONTROL_PLANE_AUTH_REQUIRED", url);
  }

  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200);
  const session = await app.inject({ method: "GET", url: "/api/auth/session" });
  assert.equal(session.statusCode, 200);

  for (const url of ["/api/node-join/complete", "/api/node-proxy/claims"]) {
    const response = await app.inject({ method: "POST", url, payload: {} });
    assert.equal(response.statusCode, 400, `${url}: ${response.body}`);
    assert.notEqual(response.json().error.code, "CONTROL_PLANE_AUTH_REQUIRED", url);
  }
  const appAccess = await app.inject({ method: "GET", url: "/api/app-access/session?token=invalid" });
  assert.equal(appAccess.statusCode, 401);
  assert.equal(appAccess.json().error.code, "APP_ACCESS_TOKEN_INVALID");
});

test("control plane admin bootstrap has exactly one winner under concurrency", async (t) => {
  const dataDir = tempDataDir("cp-auth-bootstrap-concurrency");
  const app = await createControlPlaneApp({
    dataDir,
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    auth: { mode: "password" },
  });
  t.after(() => app.close());

  const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) => app.inject({
    method: "POST",
    url: "/api/auth/bootstrap-admin",
    payload: {
      username: `admin-${index}`,
      password: `password-${index}`,
    },
  })));
  const winners = attempts.filter((response) => response.statusCode === 201);
  const rejected = attempts.filter((response) => response.statusCode === 409);

  assert.equal(winners.length, 1);
  assert.equal(rejected.length, 7);
  assert.equal(rejected.every((response) => response.json().error.code === "AUTH_BOOTSTRAP_IN_PROGRESS"), true);
  assert.equal(fs.readdirSync(path.join(dataDir, "auth-users")).filter((name) => name.endsWith(".json")).length, 1);

  const repeated = await app.inject({
    method: "POST",
    url: "/api/auth/bootstrap-admin",
    payload: { username: "another-admin", password: "password-another" },
  });
  assert.equal(repeated.statusCode, 409);
  assert.equal(repeated.json().error.code, "AUTH_BOOTSTRAP_ALREADY_DONE");
});

test("control plane viewer cannot reach privileged mutation handlers", async (t) => {
  const dataDir = tempDataDir("cp-auth-viewer-mutations");
  const app = await createControlPlaneApp({
    dataDir,
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    auth: { mode: "password" },
  });
  t.after(() => app.close());
  await json(app, "POST", "/api/auth/bootstrap-admin", {
    username: "viewer",
    password: "password123",
  });
  const userPath = path.join(dataDir, "auth-users", fs.readdirSync(path.join(dataDir, "auth-users")).find((name) => name.endsWith(".json")));
  const user = JSON.parse(fs.readFileSync(userPath, "utf8"));
  fs.writeFileSync(userPath, JSON.stringify({ ...user, role: "viewer" }));
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "viewer", password: "password123" },
  });
  const cookie = login.headers["set-cookie"];
  assert.equal(login.statusCode, 200);
  assert.ok(cookie);

  const readable = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
  assert.equal(readable.statusCode, 200);
  for (const [method, url, payload] of [
    ["POST", "/api/ai-session-attachments", {}],
    ["POST", "/api/chat-gateway/messages", {}],
    ["POST", "/api/chat-gateway/actions", {}],
    ["POST", "/api/controlled-instances/inst_x/ai-sessions/session_x/resume", {}],
    ["POST", "/api/controlled-instances/inst_x/ai-sessions/session_x/commands", {}],
    ["POST", "/api/controlled-instances/inst_x/ai-sessions/session_x/triggers", {}],
    ["DELETE", "/api/controlled-instances/inst_x/ai-sessions/session_x/triggers/trigger_x", undefined],
  ]) {
    const response = await app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
    assert.equal(response.statusCode, 403, `${method} ${url}: ${response.body}`);
    assert.equal(response.json().error.code, "CONTROL_PLANE_FORBIDDEN");
  }
});

test("control plane login bounds password concurrency and rate limits source and username failures", async (t) => {
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("cp-auth-login-rate-limit"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    auth: {
      mode: "password",
      loginRateLimit: {
        windowMs: 60_000,
        maxFailuresPerSource: 2,
        maxFailuresPerUsername: 2,
        maxConcurrent: 1,
      },
    },
  });
  t.after(() => app.close());
  await json(app, "POST", "/api/auth/bootstrap-admin", {
    username: "admin",
    password: "password123",
  });

  const concurrent = await Promise.all([1, 2].map(() => app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: "10.0.0.1",
    payload: { username: "admin", password: "password123" },
  })));
  assert.deepEqual(concurrent.map((response) => response.statusCode).sort(), [200, 429]);
  assert.equal(concurrent.find((response) => response.statusCode === 429).json().error.code, "AUTH_LOGIN_RATE_LIMITED");

  for (const remoteAddress of ["10.0.1.1", "10.0.1.2"]) {
    const failed = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress,
      payload: { username: "admin", password: "wrong-password" },
    });
    assert.equal(failed.statusCode, 401);
  }
  const usernameLimited = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: "10.0.1.3",
    payload: { username: "admin", password: "wrong-password" },
  });
  assert.equal(usernameLimited.statusCode, 429);
  assert.equal(usernameLimited.headers["retry-after"], "60");

  for (const username of ["missing-one", "missing-two"]) {
    const failed = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.0.2.1",
      payload: { username, password: "wrong-password" },
    });
    assert.equal(failed.statusCode, 401);
  }
  const sourceLimited = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: "10.0.2.1",
    payload: { username: "missing-three", password: "wrong-password" },
  });
  assert.equal(sourceLimited.statusCode, 429);
  assert.equal(sourceLimited.headers["retry-after"], "60");
});

test("control plane serves the remote node-agent installer without auth", async (t) => {
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("cp-node-agent-installer"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    auth: { mode: "password" },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/install-node-agent.sh",
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.headers["content-type"], /text\/x-shellscript/);
  assert.match(response.body, /task-handoff-node-agent\.service/);
  assert.match(response.body, /--control-plane <url>/);
  assert.match(response.body, /api\/node-agent\/control-plane-connections/);
});

test("control plane authorization role matrix separates viewer operator and admin", () => {
  const admin = { type: "user", userId: "u_admin", role: "admin" };
  const operator = { type: "user", userId: "u_operator", role: "operator" };
  const viewer = { type: "user", userId: "u_viewer", role: "viewer" };

  assert.equal(can(admin, "manage-secrets", { type: "model" }), true);
  assert.equal(can(operator, "start", { type: "instance", id: "inst_1" }), true);
  assert.equal(can(operator, "send-message", { type: "ai-session", instanceId: "inst_1", id: "ais_1" }), true);
  assert.equal(can(operator, "manage-secrets", { type: "model", id: "model_1" }), false);
  assert.equal(can(operator, "manage-node-auth", { type: "node", id: "node_1" }), false);
  assert.equal(can(viewer, "read", { type: "instance", id: "inst_1" }), true);
  assert.equal(can(viewer, "start", { type: "instance", id: "inst_1" }), false);
});

test("control plane mutation route policies never degrade privileged operations to read", () => {
  const viewer = { type: "user", userId: "u_viewer", role: "viewer" };
  const operator = { type: "user", userId: "u_operator", role: "operator" };
  const operatorRoutes = [
    ["POST", "/api/ai-session-attachments", "send-message", "ai-session"],
    ["POST", "/api/chat-gateway/messages", "send-message", "ai-session"],
    ["POST", "/api/chat-gateway/actions", "send-message", "ai-session"],
    ["POST", "/api/controlled-instances/:id/ai-sessions/:sessionId/resume", "send-message", "ai-session"],
    ["POST", "/api/controlled-instances/:id/ai-sessions/:sessionId/commands", "send-message", "ai-session"],
    ["POST", "/api/controlled-instances/:id/ai-sessions/:sessionId/triggers", "create", "trigger"],
    ["DELETE", "/api/controlled-instances/:id/ai-sessions/:sessionId/triggers/:configHash", "delete", "trigger"],
  ];
  for (const [method, route, expectedAction, expectedResource] of operatorRoutes) {
    const policy = routeAuthorization(method, route);
    assert.equal(policy.action, expectedAction, `${method} ${route}`);
    assert.equal(policy.resource.type, expectedResource, `${method} ${route}`);
    assert.equal(can(viewer, policy.action, policy.resource), false, `${method} ${route} viewer`);
    assert.equal(can(operator, policy.action, policy.resource), true, `${method} ${route} operator`);
  }

  const adminOnly = routeAuthorization("POST", "/api/chat-gateway/poll-ai-sessions");
  assert.equal(adminOnly.action, "manage-settings");
  assert.equal(can(viewer, adminOnly.action, adminOnly.resource), false);
  assert.equal(can(operator, adminOnly.action, adminOnly.resource), false);

  const unknownMutation = routeAuthorization("POST", "/api/future-sensitive-operation");
  assert.equal(unknownMutation.action, "create");
  assert.equal(can(viewer, unknownMutation.action, unknownMutation.resource), false);
  assert.equal(can(operator, unknownMutation.action, unknownMutation.resource), false);
  const unknownAiMutation = routeAuthorization("POST", "/api/controlled-instances/:id/ai-sessions/:sessionId/future-operation");
  assert.equal(unknownAiMutation.action, "create");
  assert.equal(can(viewer, unknownAiMutation.action, unknownAiMutation.resource), false);
  assert.equal(can(operator, unknownAiMutation.action, unknownAiMutation.resource), false);
});

test("event connection retry timing is bounded, jittered, and safety reconciliation is clamped", () => {
  assert.equal(eventConnectionRetryDelay(0, () => 0), 750);
  assert.equal(eventConnectionRetryDelay(1, () => 0.5), 2_000);
  assert.equal(eventConnectionRetryDelay(10, () => 0.5), 30_000);
  assert.equal(eventConnectionRetryDelay(10, () => 1), 30_000);
  assert.equal(eventConnectionSafetyIntervalMs(1_000), 30_000);
  assert.equal(eventConnectionSafetyIntervalMs(50_000), 50_000);
  assert.equal(eventConnectionSafetyIntervalMs(120_000), 60_000);
});

test("event connection retry timer resets after success and cancels removal cleanup deterministically", () => {
  const scheduled = [];
  const cleared = [];
  const setTimeoutFn = (callback, delay) => {
    const handle = { callback, delay };
    scheduled.push(handle);
    return handle;
  };
  const clearTimeoutFn = (handle) => cleared.push(handle);
  const retry = new EventConnectionRetryTimer();

  assert.deepEqual(retry.schedule(() => undefined, { random: () => 0.5, setTimeoutFn }), { attempt: 1, delay: 1_000 });
  assert.equal(retry.pending, true);
  assert.equal(retry.schedule(() => undefined, { random: () => 0.5, setTimeoutFn }), undefined);
  scheduled[0].callback();
  assert.equal(retry.pending, false);
  assert.deepEqual(retry.schedule(() => undefined, { random: () => 0.5, setTimeoutFn }), { attempt: 2, delay: 2_000 });
  retry.reset(clearTimeoutFn);
  assert.equal(retry.attempts, 0);
  assert.equal(cleared.includes(scheduled[1]), true);
  assert.deepEqual(retry.schedule(() => undefined, { random: () => 0.5, setTimeoutFn }), { attempt: 1, delay: 1_000 });
  retry.cancel(clearTimeoutFn);
  assert.equal(retry.pending, false);
  assert.equal(cleared.includes(scheduled[2]), true);
});

test("instance event connections reconcile immediately, clean retries on removal, and safety-repair missed lifecycle changes", () => {
  const instances = [];
  const sockets = [];
  let safetyTick;
  class FakeSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = WebSocket.CONNECTING;
      this.sent = [];
      this.closed = false;
    }
    send(value) { this.sent.push(String(value)); }
    close() { this.closed = true; }
  }
  const forwarder = new NodeAgentInstanceEventForwarder(
    { listInstances: () => instances },
    undefined,
    {
      safetyIntervalMs: 30_000,
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      setIntervalFn: (callback) => {
        safetyTick = callback;
        return { kind: "interval" };
      },
      clearIntervalFn: () => undefined,
    },
  );
  const output = new EventEmitter();
  output.readyState = WebSocket.OPEN;
  output.send = () => undefined;
  forwarder.addOutput(output);
  forwarder.start();

  instances.push({ id: "inst_reconcile", target: { api: "http://127.0.0.1:18080" } });
  assert.equal(sockets.length, 0);
  safetyTick();
  assert.equal(sockets.length, 1);
  assert.equal(forwarder.diagnostics().safetyReconciliations, 1);
  sockets[0].readyState = WebSocket.OPEN;
  sockets[0].emit("open");

  instances[0].target.api = "http://127.0.0.1:18081";
  forwarder.syncNow();
  assert.equal(sockets[0].closed, true);
  assert.equal(sockets.length, 2);

  sockets[1].emit("close");
  assert.equal(forwarder.diagnostics().pendingRetries, 1);
  instances.splice(0, 1);
  forwarder.syncNow();
  assert.equal(forwarder.diagnostics().pendingRetries, 0);

  instances.push({ id: "inst_immediate", target: { api: "http://127.0.0.1:18082" } });
  forwarder.syncNow();
  assert.equal(sockets.length, 3);
  forwarder.stop();
});

test("control plane process lock enforces one owner per system lock", () => {
  const dataDir = tempDataDir("control-plane-lock");
  const lockPath = path.join(dataDir, "control-plane-system.lock");
  const first = acquireControlPlaneSingletonLock(lockPath, { dataDir: path.join(dataDir, "first"), host: "127.0.0.1", port: 18081 });

  assert.throws(
    () => acquireControlPlaneSingletonLock(lockPath, { dataDir: path.join(dataDir, "second"), host: "127.0.0.1", port: 18082 }),
    (error) => {
      assert.equal(error instanceof ProcessSingletonError, true);
      assert.equal(error.code, "CONTROL_PLANE_ALREADY_RUNNING");
      assert.equal(error.owner.pid, process.pid);
      assert.equal(error.owner.component, "control-plane");
      assert.equal(error.owner.port, 18081);
      assert.equal(error.owner.dataDir, path.join(dataDir, "first"));
      return true;
    },
  );

  first.release();
  const second = acquireControlPlaneSingletonLock(lockPath, { dataDir: path.join(dataDir, "second"), host: "127.0.0.1", port: 18082 });
  assert.equal(second.owner.port, 18082);
  second.release();
});

test("node agent process lock enforces one owner independent of port", () => {
  const dataDir = tempDataDir("node-agent-lock");
  const lockPath = path.join(dataDir, "node-agent-system.lock");
  const first = acquireNodeAgentSingletonLock(lockPath, { dataDir: path.join(dataDir, "first"), host: "127.0.0.1", port: 18091 });

  assert.throws(
    () => acquireNodeAgentSingletonLock(lockPath, { dataDir: path.join(dataDir, "second"), host: "127.0.0.1", port: 18092 }),
    (error) => {
      assert.equal(error instanceof ProcessSingletonError, true);
      assert.equal(error.code, "NODE_AGENT_ALREADY_RUNNING");
      assert.equal(error.owner.pid, process.pid);
      assert.equal(error.owner.component, "node-agent");
      assert.equal(error.owner.port, 18091);
      return true;
    },
  );

  first.release();
});

test("local controlled instance lock is host-user scoped instead of node-agent data scoped", () => {
  const root = tempDataDir("local-controlled-instance-lock");
  const lockPath = path.join(root, "host-user.lock");
  const first = acquireLocalControlledInstanceLock({
    instanceId: "inst_first",
    dataDir: path.join(root, "node-agent-a", "local-instances", "inst_first"),
    host: "127.0.0.1",
    port: 19001,
  }, lockPath);

  assert.throws(
    () => acquireLocalControlledInstanceLock({
      instanceId: "inst_second",
      dataDir: path.join(root, "node-agent-b", "local-instances", "inst_second"),
      host: "127.0.0.1",
      port: 19002,
    }, lockPath),
    (error) => {
      assert.equal(error.code, "LOCAL_CONTROLLED_INSTANCE_ALREADY_RUNNING");
      assert.equal(error.owner.instanceId, "inst_first");
      assert.equal(error.owner.port, 19001);
      return true;
    },
  );

  if (process.platform !== "win32") {
    assert.equal(localControlledInstanceLockPath(), `/tmp/task-handoff-local-controlled-instance-${process.getuid()}.lock`);
  }
  first.release();
});

test("process termination identity rejects a reused pid", () => {
  const currentIdentity = processStartIdentity(process.pid);
  assert.equal(verifiedProcessLockOwnerPid({ pid: process.pid, startIdentity: "definitely-not-this-process" }), undefined);
  if (currentIdentity) {
    assert.equal(verifiedProcessLockOwnerPid({ pid: process.pid, startIdentity: currentIdentity }), process.pid);
  }
});

test("control plane process lock recovers stale owners", () => {
  const dataDir = tempDataDir("control-plane-stale-lock");
  const lockPath = path.join(dataDir, "control-plane.lock");
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({
    pid: 99999999,
    hostname: "old-host",
    command: "task-handoff control-plane",
    acquiredAt: "2026-07-03T00:00:00.000Z",
    token: "old-token",
    host: "127.0.0.1",
    port: 18081,
  })}\n`);

  const lock = acquireProcessSingletonLock(lockPath, { component: "control-plane", host: "127.0.0.1", port: 18082 });
  assert.equal(lock.owner.pid, process.pid);
  assert.equal(lock.owner.port, 18082);
  lock.release();
});

test("process lock allows exactly one concurrent child-process owner", async () => {
  const dataDir = tempDataDir("concurrent-process-lock");
  const lockPath = path.join(dataDir, "system.lock");
  const gatePath = path.join(dataDir, "start");
  const modulePath = path.resolve(__dirname, "../packages/control-plane/src/shared/process/singleton-lock.ts");
  const script = String.raw`
    const fs = require("node:fs");
    const { acquireProcessSingletonLock } = require(process.argv[1]);
    const lockPath = process.argv[2];
    const gatePath = process.argv[3];
    while (!fs.existsSync(gatePath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    try {
      const lock = acquireProcessSingletonLock(lockPath, { component: "control-plane" });
      process.stdout.write(JSON.stringify({ acquired: true, pid: process.pid }));
      setTimeout(() => { lock.release(); process.exit(0); }, 300);
    } catch (error) {
      process.stdout.write(JSON.stringify({ acquired: false, code: error.code }));
    }
  `;
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, ["-e", script, modulePath, lockPath, gatePath], {
    stdio: ["ignore", "pipe", "pipe"],
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.writeFileSync(gatePath, "start\n");
  const results = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `child exited ${code}`)));
  })));

  assert.equal(results.filter((result) => result.acquired).length, 1);
  assert.equal(results.filter((result) => result.code === "PROCESS_ALREADY_RUNNING").length, 7);
});

test("process lock does not reclaim a recent incomplete child-process initialization", async () => {
  const dataDir = tempDataDir("initializing-process-lock");
  const lockPath = path.join(dataDir, "system.lock");
  const script = String.raw`
    const fs = require("node:fs");
    const path = require("node:path");
    const lockPath = process.argv[1];
    fs.mkdirSync(lockPath);
    process.stdout.write("ready\n");
    setTimeout(() => {
      fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
        pid: process.pid, hostname: "child", command: "test", acquiredAt: new Date().toISOString(), token: "child-token"
      }));
      setTimeout(() => process.exit(0), 200);
    }, 250);
  `;
  const child = spawn(process.execPath, ["-e", script, lockPath], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", resolve);
  });

  assert.throws(
    () => acquireControlPlaneSingletonLock(lockPath),
    (error) => error instanceof ProcessSingletonError && error.code === "CONTROL_PLANE_ALREADY_RUNNING",
  );
  assert.equal(fs.existsSync(lockPath), true);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
  });
});

test("process lock recovers an aged directory with no owner", () => {
  const dataDir = tempDataDir("missing-owner-process-lock");
  const lockPath = path.join(dataDir, "system.lock");
  fs.mkdirSync(lockPath);
  const staleAt = new Date(Date.now() - 10_000);
  fs.utimesSync(lockPath, staleAt, staleAt);

  const lock = acquireControlPlaneSingletonLock(lockPath);
  assert.equal(lock.owner.pid, process.pid);
  lock.release();
});

test("process lock recovers an aged directory with an invalid owner", () => {
  const dataDir = tempDataDir("invalid-owner-process-lock");
  const lockPath = path.join(dataDir, "system.lock");
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, "owner.json"), "{ truncated");
  const staleAt = new Date(Date.now() - 10_000);
  fs.utimesSync(lockPath, staleAt, staleAt);

  const lock = acquireControlPlaneSingletonLock(lockPath);
  assert.equal(lock.owner.pid, process.pid);
  lock.release();
});

test("process lock recovers an abandoned stale-recovery claim", () => {
  const dataDir = tempDataDir("abandoned-recovery-process-lock");
  const lockPath = path.join(dataDir, "system.lock");
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, "recovering.json"), JSON.stringify({
    token: "abandoned-token",
    pid: 99999999,
    startedAt: new Date(Date.now() - 10_000).toISOString(),
  }));
  const staleAt = new Date(Date.now() - 10_000);
  fs.utimesSync(lockPath, staleAt, staleAt);

  const lock = acquireControlPlaneSingletonLock(lockPath);
  assert.equal(lock.owner.pid, process.pid);
  lock.release();
});

test("control plane emits websocket events for mutations", async (t) => {
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("cp-events"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
  });
  t.after(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.equal(typeof address, "object");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events`);
  t.after(() => socket.terminate());
  const connectedMessage = withTimeout(onceWebSocketMessageFrame(socket), "events connected");
  await withTimeout(waitForWebSocketOpen(socket), "control plane events websocket open");
  assert.equal(JSON.parse((await connectedMessage).message).type, "streams.hello");

  const project = await json(app, "POST", "/api/projects", {
    name: "Events Project",
    source: {
      type: "local-folder",
      path: "/tmp/events",
    },
  });
  assert.equal(project.statusCode, 201);
  const event = JSON.parse((await withTimeout(onceWebSocketMessageFrame(socket), "project created event")).message);
  assert.equal(event.type, "project.created");
  assert.equal(event.payload.projectId, project.body.data.id);
});

test("control plane event bus drops clients that fail to send", () => {
  const events = new ControlPlaneEventBus();
  const sent = [];
  const badSocket = {
    readyState: 1,
    OPEN: 1,
    send: () => {
      throw new Error("socket closed");
    },
    on: () => undefined,
  };
  const goodSocket = {
    readyState: 1,
    OPEN: 1,
    send: (value) => sent.push(JSON.parse(value)),
    on: () => undefined,
  };
  events.connect(badSocket);
  events.connect(goodSocket);

  events.publish("project.created", { projectId: "proj_1" });
  events.publish("project.updated", { projectId: "proj_1" });

  assert.deepEqual(sent.map((event) => event.type), ["project.created", "project.updated"]);
});

test("control plane event bus filters websocket topics", () => {
  const events = new ControlPlaneEventBus();
  const listeners = {};
  const sent = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send: (value) => sent.push(value),
    on: (event, listener) => {
      listeners[event] = listener;
    },
  };
  events.connect(socket);
  listeners.message(JSON.stringify({ type: "subscribe", topics: [AiSessionEventTopic] }));

  events.publish("project.created", { projectId: "project_1" });
  events.publish(AiSessionEventType.Snapshot, aiSessionSnapshotPayload({ sessions: [] }));

  assert.equal(sent.length, 1);
  const event = JSON.parse(sent[0]);
  assert.equal(event.type, AiSessionEventType.Snapshot);
  assert.equal(event.topic, AiSessionEventTopic);
});

test("node agent ai session event forwarder logs revision gaps", async (t) => {
  const instanceEvents = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
  t.after(() => instanceEvents.close());
  await new Promise((resolve) => instanceEvents.once("listening", resolve));
  const address = instanceEvents.address();
  assert.equal(typeof address, "object");
  const warnings = [];
  const outputFrames = [];
  const forwarder = new NodeAgentInstanceEventForwarder({
    listInstances: () => [{
      id: "inst_gap",
      target: {
        api: `http://127.0.0.1:${address.port}`,
        web: `http://127.0.0.1:${address.port}`,
      },
    }],
  }, undefined, {
    logger: {
      warn: (data, message) => warnings.push({ data, message }),
      info: () => undefined,
    },
  });
  t.after(() => forwarder.stop());
  const output = {
    readyState: 1,
    OPEN: 1,
    send: (value) => outputFrames.push(JSON.parse(value)),
    on: () => undefined,
  };
  instanceEvents.on("connection", (socket) => {
    socket.on("message", () => {
      socket.send(JSON.stringify({
        type: AiSessionEventType.Snapshot,
        topic: AiSessionEventTopic,
        payload: aiSessionSnapshotPayload({ sessions: [] }, { instanceId: "inst_gap", streamId: "ai_gap_stream", revision: 1 }),
      }));
      socket.send(JSON.stringify({
        type: AiSessionEventType.Snapshot,
        topic: AiSessionEventTopic,
        payload: aiSessionSnapshotPayload({ sessions: [] }, { instanceId: "inst_gap", streamId: "ai_gap_stream", revision: 3 }),
      }));
    });
  });

  forwarder.addOutput(output);
  await waitForCondition(() => outputFrames.length >= 2, "forwarded ai session events");

  const gap = warnings.find((entry) => entry.message === "ai-session.event.forward.gap");
  assert.ok(gap);
  assert.equal(gap.data.instanceId, "inst_gap");
  assert.equal(gap.data.previousRevision, 1);
  assert.equal(gap.data.revision, 3);
});

test("control plane forwards node agent websocket events with instance scope", async (t) => {
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("cp-node-agent-events"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
  });
  t.after(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.equal(typeof address, "object");
  const node = await json(app, "POST", "/api/nodes", {
    id: "node_events",
    name: "Events Node",
    connectionMode: "reverse-wss",
    auth: {
      mode: "paired-hmac",
      keyId: "key_agent",
      secret: "agent-secret",
    },
  });
  assert.equal(node.statusCode, 201);

  const eventsSocket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events`);
  t.after(() => eventsSocket.terminate());
  const connectedMessage = withTimeout(onceWebSocketMessageFrame(eventsSocket), "events connected");
  await withTimeout(waitForWebSocketOpen(eventsSocket), "control plane events websocket open");
  assert.equal(JSON.parse((await connectedMessage).message).type, "streams.hello");

  const tunnelUrl = `/api/node-tunnel?nodeId=node_events`;
  const tunnel = new WebSocket(`ws://127.0.0.1:${address.port}${tunnelUrl}`, {
    headers: createNodeAgentHmacHeaders({
      nodeId: "node_events",
      keyId: "key_agent",
      secret: "agent-secret",
      method: "GET",
      pathWithQuery: tunnelUrl,
    }),
  });
  t.after(() => tunnel.terminate());
  const welcomeMessage = withTimeout(onceWebSocketMessageFrame(tunnel), "node tunnel welcome");
  await withTimeout(waitForWebSocketOpen(tunnel), "node agent tunnel websocket open");
  assert.equal(JSON.parse((await welcomeMessage).message).type, "control-plane.hello");
  tunnel.send(JSON.stringify({ type: "node-agent.identify", nodeId: "node_events" }));
  assert.equal(JSON.parse((await withTimeout(onceWebSocketMessageFrame(tunnel), "node tunnel identified")).message).type, "control-plane.identified");

  tunnel.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type !== "control-plane.request" || message.route !== "/instances") return;
    const timestamp = new Date().toISOString();
    tunnel.send(JSON.stringify({
      type: "node-agent.response",
      requestId: message.requestId,
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: [{
          id: "inst_events",
          name: "Events Instance",
          source: { type: "local-folder", path: "/tmp/events" },
          sourceSnapshot: {},
          modelSelection: {},
          nodeId: "node_events",
          runtimeId: "runtime_events",
          access: { strategy: "control-plane-proxy", status: "unknown" },
          createdAt: timestamp,
          updatedAt: timestamp,
        }],
      }),
    }));
  });

  tunnel.send(JSON.stringify({
    type: "node-agent.event.forwarded",
    event: {
      type: AiSessionEventType.Snapshot,
      topic: AiSessionEventTopic,
      payload: aiSessionSnapshotPayload({ sessions: [] }, { instanceId: "inst_events" }),
      scope: { instanceId: "inst_events" },
    },
  }));

  const event = JSON.parse((await withTimeout(onceWebSocketMessageFrame(eventsSocket), "forwarded ai session event")).message);
  assert.equal(event.type, AiSessionEventType.Snapshot);
  assert.equal(event.topic, AiSessionEventTopic);
  assert.equal(event.scope.nodeId, "node_events");
  assert.equal(event.scope.instanceId, "inst_events");
});

test("control plane accepts metrics only for an instance owned by the forwarding node", async () => {
  const events = new ControlPlaneEventBus();
  const published = [];
  events.on((event) => published.push(event));
  const validations = [];
  const tunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
    validateInstanceScope: async (nodeId, instanceId) => {
      validations.push([nodeId, instanceId]);
      return nodeId === "node_metrics" && instanceId === "inst_owned";
    },
  });
  const metric = (instanceId) => ({
    instanceId,
    runtimeKind: "docker",
    state: "available",
    sampledAt: "2026-07-17T00:00:00.000Z",
    cpu: { usagePercent: 2.5 },
  });

  tunnel.handleMessage("node_metrics", {
    type: "node-agent.event.forwarded",
    event: { type: "instance.metrics.snapshot", topic: "instances", payload: metric("inst_other"), scope: { instanceId: "inst_other" } },
  });
  tunnel.handleMessage("node_metrics", {
    type: "node-agent.event.forwarded",
    event: { type: "instance.metrics.snapshot", topic: "instances", payload: metric("inst_owned"), scope: { instanceId: "inst_owned" } },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(validations, [["node_metrics", "inst_other"], ["node_metrics", "inst_owned"]]);
  assert.equal(published.length, 1);
  assert.equal(published[0].payload.instanceId, "inst_owned");
  assert.deepEqual(published[0].scope, { nodeId: "node_metrics", instanceId: "inst_owned" });
});

test("control plane rejects metrics whose payload and forwarded scope disagree", async () => {
  const events = new ControlPlaneEventBus();
  const published = [];
  events.on((event) => published.push(event));
  let validations = 0;
  const tunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
    validateInstanceScope: async () => { validations += 1; return true; },
  });
  tunnel.handleMessage("node_metrics", {
    type: "node-agent.event.forwarded",
    event: {
      type: "instance.metrics.snapshot",
      payload: { instanceId: "inst_payload", runtimeKind: "docker", state: "unavailable", sampledAt: "2026-07-17T00:00:00.000Z" },
      scope: { instanceId: "inst_scope" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(validations, 0);
  assert.equal(published.length, 0);
});

test("control plane rejects session events whose payload and forwarded scope disagree", async () => {
  const events = new ControlPlaneEventBus();
  const published = [];
  events.on((event) => published.push(event));
  let validations = 0;
  let aggregated = 0;
  const tunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
    validateInstanceScope: async () => { validations += 1; return true; },
    onSessionEvent: () => { aggregated += 1; return true; },
  });
  tunnel.handleMessage("node_sessions", {
    type: "node-agent.event.forwarded",
    event: {
      type: AiSessionEventType.Snapshot,
      topic: AiSessionEventTopic,
      payload: aiSessionSnapshotPayload({ sessions: [] }, { instanceId: "inst_payload" }),
      scope: { instanceId: "inst_scope" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(validations, 0);
  assert.equal(aggregated, 0);
  assert.equal(published.length, 0);
});

test("invalidating instance ownership prevents a stale node from forwarding session events", async () => {
  const events = new ControlPlaneEventBus();
  const published = [];
  events.on((event) => published.push(event));
  let ownsInstance = true;
  let validations = 0;
  const tunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
    validateInstanceScope: async () => { validations += 1; return ownsInstance; },
  });
  const forward = (revision) => tunnel.handleMessage("node_sessions", {
    type: "node-agent.event.forwarded",
    event: {
      type: AiSessionEventType.Snapshot,
      topic: AiSessionEventTopic,
      payload: aiSessionSnapshotPayload({ sessions: [] }, { instanceId: "inst_owned", revision }),
      scope: { instanceId: "inst_owned" },
    },
  });

  forward(1);
  forward(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(validations, 1);
  assert.equal(published.length, 2);

  ownsInstance = false;
  tunnel.attach("node_sessions", { readyState: 1, send() {}, close() {} });
  tunnel.attach("node_sessions", { readyState: 1, send() {}, close() {} });
  forward(3);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(validations, 2);
  assert.equal(published.length, 2);
});

test("control plane forwards lifecycle snapshots only for instances owned by the node", async () => {
  const events = new ControlPlaneEventBus();
  const published = [];
  events.on((event) => published.push(event));
  const validations = [];
  const tunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
    validateInstanceScope: async (nodeId, instanceId) => {
      validations.push([nodeId, instanceId]);
      return nodeId === "node_lifecycle" && instanceId === "inst_owned";
    },
  });
  const lifecycle = (instanceId, revision) => ({
    instanceId,
    revision,
    updatedAt: "2026-07-25T00:00:00.000Z",
    status: "starting",
    health: "unknown",
    connectionStatus: "unknown",
    accessStatus: "endpoint-unreachable",
    ready: false,
    workspace: { status: "pending" },
    runtime: { labels: {} },
  });

  tunnel.handleMessage("node_lifecycle", {
    type: "node-agent.event.forwarded",
    event: { type: InstanceLifecycleEventType.Snapshot, topic: "instances", payload: lifecycle("inst_other", 1), scope: { instanceId: "inst_other" } },
  });
  tunnel.handleMessage("node_lifecycle", {
    type: "node-agent.event.forwarded",
    event: { type: InstanceLifecycleEventType.Snapshot, topic: "instances", payload: lifecycle("inst_owned", 2), scope: { instanceId: "inst_owned" } },
  });
  tunnel.handleMessage("node_lifecycle", {
    type: "node-agent.event.forwarded",
    event: { type: InstanceLifecycleEventType.Snapshot, topic: "instances", payload: lifecycle("inst_owned", 3), scope: { instanceId: "inst_mismatch" } },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(validations, [["node_lifecycle", "inst_other"], ["node_lifecycle", "inst_owned"]]);
  assert.equal(published.length, 1);
  assert.equal(published[0].type, InstanceLifecycleEventType.Snapshot);
  assert.equal(published[0].payload.revision, 2);
  assert.deepEqual(published[0].scope, { nodeId: "node_lifecycle", instanceId: "inst_owned" });
});

test("control plane subscribes to direct node agent websocket events", async (t) => {
  const instanceEvents = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
  let instanceEventSocket;
  t.after(() => instanceEvents.close());
  instanceEvents.on("connection", (socket) => {
    instanceEventSocket = socket;
    socket.on("message", () => {
      const timestamp = new Date().toISOString();
      socket.send(JSON.stringify({
        type: AiSessionEventType.Snapshot,
        topic: AiSessionEventTopic,
        payload: aiSessionSnapshotPayload({
          sessions: [{
            id: "ai_1",
            agent: "codex",
            appId: "codex",
            appSessionId: "app_1",
            status: "idle",
            phase: "unknown",
            startedAt: timestamp,
            updatedAt: timestamp,
          }],
        }, { instanceId: "inst_direct_events", streamId: "ai_direct_stream", revision: 1 }),
      }));
      socket.send(JSON.stringify({
        type: AiSessionEventType.Snapshot,
        topic: AiSessionEventTopic,
        payload: aiSessionSnapshotPayload({
          sessions: [{
            id: "ai_1",
            agent: "codex",
            appId: "codex",
            appSessionId: "app_1",
            status: "idle",
            phase: "unknown",
            startedAt: timestamp,
            updatedAt: timestamp,
          }],
        }, { instanceId: "inst_direct_events", streamId: "ai_direct_stream", revision: 1 }),
      }));
      const rawDeltas = ["stream", "ed ", "text ", "stays ", "exact"];
      const coalescer = new AiSessionMessageDeltaCoalescer({
        emit: (payload) => socket.send(JSON.stringify({
          type: AiSessionEventType.MessageDelta,
          topic: AiSessionEventTopic,
          payload,
        })),
      });
      for (const delta of rawDeltas) {
        coalescer.push({
          instanceId: "inst_direct_events",
          sessionId: "ai_1",
          providerSessionId: "thread_1",
          turnId: "turn_1",
          itemId: "item_1",
          delta,
          generatedAt: timestamp,
        });
      }
      coalescer.flushAll("authoritative-event");
    });
  });
  await new Promise((resolve) => instanceEvents.once("listening", resolve));
  const instanceEventsAddress = instanceEvents.address();
  assert.equal(typeof instanceEventsAddress, "object");

  const nodeAgent = await createNodeAgentApp({
    dataDir: tempDataDir("direct-node-agent-events"),
    logger: false,
    token: "agent-secret",
    port: 0,
  });
  t.after(() => nodeAgent.close());
  await nodeAgent.listen({ host: "127.0.0.1", port: 0 });
  const nodeAgentAddress = nodeAgent.server.address();
  assert.equal(typeof nodeAgentAddress, "object");

  const createdInstance = await nodeAgent.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_direct_events",
      name: "direct events",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "market_taskhandoff_browser" },
      source: {
        type: "local-folder",
        path: "/tmp/direct-events",
      },
      image: testInstanceImage("task-handoff/default:latest", "img_default", "Default"),
    },
  });
  assert.equal(createdInstance.statusCode, 201);
  const registeredInstance = await nodeAgent.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_direct_events/register",
    headers: { authorization: `Bearer ${createdInstance.json().data.registrationToken}` },
    payload: {
      instanceId: "inst_direct_events",
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      appInventory: emptyAppInventory(),
      build: { component: "controlled-instance", packageVersion: runtimeVersionStateForActual().desiredVersion },
      target: {
        strategy: "direct-port",
        web: `http://127.0.0.1:${instanceEventsAddress.port}`,
        api: `http://127.0.0.1:${instanceEventsAddress.port}`,
        status: "reachable",
      },
      workspace: {
        status: "ready",
      },
    },
  });
  assert.equal(registeredInstance.statusCode, 201);
  const registeredState = nodeAgent.nodeAgentState.controlledInstances.get("inst_direct_events");
  nodeAgent.nodeAgentState.controlledInstances.put({
    ...registeredState,
    status: "running",
    ready: true,
    runtimeVersion: runtimeVersionStateForActual(runtimeVersionStateForActual().desiredVersion),
  });

  const controlPlane = await createControlPlaneApp({
    dataDir: tempDataDir("cp-direct-node-agent-events"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
  });
  t.after(() => controlPlane.close());
  await controlPlane.listen({ host: "127.0.0.1", port: 0 });
  const controlPlaneAddress = controlPlane.server.address();
  assert.equal(typeof controlPlaneAddress, "object");

  const createdNode = await json(controlPlane, "POST", "/api/nodes", {
    name: "Direct Events Node",
    connectionMode: "local-loopback",
    endpoint: `http://127.0.0.1:${nodeAgentAddress.port}`,
    controlEndpoint: `http://127.0.0.1:${nodeAgentAddress.port}`,
    auth: {
      mode: "local-static-key",
      secret: "agent-secret",
    },
  });
  assert.equal(createdNode.statusCode, 201);
  const directNodeId = createdNode.body.data.id;

  const eventsSocket = new WebSocket(`ws://127.0.0.1:${controlPlaneAddress.port}/api/events`);
  t.after(() => eventsSocket.terminate());
  const receivedEvents = [];
  eventsSocket.on("message", (message) => receivedEvents.push(JSON.parse(String(message))));
  await withTimeout(waitForWebSocketOpen(eventsSocket), "control plane events websocket open");
  const hello = await waitForCondition(() => receivedEvents.find((entry) => entry.type === "streams.hello"), "control plane streams hello");
  assert.equal(hello.type, "streams.hello");

  const lifecycle = await waitForCondition(() => receivedEvents.find((entry) => entry.type === InstanceLifecycleEventType.Snapshot), "direct node agent lifecycle snapshot", 7000);
  assert.equal(lifecycle.topic, "instances");
  assert.equal(lifecycle.scope.nodeId, directNodeId);
  assert.equal(lifecycle.scope.instanceId, "inst_direct_events");
  assert.equal(lifecycle.payload.instanceId, "inst_direct_events");
  assert.ok(lifecycle.payload.revision >= 1);

  const heartbeat = await nodeAgent.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_direct_events/heartbeat",
    headers: { authorization: `Bearer ${createdInstance.json().data.registrationToken}` },
    payload: {
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      status: "running",
      health: "ok",
      appInventory: emptyAppInventory(),
      target: { status: "reachable" },
    },
  });
  assert.equal(heartbeat.statusCode, 200);
  const runningLifecycle = await waitForCondition(() => receivedEvents.find((entry) => (
    entry.type === InstanceLifecycleEventType.Snapshot
    && entry.payload.status === "running"
    && entry.payload.revision > lifecycle.payload.revision
  )), "live node agent lifecycle update", 7000);
  assert.equal(runningLifecycle.payload.health, "ok");
  assert.equal(runningLifecycle.payload.accessStatus, "reachable");

  const event = await waitForCondition(() => receivedEvents.find((entry) => entry.type === AiSessionEventType.Snapshot), "direct node agent ai session event", 7000);
  assert.equal(event.type, AiSessionEventType.Snapshot);
  assert.equal(event.topic, AiSessionEventTopic);
  assert.equal(event.scope.nodeId, directNodeId);
  assert.equal(event.scope.instanceId, "inst_direct_events");
  assert.equal(event.payload.meta.revision, 1);
  assert.equal(event.payload.snapshot.sessions[0].id, "ai_1");

  const messageDeltas = await waitForCondition(() => {
    const matches = receivedEvents.filter((entry) => entry.type === AiSessionEventType.MessageDelta);
    return matches.length ? matches : undefined;
  }, "coalesced direct node agent AI message delta", 7000);
  assert.equal(messageDeltas.length, 1);
  assert.equal(messageDeltas[0].scope.nodeId, directNodeId);
  assert.equal(messageDeltas[0].scope.instanceId, "inst_direct_events");
  assert.equal(messageDeltas[0].payload.delta, "streamed text stays exact");

  const aggregated = await waitForCondition(async () => {
    const response = await json(controlPlane, "GET", "/api/ai-sessions");
    return response.body.data.instances.find((entry) => entry.instanceId === "inst_direct_events")?.revision === 1 ? response : undefined;
  }, "aggregated direct ai session snapshot");
  assert.equal(aggregated.statusCode, 200);
  const aggregatedEntry = aggregated.body.data.instances.find((entry) => entry.instanceId === "inst_direct_events");
  assert.ok(aggregatedEntry);
  assert.equal(aggregatedEntry.revision, 1);
  assert.equal(aggregatedEntry.aiSessions.sessions[0].unread, false);

  const sendAiSessionStatus = (status, revision, updatedAt) => instanceEventSocket.send(JSON.stringify({
    type: AiSessionEventType.Snapshot,
    topic: AiSessionEventTopic,
    payload: aiSessionSnapshotPayload({
      runningCount: status === "running" ? 1 : 0,
      waitingCount: status === "waiting" ? 1 : 0,
      sessions: [{
        id: "ai_1",
        agent: "codex",
        appId: "codex",
        appSessionId: "app_1",
        status,
        phase: "unknown",
        startedAt: updatedAt,
        updatedAt,
      }],
    }, { instanceId: "inst_direct_events", streamId: "ai_direct_stream", revision, generatedAt: updatedAt }),
  }));
  sendAiSessionStatus("running", 2, "2026-07-25T01:00:00.000Z");
  sendAiSessionStatus("idle", 3, "2026-07-25T01:00:01.000Z");
  const unreadEvent = await waitForCondition(() => receivedEvents.find((entry) => entry.type === AiSessionUnreadEventType.Updated && entry.payload.unread), "completed AI session unread event");
  assert.equal(unreadEvent.payload.sessionId, "ai_1");
  const unreadView = await waitForCondition(async () => {
    const response = await json(controlPlane, "GET", "/api/ai-sessions");
    const session = response.body.data.instances.find((entry) => entry.instanceId === "inst_direct_events")?.aiSessions.sessions[0];
    return session?.unread ? response : undefined;
  }, "completed AI session unread projection");
  assert.equal(unreadView.statusCode, 200);

  sendAiSessionStatus("running", 4, "2026-07-25T01:00:02.000Z");
  const clearedForNewRound = await waitForCondition(() => receivedEvents.find((entry) => entry.type === AiSessionUnreadEventType.Updated && entry.payload.sessionUpdatedAt === "2026-07-25T01:00:02.000Z" && !entry.payload.unread), "new AI session round clears unread");
  assert.equal(clearedForNewRound.payload.unread, false);
  sendAiSessionStatus("failed", 5, "2026-07-25T01:00:03.000Z");
  await waitForCondition(() => receivedEvents.find((entry) => entry.type === AiSessionUnreadEventType.Updated && entry.payload.sessionUpdatedAt === "2026-07-25T01:00:03.000Z" && entry.payload.unread), "failed AI session unread event");
  const read = await json(controlPlane, "POST", "/api/controlled-instances/inst_direct_events/ai-sessions/ai_1/read", {
    sessionUpdatedAt: "2026-07-25T01:00:03.000Z",
  });
  assert.equal(read.statusCode, 200);
  assert.equal(read.body.data.unread, false);
  await waitForCondition(() => receivedEvents.find((entry) => entry.type === AiSessionUnreadEventType.Updated && entry.payload.updatedAt === read.body.data.updatedAt && !entry.payload.unread), "AI session read event");

  const delta = await waitForCondition(async () => {
    const response = await json(controlPlane, "GET", "/api/ai-sessions?instanceId=inst_direct_events&streamId=ai_direct_stream&sinceRevision=0");
    return response.body.data.events.length ? response : undefined;
  }, "ai session delta");
  assert.equal(delta.statusCode, 200);
  assert.equal(delta.body.data.instanceId, "inst_direct_events");
  assert.equal(delta.body.data.syncRequired, false);
  assert.equal(delta.body.data.events.length, 5);
  assert.equal(delta.body.data.events[0].type, AiSessionEventType.Snapshot);
  assert.equal(delta.body.data.events[0].payload.snapshot.sessions[0].id, "ai_1");

  const currentDelta = await json(controlPlane, "GET", "/api/ai-sessions?instanceId=inst_direct_events&streamId=ai_direct_stream&sinceRevision=5");
  assert.equal(currentDelta.statusCode, 200);
  assert.equal(currentDelta.body.data.syncRequired, false);
  assert.deepEqual(currentDelta.body.data.events, []);
});

test("local docker run args include controlled metadata and disable local chat bridges", () => {
  const timestamp = new Date().toISOString();
  const args = dockerRunArgs(
    {
      nodeAgentUrl: "http://127.0.0.1:8091",
      node: {
        id: "node_exec",
        name: "Execution Node",
        connectionMode: "direct-http",
        endpoint: "http://127.0.0.1:8091",
        controlEndpoint: "http://127.0.0.1:8091",
        status: "online",
        health: "ok",
        capabilities: {},
        labels: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      project: {
        id: "proj_1",
        name: "Project",
        source: {
          type: "local-folder",
          path: "/tmp/workspace",
        },
        workspacePolicy: {
          mode: "local-bind",
          path: "/workspace",
          readOnly: false,
        },
        labels: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      image: {
        ...testInstanceImage("task-handoff-web:latest", "img_1", "Image"),
        defaultEnv: {
          EXTRA_FLAG: "1",
        },
      },
      runtime: {
        id: "runtime_local_docker",
        type: "docker",
        name: "Docker",
        endpoint: "unix:///var/run/docker.sock",
        accessStrategy: "direct-port",
        labels: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      instance: {
        id: "inst_1",
        name: "worker",
        projectId: "proj_1",
        runtimeId: "runtime_local_docker",
        imageSelection: { imageId: "img_1" },
        status: "created",
        health: "unknown",
        connectionStatus: "unknown",
        controlMode: "controlled",
        capabilities: {},
        workspace: { status: "unknown" },
        target: { strategy: "direct-port", status: "unknown" },
        apps: { runningCount: 0 },
        runtime: { labels: {} },
        registrationToken: "secret",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
    "task-handoff-inst_1",
  );

  const imageTagIndex = args.indexOf("TASK_HANDOFF_IMAGE_TAG=latest");
  assert.ok(imageTagIndex > 0);
  assert.equal(args[imageTagIndex - 1], "-e");
  assert.equal(args.at(-1), "task-handoff-web:latest");
  for (const [index, arg] of args.entries()) {
    if (/^[A-Z][A-Z0-9_]*=/.test(arg)) assert.equal(args[index - 1], "-e", `${arg} must be passed as a Docker environment variable`);
  }

  assert.ok(args.includes("task-handoff.node-id=node_exec"));
  assert.ok(args.includes("task-handoff.runtime-id=runtime_local_docker"));
  assert.ok(args.includes("task-handoff.image-id=img_1"));
  assert.ok(args.includes("TASK_HANDOFF_NODE_ID=node_exec"));
  assert.ok(args.includes("TASK_HANDOFF_NODE_AGENT_URL=http://127.0.0.1:8091"));
  assert.ok(args.includes("TASK_HANDOFF_RUNTIME_ID=runtime_local_docker"));
  assert.ok(args.includes("TASK_HANDOFF_IMAGE_ID=img_1"));
  assert.ok(args.includes("TASK_HANDOFF_CHAT_BRIDGES=none"));
  assert.ok(args.includes("TASK_HANDOFF_WORKSPACE=/workspace"));
  assert.ok(args.includes("TASK_HANDOFF_WORKSPACE_MODE=local-bind"));
  assert.ok(args.includes("bridge"));
  assert.ok(args.includes("host.docker.internal:host-gateway"));
  assert.ok(args.includes("/tmp:rw,mode=1777"));
  assert.ok(args.includes("task-handoff-inst_1-data:/data"));
  assert.ok(args.includes("task-handoff-inst_1-agent-home:/home/agent"));
  assert.ok(args.includes("EXTRA_FLAG=1"));
  assert.ok(args.includes("/tmp/workspace:/workspace:rw"));
});

test("Node updates compare exact release versions without deriving Docker image updates", () => {
  assert.equal(isNewerVersion("1.2.3", "1.2.4"), true);
  assert.equal(isNewerVersion("1.2.3", "1.2.3-beta.1"), false);
  assert.equal(isNewerVersion("1.2.3-alpha.2", "1.2.3-alpha.10"), true);
  assert.equal(isNewerVersion("1.2.3-alpha.10", "1.2.3-alpha.2"), false);
  assert.equal(isNewerVersion("1.2.3-alpha.1", "1.2.3-alpha.beta"), true);
  assert.equal(isNewerVersion("1.2.3+build.1", "1.2.3+build.2"), false);

  const timestamp = new Date().toISOString();
  const updatedImage = resolvedDockerImageUpdatePatch({
    id: "inst_update",
    imageSnapshot: { requestedReference: "example/app:old", updatedAt: timestamp },
    imageProvisioning: { phase: "ready", requestedReference: "example/app:old", generation: 4, startedAt: timestamp, updatedAt: timestamp },
  }, {
    requestedReference: "example/app:latest",
    resolvedDigest: `sha256:${"c".repeat(64)}`,
    resolvedReference: `example/app@sha256:${"c".repeat(64)}`,
    pulled: false,
  }, timestamp);
  assert.equal(updatedImage.imageSnapshot.resolvedDigest, `sha256:${"c".repeat(64)}`);
  assert.equal(updatedImage.imageSnapshot.resolvedReference, `example/app@sha256:${"c".repeat(64)}`);
  assert.equal(updatedImage.imageProvisioning.requestedReference, "example/app:latest");
  assert.equal(updatedImage.imageProvisioning.generation, 5);
});

test("missing npm channel releases are reported as no update", async () => {
  const npm404 = Object.assign(new Error("npm ERR! code E404"), {
    details: {
      stdout: "",
      stderr: "npm ERR! code E404 npm ERR! 404 No match found for version beta",
    },
  });
  const runCommand = async () => {
    throw npm404;
  };

  const agent = await checkNodeAgentUpdate({
    channel: "beta",
    currentVersion: "1.0.0",
    runCommand,
  });
  assert.equal(agent.supported, true);
  assert.equal(agent.updateAvailable, false);
  assert.equal(agent.availableVersion, "1.0.0");
  assert.equal(agent.reason, "No beta release is currently published.");

});

test("npm update checks preserve non-404 registry failures", async () => {
  const registryError = Object.assign(new Error("npm ERR! code E401"), {
    details: { stdout: "", stderr: "npm ERR! code E401 authentication required" },
  });

  await assert.rejects(
    checkNodeAgentUpdate({
      channel: "beta",
      currentVersion: "1.0.0",
      runCommand: async () => {
        throw registryError;
      },
    }),
    /E401/,
  );
});

test("node update preflight requires immutable npm integrity metadata", async () => {
  await assert.rejects(
    checkNodeAgentUpdate({
      channel: "stable",
      currentVersion: "1.0.0",
      runCommand: async (_command, args) => ({
        stdout: JSON.stringify(args.includes("dist.integrity") ? null : "1.1.0"),
        stderr: "",
      }),
    }),
    (error) => error?.code === "NODE_UPDATE_PREFLIGHT_FAILED",
  );
});

test("node agent update API treats a missing npm channel as no update", async (t) => {
  const globalRoot = tempDataDir("node-agent-update-missing-channel-root");
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-update-missing-channel"),
    logger: false,
    token: "agent-secret",
    updateCommandRunner: async (_command, args) => {
      if (args[0] === "root") return { stdout: globalRoot, stderr: "" };
      throw Object.assign(new Error("npm ERR! code E404"), {
        details: { stdout: "", stderr: "npm ERR! code E404 npm ERR! 404 No match found for version beta" },
      });
    },
  });
  t.after(() => app.close());

  const check = await app.inject({
    method: "POST",
    url: "/api/node-agent/updates/check",
    headers: { authorization: "Bearer agent-secret" },
    payload: { channel: "beta" },
  });
  assert.equal(check.statusCode, 200);
  assert.equal(check.json().data.updateAvailable, false);
  assert.equal(check.json().data.reason, "No beta release is currently published.");

  const apply = await app.inject({
    method: "POST",
    url: "/api/node-agent/updates/apply",
    headers: { authorization: "Bearer agent-secret" },
    payload: { channel: "beta", targetVersion: "1.0.0", preflightToken: "missing_preflight_token" },
  });
  assert.equal(apply.statusCode, 409);
  assert.equal(apply.json().error.code, "UPDATE_PREFLIGHT_EXPIRED");
});

test("retired per-instance update endpoints return 404 without creating jobs", async (t) => {
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-retired-instance-update"),
    logger: false,
    token: "agent-secret",
  });
  t.after(() => app.close());
  for (const suffix of ["check", "apply"]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/node-agent/instances/inst_old/updates/${suffix}`,
      headers: { authorization: "Bearer agent-secret" },
      payload: {},
    });
    assert.equal(response.statusCode, 404);
  }
  const jobs = await app.inject({
    method: "GET",
    url: "/api/node-agent/updates/jobs",
    headers: { authorization: "Bearer agent-secret" },
  });
  assert.deepEqual(jobs.json().data, []);
});

test("control plane rejects the real legacy target-based instance update API as retired", async (t) => {
  const app = await createControlPlaneApp({ dataDir: tempDataDir("control-plane-retired-target-update"), authMode: "disabled" });
  t.after(() => app.close());
  for (const suffix of ["check", "apply"]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/nodes/node_missing/updates/${suffix}`,
      payload: { target: { component: "controlled-instance", instanceId: "inst_old" }, channel: "stable" },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "LEGACY_INSTANCE_UPDATE_RETIRED");
  }
});

test("node agent update checks default to the stable npm channel", async (t) => {
  const calls = [];
  const globalRoot = tempDataDir("node-agent-update-check-root");
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-update-check"),
    logger: false,
    token: "agent-secret",
    updateCommandRunner: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === "root") return { stdout: globalRoot, stderr: "" };
      return { stdout: JSON.stringify(args.includes("dist.integrity") ? npmIntegrityFixture : "9.8.7"), stderr: "" };
    },
    dockerCommandRunner: async (_command, args) => {
      if (args[0] === "info") return { stdout: JSON.stringify({ OSType: "linux", Architecture: "x86_64" }), stderr: "" };
      throw new Error("unexpected Docker command");
    },
    resolveRuntimeArtifact: async (version, platform, arch) => ({
      archivePath: "/cache/runtime.tar.gz",
      cacheHit: false,
      identity: {
        packageName: "@task-handoff/controlled-instance",
        version,
        platform,
        arch,
        formatVersion: 1,
        launcherAbi: 1,
        entrypoint: "dist/controlled-instance-cli.js",
        sha256: "b".repeat(64),
      },
    }),
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/node-agent/updates/check",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.channel, "stable");
  assert.equal(response.json().data.availableVersion, "9.8.7");
  assert.deepEqual(calls, [
    ["npm", ["root", "--global"]],
    ["npm", ["view", "@task-handoff/node-agent@latest", "version", "--json"]],
    ["npm", ["view", "@task-handoff/node-agent@9.8.7", "dist.integrity", "--json"]],
  ]);
});

test("node update preflight excludes Local Runtime artifacts on macOS and reports stopped impact", async (t) => {
  const resolved = [];
  const updateCommands = [];
  const globalRoot = tempDataDir("node-agent-update-runtime-preflight-root");
  let failArtifact = false;
  let artifactSha = "c".repeat(64);
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-update-runtime-preflight"),
    logger: false,
    token: "agent-secret",
    platform: "darwin",
    arch: "arm64",
    dockerCommandRunner: async (_command, args) => {
      if (args[0] === "info") return { stdout: JSON.stringify({ OSType: "linux", Architecture: "x86_64" }), stderr: "" };
      throw new Error("unexpected Docker command");
    },
    updateCommandRunner: async (command, args) => {
      updateCommands.push(command);
      if (args[0] === "root") return { stdout: globalRoot, stderr: "" };
      return { stdout: JSON.stringify(args.includes("dist.integrity") ? npmIntegrityFixture : "9.8.7"), stderr: "" };
    },
    resolveRuntimeArtifact: async (version, platform, arch) => {
      if (failArtifact) throw Object.assign(new Error("runtime artifact missing"), { code: "INSTANCE_RUNTIME_ARTIFACT_UNAVAILABLE", retryable: false });
      resolved.push([version, platform, arch]);
      return {
        archivePath: "/cache/runtime.tar.gz",
        cacheHit: false,
        identity: {
          packageName: "@task-handoff/controlled-instance",
          version,
          platform,
          arch,
          formatVersion: 1,
          launcherAbi: 1,
          entrypoint: "dist/controlled-instance-cli.js",
          sha256: artifactSha,
        },
      };
    },
  });
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_preflight",
      runtimeId: "runtime_local_host",
      projectId: "proj_preflight",
      source: { type: "local-folder", path: "/workspace" },
      sourceSnapshot: {},
    },
  });
  assert.equal(created.statusCode, 201, created.body);

  const response = await app.inject({
    method: "POST",
    url: "/api/node-agent/updates/check",
    headers: { authorization: "Bearer agent-secret" },
    payload: { channel: "stable" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(resolved, [["9.8.7", "linux", "x64"]]);
  assert.equal(response.json().data.impact.stoppedInstanceCount, 1);
  assert.equal(response.json().data.impact.restartInstanceCount, 0);
  assert.deepEqual(response.json().data.runtimeArtifacts.map((artifact) => artifact.version), ["9.8.7"]);
  assert.ok(response.json().data.preflightToken);

  const apply = await app.inject({
    method: "POST",
    url: "/api/node-agent/updates/apply",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      channel: "stable",
      targetVersion: response.json().data.availableVersion,
      preflightToken: response.json().data.preflightToken,
    },
  });
  assert.equal(apply.statusCode, 202, apply.body);
  assert.equal(resolved.length, 2);
  assert.equal(updateCommands.includes("systemd-run"), true);

  const replay = await app.inject({
    method: "POST",
    url: "/api/node-agent/updates/apply",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      channel: "stable",
      targetVersion: response.json().data.availableVersion,
      preflightToken: response.json().data.preflightToken,
    },
  });
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.json().error.code, "UPDATE_PREFLIGHT_EXPIRED");

  failArtifact = false;
  const secondCheck = await app.inject({
    method: "POST",
    url: "/api/node-agent/updates/check",
    headers: { authorization: "Bearer agent-secret" },
    payload: { channel: "stable" },
  });
  const staleTarget = await app.inject({
    method: "POST",
    url: "/api/node-agent/updates/apply",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      channel: "stable",
      targetVersion: "9.8.8",
      preflightToken: secondCheck.json().data.preflightToken,
    },
  });
  assert.equal(staleTarget.statusCode, 409);
  assert.equal(staleTarget.json().error.code, "UPDATE_PREFLIGHT_STALE");

  const thirdCheck = await app.inject({
    method: "POST",
    url: "/api/node-agent/updates/check",
    headers: { authorization: "Bearer agent-secret" },
    payload: { channel: "stable" },
  });
  const beforeImpactChange = app.nodeAgentState.controlledInstances.get("inst_preflight");
  app.nodeAgentState.controlledInstances.put(ControlledInstanceSchema.parse({
    ...beforeImpactChange,
    status: "running",
    updatedAt: new Date().toISOString(),
  }));
  const staleImpact = await app.inject({
    method: "POST",
    url: "/api/node-agent/updates/apply",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      channel: "stable",
      targetVersion: thirdCheck.json().data.availableVersion,
      preflightToken: thirdCheck.json().data.preflightToken,
    },
  });
  assert.equal(staleImpact.statusCode, 409);
  assert.equal(staleImpact.json().error.code, "UPDATE_PREFLIGHT_STALE");

  const artifactCheck = await app.inject({
    method: "POST",
    url: "/api/node-agent/updates/check",
    headers: { authorization: "Bearer agent-secret" },
    payload: { channel: "stable" },
  });
  artifactSha = "e".repeat(64);
  const staleArtifact = await app.inject({
    method: "POST",
    url: "/api/node-agent/updates/apply",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      channel: "stable",
      targetVersion: artifactCheck.json().data.availableVersion,
      preflightToken: artifactCheck.json().data.preflightToken,
    },
  });
  assert.equal(staleArtifact.statusCode, 409);
  assert.equal(staleArtifact.json().error.code, "UPDATE_PREFLIGHT_STALE");
});

test("node agent update checks use the configured absolute npm command", async (t) => {
  const previous = process.env.TASK_HANDOFF_NPM_COMMAND;
  process.env.TASK_HANDOFF_NPM_COMMAND = "/opt/node/bin/npm";
  t.after(() => {
    if (previous === undefined) delete process.env.TASK_HANDOFF_NPM_COMMAND;
    else process.env.TASK_HANDOFF_NPM_COMMAND = previous;
  });
  const calls = [];

  const result = await checkNodeAgentUpdate({
    channel: "beta",
    currentVersion: "1.0.0",
    runCommand: async (command, args) => {
      calls.push([command, args]);
      return { stdout: JSON.stringify(args.includes("dist.integrity") ? npmIntegrityFixture : "1.1.0-beta.1"), stderr: "" };
    },
  });

  assert.equal(result.updateAvailable, true);
  assert.deepEqual(calls, [
    ["/opt/node/bin/npm", ["view", "@task-handoff/node-agent@beta", "version", "--json"]],
    ["/opt/node/bin/npm", ["view", "@task-handoff/node-agent@1.1.0-beta.1", "dist.integrity", "--json"]],
  ]);
});

test("node update checks use the package that owns the installed service launcher", async () => {
  const globalRoot = tempDataDir("node-update-package-resolution");
  const serverRoot = path.join(globalRoot, "@task-handoff", "server");
  const nodeAgentRoot = path.join(globalRoot, "@task-handoff", "node-agent");
  fs.mkdirSync(serverRoot, { recursive: true });
  fs.mkdirSync(nodeAgentRoot, { recursive: true });
  fs.writeFileSync(path.join(serverRoot, "package.json"), JSON.stringify({ name: "@task-handoff/server", version: "1.0.0" }));
  fs.writeFileSync(path.join(nodeAgentRoot, "package.json"), JSON.stringify({ name: "@task-handoff/node-agent", version: "0.9.0" }));
  const calls = [];
  const result = await checkNodeAgentUpdate({
    channel: "stable",
    currentVersion: "1.0.0",
    packageName: "@task-handoff/server",
    relatedCurrentVersions: ["0.9.0"],
    runCommand: async (command, args) => {
      calls.push([command, args]);
      return { stdout: JSON.stringify(args.includes("dist.integrity") ? npmIntegrityFixture : "1.1.0"), stderr: "" };
    },
  });

  assert.equal(result.artifactRef, `npm:@task-handoff/server@1.1.0#${npmIntegrityFixture}`);
  assert.deepEqual(calls.map(([, args]) => args), [
    ["view", "@task-handoff/server@latest", "version", "--json"],
    ["view", "@task-handoff/server@1.1.0", "dist.integrity", "--json"],
  ]);
  assert.deepEqual(await resolveNodeUpdatePackage(async (_command, args) => {
    assert.deepEqual(args, ["root", "--global"]);
    return { stdout: `${globalRoot}\n`, stderr: "" };
  }), { packageName: "@task-handoff/server", currentVersion: "1.0.0", relatedCurrentVersions: ["0.9.0"] });
  fs.rmSync(serverRoot, { recursive: true });
  fs.rmSync(nodeAgentRoot, { recursive: true });
  assert.deepEqual(await resolveNodeUpdatePackage(async () => ({ stdout: globalRoot, stderr: "" })), {
    packageName: "@task-handoff/node-agent",
    currentVersion: undefined,
    relatedCurrentVersions: [],
  });

  const companionOnly = await checkNodeAgentUpdate({
    channel: "stable",
    currentVersion: "1.1.0",
    packageName: "@task-handoff/server",
    relatedCurrentVersions: ["1.0.0"],
    runCommand: async (_command, args) => ({
      stdout: JSON.stringify(args.includes("dist.integrity") ? npmIntegrityFixture : "1.1.0"),
      stderr: "",
    }),
  });
  assert.equal(companionOnly.updateAvailable, true);
});

test("node agent resolves update workers in source and bundled runtime layouts", () => {
  const root = tempDataDir("node-agent-worker-layouts");
  const sourceModuleDir = path.join(root, "packages", "control-plane", "src", "node-agent");
  const sourceWorker = path.join(root, "scripts", "node-update-worker.cjs");
  fs.mkdirSync(sourceModuleDir, { recursive: true });
  fs.mkdirSync(path.dirname(sourceWorker), { recursive: true });
  fs.writeFileSync(sourceWorker, "// source worker\n");
  assert.deepEqual(resolveNodeAgentUpdateWorker(sourceModuleDir), {
    worker: sourceWorker,
    packaged: false,
    expectedWorker: path.join(root, "packages", "control-plane", "src", "bin", "task-handoff-node-update-worker"),
  });

  const packageRoot = path.join(root, "release", "npm", "node-agent");
  const distModuleDir = path.join(packageRoot, "dist");
  const packagedWorker = path.join(packageRoot, "bin", "task-handoff-node-update-worker");
  fs.mkdirSync(distModuleDir, { recursive: true });
  fs.mkdirSync(path.dirname(packagedWorker), { recursive: true });
  fs.writeFileSync(packagedWorker, "#!/usr/bin/env node\n");
  assert.deepEqual(resolveNodeAgentUpdateWorker(distModuleDir), {
    worker: packagedWorker,
    packaged: true,
    expectedWorker: packagedWorker,
  });
});

test("node agent update apply launches the resolved worker through systemd-run", async (t) => {
  const calls = [];
  const globalRoot = tempDataDir("node-agent-update-apply-worker-root");
  const previousHealthUrl = process.env.TASK_HANDOFF_CONTROL_PLANE_HEALTH_URL;
  process.env.TASK_HANDOFF_CONTROL_PLANE_HEALTH_URL = "http://127.0.0.1:8081/api/health";
  t.after(() => {
    if (previousHealthUrl === undefined) delete process.env.TASK_HANDOFF_CONTROL_PLANE_HEALTH_URL;
    else process.env.TASK_HANDOFF_CONTROL_PLANE_HEALTH_URL = previousHealthUrl;
  });
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-update-apply-worker"),
    logger: false,
    token: "agent-secret",
    updateCommandRunner: async (command, args) => {
      calls.push([command, args]);
      if (command === "npm" && args[0] === "root") return { stdout: globalRoot, stderr: "" };
      return command === "npm" ? { stdout: JSON.stringify(args.includes("dist.integrity") ? npmIntegrityFixture : "9.8.7"), stderr: "" } : { stdout: "", stderr: "" };
    },
    platform: "linux",
    arch: "x64",
    dockerCommandRunner: async (_command, args) => {
      if (args[0] === "info") return { stdout: JSON.stringify({ OSType: "linux", Architecture: "x86_64" }), stderr: "" };
      throw new Error("unexpected Docker command");
    },
    resolveRuntimeArtifact: async (version, platform, arch) => ({
      archivePath: "/cache/runtime.tar.gz",
      cacheHit: false,
      identity: {
        packageName: "@task-handoff/controlled-instance",
        version,
        platform,
        arch,
        formatVersion: 1,
        launcherAbi: 1,
        entrypoint: "dist/controlled-instance-cli.js",
        sha256: "d".repeat(64),
      },
    }),
  });
  t.after(() => app.close());

  const check = await app.inject({
    method: "POST",
    url: "/api/node-agent/updates/check",
    headers: { authorization: "Bearer agent-secret" },
    payload: { channel: "stable" },
  });
  assert.equal(check.statusCode, 200, check.body);
  const response = await app.inject({
    method: "POST",
    url: "/api/node-agent/updates/apply",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      channel: "stable",
      targetVersion: check.json().data.availableVersion,
      preflightToken: check.json().data.preflightToken,
    },
  });
  assert.equal(response.statusCode, 202);
  assert.equal(calls.length, 5);
  assert.equal(calls[4][0], "systemd-run");
  const args = calls[4][1];
  const propertyIndex = args.indexOf("--property=Type=exec");
  assert.equal(args[propertyIndex + 1], process.execPath);
  assert.equal(args[propertyIndex + 2], path.resolve(__dirname, "..", "scripts", "node-update-worker.cjs"));
  assert.equal(args[args.indexOf("--target-version") + 1], "9.8.7");
  assert.equal(args[args.indexOf("--npm-command") + 1], "npm");
  assert.equal(args[args.indexOf("--control-plane-health-url") + 1], "http://127.0.0.1:8081/api/health");
});

test("local docker run args include resolved model environment", () => {
  const timestamp = new Date().toISOString();
  const args = dockerRunArgs(
    {
      nodeAgentUrl: "http://127.0.0.1:8091",
      modelEnv: {
        OPENAI_API_KEY: "codex-key",
        OPENAI_BASE_URL: "https://openai.example/v1",
        TASK_HANDOFF_CODEX_BASE_URL: "https://openai.example/v1",
        TASK_HANDOFF_CODEX_MODEL: "gpt-codex",
        ANTHROPIC_API_KEY: "claude-key",
        ANTHROPIC_BASE_URL: "https://anthropic.example",
        TASK_HANDOFF_CLAUDE_MODEL: "claude-sonnet",
      },
      project: {
        id: "proj_1",
        name: "Project",
        source: {
          type: "local-folder",
          path: "/tmp/workspace",
        },
        workspacePolicy: {
          mode: "local-bind",
          path: "/workspace",
          readOnly: false,
        },
        labels: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      image: testInstanceImage("task-handoff-web:latest", "img_1", "Image"),
      runtime: {
        id: "runtime_local_docker",
        type: "docker",
        name: "Docker",
        endpoint: "unix:///var/run/docker.sock",
        accessStrategy: "direct-port",
        labels: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      instance: {
        id: "inst_1",
        name: "worker",
        projectId: "proj_1",
        runtimeId: "runtime_local_docker",
        imageSelection: { imageId: "img_1" },
        status: "created",
        health: "unknown",
        connectionStatus: "unknown",
        controlMode: "controlled",
        capabilities: {},
        workspace: { status: "unknown" },
        target: { strategy: "direct-port", status: "unknown" },
        apps: { runningCount: 0 },
        runtime: { labels: {} },
        registrationToken: "secret",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
    "task-handoff-inst_1",
  );

  assert.ok(args.includes("OPENAI_API_KEY=codex-key"));
  assert.ok(args.includes("OPENAI_BASE_URL=https://openai.example/v1"));
  assert.ok(args.includes("TASK_HANDOFF_CODEX_BASE_URL=https://openai.example/v1"));
  assert.ok(args.includes("TASK_HANDOFF_CODEX_MODEL=gpt-codex"));
  assert.ok(args.includes("ANTHROPIC_API_KEY=claude-key"));
  assert.ok(args.includes("ANTHROPIC_BASE_URL=https://anthropic.example"));
  assert.ok(args.includes("TASK_HANDOFF_CLAUDE_MODEL=claude-sonnet"));
});

test("local docker run args expose git workspace bootstrap environment", () => {
  const timestamp = new Date().toISOString();
  const args = dockerRunArgs(
    {
      nodeAgentUrl: "http://127.0.0.1:8091",
      project: {
        id: "proj_git",
        name: "Git Project",
        source: {
          type: "git-repository",
          url: "https://github.com/example/repo.git",
          ref: { type: "branch", name: "main" },
          auth: { type: "none" },
          clone: { depth: 10, submodules: true, lfs: false, subdirectory: "" },
        },
        workspacePolicy: {
          mode: "git-clone",
          path: "/workspace",
          readOnly: false,
        },
        labels: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      image: testInstanceImage("task-handoff-web:latest", "img_1", "Image"),
      runtime: {
        id: "runtime_local_docker",
        type: "docker",
        name: "Docker",
        endpoint: "unix:///var/run/docker.sock",
        accessStrategy: "direct-port",
        labels: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      instance: {
        id: "inst_git",
        name: "git-worker",
        projectId: "proj_git",
        runtimeId: "runtime_local_docker",
        imageSelection: { imageId: "img_1" },
        status: "created",
        health: "unknown",
        connectionStatus: "unknown",
        controlMode: "controlled",
        capabilities: {},
        workspace: { status: "unknown" },
        target: { strategy: "direct-port", status: "unknown" },
        apps: { runningCount: 0 },
        runtime: { labels: {} },
        registrationToken: "secret",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
    "task-handoff-inst_git",
  );

  assert.ok(args.includes("TASK_HANDOFF_WORKSPACE=/workspace"));
  assert.ok(args.includes("TASK_HANDOFF_WORKSPACE_MODE=git-clone"));
  assert.ok(args.includes("TASK_HANDOFF_GIT_URL=https://github.com/example/repo.git"));
  assert.ok(args.includes("TASK_HANDOFF_GIT_REF=main"));
  assert.ok(args.includes("TASK_HANDOFF_GIT_DEPTH=10"));
  assert.ok(args.includes("TASK_HANDOFF_GIT_SUBMODULES=true"));
  assert.ok(args.includes("TASK_HANDOFF_GIT_LFS=false"));
});

test("local docker executor checks local images and pulls registry images before running", async () => {
  const timestamp = new Date().toISOString();
  const baseContext = {
    nodeAgentUrl: "http://127.0.0.1:8091",
    project: {
      id: "proj_1",
      name: "Project",
      source: {
        type: "local-folder",
        path: "/tmp/workspace",
      },
      workspacePolicy: {
        mode: "local-bind",
        path: "/workspace",
        readOnly: false,
      },
      labels: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    runtime: {
      id: "runtime_local_docker",
      type: "docker",
      name: "Docker",
      endpoint: "unix:///var/run/docker.sock",
      accessStrategy: "direct-port",
      labels: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    instance: {
      id: "inst_1",
      name: "worker",
      projectId: "proj_1",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_1" },
      status: "created",
      health: "unknown",
      connectionStatus: "unknown",
      controlMode: "controlled",
      capabilities: {},
      workspace: { status: "unknown" },
      target: { strategy: "direct-port", status: "unknown" },
      apps: { runningCount: 0 },
      runtime: { labels: {} },
      registrationToken: "secret",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    image: {
      id: "img_1",
      name: "Image",
      requestedReference: "task-handoff-web:local",
      pullPolicy: "if-not-present",
      capabilities: [],
      optionalApps: [],
      defaultEnv: {},
      labels: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };

  const localCalls = [];
  const localExecutor = new LocalDockerExecutor(async (command, args) => {
    localCalls.push([command, args]);
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      throw Object.assign(new Error("No such container"), { details: { stderr: "No such container" } });
    }
    if (args[0] === "image" && args[1] === "inspect") {
      throw new Error("missing");
    }
    return { stdout: "", stderr: "" };
  });
  await assert.rejects(
    () =>
      localExecutor.start({
        ...baseContext,
        image: {
          id: "img_1",
          name: "Image",
          requestedReference: "task-handoff-web:local",
          pullPolicy: "if-not-present",
          capabilities: [],
          optionalApps: [],
          defaultEnv: {},
          labels: {},
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      }),
    /missing/,
  );
  assert.deepEqual(localCalls, [
    ["docker", ["inspect", "--format", "{{json .}}", "task-handoff-inst_1"]],
    ["docker", ["image", "inspect", "task-handoff-web:local", "--format", "{{json .}}"]],
    ["docker", ["pull", "task-handoff-web:local"]],
    ["docker", ["image", "inspect", "task-handoff-web:local", "--format", "{{json .}}"]],
  ]);

  const remoteCalls = [];
  let remotePulled = false;
  const remoteExecutor = new LocalDockerExecutor(async (command, args) => {
    remoteCalls.push([command, args]);
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      throw Object.assign(new Error("No such container"), { details: { stderr: "No such container" } });
    }
    if (args[0] === "image" && args[1] === "inspect") {
      if (!remotePulled) throw new Error("missing");
      return {
        stdout: JSON.stringify({
          Id: `sha256:${"a".repeat(64)}`,
          RepoDigests: [`ghcr.io/example/task-handoff-web@sha256:${"a".repeat(64)}`],
        }),
        stderr: "",
      };
    }
    if (args[0] === "pull") {
      remotePulled = true;
      return { stdout: "pulled", stderr: "" };
    }
    if (args[0] === "run") {
      return { stdout: "container-1", stderr: "" };
    }
    if (args[0] === "port") {
      return { stdout: "127.0.0.1:18080", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  const started = await remoteExecutor.start({
    ...baseContext,
    image: {
      id: "img_2",
      name: "Registry Image",
          requestedReference: "ghcr.io/example/task-handoff-web:latest",
          pullPolicy: "if-not-present",
      capabilities: [],
      optionalApps: [],
      defaultEnv: {},
      labels: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
  assert.equal(started.runtime.containerId, "container-1");
  assert.deepEqual(
    remoteCalls.slice(0, 4),
    [
      ["docker", ["inspect", "--format", "{{json .}}", "task-handoff-inst_1"]],
      ["docker", ["image", "inspect", "ghcr.io/example/task-handoff-web:latest", "--format", "{{json .}}"]],
      ["docker", ["pull", "ghcr.io/example/task-handoff-web:latest"]],
      ["docker", ["image", "inspect", "ghcr.io/example/task-handoff-web:latest", "--format", "{{json .}}"]],
    ],
  );
  assert.ok(remoteCalls.some(([, args]) => args[0] === "run"));
  assert.equal(remoteCalls.some(([, args]) => args[0] === "rm"), false);

  const resolvedReference = `ghcr.io/example/task-handoff-web@sha256:${"b".repeat(64)}`;
  const resolvedCalls = [];
  const resolvedExecutor = new LocalDockerExecutor(async (command, args) => {
    resolvedCalls.push([command, args]);
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      throw Object.assign(new Error("No such container"), { details: { stderr: "No such container" } });
    }
    if (args[0] === "image" && args[1] === "inspect") {
      assert.equal(args[2], resolvedReference);
      return { stdout: JSON.stringify({ Id: `sha256:${"b".repeat(64)}`, RepoDigests: [resolvedReference] }), stderr: "" };
    }
    if (args[0] === "run") return { stdout: "container-resolved", stderr: "" };
    if (args[0] === "port") return { stdout: "127.0.0.1:18082", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  await resolvedExecutor.start({
    ...baseContext,
    image: {
      id: "img_resolved",
      name: "Resolved image",
      requestedReference: "ghcr.io/example/task-handoff-web:latest",
      resolvedReference,
      resolvedDigest: `sha256:${"b".repeat(64)}`,
      pullPolicy: "if-not-present",
      capabilities: [],
      optionalApps: [],
      defaultEnv: {},
      labels: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
  assert.equal(resolvedCalls.some(([, args]) => args[0] === "pull"), false);
  assert.equal(resolvedCalls.find(([, args]) => args[0] === "run")[1].at(-1), resolvedReference);

  const existingCalls = [];
  const existingExecutor = new LocalDockerExecutor(async (command, args) => {
    existingCalls.push([command, args]);
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      return { stdout: JSON.stringify({ Id: "container-1", Config: { Labels: { "task-handoff.instance-id": "inst_1" } } }), stderr: "" };
    }
    if (args[0] === "port") {
      return { stdout: "127.0.0.1:18081", stderr: "" };
    }
    return { stdout: "task-handoff-inst_1", stderr: "" };
  });
  const resumed = await existingExecutor.start({
    ...baseContext,
    instance: {
      ...baseContext.instance,
      status: "stopped",
      runtime: {
        kind: "docker",
        containerName: "task-handoff-inst_1",
        containerId: "container-1",
        labels: {},
      },
    },
    image: {
      id: "img_2",
      name: "Registry Image",
      requestedReference: "ghcr.io/example/task-handoff-web:latest",
      capabilities: [],
      optionalApps: [],
      defaultEnv: {},
      labels: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
  assert.equal(resumed.runtime.containerId, "container-1");
  assert.equal(resumed.target.web, "http://127.0.0.1:18081");
  assert.deepEqual(existingCalls, [
    ["docker", ["inspect", "--format", "{{json .}}", "task-handoff-inst_1"]],
    ["docker", ["start", "task-handoff-inst_1"]],
    ["docker", ["port", "task-handoff-inst_1", "8080/tcp"]],
  ]);

  const inspectFallbackExecutor = new LocalDockerExecutor(async (_command, args) => {
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      return { stdout: JSON.stringify({ Id: "container-1", Config: { Labels: { "task-handoff.instance-id": "inst_1" } } }), stderr: "" };
    }
    if (args[0] === "port") {
      throw Object.assign(new Error("no public port '8080/tcp' published"), { details: { stderr: "no public port '8080/tcp' published" } });
    }
    if (args[0] === "inspect" && args.includes("{{json .NetworkSettings.Ports}}")) {
      return { stdout: JSON.stringify({ "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "28081" }] }), stderr: "" };
    }
    return { stdout: "task-handoff-inst_1", stderr: "" };
  }, { portResolutionRetryDelaysMs: [0] });
  const resumedFromInspection = await inspectFallbackExecutor.start({
    ...baseContext,
    instance: {
      ...baseContext.instance,
      status: "stopped",
      runtime: {
        kind: "docker",
        containerName: "task-handoff-inst_1",
        containerId: "container-1",
        labels: {},
      },
    },
  });
  assert.equal(resumedFromInspection.target.web, "http://127.0.0.1:28081");

  let transientPortAttempts = 0;
  const transientPortExecutor = new LocalDockerExecutor(async (_command, args) => {
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      return { stdout: JSON.stringify({ Id: "container-1", Config: { Labels: { "task-handoff.instance-id": "inst_1" } } }), stderr: "" };
    }
    if (args[0] === "port") {
      transientPortAttempts += 1;
      if (transientPortAttempts < 3) {
        throw Object.assign(new Error("no public port '8080/tcp' published"), { details: { stderr: "no public port '8080/tcp' published" } });
      }
      return { stdout: "127.0.0.1:38081", stderr: "" };
    }
    if (args[0] === "inspect" && args.includes("{{json .NetworkSettings.Ports}}")) {
      return { stdout: JSON.stringify({ "8080/tcp": null }), stderr: "" };
    }
    return { stdout: "task-handoff-inst_1", stderr: "" };
  }, { portResolutionRetryDelaysMs: [0, 0, 0] });
  const resumedAfterRetry = await transientPortExecutor.start({
    ...baseContext,
    instance: {
      ...baseContext.instance,
      status: "stopped",
      runtime: {
        kind: "docker",
        containerName: "task-handoff-inst_1",
        containerId: "container-1",
        labels: {},
      },
    },
  });
  assert.equal(transientPortAttempts, 3);
  assert.equal(resumedAfterRetry.target.web, "http://127.0.0.1:38081");

  const missingPortExecutor = new LocalDockerExecutor(async (_command, args) => {
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      return { stdout: JSON.stringify({ Id: "container-1", Config: { Labels: { "task-handoff.instance-id": "inst_1" } } }), stderr: "" };
    }
    if (args[0] === "port") {
      throw Object.assign(new Error("no public port '8080/tcp' published"), { details: { stderr: "no public port '8080/tcp' published" } });
    }
    if (args[0] === "inspect" && args.includes("{{json .NetworkSettings.Ports}}")) {
      return { stdout: JSON.stringify({ "8080/tcp": null }), stderr: "" };
    }
    return { stdout: "task-handoff-inst_1", stderr: "" };
  }, { portResolutionRetryDelaysMs: [0, 0] });
  await assert.rejects(
    () => missingPortExecutor.start({
      ...baseContext,
      instance: {
        ...baseContext.instance,
        status: "stopped",
        runtime: {
          kind: "docker",
          containerName: "task-handoff-inst_1",
          containerId: "container-1",
          labels: {},
        },
      },
    }),
    /does not publish 8080\/tcp/,
  );

  const daemonCalls = [];
  const daemonErrorExecutor = new LocalDockerExecutor(async (_command, args) => {
    daemonCalls.push(args);
    throw Object.assign(new Error("Cannot connect to the Docker daemon"), { details: { stderr: "Cannot connect to the Docker daemon" } });
  });
  await assert.rejects(() => daemonErrorExecutor.start(baseContext), /Cannot connect to the Docker daemon/);
  assert.deepEqual(daemonCalls, [["inspect", "--format", "{{json .}}", "task-handoff-inst_1"]]);

  const wrongOwnerCalls = [];
  const wrongOwnerExecutor = new LocalDockerExecutor(async (_command, args) => {
    wrongOwnerCalls.push(args);
    return { stdout: JSON.stringify({ Id: "container-foreign", Config: { Labels: { "task-handoff.instance-id": "inst_foreign" } } }), stderr: "" };
  });
  await assert.rejects(() => wrongOwnerExecutor.start(baseContext), /belongs to inst_foreign/);
  assert.equal(wrongOwnerCalls.some((args) => args[0] === "start"), false);

  const stopErrorExecutor = new LocalDockerExecutor(async () => {
    throw Object.assign(new Error("permission denied"), { details: { stderr: "permission denied" } });
  });
  await assert.rejects(() => stopErrorExecutor.stop(baseContext), /permission denied/);

  const restartCalls = [];
  const restartExecutor = new LocalDockerExecutor(async (command, args) => {
    restartCalls.push([command, args]);
    if (args[0] === "inspect") {
      return { stdout: "container-1", stderr: "" };
    }
    if (args[0] === "port") {
      return { stdout: "127.0.0.1:19090", stderr: "" };
    }
    return { stdout: "task-handoff-inst_1", stderr: "" };
  });
  const restarted = await restartExecutor.restart({
    ...baseContext,
    instance: {
      ...baseContext.instance,
      status: "running",
      runtime: {
        kind: "docker",
        containerName: "task-handoff-inst_1",
        containerId: "container-1",
        labels: {},
      },
    },
    image: {
      id: "img_2",
      name: "Registry Image",
      requestedReference: "ghcr.io/example/task-handoff-web:latest",
      capabilities: [],
      optionalApps: [],
      defaultEnv: {},
      labels: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
  assert.equal(restarted.runtime.containerId, "container-1");
  assert.equal(restarted.target.web, "http://127.0.0.1:19090");
  assert.deepEqual(restartCalls, [
    ["docker", ["inspect", "--format", "{{.Id}}", "task-handoff-inst_1"]],
    ["docker", ["restart", "task-handoff-inst_1"]],
    ["docker", ["inspect", "--format", "{{.Id}}", "task-handoff-inst_1"]],
    ["docker", ["port", "task-handoff-inst_1", "8080/tcp"]],
  ]);
});

test("node agent runs local docker behind node-local target and auto-imports agent config on start and restart", async (t) => {
  const calls = [];
  const fetchCalls = [];
  let containerExists = false;
  const desiredRuntimeVersion = runtimeVersionStateForActual().desiredVersion;
  let app;
  app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-local-endpoint"),
    logger: false,
    token: "agent-secret",
    platform: "linux",
    arch: "arm64",
    port: 18091,
    resolveRuntimeArtifact: async (version, platform, arch) => ({
      archivePath: "/cache/controlled-instance-runtime.tar.gz",
      cacheHit: true,
      identity: {
        packageName: "@task-handoff/controlled-instance",
        version,
        platform,
        arch,
        formatVersion: 1,
        launcherAbi: 1,
        entrypoint: "dist/controlled-instance-cli.js",
        sha256: "a".repeat(64),
      },
    }),
    fetchImpl: async (url, init = {}) => {
      fetchCalls.push({ url: String(url), method: init.method || "GET" });
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    dockerCommandRunner: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === "inspect" && args.includes("{{json .}}") && !containerExists) {
        throw Object.assign(new Error("No such container"), { details: { stderr: "No such container" } });
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: JSON.stringify({ Id: `sha256:${"b".repeat(64)}`, RepoDigests: [`task-handoff-web@sha256:${"b".repeat(64)}`], Os: "linux", Architecture: "arm64" }), stderr: "" };
      }
      if (args[0] === "run") {
        containerExists = true;
        return { stdout: "container-1", stderr: "" };
      }
      if (args[0] === "port") {
        return { stdout: "0.0.0.0:18080", stderr: "" };
      }
      if (args[0] === "inspect" && args.includes("{{json .}}")) {
        return { stdout: JSON.stringify({ Id: "container-1", Platform: "linux", Image: "sha256:image", Config: { Labels: { "task-handoff.instance-id": "inst_1" } } }), stderr: "" };
      }
      if (args[0] === "inspect") {
        return { stdout: "container-1", stderr: "" };
      }
      if (args[0] === "exec" && args.includes("verify-active")) {
        return { stdout: JSON.stringify(resolvedRuntimeArtifact(desiredRuntimeVersion, "linux", "arm64").identity), stderr: "" };
      }
      if (args[0] === "restart" && app) {
        const instance = app.nodeAgentState.controlledInstances.get("inst_1");
          setImmediate(() => app.nodeAgentState.registerInstance("inst_1", {
            instanceId: "inst_1",
            protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
            appInventory: emptyAppInventory(),
            controlMode: "controlled",
            capabilities: {},
            build: { component: "controlled-instance", packageVersion: desiredRuntimeVersion },
            target: { strategy: "direct-port", status: "reachable", web: "http://127.0.0.1:18080" },
            workspace: { status: "ready" },
          }, instance.registrationToken));
      }
      return { stdout: "", stderr: "" };
    },
  });
  t.after(() => app.close());

  const health = await app.inject({
    method: "GET",
    url: "/api/node-agent/health",
    headers: {
      authorization: "Bearer agent-secret",
    },
  });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().data.role, "node-agent");
  assert.equal(health.json().data.platform, "linux");
  assert.equal(health.json().data.protocolVersion, CONTROL_PLANE_PROTOCOL_VERSION);
  assert.equal(health.json().data.build.component, "node-agent");
  assert.equal(health.json().data.build.protocolVersion, CONTROL_PLANE_PROTOCOL_VERSION);
  assert.equal(health.json().data.endpoint, undefined);
  assert.equal(health.json().data.controlEndpoint, undefined);
  assert.equal(health.json().data.containerUrl, undefined);
  assert.equal(health.json().data.containerEndpoint, undefined);

  const timestamp = new Date().toISOString();
  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: {
      authorization: "Bearer agent-secret",
    },
    payload: {
      id: "inst_1",
      name: "worker",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_1" },
      image: testInstanceImage("task-handoff-web:local", "img_1", "Image"),
      source: {
        type: "git-repository",
        url: "https://github.com/example/repo.git",
      },
      sourceSnapshot: {
        id: "proj_1",
        name: "Git Project",
      },
    },
  });
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  assert.equal(created.json().data.config.defaultCodexPermissionMode, "full-access");
  await waitForCondition(
    () => app.nodeAgentState.controlledInstances.get("inst_1")?.status === "created",
    "image provisioning",
  );

  const response = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_1/start",
    headers: {
      authorization: "Bearer agent-secret",
    },
    payload: {},
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.data.target.web, "http://127.0.0.1:18080");
  assert.deepEqual(
    fetchCalls
      .map((call) => `${call.method} ${new URL(call.url).pathname}`)
      .filter((call) => call === "GET /api/health" || call.startsWith("POST /api/config-sync/import/")),
    [
      "GET /api/health",
      "POST /api/config-sync/import/codex",
      "POST /api/config-sync/import/claude",
    ],
  );
  assert.ok(calls.some(([, args]) => args[0] === "run" && args.includes("127.0.0.1::8080")));
  assert.ok(calls.some(([, args]) => args[0] === "run" && args.includes("TASK_HANDOFF_NODE_AGENT_URL=http://host.docker.internal:18091")));

  fetchCalls.length = 0;
  const restarted = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_1/restart",
    headers: {
      authorization: "Bearer agent-secret",
    },
    payload: {},
  });
  assert.equal(restarted.statusCode, 200);
  assert.deepEqual(
    fetchCalls
      .map((call) => `${call.method} ${new URL(call.url).pathname}`)
      .filter((call) => call === "GET /api/health" || call.startsWith("POST /api/config-sync/import/")),
    [
      "GET /api/health",
      "POST /api/config-sync/import/codex",
      "POST /api/config-sync/import/claude",
    ],
  );
});

test("node agent keeps a managed instance started when startup runtime convergence fails", async (t) => {
  const calls = [];
  let containerExists = false;
  let artifactResolutions = 0;
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-start-runtime-convergence-failure"),
    logger: false,
    token: "agent-secret",
    resolveRuntimeArtifact: async () => {
      artifactResolutions += 1;
      throw Object.assign(new Error("runtime artifact unavailable"), {
        code: "INSTANCE_RUNTIME_ARTIFACT_UNAVAILABLE",
        retryable: false,
      });
    },
    dockerCommandRunner: async (_command, args) => {
      calls.push(args);
      if (args[0] === "inspect" && args.includes("{{json .}}") && !containerExists) {
        throw Object.assign(new Error("No such container"), { details: { stderr: "No such container" } });
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: JSON.stringify({ Id: `sha256:${"f".repeat(64)}`, RepoDigests: [`task-handoff-web@sha256:${"f".repeat(64)}`], Os: "linux", Architecture: "amd64" }), stderr: "" };
      }
      if (args[0] === "run") {
        containerExists = true;
        return { stdout: "container-start-fallback", stderr: "" };
      }
      if (args[0] === "port") return { stdout: "0.0.0.0:18183", stderr: "" };
      if (args[0] === "inspect" && args.includes("{{json .}}")) {
        return { stdout: JSON.stringify({ Id: "container-start-fallback", Platform: "linux", Image: "sha256:image", Config: { Labels: { "task-handoff.instance-id": "inst_start_fallback" } } }), stderr: "" };
      }
      return { stdout: "container-start-fallback", stderr: "" };
    },
    fetchImpl: async () => new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_start_fallback",
      name: "worker",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_1" },
      image: testInstanceImage("task-handoff-web:local", "img_1", "Image"),
      source: { type: "git-repository", url: "https://github.com/example/repo.git" },
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  await waitForCondition(
    () => app.nodeAgentState.controlledInstances.get("inst_start_fallback")?.status === "created",
    "runtime convergence fallback image provisioning",
  );

  const started = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_start_fallback/start",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });

  assert.equal(started.statusCode, 200, started.body);
  assert.equal(started.json().data.status, "registering");
  assert.equal(started.json().data.target.status, "reachable");
  assert.equal(started.json().data.workspace.error, undefined);
  assert.equal(started.json().data.runtimeVersion.phase, "failed");
  assert.equal(started.json().data.runtimeVersion.error.code, "INSTANCE_RUNTIME_ARTIFACT_UNAVAILABLE");
  assert.ok(calls.some((args) => args[0] === "run"), "the instance container must remain started");

  const attemptsAfterStart = artifactResolutions;
  await app.nodeAgentRecoverManagedInstances();
  await app.nodeAgentRecoverManagedInstances();
  assert.equal(artifactResolutions, attemptsAfterStart, "passive recovery must not reset a failed run attempt budget");

  const restarted = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_start_fallback/restart",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(restarted.statusCode, 200, restarted.body);
  assert.equal(restarted.json().data.runtimeVersion.phase, "failed");
  assert.equal(artifactResolutions, attemptsAfterStart + 1, "an explicit restart creates a fresh convergence budget");

  const lifecycleStartsAfterRequest = calls.filter((args) => ["run", "start"].includes(args[0])).length;
  await app.nodeAgentRestoreManagedInstances();
  assert.equal(
    calls.filter((args) => ["run", "start"].includes(args[0])).length,
    lifecycleStartsAfterRequest,
    "an instance started by this node-agent must not be restored again by the recovery supervisor",
  );
});

test("node agent restores a managed container before startup convergence", async (t) => {
  const actions = [];
  let artifactResolutions = 0;
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-restore-before-convergence"),
    logger: false,
    token: "agent-secret",
    resolveRuntimeArtifact: async () => {
      artifactResolutions += 1;
      actions.push("resolve-artifact");
      throw Object.assign(new Error("artifact unavailable"), {
        code: "INSTANCE_RUNTIME_ARTIFACT_UNAVAILABLE",
        retryable: false,
      });
    },
    dockerCommandRunner: async (_command, args) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: JSON.stringify({ Id: `sha256:${"a".repeat(64)}`, RepoDigests: [`task-handoff-web@sha256:${"a".repeat(64)}`], Os: "linux", Architecture: "amd64" }), stderr: "" };
      }
      if (args[0] === "inspect" && args.includes("{{json .}}")) {
        return { stdout: JSON.stringify({ Id: "container-restore", Platform: "linux", Image: "sha256:image", Config: { Labels: { "task-handoff.instance-id": "inst_restore_order" } } }), stderr: "" };
      }
      if (args[0] === "start") actions.push("start-container");
      if (args[0] === "port") return { stdout: "127.0.0.1:18184", stderr: "" };
      return { stdout: "container-restore", stderr: "" };
    },
    fetchImpl: async () => new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_restore_order",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_1" },
      image: testInstanceImage("task-handoff-web:local", "img_1", "Image"),
      source: { type: "git-repository", url: "https://github.com/example/repo.git" },
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  await waitForCondition(() => app.nodeAgentState.controlledInstances.get("inst_restore_order")?.status === "created", "restore-order image provisioning");
  const instance = app.nodeAgentState.controlledInstances.get("inst_restore_order");
  app.nodeAgentState.controlledInstances.put({
    ...instance,
    status: "registering",
    runtime: { ...instance.runtime, kind: "docker", containerName: "task-handoff-inst_restore_order", containerId: "container-restore" },
  });

  await app.nodeAgentRecoverManagedInstances();
  assert.equal(artifactResolutions, 0, "convergence must not run before the managed runtime is restored");
  await app.nodeAgentRestoreManagedInstances();
  assert.deepEqual(actions, ["start-container"]);
  await app.nodeAgentRecoverManagedInstances();
  assert.equal(artifactResolutions, 1);
  assert.deepEqual(actions, ["start-container", "resolve-artifact"]);
});

test("node agent skips start config auto-import when disabled on the instance", async (t) => {
  const fetchCalls = [];
  let containerExists = false;
  let app;
  app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-config-auto-import-disabled"),
    logger: false,
    token: "agent-secret",
    resolveRuntimeArtifact: resolvedRuntimeArtifact,
    dockerCommandRunner: async (_command, args) => {
      if (args[0] === "inspect" && args.includes("{{json .}}") && !containerExists) {
        throw new Error("No such container");
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: JSON.stringify({ Id: `sha256:${"c".repeat(64)}`, RepoDigests: [`task-handoff-web@sha256:${"c".repeat(64)}`], Os: "linux", Architecture: "amd64" }), stderr: "" };
      }
      if (args[0] === "run") {
        containerExists = true;
        return { stdout: "container-1", stderr: "" };
      }
      if (args[0] === "port") {
        return { stdout: "0.0.0.0:18180", stderr: "" };
      }
      const convergence = managedDockerRuntimeCommand(app, "inst_no_auto_import", "http://127.0.0.1:18180", args);
      if (convergence) return convergence;
      return { stdout: "", stderr: "" };
    },
    fetchImpl: async (url, init = {}) => {
      fetchCalls.push({ url: String(url), method: init.method || "GET" });
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  t.after(() => app.close());

  const timestamp = new Date().toISOString();
  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_no_auto_import",
      name: "worker",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_1" },
      image: testInstanceImage("task-handoff-web:local", "img_1", "Image"),
      source: {
        type: "git-repository",
        url: "https://github.com/example/repo.git",
      },
      config: {
        autoImportAgentConfigs: false,
      },
    },
  });
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  assert.equal(created.json().data.config.autoImportAgentConfigs, false);
  await waitForCondition(() => app.nodeAgentState.controlledInstances.get("inst_no_auto_import")?.status === "created", "disabled auto-import image provisioning");

  const started = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_no_auto_import/start",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(started.statusCode, 200, started.body);
  assert.deepEqual(
    fetchCalls
      .map((call) => `${call.method} ${new URL(call.url).pathname}`)
      .filter((call) => call === "GET /api/health" || call.startsWith("POST /api/config-sync/import/")),
    ["GET /api/health"],
  );
});

test("node agent config auto-import failure does not fail start", async (t) => {
  const fetchCalls = [];
  let containerExists = false;
  let app;
  app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-config-auto-import-failure"),
    logger: false,
    token: "agent-secret",
    resolveRuntimeArtifact: resolvedRuntimeArtifact,
    dockerCommandRunner: async (_command, args) => {
      if (args[0] === "inspect" && args.includes("{{json .}}") && !containerExists) {
        throw new Error("No such container");
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: JSON.stringify({ Id: `sha256:${"d".repeat(64)}`, RepoDigests: [`task-handoff-web@sha256:${"d".repeat(64)}`], Os: "linux", Architecture: "amd64" }), stderr: "" };
      }
      if (args[0] === "run") {
        containerExists = true;
        return { stdout: "container-1", stderr: "" };
      }
      if (args[0] === "port") {
        return { stdout: "0.0.0.0:18181", stderr: "" };
      }
      const convergence = managedDockerRuntimeCommand(app, "inst_auto_import_fails", "http://127.0.0.1:18181", args);
      if (convergence) return convergence;
      return { stdout: "", stderr: "" };
    },
    fetchImpl: async (url, init = {}) => {
      fetchCalls.push({ url: String(url), method: init.method || "GET" });
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/api/health") {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { message: "sync failed" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    },
  });
  t.after(() => app.close());

  const timestamp = new Date().toISOString();
  await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_auto_import_fails",
      name: "worker",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_1" },
      image: testInstanceImage("task-handoff-web:local", "img_1", "Image"),
      source: {
        type: "git-repository",
        url: "https://github.com/example/repo.git",
      },
    },
  });
  await waitForCondition(() => app.nodeAgentState.controlledInstances.get("inst_auto_import_fails")?.status === "created", "failed auto-import image provisioning");

  const started = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_auto_import_fails/start",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(started.statusCode, 200);
  assert.equal(started.json().data.target.status, "reachable");
  assert.deepEqual(
    fetchCalls
      .map((call) => `${call.method} ${new URL(call.url).pathname}`)
      .filter((call) => call === "GET /api/health" || call.startsWith("POST /api/config-sync/import/")),
    [
      "GET /api/health",
      "POST /api/config-sync/import/codex",
      "POST /api/config-sync/import/claude",
    ],
  );
});

test("node agent config auto-import timeout does not hang start", async (t) => {
  const previousTimeout = process.env.TASK_HANDOFF_CONFIG_AUTO_IMPORT_TIMEOUT_MS;
  process.env.TASK_HANDOFF_CONFIG_AUTO_IMPORT_TIMEOUT_MS = "20";
  t.after(() => {
    if (previousTimeout === undefined) {
      delete process.env.TASK_HANDOFF_CONFIG_AUTO_IMPORT_TIMEOUT_MS;
    } else {
      process.env.TASK_HANDOFF_CONFIG_AUTO_IMPORT_TIMEOUT_MS = previousTimeout;
    }
  });
  let containerExists = false;
  let app;
  app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-config-auto-import-timeout"),
    logger: false,
    token: "agent-secret",
    resolveRuntimeArtifact: resolvedRuntimeArtifact,
    dockerCommandRunner: async (_command, args) => {
      if (args[0] === "inspect" && args.includes("{{json .}}") && !containerExists) {
        throw new Error("No such container");
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: JSON.stringify({ Id: `sha256:${"e".repeat(64)}`, RepoDigests: [`task-handoff-web@sha256:${"e".repeat(64)}`], Os: "linux", Architecture: "amd64" }), stderr: "" };
      }
      if (args[0] === "run") {
        containerExists = true;
        return { stdout: "container-1", stderr: "" };
      }
      if (args[0] === "port") {
        return { stdout: "0.0.0.0:18182", stderr: "" };
      }
      const convergence = managedDockerRuntimeCommand(app, "inst_auto_import_timeout", "http://127.0.0.1:18182", args);
      if (convergence) return convergence;
      return { stdout: "", stderr: "" };
    },
    fetchImpl: async (url, init = {}) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/api/health") {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (pathname.startsWith("/api/internal/node-agent/") || pathname === "/api/apps/sessions") {
        return new Response(JSON.stringify({ data: { ok: true, sessions: [] } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, 1_000);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new Error("aborted"));
        });
      });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  t.after(() => app.close());

  const timestamp = new Date().toISOString();
  await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_auto_import_timeout",
      name: "worker",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_1" },
      image: testInstanceImage("task-handoff-web:local", "img_1", "Image"),
      source: {
        type: "git-repository",
        url: "https://github.com/example/repo.git",
      },
    },
  });
  await waitForCondition(() => app.nodeAgentState.controlledInstances.get("inst_auto_import_timeout")?.status === "created", "timed-out auto-import image provisioning");

  const started = await withTimeout(
    app.inject({
      method: "POST",
      url: "/api/node-agent/instances/inst_auto_import_timeout/start",
      headers: { authorization: "Bearer agent-secret" },
      payload: {},
    }),
    "auto import timeout start",
    500,
  );
  assert.equal(started.statusCode, 200);
  assert.equal(started.json().data.target.status, "reachable");
});

test("node agent local-ipc endpoint supports control plane direct requests", async (t) => {
  const dataDir = tempDataDir("node-agent-local-ipc");
  const ipcPath = nodeAgentIpcPath(dataDir);
  const nodeAgent = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
    connectionMode: "local-ipc",
    ipcPath,
  });
  t.after(() => nodeAgent.close());
  prepareNodeAgentIpcPath(ipcPath);
  await nodeAgent.listen({ path: ipcPath });

  const controlPlane = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-local-ipc"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
  });
  t.after(() => controlPlane.close());

  const created = await json(controlPlane, "POST", "/api/nodes", {
    name: "Local IPC Node",
    connectionMode: "local-ipc",
    endpoint: nodeAgentIpcEndpoint(ipcPath),
    auth: {
      mode: "local-static-key",
      secret: "agent-secret",
    },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.data.connectionMode, "local-ipc");

  const runtimes = await json(controlPlane, "GET", `/api/nodes/${created.body.data.id}/runtimes`);
  assert.equal(runtimes.statusCode, 200);
  assert.ok(runtimes.body.data.some((runtime) => runtime.id === "runtime_local_docker"));
});

test("node agent keeps local IPC control available when remote HMAC pairing exists", async (t) => {
  const dataDir = tempDataDir("node-agent-local-ipc-with-remote");
  const ipcPath = nodeAgentIpcPath(dataDir);
  const nodeAgent = await createNodeAgentApp({
    dataDir,
    logger: false,
    connectionMode: "local-ipc",
    ipcPath,
    nodeId: "node_local_ipc",
    remoteKeyId: "key_remote",
    remoteSecret: "remote-secret",
  });
  t.after(() => nodeAgent.close());
  prepareNodeAgentIpcPath(ipcPath);
  await nodeAgent.listen({ path: ipcPath });

  const localHealth = await fetchNodeAgentIpc(ipcPath, "/health");
  assert.equal(localHealth.status, 200);
  assert.equal((await localHealth.json()).data.nodeId, "node_local_ipc");

  const unsignedLoopback = await nodeAgent.inject({
    method: "GET",
    url: "/api/node-agent/health",
    remoteAddress: "127.0.0.1",
  });
  assert.equal(unsignedLoopback.statusCode, 401);
  assert.equal(unsignedLoopback.json().error.code, "NODE_AGENT_HMAC_SIGNATURE_REQUIRED");
});

test("node agent local-ipc path uses windows named pipe format on win32", () => {
  const pipePath = nodeAgentIpcPath("C:\\Users\\agent\\task-handoff", "win32");
  assert.ok(pipePath.startsWith("\\\\.\\pipe\\task-handoff-node-agent-"));
  assert.equal(nodeAgentIpcEndpoint(pipePath).startsWith("ipc://"), true);
});

test("node agent accepts paired HMAC APIs but denies listener management over TCP", async (t) => {
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-hmac"),
    logger: false,
    nodeId: "node_hmac",
    remoteKeyId: "key_remote",
    remoteSecret: "remote-secret",
  });
  t.after(() => app.close());

  const unsigned = await app.inject({
    method: "GET",
    url: "/api/node-agent/health",
  });
  assert.equal(unsigned.statusCode, 401);

  const signed = await app.inject({
    method: "GET",
    url: "/api/node-agent/health",
    headers: createNodeAgentHmacHeaders({
      nodeId: "node_hmac",
      keyId: "key_remote",
      secret: "remote-secret",
      method: "GET",
      pathWithQuery: "/api/node-agent/health",
    }),
  });
  assert.equal(signed.statusCode, 200);
  assert.equal(signed.json().data.nodeId, "node_hmac");

  const signedListener = await app.inject({
    method: "GET",
    url: "/api/node-agent/settings/external-listener",
    headers: createNodeAgentHmacHeaders({
      nodeId: "node_hmac",
      keyId: "key_remote",
      secret: "remote-secret",
      method: "GET",
      pathWithQuery: "/api/node-agent/settings/external-listener",
    }),
  });
  assert.equal(signedListener.statusCode, 403);
  assert.equal(signedListener.json().error.code, "NODE_AGENT_LISTENER_LOCAL_IPC_ONLY");
});

test("node agent pairs additional control planes with one-time join tokens", async (t) => {
  const dataDir = tempDataDir("node-agent-pairing");
  const app = await createNodeAgentApp({
    dataDir,
    logger: false,
    nodeId: "node_pairing",
    token: "agent-secret",
  });
  t.after(() => app.close());

  const unauthenticatedInvite = await app.inject({
    method: "POST",
    url: "/api/node-agent/pairing/invites",
    payload: {},
  });
  assert.equal(unauthenticatedInvite.statusCode, 401);

  const invite = await app.inject({
    method: "POST",
    url: "/api/node-agent/pairing/invites",
    headers: { authorization: "Bearer agent-secret" },
    payload: { controlPlaneName: "Second Control Plane" },
    remoteAddress: "127.0.0.1",
  });
  assert.equal(invite.statusCode, 201);
  const joinToken = invite.json().data.joinToken;
  assert.ok(joinToken);

  const paired = await app.inject({
    method: "POST",
    url: "/api/node-agent/pairing/complete",
    payload: { joinToken, controlPlaneId: "cp_two" },
    remoteAddress: "203.0.113.10",
  });
  assert.equal(paired.statusCode, 201);
  const pairedBody = paired.json().data;
  assert.equal(pairedBody.nodeId, "node_pairing");
  assert.ok(pairedBody.keyId);
  assert.ok(pairedBody.secret);

  const reused = await app.inject({
    method: "POST",
    url: "/api/node-agent/pairing/complete",
    payload: { joinToken, controlPlaneId: "cp_three" },
    remoteAddress: "203.0.113.11",
  });
  assert.equal(reused.statusCode, 401);

  const signed = await app.inject({
    method: "GET",
    url: "/api/node-agent/health",
    headers: createNodeAgentHmacHeaders({
      nodeId: "node_pairing",
      keyId: pairedBody.keyId,
      secret: pairedBody.secret,
      method: "GET",
      pathWithQuery: "/api/node-agent/health",
    }),
    remoteAddress: "203.0.113.10",
  });
  assert.equal(signed.statusCode, 200);

  const wrongKey = await app.inject({
    method: "GET",
    url: "/api/node-agent/health",
    headers: createNodeAgentHmacHeaders({
      nodeId: "node_pairing",
      keyId: "key_wrong",
      secret: pairedBody.secret,
      method: "GET",
      pathWithQuery: "/api/node-agent/health",
    }),
    remoteAddress: "203.0.113.10",
  });
  assert.equal(wrongKey.statusCode, 401);
  assert.equal(wrongKey.json().error.code, "NODE_AGENT_HMAC_KEY_INVALID");

  const restarted = await createNodeAgentApp({
    dataDir,
    logger: false,
    nodeId: "node_pairing",
    token: "agent-secret",
  });
  t.after(() => restarted.close());
  const signedAfterRestart = await restarted.inject({
    method: "GET",
    url: "/api/node-agent/health",
    headers: createNodeAgentHmacHeaders({
      nodeId: "node_pairing",
      keyId: pairedBody.keyId,
      secret: pairedBody.secret,
      method: "GET",
      pathWithQuery: "/api/node-agent/health",
    }),
    remoteAddress: "203.0.113.10",
  });
  assert.equal(signedAfterRestart.statusCode, 200);
});

test("node agent identity sanitizes unknown stored fields and writes atomically with private permissions", () => {
  const dataDir = tempDataDir("node-agent-identity-sanitize");
  const paths = nodeAgentStorePaths(dataDir);
  const timestamp = new Date().toISOString();
  const warnings = [];
  fs.mkdirSync(path.dirname(paths.identityPath), { recursive: true });
  fs.writeFileSync(paths.identityPath, JSON.stringify({
    nodeId: " node_sanitized ",
    createdAt: timestamp,
    updatedAt: timestamp,
    futureIdentityField: true,
    pairingInvites: [{
      tokenHash: "token-hash",
      createdAt: timestamp,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      futureInviteField: "ignored",
    }],
    controlPlanePairings: [{
      id: "cp_remote",
      keyId: "key_remote",
      secret: "remote-secret",
      pairedAt: timestamp,
      updatedAt: timestamp,
      futurePairingField: "ignored",
    }],
  }));

  const store = new NodeAgentIdentityStore(paths, { logger: (message, details) => warnings.push({ message, details }) });
  const identity = store.read();
  assert.equal(identity.nodeId, "node_sanitized");
  assert.equal(identity.futureIdentityField, undefined);
  assert.equal(identity.pairingInvites[0].futureInviteField, undefined);
  assert.equal(identity.controlPlanePairings[0].futurePairingField, undefined);
  assert.equal(warnings.length, 3);

  store.write(identity);
  const persisted = JSON.parse(fs.readFileSync(paths.identityPath, "utf8"));
  assert.equal(persisted.futureIdentityField, undefined);
  assert.equal(persisted.pairingInvites[0].futureInviteField, undefined);
  assert.equal(persisted.controlPlanePairings[0].futurePairingField, undefined);
  assert.equal(fs.statSync(paths.identityPath).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.dirname(paths.identityPath)).filter((name) => name.includes("identity.json.")).length, 0);
});

test("node agent does not replace malformed or truncated identity data", () => {
  const dataDir = tempDataDir("node-agent-identity-truncated");
  const paths = nodeAgentStorePaths(dataDir);
  const truncated = '{"nodeId":"node_original","remoteControlPlanes":[';
  fs.mkdirSync(path.dirname(paths.identityPath), { recursive: true });
  fs.writeFileSync(paths.identityPath, truncated);

  const identity = new NodeAgentIdentityService(paths);
  assert.throws(
    () => identity.resolveNodeId(),
    (error) => error.code === "NODE_AGENT_IDENTITY_INVALID" && /invalid JSON/.test(error.message),
  );
  assert.equal(fs.readFileSync(paths.identityPath, "utf8"), truncated);
});

test("node agent migrates legacy remote records into separate pairings and outbound connections", () => {
  const paths = nodeAgentStorePaths(tempDataDir("node-agent-identity-remote-migration"));
  const timestamp = new Date().toISOString();
  fs.mkdirSync(path.dirname(paths.identityPath), { recursive: true });
  fs.writeFileSync(paths.identityPath, JSON.stringify({
    nodeId: "node_migrated",
    createdAt: timestamp,
    updatedAt: timestamp,
    remoteControlPlanes: [
      { id: "cp_pairing_only", keyId: "key_pairing_only", name: "Direct control plane", secret: "secret-one", pairedAt: timestamp, updatedAt: timestamp, active: true },
      { id: "cp_connected", keyId: "key_connected", name: "Tunnel control plane", url: "https://control-plane.example.com", secret: "secret-two", pairedAt: timestamp, updatedAt: timestamp, active: true },
    ],
  }));

  const store = new NodeAgentIdentityStore(paths, { logger: () => undefined });
  const identity = store.read();
  assert.equal(identity.controlPlanePairings.length, 2);
  assert.deepEqual(identity.controlPlaneConnections.map((connection) => ({
    pairingKeyId: connection.pairingKeyId,
    url: connection.url,
    enabled: connection.enabled,
  })), [{
    pairingKeyId: "key_connected",
    url: "https://control-plane.example.com",
    enabled: true,
  }]);

  store.write(identity);
  const persisted = JSON.parse(fs.readFileSync(paths.identityPath, "utf8"));
  assert.equal(persisted.remoteControlPlanes, undefined);
  assert.equal(persisted.controlPlanePairings.length, 2);
  assert.equal(persisted.controlPlaneConnections.length, 1);
});

test("node agent does not initialize over an unreadable identity path", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX symbolic links are required");
    return;
  }
  const dataDir = tempDataDir("node-agent-identity-unreadable");
  const paths = nodeAgentStorePaths(dataDir);
  fs.mkdirSync(path.dirname(paths.identityPath), { recursive: true });
  fs.symlinkSync(paths.identityPath, paths.identityPath);

  assert.throws(
    () => new NodeAgentIdentityService(paths).resolveNodeId(),
    (error) => error.code === "NODE_AGENT_IDENTITY_READ_FAILED",
  );
  assert.equal(fs.lstatSync(paths.identityPath).isSymbolicLink(), true);
});

test("node agent identity ignores invalid stored credentials and invite records", () => {
  const paths = nodeAgentStorePaths(tempDataDir("node-agent-identity-invalid-records"));
  const timestamp = new Date().toISOString();
  const warnings = [];
  fs.mkdirSync(path.dirname(paths.identityPath), { recursive: true });
  fs.writeFileSync(paths.identityPath, JSON.stringify({
    nodeId: "node_valid",
    createdAt: timestamp,
    updatedAt: timestamp,
    pairingInvites: [{ tokenHash: "token", createdAt: timestamp, expiresAt: "not-a-datetime" }],
    controlPlanePairings: [
      { id: "cp_empty_secret", keyId: "known", secret: "", pairedAt: timestamp, updatedAt: timestamp },
    ],
    controlPlaneConnections: [
      { id: "connection_invalid_url", pairingKeyId: "key_url", url: "not a url", enabled: true, createdAt: timestamp, updatedAt: timestamp },
    ],
  }));

  const store = new NodeAgentIdentityStore(paths, { logger: (message, details) => warnings.push({ message, details }) });
  const stored = store.read();
  assert.deepEqual(stored.pairingInvites, []);
  assert.deepEqual(stored.controlPlanePairings, []);
  assert.deepEqual(stored.controlPlaneConnections, []);
  assert.equal(warnings.filter((warning) => warning.message.includes("was ignored")).length, 3);
  store.write(stored);
  assert.deepEqual(new NodeAgentIdentityService(paths).remoteSecrets(), []);
});

test("node agent hmac nonce expires after one timestamp window", () => {
  const paths = nodeAgentStorePaths(tempDataDir("node-agent-hmac-nonce-expiry"));
  const identity = new NodeAgentIdentityService(paths);
  let clock = Date.parse("2026-07-15T00:00:00.000Z");
  const verifier = new NodeAgentPairedHmacVerifier(identity, "node_hmac_expiry", "remote-secret", "key_remote", () => clock);
  const requestForClock = () => ({
    method: "GET",
    url: "/api/node-agent/health",
    body: undefined,
    headers: createNodeAgentHmacHeaders({
      nodeId: "node_hmac_expiry",
      keyId: "key_remote",
      secret: "remote-secret",
      method: "GET",
      pathWithQuery: "/api/node-agent/health",
      timestamp: new Date(clock).toISOString(),
      nonce: "reusable-after-expiry",
    }),
  });

  assert.equal(verifier.verify(requestForClock()), "key_remote");
  clock += NODE_AGENT_HMAC_TIMESTAMP_WINDOW_MS * 2;
  assert.equal(verifier.verify(requestForClock()), "key_remote");
});

test("node agent hmac retains a future-timestamp nonce until that signature is stale", () => {
  const paths = nodeAgentStorePaths(tempDataDir("node-agent-hmac-future-nonce"));
  const identity = new NodeAgentIdentityService(paths);
  let clock = Date.parse("2026-07-15T00:00:00.000Z");
  const verifier = new NodeAgentPairedHmacVerifier(identity, "node_hmac_future", "remote-secret", "key_remote", () => clock);
  const timestamp = new Date(clock + NODE_AGENT_HMAC_TIMESTAMP_WINDOW_MS).toISOString();
  const request = {
    method: "GET",
    url: "/api/node-agent/health",
    body: undefined,
    headers: createNodeAgentHmacHeaders({
      nodeId: "node_hmac_future",
      keyId: "key_remote",
      secret: "remote-secret",
      method: "GET",
      pathWithQuery: "/api/node-agent/health",
      timestamp,
      nonce: "future-timestamp-exact-replay",
    }),
  };

  assert.equal(verifier.verify(request), "key_remote");
  clock += NODE_AGENT_HMAC_TIMESTAMP_WINDOW_MS + 1;
  assert.throws(
    () => verifier.verify(request),
    (error) => error.code === "NODE_AGENT_HMAC_NONCE_REPLAY",
  );
});

test("node agent rejects hmac replay stale timestamp and body hash mismatch", async (t) => {
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-hmac-negative"),
    logger: false,
    nodeId: "node_hmac_negative",
    remoteKeyId: "key_remote",
    remoteSecret: "remote-secret",
  });
  t.after(() => app.close());

  const reusableHeaders = createNodeAgentHmacHeaders({
    nodeId: "node_hmac_negative",
    keyId: "key_remote",
    secret: "remote-secret",
    method: "GET",
    pathWithQuery: "/api/node-agent/health",
    nonce: "nonce_replay",
  });
  assert.equal((await app.inject({ method: "GET", url: "/api/node-agent/health", headers: reusableHeaders })).statusCode, 200);
  const replayed = await app.inject({ method: "GET", url: "/api/node-agent/health", headers: reusableHeaders });
  assert.equal(replayed.statusCode, 401);
  assert.equal(replayed.json().error.code, "NODE_AGENT_HMAC_NONCE_REPLAY");

  const stale = await app.inject({
    method: "GET",
    url: "/api/node-agent/health",
    headers: createNodeAgentHmacHeaders({
      nodeId: "node_hmac_negative",
      keyId: "key_remote",
      secret: "remote-secret",
      method: "GET",
      pathWithQuery: "/api/node-agent/health",
      timestamp: new Date(Date.now() - 120_000).toISOString(),
    }),
  });
  assert.equal(stale.statusCode, 401);
  assert.equal(stale.json().error.code, "NODE_AGENT_HMAC_TIMESTAMP_INVALID");

  const body = JSON.stringify({ name: "Local" });
  const mismatchedBody = await app.inject({
    method: "POST",
    url: "/api/node-agent/runtimes",
    headers: {
      "content-type": "application/json",
      ...createNodeAgentHmacHeaders({
        nodeId: "node_hmac_negative",
        keyId: "key_remote",
        secret: "remote-secret",
        method: "POST",
        pathWithQuery: "/api/node-agent/runtimes",
        body: JSON.stringify({ name: "Different" }),
      }),
    },
    payload: body,
  });
  assert.equal(mismatchedBody.statusCode, 401);
  assert.equal(mismatchedBody.json().error.code, "NODE_AGENT_HMAC_BODY_HASH_INVALID");
});

test("control plane creates remote direct http nodes with node-agent join tokens", async (t) => {
  const port = await freePort();
  const nodeAgent = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-control-plane-pairing"),
    logger: false,
    nodeId: "node_joined",
    token: "agent-secret",
    port,
    platform: "darwin",
  });
  await nodeAgent.listen({ host: "127.0.0.1", port });
  t.after(() => nodeAgent.close());

  const invite = await nodeAgent.inject({
    method: "POST",
    url: "/api/node-agent/pairing/invites",
    headers: { authorization: "Bearer agent-secret" },
    payload: { controlPlaneName: "New Control Plane" },
    remoteAddress: "127.0.0.1",
  });
  assert.equal(invite.statusCode, 201);

  const controlPlane = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-node-pairing"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
  });
  t.after(() => controlPlane.close());

  const created = await json(controlPlane, "POST", "/api/nodes", {
    name: "Joined Node",
    connectionMode: "direct-http",
    endpoint: `http://127.0.0.1:${port}`,
    joinToken: invite.json().data.joinToken,
  });
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.id, "node_joined");
  assert.equal(created.body.data.capabilities.agent.platform, "darwin");
  assert.equal(created.body.data.auth.mode, "paired-hmac");
  assert.ok(created.body.data.auth.keyId);
  assert.equal(created.body.data.auth.secret, undefined);
  assert.equal(created.body.data.auth.pairing.status, "paired");

  const runtimes = await json(controlPlane, "GET", "/api/nodes/node_joined/runtimes");
  assert.equal(runtimes.statusCode, 200);
  assert.ok(runtimes.body.data.some((runtime) => runtime.id === "runtime_local_docker"));

  const pairings = await json(controlPlane, "GET", "/api/nodes/node_joined/control-plane-pairings");
  assert.equal(pairings.statusCode, 200, JSON.stringify(pairings.body));
  assert.equal(pairings.body.data.length, 1);
  assert.equal(pairings.body.data[0].current, true);
  const connections = await json(controlPlane, "GET", "/api/nodes/node_joined/control-plane-connections");
  assert.equal(connections.statusCode, 200, JSON.stringify(connections.body));
  assert.deepEqual(connections.body.data, []);
});

test("control plane node runtime aggregation isolates invalid node protocol data", async (t) => {
  const timestamp = new Date().toISOString();
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const parsedUrl = new URL(String(url));
    const route = parsedUrl.pathname.replace(/^\/api\/node-agent/, "");
    requests.push({ url: String(url), route, host: parsedUrl.host, method: init.method || "GET" });
    const nodeId = parsedUrl.hostname.startsWith("bad-node") ? "node_bad" : "node_good";
    if (route === "/health") {
      return new Response(JSON.stringify({
        data: {
          ok: true,
          role: "node-agent",
          nodeId,
          protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (route === "/runtimes") {
      const data = nodeId === "node_bad"
        ? [{ id: "runtime_bad", nodeId }]
        : [{
            id: "runtime_good",
            nodeId,
            name: "Good Runtime",
            type: "docker",
            status: "online",
            accessStrategy: "direct-port",
            capabilities: {},
            labels: {},
            createdAt: timestamp,
            updatedAt: timestamp,
          }];
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-node-runtime-invalid-aggregate"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: { fetchImpl },
  });
  t.after(() => app.close());

  const goodNode = await json(app, "POST", "/api/nodes", {
    id: "node_good",
    name: "Good Node",
    connectionMode: "direct-http",
    endpoint: "http://good-node.example:8091",
    auth: {
      mode: "paired-hmac",
      keyId: "key_good",
      secret: "good-secret",
    },
  });
  assert.equal(goodNode.statusCode, 201, JSON.stringify(goodNode.body));

  const badNode = await json(app, "POST", "/api/nodes", {
    id: "node_bad",
    name: "Bad Node",
    connectionMode: "direct-http",
    endpoint: "http://bad-node.example:8091",
    auth: {
      mode: "paired-hmac",
      keyId: "key_bad",
      secret: "bad-secret",
    },
  });
  assert.equal(badNode.statusCode, 201, JSON.stringify(badNode.body));

  const allRuntimes = await json(app, "GET", "/api/node-runtimes");
  assert.equal(allRuntimes.statusCode, 200);
  assert.deepEqual(allRuntimes.body.data.map((runtime) => runtime.id), ["runtime_good"]);
  assert.equal(allRuntimes.body.meta.nodeErrors.length, 1);
  assert.equal(allRuntimes.body.meta.nodeErrors[0].nodeId, "node_bad");
  assert.equal(allRuntimes.body.meta.nodeErrors[0].code, "NODE_AGENT_PROTOCOL_INVALID");
  assert.ok(requests.some((request) => request.host === "bad-node.example:8091" && request.route === "/runtimes"));

  const badRuntimes = await json(app, "GET", "/api/nodes/node_bad/runtimes");
  assert.equal(badRuntimes.statusCode, 502);
  assert.equal(badRuntimes.body.error.code, "NODE_AGENT_PROTOCOL_INVALID");
});

test("control plane node instance aggregation isolates invalid node protocol data", async (t) => {
  const timestamp = new Date().toISOString();
  const requests = [];
  const validInstance = {
    id: "inst_good",
    name: "Good Instance",
    source: {
      type: "local-folder",
      path: "/workspace/good",
    },
    nodeId: "node_good",
    runtimeId: "runtime_good",
    status: "running",
    health: "ok",
    connectionStatus: "online",
    agentStatus: "online",
    targetStatus: "reachable",
    uiAccessStatus: "reachable",
    controlMode: "controlled",
    capabilities: {},
    config: { autoImportAgentConfigs: true },
    workspace: { status: "ready", path: "/workspace/good" },
    target: { strategy: "direct-port", status: "reachable", web: "http://127.0.0.1:19001" },
    access: { strategy: "control-plane-proxy", status: "reachable" },
    apps: { runningCount: 0 },
    aiSessions: {
      runningCount: 0,
      waitingCount: 0,
      staleCount: 0,
      sessions: [],
      updatedAt: timestamp,
    },
    runtime: { labels: {} },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const incompatibleInstance = {
    ...validInstance,
    id: "inst_old_protocol",
    name: "Old Protocol Instance",
    protocolVersion: "2026-06-23",
  };
  const fetchImpl = async (url, init = {}) => {
    const parsedUrl = new URL(String(url));
    const route = parsedUrl.pathname.replace(/^\/api\/node-agent/, "");
    requests.push({ route, host: parsedUrl.host, method: init.method || "GET" });
    const nodeId = parsedUrl.hostname.startsWith("bad-node") ? "node_bad" : "node_good";
    if (route === "/health") {
      return new Response(JSON.stringify({
        data: {
          ok: true,
          role: "node-agent",
          nodeId,
          protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (route === "/instances") {
      const data = nodeId === "node_bad"
        ? [{ id: "inst_bad", nodeId }]
        : [validInstance, incompatibleInstance, { id: "inst_invalid_same_node", nodeId }];
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (route === "/triggers") {
      return new Response(JSON.stringify({
        data: {
          enabledCount: 0,
          runningCount: 0,
          errorCount: 0,
          configs: [],
          recentRuns: [],
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-node-instance-invalid-aggregate"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: { fetchImpl },
  });
  t.after(() => app.close());

  const goodNode = await json(app, "POST", "/api/nodes", {
    id: "node_good",
    name: "Good Node",
    connectionMode: "direct-http",
    endpoint: "http://good-node.example:8091",
    auth: {
      mode: "paired-hmac",
      keyId: "key_good",
      secret: "good-secret",
    },
  });
  assert.equal(goodNode.statusCode, 201, JSON.stringify(goodNode.body));

  const badNode = await json(app, "POST", "/api/nodes", {
    id: "node_bad",
    name: "Bad Node",
    connectionMode: "direct-http",
    endpoint: "http://bad-node.example:8091",
    auth: {
      mode: "paired-hmac",
      keyId: "key_bad",
      secret: "bad-secret",
    },
  });
  assert.equal(badNode.statusCode, 201, JSON.stringify(badNode.body));

  const instances = await json(app, "GET", "/api/controlled-instances");
  assert.equal(instances.statusCode, 200, JSON.stringify(instances.body));
  assert.deepEqual(instances.body.data.map((instance) => instance.id), ["inst_good", "inst_old_protocol"]);
  assert.ok(requests.some((request) => request.host === "bad-node.example:8091" && request.route === "/instances"));

  const board = await json(app, "GET", "/api/instance-board");
  assert.equal(board.statusCode, 200, JSON.stringify(board.body));
  assert.deepEqual(board.body.data.map((instance) => instance.id), ["inst_good", "inst_old_protocol"]);
  assert.equal(board.body.data.find((instance) => instance.id === "inst_old_protocol").protocolCompatible, false);
  assert.equal(board.body.meta.nodeErrors.length, 2);
  assert.deepEqual(board.body.meta.nodeErrors.map((error) => [error.nodeId, error.code]).sort(), [
    ["node_bad", "NODE_INSTANCE_PAYLOAD_INVALID"],
    ["node_good", "NODE_INSTANCE_PAYLOAD_INVALID"],
  ]);
});

test("node agent connects itself to another control plane with a join token", async (t) => {
  const targetPort = await freePort();
  const targetControlPlane = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-node-join-target"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
  });
  await targetControlPlane.listen({ host: "127.0.0.1", port: targetPort });
  t.after(() => targetControlPlane.close());

  const invite = await json(targetControlPlane, "POST", "/api/node-join/invites", {});
  assert.equal(invite.statusCode, 201);
  assert.ok(invite.body.data.joinToken);

  const agentDataDir = tempDataDir("node-agent-remote-connect");
  const nodeAgent = await createNodeAgentApp({
    dataDir: agentDataDir,
    logger: false,
    nodeId: "node_remote_connect",
    token: "agent-secret",
    port: await freePort(),
  });
  t.after(() => nodeAgent.close());

  const connected = await nodeAgent.inject({
    method: "POST",
    url: "/api/node-agent/control-plane-connections",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      controlPlaneUrl: `http://127.0.0.1:${targetPort}`,
      joinToken: invite.body.data.joinToken,
      controlPlaneName: "Target Control Plane",
    },
    remoteAddress: "127.0.0.1",
  });
  assert.equal(connected.statusCode, 201);
  assert.equal(connected.json().data.connection.url, `http://127.0.0.1:${targetPort}`);
  assert.equal(connected.json().data.tunnel.status, "saved");

  const listed = await json(targetControlPlane, "GET", "/api/nodes");
  assert.equal(listed.statusCode, 200);
  const joined = listed.body.data.find((node) => node.id === "node_remote_connect");
  assert.ok(joined);
  assert.equal(joined.connectionMode, "reverse-wss");
  assert.equal(joined.auth.mode, "paired-hmac");
  assert.ok(joined.auth.keyId);
  assert.equal(joined.auth.secret, undefined);

  const identity = JSON.parse(fs.readFileSync(path.join(agentDataDir, "identity.json"), "utf8"));
  const connection = identity.controlPlaneConnections.find((item) => item.url === `http://127.0.0.1:${targetPort}`);
  assert.ok(connection);
  assert.equal(connection.enabled, true);
  const pairing = identity.controlPlanePairings.find((item) => item.keyId === connection.pairingKeyId);
  assert.equal(pairing.keyId, joined.auth.keyId);
});

test("node agent persists control-plane credentials before completing the remote join", async (t) => {
  const agentDataDir = tempDataDir("node-agent-persist-before-join");
  let persistedDuringJoin;
  const nodeAgent = await createNodeAgentApp({
    dataDir: agentDataDir,
    logger: false,
    nodeId: "node_persist_before_join",
    token: "agent-secret",
    fetchImpl: async () => {
      persistedDuringJoin = new NodeAgentIdentityStore(nodeAgentStorePaths(agentDataDir), { logger: () => undefined }).read();
      return new Response(JSON.stringify({ data: { id: "node_persist_before_join", name: "Target Control Plane" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });
  t.after(() => nodeAgent.close());

  const connected = await nodeAgent.inject({
    method: "POST",
    url: "/api/node-agent/control-plane-connections",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      controlPlaneUrl: "https://control-plane.example.com",
      joinToken: "join-token",
    },
    remoteAddress: "127.0.0.1",
  });

  assert.equal(connected.statusCode, 201);
  assert.equal(persistedDuringJoin.controlPlanePairings.length, 1);
  assert.equal(persistedDuringJoin.controlPlaneConnections.length, 1);
  assert.equal(persistedDuringJoin.controlPlaneConnections[0].pairingKeyId, persistedDuringJoin.controlPlanePairings[0].keyId);
  const persistedAfterJoin = new NodeAgentIdentityStore(nodeAgentStorePaths(agentDataDir), { logger: () => undefined }).read();
  assert.equal(persistedAfterJoin.controlPlanePairings[0].name, "Target Control Plane");
  assert.equal(persistedAfterJoin.controlPlaneConnections[0].name, "Target Control Plane");
});

test("node agent rolls back staged control-plane credentials when the remote join fails", async (t) => {
  const agentDataDir = tempDataDir("node-agent-rollback-failed-join");
  const paths = nodeAgentStorePaths(agentDataDir);
  const identity = new NodeAgentIdentityService(paths);
  identity.resolveNodeId("node_rollback_failed_join");
  const existing = identity.commitControlPlaneConnection(
    identity.stageControlPlaneConnection({ url: "https://control-plane.example.com", name: "Existing" }),
  );
  let persistedDuringJoin;
  const nodeAgent = await createNodeAgentApp({
    dataDir: agentDataDir,
    logger: false,
    nodeId: "node_rollback_failed_join",
    token: "agent-secret",
    fetchImpl: async () => {
      persistedDuringJoin = new NodeAgentIdentityStore(paths, { logger: () => undefined }).read();
      return new Response(JSON.stringify({ error: { code: "NODE_JOIN_REJECTED", message: "Join rejected." } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    },
  });
  t.after(() => nodeAgent.close());

  const requestBody = JSON.stringify({
    controlPlaneUrl: "https://control-plane.example.com",
    joinToken: "join-token",
  });
  const connected = await nodeAgent.inject({
    method: "POST",
    url: "/api/node-agent/control-plane-connections",
    headers: {
      "content-type": "application/json",
      ...createNodeAgentHmacHeaders({
        nodeId: "node_rollback_failed_join",
        keyId: existing.pairing.keyId,
        secret: existing.pairing.secret,
        method: "POST",
        pathWithQuery: "/api/node-agent/control-plane-connections",
        body: requestBody,
      }),
    },
    payload: requestBody,
    remoteAddress: "127.0.0.1",
  });

  assert.equal(connected.statusCode, 409);
  assert.notEqual(persistedDuringJoin.controlPlaneConnections[0].id, existing.connection.id);
  const restored = new NodeAgentIdentityStore(paths, { logger: () => undefined }).read();
  assert.deepEqual(restored.controlPlaneConnections.map((connection) => connection.id), [existing.connection.id]);
  assert.deepEqual(restored.controlPlanePairings.map((pairing) => pairing.keyId), [existing.pairing.keyId]);
});

test("node agent removes the orphaned pairing after replacing a control-plane connection", () => {
  const paths = nodeAgentStorePaths(tempDataDir("node-agent-replace-control-plane-connection"));
  const identity = new NodeAgentIdentityService(paths);
  identity.resolveNodeId("node_replace_control_plane_connection");
  const existing = identity.commitControlPlaneConnection(
    identity.stageControlPlaneConnection({ url: "https://control-plane.example.com", name: "Existing" }),
  );
  const replacement = identity.commitControlPlaneConnection(
    identity.stageControlPlaneConnection({ url: "https://control-plane.example.com", name: "Replacement" }),
  );

  const stored = new NodeAgentIdentityStore(paths, { logger: () => undefined }).read();
  assert.deepEqual(stored.controlPlaneConnections.map((connection) => connection.id), [replacement.connection.id]);
  assert.deepEqual(stored.controlPlanePairings.map((pairing) => pairing.keyId), [replacement.pairing.keyId]);
  assert.notEqual(replacement.pairing.keyId, existing.pairing.keyId);
});

test("node agent serializes concurrent connection changes for the same control-plane URL", async () => {
  const paths = nodeAgentStorePaths(tempDataDir("node-agent-serialize-control-plane-connection"));
  const identity = new NodeAgentIdentityService(paths);
  identity.resolveNodeId("node_serialize_control_plane_connection");
  const controlPlaneUrl = "https://control-plane.example.com";
  let activeOperations = 0;
  let maximumActiveOperations = 0;
  let releaseFirst;
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => {
    firstStartedResolve = resolve;
  });
  const firstMayFinish = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const connect = (name, wait) => identity.runControlPlaneConnectionOperation(controlPlaneUrl, async () => {
    activeOperations += 1;
    maximumActiveOperations = Math.max(maximumActiveOperations, activeOperations);
    const staged = identity.stageControlPlaneConnection({ url: controlPlaneUrl, name });
    if (wait) {
      firstStartedResolve();
      await firstMayFinish;
    }
    const stored = identity.commitControlPlaneConnection(staged);
    activeOperations -= 1;
    return stored;
  });

  const first = connect("First", true);
  await firstStarted;
  const second = connect("Second", false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activeOperations, 1);
  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(maximumActiveOperations, 1);
  assert.deepEqual(identity.listControlPlaneConnections().map((connection) => connection.name), ["Second"]);
  assert.deepEqual(identity.listControlPlanePairings().map((pairing) => pairing.name), ["Second"]);
});

test("control plane rejects node join when node id already exists", async (t) => {
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-node-join-duplicate"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
  });
  t.after(() => app.close());

  const invite = await json(app, "POST", "/api/node-join/invites", {});
  assert.equal(invite.statusCode, 201);

  const first = await json(app, "POST", "/api/node-join/complete", {
    joinToken: invite.body.data.joinToken,
    nodeId: "node_duplicate_join",
    nodeName: "First",
    keyId: "key_first",
    secret: "secret-first",
  });
  assert.equal(first.statusCode, 201);

  const secondInvite = await json(app, "POST", "/api/node-join/invites", {});
  assert.equal(secondInvite.statusCode, 201);
  const duplicate = await json(app, "POST", "/api/node-join/complete", {
    joinToken: secondInvite.body.data.joinToken,
    nodeId: "node_duplicate_join",
    nodeName: "Second",
    keyId: "key_second",
    secret: "secret-second",
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.body.error.code, "NODE_JOIN_NODE_ALREADY_EXISTS");
});

test("control plane does not use local static key for remote direct http node auth", async (t) => {
  const mock = createMockNodeAgentFetch({
    nodeId: "node_remote_auth",
  });
  const controlPlane = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-remote-auth-headers"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => controlPlane.close());

  const created = await json(controlPlane, "POST", "/api/nodes", {
    id: "node_remote_auth",
    name: "Remote Auth Node",
    connectionMode: "direct-http",
    endpoint: "http://node-agent.example.test",
    auth: {
      mode: "paired-hmac",
      keyId: "key_remote",
      secret: "remote-secret",
    },
  });
  assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  const remoteHealthRequest = mock.requests.find((request) => request.path === "/health" && request.url.startsWith("http://node-agent.example.test"));
  assert.ok(remoteHealthRequest);
  assert.equal(remoteHealthRequest.headers.authorization, undefined);
  assert.equal(remoteHealthRequest.headers["x-taskhandoff-key-id"], "key_remote");
  assert.ok(remoteHealthRequest.headers["x-taskhandoff-signature"]);
});

test("node agent only accepts local static key from loopback clients", async (t) => {
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-local-static-key"),
    logger: false,
    token: "agent-secret",
  });
  t.after(() => app.close());

  const local = await app.inject({
    method: "GET",
    url: "/api/node-agent/health",
    headers: { authorization: "Bearer agent-secret" },
    remoteAddress: "127.0.0.1",
  });
  assert.equal(local.statusCode, 200);

  const remote = await app.inject({
    method: "GET",
    url: "/api/node-agent/health",
    headers: { authorization: "Bearer agent-secret" },
    remoteAddress: "203.0.113.10",
  });
  assert.equal(remote.statusCode, 401);
  assert.equal(remote.json().error.code, "NODE_AGENT_LOCAL_TOKEN_REQUIRES_LOOPBACK");
});

test("node agent provisions one built-in local runtime and creates local instances without images", async (t) => {
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-localhost-runtime"),
    logger: false,
    token: "agent-secret",
    platform: "linux",
    dockerCommandRunner: async (command) => {
      if (command === "codex") {
        return { stdout: "codex 1.2.3", stderr: "" };
      }
      throw new Error(`${command} missing`);
    },
  });
  t.after(() => app.close());

  const initialRuntimes = await app.inject({
    method: "GET",
    url: "/api/node-agent/runtimes",
    headers: { authorization: "Bearer agent-secret" },
  });
  assert.equal(initialRuntimes.statusCode, 200);
  assert.deepEqual(initialRuntimes.json().data.map((runtime) => runtime.id), ["runtime_local_docker", "runtime_local_host"]);
  const localRuntime = initialRuntimes.json().data.find((runtime) => runtime.id === "runtime_local_host");
  assert.equal(localRuntime.name, "Local Runtime");
  assert.equal(localRuntime.type, "local");
  assert.equal(localRuntime.capabilities.requiresImage, false);
  assert.equal(localRuntime.accessStrategy, "node-proxy");
  assert.equal(localRuntime.labels["task-handoff.node-agent.builtin"], "true");

  const manualRuntime = await app.inject({
    method: "POST",
    url: "/api/node-agent/runtimes",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "runtime_manual_local",
      name: "Manual Local Runtime",
      type: "local",
    },
  });
  assert.equal(manualRuntime.statusCode, 409);
  assert.equal(manualRuntime.json().error.code, "LOCAL_RUNTIME_BUILTIN");

  const checkedRuntime = await app.inject({
    method: "POST",
    url: "/api/node-agent/runtimes/runtime_local_host/check",
    headers: { authorization: "Bearer agent-secret" },
  });
  assert.equal(checkedRuntime.statusCode, 200);
  assert.equal(checkedRuntime.json().data.status, "online");
  assert.equal(checkedRuntime.json().data.capabilities.apps.terminal, true);
  assert.equal(checkedRuntime.json().data.capabilities.apps.codex.available, true);
  assert.equal(checkedRuntime.json().data.capabilities.apps.claude.available, false);

  const createdInstance = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_local",
      runtimeId: "runtime_local_host",
      source: {
        type: "local-folder",
        path: "/tmp/task-handoff-localhost-workspace",
      },
      sourceSnapshot: {
        name: "workspace",
      },
    },
  });
  assert.equal(createdInstance.statusCode, 201);
  assert.equal(createdInstance.json().data.name, "instance-local");
  assert.equal(createdInstance.json().data.imageId, undefined);
  assert.equal(createdInstance.json().data.status, "created");
  assert.equal(createdInstance.json().data.connectionStatus, "unknown");
  assert.equal(createdInstance.json().data.workspace.status, "unknown");
  assert.equal(createdInstance.json().data.workspace.path, "/tmp/task-handoff-localhost-workspace");
  assert.equal(createdInstance.json().data.runtime.kind, "local");
  assert.equal(createdInstance.json().data.config.defaultCodexPermissionMode, "ask");

  const updatedPermissionDefault = await app.inject({
    method: "PATCH",
    url: "/api/node-agent/instances/inst_local",
    headers: { authorization: "Bearer agent-secret" },
    payload: { config: { defaultCodexPermissionMode: "auto-review" } },
  });
  assert.equal(updatedPermissionDefault.statusCode, 200);
  assert.deepEqual(updatedPermissionDefault.json().data.config, {
    autoImportAgentConfigs: true,
    defaultCodexPermissionMode: "auto-review",
  });

  const mergedConfigUpdate = await app.inject({
    method: "PATCH",
    url: "/api/node-agent/instances/inst_local",
    headers: { authorization: "Bearer agent-secret" },
    payload: { config: { autoImportAgentConfigs: false } },
  });
  assert.equal(mergedConfigUpdate.statusCode, 200);
  assert.deepEqual(mergedConfigUpdate.json().data.config, {
    autoImportAgentConfigs: false,
    defaultCodexPermissionMode: "auto-review",
  });

  const duplicateInstance = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_local_duplicate",
      name: "local workspace duplicate",
      runtimeId: "runtime_local_host",
      source: {
        type: "local-folder",
        path: "/tmp/task-handoff-localhost-workspace-2",
      },
    },
  });
  assert.equal(duplicateInstance.statusCode, 409);
  assert.equal(duplicateInstance.json().error.code, "LOCAL_RUNTIME_INSTANCE_EXISTS");

  const deleteRuntime = await app.inject({
    method: "DELETE",
    url: "/api/node-agent/runtimes/runtime_local_host",
    headers: { authorization: "Bearer agent-secret" },
  });
  assert.equal(deleteRuntime.statusCode, 400);
  assert.equal(deleteRuntime.json().error.code, "NODE_RUNTIME_BUILTIN");
});

test("node agent omits local runtime on Windows and rejects manual creation", async (t) => {
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-windows-local-runtime"),
    logger: false,
    token: "agent-secret",
    platform: "win32",
  });
  t.after(() => app.close());

  const runtimes = await app.inject({
    method: "GET",
    url: "/api/node-agent/runtimes",
    headers: { authorization: "Bearer agent-secret" },
  });
  assert.deepEqual(runtimes.json().data.map((runtime) => runtime.id), ["runtime_local_docker"]);

  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/runtimes",
    headers: { authorization: "Bearer agent-secret" },
    payload: { id: "runtime_windows_local", name: "Local Runtime", type: "local" },
  });
  assert.equal(created.statusCode, 400);
  assert.equal(created.json().error.code, "LOCAL_RUNTIME_UNSUPPORTED");
});

test("node agent reserves the built-in runtime marker", async (t) => {
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-reserved-runtime-label"),
    logger: false,
    token: "agent-secret",
    platform: "linux",
  });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/runtimes",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "runtime_user_docker",
      name: "User Docker",
      type: "docker",
      labels: { "task-handoff.node-agent.builtin": "true", owner: "user" },
    },
  });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json().data.labels, { owner: "user" });

  const updated = await app.inject({
    method: "PATCH",
    url: "/api/node-agent/runtimes/runtime_user_docker",
    headers: { authorization: "Bearer agent-secret" },
    payload: { labels: { "task-handoff.node-agent.builtin": "true", owner: "updated" } },
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.json().data.labels, { owner: "updated" });

  const deleted = await app.inject({
    method: "DELETE",
    url: "/api/node-agent/runtimes/runtime_user_docker",
    headers: { authorization: "Bearer agent-secret" },
  });
  assert.equal(deleted.statusCode, 200);
});

test("node agent checks the real Docker daemon and persists its current status", async (t) => {
  const calls = [];
  let daemonError;
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-docker-runtime-check"),
    logger: false,
    token: "agent-secret",
    platform: "linux",
    dockerCommandRunner: async (command, args, options) => {
      calls.push({ command, args, options });
      if (daemonError) throw daemonError;
      return { stdout: "27.5.1", stderr: "" };
    },
  });
  t.after(() => app.close());

  const online = await app.inject({
    method: "POST",
    url: "/api/node-agent/runtimes/runtime_local_docker/check",
    headers: { authorization: "Bearer agent-secret" },
  });
  assert.equal(online.statusCode, 200);
  assert.equal(online.json().data.status, "online");
  assert.deepEqual(online.json().data.capabilities.daemon, { status: "online", hostPlatform: "linux", serverVersion: "27.5.1" });
  assert.deepEqual(calls, [{
    command: "docker",
    args: ["version", "--format", "{{.Server.Version}}"],
    options: { timeoutMs: 5_000 },
  }]);

  daemonError = new Error("Cannot connect to the Docker daemon");
  const offline = await app.inject({
    method: "POST",
    url: "/api/node-agent/runtimes/runtime_local_docker/check",
    headers: { authorization: "Bearer agent-secret" },
  });
  assert.equal(offline.statusCode, 200);
  assert.equal(offline.json().data.status, "offline");
  assert.deepEqual(offline.json().data.capabilities.daemon, {
    status: "offline",
    hostPlatform: "linux",
    error: "Cannot connect to the Docker daemon",
  });

  const runtimes = await app.inject({
    method: "GET",
    url: "/api/node-agent/runtimes",
    headers: { authorization: "Bearer agent-secret" },
  });
  assert.equal(runtimes.statusCode, 200);
  assert.equal(runtimes.json().data.find((runtime) => runtime.id === "runtime_local_docker").status, "offline");
});

test("node agent rejects unknown management request fields", async (t) => {
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-unknown-management-fields"),
    logger: false,
    token: "agent-secret",
  });
  t.after(() => app.close());

  const runtime = await app.inject({
    method: "POST",
    url: "/api/node-agent/runtimes",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "runtime_unknown_fields",
      name: "Unknown fields runtime",
      type: "docker",
      defaultRuntimeTargetId: "ignored",
    },
  });
  assert.equal(runtime.statusCode, 400);

  const cleanRuntime = await app.inject({
    method: "POST",
    url: "/api/node-agent/runtimes",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "runtime_unknown_fields",
      name: "Unknown fields runtime",
      type: "docker",
    },
  });
  assert.equal(cleanRuntime.statusCode, 201);

  const updatedRuntime = await app.inject({
    method: "PATCH",
    url: "/api/node-agent/runtimes/runtime_unknown_fields",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      name: "Updated runtime",
      defaultRuntimeTargetId: "ignored",
    },
  });
  assert.equal(updatedRuntime.statusCode, 400);

  const folder = await app.inject({
    method: "POST",
    url: "/api/node-agent/local-folders",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      name: "Unknown fields folder",
      path: "/tmp/task-handoff-unknown-folder",
      defaultRuntimeTargetId: "ignored",
    },
  });
  assert.equal(folder.statusCode, 400);
});

test("node agent starts localhost runtime as a host controlled-instance process", async (t) => {
  const dataDir = tempDataDir("node-agent-localhost-process");
  const webStubDir = path.join(dataDir, "controlled runtime");
  fs.mkdirSync(webStubDir, { recursive: true });
  const webStub = path.join(webStubDir, "controlled-web-stub.js");
  const envLog = path.join(dataDir, "controlled-web-env.jsonl");
  fs.writeFileSync(
    webStub,
    [
      "const fs = require('node:fs');",
      "const http = require('node:http');",
      "const port = Number(process.env.TASK_HANDOFF_WEB_PORT);",
      "(async () => {",
      "const registered = await fetch(`${process.env.TASK_HANDOFF_NODE_AGENT_URL}/api/node-agent/instances/${process.env.TASK_HANDOFF_INSTANCE_ID}/register`, {",
      "  method: 'POST',",
      "  headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TASK_HANDOFF_REGISTRATION_TOKEN}` },",
      "  body: JSON.stringify({",
      "    instanceId: process.env.TASK_HANDOFF_INSTANCE_ID,",
      "    nodeId: process.env.TASK_HANDOFF_NODE_ID,",
      "    runtimeId: process.env.TASK_HANDOFF_RUNTIME_ID,",
      `    protocolVersion: '${CONTROL_PLANE_PROTOCOL_VERSION}',`,
      "    build: { component: 'controlled-instance' },",
      "    controlMode: 'controlled',",
      `    capabilities: { protocolVersion: '${CONTROL_PLANE_PROTOCOL_VERSION}', features: {} },`,
      "    appInventory: { items: [], observedAt: new Date().toISOString(), issues: [] },",
      "    target: { strategy: 'direct-port', web: `http://127.0.0.1:${port}`, api: `http://127.0.0.1:${port}/api`, status: 'reachable' },",
      "    workspace: { mode: 'local-bind', status: 'ready', path: process.env.TASK_HANDOFF_WORKSPACE, exists: true },",
      "  }),",
      "});",
      "if (!registered.ok) { throw new Error(`register failed ${registered.status}: ${await registered.text()}`); }",
      "const heartbeat = await fetch(`${process.env.TASK_HANDOFF_NODE_AGENT_URL}/api/node-agent/instances/${process.env.TASK_HANDOFF_INSTANCE_ID}/heartbeat`, {",
      "  method: 'POST',",
      "  headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TASK_HANDOFF_REGISTRATION_TOKEN}` },",
      "  body: JSON.stringify({",
      "    status: 'running',",
      "    health: 'ok',",
      `    protocolVersion: '${CONTROL_PLANE_PROTOCOL_VERSION}',`,
      "    build: { component: 'controlled-instance' },",
      "    appInventory: { items: [], observedAt: new Date().toISOString(), issues: [] },",
      "    apps: { runningCount: 0, problemCount: 0 },",
      "    target: { status: 'reachable' },",
      "    workspace: { mode: 'local-bind', status: 'ready', path: process.env.TASK_HANDOFF_WORKSPACE, exists: true },",
      "  }),",
      "});",
      "if (!heartbeat.ok) { throw new Error(`heartbeat failed ${heartbeat.status}: ${await heartbeat.text()}`); }",
      `fs.appendFileSync(${JSON.stringify(envLog)}, JSON.stringify({`,
      "  persist: process.env.TASK_HANDOFF_APP_SESSION_PERSIST,",
      "  dataDir: process.env.TASK_HANDOFF_DATA_DIR,",
      "  logDir: process.env.TASK_HANDOFF_LOG_DIR,",
      "  runtimeKind: process.env.TASK_HANDOFF_RUNTIME_KIND,",
      "  openaiKey: process.env.OPENAI_API_KEY,",
      "  argv: process.argv.slice(2),",
      "}) + '\\n');",
      "const server = http.createServer((req, res) => {",
      ...controlledProcessIdentityRouteStubLines,
      "  res.end('ok');",
      "});",
      "server.listen(port, '127.0.0.1');",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
      "})().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });",
    ].join("\n"),
  );
  const previousCommandArgv = process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV;
  process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV = JSON.stringify([process.execPath, webStub]);
  const host = "127.0.0.1";
  const port = await freePort(host);
  const app = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
    host,
    port,
  });
  t.after(async () => {
    if (previousCommandArgv === undefined) {
      delete process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV;
    } else {
      process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV = previousCommandArgv;
    }
    await app.close();
  });
  await app.listen({ host, port });

  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_local_process",
      name: "local process",
      runtimeId: "runtime_local_host",
      source: {
        type: "local-folder",
        path: dataDir,
      },
    },
  });
  assert.equal(created.statusCode, 201);
  const initialModel = await createAndAssignNodeModel(app, "inst_local_process", {
    id: "model_local_process",
    key: "instance-codex-key",
  });

  const started = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_local_process/start",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(started.statusCode, 200);
  assert.equal(started.json().data.status, "running");
  assert.equal(started.json().data.runtime.kind, "local");
  assert.equal(typeof started.json().data.runtime.pid, "number");
  assert.equal(typeof started.json().data.runtime.port, "number");
  assert.equal(started.json().data.target.web, `http://127.0.0.1:${started.json().data.runtime.port}`);
  assert.equal(started.json().data.target.status, "reachable");
  const firstPid = started.json().data.runtime.pid;
  const envLines = fs.readFileSync(envLog, "utf8").trim().split(/\n/).map((line) => JSON.parse(line));
  assert.equal(envLines[0].argv.includes("--receiver-auto-start"), false);
  assert.equal(envLines[0].runtimeKind, "local");
  assert.equal(envLines[0].openaiKey, "instance-codex-key");

  const updatedModel = await app.inject({
    method: "PATCH",
    url: `/api/node-agent/models/${initialModel.id}`,
    headers: { authorization: "Bearer agent-secret" },
    payload: { key: "restarted-codex-key" },
  });
  assert.equal(updatedModel.statusCode, 200);
  const reassigned = await app.inject({
    method: "PUT",
    url: "/api/node-agent/instances/inst_local_process/model-assignment",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      modelSelection: { codexModelHash: updatedModel.json().data.id },
      codexModelHash: updatedModel.json().data.id,
    },
  });
  assert.equal(reassigned.statusCode, 200);

  const restarted = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_local_process/restart",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(restarted.statusCode, 200);
  assert.equal(restarted.json().data.status, "running");
  assert.notEqual(restarted.json().data.runtime.pid, firstPid);
  await waitForProcessExit(firstPid, "replaced localhost controlled instance");
  const restartedEnvLines = fs.readFileSync(envLog, "utf8").trim().split(/\n/).map((line) => JSON.parse(line));
  assert.equal(restartedEnvLines.length, 2);
  assert.equal(restartedEnvLines[1].openaiKey, "restarted-codex-key");

  const noModelAssignment = await app.inject({
    method: "PUT",
    url: "/api/node-agent/instances/inst_local_process/model-assignment",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      modelSelection: { codexModelHash: null },
    },
  });
  assert.equal(noModelAssignment.statusCode, 200);
  assert.deepEqual(noModelAssignment.json().data.instance.modelSelection, { codexModelHash: null });

  const restartedWithoutModel = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_local_process/restart",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(restartedWithoutModel.statusCode, 200);
  assert.equal(restartedWithoutModel.json().data.status, "running");
  const noModelEnvLines = fs.readFileSync(envLog, "utf8").trim().split(/\n/).map((line) => JSON.parse(line));
  assert.equal(noModelEnvLines.length, 3);
  assert.equal(noModelEnvLines[2].openaiKey, process.env.OPENAI_API_KEY);
  assert.notEqual(noModelEnvLines[2].openaiKey, "restarted-codex-key");

  const stopped = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_local_process/stop",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(stopped.statusCode, 200);
  assert.equal(stopped.json().data.status, "stopped");
});

test("localhost process spawn failures fail the instance without crashing node agent", async (t) => {
  const dataDir = tempDataDir("node-agent-localhost-spawn-failure");
  const inaccessibleCommand = path.join(dataDir, "controlled-instance-no-exec");
  fs.writeFileSync(inaccessibleCommand, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  const previousCommandArgv = process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV;
  process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV = JSON.stringify([inaccessibleCommand]);
  const app = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
  });
  t.after(async () => {
    if (previousCommandArgv === undefined) {
      delete process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV;
    } else {
      process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV = previousCommandArgv;
    }
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_local_spawn_failure",
      name: "local spawn failure",
      runtimeId: "runtime_local_host",
      source: { type: "local-folder", path: dataDir },
    },
  });

  const started = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_local_spawn_failure/start",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(started.statusCode, 500);
  assert.equal(started.json().error.code, "LOCAL_INSTANCE_PROCESS_SPAWN_FAILED");

  const failedInstance = await app.inject({
    method: "GET",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
  });
  assert.equal(failedInstance.statusCode, 200);
  const failed = failedInstance.json().data.find((instance) => instance.id === "inst_local_spawn_failure");
  assert.equal(failed.status, "failed");
  assert.equal(failed.health, "failed");
  assert.equal(failed.workspace.error, started.json().error.message);

  const health = await app.inject({
    method: "GET",
    url: "/api/node-agent/health",
    headers: { authorization: "Bearer agent-secret" },
  });
  assert.equal(health.statusCode, 200);
});

test("localhost startup rejects a stale healthy process already bound to the instance port", async (t) => {
  const dataDir = tempDataDir("node-agent-localhost-stale-port");
  const webStub = path.join(dataDir, "controlled-web-stub.js");
  fs.writeFileSync(
    webStub,
    [
      "const http = require('node:http');",
      "const port = Number(process.env.TASK_HANDOFF_WEB_PORT);",
      "http.createServer((_req, res) => res.end('ok')).listen(port, '127.0.0.1');",
    ].join("\n"),
  );
  const stalePort = await freePort("127.0.0.1");
  const staleServer = net.createServer((socket) => {
    const body = JSON.stringify({ data: { ok: true, version: "old", startedAt: "2026-07-26T00:00:00.000Z" } });
    socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
  });
  await new Promise((resolve, reject) => {
    staleServer.once("error", reject);
    staleServer.listen(stalePort, "127.0.0.1", resolve);
  });
  const previousCommandArgv = process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV;
  process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV = JSON.stringify([process.execPath, webStub]);
  const app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret" });
  t.after(async () => {
    staleServer.close();
    if (previousCommandArgv === undefined) delete process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV;
    else process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV = previousCommandArgv;
    await app.close();
  });

  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_local_stale_port",
      name: "local stale port",
      runtimeId: "runtime_local_host",
      source: { type: "local-folder", path: dataDir },
    },
  });
  const instance = app.nodeAgentState.controlledInstances.get(created.json().data.id);
  app.nodeAgentState.controlledInstances.put({
    ...instance,
    runtime: { ...instance.runtime, port: stalePort },
  });

  const started = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_local_stale_port/start",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(started.statusCode, 503);
  assert.equal(started.json().error.code, "LOCAL_INSTANCE_PROCESS_NOT_READY");
  const failed = app.nodeAgentState.controlledInstances.get("inst_local_stale_port");
  assert.equal(failed.status, "failed");
  assert.notEqual(failed.runtime.pid, process.pid);
});

test("localhost stop uses authenticated process identity after node agent process ownership is lost", async (t) => {
  const dataDir = tempDataDir("node-agent-localhost-detached-stop");
  const webStub = path.join(dataDir, "controlled-web-stub.js");
  fs.writeFileSync(
    webStub,
    [
      "const http = require('node:http');",
      "const port = Number(process.env.TASK_HANDOFF_WEB_PORT);",
      "const server = http.createServer((req, res) => {",
      "  res.setHeader('content-type', 'application/json');",
      ...controlledProcessIdentityRouteStubLines,
      "  if (req.url === '/api/internal/node-agent/shutdown' && req.method === 'POST' && req.headers.authorization === `Bearer ${process.env.TASK_HANDOFF_REGISTRATION_TOKEN}`) {",
      "    res.statusCode = 202; res.end(JSON.stringify({ data: { accepted: true } }));",
      "    setImmediate(() => server.close(() => process.exit(0))); return;",
      "  }",
      "  res.statusCode = 403; res.end(JSON.stringify({ error: { code: 'FORBIDDEN' } }));",
      "});",
      "server.listen(port, '127.0.0.1');",
    ].join("\n"),
  );
  const app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret" });
  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_local_detached_stop",
      name: "local detached stop",
      runtimeId: "runtime_local_host",
      source: { type: "local-folder", path: dataDir },
    },
  });
  assert.equal(created.statusCode, 201);
  const instance = app.nodeAgentState.controlledInstances.get("inst_local_detached_stop");
  const runtimePort = await freePort("127.0.0.1");
  const processNonce = "detached-process-nonce";
  const child = spawn(process.execPath, [webStub], {
    env: {
      ...process.env,
      TASK_HANDOFF_WEB_PORT: String(runtimePort),
      TASK_HANDOFF_INSTANCE_ID: instance.id,
      TASK_HANDOFF_LOCAL_PROCESS_NONCE: processNonce,
      TASK_HANDOFF_REGISTRATION_TOKEN: instance.registrationToken,
    },
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await app.close();
  });
  await waitForCondition(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${runtimePort}/api/health`);
      return response.ok || undefined;
    } catch {
      return undefined;
    }
  }, "detached localhost process health");
  app.nodeAgentState.controlledInstances.put({
    ...instance,
    status: "running",
    connectionStatus: "online",
    target: {
      ...instance.target,
      web: `http://127.0.0.1:${runtimePort}`,
      api: `http://127.0.0.1:${runtimePort}/api`,
      status: "reachable",
    },
    runtime: {
      ...instance.runtime,
      pid: child.pid,
      port: runtimePort,
      labels: {
        ...instance.runtime.labels,
        "task-handoff.local-process-nonce": processNonce,
      },
    },
  });

  const stopped = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_local_detached_stop/stop",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(stopped.statusCode, 200);
  assert.equal(stopped.json().data.status, "stopped");
  await waitForProcessExit(child.pid, "detached localhost controlled instance exit");
});

test("localhost stop allows an exited residual lock owner to be reclaimed", async (t) => {
  const dataDir = tempDataDir("node-agent-localhost-stale-residual-lock-stop");
  const lockPath = path.join(dataDir, "host-user-local-instance.lock");
  const instanceId = "inst_local_stale_residual_lock_stop";
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({
    pid: 99999999,
    hostname: os.hostname(),
    component: "local-controlled-instance",
    command: "task-handoff-controlled-instance web",
    acquiredAt: "2026-07-30T17:38:00.000Z",
    token: "stale-owner-token",
    startIdentity: "linux:123456",
    instanceId,
    dataDir: path.join(dataDir, "local-instances", instanceId),
    host: "127.0.0.1",
    port: 19000,
  }, null, 2)}\n`);
  const app = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
    localControlledInstanceLockPath: lockPath,
  });
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: instanceId,
      name: "stale residual local instance",
      runtimeId: "runtime_local_host",
      source: { type: "local-folder", path: dataDir },
    },
  });
  const instance = app.nodeAgentState.controlledInstances.get(instanceId);
  app.nodeAgentState.controlledInstances.put({
    ...instance,
    status: "running",
    runtime: { ...instance.runtime, pid: 99999999 },
  });

  const stopped = await app.inject({
    method: "POST",
    url: `/api/node-agent/instances/${instanceId}/stop`,
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(stopped.statusCode, 200);
  assert.equal(stopped.json().data.status, "stopped");

  const reclaimed = acquireLocalControlledInstanceLock({
    instanceId,
    dataDir: path.join(dataDir, "local-instances", instanceId),
    host: "127.0.0.1",
    port: 19001,
  }, lockPath);
  assert.equal(reclaimed.owner.pid, process.pid);
  reclaimed.release();
});

test("localhost stop refuses to kill an unverifiable residual lock pid", async (t) => {
  const dataDir = tempDataDir("node-agent-localhost-residual-lock-stop");
  const lockPath = path.join(dataDir, "host-user-local-instance.lock");
  const lockModule = path.resolve(__dirname, "../packages/core/src/core/local-controlled-instance-lock.ts");
  const instanceId = "inst_local_residual_lock_stop";
  const child = spawn(process.execPath, ["-e", String.raw`
    const { acquireLocalControlledInstanceLock } = require(process.argv[1]);
    const instanceId = process.argv[2];
    const lockPath = process.argv[3];
    const lock = acquireLocalControlledInstanceLock({ instanceId, dataDir: process.argv[4] }, lockPath);
    const close = () => { lock.release(); process.exit(0); };
    process.once("SIGTERM", close);
    setInterval(() => {}, 1000);
  `, lockModule, instanceId, lockPath, path.join(dataDir, "other-node-agent-config")], {
    stdio: "ignore",
  });
  const app = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
    localControlledInstanceLockPath: lockPath,
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await app.close();
  });

  await waitForCondition(() => readLocalControlledInstanceLockOwner(lockPath)?.pid === child.pid || undefined, "residual local instance lock owner");
  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: instanceId,
      name: "residual local instance",
      runtimeId: "runtime_local_host",
      source: { type: "local-folder", path: dataDir },
    },
  });
  assert.equal(created.statusCode, 201);
  const instance = app.nodeAgentState.controlledInstances.get(instanceId);
  app.nodeAgentState.controlledInstances.put({
    ...instance,
    status: "running",
    runtime: { ...instance.runtime, pid: 99999999 },
  });

  const stopped = await app.inject({
    method: "POST",
    url: `/api/node-agent/instances/${instanceId}/stop`,
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(stopped.statusCode, 503);
  assert.equal(stopped.json().error.code, "LOCAL_INSTANCE_STOP_UNCONFIRMED");
  assert.equal(child.exitCode, null);
  assert.equal(app.nodeAgentState.controlledInstances.get(instanceId).status, "running");
});

test("localhost stop migrates a legacy residual process using its reported instance identity and pid", async (t) => {
  const dataDir = tempDataDir("node-agent-localhost-legacy-residual-stop");
  const lockPath = path.join(dataDir, "unused-new-lock.lock");
  const runtimePort = await freePort("127.0.0.1");
  const instanceId = "inst_local_legacy_residual_stop";
  const child = spawn(process.execPath, ["-e", String.raw`
    const http = require("node:http");
    const port = Number(process.argv[1]);
    const instanceId = process.argv[2];
    const server = http.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/instance/status") {
        response.end(JSON.stringify({ data: { id: instanceId, controlMode: "controlled" } }));
        return;
      }
      if (request.url === "/api/diagnostics") {
        response.end(JSON.stringify({ data: { runtime: { pid: process.pid } } }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
    });
    server.listen(port, "127.0.0.1");
    process.once("SIGTERM", () => server.close(() => process.exit(0)));
  `, String(runtimePort), instanceId], { stdio: "ignore" });
  const app = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
    localControlledInstanceLockPath: lockPath,
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await app.close();
  });
  await waitForCondition(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${runtimePort}/api/instance/status`)).ok || undefined;
    } catch {
      return undefined;
    }
  }, "legacy residual local instance status");

  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: instanceId,
      name: "legacy residual local instance",
      runtimeId: "runtime_local_host",
      source: { type: "local-folder", path: dataDir },
    },
  });
  assert.equal(created.statusCode, 201);
  const instance = app.nodeAgentState.controlledInstances.get(instanceId);
  app.nodeAgentState.controlledInstances.put({
    ...instance,
    status: "running",
    target: {
      ...instance.target,
      web: `http://127.0.0.1:${runtimePort}`,
      api: `http://127.0.0.1:${runtimePort}/api`,
    },
    runtime: { ...instance.runtime, pid: 99999999, port: runtimePort },
  });

  const stopped = await app.inject({
    method: "POST",
    url: `/api/node-agent/instances/${instanceId}/stop`,
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(stopped.statusCode, 200);
  assert.equal(stopped.json().data.status, "stopped");
});

test("node agent shutdown stops localhost processes while preserving active restore state", async (t) => {
  const dataDir = tempDataDir("node-agent-localhost-shutdown");
  const webStub = path.join(dataDir, "controlled-web-stub.js");
  const signalLog = path.join(dataDir, "controlled-web-signal.jsonl");
  fs.writeFileSync(
    webStub,
    [
      "const fs = require('node:fs');",
      "const http = require('node:http');",
      "const port = Number(process.env.TASK_HANDOFF_WEB_PORT);",
      "const server = http.createServer((req, res) => {",
      ...controlledProcessIdentityRouteStubLines,
      "  res.end('ok');",
      "});",
      "server.listen(port, '127.0.0.1');",
      "process.on('SIGTERM', () => {",
      `  fs.appendFileSync(${JSON.stringify(signalLog)}, JSON.stringify({ signal: 'SIGTERM', pid: process.pid }) + '\\n');`,
      "  server.close(() => process.exit(0));",
      "});",
    ].join("\n"),
  );
  const previousCommandArgv = process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV;
  process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV = JSON.stringify([process.execPath, webStub]);
  const host = "127.0.0.1";
  const port = await freePort(host);
  const app = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
    host,
    port,
    dockerCommandRunner: async (_command, args) => {
      if (args[0] === "image") return { stdout: JSON.stringify({ Id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", RepoDigests: [] }), stderr: "" };
      return { stdout: "", stderr: "" };
    },
  });
  t.after(async () => {
    if (previousCommandArgv === undefined) {
      delete process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV;
    } else {
      process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV = previousCommandArgv;
    }
    try {
      await app.close();
    } catch {
      // The test closes the app explicitly.
    }
  });
  await app.listen({ host, port });

  const localCreated = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_local_shutdown",
      name: "local shutdown",
      runtimeId: "runtime_local_host",
      source: {
        type: "local-folder",
        path: dataDir,
      },
    },
  });
  assert.equal(localCreated.statusCode, 201);

  const timestamp = new Date().toISOString();
  const dockerCreated = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_docker_shutdown",
      name: "docker shutdown",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_1" },
      image: testInstanceImage("task-handoff-web:local", "img_1", "Image"),
      source: {
        type: "git-repository",
        url: "https://example.com/repo.git",
        ref: { type: "branch", name: "main" },
        auth: { type: "none" },
        clone: { submodules: false, lfs: false, subdirectory: "" },
      },
    },
  });
  assert.equal(dockerCreated.statusCode, 201);
  const dockerStatusBeforeShutdown = await waitForCondition(() => {
    const status = app.nodeAgentState.controlledInstances.get("inst_docker_shutdown")?.status;
    return status && status !== "provisioning" ? status : undefined;
  }, "docker image provisioning completion");

  const started = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_local_shutdown/start",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(started.statusCode, 200);
  const pid = started.json().data.runtime.pid;
  assert.equal(typeof pid, "number");

  await app.close();
  await waitForProcessExit(pid, "localhost controlled instance exit");
  const signalRows = fs.readFileSync(signalLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(signalRows.map((row) => row.signal), ["SIGTERM"]);

  const localRecord = JSON.parse(fs.readFileSync(path.join(dataDir, "controlled-instances", "inst_local_shutdown.json"), "utf8"));
  assert.equal(localRecord.status, "registering");
  assert.equal(localRecord.connectionStatus, "offline");
  const dockerRecord = JSON.parse(fs.readFileSync(path.join(dataDir, "controlled-instances", "inst_docker_shutdown.json"), "utf8"));
  assert.equal(dockerRecord.status, dockerStatusBeforeShutdown);
  assert.equal(dockerRecord.connectionStatus, "unknown");
});

test("node agent restores localhost runtime processes after graceful shutdown", async (t) => {
  const dataDir = tempDataDir("node-agent-localhost-restore");
  const webStub = path.join(dataDir, "controlled-web-stub.js");
  const envLog = path.join(dataDir, "controlled-web-env.jsonl");
  fs.writeFileSync(
    webStub,
    [
      "const fs = require('node:fs');",
      "const http = require('node:http');",
      "const port = Number(process.env.TASK_HANDOFF_WEB_PORT);",
      `fs.appendFileSync(${JSON.stringify(envLog)}, JSON.stringify({`,
      "  persist: process.env.TASK_HANDOFF_APP_SESSION_PERSIST,",
      "  dataDir: process.env.TASK_HANDOFF_DATA_DIR,",
      "  logDir: process.env.TASK_HANDOFF_LOG_DIR,",
      "  apiKey: process.env.OPENAI_API_KEY,",
      "  baseUrl: process.env.OPENAI_BASE_URL,",
      "}) + '\\n');",
      "const server = http.createServer((req, res) => {",
      ...controlledProcessIdentityRouteStubLines,
      "  res.end('ok');",
      "});",
      "server.listen(port, '127.0.0.1');",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
    ].join("\n"),
  );
  const previousCommandArgv = process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV;
  process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV = JSON.stringify([process.execPath, webStub]);
  const host = "127.0.0.1";
  const port = await freePort(host);
  let app = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
    host,
    port,
  });
  t.after(async () => {
    if (previousCommandArgv === undefined) {
      delete process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV;
    } else {
      process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV = previousCommandArgv;
    }
    await app.close();
  });
  await app.listen({ host, port });

  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_local_restore",
      name: "local restore",
      runtimeId: "runtime_local_host",
      source: {
        type: "local-folder",
        path: dataDir,
      },
    },
  });
  assert.equal(created.statusCode, 201);
  const restoreModel = await createAndAssignNodeModel(app, "inst_local_restore", {
    id: "model_local_restore",
    key: "restore-key-secret",
    endpoint: "https://restore.example/v1",
    model: "gpt-restore",
  });

  const started = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_local_restore/start",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(started.statusCode, 200);
  const firstPid = started.json().data.runtime.pid;
  const firstPort = started.json().data.runtime.port;
  assert.equal(started.json().data.status, "registering");
  assert.equal(started.json().data.target.status, "reachable");

  await app.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  app = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
    host,
    port,
  });
  await app.listen({ host, port });
  await app.nodeAgentRestoreManagedInstances();

  const listed = await withTimeout(
    (async () => {
      for (;;) {
        const response = await app.inject({
          method: "GET",
          url: "/api/node-agent/instances",
          headers: { authorization: "Bearer agent-secret" },
        });
        const candidate = response.json().data.find((item) => item.id === "inst_local_restore");
        if (candidate?.status === "registering" && candidate?.runtime?.pid !== firstPid && candidate?.target?.status === "reachable") {
          return response;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })(),
    "graceful localhost runtime restore",
    3000,
  );
  const instance = listed.json().data.find((item) => item.id === "inst_local_restore");
  assert.equal(instance.status, "registering");
  assert.equal(instance.connectionStatus, "online");
  assert.equal(instance.runtime.port, firstPort);
  assert.notEqual(instance.runtime.pid, firstPid);
  const envRows = fs.readFileSync(envLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(envRows.length, 2);
  assert.deepEqual(envRows.map((row) => row.persist), ["1", "1"]);
  assert.deepEqual(envRows.map((row) => row.apiKey), ["restore-key-secret", "restore-key-secret"]);
  assert.deepEqual(envRows.map((row) => row.baseUrl), ["https://restore.example/v1", "https://restore.example/v1"]);
  const modelEnvironmentPath = path.join(dataDir, "model-environments", "inst_local_restore.json");
  assert.equal(fs.existsSync(modelEnvironmentPath), false);
  assert.equal(fs.statSync(path.join(dataDir, "models", `${restoreModel.id}.json`)).mode & 0o777, 0o600);
});

test("node agent restores active localhost runtime processes after unclean shutdown state", async (t) => {
  const dataDir = tempDataDir("node-agent-localhost-restore-unclean");
  const webStub = path.join(dataDir, "controlled-web-stub.js");
  const envLog = path.join(dataDir, "controlled-web-env.jsonl");
  const requestLog = path.join(dataDir, "controlled-web-requests.jsonl");
  fs.writeFileSync(
    webStub,
    [
      "const fs = require('node:fs');",
      "const http = require('node:http');",
      "const port = Number(process.env.TASK_HANDOFF_WEB_PORT);",
      `fs.appendFileSync(${JSON.stringify(envLog)}, JSON.stringify({`,
      "  pid: process.pid,",
      "  processNonce: process.env.TASK_HANDOFF_LOCAL_PROCESS_NONCE,",
      "  releaseVersion: process.env.TASK_HANDOFF_CONTROLLED_INSTANCE_VERSION,",
      "  persist: process.env.TASK_HANDOFF_APP_SESSION_PERSIST,",
      "  dataDir: process.env.TASK_HANDOFF_DATA_DIR,",
      "  logDir: process.env.TASK_HANDOFF_LOG_DIR,",
      "}) + '\\n');",
      "const server = http.createServer((req, res) => {",
      `  fs.appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify({ method: req.method, url: req.url }) + '\\n');`,
      ...controlledProcessIdentityRouteStubLines,
      "  if (req.url === '/api/internal/node-agent/shutdown' && req.method === 'POST' && req.headers.authorization === `Bearer ${process.env.TASK_HANDOFF_REGISTRATION_TOKEN}`) { res.end('ok'); setImmediate(() => process.kill(process.pid, 'SIGTERM')); return; }",
      "  if (req.url && req.url.startsWith('/api/config-sync/import/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: { ok: true } })); return; }",
      "  res.end('ok');",
      "});",
      "server.listen(port, '127.0.0.1');",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
    ].join("\n"),
  );
  const previousCommandArgv = process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV;
  process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV = JSON.stringify([process.execPath, webStub]);
  const host = "127.0.0.1";
  const port = await freePort(host);
  let app = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
    host,
    port,
  });
  t.after(async () => {
    if (previousCommandArgv === undefined) {
      delete process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV;
    } else {
      process.env.TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV = previousCommandArgv;
    }
    await app.close();
  });
  await app.listen({ host, port });
  await app.nodeAgentRestoreManagedInstances();

  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_local_restore_unclean",
      name: "local restore",
      runtimeId: "runtime_local_host",
      source: {
        type: "local-folder",
        path: dataDir,
      },
    },
  });
  assert.equal(created.statusCode, 201);

  const started = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_local_restore_unclean/start",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(started.statusCode, 200);
  const firstPid = started.json().data.runtime.pid;
  const firstPort = started.json().data.runtime.port;
  assert.equal(started.json().data.status, "registering");
  assert.equal(started.json().data.target.status, "reachable");

  const child = app.nodeAgentState.controlledInstances.get("inst_local_restore_unclean");
  app.nodeAgentState.controlledInstances.put({ ...child, status: "running", connectionStatus: "online" });
  await app.close();
  const orphanNonce = "previous-node-agent-process";
  const orphan = spawn(process.execPath, [webStub], {
    cwd: dataDir,
    stdio: "ignore",
    env: {
      ...process.env,
      TASK_HANDOFF_APP_SESSION_PERSIST: undefined,
      TASK_HANDOFF_CONTROLLED_INSTANCE_VERSION: undefined,
      TASK_HANDOFF_INSTANCE_ID: child.id,
      TASK_HANDOFF_REGISTRATION_TOKEN: child.registrationToken,
      TASK_HANDOFF_LOCAL_PROCESS_NONCE: orphanNonce,
      TASK_HANDOFF_WEB_PORT: String(firstPort),
      TASK_HANDOFF_DATA_DIR: path.join(dataDir, "local-instances", child.id),
      TASK_HANDOFF_LOG_DIR: path.join(dataDir, "local-instances", child.id, "logs"),
    },
  });
  assert.equal(typeof orphan.pid, "number");
  t.after(() => {
    try {
      process.kill(orphan.pid, "SIGKILL");
    } catch {
      // The restore path already stopped the orphan.
    }
  });
  await waitForCondition(async () => {
    try {
      return (await fetch(`http://${host}:${firstPort}/api/health`)).ok;
    } catch {
      return false;
    }
  }, "orphaned localhost runtime readiness");
  app.nodeAgentState.controlledInstances.put({
    ...child,
    status: "running",
    connectionStatus: "online",
    runtime: {
      ...child.runtime,
      pid: orphan.pid,
      labels: {
        ...child.runtime.labels,
        "task-handoff.local-process-nonce": orphanNonce,
      },
    },
  });
  app = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
    host,
    port,
  });
  await app.listen({ host, port });
  await app.nodeAgentRestoreManagedInstances();

  const restored = await withTimeout(
    (async () => {
      for (;;) {
        const response = await app.inject({
          method: "GET",
          url: "/api/node-agent/instances",
          headers: { authorization: "Bearer agent-secret" },
        });
        const instance = response.json().data.find((item) => item.id === "inst_local_restore_unclean");
        if (instance?.status === "registering" && instance?.runtime?.pid !== firstPid && instance?.target?.status === "reachable") {
          return response;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })(),
    "localhost runtime restore",
    3000,
  );
  assert.equal(restored.statusCode, 200);
  const instance = restored.json().data.find((item) => item.id === "inst_local_restore_unclean");
  assert.equal(instance.status, "registering");
  assert.equal(instance.connectionStatus, "online");
  assert.equal(instance.target.status, "reachable");
  assert.equal(instance.runtime.port, firstPort);
  assert.equal(typeof instance.runtime.pid, "number");
  assert.notEqual(instance.runtime.pid, firstPid);
  assert.notEqual(instance.runtime.pid, orphan.pid);
  await waitForProcessExit(orphan.pid, "orphaned localhost controlled instance exit");
  const envRows = fs.readFileSync(envLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(envRows.length, 3);
  assert.deepEqual(envRows.map((row) => row.persist), ["1", undefined, "1"]);
  assert.equal(typeof envRows[0].releaseVersion, "string");
  assert.equal(envRows[2].releaseVersion, envRows[0].releaseVersion);
  assert.equal(envRows[1].releaseVersion, undefined);
  assert.ok(envRows.every((row) => row.dataDir.includes("local-instances/inst_local_restore_unclean")));
  assert.ok(envRows.every((row) => row.logDir.includes("local-instances/inst_local_restore_unclean/logs")));
  const requestRows = await waitForCondition(() => {
    const rows = fs.readFileSync(requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    return rows.filter((row) => row.url.startsWith("/api/config-sync/import/")).length === 4 ? rows : undefined;
  }, "localhost runtime config auto-imports");
  assert.deepEqual(
    requestRows.filter((row) => row.url.startsWith("/api/config-sync/import/")).map((row) => `${row.method} ${row.url}`),
    [
      "POST /api/config-sync/import/codex",
      "POST /api/config-sync/import/claude",
      "POST /api/config-sync/import/codex",
      "POST /api/config-sync/import/claude",
    ],
  );
});

test("node agent accepts incompatible controlled instance protocol versions and keeps the reported version", async (t) => {
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-protocol-mismatch"),
    logger: false,
    token: "agent-secret",
  });
  t.after(() => app.close());

  const timestamp = new Date().toISOString();
  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: {
      authorization: "Bearer agent-secret",
    },
    payload: {
      id: "inst_protocol",
      name: "worker",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_1" },
      image: testInstanceImage("task-handoff-web:local", "img_1", "Image"),
      source: {
        type: "git-repository",
        url: "https://github.com/example/repo.git",
      },
    },
  });
  assert.equal(created.statusCode, 201);
  const token = created.json().data.registrationToken;

  const rejectedRegister = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_protocol/register",
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      instanceId: "inst_protocol",
      name: "worker",
      protocolVersion: "2026-01-01",
      imageId: "img_1",
      legacyRegistrationField: true,
      target: {
        strategy: "direct-port",
        status: "reachable",
        web: "http://127.0.0.1:18080",
      },
      workspace: {
        status: "ready",
      },
    },
  });
  assert.equal(rejectedRegister.statusCode, 201);
  assert.equal(rejectedRegister.json().data.protocolVersion, "2026-01-01");

  const registered = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_protocol/register",
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      instanceId: "inst_protocol",
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      appInventory: emptyAppInventory(),
      build: {
        component: "controlled-instance",
        packageVersion: "0.1.0",
        buildId: "build-1",
        imageRef: "task-handoff-web:test",
      },
      target: {
        strategy: "direct-port",
        status: "reachable",
        web: "http://127.0.0.1:18080",
      },
      workspace: {
        status: "ready",
      },
    },
  });
  assert.equal(registered.statusCode, 201);
  assert.equal(registered.json().data.build.buildId, "build-1");
  assert.equal(registered.json().data.build.imageRef, "task-handoff-web:test");

  const rejectedHeartbeat = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_protocol/heartbeat",
    headers: {
      authorization: `Bearer ${token}`,
    },
    payload: {
      protocolVersion: "2026-01-01",
      status: "running",
      health: "ok",
      receiver: { status: "running", pendingCount: 1 },
      target: {
        status: "reachable",
      },
    },
  });
  assert.equal(rejectedHeartbeat.statusCode, 200);
  assert.equal(rejectedHeartbeat.json().data.protocolVersion, "2026-01-01");
});

test("controlled instance registration preserves the node-owned name after rename", async (t) => {
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-instance-name-authority"),
    logger: false,
    token: "agent-secret",
  });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_renamed",
      name: "Original name",
      runtimeId: "runtime_local_host",
      source: { type: "local-folder", path: "/workspace" },
    },
  });
  assert.equal(created.statusCode, 201);

  const renamed = await app.inject({
    method: "PATCH",
    url: "/api/node-agent/instances/inst_renamed",
    headers: { authorization: "Bearer agent-secret" },
    payload: { name: "Renamed in control plane" },
  });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().data.name, "Renamed in control plane");

  const registered = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_renamed/register",
    headers: { authorization: `Bearer ${created.json().data.registrationToken}` },
    payload: {
      instanceId: "inst_renamed",
      name: "Original name",
      protocolVersion: "2026-07-28",
      controlMode: "controlled",
      capabilities: {},
      appInventory: emptyAppInventory(),
      target: { strategy: "direct-port", status: "reachable" },
      workspace: { status: "ready" },
    },
  });
  assert.equal(registered.statusCode, 201);
  assert.equal(registered.json().data.name, "Renamed in control plane");
  assert.equal(app.nodeAgentState.controlledInstances.get("inst_renamed").name, "Renamed in control plane");
});

test("register and heartbeat preserve authoritative convergence attempts and failures", async (t) => {
  const desiredVersion = runtimeVersionStateForActual().desiredVersion;
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-convergence-report-preservation"),
    logger: false,
    token: "agent-secret",
  });
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_attempts",
      runtimeId: "runtime_local_host",
      projectId: "proj_attempts",
      source: { type: "local-folder", path: "/workspace" },
      sourceSnapshot: {},
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const original = app.nodeAgentState.controlledInstances.get("inst_attempts");
  app.nodeAgentState.controlledInstances.put(ControlledInstanceSchema.parse({
    ...original,
    runtimeId: "runtime_local_docker",
    status: "running",
    build: { component: "controlled-instance", packageVersion: "0.9.0" },
    runtimeVersion: {
      desiredVersion,
      actualVersion: "0.9.0",
      phase: "failed",
      attempt: 3,
      error: {
        code: "INSTANCE_RUNTIME_INSTALL_FAILED",
        message: "bounded retries exhausted",
        expectedVersion: desiredVersion,
        actualVersion: "0.9.0",
        retryable: false,
      },
    },
  }));
  const registrationToken = created.json().data.registrationToken;
  const report = {
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    appInventory: emptyAppInventory(),
    build: { component: "controlled-instance", packageVersion: "0.9.0" },
    target: { strategy: "node-proxy", status: "reachable", web: "http://127.0.0.1:18080" },
    workspace: { status: "ready" },
  };
  const registered = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_attempts/register",
    headers: { authorization: `Bearer ${registrationToken}` },
    payload: { ...report, instanceId: "inst_attempts" },
  });
  assert.equal(registered.statusCode, 201, registered.body);
  assert.equal(registered.json().data.ready, false);
  assert.equal(registered.json().data.runtimeVersion.phase, "failed");
  assert.equal(registered.json().data.runtimeVersion.attempt, 3);
  assert.equal(registered.json().data.runtimeVersion.error.message, "bounded retries exhausted");

  const heartbeat = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_attempts/heartbeat",
    headers: { authorization: `Bearer ${registrationToken}` },
    payload: { protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION, appInventory: emptyAppInventory(), status: "running", health: "ok", build: report.build },
  });
  assert.equal(heartbeat.statusCode, 200, heartbeat.body);
  assert.equal(heartbeat.json().data.status, "running");
  assert.equal(heartbeat.json().data.health, "ok");
  assert.equal(heartbeat.json().data.ready, true);
  assert.equal(heartbeat.json().data.runtimeVersion.phase, "failed");
  assert.equal(heartbeat.json().data.runtimeVersion.attempt, 3);

  app.nodeAgentState.controlledInstances.put(ControlledInstanceSchema.parse({
    ...app.nodeAgentState.controlledInstances.get("inst_attempts"),
    runtimeVersion: {
      desiredVersion,
      actualVersion: "0.9.0",
      phase: "pending",
      attempt: 1,
      error: {
        code: "INSTANCE_RUNTIME_INSTALL_FAILED",
        message: "docker cp could not find the launcher asset",
        expectedVersion: desiredVersion,
        actualVersion: "0.9.0",
        retryable: true,
      },
    },
  }));
  const retryHeartbeat = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_attempts/heartbeat",
    headers: { authorization: `Bearer ${registrationToken}` },
    payload: { protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION, appInventory: emptyAppInventory(), health: "ok", build: report.build },
  });
  assert.equal(retryHeartbeat.statusCode, 200, retryHeartbeat.body);
  assert.equal(retryHeartbeat.json().data.runtimeVersion.error.message, "docker cp could not find the launcher asset");
});

test("node agent rejects heartbeat reports from an obsolete process incarnation", async (t) => {
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-process-incarnation"),
    logger: false,
    token: "agent-secret",
  });
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_incarnation",
      runtimeId: "runtime_local_host",
      source: { type: "local-folder", path: "/workspace" },
      sourceSnapshot: {},
    },
  });
  const registrationToken = created.json().data.registrationToken;
  const registered = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_incarnation/register",
    headers: { authorization: `Bearer ${registrationToken}` },
    payload: {
      instanceId: "inst_incarnation",
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      appInventory: emptyAppInventory(),
      processIncarnationId: "process-current",
      target: { strategy: "direct-port", status: "reachable" },
      workspace: { status: "ready" },
    },
  });
  assert.equal(registered.statusCode, 201, registered.body);

  const currentHeartbeat = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_incarnation/heartbeat",
    headers: { authorization: `Bearer ${registrationToken}` },
    payload: {
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      appInventory: emptyAppInventory(),
      processIncarnationId: "process-current",
      status: "running",
      health: "ok",
    },
  });
  assert.equal(currentHeartbeat.statusCode, 200, currentHeartbeat.body);

  const duplicateRegistration = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_incarnation/register",
    headers: { authorization: `Bearer ${registrationToken}` },
    payload: {
      instanceId: "inst_incarnation",
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      appInventory: emptyAppInventory(),
      processIncarnationId: "process-current",
      target: { strategy: "direct-port", status: "reachable" },
      workspace: { status: "ready" },
    },
  });
  assert.equal(duplicateRegistration.statusCode, 201, duplicateRegistration.body);
  assert.equal(duplicateRegistration.json().data.status, "running");

  const staleHeartbeat = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_incarnation/heartbeat",
    headers: { authorization: `Bearer ${registrationToken}` },
    payload: {
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      appInventory: emptyAppInventory(),
      processIncarnationId: "process-obsolete",
      status: "failed",
      health: "failed",
    },
  });
  assert.equal(staleHeartbeat.statusCode, 409, staleHeartbeat.body);
  assert.equal(staleHeartbeat.json().error.code, "INSTANCE_PROCESS_INCARNATION_MISMATCH");
  const stored = app.nodeAgentState.controlledInstances.get("inst_incarnation");
  assert.equal(stored.status, "running");
  assert.equal(stored.health, currentHeartbeat.json().data.health);
});

test("node agent migrates legacy local stored endpoint-shaped instances on startup", async (t) => {
  const dataDir = tempDataDir("node-agent-invalid-stored-instance");
  const timestamp = new Date().toISOString();
  const instanceDir = path.join(dataDir, "controlled-instances");
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(
    path.join(instanceDir, "inst_legacy.json"),
    `${JSON.stringify(
      {
        id: "inst_legacy",
        name: "legacy-worker",
        source: {
          type: "local-folder",
          path: "/workspace",
          futureSourceField: true,
        },
        sourceSnapshot: {},
        nodeId: "node_old",
        runtimeId: "runtime_local_docker",
        imageSelection: { imageId: "market_taskhandoff_browser" },
        status: "running",
        health: "ok",
        connectionStatus: "online",
        agentStatus: "online",
        endpointStatus: "reachable",
        uiAccessStatus: "reachable",
        controlMode: "controlled",
        capabilities: {},
        workspace: { status: "ready" },
        endpoints: {
          strategy: "direct-port",
          status: "reachable",
          web: "http://127.0.0.1:18080",
        },
        runtime: { labels: {} },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      null,
      2,
    )}\n`,
  );

  const app = await createNodeAgentApp({
    dataDir,
    logger: false,
    nodeId: "node_current",
    token: "agent-secret",
  });
  t.after(() => app.close());

  const listed = await app.inject({
    method: "GET",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().data.length, 1);
  assert.equal(listed.json().data[0].id, "inst_legacy");
  assert.deepEqual(listed.json().data[0].target, {
    strategy: "direct-port",
    status: "reachable",
    web: "http://127.0.0.1:18080",
  });
  assert.equal("endpoints" in listed.json().data[0], false);
});

test("node agent tolerates extra fields in stored controlled instances", async (t) => {
  const dataDir = tempDataDir("node-agent-stored-instance-extra-fields");
  const timestamp = new Date().toISOString();
  const instanceDir = path.join(dataDir, "controlled-instances");
  const instanceFile = path.join(instanceDir, "inst_extra.json");
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(
    instanceFile,
    `${JSON.stringify(
      {
        id: "inst_extra",
        name: "extra-worker",
        source: {
          type: "local-folder",
          path: "/workspace",
        },
        sourceSnapshot: {},
        nodeId: "node_current",
        runtimeId: "runtime_local_docker",
        imageSelection: { imageId: "market_taskhandoff_browser" },
        status: "stopped",
        health: "ok",
        connectionStatus: "online",
        controlMode: "controlled",
        build: {
          component: "controlled-instance",
          packageVersion: "0.9.0",
          gitCommit: "x".repeat(121),
          futureBuildField: true,
        },
        capabilities: {},
        modelSelection: { futureModelSelectionField: true },
        aiSessions: {
          runningCount: 1,
          waitingCount: 0,
          staleCount: 0,
          updatedAt: timestamp,
          futureSnapshotField: true,
          sessions: [{
            id: "ai_extra",
            agent: "codex",
            status: "running",
            phase: "thinking",
            title: "x".repeat(241),
            startedAt: timestamp,
            updatedAt: timestamp,
            actions: { send: true, futureActionField: true },
            futureSessionField: true,
          }],
        },
        triggers: {
          enabledCount: 1,
          runningCount: 0,
          errorCount: 0,
          futureTriggersField: true,
          configs: [{
            configHash: "trg_12345678",
            futureConfigRecordField: true,
            config: {
              configHash: "trg_12345678",
              name: "Nightly",
              description: "x".repeat(1001),
              source: { type: "schedule", scheduleKind: "interval", intervalMs: 1000, futureSourceField: true },
              action: { promptTemplate: "Run", futureActionField: true },
              policy: { maxConcurrentRuns: 1, whenBusy: "skip", futurePolicyField: true },
              createdAt: timestamp,
              updatedAt: timestamp,
              futureTriggerConfigField: true,
            },
            deployments: [{
              configHash: "trg_12345678",
              deploymentId: "dep_1",
              instanceId: "inst_extra",
              target: { type: "ai-session", aiSessionId: "ai_extra", futureTargetField: true },
              createdAt: timestamp,
              updatedAt: timestamp,
              futureDeploymentField: true,
            }],
            runtime: [{
              configHash: "trg_12345678",
              deploymentId: "dep_1",
              instanceId: "inst_extra",
              status: "idle",
              runCount: 0,
              skippedCount: 0,
              futureRuntimeStateField: true,
            }],
          }],
          recentRuns: [{
            id: "run_1",
            configHash: "trg_12345678",
            deploymentId: "dep_1",
            instanceId: "inst_extra",
            eventType: "manual",
            status: "completed",
            target: { type: "ai-session", aiSessionId: "ai_extra", futureTargetField: true },
            promptPreview: "Run",
            startedAt: timestamp,
            completedAt: timestamp,
            futureRunField: true,
          }],
        },
        workspace: { status: "ready", futureWorkspaceField: true },
        target: {
          strategy: "direct-port",
          status: "reachable",
          web: "http://127.0.0.1:18080",
          logs: "x".repeat(2049),
          futureTargetField: true,
        },
        access: { strategy: "node-proxy", status: "reachable", futureAccessField: true },
        receiver: { status: "running", pendingCount: 0, legacyReceiverField: true },
        apps: {
          runningCount: 1,
          sessions: [{ id: "app_legacy", appId: "codex", status: "running" }],
          legacyAppsField: true,
        },
        runtime: { labels: {}, legacyRuntimeField: true },
        runtimeVersion: {
          desiredVersion: "1.0.0",
          actualVersion: "0.9.0",
          phase: "updating",
          attempt: 2,
          lastAttemptAt: "not-a-timestamp",
          matchedAt: "also-invalid",
          error: {
            code: "FUTURE_RUNTIME_ERROR",
            message: "legacy install failed",
            retryable: true,
            futureErrorField: true,
          },
          futureRuntimeField: true,
        },
        legacyTopLevelField: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      null,
      2,
    )}\n`,
  );

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  const sanitizedStored = sanitizeStoredControlledInstance(JSON.parse(fs.readFileSync(instanceFile, "utf8")), () => {});
  assert.equal(sanitizedStored.runtimeVersion.error.code, "INSTANCE_RUNTIME_INSTALL_FAILED");
  assert.equal(sanitizedStored.runtimeVersion.error.retryable, true);
  assert.equal("lastAttemptAt" in sanitizedStored.runtimeVersion, false);
  assert.equal("matchedAt" in sanitizedStored.runtimeVersion, false);
  assert.equal(sanitizedStored.source.path, "/workspace");
  assert.equal("futureSourceField" in sanitizedStored.source, false);
  assert.equal(sanitizedStored.build.packageVersion, "0.9.0");
  assert.equal("futureBuildField" in sanitizedStored.build, false);
  assert.equal("gitCommit" in sanitizedStored.build, false);
  assert.equal(sanitizedStored.aiSessions.sessions.length, 1);
  assert.deepEqual(sanitizedStored.aiSessions.sessions[0].actions, { send: true });
  assert.equal("futureSessionField" in sanitizedStored.aiSessions.sessions[0], false);
  assert.equal("title" in sanitizedStored.aiSessions.sessions[0], false);
  assert.equal(sanitizedStored.triggers.configs.length, 1);
  assert.deepEqual(sanitizedStored.triggers.configs[0].config.action, { promptTemplate: "Run" });
  assert.equal("futurePolicyField" in sanitizedStored.triggers.configs[0].config.policy, false);
  assert.equal("description" in sanitizedStored.triggers.configs[0].config, false);
  assert.equal(sanitizedStored.triggers.configs[0].deployments.length, 1);
  assert.equal("futureTargetField" in sanitizedStored.triggers.configs[0].deployments[0].target, false);
  assert.equal(sanitizedStored.triggers.configs[0].runtime.length, 1);
  assert.equal("futureRuntimeStateField" in sanitizedStored.triggers.configs[0].runtime[0], false);
  assert.equal(sanitizedStored.triggers.recentRuns.length, 1);
  assert.equal("futureTargetField" in sanitizedStored.triggers.recentRuns[0].target, false);
  assert.equal("futureTargetField" in sanitizedStored.target, false);
  assert.equal("logs" in sanitizedStored.target, false);
  assert.equal("futureAccessField" in sanitizedStored.access, false);
  let app;
  let listed;
  try {
    app = await createNodeAgentApp({
      dataDir,
      logger: false,
      nodeId: "node_current",
      token: "agent-secret",
    });
    listed = await app.inject({
      method: "GET",
      url: "/api/node-agent/instances",
      headers: { authorization: "Bearer agent-secret" },
    });
  } finally {
    console.warn = originalWarn;
  }
  t.after(() => app?.close());
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().data.length, 1);
  assert.equal(listed.json().data[0].id, "inst_extra");
  assert.equal("receiver" in listed.json().data[0], false);
  assert.deepEqual(listed.json().data[0].apps, { runningCount: 1, problemCount: 0 });
  assert.equal("legacyTopLevelField" in listed.json().data[0], false);
  assert.equal("sessions" in listed.json().data[0].apps, false);
  assert.equal(listed.json().data[0].runtimeVersion.phase, "pending");
  assert.equal(listed.json().data[0].runtimeVersion.attempt, 2);
  assert.equal(listed.json().data[0].runtimeVersion.error.code, "INSTANCE_RUNTIME_VERSION_MISMATCH");
  assert.ok(warnings.some((warning) => warning.includes("legacy controlled instance field was ignored") && warning.includes("inst_extra") && warning.includes("receiver")));
});

test("node agent proxies mutating instance API requests while runtime convergence is pending", async (t) => {
  const calls = [];
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-proxy"),
    logger: false,
    token: "agent-secret",
    fetchImpl: async (url, init = {}) => {
      calls.push({
        url,
        method: init.method || "GET",
        headers: init.headers || {},
        body: init.body,
      });
      return new Response(JSON.stringify({ data: { accepted: true } }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
  });
  t.after(() => app.close());

  const timestamp = new Date().toISOString();
  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_1",
      name: "proxy-worker",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_1" },
      image: testInstanceImage("task-handoff-web:local", "img_1", "Image"),
      source: {
        type: "local-folder",
        path: "/workspace",
      },
      sourceSnapshot: {},
    },
  });
  await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_1/register",
    headers: {
      authorization: `Bearer ${created.json().data.registrationToken}`,
    },
    payload: {
      instanceId: "inst_1",
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      appInventory: emptyAppInventory(),
      controlMode: "controlled",
      capabilities: {},
      build: { component: "controlled-instance", packageVersion: "1.0.0" },
      target: {
        strategy: "direct-port",
        web: "http://127.0.0.1:18080",
        api: "http://127.0.0.1:18080/api",
        status: "unknown",
      },
      workspace: {
        status: "ready",
      },
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_1/proxy",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      path: "/api/status",
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
    },
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { data: { accepted: true } });
  assert.deepEqual(calls, [
    {
      url: "http://127.0.0.1:18080/api/status",
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: undefined,
    },
  ]);
});

test("node agent proxies direct-port instances through the node-local host", async (t) => {
  const calls = [];
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-proxy-local-host"),
    logger: false,
    token: "agent-secret",
    fetchImpl: async (url, init = {}) => {
      calls.push({
        url,
        method: init.method || "GET",
        bodyBytes: init.body ? [...Buffer.from(await new Response(init.body).arrayBuffer())] : [],
      });
      return new Response("<html>ok</html>", {
        status: 200,
        headers: { "content-type": "text/html", ...(String(url).endsWith("/large") ? { "content-length": String(65 * 1024 * 1024) } : {}) },
      });
    },
  });
  t.after(() => app.close());

  const timestamp = new Date().toISOString();
  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_proxy",
      name: "proxy-worker",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_1" },
      image: testInstanceImage("task-handoff-web:local", "img_1", "Image"),
      source: {
        type: "local-folder",
        path: "/workspace",
      },
      sourceSnapshot: {},
    },
  });
  await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_proxy/register",
    headers: {
      authorization: `Bearer ${created.json().data.registrationToken}`,
    },
    payload: {
      instanceId: "inst_proxy",
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      appInventory: emptyAppInventory(),
      controlMode: "controlled",
      capabilities: {},
      build: { component: "controlled-instance", packageVersion: "1.0.0" },
      target: {
        strategy: "direct-port",
        web: "http://127.0.0.1:18080",
        api: "http://127.0.0.1:18080/api",
        status: "unknown",
      },
      workspace: {
        status: "ready",
      },
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_proxy/proxy/stream",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      path: "/",
      method: "GET",
      headers: {},
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "<html>ok</html>");
  assert.deepEqual(calls, [
    {
      url: "http://127.0.0.1:18080/",
      method: "GET",
      bodyBytes: [],
    },
  ]);

  const posted = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_proxy/proxy/raw",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      path: "/upload",
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      bodyBase64: Buffer.from([0, 1, 2, 255]).toString("base64"),
    },
  });

  assert.equal(posted.statusCode, 200);
  assert.deepEqual(calls.at(-1), {
    url: "http://127.0.0.1:18080/upload",
    method: "POST",
    bodyBytes: [0, 1, 2, 255],
  });

  const limited = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_proxy/proxy/stream",
    headers: { authorization: "Bearer agent-secret" },
    payload: { path: "/large", method: "GET", headers: {} },
  });
  assert.equal(limited.statusCode, 502);
  assert.equal(limited.json().error.code, "INSTANCE_PROXY_RESPONSE_TOO_LARGE");
  const health = await app.inject({ method: "GET", url: "/api/node-agent/health", headers: { authorization: "Bearer agent-secret" } });
  assert.equal(health.json().data.instanceProxy.limitRejected, 1);
  assert.ok(health.json().data.instanceProxy.responseBytes >= Buffer.byteLength("<html>ok</html>"));
});

test("node agent proxies instance websocket subprotocols", async (t) => {
  const upstream = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
  const upstreamSockets = new Set();
  const seen = [];
  t.after(() => {
    for (const socket of upstreamSockets) socket.terminate();
    return new Promise((resolve) => upstream.close(resolve));
  });
  await withTimeout(new Promise((resolve) => upstream.once("listening", resolve)), "controlled websocket listening");
  const upstreamAddress = upstream.address();
  assert.equal(typeof upstreamAddress, "object");
  upstream.on("connection", (socket, request) => {
    upstreamSockets.add(socket);
    socket.on("close", () => upstreamSockets.delete(socket));
    seen.push({
      url: request.url,
      protocol: request.headers["sec-websocket-protocol"] || "",
    });
    socket.send(Buffer.from("RFB 003.008\n"));
  });

  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-ws-protocol"),
    logger: false,
    token: "agent-secret",
  });
  t.after(() => app.close());

  const timestamp = new Date().toISOString();
  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_ws",
      name: "ws-worker",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_1" },
      image: testInstanceImage("task-handoff-web:local", "img_1", "Image"),
      source: {
        type: "local-folder",
        path: "/workspace",
      },
      sourceSnapshot: {},
    },
  });
  await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_ws/register",
    headers: {
      authorization: `Bearer ${created.json().data.registrationToken}`,
    },
    payload: {
      instanceId: "inst_ws",
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      appInventory: emptyAppInventory(),
      controlMode: "controlled",
      capabilities: {},
      build: { component: "controlled-instance", packageVersion: "1.0.0" },
      target: {
        strategy: "direct-port",
        web: `http://127.0.0.1:${upstreamAddress.port}`,
        api: `http://127.0.0.1:${upstreamAddress.port}/api`,
        status: "reachable",
      },
      workspace: {
        status: "ready",
      },
    },
  });

  await withTimeout(app.listen({ host: "127.0.0.1", port: 0 }), "node agent listen");
  const address = app.server.address();
  assert.equal(typeof address, "object");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/node-agent/instances/inst_ws/proxy/ws/api/apps/sessions/app_1/web/websockify`, ["binary"], {
    headers: { authorization: "Bearer agent-secret" },
  });
  t.after(() => client.terminate());
  await withTimeout(waitForWebSocketOpen(client), "node-agent proxied websocket open");
  assert.equal(client.protocol, "binary");
  assert.deepEqual(await withTimeout(onceWebSocketMessageFrame(client), "node-agent proxied websocket greeting"), { message: "RFB 003.008\n", isBinary: true });
  assert.deepEqual(seen.filter((entry) => entry.url !== "/api/node-agent/events"), [
    {
      url: "/api/apps/sessions/app_1/web/websockify",
      protocol: "binary",
    },
  ]);
});

test("control plane checks node agent runtime targets and lists their images", async (t) => {
  const timestamp = new Date().toISOString();
  const mock = createMockNodeAgentFetch({
    nodeId: "node_agent",
    health: {
      build: {
        component: "node-agent",
        packageName: "@task-handoff/node-agent",
        packageVersion: "1.0.0",
        protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        buildId: "agent-build",
      },
      publicHost: "agent.example",
      endpoint: "http://agent.example:8091",
      controlEndpoint: "http://agent.example:8091",
      containerEndpoint: "http://host.docker.internal:8091",
    },
    runtimes: [
      {
        id: "runtime_agent",
        nodeId: "node_agent",
        type: "docker",
        name: "Docker",
        status: "unknown",
        accessStrategy: "direct-port",
        capabilities: {},
        labels: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    dockerImages: [
      {
        repository: "task-handoff-web",
        tag: "remote",
        id: "sha256:abc123",
        reference: "task-handoff-web:remote",
      },
    ],
    folderTree: [
      {
        name: "workspace",
        path: "/workspace",
        children: [
          { name: "project", path: "/workspace/project", children: [] },
        ],
      },
    ],
  });
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-runtime-check"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());
  mock.requests.length = 0;

  const node = await json(app, "POST", "/api/nodes", {
    id: "node_agent",
    name: "Node Agent",
    connectionMode: "direct-http",
    endpoint: "http://agent.example:8091",
    auth: {
      mode: "paired-hmac",
      keyId: "key_agent",
      secret: "agent-secret",
    },
  });
  assert.equal(node.statusCode, 201);
  assert.equal(node.body.data.status, "online");
  assert.equal(node.body.data.health, "ok");
  assert.equal(node.body.data.capabilities.agent.build.buildId, "agent-build");

  const checked = await json(app, "POST", "/api/nodes/node_agent/check");
  assert.equal(checked.statusCode, 200);
  assert.equal(checked.body.data.status, "online");
  assert.equal(checked.body.data.agent.role, "node-agent");

  const publicNode = await json(app, "GET", "/api/nodes/node_agent");
  assert.equal(publicNode.statusCode, 200);
  assert.equal(publicNode.body.data.auth.secret, undefined);
  assert.deepEqual(publicNode.body.data.capabilities.agent, {
    ok: true,
    role: "node-agent",
    nodeId: "node_agent",
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    build: {
      component: "node-agent",
      packageName: "@task-handoff/node-agent",
      packageVersion: "1.0.0",
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      buildId: "agent-build",
    },
  });

  const runtimes = await json(app, "GET", "/api/nodes/node_agent/runtimes");
  assert.equal(runtimes.statusCode, 200);
  assert.equal(runtimes.body.data[0].id, "runtime_agent");
  assert.equal(runtimes.body.data[0].nodeId, "node_agent");

  const images = await json(app, "GET", "/api/nodes/node_agent/docker/images");
  assert.equal(images.statusCode, 200);
  assert.equal(images.body.data[0].reference, "task-handoff-web:remote");
  const folders = await json(app, "GET", "/api/nodes/node_agent/folders/tree?path=%2Fworkspace&depth=1");
  assert.equal(folders.statusCode, 200);
  assert.equal(folders.body.data[0].children[0].path, "/workspace/project");
  assert.deepEqual(mock.requests.map((request) => [request.method, request.url, Boolean(request.headers["x-taskhandoff-signature"]), request.headers.authorization]), [
    ["GET", "http://agent.example:8091/api/node-agent/health", true, undefined],
    ["GET", "http://agent.example:8091/api/node-agent/health", true, undefined],
    ["GET", "http://agent.example:8091/api/node-agent/runtimes", true, undefined],
    ["GET", "http://agent.example:8091/api/node-agent/docker/images", true, undefined],
    ["GET", "http://agent.example:8091/api/node-agent/folders/tree?path=%2Fworkspace&depth=1", true, undefined],
  ]);
});

test("control plane consumes the built-in local runtime and creates local instances without images", async (t) => {
  const timestamp = new Date().toISOString();
  const mock = createMockNodeAgentFetch({
    nodeId: "node_agent",
    runtimes: [{
      id: "runtime_local_host",
      nodeId: "node_agent",
      name: "Local Runtime",
      type: "local",
      status: "unknown",
      accessStrategy: "node-proxy",
      capabilities: {
        requiresImage: false,
        supportsControlledInstanceApi: true,
        supportsContainerLifecycle: false,
        supportsAppSessions: true,
        supportsHostSessions: true,
        artifactKind: "none",
        isolation: "none",
      },
      labels: { "task-handoff.node-agent.builtin": "true" },
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  });
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-localhost-runtime"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());

  const node = await json(app, "POST", "/api/nodes", {
    id: "node_agent",
    name: "Node Agent",
    connectionMode: "direct-http",
    endpoint: "http://agent.example:8091",
    auth: {
      mode: "paired-hmac",
      keyId: "key_agent",
      secret: "agent-secret",
    },
  });
  assert.equal(node.statusCode, 201);

  const runtimes = await json(app, "GET", "/api/nodes/node_agent/runtimes");
  assert.equal(runtimes.statusCode, 200);
  assert.equal(runtimes.body.data[0].type, "local");
  assert.equal(runtimes.body.data[0].capabilities.requiresImage, false);

  const checked = await json(app, "POST", "/api/nodes/node_agent/runtimes/runtime_local_host/check");
  assert.equal(checked.statusCode, 200);
  assert.equal(checked.body.data.status, "online");

  const instance = await json(app, "POST", "/api/controlled-instances", {
    name: "Local Workspace",
    nodeId: "node_agent",
    runtimeId: "runtime_local_host",
    start: true,
    source: {
      type: "local-folder",
      path: "/tmp/local-workspace",
      ownerNodeId: "node_agent",
    },
    sourceSnapshot: {
      name: "local-workspace",
    },
  });
  assert.equal(instance.statusCode, 201);
  assert.equal(instance.body.data.imageId, undefined);
  assert.equal(instance.body.data.status, "registering");
  assert.deepEqual(instance.body.data.startOutcome, { status: "started" });

  const createRequest = mock.requests.find((request) => request.path === "/instances" && request.method === "POST");
  assert.ok(createRequest);
  assert.equal(createRequest.body.imageId, undefined);
  assert.equal(createRequest.body.image, undefined);
  assert.equal(createRequest.body.runtimeId, "runtime_local_host");
  assert.equal(createRequest.body.source.path, "/tmp/local-workspace");
  const assignmentRequestIndex = mock.requests.findIndex((request) => request.path === `/instances/${instance.body.data.id}/model-assignment`);
  const startRequestIndex = mock.requests.findIndex((request) => request.path === `/instances/${instance.body.data.id}/start`);
  assert.ok(assignmentRequestIndex >= 0);
  assert.ok(startRequestIndex > assignmentRequestIndex);
});

test("creating with start returns the persisted instance when start fails", async (t) => {
  const timestamp = new Date().toISOString();
  const mock = createMockNodeAgentFetch({
    nodeId: "node_start_failure",
    startError: { status: 503, code: "LOCAL_INSTANCE_PROCESS_SPAWN_FAILED", message: "Local process could not be started." },
    runtimes: [{
      id: "runtime_local_host",
      nodeId: "node_start_failure",
      name: "Local Runtime",
      type: "local",
      status: "online",
      accessStrategy: "node-proxy",
      capabilities: { requiresImage: false, supportsControlledInstanceApi: true, supportsHostSessions: true, artifactKind: "none", isolation: "none" },
      labels: { "task-handoff.node-agent.builtin": "true" },
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  });
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-create-start-failure"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: { fetchImpl: mock.fetchImpl },
  });
  t.after(() => app.close());

  await json(app, "POST", "/api/nodes", {
    id: "node_start_failure",
    name: "Start Failure Node",
    connectionMode: "direct-http",
    endpoint: "http://agent.example:8091",
    auth: { mode: "paired-hmac", keyId: "key_start_failure", secret: "agent-secret" },
  });
  const created = await json(app, "POST", "/api/controlled-instances", {
    name: "Created Before Start Failure",
    nodeId: "node_start_failure",
    runtimeId: "runtime_local_host",
    start: true,
    source: { type: "local-folder", path: "/tmp/start-failure-workspace", ownerNodeId: "node_start_failure" },
    sourceSnapshot: { name: "start-failure-workspace" },
  });

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.data.status, "failed");
  assert.equal(created.body.data.workspace.error, "Local process could not be started.");
  assert.deepEqual(created.body.data.startOutcome, {
    status: "failed",
    error: { code: "LOCAL_INSTANCE_PROCESS_SPAWN_FAILED", message: "Local process could not be started." },
  });
  const instances = await json(app, "GET", "/api/controlled-instances");
  assert.equal(instances.body.data.find((instance) => instance.id === created.body.data.id)?.status, "failed");
});

test("control plane accepts node agents with incompatible protocol versions and reports a warning", async (t) => {
  const mock = createMockNodeAgentFetch({
    nodeId: "node_old",
    health: {
      protocolVersion: "2026-01-01",
    },
  });
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-node-protocol-mismatch"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());

  const node = await json(app, "POST", "/api/nodes", {
    id: "node_old",
    name: "Old Node",
    connectionMode: "direct-http",
    endpoint: "http://old-node.example:8091",
    auth: {
      mode: "paired-hmac",
      keyId: "key_agent",
      secret: "agent-secret",
    },
  });
  assert.equal(node.statusCode, 201);
});

test("control plane registers node connections with the agent node id", async (t) => {
  const timestamp = new Date().toISOString();
  const mock = createMockNodeAgentFetch({
    nodeId: "node_remote",
    runtimes: [
      {
        id: "runtime_local_docker",
        nodeId: "node_remote",
        type: "docker",
        name: "Local Docker",
        status: "unknown",
        accessStrategy: "direct-port",
        capabilities: {},
        labels: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    localFolders: [
      {
        id: "folder_1",
        nodeId: "node_remote",
        name: "Workspace",
        path: "/home/agent/work",
        labels: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  });
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-node-resource-scope"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());

  const node = await json(app, "POST", "/api/nodes", {
    id: "node_remote",
    name: "Remote Node",
    connectionMode: "direct-http",
    endpoint: "http://agent.example:8091",
    auth: {
      mode: "paired-hmac",
      keyId: "key_agent",
      secret: "agent-secret",
    },
  });
  assert.equal(node.statusCode, 201);
  assert.equal(node.body.data.id, "node_remote");

  const runtimes = await json(app, "GET", "/api/nodes/node_remote/runtimes");
  assert.equal(runtimes.statusCode, 200);
  assert.equal(runtimes.body.data.length, 1);
  assert.equal(runtimes.body.data[0].id, "runtime_local_docker");
  assert.equal(runtimes.body.data[0].nodeId, "node_remote");

  const allRuntimes = await json(app, "GET", "/api/node-runtimes");
  const remoteRuntime = allRuntimes.body.data.find((runtime) => runtime.id === "runtime_local_docker" && runtime.nodeId === "node_remote");
  assert.ok(remoteRuntime);

  const folders = await json(app, "GET", "/api/nodes/node_remote/local-folders");
  assert.equal(folders.statusCode, 200);
  assert.equal(folders.body.data[0].id, "folder_1");
  assert.equal(folders.body.data[0].nodeId, "node_remote");
});

test("node agent reverse tunnel survives rejected handshakes and retries", async (t) => {
  let attempts = 0;
  let resolveFirstAttempt;
  let resolveSecondAttempt;
  const firstAttempt = new Promise((resolve) => {
    resolveFirstAttempt = resolve;
  });
  const secondAttempt = new Promise((resolve) => {
    resolveSecondAttempt = resolve;
  });
  const rejectingServer = http.createServer((_request, response) => {
    attempts += 1;
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "PROTOCOL_VERSION_MISMATCH" } }));
    if (attempts === 1) resolveFirstAttempt();
    if (attempts === 2) resolveSecondAttempt();
  });
  await new Promise((resolve, reject) => {
    rejectingServer.once("error", reject);
    rejectingServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => rejectingServer.close(resolve)));

  const dataDir = tempDataDir("node-agent-rejected-reverse-tunnel");
  const paths = nodeAgentStorePaths(dataDir);
  const identity = new NodeAgentIdentityService(paths);
  identity.resolveNodeId("node_rejected");
  identity.commitControlPlaneConnection(identity.stageControlPlaneConnection({ url: `http://127.0.0.1:${rejectingServer.address().port}` }));
  const app = await createNodeAgentApp({ dataDir, logger: false, port: 8091 });
  const manager = createReverseTunnelManager(app, { host: "127.0.0.1", port: 8091, dataDir }, paths, "node_rejected");
  t.after(async () => {
    manager.closeAll();
    await app.close();
  });

  manager.connectConfigured();
  await withTimeout(firstAttempt, "rejected reverse tunnel first attempt");
  await withTimeout(secondAttempt, "rejected reverse tunnel retry");

  assert.equal(attempts, 2);
  manager.closeAll();
});

test("persisted control-plane access suppresses the bootstrap reverse tunnel", async (t) => {
  let attempts = 0;
  let resolveAttempt;
  const attempted = new Promise((resolve) => {
    resolveAttempt = resolve;
  });
  const rejectingServer = http.createServer((_request, response) => {
    attempts += 1;
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "UNAUTHORIZED" } }));
    resolveAttempt();
  });
  await new Promise((resolve, reject) => {
    rejectingServer.once("error", reject);
    rejectingServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => rejectingServer.close(resolve)));

  const address = rejectingServer.address();
  assert.equal(typeof address, "object");
  const controlPlaneUrl = `http://127.0.0.1:${address.port}`;
  const dataDir = tempDataDir("node-agent-persisted-suppresses-bootstrap");
  const paths = nodeAgentStorePaths(dataDir);
  const identity = new NodeAgentIdentityService(paths);
  identity.resolveNodeId("node_single_reverse_tunnel");
  const pending = identity.commitControlPlaneConnection(identity.stageControlPlaneConnection({ url: controlPlaneUrl }));
  const previousControlPlaneUrl = process.env.TASK_HANDOFF_CONTROL_PLANE_URL;
  process.env.TASK_HANDOFF_CONTROL_PLANE_URL = controlPlaneUrl;
  t.after(() => {
    if (previousControlPlaneUrl === undefined) delete process.env.TASK_HANDOFF_CONTROL_PLANE_URL;
    else process.env.TASK_HANDOFF_CONTROL_PLANE_URL = previousControlPlaneUrl;
  });

  const app = await createNodeAgentApp({ dataDir, logger: false, port: 8091 });
  const manager = createReverseTunnelManager(app, { host: "127.0.0.1", port: 8091, dataDir }, paths, "node_single_reverse_tunnel");
  t.after(async () => {
    manager.closeAll();
    await app.close();
  });
  manager.connectConfigured();
  await withTimeout(attempted, "persisted reverse tunnel attempt");
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(attempts, 1);
  assert.equal(identity.deleteControlPlaneConnection(pending.connection.id), true);
  manager.connectConfigured();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(attempts, 1);
  manager.closeAll();
});

test("an explicit reverse tunnel remains active alongside persisted control-plane access", async (t) => {
  const attemptedPaths = new Set();
  let resolveAttempts;
  const attemptsComplete = new Promise((resolve) => {
    resolveAttempts = resolve;
  });
  const rejectingServer = http.createServer((request, response) => {
    attemptedPaths.add(request.url.split("?")[0]);
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "UNAUTHORIZED" } }));
    if (attemptedPaths.size === 2) resolveAttempts();
  });
  await new Promise((resolve, reject) => {
    rejectingServer.once("error", reject);
    rejectingServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => rejectingServer.close(resolve)));

  const address = rejectingServer.address();
  assert.equal(typeof address, "object");
  const dataDir = tempDataDir("node-agent-explicit-and-persisted-tunnels");
  const paths = nodeAgentStorePaths(dataDir);
  const identity = new NodeAgentIdentityService(paths);
  identity.resolveNodeId("node_explicit_and_persisted_tunnels");
  identity.commitControlPlaneConnection(identity.stageControlPlaneConnection({ url: `http://127.0.0.1:${address.port}` }));
  const app = await createNodeAgentApp({ dataDir, logger: false, port: 8091 });
  const manager = createReverseTunnelManager(app, {
    host: "127.0.0.1",
    port: 8091,
    dataDir,
    controlPlaneTunnelUrl: `ws://127.0.0.1:${address.port}/explicit-tunnel`,
    remoteKeyId: "explicit-key",
    remoteSecret: "explicit-secret",
  }, paths, "node_explicit_and_persisted_tunnels");
  t.after(async () => {
    manager.closeAll();
    await app.close();
  });

  manager.connectConfigured();
  await withTimeout(attemptsComplete, "explicit and persisted reverse tunnel attempts");
  assert.deepEqual([...attemptedPaths].sort(), ["/api/node-tunnel", "/explicit-tunnel"]);
  manager.closeAll();
});

test("deleting a node agent control-plane connection cancels its pending reverse tunnel retry", async (t) => {
  let attempts = 0;
  let resolveAttempt;
  const attempted = new Promise((resolve) => {
    resolveAttempt = resolve;
  });
  const rejectingServer = http.createServer((_request, response) => {
    attempts += 1;
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "PROTOCOL_VERSION_MISMATCH" } }));
    resolveAttempt();
  });
  await new Promise((resolve, reject) => {
    rejectingServer.once("error", reject);
    rejectingServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => rejectingServer.close(resolve)));

  const address = rejectingServer.address();
  assert.equal(typeof address, "object");
  const dataDir = tempDataDir("node-agent-deleted-reverse-tunnel");
  const paths = nodeAgentStorePaths(dataDir);
  const identity = new NodeAgentIdentityService(paths);
  identity.resolveNodeId("node_deleted");
  const pending = identity.commitControlPlaneConnection(identity.stageControlPlaneConnection({ url: `http://127.0.0.1:${address.port}` }));

  const ipcPath = nodeAgentIpcPath(dataDir);
  const app = await createNodeAgentApp({ dataDir, logger: false, port: 8091, connectionMode: "local-ipc", ipcPath });
  const manager = createReverseTunnelManager(app, { host: "127.0.0.1", port: 8091, dataDir, connectionMode: "local-ipc", ipcPath }, paths, "node_deleted");
  app.decorate("nodeAgentReverseTunnels", manager);
  await app.ready();
  const ipcServer = await listenNodeAgentIpcServer(app, ipcPath);
  t.after(async () => {
    manager.closeAll();
    await new Promise((resolve) => ipcServer.close(resolve));
    await app.close();
  });

  manager.connectConfigured();
  await withTimeout(attempted, "deleted reverse tunnel initial attempt");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(attempts, 1);

  const connections = await fetchNodeAgentIpc(ipcPath, "/control-plane-connections");
  assert.equal(connections.status, 200);
  const connectionState = (await connections.json()).data[0];
  assert.equal(connectionState.id, pending.connection.id);
  assert.equal(connectionState.status, "reconnecting");
  assert.ok(connectionState.lastDisconnectedAt);

  const pairingInUse = await fetchNodeAgentIpc(ipcPath, `/control-plane-pairings/${encodeURIComponent(pending.pairing.keyId)}`, {
    method: "DELETE",
  });
  assert.equal(pairingInUse.status, 409);
  assert.equal((await pairingInUse.json()).error.code, "NODE_AGENT_PAIRING_IN_USE");

  const deleted = await fetchNodeAgentIpc(ipcPath, `/control-plane-connections/${encodeURIComponent(pending.connection.id)}`, {
    method: "DELETE",
  });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).data.deleted, true);
  const storedAfterDelete = new NodeAgentIdentityStore(paths, { logger: () => undefined }).read();
  assert.equal(storedAfterDelete.controlPlaneConnections.length, 0);
  assert.equal(storedAfterDelete.controlPlanePairings.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 1_400));
  assert.equal(attempts, 1);
});

test("control plane accepts node agent reverse tunnel handshake", async (t) => {
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-node-agent-tunnel"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());

  const node = await json(app, "POST", "/api/nodes", {
    id: "node_tunnel",
    name: "Tunnel Node",
    connectionMode: "reverse-wss",
    auth: {
      mode: "paired-hmac",
      keyId: "key_agent",
      secret: "agent-secret",
    },
  });
  assert.equal(node.statusCode, 201);

  const address = app.server.address();
  assert.equal(typeof address, "object");
  const tunnelPath = "/api/node-tunnel?nodeId=node_tunnel";
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}${tunnelPath}`, {
    headers: createNodeAgentHmacHeaders({
      nodeId: "node_tunnel",
      keyId: "key_agent",
      secret: "agent-secret",
      method: "GET",
      pathWithQuery: tunnelPath,
    }),
  });
  t.after(() => socket.close());

  const hello = await onceWebSocketMessage(socket);
  assert.equal(hello.type, "control-plane.hello");
  assert.equal(hello.nodeId, "node_tunnel");
  assert.equal(hello.capabilities.reverseTunnel, "request-response");
  assert.equal(hello.capabilities.lifecycleCommands, true);
  assert.equal(hello.capabilities.instanceApiProxy, true);

  socket.send(JSON.stringify({ type: "node-agent.ping" }));
  const pong = await onceWebSocketMessage(socket);
  assert.equal(pong.type, "control-plane.pong");
  assert.equal(pong.nodeId, "node_tunnel");

  const runtimesPromise = json(app, "GET", "/api/nodes/node_tunnel/runtimes");
  const request = await onceWebSocketMessage(socket);
  assert.equal(request.type, "control-plane.request");
  assert.equal(request.route, "/runtimes");
  socket.send(
    JSON.stringify({
      type: "node-agent.response",
      requestId: request.requestId,
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: [
          {
            id: "runtime_reverse",
            nodeId: "node_tunnel",
            name: "Reverse Docker",
            type: "docker",
            status: "online",
            accessStrategy: "node-proxy",
            capabilities: {},
            labels: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
    }),
  );
  const runtimes = await runtimesPromise;
  assert.equal(runtimes.statusCode, 200);
  assert.equal(runtimes.body.data[0].id, "runtime_reverse");
});

test("aborting a reverse tunnel request releases it and notifies the node agent", async () => {
  const transport = new ControlPlaneNodeAgentTunnelTransport();
  const sent = [];
  transport.attach("node_request_abort", {
    readyState: 1,
    send(data) { sent.push(JSON.parse(String(data))); },
  });
  const controller = new AbortController();
  const responsePromise = transport.request({ id: "node_request_abort" }, "/slow", { signal: controller.signal });
  const requestId = sent[0].requestId;

  controller.abort();

  await assert.rejects(responsePromise, (error) => error.name === "AbortError" && error.code === "ABORT_ERR");
  assert.deepEqual(sent.at(-1), { type: "control-plane.request.cancel", requestId });
  assert.equal(transport.handleMessage("node_request_abort", {
    type: "node-agent.response",
    requestId,
    status: 200,
    body: "late",
  }), true);
});

test("timing out a reverse tunnel request cancels the node-agent operation", async () => {
  const transport = new ControlPlaneNodeAgentTunnelTransport(undefined, { requestTimeoutMs: 10 });
  const sent = [];
  transport.attach("node_request_timeout", {
    readyState: 1,
    send(data) { sent.push(JSON.parse(String(data))); },
  });
  const responsePromise = transport.request({ id: "node_request_timeout" }, "/slow-mutation", { method: "POST" });
  const requestId = sent[0].requestId;

  await assert.rejects(responsePromise, (error) => error.code === "NODE_AGENT_REVERSE_REQUEST_TIMEOUT" && error.statusCode === 504);

  assert.deepEqual(sent.at(-1), { type: "control-plane.request.cancel", requestId });
  assert.equal(transport.handleMessage("node_request_timeout", {
    type: "node-agent.response",
    requestId,
    status: 200,
    body: "late success",
  }), true);
});

test("node reverse tunnel aborts app.inject when a regular request is canceled", async (t) => {
  const tunnelServer = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
  const tunnelSockets = new Set();
  t.after(() => {
    for (const socket of tunnelSockets) socket.terminate();
    return new Promise((resolve) => tunnelServer.close(resolve));
  });
  await withTimeout(new Promise((resolve) => tunnelServer.once("listening", resolve)), "request cancel tunnel server");
  const address = tunnelServer.address();
  assert.equal(typeof address, "object");
  let markConnected;
  let markInjectStarted;
  let markInjectAborted;
  const connected = new Promise((resolve) => { markConnected = resolve; });
  const injectStarted = new Promise((resolve) => { markInjectStarted = resolve; });
  const injectAborted = new Promise((resolve) => { markInjectAborted = resolve; });
  tunnelServer.on("connection", (serverSocket) => {
    tunnelSockets.add(serverSocket);
    serverSocket.on("close", () => tunnelSockets.delete(serverSocket));
    markConnected(serverSocket);
  });
  const tunnel = connectReverseTunnel({
    log: { warn() {} },
    inject(input) {
      markInjectStarted(input.signal);
      return new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => {
        markInjectAborted(input.signal.aborted);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true }));
    },
  }, {
    tunnelUrl: `ws://127.0.0.1:${address.port}/api/node-tunnel`,
    nodeId: "node_regular_cancel",
    port: 1,
  });
  t.after(() => tunnel.terminate());
  const main = await withTimeout(connected, "regular request tunnel connection");
  main.send(JSON.stringify({ type: "control-plane.request", requestId: "request_cancel", route: "/mutation", init: { method: "POST" } }));
  const signal = await withTimeout(injectStarted, "regular request inject start");
  assert.equal(signal.aborted, false);

  main.send(JSON.stringify({ type: "control-plane.request.cancel", requestId: "request_cancel" }));

  assert.equal(await withTimeout(injectAborted, "regular request inject abort"), true);
});

test("node reverse tunnel rejects legacy request bodies without terminating the connection", async (t) => {
  const tunnelServer = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
  const tunnelSockets = new Set();
  t.after(() => {
    for (const socket of tunnelSockets) socket.terminate();
    return new Promise((resolve) => tunnelServer.close(resolve));
  });
  await withTimeout(new Promise((resolve) => tunnelServer.once("listening", resolve)), "legacy request tunnel server");
  const address = tunnelServer.address();
  assert.equal(typeof address, "object");

  let markConnected;
  const connected = new Promise((resolve) => { markConnected = resolve; });
  tunnelServer.on("connection", (serverSocket) => {
    tunnelSockets.add(serverSocket);
    serverSocket.on("close", () => tunnelSockets.delete(serverSocket));
    markConnected({ serverSocket, identified: onceWebSocketMessage(serverSocket) });
  });
  const warnings = [];
  let injectCount = 0;
  const tunnel = connectReverseTunnel({
    log: { warn(data, message) { warnings.push({ data, message }); } },
    async inject() {
      injectCount += 1;
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: "{}" };
    },
  }, {
    tunnelUrl: `ws://127.0.0.1:${address.port}/api/node-tunnel`,
    nodeId: "node_legacy_request_body",
    port: 1,
  });
  t.after(() => tunnel.terminate());

  const { serverSocket: main, identified } = await withTimeout(connected, "legacy request tunnel connection");
  assert.equal((await withTimeout(identified, "legacy request tunnel identify")).type, "node-agent.identify");
  const rejectedResponse = onceWebSocketMessage(main);
  main.send(JSON.stringify({
    type: "control-plane.request",
    requestId: "legacy_request",
    route: "/instances/one/proxy",
    init: { method: "POST", body: "{\"legacy\":true}" },
  }));
  assert.deepEqual(await withTimeout(rejectedResponse, "legacy request rejection"), {
    type: "node-agent.response",
    requestId: "legacy_request",
    status: 400,
    error: {
      code: "NODE_TUNNEL_REQUEST_BODY_INVALID",
      message: "Reverse tunnel request body does not match the negotiated protocol.",
    },
  });
  assert.equal(injectCount, 0);
  assert.equal(warnings.at(-1).message, "node agent reverse tunnel request body rejected");

  const healthyResponse = onceWebSocketMessage(main);
  main.send(JSON.stringify({
    type: "control-plane.request",
    requestId: "current_request",
    route: "/health",
    init: { method: "GET" },
  }));
  assert.equal((await withTimeout(healthyResponse, "request after legacy rejection")).status, 200);
  assert.equal(injectCount, 1);
  assert.equal(main.readyState, WebSocket.OPEN);
});

test("aborting an active fleet query cancels its reverse-WSS node request", async (t) => {
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-fleet-query-abort"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());

  await json(app, "POST", "/api/nodes", {
    id: "node_fleet_query_abort",
    name: "Slow Tunnel Node",
    connectionMode: "reverse-wss",
    auth: { mode: "paired-hmac", keyId: "key_abort", secret: "abort-secret" },
  });
  const address = app.server.address();
  assert.equal(typeof address, "object");
  const tunnelPath = "/api/node-tunnel?nodeId=node_fleet_query_abort";
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}${tunnelPath}`, {
    headers: createNodeAgentHmacHeaders({
      nodeId: "node_fleet_query_abort",
      keyId: "key_abort",
      secret: "abort-secret",
      method: "GET",
      pathWithQuery: tunnelPath,
    }),
  });
  t.after(() => socket.close());
  await onceWebSocketMessage(socket);

  const controller = new AbortController();
  const responsePromise = fetch(`http://127.0.0.1:${address.port}/api/node-runtimes`, { signal: controller.signal })
    .catch((error) => error);
  const forwarded = await onceWebSocketMessage(socket);
  assert.equal(forwarded.type, "control-plane.request");
  assert.equal(forwarded.route, "/runtimes");

  controller.abort();

  const cancellation = await onceWebSocketMessage(socket);
  assert.deepEqual(cancellation, { type: "control-plane.request.cancel", requestId: forwarded.requestId });
  assert.equal((await responsePromise).name, "AbortError");
});

test("reverse tunnel authenticates forwarded control-plane requests to a paired node agent", async (t) => {
  const nodeId = "node_tunnel_forwarded_auth";
  const keyId = "key_tunnel_forwarded_auth";
  const secret = "tunnel-forwarded-secret";
  const controlPlane = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-node-agent-forwarded-auth"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
  });
  await controlPlane.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => controlPlane.close());

  const created = await json(controlPlane, "POST", "/api/nodes", {
    id: nodeId,
    name: "Authenticated Forwarded Tunnel Node",
    connectionMode: "reverse-wss",
    auth: { mode: "paired-hmac", keyId, secret },
  });
  assert.equal(created.statusCode, 201);

  const nodeAgent = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-forwarded-auth"),
    logger: false,
    nodeId,
    remoteKeyId: keyId,
    remoteSecret: secret,
  });
  t.after(() => nodeAgent.close());

  const address = controlPlane.server.address();
  assert.equal(typeof address, "object");
  const tunnel = connectReverseTunnel(nodeAgent, {
    tunnelUrl: `ws://127.0.0.1:${address.port}/api/node-tunnel`,
    nodeId,
    port: 0,
    keyId,
    secret,
  });
  t.after(() => tunnel.terminate());
  await withTimeout(waitForWebSocketOpen(tunnel), "authenticated reverse tunnel open", 5_000);

  const checked = await json(controlPlane, "POST", `/api/nodes/${nodeId}/check`);
  assert.equal(checked.statusCode, 200);
  assert.equal(checked.body.data.status, "online");
  assert.equal(checked.body.data.agent.nodeId, nodeId);
});

test("control plane authenticates reverse tunnels with node HMAC when password auth is enabled", async (t) => {
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-authenticated-node-agent-tunnel"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    auth: { mode: "password" },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());

  await json(app, "POST", "/api/auth/bootstrap-admin", {
    username: "admin",
    password: "password123",
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "admin", password: "password123" },
  });
  const cookie = login.headers["set-cookie"];
  assert.ok(cookie);

  const unrelatedNodeAgentRoute = await app.inject({ method: "GET", url: "/api/node-agent/health" });
  assert.equal(unrelatedNodeAgentRoute.statusCode, 401);
  const retiredTunnelRoute = await app.inject({ method: "GET", url: "/api/node-agent/tunnel" });
  assert.equal(retiredTunnelRoute.statusCode, 401);

  const node = await json(app, "POST", "/api/nodes", {
    id: "node_authenticated_tunnel",
    name: "Authenticated Tunnel Node",
    connectionMode: "reverse-wss",
    auth: {
      mode: "paired-hmac",
      keyId: "key_agent",
      secret: "agent-secret",
    },
  }, { cookie });
  assert.equal(node.statusCode, 201);

  const address = app.server.address();
  assert.equal(typeof address, "object");
  const tunnelPath = "/api/node-tunnel?nodeId=node_authenticated_tunnel";
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}${tunnelPath}`, {
    headers: createNodeAgentHmacHeaders({
      nodeId: "node_authenticated_tunnel",
      keyId: "key_agent",
      secret: "agent-secret",
      method: "GET",
      pathWithQuery: tunnelPath,
    }),
  });
  t.after(() => socket.close());

  const hello = await onceWebSocketMessage(socket);
  assert.equal(hello.type, "control-plane.hello");
  assert.equal(hello.nodeId, "node_authenticated_tunnel");
});

test("reverse node tunnel streams HTTP response bodies as binary frames", async () => {
  const transport = new ControlPlaneNodeAgentTunnelTransport();
  const mainEvents = new EventEmitter();
  const sent = [];
  const main = {
    readyState: 1,
    send(data) { sent.push(JSON.parse(String(data))); },
    on(event, listener) { mainEvents.on(event, listener); },
  };
  transport.attach("node_stream", main);
  const responsePromise = transport.requestStream({ id: "node_stream" }, "/instances/inst/proxy/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(sent[0].type, "control-plane.http.open");

  const secondaryEvents = new EventEmitter();
  const secondary = {
    readyState: 1,
    send() {},
    close() { this.readyState = 3; },
    on(event, listener) { secondaryEvents.on(event, listener); },
  };
  assert.equal(transport.attachHttpStream("node_stream", sent[0].streamId, secondary), true);
  secondaryEvents.emit("message", JSON.stringify({ type: "node-agent.http.head", status: 200, headers: { "content-type": "application/octet-stream" } }), false);
  const response = await responsePromise;
  secondaryEvents.emit("message", Buffer.from([0, 1, 2]), true);
  secondaryEvents.emit("message", Buffer.from([3, 255]), true);
  secondaryEvents.emit("message", JSON.stringify({ type: "node-agent.http.end" }), false);
  assert.deepEqual([...Buffer.from(await response.arrayBuffer())], [0, 1, 2, 3, 255]);
});

test("replacing a reverse tunnel closes and isolates the old main socket", async () => {
  const events = new ControlPlaneEventBus();
  const published = [];
  const streamHellos = [];
  events.on((event) => published.push(event));
  const transport = new ControlPlaneNodeAgentTunnelTransport(events, {
    onStreamsHello: (instanceId, hello) => streamHellos.push({ instanceId, hello }),
  });
  const createSocket = () => {
    const socketEvents = new EventEmitter();
    return {
      readyState: 1,
      sent: [],
      closes: [],
      events: socketEvents,
      send(data) { this.sent.push(JSON.parse(String(data))); },
      close(code, reason) { this.readyState = 3; this.closes.push({ code, reason }); },
      on(event, listener) { socketEvents.on(event, listener); },
    };
  };
  const oldSocket = createSocket();
  const newSocket = createSocket();
  transport.attach("node_replaced", oldSocket);
  transport.attach("node_replaced", newSocket);

  assert.deepEqual(oldSocket.closes, [{ code: 1000, reason: "Reverse tunnel was replaced." }]);
  assert.equal(transport.handleSocketMessage("node_replaced", oldSocket, { type: "node-agent.ping" }), undefined);
  assert.equal(transport.handleSocketMessage("node_replaced", oldSocket, {
    type: "node-agent.event.forwarded",
    event: { type: "test.replaced-tunnel", payload: { source: "old" } },
  }), undefined);
  assert.equal(published.length, 0);
  assert.equal(transport.handleSocketMessage("node_replaced", oldSocket, {
    type: "node-agent.streams.hello",
    instanceId: "inst_old",
    payload: { protocolVersion: 1, streams: [] },
  }), undefined);
  assert.equal(streamHellos.length, 0);

  const responsePromise = transport.request({ id: "node_replaced" }, "/health");
  const requestId = newSocket.sent.at(-1).requestId;
  assert.equal(transport.handleSocketMessage("node_replaced", oldSocket, {
    type: "node-agent.response",
    requestId,
    status: 200,
    body: "old",
  }), undefined);
  oldSocket.events.emit("close");
  assert.equal(transport.handleSocketMessage("node_replaced", newSocket, {
    type: "node-agent.response",
    requestId,
    status: 200,
    body: "new",
  }), true);
  assert.equal(await (await responsePromise).text(), "new");

  assert.equal(transport.handleSocketMessage("node_replaced", newSocket, {
    type: "node-agent.event.forwarded",
    event: { type: "test.replaced-tunnel", payload: { source: "new" } },
  }), true);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].payload, { source: "new" });
  assert.equal(transport.handleSocketMessage("node_replaced", newSocket, {
    type: "node-agent.streams.hello",
    instanceId: "inst_new",
    payload: { protocolVersion: 1, streams: [] },
  }), true);
  assert.equal(streamHellos.length, 1);
  assert.equal(streamHellos[0].instanceId, "inst_new");
});

test("reverse HTTP stream header timeout cancels the node request and ignores late frames", async () => {
  const transport = new ControlPlaneNodeAgentTunnelTransport(undefined, { httpStreamHeaderTimeoutMs: 10 });
  const sent = [];
  transport.attach("node_stream_timeout", {
    readyState: 1,
    send(data) { sent.push(JSON.parse(String(data))); },
  });

  const responsePromise = transport.requestStream({ id: "node_stream_timeout" }, "/slow");
  const opened = sent[0];
  const secondaryEvents = new EventEmitter();
  const secondary = {
    readyState: 1,
    closes: [],
    pauses: 0,
    send() {},
    close(code, reason) { this.readyState = 3; this.closes.push({ code, reason }); },
    pause() { this.pauses += 1; },
    on(event, listener) { secondaryEvents.on(event, listener); },
  };
  assert.equal(transport.attachHttpStream("node_stream_timeout", opened.streamId, secondary), true);

  await assert.rejects(responsePromise, (error) => error.code === "NODE_AGENT_REVERSE_STREAM_TIMEOUT" && error.statusCode === 504);
  assert.equal(secondary.closes.length, 1);
  assert.equal(sent.at(-1).type, "control-plane.http.cancel");
  assert.equal(sent.at(-1).streamId, opened.streamId);

  secondaryEvents.emit("message", JSON.stringify({ type: "node-agent.http.head", status: 200, headers: {} }), false);
  secondaryEvents.emit("message", Buffer.alloc(128 * 1024), true);
  assert.equal(secondary.pauses, 0);
});

test("aborting a reverse HTTP stream before headers cancels the node request", async () => {
  const transport = new ControlPlaneNodeAgentTunnelTransport();
  const sent = [];
  transport.attach("node_stream_abort", {
    readyState: 1,
    send(data) { sent.push(JSON.parse(String(data))); },
  });
  const controller = new AbortController();
  const responsePromise = transport.requestStream({ id: "node_stream_abort" }, "/slow", { signal: controller.signal });
  const opened = sent[0];
  const secondary = {
    readyState: 1,
    closes: [],
    send() {},
    close(code, reason) { this.readyState = 3; this.closes.push({ code, reason }); },
    on() {},
  };
  assert.equal(transport.attachHttpStream("node_stream_abort", opened.streamId, secondary), true);

  controller.abort();
  await assert.rejects(responsePromise, (error) => error.name === "AbortError" && error.code === "ABORT_ERR");
  assert.equal(secondary.closes.length, 1);
  assert.equal(sent.at(-1).type, "control-plane.http.cancel");
  assert.equal(sent.at(-1).streamId, opened.streamId);
});

test("closing a reverse HTTP response consumer cancels the node request", async () => {
  const transport = new ControlPlaneNodeAgentTunnelTransport();
  const sent = [];
  transport.attach("node_stream_consumer", {
    readyState: 1,
    send(data) { sent.push(JSON.parse(String(data))); },
  });
  const responsePromise = transport.requestStream({ id: "node_stream_consumer" }, "/stream");
  const opened = sent[0];
  const secondaryEvents = new EventEmitter();
  const secondary = {
    readyState: 1,
    closes: [],
    send() {},
    close(code, reason) { this.readyState = 3; this.closes.push({ code, reason }); },
    on(event, listener) { secondaryEvents.on(event, listener); },
  };
  assert.equal(transport.attachHttpStream("node_stream_consumer", opened.streamId, secondary), true);
  secondaryEvents.emit("message", JSON.stringify({ type: "node-agent.http.head", status: 200, headers: {} }), false);
  const response = await responsePromise;

  await response.body.cancel();
  await waitForCondition(() => secondary.closes.length === 1, "reverse HTTP consumer cancellation");
  assert.equal(sent.at(-1).type, "control-plane.http.cancel");
  assert.equal(sent.at(-1).streamId, opened.streamId);
});

test("node reverse tunnel aborts its local fetch when the control plane cancels an HTTP stream", async (t) => {
  let markRequestStarted;
  let markRequestClosed;
  const requestStarted = new Promise((resolve) => { markRequestStarted = resolve; });
  const requestClosed = new Promise((resolve) => { markRequestClosed = resolve; });
  const localServer = http.createServer((_request, response) => {
    markRequestStarted();
    response.once("close", () => markRequestClosed(response.writableFinished));
  });
  await new Promise((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => localServer.close(resolve)));
  const localAddress = localServer.address();
  assert.equal(typeof localAddress, "object");

  const tunnelServer = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
  const tunnelSockets = new Set();
  t.after(() => {
    for (const socket of tunnelSockets) socket.terminate();
    return new Promise((resolve) => tunnelServer.close(resolve));
  });
  await withTimeout(new Promise((resolve) => tunnelServer.once("listening", resolve)), "reverse tunnel test server listening");
  const tunnelAddress = tunnelServer.address();
  assert.equal(typeof tunnelAddress, "object");
  let markMainConnected;
  const mainConnected = new Promise((resolve) => { markMainConnected = resolve; });
  tunnelServer.on("connection", (serverSocket, request) => {
    tunnelSockets.add(serverSocket);
    serverSocket.on("close", () => tunnelSockets.delete(serverSocket));
    if (!request.url.includes("/http-streams/")) markMainConnected(serverSocket);
  });

  const tunnel = connectReverseTunnel({
    log: { warn() {} },
    inject() { throw new Error("Unexpected inject call."); },
  }, {
    tunnelUrl: `ws://127.0.0.1:${tunnelAddress.port}/api/node-tunnel`,
    nodeId: "node_http_cancel",
    port: localAddress.port,
  });
  t.after(() => tunnel.terminate());
  const main = await withTimeout(mainConnected, "reverse tunnel main connection");
  main.send(JSON.stringify({ type: "control-plane.http.open", streamId: "stream_cancel", route: "/slow", init: { method: "GET" } }));
  await withTimeout(requestStarted, "node local fetch start");
  main.send(JSON.stringify({ type: "control-plane.http.cancel", streamId: "stream_cancel", reason: "test cancellation" }));

  assert.equal(await withTimeout(requestClosed, "node local fetch cancellation"), false);
});

test("reverse websocket proxy normalizes abnormal close events in both directions", () => {
  class StrictWebSocket extends EventEmitter {
    OPEN = 1;
    readyState = this.OPEN;
    closes = [];

    send() {}

    close(code, reason) {
      const valid = code === undefined
        || (Number.isInteger(code) && ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999)));
      if (!valid) throw new TypeError("First argument must be a valid error code number");
      if (reason !== undefined && Buffer.byteLength(reason, "utf8") > 123) throw new RangeError("Close reason is too long");
      this.closes.push({ code, reason });
    }
  }

  const sent = [];
  const transport = new ControlPlaneNodeAgentTunnelTransport();
  transport.attach("node_close_codes", {
    readyState: 1,
    send(data) { sent.push(JSON.parse(data)); },
  });

  const browser = new StrictWebSocket();
  transport.proxyWebSocket({ id: "node_close_codes" }, browser, "/instances/one/proxy/ws/events");
  const opened = sent.shift();
  const reverseStream = new StrictWebSocket();
  assert.equal(transport.attachWebSocketStream("node_close_codes", opened.streamId, reverseStream), true);

  assert.doesNotThrow(() => browser.emit("close", 1006, Buffer.from("abnormal close")));
  assert.ok(reverseStream.closes.length > 0);
  assert.ok(reverseStream.closes.every((close) => close.code === undefined));
  const forwardedClose = sent.find((message) => message.type === "control-plane.websocket.close");
  assert.equal(forwardedClose.code, undefined);

  const secondBrowser = new StrictWebSocket();
  transport.proxyWebSocket({ id: "node_close_codes" }, secondBrowser, "/instances/two/proxy/ws/events");
  const secondOpened = sent.findLast((message) => message.type === "control-plane.websocket.open");
  assert.doesNotThrow(() => transport.handleMessage("node_close_codes", {
    type: "node-agent.websocket.close",
    streamId: secondOpened.streamId,
    code: 1006,
    reason: "x".repeat(200),
  }));
  assert.deepEqual(secondBrowser.closes.map((close) => close.code), [undefined]);
  assert.equal(Buffer.byteLength(secondBrowser.closes[0].reason, "utf8"), 123);
});

test("control plane proxies instance websocket routes through reverse node tunnels", async (t) => {
  const mock = createMockNodeAgentFetch();
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-reverse-websocket"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });

  const project = await json(app, "POST", "/api/projects", {
    name: "Reverse WebSocket Project",
    source: {
      type: "local-folder",
      path: "/tmp/reverse-websocket",
    },
  });
  assert.equal(project.statusCode, 201);
  const created = await json(app, "POST", "/api/controlled-instances", {
    name: "reverse-worker",
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
  });
  assert.equal(created.statusCode, 201);
  await mock.fetchImpl(`http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${created.body.data.registrationToken}` },
    body: JSON.stringify({
      instanceId: created.body.data.id,
      target: {
        strategy: "direct-port",
        web: "http://controlled.internal:8080",
        api: "http://controlled.internal:8080/api",
        status: "reachable",
      },
      workspace: {
        status: "ready",
      },
      capabilities: { features: { appRuntime: true } },
      appInventory: testAppInventory([
        { id: "codex", name: "Codex" },
        { id: "claude", name: "Claude" },
      ]),
    }),
  });
  const updatedNode = await json(app, "PATCH", "/api/nodes/node_mock", {
    connectionMode: "reverse-wss",
    auth: {
      mode: "paired-hmac",
      keyId: "key_agent",
      secret: "agent-secret",
    },
  });
  assert.equal(updatedNode.statusCode, 200);

  const address = app.server.address();
  assert.equal(typeof address, "object");
  const tunnelPath = "/api/node-tunnel?nodeId=node_mock";
  const tunnel = new WebSocket(`ws://127.0.0.1:${address.port}${tunnelPath}`, {
    headers: createNodeAgentHmacHeaders({
      nodeId: "node_mock",
      keyId: "key_agent",
      secret: "agent-secret",
      method: "GET",
      pathWithQuery: tunnelPath,
    }),
  });
  t.after(() => tunnel.terminate());
  const hello = await onceWebSocketMessage(tunnel);
  assert.equal(hello.type, "control-plane.hello");

  const queuedTunnelMessages = [];
  const tunnelMessageWaiters = [];
  let recoveryRequestPending = false;
  let fallbackRecoverySnapshot;
  const dispatchTunnelMessage = (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === "control-plane.request" && message.route === "/instances") {
      tunnel.send(JSON.stringify({
        type: "node-agent.response",
        requestId: message.requestId,
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: [...mock.instances.values()] }),
      }));
      return;
    }
    if (message.type === "control-plane.request" && !recoveryRequestPending && fallbackRecoverySnapshot) {
      const body = JSON.parse(String(decodeNodeTunnelRequestBody(message.init.body)));
      if (message.route === `/instances/${created.body.data.id}/proxy` && body.path === "/api/triggers") {
        tunnel.send(JSON.stringify({
          type: "node-agent.response",
          requestId: message.requestId,
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: { schemaVersion: 1, configs: [], deployments: [], runtime: [], recentRuns: [] } }),
        }));
        return;
      }
      if (message.route === `/instances/${created.body.data.id}/proxy` && body.path === "/api/ai-sessions/state") {
        tunnel.send(JSON.stringify({
          type: "node-agent.response",
          requestId: message.requestId,
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: fallbackRecoverySnapshot }),
        }));
        return;
      }
    }
    const waiter = tunnelMessageWaiters.shift();
    if (waiter) waiter(message);
    else queuedTunnelMessages.push(message);
  };
  tunnel.on("message", dispatchTunnelMessage);
  t.after(() => tunnel.off("message", dispatchTunnelMessage));
  const nextTunnelMessage = () => queuedTunnelMessages.length
    ? Promise.resolve(queuedTunnelMessages.shift())
    : new Promise((resolve) => tunnelMessageWaiters.push(resolve));

  const respondToRecoveryRequest = async (data) => {
    recoveryRequestPending = true;
    for (;;) {
      const message = await nextTunnelMessage();
      if (message.type !== "control-plane.request") continue;
      assert.equal(message.route, `/instances/${created.body.data.id}/proxy`);
      tunnel.send(JSON.stringify({
        type: "node-agent.response",
        requestId: message.requestId,
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data }),
      }));
      await new Promise((resolve) => setImmediate(resolve));
      if (data.snapshot) fallbackRecoverySnapshot = data;
      recoveryRequestPending = false;
      return JSON.parse(String(decodeNodeTunnelRequestBody(message.init.body)));
    }
  };

  const recoveredAt = new Date().toISOString();
  tunnel.send(JSON.stringify({
    type: "node-agent.streams.hello",
    instanceId: created.body.data.id,
    payload: {
      protocolVersion: 1,
      streams: [{ topic: "ai.sessions", instanceId: created.body.data.id, streamId: "ai_reverse_stream", latestRevision: 1, earliestRetainedRevision: 1 }],
    },
  }));
  const initialRecoveryBody = await withTimeout(respondToRecoveryRequest({
    streamId: "ai_reverse_stream",
    revision: 1,
    lastEventAt: recoveredAt,
    snapshot: { runningCount: 0, waitingCount: 0, staleCount: 0, sessions: [], updatedAt: recoveredAt },
  }), "reverse tunnel initial recovery request", 5_000);
  assert.equal(initialRecoveryBody.path, "/api/ai-sessions/state");
  await waitForCondition(async () => {
    const response = await json(app, "GET", "/api/ai-sessions");
    return response.body.data.instances.some((entry) => entry.instanceId === created.body.data.id && entry.streamId === "ai_reverse_stream" && entry.revision === 1);
  }, "reverse tunnel initial stream recovery");

  tunnel.send(JSON.stringify({
    type: "node-agent.streams.hello",
    instanceId: created.body.data.id,
    payload: {
      protocolVersion: 1,
      streams: [{ topic: "ai.sessions", instanceId: created.body.data.id, streamId: "ai_reverse_stream", latestRevision: 3, earliestRetainedRevision: 2 }],
    },
  }));
  const recoveredSession = { id: "ai_reverse_recovered", agent: "codex", status: "idle", phase: "unknown", startedAt: recoveredAt, updatedAt: recoveredAt, queue: { pendingCount: 0, items: [] } };
  const deltaEvents = [2, 3].map((revision) => ({
    type: AiSessionEventType.Patch,
    payload: {
      meta: { instanceId: created.body.data.id, streamId: "ai_reverse_stream", revision, previousRevision: revision - 1, traceId: `reverse_${revision}`, generatedAt: recoveredAt, reason: "provider-event" },
      upserted: [recoveredSession],
      removed: [],
    },
  }));
  const deltaRecoveryBody = await withTimeout(respondToRecoveryRequest({
    instanceId: created.body.data.id,
    streamId: "ai_reverse_stream",
    sinceRevision: 1,
    latestRevision: 3,
    earliestRetainedRevision: 2,
    syncRequired: false,
    events: deltaEvents,
  }), "reverse tunnel delta recovery request", 5_000);
  assert.match(deltaRecoveryBody.path, /^\/api\/ai-sessions\?/);
  await waitForCondition(async () => {
    const response = await json(app, "GET", "/api/ai-sessions");
    return response.body.data.instances.find((entry) => entry.instanceId === created.body.data.id)?.revision === 3;
  }, "reverse tunnel delta recovery");

  tunnel.send(JSON.stringify({
    type: "node-agent.streams.hello",
    instanceId: created.body.data.id,
    payload: {
      protocolVersion: 1,
      streams: [{ topic: "ai.sessions", instanceId: created.body.data.id, streamId: "ai_reverse_restarted", latestRevision: 1, earliestRetainedRevision: 1 }],
    },
  }));
  await withTimeout(respondToRecoveryRequest({
    streamId: "ai_reverse_restarted",
    revision: 1,
    lastEventAt: recoveredAt,
    snapshot: { runningCount: 0, waitingCount: 0, staleCount: 0, sessions: [], updatedAt: recoveredAt },
  }), "reverse tunnel restarted recovery request", 5_000);
  tunnel.send(JSON.stringify({
    type: "node-agent.event.forwarded",
    event: { type: AiSessionEventType.Snapshot, topic: AiSessionEventTopic, payload: aiSessionSnapshotPayload({ sessions: [recoveredSession] }, { instanceId: created.body.data.id, streamId: "ai_reverse_stream", revision: 4 }), scope: { instanceId: created.body.data.id } },
  }));
  const restarted = await waitForCondition(async () => {
    const response = await json(app, "GET", "/api/ai-sessions");
    return response.body.data.instances.find((entry) => entry.instanceId === created.body.data.id && entry.streamId === "ai_reverse_restarted");
  }, "reverse tunnel restarted stream recovery");
  assert.equal(restarted.revision, 1);
  assert.deepEqual(restarted.aiSessions.sessions, []);

  const client = new WebSocket(`ws://127.0.0.1:${address.port}/instances/${created.body.data.id}/api/apps/sessions/app_1/tty?token=abc`, ["binary"]);
  t.after(() => client.terminate());
  await withTimeout(waitForWebSocketOpen(client), "reverse proxied websocket open");

  let open;
  while (!open) {
    const message = await withTimeout(nextTunnelMessage(), "reverse websocket open request", 5_000);
    open = message;
  }
  assert.equal(open.type, "control-plane.websocket.open");
  assert.equal(open.route, `/instances/${created.body.data.id}/proxy/ws/api/apps/sessions/app_1/tty?token=abc`);
  assert.deepEqual(open.protocols, ["binary"]);

  const streamPath = `/api/node-tunnel/streams/${open.streamId}?nodeId=node_mock`;
  const stream = new WebSocket(`ws://127.0.0.1:${address.port}${streamPath}`, {
    headers: createNodeAgentHmacHeaders({
      nodeId: "node_mock",
      keyId: "key_agent",
      secret: "agent-secret",
      method: "GET",
      pathWithQuery: streamPath,
    }),
  });
  t.after(() => stream.terminate());
  t.after(() => app.close());
  await withTimeout(waitForWebSocketOpen(stream), "reverse websocket stream open");
  stream.send("ready");
  assert.deepEqual(await withTimeout(onceWebSocketMessageFrame(client), "reverse websocket ready"), { message: "ready", isBinary: false });

  client.send("hello");
  assert.deepEqual(await withTimeout(onceWebSocketMessageFrame(stream), "reverse websocket stream frame"), { message: "hello", isBinary: false });
  const sockets = [stream, client, tunnel];
  const closed = sockets.map((socket) => socket.readyState === WebSocket.CLOSED
    ? Promise.resolve()
    : new Promise((resolve) => socket.once("close", resolve)));
  sockets.forEach((socket) => socket.terminate());
  await withTimeout(Promise.all(closed), "reverse websocket cleanup", 5_000);
  await withTimeout(app.close(), "reverse websocket app close", 5_000);
});

test("node model edits create a new hash and retain the previous location until explicit deletion", async (t) => {
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-agent-model-content-addressed-edit"),
    logger: false,
    token: "agent-secret",
  });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST",
    url: "/api/node-agent/models",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      name: "Node model",
      endpoint: "https://node-model.example/v1",
      key: "node-model-secret",
      model: "gpt-node-model",
      app: "codex",
    },
  });
  assert.equal(created.statusCode, 201);
  const originalId = created.json().data.id;

  const updated = await app.inject({
    method: "PATCH",
    url: `/api/node-agent/models/${originalId}`,
    headers: { authorization: "Bearer agent-secret" },
    payload: { endpoint: "https://node-model-v2.example/v1" },
  });
  assert.equal(updated.statusCode, 200);
  assert.notEqual(updated.json().data.id, originalId);

  const listed = await app.inject({
    method: "GET",
    url: "/api/node-agent/models",
    headers: { authorization: "Bearer agent-secret" },
  });
  assert.deepEqual(new Set(listed.json().data.map((model) => model.id)), new Set([originalId, updated.json().data.id]));

  const removed = await app.inject({
    method: "DELETE",
    url: `/api/node-agent/models/${originalId}`,
    headers: { authorization: "Bearer agent-secret" },
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().data.deleted, true);
});

test("control plane models deploy to the target node and instances store assignments", async (t) => {
  const mockOptions = {};
  const mock = createMockNodeAgentFetch(mockOptions);
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-models"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());

  const first = await json(app, "POST", "/api/models", {
    name: "First Codex",
    endpoint: "https://first.example/v1",
    key: "first-key-secret",
    model: "first-model",
    app: "codex",
  });
  assert.equal(first.statusCode, 201);
  assert.equal(first.body.data.key, undefined);
  assert.equal(first.body.data.keySet, true);

  const selectedCodex = await json(app, "POST", "/api/models", {
    name: "Allowed Codex",
    endpoint: "https://allowed.example/v1",
    key: "allowed-codex-key-secret",
    model: "allowed-codex-model",
    app: "codex",
  });
  assert.equal(selectedCodex.statusCode, 201);

  const selectedClaude = await json(app, "POST", "/api/models", {
    name: "Allowed Claude",
    endpoint: "https://anthropic.example",
    key: "allowed-claude-key-secret",
    model: "allowed-claude-model",
    app: "claude",
  });
  assert.equal(selectedClaude.statusCode, 201);

  const disabledCodex = await json(app, "POST", "/api/models", {
    name: "Disabled Codex",
    endpoint: "https://disabled.example/v1",
    key: "disabled-codex-key-secret",
    model: "disabled-codex-model",
    app: "codex",
    enabled: false,
  });
  assert.equal(disabledCodex.statusCode, 201);

  const project = await json(app, "POST", "/api/projects", {
    name: "Instance Model Project",
    source: {
      type: "local-folder",
      path: "/tmp/workspace",
    },
  });
  assert.equal(project.statusCode, 201);
  assert.equal(project.body.data.modelSelection, undefined);

  const projectWithModels = await json(app, "POST", "/api/projects", {
    name: "Legacy Model Project",
    source: { type: "local-folder", path: "/tmp/legacy-workspace" },
    modelSelection: { codexModelHash: selectedCodex.body.data.id },
  });
  assert.equal(projectWithModels.statusCode, 400);

  const wrongAppInstance = await json(app, "POST", "/api/controlled-instances", {
    name: "wrong-app-instance",
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
    modelSelection: { claudeModelHash: selectedCodex.body.data.id },
  });
  assert.equal(wrongAppInstance.statusCode, 400);
  assert.equal(wrongAppInstance.body.error.code, "MODEL_APP_MISMATCH");

  const disabledModelInstance = await json(app, "POST", "/api/controlled-instances", {
    name: "disabled-model-instance",
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
    modelSelection: { codexModelHash: disabledCodex.body.data.id },
  });
  assert.equal(disabledModelInstance.statusCode, 400);
  assert.equal(disabledModelInstance.body.error.code, "MODEL_DISABLED");

  const instance = await json(app, "POST", "/api/controlled-instances", {
    name: "scoped-1",
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
    modelSelection: {
      codexModelHash: selectedCodex.body.data.id,
      claudeModelHash: selectedClaude.body.data.id,
    },
  });
  assert.equal(instance.statusCode, 201);
  assert.deepEqual(instance.body.data.modelSelection, {
    codexModelHash: selectedCodex.body.data.id,
    claudeModelHash: selectedClaude.body.data.id,
  });
  const createRequest = mock.requests.find((request) => request.path === "/instances" && request.method === "POST" && request.body.name === "scoped-1");
  assert.equal("modelEnv" in createRequest.body, false);
  const codexDeploy = mock.requests.find((request) => request.path === `/models/${selectedCodex.body.data.id}/deploy` && request.method === "PUT");
  assert.equal(codexDeploy.body.key, "allowed-codex-key-secret");
  assert.equal(modelConfigHash(codexDeploy.body), selectedCodex.body.data.id);
  const assignmentRequest = mock.requests.find((request) => request.path === `/instances/${instance.body.data.id}/model-assignment` && request.method === "PUT");
  assert.equal(assignmentRequest.body.codexModelHash, selectedCodex.body.data.id);
  assert.equal(assignmentRequest.body.claudeModelHash, selectedClaude.body.data.id);
  assert.equal("key" in assignmentRequest.body, false);

  const noModelInstance = await json(app, "POST", "/api/controlled-instances", {
    name: "no-managed-model",
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
    modelSelection: {
      codexModelHash: null,
      claudeModelHash: null,
    },
  });
  assert.equal(noModelInstance.statusCode, 201);
  assert.deepEqual(noModelInstance.body.data.modelSelection, {
    codexModelHash: null,
    claudeModelHash: null,
  });
  const noModelAssignment = mock.requests.find((request) => request.path === `/instances/${noModelInstance.body.data.id}/model-assignment` && request.method === "PUT");
  assert.deepEqual(noModelAssignment.body.modelSelection, {
    codexModelHash: null,
    claudeModelHash: null,
  });
  assert.equal(noModelAssignment.body.codexModelHash, undefined);
  assert.equal(noModelAssignment.body.claudeModelHash, undefined);

  const registry = await json(app, "GET", "/api/models");
  assert.equal(registry.statusCode, 200);
  assert.equal(Array.isArray(registry.body.data.models), true);
  const selectedGroup = registry.body.data.models.find((group) => group.id === selectedCodex.body.data.id);
  assert.deepEqual(selectedGroup.locations.map((location) => location.type), ["control-plane", "node"]);
  assert.equal("key" in selectedGroup.model, false);

  const localModel = await json(app, "POST", "/api/nodes/node_mock/models", {
    name: "Node local Codex",
    endpoint: "http://node-local.test/v1",
    key: "node-local-secret",
    model: "node-local-model",
    app: "codex",
  });
  assert.equal(localModel.statusCode, 201);
  const registryWithLocal = await json(app, "GET", "/api/models");
  assert.equal(registryWithLocal.statusCode, 200, JSON.stringify(registryWithLocal.body));
  assert.equal(registryWithLocal.body.data.models.some((group) => group.locations.some((location) => location.type === "node" && location.nodeId === "node_mock")), true);

  const rotatedModel = await json(app, "PATCH", `/api/models/${selectedCodex.body.data.id}`, {
    key: "rotated-codex-key-secret",
    endpoint: "https://rotated.example/v1",
  });
  assert.equal(rotatedModel.statusCode, 200);
  assert.notEqual(rotatedModel.body.data.id, selectedCodex.body.data.id);
  assert.equal(mock.requests.filter((request) => request.path === `/models/${selectedCodex.body.data.id}/deploy`).length, 1);
  const registryAfterRotation = await json(app, "GET", "/api/models");
  assert.equal(registryAfterRotation.body.data.models.some((group) => group.id === selectedCodex.body.data.id), true);
  assert.equal(registryAfterRotation.body.data.models.some((group) => group.id === rotatedModel.body.data.id), true);

  const selectRotated = await json(app, "PATCH", `/api/controlled-instances/${instance.body.data.id}`, {
    modelSelection: { codexModelHash: rotatedModel.body.data.id },
  });
  assert.equal(selectRotated.statusCode, 200);
  const disableSelectedModel = await json(app, "PATCH", `/api/models/${rotatedModel.body.data.id}`, { enabled: false });
  assert.equal(disableSelectedModel.statusCode, 200);
  assert.equal(disableSelectedModel.body.data.enabled, false);

  const rejectedStart = await json(app, "POST", `/api/controlled-instances/${instance.body.data.id}/start`);
  assert.equal(rejectedStart.statusCode, 400);
  assert.equal(rejectedStart.body.error.code, "MODEL_DISABLED");

  const updated = await json(app, "PATCH", `/api/controlled-instances/${instance.body.data.id}`, {
    modelSelection: { codexModelHash: first.body.data.id },
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.body.data.modelSelection, { codexModelHash: first.body.data.id });

  const started = await json(app, "POST", `/api/controlled-instances/${instance.body.data.id}/start`);
  assert.equal(started.statusCode, 200);
  const startRequest = mock.requests.find((request) => request.path === `/instances/${instance.body.data.id}/start`);
  assert.deepEqual(startRequest.body, {});

  const generalUpdated = await json(app, "PATCH", `/api/controlled-instances/${instance.body.data.id}`, {
    config: { autoImportAgentConfigs: false },
  });
  assert.equal(generalUpdated.statusCode, 200);
  assert.deepEqual(generalUpdated.body.data.config, { autoImportAgentConfigs: false, defaultCodexPermissionMode: "ask" });
  const generalUpdateRequest = mock.requests.findLast((request) => request.path === `/instances/${instance.body.data.id}` && request.method === "PATCH" && request.body.config);
  assert.deepEqual(generalUpdateRequest.body.config, { autoImportAgentConfigs: false });

  const rejectedGeneralUpdate = await json(app, "PATCH", `/api/controlled-instances/${instance.body.data.id}`, {
    config: { autoImportAgentConfigs: true, unknown: true },
  });
  assert.equal(rejectedGeneralUpdate.statusCode, 400);

  const restarted = await json(app, "POST", `/api/controlled-instances/${instance.body.data.id}/restart`);
  assert.equal(restarted.statusCode, 200);
  const restartRequest = mock.requests.findLast((request) => request.path === `/instances/${instance.body.data.id}/restart`);
  assert.deepEqual(restartRequest.body, {});

  const deleteBoundModel = await json(app, "DELETE", `/api/models/${first.body.data.id}`);
  assert.equal(deleteBoundModel.statusCode, 200);
});

test("control plane deletes an undeployed model without scanning an offline fleet", async (t) => {
  const mockOptions = {};
  const mock = createMockNodeAgentFetch(mockOptions);
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-model-delete-offline"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: { fetchImpl: mock.fetchImpl },
  });
  t.after(() => app.close());

  const model = await json(app, "POST", "/api/models", {
    name: "Offline reference model",
    endpoint: "https://offline.example/v1",
    key: "offline-key-secret",
    model: "offline-model",
    app: "codex",
  });
  assert.equal(model.statusCode, 201);

  mockOptions.instancesError = new Error("node offline");
  const deleted = await json(app, "DELETE", `/api/models/${model.body.data.id}`);
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.body.data.deleted, true);
});

test("federated model registry groups one control-plane model across multiple nodes", async (t) => {
  const firstOptions = { nodeId: "node_one" };
  const secondOptions = { nodeId: "node_two" };
  const firstNode = createMockNodeAgentFetch(firstOptions);
  const secondNode = createMockNodeAgentFetch(secondOptions);
  const fetchImpl = (url, init) => new URL(String(url)).hostname === "node-two.example"
    ? secondNode.fetchImpl(url, init)
    : firstNode.fetchImpl(url, init);
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-models-multi-node"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: { fetchImpl },
  });
  t.after(() => app.close());

  const nodeTwo = await json(app, "POST", "/api/nodes", {
    id: "node_two",
    name: "Node Two",
    connectionMode: "direct-http",
    endpoint: "http://node-two.example:8091",
    auth: { mode: "paired-hmac", keyId: "key_two", secret: "secret-two" },
  });
  assert.equal(nodeTwo.statusCode, 201, JSON.stringify(nodeTwo.body));
  const model = await json(app, "POST", "/api/models", {
    name: "Shared Codex",
    endpoint: "https://shared.example/v1",
    key: "shared-secret-key",
    model: "shared-codex",
    app: "codex",
  });
  const project = await json(app, "POST", "/api/projects", {
    name: "Multi-node models",
    source: { type: "local-folder", path: "/tmp/multi-node" },
  });
  for (const nodeId of ["node_one", "node_two"]) {
    const instance = await json(app, "POST", "/api/controlled-instances", {
      name: `instance-${nodeId}`,
      projectId: project.body.data.id,
      nodeId,
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "market_taskhandoff_browser" },
      modelSelection: { codexModelHash: model.body.data.id },
    });
    assert.equal(instance.statusCode, 201, JSON.stringify(instance.body));
  }
  const local = await json(app, "POST", "/api/nodes/node_two/models", {
    name: "Node Two Local",
    endpoint: "http://node-two.local/v1",
    key: "node-two-local-secret",
    model: "node-two-local",
    app: "codex",
  });
  assert.equal(local.statusCode, 201);

  const registry = await json(app, "GET", "/api/models");
  const group = registry.body.data.models.find((item) => item.id === model.body.data.id);
  assert.deepEqual(group.locations.filter((item) => item.type === "node").map((item) => item.nodeId).sort(), ["node_one", "node_two"]);
  assert.equal(registry.body.data.models.some((item) => item.locations.some((location) => location.type === "node" && location.nodeId === "node_two")), true);
  assert.equal(JSON.stringify(registry.body.data).includes("shared-secret-key"), false);
  assert.equal(JSON.stringify(registry.body.data).includes("node-two-local-secret"), false);

  secondOptions.modelsError = new Error("node two offline");
  secondOptions.deployModelError = new Error("node two offline");
  const staleRegistry = await json(app, "GET", "/api/models");
  assert.equal(staleRegistry.statusCode, 200, JSON.stringify(staleRegistry.body));
  const partialGroup = staleRegistry.body.data.models.find((item) => item.id === model.body.data.id);
  assert.equal(partialGroup.locations.some((item) => item.type === "node" && item.nodeId === "node_two"), false);
  assert.equal(staleRegistry.body.data.nodeDiagnostics.some((item) => item.nodeId === "node_two"), true);

  secondOptions.modelsError = undefined;
  secondOptions.deployModelError = undefined;
  const reconciled = await json(app, "GET", "/api/models");
  assert.equal(reconciled.body.data.models.find((item) => item.id === model.body.data.id).locations.some((item) => item.type === "node" && item.nodeId === "node_two"), true);

  for (const mock of [firstNode, secondNode]) {
    const deployed = mock.nodeModels.get(model.body.data.id);
    mock.nodeModels.set(model.body.data.id, { ...deployed, referenceCount: 0 });
  }
  secondOptions.modelDeleteError = new Error("node two offline");
  const sourceDelete = await json(app, "DELETE", `/api/models/${model.body.data.id}`);
  assert.equal(sourceDelete.statusCode, 200);
});

test("failed assignment leaves an unreferenced hash entry without deployment state", async (t) => {
  const mockOptions = {};
  const mock = createMockNodeAgentFetch(mockOptions);
  const dataDir = tempDataDir("control-plane-model-assignment-compensation");
  const app = await createControlPlaneApp({
    dataDir,
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: { fetchImpl: mock.fetchImpl },
  });
  t.after(() => app.close());

  const model = await json(app, "POST", "/api/models", {
    name: "Compensated model",
    endpoint: "https://compensated.example/v1",
    key: "compensated-key",
    model: "compensated-model",
    app: "codex",
  });
  const project = await json(app, "POST", "/api/projects", {
    name: "Compensation project",
    source: { type: "local-folder", path: "/tmp/compensation" },
  });
  mockOptions.assignmentError = new Error("assignment failed");
  const failed = await json(app, "POST", "/api/controlled-instances", {
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
    modelSelection: { codexModelHash: model.body.data.id },
  });
  assert.notEqual(failed.statusCode, 201);
  assert.equal(mock.requests.some((request) => request.path === `/models/${model.body.data.id}/deploy` && request.method === "PUT"), true);
  assert.equal(mock.requests.some((request) => /^\/instances\/[^/]+\/delete$/.test(request.path) && request.method === "POST"), true);
  assert.equal(mock.requests.some((request) => request.path === `/models/${model.body.data.id}` && request.method === "DELETE"), false);
  assert.equal(fs.existsSync(path.join(dataDir, "model-deployments")), false);

  mockOptions.assignmentError = undefined;
  mockOptions.modelsError = new Error("target node offline");
  const requestCount = mock.requests.length;
  const offline = await json(app, "POST", "/api/controlled-instances", {
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
    modelSelection: { codexModelHash: model.body.data.id },
  });
  assert.notEqual(offline.statusCode, 201);
  assert.equal(mock.requests.slice(requestCount).some((request) => request.path === "/instances" && request.method === "POST"), false);
});

test("control plane manages projects, instances, register, heartbeat, and board state", async (t) => {
  const mock = createMockNodeAgentFetch({
    proxy: ({ body, jsonResponse }) => {
      if (body.path === "/api/apps/sessions" && body.method === "GET") {
        return jsonResponse([{ id: "app_1", appId: "terminal-tty", kind: "tty", status: "running" }]);
      }
      return jsonResponse({ ok: true });
    },
  });
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());

  const health = await json(app, "GET", "/api/health");
  assert.equal(health.statusCode, 200);
  assert.equal(health.body.data.role, "control-plane");
  assert.equal(health.body.data.build.component, "control-plane");
  assert.equal(health.body.data.build.protocolVersion, CONTROL_PLANE_PROTOCOL_VERSION);

  const nodeAgentRequestsBeforeStatus = mock.requests.length;
  const status = await json(app, "GET", "/api/control-plane/status");
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.data.build.component, "control-plane");
  assert.equal("counts" in status.body.data, false);
  assert.equal(mock.requests.length, nodeAgentRequestsBeforeStatus);

  const nodes = await json(app, "GET", "/api/nodes");
  assert.equal(nodes.statusCode, 200);
  const localNodeId = nodes.body.data[0].id;
  assert.equal(localNodeId, "node_mock");
  assert.equal(nodes.body.data[0].labels["task-handoff.control-plane.local"], "true");
  assert.equal(nodes.body.data[0].labels["task-handoff.control-plane.builtin"], "true");

  const syncedLocalNode = await json(app, "POST", "/api/nodes/local/sync");
  assert.equal(syncedLocalNode.statusCode, 200);
  assert.equal(syncedLocalNode.body.data.id, localNodeId);

  const deletedLocalNode = await json(app, "DELETE", `/api/nodes/${localNodeId}`);
  assert.equal(deletedLocalNode.statusCode, 400);
  assert.equal(deletedLocalNode.body.error.code, "LOCAL_NODE_CANNOT_BE_DELETED");

  const listener = await json(app, "GET", `/api/nodes/${localNodeId}/settings/external-listener`);
  assert.equal(listener.statusCode, 200);
  assert.equal(listener.body.data.port, 8091);
  const originalLocalEndpoint = nodes.body.data[0].endpoint;
  const originalLocalConnectionMode = nodes.body.data[0].connectionMode;
  const updatedListener = await json(app, "PATCH", `/api/nodes/${localNodeId}/settings/external-listener`, { bindScope: "all-ipv4", port: 18091 });
  assert.equal(updatedListener.statusCode, 200);
  assert.deepEqual(updatedListener.body.data, { bindScope: "all-ipv4", host: "0.0.0.0", port: 18091, status: "listening", source: "persisted" });
  const localAfterListenerUpdate = await json(app, "GET", `/api/nodes/${localNodeId}`);
  assert.equal(localAfterListenerUpdate.body.data.connectionMode, originalLocalConnectionMode);
  assert.equal(localAfterListenerUpdate.body.data.endpoint, originalLocalEndpoint);

  const remoteNode = await json(app, "POST", "/api/nodes", {
    name: "Remote",
    connectionMode: "direct-http",
    endpoint: "http://remote.example:8091",
    auth: { mode: "paired-hmac", keyId: "key_remote", secret: "secret_remote", pairedAt: new Date().toISOString() },
  });
  assert.equal(remoteNode.statusCode, 201);
  const remoteListener = await json(app, "GET", `/api/nodes/${remoteNode.body.data.id}/settings/external-listener`);
  assert.equal(remoteListener.statusCode, 403);
  assert.equal(remoteListener.body.error.code, "LOCAL_NODE_LISTENER_ONLY");

  const targets = await json(app, "GET", "/api/node-runtimes");
  assert.equal(targets.statusCode, 200);
  assert.equal(targets.body.data[0].id, "runtime_local_docker");

  const project = await json(app, "POST", "/api/projects", {
    name: "Local Project",
    source: {
      type: "local-folder",
      path: "/tmp/workspace",
    },
  });
  assert.equal(project.statusCode, 201);
  assert.equal(project.body.data.workspacePolicy.mode, "local-bind");

  const createdInstance = await json(app, "POST", "/api/controlled-instances", {
    name: "local-1",
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
  });
  assert.equal(createdInstance.statusCode, 201);
  assert.match(createdInstance.body.data.registrationToken, /^[A-Za-z0-9_-]+$/);

  const resourceMetrics = await json(app, "GET", `/api/controlled-instances/${createdInstance.body.data.id}/metrics`);
  assert.equal(resourceMetrics.statusCode, 200);
  const { sampledAt, ...resourceMetricsData } = resourceMetrics.body.data;
  assert.equal(Number.isNaN(Date.parse(sampledAt)), false);
  assert.deepEqual(resourceMetricsData, {
    instanceId: createdInstance.body.data.id,
    runtimeKind: "docker",
    state: "available",
    cpu: { usagePercent: 1.25 },
    memory: { usageBytes: 134_217_728, limitBytes: 536_870_912, usagePercent: 25 },
  });
  assert.equal(mock.requests.some((request) => request.path === `/instances/${createdInstance.body.data.id}/metrics` && request.method === "GET"), true);

  const registeredResponse = await mock.fetchImpl(`http://127.0.0.1:8091/api/node-agent/instances/${createdInstance.body.data.id}/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${createdInstance.body.data.registrationToken}`,
    },
    body: JSON.stringify({
      instanceId: createdInstance.body.data.id,
      projectId: project.body.data.id,
      instanceVersion: runtimeVersionStateForActual().desiredVersion,
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      controlMode: "controlled",
      capabilities: { features: { appRuntime: true } },
      appInventory: testAppInventory([{ id: "terminal-tty", name: "Terminal" }]),
      target: {
        strategy: "direct-port",
        web: "http://127.0.0.1:18080",
        api: "http://127.0.0.1:18080/api",
        status: "reachable",
      },
      workspace: {
        mode: "local-bind",
        status: "ready",
        path: "/workspace",
      },
    }),
  });
  assert.equal(registeredResponse.status, 201);

  const heartbeatResponse = await mock.fetchImpl(`http://127.0.0.1:8091/api/node-agent/instances/${createdInstance.body.data.id}/heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${createdInstance.body.data.registrationToken}`,
    },
    body: JSON.stringify({
      status: "running",
      health: "ok",
      capabilities: { features: { appRuntime: true } },
      appInventory: testAppInventory([
        { id: "terminal-tty", name: "Terminal", kind: "tty" },
        { id: "cc-switch", name: "CC Switch", kind: "gui" },
      ]),
      apps: {
        runningCount: 1,
      },
      aiSessions: {
        runningCount: 1,
        waitingCount: 0,
        staleCount: 0,
        updatedAt: new Date().toISOString(),
        sessions: [{
          id: "ais_1",
          agent: "codex",
          appId: "codex",
          appSessionId: "app_1",
          status: "running",
          phase: "responding",
          summary: "Working",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      },
      workspace: {
        status: "ready",
        resolvedCommit: "abc123",
      },
      target: {
        status: "reachable",
      },
    }),
  });
  assert.equal(heartbeatResponse.status, 200);

  const board = await json(app, "GET", "/api/instance-board");
  assert.equal(board.statusCode, 200);
  assert.equal(board.body.data.length, 1);
  assert.equal(board.body.data[0].project.name, "Local Project");
  assert.equal(board.body.data[0].image.id, "market_taskhandoff_browser");
  assert.deepEqual(board.body.data[0].appInventory.items.map(({ id, availability }) => ({ id, availability })), [
    { id: "terminal-tty", availability: "available" },
    { id: "cc-switch", availability: "available" },
  ]);
  assert.equal(board.body.data[0].runtime.id, "runtime_local_docker");
  assert.equal(board.body.data[0].protocolCompatible, true);
  assert.equal(board.body.data[0].aiSessions.runningCount, 1);
  assert.equal(board.body.data[0].aiSessions.idleCount, 0);
  assert.equal(board.body.data[0].aiSessions.problemCount, 0);
  assert.equal("sessions" in board.body.data[0].aiSessions, false);

  const aiSessions = await json(app, "GET", "/api/ai-sessions");
  assert.equal(aiSessions.statusCode, 200);
  assert.equal(aiSessions.body.data.instances.length, 1);
  assert.equal(aiSessions.body.data.instances[0].instanceId, createdInstance.body.data.id);
  assert.equal(aiSessions.body.data.instances[0].aiSessions.sessions[0].id, "ais_1");
});

test("control plane rejects unknown project request fields", async (t) => {
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-project-unknown-fields"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
  });
  t.after(() => app.close());

  const project = await json(app, "POST", "/api/projects", {
    name: "Tolerant Project",
    source: {
      type: "local-folder",
      path: "/tmp/workspace",
    },
    defaultRuntimeTargetId: "runtime_should_be_ignored",
  });
  assert.equal(project.statusCode, 400);

  const cleanProject = await json(app, "POST", "/api/projects", {
    name: "Clean Project",
    source: {
      type: "local-folder",
      path: "/tmp/workspace",
    },
  });
  assert.equal(cleanProject.statusCode, 201);

  const projectIdPatch = await json(app, "PATCH", `/api/projects/${cleanProject.body.data.id}`, {
    id: "project_patch_id",
  });
  assert.equal(projectIdPatch.statusCode, 400);
});

test("control plane rejects unknown controlled instance request fields", async (t) => {
  const mock = createMockNodeAgentFetch();
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-instance-unknown-fields"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());

  const project = await json(app, "POST", "/api/projects", {
    name: "Instance Tolerant Project",
    source: {
      type: "local-folder",
      path: "/tmp/workspace",
    },
  });
  assert.equal(project.statusCode, 201);

  const instance = await json(app, "POST", "/api/controlled-instances", {
    name: "unknown-field-instance",
    projectId: project.body.data.id,
    imageSelection: { imageId: "market_taskhandoff_browser" },
    defaultRuntimeTargetId: "runtime_should_be_ignored",
  });
  assert.equal(instance.statusCode, 400);
});

test("control plane forwards instance config auto-import setting to node agent", async (t) => {
  const mock = createMockNodeAgentFetch();
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-instance-auto-import-config"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());

  const project = await json(app, "POST", "/api/projects", {
    name: "Config Project",
    source: {
      type: "local-folder",
      path: "/tmp/workspace",
    },
  });
  assert.equal(project.statusCode, 201);

  const instance = await json(app, "POST", "/api/controlled-instances", {
    name: "config-instance",
    projectId: project.body.data.id,
    imageSelection: { imageId: "market_taskhandoff_browser" },
    config: {
      autoImportAgentConfigs: false,
    },
  });
  assert.equal(instance.statusCode, 201);
  assert.equal(instance.body.data.config.autoImportAgentConfigs, false);

  const createRequest = mock.requests.find((request) => request.path === "/instances");
  assert.ok(createRequest);
  assert.deepEqual(createRequest.body.config, { autoImportAgentConfigs: false });
});

test("control plane reports node-scoped image availability and preserves unknown inventory failures", async (t) => {
  const reference = "huadream/task-handoff-controlled-browser:latest";
  const availableAgent = createMockNodeAgentFetch({
    dockerImages: [{
      repository: "huadream/task-handoff-controlled-browser",
      tag: "latest",
      id: "sha256:local",
      reference,
      repoDigests: ["huadream/task-handoff-controlled-browser@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    }],
  });
  const missingAgent = createMockNodeAgentFetch({ nodeId: "node_missing", dockerImages: [] });
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-image-availability"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: (url, init) => {
        const host = new URL(String(url)).hostname;
        if (host === "node-missing.invalid") return missingAgent.fetchImpl(url, init);
        if (host === "node-offline.invalid") throw new Error("node inventory unavailable");
        return availableAgent.fetchImpl(url, init);
      },
    },
  });
  t.after(() => app.close());

  for (const node of [
    { id: "node_missing", name: "Missing image node", endpoint: "http://node-missing.invalid:8091", connectionMode: "direct-http", keyId: "key_missing", secret: "missing-secret" },
    { id: "node_offline", name: "Offline node", endpoint: "http://node-offline.invalid:8091", connectionMode: "reverse-wss", keyId: "key_offline", secret: "offline-secret" },
  ]) {
    const created = await json(app, "POST", "/api/nodes", {
      id: node.id,
      name: node.name,
      endpoint: node.endpoint,
      connectionMode: node.connectionMode,
      auth: { mode: "paired-hmac", keyId: node.keyId, secret: node.secret, pairing: { status: "paired" } },
    });
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
  }

  const available = await json(app, "GET", "/api/nodes/node_mock/image-options");
  assert.equal(available.statusCode, 200);
  const availableBrowser = available.body.data.find((entry) => entry.image.reference === reference);
  assert.equal(availableBrowser.status, "available");
  assert.equal(availableBrowser.localImage.reference, reference);

  const missing = await json(app, "GET", "/api/nodes/node_missing/image-options");
  assert.equal(missing.statusCode, 200);
  assert.equal(missing.body.data[0].status, "pull-required");

  const offline = await json(app, "GET", "/api/nodes/node_offline/image-options");
  assert.equal(offline.statusCode, 200);
  assert.equal(offline.body.data[0].status, "unknown");
  assert.ok(offline.body.data[0].error);
});

test("control plane protects referenced images and keeps instance image snapshots immutable", async (t) => {
  const mock = createMockNodeAgentFetch({
    localFolders: [{
      id: "folder_image_guard",
      nodeId: "node_mock",
      name: "Guarded folder",
      path: "/tmp/guarded-folder",
      defaultImageSelection: { imageId: "img_folder_guard" },
      labels: {},
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    }],
  });
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-image-delete-guards"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: { fetchImpl: mock.fetchImpl },
  });
  t.after(() => app.close());

  for (const [id, name] of [
    ["img_project_guard", "Project guard"],
    ["img_folder_guard", "Folder guard"],
    ["img_instance_guard", "Instance guard"],
    ["img_unused", "Unused"],
  ]) {
    const created = await json(app, "POST", "/api/images", { id, name, reference: `docker.io/example/${id}:v1` });
    assert.equal(created.statusCode, 201);
  }
  const project = await json(app, "POST", "/api/projects", {
    name: "Image guard project",
    source: { type: "local-folder", path: "/tmp/image-guard" },
    defaultImageSelection: { imageId: "img_project_guard" },
  });
  assert.equal(project.statusCode, 201);
  const instance = await json(app, "POST", "/api/controlled-instances", {
    name: "snapshot-instance",
    projectId: project.body.data.id,
    imageSelection: { imageId: "img_instance_guard" },
  });
  assert.equal(instance.statusCode, 201);
  assert.equal(instance.body.data.imageSnapshot.requestedReference, "docker.io/example/img_instance_guard:v1");

  const updated = await json(app, "PATCH", "/api/images/img_instance_guard", { reference: "docker.io/example/img_instance_guard:v2" });
  assert.equal(updated.statusCode, 200);
  const board = await json(app, "GET", "/api/instance-board");
  assert.equal(board.statusCode, 200);
  assert.equal(board.body.data.find((item) => item.id === instance.body.data.id).image.requestedReference, "docker.io/example/img_instance_guard:v1");

  for (const id of ["img_project_guard", "img_folder_guard", "img_instance_guard"]) {
    const guarded = await json(app, "DELETE", `/api/images/${id}`);
    assert.equal(guarded.statusCode, 409);
    assert.equal(guarded.body.error.code, "IMAGE_IN_USE");
  }
  const removed = await json(app, "DELETE", "/api/images/img_unused");
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.body.data.deleted, true);
});

test("control plane rejects unknown management request fields", async (t) => {
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-unknown-management-fields"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
  });
  t.after(() => app.close());

  const model = await json(app, "POST", "/api/models", {
    name: "Unknown Model",
    endpoint: "https://model.example/v1",
    key: "model-secret",
    model: "unknown-model",
    app: "codex",
    defaultRuntimeTargetId: "ignored",
  });
  assert.equal(model.statusCode, 400);

  const cleanModel = await json(app, "POST", "/api/models", {
    name: "Unknown Model",
    endpoint: "https://model.example/v1",
    key: "model-secret",
    model: "unknown-model",
    app: "codex",
  });
  assert.equal(cleanModel.statusCode, 201);

  const updatedModel = await json(app, "PATCH", `/api/models/${cleanModel.body.data.id}`, {
    name: "Updated Unknown Model",
    defaultRuntimeTargetId: "ignored",
  });
  assert.equal(updatedModel.statusCode, 400);

  const modelIdPatch = await json(app, "PATCH", `/api/models/${cleanModel.body.data.id}`, {
    id: "model_patch_id",
  });
  assert.equal(modelIdPatch.statusCode, 400);

  const modelNamePatch = await json(app, "PATCH", `/api/models/${cleanModel.body.data.id}`, {
    name: "Renamed Model",
  });
  assert.equal(modelNamePatch.statusCode, 200);
  assert.equal(modelNamePatch.body.data.name, "Renamed Model");

  const image = await json(app, "POST", "/api/images", {
    name: "Unknown Image",
    reference: "task-handoff-unknown:latest",
    defaultRuntimeTargetId: "ignored",
  });
  assert.equal(image.statusCode, 400);

  const cleanImage = await json(app, "POST", "/api/images", {
    name: "Unknown Image",
    reference: "task-handoff-unknown:latest",
  });
  assert.equal(cleanImage.statusCode, 201);

  const updatedImage = await json(app, "PATCH", `/api/images/${cleanImage.body.data.id}`, {
    name: "Updated Unknown Image",
    defaultRuntimeTargetId: "ignored",
  });
  assert.equal(updatedImage.statusCode, 400);

  const imageIdPatch = await json(app, "PATCH", `/api/images/${cleanImage.body.data.id}`, {
    id: "image_patch_id",
  });
  assert.equal(imageIdPatch.statusCode, 400);

  const imageNamePatch = await json(app, "PATCH", `/api/images/${cleanImage.body.data.id}`, {
    name: "Renamed Image",
  });
  assert.equal(imageNamePatch.statusCode, 200);
  assert.equal(imageNamePatch.body.data.name, "Renamed Image");

  const node = await json(app, "POST", "/api/nodes", {
    id: "node_unknown_fields",
    name: "Unknown Fields Node",
    connectionMode: "reverse-wss",
    auth: {
      mode: "paired-hmac",
      keyId: "key_agent",
      secret: "agent-secret",
    },
    defaultRuntimeTargetId: "ignored",
  });
  assert.equal(node.statusCode, 400);

  const cleanNode = await json(app, "POST", "/api/nodes", {
    id: "node_unknown_fields",
    name: "Unknown Fields Node",
    connectionMode: "reverse-wss",
    auth: {
      mode: "paired-hmac",
      keyId: "key_agent",
      secret: "agent-secret",
    },
  });
  assert.equal(cleanNode.statusCode, 201);

  const updatedNode = await json(app, "PATCH", "/api/nodes/node_unknown_fields", {
    name: "Updated Unknown Fields Node",
    defaultRuntimeTargetId: "ignored",
  });
  assert.equal(updatedNode.statusCode, 400);

  const joinTokenNodePatch = await json(app, "PATCH", "/api/nodes/node_unknown_fields", {
    joinToken: "create-only-token",
  });
  assert.equal(joinTokenNodePatch.statusCode, 400);

  const bridge = await json(app, "POST", "/api/chat-gateway/bridges", {
    channel: "web",
    enabled: true,
    defaultRuntimeTargetId: "ignored",
  });
  assert.equal(bridge.statusCode, 400);
});

test("control plane renames offline nodes with strict validation and preserves node configuration", async (t) => {
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-node-rename-offline"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: createMockNodeAgentFetch().fetchImpl,
    },
  });
  t.after(() => app.close());

  const created = await json(app, "POST", "/api/nodes", {
    id: "node_offline_rename",
    name: "Offline original",
    connectionMode: "reverse-wss",
    auth: {
      mode: "paired-hmac",
      keyId: "key_offline_rename",
      secret: "offline-rename-secret",
      pairedAt: "2026-07-13T00:00:00.000Z",
      pairing: { status: "paired" },
    },
    status: "offline",
    health: "failed",
    capabilities: { inventory: true },
    labels: { zone: "west" },
    lastSeenAt: "2026-07-12T23:59:00.000Z",
  });
  assert.equal(created.statusCode, 201);

  const renamed = await json(app, "PATCH", "/api/nodes/node_offline_rename", {
    name: "  Offline renamed  ",
  });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.body.data.id, "node_offline_rename");
  assert.equal(renamed.body.data.name, "Offline renamed");
  const { name: _createdName, updatedAt: _createdUpdatedAt, ...createdInvariant } = created.body.data;
  const { name: _renamedName, updatedAt: _renamedUpdatedAt, ...renamedInvariant } = renamed.body.data;
  assert.deepEqual(renamedInvariant, createdInvariant);

  const persisted = await json(app, "GET", "/api/nodes/node_offline_rename");
  assert.equal(persisted.statusCode, 200);
  assert.equal(persisted.body.data.name, "Offline renamed");

  const blank = await json(app, "PATCH", "/api/nodes/node_offline_rename", { name: "   " });
  assert.equal(blank.statusCode, 400);
  const tooLong = await json(app, "PATCH", "/api/nodes/node_offline_rename", { name: "n".repeat(161) });
  assert.equal(tooLong.statusCode, 400);
  const unknownField = await json(app, "PATCH", "/api/nodes/node_offline_rename", {
    name: "Should not save",
    displayName: "not-supported",
  });
  assert.equal(unknownField.statusCode, 400);

  const afterRejectedUpdates = await json(app, "GET", "/api/nodes/node_offline_rename");
  assert.equal(afterRejectedUpdates.body.data.name, "Offline renamed");
});

test("control plane preserves a renamed built-in node across sync and instance projections", async (t) => {
  const mock = createMockNodeAgentFetch();
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-node-rename-builtin"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());

  const before = await json(app, "GET", "/api/nodes/node_mock");
  assert.equal(before.statusCode, 200);
  assert.equal(before.body.data.labels["task-handoff.control-plane.builtin"], "true");

  const project = await json(app, "POST", "/api/projects", {
    name: "Renamed node project",
    source: { type: "local-folder", path: "/tmp/renamed-node-project" },
  });
  assert.equal(project.statusCode, 201);
  const instance = await json(app, "POST", "/api/controlled-instances", {
    name: "renamed-node-instance",
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
  });
  assert.equal(instance.statusCode, 201);
  assert.equal(instance.body.data.nodeId, "node_mock");

  const renamed = await json(app, "PATCH", "/api/nodes/node_mock", { name: "  Local build host  " });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.body.data.name, "Local build host");
  const { name: _beforeName, updatedAt: _beforeUpdatedAt, ...beforeInvariant } = before.body.data;
  const { name: _afterName, updatedAt: _afterUpdatedAt, ...afterInvariant } = renamed.body.data;
  assert.deepEqual(afterInvariant, beforeInvariant);

  const synced = await json(app, "POST", "/api/nodes/local/sync");
  assert.equal(synced.statusCode, 200);
  assert.equal(synced.body.data.id, "node_mock");
  assert.equal(synced.body.data.name, "Local build host");

  const board = await json(app, "GET", "/api/instance-board");
  assert.equal(board.statusCode, 200);
  const boardItem = board.body.data.find((item) => item.id === instance.body.data.id);
  assert.ok(boardItem);
  assert.equal(boardItem.nodeId, "node_mock");
  assert.equal(boardItem.node.name, "Local build host");

  const persistedInstance = await json(app, "GET", `/api/controlled-instances/${instance.body.data.id}`);
  assert.equal(persistedInstance.statusCode, 200);
  assert.equal(persistedInstance.body.data.nodeId, "node_mock");
});

test("control plane proxies instance websocket routes while preserving HTTP proxy routes", async (t) => {
  const nodeAgentProxy = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
  const upstreamSockets = new Set();
  t.after(() => {
    for (const socket of upstreamSockets) socket.terminate();
    return new Promise((resolve) => nodeAgentProxy.close(resolve));
  });
  await withTimeout(new Promise((resolve) => nodeAgentProxy.once("listening", resolve)), "node-agent websocket proxy listening");
  const nodeAgentAddress = nodeAgentProxy.address();
  assert.equal(typeof nodeAgentAddress, "object");
  const nodeAgentEndpoint = `http://127.0.0.1:${nodeAgentAddress.port}`;
  const seen = [];
  nodeAgentProxy.on("connection", (socket, request) => {
    upstreamSockets.add(socket);
    socket.on("close", () => upstreamSockets.delete(socket));
    seen.push({
      url: request.url,
      protocol: request.headers["sec-websocket-protocol"] || "",
    });
    socket.send(request.url?.includes("websockify") ? Buffer.from("RFB 003.008\n") : "ready");
    socket.on("message", (message) => socket.send(`echo:${message}`));
  });

  const mock = createMockNodeAgentFetch({
    proxy: ({ body, jsonResponse }) =>
      body.path === "/"
        ? jsonResponse({
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
            bodyBase64: Buffer.from("<!doctype html><html><head><title>Instance</title></head><body><div id=\"app\"></div></body></html>").toString("base64"),
          })
        : body.path.startsWith("/api/apps/sessions/app_1/web/")
          ? jsonResponse({
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" },
              bodyBase64: Buffer.from("<!doctype html><html><head><title>App</title></head><body><script src=\"./app.js\"></script></body></html>").toString("base64"),
            })
        : jsonResponse({
            status: 200,
            headers: { "content-type": "text/plain" },
            bodyBase64: Buffer.from(`proxied:${body.path}`).toString("base64"),
          }),
  });
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-instance-ws-proxy"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());

  const nodes = await json(app, "GET", "/api/nodes");
  assert.equal(nodes.statusCode, 200);
  const localNode = nodes.body.data.find((node) => node.id === "node_mock");
  assert.ok(localNode);
  assert.equal(localNode.status, "online");
  assert.equal(localNode.health, "ok");
  const updatedNode = await json(app, "PATCH", "/api/nodes/node_mock", {
    endpoint: nodeAgentEndpoint,
    controlEndpoint: nodeAgentEndpoint,
  });
  assert.equal(updatedNode.statusCode, 200);

  const project = await json(app, "POST", "/api/projects", {
    name: "WebSocket Proxy Project",
    source: {
      type: "local-folder",
      path: "/tmp/workspace",
    },
  });
  assert.equal(project.statusCode, 201);

  const createdInstance = await json(app, "POST", "/api/controlled-instances", {
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
  });
  assert.equal(createdInstance.statusCode, 201);

  const registeredResponse = await mock.fetchImpl(`http://127.0.0.1:8091/api/node-agent/instances/${createdInstance.body.data.id}/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${createdInstance.body.data.registrationToken}`,
    },
    body: JSON.stringify({
      instanceId: createdInstance.body.data.id,
      projectId: project.body.data.id,
      instanceVersion: runtimeVersionStateForActual().desiredVersion,
      protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
      controlMode: "controlled",
      capabilities: { features: { appRuntime: true } },
      appInventory: testAppInventory([{ id: "terminal-tty", name: "Terminal" }]),
      target: {
        strategy: "direct-port",
        web: "http://controlled.internal:8080",
        api: "http://controlled.internal:8080/api",
        status: "reachable",
      },
      workspace: {
        mode: "local-bind",
        status: "ready",
        path: "/workspace",
      },
    }),
  });
  assert.equal(registeredResponse.status, 201);

  await withTimeout(app.listen({ host: "127.0.0.1", port: 0 }), "control plane listen");
  const address = app.server.address();
  assert.equal(typeof address, "object");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/instances/${createdInstance.body.data.id}/api/apps/sessions/app_1/tty?token=abc`);
  t.after(() => client.terminate());
  const readyFrame = onceWebSocketMessageFrame(client);
  await withTimeout(waitForWebSocketOpen(client), "proxied websocket open");
  assert.deepEqual(await withTimeout(readyFrame, "proxied websocket ready"), { message: "ready", isBinary: false });
  client.send("hello");
  assert.deepEqual(await withTimeout(onceWebSocketMessageFrame(client), "proxied websocket echo"), { message: "echo:hello", isBinary: false });
  const binaryClient = new WebSocket(`ws://127.0.0.1:${address.port}/instances/${createdInstance.body.data.id}/api/apps/sessions/app_1/web/websockify`, ["binary"]);
  t.after(() => binaryClient.terminate());
  const binaryGreeting = onceWebSocketMessageFrame(binaryClient);
  await withTimeout(waitForWebSocketOpen(binaryClient), "proxied websocket binary open");
  assert.equal(binaryClient.protocol, "binary");
  assert.deepEqual(await withTimeout(binaryGreeting, "proxied websocket binary greeting"), { message: "RFB 003.008\n", isBinary: true });
  assert.deepEqual(seen.filter((entry) => entry.url !== "/api/node-agent/events"), [
    {
      url: `/api/node-agent/instances/${createdInstance.body.data.id}/proxy/ws/api/apps/sessions/app_1/tty?token=abc`,
      protocol: "",
    },
    {
      url: `/api/node-agent/instances/${createdInstance.body.data.id}/proxy/ws/api/apps/sessions/app_1/web/websockify`,
      protocol: "binary",
    },
  ]);

  const rootRedirect = await app.inject({
    method: "GET",
    url: `/instances/${createdInstance.body.data.id}`,
  });
  assert.equal(rootRedirect.statusCode, 302);
  assert.equal(rootRedirect.headers.location, `/instances/${createdInstance.body.data.id}/`);

  const proxiedRoot = await app.inject({
    method: "GET",
    url: `/instances/${createdInstance.body.data.id}/`,
  });
  assert.equal(proxiedRoot.statusCode, 200);
  assert.match(proxiedRoot.body, new RegExp(`window\\.__TASK_HANDOFF_PUBLIC_BASE__="/instances/${createdInstance.body.data.id}"`));
  assert.doesNotMatch(proxiedRoot.body, /<base href=/);

  const proxied = await app.inject({
    method: "GET",
    url: `/instances/${createdInstance.body.data.id}/api/apps/sessions/app_1/web/index.html?theme=dark`,
    headers: {
      cookie: "task_handoff_cp_session=control-plane-session; instance_session=instance-session",
      authorization: "Bearer control-plane-credential",
      "x-instance-client": "forward-me",
    },
  });
  assert.equal(proxied.statusCode, 200);
  assert.equal(proxied.headers["content-encoding"], undefined);
  assert.equal(proxied.body, "<!doctype html><html><head><title>App</title></head><body><script src=\"./app.js\"></script></body></html>");
  assert.doesNotMatch(proxied.body, /__TASK_HANDOFF_PUBLIC_BASE__/);
  assert.doesNotMatch(proxied.body, /<base href=/);
  const proxiedPageRequest = mock.requests.find((request) =>
    request.path.endsWith("/proxy/stream") &&
    request.body?.path === "/api/apps/sessions/app_1/web/index.html?theme=dark"
  );
  assert.equal(proxiedPageRequest.body.headers.cookie, "instance_session=instance-session");
  assert.equal(proxiedPageRequest.body.headers.authorization, undefined);
  assert.equal(proxiedPageRequest.body.headers["x-instance-client"], "forward-me");

  const uploaded = await app.inject({
    method: "POST",
    url: `/instances/${createdInstance.body.data.id}/api/upload`,
    headers: {
      "content-type": "application/octet-stream",
    },
    payload: Buffer.from([0, 1, 2, 255]),
  });
  assert.equal(uploaded.statusCode, 200);
  const uploadProxyRequest = mock.requests.find((request) =>
    request.path.endsWith("/proxy/stream") &&
    request.body?.path === "/api/upload"
  );
  assert.deepEqual(uploadProxyRequest.body, {
    path: "/api/upload",
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      host: "localhost:80",
      "user-agent": "lightMyRequest",
    },
    bodyBase64: Buffer.from([0, 1, 2, 255]).toString("base64"),
  });

  const urlencoded = await app.inject({
    method: "POST",
    url: `/instances/${createdInstance.body.data.id}/api/form`,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: new URLSearchParams([[
      "alpha",
      "1",
    ], [
      "beta",
      "two words",
    ]]).toString(),
  });
  assert.equal(urlencoded.statusCode, 200);
  const formProxyRequest = mock.requests.find((request) =>
    request.path.endsWith("/proxy/stream") &&
    request.body?.path === "/api/form"
  );
  assert.deepEqual(formProxyRequest.body, {
    path: "/api/form",
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      host: "localhost:80",
      "user-agent": "lightMyRequest",
    },
    bodyBase64: Buffer.from("alpha=1&beta=two+words").toString("base64"),
  });
});

test("control plane generated instance names use a short id suffix", async (t) => {
  const mock = createMockNodeAgentFetch();
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-generated-name"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());

  const project = await json(app, "POST", "/api/projects", {
    name: "Generated Name Project",
    source: {
      type: "local-folder",
      path: "/tmp/workspace",
    },
  });
  assert.equal(project.statusCode, 201);

  const created = await json(app, "POST", "/api/controlled-instances", {
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.data.name, `instance-${created.body.data.id.replace(/^inst_?/, "").slice(0, 6)}`);
});

test("control plane starts, stops, and restarts instances through runtime executors", async (t) => {
  const mock = createMockNodeAgentFetch();
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-lifecycle"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());

  const project = await json(app, "POST", "/api/projects", {
    name: "Git Project",
    source: {
      type: "git-repository",
      url: "https://github.com/example/repo.git",
    },
  });
  assert.equal(project.statusCode, 201);

  const created = await json(app, "POST", "/api/controlled-instances", {
    name: "git-1",
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
  });
  assert.equal(created.statusCode, 201);

  const started = await json(app, "POST", `/api/controlled-instances/${created.body.data.id}/start`);
  assert.equal(started.statusCode, 200);
  assert.equal(started.body.data.status, "registering");
  assert.equal(started.body.data.connectionStatus, "online");
  assert.equal(started.body.data.target, undefined);
  assert.equal(started.body.data.targetStatus, undefined);
  assert.equal(started.body.data.agentStatus, undefined);
  assert.equal(started.body.data.access.web, `/instances/${created.body.data.id}/`);
  assert.equal(started.body.data.runtime.containerName, `task-handoff-${created.body.data.id}`);
  assert.equal(started.body.data.runtime.containerId, `container-${created.body.data.id}`);
  assert.equal(started.body.data.registrationToken, undefined);

  const stopped = await json(app, "POST", `/api/controlled-instances/${created.body.data.id}/stop`);
  assert.equal(stopped.statusCode, 200);
  assert.equal(stopped.body.data.status, "stopped");
  assert.equal(stopped.body.data.connectionStatus, "offline");

  const restarted = await json(app, "POST", `/api/controlled-instances/${created.body.data.id}/restart`);
  assert.equal(restarted.statusCode, 200);
  assert.equal(restarted.body.data.status, "registering");

  const deleted = await json(app, "DELETE", `/api/controlled-instances/${created.body.data.id}`);
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.body.data.deleted, true);
  const afterDelete = await json(app, "GET", "/api/controlled-instances");
  assert.equal(afterDelete.statusCode, 200);
  assert.equal(afterDelete.body.data.length, 0);

  assert.deepEqual(
    mock.requests
      .filter((request) => request.path.startsWith(`/instances/${created.body.data.id}/`))
      .map((request) => request.path.split("/").at(-1))
      .filter((action) => ["start", "stop", "restart", "delete"].includes(action)),
    ["start", "stop", "restart", "delete"],
  );
});

test("control plane lists local Docker images for image management", async (t) => {
  const mock = createMockNodeAgentFetch({
    dockerImages: [
      {
        repository: "task-handoff-web",
        tag: "local",
        id: "sha256:abc123",
        createdSince: "2 hours ago",
        size: "1.2GB",
        reference: "task-handoff-web:local",
      },
      {
        repository: "<none>",
        tag: "<none>",
        id: "sha256:def456",
        createdSince: "3 days ago",
        size: "900MB",
        reference: "sha256:def456",
      },
    ],
  });
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-local-images"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());

  const nodes = await json(app, "GET", "/api/nodes");
  const images = await json(app, "GET", `/api/nodes/${nodes.body.data[0].id}/docker/images`);
  assert.equal(images.statusCode, 200);
  assert.deepEqual(mock.requests.map((request) => [request.method, request.url]), [
    ["GET", "http://127.0.0.1:8091/api/node-agent/health"],
    ["GET", "http://127.0.0.1:8091/api/node-agent/docker/images"],
  ]);
  assert.equal(images.body.data[0].reference, "task-handoff-web:local");
  assert.equal(images.body.data[0].size, "1.2GB");
  assert.equal(images.body.data[1].reference, "sha256:def456");
});

test("control plane launches app sessions through the controlled instance API", async (t) => {
  const appSessionsById = new Map();
  let appSessionRevision = 0;
  let malformedConfigSyncResponse = false;
  const appSessionPayload = (status = "running", title = "Claude") => ({
    id: "app_1",
    appId: "claude",
    title,
    kind: "tty",
    status,
    bindings: [
      { type: "app-session", id: "app_1" },
      { type: "adapter-key", adapter: "claude", agent: "claude", id: "short:ac8eaf94", key: "short:ac8eaf94" },
    ],
    workspace: {
      cwd: "/workspace/demo",
    },
    tty: {
      webPath: "/api/apps/sessions/app_1/tty",
      shell: "claude",
      cwd: "/workspace/demo",
      mode: "claude-attach",
    },
    ai: {
      agent: "claude",
      claude: {
        short: "ac8eaf94",
        controlSock: "/tmp/control.sock",
        cwd: "/workspace/demo",
      },
    },
  });
  const mock = createMockNodeAgentFetch({
    proxy: ({ body, jsonResponse }) => {
      if (body.path === "/api/config-sync/programs") {
        return jsonResponse([
          { id: "codex", label: "Codex", directoryName: "codex" },
          { id: "claude", label: "Claude", directoryName: "claude" },
          { id: "browser", label: "Browser", directoryName: "browser" },
        ]);
      }
      if (body.path === "/api/config-sync" && body.method === "POST") {
        if (malformedConfigSyncResponse) return jsonResponse({ accepted: true });
        const request = JSON.parse(body.body);
        return jsonResponse({
          direction: request.direction,
          workspaceFolder: request.workspaceFolder,
          programs: request.programIds.map((programId) => ({
            preset: { id: programId, label: programId, projectRoot: `${request.workspaceFolder}/${programId}` },
            direction: request.direction,
            items: [],
          })),
        });
      }
      if (body.path === "/api/apps/sessions/state") {
        const updatedAt = new Date().toISOString();
        const sessions = [...appSessionsById.values()];
        return jsonResponse({ streamId: "app_launch_stream", revision: appSessionRevision, lastEventAt: updatedAt, snapshot: { runningCount: sessions.filter((session) => session.status === "running").length, problemCount: 0, sessions, updatedAt } });
      }
      if (body.path === "/api/apps/sessions" && body.method === "GET") {
        return jsonResponse([...appSessionsById.values()]);
      }
      if (body.path === "/api/apps/sessions/app_1" && body.method === "PATCH") {
        const current = appSessionsById.get("app_1") || appSessionPayload();
        const session = { ...current, title: JSON.parse(body.body).title };
        appSessionsById.set(session.id, session);
        appSessionRevision += 1;
        return jsonResponse(session);
      }
      if (body.path !== "/api/apps/sessions" && !body.path.endsWith("/stop")) {
        return jsonResponse({ accepted: true });
      }
      const existing = appSessionsById.get("app_1");
      const session = appSessionPayload(body.path.endsWith("/stop") ? "stopped" : "running", existing?.title || "Claude");
      appSessionsById.set(session.id, session);
      appSessionRevision += 1;
      return jsonResponse(session);
    },
  });
  const dataDir = tempDataDir("control-plane-app-session");
  const app = await createControlPlaneApp({
    dataDir,
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.equal(typeof address, "object");
  const eventsSocket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events`);
  t.after(() => eventsSocket.terminate());
  const connectedMessage = withTimeout(onceWebSocketMessageFrame(eventsSocket), "app session events connected");
  await withTimeout(waitForWebSocketOpen(eventsSocket), "app session events websocket open");
  assert.equal(JSON.parse((await connectedMessage).message).type, "streams.hello");

  const project = await json(app, "POST", "/api/projects", {
    name: "App Project",
    source: {
      type: "local-folder",
      path: "/tmp/workspace",
    },
  });
  assert.equal(project.statusCode, 201);

  const created = await json(app, "POST", "/api/controlled-instances", {
    name: "app-worker",
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
  });
  assert.equal(created.statusCode, 201);

  await mock.fetchImpl(`http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${created.body.data.registrationToken}` },
    body: JSON.stringify({
      instanceId: created.body.data.id,
      projectId: project.body.data.id,
      target: {
        strategy: "direct-port",
        web: "http://127.0.0.1:18082",
        api: "http://127.0.0.1:18082/api",
        status: "endpoint-unreachable",
      },
      workspace: {
        status: "ready",
      },
      capabilities: { features: { appRuntime: true } },
      appInventory: testAppInventory([
        { id: "codex", name: "Codex" },
        { id: "claude", name: "Claude" },
      ]),
    }),
  });

  const registered = await json(app, "GET", `/api/controlled-instances/${created.body.data.id}`);
  assert.equal(registered.statusCode, 200);
  assert.equal(registered.body.data.connectionStatus, "online");
  assert.equal(registered.body.data.targetStatus, undefined);
  assert.equal(registered.body.data.target, undefined);
  assert.equal(registered.body.data.access.status, "reachable");
  const heartbeatRequestsBeforeLaunch = mock.requests.filter((request) => request.path.endsWith("/heartbeat")).length;

  const launched = await json(app, "POST", `/api/controlled-instances/${created.body.data.id}/apps/sessions`, {
    appId: "claude",
    options: {
      cwd: "/workspace/demo",
      env: {
        DEMO: "1",
      },
      display: {
        width: 1280,
        height: 720,
      },
    },
  });
  assert.equal(launched.statusCode, 200);
  assert.equal(launched.body.data.id, "app_1");
  const launchEvent = JSON.parse((await withTimeout(onceWebSocketMessageFrame(eventsSocket), "app session created event")).message);
  assert.equal(launchEvent.type, "instance.app-session.launched");
  assert.equal(launchEvent.payload.instanceId, created.body.data.id);
  assert.equal(launchEvent.payload.sessionId, "app_1");
  assert.equal(launchEvent.payload.appId, "claude");
  const appSessionsAfterLaunch = await json(app, "GET", "/api/app-sessions");
  assert.equal(appSessionsAfterLaunch.statusCode, 200);
  assert.equal(appSessionsAfterLaunch.body.data.instances[0].instanceId, created.body.data.id);
  assert.equal(appSessionsAfterLaunch.body.data.instances[0].appSessions.runningCount, 1);
  assert.deepEqual(appSessionsAfterLaunch.body.data.instances[0].appSessions.sessions, [
    appSessionPayload("running"),
  ]);
  const boardAfterLaunch = await json(app, "GET", "/api/instance-board");
  assert.equal(boardAfterLaunch.statusCode, 200);
  assert.equal(boardAfterLaunch.body.data[0].status, "registered");
  assert.equal(boardAfterLaunch.body.data[0].connectionStatus, "online");
  assert.equal(boardAfterLaunch.body.data[0].workspace.status, "ready");
  assert.equal(boardAfterLaunch.body.data[0].apps.runningCount, 0);
  assert.equal("sessions" in boardAfterLaunch.body.data[0].apps, false);
  const heartbeatRequestsAfterLaunch = mock.requests.filter((request) => request.path.endsWith("/heartbeat"));
  assert.equal(heartbeatRequestsAfterLaunch.length, heartbeatRequestsBeforeLaunch);
  const proxyRequests = mock.requests.filter((request) => request.path.endsWith("/proxy") && request.body?.path === "/api/apps/sessions" && request.body?.method === "POST");
  assert.deepEqual(proxyRequests.map(({ url, method, body }) => ({ url, method, body })), [
    {
      url: `http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/proxy`,
      method: "POST",
      body: {
        path: "/api/apps/sessions",
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          appId: "claude",
          cwd: "/workspace/demo",
          env: {
            DEMO: "1",
          },
          display: {
            width: 1280,
            height: 720,
          },
        }),
      },
    },
  ]);

  const renamed = await json(app, "PATCH", `/api/controlled-instances/${created.body.data.id}/apps/sessions/app_1`, {
    title: "Control Claude",
  });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.body.data.title, "Control Claude");
  const renameEvent = JSON.parse((await withTimeout(onceWebSocketMessageFrame(eventsSocket), "app session renamed event")).message);
  assert.equal(renameEvent.type, "instance.app-session.renamed");
  assert.deepEqual(renameEvent.payload, {
    instanceId: created.body.data.id,
    sessionId: "app_1",
    title: "Control Claude",
  });
  const appSessionsAfterRename = await json(app, "GET", "/api/app-sessions");
  assert.equal(appSessionsAfterRename.body.data.instances[0].appSessions.sessions[0].title, "Control Claude");
  const renameProxy = mock.requests.find((request) => request.path.endsWith("/proxy") && request.body?.path === "/api/apps/sessions/app_1" && request.body?.method === "PATCH");
  assert.deepEqual({ url: renameProxy.url, method: renameProxy.method, body: renameProxy.body }, {
    url: `http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/proxy`,
    method: "POST",
    body: {
      path: "/api/apps/sessions/app_1",
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Control Claude" }),
    },
  });

  const stopped = await json(app, "POST", `/api/controlled-instances/${created.body.data.id}/apps/sessions/app_1/stop`);
  assert.equal(stopped.statusCode, 200);
  assert.equal(stopped.body.data.id, "app_1");
  const stopEvent = JSON.parse((await withTimeout(onceWebSocketMessageFrame(eventsSocket), "app session updated event")).message);
  assert.equal(stopEvent.type, "instance.app-session.stopped");
  assert.equal(stopEvent.payload.instanceId, created.body.data.id);
  assert.equal(stopEvent.payload.sessionId, "app_1");
  const appSessionsAfterStop = await json(app, "GET", "/api/app-sessions");
  assert.equal(appSessionsAfterStop.statusCode, 200);
  assert.equal(appSessionsAfterStop.body.data.instances[0].appSessions.runningCount, 0);
  assert.deepEqual(appSessionsAfterStop.body.data.instances[0].appSessions.sessions, []);
  const appSessionTombstonesAfterStop = await json(app, "GET", "/api/app-sessions?includeTombstones=true");
  assert.equal(appSessionTombstonesAfterStop.statusCode, 200);
  assert.equal(appSessionTombstonesAfterStop.body.data.instances[0].appSessions.runningCount, 0);
  assert.deepEqual(appSessionTombstonesAfterStop.body.data.instances[0].appSessions.sessions, [
    appSessionPayload("stopped", "Control Claude"),
  ]);
  const boardAfterStop = await json(app, "GET", "/api/instance-board");
  assert.equal(boardAfterStop.statusCode, 200);
  assert.equal(boardAfterStop.body.data[0].apps.runningCount, 0);
  assert.equal("sessions" in boardAfterStop.body.data[0].apps, false);
  {
    const stopProxy = mock.requests.find((request) => request.path.endsWith("/proxy") && request.body?.path === "/api/apps/sessions/app_1/stop");
    assert.deepEqual({ url: stopProxy.url, method: stopProxy.method, body: stopProxy.body }, {
      url: `http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/proxy`,
      method: "POST",
      body: {
        path: "/api/apps/sessions/app_1/stop",
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    });
  }

  const batchSynced = await json(app, "POST", `/api/controlled-instances/${created.body.data.id}/config-sync`, {
    direction: "export",
    programIds: ["codex", "claude"],
    workspaceFolder: "config-backups",
  });
  assert.equal(batchSynced.statusCode, 200);
  const batchSyncProxy = mock.requests.find((request) => request.path.endsWith("/proxy") && request.body?.path === "/api/config-sync");
  const batchSyncBody = JSON.parse(batchSyncProxy.body.body);
  assert.deepEqual(batchSyncBody, {
    direction: "export",
    programIds: ["codex", "claude"],
    workspaceFolder: "config-backups",
  });
  assert.deepEqual(batchSynced.body.data.programs.map((program) => program.preset.id), ["codex", "claude"]);

  const configSyncState = await json(app, "GET", `/api/controlled-instances/${created.body.data.id}/config-sync`);
  assert.equal(configSyncState.statusCode, 200);
  assert.equal(configSyncState.body.data.preferences.export, "config-backups");
  assert.deepEqual(configSyncState.body.data.programs.map((program) => program.id), ["codex", "claude", "browser"]);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dataDir, "config-sync-preferences", `${created.body.data.id}.json`), "utf8")).preferences.export,
    "config-backups",
  );

  const invalidBatchFolder = await json(app, "POST", `/api/controlled-instances/${created.body.data.id}/config-sync`, {
    direction: "export",
    programIds: ["codex"],
    workspaceFolder: "../../outside",
  });
  assert.equal(invalidBatchFolder.statusCode, 400);
  assert.equal(invalidBatchFolder.body.error.code, "CONFIG_SYNC_FOLDER_INVALID");

  malformedConfigSyncResponse = true;
  const malformedBatch = await json(app, "POST", `/api/controlled-instances/${created.body.data.id}/config-sync`, {
    direction: "export",
    programIds: ["codex"],
    workspaceFolder: ".",
  });
  malformedConfigSyncResponse = false;
  assert.equal(malformedBatch.statusCode, 400);
  assert.equal(malformedBatch.body.error.code, "VALIDATION_ERROR");
  const stateAfterMalformedBatch = await json(app, "GET", `/api/controlled-instances/${created.body.data.id}/config-sync`);
  assert.equal(stateAfterMalformedBatch.body.data.preferences.export, "config-backups");

  const gitProject = await json(app, "POST", "/api/projects", {
    name: "Git App Project",
    source: {
      type: "git-repository",
      url: "https://github.com/example/repo.git",
    },
  });
  assert.equal(gitProject.statusCode, 201);
  const gitInstance = await json(app, "POST", "/api/controlled-instances", {
    name: "git-app-worker",
    projectId: gitProject.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
  });
  assert.equal(gitInstance.statusCode, 201);
  await mock.fetchImpl(`http://127.0.0.1:8091/api/node-agent/instances/${gitInstance.body.data.id}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gitInstance.body.data.registrationToken}` },
    body: JSON.stringify({
      instanceId: gitInstance.body.data.id,
      projectId: gitProject.body.data.id,
      target: {
        strategy: "direct-port",
        web: "http://127.0.0.1:18083",
        api: "http://127.0.0.1:18083/api",
        status: "reachable",
      },
      workspace: {
        status: "ready",
      },
    }),
  });
  const rejectedBatchExport = await json(app, "POST", `/api/controlled-instances/${gitInstance.body.data.id}/config-sync`, {
    direction: "export",
    programIds: ["browser"],
    workspaceFolder: ".",
  });
  assert.equal(rejectedBatchExport.statusCode, 400);
  assert.equal(rejectedBatchExport.body.error.code, "CONFIG_SYNC_EXPORT_REQUIRES_LOCAL_PROJECT");
});

test("control plane app session launch succeeds when board heartbeat sync fails", async (t) => {
  const mock = createMockNodeAgentFetch({
    proxy: ({ jsonResponse }) =>
      jsonResponse({
        id: "app_heartbeat_failure",
        appId: "terminal-tty",
        title: "terminal-tty",
        kind: "tty",
        status: "running",
      }),
    heartbeat: ({ errorResponse }) => errorResponse("heartbeat sync failed", 500),
  });
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-app-session-heartbeat-failure"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());

  const project = await json(app, "POST", "/api/projects", {
    name: "Heartbeat Failure Project",
    source: {
      type: "local-folder",
      path: "/tmp/heartbeat-failure",
    },
  });
  assert.equal(project.statusCode, 201);
  const created = await json(app, "POST", "/api/controlled-instances", {
    name: "heartbeat-worker",
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
  });
  assert.equal(created.statusCode, 201);
  await mock.fetchImpl(`http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${created.body.data.registrationToken}` },
    body: JSON.stringify({
      instanceId: created.body.data.id,
      target: {
        strategy: "direct-port",
        web: "http://127.0.0.1:18083",
        api: "http://127.0.0.1:18083/api",
        status: "reachable",
      },
      workspace: {
        status: "ready",
      },
    }),
  });

  const launched = await json(app, "POST", `/api/controlled-instances/${created.body.data.id}/apps/sessions`, {
    appId: "terminal-tty",
  });
  assert.equal(launched.statusCode, 200);
  assert.equal(launched.body.data.id, "app_heartbeat_failure");
  const board = await json(app, "GET", "/api/instance-board");
  assert.equal(board.statusCode, 200);
  assert.equal(board.body.data[0].apps.runningCount, 0);
  assert.equal("sessions" in board.body.data[0].apps, false);
});

test("control plane rejects local folder projects on non-local runtimes before executor selection", async (t) => {
  const timestamp = new Date().toISOString();
  const mock = createMockNodeAgentFetch({
    nodeId: "node_remote",
    runtimes: [
      {
        id: "runtime_remote",
        nodeId: "node_remote",
        type: "docker",
        name: "Docker",
        status: "unknown",
        accessStrategy: "direct-port",
        capabilities: {},
        labels: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  });
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-reject"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());

  const node = await json(app, "POST", "/api/nodes", {
    id: "node_remote",
    name: "Remote Node",
    connectionMode: "direct-http",
    endpoint: "http://10.0.0.12:8091",
    auth: {
      mode: "paired-hmac",
      keyId: "key_agent",
      secret: "agent-secret",
    },
  });
  assert.equal(node.statusCode, 201);

  const project = await json(app, "POST", "/api/projects", {
    name: "Local Project",
    source: {
      type: "local-folder",
      path: "/tmp/workspace",
      ownerNodeId: "node_other",
    },
    defaultNodeId: "node_remote",
    defaultRuntimeId: "runtime_remote",
  });
  assert.equal(project.statusCode, 201);

  const rejected = await json(app, "POST", "/api/controlled-instances", {
    name: "bad-remote",
    projectId: project.body.data.id,
    nodeId: "node_remote",
    runtimeId: "runtime_remote",
    imageSelection: { imageId: "market_taskhandoff_browser" },
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.body.error.code, "LOCAL_FOLDER_REQUIRES_OWNER_NODE");
});

test("control plane chat gateway binds sessions and forwards messages to active instances", async (t) => {
  const forwarded = [];
  let chatWorkerInstanceId = "";
  const liveAppSessions = [
    { id: "app_codex", appId: "codex", title: "Codex", kind: "tty", status: "running" },
    { id: "app_claude", appId: "claude", title: "Claude", kind: "tty", status: "running" },
    { id: "app_closed", appId: "codex", title: "Closed Codex", kind: "tty", status: "closed" },
  ];
  let liveAppSessionRevision = 1;
  const mock = createMockNodeAgentFetch({
    proxy: ({ url, init, body, jsonResponse }) => {
      forwarded.push({
        url,
        method: init.method,
        body,
      });
      if (body.path === "/api/apps/sessions/state") {
        const sessions = chatWorkerInstanceId && url.includes(`/instances/${chatWorkerInstanceId}/proxy`)
          ? liveAppSessions
          : [{ id: "app_other_claude", appId: "claude", title: "Claude", kind: "tty", status: "running" }];
        const updatedAt = new Date().toISOString();
        const revision = chatWorkerInstanceId && url.includes(`/instances/${chatWorkerInstanceId}/proxy`) ? liveAppSessionRevision : 1;
        return jsonResponse({ streamId: "app_chat_stream", revision, lastEventAt: updatedAt, snapshot: { runningCount: sessions.filter((session) => session.status === "running").length, problemCount: 0, sessions, updatedAt } });
      }
      if (body.path === "/api/ai-sessions/state") {
        const updatedAt = new Date().toISOString();
        const isPrimary = chatWorkerInstanceId && url.includes(`/instances/${chatWorkerInstanceId}/proxy`);
        const sessions = isPrimary
          ? [
              { id: "ais_1", agent: "codex", appSessionId: "app_codex", status: "running", phase: "responding", summary: "Working", startedAt: updatedAt, updatedAt },
              { id: "ais_2", agent: "claude", appSessionId: "app_claude", status: "waiting", phase: "approval", summary: "Needs approval", startedAt: updatedAt, updatedAt },
            ]
          : [{ id: "ais_other", agent: "claude", appSessionId: "app_other_claude", status: "idle", phase: "unknown", summary: "Other project session", startedAt: updatedAt, updatedAt }];
        return jsonResponse({ streamId: "ai_chat_stream", revision: 1, lastEventAt: updatedAt, snapshot: { runningCount: isPrimary ? 1 : 0, waitingCount: isPrimary ? 1 : 0, staleCount: 0, sessions, updatedAt } });
      }
      if (body.path === "/api/apps/sessions" && body.method === "GET") {
        if (chatWorkerInstanceId && url.includes(`/instances/${chatWorkerInstanceId}/proxy`)) {
          return jsonResponse(liveAppSessions);
        }
        return jsonResponse([
          { id: "app_other_claude", appId: "claude", title: "Claude", kind: "tty", status: "running" },
        ]);
      }
      if (body.path === "/api/apps/sessions") {
        const payload = typeof body.body === "string" ? JSON.parse(body.body) : body.body || {};
        const session = {
          id: "app_launched_chromium",
          appId: payload.appId,
          title: "Chromium",
          kind: "web",
          status: "running",
        };
        liveAppSessions.push(session);
        liveAppSessionRevision += 1;
        return jsonResponse(session);
      }
      const aiActionMatch = body.path.match(/^\/api\/ai-sessions\/([^/]+)\/(messages|interrupt)$/);
      if (aiActionMatch) {
        const timestamp = new Date().toISOString();
        return jsonResponse({
          session: {
            id: aiActionMatch[1],
            agent: aiActionMatch[1] === "ais_2" ? "claude" : "codex",
            status: aiActionMatch[2] === "interrupt" ? "idle" : "running",
            phase: "unknown",
            startedAt: timestamp,
            updatedAt: timestamp,
          },
          provider: aiActionMatch[1] === "ais_2" ? "claude" : "codex",
          action: aiActionMatch[2] === "interrupt" ? "interrupt" : "send",
          ...(aiActionMatch[2] === "messages" ? { turnId: "turn_test", providerTurnId: "turn_test" } : {}),
        });
      }
      return jsonResponse({ accepted: true, conversationId: 7, taskId: "task_1" });
    },
  });
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-chat"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());

  const project = await json(app, "POST", "/api/projects", {
    name: "Chat Project",
    source: {
      type: "git-repository",
      url: "https://github.com/example/repo.git",
    },
  });
  assert.equal(project.statusCode, 201);

  const created = await json(app, "POST", "/api/controlled-instances", {
    name: "chat-worker",
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
  });
  assert.equal(created.statusCode, 201);
  chatWorkerInstanceId = created.body.data.id;

  await mock.fetchImpl(`http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${created.body.data.registrationToken}` },
    body: JSON.stringify({
      instanceId: created.body.data.id,
      projectId: project.body.data.id,
      target: {
        strategy: "direct-port",
        web: "http://127.0.0.1:18081",
        api: "http://127.0.0.1:18081/api",
        status: "reachable",
      },
      workspace: {
        status: "ready",
      },
      capabilities: { features: { appRuntime: true } },
      appInventory: testAppInventory([
        { id: "codex", name: "Codex" },
        { id: "claude", name: "Claude" },
      ]),
    }),
  });
  await mock.fetchImpl(`http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${created.body.data.registrationToken}` },
    body: JSON.stringify({
      status: "running",
      health: "ok",
      connectionStatus: "online",
      appInventory: testAppInventory([
        { id: "chromium", name: "Chromium", kind: "web" },
        { id: "terminal-tty", name: "Terminal" },
        { id: "terminal-gui", name: "GUI Terminal", kind: "gui" },
        { id: "vscode", name: "VS Code", kind: "gui" },
      ]),
      apps: {
        runningCount: 2,
      },
      aiSessions: {
        runningCount: 1,
        waitingCount: 0,
        staleCount: 0,
        updatedAt: new Date().toISOString(),
        sessions: [
          {
            id: "ais_1",
            agent: "codex",
            appSessionId: "app_codex",
            status: "running",
            phase: "responding",
            summary: "Working",
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            id: "ais_2",
            agent: "claude",
            appSessionId: "app_claude",
            status: "waiting",
            phase: "approval",
            summary: "Needs approval",
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
      target: {
        status: "reachable",
      },
      workspace: {
        status: "ready",
      },
    }),
  });

  const selected = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:123",
      userId: "user-1",
    },
    message: {
      text: `/use ${project.body.data.id}`,
    },
  });
  assert.equal(selected.statusCode, 200);
  assert.equal(selected.body.data.binding.activeProjectId, project.body.data.id);
  assert.equal(selected.body.data.binding.activeInstanceId, created.body.data.id);
  assert.equal(selected.body.data.binding.activeAiSessionId, undefined);
  assert.match(selected.body.data.reply, /Chat Project \/ chat-worker/);

  const help = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:123",
      userId: "user-1",
    },
    message: {
      text: "/help@TaskHandoffBot",
      attachments: [],
    },
  });
  assert.equal(help.statusCode, 200);
  assert.match(help.body.data.reply, /TaskHandoff chat commands/);
  assert.match(help.body.data.reply, /\/sessions/);
  assert.match(help.body.data.reply, /\/apps/);
  assert.match(help.body.data.reply, /Current target: Chat Project \/ chat-worker \/ none/);

  const sessionList = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:123",
      userId: "user-1",
    },
    message: {
      text: "/session",
      attachments: [],
    },
  });
  assert.equal(sessionList.statusCode, 200);
  assert.match(sessionList.body.data.reply, /Select AI session/);
  assert.match(sessionList.body.data.reply, /1\. Chat Project \/ chat-worker - claude - waiting\/approval - ais_2/);
  assert.match(sessionList.body.data.reply, /2\. Chat Project \/ chat-worker - codex - running\/responding - ais_1/);
  assert.deepEqual(sessionList.body.data.replyMarkup.inline_keyboard.map((row) => row[0].callback_data), [
    "task_handoff:cp_session:0",
    "task_handoff:cp_session:1",
  ]);

  const otherProject = await json(app, "POST", "/api/projects", {
    name: "Other Chat Project",
    source: {
      type: "git-repository",
      url: "https://github.com/example/other.git",
    },
  });
  assert.equal(otherProject.statusCode, 201);

  const otherCreated = await json(app, "POST", "/api/controlled-instances", {
    name: "other-chat-worker",
    projectId: otherProject.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
  });
  assert.equal(otherCreated.statusCode, 201);

  await mock.fetchImpl(`http://127.0.0.1:8091/api/node-agent/instances/${otherCreated.body.data.id}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${otherCreated.body.data.registrationToken}` },
    body: JSON.stringify({
      instanceId: otherCreated.body.data.id,
      projectId: otherProject.body.data.id,
      target: {
        strategy: "direct-port",
        web: "http://127.0.0.1:28081",
        api: "http://127.0.0.1:28081/api",
        status: "reachable",
      },
      workspace: {
        status: "ready",
      },
    }),
  });
  await mock.fetchImpl(`http://127.0.0.1:8091/api/node-agent/instances/${otherCreated.body.data.id}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${otherCreated.body.data.registrationToken}` },
    body: JSON.stringify({
      status: "running",
      health: "ok",
      connectionStatus: "online",
      apps: {
        runningCount: 1,
      },
      aiSessions: {
        runningCount: 0,
        waitingCount: 0,
        staleCount: 0,
        updatedAt: new Date().toISOString(),
        sessions: [
          {
            id: "ais_other",
            agent: "claude",
            appSessionId: "app_other_claude",
            status: "idle",
            phase: "unknown",
            summary: "Other project session",
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
      target: {
        status: "reachable",
      },
      workspace: {
        status: "ready",
      },
    }),
  });

  const refreshedAppSessions = await json(app, "GET", "/api/app-sessions?refresh=true");
  assert.equal(refreshedAppSessions.statusCode, 200);

  const globalSessionList = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:123",
      userId: "user-1",
    },
    message: {
      text: "/sessions",
      attachments: [],
    },
  });
  assert.equal(globalSessionList.statusCode, 200);
  assert.match(globalSessionList.body.data.reply, /Chat Project \/ chat-worker - claude - waiting\/approval - ais_2/);
  assert.match(globalSessionList.body.data.reply, /Other Chat Project \/ other-chat-worker - claude - idle - ais_other/);

  const instanceMenu = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:123",
      userId: "user-1",
    },
    message: {
      text: "/instances",
      attachments: [],
    },
  });
  assert.equal(instanceMenu.statusCode, 200);
  assert.equal(instanceMenu.body.data.reply, "Instances: 1. Tap an instance to create an app.");
  assert.deepEqual(instanceMenu.body.data.replyMarkup.inline_keyboard.map((row) => row[0].text), [
    "chat-worker",
  ]);
  assert.match(instanceMenu.body.data.replyMarkup.inline_keyboard[0][0].callback_data, /^task_handoff:cp_i:/);
  assert.ok(instanceMenu.body.data.replyMarkup.inline_keyboard[0][0].callback_data.length <= 64);

  const appMenu = await json(app, "POST", "/api/chat-gateway/actions", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:123",
      userId: "user-1",
    },
    action: {
      type: "instance-app-menu",
      instanceId: created.body.data.id,
    },
  });
  assert.equal(appMenu.statusCode, 200);
  assert.equal(appMenu.body.data.reply, "New app for chat-worker");
  assert.deepEqual(appMenu.body.data.replyMarkup.inline_keyboard.map((row) => row[0].text), ["Chromium", "Terminal", "GUI Terminal", "VS Code"]);
  assert.match(appMenu.body.data.replyMarkup.inline_keyboard[0][0].callback_data, /^task_handoff:cp_a:/);
  assert.ok(appMenu.body.data.replyMarkup.inline_keyboard[0][0].callback_data.length <= 64);

  const launchedFromMenu = await json(app, "POST", "/api/chat-gateway/actions", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:123",
      userId: "user-1",
    },
    action: {
      type: "launch-app",
      instanceId: created.body.data.id,
      appId: "chromium",
    },
  });
  assert.equal(launchedFromMenu.statusCode, 200);
  assert.equal(launchedFromMenu.body.data.reply, "Launched Chromium on chat-worker.");
  assert.ok(mock.requests.some((request) => {
    const innerBody = typeof request.body?.body === "string" ? JSON.parse(request.body.body) : request.body?.body;
    return request.path === `/instances/${created.body.data.id}/proxy` &&
      request.body?.path === "/api/apps/sessions" &&
      innerBody?.appId === "chromium";
  }));

  const settingsPatch = await json(app, "PATCH", "/api/control-plane/settings", {
    publicBaseUrl: "https://control.example.test",
  });
  assert.equal(settingsPatch.statusCode, 200);
  const appSessionList = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:123",
      userId: "user-1",
    },
    message: {
      text: "/apps",
      attachments: [],
    },
  });
  assert.equal(appSessionList.statusCode, 200);
  assert.equal(appSessionList.body.data.reply, "App sessions: 4. Tap a button to open.");
  assert.ok(appSessionList.body.data.reply.length < 120);
  assert.deepEqual(appSessionList.body.data.replyMarkup.inline_keyboard.map((row) => row[0].text), [
    "chat-worker · Codex",
    "chat-worker · Claude",
    "chat-worker · Chromium",
    "other-chat-worker · Claude",
  ]);
  assert.match(appSessionList.body.data.replyMarkup.inline_keyboard[0][0].url, /^https:\/\/control\.example\.test\/apps\/access\/tty\?token=/);
  assert.equal(appSessionList.body.data.replyMarkup.inline_keyboard[0][0].callback_data, undefined);

  await mock.fetchImpl(`http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${created.body.data.registrationToken}` },
    body: JSON.stringify({
      status: "running",
      health: "ok",
      connectionStatus: "online",
      apps: {
        runningCount: 0,
      },
      aiSessions: {
        runningCount: 1,
        waitingCount: 0,
        staleCount: 0,
        updatedAt: new Date().toISOString(),
        sessions: [
          {
            id: "ais_snapshot_only",
            agent: "claude",
            appSessionId: "app_not_yet_synced",
            status: "idle",
            phase: "unknown",
            summary: "Available from AI session snapshot",
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
      target: {
        status: "reachable",
      },
      workspace: {
        status: "ready",
      },
    }),
  });

  const snapshotOnlySessionList = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:123",
      userId: "user-1",
    },
    message: {
      text: "/sessions",
      attachments: [],
    },
  });
  assert.equal(snapshotOnlySessionList.statusCode, 200);
  assert.match(snapshotOnlySessionList.body.data.reply, /Select AI session/);
  assert.doesNotMatch(snapshotOnlySessionList.body.data.reply, /ais_snapshot_only/);
  assert.match(snapshotOnlySessionList.body.data.reply, /ais_other/);
  assert.deepEqual(snapshotOnlySessionList.body.data.replyMarkup.inline_keyboard.map((row) => row[0].callback_data), [
    "task_handoff:cp_session:0",
    "task_handoff:cp_session:1",
    "task_handoff:cp_session:2",
  ]);

  await mock.fetchImpl(`http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${created.body.data.registrationToken}` },
    body: JSON.stringify({
      status: "running",
      health: "ok",
      connectionStatus: "online",
      apps: {
        runningCount: 2,
      },
      aiSessions: {
        runningCount: 1,
        waitingCount: 0,
        staleCount: 0,
        updatedAt: new Date().toISOString(),
        sessions: [
          {
            id: "ais_1",
            agent: "codex",
            appSessionId: "app_codex",
            status: "running",
            phase: "responding",
            summary: "Working",
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            id: "ais_2",
            agent: "claude",
            appSessionId: "app_claude",
            status: "waiting",
            phase: "approval",
            summary: "Needs approval",
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
      target: {
        status: "reachable",
      },
      workspace: {
        status: "ready",
      },
    }),
  });
  const refreshedActionAppSessions = await json(app, "GET", "/api/app-sessions?refresh=true");
  assert.equal(refreshedActionAppSessions.statusCode, 200);

  const actionSelected = await app.inject({
    method: "POST",
    url: "/api/chat-gateway/messages",
    payload: {
      source: {
        channel: "telegram",
        chatSessionId: "telegram:123",
        userId: "user-1",
      },
      message: {
        text: "/session ais_2",
        attachments: [],
      },
    },
  });
  const parsedActionSelected = JSON.parse(actionSelected.body);
  assert.equal(actionSelected.statusCode, 200);
  assert.equal(parsedActionSelected.data.binding.activeAiSessionId, "ais_2");

  const sent = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:123",
      userId: "user-1",
    },
    message: {
      text: "run tests",
      attachments: [],
    },
  });
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.body.data.routed, true);
  assert.equal(sent.body.data.binding.activeAiSessionId, "ais_2");
  const aiForwardsAfterSent = forwarded.filter((entry) => /^\/api\/ai-sessions\/[^/]+\/(messages|interrupt)$/.test(entry.body.path));
  assert.equal(aiForwardsAfterSent.length, 1);
  assert.equal(aiForwardsAfterSent[0].body.path, "/api/ai-sessions/ais_2/messages");
  assert.equal(aiForwardsAfterSent[0].body.method, "POST");
  assert.deepEqual(JSON.parse(aiForwardsAfterSent[0].body.body), { message: "run tests" });
  assert.equal(forwarded.some((entry) => entry.body.path === "/api/receiver/messages"), false);

  const aiSessionSelected = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:123",
      userId: "user-1",
    },
    message: {
      text: "/session ais_1",
      attachments: [],
    },
  });
  assert.equal(aiSessionSelected.statusCode, 200);
  assert.equal(aiSessionSelected.body.data.binding.activeAiSessionId, "ais_1");

  const aiSent = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:123",
      userId: "user-1",
    },
    message: {
      text: "continue",
      attachments: [],
    },
  });
  assert.equal(aiSent.statusCode, 200);
  assert.equal(aiSent.body.data.routed, true);
  const aiForwardsAfterContinue = forwarded.filter((entry) => /^\/api\/ai-sessions\/[^/]+\/(messages|interrupt)$/.test(entry.body.path));
  assert.equal(aiForwardsAfterContinue.length, 2);
  assert.equal(aiForwardsAfterContinue[1].body.path, "/api/ai-sessions/ais_1/messages");
  assert.equal(aiForwardsAfterContinue[1].body.method, "POST");
  assert.deepEqual(JSON.parse(aiForwardsAfterContinue[1].body.body), { message: "continue", permissionMode: "ask" });

  const interrupted = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:123",
      userId: "user-1",
    },
    message: {
      text: "/cancel",
      attachments: [],
    },
  });
  assert.equal(interrupted.statusCode, 200);
  assert.equal(interrupted.body.data.routed, true);
  const aiForwardsAfterInterrupt = forwarded.filter((entry) => /^\/api\/ai-sessions\/[^/]+\/(messages|interrupt)$/.test(entry.body.path));
  assert.equal(aiForwardsAfterInterrupt.length, 3);
  assert.equal(aiForwardsAfterInterrupt[2].body.path, "/api/ai-sessions/ais_1/interrupt");
  assert.equal(aiForwardsAfterInterrupt[2].body.method, "POST");
  assert.deepEqual(JSON.parse(aiForwardsAfterInterrupt[2].body.body), {});

  const unknown = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:123",
      userId: "user-1",
    },
    message: {
      text: "/wat",
      attachments: [],
    },
  });
  assert.equal(unknown.statusCode, 200);
  assert.match(unknown.body.data.reply, /Try \/help/);

  const sessions = await json(app, "GET", "/api/chat/sessions");
  assert.equal(sessions.statusCode, 200);
  assert.equal(sessions.body.data.length, 1);
  assert.equal(sessions.body.data[0].id, "telegram:telegram:123");
  assert.equal(sessions.body.data[0].activeAiSessionId, "ais_1");
});

test("control plane chat gateway clears stale ai session bindings instead of crashing", async (t) => {
  const forwarded = [];
  const mock = createMockNodeAgentFetch({
    proxy: ({ init, body, jsonResponse, errorResponse }) => {
      forwarded.push({
        method: init.method,
        body,
      });
      if (body.path === "/api/apps/sessions/state") {
        const updatedAt = new Date().toISOString();
        const sessions = [{ id: "app_missing", appId: "codex", kind: "tty", status: "running" }];
        return jsonResponse({ streamId: "app_stale_stream", revision: 1, lastEventAt: updatedAt, snapshot: { runningCount: 1, problemCount: 0, sessions, updatedAt } });
      }
      if (body.path === "/api/ai-sessions/state") {
        const updatedAt = new Date().toISOString();
        const sessions = [{ id: "ais_missing", agent: "codex", appSessionId: "app_missing", status: "running", phase: "responding", summary: "Stale session", startedAt: updatedAt, updatedAt }];
        return jsonResponse({ streamId: "ai_stale_stream", revision: 1, lastEventAt: updatedAt, snapshot: { runningCount: 1, waitingCount: 0, staleCount: 0, sessions, updatedAt } });
      }
      if (body.path === "/api/apps/sessions" && body.method === "GET") {
        return jsonResponse([{ id: "app_missing", appId: "codex", kind: "tty", status: "running" }]);
      }
      if (body.path === "/api/ai-sessions/ais_missing/messages") {
        return errorResponse("AI session not found.", 404, "AI_SESSION_NOT_FOUND");
      }
      return jsonResponse({ accepted: true });
    },
  });
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-chat-stale-ai-session"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());

  const project = await json(app, "POST", "/api/projects", {
    name: "Chat Project",
    source: {
      type: "git-repository",
      url: "https://github.com/example/repo.git",
    },
  });
  assert.equal(project.statusCode, 201);

  const created = await json(app, "POST", "/api/controlled-instances", {
    name: "chat-worker",
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
  });
  assert.equal(created.statusCode, 201);

  await mock.fetchImpl(`http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${created.body.data.registrationToken}` },
    body: JSON.stringify({
      instanceId: created.body.data.id,
      projectId: project.body.data.id,
      target: {
        strategy: "direct-port",
        web: "http://127.0.0.1:18081",
        api: "http://127.0.0.1:18081/api",
        status: "reachable",
      },
      workspace: {
        status: "ready",
      },
    }),
  });
  await mock.fetchImpl(`http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${created.body.data.registrationToken}` },
    body: JSON.stringify({
      status: "running",
      health: "ok",
      connectionStatus: "online",
      apps: {
        runningCount: 1,
      },
      aiSessions: {
        runningCount: 1,
        waitingCount: 0,
        staleCount: 0,
        updatedAt: new Date().toISOString(),
        sessions: [{
          id: "ais_missing",
          agent: "codex",
          appSessionId: "app_missing",
          status: "running",
          phase: "responding",
          summary: "Stale session",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      },
      target: {
        status: "reachable",
      },
      workspace: {
        status: "ready",
      },
    }),
  });

  const selected = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:stale",
      userId: "user-1",
    },
    message: {
      text: `/use ${project.body.data.id}`,
      attachments: [],
    },
  });
  assert.equal(selected.statusCode, 200);
  assert.equal(selected.body.data.binding.activeInstanceId, created.body.data.id);
  assert.equal(selected.body.data.binding.activeAiSessionId, "ais_missing");

  const sessionSelected = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:stale",
      userId: "user-1",
    },
    message: {
      text: "/session ais_missing",
      attachments: [],
    },
  });
  assert.equal(sessionSelected.statusCode, 200);
  assert.equal(sessionSelected.body.data.binding.activeAiSessionId, "ais_missing");

  const sent = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:stale",
      userId: "user-1",
    },
    message: {
      text: "hello",
      attachments: [],
    },
  });
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.body.data.routed, false);
  assert.equal(sent.body.data.binding.activeAiSessionId, undefined);
  assert.match(sent.body.data.reply, /no longer exists/i);
  assert.equal(forwarded.filter((entry) => entry.body.path === "/api/ai-sessions/ais_missing/messages").length, 1);

  const sessions = await json(app, "GET", "/api/chat/sessions");
  assert.equal(sessions.statusCode, 200);
  assert.equal(sessions.body.data[0].activeAiSessionId, undefined);
});

test("control plane chat bridge config patch does not stop an enabled bridge", async (t) => {
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-chat-bridge-enabled-patch"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
  });
  t.after(() => app.close());

  const created = await json(app, "POST", "/api/chat-gateway/bridges", {
    channel: "telegram",
    name: "Telegram",
    token: "telegram-token",
    enabled: true,
  });
  assert.equal(created.statusCode, 200);
  const bridgeId = created.body.data.id;

  const started = await json(app, "POST", `/api/chat-gateway/bridges/${bridgeId}/start`);
  assert.equal(started.statusCode, 200);
  assert.equal(started.body.data.bridges.find((bridge) => bridge.id === bridgeId)?.running, true);

  const patched = await json(app, "PATCH", `/api/chat-gateway/bridges/${bridgeId}`, {
    name: "Telegram renamed",
    pollIntervalMs: 5000,
    settings: { telegramLastUpdateId: 123 },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.body.data.enabled, true);

  const bridges = await json(app, "GET", "/api/chat-gateway/bridges");
  assert.equal(bridges.statusCode, 200);
  assert.equal(bridges.body.data.find((bridge) => bridge.id === bridgeId)?.enabled, true);

  const status = await json(app, "GET", "/api/chat-gateway/status");
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.data.bridges.find((bridge) => bridge.id === bridgeId)?.running, true);
});

test("control plane telegram bridge polls messages and sends replies", async (t) => {
  const calls = [];
  const forwarded = [];
  const mock = createMockNodeAgentFetch();
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-telegram-bridge"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: async (url, init = {}) => {
        if (String(url).includes("/api/node-agent/")) {
          return mock.fetchImpl(url, init);
        }
        calls.push({
          url,
          method: init.method || "GET",
          body: init.body ? JSON.parse(init.body) : undefined,
        });
        if (String(url).includes("getUpdates")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 100,
                  message: {
                    text: "/instances",
                    chat: { id: 123 },
                    from: { id: 456 },
                  },
                },
                {
                  update_id: 101,
                  message: {
                    text: "/instances",
                    chat: { id: 789 },
                    from: { id: 789 },
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (String(url).includes("sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        forwarded.push({ url, init });
        return new Response(JSON.stringify({ data: { accepted: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
  t.after(() => app.close());

  const createdBridge = await json(app, "POST", "/api/chat-gateway/bridges", {
    channel: "telegram",
    name: "Telegram Ops",
  });
  assert.equal(createdBridge.statusCode, 200);

  const patched = await json(app, "PATCH", `/api/chat-gateway/bridges/${createdBridge.body.data.id}`, {
    token: "telegram-token",
    pollIntervalMs: 30000,
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.body.data.token, undefined);
  assert.equal(patched.body.data.tokenSet, true);

  const started = await json(app, "POST", `/api/chat-gateway/bridges/${createdBridge.body.data.id}/start`);
  assert.equal(started.statusCode, 200);
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.ok(calls.some((call) => String(call.url).includes("getUpdates")));
  const sentMessages = calls.filter((call) => String(call.url).includes("sendMessage"));
  assert.equal(sentMessages.length, 1);
  const sent = sentMessages[0];
  assert.ok(sent);
  assert.match(sent.body.text, /No controlled instances/);

  const bridges = await json(app, "GET", "/api/chat-gateway/bridges");
  assert.deepEqual(
    bridges.body.data.find((bridge) => bridge.id === createdBridge.body.data.id)?.allowedUserIds,
    ["456"],
  );

  const stopped = await json(app, "POST", `/api/chat-gateway/bridges/${createdBridge.body.data.id}/stop`);
  assert.equal(stopped.statusCode, 200);
});

test("control plane telegram bridge renders ai session buttons and handles selections", async () => {
  const calls = [];
  const bridge = {
    id: "chat_telegram_test",
    channel: "telegram",
    name: "Telegram Test",
    enabled: true,
    token: "telegram-token",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: ["456"],
    pollIntervalMs: 30000,
    settings: {},
  };
  let aiSessionLastMessage = "";
  let aiSessionStatus = "idle";
  let aiSessionPhase = "unknown";
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    handleChatGatewayMessage: async (message) => {
      calls.push({ type: "message", message });
      if (message.message.text === "hello") {
        return {
          routed: true,
          instance: { id: "inst_1" },
          aiSession: {
            session: {
              id: "ais_2",
              agent: "claude",
              activeTurnId: "turn_1",
              status: "running",
              phase: "responding",
              updatedAt: "2026-07-03T00:00:00.000Z",
            },
            provider: "claude",
            action: "send",
            providerTurnId: "turn_1",
          },
          reply: "Sent to Project / inst / ais_2.",
        };
      }
      return {
        reply: "Select AI session\n1. Project / inst - codex - running - ais_1\n2. Project / inst - claude - waiting - ais_2",
        replyMarkup: {
          inline_keyboard: [
            [{ text: "inst - codex running", callback_data: "task_handoff:cp_session:0" }],
            [{ text: "inst - claude waiting", callback_data: "task_handoff:cp_session:1" }],
          ],
        },
      };
    },
    handleChatGatewayAction: async (input) => {
      calls.push({ type: "action", input });
      if (input.action.type === "pending-decision") {
        return {
          accepted: true,
          message: `${input.action.decision} sent`,
          reply: `${input.action.decision} sent to ${input.action.routeId}.`,
        };
      }
      return {
        message: "selected ais_2",
        reply: "Current chat is bound to AI session ais_2",
        replyMarkup: {
          inline_keyboard: [
            [{ text: "inst - codex running", callback_data: "task_handoff:cp_session:0" }],
            [{ text: "✓ inst - claude waiting", callback_data: "task_handoff:cp_session:1" }],
          ],
        },
      };
    },
    listChatSessions: () => [{
      id: "telegram:123",
      channel: "telegram",
      bridgeId: bridge.id,
      chatSessionId: "123",
      activeInstanceId: "inst_1",
      activeAiSessionId: "ais_2",
    }],
    boardAsync: async () => [{
      id: "inst_1",
      name: "instance-main",
    }],
    listAiSessions: async () => ({
      updatedAt: "2026-07-03T00:00:02.000Z",
      instances: [{
        instanceId: "inst_1",
        aiSessions: {
          runningCount: 0,
          waitingCount: 0,
          staleCount: 0,
          updatedAt: "2026-07-03T00:00:02.000Z",
          sessions: [{
            id: "ais_2",
            agent: "claude",
            status: aiSessionStatus,
            phase: aiSessionPhase,
            lastMessage: aiSessionLastMessage,
            turns: aiSessionTurns,
            updatedAt: aiSessionLastMessage ? "2026-07-03T00:00:03.000Z" : "2026-07-03T00:00:00.000Z",
            startedAt: "2026-07-03T00:00:00.000Z",
          }],
        },
      }],
    }),
    listPendingRoutes: async () => [],
  };
  let pollCount = 0;
  let telegramMessageId = 1000;
  let aiSessionTurns = [];
  const runtime = new ControlPlaneChatGatewayRuntime(service, async (url, init = {}) => {
    calls.push({
      type: "fetch",
      url: String(url),
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    if (String(url).includes("getUpdates")) {
      pollCount += 1;
      return new Response(JSON.stringify({
        ok: true,
        result: pollCount === 1
          ? [{
              update_id: 1,
              message: {
                message_id: 10,
                text: "/session",
                chat: { id: 123 },
                from: { id: 456 },
              },
            }]
          : pollCount === 2
            ? [{
              update_id: 2,
              callback_query: {
                id: "callback-1",
                data: "task_handoff:cp_session:1",
                from: { id: 456 },
                message: {
                  message_id: 10,
                  chat: { id: 123 },
                },
              },
            }]
            : pollCount === 3
              ? [{
                  update_id: 3,
                  message: {
                    message_id: 12,
                    text: "hello",
                    chat: { id: 123 },
                    from: { id: 456 },
                  },
                }]
              : [{
                update_id: 4,
                callback_query: {
                  id: "callback-2",
                  data: "task_handoff:approval:inst_1:ai:ais_2:allow",
                  from: { id: 456 },
                  message: {
                    message_id: telegramMessageId,
                    chat: { id: 123 },
                  },
                },
              }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("sendMessage")) {
      telegramMessageId += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: telegramMessageId } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await runtime.pollBridgeNow(bridge.id);
  const sent = calls.find((call) => call.type === "fetch" && call.url.includes("sendMessage"));
  assert.ok(sent);
  assert.equal(sent.body.chat_id, "123");
  assert.match(sent.body.text, /Select AI session/);
  assert.equal(sent.body.parse_mode, "MarkdownV2");
  assert.equal(sent.body.disable_web_page_preview, true);
  assert.equal(sent.body.reply_markup.inline_keyboard[1][0].callback_data, "task_handoff:cp_session:1");

  await runtime.pollBridgeNow(bridge.id);
  const action = calls.find((call) => call.type === "action");
  assert.equal(action.input.source.chatSessionId, "123");
  assert.equal(action.input.source.userId, "456");
  assert.deepEqual(action.input.action, { type: "ai-session", index: 1 });
  const answered = calls.find((call) => call.type === "fetch" && call.url.includes("answerCallbackQuery"));
  assert.equal(answered.body.callback_query_id, "callback-1");
  const edited = calls.find((call) => call.type === "fetch" && call.url.includes("editMessageText"));
  assert.equal(edited.body.message_id, 10);
  assert.match(edited.body.text, /bound to AI session ais\\_2/);
  assert.equal(edited.body.parse_mode, "MarkdownV2");
  assert.match(edited.body.reply_markup.inline_keyboard[1][0].text, /claude waiting/);
  const sendCountAfterSelection = calls.filter((call) => call.type === "fetch" && call.url.includes("sendMessage")).length;
  await runtime.pollAiSessionsNow();
  assert.equal(calls.filter((call) => call.type === "fetch" && call.url.includes("sendMessage")).length, sendCountAfterSelection);

  await runtime.pollBridgeNow(bridge.id);
  await waitTelegramAggregate();
  const sentAck = calls.filter((call) => call.type === "fetch" && call.url.includes("sendMessage")).at(-1);
  assert.equal(sentAck.body.reply_to_message_id, 12);
  assert.match(sentAck.body.text, /Sent to Project/);
  assert.equal(sentAck.body.parse_mode, "MarkdownV2");
  const sentAckMessageId = telegramMessageId;

  aiSessionTurns = [{
    id: "turn_1",
    userPrompt: "hello",
    updatedAt: "2026-07-03T00:00:02.500Z",
  }];
  aiSessionStatus = "running";
  aiSessionPhase = "thinking";
  await runtime.pollAiSessionsNow();
  assert.equal(calls.filter((call) => call.type === "fetch" && call.url.includes("editMessageText")).length, 1);

  aiSessionLastMessage = "你好。需要我在 /Users/example/project/work 里处理哪个项目？";
  aiSessionTurns = [{
    id: "turn_1",
    providerTurnId: "claude_transcript_turn_1",
    userPrompt: "hello",
    lastMessage: aiSessionLastMessage,
    updatedAt: "2026-07-03T00:00:03.000Z",
  }];
  aiSessionStatus = "running";
  aiSessionPhase = "responding";
  await runtime.pollAiSessionsNow();
  await waitTelegramAggregate();
  const runningReply = calls.filter((call) => call.type === "fetch" && call.url.includes("editMessageText")).at(-1);
  assert.equal(runningReply.body.message_id, sentAckMessageId);
  assert.match(runningReply.body.text, /需要我在/);
  assert.equal(calls.filter((call) => call.type === "fetch" && call.url.includes("sendMessage")).length, sendCountAfterSelection + 1);

  aiSessionStatus = "idle";
  aiSessionPhase = "unknown";
  await runtime.pollAiSessionsNow();
  await waitTelegramAggregate();
  const aiReply = calls.filter((call) => call.type === "fetch" && call.url.includes("editMessageText")).at(-1);
  assert.equal(aiReply.body.message_id, sentAckMessageId);
  assert.match(aiReply.body.text, /^\*instance\\-main · claude idle\*/);
  assert.match(aiReply.body.text, /需要我在/);
  const sendCountAfterAiReply = calls.filter((call) => call.type === "fetch" && call.url.includes("sendMessage")).length;
  const editCountAfterAiReply = calls.filter((call) => call.type === "fetch" && call.url.includes("editMessageText")).length;
  await runtime.pollAiSessionsNow();
  assert.equal(calls.filter((call) => call.type === "fetch" && call.url.includes("sendMessage")).length, sendCountAfterAiReply);
  assert.equal(calls.filter((call) => call.type === "fetch" && call.url.includes("editMessageText")).length, editCountAfterAiReply);

  aiSessionLastMessage = "";
  aiSessionTurns = [{
    id: "turn_1",
    userPrompt: "hello",
    lastMessage: "你好。需要我在这个工作目录里处理哪个项目或 workflow?",
    updatedAt: "2026-07-03T00:00:04.000Z",
  }];
  await runtime.pollAiSessionsNow();
  await waitTelegramAggregate();
  const turnReply = calls.filter((call) => call.type === "fetch" && call.url.includes("editMessageText")).at(-1);
  assert.equal(turnReply.body.message_id, sentAckMessageId);
  assert.match(turnReply.body.text, /这个工作目录/);

  await runtime.pollBridgeNow(bridge.id);
  const approvalAction = calls.filter((call) => call.type === "action").at(-1);
  assert.deepEqual(approvalAction.input.action, {
    type: "pending-decision",
    routeId: "inst_1:ai:ais_2",
    decision: "allow",
  });
  const approvalAnswer = calls.filter((call) => call.type === "fetch" && call.url.includes("answerCallbackQuery")).at(-1);
  assert.equal(approvalAnswer.body.text, "");
  assert.equal(calls.some((call) => call.type === "fetch" && call.url.includes("deleteMessage")), false);
  assert.equal(calls.some((call) => call.type === "fetch" && call.url.includes("editMessageText") && /allow sent/i.test(call.body.text || "")), false);
});

test("control plane telegram bridge deletes standalone approval cards after decisions", async () => {
  const calls = [];
  const routeId = "inst_1:ai:ais_1";
  const callbackData = new ChatActionTokenService().pendingDecisionCallbackData(routeId, "allow");
  const bridge = {
    id: "chat_telegram_standalone_approval",
    channel: "telegram",
    name: "Telegram",
    enabled: true,
    token: "telegram-token",
    tokenSet: true,
    defaultChatId: "123",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {},
  };
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    updateChatBridge: (_id, input) => {
      calls.push({ type: "update", input });
    },
    resolveChatActionToken: () => { throw new Error("stable pending callbacks must not use the expiring token store"); },
    handleChatGatewayAction: async (input) => {
      calls.push({ type: "action", input });
      return { accepted: true, message: "allow sent" };
    },
    listPendingRoutes: async () => [{ id: routeId, kind: "approval", status: "pending" }],
  };
  const runtime = new ControlPlaneChatGatewayRuntime(service, async (url, init = {}) => {
    calls.push({
      type: "fetch",
      url: String(url),
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    if (String(url).includes("getUpdates")) {
      return new Response(JSON.stringify({
        ok: true,
        result: [{
          update_id: 1,
          callback_query: {
            id: "callback-approval",
            data: callbackData,
            from: { id: 456 },
            message: {
              message_id: 20,
              chat: { id: 123 },
            },
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await runtime.pollBridgeNow(bridge.id);

  assert.deepEqual(bridge.allowedUserIds, ["456"]);
  assert.deepEqual(
    calls.find((call) => call.type === "update" && call.input.allowedUserIds)?.input,
    { allowedUserIds: ["456"] },
  );

  const approvalAction = calls.find((call) => call.type === "action");
  assert.deepEqual(approvalAction.input.action, {
    type: "pending-decision",
    routeId,
    decision: "allow",
  });
  const approvalAnswer = calls.filter((call) => call.type === "fetch" && call.url.includes("answerCallbackQuery")).at(-1);
  assert.equal(approvalAnswer.body.text, "");
  const deleteMessage = calls.filter((call) => call.type === "fetch" && call.url.includes("deleteMessage")).at(-1);
  assert.equal(deleteMessage.body.chat_id, "123");
  assert.equal(deleteMessage.body.message_id, 20);
  assert.equal(calls.some((call) => call.type === "fetch" && call.url.includes("editMessageText")), false);
});

test("control plane telegram bridge rejects approval buttons after the route stops pending", async () => {
  const calls = [];
  const callbackData = new ChatActionTokenService().pendingDecisionCallbackData("inst_1:ai:ais_finished", "deny");
  const bridge = {
    id: "chat_telegram_stale_approval",
    channel: "telegram",
    name: "Telegram",
    enabled: true,
    token: "telegram-token",
    tokenSet: true,
    defaultChatId: "123",
    allowedUserIds: ["456"],
    pollIntervalMs: 30000,
    settings: {},
  };
  const runtime = new ControlPlaneChatGatewayRuntime({
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    updateChatBridge: () => {},
    listPendingRoutes: async () => [],
    resolveChatActionToken: () => { throw new Error("stable pending callbacks must not use the expiring token store"); },
    handleChatGatewayAction: async (input) => {
      calls.push({ type: "action", input });
      return { accepted: true };
    },
  }, async (url, init = {}) => {
    calls.push({
      type: "fetch",
      url: String(url),
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    if (String(url).includes("getUpdates")) {
      return new Response(JSON.stringify({
        ok: true,
        result: [{
          update_id: 1,
          callback_query: {
            id: "callback-stale-approval",
            data: callbackData,
            from: { id: 456 },
            message: { message_id: 21, chat: { id: 123 } },
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await runtime.pollBridgeNow(bridge.id);

  assert.equal(calls.some((call) => call.type === "action"), false);
  assert.equal(calls.some((call) => call.type === "fetch" && call.url.includes("sendMessage")), false);
  const answer = calls.find((call) => call.type === "fetch" && call.url.includes("answerCallbackQuery"));
  assert.equal(answer.body.text, "This approval is no longer pending.");
  assert.equal(calls.some((call) => call.type === "fetch" && call.url.includes("deleteMessage")), true);
});

test("control plane telegram bridge appends downloaded image paths to messages", async () => {
  const calls = [];
  const receivedMessages = [];
  const bridge = {
    id: "chat_telegram_images",
    channel: "telegram",
    name: "Telegram Images",
    enabled: true,
    token: "telegram-token",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: ["456"],
    pollIntervalMs: 30000,
    settings: {},
  };
  const runtime = new ControlPlaneChatGatewayRuntime(
    {
      listChatBridges: () => [bridge],
      requireChatBridge: () => bridge,
      listChatSessions: () => [],
      listPendingRoutes: async () => [],
      handleChatGatewayMessage: async (message) => {
        receivedMessages.push(message);
        return { reply: "ok" };
      },
    },
    async (url, init = {}) => {
      calls.push({
        url: String(url),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      const value = String(url);
      if (value.includes("getUpdates")) {
        return new Response(JSON.stringify({
          ok: true,
          result: [{
            update_id: 100,
            message: {
              caption: "看一下这张图",
              photo: [
                { file_id: "small", file_size: 10, width: 10 },
                { file_id: "large", file_size: 20, width: 20 },
              ],
              chat: { id: 123 },
              from: { id: 456 },
            },
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (value.includes("getFile")) {
        assert.equal(JSON.parse(init.body).file_id, "large");
        return new Response(JSON.stringify({
          ok: true,
          result: { file_path: "photos/large.jpg" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (value.includes("/file/bottelegram-token/photos/large.jpg")) {
        return new Response(Buffer.from("image-bytes"), {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-length": "11" },
        });
      }
      if (value.includes("sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request: ${value}`);
    },
  );

  await runtime.pollBridgeNow(bridge.id);
  await waitTelegramAggregate();

  assert.equal(receivedMessages.length, 1);
  assert.equal(receivedMessages[0].message.text, "看一下这张图");
  assert.equal(receivedMessages[0].message.attachments.length, 1);
  assert.equal(receivedMessages[0].message.attachments[0].kind, "image");
  assert.equal(receivedMessages[0].message.attachments[0].mime, "image/jpeg");
  assert.equal(receivedMessages[0].message.attachments[0].size, 11);
  assert.equal(receivedMessages[0].message.attachments[0].source.data, Buffer.from("image-bytes").toString("base64"));
  assert.match(receivedMessages[0].message.attachments[0].name, /^telegram-/);
  assert.ok(calls.some((call) => call.url.includes("getFile")));
  assert.ok(calls.some((call) => call.url.includes("/file/bottelegram-token/photos/large.jpg")));
});

test("control plane telegram bridge does not download images from unauthorized users", async () => {
  const calls = [];
  const bridge = {
    id: "chat_telegram_unauthorized_images",
    channel: "telegram",
    name: "Telegram Unauthorized Images",
    enabled: true,
    token: "telegram-token",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: ["456"],
    pollIntervalMs: 30000,
    settings: {},
  };
  const runtime = new ControlPlaneChatGatewayRuntime(
    {
      listChatBridges: () => [bridge],
      requireChatBridge: () => bridge,
      listChatSessions: () => [],
      listPendingRoutes: async () => [],
      handleChatGatewayMessage: async () => {
        throw new Error("unauthorized message should not be handled");
      },
    },
    async (url, init = {}) => {
      calls.push({
        url: String(url),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      const value = String(url);
      if (value.includes("getUpdates")) {
        return new Response(JSON.stringify({
          ok: true,
          result: [{
            update_id: 100,
            message: {
              caption: "unauthorized image",
              photo: [{ file_id: "large", file_size: 20, width: 20 }],
              chat: { id: 123 },
              from: { id: 999 },
            },
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request: ${value}`);
    },
  );

  await runtime.pollBridgeNow(bridge.id);

  assert.equal(calls.filter((call) => call.url.includes("getFile")).length, 0);
  assert.equal(calls.filter((call) => call.url.includes("/file/bottelegram-token/")).length, 0);
});

test("control plane telegram bridge auto begins collection for a single image without caption", async () => {
  const calls = [];
  const receivedMessages = [];
  const bridge = {
    id: "chat_telegram_image_begin",
    channel: "telegram",
    name: "Telegram Image Begin",
    enabled: true,
    token: "telegram-token",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: ["456"],
    pollIntervalMs: 30000,
    settings: {},
  };
  let pollCount = 0;
  const runtime = new ControlPlaneChatGatewayRuntime(
    {
      listChatBridges: () => [bridge],
      requireChatBridge: () => bridge,
      listChatSessions: () => [],
      listPendingRoutes: async () => [],
      handleChatGatewayMessage: async (message) => {
        receivedMessages.push(message);
        return { reply: "ok" };
      },
    },
    async (url, init = {}) => {
      calls.push({
        url: String(url),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      const value = String(url);
      if (value.includes("getUpdates")) {
        pollCount += 1;
        const result = pollCount === 1
          ? [{
              update_id: 100,
              message: {
                message_id: 10,
                photo: [{ file_id: "single", file_size: 20, width: 20 }],
                chat: { id: 123 },
                from: { id: 456 },
              },
            }]
          : pollCount === 2
            ? [{
                update_id: 101,
                message: { message_id: 11, text: "/end", chat: { id: 123 }, from: { id: 456 } },
              }]
            : [];
        return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (value.includes("getFile")) {
        assert.equal(JSON.parse(init.body).file_id, "single");
        return new Response(JSON.stringify({
          ok: true,
          result: { file_path: "photos/single.jpg" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (value.includes("/file/bottelegram-token/photos/single.jpg")) {
        return new Response(Buffer.from("image-bytes"), {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-length": "11" },
        });
      }
      if (value.includes("sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request: ${value}`);
    },
  );

  await runtime.pollBridgeNow(bridge.id);
  const beginReply = calls.filter((call) => call.url.includes("sendMessage")).at(-1);
  assert.match(beginReply.body.text, /Image received/);
  assert.equal(beginReply.body.reply_markup.inline_keyboard[0][0].text, "/end");
  assert.match(beginReply.body.reply_markup.inline_keyboard[0][0].callback_data, /^task_handoff:cp_msg_end:[A-Za-z0-9_-]+$/);
  await waitTelegramAggregate();
  assert.equal(receivedMessages.length, 0);

  await runtime.pollBridgeNow(bridge.id);
  assert.equal(receivedMessages.length, 1);
  assert.equal(receivedMessages[0].message.text, "");
  assert.equal(receivedMessages[0].message.attachments.length, 1);
  assert.equal(receivedMessages[0].message.attachments[0].kind, "image");
  assert.equal(receivedMessages[0].message.attachments[0].mime, "image/jpeg");
  assert.equal(receivedMessages[0].message.attachments[0].size, 11);
  assert.equal(receivedMessages[0].message.attachments[0].source.data, Buffer.from("image-bytes").toString("base64"));
});

test("control plane telegram bridge aggregates adjacent messages and explicit begin end batches", async () => {
  const calls = [];
  const receivedMessages = [];
  const bridge = {
    id: "chat_telegram_aggregate",
    channel: "telegram",
    name: "Telegram Aggregate",
    enabled: true,
    token: "telegram-token",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: ["456"],
    pollIntervalMs: 30000,
    settings: {},
  };
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    listChatSessions: () => [],
    listPendingRoutes: async () => [],
    handleChatGatewayMessage: async (message) => {
      receivedMessages.push(message);
      return { reply: `received ${receivedMessages.length}` };
    },
  };
  let pollCount = 0;
  const runtime = new ControlPlaneChatGatewayRuntime(service, async (url, init = {}) => {
    calls.push({
      url: String(url),
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    if (String(url).includes("getUpdates")) {
      pollCount += 1;
      const result = pollCount === 1
        ? [{
            update_id: 100,
            message: { message_id: 10, text: "first chunk", chat: { id: 123 }, from: { id: 456 } },
          }, {
            update_id: 101,
            message: { message_id: 11, text: "second chunk", chat: { id: 123 }, from: { id: 456 } },
          }]
        : pollCount === 2
          ? [{
              update_id: 102,
              message: { message_id: 12, text: "/begin", chat: { id: 123 }, from: { id: 456 } },
            }, {
              update_id: 103,
              message: { message_id: 13, text: "manual one", chat: { id: 123 }, from: { id: 456 } },
            }, {
              update_id: 104,
              message: { message_id: 14, text: "manual two", chat: { id: 123 }, from: { id: 456 } },
            }]
          : pollCount === 3
            ? [{
                update_id: 105,
                message: { message_id: 15, text: "/end", chat: { id: 123 }, from: { id: 456 } },
              }]
            : [];
      return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("sendMessage")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 900 + calls.length } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await runtime.pollBridgeNow(bridge.id);
  assert.equal(receivedMessages.length, 0);
  await waitTelegramAggregate();
  assert.equal(receivedMessages.length, 1);
  assert.equal(receivedMessages[0].message.text, "first chunk\n\nsecond chunk");

  await runtime.pollBridgeNow(bridge.id);
  const beginReply = calls.filter((call) => call.url.includes("sendMessage")).at(-1);
  assert.match(beginReply.body.text, /Started collecting messages/);
  assert.equal(beginReply.body.reply_markup.inline_keyboard[0][0].text, "/end");
  assert.match(beginReply.body.reply_markup.inline_keyboard[0][0].callback_data, /^task_handoff:cp_msg_end:[A-Za-z0-9_-]+$/);
  await waitTelegramAggregate();
  assert.equal(receivedMessages.length, 1);

  await runtime.pollBridgeNow(bridge.id);
  assert.equal(receivedMessages.length, 2);
  assert.equal(receivedMessages[1].message.text, "manual one\n\nmanual two");
});

test("control plane telegram ai session ack updates from node agent events without event scope", async () => {
  const calls = [];
  const events = new ControlPlaneEventBus();
  const tunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
    validateInstanceScope: () => true,
    onSessionEvent: () => true,
  });
  const bridge = {
    id: "chat_telegram_node_event",
    channel: "telegram",
    name: "Telegram Node Event",
    enabled: true,
    token: "telegram-token",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {},
  };
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    handleChatGatewayMessage: async (message) => ({
      accepted: true,
      routed: true,
      binding: {
        id: "telegram:123",
        channel: "telegram",
        bridgeId: bridge.id,
        chatSessionId: message.source.chatSessionId,
        activeInstanceId: "inst_1",
        activeAiSessionId: "ais_1",
      },
      instance: { id: "inst_1" },
      aiSession: {
        session: {
          id: "ais_1",
          agent: "codex",
          activeTurnId: "turn_1",
          status: "running",
          phase: "thinking",
          userPrompt: message.message.text,
          turns: [{
            id: "turn_1",
            userPrompt: message.message.text,
          }],
          updatedAt: "2026-07-03T00:00:00.000Z",
        },
        provider: "codex",
        action: "send",
      },
      turnId: "turn_1",
      providerTurnId: "turn_1",
      reply: "Sent to work / inst_1 / ais_1.",
    }),
    listChatSessions: () => [{
      id: "telegram:123",
      channel: "telegram",
      bridgeId: bridge.id,
      chatSessionId: "123",
      activeInstanceId: "inst_1",
      activeAiSessionId: "ais_1",
    }],
    boardAsync: async () => [{ id: "inst_1", name: "instance-main" }],
    listPendingRoutes: async () => [],
  };
  let pollCount = 0;
  let telegramMessageId = 700;
  const runtime = new ControlPlaneChatGatewayRuntime(service, async (url, init = {}) => {
    calls.push({
      url: String(url),
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    if (String(url).includes("getUpdates")) {
      pollCount += 1;
      return new Response(JSON.stringify({
        ok: true,
        result: pollCount === 1
          ? [{
              update_id: 1,
              message: {
                message_id: 10,
                text: "你是谁",
                chat: { id: 123 },
                from: { id: 456 },
              },
            }]
          : [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("sendMessage")) {
      telegramMessageId += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: telegramMessageId } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, aiSessionGatewayOptions(events, { telegramProgressUpdateIntervalMs: 1 }));

  await runtime.pollBridgeNow(bridge.id);
  await waitTelegramAggregate();
  const sentAck = calls.find((call) => call.url.includes("sendMessage"));
  assert.ok(sentAck);
  assert.equal(sentAck.body.reply_to_message_id, 10);
  assert.match(sentAck.body.text, /Sent to work/);
  const ackMessageId = telegramMessageId;

  tunnel.handleMessage("node_1", {
    type: "node-agent.event.forwarded",
    instanceId: "inst_1",
    event: {
      type: AiSessionEventType.Snapshot,
      topic: AiSessionEventTopic,
      payload: aiSessionSnapshotPayload({
        runningCount: 0,
        waitingCount: 0,
        staleCount: 0,
        updatedAt: "2026-07-03T00:00:03.000Z",
        sessions: [{
          id: "ais_1",
          agent: "codex",
          status: "idle",
          phase: "unknown",
          turns: [{
            id: "turn_1",
            userPrompt: "你是谁",
            lastMessage: "我是这个工作区里的 AI 助手。",
            updatedAt: "2026-07-03T00:00:03.000Z",
          }],
          startedAt: "2026-07-03T00:00:00.000Z",
          updatedAt: "2026-07-03T00:00:03.000Z",
        }],
      }, { instanceId: "inst_1" }),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const edit = calls.find((call) => call.url.includes("editMessageText"));
  assert.ok(edit);
  assert.equal(edit.body.message_id, ackMessageId);
  assert.match(edit.body.text, /AI 助手/);
  assert.equal(calls.filter((call) => call.url.includes("sendMessage")).length, 1);
  runtime.stopAll();
});

test("control plane telegram ai session ack remembers action result turn id", async () => {
  const calls = [];
  const events = new ControlPlaneEventBus();
  const bridge = {
    id: "chat_telegram_turn_result",
    channel: "telegram",
    name: "Telegram Turn Result",
    enabled: true,
    token: "telegram-token",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {},
  };
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    handleChatGatewayMessage: async (message) => ({
      accepted: true,
      routed: true,
      binding: {
        id: "telegram:123",
        channel: "telegram",
        bridgeId: bridge.id,
        chatSessionId: message.source.chatSessionId,
        activeInstanceId: "inst_1",
        activeAiSessionId: "ais_1",
      },
      instance: { id: "inst_1" },
      aiSession: {
        session: {
          id: "ais_1",
          agent: "claude",
          activeTurnId: "turn_control_1",
          status: "running",
          phase: "thinking",
          turns: [{
            id: "turn_control_1",
            userPrompt: message.message.text,
            updatedAt: "2026-07-03T00:00:00.000Z",
          }],
          updatedAt: "2026-07-03T00:00:00.000Z",
        },
        provider: "claude",
        action: "send",
        turnId: "turn_control_1",
      },
      reply: "Sent to work / inst_1 / ais_1.",
    }),
    listChatSessions: () => [{
      id: "telegram:123",
      channel: "telegram",
      bridgeId: bridge.id,
      chatSessionId: "123",
      activeInstanceId: "inst_1",
      activeAiSessionId: "ais_1",
    }],
    boardAsync: async () => [{ id: "inst_1", name: "instance-main" }],
    listPendingRoutes: async () => [],
  };
  let pollCount = 0;
  const runtime = new ControlPlaneChatGatewayRuntime(service, async (url, init = {}) => {
    calls.push({
      url: String(url),
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    if (String(url).includes("getUpdates")) {
      pollCount += 1;
      return new Response(JSON.stringify({
        ok: true,
        result: pollCount === 1
          ? [{
              update_id: 1,
              message: {
                message_id: 12,
                text: "你好啊",
                chat: { id: 123 },
                from: { id: 456 },
              },
            }]
          : [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("sendMessage")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1001 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, aiSessionGatewayOptions(events, { telegramProgressUpdateIntervalMs: 1 }));

  await runtime.pollBridgeNow(bridge.id);
  await waitTelegramAggregate();
  publishAiSessionSnapshotForTest(events, {
    runningCount: 0,
    waitingCount: 0,
    staleCount: 0,
    updatedAt: "2026-07-03T00:00:02.000Z",
    sessions: [{
      id: "ais_1",
      agent: "claude",
      status: "idle",
      phase: "unknown",
      turns: [{
        id: "turn_control_1",
        userPrompt: "你好啊",
        lastMessage: "你好！有什么我可以帮你的吗？",
        updatedAt: "2026-07-03T00:00:02.000Z",
      }],
      updatedAt: "2026-07-03T00:00:02.000Z",
      startedAt: "2026-07-03T00:00:00.000Z",
    }],
  }, { scope: { instanceId: "inst_1" } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const sends = calls.filter((call) => call.url.includes("sendMessage"));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.reply_to_message_id, 12);
  const edit = calls.find((call) => call.url.includes("editMessageText"));
  assert.ok(edit);
  assert.equal(edit.body.message_id, 1001);
  assert.match(edit.body.text, /有什么我可以帮你的吗/);
  runtime.stopAll();
});

test("control plane telegram queued ack replaces and deletes the previous progress message", async () => {
  const calls = [];
  const events = new ControlPlaneEventBus();
  const bridge = {
    id: "chat_telegram_queue_replace",
    channel: "telegram",
    name: "Telegram Queue Replace",
    enabled: true,
    token: "telegram-token",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: ["456"],
    pollIntervalMs: 30000,
    settings: {},
  };
  let handledMessages = 0;
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    handleChatGatewayMessage: async (message) => {
      handledMessages += 1;
      const queued = handledMessages >= 2;
      return {
        accepted: true,
        routed: true,
        binding: {
          id: "telegram:123",
          channel: "telegram",
          bridgeId: bridge.id,
          chatSessionId: message.source.chatSessionId,
          activeInstanceId: "inst_1",
          activeAiSessionId: "ais_1",
        },
        instance: { id: "inst_1" },
        aiSession: {
          session: {
            id: "ais_1",
            agent: "codex",
            activeTurnId: "turn_1",
            status: "running",
            phase: "thinking",
            queue: queued ? {
              pendingCount: 1,
              items: [{ id: "queue_1", message: message.message.text, status: "queued" }],
            } : { pendingCount: 0, items: [] },
            turns: [{ id: "turn_1", userPrompt: "first", updatedAt: "2026-07-10T00:00:00.000Z" }],
            updatedAt: "2026-07-10T00:00:00.000Z",
          },
          provider: "codex",
          action: queued ? "queue" : "send",
          ...(queued ? { queueId: "queue_1" } : { turnId: "turn_1", providerTurnId: "turn_1" }),
        },
        reply: queued ? "Queued for ais_1." : "Sent to ais_1.",
      };
    },
    listChatSessions: () => [{
      id: "telegram:123",
      channel: "telegram",
      bridgeId: bridge.id,
      chatSessionId: "123",
      activeInstanceId: "inst_1",
      activeAiSessionId: "ais_1",
    }],
    boardAsync: async () => [{ id: "inst_1", name: "instance-main" }],
    listPendingRoutes: async () => [],
  };
  const updates = [{
    update_id: 1,
    message: { message_id: 10, text: "first", chat: { id: 123 }, from: { id: 456 } },
  }, {
    update_id: 2,
    message: { message_id: 11, text: "queued follow up", chat: { id: 123 }, from: { id: 456 } },
  }, {
    update_id: 3,
    message: { message_id: 12, text: "latest queued follow up", chat: { id: 123 }, from: { id: 456 } },
  }];
  let nextTelegramMessageId = 900;
  let deleteCallCount = 0;
  const runtime = new ControlPlaneChatGatewayRuntime(service, async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url).includes("getUpdates")) {
      const update = updates.shift();
      return new Response(JSON.stringify({ ok: true, result: update ? [update] : [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (String(url).includes("sendMessage")) {
      nextTelegramMessageId += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextTelegramMessageId } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (String(url).includes("deleteMessage")) {
      deleteCallCount += 1;
      return new Response(JSON.stringify(deleteCallCount === 2
        ? { ok: false, description: "message cannot be deleted" }
        : { ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, aiSessionGatewayOptions(events, { telegramProgressUpdateIntervalMs: 1 }));

  await runtime.pollBridgeNow(bridge.id);
  await waitTelegramAggregate();
  await runtime.pollBridgeNow(bridge.id);
  await waitTelegramAggregate();
  await runtime.pollBridgeNow(bridge.id);
  await waitTelegramAggregate();

  const sends = calls.filter((call) => call.url.includes("sendMessage"));
  assert.equal(sends.length, 3);
  const deletions = calls.filter((call) => call.url.includes("deleteMessage"));
  assert.deepEqual(deletions.map((call) => call.body.message_id), [901, 902]);

  publishAiSessionSnapshotForTest(events, {
    runningCount: 1,
    waitingCount: 0,
    staleCount: 0,
    updatedAt: "2026-07-10T00:00:01.000Z",
    sessions: [{
      id: "ais_1",
      agent: "codex",
      activeTurnId: "turn_1",
      status: "running",
      phase: "tool",
      currentTool: { name: "shell", inputPreview: "still working" },
      queue: {
        pendingCount: 1,
        items: [{
          id: "queue_1",
          message: "latest queued follow up",
          status: "queued",
          createdAt: "2026-07-10T00:00:01.000Z",
          updatedAt: "2026-07-10T00:00:01.000Z",
        }],
      },
      turns: [{ id: "turn_1", userPrompt: "first", updatedAt: "2026-07-10T00:00:01.000Z" }],
      startedAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:01.000Z",
    }],
  }, { scope: { instanceId: "inst_1" } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const edit = calls.filter((call) => call.url.includes("editMessageText")).at(-1);
  assert.ok(edit);
  assert.equal(edit.body.message_id, 903);
  assert.match(edit.body.text, /Thinking\\\.\\\.\\\. · shell · still working/);
  assert.deepEqual(edit.body.reply_markup.inline_keyboard.map((row) => row.map((button) => button.text)), [
    ["1. latest queued follow up"],
    ["Delete Queue", "Cancel"],
  ]);
  runtime.stopAll();
});

test("control plane telegram replies route to the replied ai session and include quote text", async () => {
  const calls = [];
  const receivedMessages = [];
  const events = new ControlPlaneEventBus();
  const bridge = {
    id: "chat_telegram_reply_quote",
    channel: "telegram",
    name: "Telegram Reply Quote",
    enabled: true,
    token: "telegram-token",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {},
  };
  let nextTelegramMessageId = 1200;
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    handleChatGatewayMessage: async (message) => {
      receivedMessages.push(message);
      const target = message.target || { instanceId: "inst_reply", aiSessionId: "ais_reply" };
      return {
        accepted: true,
        routed: true,
        binding: {
          id: "telegram:123",
          channel: "telegram",
          bridgeId: bridge.id,
          chatSessionId: message.source.chatSessionId,
          activeInstanceId: "inst_default",
          activeAiSessionId: "ais_default",
        },
        instance: { id: target.instanceId },
        aiSession: {
          session: {
            id: target.aiSessionId,
            agent: "codex",
            activeTurnId: target.aiSessionId === "ais_reply" ? "turn_reply" : "turn_default",
            status: "running",
            phase: "thinking",
            turns: [{
              id: target.aiSessionId === "ais_reply" ? "turn_reply" : "turn_default",
              userPrompt: message.message.text,
              updatedAt: "2026-07-03T00:00:00.000Z",
            }],
            updatedAt: "2026-07-03T00:00:00.000Z",
          },
          provider: "codex",
          action: "send",
        },
        turnId: target.aiSessionId === "ais_reply" ? "turn_reply" : "turn_default",
        providerTurnId: target.aiSessionId === "ais_reply" ? "turn_reply" : "turn_default",
        reply: `Sent to work / ${target.instanceId} / ${target.aiSessionId}.`,
      };
    },
    listChatSessions: () => [{
      id: "telegram:123",
      channel: "telegram",
      bridgeId: bridge.id,
      chatSessionId: "123",
      activeInstanceId: "inst_default",
      activeAiSessionId: "ais_default",
    }],
    boardAsync: async () => [{ id: "inst_default", name: "default" }, { id: "inst_reply", name: "reply" }],
    listPendingRoutes: async () => [],
  };
  let pollCount = 0;
  let ackMessageId = 0;
  const runtime = new ControlPlaneChatGatewayRuntime(service, async (url, init = {}) => {
    calls.push({
      url: String(url),
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    if (String(url).includes("getUpdates")) {
      pollCount += 1;
      return new Response(JSON.stringify({
        ok: true,
        result: pollCount === 1
          ? [{
              update_id: 1,
              message: {
                message_id: 10,
                text: "first prompt",
                chat: { id: 123 },
                from: { id: 456 },
              },
            }]
          : pollCount === 2
            ? [{
                update_id: 2,
                message: {
                  message_id: 11,
                  text: "继续解释",
                  quote: { text: "关键片段" },
                  reply_to_message: {
                    message_id: ackMessageId,
                    chat: { id: 123 },
                  },
                  chat: { id: 123 },
                  from: { id: 456 },
                },
              }]
            : [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("sendMessage")) {
      nextTelegramMessageId += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextTelegramMessageId } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, aiSessionGatewayOptions(events, { telegramProgressUpdateIntervalMs: 1 }));

  await runtime.pollBridgeNow(bridge.id);
  await waitTelegramAggregate();
  ackMessageId = nextTelegramMessageId;

  publishAiSessionSnapshotForTest(events, {
    runningCount: 1,
    waitingCount: 0,
    staleCount: 0,
    updatedAt: "2026-07-03T00:00:01.000Z",
    sessions: [{
      id: "ais_reply",
      agent: "codex",
      activeTurnId: "turn_reply",
      status: "running",
      phase: "thinking",
      turns: [{
        id: "turn_reply",
        userPrompt: "first prompt",
        updatedAt: "2026-07-03T00:00:01.000Z",
      }],
      startedAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:01.000Z",
    }],
  }, { scope: { instanceId: "inst_reply" } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  await runtime.pollBridgeNow(bridge.id);
  await waitTelegramAggregate();

  assert.equal(receivedMessages.length, 2);
  assert.equal(receivedMessages[1].target.instanceId, "inst_reply");
  assert.equal(receivedMessages[1].target.aiSessionId, "ais_reply");
  assert.equal(receivedMessages[1].message.text, "引用：关键片段\n继续解释");
  const replyAck = calls.filter((call) => call.url.includes("sendMessage")).at(-1);
  assert.equal(replyAck.body.reply_to_message_id, 11);
  assert.match(replyAck.body.text, /inst\\_reply \/ ais\\_reply/);
  runtime.stopAll();
});

test("control plane ai session delivery keeps response content inside the latest turn", () => {
  const session = {
    id: "ais_1",
    agent: "claude",
    status: "running",
    phase: "thinking",
    userPrompt: "second prompt",
    summary: "first answer",
    lastMessage: "first answer",
    turns: [
      {
        userPrompt: "first prompt",
        summary: "first answer",
        lastMessage: "first answer",
        updatedAt: "2026-07-03T00:00:00.000Z",
      },
      {
        userPrompt: "second prompt",
        updatedAt: "2026-07-03T00:00:01.000Z",
      },
    ],
    startedAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:01.000Z",
  };

  assert.equal(aiSessionDeliveryText(session, "instance-main · claude running/thinking"), "");

  session.turns[1].lastMessage = "second answer";
  assert.equal(aiSessionDeliveryText(session, "instance-main · claude idle"), "instance-main · claude idle\nsecond answer");
});

test("control plane ai session delivery appends authoritative tool activity after the latest response", () => {
  const session = {
    id: "ais_tool_progress",
    agent: "codex",
    status: "running",
    phase: "tool",
    currentTool: {
      id: "tool_1",
      name: "Command",
      inputPreview: "/bin/zsh -lc 'node --test test/control-plane.test.js'",
    },
    toolCallsSinceLastMessage: 1,
    turns: [{
      id: "turn_1",
      userPrompt: "检查未完成项",
      lastMessage: "目前有 3 个未提交修改。",
      updatedAt: "2026-07-18T00:00:01.000Z",
    }],
    startedAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:01.000Z",
  };

  assert.equal(
    aiSessionDeliveryText(session, "instance-main · codex running/tool"),
    "instance-main · codex running/tool\n目前有 3 个未提交修改。\n\nThinking... · Command · /bin/zsh -lc 'node --test test/control-plane.test.js'",
  );

  session.turns[0].lastMessage = "正在执行 /bin/zsh -lc 'node --test test/control-plane.test.js'";
  assert.equal(
    aiSessionDeliveryText(session, "instance-main · codex running/tool"),
    "instance-main · codex running/tool\n正在执行 /bin/zsh -lc 'node --test test/control-plane.test.js'\n\nThinking... · Command · /bin/zsh -lc 'node --test test/control-plane.test.js'",
  );

  session.turns[0].lastMessage = "目前有 3 个未提交修改。";
  session.currentTool = undefined;
  session.toolCallsSinceLastMessage = 2;
  assert.equal(
    aiSessionDeliveryText(session, "instance-main · codex running/thinking"),
    "instance-main · codex running/thinking\n目前有 3 个未提交修改。\n\nThinking... · 2 tools completed",
  );
});

test("control plane surfaces approval reasons over an earlier assistant message", () => {
  const session = {
    id: "ais_approval",
    agent: "codex",
    activeTurnId: "turn_approval",
    status: "waiting",
    phase: "approval",
    summary: "Tests need access to the local package cache.",
    lastMessage: "I will run the tests now.",
    turns: [{
      id: "turn_approval",
      userPrompt: "Run the tests",
      status: "waiting",
      phase: "approval",
      revision: 2,
      summary: "Tests need access to the local package cache.",
      lastMessage: "I will run the tests now.",
      updatedAt: "2026-07-17T00:00:01.000Z",
    }],
    startedAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:01.000Z",
  };

  assert.equal(displayAiSessionMessage(session), "Tests need access to the local package cache.");
  assert.equal(displayAiSessionMessage(session, 0), "Tests need access to the local package cache.");
  assert.equal(
    aiSessionDeliveryText(session, "instance-main · codex waiting/approval"),
    "instance-main · codex waiting/approval\nTests need access to the local package cache.",
  );

  session.summary = "Tests need access to the local package cache. · Command: pnpm test";
  session.turns[0].summary = session.summary;
  session.currentTool = { name: "Command", inputPreview: "pnpm test" };
  assert.equal(
    aiSessionDeliveryText(session, "instance-main · codex waiting/approval"),
    "instance-main · codex waiting/approval\nTests need access to the local package cache. · Command: pnpm test",
  );

  session.summary = "Tests need access to the local package cache.";
  session.turns[0].summary = session.summary;
  session.turns[0].status = "completed";
  session.turns[0].phase = "responding";
  session.turns[0].summary = "I will run the tests now.";
  assert.equal(displayAiSessionMessage(session, 0), "Tests need access to the local package cache.");
});

test("control plane ai session delivery keys explicit turns by id and revision", () => {
  const session = {
    id: "ais_1",
    agent: "claude",
    status: "running",
    phase: "thinking",
    turns: [
      {
        id: "turn_1",
        userPrompt: "first prompt",
        status: "completed",
        revision: 2,
        summary: "first answer",
        lastMessage: "first answer",
        updatedAt: "2026-07-03T00:00:00.000Z",
      },
      {
        id: "turn_2",
        userPrompt: "second prompt",
        status: "running",
        phase: "thinking",
        revision: 0,
        updatedAt: "2026-07-03T00:00:01.000Z",
      },
    ],
    startedAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:01.000Z",
  };

  assert.equal(aiSessionDeliveryText(session, "instance-main · claude running/thinking"), "");

  session.status = "idle";
  session.phase = "unknown";
  session.turns[1] = {
    ...session.turns[1],
    status: "completed",
    phase: "responding",
    revision: 1,
    summary: "second answer",
    lastMessage: "second answer",
    completedAt: "2026-07-03T00:00:02.000Z",
    updatedAt: "2026-07-03T00:00:02.000Z",
  };
  const delivered = aiSessionDeliveryText(session, "instance-main · claude idle");
  assert.equal(delivered, "instance-main · claude idle\nsecond answer");
  assert.doesNotMatch(delivered, /first answer/);
});

test("control plane ai session UI only displays authoritative turns", () => {
  const session = {
    id: "ais_1",
    agent: "codex",
    providerSessionId: "thread_1",
    userPrompt: "current prompt",
    status: "running",
    phase: "thinking",
    summary: "current progress",
    lastMessage: "current progress",
    turns: [
      {
        id: "turn_current",
        userPrompt: "current prompt",
        status: "completed",
        revision: 2,
        summary: "current progress",
        lastMessage: "current progress",
        updatedAt: "2026-07-04T00:00:00.000Z",
      },
    ],
    startedAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:01.000Z",
  };

  assert.equal(aiSessionUserPrompts(session).length, 1);
  assert.equal(displayAiSessionTitle(session, 1), "current prompt");
  assert.equal(displayAiSessionMessage(session, 1), "current progress");
  assert.equal(displayAiSessionMessage(session), "current progress");
});

test("control plane chat gateway delivers canonical ai session updates without heartbeat polling", async () => {
  const calls = [];
  const events = new ControlPlaneEventBus();
  let pollCount = 0;
  let telegramMessageId = 900;
  const bridge = {
    id: "chat_telegram_events",
    channel: "telegram",
    name: "Telegram Events",
    enabled: true,
    token: "telegram-token",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {},
  };
  const interrupts = [];
  const steeredQueuedMessages = [];
  const removedQueuedMessages = [];
  const telegramCallbacks = [];
  let cancelCallbackData = "";
  let steerCallbackData = "";
  let deleteQueueCallbackData = "";
  let deleteItemCallbackData = "";
  const runtime = new ControlPlaneChatGatewayRuntime(
    {
      listChatBridges: () => [bridge],
      requireChatBridge: () => bridge,
      listChatSessions: () => [{
        id: "telegram:123",
        channel: "telegram",
        bridgeId: bridge.id,
        chatSessionId: "123",
        activeInstanceId: "inst_1",
        activeAiSessionId: "ais_1",
      }],
      boardAsync: async () => [{
        id: "inst_1",
        name: "instance-main",
      }],
      listAiSessions: async () => {
        throw new Error("listAiSessions should not be used for event delivery");
      },
      listPendingRoutes: async () => [],
      pendingDecisionCallbackData: (_routeId, decision) => `task_handoff:cp_p:${decision}_token`,
      interruptAiSession: async (instanceId, sessionId) => {
        interrupts.push({ instanceId, sessionId });
        return { session: { id: sessionId }, action: "interrupt" };
      },
      steerAiSessionQueuedMessage: async (instanceId, sessionId, queueId) => {
        steeredQueuedMessages.push({ instanceId, sessionId, queueId });
        return { session: { id: sessionId }, action: "steer", queueId };
      },
      aiSessionQueue: async () => ({
        pendingCount: 2,
        items: [{
          id: "queue_1",
          message: "please steer this queued follow up into the active turn and keep going",
          status: "queued",
        }, {
          id: "queue_sent",
          message: "already sent",
          status: "sent",
        }, {
          id: "queue_2",
          message: "delete this queued follow up",
          status: "queued",
        }],
      }),
      removeAiSessionQueuedMessage: async (instanceId, sessionId, queueId) => {
        removedQueuedMessages.push({ instanceId, sessionId, queueId });
        return { session: { id: sessionId }, action: "remove", queueId };
      },
    },
    async (url, init = {}) => {
      calls.push({
        url: String(url),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      if (String(url).includes("getUpdates")) {
        pollCount += 1;
        return new Response(JSON.stringify({
          ok: true,
          result: telegramCallbacks.length
            ? [{
                update_id: pollCount,
                callback_query: {
                  id: "cancel-callback",
                  data: telegramCallbacks.shift(),
                  from: { id: 456 },
                  message: {
                    message_id: 902,
                    chat: { id: 123 },
                  },
                },
              }]
            : [],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const messageId = String(url).includes("sendMessage") ? ++telegramMessageId : telegramMessageId;
      return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    aiSessionGatewayOptions(events, { telegramProgressUpdateIntervalMs: 1 }),
  );

  publishAiSessionSnapshotForTest(events, {
    runningCount: 0,
    waitingCount: 0,
    staleCount: 0,
    updatedAt: "2026-07-03T00:00:03.000Z",
    sessions: [{
      id: "ais_1",
      agent: "codex",
      status: "idle",
      phase: "unknown",
      turns: [{
        id: "turn_event_1",
        userPrompt: "hello",
        lastMessage: "event delivered answer",
        updatedAt: "2026-07-03T00:00:03.000Z",
      }],
      startedAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:03.000Z",
    }],
  }, {
    scope: { instanceId: "inst_1" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const sent = calls.find((call) => call.url.includes("sendMessage"));
  assert.ok(sent);
  assert.equal(sent.body.chat_id, "123");
  assert.match(sent.body.text, /event delivered answer/);
  assert.equal(calls.some((call) => call.url.includes("editMessageText")), false);

  publishAiSessionSnapshotForTest(events, {
    runningCount: 0,
    waitingCount: 0,
    staleCount: 0,
    updatedAt: "2026-07-03T00:00:04.000Z",
    sessions: [{
      id: "ais_1",
      agent: "codex",
      status: "idle",
      phase: "unknown",
      turns: [{
        id: "turn_event_1",
        userPrompt: "hello",
        lastMessage: "event delivered answer again",
        updatedAt: "2026-07-03T00:00:04.000Z",
      }],
      startedAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:04.000Z",
    }],
  }, {
    scope: { instanceId: "inst_1" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const edited = calls.find((call) => call.url.includes("editMessageText"));
  assert.ok(edited);
  assert.equal(edited.body.message_id, 901);
  assert.match(edited.body.text, /again/);

  publishAiSessionSnapshotForTest(events, {
    runningCount: 1,
    waitingCount: 0,
    staleCount: 0,
    updatedAt: "2026-07-03T00:00:05.000Z",
    sessions: [{
      id: "ais_1",
      agent: "codex",
      activeTurnId: "turn_web_2",
      status: "running",
      phase: "thinking",
      currentTool: {
        name: "web_search",
        inputPreview: "checking docs",
      },
      turns: [{
        id: "turn_event_1",
        userPrompt: "hello",
        lastMessage: "event delivered answer again",
        updatedAt: "2026-07-03T00:00:04.000Z",
      }, {
        id: "turn_web_2",
        userPrompt: "web started another turn",
        updatedAt: "2026-07-03T00:00:05.000Z",
      }],
      queue: {
        pendingCount: 1,
        items: [{
          id: "queue_1",
          message: "please steer this queued follow up into the active turn and keep going",
          status: "queued",
          createdAt: "2026-07-03T00:00:05.100Z",
          updatedAt: "2026-07-03T00:00:05.100Z",
        }],
      },
      startedAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:05.000Z",
    }],
  }, {
    scope: { instanceId: "inst_1" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.filter((call) => call.url.includes("sendMessage")).length, 2);
  const runningProgress = calls.filter((call) => call.url.includes("sendMessage")).at(-1);
  assert.match(runningProgress.body.text, /Thinking\\\.\\\.\\\. · web\\_search · checking docs/);
  steerCallbackData = runningProgress.body.reply_markup.inline_keyboard[0][0].callback_data;
  deleteQueueCallbackData = runningProgress.body.reply_markup.inline_keyboard[1][0].callback_data;
  cancelCallbackData = runningProgress.body.reply_markup.inline_keyboard[1][1].callback_data;
  assert.match(runningProgress.body.reply_markup.inline_keyboard[0][0].text, /^1\. please steer this queued follow up/);
  assert.match(steerCallbackData, /^task_handoff:cp_ai_steer:[A-Za-z0-9_-]+$/);
  assert.ok(Buffer.byteLength(steerCallbackData, "utf8") <= 64);
  assert.deepEqual(runningProgress.body.reply_markup.inline_keyboard[1].map((button) => button.text), ["Delete Queue", "Cancel"]);
  assert.match(deleteQueueCallbackData, /^task_handoff:cp_ai_qdel_menu:[A-Za-z0-9_-]+$/);
  assert.ok(Buffer.byteLength(deleteQueueCallbackData, "utf8") <= 64);
  assert.match(cancelCallbackData, /^task_handoff:cp_ai_cancel:[A-Za-z0-9_-]+$/);
  assert.ok(Buffer.byteLength(cancelCallbackData, "utf8") <= 64);
  telegramCallbacks.push(deleteQueueCallbackData);
  await runtime.pollBridgeNow(bridge.id);
  const deleteMenuMessage = calls.filter((call) => call.url.includes("sendMessage")).at(-1);
  assert.equal(deleteMenuMessage.body.text, "Delete queued message");
  assert.match(deleteMenuMessage.body.reply_markup.inline_keyboard[0][0].text, /^1\. please steer this queued follow up into th\.\.\.$/);
  assert.equal(deleteMenuMessage.body.reply_markup.inline_keyboard[1][0].text, "2. delete this queued follow up");
  deleteItemCallbackData = deleteMenuMessage.body.reply_markup.inline_keyboard[1][0].callback_data;
  assert.match(deleteItemCallbackData, /^task_handoff:cp_ai_qdel:[A-Za-z0-9_-]+$/);
  assert.ok(Buffer.byteLength(deleteItemCallbackData, "utf8") <= 64);
  const deleteMenuAnswer = calls.filter((call) => call.url.includes("answerCallbackQuery")).at(-1);
  assert.equal(deleteMenuAnswer.body.text, "Select a queued message");
  telegramCallbacks.push(deleteItemCallbackData);
  await runtime.pollBridgeNow(bridge.id);
  assert.deepEqual(removedQueuedMessages, [{ instanceId: "inst_1", sessionId: "ais_1", queueId: "queue_2" }]);
  const deleteMessageCall = calls.find((call) => call.url.includes("deleteMessage"));
  assert.equal(deleteMessageCall.body.chat_id, "123");
  assert.equal(deleteMessageCall.body.message_id, 902);
  const deleteItemAnswer = calls.filter((call) => call.url.includes("answerCallbackQuery")).at(-1);
  assert.equal(deleteItemAnswer.body.text, "Queued message deleted");
  telegramCallbacks.push(steerCallbackData);
  await runtime.pollBridgeNow(bridge.id);
  assert.deepEqual(steeredQueuedMessages, [{ instanceId: "inst_1", sessionId: "ais_1", queueId: "queue_1" }]);
  const steerAnswer = calls.filter((call) => call.url.includes("answerCallbackQuery")).at(-1);
  assert.equal(steerAnswer.body.text, "Steered queued message");
  steerCallbackData = "";

  const editsBeforeQueueSnapshot = calls.filter((call) => call.url.includes("editMessageText")).length;
  publishAiSessionSnapshotForTest(events, {
    runningCount: 1,
    waitingCount: 0,
    staleCount: 0,
    updatedAt: "2026-07-03T00:00:05.250Z",
    sessions: [{
      id: "ais_1",
      agent: "codex",
      activeTurnId: "turn_web_2",
      status: "running",
      phase: "thinking",
      currentTool: {
        name: "web_search",
        inputPreview: "checking docs",
      },
      turns: [{
        id: "turn_event_1",
        userPrompt: "hello",
        lastMessage: "event delivered answer again",
        updatedAt: "2026-07-03T00:00:04.000Z",
      }, {
        id: "turn_web_2",
        userPrompt: "web started another turn",
        updatedAt: "2026-07-03T00:00:05.000Z",
      }],
      startedAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:05.250Z",
    }],
  }, {
    scope: { instanceId: "inst_1" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const queueRemovedEdit = calls.filter((call) => call.url.includes("editMessageText")).at(-1);
  assert.equal(calls.filter((call) => call.url.includes("editMessageText")).length, editsBeforeQueueSnapshot + 1);
  assert.match(queueRemovedEdit.body.text, /Thinking\\\.\\\.\\\. · web\\_search · checking docs/);
  assert.deepEqual(queueRemovedEdit.body.reply_markup.inline_keyboard.map((row) => row.map((button) => button.text)), [["Cancel"]]);

  publishAiSessionSnapshotForTest(events, {
    runningCount: 1,
    waitingCount: 0,
    staleCount: 0,
    updatedAt: "2026-07-03T00:00:05.500Z",
    sessions: [{
      id: "ais_1",
      agent: "codex",
      activeTurnId: "turn_web_2",
      status: "running",
      phase: "tool",
      currentTool: {
        name: "shell",
        inputPreview: "still running",
      },
      turns: [{
        id: "turn_event_1",
        userPrompt: "hello",
        lastMessage: "event delivered answer again",
        updatedAt: "2026-07-03T00:00:04.000Z",
      }, {
        id: "turn_web_2",
        userPrompt: "web started another turn",
        lastMessage: "I found the relevant tests and will run them now.",
        updatedAt: "2026-07-03T00:00:05.500Z",
      }],
      startedAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:05.500Z",
    }],
  }, {
    scope: { instanceId: "inst_1" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const waitingEdit = calls.filter((call) => call.url.includes("editMessageText")).at(-1);
  assert.match(waitingEdit.body.text, /I found the relevant tests and will run them now/);
  assert.match(waitingEdit.body.text, /Thinking\\\.\\\.\\\. · shell · still running/);
  assert.ok(waitingEdit.body.text.indexOf("I found the relevant tests") < waitingEdit.body.text.indexOf("Thinking"));
  assert.equal(waitingEdit.body.reply_markup.inline_keyboard[0][0].text, "Cancel");
  cancelCallbackData = waitingEdit.body.reply_markup.inline_keyboard[0][0].callback_data;

  publishAiSessionSnapshotForTest(events, {
    runningCount: 1,
    waitingCount: 0,
    staleCount: 0,
    updatedAt: "2026-07-03T00:00:05.750Z",
    sessions: [{
      id: "ais_1",
      agent: "codex",
      activeTurnId: "turn_web_2",
      status: "running",
      phase: "approval",
      currentTool: {
        name: "shell",
        inputPreview: "needs approval",
      },
      turns: [{
        id: "turn_event_1",
        userPrompt: "hello",
        lastMessage: "event delivered answer again",
        updatedAt: "2026-07-03T00:00:04.000Z",
      }, {
        id: "turn_web_2",
        userPrompt: "web started another turn",
        updatedAt: "2026-07-03T00:00:05.750Z",
      }],
      startedAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:05.750Z",
    }],
  }, {
    scope: { instanceId: "inst_1" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const approvalEdit = calls.filter((call) => call.url.includes("editMessageText")).at(-1);
  assert.match(approvalEdit.body.text, /Thinking\\\.\\\.\\\. · shell · needs approval/);
  assert.deepEqual(approvalEdit.body.reply_markup.inline_keyboard.map((row) => row.map((button) => button.text)), [["Cancel"]]);
  const approvalCallbackData = approvalEdit.body.reply_markup.inline_keyboard.flatMap((row) => row.map((button) => button.callback_data));
  for (const callbackData of approvalCallbackData) {
    assert.ok(Buffer.byteLength(callbackData, "utf8") <= 64);
  }
  cancelCallbackData = approvalCallbackData[0];

  publishAiSessionSnapshotForTest(events, {
    runningCount: 0,
    waitingCount: 1,
    staleCount: 0,
    updatedAt: "2026-07-03T00:00:05.875Z",
    sessions: [{
      id: "ais_1",
      agent: "codex",
      activeTurnId: "turn_web_2",
      status: "waiting",
      phase: "approval",
      currentTool: {
        name: "shell",
        inputPreview: "needs approval",
      },
      turns: [{
        id: "turn_event_1",
        userPrompt: "hello",
        lastMessage: "event delivered answer again",
        updatedAt: "2026-07-03T00:00:04.000Z",
      }, {
        id: "turn_web_2",
        userPrompt: "web started another turn",
        updatedAt: "2026-07-03T00:00:05.875Z",
      }],
      startedAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:05.875Z",
    }],
  }, {
    scope: { instanceId: "inst_1" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const waitingApprovalEdit = calls.filter((call) => call.url.includes("editMessageText")).at(-1);
  assert.match(waitingApprovalEdit.body.text, /Thinking\\\.\\\.\\\. · shell · needs approval/);
  assert.deepEqual(waitingApprovalEdit.body.reply_markup.inline_keyboard.map((row) => row.map((button) => button.text)), [["Allow", "Skip", "Deny"]]);
  const waitingApprovalCallbackData = waitingApprovalEdit.body.reply_markup.inline_keyboard.flatMap((row) => row.map((button) => button.callback_data));
  assert.deepEqual(waitingApprovalCallbackData, [
    "task_handoff:cp_p:allow_token",
    "task_handoff:cp_p:skip_token",
    "task_handoff:cp_p:deny_token",
  ]);

  publishAiSessionSnapshotForTest(events, {
    runningCount: 0,
    waitingCount: 0,
    staleCount: 0,
    updatedAt: "2026-07-03T00:00:06.000Z",
    sessions: [{
      id: "ais_1",
      agent: "codex",
      status: "idle",
      phase: "unknown",
      turns: [{
        id: "turn_event_1",
        userPrompt: "hello",
        lastMessage: "event delivered answer again",
        updatedAt: "2026-07-03T00:00:04.000Z",
      }, {
        id: "turn_web_2",
        userPrompt: "web started another turn",
        lastMessage: "web turn answer",
        updatedAt: "2026-07-03T00:00:06.000Z",
      }],
      startedAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:06.000Z",
    }],
  }, {
    scope: { instanceId: "inst_1" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const sentMessages = calls.filter((call) => call.url.includes("sendMessage"));
  assert.equal(sentMessages.length, 3);
  const webTurnEdit = calls.filter((call) => call.url.includes("editMessageText")).at(-1);
  assert.match(webTurnEdit.body.text, /web turn answer/);
  assert.deepEqual(webTurnEdit.body.reply_markup.inline_keyboard, []);
  telegramCallbacks.push(cancelCallbackData);
  await runtime.pollBridgeNow(bridge.id);
  assert.deepEqual(interrupts, [{ instanceId: "inst_1", sessionId: "ais_1" }]);
  const cancelAnswer = calls.filter((call) => call.url.includes("answerCallbackQuery")).at(-1);
  assert.equal(cancelAnswer.body.text, "Interrupt sent");

  publishAiSessionSnapshotForTest(events, {
    runningCount: 0,
    waitingCount: 0,
    staleCount: 0,
    updatedAt: "2026-07-03T00:00:07.000Z",
    sessions: [{
      id: "ais_1",
      agent: "codex",
      status: "idle",
      phase: "unknown",
      turns: [{
        userPrompt: "hello",
        lastMessage: "event delivered answer again",
        updatedAt: "2026-07-03T00:00:04.000Z",
      }, {
        userPrompt: "web started another turn",
        lastMessage: "web turn final",
        updatedAt: "2026-07-03T00:00:07.000Z",
      }],
      startedAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:07.000Z",
    }],
  }, {
    scope: { instanceId: "inst_1" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const finalEdit = calls.filter((call) => call.url.includes("editMessageText")).at(-1);
  assert.deepEqual(finalEdit.body.reply_markup.inline_keyboard, []);
  assert.equal(calls.some((call) => call.url.includes("editMessageText") && call.body.message_id === 901 && /web turn/.test(call.body.text)), false);
  runtime.stopAll();
});

test("control plane telegram bridge treats getUpdates conflicts as runtime errors without throwing", async () => {
  const bridge = {
    id: "chat_telegram_conflict",
    channel: "telegram",
    name: "Telegram Conflict",
    enabled: true,
    token: "telegram-token",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {},
  };
  const runtime = new ControlPlaneChatGatewayRuntime({
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    listPendingRoutes: async () => [],
  }, async () =>
    new Response(JSON.stringify({
      ok: false,
      description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
    }), { status: 409, headers: { "content-type": "application/json" } }));

  const status = await runtime.pollBridgeNow(bridge.id);
  assert.match(status.bridges[0].error, /terminated by other getUpdates request/);
});

test("control plane telegram bridge keeps old progress message updating after session switch", async () => {
  const bridge = {
    id: "chat_telegram_task2",
    channel: "telegram",
    name: "Telegram Task2",
    enabled: true,
    token: "telegram-token",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: ["456"],
    pollIntervalMs: 30000,
    settings: {},
  };
  const calls = [];
  const events = new ControlPlaneEventBus();
  let telegramMessageId = 900;
  const bindings = [{
    id: "telegram:123",
    channel: "telegram",
    bridgeId: bridge.id,
    chatSessionId: "123",
    activeInstanceId: "inst_1",
    activeAiSessionId: "ais_1",
  }];
  const interrupts = [];
  let updatePayloads = [];
  const runtime = new ControlPlaneChatGatewayRuntime({
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    handleChatGatewayMessage: async (message) => {
      if (message.message.text === "hello") {
        return {
          routed: true,
          instance: { id: "inst_1" },
          aiSession: {
            session: {
              id: "ais_1",
              agent: "codex",
              activeTurnId: "turn_1",
              status: "running",
              phase: "responding",
              updatedAt: "2026-07-10T00:00:00.000Z",
            },
            provider: "codex",
            action: "send",
            providerTurnId: "turn_1",
          },
          reply: "Sent to ais_1.",
        };
      }
      return { reply: "ok" };
    },
    handleChatGatewayAction: async () => ({ accepted: true, reply: "ok" }),
    listChatSessions: () => bindings,
    boardAsync: async () => [{ id: "inst_1", name: "instance-main" }],
    listPendingRoutes: async () => [],
    listAiSessions: async () => ({ instances: [] }),
    interruptAiSession: async (instanceId, sessionId) => {
      interrupts.push({ instanceId, sessionId });
    },
    aiSessionQueue: async () => ({ pendingCount: 0, items: [] }),
    steerAiSessionQueuedMessage: async () => ({}),
    removeAiSessionQueuedMessage: async () => ({}),
    resolveChatActionToken: () => { throw new Error("unused"); },
    pendingDecisionCallbackData: () => "unused",
  },
  async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url).includes("getUpdates")) {
      return new Response(JSON.stringify({
        ok: true,
        result: updatePayloads.length ? [updatePayloads.shift()] : [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const messageId = String(url).includes("sendMessage") ? ++telegramMessageId : telegramMessageId;
    return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, aiSessionGatewayOptions(events, { telegramProgressUpdateIntervalMs: 1 }));

  updatePayloads.push({
    update_id: 1,
    message: {
      text: "hello",
      chat: { id: 123 },
      from: { id: 456 },
    },
  });
  await runtime.pollBridgeNow(bridge.id);
  await waitTelegramAggregate();
  publishAiSessionSnapshotForTest(events, {
    runningCount: 1,
    waitingCount: 0,
    staleCount: 0,
    updatedAt: "2026-07-10T00:00:01.000Z",
    sessions: [{
      id: "ais_1",
      agent: "codex",
      activeTurnId: "turn_1",
      status: "running",
      phase: "thinking",
      turns: [{ id: "turn_1", userPrompt: "hello", updatedAt: "2026-07-10T00:00:01.000Z" }],
      startedAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:01.000Z",
    }],
  }, { scope: { instanceId: "inst_1" } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  bindings[0].activeAiSessionId = "ais_2";
  publishAiSessionSnapshotForTest(events, {
    runningCount: 1,
    waitingCount: 1,
    staleCount: 0,
    updatedAt: "2026-07-10T00:00:02.000Z",
    sessions: [{
      id: "ais_1",
      agent: "codex",
      activeTurnId: "turn_1",
      status: "running",
      phase: "tool",
      currentTool: { name: "shell", inputPreview: "still running" },
      turns: [{ id: "turn_1", userPrompt: "hello", updatedAt: "2026-07-10T00:00:02.000Z" }],
      startedAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:02.000Z",
    }, {
      id: "ais_2",
      agent: "claude",
      status: "waiting",
      phase: "approval",
      turns: [{ id: "turn_2", userPrompt: "other", updatedAt: "2026-07-10T00:00:02.000Z" }],
      startedAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:02.000Z",
    }],
  }, { scope: { instanceId: "inst_1" } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const switchedEdit = calls.filter((call) => call.url.includes("editMessageText")).at(-1);
  assert.ok(switchedEdit);
  assert.equal(switchedEdit.body.message_id, 901);
  assert.match(switchedEdit.body.text, /Thinking\\\.\\\.\\\. · shell · still running/);
  assert.equal(calls.filter((call) => call.url.includes("sendMessage")).length, 1);

  const cancelCallbackData = switchedEdit.body.reply_markup.inline_keyboard[0][0].callback_data;
  updatePayloads = [{
    update_id: 2,
    callback_query: {
      id: "cb-unrelated",
      data: cancelCallbackData,
      from: { id: 456 },
      message: {
        message_id: 999,
        chat: { id: 123 },
      },
    },
  }];
  await runtime.pollBridgeNow(bridge.id);
  const unrelatedAnswer = calls.filter((call) => call.url.includes("answerCallbackQuery")).at(-1);
  assert.equal(unrelatedAnswer?.body?.text, "This chat is not bound to that AI session");
  assert.deepEqual(interrupts, []);

  updatePayloads = [{
    update_id: 3,
    callback_query: {
      id: "cb-1",
      data: cancelCallbackData,
      from: { id: 456 },
      message: {
        message_id: 901,
        chat: { id: 123 },
      },
    },
  }];
  await runtime.pollBridgeNow(bridge.id);
  const cancelAnswer = calls.filter((call) => call.url.includes("answerCallbackQuery")).at(-1);
  assert.equal(cancelAnswer?.body?.text, "Interrupt sent");
  assert.deepEqual(interrupts, [{ instanceId: "inst_1", sessionId: "ais_1" }]);
  runtime.stopAll();
});

test("control plane telegram bridge falls back from markdown v2 to legacy markdown", async () => {
  const bridge = {
    id: "chat_telegram_markdown_fallback",
    channel: "telegram",
    name: "Telegram Markdown",
    enabled: true,
    token: "telegram-token",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: ["456"],
    pollIntervalMs: 30000,
    settings: {},
  };
  const calls = [];
  const runtime = new ControlPlaneChatGatewayRuntime({
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    handleChatGatewayMessage: async () => ({
      reply: "Use *markdown* please",
    }),
    listPendingRoutes: async () => [],
  }, async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), body });
    if (String(url).includes("getUpdates")) {
      return new Response(JSON.stringify({
        ok: true,
        result: [{
          update_id: 1,
          message: {
            message_id: 10,
            text: "hello",
            chat: { id: 123 },
            from: { id: 456 },
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (body?.parse_mode === "MarkdownV2") {
      return new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1001 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await runtime.pollBridgeNow(bridge.id);
  await waitTelegramAggregate();
  const sent = calls.filter((call) => call.url.includes("sendMessage"));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.parse_mode, "MarkdownV2");
  assert.equal(sent[0].body.text, "Use _markdown_ please");
  assert.equal(sent[1].body.parse_mode, undefined);
  assert.equal(sent[1].body.text, "Use *markdown* please");
});

test("control plane chat bridge settings cover telegram wechat and dingding", async (t) => {
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-chat-bridges"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
  });
  t.after(() => app.close());

  const telegramBridge = await json(app, "POST", "/api/chat-gateway/bridges", {
    channel: "telegram",
    name: "Telegram Main",
  });
  assert.equal(telegramBridge.statusCode, 200);

  const secondTelegramBridge = await json(app, "POST", "/api/chat-gateway/bridges", {
    channel: "telegram",
    name: "Telegram Alerts",
  });
  assert.equal(secondTelegramBridge.statusCode, 200);

  const telegram = await json(app, "PATCH", `/api/chat-gateway/bridges/${telegramBridge.body.data.id}`, {
    token: "telegram-token",
    defaultChatId: "123",
    allowedUserIds: ["456"],
  });
  assert.equal(telegram.statusCode, 200);
  assert.equal(telegram.body.data.token, undefined);
  assert.equal(telegram.body.data.tokenSet, true);
  assert.equal(telegram.body.data.defaultChatId, "123");
  assert.notEqual(telegramBridge.body.data.id, secondTelegramBridge.body.data.id);

  const wechatBridge = await json(app, "POST", "/api/chat-gateway/bridges", {
    channel: "wechat",
    name: "WeChat Main",
  });
  assert.equal(wechatBridge.statusCode, 200);

  const wechatStart = await json(app, "POST", `/api/chat-gateway/bridges/${wechatBridge.body.data.id}/start`);
  assert.equal(wechatStart.statusCode, 200);
  const wechatStatus = wechatStart.body.data.bridges.find((bridge) => bridge.id === wechatBridge.body.data.id);
  assert.equal(wechatStatus.running, false);
  assert.match(wechatStatus.error, /token is not configured/i);

  const dingdingBridge = await json(app, "POST", "/api/chat-gateway/bridges", {
    channel: "dingding",
    name: "DingDing Main",
  });
  assert.equal(dingdingBridge.statusCode, 200);

  const dingding = await json(app, "PATCH", `/api/chat-gateway/bridges/${dingdingBridge.body.data.id}`, {
    token: "dingding-client-id",
    defaultChatId: "dingding-chat",
    allowedUserIds: [],
    settings: {
      clientSecret: "dingding-secret",
      robotCode: "robot-code",
      corpId: "corp-id",
    },
  });
  assert.equal(dingding.statusCode, 200);
  assert.equal(dingding.body.data.token, undefined);
  assert.equal(dingding.body.data.tokenSet, true);
  assert.equal(dingding.body.data.settings.clientSecret, undefined);
  assert.equal(dingding.body.data.settings.clientSecretSet, true);
  assert.equal(dingding.body.data.settings.robotCode, "robot-code");

  const bridges = await json(app, "GET", "/api/chat-gateway/bridges");
  assert.equal(bridges.statusCode, 200);
  assert.equal(bridges.body.data.filter((bridge) => bridge.channel === "telegram").length, 2);
  assert.equal(bridges.body.data.find((bridge) => bridge.channel === "dingding").settings.clientSecret, undefined);
  assert.equal(bridges.body.data.find((bridge) => bridge.channel === "dingding").settings.clientSecretSet, true);
});

test("control plane wechat bridge polls messages and sends replies", async (t) => {
  const calls = [];
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-wechat-bridge"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: async (url, init = {}) => {
        calls.push({
          url: String(url),
          method: init.method || "GET",
          body: init.body ? JSON.parse(init.body) : undefined,
        });
        if (String(url).includes("getupdates")) {
          return new Response(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "cursor-2",
              msgs: [
                {
                  from_user_id: "wechat-chat",
                  message_type: 1,
                  context_token: "context-1",
                  item_list: [{ type: 1, text_item: { text: "/instances" } }],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (String(url).includes("sendmessage")) {
          return new Response(JSON.stringify({ ret: 0, msg: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ret: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
  t.after(() => app.close());

  const createdBridge = await json(app, "POST", "/api/chat-gateway/bridges", {
    channel: "wechat",
    name: "WeChat Ops",
  });
  assert.equal(createdBridge.statusCode, 200);

  const patched = await json(app, "PATCH", `/api/chat-gateway/bridges/${createdBridge.body.data.id}`, {
    token: "wechat-token",
    defaultChatId: "wechat-chat",
    pollIntervalMs: 30000,
    settings: {
      baseUrl: "https://wechat.example.test",
      contextToken: "context-1",
    },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.body.data.tokenSet, true);

  const started = await json(app, "POST", `/api/chat-gateway/bridges/${createdBridge.body.data.id}/start`);
  assert.equal(started.statusCode, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(calls.some((call) => call.url.includes("getupdates")));
  const sent = calls.find((call) => call.url.includes("sendmessage"));
  assert.ok(sent);
  assert.equal(sent.body.msg.to_user_id, "wechat-chat");
  assert.match(sent.body.msg.item_list[0].text_item.text, /No controlled instances/);

  const bridges = await json(app, "GET", "/api/chat-gateway/bridges");
  assert.equal(bridges.body.data.find((bridge) => bridge.id === createdBridge.body.data.id).settings.updatesBuf, "cursor-2");
});

test("control plane dingding bridge receives robot messages and sends replies", async () => {
  const calls = [];
  let fakeClient;
  const bridge = {
    id: "chat_dingding_test",
    channel: "dingding",
    name: "DingDing Test",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {
      clientSecret: "dingding-secret",
    },
  };
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    updateChatBridge: (_channel, input) => {
      calls.push({ type: "update", input });
      Object.assign(bridge, input, {
        settings: {
          ...bridge.settings,
          ...(input.settings || {}),
        },
      });
      return bridge;
    },
    handleChatGatewayMessage: async (message) => {
      calls.push({ type: "message", message });
      return { reply: "DingDing reply" };
    },
    listPendingRoutes: async () => [],
  };
  class FakeDingdingClient {
    constructor() {
      this.listeners = new Map();
      this.responses = [];
      this.connected = false;
      this.disconnected = false;
    }

    registerCallbackListener(topic, listener) {
      this.listeners.set(topic, listener);
    }

    async connect() {
      this.connected = true;
    }

    disconnect() {
      this.disconnected = true;
    }

    socketCallBackResponse(messageId, payload) {
      this.responses.push({ messageId, payload });
    }

    emitRobot(data) {
      const listener = this.listeners.get("/v1.0/im/bot/messages/get");
      listener({
        headers: { messageId: "ding-msg-1" },
        data: JSON.stringify(data),
      });
    }

    emitCard(data) {
      const listener = this.listeners.get("/v1.0/card/instances/callback");
      listener({
        headers: { messageId: "ding-card-1" },
        data: JSON.stringify(data),
      });
    }
  }
  const runtime = new ControlPlaneChatGatewayRuntime(
    service,
    async (url, init = {}) => {
      calls.push({
        type: "fetch",
        url: String(url),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify({ errcode: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    {
      createDingdingClient: () => {
        fakeClient = new FakeDingdingClient();
        return fakeClient;
      },
    },
  );

  const started = runtime.startBridge(bridge.id);
  assert.equal(started.bridges.find((status) => status.id === bridge.id).running, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fakeClient.connected, true);

  fakeClient.emitRobot({
    conversationId: "dingding-chat",
    senderStaffId: "staff-1",
    sessionWebhook: "https://dingding.example.test/webhook",
    text: { content: "/instances" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  fakeClient.emitRobot({
    conversationId: "other-chat",
    senderStaffId: "staff-2",
    sessionWebhook: "https://dingding.example.test/other-webhook",
    text: { content: "/instances" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const routedMessages = calls.filter((call) => call.type === "message");
  assert.equal(routedMessages.length, 1);
  const routed = routedMessages[0];
  assert.equal(routed.message.source.channel, "dingding");
  assert.equal(routed.message.source.bridgeId, bridge.id);
  assert.equal(routed.message.source.chatSessionId, "dingding-chat");
  assert.equal(routed.message.source.userId, "staff-1");
  assert.equal(routed.message.message.text, "/instances");
  assert.deepEqual(bridge.allowedUserIds, ["staff-1"]);
  assert.deepEqual(
    calls.find((call) => call.type === "update" && call.input.allowedUserIds)?.input,
    { allowedUserIds: ["staff-1"] },
  );
  assert.equal(bridge.defaultChatId, "dingding-chat");
  assert.deepEqual(fakeClient.responses, [
    { messageId: "ding-msg-1", payload: {} },
    { messageId: "ding-msg-1", payload: {} },
  ]);
  const reply = calls.find((call) => call.type === "fetch");
  assert.equal(reply.url, "https://dingding.example.test/webhook");
  assert.equal(reply.body.msgtype, "markdown");
  assert.match(reply.body.markdown.text, /DingDing reply/);

  runtime.stopAll();
  assert.equal(fakeClient.disconnected, true);
});

test("control plane dingding stream client disables unsafe sdk heartbeat", () => {
  const client = createDingdingStreamClient({
    clientId: "dingding-client-id",
    clientSecret: "dingding-secret",
  });
  assert.equal(client.getConfig().keepAlive, false);
  assert.equal(client.getConfig().autoReconnect, false);
});

test("control plane dingding bridge replies business errors through robot message", async () => {
  const calls = [];
  let fakeClient;
  const bridge = {
    id: "chat_dingding_business_error",
    channel: "dingding",
    name: "DingDing Business Error",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: ["staff-1"],
    pollIntervalMs: 30000,
    settings: {
      clientSecret: "dingding-secret",
    },
  };
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    updateChatBridge: (_channel, input) => {
      Object.assign(bridge, input, {
        settings: {
          ...bridge.settings,
          ...(input.settings || {}),
        },
      });
      return bridge;
    },
    handleChatGatewayMessage: async () => {
      throw new Error("Project 123 was not found.");
    },
    listPendingRoutes: async () => [],
  };
  class FakeDingdingClient {
    constructor() {
      this.listeners = new Map();
      this.responses = [];
      this.connected = false;
    }

    registerCallbackListener(topic, listener) {
      this.listeners.set(topic, listener);
    }

    async connect() {
      this.connected = true;
    }

    disconnect() {}

    socketCallBackResponse(messageId, payload) {
      this.responses.push({ messageId, payload });
    }

    emitRobot(data) {
      this.listeners.get("/v1.0/im/bot/messages/get")({
        headers: { messageId: "ding-msg-error" },
        data: JSON.stringify(data),
      });
    }
  }
  const runtime = new ControlPlaneChatGatewayRuntime(
    service,
    async (url, init = {}) => {
      calls.push({
        type: "fetch",
        url: String(url),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify({ errcode: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    {
      createDingdingClient: () => {
        fakeClient = new FakeDingdingClient();
        return fakeClient;
      },
    },
  );

  runtime.startBridge(bridge.id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  fakeClient.emitRobot({
    conversationId: "dingding-chat",
    senderStaffId: "staff-1",
    sessionWebhook: "https://dingding.example.test/webhook",
    text: { content: "/use 123" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(fakeClient.responses, [{ messageId: "ding-msg-error", payload: {} }]);
  const reply = calls.find((call) => call.type === "fetch");
  assert.equal(reply.url, "https://dingding.example.test/webhook");
  assert.equal(reply.body.msgtype, "markdown");
  assert.match(reply.body.markdown.text, /Project 123 was not found/);
  assert.equal(runtime.status().bridges.find((status) => status.id === bridge.id).error, undefined);
  runtime.stopAll();
});

test("control plane dingding bridge reuses cached robot webhook for later command replies", async () => {
  const calls = [];
  let fakeClient;
  const bridge = {
    id: "chat_dingding_cached_webhook",
    channel: "dingding",
    name: "DingDing Cached Webhook",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: ["staff-1"],
    pollIntervalMs: 30000,
    settings: {
      clientSecret: "dingding-secret",
    },
  };
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    updateChatBridge: (_channel, input) => {
      Object.assign(bridge, input, {
        settings: {
          ...bridge.settings,
          ...(input.settings || {}),
        },
      });
      return bridge;
    },
    handleChatGatewayMessage: async (message) => {
      calls.push({ type: "message", message });
      if (message.message.text === "/sessions") {
        return {
          reply: "Sessions: 1. Tap a session to use.",
          replyMarkup: {
            inline_keyboard: [[{ text: "worker - idle - ais_1", callback_data: "task_handoff:cp_session:0" }]],
          },
        };
      }
      return { reply: "ok" };
    },
    listPendingRoutes: async () => [],
  };
  class FakeDingdingClient {
    constructor() {
      this.listeners = new Map();
      this.responses = [];
    }

    registerCallbackListener(topic, listener) {
      this.listeners.set(topic, listener);
    }

    async connect() {}

    disconnect() {}

    socketCallBackResponse(messageId, payload) {
      this.responses.push({ messageId, payload });
    }

    emitRobot(messageId, data) {
      this.listeners.get("/v1.0/im/bot/messages/get")({
        headers: { messageId },
        data: JSON.stringify(data),
      });
    }
  }
  const runtime = new ControlPlaneChatGatewayRuntime(
    service,
    async (url, init = {}) => {
      calls.push({
        type: "fetch",
        url: String(url),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify({ errcode: 0, result: { outTrackId: "card-track-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    {
      createDingdingClient: () => {
        fakeClient = new FakeDingdingClient();
        return fakeClient;
      },
    },
  );

  runtime.startBridge(bridge.id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  fakeClient.emitRobot("ding-msg-prime", {
    conversationId: "dingding-chat",
    senderStaffId: "staff-1",
    sessionWebhook: "https://dingding.example.test/webhook",
    text: { content: "/help" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  fakeClient.emitRobot("ding-msg-sessions", {
    conversationId: "dingding-chat",
    senderStaffId: "staff-1",
    text: { content: "/sessions" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const routed = calls.filter((call) => call.type === "message").map((call) => call.message.message.text);
  assert.deepEqual(routed, ["/help", "/sessions"]);
  const replies = calls.filter((call) => call.type === "fetch" && call.url === "https://dingding.example.test/webhook");
  assert.equal(replies.length, 2);
  assert.match(replies[1].body.markdown.text, /Sessions: 1/);
  assert.deepEqual(fakeClient.responses, [
    { messageId: "ding-msg-prime", payload: {} },
    { messageId: "ding-msg-sessions", payload: {} },
  ]);
  assert.equal(runtime.status().bridges.find((status) => status.id === bridge.id).error, undefined);
  runtime.stopAll();
});

test("control plane dingding bridge sends command action cards without robot webhook", async () => {
  const calls = [];
  let fakeClient;
  const bridge = {
    id: "chat_dingding_command_card",
    channel: "dingding",
    name: "DingDing Command Card",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: ["staff-1"],
    pollIntervalMs: 30000,
    settings: {
      clientSecret: "dingding-secret",
      robotCode: "robot-code",
    },
  };
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    updateChatBridge: (_channel, input) => {
      Object.assign(bridge, input, {
        settings: {
          ...bridge.settings,
          ...(input.settings || {}),
        },
      });
      return bridge;
    },
    handleChatGatewayMessage: async (message) => {
      calls.push({ type: "message", message });
      return {
        reply: "Select AI session",
        replyMarkup: {
          inline_keyboard: [[{ text: "worker - idle - ais_1", callback_data: "task_handoff:cp_session:0" }]],
        },
      };
    },
    listPendingRoutes: async () => [],
  };
  class FakeDingdingClient {
    constructor() {
      this.listeners = new Map();
      this.responses = [];
    }

    registerCallbackListener(topic, listener) {
      this.listeners.set(topic, listener);
    }

    async connect() {}

    disconnect() {}

    socketCallBackResponse(messageId, payload) {
      this.responses.push({ messageId, payload });
    }

    emitRobot(messageId, data) {
      this.listeners.get("/v1.0/im/bot/messages/get")({
        headers: { messageId },
        data: JSON.stringify(data),
      });
    }
  }
  const runtime = new ControlPlaneChatGatewayRuntime(
    service,
    async (url, init = {}) => {
      calls.push({
        type: "fetch",
        url: String(url),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      if (String(url).includes("/oauth2/accessToken")) {
        return new Response(JSON.stringify({ accessToken: "access-token", expireIn: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    {
      createDingdingClient: () => {
        fakeClient = new FakeDingdingClient();
        return fakeClient;
      },
    },
  );

  try {
    runtime.startBridge(bridge.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fakeClient.emitRobot("ding-msg-sessions", {
      conversationId: "dingding-chat",
      conversationType: "2",
      senderStaffId: "staff-1",
      text: { content: "/sessions" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const routed = calls.find((call) => call.type === "message");
    assert.equal(routed.message.message.text, "/sessions");
    const cardCreate = calls.find((call) => call.type === "fetch" && call.url.includes("/card/instances/createAndDeliver"));
    assert.ok(cardCreate);
    assert.equal(cardCreate.body.userId, "staff-1");
    assert.equal(cardCreate.body.imGroupOpenDeliverModel.robotCode, "robot-code");
    assert.equal(cardCreate.body.cardData.cardParamMap.biz_conversation_id, "dingding-chat");
    assert.equal(cardCreate.body.cardData.cardParamMap.biz_session_webhook, "");
    assert.match(cardCreate.body.cardData.cardParamMap.description, /Select AI session/);
    assert.match(cardCreate.body.cardData.cardParamMap.list, /worker - idle - ais_1/);
    assert.deepEqual(fakeClient.responses, [{ messageId: "ding-msg-sessions", payload: {} }]);
  } finally {
    runtime.stopAll();
  }
});

test("control plane dingding bridge sends action cards and handles callbacks", async () => {
  const calls = [];
  let fakeClient;
  const bridge = {
    id: "chat_dingding_cards",
    channel: "dingding",
    name: "DingDing Cards",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: ["staff-1", "staff-2"],
    pollIntervalMs: 30000,
    settings: {
      clientSecret: "dingding-secret",
      robotCode: "robot-code",
    },
  };
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    updateChatBridge: (_channel, input) => {
      Object.assign(bridge, input, {
        settings: {
          ...bridge.settings,
          ...(input.settings || {}),
        },
      });
      return bridge;
    },
    handleChatGatewayMessage: async (message) => {
      calls.push({ type: "message", message });
      return {
        reply: "Pick a session",
        replyMarkup: {
          inline_keyboard: [
            [{ text: "Session 1", callback_data: "task_handoff:cp_session:0" }],
          ],
        },
      };
    },
    handleChatGatewayAction: async (input) => {
      calls.push({ type: "action", input });
      return {
        message: "selected",
        reply: "Selected session",
        replyMarkup: {
          inline_keyboard: [
            [{ text: "Session 1", callback_data: "task_handoff:cp_session:0" }],
          ],
        },
      };
    },
    listPendingRoutes: async () => [],
  };
  class FakeDingdingClient {
    constructor() {
      this.listeners = new Map();
      this.responses = [];
    }

    registerCallbackListener(topic, listener) {
      this.listeners.set(topic, listener);
    }

    async connect() {}

    disconnect() {}

    socketCallBackResponse(messageId, payload) {
      this.responses.push({ messageId, payload });
    }

    emitRobot(data) {
      this.listeners.get("/v1.0/im/bot/messages/get")({
        headers: { messageId: "ding-msg-1" },
        data: JSON.stringify(data),
      });
    }

    emitCard(data) {
      this.listeners.get("/v1.0/card/instances/callback")({
        headers: { messageId: "ding-card-1" },
        data: JSON.stringify(data),
      });
    }
  }
  const runtime = new ControlPlaneChatGatewayRuntime(
    service,
    async (url, init = {}) => {
      calls.push({
        type: "fetch",
        url: String(url),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      if (String(url).includes("/oauth2/accessToken")) {
        return new Response(JSON.stringify({ accessToken: "access-token", expireIn: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    {
      createDingdingClient: () => {
        fakeClient = new FakeDingdingClient();
        return fakeClient;
      },
    },
  );

  try {
    runtime.startBridge(bridge.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    fakeClient.emitRobot({
      conversationId: "dingding-chat",
      senderStaffId: "staff-1",
      sessionWebhook: "https://dingding.example.test/webhook",
      text: { content: "/session" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cardCreate = calls.find((call) => call.type === "fetch" && call.url.includes("/card/instances/createAndDeliver"));
    assert.ok(cardCreate);
    assert.equal(cardCreate.body.userId, "staff-1");
    assert.equal(cardCreate.body.imGroupOpenDeliverModel.robotCode, "robot-code");
    const cardParams = cardCreate.body.cardData.cardParamMap;
    assert.equal(cardParams.biz_conversation_id, "dingding-chat");
    assert.equal(cardParams.biz_sender_id, "staff-1");
    assert.match(cardParams.list, /Session 1/);

    fakeClient.emitCard({
      userId: "staff-2",
      outTrackId: cardCreate.body.outTrackId,
      cardActionData: {
        cardPrivateData: {
          actionIdList: [JSON.parse(cardParams.list)[0].id],
          params: {
            biz_conversation_id: "dingding-chat",
            biz_sender_id: "staff-1",
            biz_session_webhook: "https://dingding.example.test/webhook",
          },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const action = calls.find((call) => call.type === "action");
    assert.deepEqual(action.input.action, { type: "ai-session", index: 0 });
    assert.equal(action.input.source.channel, "dingding");
    assert.equal(action.input.source.chatSessionId, "dingding-chat");
    assert.equal(action.input.source.userId, "staff-2");
    const cardResponse = fakeClient.responses.find((response) => response.messageId === "ding-card-1");
    assert.ok(cardResponse);
    assert.match(cardResponse.payload.cardData.cardParamMap.description, /Selected session/);
    assert.match(cardResponse.payload.cardData.cardParamMap.list, /Session 1/);
    assert.equal(cardResponse.payload.cardData.cardParamMap.biz_sender_id, "staff-1");
  } finally {
    runtime.stopAll();
  }
});

test("control plane dingding bridge binds the first card callback user", async () => {
  const calls = [];
  let fakeClient;
  const bridge = {
    id: "chat_dingding_first_card_user",
    channel: "dingding",
    name: "DingDing First Card User",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "dingding-chat",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: { clientSecret: "dingding-secret" },
  };
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    updateChatBridge: (_id, input) => {
      calls.push({ type: "update", input });
    },
    handleChatGatewayAction: async (input) => {
      calls.push({ type: "action", input });
      return { reply: "Selected session" };
    },
    listPendingRoutes: async () => [],
  };
  class FakeDingdingClient {
    constructor() {
      this.listeners = new Map();
      this.responses = [];
    }

    registerCallbackListener(topic, listener) {
      this.listeners.set(topic, listener);
    }

    async connect() {}

    disconnect() {}

    socketCallBackResponse(messageId, payload) {
      this.responses.push({ messageId, payload });
    }

    emitCard(data) {
      this.listeners.get("/v1.0/card/instances/callback")({
        headers: { messageId: "ding-card-first-user" },
        data: JSON.stringify(data),
      });
    }
  }
  const runtime = new ControlPlaneChatGatewayRuntime(
    service,
    async () => new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    {
      createDingdingClient: () => {
        fakeClient = new FakeDingdingClient();
        return fakeClient;
      },
    },
  );

  try {
    runtime.startBridge(bridge.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    fakeClient.emitCard({
      userId: "staff-card-1",
      cardActionData: {
        cardPrivateData: {
          actionIdList: ["task_handoff:cp_session:0"],
          params: { biz_conversation_id: "dingding-chat" },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(bridge.allowedUserIds, ["staff-card-1"]);
    assert.deepEqual(
      calls.find((call) => call.type === "update" && call.input.allowedUserIds)?.input,
      { allowedUserIds: ["staff-card-1"] },
    );
    assert.equal(calls.filter((call) => call.type === "action").length, 1);
  } finally {
    runtime.stopAll();
  }
});

test("control plane dingding card callback parses action id from card action data", () => {
  const encoded = Buffer.from("task_handoff:cp_session:2", "utf8").toString("base64url");
  const event = parseDingdingCardEvent(JSON.stringify({
    userId: "staff-2",
    spaceId: "dtv1.card//IM_GROUP.dingding-chat",
    cardActionData: {
      actionId: `th_cb_${encoded}`,
      params: {
        biz_conversation_id: "dingding-chat",
        biz_sender_id: "staff-1",
        biz_conversation_type: "IM_GROUP",
      },
    },
  }));

  assert.equal(event.callbackData, "task_handoff:cp_session:2");
  assert.equal(event.chatId, "dingding-chat");
  assert.equal(event.deliverySenderId, "staff-1");
  assert.equal(event.conversationType, "IM_GROUP");
});

test("control plane dingding card callback parses json string private data", () => {
  const event = parseDingdingCardEvent(JSON.stringify({
    userId: "staff-2",
    cardActionData: {
      cardPrivateData: JSON.stringify({
        actionIdList: ["task_handoff:cp_session:3"],
        params: {
          biz_conversation_id: "single-chat",
          biz_sender_id: "staff-1",
          biz_conversation_type: "IM_ROBOT",
        },
      }),
    },
  }));

  assert.equal(event.callbackData, "task_handoff:cp_session:3");
  assert.equal(event.chatId, "single-chat");
  assert.equal(event.deliverySenderId, "staff-1");
  assert.equal(event.conversationType, "IM_ROBOT");
});

test("control plane dingding card callback parses action data from content", () => {
  const event = parseDingdingCardEvent(JSON.stringify({
    userId: "staff-2",
    outTrackId: "task_handoff_cp_1",
    spaceId: "cid-single-chat",
    content: JSON.stringify({
      cardPrivateData: {
        actionIds: ["task_handoff:cp_session:4"],
        params: {
          biz_conversation_id: "single-chat",
          biz_sender_id: "staff-1",
          biz_session_webhook: "https://dingding.example.test/webhook",
          biz_conversation_type: "IM_ROBOT",
        },
      },
    }),
  }));

  assert.equal(event.callbackData, "task_handoff:cp_session:4");
  assert.equal(event.chatId, "single-chat");
  assert.equal(event.deliverySenderId, "staff-1");
  assert.equal(event.sessionWebhook, "https://dingding.example.test/webhook");
  assert.equal(event.conversationType, "IM_ROBOT");
});

test("control plane chat gateway records default bridge send misses", async () => {
  const bridge = {
    id: "chat_wechat_default_miss",
    channel: "wechat",
    name: "WeChat Default Miss",
    enabled: true,
    token: "wechat-token",
    tokenSet: true,
    defaultChatId: "wechat-chat",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {},
  };
  let listPendingCalls = 0;
  const runtime = new ControlPlaneChatGatewayRuntime(
    {
      listChatBridges: () => [bridge],
      requireChatBridge: () => bridge,
      listPendingRoutes: async () => {
        listPendingCalls += 1;
        return [{
          id: "route_1",
          projectId: "proj_1",
          instanceId: "inst_1",
          kind: "approval",
          result: "Approve command",
        }];
      },
      pendingDecisionCallbackData: (_routeId, decision) => `task_handoff:approval:route_1:${decision}`,
    },
    async () => {
      return new Response(JSON.stringify({ errcode: 0, msgs: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  try {
    await runtime.pollPendingRoutes();
    await runtime.pollPendingRoutes();

    const status = runtime.status();
    assert.equal(status.bridges.find((item) => item.id === bridge.id).error, "Chat bridge message was not delivered.");
    assert.equal(listPendingCalls, 2);
  } finally {
    runtime.stopAll();
  }
});

test("control plane chat gateway keeps default bridge send errors", async () => {
  const bridge = {
    id: "chat_telegram_default_error",
    channel: "telegram",
    name: "Telegram Default Error",
    enabled: true,
    token: "telegram-token",
    tokenSet: true,
    defaultChatId: "telegram-chat",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {},
  };
  const runtime = new ControlPlaneChatGatewayRuntime(
    {
      listChatBridges: () => [bridge],
      requireChatBridge: () => bridge,
      listPendingRoutes: async () => [{
        id: "route_1",
        projectId: "proj_1",
        instanceId: "inst_1",
        kind: "approval",
        result: "Approve command",
      }],
      pendingDecisionCallbackData: (_routeId, decision) => `task_handoff:approval:route_1:${decision}`,
    },
    async () => {
      throw new Error("telegram send failed");
    },
  );

  try {
    await runtime.pollPendingRoutes();

    const status = runtime.status();
    assert.equal(status.bridges.find((item) => item.id === bridge.id).error, "telegram send failed");
  } finally {
    runtime.stopAll();
  }
});

test("control plane dingding progress webhook fallback is delivered once", async () => {
  const calls = [];
  const events = new ControlPlaneEventBus();
  const bridge = {
    id: "chat_dingding_progress_webhook_fallback",
    channel: "dingding",
    name: "DingDing Progress Webhook Fallback",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "dingding-chat",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {
      clientSecret: "dingding-secret",
      sessionWebhook: "https://dingding.example.test/webhook",
    },
  };
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    listChatSessions: () => [{
      id: "dingding:chat",
      channel: "dingding",
      bridgeId: bridge.id,
      chatSessionId: "dingding-chat",
      activeInstanceId: "inst_1",
      activeAiSessionId: "ais_1",
    }],
    boardAsync: async () => [{ id: "inst_1", name: "instance-main" }],
    listPendingRoutes: async () => [],
  };
  class FakeDingdingClient {
    registerCallbackListener() {}
    async connect() {}
    disconnect() {}
    socketCallBackResponse() {}
  }
  const runtime = new ControlPlaneChatGatewayRuntime(
    service,
    async (url, init = {}) => {
      calls.push({
        type: "fetch",
        url: String(url),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    aiSessionGatewayOptions(events, {
      createDingdingClient: () => new FakeDingdingClient(),
    }),
  );

  try {
    runtime.startBridge(bridge.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    publishAiSessionSnapshotForTest(events, {
      runningCount: 1,
      waitingCount: 0,
      staleCount: 0,
      updatedAt: "2026-07-03T00:00:05.000Z",
      sessions: [{
        id: "ais_1",
        agent: "codex",
        activeTurnId: "turn_1",
        status: "running",
        phase: "thinking",
        currentTool: { name: "shell", inputPreview: "npm test" },
        turns: [{ id: "turn_1", userPrompt: "run tests", updatedAt: "2026-07-03T00:00:05.000Z" }],
        startedAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:00:05.000Z",
      }],
    }, {
      scope: { instanceId: "inst_1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(calls.filter((call) => call.url === "https://dingding.example.test/webhook").length, 1);
    assert.equal(calls.some((call) => call.url.includes("/card/instances/createAndDeliver")), false);
  } finally {
    runtime.stopAll();
  }
});

test("control plane dingding progress treats API business errors as failures", async () => {
  const calls = [];
  const events = new ControlPlaneEventBus();
  const bridge = {
    id: "chat_dingding_progress_api_error",
    channel: "dingding",
    name: "DingDing Progress API Error",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "dingding-chat",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {
      clientSecret: "dingding-secret",
      robotCode: "robot-code",
      senderId: "staff-1",
    },
  };
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    listChatSessions: () => [{
      id: "dingding:chat",
      channel: "dingding",
      bridgeId: bridge.id,
      chatSessionId: "dingding-chat",
      activeInstanceId: "inst_1",
      activeAiSessionId: "ais_1",
    }],
    boardAsync: async () => [{ id: "inst_1", name: "instance-main" }],
    listPendingRoutes: async () => [],
  };
  class FakeDingdingClient {
    registerCallbackListener() {}
    async connect() {}
    disconnect() {}
    socketCallBackResponse() {}
  }
  const runtime = new ControlPlaneChatGatewayRuntime(
    service,
    async (url, init = {}) => {
      calls.push({
        type: "fetch",
        url: String(url),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      if (String(url).includes("/oauth2/accessToken")) {
        return new Response(JSON.stringify({ accessToken: "access-token", expireIn: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: false, code: "InvalidParameter", message: "bad card" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    aiSessionGatewayOptions(events, {
      createDingdingClient: () => new FakeDingdingClient(),
    }),
  );

  try {
    runtime.startBridge(bridge.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const payload = {
      runningCount: 1,
      waitingCount: 0,
      staleCount: 0,
      updatedAt: "2026-07-03T00:00:05.000Z",
      sessions: [{
        id: "ais_1",
        agent: "codex",
        activeTurnId: "turn_1",
        status: "running",
        phase: "thinking",
        currentTool: { name: "shell", inputPreview: "npm test" },
        turns: [{ id: "turn_1", userPrompt: "run tests", updatedAt: "2026-07-03T00:00:05.000Z" }],
        startedAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-03T00:00:05.000Z",
      }],
    };
    publishAiSessionSnapshotForTest(events, payload, { scope: { instanceId: "inst_1" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    publishAiSessionSnapshotForTest(events, payload, { scope: { instanceId: "inst_1" } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(calls.filter((call) => call.url.includes("/card/instances/createAndDeliver")).length, 2);
  } finally {
    runtime.stopAll();
  }
});

test("control plane dingding bridge renders ai session progress as cards", async () => {
  const calls = [];
  const events = new ControlPlaneEventBus();
  let fakeClient;
  const bridge = {
    id: "chat_dingding_progress",
    channel: "dingding",
    name: "DingDing Progress",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "dingding-chat",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {
      clientSecret: "dingding-secret",
      robotCode: "robot-code",
      senderId: "staff-1",
      sessionWebhook: "https://dingding.example.test/webhook",
    },
  };
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    listChatSessions: () => [{
      id: "dingding:chat",
      channel: "dingding",
      bridgeId: bridge.id,
      chatSessionId: "dingding-chat",
      activeInstanceId: "inst_1",
      activeAiSessionId: "ais_1",
    }],
    boardAsync: async () => [{
      id: "inst_1",
      name: "instance-main",
    }],
    listAiSessions: async () => {
      throw new Error("listAiSessions should not be used for event delivery");
    },
    listPendingRoutes: async () => [],
  };
  class FakeDingdingClient {
    constructor() {
      this.listeners = new Map();
    }

    registerCallbackListener(topic, listener) {
      this.listeners.set(topic, listener);
    }

    async connect() {}

    disconnect() {}

    socketCallBackResponse() {}
  }
  const runtime = new ControlPlaneChatGatewayRuntime(
    service,
    async (url, init = {}) => {
      calls.push({
        type: "fetch",
        url: String(url),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      if (String(url).includes("/oauth2/accessToken")) {
        return new Response(JSON.stringify({ accessToken: "access-token", expireIn: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    aiSessionGatewayOptions(events, {
      createDingdingClient: () => {
        fakeClient = new FakeDingdingClient();
        return fakeClient;
      },
    }),
  );

  runtime.startBridge(bridge.id);
  await new Promise((resolve) => setTimeout(resolve, 0));

  publishAiSessionSnapshotForTest(events, {
    runningCount: 1,
    waitingCount: 0,
    staleCount: 0,
    updatedAt: "2026-07-03T00:00:05.000Z",
    sessions: [{
      id: "ais_1",
      agent: "codex",
      activeTurnId: "turn_1",
      status: "running",
      phase: "thinking",
      currentTool: {
        name: "shell",
        inputPreview: "npm test",
      },
      turns: [{
        id: "turn_1",
        userPrompt: "run tests",
        updatedAt: "2026-07-03T00:00:05.000Z",
      }],
      startedAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:05.000Z",
    }],
  }, {
    scope: { instanceId: "inst_1" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const cardCreate = calls.find((call) => call.type === "fetch" && call.url.includes("/card/instances/createAndDeliver"));
  assert.ok(cardCreate);
  assert.equal(cardCreate.body.userId, "staff-1");
  const cardParams = cardCreate.body.cardData.cardParamMap;
  assert.equal(cardParams.biz_step, "progress");
  assert.equal(cardParams.biz_conversation_id, "dingding-chat");
  assert.match(cardParams.description, /Thinking\.\.\. · shell · npm test/);
  assert.match(cardParams.list, /Cancel/);
  assert.equal(calls.some((call) => call.url === "https://dingding.example.test/webhook"), false);

  runtime.stopAll();
});

test("control plane dingding progress cards update when only actions change", async () => {
  const calls = [];
  const events = new ControlPlaneEventBus();
  const bridge = {
    id: "chat_dingding_progress_actions",
    channel: "dingding",
    name: "DingDing Progress Actions",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "dingding-chat",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {
      clientSecret: "dingding-secret",
      robotCode: "robot-code",
      senderId: "staff-1",
      sessionWebhook: "https://dingding.example.test/webhook",
    },
  };
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    listChatSessions: () => [{
      id: "dingding:chat",
      channel: "dingding",
      bridgeId: bridge.id,
      chatSessionId: "dingding-chat",
      activeInstanceId: "inst_1",
      activeAiSessionId: "ais_1",
    }],
    boardAsync: async () => [{
      id: "inst_1",
      name: "instance-main",
    }],
    listAiSessions: async () => {
      throw new Error("listAiSessions should not be used for event delivery");
    },
    listPendingRoutes: async () => [],
    pendingDecisionCallbackData: (_routeId, decision) => `task_handoff:cp_p:${decision}_token`,
  };
  class FakeDingdingClient {
    registerCallbackListener() {}
    async connect() {}
    disconnect() {}
    socketCallBackResponse() {}
  }
  const runtime = new ControlPlaneChatGatewayRuntime(
    service,
    async (url, init = {}) => {
      calls.push({
        type: "fetch",
        url: String(url),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      if (String(url).includes("/oauth2/accessToken")) {
        return new Response(JSON.stringify({ accessToken: "access-token", expireIn: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    aiSessionGatewayOptions(events, {
      createDingdingClient: () => new FakeDingdingClient(),
    }),
  );

  runtime.startBridge(bridge.id);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const session = {
    id: "ais_1",
    agent: "codex",
    activeTurnId: "turn_1",
    status: "running",
    phase: "thinking",
    currentTool: {
      name: "shell",
      inputPreview: "npm test",
    },
    turns: [{
      id: "turn_1",
      userPrompt: "run tests",
      updatedAt: "2026-07-03T00:00:05.000Z",
    }],
    startedAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:05.000Z",
  };

  publishAiSessionSnapshotForTest(events, {
    runningCount: 1,
    waitingCount: 0,
    staleCount: 0,
    updatedAt: "2026-07-03T00:00:05.000Z",
    sessions: [session],
  }, {
    scope: { instanceId: "inst_1" },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const cardCreate = calls.find((call) => call.type === "fetch" && call.url.includes("/card/instances/createAndDeliver"));
  assert.ok(cardCreate);
  assert.match(cardCreate.body.cardData.cardParamMap.list, /Cancel/);
  assert.equal(calls.some((call) => call.url === "https://dingding.example.test/webhook"), false);

  service.listPendingRoutes = async () => [{
    id: "inst_1:ai:ais_1",
    projectId: "proj_1",
    instanceId: "inst_1",
    aiSessionId: "ais_1",
    kind: "approval",
    result: "Approve command: npm test",
  }];
  publishAiSessionSnapshotForTest(events, {
    runningCount: 0,
    waitingCount: 1,
    staleCount: 0,
    updatedAt: "2026-07-03T00:00:05.000Z",
    sessions: [{ ...session, status: "waiting", phase: "approval" }],
  }, {
    scope: { instanceId: "inst_1" },
  });
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const cardUpdate = calls.find((call) => call.type === "fetch" && call.body?.cardUpdateOptions && call.body?.outTrackId === cardCreate.body.outTrackId);
  assert.ok(cardUpdate);
  assert.match(cardUpdate.body.cardData.cardParamMap.description, /Thinking\.\.\. · shell · npm test/);
  assert.match(cardUpdate.body.cardData.cardParamMap.list, /Allow/);
  assert.match(cardUpdate.body.cardData.cardParamMap.list, /Deny/);

  runtime.stopAll();
});

test("control plane dingding routed ai session ack starts progress card", async () => {
  const calls = [];
  const events = new ControlPlaneEventBus();
  const bridge = {
    id: "chat_dingding_routed_ack",
    channel: "dingding",
    name: "DingDing Routed Ack",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {
      clientSecret: "dingding-secret",
      robotCode: "robot-code",
      senderId: "staff-1",
    },
  };
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    updateChatBridge: (_id, patch) => {
      if (patch.defaultChatId) {
        bridge.defaultChatId = patch.defaultChatId;
      }
    },
    handleChatGatewayMessage: async (message) => ({
      accepted: true,
      routed: true,
      binding: {
        id: "dingding:chat",
        channel: "dingding",
        bridgeId: bridge.id,
        chatSessionId: message.source.chatSessionId,
        activeInstanceId: "inst_1",
        activeAiSessionId: "ais_1",
      },
      instance: { id: "inst_1" },
      aiSession: {
        session: {
          id: "ais_1",
          agent: "codex",
          activeTurnId: "turn_1",
          status: "running",
          phase: "thinking",
          turns: [{
            id: "turn_1",
            userPrompt: message.message.text,
            updatedAt: "2026-07-03T00:00:00.000Z",
          }],
          updatedAt: "2026-07-03T00:00:00.000Z",
        },
        provider: "codex",
        action: "send",
      },
      turnId: "turn_1",
      providerTurnId: "turn_1",
      reply: "Sent to work / inst_1 / ais_1.",
    }),
    listChatSessions: () => [{
      id: "dingding:chat",
      channel: "dingding",
      bridgeId: bridge.id,
      chatSessionId: "dingding-chat",
      activeInstanceId: "inst_1",
      activeAiSessionId: "ais_1",
    }],
    boardAsync: async () => [{ id: "inst_1", name: "instance-main" }],
    listAiSessions: async () => {
      throw new Error("listAiSessions should not be used for event delivery");
    },
    listPendingRoutes: async () => [],
    pendingDecisionCallbackData: (_routeId, decision) => `task_handoff:cp_p:${decision}_token`,
  };
  const listeners = new Map();
  class FakeDingdingClient {
    registerCallbackListener(topic, listener) {
      listeners.set(topic, listener);
    }
    async connect() {}
    disconnect() {}
    socketCallBackResponse() {}
  }
  const runtime = new ControlPlaneChatGatewayRuntime(
    service,
    async (url, init = {}) => {
      calls.push({
        type: "fetch",
        url: String(url),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      if (String(url).includes("/oauth2/accessToken")) {
        return new Response(JSON.stringify({ accessToken: "access-token", expireIn: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    aiSessionGatewayOptions(events, {
      createDingdingClient: () => new FakeDingdingClient(),
    }),
  );

  runtime.startBridge(bridge.id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  listeners.get("/v1.0/im/bot/messages/get")({
    headers: { messageId: "msg-1" },
    data: JSON.stringify({
      conversationId: "dingding-chat",
      conversationType: "2",
      senderStaffId: "staff-1",
      sessionWebhook: "https://dingding.example.test/webhook",
      text: { content: "你好" },
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const cardCreate = calls.find((call) => call.type === "fetch" && call.url.includes("/card/instances/createAndDeliver"));
  assert.ok(cardCreate);
  assert.match(cardCreate.body.cardData.cardParamMap.description, /Sent to work/);
  assert.equal(calls.some((call) => call.url === "https://dingding.example.test/webhook"), false);

  publishAiSessionSnapshotForTest(events, {
    runningCount: 0,
    waitingCount: 0,
    staleCount: 0,
    updatedAt: "2026-07-03T00:00:03.000Z",
    sessions: [{
      id: "ais_1",
      agent: "codex",
      status: "idle",
      phase: "unknown",
      turns: [{
        id: "turn_1",
        userPrompt: "你好",
        lastMessage: "你好。需要我做什么？",
        updatedAt: "2026-07-03T00:00:03.000Z",
      }],
      startedAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:03.000Z",
    }],
  }, { scope: { instanceId: "inst_1" } });
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const cardUpdate = calls.find((call) => call.type === "fetch" && call.body?.cardUpdateOptions);
  assert.ok(cardUpdate);
  assert.equal(cardUpdate.body.outTrackId, cardCreate.body.outTrackId);
  assert.match(cardUpdate.body.cardData.cardParamMap.description, /需要我做什么/);
  assert.equal(calls.filter((call) => call.url.includes("/card/instances/createAndDeliver")).length, 1);
  assert.equal(calls.some((call) => call.url === "https://dingding.example.test/webhook"), false);

  runtime.stopAll();
});

test("control plane dingding throttled progress update failures can retry", async () => {
  const calls = [];
  const events = new ControlPlaneEventBus();
  const bridge = {
    id: "chat_dingding_progress_update_retry",
    channel: "dingding",
    name: "DingDing Progress Update Retry",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "dingding-chat",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {
      clientSecret: "dingding-secret",
      robotCode: "robot-code",
      senderId: "staff-1",
    },
  };
  const service = {
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    listChatSessions: () => [{
      id: "dingding:chat",
      channel: "dingding",
      bridgeId: bridge.id,
      chatSessionId: "dingding-chat",
      activeInstanceId: "inst_1",
      activeAiSessionId: "ais_1",
    }],
    boardAsync: async () => [{ id: "inst_1", name: "instance-main" }],
    listPendingRoutes: async () => [],
    pendingDecisionCallbackData: (_routeId, decision) => `task_handoff:cp_p:${decision}_token`,
  };
  class FakeDingdingClient {
    registerCallbackListener() {}
    async connect() {}
    disconnect() {}
    socketCallBackResponse() {}
  }
  const runtime = new ControlPlaneChatGatewayRuntime(
    service,
    async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ type: "fetch", url: String(url), body });
      if (String(url).includes("/oauth2/accessToken")) {
        return new Response(JSON.stringify({ accessToken: "access-token", expireIn: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (body?.cardUpdateOptions && calls.filter((call) => call.body?.cardUpdateOptions).length === 1) {
        return new Response(JSON.stringify({ success: false, code: "InvalidParameter", message: "bad update" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    aiSessionGatewayOptions(events, {
      createDingdingClient: () => new FakeDingdingClient(),
    }),
  );

  try {
    runtime.startBridge(bridge.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const session = {
      id: "ais_1",
      agent: "codex",
      activeTurnId: "turn_1",
      status: "running",
      phase: "thinking",
      currentTool: { name: "shell", inputPreview: "npm test" },
      turns: [{ id: "turn_1", userPrompt: "run tests", updatedAt: "2026-07-03T00:00:05.000Z" }],
      startedAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:05.000Z",
    };

    publishAiSessionSnapshotForTest(events, {
      runningCount: 1,
      waitingCount: 0,
      staleCount: 0,
      updatedAt: "2026-07-03T00:00:05.000Z",
      sessions: [session],
    }, { scope: { instanceId: "inst_1" } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    service.listPendingRoutes = async () => [{
      id: "inst_1:ai:ais_1",
      projectId: "proj_1",
      instanceId: "inst_1",
      aiSessionId: "ais_1",
      kind: "approval",
      result: "Approve command: npm test",
    }];
    const waitingPayload = {
      runningCount: 0,
      waitingCount: 1,
      staleCount: 0,
      updatedAt: "2026-07-03T00:00:06.000Z",
      sessions: [{ ...session, status: "waiting", phase: "approval" }],
    };
    publishAiSessionSnapshotForTest(events, waitingPayload, { scope: { instanceId: "inst_1" } });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    publishAiSessionSnapshotForTest(events, waitingPayload, { scope: { instanceId: "inst_1" } });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.equal(calls.filter((call) => call.body?.cardUpdateOptions).length, 2);
  } finally {
    runtime.stopAll();
  }
});

test("control plane dingding progress clear rejects throttled updates", async () => {
  const calls = [];
  const bridge = {
    id: "chat_dingding_progress_clear",
    channel: "dingding",
    name: "DingDing Progress Clear",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "dingding-chat",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {
      clientSecret: "dingding-secret",
      robotCode: "robot-code",
      senderId: "staff-1",
    },
  };
  const runtimeState = {
    client: {
      connect: async () => {},
      disconnect: () => {},
      registerCallbackListener: () => {},
      socketCallBackResponse: () => {},
    },
    chatWebhooks: new Map(),
    senderIds: new Map([["dingding-chat", "staff-1"]]),
  };
  const store = new DingdingProgressStore(async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url).includes("/oauth2/accessToken")) {
      return new Response(JSON.stringify({ accessToken: "access-token", expireIn: 7200 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await store.applyUpdate({
    bridge,
    key: "inst_1:ais_1:turn_1:chat_dingding_progress_clear:dingding-chat",
    chatId: "dingding-chat",
    text: "Running shell",
    replyMarkup: { inline_keyboard: [[{ text: "Cancel", callback_data: "cancel" }]] },
  }, runtimeState);
  const pending = store.applyUpdate({
    bridge,
    key: "inst_1:ais_1:turn_1:chat_dingding_progress_clear:dingding-chat",
    chatId: "dingding-chat",
    text: "Waiting for approval",
    replyMarkup: { inline_keyboard: [[{ text: "Allow", callback_data: "allow" }]] },
  }, runtimeState);
  store.clearBridge(bridge.id);

  await assert.rejects(pending, /cancelled/);
  assert.equal(calls.filter((call) => call.body?.cardUpdateOptions).length, 0);
});

test("control plane dingding progress ignores an in-flight delivery after bridge stop", async () => {
  let resolveDelivery;
  let deliveryStarted = false;
  const bridge = {
    id: "chat_dingding_progress_inflight",
    channel: "dingding",
    name: "DingDing In-flight",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "dingding-chat",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: { clientSecret: "dingding-secret", robotCode: "robot-code", senderId: "staff-1" },
  };
  const runtimeState = {
    client: { connect: async () => {}, disconnect: () => {}, registerCallbackListener: () => {}, socketCallBackResponse: () => {} },
    chatWebhooks: new Map(), senderIds: new Map(), conversationTypes: new Map(),
  };
  const store = new DingdingProgressStore(async (url) => {
    if (String(url).includes("/oauth2/accessToken")) {
      return new Response(JSON.stringify({ accessToken: "access-token", expireIn: 7200 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    deliveryStarted = true;
    await new Promise((resolve) => { resolveDelivery = resolve; });
    return new Response(JSON.stringify({ success: true, result: { outTrackId: "track-inflight" } }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const pending = store.applyUpdate({
    bridge,
    key: "inst_1:ais_1:turn_1:chat_dingding_progress_inflight:dingding-chat",
    chatId: "dingding-chat",
    text: "Running shell",
  }, runtimeState);
  while (!deliveryStarted) await new Promise((resolve) => setImmediate(resolve));
  store.clearBridge(bridge.id);
  resolveDelivery();
  assert.equal(await pending, false);
  assert.equal(store.entries.size, 0);
});

test("dingding runtime stop cancels manager-owned reconnect after socket close", async () => {
  let onDisconnect;
  let connectAttempts = 0;
  const bridge = {
    id: "chat_dingding_disconnect",
    channel: "dingding",
    name: "DingDing Disconnect",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "dingding-chat",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: { clientSecret: "dingding-secret" },
  };
  const manager = new DingdingBridgeRuntimeManager({
    fetchImpl: fetch,
    createClient: () => ({
      connect: async () => { connectAttempts += 1; },
      disconnect: () => {},
      onDisconnect: (listener) => { onDisconnect = listener; },
      registerCallbackListener: () => {},
      socketCallBackResponse: () => {},
    }),
    logger: { info: () => {}, warn: () => {} },
    onRobotMessage: async () => {}, onCardCallback: async () => ({}), onError: () => {}, clearError: () => {},
    reconnectDelayMs: 40,
  });
  manager.start(bridge);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.isRunning(bridge.id), true);
  onDisconnect(new Error("socket closed"));
  assert.equal(manager.isRunning(bridge.id), false);
  manager.stop(bridge.id);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(connectAttempts, 1);
  assert.equal(manager.has(bridge.id), false);
});

test("invalid dingding bridge does not start pending polling", () => {
  const bridge = {
    id: "chat_dingding_invalid",
    channel: "dingding",
    name: "DingDing Invalid",
    enabled: true,
    token: "",
    tokenSet: false,
    defaultChatId: "",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {},
  };
  const runtime = new ControlPlaneChatGatewayRuntime({
    listChatBridges: () => [bridge], requireChatBridge: () => bridge, listPendingRoutes: async () => [],
  }, fetch);
  const status = runtime.startBridge(bridge.id);
  assert.equal(status.bridges[0].running, false);
  runtime.startEnabled();
  runtime.stopAll();
});

test("enabled chat bridges rely on AI session snapshot events instead of pending-route polling", () => {
  const bridge = {
    id: "chat_telegram_events",
    channel: "telegram",
    name: "Telegram Events",
    enabled: true,
    token: "telegram-token",
    tokenSet: true,
    defaultChatId: "chat-1",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {},
  };
  let pendingRouteReads = 0;
  const runtime = new ControlPlaneChatGatewayRuntime({
    listChatBridges: () => [bridge],
    requireChatBridge: () => bridge,
    listPendingRoutes: async () => {
      pendingRouteReads += 1;
      return [];
    },
  }, async () => new Response(JSON.stringify({ ok: true, result: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));

  runtime.startEnabled();
  assert.equal(runtime.status().bridges[0].running, true);
  assert.equal(pendingRouteReads, 0);
  runtime.stopAll();
});

test("dingding runtime rejection clears pending progress and retries under manager control", async () => {
  let rejectConnect;
  let clientCount = 0;
  let connectAttempts = 0;
  const bridge = {
    id: "chat_dingding_runtime_reject",
    channel: "dingding",
    name: "DingDing Runtime Reject",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "dingding-chat",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: { clientSecret: "dingding-secret", robotCode: "robot-code", senderId: "staff-1" },
  };
  const manager = new DingdingBridgeRuntimeManager({
    fetchImpl: async (url) => new Response(JSON.stringify(String(url).includes("/oauth2/accessToken")
      ? { accessToken: "access-token", expireIn: 7200 }
      : { success: true }), { status: 200, headers: { "content-type": "application/json" } }),
    createClient: () => {
      clientCount += 1;
      return {
        connect: () => ++connectAttempts === 1
          ? new Promise((_resolve, reject) => { rejectConnect = reject; })
          : Promise.resolve(),
        disconnect: () => {},
        registerCallbackListener: () => {},
        socketCallBackResponse: () => {},
      };
    },
    logger: { info: () => {}, warn: () => {} },
    onRobotMessage: async () => {},
    onCardCallback: async () => ({}),
    onError: () => {},
    clearError: () => {},
    reconnectDelayMs: 50,
  });

  assert.equal(manager.start(bridge), true);
  const update = {
    bridge,
    key: "inst_1:ais_1:turn_1:chat_dingding_runtime_reject:dingding-chat",
    chatId: "dingding-chat",
    text: "Running shell",
    replyMarkup: { inline_keyboard: [[{ text: "Cancel", callback_data: "cancel" }]] },
  };
  assert.equal(await manager.applyProgressUpdate(update), true);
  const pending = manager.applyProgressUpdate({ ...update, text: "Waiting for approval" });
  rejectConnect(new Error("connect rejected"));
  await assert.rejects(pending, /cancelled/);
  assert.equal(manager.has(bridge.id), true);
  assert.equal(manager.isRunning(bridge.id), false);

  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(clientCount, 1);
  assert.equal(connectAttempts, 2);
  assert.equal(manager.has(bridge.id), true);
  assert.equal(manager.isRunning(bridge.id), true);
  manager.stopAll();
  assert.equal(manager.has(bridge.id), false);
});

test("control plane dingding action cards use robot private-chat delivery target", async () => {
  const calls = [];
  const bridge = {
    id: "chat_dingding_single",
    channel: "dingding",
    name: "DingDing Single",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "single-chat",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {
      clientSecret: "dingding-secret",
      robotCode: "robot-code",
      senderId: "staff-1",
    },
  };
  const runtimeState = {
    client: {
      connect: async () => {},
      disconnect: () => {},
      registerCallbackListener: () => {},
      socketCallBackResponse: () => {},
    },
    chatWebhooks: new Map(),
    senderIds: new Map([["single-chat", "staff-1"]]),
    conversationTypes: new Map([["single-chat", "IM_ROBOT"]]),
  };

  await sendDingdingActionsCard({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
      if (String(url).includes("/oauth2/accessToken")) {
        return new Response(JSON.stringify({ accessToken: "access-token", expireIn: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    bridge,
    runtime: runtimeState,
    chatId: "single-chat",
    text: "Select AI session",
    replyMarkup: { inline_keyboard: [[{ text: "Session 1", callback_data: "task_handoff:cp_session:1" }]] },
  });

  const deliver = calls.find((call) => String(call.url).includes("/v1.0/card/instances/createAndDeliver"));
  assert.ok(deliver);
  assert.equal(deliver.body.openSpaceId, "dtv1.card//IM_ROBOT.staff-1");
  assert.deepEqual(deliver.body.imRobotOpenSpaceModel, { supportForward: false });
  assert.deepEqual(deliver.body.imRobotOpenDeliverModel, { extension: {}, robotCode: "robot-code", spaceType: "IM_ROBOT" });
  assert.equal(deliver.body.imSingleOpenSpaceModel, undefined);
  assert.equal(deliver.body.imSingleOpenDeliverModel, undefined);
  assert.equal(deliver.body.imGroupOpenSpaceModel, undefined);
  assert.equal(deliver.body.imGroupOpenDeliverModel, undefined);
  assert.equal(deliver.body.cardData.cardParamMap.biz_conversation_type, "IM_ROBOT");
});

test("control plane dingding action cards reject failed delivery results", async () => {
  const bridge = {
    id: "chat_dingding_delivery_failure",
    channel: "dingding",
    name: "DingDing Delivery Failure",
    enabled: true,
    token: "dingding-client-id",
    tokenSet: true,
    defaultChatId: "single-chat",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {
      clientSecret: "dingding-secret",
      robotCode: "robot-code",
      senderId: "staff-1",
    },
  };
  const runtimeState = {
    client: {
      connect: async () => {},
      disconnect: () => {},
      registerCallbackListener: () => {},
      socketCallBackResponse: () => {},
    },
    chatWebhooks: new Map(),
    senderIds: new Map([["single-chat", "staff-1"]]),
    conversationTypes: new Map([["single-chat", "IM_SINGLE"]]),
  };

  await assert.rejects(
    () => sendDingdingActionsCard({
      fetchImpl: async (url) => {
        if (String(url).includes("/oauth2/accessToken")) {
          return new Response(JSON.stringify({ accessToken: "access-token", expireIn: 7200 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          success: true,
          result: {
            deliverResults: [{ spaceId: "IM_ALL", spaceType: "IM", success: false, errorMsg: "spaces of card is empty" }],
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      bridge,
      runtime: runtimeState,
      chatId: "single-chat",
      text: "Select AI session",
      replyMarkup: { inline_keyboard: [[{ text: "Session 1", callback_data: "task_handoff:cp_session:1" }]] },
    }),
    /DingDing card delivery failed for IM_ALL: spaces of card is empty/,
  );
});

test("control plane chat gateway does not duplicate ai session pending notifications", async () => {
  const calls = [];
  const bridgeA = {
    id: "chat_telegram_a",
    channel: "telegram",
    name: "Telegram A",
    enabled: true,
    token: "token-a",
    tokenSet: true,
    defaultChatId: "fallback-a",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {},
  };
  const bridgeB = {
    id: "chat_telegram_b",
    channel: "telegram",
    name: "Telegram B",
    enabled: true,
    token: "token-b",
    tokenSet: true,
    defaultChatId: "fallback-b",
    allowedUserIds: [],
    pollIntervalMs: 30000,
    settings: {},
  };
  const bridges = new Map([
    [bridgeA.id, bridgeA],
    [bridgeB.id, bridgeB],
  ]);
  const runtime = new ControlPlaneChatGatewayRuntime(
    {
      listChatBridges: () => [bridgeA, bridgeB],
      requireChatBridge: (id) => bridges.get(id),
      listChatSessions: () => [
        {
          id: "binding-a",
          channel: "telegram",
          bridgeId: bridgeA.id,
          chatSessionId: "chat-a",
          activeInstanceId: "inst_1",
          activeAiSessionId: "ais_1",
        },
        {
          id: "binding-b",
          channel: "telegram",
          bridgeId: bridgeB.id,
          chatSessionId: "chat-b",
          activeInstanceId: "inst_1",
          activeAiSessionId: "ais_1",
        },
      ],
      listPendingRoutes: async () => [
        {
          id: "inst_1:ai:ais_1",
          projectId: "proj_1",
          instanceId: "inst_1",
          aiSessionId: "ais_1",
          kind: "approval",
          result: "Approve command: npm test",
        },
      ],
      pendingDecisionCallbackData: (_routeId, decision) => `task_handoff:cp_p:${decision}_token`,
    },
    async (url, init = {}) => {
      calls.push({
        url: String(url),
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  await runtime.pollPendingRoutes();

  assert.deepEqual(
    calls.map((call) => [call.url.includes("bottoken-a"), call.url.includes("bottoken-b"), call.body.chat_id]),
    [
      [true, false, "chat-a"],
      [false, true, "chat-b"],
    ],
  );
  assert.match(calls[0].body.text, /npm test/);
  for (const call of calls) {
    const callbackData = call.body.reply_markup.inline_keyboard.flatMap((row) => row.map((button) => button.callback_data));
    assert.deepEqual(callbackData, [
      "task_handoff:cp_p:allow_token",
      "task_handoff:cp_p:skip_token",
      "task_handoff:cp_p:deny_token",
    ]);
    for (const value of callbackData) {
      assert.ok(Buffer.byteLength(value, "utf8") <= 64);
    }
  }

  calls.length = 0;

  runtime.service.listPendingRoutes = async () => [
    {
      id: "task_1",
      projectId: "proj_1",
      instanceId: "inst_1",
      kind: "approval",
      result: "Approve command: npm test",
    },
  ];

  await runtime.pollPendingRoutes();

  assert.deepEqual(
    calls.map((call) => [call.url.includes("bottoken-a"), call.url.includes("bottoken-b"), call.body.chat_id]),
    [
      [true, false, "fallback-a"],
      [false, true, "fallback-b"],
    ],
  );
  assert.match(calls[0].body.text, /npm test/);
  for (const call of calls) {
    const callbackData = call.body.reply_markup.inline_keyboard.flatMap((row) => row.map((button) => button.callback_data));
    assert.deepEqual(callbackData, [
      "task_handoff:cp_p:allow_token",
      "task_handoff:cp_p:skip_token",
      "task_handoff:cp_p:deny_token",
    ]);
    for (const value of callbackData) {
      assert.ok(Buffer.byteLength(value, "utf8") <= 64);
    }
  }
});

test("control plane aggregates ai session pending routes and proxies ai session actions", async (t) => {
  const requests = [];
  const mock = createMockNodeAgentFetch({
    proxy: ({ url, init, body }) => {
      requests.push({
        url,
        method: init.method || "GET",
        body,
      });
      if (body?.path === "/api/apps/sessions/state") {
        const updatedAt = new Date().toISOString();
        const sessions = [{ id: "app_waiting", appId: "codex", kind: "tty", status: "running" }];
        return new Response(JSON.stringify({ data: { revision: 1, lastEventAt: updatedAt, snapshot: { runningCount: 1, problemCount: 0, sessions, updatedAt } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body?.path === "/api/ai-sessions/state") {
        const updatedAt = new Date().toISOString();
        const sessions = [{ id: "ais_waiting", agent: "codex", appSessionId: "app_waiting", status: "waiting", phase: "approval", summary: "Approve command: npm install", startedAt: updatedAt, updatedAt }];
        return new Response(JSON.stringify({ data: { revision: 1, lastEventAt: updatedAt, snapshot: { runningCount: 0, waitingCount: 1, staleCount: 0, sessions, updatedAt } } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body?.path === "/api/apps/sessions" && body.method === "GET") {
        return new Response(JSON.stringify({ data: [{ id: "app_waiting", appId: "codex", kind: "tty", status: "running" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (body?.path === "/api/ai-sessions/ais_waiting/approval") {
        const timestamp = new Date().toISOString();
        const decision = JSON.parse(body.body).decision;
        return new Response(JSON.stringify({ data: {
          session: { id: "ais_waiting", agent: "codex", status: "waiting", phase: "approval", startedAt: timestamp, updatedAt: timestamp },
          provider: "codex",
          action: "approval",
          decision,
        } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (body?.path === "/api/ai-sessions/ais_waiting/mentions" && body.method === "GET") {
        return new Response(JSON.stringify({ data: {
          sessionId: "ais_waiting",
          providerSessionId: "thread_waiting",
          cwd: "/workspace/exact",
          candidates: [{ kind: "plugin", name: "Exact / Plugin", path: "plugin://exact-plugin" }],
          diagnostics: [{ category: "apps", code: "APP_LIST_PARTIAL", message: "Apps unavailable." }],
        } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body?.path === "/api/ai-sessions/ais_waiting/mentions/files" && body.method === "POST") {
        return new Response(JSON.stringify({ data: {
          sessionId: "ais_waiting",
          cwd: "/workspace/exact",
          query: JSON.parse(body.body).query,
          requestId: "search_proxy",
          candidates: [{ kind: "file", name: "Exact Name.ts", path: "src/Exact Name.ts" }],
          complete: true,
        } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body?.path === "/api/ai-sessions/ais_waiting/messages") {
        const timestamp = new Date().toISOString();
        return new Response(JSON.stringify({ data: {
          session: { id: "ais_waiting", agent: "codex", status: "running", phase: "responding", startedAt: timestamp, updatedAt: timestamp },
          provider: "codex",
          action: "send",
          turnId: "turn_continue",
          providerTurnId: "turn_continue",
        } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (body?.path === "/api/ai-sessions/history" && body.method === "GET") {
        return new Response(JSON.stringify({ data: { items: [{
          id: "ais_history_proxy",
          agent: "claude",
          providerSessionId: "claude_history_proxy",
          title: "Proxy history",
          cwd: "/workspace/proxy",
          lastActiveAt: "2026-07-20T10:00:00.000Z",
          archivedAt: "2026-07-20T10:01:00.000Z",
        }] } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body?.path === "/api/ai-sessions/history/ais_history_proxy" && body.method === "GET") {
        return new Response(JSON.stringify({ data: {
          item: {
            id: "ais_history_proxy",
            agent: "claude",
            providerSessionId: "claude_history_proxy",
            title: "Proxy history",
            cwd: "/workspace/proxy",
            lastActiveAt: "2026-07-20T10:00:00.000Z",
            archivedAt: "2026-07-20T10:01:00.000Z",
          },
          turns: [{ id: "turn_history_proxy", userPrompt: "Proxy prompt", lastMessage: "Proxy answer", status: "completed" }],
        } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body?.path === "/api/ai-sessions/ais_history_proxy/resume" && body.method === "POST") {
        return new Response(JSON.stringify({ data: {
          disposition: "resumed",
          aiSessionId: "ais_history_proxy",
          providerSessionId: "claude_history_proxy",
          appSessionId: "app_history_proxy",
        } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body?.path === "/api/ai-sessions/ais_history_unavailable/resume" && body.method === "POST") {
        return new Response(JSON.stringify({ error: {
          code: "AI_SESSION_RESUME_UNAVAILABLE",
          message: "Provider session no longer exists.",
        } }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { message: "unexpected request" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-pending"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: mock.fetchImpl,
    },
  });
  t.after(() => app.close());

  const project = await json(app, "POST", "/api/projects", {
    name: "Pending Project",
    source: {
      type: "git-repository",
      url: "https://github.com/example/repo.git",
    },
  });
  assert.equal(project.statusCode, 201);

  const created = await json(app, "POST", "/api/controlled-instances", {
    name: "pending-worker",
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
  });
  assert.equal(created.statusCode, 201);

  const registered = await mock.fetchImpl(`http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${created.body.data.registrationToken}`,
    },
    body: JSON.stringify({
      instanceId: created.body.data.id,
      projectId: project.body.data.id,
      target: {
        strategy: "direct-port",
        web: "http://127.0.0.1:18082",
        api: "http://127.0.0.1:18082/api",
        status: "reachable",
      },
      workspace: {
        status: "ready",
      },
    }),
  });
  assert.equal(registered.status, 201);

  await mock.fetchImpl(`http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${created.body.data.registrationToken}`,
    },
    body: JSON.stringify({
      status: "running",
      health: "ok",
      connectionStatus: "online",
      apps: {
        runningCount: 1,
      },
      aiSessions: {
        runningCount: 0,
        waitingCount: 1,
        staleCount: 0,
        updatedAt: new Date().toISOString(),
        sessions: [{
          id: "ais_waiting",
          agent: "codex",
          appSessionId: "app_waiting",
          status: "waiting",
          phase: "approval",
          summary: "Approve command: npm install",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
      },
      target: {
        status: "reachable",
      },
      workspace: {
        status: "ready",
      },
    }),
  });

  const pending = await json(app, "GET", "/api/pending-routes");
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.body.data.length, 1);
  const aiPending = pending.body.data.find((route) => route.aiSessionId === "ais_waiting");
  assert.equal(aiPending.id, `${created.body.data.id}:ai:ais_waiting`);
  assert.equal(aiPending.instanceId, created.body.data.id);
  assert.equal(aiPending.projectId, project.body.data.id);
  assert.equal(aiPending.project.name, "Pending Project");
  assert.equal(aiPending.instance.name, "pending-worker");
  assert.equal(aiPending.kind, "approval");
  assert.match(aiPending.result, /npm install/);

  const mentionCatalog = await json(app, "GET", `/api/controlled-instances/${created.body.data.id}/ai-sessions/ais_waiting/mentions`);
  assert.equal(mentionCatalog.statusCode, 200);
  assert.equal(mentionCatalog.body.data.candidates[0].name, "Exact / Plugin");
  assert.equal(mentionCatalog.body.data.candidates[0].path, "plugin://exact-plugin");
  const mentionFiles = await json(app, "POST", `/api/controlled-instances/${created.body.data.id}/ai-sessions/ais_waiting/mentions/files`, { query: "Exact Name" });
  assert.equal(mentionFiles.statusCode, 200);
  assert.equal(mentionFiles.body.data.candidates[0].path, "src/Exact Name.ts");
  const references = [{ kind: "plugin", name: "Exact / Plugin", path: "plugin://exact-plugin" }];
  const mentionMessage = await json(app, "POST", `/api/controlled-instances/${created.body.data.id}/ai-sessions/ais_waiting/messages`, { message: "Use @Exact", references });
  assert.equal(mentionMessage.statusCode, 200);
  const mentionForwards = requests.filter((request) => request.body.path.includes("/ai-sessions/ais_waiting/")).slice(-3);
  assert.deepEqual(mentionForwards.map((request) => [request.body.method, request.body.path, request.body.body ? JSON.parse(request.body.body) : undefined]), [
    ["GET", "/api/ai-sessions/ais_waiting/mentions", undefined],
    ["POST", "/api/ai-sessions/ais_waiting/mentions/files", { query: "Exact Name" }],
    ["POST", "/api/ai-sessions/ais_waiting/messages", { message: "Use @Exact", references, permissionMode: "ask" }],
  ]);

  const history = await json(app, "GET", `/api/controlled-instances/${created.body.data.id}/ai-sessions/history`);
  assert.equal(history.statusCode, 200);
  assert.deepEqual(history.body.data.items.map((item) => [item.id, item.providerSessionId]), [["ais_history_proxy", "claude_history_proxy"]]);
  const historyDetail = await json(app, "GET", `/api/controlled-instances/${created.body.data.id}/ai-sessions/history/ais_history_proxy`);
  assert.equal(historyDetail.statusCode, 200);
  assert.deepEqual(historyDetail.body.data.turns.map((turn) => [turn.id, turn.userPrompt, turn.lastMessage]), [["turn_history_proxy", "Proxy prompt", "Proxy answer"]]);
  const resumed = await json(app, "POST", `/api/controlled-instances/${created.body.data.id}/ai-sessions/ais_history_proxy/resume`, {});
  assert.equal(resumed.statusCode, 200);
  assert.deepEqual(resumed.body.data, {
    disposition: "resumed",
    aiSessionId: "ais_history_proxy",
    providerSessionId: "claude_history_proxy",
    appSessionId: "app_history_proxy",
  });
  const historyForwards = requests.filter((request) => request.body.path === "/api/ai-sessions/history" || request.body.path === "/api/ai-sessions/history/ais_history_proxy" || request.body.path === "/api/ai-sessions/ais_history_proxy/resume");
  assert.deepEqual(historyForwards.map((request) => [request.body.method, request.body.path, request.body.body ? JSON.parse(request.body.body) : undefined]), [
    ["GET", "/api/ai-sessions/history", undefined],
    ["GET", "/api/ai-sessions/history/ais_history_proxy", undefined],
    ["POST", "/api/ai-sessions/ais_history_proxy/resume", {}],
  ]);

  const invalidResume = await json(app, "POST", `/api/controlled-instances/${created.body.data.id}/ai-sessions/ais_history_proxy/resume`, { providerSessionId: "untrusted" });
  assert.equal(invalidResume.statusCode, 400);
  const unavailableResume = await json(app, "POST", `/api/controlled-instances/${created.body.data.id}/ai-sessions/ais_history_unavailable/resume`, {});
  assert.equal(unavailableResume.statusCode, 409);
  assert.equal(unavailableResume.body.error.code, "AI_SESSION_RESUME_UNAVAILABLE");
  const offline = await json(app, "POST", "/api/controlled-instances", {
    name: "offline-history-worker",
    projectId: project.body.data.id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "market_taskhandoff_browser" },
  });
  assert.equal(offline.statusCode, 201);
  const offlineHistory = await json(app, "GET", `/api/controlled-instances/${offline.body.data.id}/ai-sessions/history`);
  assert.equal(offlineHistory.statusCode, 409);
  assert.equal(offlineHistory.body.error.code, "INSTANCE_UNREACHABLE");

  const pendingCommand = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:pending",
      userId: "user-1",
    },
    message: {
      text: "/pending",
      attachments: [],
    },
  });
  assert.equal(pendingCommand.statusCode, 200);
  assert.match(pendingCommand.body.data.reply, new RegExp(`${created.body.data.id}:ai:ais_waiting`));
  const pendingCallbackData = pendingCommand.body.data.replyMarkup.inline_keyboard.map((row) => row[0].callback_data);
  assert.equal(pendingCallbackData.length, 3);
  for (const callbackData of pendingCallbackData) {
    assert.match(callbackData, /^task_handoff:cp_p:v1:[ads]:[A-Za-z0-9_-]{16}$/);
    assert.ok(Buffer.byteLength(callbackData, "utf8") <= 64);
  }

  const aiSkipAction = await app.inject({
    method: "POST",
    url: "/api/chat-gateway/messages",
    payload: {
      source: {
        channel: "telegram",
        chatSessionId: "telegram:pending",
        userId: "user-1",
      },
      message: {
        text: `/skip ${created.body.data.id}:ai:ais_waiting`,
        attachments: [],
      },
    },
  });
  assert.equal(aiSkipAction.statusCode, 200);

  const aiApprovalCommand = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:pending",
      userId: "user-1",
    },
    message: {
      text: `/approve ${created.body.data.id}:ai:ais_waiting`,
      attachments: [],
    },
  });
  assert.equal(aiApprovalCommand.statusCode, 200);
  assert.match(aiApprovalCommand.body.data.reply, /allow sent/);

  const replyCommand = await json(app, "POST", "/api/chat-gateway/messages", {
    source: {
      channel: "telegram",
      chatSessionId: "telegram:pending",
      userId: "user-1",
    },
    message: {
      text: `/reply ${created.body.data.id}:ai:ais_waiting continue`,
      attachments: [],
    },
  });
  assert.equal(replyCommand.statusCode, 200);
  assert.match(replyCommand.body.data.reply, /Reply sent/);

  assert.deepEqual(
    requests.filter((request) => /^\/api\/ai-sessions\/[^/]+\/(approval|messages)$/.test(request.body.path)).map((request) => [
      request.method,
      request.url,
      request.body.path,
      request.body.body ? JSON.parse(request.body.body) : undefined,
    ]),
    [
      ["POST", `http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/proxy`, "/api/ai-sessions/ais_waiting/messages", { message: "Use @Exact", references, permissionMode: "ask" }],
      ["POST", `http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/proxy`, "/api/ai-sessions/ais_waiting/approval", { decision: "skip" }],
      ["POST", `http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/proxy`, "/api/ai-sessions/ais_waiting/approval", { decision: "allow" }],
      ["POST", `http://127.0.0.1:8091/api/node-agent/instances/${created.body.data.id}/proxy`, "/api/ai-sessions/ais_waiting/messages", { message: "continue", permissionMode: "ask" }],
    ],
  );
});
