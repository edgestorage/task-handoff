import { randomUUID } from "node:crypto";
import {
  AiSessionApprovalInputSchema,
  AiSessionSendModeSchema,
  type AiSessionApprovalInput,
  type AiSessionSendMode,
} from "@task-handoff/protocol/ai-sessions";
import { ThctlError } from "../errors.ts";
import { openConnection, performWrite, type CliContext, type CliInvocation } from "../runtime.ts";
import {
  optionString,
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

async function findSessionUpdatedAt(context: CliContext, instanceId: string, sessionId: string) {
  const connection = await openConnection(context);
  const view = await connection.client.aiSessions.list(context.signal, instanceId);
  const session = view.instances
    .filter((entry) => entry.instanceId === instanceId)
    .flatMap((entry) => entry.aiSessions.sessions)
    .find((candidate) => candidate.id === sessionId);
  if (!session) {
    throw new ThctlError("CLI_SESSION_NOT_FOUND", `No AI session \`${sessionId}\` is visible on instance \`${instanceId}\`.`, 7, { instanceId, sessionId });
  }
  return { connection, session };
}

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
  const { connection, session } = await findSessionUpdatedAt(context, instanceId, sessionId);
  const result = await performWrite(
    context,
    "ai-session read",
    () => ({ method: "POST", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/read`, body: { sessionUpdatedAt: session.updatedAt } }),
    () => connection.client.aiSessions.markRead(instanceId, sessionId, session.updatedAt),
  );
  if (!result) return;
  return { data: result, message: `AI session \`${sessionId}\` marked as read.` };
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
