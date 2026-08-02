const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  ImageProfileSchema,
  InstanceLifecycleEventType,
  normalizeDockerImageReference,
  sanitizeStoredImageProfile,
} = require("../packages/protocol/src/control-plane.ts");
const { DockerImageService } = require("../packages/control-plane/src/node-agent/docker-images.ts");
const { createNodeAgentApp } = require("../packages/control-plane/src/node-agent/app.ts");
const { defaultTerminalCommandRunner } = require("../packages/control-plane/src/shared/process/terminal-command-runner.ts");

const digest = (letter) => `sha256:${letter.repeat(64)}`;
const tempDataDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

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
  while (Date.now() - startedAt < 2_000) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} timed out`);
}

function imageProfile(reference = "docker.io/example/controlled:v1") {
  const timestamp = new Date().toISOString();
  const tag = reference.includes(":") ? reference.slice(reference.lastIndexOf(":") + 1) : undefined;
  const repository = tag ? reference.slice(0, reference.lastIndexOf(":")) : reference.split("@")[0];
  return {
    id: "img_test",
    origin: "custom",
    name: "Test image",
    repository,
    tag,
    requestedReference: reference,
    pullPolicy: "if-not-present",
    capabilities: [],
    optionalApps: [],
    defaultEnv: {},
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test("Docker image references require explicit tags or sha256 digests", () => {
  assert.equal(normalizeDockerImageReference("registry.example:5000/org/app:v1"), "registry.example:5000/org/app:v1");
  assert.equal(
    normalizeDockerImageReference(`GHCR.IO/org/app@${digest("A")}`),
    `ghcr.io/org/app@${digest("a")}`,
  );
  assert.throws(() => normalizeDockerImageReference("docker.io/org/app"), /explicit tag/);
  assert.throws(() => normalizeDockerImageReference("https://docker.io/org/app:v1"), /URL scheme/);
  assert.throws(() => normalizeDockerImageReference("docker.io/Upper/app:v1"), /lowercase/);
});

test("stored legacy image profiles migrate before strict parsing", () => {
  const timestamp = new Date().toISOString();
  const warnings = [];
  const migrated = sanitizeStoredImageProfile({
    id: "img_legacy",
    name: "Legacy",
    image: "example/legacy",
    registry: "local",
    capabilities: [],
    optionalApps: [],
    defaultEnv: {},
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    futureField: true,
  }, (warning) => warnings.push(warning.field));
  const parsed = ImageProfileSchema.parse(migrated);
  assert.equal(parsed.reference, "example/legacy:latest");
  assert.equal(parsed.pullPolicy, "if-not-present");
  assert.deepEqual(warnings, ["futureField", "image", "registry", "reference:implicit-latest"]);
  assert.equal("futureField" in parsed, false);

  const invalid = sanitizeStoredImageProfile({ ...migrated, reference: "https://invalid/repository" });
  assert.equal(ImageProfileSchema.safeParse(invalid).success, false);
});

test("Docker image service reuses local images and resolves their digest", async () => {
  const calls = [];
  const service = new DockerImageService(async (command, args) => {
    calls.push([command, args]);
    return { stdout: JSON.stringify({ Id: digest("a"), RepoDigests: [`docker.io/example/app@${digest("a")}`] }), stderr: "" };
  });
  const phases = [];
  const result = await service.ensure("docker.io/example/app:v1", (phase) => phases.push(phase));
  assert.equal(result.pulled, false);
  assert.equal(result.resolvedDigest, digest("a"));
  assert.equal(result.resolvedReference, `docker.io/example/app@${digest("a")}`);
  assert.deepEqual(phases, ["checking-image", "resolving-image"]);
  assert.deepEqual(calls, [["docker", ["image", "inspect", "docker.io/example/app:v1", "--format", "{{json .}}"]]]);
});

test("Docker image service keeps the requested reference when a local image has no repo digest", async () => {
  const service = new DockerImageService(async () => ({
    stdout: JSON.stringify({ Id: digest("f"), RepoDigests: [] }),
    stderr: "",
  }));
  const result = await service.ensure("task-handoff-web:local");
  assert.equal(result.resolvedDigest, undefined);
  assert.equal(result.resolvedReference, "task-handoff-web:local");
});

test("Docker image service single-flights concurrent pulls and permits retry after failure", async () => {
  let available = false;
  let failPull = true;
  let pullCalls = 0;
  const service = new DockerImageService(async (_command, args) => {
    if (args[0] === "image") {
      if (!available) throw new Error("missing");
      return { stdout: JSON.stringify({ Id: digest("b"), RepoDigests: [`docker.io/example/app@${digest("b")}`] }), stderr: "" };
    }
    if (args[0] === "pull") {
      pullCalls += 1;
      if (failPull) throw new Error("registry unavailable");
      available = true;
      return { stdout: "pulled", stderr: "" };
    }
    throw new Error(`Unexpected Docker command ${args.join(" ")}`);
  });

  await assert.rejects(() => service.ensure("docker.io/example/app:v1"), /registry unavailable/);
  failPull = false;
  const firstPhases = [];
  const secondPhases = [];
  const [first, second] = await Promise.all([
    service.ensure("docker.io/example/app:v1", (phase) => firstPhases.push(phase)),
    service.ensure("docker.io/example/app:v1", (phase) => secondPhases.push(phase)),
  ]);
  assert.equal(first.resolvedDigest, digest("b"));
  assert.deepEqual(second, first);
  assert.equal(pullCalls, 2);
  assert.deepEqual(firstPhases, ["checking-image", "pulling-image", "resolving-image"]);
  assert.deepEqual(secondPhases, ["checking-image", "pulling-image", "resolving-image"]);
});

test("Docker image service aborts the underlying pull process", async () => {
  let pullSignal;
  let pullExited = false;
  const service = new DockerImageService(
    async () => { throw new Error("missing"); },
    async (_command, _args, options) => {
      pullSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          setImmediate(() => {
            pullExited = true;
            reject(Object.assign(new Error("docker was aborted."), { code: "RUNTIME_COMMAND_ABORTED" }));
          });
        }, { once: true });
      });
    },
  );
  const controller = new AbortController();
  const pulling = service.ensure("docker.io/example/app:v1", undefined, undefined, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pullSignal.aborted, false);

  controller.abort();
  await assert.rejects(pulling, (error) => error.code === "RUNTIME_COMMAND_ABORTED");
  assert.equal(pullSignal.aborted, true);
  assert.equal(pullExited, true);
});

test("terminal command cancellation kills and reaps the child process", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const running = defaultTerminalCommandRunner(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  controller.abort();

  await assert.rejects(running, (error) => error.code === "RUNTIME_COMMAND_ABORTED");
  assert.ok(Date.now() - startedAt < 2_000);
});

test("node-agent creates immediately, provisions the image, and blocks stale worker writes after deletion", async (t) => {
  let releasePull;
  let available = false;
  const pullGate = new Promise((resolve) => { releasePull = resolve; });
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-image-provisioning"),
    logger: false,
    token: "agent-secret",
    dockerCommandRunner: async (_command, args) => {
      if (args[0] === "image") {
        if (!available) throw new Error("missing");
        return { stdout: JSON.stringify({ Id: digest("c"), RepoDigests: [`docker.io/example/controlled@${digest("c")}`] }), stderr: "" };
      }
      if (args[0] === "pull") {
        await pullGate;
        available = true;
        return { stdout: "pulled", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  });
  t.after(() => app.close());
  const create = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_pull",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_test" },
      image: imageProfile(),
      source: { type: "local-folder", path: "/tmp/project" },
    },
  });
  assert.equal(create.statusCode, 201);
  assert.equal(create.json().data.status, "provisioning");
  await waitFor(() => app.nodeAgentState.controlledInstances.get("inst_pull")?.imageProvisioning?.phase === "pulling-image", "pull phase");

  const deleted = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_pull/delete",
    headers: { authorization: "Bearer agent-secret" },
  });
  assert.equal(deleted.statusCode, 200);
  releasePull();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(app.nodeAgentState.controlledInstances.get("inst_pull"), undefined);
});

test("node-agent queues start while pulling and runs the container when the image is ready", async (t) => {
  let releasePull;
  let available = false;
  const calls = [];
  const pullGate = new Promise((resolve) => { releasePull = resolve; });
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-image-queued-start"),
    logger: false,
    token: "agent-secret",
    fetchImpl: async () => ({ ok: false }),
    dockerCommandRunner: async (_command, args) => {
      calls.push(args);
      if (args[0] === "image") {
        if (!available) throw new Error("missing");
        return { stdout: JSON.stringify({ Id: digest("f"), RepoDigests: [`docker.io/example/controlled@${digest("f")}`] }), stderr: "" };
      }
      if (args[0] === "pull") {
        await pullGate;
        available = true;
        return { stdout: "pulled", stderr: "" };
      }
      if (args[0] === "inspect" && args[1] === "--format" && args[2] === "{{json .}}") throw new Error("No such container");
      if (args[0] === "run") return { stdout: "container-queued", stderr: "" };
      if (args[0] === "port") return { stdout: "127.0.0.1:18080", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  });
  t.after(() => app.close());
  const lifecycleEvents = [];
  const imagePullEvents = [];
  app.nodeAgentEventForwarder.addOutput({
    readyState: 1,
    OPEN: 1,
    send: (value) => {
      const message = JSON.parse(value);
      if (message.event?.type === InstanceLifecycleEventType.Snapshot) lifecycleEvents.push(message.event.payload);
      if (message.event?.type?.startsWith("image.pull.terminal.")) imagePullEvents.push(message.event);
    },
    on: () => undefined,
  });

  await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_queued_start",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_test" },
      image: imageProfile(),
      source: { type: "local-folder", path: "/tmp/project" },
    },
  });
  await waitFor(() => app.nodeAgentState.controlledInstances.get("inst_queued_start")?.imageProvisioning?.phase === "pulling-image", "pull phase");

  const start = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_queued_start/start",
    headers: { authorization: "Bearer agent-secret" },
    payload: {},
  });
  assert.equal(start.statusCode, 200, start.body);
  assert.equal(start.json().data.status, "starting");
  assert.equal(calls.some((args) => args[0] === "run"), false);

  releasePull();
  const started = await waitFor(() => {
    const instance = app.nodeAgentState.controlledInstances.get("inst_queued_start");
    return instance?.runtime.containerId === "container-queued" ? instance : undefined;
  }, "queued container start");
  assert.equal(started.status, "registering");
  assert.equal(started.imageProvisioning.phase, "ready");
  assert.equal(calls.filter((args) => args[0] === "run").length, 1);
  const instanceEvents = lifecycleEvents.filter((event) => event.instanceId === "inst_queued_start");
  assert.ok(instanceEvents.some((event) => event.imageProvisioning?.phase === "pulling-image"));
  assert.ok(instanceEvents.some((event) => event.status === "starting" && event.imageProvisioning?.phase === "pulling-image"));
  assert.ok(instanceEvents.some((event) => event.status === "starting" && event.imageProvisioning?.phase === "ready"));
  assert.ok(instanceEvents.some((event) => event.status === "registering" && event.imageProvisioning?.phase === "ready"));
  assert.deepEqual(instanceEvents.map((event) => event.revision), [...instanceEvents.map((event) => event.revision)].sort((a, b) => a - b));
  assert.deepEqual(imagePullEvents.map((event) => event.type), ["image.pull.terminal.output", "image.pull.terminal.finished"]);
  assert.equal(imagePullEvents[0].payload.data, "pulled");
  assert.equal(imagePullEvents[1].payload.outcome, "succeeded");
});

test("node-agent streams Docker pull TTY output live and replays its bounded tail to a reconnected control plane", async (t) => {
  let releasePull;
  let available = false;
  const pullGate = new Promise((resolve) => { releasePull = resolve; });
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-image-tty"),
    logger: false,
    token: "agent-secret",
    dockerCommandRunner: async (_command, args) => {
      if (args[0] === "image") {
        if (!available) throw new Error("missing");
        return { stdout: JSON.stringify({ Id: digest("a"), RepoDigests: [`docker.io/example/controlled@${digest("a")}`] }), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    dockerTerminalCommandRunner: async (_command, _args, options) => {
      options.onData("aaaaaa111111: Downloading  5 MiB/10 MiB\r\n");
      await pullGate;
      available = true;
      return { stdout: "", stderr: "" };
    },
  });
  t.after(() => app.close());
  const first = [];
  app.nodeAgentEventForwarder.addOutput(eventSocket(first));
  await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_tty_pull",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_test" },
      image: imageProfile(),
      source: { type: "local-folder", path: "/tmp/project" },
    },
  });
  await waitFor(() => first.some((event) => event.type === "image.pull.terminal.output"), "live TTY output");
  const reconnected = [];
  app.nodeAgentEventForwarder.addOutput(eventSocket(reconnected));
  const replay = reconnected.find((event) => event.type === "image.pull.terminal.output");
  assert.equal(replay.payload.replay, true);
  assert.match(replay.payload.data, /Downloading/);
  releasePull();
  await waitFor(() => app.nodeAgentState.controlledInstances.get("inst_tty_pull")?.imageProvisioning?.phase === "ready", "TTY pull ready");
});

test("failed node-agent image provisioning is persisted and can be retried", async (t) => {
  let failPull = true;
  let available = false;
  const app = await createNodeAgentApp({
    dataDir: tempDataDir("node-image-retry"),
    logger: false,
    token: "agent-secret",
    dockerCommandRunner: async (_command, args) => {
      if (args[0] === "image") {
        if (!available) throw new Error("missing");
        return { stdout: JSON.stringify({ Id: digest("d"), RepoDigests: [`docker.io/example/controlled@${digest("d")}`] }), stderr: "" };
      }
      if (args[0] === "pull") {
        if (failPull) throw new Error("registry unavailable");
        available = true;
        return { stdout: "pulled", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  });
  t.after(() => app.close());
  await app.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_retry",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_test" },
      image: imageProfile(),
      source: { type: "local-folder", path: "/tmp/project" },
    },
  });
  const failed = await waitFor(() => {
    const instance = app.nodeAgentState.controlledInstances.get("inst_retry");
    return instance?.status === "failed" ? instance : undefined;
  }, "failed provisioning");
  assert.match(failed.imageProvisioning.error, /registry unavailable/);

  failPull = false;
  const retry = await app.inject({
    method: "POST",
    url: "/api/node-agent/instances/inst_retry/image-provisioning/retry",
    headers: { authorization: "Bearer agent-secret" },
  });
  assert.equal(retry.statusCode, 200);
  const ready = await waitFor(() => {
    const instance = app.nodeAgentState.controlledInstances.get("inst_retry");
    return instance?.status === "created" ? instance : undefined;
  }, "retried provisioning");
  assert.equal(ready.imageProvisioning.phase, "ready");
  assert.equal(ready.imageSnapshot.resolvedDigest, digest("d"));
});

test("node-agent restart migrates and resumes persisted image provisioning without a control plane", async (t) => {
  const dataDir = tempDataDir("node-image-restore");
  const first = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
    dockerCommandRunner: async (_command, args) => {
      if (args[0] === "image") throw new Error("missing");
      if (args[0] === "pull") throw new Error("temporary registry outage");
      return { stdout: "", stderr: "" };
    },
  });
  await first.inject({
    method: "POST",
    url: "/api/node-agent/instances",
    headers: { authorization: "Bearer agent-secret" },
    payload: {
      id: "inst_restore",
      runtimeId: "runtime_local_docker",
      imageSelection: { imageId: "img_test" },
      image: imageProfile("docker.io/example/controlled:v1"),
      source: { type: "local-folder", path: "/tmp/project" },
    },
  });
  await waitFor(() => first.nodeAgentState.controlledInstances.get("inst_restore")?.status === "failed", "initial failed provisioning");
  await first.close();

  const instancePath = path.join(dataDir, "controlled-instances", "inst_restore.json");
  const stored = JSON.parse(fs.readFileSync(instancePath, "utf8"));
  const { requestedReference: _requestedReference, ...legacySnapshot } = stored.imageSnapshot;
  stored.imageSnapshot = {
    ...legacySnapshot,
    image: "docker.io/example/controlled",
    registry: "legacy-local",
    futureSnapshotField: true,
  };
  stored.status = "starting";
  stored.health = "unknown";
  stored.imageProvisioning = {
    phase: "checking-image",
    requestedReference: "docker.io/example/controlled:latest",
    generation: 1,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    futureProvisioningField: true,
  };
  stored.futureInstanceField = true;
  fs.writeFileSync(instancePath, `${JSON.stringify(stored, null, 2)}\n`);

  let available = false;
  const restored = await createNodeAgentApp({
    dataDir,
    logger: false,
    token: "agent-secret",
    fetchImpl: async () => ({ ok: false }),
    dockerCommandRunner: async (_command, args) => {
      if (args[0] === "image") {
        if (!available) throw new Error("missing");
        return { stdout: JSON.stringify({ Id: digest("e"), RepoDigests: [`docker.io/example/controlled@${digest("e")}`] }), stderr: "" };
      }
      if (args[0] === "pull") {
        available = true;
        return { stdout: "pulled", stderr: "" };
      }
      if (args[0] === "inspect" && args[1] === "--format" && args[2] === "{{json .}}") throw new Error("No such container");
      if (args[0] === "run") return { stdout: "container-restored", stderr: "" };
      if (args[0] === "port") return { stdout: "127.0.0.1:18081", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  });
  t.after(() => restored.close());
  await restored.nodeAgentRestoreManagedInstances();
  const ready = await waitFor(() => {
    const instance = restored.nodeAgentState.controlledInstances.get("inst_restore");
    return instance?.runtime.containerId === "container-restored" ? instance : undefined;
  }, "restored provisioning");
  assert.equal(ready.status, "registering");
  assert.equal(ready.imageProvisioning.phase, "ready");
  assert.equal(ready.imageSnapshot.requestedReference, "docker.io/example/controlled:latest");
  assert.equal(ready.imageSnapshot.resolvedDigest, digest("e"));
  assert.equal("futureInstanceField" in ready, false);
  assert.equal("futureSnapshotField" in ready.imageSnapshot, false);
});
