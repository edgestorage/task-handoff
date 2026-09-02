import { z } from "zod";
import { StoryIdSchema } from "./story-id.ts";

export const AI_SESSION_MAX_MESSAGE_ATTACHMENTS = 6;
export const AI_SESSION_MAX_REFERENCES = 20;
export const AI_SESSION_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const AI_SESSION_MAX_INLINE_FILE_BYTES = 500 * 1024;
export const AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES = AI_SESSION_MAX_INLINE_FILE_BYTES;
export const AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES = AI_SESSION_MAX_ATTACHMENT_BYTES;
export const AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES = 40 * 1024 * 1024;
export const AI_SESSION_ATTACHMENT_UPLOAD_BODY_LIMIT = AI_SESSION_MAX_ATTACHMENT_BYTES + 1024 * 1024;
export const AI_SESSION_ATTACHMENT_DRAFT_STREAM_CHUNK_BYTES = 256 * 1024;
export const AI_SESSION_ATTACHMENT_DRAFT_STREAM_BODY_LIMIT = 2 * AI_SESSION_ATTACHMENT_DRAFT_STREAM_CHUNK_BYTES;
export const AI_SESSION_ATTACHMENT_DRAFT_STREAM_TTL_MS = 10 * 60 * 1000;
export const AiSessionEventTopic = "ai.sessions";
export const AiSessionEventType = {
  Snapshot: "ai-session.snapshot",
  Patch: "ai-session.patch",
  Removed: "ai-session.removed",
  MessageDelta: "ai-session.message-delta",
  TimelineItem: "ai-session.timeline-item",
  SyncRequired: "ai-session.sync-required",
} as const;
export const AiSessionUnreadEventType = {
  Updated: "ai-session.unread.updated",
} as const;
export const AI_SESSION_TOMBSTONE_RETENTION_MS = 60 * 60 * 1000;
export const AI_SESSION_DELTA_RETENTION_MS = AI_SESSION_TOMBSTONE_RETENTION_MS;

export const AiAgentKindSchema = z.string().trim().min(1).max(80);

export const AiSessionCreationSourceSchema = z.enum(["app-session", "ai-session"]);

export const AiSessionAttachmentKindSchema = z.enum(["image", "file"]);

const AiSessionAttachmentDraftFields = {
  scopeType: z.enum(["session", "create-request"]),
  scopeId: z.string().trim().min(1).max(160),
  kind: AiSessionAttachmentKindSchema,
  name: z.string().trim().min(1).max(240),
  mime: z.string().trim().min(1).max(120),
};

export const AiSessionAttachmentDraftUploadQuerySchema = z.object({
  ...AiSessionAttachmentDraftFields,
  size: z.coerce.number().int().positive().max(AI_SESSION_MAX_ATTACHMENT_BYTES),
}).strict();

export const AiSessionAttachmentDraftStreamIdSchema = z.string().regex(/^cia_[a-f0-9]{24}$/);

export const AiSessionAttachmentDraftStreamCreateInputSchema = z.object({
  attachmentId: AiSessionAttachmentDraftStreamIdSchema,
  ...AiSessionAttachmentDraftFields,
  size: z.number().int().positive().max(AI_SESSION_MAX_ATTACHMENT_BYTES),
}).strict();

export const AiSessionAttachmentDraftStreamOffsetQuerySchema = z.object({
  offset: z.coerce.number().int().nonnegative(),
}).strict();

export const AiSessionAttachmentDraftStreamOffsetSchema = z.object({
  attachmentId: AiSessionAttachmentDraftStreamIdSchema,
  offset: z.number().int().nonnegative(),
});

export const AiSessionAttachmentDraftSchema = z.object({
  id: AiSessionAttachmentDraftStreamIdSchema,
  kind: AiSessionAttachmentKindSchema,
  name: z.string().trim().min(1).max(240),
  mime: z.string().trim().min(1).max(120),
  size: z.number().int().positive().max(AI_SESSION_MAX_ATTACHMENT_BYTES),
  expiresAt: z.string().datetime(),
});

export function isAiSessionInlineImageMime(mime: string) {
  return ["image/bmp", "image/gif", "image/jpeg", "image/png", "image/webp"].includes(mime.split(";", 1)[0]!.trim().toLowerCase());
}

