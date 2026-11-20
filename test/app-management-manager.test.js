const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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
const { AppRecipeExecutionError, createAppRecipeExecutor } = require("../packages/controlled-instance/src/web/app-recipe-executor.ts");
const { AppInstallEnvironmentManager } = require("../packages/controlled-instance/src/web/app-install-environment.ts");
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

test("app jobs freeze the install source policy when the request is accepted", async () => {
  const dirs = stateDirs("task-handoff-app-install-policy-");
  const installEnvironment = new AppInstallEnvironmentManager({
    dataDir: path.dirname(dirs.stateDir),
    stateDir: dirs.stateDir,
    env: {},
    platform: "linux",
    arch: "x64",
    osReleasePath: path.join(path.dirname(dirs.stateDir), "missing-os-release"),
  });
  installEnvironment.update({ settings: { profile: "official", custom: {} } });
  let state = "not-installed";
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let frozenRevision;
  const manager = new AppManagementManager({
    ...dirs,
    installEnvironment,
    definitions: () => [app()],
    capabilities: () => capabilities,
    detection: () => ({ state, executablePaths: state === "installed" ? ["/bin/tool"] : [] }),
    execute: async (_operation, _recipe, _context, policy) => {
      frozenRevision = policy?.revision;
      await gate;
      state = "installed";
    },
  });
  const job = manager.request("tool", "install");
  assert.equal(job.installSourceRevision, 1);

  installEnvironment.update({ settings: { profile: "china", custom: {} } });
  release();
  await manager.waitForIdle();

  assert.equal(frozenRevision, 1);
  assert.equal(manager.getJob(job.id).installSourceRevision, 1);
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

test("postcondition failure then retry matches the shared app-management fixture", async () => {
  const dirs = stateDirs("task-handoff-app-retry-parity-");
  const launcher = path.join(dirs.installBaseDir, "tool", "bin", "tool");
  const manifestFile = path.join(dirs.stateDir, "manifests", "tool.json");
  const archiveApp = {
    launcher: { id: "tool", name: "tool", kind: "tty", command: "bin/tool" },
    detection: [{ type: "launcher-executable" }],
    distribution: {
      recipes: [{
        type: "archive",
        platforms: ["linux"],
        arches: ["x64"],
        privilege: "root",
        url: "https://example.invalid/tool.tar.gz",
        sha256: "0".repeat(64),
        format: "tar.gz",
        installRoot: "tool",
      }],
    },
  };
  let executions = 0;
  let installed = false;
  const events = [];
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [archiveApp],
    capabilities: () => capabilities,
    detection: () => ({
      state: installed ? "installed" : "not-installed",
      executablePaths: installed ? [launcher] : [],
    }),
    managementSource: () => "recipe",
    execute: async (_operation, _recipe, context) => {
      executions += 1;
      context.onPhase("install-package");
      if (executions === 2) {
        fs.mkdirSync(path.dirname(launcher), { recursive: true });
        fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
        fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        fs.writeFileSync(manifestFile, JSON.stringify({
          schemaVersion: 1,
          appId: "tool",
          installRoot: path.join(dirs.installBaseDir, "tool"),
          files: ["bin/tool"],
        }));
        installed = true;
      }
    },
    publish: (event) => events.push(event),
  });
  const jobProjection = (job) => ({
    operation: job.operation,
    state: job.state,
    phase: job.phase ?? null,
    hasStartedAt: Boolean(job.startedAt),
    hasFinishedAt: Boolean(job.finishedAt),
    error: job.error ?? null,
  });
  const appProjection = () => {
    const managed = manager.snapshot().apps[0];
    return {
      state: managed.state,
      managementSource: managed.managementSource,
      canInstall: managed.canInstall,
      canUninstall: managed.canUninstall,
      canUpdate: managed.canUpdate,
      installReason: managed.installReason?.code ?? null,
      updateReason: managed.updateReason?.code ?? null,
    };
  };

  const first = manager.request("tool", "install");
  await manager.waitForIdle();
  const firstStep = {
    name: "first-install",
    job: jobProjection(manager.getJob(first.id)),
    app: appProjection(),
    executions,
    launcherExists: fs.existsSync(launcher),
    manifestExists: fs.existsSync(manifestFile),
  };
  const second = manager.request("tool", "install");
  await manager.waitForIdle();
  const actual = {
    scenario: "postcondition-failure-then-retry",
    steps: [firstStep, {
      name: "retry-install",
      job: jobProjection(manager.getJob(second.id)),
      app: appProjection(),
      executions,
      launcherExists: fs.existsSync(launcher),
      manifestExists: fs.existsSync(manifestFile),
    }],
    jobIdsDiffer: first.id !== second.id,
    eventStates: events.filter((event) => event.job?.appId === "tool").map((event) => event.job.state),
  };
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "controlled-instance-rs", "crates", "instance", "tests", "fixtures", "app-management-retry-parity.json"), "utf8"));
  assert.deepEqual(actual, fixture);
});

