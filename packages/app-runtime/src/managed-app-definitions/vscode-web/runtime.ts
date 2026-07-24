import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { ManagedAppRuntimeExtension } from "../types";

const DEFAULT_SETTINGS: Record<string, unknown> = {
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.preferredDarkColorTheme": "Default Dark Modern",
};

export function createVscodeWebRuntime(): ManagedAppRuntimeExtension {
  return {
    prepareWebSession({ sessionDir }) {
      const settingsDir = path.join(sessionDir, "user-data", "User");
      const settingsPath = path.join(settingsDir, "settings.json");
      let existingSettings: Record<string, unknown> = {};
      fs.mkdirSync(settingsDir, { recursive: true });
      if (fs.existsSync(settingsPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existingSettings = parsed as Record<string, unknown>;
        } catch {
          existingSettings = {};
        }
      }
      writeFileAtomic.sync(settingsPath, `${JSON.stringify({ ...DEFAULT_SETTINGS, ...existingSettings }, null, 2)}\n`, { mode: 0o600 });
    },
  };
}