const AiSessionMessageAttachmentBaseSchema = z.object({
  id: z.string().trim().min(1).max(120),
  kind: AiSessionAttachmentKindSchema,
  name: z.string().trim().min(1).max(240),
  mime: z.string().trim().min(1).max(120),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export const AiSessionConversationAttachmentContentStateSchema = z.enum(["available", "expired", "missing"]);

export const AiSessionConversationAttachmentSchema = AiSessionMessageAttachmentBaseSchema.extend({
  contentState: AiSessionConversationAttachmentContentStateSchema.default("available"),
}).strict();

export const AiSessionUserMessageDetailSchema = z.object({
  id: z.string().trim().min(1).max(240),
  text: z.string(),
  attachments: z.array(AiSessionConversationAttachmentSchema).max(AI_SESSION_MAX_MESSAGE_ATTACHMENTS).default([]),
}).strict();

export const AiSessionLifecycleSchema = z.enum([
  "running",
  "waiting",
  "idle",
  "failed",
]);

export const AiSessionUnreadStateSchema = z.object({
  instanceId: z.string().trim().min(1).max(160),
  sessionId: z.string().trim().min(1).max(120),
  unread: z.boolean(),
  sessionUpdatedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

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

export const AiSessionTimelineActivityStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "waiting",
]);

const AiSessionTimelineItemBaseSchema = z.object({
  id: z.string().trim().min(1).max(240),
  turnId: z.string().trim().min(1).max(240),
}).strict();

export const AiSessionTimelineUserMessageSchema = AiSessionTimelineItemBaseSchema.extend({
  type: z.literal("user-message"),
  text: z.string(),
  attachments: z.array(AiSessionConversationAttachmentSchema).max(AI_SESSION_MAX_MESSAGE_ATTACHMENTS).optional(),
}).strict();

export const AiSessionTimelineAgentMessageSchema = AiSessionTimelineItemBaseSchema.extend({
  type: z.literal("ai-message"),
  text: z.string(),
}).strict();

export const AiSessionTimelineActivitySchema = AiSessionTimelineItemBaseSchema.extend({
  type: z.literal("activity"),
  activityKind: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(240),
  status: AiSessionTimelineActivityStatusSchema.optional(),
  summary: z.string().max(4_000).optional(),
  input: z.string().max(100_000).optional(),
  output: z.string().max(1_000_000).optional(),
  paths: z.array(z.string().trim().min(1).max(4096)).max(500).optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative().optional(),
}).strict();

export const AiSessionTimelineItemSchema = z.discriminatedUnion("type", [
  AiSessionTimelineUserMessageSchema,
  AiSessionTimelineAgentMessageSchema,
  AiSessionTimelineActivitySchema,
]);

export const AiSessionTimelineSchema = z.object({
  sessionId: z.string().trim().min(1).max(120),
  providerSessionId: z.string().trim().min(1).max(240),
  items: z.array(AiSessionTimelineItemSchema),
  generatedAt: z.string().datetime(),
}).strict();

export const AiSessionTurnTimelineSchema = z.object({
  sessionId: z.string().trim().min(1).max(120),
  turnId: z.string().trim().min(1).max(240),
  items: z.array(AiSessionTimelineItemSchema),
  generatedAt: z.string().datetime(),
}).strict();

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
    fork: z.boolean().optional(),
    openApp: z.boolean().optional(),
    close: z.boolean().optional(),
  })
  .strict();

export const AiSessionLineageSchema = z.object({
  kind: z.literal("fork"),
  parentProviderSessionId: z.string().trim().min(1).max(240),
  throughTurnId: z.string().trim().min(1).max(240).optional(),
}).strict();

export const AiSessionMessageAttachmentSchema = z.union([
  AiSessionMessageAttachmentBaseSchema.extend({
    // A runtime path is an absolute path in the target controlled instance's
    // filesystem namespace. It is never a browser or node-host path by implication.
    source: z.object({
      type: z.literal("inline"),
      encoding: z.literal("base64"),
      data: z.string().min(1).max(30 * 1024 * 1024),
    }).strict(),
  }).strict().superRefine((attachment, context) => {
    const maxBytes = attachment.kind === "image" ? AI_SESSION_MAX_ATTACHMENT_BYTES : AI_SESSION_MAX_INLINE_FILE_BYTES;
    if (attachment.size <= 0 || (attachment.kind === "file" ? attachment.size >= maxBytes : attachment.size > maxBytes)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["size"], message: `Inline ${attachment.kind} must be between 1 byte and ${maxBytes} bytes.` });
    }
  }),
  AiSessionMessageAttachmentBaseSchema.extend({
    source: z.object({
      type: z.literal("runtime-path"),
      path: z.string().trim().min(1).max(4096),
    }).strict(),
  }).strict(),
]);

export const AiSessionMessageAttachmentMetaSchema = AiSessionMessageAttachmentBaseSchema.extend({
  sourceType: z.enum(["inline", "runtime-path"]),
}).strict();

export const AiSessionMessageAttachmentRefSchema = z.union([
  z.object({
    id: z.string().trim().min(1).max(120),
    kind: AiSessionAttachmentKindSchema.optional(),
    source: z.object({ type: z.literal("upload-ref") }).strict().default({ type: "upload-ref" }),
  }).strict(),
  z.object({
    id: z.string().trim().min(1).max(120),
    kind: AiSessionAttachmentKindSchema,
    name: z.string().trim().min(1).max(240),
    mime: z.string().trim().min(1).max(120),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    // Server-side file pickers resolve their selection to this same instance path form.
    source: z.object({
      type: z.literal("runtime-path"),
      path: z.string().trim().min(1).max(4096),
    }).strict(),
  }).strict(),
]);

export const AiSessionSendModeSchema = z.enum(["auto", "queue", "steer", "immediate"]);

export const AiSessionPermissionModeSchema = z.enum(["ask", "auto-review", "full-access"]);

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
  permissionMode: AiSessionPermissionModeSchema.optional(),
});

export const AiSessionMessageInputSchema = AiSessionMessageBaseSchema.extend({
  attachments: z.array(AiSessionMessageAttachmentSchema).max(AI_SESSION_MAX_MESSAGE_ATTACHMENTS).default([]),
  references: AiSessionReferencesSchema,
}).strict().superRefine((message, context) => {
  const totalBytes = message.attachments.reduce((sum, attachment) => sum + (attachment.source.type === "inline" ? attachment.size : 0), 0);
  if (totalBytes > AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attachments"],
      message: `Inline attachments must be ${AI_SESSION_MAX_MESSAGE_ATTACHMENT_BYTES} bytes or less in total.`,
    });
  }
});

