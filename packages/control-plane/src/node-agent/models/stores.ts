import fs from "node:fs";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import {
  modelConfigHash,
  NodeModelAssignmentSchema,
  NodeModelConfigSchema,
  type NodeModelAssignment,
  type NodeModelConfig,
} from "@task-handoff/protocol/control-plane";

const ModelEnvironmentSchema = z.record(z.string(), z.string());

export const LEGACY_MODEL_ENV_KEYS = new Set([
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_MODEL",
  "TASK_HANDOFF_CODEX_BASE_URL",
  "TASK_HANDOFF_CODEX_MODEL",
  "TASK_HANDOFF_CODEX_MODEL_ID",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_MODEL",
  "TASK_HANDOFF_CLAUDE_MODEL",
  "TASK_HANDOFF_CLAUDE_MODEL_ID",
]);

export class InstanceModelEnvironmentStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  get(instanceId: string) {
    try {
      return ModelEnvironmentSchema.parse(JSON.parse(fs.readFileSync(this.filePath(instanceId), "utf8")));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
      throw new Error(`Stored model environment for instance ${instanceId} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  has(instanceId: string) {
    return fs.existsSync(this.filePath(instanceId));
  }

  listInstanceIds() {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .sort();
  }

  put(instanceId: string, value: Record<string, string>) {
    const parsed = ModelEnvironmentSchema.parse(value);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filePath = this.filePath(instanceId);
    writeFileAtomic.sync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
    return parsed;
  }

  delete(instanceId: string) {
    fs.rmSync(this.filePath(instanceId), { force: true });
  }

  private filePath(instanceId: string) {
    return path.join(this.directory, `${instanceId}.json`);
  }
}

export class NodeModelStore {
  private readonly directory: string;
  private readonly nodeId: string;

  constructor(directory: string, nodeId: string) {
    this.directory = directory;
    this.nodeId = nodeId;
  }

  init() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
  }

  list() {
    this.init();
    return fs.readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .flatMap((name) => {
        const model = this.read(path.join(this.directory, name));
        return model ? [model] : [];
      });
  }

  get(id: string) {
    const filePath = this.filePath(id);
    return fs.existsSync(filePath) ? this.read(filePath) : undefined;
  }

  put(model: NodeModelConfig) {
    const parsed = NodeModelConfigSchema.parse(model);
    this.init();
    const filePath = this.filePath(parsed.id);
    writeFileAtomic.sync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
    return parsed;
  }

  delete(id: string) {
    const filePath = this.filePath(id);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  private read(filePath: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const expectedId = path.basename(filePath, ".json");
      const parsed = NodeModelConfigSchema.safeParse(raw);
      if (parsed.success && parsed.data.id === expectedId && modelConfigHash(parsed.data) === parsed.data.id) return parsed.data;
      const sanitized = NodeModelConfigSchema.strip().safeParse(raw);
      if (sanitized.success && sanitized.data.id === expectedId && modelConfigHash(sanitized.data) === sanitized.data.id) {
        console.warn(JSON.stringify({ message: "unknown stored node model fields were ignored", nodeId: this.nodeId, filePath }));
        return sanitized.data;
      }
      console.warn(JSON.stringify({ message: "stored node model failed validation and was isolated", nodeId: this.nodeId, filePath }));
      return undefined;
    } catch (error) {
      console.warn(JSON.stringify({ message: "stored node model could not be read", nodeId: this.nodeId, filePath, error: error instanceof Error ? error.message : String(error) }));
      return undefined;
    }
  }

  private filePath(id: string) {
    return path.join(this.directory, `${id}.json`);
  }
}

export class InstanceModelAssignmentStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  init() {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
  }

  get(instanceId: string) {
    const filePath = this.filePath(instanceId);
    if (!fs.existsSync(filePath)) return undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const parsed = NodeModelAssignmentSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
      const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const sanitized = NodeModelAssignmentSchema.safeParse({
        instanceId: source.instanceId,
        modelEntityIds: source.modelEntityIds,
        codexModelHash: source.codexModelHash,
        claudeModelHash: source.claudeModelHash,
        opencodeModelHash: source.opencodeModelHash,
        updatedAt: source.updatedAt,
      });
      if (sanitized.success) {
        console.warn(JSON.stringify({ message: "unknown stored model assignment fields were ignored", instanceId, filePath }));
        return sanitized.data;
      }
      throw parsed.error;
    } catch (error) {
      throw Object.assign(new Error(`Stored model assignment for instance ${instanceId} is invalid.`), {
        statusCode: 409,
        code: "NODE_MODEL_ASSIGNMENT_INVALID",
        cause: error,
      });
    }
  }

  put(assignment: NodeModelAssignment) {
    const parsed = NodeModelAssignmentSchema.parse(assignment);
    this.init();
    const filePath = this.filePath(parsed.instanceId);
    writeFileAtomic.sync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
    return parsed;
  }

  delete(instanceId: string) {
    fs.rmSync(this.filePath(instanceId), { force: true });
  }

  private filePath(instanceId: string) {
    return path.join(this.directory, `${instanceId}.json`);
  }
}
