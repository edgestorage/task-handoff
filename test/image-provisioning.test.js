const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  ImageProfileSchema,
  normalizeDockerImageReference,
  sanitizeStoredImageProfile,
} = require("../packages/protocol/src/control-plane.ts");
const { DockerImageService } = require("../packages/control-plane/src/node-agent/docker-images.ts");
const { createNodeAgentApp } = require("../packages/control-plane/src/node-agent/app.ts");

const digest = (letter) => `sha256:${letter.repeat(64)}`;
const tempDataDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

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
  return {
    id: "img_test",
    name: "Test image",
    reference,
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
  assert.deepEqual(warnings, ["image", "registry", "reference:implicit-latest"]);
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
      imageId: "img_test",
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
      imageId: "img_test",
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
      imageId: "img_test",
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
  stored.status = "provisioning";
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
    dockerCommandRunner: async (_command, args) => {
      if (args[0] === "image") {
        if (!available) throw new Error("missing");
        return { stdout: JSON.stringify({ Id: digest("e"), RepoDigests: [`docker.io/example/controlled@${digest("e")}`] }), stderr: "" };
      }
      if (args[0] === "pull") {
        available = true;
        return { stdout: "pulled", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  });
  t.after(() => restored.close());
  await restored.nodeAgentRestoreLocalInstances();
  const ready = await waitFor(() => {
    const instance = restored.nodeAgentState.controlledInstances.get("inst_restore");
    return instance?.status === "created" ? instance : undefined;
  }, "restored provisioning");
  assert.equal(ready.imageProvisioning.phase, "ready");
  assert.equal(ready.imageSnapshot.requestedReference, "docker.io/example/controlled:latest");
  assert.equal(ready.imageSnapshot.resolvedDigest, digest("e"));
  assert.equal("futureInstanceField" in ready, false);
  assert.equal("futureSnapshotField" in ready.imageSnapshot, false);
});
