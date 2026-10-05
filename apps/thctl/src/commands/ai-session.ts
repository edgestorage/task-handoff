import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AI_SESSION_MAX_ATTACHMENT_BYTES,
  AI_SESSION_MAX_MESSAGE_ATTACHMENTS,
  AI_SESSION_MAX_REFERENCES,
  AiSessionApprovalInputSchema,
  AiSessionCommandInputSchema,
  AiSessionForkInputSchema,
  AiSessionMentionKindSchema,
  AiSessionPermissionModeSchema,
  AiSessionReasoningEffortSchema,
  AiSessionReferenceSchema,
  AiSessionSendModeSchema,
  type AiSessionApprovalInput,
  type AiSessionMentionKind,
  type AiSessionPermissionMode,
  type AiSessionReference,
  type AiSessionTimelineItem,
  type AiSessionSendMode,
} from "@task-handoff/protocol/ai-sessions";
import { ThctlError, usageError } from "../errors.ts";
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

const INSTANCE_WORKSPACE_ROUTE = (instanceId: string) =>
  `/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/workspace`;

const WORKSPACE_COLUMNS = [
  { key: "availability", header: "availability" },
  { key: "currentBranch", header: "branch" },
  { key: "dirty", header: "dirty" },
  { key: "repositoryContextId", header: "context" },
];

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
  const modelEntityId = optionString(invocation, "model-entity");
  const modelName = optionString(invocation, "model-name");
  if (Boolean(modelEntityId) !== Boolean(modelName)) {
    throw usageError("CLI_OPTION_MISSING", "Provide both --model-entity and --model-name to select a model.", { command: "ai-session create" });
  }
  const requestedPermission = optionString(invocation, "permission-mode");
  const requestedReasoning = optionString(invocation, "reasoning");
  const input = {
    agent: requireOption(invocation, "agent"),
    message: requireOption(invocation, "prompt"),
    clientRequestId: optionString(invocation, "request-id") ?? randomUUID(),
    attachments: [] as never[],
    references: [] as never[],
    ...(optionString(invocation, "cwd-folder") ? { cwdFolderId: optionString(invocation, "cwd-folder") } : {}),
    ...(optionString(invocation, "story") ? { storyId: optionString(invocation, "story") } : {}),
    ...(requestedPermission ? { permissionMode: parsePermissionMode(requestedPermission) } : {}),
    ...(requestedReasoning ? { reasoningEffort: parseReasoningEffort(requestedReasoning, "reasoning") } : {}),
    ...(modelEntityId && modelName ? { modelSelection: { modelEntityId, modelName } } : {}),
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
  const requestedPermission = optionString(invocation, "permission-mode");
  const permissionMode = requestedPermission ? parsePermissionMode(requestedPermission) : undefined;
  const attachmentIds = repeatableOption(invocation, "attachment");
  if (attachmentIds.length > AI_SESSION_MAX_MESSAGE_ATTACHMENTS) {
    throw usageError("CLI_INVALID_OPTION", `At most ${AI_SESSION_MAX_MESSAGE_ATTACHMENTS} --attachment options are allowed per message.`, { option: "attachment", count: attachmentIds.length });
  }
  const referenceValues = repeatableOption(invocation, "reference");
  if (referenceValues.length > AI_SESSION_MAX_REFERENCES) {
    throw usageError("CLI_INVALID_OPTION", `At most ${AI_SESSION_MAX_REFERENCES} --reference options are allowed per message.`, { option: "reference", count: referenceValues.length });
  }
  const attachments = attachmentIds.map((id) => ({ id, source: { type: "upload-ref" as const } }));
  const references = referenceValues.map(parseReference);
  const body = {
    message,
    ...(mode ? { mode } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(references.length ? { references } : {}),
  };
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

export async function aiSessionStory(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const storyId = optionString(invocation, "story");
  const detach = invocation.options.detach === true;
  if (Boolean(storyId) === detach) {
    throw usageError("CLI_OPTION_MISSING", "Provide exactly one of --story <storyId> or --detach.", { command: "ai-session story" });
  }
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "ai-session story",
    () => ({ method: "PUT", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/story`, body: { storyId: storyId ?? null } }),
    () => connection.client.stories.setSessionStory(instanceId, sessionId, storyId ?? null),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "sessionId", header: "session" },
      { key: "storyId", header: "story" },
    ],
    message: storyId
      ? `AI session \`${sessionId}\` assigned to Story \`${storyId}\`.`
      : `AI session \`${sessionId}\` detached from its Story.`,
  };
}

export async function aiSessionOpenApp(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const clientRequestId = optionString(invocation, "request-id") ?? randomUUID();
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "ai-session open-app",
    () => ({ method: "POST", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/open-app`, body: { clientRequestId } }),
    () => connection.client.aiSessions.openApp(instanceId, sessionId, clientRequestId),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "aiSessionId", header: "session" },
      { key: "disposition", header: "disposition" },
      { key: "appSessionId", header: "app session" },
    ],
    message: `App session \`${result.appSessionId}\` is ${result.disposition} for AI session \`${sessionId}\`.`,
  };
}

export async function aiSessionOpenTerminal(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const appId = optionString(invocation, "app") ?? "terminal-tty";
  const connection = await openConnection(context);
  const read = await connection.client.aiSessions.detail(instanceId, sessionId, undefined, context.signal);
  const cwd = read.kind === "not-modified" ? undefined : read.detail.cwd;
  if (!cwd) {
    throw new ThctlError("CLI_SESSION_WORKSPACE_MISSING", `AI session \`${sessionId}\` has no working directory to open a terminal in.`, 8, { instanceId, sessionId });
  }
  const input = { appId, cwd };
  const result = await performWrite(
    context,
    "ai-session open-terminal",
    () => ({ method: "POST", path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/apps/sessions`, body: { appId, options: { cwd } } }),
    () => connection.client.appSessions.launch(instanceId, input),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "id", header: "app session" },
      { key: "appId", header: "app" },
      { key: "status", header: "status" },
    ],
    message: `Terminal app session \`${result.id}\` started in \`${cwd}\`.`,
  };
}

export async function aiSessionCommand(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const command = requireArgument(invocation, "command");
  const argument = optionString(invocation, "argument");
  const input = parseWithSchema(AiSessionCommandInputSchema, { command, ...(argument ? { argument } : {}) }, "AI session command");
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "ai-session command",
    () => ({ method: "POST", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/commands`, body: input }),
    () => connection.client.aiSessions.executeCommand(instanceId, sessionId, input),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "command", header: "command" },
      { key: "value", header: "value", width: 60 },
    ],
    message: `Command \`${result.command}\` completed for AI session \`${sessionId}\`.`,
  };
}

const MENTION_COLUMNS = [
  { key: "kind", header: "kind" },
  { key: "name", header: "name", width: 30 },
  { key: "path", header: "path", width: 50 },
];

export async function aiSessionMentions(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const requestedKind = optionString(invocation, "kind");
  const kind = requestedKind ? parseMentionKind(requestedKind) : undefined;
  const connection = await openConnection(context);
  const catalog = await connection.client.aiSessions.mentionCatalog(instanceId, sessionId, context.signal);
  const candidates = kind ? catalog.candidates.filter((candidate) => candidate.kind === kind) : catalog.candidates;
  if (context.output.json) return { data: { ...catalog, candidates } };
  const message = candidates.length
    ? (catalog.diagnostics.length ? `${catalog.diagnostics.length} mention diagnostic(s) reported; re-run with --json for details.` : undefined)
    : `No mention candidates${kind ? ` of kind \`${kind}\`` : ""} for session \`${sessionId}\`.`;
  return { data: candidates, columns: MENTION_COLUMNS, message };
}

export async function aiSessionMentionFiles(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const query = invocation.args.query?.trim() ?? "";
  const connection = await openConnection(context);
  const result = await connection.client.aiSessions.searchMentionFiles(instanceId, sessionId, query, context.signal);
  if (context.output.json) return { data: result };
  return {
    data: result.candidates,
    columns: MENTION_COLUMNS,
    message: result.candidates.length ? undefined : `No files matched \`${query}\` in \`${result.cwd}\`.`,
  };
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".csv": "text/csv",
  ".json": "application/json",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".zip": "application/zip",
};

function mimeForFile(file: string) {
  return MIME_BY_EXTENSION[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export async function aiSessionUpload(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const file = path.resolve(requireArgument(invocation, "file"));
  let bytes: Buffer;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("not a regular file");
    if (stat.size === 0) throw new Error("file is empty");
    if (stat.size > AI_SESSION_MAX_ATTACHMENT_BYTES) throw new Error(`file is larger than ${AI_SESSION_MAX_ATTACHMENT_BYTES} bytes`);
    bytes = fs.readFileSync(file);
  } catch (error) {
    throw usageError("CLI_FILE_UNREADABLE", `Cannot read attachment \`${file}\`: ${error instanceof Error ? error.message : String(error)}`, { file });
  }
  const name = optionString(invocation, "name") ?? path.basename(file);
  const mime = optionString(invocation, "mime") ?? mimeForFile(name);
  const kind = mime.startsWith("image/") ? "image" : "file";
  const query = new URLSearchParams({ scopeType: "session", scopeId: sessionId, kind, name, mime, size: String(bytes.byteLength) });
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "ai-session upload",
    () => ({
      method: "POST",
      path: `/api/controlled-instances/${encodeURIComponent(instanceId)}/ai-session-attachments/drafts?${query}`,
      body: { contentType: "application/octet-stream", size: bytes.byteLength },
    }),
    () => connection.client.aiSessions.uploadAttachment({
      instanceId,
      sessionId,
      scopeType: "session",
      kind,
      name,
      mime,
      data: `data:${mime};base64,${bytes.toString("base64")}`,
    }),
  );
  if (!result) return;
  return {
    data: result,
    columns: [
      { key: "id", header: "attachment" },
      { key: "kind", header: "kind" },
      { key: "name", header: "name", width: 30 },
      { key: "size", header: "size" },
      { key: "expiresAt", header: "expires" },
    ],
    message: `Uploaded \`${name}\` (${bytes.byteLength} bytes); send it with --attachment ${result.id}.`,
  };
}

export async function aiSessionAttachment(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const messageId = requireArgument(invocation, "messageId");
  const attachmentId = requireArgument(invocation, "attachmentId");
  const connection = await openConnection(context);
  const download = await connection.client.aiSessions.attachmentContent(instanceId, sessionId, messageId, attachmentId);
  const filename = download.filename ? path.basename(download.filename) : attachmentId;
  const requested = optionString(invocation, "output");
  let target = path.resolve(requested ?? filename);
  if (requested) {
    try {
      if (fs.statSync(target).isDirectory()) target = path.join(target, filename);
    } catch {
      // 目标路径尚不存在时按文件处理。
    }
  }
  try {
    fs.writeFileSync(target, download.body, { mode: 0o644 });
  } catch (error) {
    throw usageError("CLI_FILE_WRITE_FAILED", `Cannot write attachment to \`${target}\`: ${error instanceof Error ? error.message : String(error)}`, { path: target });
  }
  return {
    data: {
      path: target,
      size: download.body.byteLength,
      ...(download.contentType ? { contentType: download.contentType } : {}),
    },
    columns: [
      { key: "path", header: "path", width: 50 },
      { key: "size", header: "size" },
      { key: "contentType", header: "content type" },
    ],
    message: `Saved attachment \`${attachmentId}\` to \`${target}\`.`,
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
  const reasoningEffort = parseReasoningEffort(requireOption(invocation, "effort"));
  const clientRequestId = optionString(invocation, "request-id") ?? randomUUID();
  const connection = await openConnection(context);
  const result = await performWrite(
    context,
    "ai-session reasoning",
    () => ({ method: "PUT", path: `${INSTANCE_SESSION_ROUTE(instanceId, sessionId)}/reasoning-effort`, body: { clientRequestId, reasoningEffort } }),
    () => connection.client.aiSessions.updateReasoningEffort(instanceId, sessionId, clientRequestId, reasoningEffort),
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

function parsePermissionMode(value: string): AiSessionPermissionMode {
  const parsed = AiSessionPermissionModeSchema.safeParse(value);
  if (!parsed.success) {
    throw new ThctlError("CLI_INVALID_OPTION", `--permission-mode must be one of: ${AiSessionPermissionModeSchema.options.join(", ")}.`, 2, { option: "permission-mode", value });
  }
  return parsed.data;
}

function parseMentionKind(value: string): AiSessionMentionKind {
  const parsed = AiSessionMentionKindSchema.safeParse(value);
  if (!parsed.success) {
    throw usageError("CLI_INVALID_OPTION", `--kind must be one of: ${AiSessionMentionKindSchema.options.join(", ")}.`, { option: "kind", value });
  }
  return parsed.data;
}

/**
 * `--reference` 接受绝对 skill 路径或 app:///plugin:// URI：
 * 路径前缀决定 kind，展示名取路径最后一段（服务端只把 name 当展示字段）。
 */
function parseReference(value: string): AiSessionReference {
  const explicit = /^(app|plugin):\/\/[^\s/]+$/.exec(value);
  const candidate = explicit
    ? { kind: explicit[1] as "app" | "plugin", name: value.slice(explicit[1].length + 3), path: value }
    : value.startsWith("/")
      ? { kind: "skill" as const, name: path.basename(value), path: value }
      : undefined;
  if (!candidate) {
    throw usageError("CLI_INVALID_OPTION", "Each --reference must be an absolute skill path or an app:// or plugin:// URI.", { option: "reference", value });
  }
  return parseWithSchema(AiSessionReferenceSchema, candidate, `--reference ${value}`);
}

function parseReasoningEffort(value: string, option = "effort") {
  const parsed = AiSessionReasoningEffortSchema.safeParse(value);
  if (!parsed.success) {
    throw new ThctlError("CLI_INVALID_OPTION", `--${option} must be one of: ${AiSessionReasoningEffortSchema.options.join(", ")}.`, 2, { option, value });
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

export async function aiSessionWorkspace(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const cwdFolderId = optionString(invocation, "cwd-folder");
  const connection = await openConnection(context);
  const workspace = await connection.client.aiSessions.workspace(instanceId, cwdFolderId, context.signal);
  return { data: workspace, columns: WORKSPACE_COLUMNS };
}

export async function aiSessionCheckout(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const branch = requireOption(invocation, "branch");
  const cwdFolderId = optionString(invocation, "cwd-folder");
  const input = { branch, ...(cwdFolderId ? { cwdFolderId } : {}) };
  const connection = await openConnection(context);
  const workspace = await performWrite(
    context,
    "ai-session checkout",
    () => ({ method: "POST", path: `${INSTANCE_WORKSPACE_ROUTE(instanceId)}/checkout`, body: input }),
    () => connection.client.aiSessions.checkoutWorkspaceBranch(instanceId, input),
  );
  if (!workspace) return;
  return {
    data: workspace,
    columns: WORKSPACE_COLUMNS,
    message: `Workspace checked out to \`${branch}\`.`,
  };
}

/** provider 原生转录文件只读读取；表格模式直接输出 tail 文本，--json 保留 path/lineCount/tail。 */
export async function aiSessionTranscript(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const tail = optionalPositiveInteger(optionString(invocation, "tail"), "tail");
  const connection = await openConnection(context);
  const transcript = await connection.client.aiSessions.transcript(instanceId, sessionId, tail, context.signal);
  if (context.output.json) return { data: transcript };
  return {
    data: transcript.tail,
    message: `${transcript.lineCount} line(s) in ${transcript.path}${tail ? `, showing the last ${tail}` : ""}.`,
  };
}

const STORY_DOCUMENT_COLUMNS = [
  { key: "storyPath", header: "path", width: 48 },
  { key: "title", header: "title", width: 32 },
];

export async function aiSessionStoryContent(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const connection = await openConnection(context);
  const content = await connection.client.aiSessions.storyContent(instanceId, sessionId, context.signal);
  if (context.output.json) return { data: content };
  return {
    data: content.documents,
    columns: STORY_DOCUMENT_COLUMNS,
    message: content.documents.length
      ? `Story \`${content.storyId}\` has ${content.documents.length} document(s); read one with \`ai-session story-content read\`.`
      : `Story \`${content.storyId}\` has no documents.`,
  };
}

/** Story 内容只读：文本文档直接输出正文；非 UTF-8 或超限文档由服务端拒绝。 */
export async function aiSessionStoryContentRead(context: CliContext, invocation: CliInvocation) {
  const instanceId = requireArgument(invocation, "instanceId");
  const sessionId = requireArgument(invocation, "sessionId");
  const storyPath = requireOption(invocation, "path");
  const connection = await openConnection(context);
  const preview = await connection.client.aiSessions.storyContentPreview(instanceId, sessionId, storyPath, context.signal);
  if (context.output.json) return { data: preview };
  return {
    data: preview.content,
    message: `${preview.storyPath} at revision ${preview.revision} (${preview.size} bytes).`,
  };
}

function optionalPositiveInteger(value: string | undefined, option: string) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw usageError("CLI_INVALID_OPTION", `--${option} must be a positive integer.`, { option, value });
  }
  return parsed;
}
