import type {
  ChatSessionBinding,
} from "@task-handoff/protocol/control-plane";
import type { AiSessionsSnapshot } from "@task-handoff/protocol/ai-sessions";
import {
  aiSessionPriority,
  aiSessionStableSortKey,
  visibleAiSessionsForBoardInstance,
} from "./ai-session-presentation.ts";
import type {
  ChatAiSessionSnapshotDeps,
  ChatAppSessionSnapshotDeps,
  ChatBoardDeps,
  ChatBoardInstance,
  ChatInstanceLookupDeps,
  ChatProjectLookupDeps,
} from "./control-plane-chat-types.ts";
import { throwNotFound } from "./service-helpers.ts";

export type ControlPlaneChatTargetDeps = ChatBoardDeps & ChatAiSessionSnapshotDeps & ChatAppSessionSnapshotDeps & ChatInstanceLookupDeps & ChatProjectLookupDeps;
type ChatBoardInstanceWithAiSessions = Omit<ChatBoardInstance, "aiSessions"> & { aiSessions: AiSessionsSnapshot };

export class ControlPlaneChatTargetResolver {
  private readonly deps: ControlPlaneChatTargetDeps;

  constructor(deps: ControlPlaneChatTargetDeps) {
    this.deps = deps;
  }

  async instancesForBinding(binding: Pick<ChatSessionBinding, "activeProjectId">) {
    const instances = await this.deps.boardAsync();
    return binding.activeProjectId ? instances.filter((item) => item.projectId === binding.activeProjectId) : instances;
  }

  async fullInstancesForBinding(binding: Pick<ChatSessionBinding, "activeProjectId">) {
    const instances = await this.deps.listNodeInstances();
    return binding.activeProjectId ? instances.filter((item) => item.projectId === binding.activeProjectId) : instances;
  }

  async renderUseHelp(binding: ChatSessionBinding) {
    return `Active target: ${await this.renderChatTarget(binding)}\nUse /instances to list targets, then /use <instance-id-or-name>. Use /sessions to choose an AI session when there is more than one.`;
  }

  async renderChatStatus(binding: ChatSessionBinding) {
    const instance = binding.activeInstanceId ? (await this.deps.boardAsync()).find((item) => item.id === binding.activeInstanceId) : undefined;
    if (!instance) {
      return `Active target: ${await this.renderChatTarget(binding)}`;
    }
    return `Active target: ${await this.renderChatTarget(binding)}\nStatus: ${instance.status}, connection: ${instance.connectionStatus}, pending: ${instance.receiver.pendingCount}`;
  }

  async renderChatHelp(binding: ChatSessionBinding) {
    return [
      "TaskHandoff chat commands:",
      "/help - show this help",
      "/status or /target - show the active project, instance, and AI session",
      "/instances - list controlled instances",
      "/apps - list app sessions",
      "/use <instance-id-or-name> - choose an active instance",
      "/use <project-id-or-name> <instance-id-or-name> - choose a project and instance",
      "/project <project-id-or-name> - narrow instance selection to a project",
      "/sessions - list all AI sessions",
      "/session <ai-session-id> - choose an active AI session",
      "/pending - list waiting approvals",
      "/approve <instance-id:pending-id>, /deny <...>, /skip <...> - answer approvals",
      "/reply <instance-id:pending-id> <message> - reply to a waiting session",
      "/cancel - interrupt the active AI session",
      "",
      "Send normal text after selecting a target; if there is only one AI session, it is selected automatically.",
      `Current target: ${await this.renderChatTarget(binding)}`,
    ].join("\n");
  }

  renderInstanceLines(instances: ChatBoardInstance[]) {
    return instances.map((instance) => `${instance.name} (${instance.id}) - ${instance.status}/${instance.connectionStatus}`).join("\n");
  }

  async renderChatTarget(binding: ChatSessionBinding) {
    const project = binding.activeProjectId ? this.deps.getProject(binding.activeProjectId) : undefined;
    const instance = binding.activeInstanceId ? await this.deps.requireControlledInstance(binding.activeInstanceId).catch(() => undefined) : undefined;
    const aiSession = binding.activeAiSessionId || "none";
    return `${project?.name || binding.activeProjectId || "none"} / ${instance?.name || binding.activeInstanceId || "none"} / ${aiSession}`;
  }

  async renderTargetSelected(binding: ChatSessionBinding) {
    const target = await this.renderChatTarget(binding);
    if (binding.activeAiSessionId) {
      return `Active target: ${target}`;
    }
    return `Active target: ${target}\nNo AI session selected yet. Use /sessions and /session <id>, or send a message once exactly one session is available.`;
  }

