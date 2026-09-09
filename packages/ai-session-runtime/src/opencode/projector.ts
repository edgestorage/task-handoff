import type {
  AiSessionConversationAttachment,
  AiSessionLifecycle,
  AiSessionPhase,
  AiSessionSnapshotInput,
  AiSessionTimelineItem,
  AiSessionTurn,
  AiSessionModelSelection,
  AiSessionReasoningEffort,
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
  messageById: Map<string, OpenCodeMessageIdentity>;
  partById: Map<string, OpenCodePartIdentity>;
  pendingPermission?: OpenCodePermission;
};

export type OpenCodeMessageIdentity = {
  turnId: string;
  role: "user" | "assistant";
};

export type OpenCodePartIdentity = OpenCodeMessageIdentity & {
  messageId: string;
  type: string;
};

export function openCodeSessionLineage(session: OpenCodeSession) {
  if (!session.parentID) return undefined;
  return { kind: "subagent" as const, parentProviderSessionId: session.parentID };
}

export function projectOpenCodeSession(input: {
  session: OpenCodeSession;
  status?: OpenCodeSessionStatus;
  permissions: OpenCodePermission[];
  messages: OpenCodeMessage[];
  projectModelSelection?: (providerID: string, modelID: string) => AiSessionModelSelection | undefined;
}): OpenCodeProjection {
  const messages = [...input.messages].sort((left, right) => left.info.time.created - right.info.time.created);
  const permissions = input.permissions.filter((permission) => permission.sessionID === input.session.id);
  const pendingPermission = permissions.at(-1);
  const messageById = new Map<string, OpenCodeMessageIdentity>();
  const partById = new Map<string, OpenCodePartIdentity>();
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
    messageById.set(message.info.id, { turnId, role: "user" });
    for (const part of message.parts) partById.set(part.id, { turnId, messageId: message.info.id, role: "user", type: part.type });
    for (const assistant of assistants) {
      messageById.set(assistant.info.id, { turnId, role: "assistant" });
      for (const part of assistant.parts) partById.set(part.id, { turnId, messageId: assistant.info.id, role: "assistant", type: part.type });
    }
    const userText = textParts(message.parts).join("\n").trim();
    const attachments = conversationAttachments(message.parts);
    const assistantTextParts = assistants.flatMap((assistant) => assistant.parts.filter(isTextPart));
    const assistantText = assistantTextParts.map((part) => String(part.text)).join("").trim();
    const assistantError = assistants.map((assistant) => assistant.info.role === "assistant" ? openCodeErrorText(assistant.info.error) : undefined).find(Boolean);
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
  if (input.status?.type === "retry" && latestTurn && !timeline.some((item) => (
    item.turnId === latestTurn.id && item.type === "activity" && item.activityKind === "retry"
  ))) {
    timeline.push(openCodeRetryActivity(latestTurn.id, input.status.message));
  }
  const latestAssistant = messages.filter((message) => message.info.role === "assistant").at(-1);
  const latestUserInfo = userMessages.at(-1)?.info;
  const latestUserModel = latestUserInfo?.role === "user"
    ? latestUserInfo.model as { providerID: string; modelID: string; variant?: string } | undefined
    : undefined;
  const actualModel = latestUserModel
    ? { providerID: latestUserModel.providerID, modelID: latestUserModel.modelID, variant: latestUserModel.variant }
    : input.session.model
      ? { providerID: input.session.model.providerID, modelID: input.session.model.id, variant: input.session.model.variant }
      : undefined;
  const error = latestAssistant?.info.role === "assistant" ? openCodeErrorText(latestAssistant.info.error) : undefined;
  const lifecycle = projectLifecycle(input.status, pendingPermission, error);
  const phase = projectPhase(input.status, pendingPermission, messages);
  return {
    snapshot: {
      agent: "opencode",
      creationSource: "ai-session",
      providerSessionId: input.session.id,
      lineage: openCodeSessionLineage(input.session),
      providerMeta: compactRecord({
        version: input.session.version,
        model: input.session.model,
        retry: input.status?.type === "retry" ? { attempt: input.status.attempt, message: input.status.message, next: input.status.next } : undefined,
        pendingPermissionId: pendingPermission?.id,
      }),
      modelSelection: actualModel
        ? input.projectModelSelection?.(actualModel.providerID, actualModel.modelID)
        : undefined,
      reasoningEffort: actualModel?.variant && isReasoningEffort(actualModel.variant)
        ? actualModel.variant
        : undefined,
      actions: { send: true, interrupt: lifecycle === "running" || lifecycle === "waiting", approval: Boolean(pendingPermission), fork: true, close: true },
      title: input.session.title,
      cwd: input.session.directory,
      activeTurnId: lifecycle === "running" || lifecycle === "waiting" ? latestTurn?.id : undefined,
      userPrompt: latestTurn?.userPrompt,
      turns: turns.slice(-50),
      status: lifecycle,
      phase,
      summary: pendingPermission ? permissionSummary(pendingPermission) : undefined,
      lastMessage: latestTurn?.lastMessage,
      lastMessageItemId: latestTurn?.lastMessageItemId,
      error,
      toolCallsSinceLastMessage: activeTools(messages).length,
      currentTool: activeTools(messages).at(-1),
      observedAt: iso(input.session.time.updated),
      snapshotVersion: Math.floor(input.session.time.updated),
      replaceActivity: true,
    },
    timeline,
    messageById,
    partById,
    pendingPermission,
  };
}