test("update failure then retry matches the shared app-management fixture", async () => {
  const dirs = stateDirs("task-handoff-app-update-retry-parity-");
  const launcher = path.join(dirs.installBaseDir, "tool", "bin", "tool");
  const manifestFile = path.join(dirs.stateDir, "manifests", "tool.json");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(launcher, "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });
  fs.writeFileSync(manifestFile, JSON.stringify({
    schemaVersion: 1,
    appId: "tool",
    installRoot: path.join(dirs.installBaseDir, "tool"),
    files: ["bin/tool"],
  }));
  const archiveApp = {
    launcher: { id: "tool", name: "tool", kind: "tty", command: "bin/tool" },
    detection: [{ type: "launcher-executable" }],
    distribution: {
      recipes: [{
        type: "archive",
        platforms: ["linux"],
        arches: ["x64"],
        privilege: "root",
        url: "https://example.invalid/tool.tar.gz",
        sha256: "0".repeat(64),
        format: "tar.gz",
        installRoot: "tool",
      }],
    },
  };
  let executions = 0;
  const events = [];
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [archiveApp],
    capabilities: () => capabilities,
    detection: () => ({ state: "installed", executablePaths: [launcher] }),
    managementSource: () => "recipe",
    execute: async (_operation, _recipe, context) => {
      executions += 1;
      context.onPhase("update-package");
      if (executions === 1) throw new AppRecipeExecutionError("update_failed", "simulated update failure", true);
      fs.writeFileSync(launcher, "#!/bin/sh\necho 2.0.0\n", { mode: 0o755 });
    },
    publish: (event) => events.push(event),
  });
  const jobProjection = (job) => ({
    operation: job.operation,
    state: job.state,
    phase: job.phase ?? null,
    hasStartedAt: Boolean(job.startedAt),
    hasFinishedAt: Boolean(job.finishedAt),
    error: job.error ?? null,
  });
  const appProjection = () => {
    const managed = manager.snapshot().apps[0];
    return {
      state: managed.state,
      managementSource: managed.managementSource,
      canInstall: managed.canInstall,
      canUninstall: managed.canUninstall,
      canUpdate: managed.canUpdate,
      installReason: managed.installReason?.code ?? null,
      updateReason: managed.updateReason?.code ?? null,
    };
  };

  await manager.refreshSnapshot();
  const initial = { app: appProjection(), launcherContents: fs.readFileSync(launcher, "utf8") };
  const first = manager.request("tool", "update");
  await manager.waitForIdle();
  const firstStep = {
    name: "first-update",
    job: jobProjection(manager.getJob(first.id)),
    app: appProjection(),
    executions,
    launcherContents: fs.readFileSync(launcher, "utf8"),
    manifestExists: fs.existsSync(manifestFile),
  };
  const second = manager.request("tool", "update");
  await manager.waitForIdle();
  const actual = {
    scenario: "update-failure-then-retry",
    initial,
    steps: [firstStep, {
      name: "retry-update",
      job: jobProjection(manager.getJob(second.id)),
      app: appProjection(),
      executions,
      launcherContents: fs.readFileSync(launcher, "utf8"),
      manifestExists: fs.existsSync(manifestFile),
    }],
    jobIdsDiffer: first.id !== second.id,
    eventStates: events.filter((event) => event.job?.appId === "tool").map((event) => event.job.state),
  };
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "controlled-instance-rs", "crates", "instance", "tests", "fixtures", "app-management-update-retry-parity.json"), "utf8"));
  assert.deepEqual(actual, fixture);
});

