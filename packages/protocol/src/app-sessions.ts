import { z } from "zod";

export const AppSessionEventTopic = "app.sessions";
export const AppSessionEventType = {
  Snapshot: "app-session.snapshot",
  Patch: "app-session.patch",
  Removed: "app-session.removed",
  SyncRequired: "app-session.sync-required",
} as const;
export const APP_SESSION_TOMBSTONE_RETENTION_MS = 60 * 60 * 1000;
export const APP_SESSION_DELTA_RETENTION_MS = APP_SESSION_TOMBSTONE_RETENTION_MS;

export const AppSessionStatusSchema = z.enum([
  "created",
  "starting",
  "running",
  "stopping",
  "stopped",
  "exited",
  "failed",
  "closed",
  "terminated",
  "unknown",
]);

export const AppSessionAccessModeSchema = z.enum(["tty", "vnc", "web"]);

export const AppSessionAccessLeaseSchema = z
  .object({
    mode: AppSessionAccessModeSchema,
    url: z.string().trim().min(1).max(4096),
    token: z.string().trim().min(1).max(512),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const AppSessionAccessRevocationSchema = z
  .object({ revoked: z.boolean() })
  .strict();

const HIDDEN_APP_SESSION_STATUSES = new Set<AppSessionStatus>(["stopped", "failed", "exited", "closed", "terminated"]);

export const AppSessionBindingSchema = z
  .object({
    type: z.enum(["app-session", "provider-session", "adapter-key"]),
    id: z.string().trim().min(1).max(240),
    agent: z.string().trim().min(1).max(80).optional(),
    adapter: z.string().trim().min(1).max(80).optional(),
    key: z.string().trim().min(1).max(240).optional(),
  })
  .strict();

export const AppSessionRecordSchema = z.record(z.string(), z.unknown()).and(z.object({
  id: z.string().trim().min(1).max(160),
  appId: z.string().trim().min(1).max(160).optional(),
  title: z.string().trim().max(240).optional(),
  kind: z.string().trim().max(80).optional(),
  status: AppSessionStatusSchema.default("unknown"),
  bindings: z.array(AppSessionBindingSchema).max(40).default([]),
  workspace: z
    .object({
      cwd: z.string().trim().max(4096).optional(),
    })
    .strict()
    .optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
}));

export const AppSessionsSnapshotSchema = z
  .object({
    runningCount: z.number().int().min(0).default(0),
    problemCount: z.number().int().min(0).default(0),
    sessions: z.array(AppSessionRecordSchema).default([]),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const AppSessionsStateSchema = z
  .object({
    streamId: z.string().trim().min(1).max(240),
    revision: z.number().int().min(0),
    lastEventAt: z.string().datetime(),
    snapshot: AppSessionsSnapshotSchema,
  })
  .strict();

export const InstanceBoardAppSummarySchema = AppSessionsSnapshotSchema.pick({
  runningCount: true,
  problemCount: true,
  updatedAt: true,
}).extend({
  revision: z.number().int().min(0).optional(),
});

export function appSessionsBoardSummary(snapshot: AppSessionsSnapshot, options: { revision?: number } = {}) {
  return InstanceBoardAppSummarySchema.parse({
    runningCount: snapshot.runningCount,
    problemCount: snapshot.problemCount,
    updatedAt: snapshot.updatedAt,
    revision: options.revision,
  });
}

export const AppSessionEventReasonSchema = z.enum([
  "app-session-created",
  "app-session-updated",
  "app-session-deleted",
  "app-session-recovered",
  "control-action",
  "heartbeat-sync",
  "startup",
]);

export const AppSessionEventMetaSchema = z
  .object({
    streamId: z.string().trim().min(1).max(240),
    instanceId: z.string().trim().min(1).max(160),
    nodeId: z.string().trim().min(1).max(160).optional(),
    revision: z.number().int().min(0),
    previousRevision: z.number().int().min(0).optional(),
    traceId: z.string().trim().min(1).max(160),
    generatedAt: z.string().datetime(),
    reason: AppSessionEventReasonSchema,
  })
  .strict();

export const AppSessionSnapshotEventSchema = z
  .object({
    meta: AppSessionEventMetaSchema,
    snapshot: AppSessionsSnapshotSchema,
  })
  .strict();

export const AppSessionPatchEventSchema = z
  .object({
    meta: AppSessionEventMetaSchema,
    session: AppSessionRecordSchema,
  })
  .strict();

export const AppSessionRemovedEventSchema = z
  .object({
    meta: AppSessionEventMetaSchema,
    sessionId: z.string().trim().min(1).max(160),
    tombstone: AppSessionRecordSchema.optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

export const AppSessionDeltaResponseSchema = z
  .object({
    streamId: z.string().trim().min(1).max(240),
    instanceId: z.string().trim().min(1).max(160),
    sinceRevision: z.number().int().min(0),
    latestRevision: z.number().int().min(0),
    earliestRetainedRevision: z.number().int().min(0),
    syncRequired: z.boolean().default(false),
    events: z.array(z.discriminatedUnion("type", [
      z.object({ type: z.literal(AppSessionEventType.Snapshot), payload: AppSessionSnapshotEventSchema }).strict(),
      z.object({ type: z.literal(AppSessionEventType.Patch), payload: AppSessionPatchEventSchema }).strict(),
      z.object({ type: z.literal(AppSessionEventType.Removed), payload: AppSessionRemovedEventSchema }).strict(),
    ])).default([]),
  })
  .strict();

export type AppSessionStreamEvent =
  | { type: typeof AppSessionEventType.Snapshot; payload: AppSessionSnapshotEvent }
  | { type: typeof AppSessionEventType.Patch; payload: AppSessionPatchEvent }
  | { type: typeof AppSessionEventType.Removed; payload: AppSessionRemovedEvent };

export type AppSessionStreamApplyResult =
  | { kind: "applied"; projection: AppSessionsState }
  | { kind: "duplicate"; projection: AppSessionsState }
  | { kind: "stale"; projection: AppSessionsState }
  | { kind: "gap"; projection: AppSessionsState; expectedRevision: number; receivedRevision: number }
  | { kind: "snapshot-required"; projection?: AppSessionsState; streamId: string };

export function applyAppSessionStreamEvent(
  current: AppSessionsState | undefined,
  event: AppSessionStreamEvent,
): AppSessionStreamApplyResult {
  const { meta } = event.payload;
  if (event.type === AppSessionEventType.Snapshot) {
    if (current?.streamId === meta.streamId && meta.revision === current.revision) return { kind: "duplicate", projection: current };
    if (current?.streamId === meta.streamId && meta.revision < current.revision) return { kind: "stale", projection: current };
    return {
      kind: "applied",
      projection: AppSessionsStateSchema.parse({
        streamId: meta.streamId,
        revision: meta.revision,
        lastEventAt: meta.generatedAt,
        snapshot: activeAppSessionsSnapshotFromRecords(event.payload.snapshot.sessions, event.payload.snapshot.updatedAt),
      }),
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
  const sessions = [...current.snapshot.sessions];
  if (event.type === AppSessionEventType.Patch) {
    const index = sessions.findIndex((session) => session.id === event.payload.session.id);
    if (!isVisibleAppSessionStatus(event.payload.session.status)) {
      if (index >= 0) sessions.splice(index, 1);
    } else if (index < 0) sessions.push(event.payload.session);
    else sessions[index] = event.payload.session;
  } else {
    const index = sessions.findIndex((session) => session.id === event.payload.sessionId);
    if (index >= 0) sessions.splice(index, 1);
  }
  const snapshot = appSessionsSnapshotFromRecords(sessions, meta.generatedAt);
  return {
    kind: "applied",
    projection: AppSessionsStateSchema.parse({ streamId: meta.streamId, revision: meta.revision, lastEventAt: meta.generatedAt, snapshot }),
  };
}

export function appSessionsSnapshotFromRecords(sessions: Array<Record<string, unknown>>, now = new Date().toISOString()) {
  const parsedSessions = sessions.map((session) => normalizeAppSessionRecord(session));
  return AppSessionsSnapshotSchema.parse({
    runningCount: parsedSessions.filter((session) => session.status === "running").length,
    problemCount: parsedSessions.filter((session) => session.status === "failed").length,
    sessions: parsedSessions,
    updatedAt: now,
  });
}

export function activeAppSessionsSnapshotFromRecords(sessions: Array<Record<string, unknown>>, now = new Date().toISOString()) {
  return appSessionsSnapshotFromRecords(
    sessions.filter((session) => isVisibleAppSessionStatus(typeof session.status === "string" ? session.status : undefined)),
    now,
  );
}

export function normalizeAppSessionRecord(session: Record<string, unknown>) {
  const status = normalizeAppSessionStatus(typeof session.status === "string" ? session.status : undefined);
  const id = typeof session.id === "string" ? session.id : "";
  const workspace = normalizeAppSessionWorkspace(session);
  const { workspace: _workspace, ...sanitizedSession } = session;
  return AppSessionRecordSchema.parse({
    ...sanitizedSession,
    status,
    bindings: mergeAppSessionBindings([
      ...existingAppSessionBindings(session.bindings),
      ...(id ? [{ type: "app-session" as const, id }] : []),
      ...legacyAppSessionBindings(session),
    ]),
    ...(workspace ? { workspace } : {}),
  });
}

export function normalizeAppSessionStatus(status: string | undefined): AppSessionStatus {
  const value = (status || "unknown").trim().toLowerCase();
  if (value === "ended") return "closed";
  if (value === "terminating") return "stopping";
  return AppSessionStatusSchema.options.includes(value as AppSessionStatus) ? value as AppSessionStatus : "unknown";
}

export function isVisibleAppSessionStatus(status: string | undefined) {
  return !HIDDEN_APP_SESSION_STATUSES.has(normalizeAppSessionStatus(status));
}

export function appSessionAccessMode(session: Record<string, unknown>): AppSessionAccessMode | undefined {
  if (session.kind === "tty") return "tty";
  if (session.kind === "gui") return "vnc";
  if (session.kind === "web") return "web";
  return undefined;
}

export function appSessionBindingKeys(session: Record<string, unknown>) {
  return [
    ...normalizeAppSessionRecord(session).bindings.map(appSessionBindingKey),
    ...legacyAppSessionBindingKeys(session),
  ].filter(Boolean);
}

export function appSessionBindingKey(binding: AppSessionBinding) {
  if (binding.type === "app-session") return `app:${binding.id}`;
  if (binding.type === "provider-session") return `provider:${binding.agent || ""}:${binding.id}`;
  return `adapter:${binding.adapter || ""}:${binding.key || binding.id}`;
}

function existingAppSessionBindings(value: unknown): AppSessionBinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = AppSessionBindingSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function legacyAppSessionBindings(session: Record<string, unknown>): AppSessionBinding[] {
  const ai = objectRecord(session.ai);
  const claude = objectRecord(ai.claude);
  const appServer = objectRecord(ai.appServer);
  const bindings: AppSessionBinding[] = [];
  const claudeShort = stringValue(claude.short);
  if (claudeShort) bindings.push({ type: "adapter-key", adapter: "claude", agent: "claude", id: `short:${claudeShort}`, key: `short:${claudeShort}` });
  const claudeProviderSessionId = stringValue(claude.providerSessionId);
  if (claudeProviderSessionId) bindings.push({ type: "provider-session", agent: "claude", id: claudeProviderSessionId });
  const threadIds = Array.isArray(ai.threadIds) ? ai.threadIds.filter((value): value is string => typeof value === "string" && Boolean(value.trim())) : [];
  const activeThreadId = stringValue(ai.activeThreadId);
  for (const threadId of [...new Set([activeThreadId, ...threadIds].filter(Boolean))]) {
    bindings.push({ type: "provider-session", agent: "codex", id: threadId });
  }
  const socketPath = stringValue(appServer.socketPath);
  if (socketPath) bindings.push({ type: "adapter-key", adapter: "codex-app-server", agent: "codex", id: `socket:${socketPath}`, key: `socket:${socketPath}` });
  return bindings;
}

function legacyAppSessionBindingKeys(session: Record<string, unknown>) {
  const id = typeof session.id === "string" ? session.id : "";
  const ai = objectRecord(session.ai);
  const claude = objectRecord(ai.claude);
  const claudeShort = stringValue(claude.short);
  return [
    id ? `app:${id}` : "",
    claudeShort ? `claude-short:${claudeShort}` : "",
  ];
}

function normalizeAppSessionWorkspace(session: Record<string, unknown>) {
  const current = objectRecord(session.workspace);
  const tty = objectRecord(session.tty);
  const launch = objectRecord(session.launch);
  const ai = objectRecord(session.ai);
  const claude = objectRecord(ai.claude);
  const cwd = stringValue(current.cwd) || stringValue(tty.cwd) || stringValue(claude.cwd) || stringValue(launch.cwd);
  return cwd ? { cwd } : undefined;
}

function mergeAppSessionBindings(bindings: AppSessionBinding[]) {
  const byKey = new Map<string, AppSessionBinding>();
  for (const binding of bindings) byKey.set(appSessionBindingKey(binding), binding);
  return [...byKey.values()];
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function emptyAppSessionsSnapshot(now = new Date().toISOString()) {
  return AppSessionsSnapshotSchema.parse({
    runningCount: 0,
    problemCount: 0,
    sessions: [],
    updatedAt: now,
  });
}

export type AppSessionRecord = z.infer<typeof AppSessionRecordSchema>;
export type AppSessionStatus = z.infer<typeof AppSessionStatusSchema>;
export type AppSessionAccessMode = z.infer<typeof AppSessionAccessModeSchema>;
export type AppSessionAccessLease = z.infer<typeof AppSessionAccessLeaseSchema>;
export type AppSessionBinding = z.infer<typeof AppSessionBindingSchema>;
export type AppSessionsSnapshot = z.infer<typeof AppSessionsSnapshotSchema>;
export type AppSessionsState = z.infer<typeof AppSessionsStateSchema>;
export type InstanceBoardAppSummary = z.infer<typeof InstanceBoardAppSummarySchema>;
export type AppSessionEventReason = z.infer<typeof AppSessionEventReasonSchema>;
export type AppSessionEventMeta = z.infer<typeof AppSessionEventMetaSchema>;
export type AppSessionSnapshotEvent = z.infer<typeof AppSessionSnapshotEventSchema>;
export type AppSessionPatchEvent = z.infer<typeof AppSessionPatchEventSchema>;
export type AppSessionRemovedEvent = z.infer<typeof AppSessionRemovedEventSchema>;
export type AppSessionDeltaResponse = z.infer<typeof AppSessionDeltaResponseSchema>;
