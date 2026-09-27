import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DOCKER_AGENT_RUN_OVERLAY_ROOT,
  DOCKER_AGENT_RUN_ROOT,
  DOCKER_AGENT_RUN_SHARED_ROOT,
  agentRunRuntimeVolume,
  type CommandRunner,
} from "../src/node-agent/runtimes/docker.ts";
import { DockerAgentRunStorage, AGENT_RUN_OVERLAY_HELPER_IMAGE } from "../src/node-agent/agents/docker-agent-run-storage.ts";
import {
  AGENT_RUN_SHARED_SPACE_DEFAULT_RUN_QUOTA_BYTES,
  AgentRunSharedSpaceService,
  agentRunSharedSpaceBinding,
  assertAgentRunSharedSpacePath,
} from "../src/node-agent/agents/agent-run-shared-space.ts";
import { WorkspaceMaterializerRegistry } from "../src/node-agent/agents/workspace-materializer.ts";
import { createStoryDatabaseFixture } from "./story-database-fixture.ts";

const timestamp = "2026-09-26T00:00:00.000Z";

async function fixture() {
  const database = await createStoryDatabaseFixture("task-handoff-docker-agent-run-");
  const client = database.database.client;
  client.prepare("INSERT INTO na_node_identity (singleton_key, node_id, created_at, updated_at) VALUES (1, ?, ?, ?)")
    .run("node_one", timestamp, timestamp);
  client.prepare(`INSERT INTO na_runtimes
    (id, node_id, name, type, status, access_strategy, capabilities_json, labels_json, created_at, updated_at)
    VALUES (?, ?, 'Docker', 'docker', 'online', 'direct-port', '{}', '{}', ?, ?)`)
    .run("runtime_one", "node_one", timestamp, timestamp);
  client.prepare(`INSERT INTO na_instances
    (id, node_id, runtime_id, name, status, desired_json, created_at, updated_at)
    VALUES (?, ?, ?, 'Instance', 'running', '{}', ?, ?)`)
    .run("instance_one", "node_one", "runtime_one", timestamp, timestamp);
  const run = database.repository.agents.runs.create({
    clientRequestId: "request_one",
    input: { prompt: "Prepare the workspace" },
    provenance: { initiatingInstanceId: "instance_one", initiatingAiSessionId: "session_one", storyId: "story_one" },
    budget: { maxMembers: 4, maxDepth: 2, maxConcurrency: 2 },
    root: {
      agentId: "agent_one",
      instanceId: "instance_one",
      executionSnapshot: snapshot(),
    },
    timestamp,
  });
  return { ...database, run };
}

