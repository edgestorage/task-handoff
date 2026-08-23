import type {
  AiSessionConversationAttachment,
  AiSessionLifecycle,
  AiSessionPhase,
  AiSessionSnapshotInput,
  AiSessionTimelineItem,
  AiSessionTurn,
} from "@task-handoff/protocol/ai-sessions";
import type {
  OpenCodeMessage,
  OpenCodePart,
  OpenCodePermission,
  OpenCodeSession,
  OpenCodeSessionStatus,
} from "./wire";

export type OpenCodeProjection = {
  snapshot: Omit<AiSessionSnapshotInput, "type" | "source">;
  timeline: AiSessionTimelineItem[];
  turnByMessageId: Map<string, string>;
  pendingPermission?: OpenCodePermission;
};

export function projectOpenCodeSession(input: {
  session: OpenCodeSession;
  status?: OpenCodeSessionStatus;
  permissions: OpenCodePermission[];
  messages: OpenCodeMessage[];
}): OpenCodeProjection {
  const messages = [...input.messages].sort((left, right) => left.info.time.created - right.info.time.created);
  const permissions = input.permissions.filter((permission) => permission.sessionID === input.session.id);
  const pendingPermission = permissions.at(-1);
  const turnByMessageId = new Map<string, string>();
  const timeline: AiSessionTimelineItem[] = [];
  const turns: AiSessionTurn[] = [];
  const userMessages = messages.filter((message) => message.info.role === "user");
  const assistantsByParent = new Map<string, OpenCodeMessage[]>();

  for (const message of messages) {
    if (message.info.role !== "assistant") continue;
    const group = assistantsByParent.get(message.info.parentID);
    if (group) group.push(message);
    else assistantsByParent.set(message.info.parentID, [message]);
  }

  for (const message of userMessages) {
    const turnId = message.info.id;
    const assistants = assistantsByParent.get(turnId) || [];
    turnByMessageId.set(message.info.id, turnId);
    for (const assistant of assistants) turnByMessageId.set(assistant.info.id, turnId);
    const userText = textParts(message.parts).join("\n").trim();
    const attachments = conversationAttachments(message.parts);
    const assistantTextParts = assistants.flatMap((assistant) => assistant.parts.filter(isTextPart));
    const assistantText = assistantTextParts.map((part) => String(part.text)).join("").trim();
    const assistantError = assistants.map((assistant) => assistant.info.role === "assistant" ? errorText(assistant.info.error) : undefined).find(Boolean);
    const completedAtMs = assistants.map((assistant) => assistant.info.role === "assistant" ? assistant.info.time.completed : undefined).filter(isNumber).at(-1);
    const isActive = input.status?.type !== "idle" && message === userMessages.at(-1);
    const isWaiting = Boolean(pendingPermission && isActive);
    turns.push({
      id: turnId,
      providerTurnId: turnId,
      source: "adapter-snapshot",
      userPrompt: userText || undefined,
      userMessages: [{ id: message.info.id, text: userText, attachments }],
      status: assistantError ? "failed" : isWaiting ? "waiting" : isActive ? "running" : "completed",
      phase: isWaiting ? "approval" : isActive ? activePhase(assistants) : "unknown",
      lastMessage: assistantText || undefined,
      lastMessageItemId: assistantTextParts.at(-1)?.id,
      revision: 0,
      observedAt: iso(input.session.time.updated),
      startedAt: iso(message.info.time.created),
      updatedAt: iso(completedAtMs || input.session.time.updated),
      completedAt: !isActive && completedAtMs ? iso(completedAtMs) : undefined,
    });
    timeline.push({ id: message.info.id, turnId, type: "user-message", text: userText, attachments });
    for (const assistant of assistants) {
      for (const part of assistant.parts) {
        const item = projectOpenCodePart(part, turnId);
        if (item) timeline.push(item);
      }
    }
  }

  const latestTurn = turns.at(-1);
  const latestAssistant = messages.filter((message) => message.info.role === "assistant").at(-1);
  const error = latestAssistant?.info.role === "assistant" ? errorText(latestAssistant.info.error) : undefined;
  const lifecycle = projectLifecycle(input.status, pendingPermission, error);
  const phase = projectPhase(input.status, pendingPermission, messages);
  return {
    snapshot: {
      agent: "opencode",
      creationSource: "ai-session",
      providerSessionId: input.session.id,
      lineage: input.session.parentID ? { kind: "fork", parentProviderSessionId: input.session.parentID } : undefined,
      providerMeta: compactRecord({
        version: input.session.version,
        model: input.session.model,
        retry: input.status?.type === "retry" ? { attempt: input.status.attempt, message: input.status.message, next: input.status.next } : undefined,
        pendingPermissionId: pendingPermission?.id,
      }),
      actions: { send: true, interrupt: lifecycle === "running" || lifecycle === "waiting", approval: Boolean(pendingPermission), fork: true, close: true },
      title: input.session.title,
      cwd: input.session.directory,
      activeTurnId: lifecycle === "running" || lifecycle === "waiting" ? latestTurn?.id : undefined,
      userPrompt: latestTurn?.userPrompt,
      turns: turns.slice(-50),
      status: lifecycle,
      phase,
      summary: pendingPermission ? permissionSummary(pendingPermission) : input.status?.type === "retry" ? input.status.message : undefined,
      lastMessage: latestTurn?.lastMessage,
      lastMessageItemId: latestTurn?.lastMessageItemId,
      error,
      toolCallsSinceLastMessage: activeTools(messages).length,
      currentTool: activeTools(messages).at(-1),
      observedAt: iso(input.session.time.updated),
      snapshotVersion: Math.floor(input.session.time.updated),
    },
    timeline,
    turnByMessageId,
    pendingPermission,
  };
}

