import { z } from "zod";

export const AI_SESSION_MAX_MESSAGE_ATTACHMENTS = 6;
export const AI_SESSION_MAX_REFERENCES = 20;
export const AI_SESSION_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES = 40 * 1024 * 1024;
export const AiSessionEventTopic = "ai.sessions";
export const AiSessionEventType = {
  Snapshot: "ai-session.snapshot",
  Patch: "ai-session.patch",
  Removed: "ai-session.removed",
  MessageDelta: "ai-session.message-delta",
  SyncRequired: "ai-session.sync-required",
} as const;
export const AI_SESSION_TOMBSTONE_RETENTION_MS = 60 * 60 * 1000;
export const AI_SESSION_DELTA_RETENTION_MS = AI_SESSION_TOMBSTONE_RETENTION_MS;

export const AiAgentKindSchema = z.string().trim().min(1).max(80);

export const AiSessionLifecycleSchema = z.enum([
  "running",
  "waiting",
  "idle",
  "failed",
]);

export const AiSessionPhaseSchema = z.enum([
  "thinking",
  "tool",
  "editing",
  "approval",
  "responding",
  "unknown",
]);

export const AiSessionToolSchema = z
  .object({
    id: z.string().trim().min(1).max(240).optional(),
    kind: z.string().trim().min(1).max(80).optional(),
    name: z.string().trim().min(1).max(120),
    inputPreview: z.string().trim().max(500).optional(),
    startedAt: z.string().datetime().optional(),
  })
  .strict();

export const AiSessionSubAgentStatusSchema = z.enum([
  "pending-init",
  "running",
  "interrupted",
  "completed",
  "errored",
  "shutdown",
  "not-found",
]);

export const AiSessionSubAgentActivitySchema = z.enum([
  "started",
  "interacted",
  "interrupted",
]);

export const AiSessionSubAgentSchema = z
  .object({
    threadId: z.string().trim().min(1).max(240),
    path: z.string().trim().max(4096).optional(),
    status: AiSessionSubAgentStatusSchema,
    activity: AiSessionSubAgentActivitySchema.optional(),
    message: z.string().trim().max(1000).optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const AiSessionCountersSchema = z
  .object({
    toolCalls: z.number().int().min(0).default(0),
    edits: z.number().int().min(0).default(0),
    approvals: z.number().int().min(0).default(0),
  })
  .strict()
  .default({ toolCalls: 0, edits: 0, approvals: 0 });

export const AiSessionActionsSchema = z
  .object({
    send: z.boolean().optional(),
    interrupt: z.boolean().optional(),
    approval: z.boolean().optional(),
  })
  .strict();

export const AiSessionMessageAttachmentSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    kind: z.enum(["image"]),
    name: z.string().trim().min(1).max(240),
    mime: z.string().trim().min(1).max(120),
    size: z.number().int().min(0).max(AI_SESSION_MAX_ATTACHMENT_BYTES),
    data: z.string().min(1).max(30 * 1024 * 1024),
  })
  .strict();

export const AiSessionMessageAttachmentMetaSchema = AiSessionMessageAttachmentSchema.omit({ data: true });

export const AiSessionMessageAttachmentRefSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    kind: z.enum(["image"]).optional(),
  })
  .strict();

export const AiSessionSendModeSchema = z.enum(["auto", "queue", "steer", "immediate"]);

export const AiSessionCommandNameSchema = z.enum(["review", "rename", "goal", "compact"]);

export const AiSessionCommandInputSchema = z.object({
  command: AiSessionCommandNameSchema,
  argument: z.string().trim().max(4000).optional(),
}).strict().superRefine((input, context) => {
  if (input.command === "rename" && !input.argument) {
    context.addIssue({ code: "custom", path: ["argument"], message: "Rename requires a thread name." });
  }
  if ((input.command === "review" || input.command === "compact") && input.argument) {
    context.addIssue({ code: "custom", path: ["argument"], message: `${input.command} does not accept an argument.` });
  }
});