function snapshot() {
  return {
    agentRevision: "a".repeat(64),
    targetInstanceId: "instance_one",
    cwdFolderId: "folder_one",
    appendedPrompt: "Review",
    providerId: "codex",
    executionPolicy: { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" },
  } as const;
}

function target() {
  return {
    nodeId: "node_one",
    runtimeId: "runtime_one",
    instanceId: "instance_one",
    containerName: "task-handoff-instance_one",
    expectedContainerId: "container_one",
    providerReady: true,
  };
}

function inspectedContainer(includeRunVolumes = true) {
  return {
    Id: "container_one",
    State: { Running: true },
    Config: { User: "0:0", Labels: { "task-handoff.instance-id": "instance_one" } },
    Mounts: includeRunVolumes
      ? [{
        Type: "volume",
        Name: agentRunRuntimeVolume("node_one", "runtime_one").name,
        Destination: agentRunRuntimeVolume("node_one", "runtime_one").mountPath,
      }]
      : [],
  };
}

function prepareInput(runId: string, memberId: string) {
  return {
    runId,
    memberId,
    generationId: "generation_one",
    runtimeId: "runtime_one",
    instanceId: "instance_one",
    sourceRuntimePath: "/workspace/project",
    executionSnapshot: snapshot(),
  };
}

test("Docker overlay preparation uses a fixed constrained helper and is idempotently registered", async () => {
  const state = await fixture();
  const calls: string[][] = [];
  const marker = { version: 1, runId: state.run.runId, memberId: state.run.rootMemberId, generationId: "generation_one", createdAt: timestamp };
  const runCommand: CommandRunner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect") return { stdout: JSON.stringify(inspectedContainer()), stderr: "" };
    if (args.includes("inspect")) return { stdout: JSON.stringify({ mounted: true, marker }), stderr: "" };
    return { stdout: "", stderr: "" };
  };
  try {
    const storage = new DockerAgentRunStorage(runCommand, state.repository.agents.resources, () => target());
    const input = prepareInput(state.run.runId, state.run.rootMemberId);
    const first = await storage.prepare(input);
    const repeated = await storage.prepare(input);
    assert.equal(first.resourceId, repeated.resourceId);
    assert.equal(state.repository.agents.resources.listForRun(state.run.runId).length, 1);
    const helper = calls.find((args) => args[0] === "run" && args.includes("inject"))!;
    assert.ok(helper.includes(AGENT_RUN_OVERLAY_HELPER_IMAGE));
    assert.ok(helper.includes("--network") && helper.includes("none") && helper.includes("--read-only"));
    assert.ok(helper.includes("--cap-drop") && helper.includes("ALL"));
    for (const capability of ["SYS_ADMIN", "SYS_PTRACE", "SYS_CHROOT", "DAC_OVERRIDE", "CHOWN"]) assert.ok(helper.includes(capability));
    assert.equal(helper.includes("--mount"), false);
    assert.equal(helper.includes("--privileged"), false);
    assert.equal(helper.some((value) => value.includes("seccomp=unconfined")), false);
    assert.equal(helper.some((value) => /api[_-]?key|credential|secret|token/i.test(value)), false);
    assert.equal(first.diagnostics.sharesContainerUserNetworkAndCredentials, true);
    const attempts = state.repository.agents.resources.get(first.resourceId)!.metadata.injectionAttempts as Array<Record<string, unknown>>;
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].helperImage, AGENT_RUN_OVERLAY_HELPER_IMAGE);
    assert.equal(attempts[1].result, "completed");
  } finally { await state.close(); }
});

test("Missing immutable runtime mounts blocks Agent execution without issuing a helper command", async () => {
  const state = await fixture();
  const calls: string[][] = [];
  const runCommand: CommandRunner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect") return { stdout: JSON.stringify(inspectedContainer(false)), stderr: "" };
    return { stdout: "", stderr: "" };
  };
  try {
    const storage = new DockerAgentRunStorage(runCommand, state.repository.agents.resources, () => target());
    await assert.rejects(
      () => storage.prepare(prepareInput(state.run.runId, state.run.rootMemberId)),
      (error: any) => error.code === "AGENT_RUN_RUNTIME_VOLUME_MISSING",
    );
    assert.equal(calls.some((args) => args[0] === "run"), false);
  } finally { await state.close(); }
});

test("A Docker Runtime uses one Agent Run volume with disjoint overlay and shared subtrees", () => {
  const volume = agentRunRuntimeVolume("node_one", "runtime_one");
  assert.equal(volume.role, "agent-run");
  assert.equal(volume.mountPath, DOCKER_AGENT_RUN_ROOT);
  assert.equal(DOCKER_AGENT_RUN_OVERLAY_ROOT.startsWith(`${volume.mountPath}/`), true);
  assert.equal(DOCKER_AGENT_RUN_SHARED_ROOT.startsWith(`${volume.mountPath}/`), true);
  assert.notEqual(DOCKER_AGENT_RUN_OVERLAY_ROOT, DOCKER_AGENT_RUN_SHARED_ROOT);
});

