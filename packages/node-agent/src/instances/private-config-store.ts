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
// /run/task-handoff/private/private-config.json.
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
      // The retired single-file layout is no longer read or migrated, but this
      // store owns the directory and a preserved v0.0.28 import can leave such a
      // file holding an instance credential. Never leave it group-readable.
      if (entry.name.endsWith(".json")) fs.chmodSync(entryPath, 0o600);
    }
  }

  filePath(instanceId: string) {
    return path.join(this.directoryPath(instanceId), INSTANCE_PRIVATE_CONFIG_FILE_NAME);
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
    const { value, error } = this.readLayout(instanceId, this.filePath(instanceId));
    if (value) return value;
    if (error && !options.tolerateInvalid) throw error;
    return undefined;
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
    // touch the disk.
    const current = this.readLayout(instanceId, this.filePath(instanceId)).value;
    if (current && samePrivateConfigPayload(current, next)) {
      return current;
    }
    return this.put(next);
  }

  delete(instanceId: string) {
    fs.rmSync(this.directoryPath(instanceId), { recursive: true, force: true });
  }
}
