import {
  AGENT_DEFINITION_ERROR_CODES,
  AgentDefinitionCreateInputSchema,
  AgentDefinitionUpdateInputSchema,
  isPublishedAgentExecutionPolicy,
  type AgentDefinition,
  type AgentDefinitionCreateInput,
  type AgentDefinitionUpdateInput,
  type AgentDefinitionErrorCode,
} from "@task-handoff/protocol/agent-definitions";
import { aiSessionProviderCapability, type ControlledInstance } from "@task-handoff/protocol/control-plane";
import { createId } from "../../shared/persistence/store.ts";
import { resolveInstanceFolder } from "../instances/instance-folder.ts";
import type { AgentDefinitionContent, AgentDefinitionRepository } from "../persistence/agent-repository.ts";
import type { NodeAgentState } from "../state.ts";
import type { AgentOrchestrationService } from "./orchestration-service.ts";

export type AgentDefinitionFields = Omit<AgentDefinitionContent, "id">;

export type AgentDefinitionChangePublisher = (type: string, payload: unknown, scope: Record<string, unknown>) => void;

export type ResolvedAgentDefinitionExecution = {
  definition: AgentDefinition;
  runtimeType: string;
};

/**
 * AgentDefinition 服务：Node Agent 是定义的唯一权威来源。
 *
 * 写入时只校验本 Node 能确定性判定的引用：目标实例、该实例可解析的文件夹、provider 预设，
 * 以及本版本可表达的执行策略组合。执行 capability 的真实探测结果只决定运行能否启动
 * （见运行调度边界），不在定义写入时按“当前是否可运行”拒绝，否则探测未就绪会让定义不可维护。
 */
export class AgentDefinitionService {
  private readonly state: NodeAgentState;
  private readonly definitions: AgentDefinitionRepository;
  private readonly orchestrations: AgentOrchestrationService;
  private readonly publish?: AgentDefinitionChangePublisher;

  constructor(
    state: NodeAgentState,
    definitions: AgentDefinitionRepository,
    orchestrations: AgentOrchestrationService,
    publish?: AgentDefinitionChangePublisher,
  ) {
    this.state = state;
    this.definitions = definitions;
    this.orchestrations = orchestrations;
    this.publish = publish;
  }

  list(): AgentDefinition[] {
    return this.definitions.list();
  }

  get(id: string): AgentDefinition {
    const definition = this.definitions.get(id);
    if (!definition) throw agentDefinitionError("AGENT_DEFINITION_NOT_FOUND", `Agent definition ${id} was not found.`, 404);
    return definition;
  }

  has(id: string): boolean {
    return Boolean(this.definitions.get(id));
  }

  /** Re-resolve mutable target state immediately before accepting a run. */
  resolveExecution(id: string): ResolvedAgentDefinitionExecution {
    const definition = this.get(id);
    const instance = this.requireTargetInstance(definition.targetInstanceId);
    this.requireFolder(instance, definition.cwdFolderId);
    if (!aiSessionProviderCapability(instance.capabilities, definition.providerId)) {
      throw agentDefinitionError(
        "AGENT_DEFINITION_PROVIDER_UNSUPPORTED",
        `Instance ${instance.id} does not support provider ${definition.providerId}.`,
        409,
      );
    }
    if (!isPublishedAgentExecutionPolicy(definition.executionPolicy)) {
      throw agentDefinitionError(
        "AGENT_DEFINITION_POLICY_UNSUPPORTED",
        `Execution policy ${definition.executionPolicy.workspaceMaterializer}/${definition.executionPolicy.processSandbox} is not published by this Node Agent.`,
        409,
      );
    }
    return { definition, runtimeType: this.state.requireRuntime(instance.runtimeId).type };
  }

  create(input: AgentDefinitionCreateInput): AgentDefinition {
    const parsed = AgentDefinitionCreateInputSchema.parse(input);
    const id = createId("agent");
    const timestamp = new Date().toISOString();
    const created = this.definitions.transaction(() => {
      const fields = fieldsFromInput(parsed);
      this.validate(fields);
      const definition = this.definitions.insert({ id, ...fields }, timestamp);
      // 每个 Agent 恰好一张默认编排，与定义在同一事务里创建；提交后再发布两条变更事件。
      const defaultOrchestration = this.orchestrations.insertDefaultForAgent(id, fields.name, timestamp);
      return { definition, defaultOrchestration };
    });
    // 事件只在最外层事务提交后发布：外层回滚不会泄露未提交的定义与编排。
    this.definitions.afterCommit(() => {
      this.emit("created", created.definition);
      this.orchestrations.publishChange("created", created.defaultOrchestration);
    });
    return created.definition;
  }

  update(id: string, input: AgentDefinitionUpdateInput): AgentDefinition {
    const parsed = AgentDefinitionUpdateInputSchema.parse(input);
    const timestamp = new Date().toISOString();
    const result = this.definitions.transaction(() => {
      const current = this.definitions.get(id);
      if (!current) return { status: "missing" } as const;
      const fields = fieldsFromUpdate(current, parsed);
      this.validate(fields);
      return this.definitions.update(id, parsed.expectedRevision, fields, timestamp);
    });
    if (result.status === "missing") throw agentDefinitionError("AGENT_DEFINITION_NOT_FOUND", `Agent definition ${id} was not found.`, 404);
    if (result.status === "revision-conflict") {
      throw Object.assign(
        agentDefinitionError("AGENT_DEFINITION_REVISION_CONFLICT", "Agent definition changed since it was read.", 409),
        { details: { code: "AGENT_DEFINITION_REVISION_CONFLICT", expectedRevision: parsed.expectedRevision, actualRevision: result.definition.revision } },
      );
    }
    this.definitions.afterCommit(() => this.emit("updated", result.definition));
    return result.definition;
  }

