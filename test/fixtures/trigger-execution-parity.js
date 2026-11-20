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

const { createAiSessionRegistry } = require("../../packages/ai-session-runtime/src/ai-session-registry.ts");
const { AiSessionController } = require("../../packages/ai-session-runtime/src/ai-session-control.ts");
const { TriggerExecutor } = require("../../packages/controlled-instance/src/triggers/executor.ts");
const { TriggerManager } = require("../../packages/controlled-instance/src/triggers/manager.ts");
const { TriggerStore } = require("../../packages/controlled-instance/src/triggers/store.ts");

const fixturePath = path.resolve(
  __dirname,
  "../../controlled-instance-rs/crates/instance/tests/fixtures/trigger-execution-parity.json",
);

function storagePaths(root) {
  return {
    configPath: path.join(root, "config.json"),
    dataDir: root,
    appCatalogDir: path.join(root, "app-catalog"),
    appSessionsDir: path.join(root, "app-sessions"),
    triggersDir: path.join(root, "triggers"),
    runtimeDir: path.join(root, "runtime"),
    eventsDir: path.join(root, "events"),
    artifactDir: path.join(root, "artifacts"),
    logDir: path.join(root, "logs"),
    webTokenPath: path.join(root, "web-token"),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stabilizeWorkspaceObservation(value, workspaceDir, configHashes = new Map()) {
  if (typeof value === "string") return value.replaceAll(workspaceDir, "{{workspace}}");
  if (Array.isArray(value)) return value.map((entry) => stabilizeWorkspaceObservation(entry, workspaceDir, configHashes));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === "configHash" && typeof entry === "string") {
      if (!configHashes.has(entry)) configHashes.set(entry, `config_${configHashes.size + 1}`);
      return [key, configHashes.get(entry)];
    }
    return [key, stabilizeWorkspaceObservation(entry, workspaceDir, configHashes)];
  }));
}

function runId(run, ids) {
  if (!ids.has(run.id)) ids.set(run.id, `run_${ids.size + 1}`);
  return ids.get(run.id);
}

function normalizeRun(run, ids) {
  return {
    id: runId(run, ids),
    configHash: run.configHash,
    deploymentId: run.deploymentId ?? null,
    instanceId: run.instanceId,
    eventType: run.eventType,
    status: run.status,
    target: { type: run.target.type, aiSessionId: run.target.aiSessionId },
    promptPreview: run.promptPreview,
    eventSummary: run.eventSummary ?? null,
    error: run.error ?? null,
    hasStartedAt: Boolean(run.startedAt),
    hasCompletedAt: Boolean(run.completedAt),
    completedNotBeforeStarted: run.completedAt ? Date.parse(run.completedAt) >= Date.parse(run.startedAt) : null,
  };
}

function normalizeRuntime(runtime) {
  return {
    configHash: runtime.configHash,
    deploymentId: runtime.deploymentId ?? null,
    instanceId: runtime.instanceId,
    status: runtime.status,
    runCount: runtime.runCount,
    skippedCount: runtime.skippedCount,
    hasLastTriggeredAt: Boolean(runtime.lastTriggeredAt),
    hasLastCompletedAt: Boolean(runtime.lastCompletedAt),
    hasLastSkippedAt: Boolean(runtime.lastSkippedAt),
    lastError: runtime.lastError ?? null,
  };
}

function normalizeIndex(index, ids) {
  return {
    configs: index.configs.map((config) => ({
      configHash: config.configHash,
      name: config.name,
      description: config.description ?? null,
      source: config.source,
      action: config.action,
      policy: {
        cooldownMs: config.policy.cooldownMs ?? null,
        maxConcurrentRuns: config.policy.maxConcurrentRuns,
        whenBusy: config.policy.whenBusy,
      },
    })),
    deployments: index.deployments.map((deployment) => ({
      configHash: deployment.configHash,
      deploymentId: deployment.deploymentId ?? null,
      instanceId: deployment.instanceId,
      origin: deployment.origin,
      enabled: deployment.enabled,
      target: { type: deployment.target.type, aiSessionId: deployment.target.aiSessionId },
      localName: deployment.localName ?? null,
    })),
    runtime: index.runtime.map(normalizeRuntime),
    recentRuns: index.recentRuns.map((run) => normalizeRun(run, ids)),
  };
}

