const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ControlledInstanceSchema } = require("../packages/protocol/src/control-plane.ts");
const { InstancePrivateConfigStore } = require("../packages/control-plane/src/node-agent/instances/private-config-store.ts");
const { nodeAgentStorePaths } = require("../packages/control-plane/src/node-agent/persistence/paths.ts");
const { LocalDockerExecutor, assertDockerConfigHasNoSecrets, dockerRunArgs } = require("../packages/control-plane/src/node-agent/runtimes/docker.ts");

const timestamp = "2026-08-04T00:00:00.000Z";

function managedVolume(instanceId, role, name, mountPath) {
  return {
    role,
    name,
    mountPath,
    labels: {
      "task-handoff.owner": "task-handoff",
      "task-handoff.instance-id": instanceId,
      "task-handoff.node-id": "node_one",
      "task-handoff.volume-role": role,
    },
  };
}

function context(source = { type: "local-folder", path: "/tmp/workspace" }) {
  const instanceId = "inst_one";
  return {
    privateConfigPath: "/private/inst_one.json",
    nodeAgentUrl: "http://host.docker.internal:8091",
    modelEnv: { OPENAI_API_KEY: "model-secret", OPENAI_BASE_URL: "https://models.example/v1" },
    node: {
      id: "node_one", name: "Node", connectionMode: "direct-http", status: "online", health: "ok",
      capabilities: {}, labels: {}, createdAt: timestamp, updatedAt: timestamp,
    },
    runtime: {
      id: "runtime_local_docker", nodeId: "node_one", name: "Docker", type: "docker", status: "online",
      accessStrategy: "direct-port", capabilities: {}, labels: {}, createdAt: timestamp, updatedAt: timestamp,
    },
    project: {
      id: "proj_one", name: "Project", source,
      workspacePolicy: { mode: source.type === "local-folder" ? "local-bind" : "git-clone", path: "/workspace", readOnly: false },
      labels: {}, createdAt: timestamp, updatedAt: timestamp,
    },
    image: {
      id: "img_one", origin: "custom", name: "Image", repository: "task-handoff-web", tag: "latest",
      requestedReference: "task-handoff-web:latest", pullPolicy: "if-not-present", capabilities: [], optionalApps: [],
      defaultEnv: {}, labels: {}, createdAt: timestamp, updatedAt: timestamp,
    },
    instance: ControlledInstanceSchema.parse({
      id: instanceId, name: "Instance", projectId: "proj_one", source, sourceSnapshot: {}, modelSelection: {},
      nodeId: "node_one", runtimeId: "runtime_local_docker", imageSelection: { imageId: "img_one" },
      access: { strategy: "control-plane-proxy", status: "unknown" }, runtime: { labels: {} },
      registrationToken: "registration-secret", createdAt: timestamp, updatedAt: timestamp,
    }),
  };
}

function persistentVolumes(value) {
  const instanceId = value.instance.id;
  return [
    managedVolume(instanceId, "data", `task-handoff-${instanceId}-data`, "/data"),
    managedVolume(instanceId, "agent-home", `task-handoff-${instanceId}-agent-home`, "/home/agent"),
    ...(value.project.source.type === "local-folder" ? [] : [managedVolume(instanceId, "workspace", `task-handoff-${instanceId}-workspace`, "/workspace")]),
  ];
}

function volumeForInspection(value, name) {
  return persistentVolumes(value).find((item) => item.name === name) || {
    role: "runtime",
    name: `task-handoff-${value.instance.id}-runtime`,
    mountPath: "/opt/task-handoff/instance-runtime",
    labels: {
      "task-handoff.owner": "task-handoff",
      "task-handoff.instance-id": value.instance.id,
      "task-handoff.node-id": value.node.id,
      "task-handoff.volume-role": "runtime",
    },
  };
}

