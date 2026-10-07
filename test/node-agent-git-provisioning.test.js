const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createNodeAgentApp } = require("../packages/control-plane/src/node-agent/app.ts");
const { agentRunRuntimeVolume } = require("../packages/control-plane/src/node-agent/runtimes/docker.ts");

const gitProvisionScript = "/run/task-handoff/bootstrap/git-provision.sh";
const commit = "a".repeat(40);

function tempDataDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function managedVolumeInspect(args, instanceId) {
  if (args[0] !== "volume" || args[1] !== "inspect") return undefined;
  const name = args.at(-1);
  const agentRunVolume = agentRunRuntimeVolume("node_git_test", "runtime_local_docker");
  if (agentRunVolume.name === name) {
    return { stdout: JSON.stringify({ Name: name, Driver: "local", Labels: agentRunVolume.labels }), stderr: "" };
  }
  const role = name.endsWith("-agent-home") ? "agent-home" : name.endsWith("-runtime") ? "runtime" : name.endsWith("-workspace") ? "workspace" : "data";
  return { stdout: JSON.stringify({ Name: name, Labels: {
    "task-handoff.owner": "task-handoff",
    "task-handoff.instance-id": instanceId,
    "task-handoff.volume-role": role,
  } }), stderr: "" };
}

function eventSocket(events) {
  return {
    readyState: 1,
    OPEN: 1,
    send: (value) => {
      const message = JSON.parse(value);
      if (message.event) events.push(message.event);
    },
    on: () => undefined,
  };
}