export const AiSessionMessageRefInputSchema = AiSessionMessageBaseSchema.extend({
  attachments: z.array(AiSessionMessageAttachmentRefSchema).max(AI_SESSION_MAX_MESSAGE_ATTACHMENTS).default([]),
  references: AiSessionReferencesSchema,
}).strict();

export const AiSessionRuntimePathSchema = z.object({
  type: z.literal("runtime-path"),
  path: z.string().trim().min(1).max(4096).refine(
    (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value),
    "Runtime paths must be absolute in the target controlled instance.",
  ),
}).strict();

// Public wire identity only. Endpoint, protocol and credentials remain in the
// controlled instance's private model catalog.
export const AiSessionModelSelectionSchema = z.object({
  modelEntityId: z.string().trim().min(1).max(120),
  modelName: z.string().trim().min(1).max(240),
}).strict();

export const AiSessionReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export const AI_SESSION_DEFAULT_REASONING_EFFORT = "medium" as const;

export const AiSessionCreateInputSchema = AiSessionMessageInputSchema.extend({
  agent: AiAgentKindSchema,
  cwd: AiSessionRuntimePathSchema,
  cwdFolderId: z.string().trim().min(1).max(120).optional(),
  clientRequestId: z.string().trim().min(1).max(160),
  modelSelection: AiSessionModelSelectionSchema.optional(),
  reasoningEffort: AiSessionReasoningEffortSchema.optional(),
  storyId: StoryIdSchema.optional(),
}).strict();

export const AiSessionGitSelectionSchema = z.object({
  mode: z.enum(["current-folder", "worktree"]),
  branch: z.string().trim().min(1).max(1024),
}).strict();

export const AiSessionCreateRefInputSchema = AiSessionMessageRefInputSchema.extend({
  agent: AiAgentKindSchema,
  cwdFolderId: z.string().trim().min(1).max(120).optional(),
  gitSelection: AiSessionGitSelectionSchema.optional(),
  clientRequestId: z.string().trim().min(1).max(160),
  modelSelection: AiSessionModelSelectionSchema.optional(),
  reasoningEffort: AiSessionReasoningEffortSchema.optional(),
  storyId: StoryIdSchema.optional(),
}).strict();

export const AiSessionModelSelectionInputSchema = z.object({
  clientRequestId: z.string().trim().min(1).max(160),
  modelSelection: AiSessionModelSelectionSchema,
}).strict();

export const AiSessionModelSelectionActionResponseSchema = z.object({
  sessionId: z.string().trim().min(1).max(120),
  accepted: z.literal(true),
}).strict();

export const AiSessionReasoningEffortInputSchema = z.object({
  clientRequestId: z.string().trim().min(1).max(160),
  reasoningEffort: AiSessionReasoningEffortSchema,
}).strict();

export const AiSessionReasoningEffortActionResponseSchema = z.object({
  sessionId: z.string().trim().min(1).max(120),
  accepted: z.literal(true),
}).strict();

export const AiSessionStoryInputSchema = z.object({
  storyId: StoryIdSchema.nullable(),
}).strict();

export const AiSessionStoryActionResponseSchema = z.object({
  sessionId: z.string().trim().min(1).max(120),
  storyId: StoryIdSchema.optional(),
}).strict();

export const AiSessionCreateResultSchema = z.object({
  disposition: z.enum(["created", "already-created"]),
  aiSessionId: z.string().trim().min(1).max(120),
  providerSessionId: z.string().trim().min(1).max(240),
  creationSource: z.literal("ai-session"),
}).strict();

export const AiSessionForkWorkspaceSchema = z.object({
  mode: z.enum(["current", "managed-worktree"]).default("current"),
}).strict().default({ mode: "current" });

export const AiSessionForkInputSchema = z.object({
  clientRequestId: z.string().trim().min(1).max(160),
  throughTurnId: z.string().trim().min(1).max(240).optional(),
  workspace: AiSessionForkWorkspaceSchema.optional().default({ mode: "current" }),
}).strict();

export const AiSessionForkResultSchema = z.object({
  disposition: z.enum(["created", "already-created"]),
  aiSessionId: z.string().trim().min(1).max(120),
  providerSessionId: z.string().trim().min(1).max(240),
  creationSource: z.literal("ai-session"),
}).strict();

export const AiSessionOpenAppInputSchema = z.object({
  clientRequestId: z.string().trim().min(1).max(160),
}).strict();

export const AiSessionOpenAppResultSchema = z.object({
  disposition: z.enum(["opened", "already-open"]),
  aiSessionId: z.string().trim().min(1).max(120),
  providerSessionId: z.string().trim().min(1).max(240),
  appSessionId: z.string().trim().min(1).max(120),
  creationSource: AiSessionCreationSourceSchema,
}).strict();

export const AiSessionCloseInputSchema = z.object({
  clientRequestId: z.string().trim().min(1).max(160),
}).strict();

export const AiSessionCloseResultSchema = z.object({
  disposition: z.enum(["closed", "already-closed"]),
  aiSessionId: z.string().trim().min(1).max(120),
  providerSessionId: z.string().trim().min(1).max(240),
  creationSource: AiSessionCreationSourceSchema,
}).strict();

