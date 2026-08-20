import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import {
  AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS,
  AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS,
  AI_SESSION_HISTORY_DEFAULT_LIMIT,
  AI_SESSION_HISTORY_MAX_LIMIT,
} from "@task-handoff/protocol/ai-sessions";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";

export const AiSessionPersistenceSettingsInputSchema = z.object({
  historyLimit: z.number().int().min(1).max(AI_SESSION_HISTORY_MAX_LIMIT),
  attachmentRetentionDays: z.number().int().min(0).max(AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS).optional(),
}).strict();

const AiSessionPersistenceSettingsV1Schema = z.object({
  schemaVersion: z.literal(1),
  historyLimit: z.number().int().min(1).max(AI_SESSION_HISTORY_MAX_LIMIT),
}).strict();

const AiSessionPersistenceSettingsSchema = z.object({
  schemaVersion: z.literal(2),
  historyLimit: z.number().int().min(1).max(AI_SESSION_HISTORY_MAX_LIMIT),
  attachmentRetentionDays: z.number().int().min(0).max(AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS),
}).strict();

export type AiSessionPersistenceSettings = z.infer<typeof AiSessionPersistenceSettingsSchema>;

export class AiSessionPersistenceSettingsStore {
  private readonly filePath: string;

  constructor(
    paths: Pick<TaskHandoffStoragePaths, "dataDir">,
    private readonly onWarning?: (reason: string) => void,
  ) {
    this.filePath = path.join(paths.dataDir, "ai-session-persistence", "settings.json");
  }

  get(): AiSessionPersistenceSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const parsed = AiSessionPersistenceSettingsSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      // Compatibility for v0.0.21: settings schema v1 only persisted historyLimit.
      const previous = AiSessionPersistenceSettingsV1Schema.safeParse(raw);
      if (previous.success) {
        return {
          schemaVersion: 2,
          historyLimit: previous.data.historyLimit,
          attachmentRetentionDays: AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS,
        };
      }
      this.onWarning?.("invalid settings replaced with defaults");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return this.defaults();
      this.onWarning?.("unreadable settings replaced with defaults");
    }
    return this.defaults();
  }

  put(input: z.input<typeof AiSessionPersistenceSettingsInputSchema>) {
    const current = this.get();
    const parsedInput = AiSessionPersistenceSettingsInputSchema.parse(input);
    const settings = AiSessionPersistenceSettingsSchema.parse({
      schemaVersion: 2,
      historyLimit: parsedInput.historyLimit,
      attachmentRetentionDays: parsedInput.attachmentRetentionDays ?? current.attachmentRetentionDays,
    });
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeFileAtomic.sync(this.filePath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    return settings;
  }

  private defaults(): AiSessionPersistenceSettings {
    return {
      schemaVersion: 2,
      historyLimit: AI_SESSION_HISTORY_DEFAULT_LIMIT,
      attachmentRetentionDays: AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS,
    };
  }
}