async function waitFor(check, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3_000) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} timed out`);
}

function gitInstanceInput(id) {
  const timestamp = new Date().toISOString();
  return {
    id,
    runtimeId: "runtime_local_docker",
    imageSelection: { imageId: "img_git" },
    image: {
      id: "img_git", origin: "custom", name: "Git image", repository: "docker.io/example/controlled", tag: "v1",
      requestedReference: "docker.io/example/controlled:v1", pullPolicy: "if-not-present",
      capabilities: [], optionalApps: [], defaultEnv: {}, labels: {}, createdAt: timestamp, updatedAt: timestamp,
    },
    source: {
      type: "git-repository",
      url: "https://git.example.test/team/repo.git",
      ref: { type: "branch", name: "main" },
      auth: { type: "none" },
      clone: { submodules: false, lfs: false, subdirectory: "" },
    },
  };
}

function dockerCommandRunner(calls, { available = true } = {}) {
  return async (_command, args) => {
    calls.push(args);
    const volume = managedVolumeInspect(args, "inst_git_async");
    if (volume) return volume;
    if (args[0] === "image" && args[1] === "inspect") {
      if (!available) throw new Error("missing");
      return { stdout: JSON.stringify({ Id: `sha256:${"c".repeat(64)}`, RepoDigests: [`docker.io/example/controlled@sha256:${"c".repeat(64)}`] }), stderr: "" };
    }
    if (args[0] === "inspect" && args[1] === "--format") throw new Error("No such container");
    if (args[0] === "run") return { stdout: "container-git", stderr: "" };
    if (args[0] === "port") return { stdout: "127.0.0.1:18080", stderr: "" };
    return { stdout: args.at(-1) || "", stderr: "" };
  };
}

// Models Docker's real volume semantics: `volume create` never relabels an
// existing volume, and any container mount that references a missing named
// volume silently auto-creates it without labels.
function dockerVolumeSimulator(calls, volumes) {
  const mountSpecs = (args) => args.flatMap((value, index) => {
    if (args[index - 1] !== "--mount") return [];
    const spec = Object.fromEntries((value || "").split(",").map((part) => part.split("=")));
    return spec.type === "volume" && spec.src ? [spec] : [];
  });
  return async (_command, args) => {
    calls.push(args);
    if (args[0] === "volume" && args[1] === "create") {
      const labels = {};
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] !== "--label") continue;
        const [key, value] = String(args[index + 1]).split("=");
        labels[key] = value;
      }
      const name = args.at(-1);
      if (!volumes.has(name)) volumes.set(name, labels);
      return { stdout: name, stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const name = args.at(-1);
      const labels = volumes.get(name);
      if (labels === undefined) throw new Error(`No such volume: ${name}`);
      return { stdout: JSON.stringify({ Name: name, Driver: "local", Options: {}, Labels: Object.keys(labels).length ? labels : null }), stderr: "" };
    }
    if (args[0] === "run") {
      for (const spec of mountSpecs(args)) if (!volumes.has(spec.src)) volumes.set(spec.src, {});
      return { stdout: "container-git", stderr: "" };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return { stdout: JSON.stringify({ Id: `sha256:${"c".repeat(64)}`, RepoDigests: [`docker.io/example/controlled@sha256:${"c".repeat(64)}`] }), stderr: "" };
    }
    if (args[0] === "inspect" && args[1] === "--format") throw new Error("No such container");
    if (args[0] === "port") return { stdout: "127.0.0.1:18080", stderr: "" };
    return { stdout: args.at(-1) || "", stderr: "" };
  };
}

test("node-agent starts Git instances without blocking and streams provisioning progress", async (t) => {
  let releaseClone;
  const cloneGate = new Promise((resolve) => { releaseClone = resolve; });
  const calls = [];
  const gitRuns = [];
  const app = await createNodeAgentApp({
    nodeId: "node_git_test",
    dataDir: tempDataDir("node-git-async"),
    logger: false,
    token: "agent-secret",
    fetchImpl: async () => ({ ok: false }),
    dockerCommandRunner: dockerCommandRunner(calls),
    dockerTerminalCommandRunner: async (_command, args, options = {}) => {
      if (!args.includes(gitProvisionScript)) return { stdout: "", stderr: "" };
      gitRuns.push(args);
      options.onData("TASK_HANDOFF_GIT_PROVISIONING_STAGE=cloning\n");
      options.onData("Cloning into 'checkout'...\n");
      options.onData("Receiving objects:  50% (1/2)\rReceiving objects: 100% (2/2), done.\n");
      await cloneGate;
      options.onData("TASK_HANDOFF_GIT_PROVISIONING_STAGE=finalizing\n");
      options.onData(`TASK_HANDOFF_GIT_PROVISIONING_COMMIT=${commit}\n`);
      return { stdout: "", stderr: "" };
    },
  });
  t.after(() => app.close());
  const events = [];
  app.nodeAgentEventForwarder.addOutput(eventSocket(events));

  const create = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: gitInstanceInput("inst_git_async"),
  });
  assert.equal(create.statusCode, 201, create.body);
  assert.equal(create.json().data.workspace.gitProvisioning.phase, "pending");

  await waitFor(() => app.nodeAgentState.controlledInstances.get("inst_git_async")?.imageProvisioning?.phase === "ready", "image ready");

  const startedAt = Date.now();
  const start = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_git_async/start",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(start.statusCode, 200, start.body);
  assert.ok(Date.now() - startedAt < 2_000, "start must not block on the Git clone");
  assert.equal(start.json().data.status, "starting");
  assert.notEqual(start.json().data.workspace.gitProvisioning.phase, "ready");
  const provisioningCallsBeforeReady = gitRuns.length;
  assert.equal(calls.some((args) => args[0] === "run" && args.includes("task-handoff") && !args.includes(gitProvisionScript)), false);

  releaseClone();
  const ready = await waitFor(() => {
    const instance = app.nodeAgentState.controlledInstances.get("inst_git_async");
    return instance?.workspace.gitProvisioning.phase === "ready" ? instance : undefined;
  }, "git ready");
  assert.equal(ready.workspace.resolvedCommit, commit);
  assert.equal(gitRuns.length, 1);
  assert.ok(provisioningCallsBeforeReady >= 1);

  await waitFor(() => app.nodeAgentState.controlledInstances.get("inst_git_async")?.runtime.containerId === "container-git", "container start");
  assert.equal(gitRuns.length, 1, "the workspace must never be cloned twice");
  assert.equal(calls.filter((args) => args[0] === "run" && !args.includes(gitProvisionScript)).length, 1);

  const gitEvents = events.filter((event) => event.type?.startsWith("git.provisioning."));
  const output = gitEvents.filter((event) => event.type === "git.provisioning.terminal.output");
  assert.ok(output.length >= 3);
  assert.equal(output.some((event) => event.payload.data.includes("TASK_HANDOFF_GIT_PROVISIONING_STAGE=")), true);
  assert.equal(output.some((event) => event.payload.data.includes("Receiving objects")), true);
  const finished = gitEvents.filter((event) => event.type === "git.provisioning.terminal.finished");
  assert.equal(finished.at(-1).payload.outcome, "succeeded");
  assert.equal(finished.at(-1).payload.generation, 0);
});

test("node-agent records a failed Git provision with its reason and retries it", async (t) => {
  const calls = [];
  const gitRuns = [];
  let attempt = 0;
  const app = await createNodeAgentApp({
    nodeId: "node_git_test",
    dataDir: tempDataDir("node-git-retry"),
    logger: false,
    token: "agent-secret",
    fetchImpl: async () => ({ ok: false }),
    dockerCommandRunner: dockerCommandRunner(calls),
    dockerTerminalCommandRunner: async (_command, args, options = {}) => {
      if (!args.includes(gitProvisionScript)) return { stdout: "", stderr: "" };
      gitRuns.push(args);
      attempt += 1;
      options.onData("TASK_HANDOFF_GIT_PROVISIONING_STAGE=cloning\n");
      if (attempt === 1) {
        options.onData("fatal: unable to access 'https://git-user:super-secret@git.example.test/team/repo.git/': Could not resolve host\n");
        throw Object.assign(new Error("git clone failed"), {
          details: { stderr: "fatal: unable to access 'https://git-user:super-secret@git.example.test/team/repo.git/'\nTASK_HANDOFF_GIT_PROVISIONING_ERROR=CLONE_FAILED" },
        });
      }
      options.onData("TASK_HANDOFF_GIT_PROVISIONING_STAGE=finalizing\n");
      options.onData(`TASK_HANDOFF_GIT_PROVISIONING_COMMIT=${commit}\n`);
      return { stdout: "", stderr: "" };
    },
  });
  t.after(() => app.close());
  const events = [];
  app.nodeAgentEventForwarder.addOutput(eventSocket(events));

  await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: gitInstanceInput("inst_git_async"),
  });
  await waitFor(() => app.nodeAgentState.controlledInstances.get("inst_git_async")?.imageProvisioning?.phase === "ready", "image ready");
  await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_git_async/start",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });

  const failed = await waitFor(() => {
    const instance = app.nodeAgentState.controlledInstances.get("inst_git_async");
    return instance?.workspace.gitProvisioning.phase === "failed" ? instance : undefined;
  }, "git failed");
  assert.equal(failed.status, "failed");
  assert.equal(failed.workspace.status, "failed");
  assert.match(failed.workspace.gitProvisioning.error, /Git clone failed/);
  assert.equal(failed.workspace.gitProvisioning.error.includes("super-secret"), false, "failure reason must redact credentials");

  const failedFinished = events.filter((event) => event.type === "git.provisioning.terminal.finished");
  assert.equal(failedFinished.at(-1).payload.outcome, "failed");

  const retry = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_git_async/git-provisioning/retry",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(retry.statusCode, 200, retry.body);

  const ready = await waitFor(() => {
    const instance = app.nodeAgentState.controlledInstances.get("inst_git_async");
    return instance?.workspace.gitProvisioning.phase === "ready" ? instance : undefined;
  }, "git retry ready");
  assert.equal(ready.workspace.gitProvisioning.generation, 1);
  assert.equal(ready.workspace.gitProvisioning.error, undefined);
  assert.equal(gitRuns.length, 2);
  const finished = events.filter((event) => event.type === "git.provisioning.terminal.finished");
  assert.equal(finished.at(-1).payload.outcome, "succeeded");
  assert.equal(finished.at(-1).payload.generation, 1);
});

test("git provisioning materializes the labeled workspace volume before the clone container can auto-create it", async (t) => {
  const calls = [];
  const volumes = new Map();
  const dockerRunner = dockerVolumeSimulator(calls, volumes);
  const app = await createNodeAgentApp({
    nodeId: "node_git_test",
    dataDir: tempDataDir("node-git-volume-labels"),
    logger: false,
    token: "agent-secret",
    fetchImpl: async () => ({ ok: false }),
    dockerCommandRunner: dockerRunner,
    dockerTerminalCommandRunner: async (_command, args, options = {}) => {
      // The provisioning container is the first thing to mount the workspace
      // volume, so its `docker run` must go through the same volume semantics.
      await dockerRunner("docker", args);
      if (!args.includes(gitProvisionScript)) return { stdout: "", stderr: "" };
      options.onData("TASK_HANDOFF_GIT_PROVISIONING_STAGE=cloning\n");
      options.onData(`TASK_HANDOFF_GIT_PROVISIONING_COMMIT=${commit}\n`);
      return { stdout: "", stderr: "" };
    },
  });
  t.after(() => app.close());

  const create = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: gitInstanceInput("inst_git_async"),
  });
  assert.equal(create.statusCode, 201, create.body);
  await waitFor(() => app.nodeAgentState.controlledInstances.get("inst_git_async")?.imageProvisioning?.phase === "ready", "image ready");
  await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_git_async/start",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });

  await waitFor(() => app.nodeAgentState.controlledInstances.get("inst_git_async")?.workspace.gitProvisioning.phase === "ready", "git ready");
  const started = await waitFor(() => {
    const instance = app.nodeAgentState.controlledInstances.get("inst_git_async");
    return instance && (instance.runtime.containerId === "container-git" || instance.status === "failed") ? instance : undefined;
  }, "start settled");
  assert.equal(started.status === "failed", false, started.workspace.error);
  assert.equal(started.runtime.containerId, "container-git");

  const workspaceVolume = "task-handoff-inst_git_async-workspace";
  assert.deepEqual(volumes.get(workspaceVolume), {
    "task-handoff.owner": "task-handoff",
    "task-handoff.instance-id": "inst_git_async",
    "task-handoff.node-id": "node_git_test",
    "task-handoff.volume-role": "workspace",
  });
  const workspaceCreateIndex = calls.findIndex((args) => args[0] === "volume" && args[1] === "create" && args.at(-1) === workspaceVolume);
  const instanceRunIndex = calls.findIndex((args) => args[0] === "run" && !args.includes(gitProvisionScript));
  assert.ok(workspaceCreateIndex >= 0, "the workspace volume must be created by node-agent, not auto-created by Docker");
  assert.ok(instanceRunIndex === -1 || workspaceCreateIndex < instanceRunIndex, "labeled volumes must exist before any container mounts them");
});
