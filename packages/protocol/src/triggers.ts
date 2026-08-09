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

export const ControlPlaneTriggerDeploymentEntrySchema = z.object({
  instanceId: z.string().trim().min(1).max(160),
  instanceName: z.string().trim().min(1).max(160),
  deployment: TriggerDeploymentSchema,
  runtime: TriggerRuntimeStateSchema.optional(),
}).strip();

export const ControlPlaneTriggerRunSchema = TriggerRunSchema.extend({
  instanceName: z.string().trim().min(1).max(160).optional(),
}).strip();

export const ControlPlaneTriggerSchema = z.object({
  configHash: z.string().trim().min(8).max(80),
  config: TriggerConfigSchema,
  deploymentCount: z.number().int().min(0),
  enabledCount: z.number().int().min(0),
  runningCount: z.number().int().min(0),
  errorCount: z.number().int().min(0),
  ownedByControlPlane: z.boolean(),
  controlPlaneDeploymentCount: z.number().int().min(0),
  deployments: z.array(ControlPlaneTriggerDeploymentEntrySchema),
  recentRuns: z.array(ControlPlaneTriggerRunSchema),
}).strip();

export const ControlPlaneTriggersSchema = z.object({
  updatedAt: z.string().datetime(),
  triggers: z.array(ControlPlaneTriggerSchema),
}).strip();

export const ControlPlaneTriggerTemplateInputSchema = z.object({
  name: TriggerConfigSchema.shape.name,
  description: TriggerConfigSchema.shape.description,
  source: TriggerSourceSchema,
  action: TriggerActionSchema,
  policy: TriggerPolicySchema.partial().optional(),
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
export type ControlPlaneTrigger = z.infer<typeof ControlPlaneTriggerSchema>;
export type ControlPlaneTriggers = z.infer<typeof ControlPlaneTriggersSchema>;
export type ControlPlaneTriggerTemplateInput = z.infer<typeof ControlPlaneTriggerTemplateInputSchema>;

type HashInput = Pick<TriggerConfig, "source" | "action" | "policy">;

export function triggerConfigHash(input: HashInput) {
  const canonical = canonicalize({
    source: input.source,
    action: input.action,
    policy: TriggerPolicySchema.parse(input.policy || {}),
  });
  return `trg_${sha256Hex(JSON.stringify(canonical)).slice(0, 24)}`;
}

const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function sha256Hex(value: string) {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = input.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15];
      const previous2 = words[index - 2];
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temporary1) >>> 0; d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0; hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0; hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, amount: number) {
  return (value >>> amount) | (value << (32 - amount));
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