function isReasoningEffort(value: string): value is AiSessionReasoningEffort {
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value);
}

export function projectOpenCodePart(part: OpenCodePart, turnId: string): AiSessionTimelineItem | undefined {
  const record = part as Record<string, unknown>;
  if (record.type === "text") {
    const text = typeof record.text === "string" ? record.text.trim() : "";
    return text ? { id: part.id, turnId, type: "ai-message", text } : undefined;
  }
  if (record.type === "reasoning") {
    const text = typeof record.text === "string" ? record.text : "";
    return activity(part.id, turnId, "reasoning", "Reasoning", {
      status: reasoningStatus(record),
      output: text || undefined,
    });
  }
  if (record.type === "step-start" || record.type === "step-finish" || record.type === "snapshot") return undefined;
  if (record.type === "file") {
    const filename = typeof record.filename === "string" ? record.filename : undefined;
    const image = typeof record.mime === "string" && record.mime.startsWith("image/");
    return activity(part.id, turnId, image ? "imageView" : "fileRead", image ? "View image" : "Read file", {
      paths: filename ? [filename] : undefined,
      summary: filename,
    });
  }
  if (record.type === "tool") {
    return projectOpenCodeToolActivity(part.id, turnId, typeof record.tool === "string" ? record.tool : "Tool", asRecord(record.state));
  }
  // OpenCode emits a filesystem snapshot patch after each model step. The
  // concrete edit/write/apply_patch tool part owns timeline activity; emitting
  // both would duplicate the same file change.
  if (record.type === "patch") return undefined;
  if (record.type === "compaction") return activity(part.id, turnId, "contextCompaction", "Context compaction", { status: "completed" });
  if (record.type === "retry") return activity(part.id, turnId, "retry", "Retry", { status: "waiting", summary: openCodeErrorText(record.error) });
  // OpenCode materializes user subtask inputs as an authoritative assistant
  // `task` tool part; emitting the input part as activity would duplicate it.
  if (record.type === "subtask") return undefined;
  return undefined;
}