test("archive install, update failure, uninstall, and reinstall match the shared lifecycle fixture", { skip: process.platform === "win32" }, async (context) => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "controlled-instance-rs", "crates", "instance", "tests", "fixtures", "archive-lifecycle-parity.json"), "utf8"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-app-archive-lifecycle-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installBaseDir = path.join(root, "apps");
  const stateDir = path.join(root, "state");
  const installRoot = path.join(installBaseDir, "tool");
  const manifestFile = path.join(stateDir, "manifests", "tool.json");
  const v1 = Buffer.from(fixture.artifacts.v1, "base64");
  const v2 = Buffer.from(fixture.artifacts.v2, "base64");
  let selected = v1;
  let device = v1;
  let recipeVersion = 1;
  const events = [];
  const jobIds = [];
  const recipe = () => ({
    type: "archive",
    platforms: ["linux"],
    arches: ["x64"],
    privilege: "user",
    url: `https://fixtures.invalid/tool-v${recipeVersion}.tar.gz`,
    sha256: crypto.createHash("sha256").update(selected).digest("hex"),
    format: "tar.gz",
    installRoot: "tool",
  });
  const definition = () => ({
    launcher: { id: "tool", name: "tool", kind: "tty", command: "bin/tool" },
    detection: [{ type: "launcher-executable" }],
    distribution: { recipes: [recipe()] },
  });
  const execute = createAppRecipeExecutor({
    installBaseDir,
    stateDir,
    fetcher: async () => new Response(device, { status: 200, headers: { "content-length": String(device.length) } }),
    commandRunner: async () => assert.fail("archive recipes must not invoke a command"),
  });
  const manager = new AppManagementManager({
    stateDir,
    installBaseDir,
    definitions: () => [definition()],
    capabilities: () => capabilities,
    execute,
    publish: (event) => {
      if (event.job?.appId === "tool") events.push(event.job.state);
    },
  });
  const tree = () => {
    if (!fs.existsSync(installRoot)) return [];
    const files = [];
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(installRoot, absolute).split(path.sep).join("/");
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile()) files.push({
          path: relative,
          contents: fs.readFileSync(absolute, "utf8"),
          executable: (fs.statSync(absolute).mode & 0o111) !== 0,
        });
        else files.push({ path: relative, kind: entry.isSymbolicLink() ? "other:symlink" : "other:unknown", executable: false });
      }
    };
    visit(installRoot);
    return files.sort((left, right) => left.path.localeCompare(right.path));
  };
  const manifest = () => {
    if (!fs.existsSync(manifestFile)) return null;
    const value = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    assert.equal(value.installRoot, installRoot);
    return { schemaVersion: value.schemaVersion, appId: value.appId, files: value.files };
  };
  const appProjection = () => {
    const app = manager.snapshot().apps[0];
    return {
      state: app.state,
      managementSource: app.managementSource,
      canInstall: app.canInstall,
      canUninstall: app.canUninstall,
      canUpdate: app.canUpdate,
      installReason: app.installReason?.code ?? null,
      uninstallReason: app.uninstallReason?.code ?? null,
      updateReason: app.updateReason?.code ?? null,
    };
  };
  const jobProjection = (job) => ({
    operation: job.operation,
    state: job.state,
    phase: job.phase ?? null,
    hasStartedAt: Boolean(job.startedAt),
    hasFinishedAt: Boolean(job.finishedAt),
    error: job.error ?? null,
  });
  const step = async (name, operation) => {
    const queued = manager.request("tool", operation);
    await manager.waitForIdle();
    jobIds.push(queued.id);
    const terminal = manager.getJob(queued.id);
    return { name, job: jobProjection(terminal), app: appProjection(), tree: tree(), manifest: manifest() };
  };

  await manager.refreshSnapshot();
  const steps = [await step("install-v1", "install")];
  fs.writeFileSync(path.join(installRoot, "user-config.json"), "{}\n");
  device = v2;
  steps.push(await step("failed-update-to-v2", "update"));
  device = v1;
  steps.push(await step("uninstall-v1", "uninstall"));
  selected = v2;
  device = v2;
  recipeVersion = 2;
  steps.push(await step("reinstall-v2", "install"));

  const restarted = new AppManagementManager({
    stateDir,
    installBaseDir,
    definitions: () => [definition()],
    capabilities: () => capabilities,
    execute,
  });
  await restarted.refreshSnapshot();
  const recentJobs = restarted.snapshot().recentJobs.map((job) => ({
    operation: job.operation,
    state: job.state,
    phase: job.phase ?? null,
    error: job.error?.code ?? null,
  })).sort((left, right) => `${left.operation}:${left.state}:${left.phase ?? ""}:${left.error ?? ""}`.localeCompare(`${right.operation}:${right.state}:${right.phase ?? ""}:${right.error ?? ""}`));
  const actual = {
    scenario: "archive-install-update-failure-uninstall-reinstall",
    artifacts: fixture.artifacts,
    steps,
    jobIdsDistinct: new Set(jobIds).size === jobIds.length,
    eventStates: events,
    restart: {
      app: (() => {
        const app = restarted.snapshot().apps[0];
        return {
          state: app.state,
          managementSource: app.managementSource,
          canInstall: app.canInstall,
          canUninstall: app.canUninstall,
          canUpdate: app.canUpdate,
          installReason: app.installReason?.code ?? null,
          uninstallReason: app.uninstallReason?.code ?? null,
          updateReason: app.updateReason?.code ?? null,
        };
      })(),
      tree: tree(),
      manifest: manifest(),
      recentJobs,
    },
  };
  assert.deepEqual(actual, fixture);
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

