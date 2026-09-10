import assert from "node:assert/strict";
import test from "node:test";
import { AiSessionActionService } from "../src/control-plane/sessions/ai-session-actions.ts";
import { clientRequestTraceId, TRACE_ID_HEADER } from "../src/shared/http/server-timing.ts";

test("create timing keeps the v0.0.28 request body unchanged and forwards existing transport timing", async () => {
  let sent;
  const timing = { traceId: "request-create", serverTiming: "node_proxy;dur=12", nodeTransportMs: 15 };
  const received = [];
  const service = new AiSessionActionService({
    requireInstance: async () => ({ id: "instance", config: {}, capabilities: {} }),
    requireRuntime: async () => ({ type: "local" }),
    request: async (_instance, route, init, onTiming) => {
      sent = { route, headers: init.headers, body: JSON.parse(init.body) };
      onTiming?.(timing);
      return { disposition: "created", aiSessionId: "session", providerSessionId: "thread", creationSource: "ai-session" };
    },
  });
  const input = { agent: "codex", cwd: { type: "runtime-path", path: "/workspace" }, message: "test", clientRequestId: "request-create" };
  await service.create("instance", input, (value) => received.push(value));
  assert.equal(sent.route, "/ai-sessions");
  assert.deepEqual(sent.body, input);
  assert.equal(sent.headers[TRACE_ID_HEADER], "request-create");
  assert.deepEqual(received, [timing]);
});

test("existing request identifiers remain accepted when they cannot be sent directly as trace headers", () => {
  for (const id of ["创建请求", "request\nnext", "x".repeat(160)]) {
    const trace = clientRequestTraceId(id);
    assert.match(trace, /^[a-f0-9]{64}$/);
    assert.equal(trace, clientRequestTraceId(id));
    assert.doesNotThrow(() => new Headers({ [TRACE_ID_HEADER]: trace }));
  }
});
