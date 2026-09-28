import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  sanitizeAgentDefinition,
  type AgentDefinition,
  type AgentExecutionPolicy,
} from "@task-handoff/protocol/agent-definitions";
import { AgentRunRepository } from "./agent-run-repository.ts";
import { AgentOrchestrationRepository } from "./agent-orchestration-repository.ts";
import { StoryAgentEntryRepository } from "./story-agent-entry-repository.ts";
import { AgentRunResourceRepository } from "./agent-run-resource-repository.ts";
import { registerAfterCommit, runInTransaction } from "./transaction-journal.ts";

type Row = Record<string, unknown>;

/** 定义行的权威列集合：不在这里的列只说明它是更高版本写入的，读取时忽略并记录诊断。 */
const AGENT_DEFINITION_COLUMNS = new Set([
  "id", "name", "description", "appended_prompt", "target_instance_id", "cwd_folder_id", "provider_id",
  "model_entity_id", "model_name", "reasoning_effort", "permission_mode", "execution_policy_json",
  "revision", "created_at", "updated_at",
]);

export type AgentDefinitionDiagnostic = (message: string, details: Record<string, unknown>) => void;

/** 定义的持久化内容；revision 由内容派生，时间戳不参与计算。 */
export type AgentDefinitionContent = {
  id: string;
  name: string;
  description: string;
  appendedPrompt: string;
  targetInstanceId: string;
  cwdFolderId: string;
  providerId: string;
  modelEntityId?: string;
  modelName?: string;
  reasoningEffort?: string;
  permissionMode?: string;
  executionPolicy: AgentExecutionPolicy;
};

export type AgentDefinitionStoreRow = {
  definition: AgentDefinition;
  createdAt: string;
  updatedAt: string;
};

export type AgentDefinitionMutationResult =
  | { status: "updated"; definition: AgentDefinition }
  | { status: "revision-conflict"; definition: AgentDefinition }
  | { status: "missing" };

function json(value: unknown) {
  return JSON.stringify(value ?? null);
}

function parseJson(value: unknown): unknown {
  try {
    return JSON.parse(String(value));
  } catch {
    return undefined;
  }
}

/**
 * 内容哈希即 revision：只有定义内容变化才产生新 revision，调用方据此做乐观并发控制。
 * 时间戳不参与，重复提交相同内容不会伪造出新的修订。
 */
export function agentDefinitionRevision(content: Omit<AgentDefinitionContent, "id">) {
  return crypto.createHash("sha256").update(json([
    content.name,
    content.description,
    content.appendedPrompt,
    content.targetInstanceId,
    content.cwdFolderId,
    content.providerId,
    content.modelEntityId ?? null,
    content.modelName ?? null,
    content.reasoningEffort ?? null,
    content.permissionMode ?? null,
    content.executionPolicy.workspaceMaterializer,
    content.executionPolicy.processSandbox,
  ])).digest("hex");
}

export class AgentDefinitionRepository {
  private readonly client: DatabaseSync;
  private diagnostic?: AgentDefinitionDiagnostic;
  constructor(client: DatabaseSync) { this.client = client; }

  setDiagnostic(sink: AgentDefinitionDiagnostic) { this.diagnostic = sink; }

  transaction<T>(operation: () => T): T {
    return runInTransaction(this.client, operation);
  }

  /** 在事务内注册提交后副作用：外层事务回滚时不会发布未提交状态。 */
  afterCommit(callback: () => void) {
    registerAfterCommit(this.client, callback);
  }

  list(): AgentDefinition[] {
    const rows = this.client
      .prepare("SELECT * FROM na_agent_definitions ORDER BY name COLLATE NOCASE ASC, id ASC")
      .all() as Row[];
    return rows.map((row) => this.definitionFromRow(row));
  }