export const AiSessionActionErrorSchema = z.object({
  code: z.enum([
    "invalid-request",
    "not-found",
    "unsupported",
    "provider-unavailable",
    "materialization-failed",
    "open-app-failed",
    "close-failed",
    "conflict",
  ]),
  message: z.string().trim().min(1).max(4000),
  retryable: z.boolean().default(false),
  aiSessionId: z.string().trim().min(1).max(120).optional(),
  providerSessionId: z.string().trim().min(1).max(240).optional(),
}).strict();

export const AiSessionApprovalInputSchema = z.object({
  decision: z.enum(["allow", "deny", "skip"]),
}).strict();

export const AiSessionQueueReorderInputSchema = z.object({
  expectedRevision: z.number().int().min(0),
  queueIds: z.array(z.string().trim().min(1).max(120)).max(100),
}).strict();

export const AiSessionQueueEditInputSchema = z.object({
  expectedRevision: z.number().int().min(0),
  message: z.string().trim().min(1).max(20000),
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
    messageId: z.string().trim().min(1).max(240).optional(),
    message: z.string().trim().min(1).max(20000),
    attachments: z.array(AiSessionMessageAttachmentMetaSchema).max(AI_SESSION_MAX_MESSAGE_ATTACHMENTS).default([]),
    references: AiSessionReferencesSchema,
    permissionMode: AiSessionPermissionModeSchema.optional(),
    status: z.enum(["queued", "sending", "failed"]).default("queued"),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    error: z.string().trim().max(4000).optional(),
  })
  .strict();

export const AiSessionQueueSchema = z
  .object({
    revision: z.number().int().min(0).default(0),
    pendingCount: z.number().int().min(0).default(0),
    items: z.array(AiSessionQueuedMessageSchema).max(100).default([]),
  })
  .strict()
  .default({ revision: 0, pendingCount: 0, items: [] });

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
    userMessages: z.array(AiSessionUserMessageDetailSchema).max(100).optional(),
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

export const AiSessionHistoryTurnSchema = AiSessionTurnSchema.pick({
  id: true,
  providerTurnId: true,
  userPrompt: true,
  userMessages: true,
  status: true,
  phase: true,
  summary: true,
  lastMessage: true,
  contextCompactions: true,
  startedAt: true,
  updatedAt: true,
  completedAt: true,
}).strict();

export const AiSessionStatusSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    agent: AiAgentKindSchema,
    creationSource: AiSessionCreationSourceSchema.default("app-session"),
    appSessionId: z.string().trim().max(120).optional(),
    appId: z.string().trim().max(120).optional(),
    providerSessionId: z.string().trim().max(240).optional(),
    lineage: AiSessionLineageSchema.optional(),
    providerMeta: z.record(z.string(), z.unknown()).optional(),
    modelSelection: AiSessionModelSelectionSchema.optional(),
    reasoningEffort: AiSessionReasoningEffortSchema.optional(),
    storyId: StoryIdSchema.optional(),
    appBindingKeys: z.array(z.string().trim().min(1).max(240)).max(20).optional(),
    actions: AiSessionActionsSchema.optional(),
    activeTurnId: z.string().trim().max(240).optional(),
    title: z.string().trim().max(240).optional(),
    cwd: z.string().trim().max(4096).optional(),
    cwdFolderId: z.string().trim().min(1).max(120).optional(),
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

// Current detail metadata intentionally excludes Turn bodies. Compatibility
// for v0.0.23 remains at the client boundary, where a legacy AiSessionStatus
// response can be projected into this model and its Turns seeded into cache.
export const AiSessionDetailSchema = AiSessionStatusSchema.pick({
  id: true,
  appBindingKeys: true,
  cwd: true,
  error: true,
  providerMeta: true,
  modelSelection: true,
  reasoningEffort: true,
  queue: true,
  subAgents: true,
}).strict();

export const AiSessionTurnIndexEntrySchema = AiSessionTurnSchema.pick({
  id: true,
  providerTurnId: true,
  status: true,
  phase: true,
  revision: true,
  startedAt: true,
  updatedAt: true,
  completedAt: true,
}).extend({
  bodyRevision: z.string().trim().min(1).max(64),
}).strict();

export const AiSessionTurnIndexSchema = z.object({
  sessionId: z.string().trim().min(1).max(120),
  revision: z.string().trim().min(1).max(64),
  turns: z.array(AiSessionTurnIndexEntrySchema).max(50),
}).strict();

export const AiSessionTurnBodySchema = z.object({
  sessionId: z.string().trim().min(1).max(120),
  revision: z.string().trim().min(1).max(64),
  turn: AiSessionTurnSchema,
}).strict();

const AiSessionProjectionRevisionSchema = z.string().trim().min(1).max(64);
const AiSessionProjectionNotModifiedSchema = z.object({
  kind: z.literal("not-modified"),
  revision: AiSessionProjectionRevisionSchema,
}).strict();

export const AiSessionDetailReadSchema = z.discriminatedUnion("kind", [
  AiSessionProjectionNotModifiedSchema,
  z.object({
    kind: z.literal("updated"),
    revision: AiSessionProjectionRevisionSchema,
    detail: AiSessionDetailSchema,
  }).strict(),
]);

export const AiSessionTurnIndexReadSchema = z.discriminatedUnion("kind", [
  AiSessionProjectionNotModifiedSchema,
  z.object({
    kind: z.literal("updated"),
    revision: AiSessionProjectionRevisionSchema,
    index: AiSessionTurnIndexSchema,
  }).strict(),
]);

