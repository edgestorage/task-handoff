import type { AiSessionSubAgent } from "@task-handoff/protocol/ai-sessions";
import type { CodexSubAgentUpdate, CodexToolDescriptor, JsonValue } from "./types";
import { asRecord, stringField } from "./values";

function codexSubAgentStatus(value: unknown): AiSessionSubAgent["status"] | undefined {
  switch (value) {
    case "pendingInit": return "pending-init";
    case "running": return "running";
    case "interrupted": return "interrupted";
    case "completed": return "completed";
    case "errored": return "errored";
    case "shutdown": return "shutdown";
    case "notFound": return "not-found";
    default: return undefined;
  }
}

export function codexSubAgentUpdates(item: JsonValue): CodexSubAgentUpdate[] {
  if (item.type === "subAgentActivity") {
    const threadId = stringField(item, "agentThreadId");
    const activity = ["started", "interacted", "interrupted"].includes(String(item.kind))
      ? item.kind as AiSessionSubAgent["activity"]
      : undefined;
    if (!threadId || !activity) return [];
    return [{
      threadId,
      path: stringField(item, "agentPath"),
      status: activity === "interrupted"
        ? "interrupted"
        : activity === "started"
          ? "pending-init"
          : "running",
      activity,
      observation: "activity",
    }];
  }
  if (item.type !== "collabAgentToolCall") return [];
  return Object.entries(asRecord(item.agentsStates)).flatMap(([threadId, rawState]) => {
    const state = asRecord(rawState);
    const status = codexSubAgentStatus(state.status);
    return threadId.trim() && status
      ? [{ threadId, status, message: stringField(state, "message"), observation: "state" as const }]
      : [];
  });
}

export function codexThreadItemKind(item: JsonValue): "tool" | "non-tool" | "unknown" {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "webSearch":
    case "imageView":
    case "sleep":
    case "imageGeneration":
      return "tool";
    case "userMessage":
    case "hookPrompt":
    case "agentMessage":
    case "plan":
    case "reasoning":
    case "subAgentActivity":
    case "enteredReviewMode":
    case "exitedReviewMode":
    case "contextCompaction":
      return "non-tool";
    default: return "unknown";
  }
}

export function codexToolDescriptor(item: JsonValue, startedAtMs?: number): CodexToolDescriptor | undefined {
  const classification = codexThreadItemKind(item);
  if (classification !== "tool") {
    if (classification === "unknown" && typeof item.type === "string" && item.type) {
      console.warn(`[codex-app-server] ignoring unknown ThreadItem.type: ${item.type}`);
    }
    return undefined;
  }
  const id = stringField(item, "id");
  const kind = stringField(item, "type");
  if (!id || !kind) return undefined;
  const projected = projectTool(item, kind);
  return {
    id,
    kind,
    name: projected.name,
    inputPreview: compact(projected.inputPreview),
    startedAt: isoTimestampFromMs(startedAtMs),
  };
}

export function isoTimestampFromMs(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function isoTimestampFromSeconds(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return isoTimestampFromMs(value * 1_000);
}

function projectTool(item: JsonValue, kind: string): { name: string; inputPreview?: string } {
  switch (kind) {
    case "commandExecution": return { name: "Command", inputPreview: stringField(item, "command") };
    case "fileChange": {
      const paths = Array.isArray(item.changes) ? item.changes.map((change) => stringField(asRecord(change), "path")).filter((path): path is string => Boolean(path)) : [];
      return { name: "File change", inputPreview: [...new Set(paths)].join(", ") || undefined };
    }
    case "mcpToolCall": { const server = stringField(item, "server"); const tool = stringField(item, "tool") || "Tool"; return { name: server ? `${server} · ${tool}` : tool, inputPreview: safeJson(item.arguments) }; }
    case "dynamicToolCall": { const namespace = stringField(item, "namespace"); const tool = stringField(item, "tool") || "Tool"; return { name: namespace ? `${namespace} · ${tool}` : tool, inputPreview: safeJson(item.arguments) }; }
    case "collabAgentToolCall": {
      const tool = stringField(item, "tool") || "collabAgentToolCall";
      const names: Record<string, string> = { spawnAgent: "Spawn agent", sendInput: "Send agent input", resumeAgent: "Resume agent", wait: "Wait for agents", closeAgent: "Close agent" };
      return { name: names[tool] || tool, inputPreview: stringField(item, "prompt") };
    }
    case "webSearch": return { name: "Web search", inputPreview: stringField(item, "query") };
    case "imageView": return { name: "View image", inputPreview: stringField(item, "path") };
    case "sleep": return { name: "Sleep", inputPreview: typeof item.durationMs === "number" ? `${item.durationMs} ms` : undefined };
    case "imageGeneration": return { name: "Image generation", inputPreview: stringField(item, "revisedPrompt") };
    default: return { name: kind };
  }
}
function compact(value: string | undefined) { const text = value?.replace(/\s+/g, " ").trim(); return text ? (text.length > 500 ? `${text.slice(0, 497)}...` : text) : undefined; }
function safeJson(value: unknown) { try { return value === undefined ? undefined : JSON.stringify(value); } catch { return undefined; } }