function normalizeEvent(event, ids) {
  if (event.type === "trigger.run.started") {
    return {
      type: event.type,
      configHash: event.data.configHash,
      deploymentId: event.data.deploymentId ?? null,
      eventType: event.data.eventType,
    };
  }
  if (event.type === "trigger.run.completed") {
    return {
      type: event.type,
      run: normalizeRun(event.data.run, ids),
      result: {
        provider: event.data.result.provider,
        action: event.data.result.action,
        sessionId: event.data.result.session.id,
        turnId: event.data.result.turnId ?? null,
        providerTurnId: event.data.result.providerTurnId ?? null,
        hasQueueId: Boolean(event.data.result.queueId),
      },
    };
  }
  if (event.type === "trigger.run.failed") {
    return { type: event.type, configHash: event.data.configHash, error: event.data.error };
  }
  if (event.type === "trigger.updated") {
    return { type: event.type, index: normalizeIndex(event.data, ids) };
  }
  return { type: event.type, data: event.data };
}

function seedSession(registry, seed) {
  const started = registry.start({
    agent: seed.agent,
    providerSessionId: seed.providerSessionId,
    cwd: seed.cwd,
    title: seed.title,
    summary: seed.summary,
    status: "idle",
    phase: "unknown",
  }, { timestamp: seed.startedAt, suppressPromptTurn: true });
  return registry.restoreAuthority({
    ...started,
    id: seed.id,
    status: seed.status,
    phase: seed.phase,
    startedAt: seed.startedAt,
    updatedAt: seed.updatedAt,
  });
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

async function waitFor(events, type) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (events.some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`trigger event timeout: ${type}`);
}

async function waitForCondition(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`trigger condition timeout: ${label}`);
}

function managerGatedSnapshots(scenario) {
  const transitions = scenario.busyTransitions ?? 0;
  if (!transitions) return scenario.snapshots;
  const [initial, running] = scenario.snapshots;
  const startedAt = Date.parse("2026-11-20T00:00:01.000Z");
  const busy = Array.from({ length: transitions }, (_, index) => {
    const snapshot = clone(running);
    const session = snapshot.sessions[0];
    const updatedAt = new Date(startedAt + (index + 1) * 1_000).toISOString();
    session.phase = index % 2 === 0 ? "tool" : "thinking";
    session.updatedAt = updatedAt;
    snapshot.updatedAt = updatedAt;
    return snapshot;
  });
  return [initial, running, ...busy];
}

function triggerForScenario(scenario, workspaceDir) {
  const trigger = clone(scenario.trigger);
  if (trigger.source?.type === "file-change") {
    trigger.source.roots = trigger.source.roots.map((root) => root === "{{workspace}}" ? workspaceDir : root);
  }
  return trigger;
}

async function executeFileWatcherScenario(scenario, store, workspaceDir, events) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const step of scenario.steps) {
    const target = step.path ? path.join(workspaceDir, step.path) : undefined;
    if (step.operation === "write" || step.operation === "append" || step.operation === "write-many") {
      const writes = step.operation === "write-many"
        ? step.writes
        : [{ path: step.path, content: step.content, append: step.operation === "append" }];
      for (const write of writes) {
        const file = path.join(workspaceDir, write.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (write.append) fs.appendFileSync(file, write.content || "");
        else fs.writeFileSync(file, write.content || "");
      }
    } else if (step.operation === "unlink") {
      fs.unlinkSync(target);
    } else if (step.operation === "rename") {
      const destination = path.join(workspaceDir, step.to);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(target, destination);
    } else if (step.operation === "wait") {
      await new Promise((resolve) => setTimeout(resolve, step.waitMs));
    } else {
      throw new Error(`unknown file watcher operation: ${step.operation}`);
    }
    await waitForCondition(
      () => store.list().recentRuns.length >= step.waitForRuns
        && events.filter((event) => event.type === "trigger.run.completed").length >= step.waitForRuns,
      `${scenario.id} run ${step.waitForRuns}`,
    );
    await settle();
  }
}

