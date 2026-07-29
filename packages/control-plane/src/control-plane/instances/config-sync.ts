import { ConfigSyncPreferencesSchema, type ConfigSyncPreferences } from "@task-handoff/protocol/config-sync";
import { z } from "zod";

export const ConfigSyncPreferenceRecordSchema = z.object({
  id: z.string().trim().min(1),
  preferences: ConfigSyncPreferencesSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export type ConfigSyncPreferenceRecord = z.infer<typeof ConfigSyncPreferenceRecordSchema>;

export function sanitizeStoredConfigSyncPreferenceRecord(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const preferences = record.preferences && typeof record.preferences === "object" && !Array.isArray(record.preferences)
    ? record.preferences as Record<string, unknown>
    : {};
  return {
    id: record.id,
    preferences: {
      import: typeof preferences.import === "string" && preferences.import.trim() ? preferences.import : ".",
      export: typeof preferences.export === "string" && preferences.export.trim() ? preferences.export : ".",
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function defaultConfigSyncPreferences(): ConfigSyncPreferences {
  return ConfigSyncPreferencesSchema.parse({});
}

export function normalizeConfigSyncWorkspaceFolder(input: string) {
  const value = input.trim().replace(/\\/g, "/");
  const normalized = pathPosixNormalize(value || ".");
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    const error = new Error("Config sync folder must stay inside the instance workspace.");
    Object.assign(error, { statusCode: 400, code: "CONFIG_SYNC_FOLDER_INVALID" });
    throw error;
  }
  return normalized || ".";
}

function pathPosixNormalize(value: string) {
  const result: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!result.length) return "..";
      result.pop();
    } else result.push(segment);
  }
  return result.join("/") || ".";
}
