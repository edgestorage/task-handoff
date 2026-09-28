import {
  AGENT_DEFINITION_CHANGED_EVENT_TYPE,
  AgentDefinitionChangedEventSchema,
  type AgentDefinition,
  type AgentDefinitionChangedEvent,
} from "@task-handoff/protocol/agent-definitions";
import {
  AGENT_RUN_CHANGED_EVENT_TYPE,
  AGENT_RUN_MEMBER_CHANGED_EVENT_TYPE,
  AgentRunChangedEventSchema,
  AgentRunMemberChangedEventSchema,
  type AgentRun,
  type AgentRunMember,
} from "@task-handoff/protocol/agent-runs";
import {
  AGENT_ORCHESTRATION_CHANGED_EVENT_TYPE,
  AgentOrchestrationChangedEventSchema,
  type AgentOrchestration,
  type AgentOrchestrationChangedEvent,
} from "@task-handoff/protocol/agent-orchestrations";

export type AgentRunCallTreeNode = { member: AgentRunMember; children: AgentRunCallTreeNode[] };

/** In-memory projection only. Node Agent remains the sole persistence and mutation authority. */
export class ControlPlaneAgentAggregator {
  private readonly definitions = new Map<string, Map<string, AgentDefinition>>();
  private readonly orchestrations = new Map<string, Map<string, AgentOrchestration>>();
  private readonly runs = new Map<string, Map<string, AgentRun>>();

  replaceDefinitions(nodeId: string, definitions: AgentDefinition[]) {
    this.definitions.set(nodeId, new Map(definitions.map((definition) => [definition.id, definition])));
  }

  replaceOrchestrations(nodeId: string, orchestrations: AgentOrchestration[]) {
    this.orchestrations.set(nodeId, new Map(orchestrations.map((orchestration) => [orchestration.id, orchestration])));
  }

  storeOrchestration(nodeId: string, orchestration: AgentOrchestration) {
    const orchestrations = this.orchestrations.get(nodeId) ?? new Map<string, AgentOrchestration>();
    orchestrations.set(orchestration.id, orchestration);
    this.orchestrations.set(nodeId, orchestrations);
  }

  removeOrchestration(nodeId: string, orchestrationId: string) {
    this.orchestrations.get(nodeId)?.delete(orchestrationId);
  }

  orchestrationsForNode(nodeId: string) {
    return [...(this.orchestrations.get(nodeId)?.values() ?? [])];
  }

  replaceRuns(nodeId: string, runs: AgentRun[]) {
    this.runs.set(nodeId, new Map(runs.map((run) => [run.runId, run])));
  }

  storeDefinition(nodeId: string, definition: AgentDefinition) {
    const definitions = this.definitions.get(nodeId) ?? new Map<string, AgentDefinition>();
    definitions.set(definition.id, definition);
    this.definitions.set(nodeId, definitions);
  }

  removeDefinition(nodeId: string, agentId: string) {
    this.definitions.get(nodeId)?.delete(agentId);
  }

  storeRun(nodeId: string, run: AgentRun) {
    const runs = this.runs.get(nodeId) ?? new Map<string, AgentRun>();
    runs.set(run.runId, run);
    this.runs.set(nodeId, runs);
  }

  definitionsForNode(nodeId: string) {
    return [...(this.definitions.get(nodeId)?.values() ?? [])];
  }

  runsForNode(nodeId: string) {
    return [...(this.runs.get(nodeId)?.values() ?? [])];
  }

  removeNode(nodeId: string) {
    this.definitions.delete(nodeId);
    this.orchestrations.delete(nodeId);
    this.runs.delete(nodeId);
  }

  handleEvent(nodeId: string, type: string, payload: unknown): AgentDefinitionChangedEvent | AgentOrchestrationChangedEvent | zRunEvent | undefined {
    if (type === AGENT_DEFINITION_CHANGED_EVENT_TYPE) {
      const event = AgentDefinitionChangedEventSchema.safeParse(payload);
      if (!event.success) return undefined;
      const definitions = this.definitions.get(nodeId) ?? new Map<string, AgentDefinition>();
      if (event.data.change === "deleted") definitions.delete(event.data.agentId);
      else if (event.data.definition) definitions.set(event.data.agentId, event.data.definition);
      this.definitions.set(nodeId, definitions);
      return event.data;
    }
    if (type === AGENT_ORCHESTRATION_CHANGED_EVENT_TYPE) {
      const event = AgentOrchestrationChangedEventSchema.safeParse(payload);
      if (!event.success) return undefined;
      const orchestrations = this.orchestrations.get(nodeId) ?? new Map<string, AgentOrchestration>();
      if (event.data.change === "deleted") orchestrations.delete(event.data.orchestrationId);
      else if (event.data.orchestration) orchestrations.set(event.data.orchestration.id, event.data.orchestration);
      this.orchestrations.set(nodeId, orchestrations);
      return event.data;
    }
    if (type === AGENT_RUN_CHANGED_EVENT_TYPE) {
      const event = AgentRunChangedEventSchema.safeParse(payload);
      if (!event.success) return undefined;
      const runs = this.runs.get(nodeId) ?? new Map<string, AgentRun>();
      const current = runs.get(event.data.runId);
      if (!current || event.data.revision >= current.revision) runs.set(event.data.runId, event.data.run);
      this.runs.set(nodeId, runs);
      return event.data;
    }
    if (type === AGENT_RUN_MEMBER_CHANGED_EVENT_TYPE) {
      const event = AgentRunMemberChangedEventSchema.safeParse(payload);
      if (!event.success) return undefined;
      const run = this.runs.get(nodeId)?.get(event.data.runId);
      if (!run || event.data.revision < run.revision) return event.data;
      const members = [...(run.members ?? [])];
      const index = members.findIndex((member) => member.memberId === event.data.memberId);
      if (index >= 0) members[index] = event.data.member;
      else members.push(event.data.member);
      this.runs.get(nodeId)?.set(run.runId, { ...run, revision: event.data.revision, members });
      return event.data;
    }
    return undefined;
  }
}

type zRunEvent = ReturnType<typeof AgentRunChangedEventSchema.parse> | ReturnType<typeof AgentRunMemberChangedEventSchema.parse>;

export function deriveAgentRunCallTree(run: AgentRun): AgentRunCallTreeNode[] {
  const nodes = new Map((run.members ?? []).map((member) => [member.memberId, { member, children: [] } satisfies AgentRunCallTreeNode]));
  const roots: AgentRunCallTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.member.parentMemberId ? nodes.get(node.member.parentMemberId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