async function observe(scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `trigger-parity-${scenario.id}-`));
  const previousInstanceId = process.env.TASK_HANDOFF_INSTANCE_ID;
  const previousWorkspace = process.env.TASK_HANDOFF_WORKSPACE;
  const originalSetTimeout = global.setTimeout;
  process.env.TASK_HANDOFF_INSTANCE_ID = "instance";
  if (scenario.mode === "schedule-accelerated") {
    let accelerated = false;
    global.setTimeout = (callback, delay, ...args) => {
      if (!accelerated && Number(delay) >= 60_000) {
        accelerated = true;
        return originalSetTimeout(callback, 0, ...args);
      }
      return originalSetTimeout(callback, delay, ...args);
    };
  }
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
  const events = [];
  const messages = [];
  let manager;
  try {
    const paths = storagePaths(root);
    const store = new TriggerStore(paths);
    if (scenario.mode === "file-watcher") {
      process.env.TASK_HANDOFF_WORKSPACE = workspaceDir;
      for (const [relative, content] of Object.entries(scenario.initialFiles || {})) {
        const file = path.join(workspaceDir, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
    }
    const created = store.create(triggerForScenario(scenario, workspaceDir));
    const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
    if (scenario.providerSessionExists) seedSession(registry, scenario.sessions[0]);
    let releaseProvider;
    const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
    const controller = new AiSessionController(registry);
    controller.register({
      agent: scenario.sessions[0].agent,
      async startMessage(session, input) {
        messages.push(input.message);
        if ((scenario.mode === "manager-gated" || scenario.mode === "file-watcher") && messages.length === 1) {
          registry.restoreAuthority({
            ...registry.get(session.id),
            status: "running",
            phase: "thinking",
          });
        }
        if (scenario.mode === "manager-gated" && messages.length === 1) {
          await providerGate;
        }
        return {
          session,
          provider: session.agent,
          action: "send",
          turnId: "trigger-turn",
          providerTurnId: "provider-trigger-turn",
        };
      },
    });
    const executor = new TriggerExecutor(store, controller);

    if (scenario.mode === "executor-drain") {
      executor.beginDrain();
      try {
        await executor.execute({
          config: created.config,
          deployment: created.deployment,
          eventType: "manual",
          eventSummary: "draining",
          promptOverride: "blocked",
        });
        assert.fail("draining executor unexpectedly accepted work");
      } catch (error) {
        const reopened = new TriggerStore(paths).list();
        const ids = new Map();
        return {
          id: scenario.id,
          errorCode: error.code ?? null,
          errorMessage: error.message,
          messages,
          events: events.map((event) => normalizeEvent(event, ids)),
          index: normalizeIndex(reopened, ids),
        };
      } finally {
        executor.endDrain();
      }
    }

    manager = new TriggerManager(store, executor, paths, (type, data) => {
      events.push({ type, data: clone(data) });
    });
    manager.start();
    if (scenario.mode === "schedule-accelerated") {
      await waitForCondition(
        () => events.filter((event) => event.type === "trigger.run.completed").length >= 1,
        `${scenario.id} scheduled run`,
      );
      await settle();
      manager.stop();
      manager = undefined;
      const reopened = new TriggerStore(paths).list();
      const ids = new Map();
      const normalizedEvents = events.map((event) => normalizeEvent(event, ids));
      return {
        id: scenario.id,
        messages,
        eventSummaries: normalizedEvents
          .filter((event) => event.type === "trigger.run.completed")
          .map((event) => event.run.eventSummary),
        events: normalizedEvents,
        index: normalizeIndex(reopened, ids),
      };
    }
    if (scenario.mode === "file-watcher") {
      await executeFileWatcherScenario(scenario, store, workspaceDir, events);
      manager.stop();
      manager = undefined;
      const reopened = new TriggerStore(paths).list();
      const ids = new Map();
      const normalizedEvents = events.map((event) => normalizeEvent(event, ids));
      return {
        id: scenario.id,
        messages,
        ...stabilizeWorkspaceObservation({
          eventSummaries: normalizedEvents
            .filter((event) => event.type === "trigger.run.completed")
            .map((event) => event.run.eventSummary),
          events: normalizedEvents,
          index: normalizeIndex(reopened, ids),
        }, workspaceDir),
      };
    }
    if (scenario.mode === "manager-gated") {
      const snapshots = managerGatedSnapshots(scenario);
      manager.handleAiSessions(snapshots[0]);
      manager.handleAiSessions(snapshots[1]);
      await waitForCondition(() => messages.length === 1, "first provider message");
      for (const snapshot of snapshots.slice(2)) manager.handleAiSessions(snapshot);
      await settle();
      const runsWhileFirstInFlight = store.list().recentRuns.length;
      const messagesWhileFirstInFlight = messages.length;
      const indexWhileFirstInFlight = scenario.captureInFlightIndex ? store.list() : undefined;
      if (scenario.stopBeforeRelease) {
        manager.stop();
        manager = undefined;
        await waitForCondition(
          () => events.filter((event) => event.type === "trigger.run.skipped").length === scenario.busyTransitions,
          "queued skips after stop",
        );
      }
      releaseProvider();
      await waitForCondition(
        () => events.filter((event) => event.type === "trigger.run.completed").length === scenario.completedRuns,
        "completed runs",
      );
      await settle();
      if (manager) {
        manager.stop();
        manager = undefined;
      }
      const reopened = new TriggerStore(paths).list();
      const ids = new Map();
      const observedIndexWhileFirstInFlight = indexWhileFirstInFlight
        ? normalizeIndex(indexWhileFirstInFlight, ids)
        : undefined;
      const normalizedEvents = events.map((event) => normalizeEvent(event, ids));
      const index = normalizeIndex(reopened, ids);
      const completedRuns = normalizedEvents.filter((event) => event.type === "trigger.run.completed").length;
      const skippedRuns = normalizedEvents.filter((event) => event.type === "trigger.run.skipped").length;
      if (scenario.observation === "summary") {
        return {
          id: scenario.id,
          messages,
          completedRuns,
          skippedRuns,
          runsWhileFirstInFlight,
          messagesWhileFirstInFlight,
          indexWhileFirstInFlight: observedIndexWhileFirstInFlight,
          eventTypes: normalizedEvents.map((event) => event.type),
          completedEventRunIds: normalizedEvents
            .filter((event) => event.type === "trigger.run.completed")
            .map((event) => event.run.id),
          skippedReasons: events
            .filter((event) => event.type === "trigger.run.skipped")
            .map((event) => event.data.reason),
          updateEventCount: normalizedEvents.filter((event) => event.type === "trigger.updated").length,
          index,
        };
      }
      return {
        id: scenario.id,
        messages,
        completedRuns,
        skippedRuns,
        runsWhileFirstInFlight,
        messagesWhileFirstInFlight,
        events: normalizedEvents,
        index,
      };
    }
    const runsAfterNonFinalSnapshots = [];
    for (const [index, snapshot] of scenario.snapshots.entries()) {
      if (scenario.stopBeforeFinalTransition && index === scenario.snapshots.length - 1) {
        manager.stop();
      }
      manager.handleAiSessions(snapshot);
      if (index < scenario.snapshots.length - 1) {
        await settle();
        runsAfterNonFinalSnapshots.push(store.list().recentRuns.length);
      }
    }
    await waitFor(events, scenario.waitForEventType || "trigger.updated");
    manager.stop();
    manager = undefined;
    const reopened = new TriggerStore(paths).list();
    const ids = new Map();
    return {
      id: scenario.id,
      messages,
      runsAfterNonFinalSnapshots,
      events: events.map((event) => normalizeEvent(event, ids)),
      index: normalizeIndex(reopened, ids),
    };
  } finally {
    manager?.stop();
    if (previousInstanceId === undefined) delete process.env.TASK_HANDOFF_INSTANCE_ID;
    else process.env.TASK_HANDOFF_INSTANCE_ID = previousInstanceId;
    if (previousWorkspace === undefined) delete process.env.TASK_HANDOFF_WORKSPACE;
    else process.env.TASK_HANDOFF_WORKSPACE = previousWorkspace;
    global.setTimeout = originalSetTimeout;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { fixturePath, observe };

if (require.main === module) {
  (async () => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    for (const scenario of fixture.scenarios) {
      scenario.expected = await observe(scenario);
      process.stderr.write(`${scenario.id} observed\n`);
    }
    fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