test("a hanging terminal inventory refresh does not hold the serialized app queue", { timeout: 5_000 }, async () => {
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
  await manager.waitForIdle();
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

test("update re-runs the installed recipe and keeps detection authoritative", async () => {
  const dirs = stateDirs("task-handoff-app-update-");
  const operations = [];
  const recipe = { type: "system-package", platforms: ["linux"], installer: "apt", packages: ["tool"], privilege: "root" };
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()], capabilities: () => capabilities,
    detection: () => ({ state: "installed", executablePaths: ["/usr/bin/tool"], version: "1.0.0" }),
    ownership: async () => ({ source: "recipe", recipe }),
    execute: async (operation) => { operations.push(operation); },
  });
  await manager.refreshSnapshot();
  assert.equal(manager.snapshot().apps[0].canUpdate, true);
  const job = manager.request("tool", "update");
  assert.equal(job.operation, "update");
  await manager.waitForIdle();
  assert.equal(manager.getJob(job.id).state, "succeeded");
  assert.deepEqual(operations, ["update"]);
});

test("update refuses running app sessions before stopping their backend", async () => {
  const dirs = stateDirs("task-handoff-app-update-sessions-");
  const recipe = { type: "node-package", platforms: ["linux"], installer: "npm", packages: ["tool"], privilege: "root" };
  const sessions = [{ id: "session_1", appId: "tool", status: "running" }];
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()], capabilities: () => capabilities,
    detection: () => ({ state: "installed", executablePaths: ["/usr/bin/tool"] }),
    ownership: async () => ({ source: "recipe", recipe }),
    sessions: () => sessions,
    execute: async (_operation, _recipe, context) => { context.onPhase("update-node-package"); },
  });
  await manager.refreshSnapshot();
  assert.throws(() => manager.request("tool", "update"), (error) => error.code === "app_sessions_running");
  assert.equal(sessions[0].status, "running");
});

