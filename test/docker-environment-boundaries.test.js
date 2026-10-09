const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ControlledInstanceSchema } = require("../packages/protocol/src/control-plane.ts");
const { InstancePrivateConfigStore } = require("../packages/control-plane/src/node-agent/instances/private-config-store.ts");
const { nodeAgentStorePaths } = require("../packages/control-plane/src/node-agent/persistence/paths.ts");
const {
  LocalDockerExecutor,
  agentRunRuntimeVolume,
  assertDockerConfigHasNoSecrets,
  dockerGitProvisionArgs,
  dockerRunArgs,
  GIT_WORKSPACE_PROVISIONING_PENDING_CODE,
} = require("../packages/control-plane/src/node-agent/runtimes/docker.ts");

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
    privateConfigPath: "/private/inst_one/private-config.json",
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

function runtimeVolume(value) {
  return {
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

function agentRunVolumes(value) {
  return [agentRunRuntimeVolume(value.node.id, value.runtime.id)];
}

function volumeForInspection(value, name) {
  return [...persistentVolumes(value), runtimeVolume(value), ...agentRunVolumes(value)]
    .find((item) => item.name === name);
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
    assert.equal(store.inspectMaterialized("inst_one").instanceCredential, "registration-secret");
    assert.equal("registrationToken" in JSON.parse(fs.readFileSync(store.filePath("inst_one"), "utf8")), false);
    assert.equal(value.environment.OPENAI_API_KEY, "model-secret");
    assert.equal(fs.statSync(store.filePath("inst_one")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(store.filePath("inst_one"))).mode & 0o777, 0o700);
    store.delete("inst_one");
    assert.equal(fs.existsSync(store.filePath("inst_one")), false);
    assert.equal(fs.existsSync(path.dirname(store.filePath("inst_one"))), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("private instance config skips unchanged rewrites", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-private-config-rewrite-"));
  try {
    const store = new InstancePrivateConfigStore(nodeAgentStorePaths(dataDir));
    store.materialize("inst_one", "registration-secret", { OPENAI_API_KEY: "model-secret" });
    const newInode = fs.statSync(store.filePath("inst_one")).ino;
    const stored = store.inspectMaterialized("inst_one");

    const unchanged = store.materialize("inst_one", "registration-secret", { OPENAI_API_KEY: "model-secret" });
    // Runtime convergence materializes before every start/restart; unchanged
    // payloads must not touch the layout on disk.
    assert.equal(unchanged.updatedAt, stored.updatedAt);
    assert.equal(fs.statSync(store.filePath("inst_one")).ino, newInode);

    store.materialize("inst_one", "registration-secret", { OPENAI_API_KEY: "rotated-secret" });
    assert.equal(store.inspectMaterialized("inst_one").environment.OPENAI_API_KEY, "rotated-secret");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("private instance config ignores the retired single-file layout", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-private-config-retired-"));
  try {
    const paths = nodeAgentStorePaths(dataDir);
    const store = new InstancePrivateConfigStore(paths);
    // node-agent treats controlled instances as the same internal version
    // domain, so a container created before the directory mount is neither read
    // nor migrated from its retired single-file layout.
    fs.mkdirSync(paths.instancePrivateConfigsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(paths.instancePrivateConfigsDir, "inst_one.json"), `${JSON.stringify({
      version: 1,
      instanceId: "inst_one",
      instanceCredential: "registration-secret",
      environment: { OPENAI_API_KEY: "model-secret" },
      updatedAt: timestamp,
    }, null, 2)}\n`, { mode: 0o600 });

    assert.equal(store.inspectMaterialized("inst_one"), undefined);

    store.materialize("inst_one", "registration-secret", { OPENAI_API_KEY: "model-secret" });
    assert.equal(JSON.parse(fs.readFileSync(store.filePath("inst_one"), "utf8")).instanceCredential, "registration-secret");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("private instance config repairs a torn current layout on the next materialize", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-private-config-torn-"));
  try {
    const store = new InstancePrivateConfigStore(nodeAgentStorePaths(dataDir));
    store.materialize("inst_one", "registration-secret", { OPENAI_API_KEY: "model-secret" });
    fs.writeFileSync(store.filePath("inst_one"), "", { mode: 0o600 });

    // No sibling layout masks a torn current file.
    assert.throws(() => store.inspectMaterialized("inst_one"));

    store.materialize("inst_one", "registration-secret", { OPENAI_API_KEY: "model-secret" });
    assert.equal(JSON.parse(fs.readFileSync(store.filePath("inst_one"), "utf8")).environment.OPENAI_API_KEY, "model-secret");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("private instance config reports structured errors for missing credentials and identity mismatch", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-private-config-errors-"));
  try {
    const paths = nodeAgentStorePaths(dataDir);
    const store = new InstancePrivateConfigStore(paths);
    assert.throws(
      () => store.materialize("inst_one", undefined, {}),
      (error) => error.code === "INSTANCE_PRIVATE_CONFIG_CREDENTIAL_MISSING" && error.statusCode === 409,
    );

    fs.mkdirSync(path.dirname(store.filePath("inst_one")), { recursive: true, mode: 0o700 });
    fs.writeFileSync(store.filePath("inst_one"), `${JSON.stringify({
      version: 1,
      instanceId: "inst_other",
      instanceCredential: "registration-secret",
      environment: {},
      updatedAt: timestamp,
    }, null, 2)}\n`, { mode: 0o600 });
    assert.throws(
      () => store.inspectMaterialized("inst_one"),
      (error) => error.code === "INSTANCE_PRIVATE_CONFIG_IDENTITY_MISMATCH" && error.statusCode === 409,
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("private instance config preserves managed Codex settings for restart recovery", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-private-codex-settings-"));
  try {
    const settings = {
      modelVerbosity: "high",
      personality: "pragmatic",
      multiAgent: {
        enabled: true,
        maxConcurrentThreads: 6,
        defaultReasoningEffort: "high",
      },
    };
    const paths = nodeAgentStorePaths(dataDir);
    new InstancePrivateConfigStore(paths).materialize(
      "inst_one",
      "registration-secret",
      { OPENAI_API_KEY: "model-secret" },
      undefined,
      settings,
    );

    const restored = new InstancePrivateConfigStore(paths).inspectMaterialized("inst_one");
    assert.deepEqual(restored.codexSettings, settings);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(paths.instancePrivateConfigsDir, "inst_one", "private-config.json"), "utf8")).codexSettings, settings);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Docker entrypoints project managed Codex settings before dropping privileges", () => {
  const source = fs.readFileSync(path.join(__dirname, "../docker/entrypoint.sh"), "utf8");
  assert.match(source, /TASK_HANDOFF_PRIVATE_CODEX_SETTINGS_JSON = JSON\.stringify\(value\.codexSettings\)/);
  // The container reads the private config from the directory mount, the
  // explicit env override, or the retired single-file mount that containers
  // created by older node agents still bind.
  assert.match(source, /private_config_default_path="\/run\/task-handoff\/private\/private-config\.json"/);
  assert.match(source, /private_config_legacy_path="\/run\/task-handoff\/instance-private-config\.json"/);
  assert.match(source, /for candidate in "\$\{TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH:-\}" "\$\{private_config_default_path\}" "\$\{private_config_legacy_path\}"/);
});

test("entrypoint private config loading tolerates deferred files and keeps only identity mandatory", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../docker/entrypoint.sh"), "utf8");
  const marker = "start_node_agent_unix_proxy() {";
  const markerIndex = source.indexOf(marker);
  assert.ok(markerIndex > 0, "entrypoint must define the private config loader before the main body");
  const definitions = source.slice(0, markerIndex);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-entrypoint-private-config-"));
  const load = (configPath, env = {}) => {
    const script = [
      definitions,
      "load_private_config",
      'printf "TOKEN=%s\\n" "${TASK_HANDOFF_REGISTRATION_TOKEN:-}"',
      'printf "LOADED=%s\\n" "${TASK_HANDOFF_PRIVATE_CONFIG_LOADED:-}"',
      'printf "CONFIG_PATH=%s\\n" "${TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH:-}"',
      'printf "MODEL=%s\\n" "${OPENAI_API_KEY:-}"',
      'printf "CATALOG=%s\\n" "${TASK_HANDOFF_PRIVATE_MODEL_CATALOG_JSON:-}"',
      'printf "SETTINGS=%s\\n" "${TASK_HANDOFF_PRIVATE_CODEX_SETTINGS_JSON:-}"',
    ].join("\n");
    return spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENAI_API_KEY: "",
        TASK_HANDOFF_PRIVATE_CONFIG_RETRY_ATTEMPTS: "1",
        TASK_HANDOFF_PRIVATE_CONFIG_RETRY_DELAY_SECONDS: "0",
        ...env,
      },
    });
  };
  const writeConfig = (filePath, value) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  };

  try {
    const configPath = path.join(root, "private", "private-config.json");
    // Identity alone is enough to start; environment and snapshots are optional.
    writeConfig(configPath, { version: 1, instanceId: "inst_one", instanceCredential: "credential-secret" });
    const minimal = load(configPath, { TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: configPath });
    assert.equal(minimal.status, 0, minimal.stderr);
    assert.match(minimal.stdout, /TOKEN=credential-secret/);
    assert.match(minimal.stdout, /LOADED=1/);
    assert.match(minimal.stdout, new RegExp(`CONFIG_PATH=${configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(minimal.stdout, /MODEL=\n/);

    writeConfig(configPath, {
      version: 1,
      instanceId: "inst_one",
      instanceCredential: "credential-secret",
      environment: { OPENAI_API_KEY: "model-secret" },
      modelCatalog: { models: [] },
      codexSettings: { modelVerbosity: "high" },
    });
    const complete = load(configPath, { TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: configPath });
    assert.equal(complete.status, 0, complete.stderr);
    assert.match(complete.stdout, /MODEL=model-secret/);
    assert.match(complete.stdout, /CATALOG=\{"models":\[\]\}/);
    assert.match(complete.stdout, /SETTINGS=\{"modelVerbosity":"high"\}/);

    // A node agent that materializes the file slightly after the container
    // starts must not trip the container into exit 78.
    const deferredPath = path.join(root, "deferred", "private-config.json");
    fs.mkdirSync(path.dirname(deferredPath), { recursive: true, mode: 0o700 });
    const deferredProcess = spawn("bash", ["-c", [
      definitions,
      "load_private_config",
      'printf "TOKEN=%s\\n" "${TASK_HANDOFF_REGISTRATION_TOKEN:-}"',
    ].join("\n")], {
      env: {
        ...process.env,
        TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: deferredPath,
        TASK_HANDOFF_PRIVATE_CONFIG_RETRY_ATTEMPTS: "25",
        TASK_HANDOFF_PRIVATE_CONFIG_RETRY_DELAY_SECONDS: "0.2",
      },
    });
    let deferredStdout = "";
    let deferredStderr = "";
    deferredProcess.stdout.on("data", (chunk) => { deferredStdout += chunk; });
    deferredProcess.stderr.on("data", (chunk) => { deferredStderr += chunk; });
    setTimeout(() => {
      fs.writeFileSync(deferredPath, `${JSON.stringify({
        version: 1,
        instanceId: "inst_one",
        instanceCredential: "deferred-secret",
      })}\n`, { mode: 0o600 });
    }, 300);
    const deferredCode = await new Promise((resolve) => deferredProcess.on("close", resolve));
    assert.equal(deferredCode, 0, deferredStderr);
    assert.match(deferredStdout, /TOKEN=deferred-secret/);

    // A config without identity still fails closed after the retry budget.
    writeConfig(configPath, { version: 1, instanceId: "inst_one" });
    const invalid = load(configPath, { TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH: configPath });
    assert.equal(invalid.status, 78);
    assert.match(invalid.stderr, /missing or invalid after 1 attempts/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy private registration field remains readable in the current layout", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-private-config-registration-token-"));
  try {
    const store = new InstancePrivateConfigStore(nodeAgentStorePaths(dataDir));
    fs.mkdirSync(path.dirname(store.filePath("inst_one")), { recursive: true, mode: 0o700 });
    fs.writeFileSync(store.filePath("inst_one"), `${JSON.stringify({
      version: 1,
      instanceId: "inst_one",
      registrationToken: "legacy-secret",
      environment: {},
      updatedAt: timestamp,
    }, null, 2)}\n`, { mode: 0o600 });

    assert.equal(store.inspectMaterialized("inst_one").instanceCredential, "legacy-secret");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("docker config uses a read-only private file and explicit managed mounts without secrets", () => {
  const local = context();
  local.image.capabilities = ["terminal", "codex"];
  local.image.labels["task-handoff.image.profile"] = "codex";
  local.image.defaultEnv.TASK_HANDOFF_IMAGE_CAPABILITIES = "browser";
  local.image.defaultEnv.TASK_HANDOFF_IMAGE_PROFILE = "browser";
  const args = dockerRunArgs(local, "task-handoff-inst_one", {
    nodeAgentContainerIpcPath: "/run/task-handoff/container/node-agent.sock",
  });
  assert.ok(args.includes("type=bind,src=/private/inst_one,dst=/run/task-handoff/private,readonly"));
  assert.ok(args.includes("TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH=/run/task-handoff/private/private-config.json"));
  assert.ok(args.includes("type=volume,src=task-handoff-inst_one-data,dst=/data"));
  assert.ok(args.includes("type=volume,src=task-handoff-inst_one-agent-home,dst=/home/agent"));
  assert.ok(args.includes("type=volume,src=task-handoff-inst_one-runtime,dst=/opt/task-handoff/instance-runtime"));
  for (const volume of agentRunVolumes(local)) {
    assert.ok(args.includes(`type=volume,src=${volume.name},dst=${volume.mountPath}`));
  }
  assert.ok(args.includes("/run/task-handoff/bootstrap/entrypoint.sh"));
  assert.ok(args.includes("type=bind,src=/run/task-handoff/container,dst=/run/task-handoff/node-agent-transport,readonly"));
  assert.ok(args.includes("TASK_HANDOFF_NODE_AGENT_SOCKET_PATH=/run/task-handoff/node-agent-transport/node-agent.sock"));
  assert.ok(args.includes("TASK_HANDOFF_NODE_AGENT_URL=http://127.0.0.1:19001"));
  assert.ok(args.includes("--no-healthcheck"));
  assert.ok(args.includes("/tmp:rw,nosuid,nodev,exec,mode=1777"));
  assert.ok(args.includes("/tmp/workspace:/workspace:rw"));
  assert.ok(args.includes("TASK_HANDOFF_IMAGE_CAPABILITIES=terminal,codex"));
  assert.ok(args.includes("TASK_HANDOFF_IMAGE_PROFILE=codex"));
  assert.equal(args.includes("TASK_HANDOFF_IMAGE_CAPABILITIES=browser"), false);
  assert.equal(args.includes("TASK_HANDOFF_IMAGE_PROFILE=browser"), false);
  assert.equal(args.some((value) => value.includes("registration-secret") || value.includes("model-secret")), false);

  const git = context({
    type: "git-repository", repositoryId: "repo_one", url: "https://example.com/repo.git",
    ref: { type: "branch", name: "main" }, auth: { type: "none" }, clone: { depth: 1, submodules: false, lfs: false },
  });
  const gitArgs = dockerRunArgs(git, "task-handoff-inst_one");
  assert.ok(gitArgs.includes("type=volume,src=task-handoff-inst_one-workspace,dst=/workspace"));
  assert.ok(gitArgs.includes("TASK_HANDOFF_WORKSPACE_GIT_URL=https://example.com/repo.git"));
  assert.ok(gitArgs.includes("TASK_HANDOFF_WORKSPACE_GIT_REF=main"));
  assert.ok(gitArgs.includes("TASK_HANDOFF_WORKSPACE_GIT_COMMIT="));
  assert.ok(gitArgs.includes("TASK_HANDOFF_GIT_URL=https://example.com/repo.git"));
  assert.ok(gitArgs.includes("TASK_HANDOFF_GIT_REF=main"));
  assert.equal(gitArgs.some((value) => value.startsWith("TASK_HANDOFF_GIT_COMMIT=")), false);
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
  assert.equal(volumeCreateIndexes.length, 4);
  assert.ok(volumeCreateIndexes.every((index) => index < runIndex));
  assert.equal("managedVolumes" in result.runtime, false);
});

test("Docker Git provisioning uses a disposable helper before the final instance and keeps secrets out of argv", async () => {
  const value = context({
    type: "git-repository", repositoryId: "repo_one", url: "https://git.example.com/team/repo.git",
    ref: { type: "branch", name: "main" }, auth: { type: "none" }, clone: { depth: 1, submodules: false, lfs: false, subdirectory: "packages/app" },
  });
  value.gitWorkspaceProvisioning = {
    operationId: "gitop_one",
    instanceId: value.instance.id,
    remoteUrl: value.project.source.url,
    ref: value.project.source.ref,
    clone: value.project.source.clone,
    credentials: [{
      operationId: "gitcredop_one",
      retention: "operation-only",
      payload: {
        credential: {
          id: "gitcred_one", name: "Team token", kind: "https-token",
          scope: { scheme: "https", host: "git.example.com", pathPrefix: "/team/" },
          secretSet: true, status: "enabled", revision: 1, createdAt: timestamp, updatedAt: timestamp,
        },
        secret: { kind: "https-token", username: "git", token: "provision-secret" },
      },
    }],
  };
  let completed = 0;
  value.completeGitWorkspaceProvisioning = () => { completed += 1; };
  const calls = [];
  let authDirectory;
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect" && args.includes("{{json .}}")) throw Object.assign(new Error("No such container"), { details: { stderr: "No such container" } });
    if (args[0] === "image" && args[1] === "inspect") return { stdout: JSON.stringify({ Id: `sha256:${"a".repeat(64)}`, RepoDigests: [] }), stderr: "" };
    if (args[0] === "volume" && args[1] === "inspect") {
      const name = args.at(-1);
      const volume = volumeForInspection(value, name);
      return { stdout: JSON.stringify({ Name: name, Labels: volume.labels }), stderr: "" };
    }
    if (args[0] === "run" && args.includes("/run/task-handoff/bootstrap/git-provision.sh")) {
      const mount = args.find((item) => item.includes("dst=/run/task-handoff/git-auth"));
      authDirectory = mount.match(/src=([^,]+)/)[1];
      assert.equal(fs.readFileSync(path.join(authDirectory, "credential-0", "token"), "utf8"), "provision-secret");
      assert.equal(args.some((item) => item.includes("provision-secret")), false);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "run") return { stdout: "container-one", stderr: "" };
    if (args[0] === "port") return { stdout: "127.0.0.1:18080", stderr: "" };
    return { stdout: args.at(-1) || "", stderr: "" };
  });
  // The asynchronous provisioning controller materializes the workspace first.
  await executor.provisionGitWorkspaceStreaming(value);
  const helperIndex = calls.findIndex((args) => args[0] === "run" && args.includes("/run/task-handoff/bootstrap/git-provision.sh"));
  const staleCleanupIndex = calls.findIndex((args) => args[0] === "rm" && args[1] === "-f" && args[2].endsWith("-git-provision"));
  assert.ok(staleCleanupIndex >= 0 && staleCleanupIndex < helperIndex);
  assert.ok(calls[helperIndex].includes("task-handoff.role=git-provisioning"));
  assert.ok(calls[helperIndex].includes(`task-handoff.instance-id=${value.instance.id}`));
  assert.ok(calls[helperIndex].includes("TASK_HANDOFF_WORKSPACE_SUBDIRECTORY=packages/app"));
  assert.ok(calls[helperIndex].includes("TASK_HANDOFF_WORKSPACE_GIT_URL=https://git.example.com/team/repo.git"));
  assert.ok(calls[helperIndex].includes("TASK_HANDOFF_WORKSPACE_GIT_REF=main"));
  assert.ok(calls[helperIndex].includes("TASK_HANDOFF_WORKSPACE_GIT_COMMIT="));
  assert.equal(calls[helperIndex].some((item) => item.startsWith("TASK_HANDOFF_GIT_") && !item.startsWith("TASK_HANDOFF_GIT_PROVISIONING_")), false);
  assert.equal(completed, 1);
  assert.equal(fs.existsSync(authDirectory), false);

  // Once provisioning reaches the ready phase, the instance starts on the
  // current layout without re-cloning the workspace.
  await executor.start({
    ...value,
    instance: ControlledInstanceSchema.parse({
      ...value.instance,
      workspace: {
        mode: "git-clone", status: "ready", path: value.project.workspacePolicy.path,
        gitProvisioning: {
          phase: "ready", remoteUrl: value.project.source.url, generation: 0, startedAt: timestamp, updatedAt: timestamp,
        },
      },
    }),
  });
  const finalIndex = calls.findIndex((args, index) => index > helperIndex && args[0] === "run" && args.includes("task-handoff"));
  assert.ok(finalIndex > helperIndex);
  const finalArgs = calls[finalIndex];
  assert.ok(finalArgs.includes("TASK_HANDOFF_SKIP_WORKSPACE_BOOTSTRAP=true"));
  assert.ok(finalArgs.includes("TASK_HANDOFF_WORKSPACE_SUBDIRECTORY=packages/app"));
  assert.ok(finalArgs.includes("TASK_HANDOFF_WORKSPACE_GIT_URL=https://git.example.com/team/repo.git"));
  assert.ok(finalArgs.includes("TASK_HANDOFF_WORKSPACE_GIT_REF=main"));
  assert.ok(finalArgs.includes("TASK_HANDOFF_GIT_REF=main"));
  assert.equal(finalArgs.some((item) => item.startsWith("TASK_HANDOFF_GIT_COMMIT=")), false);
  assert.equal(finalArgs.some((item) => item.includes("provision-secret")), false);
  const dryRun = dockerGitProvisionArgs(value, "helper", "/private/auth");
  assert.equal(dryRun.some((item) => item.includes("provision-secret")), false);
  assert.ok(dryRun.includes(`TASK_HANDOFF_INSTANCE_ID=${value.instance.id}`));
});

test("Docker start fails fast instead of cloning inline while Git provisioning is orchestrated", async () => {
  const value = context({
    type: "git-repository", repositoryId: "repo_one", url: "https://git.example.com/team/repo.git",
    ref: { type: "branch", name: "main" }, auth: { type: "none" }, clone: { submodules: false, lfs: false, subdirectory: "" },
  });
  value.gitWorkspaceProvisioning = {
    operationId: "gitop_pending", instanceId: value.instance.id, remoteUrl: value.project.source.url,
    ref: value.project.source.ref, clone: value.project.source.clone, credentials: [],
  };
  value.instance = ControlledInstanceSchema.parse({
    ...value.instance,
    workspace: {
      mode: "git-clone", status: "pending",
      gitProvisioning: { phase: "cloning", remoteUrl: value.project.source.url, generation: 0, startedAt: timestamp, updatedAt: timestamp },
    },
  });
  const calls = [];
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect" && args.includes("{{json .}}")) throw Object.assign(new Error("missing"), { details: { stderr: "No such container" } });
    if (args[0] === "image" && args[1] === "inspect") return { stdout: JSON.stringify({ Id: `sha256:${"a".repeat(64)}`, RepoDigests: [] }), stderr: "" };
    if (args[0] === "volume" && args[1] === "inspect") {
      const volume = volumeForInspection(value, args.at(-1));
      return { stdout: JSON.stringify({ Name: volume.name, Labels: volume.labels }), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  await assert.rejects(
    () => executor.start(value),
    (error) => error.code === GIT_WORKSPACE_PROVISIONING_PENDING_CODE,
  );
  assert.equal(calls.some((args) => args[0] === "run"), false);
});

test("Docker Git provisioning returns stable errors, preserves retry input, and cleans helper material", async () => {
  const value = context({
    type: "git-repository", repositoryId: "repo_one", url: "https://git.example.com/team/repo.git",
    ref: { type: "branch", name: "main" }, auth: { type: "none" }, clone: { submodules: true, lfs: false, subdirectory: "" },
  });
  value.gitWorkspaceProvisioning = {
    operationId: "gitop_retry", instanceId: value.instance.id, remoteUrl: value.project.source.url,
    ref: value.project.source.ref, clone: value.project.source.clone,
    credentials: [{
      operationId: "gitcredop_retry", retention: "operation-only",
      payload: {
        credential: {
          id: "gitcred_one", name: "Team token", kind: "https-token",
          scope: { scheme: "https", host: "git.example.com", pathPrefix: "/team/" },
          secretSet: true, status: "enabled", revision: 1, createdAt: timestamp, updatedAt: timestamp,
        },
        secret: { kind: "https-token", username: "git", token: "never-expose-this" },
      },
    }],
  };
  let completed = 0;
  value.completeGitWorkspaceProvisioning = () => { completed += 1; };
  const calls = [];
  let authDirectory;
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect" && args.includes("{{json .}}")) throw Object.assign(new Error("missing"), { details: { stderr: "No such container" } });
    if (args[0] === "image" && args[1] === "inspect") return { stdout: JSON.stringify({ Id: `sha256:${"a".repeat(64)}`, RepoDigests: [] }), stderr: "" };
    if (args[0] === "volume" && args[1] === "inspect") {
      const volume = volumeForInspection(value, args.at(-1));
      return { stdout: JSON.stringify({ Name: volume.name, Labels: volume.labels }), stderr: "" };
    }
    if (args[0] === "run" && args.includes("/run/task-handoff/bootstrap/git-provision.sh")) {
      authDirectory = args.find((item) => item.includes("dst=/run/task-handoff/git-auth")).match(/src=([^,]+)/)[1];
      throw Object.assign(new Error("raw output contains never-expose-this"), {
        code: "RUNTIME_EXECUTOR_FAILED",
        details: { stderr: "fatal: denied never-expose-this\nTASK_HANDOFF_GIT_PROVISIONING_ERROR=CREDENTIAL_MISSING" },
      });
    }
    return { stdout: "", stderr: "" };
  });

  await assert.rejects(
    () => executor.provisionGitWorkspaceStreaming(value),
    (error) => error.code === "GIT_WORKSPACE_PROVISIONING_CREDENTIAL_MISSING"
      && !error.message.includes("never-expose-this")
      && error.cause === undefined,
  );
  assert.equal(completed, 0);
  assert.equal(fs.existsSync(authDirectory), false);
  assert.equal(calls.filter((args) => args[0] === "rm" && args[1] === "-f" && args[2].endsWith("-git-provision")).length, 2);
});

test("Docker Git provisioning maps timeout without retaining command output", async () => {
  const value = context({
    type: "git-repository", repositoryId: "repo_one", url: "https://git.example.com/repo.git",
    ref: { type: "branch", name: "main" }, auth: { type: "none" }, clone: { submodules: false, lfs: false, subdirectory: "" },
  });
  value.gitWorkspaceProvisioning = {
    operationId: "gitop_timeout", instanceId: value.instance.id, remoteUrl: value.project.source.url,
    ref: value.project.source.ref, clone: value.project.source.clone,
    credentials: [],
  };
  const executor = new LocalDockerExecutor(async (_command, args) => {
    if (args[0] === "inspect" && args.includes("{{json .}}")) throw Object.assign(new Error("missing"), { details: { stderr: "No such container" } });
    if (args[0] === "image" && args[1] === "inspect") return { stdout: JSON.stringify({ Id: `sha256:${"a".repeat(64)}`, RepoDigests: [] }), stderr: "" };
    if (args[0] === "volume" && args[1] === "inspect") {
      const volume = volumeForInspection(value, args.at(-1));
      return { stdout: JSON.stringify({ Name: volume.name, Labels: volume.labels }), stderr: "" };
    }
    if (args[0] === "run") throw Object.assign(new Error("timeout secret output"), { code: "RUNTIME_COMMAND_TIMEOUT", details: { stderr: "timeout secret output" } });
    return { stdout: "", stderr: "" };
  });
  await assert.rejects(
    () => executor.provisionGitWorkspaceStreaming(value),
    (error) => error.code === "GIT_WORKSPACE_PROVISIONING_TIMEOUT" && !error.message.includes("secret output") && error.cause === undefined,
  );
});

test("Docker Git provisioning cancellation aborts the helper and still removes it", async () => {
  const value = context({
    type: "git-repository", repositoryId: "repo_one", url: "https://git.example.com/repo.git",
    ref: { type: "branch", name: "main" }, auth: { type: "none" }, clone: { submodules: false, lfs: false, subdirectory: "" },
  });
  value.gitWorkspaceProvisioning = {
    operationId: "gitop_cancel", instanceId: value.instance.id, remoteUrl: value.project.source.url,
    ref: value.project.source.ref, clone: value.project.source.clone, credentials: [],
  };
  const controller = new AbortController();
  value.signal = controller.signal;
  const calls = [];
  const executor = new LocalDockerExecutor(async (_command, args, options) => {
    calls.push(args);
    if (args[0] === "inspect" && args.includes("{{json .}}")) throw Object.assign(new Error("missing"), { details: { stderr: "No such container" } });
    if (args[0] === "image" && args[1] === "inspect") return { stdout: JSON.stringify({ Id: `sha256:${"a".repeat(64)}`, RepoDigests: [] }), stderr: "" };
    if (args[0] === "volume" && args[1] === "inspect") {
      const volume = volumeForInspection(value, args.at(-1));
      return { stdout: JSON.stringify({ Name: volume.name, Labels: volume.labels }), stderr: "" };
    }
    if (args[0] === "run" && args.includes("/run/task-handoff/bootstrap/git-provision.sh")) {
      assert.equal(options.signal, controller.signal);
      controller.abort();
      throw Object.assign(new Error("aborted raw output"), { code: "RUNTIME_COMMAND_ABORTED", details: { stderr: "aborted raw output" } });
    }
    return { stdout: "", stderr: "" };
  });
  await assert.rejects(
    () => executor.provisionGitWorkspaceStreaming(value),
    (error) => error.code === "GIT_WORKSPACE_PROVISIONING_CANCELLED" && !error.message.includes("raw output"),
  );
  assert.equal(calls.filter((args) => args[0] === "rm" && args[1] === "-f" && args[2].endsWith("-git-provision")).length, 2);
});

test("Git provisioning script only replaces instance-owned staging and rejects unknown workspace data", () => {
  const script = fs.readFileSync(path.resolve("docker/git-provision.sh"), "utf8");
  assert.match(script, /TASK_HANDOFF_GIT_PROVISIONING_ERROR=%s/);
  assert.match(script, /WORKSPACE_NOT_EMPTY/);
  assert.match(script, /WORKSPACE_OWNERSHIP_MISMATCH/);
  assert.match(script, /TASK_HANDOFF_INSTANCE_ID/);
  assert.match(script, /checkout="\$\{staging\}\/checkout"/);
  assert.match(script, /CLONE_FAILED/);
  assert.match(script, /SUBDIRECTORY_NOT_FOUND/);
  assert.match(script, /TASK_HANDOFF_WORKSPACE_GIT_COMMIT.*TASK_HANDOFF_WORKSPACE_GIT_DEPTH|TASK_HANDOFF_WORKSPACE_GIT_DEPTH.*TASK_HANDOFF_WORKSPACE_GIT_COMMIT/);
  // Provisioning input never comes from legacy keys: images bake
  // TASK_HANDOFF_GIT_COMMIT as the image build commit.
  assert.doesNotMatch(script, /\$\{TASK_HANDOFF_GIT_(?:URL|REF|COMMIT|DEPTH|SUBMODULES|LFS)/);
  assert.doesNotMatch(script, /rm -rf -- "\$\{workspace\}"/);
});

test("docker executor reports runtime liveness for convergence drain decisions", async () => {
  const responses = new Map([
    ["task-handoff-running", { stdout: "true\n", stderr: "" }],
    ["task-handoff-stopped", { stdout: "false\n", stderr: "" }],
  ]);
  const executor = new LocalDockerExecutor(async (_command, args) => {
    assert.deepEqual(args.slice(0, 3), ["inspect", "--format", "{{.State.Running}}"]);
    const response = responses.get(args[3]);
    if (!response) throw new Error("Error: No such container: " + args[3]);
    return response;
  }, { launcherAssetsDir: path.resolve("docker") });

  assert.equal(await executor.runtimeState("task-handoff-running"), "running");
  assert.equal(await executor.runtimeState("task-handoff-stopped"), "stopped");
  // A container removed by a failed convergence must not look running.
  assert.equal(await executor.runtimeState("task-handoff-removed"), "absent");

  const failing = new LocalDockerExecutor(async () => {
    throw new Error("Cannot connect to the Docker daemon");
  }, { launcherAssetsDir: path.resolve("docker") });
  // An unreadable state is unknown, not a licence to skip draining a live app.
  assert.equal(await failing.runtimeState("task-handoff-running"), "unknown");
});

test("docker executor keeps an existing container when stable bootstrap and container IPC mounts match", async () => {
  const value = context();
  const containerName = "task-handoff-inst_one";
  const containerId = "existing-container-id";
  const runtimeVolume = volumeForInspection(value, `task-handoff-${value.instance.id}-runtime`);
  const calls = [];
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      return { stdout: JSON.stringify({
        Id: containerId,
        State: { Running: false },
        Config: {
          Entrypoint: ["/usr/local/bin/legacy-entrypoint"],
          Cmd: ["/run/task-handoff/bootstrap/entrypoint.sh", "task-handoff", "web"],
          Labels: {
            "task-handoff.bootstrap-abi": "0",
            "task-handoff.instance-id": value.instance.id,
          },
        },
        Mounts: [
          ...persistentVolumes(value).map((volume) => ({ Type: "volume", Name: volume.name, Destination: volume.mountPath })),
          { Type: "volume", Name: runtimeVolume.name, Destination: runtimeVolume.mountPath },
          ...agentRunVolumes(value).map((volume) => ({ Type: "volume", Name: volume.name, Destination: volume.mountPath })),
          { Type: "bind", Source: path.resolve("docker"), Destination: "/run/task-handoff/bootstrap" },
          { Type: "bind", Source: "/run/task-handoff/container", Destination: "/run/task-handoff/node-agent-transport" },
          { Type: "bind", Source: path.resolve(value.project.source.path), Destination: value.project.workspacePolicy.path },
        ],
      }), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const volume = volumeForInspection(value, args.at(-1));
      return { stdout: JSON.stringify({ Name: volume.name, Labels: volume.labels }), stderr: "" };
    }
    if (args[0] === "port") return { stdout: "127.0.0.1:19090", stderr: "" };
    return { stdout: "", stderr: "" };
  }, {
    launcherAssetsDir: path.resolve("docker"),
    nodeAgentContainerIpcPath: "/run/task-handoff/container/node-agent.sock",
  });

  const result = await executor.start({
    ...value,
    instance: {
      ...value.instance,
      target: { strategy: "direct-port", status: "reachable", web: "http://127.0.0.1:18080", api: "http://127.0.0.1:18080/api" },
      runtime: { ...value.instance.runtime, containerName, containerId },
    },
  });

  assert.equal(result.target.web, "http://127.0.0.1:19090");
  assert.equal(result.target.api, "http://127.0.0.1:19090/api");
  assert.equal(result.runtime.labels["task-handoff.bootstrap-abi"], "0");
  assert.ok(calls.some((args) => args[0] === "start" && args[1] === containerName));
  assert.ok(calls.some((args) => args[0] === "port" && args[1] === containerName && args[2] === "8080/tcp"));
  assert.equal(calls.some((args) => ["rename", "rm", "run"].includes(args[0])), false);
  assert.equal(await executor.resolveNodeAgentUrl({
    ...value,
    instance: { ...value.instance, runtime: { ...value.instance.runtime, containerName, containerId } },
  }), "http://127.0.0.1:19001");
});

test("existing containers keep their original bootstrap and TCP node-agent transport", async () => {
  const value = context();
  const containerName = "task-handoff-inst_one";
  const containerId = "existing-tcp-container-id";
  const packageBootstrap = "/usr/lib/node_modules/@task-handoff/node-agent/docker";
  const runtimeVolume = volumeForInspection(value, `task-handoff-${value.instance.id}-runtime`);
  const volumes = [...persistentVolumes(value), runtimeVolume, ...agentRunVolumes(value)];
  const calls = [];
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      return { stdout: JSON.stringify({
        Id: containerId,
        State: { Running: false },
        Config: {
          Entrypoint: ["/usr/local/bin/legacy-entrypoint"],
          Cmd: ["/run/task-handoff/bootstrap/entrypoint.sh", "task-handoff", "web"],
          Labels: {
            "task-handoff.bootstrap-abi": "1",
            "task-handoff.instance-id": value.instance.id,
          },
        },
        Mounts: [
          ...volumes.map((volume) => ({ Type: "volume", Name: volume.name, Destination: volume.mountPath })),
          { Type: "bind", Source: packageBootstrap, Destination: "/run/task-handoff/bootstrap" },
          { Type: "bind", Source: path.resolve(value.project.source.path), Destination: value.project.workspacePolicy.path },
        ],
      }), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const volume = volumeForInspection(value, args.at(-1));
      return { stdout: JSON.stringify({ Name: volume.name, Labels: volume.labels }), stderr: "" };
    }
    if (args[0] === "port") return { stdout: "127.0.0.1:19090", stderr: "" };
    return { stdout: "", stderr: "" };
  }, {
    launcherAssetsDir: "/var/lib/task-handoff/node-agent/docker-bootstrap",
    nodeAgentContainerIpcPath: "/run/task-handoff/container/node-agent.sock",
  });

  const result = await executor.start({
    ...value,
    instance: {
      ...value.instance,
      runtime: { ...value.instance.runtime, containerName, containerId },
    },
  });

  assert.equal(result.runtime.containerId, containerId);
  assert.equal(result.runtime.labels["task-handoff.bootstrap-abi"], "1");
  assert.ok(calls.some((args) => args[0] === "start" && args[1] === containerName));
  assert.equal(calls.some((args) => ["stop", "rename", "rm", "run"].includes(args[0])), false);
  assert.equal(await executor.resolveNodeAgentUrl({
    ...value,
    instance: { ...value.instance, runtime: { ...value.instance.runtime, containerName, containerId } },
  }), value.nodeAgentUrl);
});

test("v0.0.32 containers without the Agent Run mount can restart for upgrade recovery", async () => {
  const value = context();
  const containerName = "task-handoff-inst_one";
  const containerId = "existing-container-id";
  const runtimeVolume = volumeForInspection(value, `task-handoff-${value.instance.id}-runtime`);
  const calls = [];
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      return { stdout: JSON.stringify({
        Id: containerId,
        State: { Running: false },
        Config: { Labels: { "task-handoff.instance-id": value.instance.id } },
        Mounts: [
          ...persistentVolumes(value).map((volume) => ({ Type: "volume", Name: volume.name, Destination: volume.mountPath })),
          { Type: "volume", Name: runtimeVolume.name, Destination: runtimeVolume.mountPath },
          { Type: "bind", Source: path.resolve(value.project.source.path), Destination: value.project.workspacePolicy.path },
        ],
      }), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const volume = volumeForInspection(value, args.at(-1));
      return { stdout: JSON.stringify({ Name: volume.name, Driver: "local", Labels: volume.labels }), stderr: "" };
    }
    if (args[0] === "port") return { stdout: "127.0.0.1:19090", stderr: "" };
    return { stdout: "", stderr: "" };
  });

  const result = await executor.start({
    ...value,
    instance: { ...value.instance, runtime: { ...value.instance.runtime, containerName, containerId } },
  });
  assert.equal(result.runtime.containerId, containerId);
  assert.ok(calls.some((args) => args[0] === "start" && args[1] === containerName));
  assert.equal(calls.some((args) => ["rm", "run", "rename"].includes(args[0])), false);
});

test("existing containers reject a foreign volume at an Agent Run runtime path", async () => {
  const value = context();
  const containerName = "task-handoff-inst_one";
  const containerId = "existing-container-id";
  const runtime = runtimeVolume(value);
  const [agentRun] = agentRunVolumes(value);
  const executor = new LocalDockerExecutor(async (_command, args) => {
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      return { stdout: JSON.stringify({
        Id: containerId,
        State: { Running: true },
        Config: { Labels: { "task-handoff.instance-id": value.instance.id } },
        Mounts: [
          ...persistentVolumes(value).map((volume) => ({ Type: "volume", Name: volume.name, Destination: volume.mountPath })),
          { Type: "volume", Name: runtime.name, Destination: runtime.mountPath },
          { Type: "volume", Name: "foreign-agent-run", Destination: agentRun.mountPath },
          { Type: "bind", Source: path.resolve(value.project.source.path), Destination: value.project.workspacePolicy.path },
        ],
      }), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const volume = volumeForInspection(value, args.at(-1));
      return { stdout: JSON.stringify({ Name: volume.name, Driver: "local", Labels: volume.labels }), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });

  await assert.rejects(
    () => executor.start({
      ...value,
      instance: { ...value.instance, runtime: { ...value.instance.runtime, containerName, containerId } },
    }),
    (error) => error.code === "AGENT_RUN_VOLUME_MOUNT_IDENTITY_MISMATCH",
  );
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

test("Agent Run runtime volume rejects local-driver remote or bind options", async () => {
  const value = context();
  const agentRunVolumeName = agentRunVolumes(value)[0].name;
  const executor = new LocalDockerExecutor(async (_command, args) => {
    if (args[0] === "inspect" && args.includes("{{json .}}")) {
      throw Object.assign(new Error("No such container"), { details: { stderr: "No such container" } });
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return { stdout: JSON.stringify({ Id: `sha256:${"a".repeat(64)}`, RepoDigests: [] }), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      const volume = volumeForInspection(value, args.at(-1));
      return { stdout: JSON.stringify({
        Name: volume.name,
        Driver: "local",
        Options: volume.name === agentRunVolumeName ? { type: "nfs", device: ":/exports/agent-runs" } : null,
        Labels: volume.labels,
      }), stderr: "" };
    }
    return { stdout: args.at(-1) || "", stderr: "" };
  });

  await assert.rejects(
    () => executor.start(value),
    (error) => error.code === "AGENT_RUN_VOLUME_IDENTITY_MISMATCH",
  );
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
  for (const volume of agentRunVolumes(local)) {
    assert.equal(partial.volumeResults.some((item) => item.name === volume.name), false);
  }

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
