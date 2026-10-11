import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ControlledInstance, NodeRuntime } from "@task-handoff/protocol/control-plane";
import { RuntimeAdapterRegistry, DockerRuntimeAdapter } from "../src/node-agent/runtimes/adapters.ts";
import { LocalDockerExecutor } from "../src/node-agent/runtimes/docker.ts";
import { LocalhostRuntimeAdapter } from "../src/node-agent/runtimes/local-adapter.ts";
import type { ExecutorContext, RuntimeAdapter } from "../src/node-agent/runtimes/contracts.ts";
import { nodeAgentStorePaths } from "../src/node-agent/persistence/paths.ts";
import { nodeLocalInstanceWebBase, resolveAuthoritativeInstanceWeb } from "../src/node-agent/instance-target.ts";
import {
  LOCAL_RUNTIME_CAPABILITY_DEFAULTS,
  normalizeRuntimeCapabilities,
  runtimeRequiresImage,
  runtimeUsesManagedArtifacts,
} from "../src/node-agent/runtime-capabilities.ts";
import { registerRuntimeAdapterContractTests } from "./support/runtime-adapter-contract.ts";

function fakeAdapter(overrides: Partial<RuntimeAdapter> = {}): RuntimeAdapter {
  return {
    resolveInstanceWeb: async () => "http://127.0.0.1:1",
    start: async () => ({}),
    stop: async () => ({}),
    restart: async () => ({}),
    delete: async () => ({ status: "deleted", deleted: [], retained: [], missing: [], failed: [] }),
    ...overrides,
  } as RuntimeAdapter;
}