test("update is unavailable for externally managed apps", async () => {
  const dirs = stateDirs("task-handoff-app-update-external-");
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()], capabilities: () => capabilities,
    detection: () => ({ state: "installed", executablePaths: ["/opt/external/tool"] }),
    managementSource: () => "external",
    execute: async () => assert.fail("must not execute"),
  });
  await manager.refreshSnapshot();
  assert.equal(manager.snapshot().apps[0].canUpdate, false);
  assert.equal(manager.snapshot().apps[0].updateReason.code, "EXTERNALLY_MANAGED");
  assert.throws(() => manager.request("tool", "update"), (error) => error.code === "app_operation_unavailable" && error.details.reason.code === "EXTERNALLY_MANAGED");
});

test("native package ownership comes from the private ownership manifest", async () => {
  const dirs = stateDirs("task-handoff-app-native-ownership-");
  const target = path.join(dirs.installBaseDir, "native", "tool");
  const launcherPath = path.join(target, "vendor", "bin", "tool");
  const recipe = {
    type: "native-package", platforms: ["linux"], arches: ["x64"], package: "native-tool",
    packageVersion: "1.2.3-linux-x64", version: "1.2.3", integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    launchPath: "vendor/bin/tool", privilege: "user",
  };
  const definition = {
    launcher: { id: "tool", name: "Tool", kind: "tty", command: launcherPath },
    detection: [{ type: "launcher-executable" }],
    distribution: { recipes: [recipe] },
  };
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "managed-app.json"), JSON.stringify({
    schemaVersion: 1, appId: "tool", version: recipe.version, package: recipe.package,
    packageVersion: recipe.packageVersion, integrity: recipe.integrity, installRoot: target,
    launchPath: recipe.launchPath, files: [recipe.launchPath, "managed-app.json"],
  }));
  let state = "installed";
  const executed = [];
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [definition],
    capabilities: () => ({ platform: "linux", arch: "x64", installers: [], privilege: "user" }),
    detection: () => ({ state, executablePaths: state === "installed" ? [launcherPath] : [] }),
    execute: async (operation, selected) => { executed.push({ operation, selected }); state = "not-installed"; },
  });
  await manager.refreshSnapshot();
  assert.equal(manager.snapshot().apps[0].managementSource, "recipe");
  assert.equal(manager.snapshot().apps[0].canUninstall, true);
  const job = manager.request("tool", "uninstall");
  await manager.waitForIdle();
  assert.equal(manager.getJob(job.id).state, "succeeded");
  assert.equal(executed[0].operation, "uninstall");
  assert.equal(executed[0].selected.type, "native-package");
});

test("update conflicts with an active install of the same app", async () => {
  const dirs = stateDirs("task-handoff-app-update-conflict-");
  let release;
  let state = "not-installed";
  const gate = new Promise((resolve) => { release = resolve; });
  const recipe = { type: "system-package", platforms: ["linux"], installer: "apt", packages: ["tool"], privilege: "root" };
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()], capabilities: () => capabilities,
    detection: () => ({ state, executablePaths: state === "installed" ? ["/usr/bin/tool"] : [] }),
    ownership: async () => ({ source: state === "installed" ? "recipe" : "none", recipe: state === "installed" ? recipe : undefined }),
    execute: async () => { await gate; state = "installed"; },
  });
  const install = manager.request("tool", "install");
  assert.throws(() => manager.request("tool", "update"), (error) => error.code === "app_operation_conflict" && error.details.activeJobId === install.id);
  release();
  await manager.waitForIdle();
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

    const installEnvironment = await web.inject({ method: "GET", url: "/api/apps/install-environment" });
    assert.equal(installEnvironment.statusCode, 200);
    assert.equal(JSON.parse(installEnvironment.payload).data.settings.profile, "environment");
    const updatedEnvironment = await web.inject({
      method: "PUT",
      url: "/api/apps/install-environment",
      payload: { expectedRevision: 0, settings: { profile: "environment", custom: {} } },
    });
    assert.equal(updatedEnvironment.statusCode, 200);
    assert.equal(JSON.parse(updatedEnvironment.payload).data.environment.revision, 1);
    const sourceTest = await web.inject({ method: "POST", url: "/api/apps/install-environment/test", payload: {} });
    assert.equal(sourceTest.statusCode, 200);
    assert.deepEqual(JSON.parse(sourceTest.payload).data.checks, []);

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

