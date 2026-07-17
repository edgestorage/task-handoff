const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, allowSyntheticDefaultImports: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { AppManagementManager, AppManagementRequestError } = require("../packages/controlled-instance/src/web/app-management.ts");
const { createWebApp } = require("../packages/controlled-instance/src/web/server.ts");

const capabilities = { platform: "linux", arch: "x64", installers: ["apt"], privilege: "root" };
function app(id = "tool") {
  return {
    launcher: { id, name: id, kind: "tty", command: id },
    detection: [{ type: "launcher-executable" }],
    distribution: { recipes: [{ type: "system-package", platforms: ["linux"], installer: "apt", packages: [id], privilege: "root" }] },
  };
}
function stateDirs(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { stateDir: path.join(root, "state"), installBaseDir: path.join(root, "apps") };
}

test("jobs are persisted before execution and finish only after authoritative detection", async () => {
  const dirs = stateDirs("task-handoff-app-manager-");
  let state = "not-installed";
  const events = [];
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()],
    capabilities: () => capabilities,
    detection: () => ({ state, executablePaths: state === "installed" ? ["/bin/tool"] : [] }),
    execute: async (_operation, _recipe, context) => { context.onPhase("install-package"); state = "installed"; },
    publish: (event) => events.push(event),
  });
  const queued = manager.request("tool", "install", "request_1");
  const persistedImmediately = JSON.parse(fs.readFileSync(path.join(dirs.stateDir, "jobs.json"), "utf8"));
  assert.equal(persistedImmediately.jobs[0].id, queued.id);
  assert.equal(persistedImmediately.jobs[0].state, "queued");
  await manager.waitForIdle();
  assert.equal(manager.getJob(queued.id).state, "succeeded");
  assert.equal(manager.snapshot().apps[0].state, "installed");
  assert.deepEqual(events.map((event) => event.job.state), ["queued", "running", "running", "succeeded"]);
  assert.equal(events.at(-1).snapshot.apps[0].state, "installed");
  assert.equal(events.every((event) => event.streamId === manager.snapshot().streamId), true);
});

test("command and bounded live output remain part of the authoritative job", async () => {
  const dirs = stateDirs("task-handoff-app-manager-output-");
  let state = "not-installed";
  const events = [];
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()],
    capabilities: () => capabilities,
    detection: () => ({ state, executablePaths: state === "installed" ? ["/bin/tool"] : [] }),
    execute: async (_operation, _recipe, context) => {
      context.onCommand({ executable: "apt-get", args: ["install", "-y", "tool"] });
      context.onOutput("stdout", "Reading package lists…\n");
      context.onPhase("install-package");
      context.onOutput("stderr", "Installing tool\rDone\n");
      context.onOutput("stdout", "x".repeat(40_000));
      state = "installed";
    },
    publish: (event) => events.push(event),
  });
  const queued = manager.request("tool", "install");
  await manager.waitForIdle();
  const completed = manager.getJob(queued.id);
  assert.deepEqual(completed.command, { executable: "apt-get", args: ["install", "-y", "tool"] });
  assert.equal(completed.logTail.length, 32_768);
  assert.equal(completed.logTruncated, true);
  assert.equal(events.some((event) => event.job.logTail?.includes("Reading package lists")), true);
  assert.equal(events.at(-1).snapshot.recentJobs[0].logTruncated, true);
});

test("active operations are idempotent and conflicting operations are rejected", async () => {
  const dirs = stateDirs("task-handoff-app-idempotency-");
  let release;
  let state = "not-installed";
  const gate = new Promise((resolve) => { release = resolve; });
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()], capabilities: () => capabilities,
    detection: () => ({ state, executablePaths: state === "installed" ? ["/bin/tool"] : [] }),
    execute: async () => { await gate; state = "installed"; },
  });
  const first = manager.request("tool", "install", "same_request");
  assert.equal(manager.request("tool", "install", "another_request").id, first.id);
  assert.throws(() => manager.request("tool", "uninstall"), (error) => error instanceof AppManagementRequestError && error.code === "app_operation_conflict" && error.details.activeJobId === first.id);
  release();
  await manager.waitForIdle();
  assert.equal(manager.request("tool", "install", "same_request").id, first.id);
});

