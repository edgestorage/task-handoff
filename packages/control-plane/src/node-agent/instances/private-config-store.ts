import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import type { NodeAgentStorePaths } from "../persistence/paths.ts";
import { CodexInstanceSettingsSchema, parseCodexInstanceSettings, type CodexInstanceSettings } from "@task-handoff/protocol/control-plane";
import {
  InstancePrivateModelCatalogSchema,
  sanitizeInstancePrivateModelCatalog,
  type InstancePrivateModelCatalog,
} from "../models/private-catalog.ts";

const PrivateEnvironmentSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string(),
);

export const InstancePrivateConfigSchema = z.object({
  version: z.literal(1),
  instanceId: z.string().trim().min(1).max(120),
  instanceCredential: z.string().trim().min(1).max(240),
  environment: PrivateEnvironmentSchema,
  modelCatalog: InstancePrivateModelCatalogSchema.optional(),
  codexSettings: CodexInstanceSettingsSchema.optional(),
  updatedAt: z.string().datetime(),
}).strict();

export type InstancePrivateConfig = z.infer<typeof InstancePrivateConfigSchema>;

// The per-instance directory mount exposes this file at
// /run/task-handoff/private/private-config.json. Compatibility for v0.0.34:
// containers created by that release bind-mount <instanceId>.json as a single
// file at /run/task-handoff/instance-private-config.json.
export const INSTANCE_PRIVATE_CONFIG_FILE_NAME = "private-config.json";

function isMissingFileError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function samePrivateConfigPayload(left: InstancePrivateConfig, right: InstancePrivateConfig) {
  const payload = (value: InstancePrivateConfig) => canonicalJson({
    instanceId: value.instanceId,
    instanceCredential: value.instanceCredential,
    environment: value.environment,
    modelCatalog: value.modelCatalog,
    codexSettings: value.codexSettings,
  });
  return payload(left) === payload(right);
}

