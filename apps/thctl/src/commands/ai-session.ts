import { randomUUID } from "node:crypto";
import {
  AiSessionApprovalInputSchema,
  AiSessionForkInputSchema,
  AiSessionReasoningEffortSchema,
  AiSessionSendModeSchema,
  type AiSessionApprovalInput,
  type AiSessionTimelineItem,
  type AiSessionSendMode,
} from "@task-handoff/protocol/ai-sessions";
import { ThctlError } from "../errors.ts";
import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import {
  optionString,
  parseWithSchema,
  requireArgument,
  requireOption,
  requireUpdatedDetail,
  repeatableOption,
} from "./support.ts";

const SESSION_COLUMNS = [
  { key: "instanceId", header: "instance" },
  { key: "id", header: "session" },
  { key: "agent", header: "agent" },
  { key: "status", header: "status" },
  { key: "phase", header: "phase" },
  { key: "title", header: "title", width: 40 },
  { key: "updatedAt", header: "updated" },
];

const INSTANCE_SESSION_ROUTE = (instanceId: string, sessionId: string) =>
  `/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/${encodeURIComponent(sessionId)}`;

export async function aiSessionList(context: CliContext, invocation: CliInvocation) {
  const connection = await openConnection(context);
  const instanceId = typeof invocation.options.instance === "string" ? invocation.options.instance.trim() : "";
  const view = await connection.client.aiSessions.list(context.signal, instanceId || undefined);
  if (context.output.json) return { data: view };
  const rows = view.instances.flatMap((entry) => entry.aiSessions.sessions.map((session) => ({
    ...session,
    instanceId: entry.instanceId,
    title: session.title || session.userPrompt || session.summary || session.id,
  })));
  return { data: rows, columns: SESSION_COLUMNS, message: rows.length ? undefined : "No AI sessions matched." };
}

export async function aiSessionShow(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const connection = await openConnection(context);
  const detail = await connection.client.aiSessions.detail(instanceId, sessionId, undefined, context.signal);
  if (context.output.json) return { data: detail };
  if (detail.kind === "not-modified") {
    return { data: detail, message: `Session \`${sessionId}\` is unchanged at revision ${detail.revision}.` };
  }
  const session = detail.detail;
  const row = {
    id: session.id,
    cwd: session.cwd ?? "",
    model: session.modelSelection?.modelName ?? "",
    queued: session.queue?.pendingCount ?? 0,
    subAgents: session.subAgents?.length ?? 0,
    error: session.error ?? "",
  };
  return {
    data: row,
    columns: [
      { key: "id", header: "session" },
      { key: "cwd", header: "cwd", width: 40 },
      { key: "model", header: "model" },
      { key: "queued", header: "queued" },
      { key: "subAgents", header: "subagents" },
      { key: "error", header: "error", width: 40 },
    ],
  };
}

export async function aiSessionHistory(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const agents = repeatableOption(invocation, "agent");
  const connection = await openConnection(context);
  const history = await connection.client.aiSessions.history(instanceId, context.signal, agents.length ? agents : undefined);
  if (context.output.json) return { data: history };
  const rows = history.items.map((item) => ({
    ...item,
    title: item.title || item.userPrompt || item.lastMessage || item.providerSessionId,
  }));
  return {
    data: rows,
    columns: [
      { key: "id", header: "session" },
      { key: "agent", header: "agent" },
      { key: "title", header: "title", width: 40 },
      { key: "cwd", header: "cwd", width: 30 },
      { key: "lastActiveAt", header: "last active" },
    ],
    message: rows.length ? undefined : "No provider session history matched.",
  };
}

export async function aiSessionTurns(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const revision = optionString(invocation, "revision");
  const connection = await openConnection(context);
  const read = await connection.client.aiSessions.turnIndex(instanceId, sessionId, revision, context.signal);
  if (context.output.json) return { data: read };
  if (read.kind === "not-modified") {
    return { data: read, message: `Turn index for \`${sessionId}\` is unchanged at revision ${read.revision}.` };
  }
  return {
    data: read.index.turns,
    columns: [
      { key: "id", header: "turn", width: 40 },
      { key: "status", header: "status" },
      { key: "phase", header: "phase" },
      { key: "startedAt", header: "started" },
      { key: "completedAt", header: "completed" },
    ],
    message: read.index.turns.length ? undefined : `AI session \`${sessionId}\` has no turns yet.`,
  };
}