test("Wrong identity at an immutable Agent Run mount is rejected", async () => {
  const state = await fixture();
  const runCommand: CommandRunner = async (_command, args) => {
    if (args[0] === "inspect") {
      const inspected = inspectedContainer();
      inspected.Mounts[0].Name = "foreign-overlay-volume";
      return { stdout: JSON.stringify(inspected), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  try {
    const storage = new DockerAgentRunStorage(runCommand, state.repository.agents.resources, () => target());
    await assert.rejects(
      () => storage.prepare(prepareInput(state.run.runId, state.run.rootMemberId)),
      (error: any) => error.code === "AGENT_RUN_RUNTIME_VOLUME_IDENTITY_MISMATCH",
    );
  } finally { await state.close(); }
});

test("Unavailable shared provider blocks preparation without changing ordinary container state", async () => {
  const state = await fixture();
  const calls: string[][] = [];
  const runCommand: CommandRunner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect") return { stdout: JSON.stringify(inspectedContainer()), stderr: "" };
    return { stdout: "", stderr: "" };
  };
  try {
    const storage = new DockerAgentRunStorage(runCommand, state.repository.agents.resources, () => ({ ...target(), providerReady: false }));
    await assert.rejects(
      () => storage.prepare(prepareInput(state.run.runId, state.run.rootMemberId)),
      (error: any) => error.code === "AGENT_RUN_PROVIDER_NOT_READY",
    );
    assert.equal(calls.some((args) => ["stop", "rm", "restart"].includes(args[0])), false);
  } finally { await state.close(); }
});

test("Materializer selection matches the complete combination and never falls back", async () => {
  const state = await fixture();
  try {
    const storage = new DockerAgentRunStorage(async () => ({ stdout: "", stderr: "" }), state.repository.agents.resources, () => target());
    const registry = new WorkspaceMaterializerRegistry();
    registry.register({ runtimeType: "docker", workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" }, storage);
    assert.equal(registry.require({ runtimeType: "docker", workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" }), storage);
    assert.throws(
      () => registry.require({ runtimeType: "local", workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" }),
      (error: any) => error.code === "AGENT_RUN_MATERIALIZER_UNAVAILABLE",
    );
    assert.throws(
      () => registry.require({ runtimeType: "docker", workspaceMaterializer: "worktree", processSandbox: "instance" }),
      (error: any) => error.code === "AGENT_RUN_MATERIALIZER_UNAVAILABLE",
    );
  } finally { await state.close(); }
});

test("Injection failure rolls back and never falls back to the source directory", async () => {
  const state = await fixture();
  const operations: string[] = [];
  const runCommand: CommandRunner = async (_command, args) => {
    if (args[0] === "inspect") return { stdout: JSON.stringify(inspectedContainer()), stderr: "" };
    if (args[0] === "run") {
      const operation = args[args.indexOf(AGENT_RUN_OVERLAY_HELPER_IMAGE) + 1];
      operations.push(operation);
      if (operation === "inject") throw new Error("mount denied");
    }
    return { stdout: "", stderr: "" };
  };
  try {
    const storage = new DockerAgentRunStorage(runCommand, state.repository.agents.resources, () => target());
    await assert.rejects(
      () => storage.prepare(prepareInput(state.run.runId, state.run.rootMemberId)),
      (error: any) => error.code === "AGENT_RUN_OVERLAY_INJECTION_FAILED",
    );
    assert.deepEqual(operations, ["inject", "rollback"]);
    assert.equal(state.repository.agents.resources.listForRun(state.run.runId)[0].phase, "deleted");
  } finally { await state.close(); }
});

test("ENOSPC during overlay preparation remains a structured failure without source fallback", async () => {
  const state = await fixture();
  const operations: string[] = [];
  const runCommand: CommandRunner = async (_command, args) => {
    if (args[0] === "inspect") return { stdout: JSON.stringify(inspectedContainer()), stderr: "" };
    const operation = args[args.indexOf(AGENT_RUN_OVERLAY_HELPER_IMAGE) + 1];
    if (operation) operations.push(operation);
    if (operation === "inject") throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    return { stdout: "", stderr: "" };
  };
  try {
    const storage = new DockerAgentRunStorage(runCommand, state.repository.agents.resources, () => target());
    await assert.rejects(
      () => storage.prepare(prepareInput(state.run.runId, state.run.rootMemberId)),
      (error: any) => error.code === "AGENT_RUN_OVERLAY_INJECTION_FAILED" && error.cause?.code === "ENOSPC",
    );
    assert.deepEqual(operations, ["inject", "rollback"]);
  } finally { await state.close(); }
});

test("Disposal stops the member first and retains EBUSY as retryable cleanup", async () => {
  const state = await fixture();
  const order: string[] = [];
  const marker = { version: 1, runId: state.run.runId, memberId: state.run.rootMemberId, generationId: "generation_one", createdAt: timestamp };
  let failDispose = false;
  const runCommand: CommandRunner = async (_command, args) => {
    if (args[0] === "inspect") return { stdout: JSON.stringify(inspectedContainer()), stderr: "" };
    const operation = args[args.indexOf(AGENT_RUN_OVERLAY_HELPER_IMAGE) + 1];
    if (operation === "inspect") return { stdout: JSON.stringify({ mounted: true, marker }), stderr: "" };
    if (operation === "dispose") {
      order.push("dispose");
      if (failDispose) throw Object.assign(new Error("target is busy"), { code: "EBUSY" });
    }
    return { stdout: "", stderr: "" };
  };
  try {
    const storage = new DockerAgentRunStorage(
      runCommand,
      state.repository.agents.resources,
      () => target(),
      async () => { order.push("terminate"); },
    );
    const prepared = await storage.prepare(prepareInput(state.run.runId, state.run.rootMemberId));
    failDispose = true;
    await assert.rejects(() => storage.dispose(prepared, prepared.marker), (error: any) => error.code === "AGENT_RUN_OVERLAY_DISPOSE_FAILED");
    assert.deepEqual(order.slice(-2), ["terminate", "dispose"]);
    const resource = state.repository.agents.resources.get(prepared.resourceId)!;
    assert.equal(resource.phase, "delete-retrying");
    assert.equal(resource.cleanupAttempts, 1);
  } finally { await state.close(); }
});

test("A forged overlay generation marker is never deleted", async () => {
  const state = await fixture();
  const operations: string[] = [];
  const runCommand: CommandRunner = async (_command, args) => {
    if (args[0] === "inspect") return { stdout: JSON.stringify(inspectedContainer()), stderr: "" };
    const operation = args[args.indexOf(AGENT_RUN_OVERLAY_HELPER_IMAGE) + 1];
    if (operation) operations.push(operation);
    if (operation === "inspect") return { stdout: JSON.stringify({
      mounted: true,
      marker: { version: 1, runId: state.run.runId, memberId: state.run.rootMemberId, generationId: "foreign_generation", createdAt: timestamp },
    }), stderr: "" };
    return { stdout: "", stderr: "" };
  };
  try {
    const storage = new DockerAgentRunStorage(runCommand, state.repository.agents.resources, () => target());
    const prepared = await storage.prepare(prepareInput(state.run.runId, state.run.rootMemberId));
    await assert.rejects(
      () => storage.dispose(prepared, prepared.marker),
      (error: any) => error.code === "AGENT_RUN_RESOURCE_OWNERSHIP_UNPROVEN",
    );
    assert.equal(operations.includes("dispose"), false);
    assert.equal(state.repository.agents.resources.get(prepared.resourceId)?.phase, "manual-intervention");
  } finally { await state.close(); }
});

test("Overlay disposal is idempotent after the mount and backing directories are gone", async () => {
  const state = await fixture();
  let disposed = false;
  let disposeCalls = 0;
  const runCommand: CommandRunner = async (_command, args) => {
    if (args[0] === "inspect") return { stdout: JSON.stringify(inspectedContainer()), stderr: "" };
    const operation = args[args.indexOf(AGENT_RUN_OVERLAY_HELPER_IMAGE) + 1];
    if (operation === "inspect") return { stdout: JSON.stringify(disposed ? { mounted: false } : { mounted: true, marker: {
      version: 1, runId: state.run.runId, memberId: state.run.rootMemberId, generationId: "generation_one", createdAt: timestamp,
    } }), stderr: "" };
    if (operation === "dispose") { disposed = true; disposeCalls += 1; }
    return { stdout: "", stderr: "" };
  };
  try {
    const storage = new DockerAgentRunStorage(runCommand, state.repository.agents.resources, () => target());
    const prepared = await storage.prepare(prepareInput(state.run.runId, state.run.rootMemberId));
    await storage.dispose(prepared, prepared.marker);
    await storage.dispose(prepared, prepared.marker);
    assert.equal(disposeCalls, 2);
    assert.equal(state.repository.agents.resources.get(prepared.resourceId)?.phase, "deleted");
  } finally { await state.close(); }
});

test("Reconciliation treats a replaced container mount as absent and cleans through the current instance", async () => {
  const state = await fixture();
  let currentTarget = target();
  let containerId = "container_one";
  const order: string[] = [];
  const runCommand: CommandRunner = async (_command, args) => {
    if (args[0] === "inspect") return { stdout: JSON.stringify({ ...inspectedContainer(), Id: containerId }), stderr: "" };
    const operation = args[args.indexOf(AGENT_RUN_OVERLAY_HELPER_IMAGE) + 1];
    if (operation) order.push(operation);
    return { stdout: "", stderr: "" };
  };
  try {
    const storage = new DockerAgentRunStorage(
      runCommand,
      state.repository.agents.resources,
      () => currentTarget,
      async () => { order.push("terminate"); },
    );
    await storage.prepare(prepareInput(state.run.runId, state.run.rootMemberId));
    containerId = "container_two";
    currentTarget = { ...target(), expectedContainerId: containerId };
    const result = await storage.reconcileInstance("instance_one");
    assert.deepEqual(result.map((item) => item.status), ["deleted"]);
    assert.deepEqual(order.slice(-2), ["terminate", "dispose"]);
    assert.equal(state.repository.agents.resources.listForRun(state.run.runId)[0].phase, "deleted");
  } finally { await state.close(); }
});

test("Stopped instances retain retryable cleanup without starting or deleting the controlled instance", async () => {
  const state = await fixture();
  let stopped = false;
  const calls: string[][] = [];
  const runCommand: CommandRunner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect") {
      const inspected = inspectedContainer();
      inspected.State.Running = !stopped;
      return { stdout: JSON.stringify(inspected), stderr: "" };
    }
    if (stopped && args[0] === "run") throw new Error("target instance is stopped");
    return { stdout: "", stderr: "" };
  };
  try {
    const storage = new DockerAgentRunStorage(runCommand, state.repository.agents.resources, () => target(), async () => {});
    await storage.prepare(prepareInput(state.run.runId, state.run.rootMemberId));
    stopped = true;
    const result = await storage.reconcileInstance("instance_one");
    assert.deepEqual(result.map((item) => item.status), ["retrying"]);
    assert.equal(calls.some((args) => ["start", "stop", "restart", "rm"].includes(args[0])), false);
  } finally { await state.close(); }
});

test("Overlay helper image has a fixed entrypoint and authoritative mount checks", () => {
  const root = path.resolve("docker/agent-run-overlay-helper");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const script = fs.readFileSync(path.join(root, "agent-run-overlay-helper.sh"), "utf8");
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/task-handoff-agent-run-overlay-helper"\]/);
  assert.match(script, /findmnt --noheadings --mountpoint/);
  assert.match(script, /nsenter --target 1 --mount --root=\/proc\/1\/root/);
  assert.match(script, /stat -c "%u:%g" \/proc\/1/);
  assert.match(script, /runtime_owner\(\)/);
  assert.match(script, /instance-runtime\/current/);
  assert.match(script, /tr '\\r\\n' '__'/);
  assert.match(script, /inject\)/);
  assert.match(script, /dispose\|rollback\)/);
  assert.match(script, /probe-verify\)/);
  assert.match(script, /sourceWriteRejected/);
  assert.match(script, /otherRunWriteRejected/);
  assert.match(dockerfile, /apk add --no-cache attr util-linux/);
  assert.match(script, /shared directory contains an overlay whiteout/);
  assert.match(script, /\^trusted\\\\\.overlay/);
  assert.match(script, /shared directory contains an overlay work directory/);
  assert.doesNotMatch(script, /eval /);
});

test("Shared space is one run-level path, rejects cross-run paths and enforces runtime identity", async () => {
  const state = await fixture();
  const runCommand: CommandRunner = async (_command, args) => {
    if (args[0] === "inspect") return { stdout: JSON.stringify(inspectedContainer()), stderr: "" };
    return { stdout: "", stderr: "" };
  };
  try {
    const storage = new DockerAgentRunStorage(runCommand, state.repository.agents.resources, () => target());
    const spaces = new AgentRunSharedSpaceService(state.repository.agents.resources, storage, DOCKER_AGENT_RUN_SHARED_ROOT);
    const first = await spaces.ensure({
      runId: state.run.runId, runtimeId: "runtime_one", instanceId: "instance_one", generationId: "generation_shared", timestamp,
    });
    const repeated = await spaces.ensure({
      runId: state.run.runId, runtimeId: "runtime_one", instanceId: "instance_one", generationId: "generation_shared", timestamp,
    });
    assert.equal(first.binding.runtimePath, repeated.binding.runtimePath);
    assert.equal(first.binding.runtimePath, `${DOCKER_AGENT_RUN_SHARED_ROOT}/${state.run.runId}`);
    assert.equal(spaces.bindingForMember(state.run.runId, "runtime_one").runtimePath, first.binding.runtimePath);
    const firstMember = spaces.pathPolicyForMember(state.run.runId, "runtime_one", "/run/task-handoff/agent-runs/workspaces/member_one/merged");
    const secondMember = spaces.pathPolicyForMember(state.run.runId, "runtime_one", "/run/task-handoff/agent-runs/workspaces/member_two/merged");
    assert.equal(firstMember.writableRoots[1], first.binding.runtimePath);
    assert.equal(secondMember.writableRoots[1], first.binding.runtimePath);
    assert.equal(firstMember.writableRoots[1].includes("member_one"), false);
    assert.throws(() => spaces.bindingForMember(state.run.runId, "runtime_other"), (error: any) => error.code === "AGENT_RUN_SHARED_RUNTIME_MISMATCH");
    assert.equal(assertAgentRunSharedSpacePath(first.binding, `${first.binding.runtimePath}/artifact.txt`), `${first.binding.runtimePath}/artifact.txt`);
    const other = agentRunSharedSpaceBinding("run_other", "runtime_one", DOCKER_AGENT_RUN_SHARED_ROOT);
    assert.throws(() => assertAgentRunSharedSpacePath(first.binding, `${other.runtimePath}/secret.txt`), (error: any) => error.code === "AGENT_RUN_SHARED_PATH_OUTSIDE_RUN");
    assert.equal(state.repository.agents.resources.listForRun(state.run.runId).filter((item) => item.kind === "shared-space-directory").length, 1);
  } finally { await state.close(); }
});

test("Expired shared space cleanup requires its generation marker and is node-agent driven", async () => {
  const state = await fixture();
  const operations: string[] = [];
  const runCommand: CommandRunner = async (_command, args) => {
    if (args[0] === "inspect") return { stdout: JSON.stringify(inspectedContainer()), stderr: "" };
    if (args[0] === "run") operations.push(args[args.indexOf(AGENT_RUN_OVERLAY_HELPER_IMAGE) + 1]);
    return { stdout: "", stderr: "" };
  };
  try {
    const storage = new DockerAgentRunStorage(runCommand, state.repository.agents.resources, () => target());
    const spaces = new AgentRunSharedSpaceService(state.repository.agents.resources, storage, DOCKER_AGENT_RUN_SHARED_ROOT);
    await spaces.ensure({ runId: state.run.runId, runtimeId: "runtime_one", instanceId: "instance_one", generationId: "generation_expiry", timestamp });
    spaces.retain(state.run.runId, new Date("2026-09-01T00:00:00.000Z"));
    const result = await spaces.reconcileExpired(new Date("2026-09-10T00:00:00.000Z"));
    assert.deepEqual(result, [{ runId: state.run.runId, status: "expired" }]);
    assert.equal(operations.includes("shared-expire"), true);
    assert.equal(state.repository.agents.resources.listForRun(state.run.runId).find((item) => item.kind === "shared-space-directory")?.phase, "deleted");
    assert.equal(state.repository.agents.resources.getSharedSpace(state.run.runId)?.state, "expired");
  } finally { await state.close(); }
});

test("Shared-space usage is persisted and exceeding the per-run quota fails closed", async () => {
  const state = await fixture();
  try {
    const backend = {
      async ensureRunDirectory() { return {}; },
      async inspectRunDirectory() { return { usageBytes: AGENT_RUN_SHARED_SPACE_DEFAULT_RUN_QUOTA_BYTES + 1 }; },
    };
    const spaces = new AgentRunSharedSpaceService(state.repository.agents.resources, backend, DOCKER_AGENT_RUN_SHARED_ROOT);
    await spaces.ensure({ runId: state.run.runId, runtimeId: "runtime_one", instanceId: "instance_one", generationId: "generation_quota", timestamp });
    await assert.rejects(
      () => spaces.refreshUsage(state.run.runId, "instance_one", new Date(timestamp)),
      (error: any) => error.code === "AGENT_RUN_SHARED_RUN_QUOTA_EXCEEDED",
    );
    const persisted = state.repository.agents.resources.getSharedSpace(state.run.runId)!;
    assert.equal(persisted.usageBytes, AGENT_RUN_SHARED_SPACE_DEFAULT_RUN_QUOTA_BYTES + 1);
    assert.equal(persisted.diagnostics.runQuotaBytes, AGENT_RUN_SHARED_SPACE_DEFAULT_RUN_QUOTA_BYTES);
  } finally { await state.close(); }
});
