import { z } from "zod";

const TimestampSchema = z.number().finite().nonnegative();
const IdentifierSchema = z.string().trim().min(1).max(240);

export const OpenCodeHealthSchema = z.object({
  healthy: z.literal(true),
  version: z.string().trim().min(1),
}).passthrough();

export const OpenCodeSessionSchema = z.object({
  id: IdentifierSchema,
  directory: z.string().trim().min(1).max(4096),
  parentID: IdentifierSchema.optional(),
  title: z.string().max(1000),
  agent: z.string().trim().min(1).optional(),
  model: z.object({
    id: z.string().trim().min(1),
    providerID: z.string().trim().min(1),
    variant: z.string().optional(),
  }).passthrough().optional(),
  version: z.string().optional(),
  time: z.object({
    created: TimestampSchema,
    updated: TimestampSchema,
    archived: z.number().finite().optional(),
  }).passthrough(),
}).passthrough();

export const OpenCodeGlobalSessionSchema = OpenCodeSessionSchema.extend({
  project: z.object({
    id: z.string().trim().min(1),
    worktree: z.string().trim().min(1),
    name: z.string().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

export const OpenCodeSessionStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }).passthrough(),
  z.object({ type: z.literal("busy") }).passthrough(),
  z.object({
    type: z.literal("retry"),
    attempt: z.number().int().nonnegative(),
    message: z.string(),
    next: TimestampSchema,
  }).passthrough(),
]);
export const OpenCodeSessionStatusMapSchema = z.record(z.string(), OpenCodeSessionStatusSchema);

const OpenCodeMessageBaseSchema = z.object({
  id: IdentifierSchema,
  sessionID: IdentifierSchema,
  time: z.object({ created: TimestampSchema }).passthrough(),
}).passthrough();

export const OpenCodeUserMessageSchema = OpenCodeMessageBaseSchema.extend({
  role: z.literal("user"),
  agent: z.string().optional(),
  model: z.object({ providerID: z.string(), modelID: z.string(), variant: z.string().optional() }).passthrough().optional(),
}).passthrough();

export const OpenCodeAssistantMessageSchema = OpenCodeMessageBaseSchema.extend({
  role: z.literal("assistant"),
  parentID: IdentifierSchema,
  time: z.object({ created: TimestampSchema, completed: TimestampSchema.optional() }).passthrough(),
  error: z.unknown().optional(),
  finish: z.string().optional(),
}).passthrough();

export const OpenCodeMessageInfoSchema = z.discriminatedUnion("role", [
  OpenCodeUserMessageSchema,
  OpenCodeAssistantMessageSchema,
]);

const OpenCodePartBaseSchema = z.object({
  id: IdentifierSchema,
  sessionID: IdentifierSchema,
  messageID: IdentifierSchema,
}).passthrough();

const OpenCodeTextPartSchema = OpenCodePartBaseSchema.extend({
  type: z.literal("text"),
  text: z.string(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
}).passthrough();
const OpenCodeReasoningPartSchema = OpenCodePartBaseSchema.extend({
  type: z.literal("reasoning"),
  text: z.string(),
}).passthrough();
const OpenCodeFilePartSchema = OpenCodePartBaseSchema.extend({
  type: z.literal("file"),
  mime: z.string(),
  filename: z.string().optional(),
  url: z.string(),
}).passthrough();
const OpenCodeToolPartSchema = OpenCodePartBaseSchema.extend({
  type: z.literal("tool"),
  tool: z.string().trim().min(1),
  callID: z.string().optional(),
  state: z.object({
    status: z.enum(["pending", "running", "completed", "error"]),
    input: z.record(z.string(), z.unknown()).optional(),
    title: z.string().optional(),
    output: z.string().optional(),
    error: z.string().optional(),
    time: z.object({ start: TimestampSchema, end: TimestampSchema.optional() }).passthrough().optional(),
  }).passthrough(),
}).passthrough();
const OpenCodePatchPartSchema = OpenCodePartBaseSchema.extend({
  type: z.literal("patch"),
  files: z.array(z.string()),
}).passthrough();
const OpenCodeCompactionPartSchema = OpenCodePartBaseSchema.extend({
  type: z.literal("compaction"),
  auto: z.boolean(),
}).passthrough();
const OpenCodeRetryPartSchema = OpenCodePartBaseSchema.extend({
  type: z.literal("retry"),
  attempt: z.number().int().nonnegative(),
  error: z.unknown(),
}).passthrough();
const OpenCodeGenericPartSchema = OpenCodePartBaseSchema.extend({
  type: z.string().trim().min(1),
}).passthrough();

export const OpenCodePartSchema = z.union([
  OpenCodeTextPartSchema,
  OpenCodeReasoningPartSchema,
  OpenCodeFilePartSchema,
  OpenCodeToolPartSchema,
  OpenCodePatchPartSchema,
  OpenCodeCompactionPartSchema,
  OpenCodeRetryPartSchema,
  OpenCodeGenericPartSchema,
]);

export const OpenCodeMessageSchema = z.object({
  info: OpenCodeMessageInfoSchema,
  parts: z.array(OpenCodePartSchema),
}).passthrough();

export const OpenCodePermissionSchema = z.object({
  id: IdentifierSchema,
  sessionID: IdentifierSchema,
  permission: z.string().trim().min(1).optional(),
  patterns: z.array(z.string()).optional(),
  always: z.array(z.string()).optional(),
  action: z.string().trim().min(1).optional(),
  resources: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tool: z.object({ messageID: z.string(), callID: z.string() }).passthrough().optional(),
  source: z.object({
    type: z.literal("tool"),
    messageID: z.string(),
    callID: z.string(),
  }).passthrough().optional(),
}).passthrough().superRefine((permission, context) => {
  if (!permission.permission && !permission.action) {
    context.addIssue({ code: "custom", path: ["permission"], message: "OpenCode permission action is required." });
  }
}).transform((permission) => ({
  ...permission,
  action: permission.action || permission.permission!,
  resources: permission.resources || permission.patterns || [],
  source: permission.source || (permission.tool ? { type: "tool" as const, ...permission.tool } : undefined),
}));

export const OpenCodeGlobalEventSchema = z.object({
  directory: z.string().max(4096).default(""),
  payload: z.object({
    type: z.string().trim().min(1),
    properties: z.record(z.string(), z.unknown()).default({}),
  }).passthrough(),
}).passthrough();

export const OpenCodeSessionListSchema = z.array(OpenCodeSessionSchema);
export const OpenCodeGlobalSessionListSchema = z.array(OpenCodeGlobalSessionSchema);
export const OpenCodeMessageListSchema = z.array(OpenCodeMessageSchema);
export const OpenCodePermissionListSchema = z.array(OpenCodePermissionSchema);
export const OpenCodeBooleanSchema = z.boolean();

export type OpenCodeSession = z.infer<typeof OpenCodeSessionSchema>;
export type OpenCodeSessionStatus = z.infer<typeof OpenCodeSessionStatusSchema>;
export type OpenCodeMessage = z.infer<typeof OpenCodeMessageSchema>;
export type OpenCodePart = z.infer<typeof OpenCodePartSchema>;
export type OpenCodePermission = z.infer<typeof OpenCodePermissionSchema>;
export type OpenCodeGlobalEvent = z.infer<typeof OpenCodeGlobalEventSchema>;
