import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import {
  DEFAULT_RETENTION_MS,
  ensurePrivateDirectory,
  retireManagedDirectory,
  sweepRetiredDirectories,
} from "@task-handoff/core/storage/retention";
import type { ControlPlaneStorePaths } from "./paths.ts";

type MaintenanceLogger = (message: string, details: Record<string, unknown>) => void;

export class ControlPlanePersistenceMaintenance {
  private readonly retiredRoot: string;
  private readonly legacyControlledInstancesDir: string;
  private readonly legacyNodeRuntimesDir: string;
  private readonly legacyNodeJoinInvitesDir: string;
  private readonly paths: ControlPlaneStorePaths;
  private readonly options: { retentionMs?: number; now?: () => number; logger?: MaintenanceLogger };

  constructor(
    paths: ControlPlaneStorePaths,
    options: { retentionMs?: number; now?: () => number; logger?: MaintenanceLogger } = {},
  ) {
    this.paths = paths;
    this.options = options;
    this.retiredRoot = path.join(paths.dataDir, "retired-persistence");
    this.legacyControlledInstancesDir = path.join(paths.dataDir, "controlled-instances");
    this.legacyNodeRuntimesDir = path.join(paths.dataDir, "node-runtimes");
    this.legacyNodeJoinInvitesDir = path.join(paths.dataDir, "node-join-invites");
  }

  run() {
    this.removePersistedInvites();
    this.retireLegacyProjection("controlled-instances", this.legacyControlledInstancesDir, true);
    this.retireLegacyProjection("node-runtimes", this.legacyNodeRuntimesDir, false);
    return sweepRetiredDirectories({
      trashRoot: this.retiredRoot,
      retentionMs: this.options.retentionMs ?? DEFAULT_RETENTION_MS,
      nowMs: this.now(),
      logger: this.options.logger,
    });
  }

  private removePersistedInvites() {
    if (!fs.existsSync(this.legacyNodeJoinInvitesDir)) return;
    fs.rmSync(this.legacyNodeJoinInvitesDir, { recursive: true, force: true });
  }

  private retireLegacyProjection(name: string, directory: string, redactRegistrationToken: boolean) {
    if (!fs.existsSync(directory)) return;
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fs.rmSync(directory, { force: true });
      this.options.logger?.("invalid legacy persistence path was removed", { store: name });
      return;
    }
    const entries = fs.readdirSync(directory);
    if (!entries.length) {
      fs.rmdirSync(directory);
      return;
    }
    if (redactRegistrationToken) this.redactLegacyInstanceCredentials(directory);
    retireManagedDirectory({
      sourceRoot: this.paths.dataDir,
      entryName: path.basename(directory),
      trashRoot: this.retiredRoot,
      nowMs: this.now(),
    });
    this.options.logger?.("legacy control-plane persistence was retired", { store: name });
  }

  private redactLegacyInstanceCredentials(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const filePath = path.join(directory, entry.name);
      try {
        const record = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
        delete record.registrationToken;
        writeFileAtomic.sync(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        fs.chmodSync(filePath, 0o600);
      } catch (error) {
        fs.rmSync(filePath, { force: true });
        this.options.logger?.("unreadable legacy instance record was removed", {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    ensurePrivateDirectory(directory);
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }
}