export const AiSessionCommandResultSchema = z.object({
  command: AiSessionCommandNameSchema,
  value: z.string().max(4000).optional(),
  turnId: z.string().trim().min(1).max(240).optional(),
}).strict();

export const AiSessionReferenceKindSchema = z.enum(["skill", "app", "plugin"]);

const AiSessionReferenceBaseSchema = z.object({
  name: z.string().trim().min(1).max(240),
  path: z.string().trim().min(1).max(4096),
});

export const AiSessionReferenceSchema = z.discriminatedUnion("kind", [
  AiSessionReferenceBaseSchema.extend({
    kind: z.literal("skill"),
    path: z.string().trim().min(1).max(4096).refine((value) => value.startsWith("/"), "Skill paths must be absolute."),
  }).strict(),
  AiSessionReferenceBaseSchema.extend({
    kind: z.literal("app"),
    path: z.string().trim().min(7).max(4096).regex(/^app:\/\/[^\s/]+$/, "App paths must use app://<id>."),
  }).strict(),
  AiSessionReferenceBaseSchema.extend({
    kind: z.literal("plugin"),
    path: z.string().trim().min(10).max(4096).regex(/^plugin:\/\/[^\s/]+$/, "Plugin paths must use plugin://<id>."),
  }).strict(),
]);

export const AiSessionReferencesSchema = z.array(AiSessionReferenceSchema).max(AI_SESSION_MAX_REFERENCES).default([]);

export const AiSessionMentionKindSchema = z.enum(["plugin", "skill", "file", "directory", "app"]);

export const AiSessionMentionCandidateSchema = z.object({
  kind: AiSessionMentionKindSchema,
  name: z.string().trim().min(1).max(240),
  description: z.string().trim().max(1000).optional(),
  path: z.string().trim().min(1).max(4096),
  icon: z.string().trim().max(4096).optional(),
}).strict().superRefine((candidate, context) => {
  if (candidate.kind === "skill" && !candidate.path.startsWith("/")) {
    context.addIssue({ code: "custom", path: ["path"], message: "Skill paths must be absolute." });
  }
  if (candidate.kind === "app" && !/^app:\/\/[^\s/]+$/.test(candidate.path)) {
    context.addIssue({ code: "custom", path: ["path"], message: "App paths must use app://<id>." });
  }
  if (candidate.kind === "plugin" && !/^plugin:\/\/[^\s/]+$/.test(candidate.path)) {
    context.addIssue({ code: "custom", path: ["path"], message: "Plugin paths must use plugin://<id>." });
  }
  if ((candidate.kind === "file" || candidate.kind === "directory") && (candidate.path.startsWith("/") || candidate.path.split(/[\\/]+/).includes(".."))) {
    context.addIssue({ code: "custom", path: ["path"], message: "File and directory paths must be relative to the session cwd." });
  }
});

export const AiSessionMentionDiagnosticSchema = z.object({
  category: z.enum(["skills", "plugins", "apps", "files"]),
  code: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(2000),
}).strict();

export const AiSessionMentionCatalogSchema = z.object({
  sessionId: z.string().trim().min(1).max(120),
  providerSessionId: z.string().trim().min(1).max(240),
  cwd: z.string().trim().min(1).max(4096),
  candidates: z.array(AiSessionMentionCandidateSchema).max(1000).default([]),
  diagnostics: z.array(AiSessionMentionDiagnosticSchema).max(20).default([]),
}).strict();

export const AiSessionMentionFileSearchInputSchema = z.object({
  query: z.string().trim().max(240).default(""),
}).strict();

export const AiSessionMentionFileSearchSchema = z.object({
  sessionId: z.string().trim().min(1).max(120),
  cwd: z.string().trim().min(1).max(4096),
  query: z.string().trim().max(240),
  requestId: z.string().trim().min(1).max(160),
  candidates: z.array(AiSessionMentionCandidateSchema.refine((candidate) => candidate.kind === "file" || candidate.kind === "directory", "File search only returns files and directories.")).max(200).default([]),
  complete: z.boolean().default(false),
}).strict();