function containerForInspection(value, mounts = persistentVolumes(value)) {
  return {
    Id: "managed-container-id",
    State: { Running: true },
    Config: { Labels: { "task-handoff.instance-id": value.instance.id } },
    Mounts: mounts.map((volume) => ({ Type: "volume", Name: volume.name, Destination: volume.mountPath })),
  };
}

test("private instance config is atomically materialized with restricted permissions", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-private-config-"));
  try {
    const store = new InstancePrivateConfigStore(nodeAgentStorePaths(dataDir));
    const value = store.materialize("inst_one", "registration-secret", { OPENAI_API_KEY: "model-secret" });
    assert.equal(store.get("inst_one").instanceCredential, "registration-secret");
    assert.equal("registrationToken" in JSON.parse(fs.readFileSync(store.filePath("inst_one"), "utf8")), false);
    assert.equal(value.environment.OPENAI_API_KEY, "model-secret");
    assert.equal(fs.statSync(store.filePath("inst_one")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(store.filePath("inst_one"))).mode & 0o777, 0o700);
    store.delete("inst_one");
    assert.equal(fs.existsSync(store.filePath("inst_one")), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("legacy private registration fields migrate to the long-lived credential model", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-private-config-migration-"));
  try {
    const store = new InstancePrivateConfigStore(nodeAgentStorePaths(dataDir));
    store.init();
    fs.writeFileSync(store.filePath("inst_one"), JSON.stringify({
      version: 1,
      instanceId: "inst_one",
      registrationToken: "legacy-secret",
      environment: {},
      updatedAt: timestamp,
    }));

    assert.equal(store.get("inst_one").instanceCredential, "legacy-secret");
    const migrated = JSON.parse(fs.readFileSync(store.filePath("inst_one"), "utf8"));
    assert.equal(migrated.instanceCredential, "legacy-secret");
    assert.equal("registrationToken" in migrated, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("docker config uses a read-only private file and explicit managed mounts without secrets", () => {
  const local = context();
  const args = dockerRunArgs(local, "task-handoff-inst_one");
  assert.ok(args.includes("type=bind,src=/private/inst_one.json,dst=/run/task-handoff/instance-private-config.json,readonly"));
  assert.ok(args.includes("type=volume,src=task-handoff-inst_one-data,dst=/data"));
  assert.ok(args.includes("type=volume,src=task-handoff-inst_one-agent-home,dst=/home/agent"));
  assert.ok(args.includes("type=volume,src=task-handoff-inst_one-runtime,dst=/opt/task-handoff/instance-runtime"));
  assert.ok(args.includes("/run/task-handoff/bootstrap/entrypoint.sh"));
  assert.ok(args.includes("--no-healthcheck"));
  assert.ok(args.includes("/tmp/workspace:/workspace:rw"));
  assert.equal(args.some((value) => value.includes("registration-secret") || value.includes("model-secret")), false);

  const git = context({
    type: "git-repository", repositoryId: "repo_one", url: "https://example.com/repo.git",
    ref: { type: "branch", name: "main" }, auth: { type: "none" }, clone: { depth: 1, submodules: false, lfs: false },
  });
  const gitArgs = dockerRunArgs(git, "task-handoff-inst_one");
  assert.ok(gitArgs.includes("type=volume,src=task-handoff-inst_one-workspace,dst=/workspace"));
});

test("docker executor creates and labels authoritative volumes before docker run", async () => {
  const calls = [];
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      throw Object.assign(new Error("No such container"), { details: { stderr: "No such container" } });
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return { stdout: JSON.stringify({ Id: `sha256:${"a".repeat(64)}`, RepoDigests: [] }), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const name = args.at(-1);
      const volume = volumeForInspection(context(), name);
      return { stdout: JSON.stringify({ Name: name, Labels: volume.labels }), stderr: "" };
    }
    if (args[0] === "run") return { stdout: "container-one", stderr: "" };
    if (args[0] === "port") return { stdout: "127.0.0.1:18080", stderr: "" };
    return { stdout: args.at(-1) || "", stderr: "" };
  });
  const result = await executor.start(context());
  const runIndex = calls.findIndex((args) => args[0] === "run");
  const volumeCreateIndexes = calls.flatMap((args, index) => args[0] === "volume" && args[1] === "create" ? [index] : []);
  assert.equal(volumeCreateIndexes.length, 3);
  assert.ok(volumeCreateIndexes.every((index) => index < runIndex));
  assert.equal("managedVolumes" in result.runtime, false);
});

test("legacy containers are rebuilt from the same image under the node-agent bootstrap without starting the old entrypoint", async () => {
  const value = context();
  const calls = [];
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      return { stdout: JSON.stringify({
        Id: "legacy-container-id",
        Image: "sha256:legacy-image-id",
        State: { Running: true },
        Config: { Entrypoint: ["/usr/local/bin/legacy-entrypoint"], Labels: { "task-handoff.instance-id": value.instance.id } },
        Mounts: persistentVolumes(value).map((volume) => ({ Type: "volume", Name: volume.name, Destination: volume.mountPath })),
      }), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const volume = volumeForInspection(value, args.at(-1));
      return { stdout: JSON.stringify({ Name: volume.name, Labels: volume.role === "runtime" ? volume.labels : null }), stderr: "" };
    }
    if (args[0] === "run") return { stdout: "current-container-id", stderr: "" };
    return { stdout: "", stderr: "" };
  }, { launcherAssetsDir: "C:\\Program Files\\Task Handoff\\bootstrap" });

  const result = await executor.start({
    ...value,
    instance: {
      ...value.instance,
      runtime: { ...value.instance.runtime, containerName: "task-handoff-inst_one", containerId: "legacy-container-id" },
    },
  });

  assert.deepEqual(calls.filter((args) => ["stop", "rename"].includes(args[0])).map((args) => args[0]), ["stop", "rename"]);
  assert.equal(calls.some((args) => args[0] === "start"), false);
  const run = calls.find((args) => args[0] === "run");
  assert.equal(run.at(-4), "sha256:legacy-image-id");
  assert.ok(run.includes(`type=bind,src=${path.resolve("C:\\Program Files\\Task Handoff\\bootstrap")},dst=/run/task-handoff/bootstrap,readonly`));
  assert.ok(run.includes("/run/task-handoff/bootstrap/entrypoint.sh"));
  assert.equal(result.status, "starting");
  assert.equal(result.runtime.containerId, "current-container-id");
  assert.match(result.runtime.labels["task-handoff.bootstrap-backup"], /legacy-conta/);
});

test("new docker instances reject an unrelated unlabeled volume with a colliding canonical name", async () => {
  const value = context();
  const executor = new LocalDockerExecutor(async (_command, args) => {
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      throw Object.assign(new Error("No such container"), { details: { stderr: "No such container" } });
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return { stdout: JSON.stringify({ Id: `sha256:${"a".repeat(64)}`, RepoDigests: [] }), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: JSON.stringify({ Name: args.at(-1), Labels: null }), stderr: "" };
    }
    return { stdout: args.at(-1) || "", stderr: "" };
  });

  await assert.rejects(
    () => executor.start(value),
    (error) => error.code === "INSTANCE_VOLUME_IDENTITY_MISMATCH",
  );
});

test("failed bootstrap migration restores a previously running legacy container", async () => {
  const value = context();
  const calls = [];
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      return { stdout: JSON.stringify({
        Id: "legacy-container-id",
        Image: "sha256:legacy-image-id",
        State: { Running: true },
        Config: { Labels: { "task-handoff.instance-id": value.instance.id } },
        Mounts: [],
      }), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const volume = volumeForInspection(value, args.at(-1));
      return { stdout: JSON.stringify({ Name: volume.name, Labels: volume.labels }), stderr: "" };
    }
    if (args[0] === "run") throw new Error("create failed");
    return { stdout: "", stderr: "" };
  }, { launcherAssetsDir: "/current/bootstrap" });

  await assert.rejects(() => executor.start({
    ...value,
    instance: {
      ...value.instance,
      runtime: { ...value.instance.runtime, containerName: "task-handoff-inst_one", containerId: "legacy-container-id" },
    },
  }), /Could not recreate Docker container/);

  assert.deepEqual(calls.filter((args) => ["stop", "rename", "run", "rm", "start"].includes(args[0])).map((args) => args[0]), [
    "stop",
    "rename",
    "run",
    "rm",
    "rename",
    "start",
  ]);
});