  async defaultAiSessionIdForInstance(instanceId: string) {
    const snapshot = await this.aiSessionSnapshotForInstance(instanceId);
    const boardInstance = (await this.deps.boardAsync()).find((entry) => entry.id === instanceId);
    const appSessionEntry = (await this.deps.listAppSessions()).instances.find((entry) => entry.instanceId === instanceId);
    const instanceWithAppSessions = boardInstance
      ? { ...boardInstance, apps: { ...boardInstance.apps, sessions: appSessionEntry?.appSessions.sessions || [] } }
      : undefined;
    const sessions = snapshot && boardInstance
      ? visibleAiSessionsForBoardInstance({ ...instanceWithAppSessions, aiSessions: snapshot })
      : snapshot?.sessions || [];
    return sessions.length === 1 ? sessions[0].id : undefined;
  }

  async aiSessionChoices(binding: Pick<ChatSessionBinding, "activeInstanceId" | "activeProjectId" | "activeAiSessionId">) {
    const instances = await this.boardInstancesForBinding({}, { refresh: true });
    return instances.flatMap((instance) => (
      visibleAiSessionsForBoardInstance(instance).map((session) => ({
        index: 0,
        projectId: instance.projectId,
        projectName: instance.project?.name || (typeof instance.sourceSnapshot.name === "string" ? instance.sourceSnapshot.name : "Source"),
        instance,
        session,
        active: binding.activeInstanceId === instance.id && binding.activeAiSessionId === session.id,
      }))
    )).sort((a, b) => {
      const priorityDelta = aiSessionPriority(b.session) - aiSessionPriority(a.session);
      if (priorityDelta) {
        return priorityDelta;
      }
      const instanceDelta = String(a.instance.name || "").localeCompare(String(b.instance.name || "")) || a.instance.id.localeCompare(b.instance.id);
      return instanceDelta || aiSessionStableSortKey(a.session).localeCompare(aiSessionStableSortKey(b.session));
    }).map((choice, index) => ({ ...choice, index }));
  }

  async boardInstancesForBinding(binding: Pick<ChatSessionBinding, "activeProjectId">, options: { refresh?: boolean } = {}): Promise<ChatBoardInstanceWithAiSessions[]> {
    const boardInstances = await this.deps.boardAsync();
    const aiSessions = await this.deps.listAiSessions(options);
    const appSessions = await this.deps.listAppSessions(options);
    const snapshots = new Map(aiSessions.instances.map((entry) => [entry.instanceId, entry.aiSessions]));
    const appSnapshots = new Map(appSessions.instances.map((entry) => [entry.instanceId, entry.appSessions]));
    const merged: ChatBoardInstanceWithAiSessions[] = boardInstances.map((instance) => ({
      ...instance,
      apps: {
        ...instance.apps,
        sessions: appSnapshots.get(instance.id)?.sessions || [],
      },
      aiSessions: snapshots.get(instance.id) || emptyAiSessionsSnapshot(instance.aiSessions.updatedAt),
    }));
    return binding.activeProjectId ? merged.filter((item) => item.projectId === binding.activeProjectId) : merged;
  }

  async findAiSession(sessionId: string) {
    const instances = await this.boardInstancesForBinding({}, { refresh: true });
    for (const instance of instances) {
      const match = (instance.aiSessions?.sessions || []).find((session) => session.id === sessionId || session.providerSessionId === sessionId);
      if (match) {
        return { instance, session: match };
      }
    }
    return undefined;
  }

  private async aiSessionSnapshotForInstance(instanceId: string) {
    const aiSessions = await this.deps.listAiSessions();
    return aiSessions.instances.find((entry) => entry.instanceId === instanceId)?.aiSessions;
  }

  resolveProject(value: string) {
    const project = this.deps.getProject(value) || this.deps.listProjects().find((entry) => entry.name === value);
    if (!project) {
      throwNotFound("PROJECT_NOT_FOUND", `Project ${value} was not found.`);
    }
    return project;
  }

  async resolveInstance(value: string, projectId?: string) {
    const instance = await this.findInstance(value, projectId);
    if (!instance) {
      throwNotFound("CONTROLLED_INSTANCE_NOT_FOUND", `Controlled instance ${value} was not found.`);
    }
    return instance;
  }

  async findInstance(value: string, projectId?: string) {
    return (await this.deps.listNodeInstances()).find((entry) => (entry.id === value || entry.name === value) && (!projectId || entry.projectId === projectId));
  }
}

function emptyAiSessionsSnapshot(updatedAt: string): AiSessionsSnapshot {
  return {
    runningCount: 0,
    waitingCount: 0,
    staleCount: 0,
    sessions: [],
    updatedAt,
  };
}
