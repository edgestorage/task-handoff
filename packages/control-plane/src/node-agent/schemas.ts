import { z } from "zod";
import { AI_SESSION_HISTORY_MAX_LIMIT, AiSessionPermissionModeSchema } from "@task-handoff/protocol/ai-sessions";
import {
  ControlledInstanceSchema,
  EnvironmentSourceSchema,
  ImageSelectionSchema,
  InstanceImageSnapshotSchema,
  ProjectSourceSchema,
} from "@task-handoff/protocol/control-plane";

export const ProxyRequestSchema = z
  .object({
    path: z.string().trim().min(1).max(2048),
    method: z.string().trim().min(1).max(20).default("GET"),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.string().optional(),
    bodyBase64: z.string().optional(),
  })
  .strict();

export const CreateLocalFolderSchema = z
  .object({
    id: z.string().trim().min(1).max(120).optional(),
    name: z.string().trim().min(1).max(160),
    path: z.string().trim().min(1).max(4096),
    defaultImageSelection: ImageSelectionSchema.optional(),
    labels: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const FolderTreeQuerySchema = z
  .object({
    path: z.string().trim().min(1).max(4096).optional(),
    depth: z.coerce.number().int().min(0).max(1).default(0),
  })
  .strict();

export const CreateNodeInstanceSchema = z
  .object({
    id: z.string().trim().min(1).max(120).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    runtimeId: z.string().trim().min(1).max(120),
    imageSelection: ImageSelectionSchema.optional(),
    environmentSource: EnvironmentSourceSchema.optional(),
    projectId: z.string().trim().min(1).max(120).optional(),
    image: InstanceImageSnapshotSchema.optional(),
    source: ProjectSourceSchema,
    sourceSnapshot: z.record(z.string(), z.unknown()).default({}),
    config: z.object({
      autoImportAgentConfigs: z.boolean().optional(),
      defaultCodexPermissionMode: AiSessionPermissionModeSchema.optional(),
      aiSessionHistoryLimit: z.number().int().min(1).max(AI_SESSION_HISTORY_MAX_LIMIT).optional(),
    }).strict().optional(),
    modelSelection: ControlledInstanceSchema.shape.modelSelection,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.environmentSource && input.imageSelection) {
      context.addIssue({ code: "custom", path: ["environmentSource"], message: "environmentSource and imageSelection are mutually exclusive." });
    }
    if (input.environmentSource?.type === "template" && input.image) {
      context.addIssue({ code: "custom", path: ["image"], message: "Template environment source is resolved by the node-agent and cannot include an image snapshot." });
    }
  });

export const UpdateNodeInstanceSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    config: z.object({
      autoImportAgentConfigs: z.boolean().optional(),
      defaultCodexPermissionMode: AiSessionPermissionModeSchema.optional(),
      aiSessionHistoryLimit: z.number().int().min(1).max(AI_SESSION_HISTORY_MAX_LIMIT).optional(),
    }).strict().optional(),
    modelSelection: ControlledInstanceSchema.shape.modelSelection.optional(),
  })
  .strict();

export const CreateNodeRuntimeSchema = z
  .object({
    id: z.string().trim().min(1).max(120).optional(),
    name: z.string().trim().min(1).max(160),
    type: z.enum(["docker", "kubernetes", "local"]),
    status: z.enum(["unknown", "online", "offline", "degraded"]).default("unknown"),
    accessStrategy: z.enum(["node-proxy", "direct-port", "kubernetes-ingress", "kubernetes-port-forward"]).optional(),
    capabilities: z.record(z.string(), z.unknown()).default({}),
    labels: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const UpdateNodeRuntimeSchema = CreateNodeRuntimeSchema.omit({ id: true }).partial().strict();
