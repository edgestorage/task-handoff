import crypto from "node:crypto";
import { z } from "zod";

const ScheduleSourceSchema = z.union([
  z.object({
    type: z.literal("schedule"),
    scheduleKind: z.literal("interval").default("interval"),
    intervalMs: z.number().int().min(1_000),
  }).strict(),
  z.object({
    type: z.literal("schedule"),
    scheduleKind: z.literal("daily"),
    timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.string().trim().min(1).max(120),
  }).strict(),
  z.object({
    type: z.literal("schedule"),
    scheduleKind: z.literal("weekly"),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.string().trim().min(1).max(120),
  }).strict(),
]);

export const TriggerSourceSchema = z.union([
  ScheduleSourceSchema,
  z.object({
    type: z.literal("file-change"),
    roots: z.array(z.string().trim().min(1).max(4096)).min(1).max(50),
    globs: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
    ignore: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
    debounceMs: z.number().int().min(100).max(60_000).default(1_500),
  }).strict(),
  z.object({
    type: z.literal("ai-session"),
    agent: z.string().trim().min(1).max(80).optional(),
    statuses: z.array(z.enum(["running", "waiting", "idle", "failed"])).max(20).optional(),
    phases: z.array(z.enum(["thinking", "tool", "editing", "approval", "responding", "unknown"])).max(20).optional(),
  }).strict(),
]);

export const TriggerActionSchema = z.object({
  promptTemplate: z.string().trim().min(1).max(20_000),
}).strict();

export const TriggerPolicySchema = z.object({
  cooldownMs: z.number().int().min(0).max(86_400_000).optional(),
  maxConcurrentRuns: z.number().int().min(1).max(20).default(1),
  whenBusy: z.enum(["skip", "queue"]).default("skip"),
}).strict();

export const TriggerConfigSchema = z.object({
  configHash: z.string().trim().min(8).max(80),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).optional(),
  source: TriggerSourceSchema,
  action: TriggerActionSchema,
  policy: TriggerPolicySchema.default({ maxConcurrentRuns: 1, whenBusy: "skip" }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const TriggerTargetSchema = z
  .object({
    type: z.literal("ai-session"),
    aiSessionId: z.string().trim().min(1).max(160),
  })
  .strict();

export const TriggerDeploymentSchema = z.object({
  configHash: z.string().trim().min(8).max(80),
  deploymentId: z.string().trim().min(1).max(240).optional(),
  instanceId: z.string().trim().min(1).max(160),
  origin: z.enum(["control-plane", "controlled-instance"]).default("controlled-instance"),
  enabled: z.boolean().default(true),
  target: TriggerTargetSchema,
  localName: z.string().trim().min(1).max(160).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const TriggerRuntimeStateSchema = z.object({
  configHash: z.string().trim().min(8).max(80),
  deploymentId: z.string().trim().min(1).max(240).optional(),
  instanceId: z.string().trim().min(1).max(160),
  status: z.enum(["idle", "running", "disabled", "error"]).default("idle"),
  lastTriggeredAt: z.string().datetime().optional(),
  lastCompletedAt: z.string().datetime().optional(),
  lastSkippedAt: z.string().datetime().optional(),
  lastError: z.string().trim().max(4000).optional(),
  runCount: z.number().int().min(0).default(0),
  skippedCount: z.number().int().min(0).default(0),
}).strict();

export const TriggerRunSchema = z.object({
  id: z.string().trim().min(1).max(160),
  configHash: z.string().trim().min(8).max(80),
  deploymentId: z.string().trim().min(1).max(240).optional(),
  instanceId: z.string().trim().min(1).max(160),
  eventType: z.enum(["manual", "schedule", "file-change", "ai-session"]),
  status: z.enum(["started", "completed", "failed", "skipped"]),
  target: TriggerTargetSchema,
  promptPreview: z.string().trim().max(500),
  eventSummary: z.string().trim().max(1000).optional(),
  error: z.string().trim().max(4000).optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
}).strict();

export const TriggerIndexSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  configs: z.array(TriggerConfigSchema).default([]),
  deployments: z.array(TriggerDeploymentSchema).default([]),
  runtime: z.array(TriggerRuntimeStateSchema).default([]),
  recentRuns: z.array(TriggerRunSchema).default([]),
}).strict();

export type TriggerSource = z.infer<typeof TriggerSourceSchema>;
export type TriggerAction = z.infer<typeof TriggerActionSchema>;
export type TriggerPolicy = z.infer<typeof TriggerPolicySchema>;
export type TriggerConfig = z.infer<typeof TriggerConfigSchema>;
export type TriggerTarget = z.infer<typeof TriggerTargetSchema>;
export type TriggerDeployment = z.infer<typeof TriggerDeploymentSchema>;
export type TriggerRuntimeState = z.infer<typeof TriggerRuntimeStateSchema>;
export type TriggerRun = z.infer<typeof TriggerRunSchema>;
export type TriggerIndex = z.infer<typeof TriggerIndexSchema>;

type HashInput = Pick<TriggerConfig, "source" | "action" | "policy">;

export function triggerConfigHash(input: HashInput) {
  const canonical = canonicalize({
    source: input.source,
    action: input.action,
    policy: TriggerPolicySchema.parse(input.policy || {}),
  });
  return `trg_${crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 24)}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}
