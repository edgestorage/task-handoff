import assert from "node:assert/strict";
import test from "node:test";
import { NodeRuntimeConsumerListSchema } from "@task-handoff/protocol/control-plane";
import { RuntimeAdapterRegistry } from "../src/node-agent/runtimes/adapters.ts";
import {
  LOCAL_RUNTIME_CAPABILITY_DEFAULTS,
  normalizeRuntimeCapabilities,
  runtimeRequiresImage,
  runtimeUsesManagedArtifacts,
} from "../src/node-agent/runtime-capabilities.ts";

/**
 * N-1 兼容矩阵脚手架（openspec change refactor-runtime-adapter-registry，D7）。
 * 锁定"重构不改变跨版本行为"：旧 Node Agent 的 runtime 记录归一结果不变；新 Node Agent 的
 * additively 新增类型不打断旧消费者；registry 对未注册类型继续 fail closed。
 */

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function legacyRuntime(type: string, capabilities: Record<string, unknown>) {
  return {
    id: type === "docker" ? "runtime_local_docker" : "runtime_local_host",
    nodeId: "node_legacy",
    name: type === "docker" ? "Local Docker" : "Local Runtime",
    type,
    status: "unknown",
    accessStrategy: type === "docker" ? "direct-port" : "node-proxy",
    capabilities,
    labels: {},
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

test("N-1: legacy docker/local runtime records normalize exactly as before the refactor", () => {
  const docker = legacyRuntime("docker", {});
  assert.deepEqual(normalizeRuntimeCapabilities(docker.type, docker.capabilities), {});
  assert.equal(runtimeRequiresImage(docker), true);
  assert.equal(runtimeUsesManagedArtifacts(docker), true);

  const local = legacyRuntime("local", { apps: { terminal: true, codex: "1", claude: "2" } });
  const localNormalized = normalizeRuntimeCapabilities(local.type, local.capabilities);
  assert.deepEqual(localNormalized, {
    apps: { terminal: true, codex: "1", claude: "2" },
    ...LOCAL_RUNTIME_CAPABILITY_DEFAULTS,
  });
  // 旧 Node Agent 持久化的 local runtime 记录已经带上了归一默认值；查询按归一后的记录判定。
  assert.equal(runtimeRequiresImage({ type: "local", capabilities: localNormalized }), false);
  assert.equal(runtimeUsesManagedArtifacts({ type: "local", capabilities: localNormalized }), false);
});

test("N-1: a new node agent runtime list stays readable and unknown types are filtered out", () => {
  const parsed = NodeRuntimeConsumerListSchema.safeParse([
    legacyRuntime("docker", {}),
    legacyRuntime("local", {}),
    { ...legacyRuntime("wsl", {}), id: "runtime_wsl", name: "WSL" },
    { ...legacyRuntime("not-a-runtime", {}), id: "runtime_future", name: "Future" },
  ]);
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  assert.deepEqual(parsed.data!.map((runtime) => runtime.type), ["docker", "local", "wsl"]);
  // 已知类型的既有字段语义不变。
  assert.deepEqual(parsed.data![0], legacyRuntime("docker", {}));
});

test("N-1: the registry keeps failing closed for types it does not register", () => {
  const registry = new RuntimeAdapterRegistry([
    { type: "docker", adapter: { resolveInstanceWeb: async () => "http://127.0.0.1:1" } as never },
    { type: "local", adapter: { resolveInstanceWeb: async () => "http://127.0.0.1:2" } as never },
  ]);
  assert.deepEqual(registry.types().sort(), ["docker", "local"]);
  // 旧 Node Agent 名单里没有的类型必须结构化失败，而不是回退到 Local/Docker。
  assert.throws(
    () => registry.forRuntime(legacyRuntime("wsl", {}) as never),
    (error: { code?: string; statusCode?: number }) => error.code === "NODE_RUNTIME_TYPE_UNSUPPORTED" && error.statusCode === 400,
  );
});
