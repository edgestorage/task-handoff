import { AiSessionReasoningEffortSchema, type AiSessionReasoningEffort } from "@task-handoff/protocol/ai-sessions";

/**
 * 推理强度的权威取值来自通信边界的协议 schema；控制面板 UI 只消费这份枚举，
 * 不在 composer、Agent 编辑器或实例设置里各自复写档位列表。
 */
export const AI_SESSION_REASONING_EFFORTS: readonly AiSessionReasoningEffort[] = AiSessionReasoningEffortSchema.options;

/** 只有 Codex 发布 `ultra` 档位；其他 agent 的可选档位到此为止。 */
export function supportedAiSessionReasoningEfforts(agent?: string): readonly AiSessionReasoningEffort[] {
  return agent === "codex" ? AI_SESSION_REASONING_EFFORTS : AI_SESSION_REASONING_EFFORTS.filter((effort) => effort !== "ultra");
}