  /**
   * 删除定义：默认编排必然随之删除；`referencingOrchestrations === "delete"` 时把引用该 Agent 的自定义编排一并删除，
   * 否则编排保留悬挂引用由用户修复。全部动作在同一事务里完成，事件在提交后发布。
   */
  delete(id: string, options: { referencingOrchestrations?: "keep" | "delete" } = {}): { deletedOrchestrationIds: string[] } {
    const existing = this.get(id);
    const deletedOrchestrations = this.definitions.transaction(() => {
      const deleted = this.orchestrations.deleteForAgent(id, options.referencingOrchestrations ?? "keep");
      if (!this.definitions.delete(id)) return undefined;
      return deleted;
    });
    if (!deletedOrchestrations) {
      throw agentDefinitionError("AGENT_DEFINITION_NOT_FOUND", `Agent definition ${id} was not found.`, 404);
    }
    this.definitions.afterCommit(() => {
      this.emit("deleted", existing);
      for (const orchestration of deletedOrchestrations) this.orchestrations.publishChange("deleted", orchestration);
    });
    return { deletedOrchestrationIds: deletedOrchestrations.map((orchestration) => orchestration.id) };
  }

  private emit(change: "created" | "updated" | "deleted", definition: AgentDefinition) {
    this.publish?.("agent.definition.changed", { agentId: definition.id, change, revision: definition.revision, definition }, {});
  }

  private validate(fields: AgentDefinitionFields) {
    const instance = this.requireTargetInstance(fields.targetInstanceId);
    this.requireFolder(instance, fields.cwdFolderId);
    if (!aiSessionProviderCapability(instance.capabilities, fields.providerId)) {
      throw agentDefinitionError("AGENT_DEFINITION_PROVIDER_UNSUPPORTED", `Instance ${instance.id} does not support provider ${fields.providerId}.`, 409);
    }
    if (!isPublishedAgentExecutionPolicy(fields.executionPolicy)) {
      throw agentDefinitionError(
        "AGENT_DEFINITION_POLICY_UNSUPPORTED",
        `Execution policy ${fields.executionPolicy.workspaceMaterializer}/${fields.executionPolicy.processSandbox} is not published by this Node Agent.`,
        409,
      );
    }
  }

  private requireTargetInstance(targetInstanceId: string): ControlledInstance {
    const instance = this.state.controlledInstances.get(targetInstanceId);
    if (!instance) {
      throw agentDefinitionError("AGENT_DEFINITION_TARGET_INSTANCE_UNKNOWN", `Instance ${targetInstanceId} does not belong to this Node Agent.`, 404);
    }
    return this.state.requireInstance(targetInstanceId);
  }

  private requireFolder(instance: ControlledInstance, cwdFolderId: string) {
    const resolution = resolveInstanceFolder(this.state, instance, cwdFolderId);
    if (resolution.status === "unknown-folder") {
      throw agentDefinitionError("AGENT_DEFINITION_FOLDER_UNKNOWN", `Working folder ${cwdFolderId} was not found on this Node Agent.`, 404);
    }
    if (resolution.status !== "resolved") {
      throw agentDefinitionError("AGENT_DEFINITION_FOLDER_UNKNOWN", `Working folder ${cwdFolderId} cannot be resolved on instance ${instance.id}.`, 409);
    }
  }

}

function fieldsFromInput(input: AgentDefinitionCreateInput): AgentDefinitionFields {
  return {
    name: input.name,
    description: input.description,
    appendedPrompt: input.appendedPrompt,
    targetInstanceId: input.targetInstanceId,
    cwdFolderId: input.cwdFolderId,
    providerId: input.providerId,
    modelEntityId: input.modelEntityId,
    modelName: input.modelName,
    reasoningEffort: input.reasoningEffort,
    permissionMode: input.permissionMode,
    executionPolicy: input.executionPolicy ?? { workspaceMaterializer: "overlay-copy-on-write", processSandbox: "instance" },
  };
}

/** 更新是补丁语义：未出现的字段保持当前值，显式 `null` 表示清空可选预设。 */
function fieldsFromUpdate(current: AgentDefinition, input: AgentDefinitionUpdateInput): AgentDefinitionFields {
  const clearable = <T>(value: T | null | undefined, fallback: T | undefined) => (value === null ? undefined : value === undefined ? fallback : value);
  return {
    name: input.name ?? current.name,
    description: input.description === null ? "" : input.description ?? current.description,
    appendedPrompt: input.appendedPrompt === null ? "" : input.appendedPrompt ?? current.appendedPrompt,
    targetInstanceId: input.targetInstanceId ?? current.targetInstanceId,
    cwdFolderId: input.cwdFolderId ?? current.cwdFolderId,
    providerId: input.providerId ?? current.providerId,
    modelEntityId: clearable(input.modelEntityId, current.modelEntityId),
    modelName: clearable(input.modelName, current.modelName),
    reasoningEffort: clearable(input.reasoningEffort, current.reasoningEffort),
    permissionMode: clearable(input.permissionMode, current.permissionMode),
    executionPolicy: input.executionPolicy ?? current.executionPolicy,
  };
}

export function agentDefinitionError(code: AgentDefinitionErrorCode, message: string, statusCode: number) {
  if (!AGENT_DEFINITION_ERROR_CODES.includes(code)) throw new Error(`Unknown Agent definition error code ${code}.`);
  return Object.assign(new Error(message), { code, statusCode });
}