export const AiSessionTurnBodyReadSchema = z.discriminatedUnion("kind", [
  AiSessionProjectionNotModifiedSchema,
  z.object({
    kind: z.literal("updated"),
    revision: AiSessionProjectionRevisionSchema,
    body: AiSessionTurnBodySchema,
  }).strict(),
]);

export const AiSessionActionResultSchema = z.object({
  session: AiSessionStatusSchema,
  provider: z.string().trim().min(1).max(80),
  action: z.enum(["send", "queue", "steer", "interrupt", "approval"]),
  decision: z.enum(["allow", "deny", "skip"]).optional(),
  turnId: z.string().trim().min(1).max(240).optional(),
  providerTurnId: z.string().trim().min(1).max(240).optional(),
  queueId: z.string().trim().min(1).max(120).optional(),
}).strict();

// Public action acknowledgement. The runtime-owned full session remains an
// internal reducer result and must not cross HTTP/reverse-proxy boundaries.
export const AiSessionActionResponseSchema = AiSessionActionResultSchema.omit({ session: true }).extend({
  sessionId: z.string().trim().min(1).max(120),
  messageId: z.string().trim().min(1).max(240).optional(),
}).strict();

export const AiSessionQueueMutationResponseSchema = z.object({
  sessionId: z.string().trim().min(1).max(120),
  queueRevision: z.number().int().min(0),
  action: z.enum(["retry", "remove", "edit", "reorder"]),
  queueId: z.string().trim().min(1).max(120).optional(),
}).strict();

export function projectAiSessionActionResponse(result: z.infer<typeof AiSessionActionResultSchema>) {
  const latestTurn = result.session.turns?.at(-1);
  const queuedMessageId = result.queueId
    ? result.session.queue?.items.find((item) => item.id === result.queueId)?.messageId
    : undefined;
  const messageId = queuedMessageId || (
    result.action === "send" || result.action === "queue" || result.action === "steer"
      ? latestTurn?.userMessages?.at(-1)?.id
      : undefined
  );
  return AiSessionActionResponseSchema.parse({
    sessionId: result.session.id,
    provider: result.provider,
    action: result.action,
    ...(result.decision ? { decision: result.decision } : {}),
    ...(result.turnId || result.session.activeTurnId || latestTurn?.id
      ? { turnId: result.turnId || result.session.activeTurnId || latestTurn?.id }
      : {}),
    ...(result.providerTurnId || latestTurn?.providerTurnId
      ? { providerTurnId: result.providerTurnId || latestTurn?.providerTurnId }
      : {}),
    ...(result.queueId ? { queueId: result.queueId } : {}),
    ...(messageId ? { messageId } : {}),
  });
}

// Compatibility for v0.0.23: normalize the former full-session response at
// the HTTP consumer boundary while current producers send only the ack.
export const AiSessionActionCompatibleResponseSchema = z.union([
  AiSessionActionResponseSchema,
  AiSessionActionResultSchema.transform(projectAiSessionActionResponse),
]);

export const AI_SESSION_HISTORY_DEFAULT_LIMIT = 50;
export const AI_SESSION_HISTORY_MAX_LIMIT = 500;
export const AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS = 30;
export const AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS = 365;
// Compatibility alias for consumers that used the original fixed default.
export const AI_SESSION_HISTORY_LIMIT = AI_SESSION_HISTORY_DEFAULT_LIMIT;

export const AiSessionHistoryItemSchema = z.object({
  id: z.string().trim().min(1).max(120),
  agent: AiAgentKindSchema,
  creationSource: AiSessionCreationSourceSchema,
  providerSessionId: z.string().trim().min(1).max(240),
  lineage: AiSessionLineageSchema.optional(),
  modelSelection: AiSessionModelSelectionSchema.optional(),
  reasoningEffort: AiSessionReasoningEffortSchema.optional(),
  storyId: StoryIdSchema.optional(),
  title: z.string().trim().max(240).optional(),
  userPrompt: z.string().trim().optional(),
  lastMessage: z.string().trim().optional(),
  cwd: z.string().trim().min(1).max(4096),
  cwdFolderId: z.string().trim().min(1).max(120).optional(),
  lastActiveAt: z.string().datetime(),
  archivedAt: z.string().datetime(),
}).strict();

export const AiSessionHistoryIndexSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  items: z.array(AiSessionHistoryItemSchema).max(AI_SESSION_HISTORY_MAX_LIMIT).default([]),
}).strict();

export const AiSessionHistoryListSchema = z.object({
  items: z.array(AiSessionHistoryItemSchema).max(AI_SESSION_HISTORY_MAX_LIMIT).default([]),
}).strict();

export const AiSessionHistoryDetailSchema = z.object({
  item: AiSessionHistoryItemSchema,
  turns: z.array(AiSessionHistoryTurnSchema).max(50).default([]),
}).strict();

export const AiSessionResumeResultSchema = z.object({
  disposition: z.enum(["resumed", "already-open"]),
  aiSessionId: z.string().trim().min(1).max(120),
  providerSessionId: z.string().trim().min(1).max(240),
  appSessionId: z.string().trim().min(1).max(120).optional(),
  creationSource: AiSessionCreationSourceSchema,
}).strict();

export const AiSessionSummaryTurnSchema = AiSessionTurnSchema.omit({ userMessages: true });