  get(id: string): AgentDefinition | undefined {
    const row = this.client.prepare("SELECT * FROM na_agent_definitions WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    return this.definitionFromRow(row);
  }

  insert(content: AgentDefinitionContent, timestamp: string): AgentDefinition {
    return runInTransaction(this.client, () => {
      const revision = agentDefinitionRevision(content);
    this.client.prepare(`INSERT INTO na_agent_definitions
        (id, name, description, appended_prompt, target_instance_id, cwd_folder_id, provider_id,
         model_entity_id, model_name, reasoning_effort, permission_mode, execution_policy_json,
         revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(content.id, content.name, content.description, content.appendedPrompt, content.targetInstanceId,
          content.cwdFolderId, content.providerId, content.modelEntityId ?? null, content.modelName ?? null,
          content.reasoningEffort ?? null, content.permissionMode ?? null, json(content.executionPolicy),
          revision, timestamp, timestamp);
      return this.requireDefinition(content.id);
    });
  }

  update(id: string, expectedRevision: string, content: Omit<AgentDefinitionContent, "id">, timestamp: string): AgentDefinitionMutationResult {
    return runInTransaction(this.client, () => {
      const current = this.get(id);
      if (!current) return { status: "missing" };
      if (current.revision !== expectedRevision) return { status: "revision-conflict", definition: current };
      const revision = agentDefinitionRevision(content);
      this.client.prepare(`UPDATE na_agent_definitions SET
          name = ?, description = ?, appended_prompt = ?, target_instance_id = ?, cwd_folder_id = ?, provider_id = ?,
          model_entity_id = ?, model_name = ?, reasoning_effort = ?, permission_mode = ?, execution_policy_json = ?,
          revision = ?, updated_at = ?
        WHERE id = ?`)
        .run(content.name, content.description, content.appendedPrompt, content.targetInstanceId, content.cwdFolderId,
          content.providerId, content.modelEntityId ?? null, content.modelName ?? null, content.reasoningEffort ?? null,
          content.permissionMode ?? null, json(content.executionPolicy), revision, timestamp, id);
      return { status: "updated", definition: this.requireDefinition(id) };
    });
  }

  /** 删除定义只影响定义本体；编排里的悬挂引用由编排侧保留并可从权威状态确定性诊断。 */
  delete(id: string): boolean {
    return runInTransaction(this.client, () => {
      return Number(this.client.prepare("DELETE FROM na_agent_definitions WHERE id = ?").run(id).changes) > 0;
    });
  }

  private requireDefinition(id: string): AgentDefinition {
    const definition = this.get(id);
    if (!definition) throw Object.assign(new Error(`Agent definition ${id} was not found after the write.`), { code: "AGENT_DEFINITION_NOT_FOUND", statusCode: 404 });
    return definition;
  }

  private definitionFromRow(row: Row): AgentDefinition {
    const unknownColumns = Object.keys(row).filter((column) => !AGENT_DEFINITION_COLUMNS.has(column));
    if (unknownColumns.length) {
      this.diagnostic?.("Agent definition row contains unknown columns; they are ignored on read.", { agentId: row.id, columns: unknownColumns });
    }
    const definition = sanitizeStoredAgentDefinition({
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      appendedPrompt: row.appended_prompt ?? "",
      targetInstanceId: row.target_instance_id,
      cwdFolderId: row.cwd_folder_id,
      providerId: row.provider_id,
      modelEntityId: row.model_entity_id ?? undefined,
      modelName: row.model_name ?? undefined,
      reasoningEffort: row.reasoning_effort ?? undefined,
      permissionMode: row.permission_mode ?? undefined,
      executionPolicy: parseJson(row.execution_policy_json),
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    return definition;
  }
}

/**
 * 存储读取边界：这里只做一次可诊断的收口，历史行或更高版本写入的行缺少/多出字段时按当前模型归一。
 */
export function sanitizeStoredAgentDefinition(input: unknown): AgentDefinition {
  try {
    return sanitizeAgentDefinition(input);
  } catch (cause) {
    throw Object.assign(new Error("Stored agent definition cannot be parsed with the current model.", { cause }), {
      code: "NODE_AGENT_AGENT_DEFINITION_INVALID",
      statusCode: 500,
    });
  }
}

export function createAgentRepositories(client: DatabaseSync) {
  return {
    definitions: new AgentDefinitionRepository(client),
    orchestrations: new AgentOrchestrationRepository(client),
    runs: new AgentRunRepository(client),
    storyEntries: new StoryAgentEntryRepository(client),
    resources: new AgentRunResourceRepository(client),
  };
}