function writeFileInPlace(filePath: string, content: string) {
  // Legacy containers bind-mount this file directly, so the path must keep its
  // inode: an atomic replace (tmp + rename) can invalidate the mount on
  // virtualized Docker file shares and make the container start fail.
  const handle = fs.openSync(filePath, "w", 0o600);
  try {
    fs.writeFileSync(handle, content, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.chmodSync(filePath, 0o600);
}

export class InstancePrivateConfigStore {
  private readonly directory: string;

  constructor(paths: NodeAgentStorePaths) {
    this.directory = paths.instancePrivateConfigsDir;
  }

  init() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
    for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
      const entryPath = path.join(this.directory, entry.name);
      if (entry.isDirectory()) {
        fs.chmodSync(entryPath, 0o700);
        const configPath = path.join(entryPath, INSTANCE_PRIVATE_CONFIG_FILE_NAME);
        if (fs.existsSync(configPath)) fs.chmodSync(configPath, 0o600);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      fs.chmodSync(entryPath, 0o600);
      this.migrateLegacyLayout(entry.name.slice(0, -".json".length));
    }
  }

  filePath(instanceId: string) {
    return path.join(this.directoryPath(instanceId), INSTANCE_PRIVATE_CONFIG_FILE_NAME);
  }

  /**
   * Compatibility for v0.0.34: containers created by that release bind-mount
   * this single file. Docker mounts are immutable, so keep materializing it
   * until those containers are recreated.
   */
  legacyFilePath(instanceId: string) {
    return path.join(this.directory, `${instanceId}.json`);
  }

  private directoryPath(instanceId: string) {
    return path.join(this.directory, instanceId);
  }

  private parseStored(stored: unknown, instanceId: string) {
    const source = stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
    const parsed = InstancePrivateConfigSchema.parse({
      version: source.version,
      instanceId: source.instanceId,
      instanceCredential: source.instanceCredential ?? source.registrationToken,
      environment: source.environment,
      modelCatalog: source.modelCatalog === undefined ? undefined : sanitizeInstancePrivateModelCatalog(source.modelCatalog),
      codexSettings: source.codexSettings === undefined ? undefined : parseCodexInstanceSettings(source.codexSettings),
      updatedAt: source.updatedAt,
    });
    if (parsed.instanceId !== instanceId) {
      throw Object.assign(new Error(`Private config identity mismatch for instance ${instanceId}.`), {
        statusCode: 409,
        code: "INSTANCE_PRIVATE_CONFIG_IDENTITY_MISMATCH",
      });
    }
    return parsed;
  }

  private readLayout(instanceId: string, filePath: string) {
    let serialized: string;
    try {
      serialized = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return { value: undefined, error: undefined };
      throw error;
    }
    try {
      return { value: this.parseStored(JSON.parse(serialized) as unknown, instanceId), error: undefined };
    } catch (error) {
      return { value: undefined, error };
    }
  }

  private readMaterialized(instanceId: string, options: { tolerateInvalid?: boolean } = {}) {
    let parseError: unknown;
    for (const filePath of [this.filePath(instanceId), this.legacyFilePath(instanceId)]) {
      const { value, error } = this.readLayout(instanceId, filePath);
      // A torn or invalid file must never mask a healthy sibling layout.
      if (value) return value;
      parseError ??= error;
    }
    if (parseError && !options.tolerateInvalid) throw parseError;
    return undefined;
  }

  private migrateLegacyLayout(instanceId: string) {
    const legacyPath = this.legacyFilePath(instanceId);
    const filePath = this.filePath(instanceId);
    if (fs.existsSync(filePath) || !fs.existsSync(legacyPath)) return;
    let parsed: InstancePrivateConfig;
    try {
      parsed = this.parseStored(JSON.parse(fs.readFileSync(legacyPath, "utf8")) as unknown, instanceId);
    } catch {
      // Leave invalid legacy files untouched; the next materialize rewrites both layouts.
      return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(filePath), 0o700);
    writeFileAtomic.sync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  }

  inspectMaterialized(instanceId: string) {
    return this.readMaterialized(instanceId);
  }

  put(input: InstancePrivateConfig) {
    const parsed = InstancePrivateConfigSchema.parse(input);
    this.init();
    const filePath = this.filePath(parsed.instanceId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(filePath), 0o700);
    writeFileAtomic.sync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
    writeFileInPlace(this.legacyFilePath(parsed.instanceId), `${JSON.stringify(parsed, null, 2)}\n`);
    return parsed;
  }

  materialize(
    instanceId: string,
    instanceCredential: string | undefined,
    environment: Record<string, string>,
    modelCatalog?: InstancePrivateModelCatalog,
    codexSettings?: CodexInstanceSettings,
  ) {
    if (!instanceCredential) {
      throw Object.assign(new Error(`Instance ${instanceId} does not have a long-lived credential.`), {
        statusCode: 409,
        code: "INSTANCE_PRIVATE_CONFIG_CREDENTIAL_MISSING",
      });
    }
    const next = InstancePrivateConfigSchema.parse({
      version: 1,
      instanceId,
      instanceCredential,
      environment,
      ...(modelCatalog ? { modelCatalog } : {}),
      ...(codexSettings ? { codexSettings } : {}),
      updatedAt: new Date().toISOString(),
    });
    // Runtime convergence reconciles through ExecutorContext, which materializes
    // the private config before every start/restart. Rewriting unchanged content
    // would keep racing mounted readers for no benefit, so only changed payloads
    // touch the disk. Both layouts must already match: a missing or stale layout
    // (for example after an upgrade) has to be materialized before the matching
    // mount can be used.
    const current = this.readLayout(instanceId, this.filePath(instanceId)).value;
    const legacy = this.readLayout(instanceId, this.legacyFilePath(instanceId)).value;
    if (current && legacy && samePrivateConfigPayload(current, next) && samePrivateConfigPayload(legacy, next)) {
      return current;
    }
    return this.put(next);
  }

  delete(instanceId: string) {
    fs.rmSync(this.directoryPath(instanceId), { recursive: true, force: true });
    fs.rmSync(this.legacyFilePath(instanceId), { force: true });
  }
}