export const AiSessionSummarySchema = AiSessionStatusSchema.pick({
  id: true,
  agent: true,
  creationSource: true,
  appSessionId: true,
  appId: true,
  providerSessionId: true,
  lineage: true,
  providerMeta: true,
  modelSelection: true,
  reasoningEffort: true,
  storyId: true,
  appBindingKeys: true,
  actions: true,
  activeTurnId: true,
  title: true,
  cwd: true,
  cwdFolderId: true,
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
}).extend({
  // Compatibility for v0.0.21: list snapshots retain the bounded turn summary
  // shape when reading an older producer. Current producers omit turns and use
  // the bounded count/timestamp projection below.
  turns: z.array(AiSessionSummaryTurnSchema).max(50).optional(),
  // Version of the fields intentionally omitted or compacted by the list
  // projection. Detail consumers bind an HTTP response to this value instead
  // of treating updatedAt as a reason to reload the complete conversation.
  // Compatibility for v0.0.23: older producers omit it and consumers retain
  // the list projection as authoritative while only enriching Turn metadata.
  detailRevision: z.string().trim().min(1).max(64).optional(),
  // Independent version for the Turn index/body domain. It is not a display
  // key and must not remount or fade the owning session.
  turnsRevision: z.string().trim().min(1).max(64).optional(),
  // Minimal pointer used to refresh the live Turn body without reloading the
  // complete Turn index. The index revision only describes list structure.
  latestTurnRef: z.object({
    id: AiSessionTurnSchema.shape.id,
    bodyRevision: z.string().trim().min(1).max(64),
  }).strict().optional(),
  turnCount: z.number().int().min(0).optional(),
  subAgentCount: z.number().int().min(0).optional(),
  lastUserMessageAt: z.string().datetime().optional(),
}).strict();

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
    // Compatibility for v0.0.23: compact delta producers omit the provider
    // identity after resolving the authoritative AI Session id.
    providerSessionId: z.string().trim().min(1).max(240).optional(),
    turnId: z.string().trim().min(1).max(240),
    itemId: z.string().trim().min(1).max(240),
    delta: z.string().min(1),
    generatedAt: z.string().datetime(),
  })
  .strict();

export const AiSessionMessageDeltaCompactEventSchema = AiSessionMessageDeltaEventSchema
  .omit({ instanceId: true, nodeId: true, providerSessionId: true })
  .strict();

export function compactAiSessionMessageDeltaEvent(input: AiSessionMessageDeltaEvent) {
  return AiSessionMessageDeltaCompactEventSchema.parse({
    sessionId: input.sessionId,
    turnId: input.turnId,
    itemId: input.itemId,
    delta: input.delta,
    generatedAt: input.generatedAt,
  });
}

export function normalizeAiSessionMessageDeltaEvent(input: unknown, instanceId: string) {
  const compact = AiSessionMessageDeltaCompactEventSchema.safeParse(input);
  if (compact.success) {
    return AiSessionMessageDeltaEventSchema.parse({ instanceId, ...compact.data });
  }
  return AiSessionMessageDeltaEventSchema.parse(input);
}

export const AiSessionTimelineItemEventSchema = z.object({
  instanceId: z.string().trim().min(1).max(160),
  nodeId: z.string().trim().min(1).max(160).optional(),
  sessionId: z.string().trim().min(1).max(120),
  providerSessionId: z.string().trim().min(1).max(240),
  item: AiSessionTimelineItemSchema,
  generatedAt: z.string().datetime(),
}).strict();