export function projectOpenCodePart(part: OpenCodePart, turnId: string): AiSessionTimelineItem | undefined {
  const record = part as Record<string, unknown>;
  if (record.type === "text") {
    const text = typeof record.text === "string" ? record.text.trim() : "";
    return text ? { id: part.id, turnId, type: "ai-message", text } : undefined;
  }
  if (record.type === "reasoning" || record.type === "step-start" || record.type === "step-finish" || record.type === "snapshot") return undefined;
  if (record.type === "file") {
    return activity(part.id, turnId, "file", "File", { paths: typeof record.filename === "string" ? [record.filename] : undefined });
  }
  if (record.type === "tool") {
    const state = asRecord(record.state);
    const status = state.status === "error" ? "failed" : state.status === "completed" ? "completed" : "running";
    return activity(part.id, turnId, "tool", typeof record.tool === "string" ? record.tool : "Tool", {
      status,
      summary: typeof state.title === "string" ? state.title : undefined,
      input: safeJson(state.input),
      output: typeof state.output === "string" ? state.output : typeof state.error === "string" ? state.error : undefined,
      durationMs: duration(state),
    });
  }
  if (record.type === "patch") {
    const paths = Array.isArray(record.files) ? record.files.filter((value): value is string => typeof value === "string") : [];
    return activity(part.id, turnId, "patch", "File changes", { paths, summary: paths.join(", ") || undefined, status: "completed" });
  }
  if (record.type === "compaction") return activity(part.id, turnId, "contextCompaction", "Context compaction", { status: "completed" });
  if (record.type === "retry") return activity(part.id, turnId, "retry", "Retry", { status: "waiting", summary: errorText(record.error) });
  if (record.type === "subtask") return activity(part.id, turnId, "subtask", "Subtask", { summary: typeof record.description === "string" ? record.description : undefined });
  return undefined;
}

export function openCodePartDelta(event: { partID: string; messageID: string; field: string; delta: string }, turnByMessageId: Map<string, string>) {
  if (event.field !== "text" || !event.delta) return undefined;
  const turnId = turnByMessageId.get(event.messageID);
  return turnId ? { itemId: event.partID, turnId, delta: event.delta } : undefined;
}

function projectLifecycle(status: OpenCodeSessionStatus | undefined, permission: OpenCodePermission | undefined, error?: string): AiSessionLifecycle {
  if (permission) return "waiting";
  if (status?.type === "busy" || status?.type === "retry") return "running";
  if (error) return "failed";
  return "idle";
}

function projectPhase(status: OpenCodeSessionStatus | undefined, permission: OpenCodePermission | undefined, messages: OpenCodeMessage[]): AiSessionPhase {
  if (permission) return "approval";
  if (status?.type === "retry") return "thinking";
  return activeTools(messages).length ? "tool" : status?.type === "busy" ? "responding" : "unknown";
}

function activePhase(messages: OpenCodeMessage[]): AiSessionPhase {
  return activeTools(messages).length ? "tool" : "responding";
}

function activeTools(messages: OpenCodeMessage[]) {
  return messages.flatMap((message) => message.parts.flatMap((part) => {
    const record = part as Record<string, unknown>;
    const state = asRecord(record.state);
    if (record.type !== "tool" || (state.status !== "pending" && state.status !== "running")) return [];
    return [{
      id: part.id,
      kind: "tool",
      name: typeof record.tool === "string" ? record.tool : "Tool",
      inputPreview: safeJson(state.input)?.slice(0, 500),
      startedAt: isNumber(asRecord(state.time).start) ? iso(asRecord(state.time).start as number) : undefined,
    }];
  }));
}

function conversationAttachments(parts: OpenCodePart[]): AiSessionConversationAttachment[] {
  return parts.flatMap((part) => {
    const record = part as Record<string, unknown>;
    if (record.type !== "file") return [];
    const mime = typeof record.mime === "string" ? record.mime : "application/octet-stream";
    return [{
      id: part.id,
      kind: mime.startsWith("image/") ? "image" as const : "file" as const,
      name: typeof record.filename === "string" ? record.filename : "attachment",
      mime,
      size: 0,
      contentState: "available" as const,
    }];
  });
}

function textParts(parts: OpenCodePart[]) {
  return parts.flatMap((part) => {
    const record = part as Record<string, unknown>;
    return record.type === "text" && record.synthetic !== true && record.ignored !== true && typeof record.text === "string" ? [record.text] : [];
  });
}

function isTextPart(part: OpenCodePart): part is OpenCodePart & { text: string } {
  const record = part as Record<string, unknown>;
  return record.type === "text" && record.synthetic !== true && record.ignored !== true && typeof record.text === "string";
}

function activity(id: string, turnId: string, activityKind: string, title: string, detail: Partial<Extract<AiSessionTimelineItem, { type: "activity" }>>): AiSessionTimelineItem {
  return { id, turnId, type: "activity", activityKind, title, ...compactRecord(detail) };
}

function permissionSummary(permission: OpenCodePermission) {
  return [permission.action, ...permission.resources].filter(Boolean).join(": ").slice(0, 1000);
}

function duration(state: Record<string, unknown>) {
  const time = asRecord(state.time);
  return isNumber(time.start) && isNumber(time.end) ? Math.max(0, time.end - time.start) : undefined;
}

function errorText(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value.slice(0, 4000);
  const record = asRecord(value);
  const data = asRecord(record.data);
  const message = typeof data.message === "string" ? data.message : typeof record.message === "string" ? record.message : undefined;
  return (message || safeJson(value))?.slice(0, 4000);
}

function safeJson(value: unknown) {
  if (value === undefined) return undefined;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function compactRecord<T extends Record<string, unknown>>(record: T) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function iso(value: number) {
  return new Date(value).toISOString();
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
