import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import {
  AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES,
  AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS,
  AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS,
  AI_SESSION_HISTORY_DEFAULT_LIMIT,
  AI_SESSION_HISTORY_MAX_LIMIT,
  AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES,
} from "@task-handoff/protocol/ai-sessions";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";

export const AiSessionPersistenceSettingsInputSchema = z.object({
  historyLimit: z.number().int().min(1).max(AI_SESSION_HISTORY_MAX_LIMIT),
  attachmentRetentionDays: z.number().int().min(0).max(AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS).optional(),
  maxFileAttachmentBytes: z.number().int().positive().max(AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES).optional(),
}).strict();

const AiSessionPersistenceSettingsV1Schema = z.object({
  schemaVersion: z.literal(1),
  historyLimit: z.number().int().min(1).max(AI_SESSION_HISTORY_MAX_LIMIT),
}).strict();

const AiSessionPersistenceSettingsV2Schema = z.object({
  schemaVersion: z.literal(2),
  historyLimit: z.number().int().min(1).max(AI_SESSION_HISTORY_MAX_LIMIT),
  attachmentRetentionDays: z.number().int().min(0).max(AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS),
}).strict();

const AiSessionPersistenceSettingsSchema = z.object({
  schemaVersion: z.literal(3),
  historyLimit: z.number().int().min(1).max(AI_SESSION_HISTORY_MAX_LIMIT),
  attachmentRetentionDays: z.number().int().min(0).max(AI_SESSION_ATTACHMENT_RETENTION_MAX_DAYS),
  maxFileAttachmentBytes: z.number().int().positive().max(AI_SESSION_MAX_CONFIGURABLE_FILE_ATTACHMENT_BYTES),
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
      const version2 = AiSessionPersistenceSettingsV2Schema.safeParse(raw);
      if (version2.success) {
        return {
          schemaVersion: 3,
          historyLimit: version2.data.historyLimit,
          attachmentRetentionDays: version2.data.attachmentRetentionDays,
          maxFileAttachmentBytes: AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES,
        };
      }
      // Compatibility for v0.0.21: settings schema v1 only persisted historyLimit.
      const previous = AiSessionPersistenceSettingsV1Schema.safeParse(raw);
      if (previous.success) {
        return {
          schemaVersion: 3,
          historyLimit: previous.data.historyLimit,
          attachmentRetentionDays: AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS,
          maxFileAttachmentBytes: AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES,
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
      schemaVersion: 3,
      historyLimit: parsedInput.historyLimit,
      attachmentRetentionDays: parsedInput.attachmentRetentionDays ?? current.attachmentRetentionDays,
      maxFileAttachmentBytes: parsedInput.maxFileAttachmentBytes ?? current.maxFileAttachmentBytes,
    });
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeFileAtomic.sync(this.filePath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    return settings;
  }

  private defaults(): AiSessionPersistenceSettings {
    return {
      schemaVersion: 3,
      historyLimit: AI_SESSION_HISTORY_DEFAULT_LIMIT,
      attachmentRetentionDays: AI_SESSION_ATTACHMENT_RETENTION_DEFAULT_DAYS,
      maxFileAttachmentBytes: AI_SESSION_DEFAULT_MAX_FILE_ATTACHMENT_BYTES,
    };
  }
}
