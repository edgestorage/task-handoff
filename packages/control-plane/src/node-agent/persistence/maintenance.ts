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
  readonly logsDir: string;
  readonly localInstancesRoot: string;
  readonly localInstancesTrashRoot: string;
  readonly privateConfigsDir: string;
  private readonly options: { retentionMs?: number; now?: () => number; logger?: MaintenanceLogger; removeFile?: (filePath: string) => void };

  constructor(
    paths: NodeAgentStorePaths,
    options: { retentionMs?: number; now?: () => number; logger?: MaintenanceLogger; removeFile?: (filePath: string) => void } = {},
  ) {
    this.options = options;
    this.logsDir = paths.logsDir;
    this.localInstancesRoot = path.join(paths.dataDir, "local-instances");
    this.localInstancesTrashRoot = path.join(paths.dataDir, "local-instances-trash");
    this.privateConfigsDir = paths.instancePrivateConfigsDir;
  }

  run(activeInstanceIds: Iterable<string>) {
    this.capNodeAgentLogs();
    const active = new Set(activeInstanceIds);
    this.removeOrphanPrivateConfigs(active);
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

  capNodeAgentLogs() {
    const rotated: string[] = [];
    for (const name of ["node-agent.out.log", "node-agent.err.log"]) {
      const filePath = path.join(this.logsDir, name);
      try {
        if (copyTruncateOpenLog(filePath)) rotated.push(filePath);
      } catch (error) {
        this.options.logger?.("node-agent log rotation failed", {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return rotated;
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

  private removeOrphanPrivateConfigs(activeInstanceIds: Set<string>) {
    if (!fs.existsSync(this.privateConfigsDir)) return;
    for (const entry of fs.readdirSync(this.privateConfigsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const instanceId = entry.name.slice(0, -".json".length);
      if (activeInstanceIds.has(instanceId)) continue;
      const filePath = path.join(this.privateConfigsDir, entry.name);
      try {
        (this.options.removeFile || ((target) => fs.rmSync(target, { force: true })))(filePath);
      } catch (error) {
        this.options.logger?.("orphan instance private config cleanup failed", {
          instanceId,
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }
}