const AiSessionMessageBaseSchema = z.object({
  message: z.string().trim().min(1).max(20000),
  mode: AiSessionSendModeSchema.optional(),
});

export const AiSessionMessageInputSchema = AiSessionMessageBaseSchema.extend({
  attachments: z.array(AiSessionMessageAttachmentSchema).max(AI_SESSION_MAX_MESSAGE_ATTACHMENTS).default([]),
  references: AiSessionReferencesSchema,
}).strict().superRefine((message, context) => {
  const totalBytes = message.attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (totalBytes > AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attachments"],
      message: `Images must be ${AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES} bytes or less in total.`,
    });
  }
});

export const AiSessionMessageRefInputSchema = AiSessionMessageBaseSchema.extend({
  attachments: z.array(AiSessionMessageAttachmentRefSchema).max(AI_SESSION_MAX_MESSAGE_ATTACHMENTS).default([]),
  references: AiSessionReferencesSchema,
}).strict();

export const AiSessionApprovalInputSchema = z.object({
  decision: z.enum(["allow", "deny", "skip"]),
}).strict();

export const AiSessionQueueReorderInputSchema = z.object({
  queueIds: z.array(z.string().trim().min(1).max(120)).max(100),
}).strict();

export const AiSessionControlErrorSchema = z.object({
  code: z.string().trim().min(1).max(160),
  message: z.string(),
  instanceId: z.string().trim().min(1).max(160).optional(),
  nodeId: z.string().trim().min(1).max(160).optional(),
  route: z.string().trim().min(1).max(4096).optional(),
}).strict();

export const AiSessionQueuedMessageSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(20000),
    attachments: z.array(AiSessionMessageAttachmentMetaSchema).max(AI_SESSION_MAX_MESSAGE_ATTACHMENTS).default([]),
    references: AiSessionReferencesSchema,
    status: z.enum(["queued", "sending", "failed"]).default("queued"),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    error: z.string().trim().max(4000).optional(),
  })
  .strict();

export const AiSessionQueueSchema = z
  .object({
    pendingCount: z.number().int().min(0).default(0),
    items: z.array(AiSessionQueuedMessageSchema).max(100).default([]),
  })
  .strict()
  .default({ pendingCount: 0, items: [] });

export const AiSessionSourceSchema = z.enum([
  "control",
  "realtime",
  "adapter-snapshot",
  "transcript-tail",
  "transcript-scan",
  "process-scan",
  "app-session",
]);

