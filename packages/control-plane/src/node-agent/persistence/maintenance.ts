import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_RETENTION_MS,
  ensurePrivateDirectory,
  retireManagedDirectory,
  sweepRetiredDirectories,
} from "@task-handoff/core/storage/retention";
import { copyTruncateOpenLog } from "@task-handoff/core/storage/open-log-retention";
import type { NodeAgentStorePaths } from "./paths.ts";

type MaintenanceLogger = (message: string, details: Record<string, unknown>) => void;

export class NodeAgentPersistenceMaintenance {
  readonly localInstancesRoot: string;
  readonly localInstancesTrashRoot: string;
  private readonly options: { retentionMs?: number; now?: () => number; logger?: MaintenanceLogger };

  constructor(
    paths: NodeAgentStorePaths,
    options: { retentionMs?: number; now?: () => number; logger?: MaintenanceLogger } = {},
  ) {
    this.options = options;
    this.localInstancesRoot = path.join(paths.dataDir, "local-instances");
    this.localInstancesTrashRoot = path.join(paths.dataDir, "local-instances-trash");
  }

  run(activeInstanceIds: Iterable<string>) {
    const active = new Set(activeInstanceIds);
    if (fs.existsSync(this.localInstancesRoot)) {
      ensurePrivateDirectory(this.localInstancesRoot);
      for (const entry of fs.readdirSync(this.localInstancesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (active.has(entry.name)) this.capControlledInstanceLogs(entry.name);
        else this.retire(entry.name);
      }
    }
    return sweepRetiredDirectories({
      trashRoot: this.localInstancesTrashRoot,
      retentionMs: this.options.retentionMs ?? DEFAULT_RETENTION_MS,
      nowMs: this.now(),
      logger: this.options.logger,
    });
  }

  capActiveInstanceLogs(activeInstanceIds: Iterable<string>) {
    for (const instanceId of activeInstanceIds) this.capControlledInstanceLogs(instanceId);
  }

  capControlledInstanceLogs(instanceId: string) {
    const instanceDirectory = path.resolve(this.localInstancesRoot, instanceId);
    if (path.dirname(instanceDirectory) !== path.resolve(this.localInstancesRoot)) return [];
    const logDirectory = path.join(instanceDirectory, "logs");
    const rotated: string[] = [];
    for (const name of ["controlled-instance.out.log", "controlled-instance.err.log"]) {
      const filePath = path.join(logDirectory, name);
      try {
        if (copyTruncateOpenLog(filePath)) rotated.push(filePath);
      } catch (error) {
        this.options.logger?.("controlled instance log rotation failed", {
          instanceId,
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return rotated;
  }

  retire(instanceId: string) {
    try {
      return retireManagedDirectory({
        sourceRoot: this.localInstancesRoot,
        entryName: instanceId,
        trashRoot: this.localInstancesTrashRoot,
        nowMs: this.now(),
      });
    } catch (error) {
      this.options.logger?.("local instance persistence retirement failed", {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }
}