test("request ids are bound to one app and operation", async () => {
  const dirs = stateDirs("task-handoff-app-request-binding-");
  const states = new Map([["one", "not-installed"], ["two", "not-installed"]]);
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app("one"), app("two")], capabilities: () => capabilities,
    detection: (definition) => ({ state: states.get(definition.launcher.id), executablePaths: [] }),
    execute: async (_operation, _recipe, context) => { states.set(context.appId, "installed"); },
  });
  const first = manager.request("one", "install", "bound_request");
  assert.throws(
    () => manager.request("two", "install", "bound_request"),
    (error) => error instanceof AppManagementRequestError && error.code === "app_request_id_conflict" && error.details.jobId === first.id,
  );
  assert.throws(
    () => manager.request("one", "uninstall", "bound_request"),
    (error) => error instanceof AppManagementRequestError && error.code === "app_request_id_conflict",
  );
  await manager.waitForIdle();
});

test("the manager serializes package operations across apps", async () => {
  const dirs = stateDirs("task-handoff-app-queue-");
  const states = new Map([["one", "not-installed"], ["two", "not-installed"]]);
  let running = 0;
  let maxRunning = 0;
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app("one"), app("two")], capabilities: () => capabilities,
    detection: (definition) => ({ state: states.get(definition.launcher.id), executablePaths: [] }),
    execute: async (_operation, _recipe, context) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      states.set(context.appId, "installed");
      running -= 1;
    },
  });
  const one = manager.request("one", "install");
  const two = manager.request("two", "install");
  assert.equal(manager.getJob(two.id).state, "queued");
  await manager.waitForIdle();
  assert.equal(maxRunning, 1);
  assert.equal(manager.getJob(one.id).state, "succeeded");
  assert.equal(manager.getJob(two.id).state, "succeeded");
});

test("postcondition failure keeps detection authoritative", async () => {
  const dirs = stateDirs("task-handoff-app-postcondition-");
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()], capabilities: () => capabilities,
    detection: () => ({ state: "not-installed", executablePaths: [] }),
    execute: async () => undefined,
  });
  const job = manager.request("tool", "install");
  await manager.waitForIdle();
  assert.equal(manager.getJob(job.id).state, "failed");
  assert.equal(manager.getJob(job.id).error.code, "postcondition_failed");
  assert.equal(manager.snapshot().apps[0].state, "not-installed");
});

test("terminal app jobs refresh inventory without changing the authoritative job result", async () => {
  const dirs = stateDirs("task-handoff-app-terminal-refresh-");
  let state = "not-installed";
  let refreshes = 0;
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()], capabilities: () => capabilities,
    detection: () => ({ state, executablePaths: state === "installed" ? ["/bin/tool"] : [] }),
    execute: async () => { state = "installed"; },
    onTerminal: async () => { refreshes += 1; },
  });
  const job = manager.request("tool", "install");
  await manager.waitForIdle();
  assert.equal(manager.getJob(job.id).state, "succeeded");
  assert.equal(refreshes, 1);
});

test("a hanging terminal inventory refresh does not hold the serialized app queue", async () => {
  const dirs = stateDirs("task-handoff-app-terminal-refresh-hang-");
  let state = "not-installed";
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()], capabilities: () => capabilities,
    detection: () => ({ state, executablePaths: state === "installed" ? ["/bin/tool"] : [] }),
    execute: async () => { state = "installed"; },
    onTerminal: () => new Promise(() => undefined),
  });
  const job = manager.request("tool", "install");
  await Promise.race([
    manager.waitForIdle(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("app queue remained blocked by inventory refresh")), 100)),
  ]);
  assert.equal(manager.getJob(job.id).state, "succeeded");
});

test("externally managed executables cannot be uninstalled by a package recipe", async () => {
  const dirs = stateDirs("task-handoff-app-external-owner-");
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()], capabilities: () => capabilities,
    detection: () => ({ state: "installed", executablePaths: ["/opt/external/tool"] }),
    managementSource: () => "external",
    execute: async () => assert.fail("must not execute"),
  });
  await manager.refreshSnapshot();
  assert.equal(manager.snapshot().apps[0].uninstallReason.code, "EXTERNALLY_MANAGED");
  assert.throws(() => manager.request("tool", "uninstall"), (error) => error.code === "app_operation_unavailable" && error.details.reason.code === "EXTERNALLY_MANAGED");
});