// Compatibility for v0.0.21: keep this additive live event outside the retained
// revision delta union so older control-plane UIs can ignore it and continue syncing.

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
  creationSource: AiSessionCreationSourceSchema.optional(),
  appSessionId: z.string().trim().max(120).optional(),
  appId: z.string().trim().max(120).optional(),
  providerSessionId: z.string().trim().max(240).optional(),
  lineage: AiSessionLineageSchema.optional(),
  providerMeta: z.record(z.string(), z.unknown()).optional(),
  modelSelection: AiSessionModelSelectionSchema.optional(),
  reasoningEffort: AiSessionReasoningEffortSchema.optional(),
  storyId: StoryIdSchema.optional(),
  appBindingKeys: z.array(z.string().trim().min(1).max(240)).max(20).optional(),
  actions: AiSessionActionsSchema.optional(),
  title: z.string().trim().max(240).optional(),
  cwd: z.string().trim().max(4096).optional(),
  cwdFolderId: z.string().trim().min(1).max(120).optional(),
  activeTurnId: z.string().trim().max(240).optional(),
  userPrompt: z.string().trim().optional(),
  turns: z.array(AiSessionTurnSchema).max(50).optional(),
  status: AiSessionLifecycleSchema.optional(),
  phase: AiSessionPhaseSchema.optional(),
  summary: z.string().trim().max(1000).optional(),
  lastMessage: z.string().trim().optional(),
  lastMessageItemId: z.string().trim().max(240).optional(),
  error: z.string().trim().max(4000).optional(),
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
  kind: z.enum(["lifecycle", "send-ack", "turn-started", "user-message", "assistant-message", "approval-requested", "turn-completed", "session-error", "tool-activity", "sub-agent-activity", "context-compaction", "model-selection", "reasoning-effort"]),
  modelSelection: AiSessionModelSelectionSchema.optional(),
  reasoningEffort: AiSessionReasoningEffortSchema.optional(),
  activeTurnId: z.string().trim().max(240).optional(),
  providerTurnId: z.string().trim().max(240).optional(),
  userPrompt: z.string().trim().optional(),
  userMessage: AiSessionUserMessageDetailSchema.optional(),
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
  if (input.kind === "model-selection") {
    if (!input.modelSelection) {
      context.addIssue({ code: "custom", path: ["modelSelection"], message: "model-selection events require modelSelection" });
    }
  } else if (input.modelSelection !== undefined) {
    context.addIssue({ code: "custom", path: ["modelSelection"], message: "modelSelection is only valid for model-selection events" });
  }
  if (input.kind === "reasoning-effort") {
    if (!input.reasoningEffort) {
      context.addIssue({ code: "custom", path: ["reasoningEffort"], message: "reasoning-effort events require reasoningEffort" });
    }
  } else if (input.reasoningEffort !== undefined) {
    context.addIssue({ code: "custom", path: ["reasoningEffort"], message: "reasoningEffort is only valid for reasoning-effort events" });
  }
  if (input.kind === "session-error" && !input.error) {
    context.addIssue({ code: "custom", path: ["error"], message: "session-error events require error" });
  }
  if (input.kind === "context-compaction") {
    if (!input.contextCompaction) {
      context.addIssue({ code: "custom", path: ["contextCompaction"], message: "context-compaction events require contextCompaction" });
    }
  } else if (input.contextCompaction !== undefined) {
    context.addIssue({ code: "custom", path: ["contextCompaction"], message: "contextCompaction is only valid for context-compaction events" });
  }
  if (input.kind !== "send-ack" && input.kind !== "user-message" && input.userMessage !== undefined) {
    context.addIssue({ code: "custom", path: ["userMessage"], message: "userMessage is only valid for send-ack and user-message events" });
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
export type AiSessionCreationSource = z.infer<typeof AiSessionCreationSourceSchema>;
export type AiSessionLifecycle = z.infer<typeof AiSessionLifecycleSchema>;
export type AiSessionUnreadState = z.infer<typeof AiSessionUnreadStateSchema>;
export type AiSessionPhase = z.infer<typeof AiSessionPhaseSchema>;
export type AiSessionTool = z.infer<typeof AiSessionToolSchema>;
export type AiSessionTimelineActivityStatus = z.infer<typeof AiSessionTimelineActivityStatusSchema>;
export type AiSessionTimelineUserMessage = z.infer<typeof AiSessionTimelineUserMessageSchema>;
export type AiSessionTimelineAgentMessage = z.infer<typeof AiSessionTimelineAgentMessageSchema>;
export type AiSessionTimelineActivity = z.infer<typeof AiSessionTimelineActivitySchema>;
export type AiSessionTimelineItem = z.infer<typeof AiSessionTimelineItemSchema>;
export type AiSessionTimeline = z.infer<typeof AiSessionTimelineSchema>;
export type AiSessionTurnTimeline = z.infer<typeof AiSessionTurnTimelineSchema>;
export type AiSessionSubAgentStatus = z.infer<typeof AiSessionSubAgentStatusSchema>;
export type AiSessionSubAgentActivity = z.infer<typeof AiSessionSubAgentActivitySchema>;
export type AiSessionSubAgent = z.infer<typeof AiSessionSubAgentSchema>;
export type AiSessionSource = z.infer<typeof AiSessionSourceSchema>;
export type AiSessionContextCompaction = z.infer<typeof AiSessionContextCompactionSchema>;
export type AiSessionConversationAttachmentContentState = z.infer<typeof AiSessionConversationAttachmentContentStateSchema>;
export type AiSessionConversationAttachment = z.infer<typeof AiSessionConversationAttachmentSchema>;
export type AiSessionUserMessageDetail = z.infer<typeof AiSessionUserMessageDetailSchema>;
export type AiSessionMessageAttachment = z.infer<typeof AiSessionMessageAttachmentSchema>;
export type AiSessionAttachmentDraftUploadQuery = z.infer<typeof AiSessionAttachmentDraftUploadQuerySchema>;
export type AiSessionAttachmentDraftStreamCreateInput = z.infer<typeof AiSessionAttachmentDraftStreamCreateInputSchema>;
export type AiSessionAttachmentDraft = z.infer<typeof AiSessionAttachmentDraftSchema>;
export type AiSessionMessageAttachmentMeta = z.infer<typeof AiSessionMessageAttachmentMetaSchema>;
export type AiSessionMessageAttachmentRef = z.infer<typeof AiSessionMessageAttachmentRefSchema>;
export type AiSessionSendMode = z.infer<typeof AiSessionSendModeSchema>;
export type AiSessionPermissionMode = z.infer<typeof AiSessionPermissionModeSchema>;
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
export type AiSessionRuntimePath = z.infer<typeof AiSessionRuntimePathSchema>;
export type AiSessionModelSelection = z.infer<typeof AiSessionModelSelectionSchema>;
export type AiSessionReasoningEffort = z.infer<typeof AiSessionReasoningEffortSchema>;
export type AiSessionCreateInput = z.infer<typeof AiSessionCreateInputSchema>;
export type AiSessionCreateRefInput = z.infer<typeof AiSessionCreateRefInputSchema>;
export type AiSessionModelSelectionInput = z.infer<typeof AiSessionModelSelectionInputSchema>;
export type AiSessionModelSelectionActionResponse = z.infer<typeof AiSessionModelSelectionActionResponseSchema>;
export type AiSessionReasoningEffortInput = z.infer<typeof AiSessionReasoningEffortInputSchema>;
export type AiSessionReasoningEffortActionResponse = z.infer<typeof AiSessionReasoningEffortActionResponseSchema>;
export type AiSessionGitSelection = z.infer<typeof AiSessionGitSelectionSchema>;
export type AiSessionCreateResult = z.infer<typeof AiSessionCreateResultSchema>;
export type AiSessionForkWorkspace = z.infer<typeof AiSessionForkWorkspaceSchema>;
export type AiSessionForkInput = z.infer<typeof AiSessionForkInputSchema>;
export type AiSessionForkResult = z.infer<typeof AiSessionForkResultSchema>;
export type AiSessionLineage = z.infer<typeof AiSessionLineageSchema>;
export type AiSessionOpenAppInput = z.infer<typeof AiSessionOpenAppInputSchema>;
export type AiSessionOpenAppResult = z.infer<typeof AiSessionOpenAppResultSchema>;
export type AiSessionCloseInput = z.infer<typeof AiSessionCloseInputSchema>;
export type AiSessionCloseResult = z.infer<typeof AiSessionCloseResultSchema>;
export type AiSessionActionError = z.infer<typeof AiSessionActionErrorSchema>;
export type AiSessionApprovalInput = z.infer<typeof AiSessionApprovalInputSchema>;
export type AiSessionQueueEditInput = z.infer<typeof AiSessionQueueEditInputSchema>;
export type AiSessionQueueReorderInput = z.infer<typeof AiSessionQueueReorderInputSchema>;
export type AiSessionControlError = z.infer<typeof AiSessionControlErrorSchema>;
export type AiSessionQueuedMessage = z.infer<typeof AiSessionQueuedMessageSchema>;
export type AiSessionQueue = z.infer<typeof AiSessionQueueSchema>;
export type AiSessionTurn = z.infer<typeof AiSessionTurnSchema>;
export type AiSessionDetail = z.infer<typeof AiSessionDetailSchema>;
export type AiSessionTurnIndexEntry = z.infer<typeof AiSessionTurnIndexEntrySchema>;
export type AiSessionTurnIndex = z.infer<typeof AiSessionTurnIndexSchema>;
export type AiSessionTurnBody = z.infer<typeof AiSessionTurnBodySchema>;
export type AiSessionDetailRead = z.infer<typeof AiSessionDetailReadSchema>;
export type AiSessionTurnIndexRead = z.infer<typeof AiSessionTurnIndexReadSchema>;
export type AiSessionTurnBodyRead = z.infer<typeof AiSessionTurnBodyReadSchema>;
export type AiSessionSummaryTurn = z.infer<typeof AiSessionSummaryTurnSchema>;
export type AiSessionStatus = z.infer<typeof AiSessionStatusSchema>;
export type AiSessionActionResult = z.infer<typeof AiSessionActionResultSchema>;
export type AiSessionActionResponse = z.infer<typeof AiSessionActionResponseSchema>;
export type AiSessionQueueMutationResponse = z.infer<typeof AiSessionQueueMutationResponseSchema>;
export type AiSessionHistoryItem = z.infer<typeof AiSessionHistoryItemSchema>;
export type AiSessionHistoryIndex = z.infer<typeof AiSessionHistoryIndexSchema>;
export type AiSessionHistoryList = z.infer<typeof AiSessionHistoryListSchema>;
export type AiSessionHistoryTurn = z.infer<typeof AiSessionHistoryTurnSchema>;
export type AiSessionHistoryDetail = z.infer<typeof AiSessionHistoryDetailSchema>;
export type AiSessionResumeResult = z.infer<typeof AiSessionResumeResultSchema>;
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
export type AiSessionMessageDeltaCompactEvent = z.infer<typeof AiSessionMessageDeltaCompactEventSchema>;
export type AiSessionTimelineItemEvent = z.infer<typeof AiSessionTimelineItemEventSchema>;
export type AiSessionDeltaResponse = z.infer<typeof AiSessionDeltaResponseSchema>;
export type AiSessionSnapshotInput = z.infer<typeof AiSessionSnapshotInputSchema>;
export type AiSessionRealtimeInput = z.infer<typeof AiSessionRealtimeInputSchema>;
export type AiSessionReducerInput = z.infer<typeof AiSessionReducerInputSchema>;

/** Merge a partial live item stream into a snapshot while preserving both streams' order constraints. */
export function mergeAiSessionTimelineItems(
  snapshot: readonly AiSessionTimelineItem[],
  liveItems: readonly AiSessionTimelineItem[],
): AiSessionTimelineItem[] {
  if (!liveItems.length) return [...snapshot];
  const liveById = new Map<string, AiSessionTimelineItem>();
  for (const item of liveItems) liveById.set(item.id, item);
  const snapshotIds = new Set(snapshot.map((item) => item.id));
  const insertBefore = new Map<string, AiSessionTimelineItem[]>();
  let pending: AiSessionTimelineItem[] = [];
  for (const item of liveById.values()) {
    if (!snapshotIds.has(item.id)) {
      pending.push(item);
      continue;
    }
    if (pending.length) insertBefore.set(item.id, pending);
    pending = [];
  }
  const merged: AiSessionTimelineItem[] = [];
  for (const item of snapshot) {
    merged.push(...(insertBefore.get(item.id) || []));
    merged.push(liveById.get(item.id) || item);
  }
  merged.push(...pending);
  return merged;
}