const RUNTIME: NodeRuntime = {
  id: "runtime_test",
  nodeId: "node_test",
  name: "Test",
  type: "docker",
  status: "online",
  accessStrategy: "direct-port",
  capabilities: {},
  labels: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function instanceFixture(overrides: Partial<ControlledInstance> = {}): ControlledInstance {
  return {
    id: "inst_test",
    name: "inst",
    source: { type: "git-repository", repositoryId: "repo_1" },
    sourceSnapshot: {},
    nodeId: "node_test",
    runtimeId: "runtime_test",
    runtime: { kind: "local", port: 18099, labels: {} },
    config: {},
    status: "stopped",
    health: "unknown",
    connectionStatus: "unknown",
    agentStatus: "unknown",
    target: { strategy: "node-proxy", status: "unknown", web: "http://169.254.169.254/" },
    targetStatus: "unknown",
    uiAccessStatus: "unknown",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as ControlledInstance;
}

test("registry dispatches by member table and fails closed for unknown types", () => {
  const docker = fakeAdapter();
  const registry = new RuntimeAdapterRegistry([{ type: "docker", adapter: docker }]);
  assert.equal(registry.forRuntime(RUNTIME), docker);
  assert.equal(registry.has("docker"), true);
  assert.deepEqual(registry.types(), ["docker"]);

  assert.throws(
    () => registry.forRuntime({ ...RUNTIME, type: "kubernetes" }),
    (error: { code?: string; statusCode?: number }) => error.code === "NODE_RUNTIME_TYPE_UNSUPPORTED" && error.statusCode === 400,
  );
});

test("registering a new member makes it dispatchable without touching the registry implementation", () => {
  const registry = new RuntimeAdapterRegistry();
  const wsl = fakeAdapter();
  registry.register("wsl", wsl);
  assert.equal(registry.forRuntime({ ...RUNTIME, type: "wsl" }), wsl);
  // 未注册的既有类型仍然 fail closed，注册动作不会隐式接管其它类型。
  assert.throws(
    () => registry.forRuntime(RUNTIME),
    (error: { code?: string }) => error.code === "NODE_RUNTIME_TYPE_UNSUPPORTED",
  );
  assert.deepEqual(registry.types(), ["wsl"]);
});

test("shared adapter contracts are re-exported, not redefined, in implementation files", () => {
  const runtimesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/node-agent/runtimes");
  const sharedNames = ["ExecutorContext", "ExecutorStartResult", "RuntimeLiveness", "RuntimeAdapter", "ManagedRuntimeAdapter"];
  for (const file of ["docker.ts", "adapters.ts"]) {
    const source = fs.readFileSync(path.join(runtimesDir, file), "utf8");
    for (const name of sharedNames) {
      assert.ok(
        !new RegExp(`export type ${name}\\b`).test(source),
        `${file} must re-export ${name} from contracts.ts instead of redefining it`,
      );
    }
  }
});

test("managedAdapters only returns managed members and stopAll only stops stopOnShutdown members", async () => {
  const stopped: string[] = [];
  const managed = { ...fakeAdapter(), managedArtifacts: true as const, artifactTarget: async () => ({ platform: "linux", arch: "x64", launcherAbi: 1 }), installRuntime: async () => undefined, inspectRuntime: async () => true };
  const registry = new RuntimeAdapterRegistry([
    { type: "docker", adapter: { ...managed, stopAll: async () => stopped.push("docker") } },
    { type: "local", adapter: fakeAdapter({ stopOnShutdown: true, stopAll: async () => stopped.push("local") }) },
    { type: "k8s", adapter: managed },
  ]);
  assert.deepEqual(registry.managedAdapters().length, 2);
  await registry.stopAll();
  assert.deepEqual(stopped, ["local"]);
});

test("authoritative endpoint wins and controlled-instance reports are never trusted", () => {
  const instance = instanceFixture();
  assert.equal(resolveAuthoritativeInstanceWeb(instance, { authoritativeWeb: "http://127.0.0.1:4321" }), "http://127.0.0.1:4321");
  // The poisoned `target.web` above is never consulted.
  assert.equal(nodeLocalInstanceWebBase(instance), "http://127.0.0.1:18099");
});

test("endpoint authority rejects non-loopback, pathed, and userinfo endpoints", () => {
  const instance = instanceFixture();
  for (const authoritativeWeb of ["http://169.254.169.254/", "http://127.0.0.1:4321/path", "http://user:pass@127.0.0.1:4321", "https://127.0.0.1:4321"]) {
    assert.throws(
      () => resolveAuthoritativeInstanceWeb(instance, { authoritativeWeb }),
      (error: { code?: string }) => error.code === "NODE_INSTANCE_WEB_ENDPOINT_INVALID",
    );
  }
});

test("a runtime without a declared fallback fails closed instead of reusing runtime.port", () => {
  const instance = instanceFixture();
  assert.throws(
    () => resolveAuthoritativeInstanceWeb(instance, {}),
    (error: { code?: string; statusCode?: number }) => error.code === "NODE_INSTANCE_WEB_ENDPOINT_MISSING" && error.statusCode === 409,
  );
  // An explicit fallback still works for runtimes that declare it.
  assert.equal(resolveAuthoritativeInstanceWeb(instance, { fallbackKind: "local" }), "http://127.0.0.1:18099");
  assert.equal(resolveAuthoritativeInstanceWeb(instance, { fallbackWeb: "http://127.0.0.1:5555" }), "http://127.0.0.1:5555");
});

test("capability normalization keeps docker/local projections byte-identical to the pre-refactor defaults", () => {
  assert.deepEqual(normalizeRuntimeCapabilities("local", {}), { ...LOCAL_RUNTIME_CAPABILITY_DEFAULTS });
  assert.deepEqual(normalizeRuntimeCapabilities("local", { requiresImage: true, custom: "x" }), { custom: "x", ...LOCAL_RUNTIME_CAPABILITY_DEFAULTS });
  assert.deepEqual(normalizeRuntimeCapabilities("docker", { daemon: { status: "online" } }), { daemon: { status: "online" } });
  assert.deepEqual(normalizeRuntimeCapabilities("kubernetes", {}), {});

  assert.equal(runtimeRequiresImage({ type: "docker", capabilities: {} }), true);
  assert.equal(runtimeRequiresImage({ type: "local", capabilities: {} }), false);
  assert.equal(runtimeRequiresImage({ type: "kubernetes", capabilities: {} }), true);
  assert.equal(runtimeRequiresImage({ type: "docker", capabilities: { requiresImage: false } }), false);
  assert.equal(runtimeUsesManagedArtifacts({ type: "docker", capabilities: {} }), true);
  assert.equal(runtimeUsesManagedArtifacts({ type: "local", capabilities: { artifactKind: "none" } }), false);
});

const tmpPaths = nodeAgentStorePaths(fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-registry-")));

function contextFor(instance: ControlledInstance): ExecutorContext {
  return { instance } as unknown as ExecutorContext;
}

registerRuntimeAdapterContractTests("docker", () => ({
  adapter: new DockerRuntimeAdapter(new LocalDockerExecutor(async () => ({ stdout: "", stderr: "no container", exitCode: 1 })), async () => ({ stdout: "", stderr: "", exitCode: 1 }), "linux", "x64"),
  runtime: RUNTIME,
  contextWithPort: (port) => contextFor(instanceFixture({ runtime: { kind: "docker", containerName: "c", port, labels: {} } as never })),
  contextWithoutPort: () => contextFor(instanceFixture({ runtime: { kind: "docker", containerName: "c", labels: {} } as never })),
}));

registerRuntimeAdapterContractTests("local", () => ({
  adapter: new LocalhostRuntimeAdapter(async () => ({ stdout: "", stderr: "", exitCode: 0 }), tmpPaths, () => "http://127.0.0.1:8091"),
  runtime: { ...RUNTIME, id: "runtime_local_host", type: "local", accessStrategy: "node-proxy" },
  contextWithPort: (port) => contextFor(instanceFixture({ runtime: { kind: "local", port, labels: {} } })),
  contextWithoutPort: () => contextFor(instanceFixture({ runtime: { kind: "local", labels: {} } })),
}));