export function openCodePartDelta(event: { partID: string; messageID: string; field: string; delta: string }, partById: Map<string, OpenCodePartIdentity>) {
  if (event.field !== "text" || !event.delta) return undefined;
  const part = partById.get(event.partID);
  if (!part || part.messageId !== event.messageID || part.role !== "assistant") return undefined;
  if (part.type === "text") return { kind: "message" as const, itemId: event.partID, turnId: part.turnId, delta: event.delta };
  if (part.type === "reasoning") return { kind: "timeline-item" as const, itemId: event.partID, turnId: part.turnId, field: "output" as const, delta: event.delta };
  return undefined;
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
  return status?.type === "busy" ? activePhase(messages) : "unknown";
}

function activePhase(messages: OpenCodeMessage[]): AiSessionPhase {
  if (activeTools(messages).length) return "tool";
  const latestPart = messages
    .filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts)
    .at(-1);
  return latestPart?.type === "reasoning" ? "thinking" : "responding";
}

function reasoningStatus(record: Record<string, unknown>) {
  const time = asRecord(record.time);
  return isNumber(time.end) ? "completed" as const : "running" as const;
}

function activeTools(messages: OpenCodeMessage[]) {
  return messages.flatMap((message) => message.parts.flatMap((part) => {
    const record = part as Record<string, unknown>;
    const state = asRecord(record.state);
    if (record.type !== "tool" || (state.status !== "pending" && state.status !== "running")) return [];
    const projected = openCodeToolDescriptor(typeof record.tool === "string" ? record.tool : "Tool", state);
    return [{
      id: part.id,
      kind: projected.activityKind,
      name: projected.title,
      inputPreview: projected.inputPreview?.slice(0, 500),
      startedAt: isNumber(asRecord(state.time).start) ? iso(asRecord(state.time).start as number) : undefined,
    }];
  }));
}

function projectOpenCodeToolActivity(id: string, turnId: string, tool: string, state: Record<string, unknown>) {
  const projected = openCodeToolDescriptor(tool, state);
  return activity(id, turnId, projected.activityKind, projected.title, {
    status: toolStatus(state.status, projected.activityKind === "commandExecution" ? projected.exitCode : undefined),
    summary: projected.summary,
    input: projected.input,
    output: toolOutput(state),
    paths: projected.paths,
    exitCode: projected.exitCode,
    durationMs: duration(state),
  });
}