export const AiSessionContextCompactionSchema = z
  .object({
    id: z.string().trim().min(1).max(240),
    status: z.enum(["running", "completed"]),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();

export const AiSessionTurnSchema = z
  .object({
    id: z.string().trim().min(1).max(240),
    providerTurnId: z.string().trim().max(240).optional(),
    source: AiSessionSourceSchema.optional(),
    userPrompt: z.string().trim().optional(),
    status: z.enum(["queued", "running", "waiting", "completed", "failed"]).default("running"),
    phase: AiSessionPhaseSchema.optional(),
    summary: z.string().trim().max(1000).optional(),
    lastMessage: z.string().trim().optional(),
    lastMessageItemId: z.string().trim().max(240).optional(),
    contextCompactions: z.array(AiSessionContextCompactionSchema).max(20).optional(),
    revision: z.number().int().min(0).default(0),
    sourcePriority: z.number().int().min(0).max(100).optional(),
    snapshotVersion: z.number().int().min(0).optional(),
    observedAt: z.string().datetime().optional(),
    startedAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();

export const AiSessionStatusSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    agent: AiAgentKindSchema,
    appSessionId: z.string().trim().max(120).optional(),
    appId: z.string().trim().max(120).optional(),
    providerSessionId: z.string().trim().max(240).optional(),
    providerMeta: z.record(z.string(), z.unknown()).optional(),
    appBindingKeys: z.array(z.string().trim().min(1).max(240)).max(20).optional(),
    actions: AiSessionActionsSchema.optional(),
    activeTurnId: z.string().trim().max(240).optional(),
    title: z.string().trim().max(240).optional(),
    cwd: z.string().trim().max(4096).optional(),
    userPrompt: z.string().trim().optional(),
    turns: z.array(AiSessionTurnSchema).max(50).optional(),
    status: AiSessionLifecycleSchema.default("running"),
    phase: AiSessionPhaseSchema.default("unknown"),
    summary: z.string().trim().max(1000).optional(),
    lastMessage: z.string().trim().optional(),
    lastMessageItemId: z.string().trim().max(240).optional(),
    currentTool: AiSessionToolSchema.optional(),
    toolCallsSinceLastMessage: z.number().int().min(0).default(0),
    subAgents: z.array(AiSessionSubAgentSchema).max(50).default([]),
    transcriptPath: z.string().trim().max(4096).optional(),
    transcriptSize: z.number().int().min(0).optional(),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    error: z.string().trim().max(4000).optional(),
    counters: AiSessionCountersSchema,
    queue: AiSessionQueueSchema,
  })
  .strict();

export const AiSessionActionResultSchema = z.object({
  session: AiSessionStatusSchema,
  provider: z.string().trim().min(1).max(80),
  action: z.enum(["send", "queue", "steer", "interrupt", "approval"]),
  decision: z.enum(["allow", "deny", "skip"]).optional(),
  turnId: z.string().trim().min(1).max(240).optional(),
  providerTurnId: z.string().trim().min(1).max(240).optional(),
  queueId: z.string().trim().min(1).max(120).optional(),
}).strict();

export const AiSessionSummarySchema = AiSessionStatusSchema.pick({
  id: true,
  agent: true,
  appSessionId: true,
  appId: true,
  providerSessionId: true,
  providerMeta: true,
  appBindingKeys: true,
  actions: true,
  activeTurnId: true,
  title: true,
  cwd: true,
  userPrompt: true,
  turns: true,
  status: true,
  phase: true,
  summary: true,
  lastMessage: true,
  lastMessageItemId: true,
  currentTool: true,
  toolCallsSinceLastMessage: true,
  subAgents: true,
  queue: true,
  startedAt: true,
  updatedAt: true,
  error: true,
});

export const AiSessionsSnapshotSchema = z
  .object({
    runningCount: z.number().int().min(0).default(0),
    waitingCount: z.number().int().min(0).default(0),
    staleCount: z.number().int().min(0).default(0),
    sessions: z.array(AiSessionSummarySchema).default([]),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const AiSessionsStateSchema = z
  .object({
    streamId: z.string().trim().min(1).max(240),
    revision: z.number().int().min(0),
    lastEventAt: z.string().datetime(),
    snapshot: AiSessionsSnapshotSchema,
  })
  .strict();

export const InstanceBoardAiSummarySchema = AiSessionsSnapshotSchema.pick({
  runningCount: true,
  waitingCount: true,
  staleCount: true,
  updatedAt: true,
}).extend({
  idleCount: z.number().int().min(0).default(0),
  problemCount: z.number().int().min(0).default(0),
  revision: z.number().int().min(0).optional(),
});

export function aiSessionsBoardSummary(snapshot: AiSessionsSnapshot, options: { revision?: number } = {}) {
  const idleCount = snapshot.sessions.filter((session) => session.status === "idle").length;
  const problemCount = snapshot.sessions.filter((session) => session.status === "failed").length;
  return InstanceBoardAiSummarySchema.parse({
    runningCount: snapshot.runningCount,
    waitingCount: snapshot.waitingCount,
    staleCount: snapshot.staleCount,
    idleCount,
    problemCount,
    updatedAt: snapshot.updatedAt,
    revision: options.revision,
  });
}

export const AiSessionEventReasonSchema = z.enum([
  "provider-event",
  "app-session-created",
  "app-session-updated",
  "app-session-deleted",
  "discovery-scan",
  "control-action",
  "heartbeat-sync",
  "startup",
]);

export const AiSessionEventMetaSchema = z
  .object({
    streamId: z.string().trim().min(1).max(240),
    instanceId: z.string().trim().min(1).max(160),
    nodeId: z.string().trim().min(1).max(160).optional(),
    revision: z.number().int().min(0),
    previousRevision: z.number().int().min(0).optional(),
    traceId: z.string().trim().min(1).max(160),
    generatedAt: z.string().datetime(),
    reason: AiSessionEventReasonSchema,
  })
  .strict();

export const AiSessionSnapshotEventSchema = z
  .object({
    meta: AiSessionEventMetaSchema,
    snapshot: AiSessionsSnapshotSchema,
  })
  .strict();

export const AiSessionPatchEventSchema = z
  .object({
    meta: AiSessionEventMetaSchema,
    upserted: z.array(AiSessionSummarySchema).default([]),
    removed: z.array(z.string().trim().min(1).max(120)).default([]),
  })
  .strict();

export const AiSessionRemovedEventSchema = z
  .object({
    meta: AiSessionEventMetaSchema,
    sessionIds: z.array(z.string().trim().min(1).max(120)).default([]),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const AiSessionMessageDeltaEventSchema = z
  .object({
    instanceId: z.string().trim().min(1).max(160),
    nodeId: z.string().trim().min(1).max(160).optional(),
    sessionId: z.string().trim().min(1).max(120),
    providerSessionId: z.string().trim().min(1).max(240),
    turnId: z.string().trim().min(1).max(240),
    itemId: z.string().trim().min(1).max(240),
    delta: z.string().min(1),
    generatedAt: z.string().datetime(),
  })
  .strict();

export const AiSessionDeltaResponseSchema = z
  .object({
    streamId: z.string().trim().min(1).max(240),
    instanceId: z.string().trim().min(1).max(160),
    sinceRevision: z.number().int().min(0),
    latestRevision: z.number().int().min(0),
    earliestRetainedRevision: z.number().int().min(0),
    syncRequired: z.boolean().default(false),
    events: z.array(z.discriminatedUnion("type", [
      z.object({ type: z.literal(AiSessionEventType.Snapshot), payload: AiSessionSnapshotEventSchema }).strict(),
      z.object({ type: z.literal(AiSessionEventType.Patch), payload: AiSessionPatchEventSchema }).strict(),
      z.object({ type: z.literal(AiSessionEventType.Removed), payload: AiSessionRemovedEventSchema }).strict(),
    ])).default([]),
  })
  .strict();

export type AiSessionStreamEvent =
  | { type: typeof AiSessionEventType.Snapshot; payload: AiSessionSnapshotEvent }
  | { type: typeof AiSessionEventType.Patch; payload: AiSessionPatchEvent }
  | { type: typeof AiSessionEventType.Removed; payload: AiSessionRemovedEvent };

export type AiSessionStreamApplyResult =
  | { kind: "applied"; projection: AiSessionsState }
  | { kind: "duplicate"; projection: AiSessionsState }
  | { kind: "stale"; projection: AiSessionsState }
  | { kind: "gap"; projection: AiSessionsState; expectedRevision: number; receivedRevision: number }
  | { kind: "snapshot-required"; projection?: AiSessionsState; streamId: string };

export function applyAiSessionStreamEvent(
  current: AiSessionsState | undefined,
  event: AiSessionStreamEvent,
): AiSessionStreamApplyResult {
  const { meta } = event.payload;
  if (event.type === AiSessionEventType.Snapshot) {
    if (current?.streamId === meta.streamId && meta.revision === current.revision) return { kind: "duplicate", projection: current };
    if (current?.streamId === meta.streamId && meta.revision < current.revision) return { kind: "stale", projection: current };
    return {
      kind: "applied",
      projection: AiSessionsStateSchema.parse({ streamId: meta.streamId, revision: meta.revision, lastEventAt: meta.generatedAt, snapshot: event.payload.snapshot }),
    };
  }
  if (!current || current.streamId !== meta.streamId) {
    return { kind: "snapshot-required", projection: current, streamId: meta.streamId };
  }
  if (meta.revision === current.revision) return { kind: "duplicate", projection: current };
  if (meta.revision < current.revision) return { kind: "stale", projection: current };
  if (meta.revision !== current.revision + 1 || meta.previousRevision !== current.revision) {
    return { kind: "gap", projection: current, expectedRevision: current.revision + 1, receivedRevision: meta.revision };
  }
  const sessions = new Map(current.snapshot.sessions.map((session) => [session.id, session]));
  if (event.type === AiSessionEventType.Patch) {
    for (const session of event.payload.upserted) sessions.set(session.id, session);
    for (const sessionId of event.payload.removed) sessions.delete(sessionId);
  } else {
    for (const sessionId of event.payload.sessionIds) sessions.delete(sessionId);
  }
  const values = [...sessions.values()];
  const snapshot = AiSessionsSnapshotSchema.parse({
    runningCount: values.filter((session) => session.status === "running").length,
    waitingCount: values.filter((session) => session.status === "waiting").length,
    staleCount: current.snapshot.staleCount,
    sessions: values,
    updatedAt: meta.generatedAt,
  });
  return {
    kind: "applied",
    projection: AiSessionsStateSchema.parse({ streamId: meta.streamId, revision: meta.revision, lastEventAt: meta.generatedAt, snapshot }),
  };
}

export function emptyAiSessionsSnapshot(now = new Date().toISOString()) {
  return AiSessionsSnapshotSchema.parse({
    runningCount: 0,
    waitingCount: 0,
    staleCount: 0,
    sessions: [],
    updatedAt: now,
  });
}

export const AiSessionInputBaseSchema = z
  .object({
    source: AiSessionSourceSchema,
    sourcePriority: z.number().int().min(0).max(100).optional(),
    observedAt: z.string().datetime().optional(),
    snapshotVersion: z.number().int().min(0).optional(),
  })
  .strict();

export const AiSessionSnapshotInputSchema = AiSessionInputBaseSchema.extend({
  type: z.literal("snapshot"),
  agent: z.string().trim().min(1).max(80),
  appSessionId: z.string().trim().max(120).optional(),
  appId: z.string().trim().max(120).optional(),
  providerSessionId: z.string().trim().max(240).optional(),
  providerMeta: z.record(z.string(), z.unknown()).optional(),
  appBindingKeys: z.array(z.string().trim().min(1).max(240)).max(20).optional(),
  actions: AiSessionActionsSchema.optional(),
  title: z.string().trim().max(240).optional(),
  cwd: z.string().trim().max(4096).optional(),
  activeTurnId: z.string().trim().max(240).optional(),
  userPrompt: z.string().trim().optional(),
  turns: z.array(AiSessionTurnSchema).max(50).optional(),
  status: AiSessionLifecycleSchema.optional(),
  phase: AiSessionPhaseSchema.optional(),
  summary: z.string().trim().max(1000).optional(),
  lastMessage: z.string().trim().optional(),
  lastMessageItemId: z.string().trim().max(240).optional(),
  currentTool: AiSessionToolSchema.optional(),
  toolCallsSinceLastMessage: z.number().int().min(0).optional(),
  subAgents: z.array(AiSessionSubAgentSchema).max(50).optional(),
  transcriptPath: z.string().trim().max(4096).optional(),
  transcriptSize: z.number().int().min(0).optional(),
  replaceActivity: z.boolean().optional(),
}).strict();

export const AiSessionRealtimeInputSchema = AiSessionInputBaseSchema.extend({
  type: z.literal("event"),
  sessionId: z.string().trim().min(1).max(120),
  kind: z.enum(["lifecycle", "send-ack", "turn-started", "user-message", "assistant-message", "approval-requested", "turn-completed", "tool-activity", "sub-agent-activity", "context-compaction"]),
  activeTurnId: z.string().trim().max(240).optional(),
  providerTurnId: z.string().trim().max(240).optional(),
  userPrompt: z.string().trim().optional(),
  text: z.string().optional(),
  itemId: z.string().trim().max(240).optional(),
  status: AiSessionLifecycleSchema.optional(),
  phase: AiSessionPhaseSchema.optional(),
  summary: z.string().trim().max(1000).optional(),
  error: z.string().trim().max(4000).optional(),
  currentTool: AiSessionToolSchema.nullable().optional(),
  toolCallsSinceLastMessage: z.number().int().min(0).optional(),
  subAgents: z.array(AiSessionSubAgentSchema).max(50).optional(),
  contextCompaction: AiSessionContextCompactionSchema.optional(),
  counters: z.object({
    toolCalls: z.number().int().min(0).optional(),
    edits: z.number().int().min(0).optional(),
    approvals: z.number().int().min(0).optional(),
  }).strict().optional(),
}).strict().superRefine((input, context) => {
  if (input.kind === "context-compaction") {
    if (!input.contextCompaction) {
      context.addIssue({ code: "custom", path: ["contextCompaction"], message: "context-compaction events require contextCompaction" });
    }
  } else if (input.contextCompaction !== undefined) {
    context.addIssue({ code: "custom", path: ["contextCompaction"], message: "contextCompaction is only valid for context-compaction events" });
  }
  if (input.kind === "sub-agent-activity") {
    if (!input.subAgents) {
      context.addIssue({ code: "custom", path: ["subAgents"], message: "sub-agent-activity events require subAgents" });
    }
  } else if (input.subAgents !== undefined) {
    context.addIssue({ code: "custom", path: ["subAgents"], message: "subAgents is only valid for sub-agent-activity events" });
  }
  if (input.kind !== "tool-activity") {
    if (input.currentTool !== undefined) {
      context.addIssue({ code: "custom", path: ["currentTool"], message: "currentTool is only valid for tool-activity events" });
    }
    if (input.toolCallsSinceLastMessage !== undefined) {
      context.addIssue({ code: "custom", path: ["toolCallsSinceLastMessage"], message: "toolCallsSinceLastMessage is only valid for tool-activity events" });
    }
    return;
  }
  if (!("currentTool" in input)) {
    context.addIssue({ code: "custom", path: ["currentTool"], message: "tool-activity events require currentTool" });
  }
  if (input.toolCallsSinceLastMessage === undefined) {
    context.addIssue({ code: "custom", path: ["toolCallsSinceLastMessage"], message: "tool-activity events require toolCallsSinceLastMessage" });
  }
});

export const AiSessionReducerInputSchema = z.discriminatedUnion("type", [
  AiSessionSnapshotInputSchema,
  AiSessionRealtimeInputSchema,
]);

export type AiAgentKind = z.infer<typeof AiAgentKindSchema>;
export type AiSessionLifecycle = z.infer<typeof AiSessionLifecycleSchema>;
export type AiSessionPhase = z.infer<typeof AiSessionPhaseSchema>;
export type AiSessionTool = z.infer<typeof AiSessionToolSchema>;
export type AiSessionSubAgentStatus = z.infer<typeof AiSessionSubAgentStatusSchema>;
export type AiSessionSubAgentActivity = z.infer<typeof AiSessionSubAgentActivitySchema>;
export type AiSessionSubAgent = z.infer<typeof AiSessionSubAgentSchema>;
export type AiSessionSource = z.infer<typeof AiSessionSourceSchema>;
export type AiSessionContextCompaction = z.infer<typeof AiSessionContextCompactionSchema>;
export type AiSessionMessageAttachment = z.infer<typeof AiSessionMessageAttachmentSchema>;
export type AiSessionMessageAttachmentMeta = z.infer<typeof AiSessionMessageAttachmentMetaSchema>;
export type AiSessionMessageAttachmentRef = z.infer<typeof AiSessionMessageAttachmentRefSchema>;
export type AiSessionSendMode = z.infer<typeof AiSessionSendModeSchema>;
export type AiSessionCommandName = z.infer<typeof AiSessionCommandNameSchema>;
export type AiSessionCommandInput = z.infer<typeof AiSessionCommandInputSchema>;
export type AiSessionCommandResult = z.infer<typeof AiSessionCommandResultSchema>;
export type AiSessionReferenceKind = z.infer<typeof AiSessionReferenceKindSchema>;
export type AiSessionReference = z.infer<typeof AiSessionReferenceSchema>;
export type AiSessionMentionKind = z.infer<typeof AiSessionMentionKindSchema>;
export type AiSessionMentionCandidate = z.infer<typeof AiSessionMentionCandidateSchema>;
export type AiSessionMentionDiagnostic = z.infer<typeof AiSessionMentionDiagnosticSchema>;
export type AiSessionMentionCatalog = z.infer<typeof AiSessionMentionCatalogSchema>;
export type AiSessionMentionFileSearchInput = z.infer<typeof AiSessionMentionFileSearchInputSchema>;
export type AiSessionMentionFileSearch = z.infer<typeof AiSessionMentionFileSearchSchema>;
export type AiSessionMessageInput = z.infer<typeof AiSessionMessageInputSchema>;
export type AiSessionMessageRefInput = z.infer<typeof AiSessionMessageRefInputSchema>;
export type AiSessionApprovalInput = z.infer<typeof AiSessionApprovalInputSchema>;
export type AiSessionQueueReorderInput = z.infer<typeof AiSessionQueueReorderInputSchema>;
export type AiSessionControlError = z.infer<typeof AiSessionControlErrorSchema>;
export type AiSessionQueuedMessage = z.infer<typeof AiSessionQueuedMessageSchema>;
export type AiSessionQueue = z.infer<typeof AiSessionQueueSchema>;
export type AiSessionTurn = z.infer<typeof AiSessionTurnSchema>;
export type AiSessionStatus = z.infer<typeof AiSessionStatusSchema>;
export type AiSessionActionResult = z.infer<typeof AiSessionActionResultSchema>;
export type AiSessionSummary = z.infer<typeof AiSessionSummarySchema>;
export type AiSessionsSnapshot = z.infer<typeof AiSessionsSnapshotSchema>;
export type AiSessionsState = z.infer<typeof AiSessionsStateSchema>;
export type InstanceBoardAiSummary = z.infer<typeof InstanceBoardAiSummarySchema>;
export type AiSessionEventType = (typeof AiSessionEventType)[keyof typeof AiSessionEventType];
export type AiSessionEventReason = z.infer<typeof AiSessionEventReasonSchema>;
export type AiSessionEventMeta = z.infer<typeof AiSessionEventMetaSchema>;
export type AiSessionSnapshotEvent = z.infer<typeof AiSessionSnapshotEventSchema>;
export type AiSessionPatchEvent = z.infer<typeof AiSessionPatchEventSchema>;
export type AiSessionRemovedEvent = z.infer<typeof AiSessionRemovedEventSchema>;
export type AiSessionMessageDeltaEvent = z.infer<typeof AiSessionMessageDeltaEventSchema>;
export type AiSessionDeltaResponse = z.infer<typeof AiSessionDeltaResponseSchema>;
export type AiSessionSnapshotInput = z.infer<typeof AiSessionSnapshotInputSchema>;
export type AiSessionRealtimeInput = z.infer<typeof AiSessionRealtimeInputSchema>;
export type AiSessionReducerInput = z.infer<typeof AiSessionReducerInputSchema>;