export async function aiSessionTurn(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const turnId = requireArgument(invocation, "turnId");
  const revision = optionString(invocation, "revision");
  const connection = await openConnection(context);
  const read = await connection.client.aiSessions.turnBody(instanceId, sessionId, turnId, revision, context.signal);
  if (context.output.json) return { data: read };
  if (read.kind === "not-modified") {
    return { data: read, message: `Turn \`${turnId}\` is unchanged at revision ${read.revision}.` };
  }
  const turn = read.body.turn;
  const rows = [
    ...(turn.userMessages ?? []).map((message) => ({ kind: "user", message: message.id, text: message.text })),
    ...(turn.lastMessage ? [{ kind: "assistant", message: turn.lastMessageItemId ?? "", text: turn.lastMessage }] : []),
  ];
  return {
    data: rows,
    columns: [
      { key: "kind", header: "kind" },
      { key: "message", header: "message", width: 24 },
      { key: "text", header: "text", width: 60 },
    ],
    message: `Turn \`${turnId}\` is ${turn.status}.`,
  };
}

type TimelineRow = { type: string; turn: string; title: string; detail: string };

function timelineRows(items: readonly AiSessionTimelineItem[]): TimelineRow[] {
  return items.map((item) => item.type === "activity"
    ? { type: item.activityKind, turn: item.turnId, title: item.title, detail: item.output ?? item.summary ?? item.input ?? "" }
    : { type: item.type, turn: item.turnId, title: "", detail: item.text });
}

const TIMELINE_COLUMNS = [
  { key: "type", header: "type" },
  { key: "turn", header: "turn", width: 40 },
  { key: "title", header: "title", width: 24 },
  { key: "detail", header: "detail", width: 60 },
];

export async function aiSessionTimeline(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const connection = await openConnection(context);
  const timeline = await connection.client.aiSessions.timeline(instanceId, sessionId, context.signal);
  if (context.output.json) return { data: timeline };
  return {
    data: timelineRows(timeline.items),
    columns: TIMELINE_COLUMNS,
    message: timeline.items.length ? undefined : `AI session \`${sessionId}\` has no timeline items.`,
  };
}

export async function aiSessionTurnTimeline(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const turnId = requireArgument(invocation, "turnId");
  const connection = await openConnection(context);
  const timeline = await connection.client.aiSessions.turnTimeline(instanceId, sessionId, turnId, context.signal);
  if (context.output.json) return { data: timeline };
  return {
    data: timelineRows(timeline.items),
    columns: TIMELINE_COLUMNS,
    message: timeline.items.length ? undefined : `Turn \`${turnId}\` has no timeline items.`,
  };
}

