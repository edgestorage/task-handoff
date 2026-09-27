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
import {
  agentInvocationToolRevisionSource,
  AgentInvocationToolResolutionSchema,
  resolveAgentInvocationToolGrant,
  type AgentInvocationToolResolution,
} from "@task-handoff/protocol/agent-invocation-tools";
import crypto from "node:crypto";
import { createId } from "../../shared/persistence/store.ts";
import { resolveInstanceFolder } from "../instances/instance-folder.ts";
import type { AgentDefinitionContent, AgentDefinitionRepository } from "../persistence/agent-repository.ts";
import type { NodeAgentState } from "../state.ts";

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
  private readonly publish?: AgentDefinitionChangePublisher;

  constructor(state: NodeAgentState, definitions: AgentDefinitionRepository, publish?: AgentDefinitionChangePublisher) {
    this.state = state;
    this.definitions = definitions;
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

  resolveInvocationTools(id: string): AgentInvocationToolResolution {
    const definition = this.get(id);
    const availableAgentIds = definition.callableAgentIds.filter((agentId) => Boolean(this.definitions.get(agentId)));
    const grant = resolveAgentInvocationToolGrant(availableAgentIds);
    const revision = crypto.createHash("sha256")
      .update(agentInvocationToolRevisionSource(definition.revision, grant))
      .digest("hex");
    return AgentInvocationToolResolutionSchema.parse({ ...grant, revision });
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
    const definition = this.definitions.transaction(() => {
      const fields = fieldsFromInput(parsed);
      this.validate(fields, id);
      return this.definitions.insert({ id, ...fields }, timestamp);
    });
    this.emit("created", definition);
    return definition;
  }

  update(id: string, input: AgentDefinitionUpdateInput): AgentDefinition {
    const parsed = AgentDefinitionUpdateInputSchema.parse(input);
    const timestamp = new Date().toISOString();
    const result = this.definitions.transaction(() => {
      const current = this.definitions.get(id);
      if (!current) return { status: "missing" } as const;
      const fields = fieldsFromUpdate(current, parsed);
      this.validate(fields, id);
      return this.definitions.update(id, parsed.expectedRevision, fields, timestamp);
    });
    if (result.status === "missing") throw agentDefinitionError("AGENT_DEFINITION_NOT_FOUND", `Agent definition ${id} was not found.`, 404);
    if (result.status === "revision-conflict") {
      throw Object.assign(
        agentDefinitionError("AGENT_DEFINITION_REVISION_CONFLICT", "Agent definition changed since it was read.", 409),
        { details: { code: "AGENT_DEFINITION_REVISION_CONFLICT", expectedRevision: parsed.expectedRevision, actualRevision: result.definition.revision } },
      );
    }
    this.emit("updated", result.definition);
    return result.definition;
  }

  /** 保留其它定义里的稳定引用，使缺失目标可以从权威关系确定性投影并由用户显式修复。 */
  delete(id: string): boolean {
    const existing = this.get(id);
    if (!this.definitions.transaction(() => this.definitions.delete(id))) return false;
    this.emit("deleted", existing);
    return true;
  }

  private emit(change: "created" | "updated" | "deleted", definition: AgentDefinition) {
    this.publish?.("agent.definition.changed", { agentId: definition.id, change, revision: definition.revision, definition }, {});
  }

  private validate(fields: AgentDefinitionFields, selfId: string) {
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
    this.requireCallableTargets(fields.callableAgentIds, selfId);
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

  private requireCallableTargets(callableAgentIds: string[], selfId: string) {
    const unique = [...new Set(callableAgentIds)];
    for (const callableAgentId of unique) {
      if (callableAgentId === selfId) {
        throw agentDefinitionError("AGENT_DEFINITION_SELF_REFERENCE", "An Agent definition cannot call itself.", 409);
      }
      if (!this.definitions.get(callableAgentId)) {
        throw agentDefinitionError("AGENT_DEFINITION_CALLABLE_TARGET_UNKNOWN", `Callable Agent ${callableAgentId} was not found on this Node Agent.`, 409);
      }
    }
    const edges = this.definitions.callableEdges(selfId);
    edges.set(selfId, unique);
    const cycle = findCallableCycle(edges, selfId);
    if (!cycle) return;
    throw Object.assign(
      agentDefinitionError("AGENT_DEFINITION_CYCLE", `Callable Agents would form a cycle: ${cycle.join(" -> ")}.`, 409),
      { details: { code: "AGENT_DEFINITION_CYCLE", cycle } },
    );
  }
}

/**
 * 环检测只看本 Node 的权威出边集合：从 start 的每条出边出发做 DFS，判断能否回到 start。
 * 返回的环路包含起点与终点，供调用方直接展示引用链。
 */
export function findCallableCycle(edges: Map<string, string[]>, start: string): string[] | undefined {
  for (const successor of edges.get(start) ?? []) {
    const path = [start, successor];
    const visited = new Set(path);
    const walk = (node: string): boolean => {
      for (const next of edges.get(node) ?? []) {
        if (next === start) {
          path.push(start);
          return true;
        }
        if (visited.has(next)) continue;
        visited.add(next);
        path.push(next);
        if (walk(next)) return true;
        path.pop();
      }
      return false;
    };
    if (walk(successor)) return path;
  }
  return undefined;
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
    callableAgentIds: [...new Set(input.callableAgentIds)],
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
    callableAgentIds: input.callableAgentIds === undefined ? current.callableAgentIds : [...new Set(input.callableAgentIds)],
  };
}

export function agentDefinitionError(code: AgentDefinitionErrorCode, message: string, statusCode: number) {
  if (!AGENT_DEFINITION_ERROR_CODES.includes(code)) throw new Error(`Unknown Agent definition error code ${code}.`);
  return Object.assign(new Error(message), { code, statusCode });
}
