import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import type { NodeAgentStorePaths } from "../persistence/paths.ts";

const PrivateEnvironmentSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string(),
);

export const InstancePrivateConfigSchema = z.object({
  version: z.literal(1),
  instanceId: z.string().trim().min(1).max(120),
  instanceCredential: z.string().trim().min(1).max(240),
  environment: PrivateEnvironmentSchema,
  updatedAt: z.string().datetime(),
}).strict();

export type InstancePrivateConfig = z.infer<typeof InstancePrivateConfigSchema>;

export const INSTANCE_PRIVATE_CONFIG_CONTAINER_PATH = "/run/task-handoff/instance-private-config.json";

export class InstancePrivateConfigStore {
  private readonly directory: string;

  constructor(paths: NodeAgentStorePaths) {
    this.directory = paths.instancePrivateConfigsDir;
  }

  init() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
    for (const name of fs.readdirSync(this.directory).filter((entry) => entry.endsWith(".json"))) {
      fs.chmodSync(path.join(this.directory, name), 0o600);
    }
  }

  filePath(instanceId: string) {
    return path.join(this.directory, `${instanceId}.json`);
  }

  get(instanceId: string) {
    const filePath = this.filePath(instanceId);
    if (!fs.existsSync(filePath)) return undefined;
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    const source = stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
    const parsed = InstancePrivateConfigSchema.parse({
      version: source.version,
      instanceId: source.instanceId,
      instanceCredential: source.instanceCredential ?? source.registrationToken,
      environment: source.environment,
      updatedAt: source.updatedAt,
    });
    if (parsed.instanceId !== instanceId) {
      throw Object.assign(new Error(`Private config identity mismatch for instance ${instanceId}.`), {
        statusCode: 409,
        code: "INSTANCE_PRIVATE_CONFIG_IDENTITY_MISMATCH",
      });
    }
    if ((source.instanceCredential === undefined && source.registrationToken !== undefined) || source.gitCredentials !== undefined) {
      // Compatibility for the pre-release snapshot implementation: read the instance
      // identity but immediately scrub the obsolete Git secret snapshot from disk.
      this.put(parsed);
    }
    return parsed;
  }

  put(input: InstancePrivateConfig) {
    const parsed = InstancePrivateConfigSchema.parse(input);
    this.init();
    const filePath = this.filePath(parsed.instanceId);
    writeFileAtomic.sync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
    return parsed;
  }

  materialize(
    instanceId: string,
    instanceCredential: string | undefined,
    environment: Record<string, string>,
  ) {
    if (!instanceCredential) {
      throw Object.assign(new Error(`Instance ${instanceId} does not have a long-lived credential.`), {
        statusCode: 409,
        code: "INSTANCE_PRIVATE_CONFIG_CREDENTIAL_MISSING",
      });
    }
    return this.put({
      version: 1,
      instanceId,
      instanceCredential,
      environment,
      updatedAt: new Date().toISOString(),
    });
  }

  delete(instanceId: string) {
    fs.rmSync(this.filePath(instanceId), { force: true });
  }
}
