import { z } from "zod";

const RouteIdSchema = z.string().trim().min(1);

export const IdParamsSchema = z.object({
  id: RouteIdSchema,
}).strict();

export const NodeRemoteKeyParamsSchema = z.object({
  id: RouteIdSchema,
  keyId: RouteIdSchema,
}).strict();

export const NodeRuntimeParamsSchema = z.object({
  id: RouteIdSchema,
  runtimeId: RouteIdSchema,
}).strict();

export const NodeLocalFolderParamsSchema = z.object({
  id: RouteIdSchema,
  folderId: RouteIdSchema,
}).strict();

export const InstanceSessionParamsSchema = z.object({
  id: RouteIdSchema,
  sessionId: RouteIdSchema,
}).strict();

export const InstanceSessionQueueParamsSchema = z.object({
  id: RouteIdSchema,
  sessionId: RouteIdSchema,
  queueId: RouteIdSchema,
}).strict();

export const TriggerConfigParamsSchema = z.object({
  configHash: RouteIdSchema,
}).strict();

export const InstanceTriggerConfigParamsSchema = z.object({
  id: RouteIdSchema,
  configHash: RouteIdSchema,
}).strict();

export const InstanceSessionTriggerConfigParamsSchema = z.object({
  id: RouteIdSchema,
  sessionId: RouteIdSchema,
  configHash: RouteIdSchema,
}).strict();

export const NodeFolderTreeQuerySchema = z.object({
  path: z.string().optional(),
  depth: z.coerce.number().int().min(0).max(32).optional(),
}).strict();