test("concurrent snapshot refreshes share one ownership probe", async () => {
  const dirs = stateDirs("task-handoff-app-refresh-singleflight-");
  let ownershipCalls = 0;
  let releaseOwnership;
  const ownershipGate = new Promise((resolve) => { releaseOwnership = resolve; });
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()],
    capabilities: () => capabilities,
    detection: () => ({ state: "installed", executablePaths: ["/bin/tool"] }),
    ownership: async () => {
      ownershipCalls += 1;
      await ownershipGate;
      return { source: "external" };
    },
    execute: async () => assert.fail("must not execute"),
  });

  const first = manager.refreshSnapshot();
  const second = manager.refreshSnapshot();
  releaseOwnership();
  await Promise.all([first, second]);

  assert.equal(ownershipCalls, 1);
});

test("uninstall executes the recipe that owns the detected executable", async () => {
  const dirs = stateDirs("task-handoff-app-owning-recipe-");
  let state = "installed";
  let executedPrivilege = "";
  const definition = {
    launcher: { id: "tool", name: "tool", kind: "tty", command: "tool" },
    detection: [{ type: "launcher-executable" }],
    distribution: { recipes: [
      { type: "node-package", platforms: ["linux"], installer: "npm", packages: ["tool"], privilege: "user" },
      { type: "node-package", platforms: ["linux"], installer: "npm", packages: ["tool"], privilege: "passwordless-sudo" },
    ] },
  };
  const owningRecipe = definition.distribution.recipes[1];
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [definition],
    capabilities: () => ({ platform: "linux", arch: "x64", installers: ["npm"], privilege: "passwordless-sudo", installerAccess: { npmGlobalWritable: true } }),
    detection: () => ({ state, executablePaths: state === "installed" ? ["/usr/local/bin/tool"] : [] }),
    ownership: async (_definition, detection) => detection.state === "installed" ? { source: "recipe", recipe: owningRecipe } : { source: "none" },
    execute: async (_operation, recipe) => { executedPrivilege = recipe.privilege; state = "not-installed"; },
  });
  await manager.refreshSnapshot();
  const job = manager.request("tool", "uninstall");
  await manager.waitForIdle();
  assert.equal(manager.getJob(job.id).state, "succeeded");
  assert.equal(executedPrivilege, "passwordless-sudo");
});

test("capabilities refresh after a terminal operation", async () => {
  const dirs = stateDirs("task-handoff-app-capability-refresh-");
  let state = "not-installed";
  let capabilityReads = 0;
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()],
    capabilities: () => { capabilityReads += 1; return capabilities; },
    detection: () => ({ state, executablePaths: state === "installed" ? ["/bin/tool"] : [] }),
    execute: async () => { state = "installed"; },
  });
  await manager.refreshSnapshot();
  const readsAfterSnapshot = capabilityReads;
  const job = manager.request("tool", "install");
  await manager.waitForIdle();
  assert.equal(manager.getJob(job.id).state, "succeeded");
  assert.equal(capabilityReads > readsAfterSnapshot, true);
});

test("restart sanitizes stored jobs, interrupts active work, and re-detects without replay", () => {
  const dirs = stateDirs("task-handoff-app-recovery-");
  fs.mkdirSync(dirs.stateDir, { recursive: true });
  fs.writeFileSync(path.join(dirs.stateDir, "jobs.json"), JSON.stringify({
    schemaVersion: 1,
    futureTopLevel: true,
    jobs: [{
      id: "job_old", appId: "tool", operation: "install", state: "running",
      requestedAt: "2026-07-16T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z", futureField: true,
    }],
  }));
  const warnings = [];
  let detections = 0;
  let executions = 0;
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()], capabilities: () => capabilities,
    detection: () => { detections += 1; return { state: "installed", executablePaths: ["/bin/tool"] }; },
    execute: async () => { executions += 1; },
    warn: (message) => warnings.push(message),
  });
  assert.equal(manager.getJob("job_old").state, "interrupted");
  assert.equal(manager.getJob("job_old").error.code, "controlled_instance_restarted");
  assert.equal(detections, 1);
  assert.equal(executions, 0);
  assert.equal(warnings.some((message) => message.includes("unknown")), true);
});

