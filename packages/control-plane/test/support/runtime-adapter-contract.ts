import assert from "node:assert/strict";
import test from "node:test";
import type { NodeRuntime } from "@task-handoff/protocol/control-plane";
import type { ExecutorContext, RuntimeAdapter } from "../../src/node-agent/runtimes/contracts.ts";
import { RuntimeAdapterRegistry } from "../../src/node-agent/runtimes/adapters.ts";

/**
 * 跨 adapter contract 测试工厂（openspec change refactor-runtime-adapter-registry，D7）。
 * 新增 runtime 接入时 MUST 复用本工厂，MUST NOT 复制一份契约用例。
 */

export type RuntimeAdapterContractHarness = {
  adapter: RuntimeAdapter;
  runtime: NodeRuntime;
  /** 至少包含一个带 `runtime.port` 的上下文与一个不带端口的上下文。 */
  contextWithPort(port: number): ExecutorContext;
  contextWithoutPort(): ExecutorContext;
  /** 端点不可用时期望的结构化错误码；默认接受 INSTANCE_RUNTIME_ENDPOINT_UNAVAILABLE / NODE_INSTANCE_WEB_ENDPOINT_MISSING。 */
  missingEndpointCodes?: string[];
};

const DEFAULT_MISSING_ENDPOINT_CODES = [
  "INSTANCE_RUNTIME_ENDPOINT_UNAVAILABLE",
  "NODE_INSTANCE_WEB_ENDPOINT_MISSING",
];

export function registerRuntimeAdapterContractTests(label: string, harness: () => RuntimeAdapterContractHarness) {
  test(`${label} contract: exposes the RuntimeAdapter surface and registry dispatch`, () => {
    const { adapter, runtime } = harness();
    for (const method of ["resolveInstanceWeb", "start", "stop", "restart", "delete"]) {
      assert.equal(typeof (adapter as unknown as Record<string, unknown>)[method], "function", `missing ${method}`);
    }
    const registry = new RuntimeAdapterRegistry([{ type: runtime.type, adapter }]);
    assert.equal(registry.forRuntime(runtime), adapter);
  });

  test(`${label} contract: resolveInstanceWeb returns an origin-only 127.0.0.1 endpoint or fails closed`, async () => {
    const { adapter, contextWithPort, contextWithoutPort, missingEndpointCodes } = harness();
    const codes = missingEndpointCodes ?? DEFAULT_MISSING_ENDPOINT_CODES;
    const assertFailsClosed = (error: unknown) => {
      const candidate = error as { code?: string; statusCode?: number };
      assert.ok(codes.includes(candidate.code ?? ""), `unexpected error code ${candidate.code}`);
      assert.equal(typeof candidate.statusCode, "number");
      return true;
    };
    await adapter.resolveInstanceWeb(contextWithPort(18099)).then(
      (value) => assert.match(value, /^http:\/\/127\.0\.0\.1:\d+$/),
      assertFailsClosed,
    );
    await adapter.resolveInstanceWeb(contextWithoutPort()).then(
      (value) => assert.match(value, /^http:\/\/127\.0\.0\.1:\d+$/),
      assertFailsClosed,
    );
  });
}