export async function aiSessionCreate(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const input = {
    agent: requireOption(invocation, "agent"),
    message: requireOption(invocation, "prompt"),
    clientRequestId: optionString(invocation, "request-id") ?? randomUUID(),
    attachments: [] as never[],
    references: [] as never[],
    ...(optionString(invocation, "cwd-folder") ? { cwdFolderId: optionString(invocation, "cwd-folder") } : {}),
    ...(optionString(invocation, "story") ? { storyId: optionString(invocation, "story") } : {}),
  };
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "ai-session create",
    () => ({ method: "POST", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions`, body: input }),
    () => connection.client.aiSessions.create(instanceId, input),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "aiSessionId", header: "session" },
      { key: "disposition", header: "disposition" },
      { key: "providerSessionId", header: "provider session" },
    ],
    message: `AI session \`${result.aiSessionId}\` is ${result.disposition}.`,
  };
}

export async function aiSessionSend(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const message = requireArgument(invocation, "message");
  const requestedMode = optionString(invocation, "mode");
  const mode = requestedMode ? parseSendMode(requestedMode) : undefined;
  const body = { message, ...(mode ? { mode } : {}) };
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "ai-session send",
    () => ({ method: "POST", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/messages`, body }),
    () => connection.client.aiSessions.sendMessage(instanceId, sessionId, body),
  );
  if (!result) return;
  return { data: result, message: `Message sent to AI session \`${sessionId}\`.` };
}

export async function aiSessionInterrupt(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "ai-session interrupt",
    () => ({ method: "POST", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/interrupt` }),
    () => connection.client.aiSessions.interrupt(instanceId, sessionId),
  );
  if (!result) return;
  return { data: result, message: `Interrupt requested for AI session \`${sessionId}\`.` };
}

export async function aiSessionApproval(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const decision = requireOption(invocation, "decision");
  const approval = parseApprovalDecision(decision);
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "ai-session approval",
    () => ({ method: "POST", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/approval`, body: approval }),
    () => connection.client.aiSessions.approval(instanceId, sessionId, approval.decision),
  );
  if (!result) return;
  return { data: result, message: `Approval \`${approval.decision}\` submitted for AI session \`${sessionId}\`.` };
}

export async function aiSessionResume(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "ai-session resume",
    () => ({ method: "POST", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/resume`, body: {} }),
    () => connection.client.aiSessions.resume(instanceId, sessionId, {}),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "aiSessionId", header: "session" },
      { key: "disposition", header: "disposition" },
      { key: "providerSessionId", header: "provider session" },
    ],
    message: `AI session \`${sessionId}\` is ${result.disposition}.`,
  };
}

export async function aiSessionRead(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "ai-session read",
    () => ({ method: "POST", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/read` }),
    () => connection.client.aiSessions.markRead(instanceId, sessionId),
  );
  if (!result) return;
  return { data: result, message: `AI session \`${sessionId}\` marked as read.` };
}

export async function aiSessionRename(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const input = {
    title: requireOption(invocation, "title"),
    clientRequestId: optionString(invocation, "request-id") ?? randomUUID(),
  };
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "ai-session rename",
    () => ({ method: "PUT", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/title`, body: input }),
    () => connection.client.aiSessions.rename(instanceId, sessionId, input),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "aiSessionId", header: "session" },
      { key: "disposition", header: "disposition" },
      { key: "title", header: "title", width: 40 },
    ],
    message: `AI session \`${result.aiSessionId}\` is ${result.disposition}.`,
  };
}

export async function aiSessionFork(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const throughTurnId = optionString(invocation, "through-turn");
  const workspaceMode = optionString(invocation, "workspace");
  const input = parseWithSchema(AiSessionForkInputSchema, {
    clientRequestId: optionString(invocation, "request-id") ?? randomUUID(),
    ...(throughTurnId ? { throughTurnId } : {}),
    ...(workspaceMode ? { workspace: { mode: workspaceMode } } : {}),
  }, "fork input");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "ai-session fork",
    () => ({ method: "POST", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/fork`, body: input }),
    () => connection.client.aiSessions.fork(instanceId, sessionId, input),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "aiSessionId", header: "session" },
      { key: "disposition", header: "disposition" },
      { key: "providerSessionId", header: "provider session" },
    ],
    message: `AI session \`${result.aiSessionId}\` is ${result.disposition}.`,
  };
}

export async function aiSessionClose(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const clientRequestId = optionString(invocation, "request-id") ?? randomUUID();
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "ai-session close",
    () => ({ method: "POST", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/close`, body: { clientRequestId } }),
    () => connection.client.aiSessions.close(instanceId, sessionId, clientRequestId),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "aiSessionId", header: "session" },
      { key: "disposition", header: "disposition" },
      { key: "providerSessionId", header: "provider session" },
    ],
    message: `AI session \`${result.aiSessionId}\` is ${result.disposition}.`,
  };
}

export async function aiSessionModel(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const modelSelection = {
    modelEntityId: requireOption(invocation, "entity"),
    modelName: requireOption(invocation, "name"),
  };
  const clientRequestId = optionString(invocation, "request-id") ?? randomUUID();
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "ai-session model",
    () => ({ method: "PUT", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/model-selection`, body: { clientRequestId, modelSelection } }),
    () => connection.client.aiSessions.updateModelSelection(instanceId, sessionId, clientRequestId, modelSelection),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "sessionId", header: "session" },
      { key: "accepted", header: "accepted" },
    ],
    message: `Model selection for AI session \`${sessionId}\` updated.`,
  };
}

export async function aiSessionReasoning(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const requested = requireOption(invocation, "effort");
  const reasoningEffort = AiSessionReasoningEffortSchema.safeParse(requested);
  if (!reasoningEffort.success) {
    throw new ThctlError("CLI_INVALID_OPTION", `--effort must be one of: ${AiSessionReasoningEffortSchema.options.join(", ")}.`, 2, { option: "effort", value: requested });
  }
  const clientRequestId = optionString(invocation, "request-id") ?? randomUUID();
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "ai-session reasoning",
    () => ({ method: "PUT", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/reasoning-effort`, body: { clientRequestId, reasoningEffort: reasoningEffort.data } }),
    () => connection.client.aiSessions.updateReasoningEffort(instanceId, sessionId, clientRequestId, reasoningEffort.data),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "sessionId", header: "session" },
      { key: "accepted", header: "accepted" },
    ],
    message: `Reasoning effort for AI session \`${sessionId}\` updated.`,
  };
}

export async function aiSessionQueueList(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const connection = await openConnection(context);
  const detail = requireUpdatedDetail(await connection.client.aiSessions.detail(instanceId, sessionId, undefined, context.signal), sessionId);
  const queue = detail.queue;
  if (context.output.json) return { data: queue };
  return {
    data: queue.items,
    columns: [
      { key: "id", header: "queue" },
      { key: "status", header: "status" },
      { key: "message", header: "message", width: 50 },
      { key: "createdAt", header: "created" },
    ],
    message: queue.items.length ? undefined : "No queued messages.",
  };
}

function queueMutation(commandId: string, action: "steer" | "retry" | "remove") {
  return async (context: CliContext, invocation: CliInvocation) => {
    const instanceId = requireArgument(invocation, "instanceId");
    const sessionId = requireArgument(invocation, "sessionId");
    const queueId = requireArgument(invocation, "queueId");
    const connection = await openConnection(context);
    const result = await performWrite(
      context,
      commandId,
      () => action === "remove"
        ? { method: "DELETE", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/queue/${encodeURIComponent(queueId)}` }
        : { method: "POST", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/queue/${encodeURIComponent(queueId)}/${action}` },
      async () => {
        if (action === "steer") return await connection.client.aiSessions.steerQueue(instanceId, sessionId, queueId);
        if (action === "retry") return await connection.client.aiSessions.retryQueue(instanceId, sessionId, queueId);
        return await connection.client.aiSessions.removeQueue(instanceId, sessionId, queueId);
      },
    );
    if (!result) return;
    return { data: result, message: `Queued message \`${queueId}\` ${action === "remove" ? "removed" : `${action} requested`}.` };
  };
}

export const aiSessionQueueSteer = queueMutation("ai-session queue steer", "steer");
export const aiSessionQueueRetry = queueMutation("ai-session queue retry", "retry");
export const aiSessionQueueRemove = queueMutation("ai-session queue remove", "remove");

async function resolveQueueRevision(
  context: CliContext,
  connection: Awaited<ReturnType<typeof openConnection>>,
  instanceId: string,
  sessionId: string,
  invocation: CliInvocation,
) {
  const explicit = optionString(invocation, "expected-revision");
  if (explicit !== undefined) {
    const value = Number(explicit);
    if (!Number.isInteger(value) || value < 0) {
      throw new ThctlError("CLI_INVALID_OPTION", "--expected-revision must be a non-negative integer.", 2, { option: "expected-revision", value: explicit });
    }
    return value;
  }
  const detail = requireUpdatedDetail(await connection.client.aiSessions.detail(instanceId, sessionId, undefined, context.signal), sessionId);
  return detail.queue?.revision ?? 0;
}

export async function aiSessionQueueEdit(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const queueId = requireArgument(invocation, "queueId");
  const message = requireOption(invocation, "message");
  const connection = await openConnection(context);
  const input = { expectedRevision: await resolveQueueRevision(context, connection, instanceId, sessionId, invocation), message };
  const result = await performWrite(
    context,
    "ai-session queue edit",
    () => ({ method: "PATCH", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/queue/${encodeURIComponent(queueId)}`, body: input }),
    () => connection.client.aiSessions.editQueue(instanceId, sessionId, queueId, input),
  );
  if (!result) return;
  return { data: result, message: `Queued message \`${queueId}\` updated.` };
}

export async function aiSessionQueueReorder(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const queueIds = repeatableOption(invocation, "queue");
  if (!queueIds.length) {
    throw new ThctlError("CLI_OPTION_MISSING", "Pass at least one --queue <queueId> to reorder.", 2, { option: "queue" });
  }
  const connection = await openConnection(context);
  const input = { expectedRevision: await resolveQueueRevision(context, connection, instanceId, sessionId, invocation), queueIds };
  const result = await performWrite(
    context,
    "ai-session queue reorder",
    () => ({ method: "PATCH", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/queue/reorder`, body: input }),
    () => connection.client.aiSessions.reorderQueue(instanceId, sessionId, input),
  );
  if (!result) return;
  return { data: result, message: `Queue for AI session \`${sessionId}\` reordered.` };
}

function parseSendMode(value: string): AiSessionSendMode {
  const parsed = AiSessionSendModeSchema.safeParse(value);
  if (!parsed.success) {
    throw new ThctlError("CLI_INVALID_OPTION", `--mode must be one of: ${AiSessionSendModeSchema.options.join(", ")}.`, 2, { option: "mode", value });
  }
  return parsed.data;
}

function parseApprovalDecision(value: string): AiSessionApprovalInput {
  const parsed = AiSessionApprovalInputSchema.safeParse({ decision: value });
  if (!parsed.success) {
    throw new ThctlError("CLI_INVALID_OPTION", `--decision must be one of: allow, deny, skip.`, 2, { option: "decision", value });
  }
  return parsed.data;
}
