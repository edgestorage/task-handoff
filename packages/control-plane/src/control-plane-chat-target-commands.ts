import type { ChatSessionBinding } from "@task-handoff/protocol/control-plane";
import type {
  ChatBoardDeps,
  ChatInstanceLookupDeps,
  ChatProjectLookupDeps,
  ChatSessionStoreDeps,
} from "./control-plane-chat-types.ts";
import type { ControlPlaneChatTargetResolver } from "./control-plane-chat-targets.ts";

export type ControlPlaneChatTargetCommandDeps =
  & ChatSessionStoreDeps
  & ChatBoardDeps
  & Pick<ChatInstanceLookupDeps, "requireControlledInstance">
  & Pick<ChatProjectLookupDeps, "requireProject">;

export class ControlPlaneChatTargetCommands {
  private readonly deps: ControlPlaneChatTargetCommandDeps;
  private readonly targets: ControlPlaneChatTargetResolver;

  constructor(deps: ControlPlaneChatTargetCommandDeps, targets: ControlPlaneChatTargetResolver) {
    this.deps = deps;
    this.targets = targets;
  }

  async handleUseCommand(binding: ChatSessionBinding, args: string[]) {
    if (args.length === 0) {
      return {
        accepted: true,
        routed: false,
        binding,
        instances: await this.targets.instancesForBinding(binding),
        reply: await this.targets.renderUseHelp(binding),
      };
    }

    if (args.length >= 2) {
      const project = this.targets.resolveProject(args[0]);
      const instance = await this.targets.resolveInstance(args[1], project.id);
      const updated = this.deps.upsertChatSession({
        ...binding,
        activeProjectId: project.id,
        activeInstanceId: instance.id,
        activeAiSessionId: await this.targets.defaultAiSessionIdForInstance(instance.id),
      });
      return {
        accepted: true,
        routed: false,
        binding: updated,
        reply: await this.targets.renderTargetSelected(updated),
      };
    }

    const target = args[0];
    const instance = await this.targets.findInstance(target);
    if (instance) {
      const project = instance.projectId ? this.deps.requireProject(instance.projectId) : undefined;
      const updated = this.deps.upsertChatSession({
        ...binding,
        activeProjectId: project?.id,
        activeInstanceId: instance.id,
        activeAiSessionId: await this.targets.defaultAiSessionIdForInstance(instance.id),
      });
      return {
        accepted: true,
        routed: false,
        binding: updated,
        reply: await this.targets.renderTargetSelected(updated),
      };
    }

    const project = this.targets.resolveProject(target);
    const projectInstances = (await this.deps.boardAsync()).filter((item) => item.projectId === project.id);
    const available = projectInstances.filter((item) => item.status === "running" && item.connectionStatus === "online");
    if (available.length === 1) {
      const updated = this.deps.upsertChatSession({
        ...binding,
        activeProjectId: project.id,
        activeInstanceId: available[0].id,
        activeAiSessionId: await this.targets.defaultAiSessionIdForInstance(available[0].id),
      });
      return {
        accepted: true,
        routed: false,
        binding: updated,
        reply: await this.targets.renderTargetSelected(updated),
      };
    }

    const updated = this.deps.upsertChatSession({
      ...binding,
      activeProjectId: project.id,
      activeInstanceId: undefined,
      activeAiSessionId: undefined,
    });
    return {
      accepted: true,
      routed: false,
      binding: updated,
      instances: projectInstances,
      reply: `${project.name} selected. Choose an instance with /use ${project.id} <instance-id-or-name>.\n${this.targets.renderInstanceLines(projectInstances)}`,
    };
  }

  async handleProjectCommand(binding: ChatSessionBinding, args: string[]) {
    if (args.length === 0) {
      return {
        accepted: false,
        routed: false,
        binding,
        reply: "Usage: /project <project-id-or-name>",
      };
    }
    const project = this.targets.resolveProject(args[0]);
    const activeInstance = binding.activeInstanceId ? await this.deps.requireControlledInstance(binding.activeInstanceId).catch(() => undefined) : undefined;
    const updated = this.deps.upsertChatSession({
      ...binding,
      activeProjectId: project.id,
      activeInstanceId: activeInstance?.projectId === project.id ? activeInstance.id : undefined,
      activeAiSessionId: activeInstance?.projectId === project.id ? binding.activeAiSessionId : undefined,
    });
    return {
      accepted: true,
      routed: false,
      binding: updated,
      reply: `Active project: ${project.name}${updated.activeInstanceId ? "" : ". Choose an instance with /use."}`,
    };
  }
}