test("controlled instance exposes the app update API", async () => {
  const dirs = stateDirs("task-handoff-app-update-api-");
  const recipe = { type: "system-package", platforms: ["linux"], installer: "apt", packages: ["tool"], privilege: "root" };
  const operations = [];
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()], capabilities: () => capabilities,
    detection: () => ({ state: "installed", executablePaths: ["/usr/bin/tool"] }),
    ownership: async () => ({ source: "recipe", recipe }),
    execute: async (operation) => { operations.push(operation); },
    updateCheck: async () => ({ status: "up-to-date", installedVersion: "1.0.0", latestVersion: "1.0.0" }),
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
    const accepted = await web.inject({ method: "POST", url: "/api/apps/tool/update", payload: { requestId: "update_request" } });
    assert.equal(accepted.statusCode, 202);
    const jobId = JSON.parse(accepted.payload).data.job.id;
    await manager.waitForIdle();
    const job = await web.inject({ method: "GET", url: `/api/apps/jobs/${jobId}` });
    assert.equal(job.statusCode, 200);
    assert.equal(JSON.parse(job.payload).data.job.operation, "update");
    assert.equal(JSON.parse(job.payload).data.job.state, "succeeded");
    assert.deepEqual(operations, ["update"]);

    const checked = await web.inject({ method: "POST", url: "/api/apps/tool/update-check", payload: {} });
    assert.equal(checked.statusCode, 200);
    const check = JSON.parse(checked.payload).data.check;
    assert.equal(check.appId, "tool");
    assert.equal(check.status, "up-to-date");
    assert.ok(check.checkedAt);

    const missing = await web.inject({ method: "POST", url: "/api/apps/missing/update-check", payload: {} });
    assert.equal(missing.statusCode, 404);
    assert.equal(JSON.parse(missing.payload).error.code, "unknown_app");
  } finally {
    await web.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("manual update checks are cached, projected, and cleared after an update", async () => {
  const dirs = stateDirs("task-handoff-app-update-check-");
  const recipe = { type: "system-package", platforms: ["linux"], installer: "apt", packages: ["tool"], privilege: "root" };
  let state = "installed";
  const calls = [];
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()], capabilities: () => capabilities,
    detection: () => ({ state, executablePaths: state === "installed" ? ["/usr/bin/tool"] : [] }),
    ownership: async () => ({ source: "recipe", recipe }),
    updateCheck: async (receivedRecipe, context) => {
      calls.push({ recipe: receivedRecipe, appId: context.appId, platform: context.capabilities.platform });
      return { status: "update-available", installedVersion: "1.0.0", latestVersion: "1.1.0" };
    },
    execute: async () => { state = "installed"; },
  });
  await manager.refreshSnapshot();
  const check = await manager.checkForUpdate("tool");
  assert.equal(check.appId, "tool");
  assert.equal(check.status, "update-available");
  assert.equal(check.installedVersion, "1.0.0");
  assert.equal(check.latestVersion, "1.1.0");
  assert.ok(check.checkedAt);
  assert.deepEqual(calls, [{ recipe, appId: "tool", platform: "linux" }]);

  assert.deepEqual(manager.snapshot().apps[0].updateCheck, {
    status: "update-available",
    installedVersion: "1.0.0",
    latestVersion: "1.1.0",
    checkedAt: check.checkedAt,
  });

  const repeated = await manager.checkForUpdate("tool");
  assert.equal(repeated.status, "update-available");
  assert.equal(calls.length, 2, "each manual check runs the checker again and republishes the snapshot");
  assert.deepEqual(manager.snapshot().apps[0].updateCheck, {
    status: "update-available",
    installedVersion: "1.0.0",
    latestVersion: "1.1.0",
    checkedAt: repeated.checkedAt,
  });

  const queued = manager.request("tool", "update");
  await manager.waitForIdle();
  assert.equal(manager.getJob(queued.id).state, "succeeded");
  assert.equal(manager.snapshot().apps[0].updateCheck, undefined, "a completed update invalidates the cached check");
});