test("managed volume deletion returns partial failures and retained resources", async () => {
  const local = context();
  const executor = new LocalDockerExecutor(async (_command, args) => {
    if (args[0] === "inspect") {
      return { stdout: JSON.stringify(containerForInspection(local)), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const name = args.at(-1);
      const volume = volumeForInspection(local, name);
      return { stdout: JSON.stringify({ Name: name, Labels: volume.labels }), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "rm" && args[2].endsWith("-data")) throw new Error("volume busy");
    return { stdout: "", stderr: "" };
  });
  const partial = await executor.delete(local, { deleteVolumes: true });
  assert.equal(partial.completed, false);
  assert.deepEqual(partial.volumeResults.map((item) => item.status).sort(), ["deleted", "failed"]);

  const retainedExecutor = new LocalDockerExecutor(async (_command, args) => {
    if (args[0] === "inspect") {
      throw Object.assign(new Error("No such container"), { details: { stderr: "No such container" } });
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      throw Object.assign(new Error("No such volume"), { details: { stderr: "No such volume" } });
    }
    return { stdout: "", stderr: "" };
  });
  const retained = await retainedExecutor.delete(local, { deleteVolumes: false });
  assert.equal(retained.completed, true);
  assert.equal(retained.retainedVolumes.length, 2);
});

test("managed volume deletion is identity-safe and missing resources are idempotent", async () => {
  const git = context({
    type: "git-repository", repositoryId: "repo_one", url: "https://example.com/repo.git",
    ref: { type: "branch", name: "main" }, auth: { type: "none" }, clone: { depth: 1, submodules: false, lfs: false },
  });
  const executor = new LocalDockerExecutor(async (_command, args) => {
    if (args[0] === "inspect") {
      return { stdout: JSON.stringify(containerForInspection(git)), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const name = args.at(-1);
      if (name.endsWith("-workspace")) throw Object.assign(new Error("No such volume"), { details: { stderr: "No such volume" } });
      const volume = volumeForInspection(git, name);
      return { stdout: JSON.stringify({ Name: name, Labels: {
        ...volume.labels,
        ...(name.endsWith("-data") ? { "task-handoff.instance-id": "inst_foreign" } : {}),
      } }), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  const result = await executor.delete(git, { deleteVolumes: true });
  assert.equal(result.completed, false);
  assert.equal(result.volumeResults.find((item) => item.role === "data").error.code, "INSTANCE_VOLUME_IDENTITY_MISMATCH");
  assert.equal(result.volumeResults.find((item) => item.role === "workspace").status, "missing");

  const missingExecutor = new LocalDockerExecutor(async (_command, args) => {
    if (args[0] === "inspect") {
      throw Object.assign(new Error("No such container"), { details: { stderr: "No such container" } });
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      throw Object.assign(new Error("No such volume"), { details: { stderr: "No such volume" } });
    }
    return { stdout: "", stderr: "" };
  });
  const repeated = await missingExecutor.delete(git, { deleteVolumes: true });
  assert.equal(repeated.completed, true);
  assert.deepEqual(repeated.volumeResults.map((item) => item.status), ["missing", "missing", "missing"]);
});

test("managed volume deletion accepts mounted unlabeled v0.0.16 volumes", async () => {
  const local = context();
  const calls = [];
  const removed = [];
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect") {
      return { stdout: JSON.stringify(containerForInspection(local)), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      if (args.at(-1).endsWith("-runtime")) {
        throw Object.assign(new Error("No such volume"), { details: { stderr: "No such volume" } });
      }
      return { stdout: JSON.stringify({ Name: args.at(-1), Labels: null }), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "rm") removed.push(args[2]);
    return { stdout: "", stderr: "" };
  });

  const result = await executor.delete(local, { deleteVolumes: true });

  assert.equal(result.completed, true);
  assert.deepEqual(removed.sort(), [
    "task-handoff-inst_one-agent-home",
    "task-handoff-inst_one-data",
  ]);
  const containerInspectIndex = calls.findIndex((args) => args[0] === "inspect");
  const containerRemoveIndex = calls.findIndex((args) => args[0] === "rm");
  const volumeRemoveIndex = calls.findIndex((args) => args[0] === "volume" && args[1] === "rm");
  assert.ok(containerInspectIndex >= 0 && containerInspectIndex < containerRemoveIndex);
  assert.ok(containerRemoveIndex < volumeRemoveIndex);
  assert.equal(calls[containerRemoveIndex][2], "managed-container-id");
});

test("managed volume deletion rejects unlabeled volumes without live container mount evidence", async () => {
  const local = context();
  const removed = [];
  const executor = new LocalDockerExecutor(async (_command, args) => {
    if (args[0] === "inspect") {
      throw Object.assign(new Error("No such container"), { details: { stderr: "No such container" } });
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      if (args.at(-1).endsWith("-runtime")) {
        throw Object.assign(new Error("No such volume"), { details: { stderr: "No such volume" } });
      }
      return { stdout: JSON.stringify({ Name: args.at(-1), Labels: null }), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "rm") removed.push(args[2]);
    return { stdout: "", stderr: "" };
  });

  const result = await executor.delete(local, { deleteVolumes: true });

  assert.equal(result.completed, false);
  assert.deepEqual(result.volumeResults.map((item) => item.error?.code), [
    "INSTANCE_VOLUME_IDENTITY_MISMATCH",
    "INSTANCE_VOLUME_IDENTITY_MISMATCH",
  ]);
  assert.deepEqual(removed, []);
});

test("managed volume deletion rejects unlabeled canonical volumes not mounted by the owned container", async () => {
  const local = context();
  const removed = [];
  const executor = new LocalDockerExecutor(async (_command, args) => {
    if (args[0] === "inspect") {
      return { stdout: JSON.stringify(containerForInspection(local, [])), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      if (args.at(-1).endsWith("-runtime")) {
        throw Object.assign(new Error("No such volume"), { details: { stderr: "No such volume" } });
      }
      return { stdout: JSON.stringify({ Name: args.at(-1), Labels: null }), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "rm") removed.push(args[2]);
    return { stdout: "", stderr: "" };
  });

  const result = await executor.delete(local, { deleteVolumes: true });

  assert.equal(result.completed, false);
  assert.deepEqual(result.volumeResults.map((item) => item.error?.code), [
    "INSTANCE_VOLUME_IDENTITY_MISMATCH",
    "INSTANCE_VOLUME_IDENTITY_MISMATCH",
  ]);
  assert.deepEqual(removed, []);
});

test("docker configuration security check reports fields without exposing values", () => {
  assert.throws(
    () => assertDockerConfigHasNoSecrets({ Config: { Env: ["OPENAI_API_KEY=historical-secret"], Labels: {} } }, ["historical-secret"]),
    (error) => error.code === "ENVIRONMENT_TEMPLATE_SECRET_IN_DOCKER_CONFIG"
      && error.message.includes("Config.Env.OPENAI_API_KEY")
      && !error.message.includes("historical-secret"),
  );
  assert.doesNotThrow(() => assertDockerConfigHasNoSecrets({ Config: { Env: ["TASK_HANDOFF_INSTANCE_ID=inst_one"], Labels: {} } }, ["secret"]));
});
