import assert from "node:assert/strict";
import test from "node:test";
import { CLIENT_REQUEST_ID_MAX_LENGTH, ClientRequestIdSchema, OptionalClientRequestIdSchema } from "../src/client-request-id.ts";
import {
  AiSessionCloseInputSchema,
  AiSessionForkInputSchema,
  AiSessionModelSelectionInputSchema,
  AiSessionOpenAppInputSchema,
  AiSessionReasoningEffortInputSchema,
  AiSessionRenameInputSchema,
} from "../src/ai-sessions.ts";
import { AgentInvocationRequestSchema } from "../src/agent-invocation-tools.ts";
import { RepositoryStartAiSessionRequestSchema } from "../src/repository.ts";
import { StoryAutomationManualRunInputSchema } from "../src/stories.ts";

const boundaries: Array<{ name: string; accepts: (clientRequestId: string) => boolean }> = [
  { name: "ai-session rename", accepts: (id) => AiSessionRenameInputSchema.safeParse({ title: "title", clientRequestId: id }).success },
  { name: "ai-session model selection", accepts: (id) => AiSessionModelSelectionInputSchema.safeParse({ clientRequestId: id, modelSelection: { modelEntityId: "mdl_one", modelName: "model-one" } }).success },
  { name: "ai-session reasoning effort", accepts: (id) => AiSessionReasoningEffortInputSchema.safeParse({ clientRequestId: id, reasoningEffort: "low" }).success },
  { name: "ai-session fork", accepts: (id) => AiSessionForkInputSchema.safeParse({ clientRequestId: id }).success },
  { name: "ai-session open-app", accepts: (id) => AiSessionOpenAppInputSchema.safeParse({ clientRequestId: id }).success },
  { name: "ai-session close", accepts: (id) => AiSessionCloseInputSchema.safeParse({ clientRequestId: id }).success },
  { name: "agent invocation", accepts: (id) => AgentInvocationRequestSchema.safeParse({ clientRequestId: id, input: { agentId: "agent_one", prompt: "Review this change" } }).success },
  { name: "repository start session", accepts: (id) => RepositoryStartAiSessionRequestSchema.safeParse({ agent: "codex", workspaceSelection: { type: "current" }, message: "hello", clientRequestId: id }).success },
  { name: "story automation manual run", accepts: (id) => StoryAutomationManualRunInputSchema.safeParse({ clientRequestId: id }).success },
];

test("every boundary shares one client request id bound instead of per-endpoint copies", () => {
  const atBound = "r".repeat(CLIENT_REQUEST_ID_MAX_LENGTH);
  const overBound = "r".repeat(CLIENT_REQUEST_ID_MAX_LENGTH + 1);
  // 旧的 120 字符上界已随统一声明消失，这个长度必须在所有边界一致通过。
  const pastLegacyBound = "r".repeat(130);
  for (const { name, accepts } of boundaries) {
    assert.equal(accepts(atBound), true, `${name} must accept a client request id at the shared bound`);
    assert.equal(accepts(overBound), false, `${name} must reject a client request id past the shared bound`);
    assert.equal(accepts(pastLegacyBound), true, `${name} must accept a client request id beyond the legacy per-endpoint bound`);
    assert.equal(accepts("  request_one  "), true, `${name} must accept a padded client request id`);
    assert.equal(accepts(""), false, `${name} must reject an empty client request id`);
  }
});

test("client request ids stay opaque rather than an entity id shape", () => {
  assert.equal(ClientRequestIdSchema.parse("  request_one  "), "request_one");
  // 它是一次性关联键，不是实体 ID：不受统一 ID 铸造的字符集约束。
  assert.equal(ClientRequestIdSchema.safeParse("请求 1: 复现").success, true);
  assert.equal(OptionalClientRequestIdSchema.safeParse(undefined).success, true);
});