test("uninstall refuses running app sessions and never terminates them", () => {
  const dirs = stateDirs("task-handoff-app-session-conflict-");
  const sessions = [{ id: "session_1", appId: "tool", status: "running" }];
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()], capabilities: () => capabilities,
    detection: () => ({ state: "installed", executablePaths: ["/bin/tool"] }),
    sessions: () => sessions,
    execute: async () => assert.fail("must not execute"),
  });
  assert.throws(() => manager.request("tool", "uninstall"), (error) => error.code === "app_sessions_running" && error.details.sessionIds[0] === "session_1");
  assert.equal(sessions[0].status, "running");
  assert.deepEqual(manager.snapshot().activeJobs, []);
});

test("unknown apps and unavailable operations do not create jobs", () => {
  const dirs = stateDirs("task-handoff-app-invalid-");
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()], capabilities: () => capabilities,
    detection: () => ({ state: "not-installed", executablePaths: [] }),
  });
  assert.throws(() => manager.request("missing", "install"), (error) => error.code === "unknown_app");
  assert.throws(() => manager.request("tool", "uninstall"), (error) => error.code === "app_operation_unavailable");
  assert.equal(fs.existsSync(path.join(dirs.stateDir, "jobs.json")), false);
});

test("controlled instance exposes strict management, operation, and job APIs", async () => {
  const dirs = stateDirs("task-handoff-app-api-");
  let state = "not-installed";
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()], capabilities: () => capabilities,
    detection: () => ({ state, executablePaths: state === "installed" ? ["/bin/tool"] : [] }),
    execute: async () => { state = "installed"; },
  });
  const previous = Object.fromEntries(["TASK_HANDOFF_DATA_DIR", "TASK_HANDOFF_LOG_DIR", "TASK_HANDOFF_CONFIG", "TASK_HANDOFF_WEB_AUTH", "TASK_HANDOFF_AI_SESSION_SCAN", "TASK_HANDOFF_NODE_AGENT_URL"].map((key) => [key, process.env[key]]));
  process.env.TASK_HANDOFF_DATA_DIR = path.dirname(dirs.stateDir);
  process.env.TASK_HANDOFF_LOG_DIR = path.join(path.dirname(dirs.stateDir), "logs");
  process.env.TASK_HANDOFF_CONFIG = path.join(path.dirname(dirs.stateDir), "config.json");
  process.env.TASK_HANDOFF_WEB_AUTH = "off";
  process.env.TASK_HANDOFF_AI_SESSION_SCAN = "0";
  delete process.env.TASK_HANDOFF_NODE_AGENT_URL;
  const web = await createWebApp({ staticDir: path.join(path.dirname(dirs.stateDir), "missing-static"), logger: false, appManagement: manager });
  try {
    const snapshot = await web.inject({ method: "GET", url: "/api/apps/management" });
    assert.equal(snapshot.statusCode, 200);
    assert.equal(JSON.parse(snapshot.payload).data.apps[0].state, "not-installed");

    const invalid = await web.inject({ method: "POST", url: "/api/apps/tool/install", payload: { url: "https://example.invalid/tool.tgz" } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(JSON.parse(invalid.payload).error.code, "app_management_input_invalid");

    const accepted = await web.inject({ method: "POST", url: "/api/apps/tool/install", payload: { requestId: "api_request" } });
    assert.equal(accepted.statusCode, 202);
    const jobId = JSON.parse(accepted.payload).data.job.id;
    await manager.waitForIdle();
    const job = await web.inject({ method: "GET", url: `/api/apps/jobs/${jobId}` });
    assert.equal(job.statusCode, 200);
    assert.equal(JSON.parse(job.payload).data.job.state, "succeeded");

    const unknown = await web.inject({ method: "POST", url: "/api/apps/missing/install", payload: {} });
    assert.equal(unknown.statusCode, 404);
    assert.equal(JSON.parse(unknown.payload).error.code, "unknown_app");
  } finally {
    await web.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
