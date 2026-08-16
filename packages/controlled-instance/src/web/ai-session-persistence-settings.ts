import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import {
  AI_SESSION_HISTORY_DEFAULT_LIMIT,
  AI_SESSION_HISTORY_MAX_LIMIT,
} from "@task-handoff/protocol/ai-sessions";
import type { TaskHandoffStoragePaths } from "@task-handoff/core/storage/paths";

export const AiSessionPersistenceSettingsInputSchema = z.object({
  historyLimit: z.number().int().min(1).max(AI_SESSION_HISTORY_MAX_LIMIT),
}).strict();

const AiSessionPersistenceSettingsSchema = AiSessionPersistenceSettingsInputSchema.extend({
  schemaVersion: z.literal(1),
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
      const parsed = AiSessionPersistenceSettingsSchema.safeParse(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
      if (parsed.success) return parsed.data;
      this.onWarning?.("invalid settings replaced with defaults");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return this.defaults();
      this.onWarning?.("unreadable settings replaced with defaults");
    }
    return this.defaults();
  }

  put(input: z.input<typeof AiSessionPersistenceSettingsInputSchema>) {
    const settings = AiSessionPersistenceSettingsSchema.parse({
      schemaVersion: 1,
      ...AiSessionPersistenceSettingsInputSchema.parse(input),
    });
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeFileAtomic.sync(this.filePath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    return settings;
  }

  private defaults(): AiSessionPersistenceSettings {
    return { schemaVersion: 1, historyLimit: AI_SESSION_HISTORY_DEFAULT_LIMIT };
  }
}
