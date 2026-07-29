import { z } from "zod";

export const ConfigSyncDirectionSchema = z.enum(["import", "export"]);

export const ConfigSyncProgramSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  directoryName: z.string().trim().min(1).max(120),
}).strict();

export const ConfigSyncRequestSchema = z.object({
  direction: ConfigSyncDirectionSchema,
  programIds: z.array(z.string().trim().min(1).max(120)).min(1).max(20)
    .refine((ids) => new Set(ids).size === ids.length, "Config sync program ids must be unique."),
  workspaceFolder: z.string().trim().min(1).max(1000),
}).strict();

export const ConfigSyncPreferencesSchema = z.object({
  import: z.string().trim().min(1).max(1000).default("."),
  export: z.string().trim().min(1).max(1000).default("."),
}).strict();

export const ConfigSyncStateSchema = z.object({
  programs: z.array(ConfigSyncProgramSchema),
  preferences: ConfigSyncPreferencesSchema,
}).strict();

export const ConfigSyncItemResultSchema = z.object({
  id: z.string().trim().min(1).max(120),
  type: z.enum(["file", "dir"]),
  projectPath: z.string().trim().min(1).max(1000),
  containerPath: z.string().trim().min(1).max(1000),
  source: z.string().trim().min(1).max(4096),
  target: z.string().trim().min(1).max(4096),
  status: z.enum(["copied", "skipped_missing_source", "failed"]),
  error: z.string().trim().max(4096).optional(),
}).strict();

export const ConfigSyncProgramResultSchema = z.object({
  preset: z.object({
    id: z.string().trim().min(1).max(120),
    label: z.string().trim().min(1).max(120),
    projectRoot: z.string().trim().min(1).max(1000),
  }).strict(),
  direction: ConfigSyncDirectionSchema,
  items: z.array(ConfigSyncItemResultSchema).max(100),
}).strict();

export const ConfigSyncBatchResultSchema = z.object({
  direction: ConfigSyncDirectionSchema,
  workspaceFolder: z.string().trim().min(1).max(1000),
  programs: z.array(ConfigSyncProgramResultSchema).min(1).max(20),
}).strict();

export type ConfigSyncDirection = z.infer<typeof ConfigSyncDirectionSchema>;
export type ConfigSyncProgram = z.infer<typeof ConfigSyncProgramSchema>;
export type ConfigSyncRequest = z.infer<typeof ConfigSyncRequestSchema>;
export type ConfigSyncPreferences = z.infer<typeof ConfigSyncPreferencesSchema>;
export type ConfigSyncState = z.infer<typeof ConfigSyncStateSchema>;

export type ConfigSyncItemResult = z.infer<typeof ConfigSyncItemResultSchema>;
export type ConfigSyncProgramResult = z.infer<typeof ConfigSyncProgramResultSchema>;
export type ConfigSyncBatchResult = z.infer<typeof ConfigSyncBatchResultSchema>;