test("update checks report unknown instead of failing when the checker throws", async () => {
  const dirs = stateDirs("task-handoff-app-update-check-error-");
  const recipe = { type: "system-package", platforms: ["linux"], installer: "apt", packages: ["tool"], privilege: "root" };
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()], capabilities: () => capabilities,
    detection: () => ({ state: "installed", executablePaths: ["/usr/bin/tool"] }),
    ownership: async () => ({ source: "recipe", recipe }),
    updateCheck: async () => { throw new Error("command_timeout"); },
    now: () => "2026-05-01T00:00:00.000Z",
  });
  await manager.refreshSnapshot();
  assert.deepEqual(await manager.checkForUpdate("tool"), {
    appId: "tool",
    status: "unknown",
    reason: "command_timeout",
    checkedAt: "2026-05-01T00:00:00.000Z",
  });
});

test("update checks reject apps that app management does not own", async () => {
  const dirs = stateDirs("task-handoff-app-update-check-reject-");
  const manager = new AppManagementManager({
    ...dirs,
    definitions: () => [app()], capabilities: () => capabilities,
    detection: () => ({ state: "installed", executablePaths: ["/usr/bin/tool"] }),
    ownership: async () => ({ source: "external" }),
  });
  await manager.refreshSnapshot();
  await assert.rejects(() => manager.checkForUpdate("tool"), (error) => {
    assert.equal(error instanceof AppManagementRequestError, true);
    assert.equal(error.code, "app_operation_unavailable");
    assert.equal(error.statusCode, 409);
    return true;
  });
  await assert.rejects(() => manager.checkForUpdate("missing"), (error) => {
    assert.equal(error.code, "unknown_app");
    assert.equal(error.statusCode, 404);
    return true;
  });
});

test("provider package hooks drain before mutation and finish before queue admission reopens", async () => {
  const dirs = stateDirs("desktop-package-hooks-");
  let state = "not-installed";
  const order = [];
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let entered; const started = new Promise((resolve) => { entered = resolve; });
  const manager = new AppManagementManager({
    ...dirs, definitions:()=>[app()], capabilities:()=>capabilities,
    detection:()=>({ state, executablePaths:state === "installed" ? ["/bin/tool"] : [] }),
    packageLifecycle:()=>({
      beforeChange:async () => { order.push("drain"); entered(); await gate; },
      changed:async (_op,success) => { assert.equal(success,true); assert.equal(manager.hasActiveOperation("tool"),true); order.push("changed"); },
    }),
    execute:async () => { order.push("mutate"); state="installed"; },
    publish:(event)=>{ if (event.job?.state === "succeeded") order.push("terminal"); },
  });
  const job = manager.request("tool","install");
  await started;
  assert.equal(manager.hasActiveOperation("tool"),true);
  assert.deepEqual(order,["drain"]);
  assert.throws(()=>manager.request("tool","uninstall"), (error)=>error.code==="app_operation_conflict");
  release(); await manager.waitForIdle();
  assert.equal(manager.getJob(job.id).state,"succeeded");
  assert.deepEqual(order,["drain","mutate","changed","terminal"]);
});

test("failed provider drain never mutates package files or bypasses failure cleanup", async () => {
  const dirs = stateDirs("desktop-package-drain-failure-");
  let executed=false, cleaned=false;
  const manager = new AppManagementManager({
    ...dirs, definitions:()=>[app()], capabilities:()=>capabilities,
    detection:()=>({state:"not-installed",executablePaths:[]}),
    packageLifecycle:()=>({ beforeChange:()=>{throw new Error("drain failed");}, changed:(_op,success)=>{assert.equal(success,false);cleaned=true;} }),
    execute:async()=>{executed=true;},
  });
  const job=manager.request("tool","install"); await manager.waitForIdle();
  assert.equal(manager.getJob(job.id).state,"failed"); assert.equal(executed,false); assert.equal(cleaned,true);
});
