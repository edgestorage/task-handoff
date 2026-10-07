import assert from "node:assert/strict";
import test from "node:test";
import { AiSessionActionService } from "../src/control-plane/sessions/ai-session-actions.ts";
import { clientRequestTraceId, TRACE_ID_HEADER } from "../src/shared/http/server-timing.ts";

const session = {
  id: "ais_trace",
  agent: "codex",
  status: "idle",
  actions: { send: true, rename: true },
  modelSelection: { modelEntityId: "mdl_a", modelName: "model-a" },
};

function instanceFor() {
  return {
    id: "inst_trace",
    nodeId: "node_trace",
    config: {},
    capabilities: {
      features: {
        aiSessionProviders: [{
          agent: "codex",
          actions: { send: true, rename: true },
          timeline: { sessionRead: true, turnRead: true, liveItems: true },
          modelSelection: { switchModelWithinProvider: true, switchProviderDuringSession: true },
          reasoningEffort: { updateDuringSession: true },
        }],
      },
    },
    aiSessions: { sessions: [session] },
  };
}

function actionResult(route) {
  if (route.endsWith("/title")) return { disposition: "renamed", aiSessionId: session.id, title: "renamed" };
  if (route.endsWith("/model-selection")) return { sessionId: session.id, accepted: true };
  if (route.endsWith("/reasoning-effort")) return { sessionId: session.id, accepted: true };
  if (route.endsWith("/fork")) return { disposition: "created", aiSessionId: session.id, providerSessionId: "provider", creationSource: "ai-session" };
  if (route.endsWith("/open-app")) return { disposition: "opened", aiSessionId: session.id, providerSessionId: "provider", appSessionId: "app", creationSource: "ai-session" };
  if (route.endsWith("/close")) return { disposition: "closed", aiSessionId: session.id, providerSessionId: "provider", creationSource: "ai-session" };
  throw new Error(`Unexpected route ${route}`);
}

function serviceFor(sent) {
  const instance = instanceFor();
  return new AiSessionActionService({
    requireInstance: async () => instance,
    requireRuntime: async () => ({ type: "local" }),
    request: async (_instance, route, init) => {
      sent.push({ route, traceId: init.headers[TRACE_ID_HEADER] });
      return actionResult(route);
    },
  });
}

test("every AI session action forwards the caller client request id as the trace id", async () => {
  const sent = [];
  const service = serviceFor(sent);

  await service.rename("inst_trace", session.id, { title: "renamed", clientRequestId: "request-rename" });
  await service.updateModelSelection("inst_trace", session.id, "request-model", { modelEntityId: "mdl_b", modelName: "model-b" });
  await service.updateReasoningEffort("inst_trace", session.id, "request-effort", "low");
  await service.fork("inst_trace", session.id, { clientRequestId: "request-fork" });
  await service.openApp("inst_trace", session.id, "request-open");
  await service.close("inst_trace", session.id, "request-close");

  assert.deepEqual(sent, [
    { route: "/ai-sessions/ais_trace/title", traceId: "request-rename" },
    { route: "/ai-sessions/ais_trace/model-selection", traceId: "request-model" },
    { route: "/ai-sessions/ais_trace/reasoning-effort", traceId: "request-effort" },
    { route: "/ai-sessions/ais_trace/fork", traceId: "request-fork" },
    { route: "/ai-sessions/ais_trace/open-app", traceId: "request-open" },
    { route: "/ai-sessions/ais_trace/close", traceId: "request-close" },
  ]);
});

test("a client request id that is unsafe as a correlation header is forwarded as a digest", async () => {
  const sent = [];
  const service = serviceFor(sent);

  // 不能直接作为代理关联头的值必须回退成摘要，而不是在 node-agent 边界被拒。
  await service.close("inst_trace", session.id, "-leading-punctuation");

  assert.equal(sent[0].traceId, clientRequestTraceId("-leading-punctuation"));
  assert.match(sent[0].traceId, /^[a-f0-9]{64}$/);
});