function openCodeToolDescriptor(toolName: string, state: Record<string, unknown>) {
  const tool = toolName.toLocaleLowerCase();
  const input = asRecord(state.input);
  const metadata = asRecord(state.metadata);
  const fallbackTitle = typeof state.title === "string" && state.title.trim() ? state.title : toolName;
  if (tool === "bash" || tool === "shell") {
    const command = stringValue(input.command) || stringValue(input.cmd);
    return {
      activityKind: "commandExecution",
      title: "Command",
      input: command,
      inputPreview: command,
      exitCode: integerValue(metadata.exit),
    };
  }
  if (tool === "edit" || tool === "write") {
    const path = stringValue(input.filePath) || stringValue(input.filepath) || stringValue(metadata.filepath);
    return {
      activityKind: "fileChange",
      title: tool === "write" ? "Write file" : "Edit file",
      summary: path,
      input: stringValue(metadata.diff) || safeJson(state.input),
      inputPreview: path,
      paths: path ? [path] : undefined,
    };
  }
  if (tool === "apply_patch" || tool === "patch") {
    const files = arrayRecords(metadata.files);
    const paths = files.flatMap((file) => stringValue(file.movePath) || stringValue(file.filePath) || stringValue(file.relativePath) || []).filter(unique);
    return {
      activityKind: "fileChange",
      title: "File changes",
      summary: paths.join(", ") || fallbackTitle,
      input: files.length ? safeJson(files) : stringValue(input.patchText) || safeJson(state.input),
      inputPreview: paths.join(", ") || fallbackTitle,
      paths: paths.length ? paths : undefined,
    };
  }
  if (tool === "task") {
    const description = stringValue(input.description) || fallbackTitle;
    const agent = stringValue(input.subagent_type);
    return {
      activityKind: "collabAgentToolCall",
      title: "Sub-agent task",
      summary: [description, agent ? `@${agent}` : undefined].filter(Boolean).join(" "),
      input: stringValue(input.prompt) || safeJson(state.input),
      inputPreview: description,
    };
  }
  if (tool === "websearch") {
    const query = stringValue(input.query);
    return { activityKind: "webSearch", title: "Web search", summary: query || fallbackTitle, input: query || safeJson(state.input), inputPreview: query };
  }
  if (tool === "read") {
    const path = stringValue(input.filePath) || stringValue(input.filepath);
    const image = arrayRecords(state.attachments).some((attachment) => stringValue(attachment.mime)?.startsWith("image/"));
    return {
      activityKind: image ? "imageView" : "fileRead",
      title: image ? "View image" : "Read file",
      summary: path || fallbackTitle,
      input: safeJson(state.input),
      inputPreview: path,
      paths: path ? [path] : undefined,
    };
  }
  if (tool === "glob" || tool === "grep") {
    const pattern = stringValue(input.pattern);
    const path = stringValue(input.path);
    return {
      activityKind: "fileSearch",
      title: tool === "glob" ? "Find files" : "Search files",
      summary: [pattern, path].filter(Boolean).join(" · ") || fallbackTitle,
      input: safeJson(state.input),
      inputPreview: pattern || path,
      paths: path ? [path] : undefined,
    };
  }
  if (tool === "webfetch") {
    const url = stringValue(input.url);
    return { activityKind: "webFetch", title: "Fetch URL", summary: url || fallbackTitle, input: safeJson(state.input), inputPreview: url };
  }
  if (tool === "todowrite") {
    const count = Array.isArray(input.todos) ? input.todos.length : 0;
    const summary = count ? `${count} task${count === 1 ? "" : "s"}` : fallbackTitle;
    return { activityKind: "todoUpdate", title: "Update tasks", summary, input: safeJson(state.input), inputPreview: summary };
  }
  if (tool === "question") {
    const questions = Array.isArray(input.questions) ? input.questions.length : 0;
    const summary = questions ? `${questions} question${questions === 1 ? "" : "s"}` : fallbackTitle;
    return { activityKind: "userQuestion", title: "Ask user", summary, input: safeJson(state.input), inputPreview: summary };
  }
  if (tool === "skill") {
    const name = stringValue(input.name);
    return { activityKind: "skillLoad", title: "Load skill", summary: name || fallbackTitle, input: safeJson(state.input), inputPreview: name };
  }
  if (tool === "plan_exit") {
    return { activityKind: "exitedPlanMode", title: "Exit plan mode", summary: fallbackTitle === toolName ? undefined : fallbackTitle, input: safeJson(state.input) };
  }
  return { activityKind: "dynamicToolCall", title: toolName, summary: fallbackTitle === toolName ? undefined : fallbackTitle, input: safeJson(state.input), inputPreview: safeJson(state.input) };
}

function toolStatus(value: unknown, exitCode?: number) {
  return value === "error" || (value === "completed" && exitCode !== undefined && exitCode !== 0)
    ? "failed" as const
    : value === "completed"
      ? "completed" as const
      : value === "pending"
        ? "waiting" as const
        : "running" as const;
}

function toolOutput(state: Record<string, unknown>) {
  if (typeof state.output === "string") return state.output;
  if (typeof state.error === "string") return state.error;
  const liveOutput = asRecord(state.metadata).output;
  return typeof liveOutput === "string" && liveOutput ? liveOutput : undefined;
}

function arrayRecords(value: unknown) {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function integerValue(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function unique(value: string, index: number, values: string[]) {
  return values.indexOf(value) === index;
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

export function openCodeRetryActivity(turnId: string, message: string, status: "waiting" | "completed" = "waiting"): AiSessionTimelineItem {
  return activity(`opencode_retry:${turnId}`, turnId, "retry", "Retry", { status, summary: message.slice(0, 4000) });
}

export function openCodeErrorText(value: unknown): string | undefined {
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
