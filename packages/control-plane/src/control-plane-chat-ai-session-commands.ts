import type { ChatSessionBinding, ControlledInstance } from "@task-handoff/protocol/control-plane";
import { createSingleColumnKeyboard } from "@task-handoff/core/core/chat-interactions";
import {
  aiSessionButtonText,
  renderAiSessionChoiceLine,
} from "./ai-session-presentation.ts";
import type { ControlPlaneChatTargetResolver } from "./control-plane-chat-targets.ts";
import type { ChatAiSessionActionDeps, ChatInstanceLookupDeps, ChatProjectLookupDeps, ChatSessionStoreDeps } from "./control-plane-chat-types.ts";
import { publicInstanceWithAccess } from "./public-records.ts";

export type ControlPlaneChatAiSessionCommandDeps = ChatSessionStoreDeps & Pick<ChatProjectLookupDeps, "getProject"> & Pick<ChatInstanceLookupDeps, "requireControlledInstance"> & Pick<ChatAiSessionActionDeps, "interruptAiSession">;

export class ControlPlaneChatAiSessionCommands {
  private readonly deps: ControlPlaneChatAiSessionCommandDeps;
  private readonly targets: ControlPlaneChatTargetResolver;

  constructor(deps: ControlPlaneChatAiSessionCommandDeps, targets: ControlPlaneChatTargetResolver) {
    this.deps = deps;
    this.targets = targets;
  }

  async handleAiSessionsCommand(binding: ChatSessionBinding) {
    const choices = await this.targets.aiSessionChoices(binding);
    const active = choices.find((choice) => choice.active);
    const lines = choices.map((choice) => renderAiSessionChoiceLine(choice));
    return {
      accepted: true,
      routed: false,
      binding,
      instances: choices.map((choice) => choice.instance),
      reply: choices.length
        ? [
            "Select AI session",
            `Current ${active ? `${active.projectName} / ${active.instance.name} / ${active.session.id}` : await this.targets.renderChatTarget(binding)}, total ${choices.length}`,
            "",
            ...lines,
          ].join("\n")
        : "No AI sessions found.",
      replyMarkup: choices.length
        ? createSingleColumnKeyboard(
            choices.map((choice) => ({
              text: `${choice.active ? "✓ " : ""}${aiSessionButtonText(choice)}`,
              callbackData: `task_handoff:cp_session:${choice.index}`,
            })),
          )
        : undefined,
    };
  }

  async handleAiSessionCommand(binding: ChatSessionBinding, args: string[]) {
    const sessionId = String(args[0] || "").trim();
    if (!sessionId) {
      return this.handleAiSessionsCommand(binding);
    }
    const match = await this.targets.findAiSession(sessionId);
    if (!match) {
      return {
        accepted: false,
        routed: false,
        binding,
        reply: `AI session ${sessionId} was not found. Try /sessions.`,
      };
    }
    const project = match.instance.projectId ? this.deps.getProject(match.instance.projectId) : undefined;
    const updated = this.deps.upsertChatSession({
      ...binding,
      activeProjectId: project?.id || binding.activeProjectId,
      activeInstanceId: match.instance.id,
      activeAiSessionId: match.session.id,
    });
    return {
      accepted: true,
      routed: false,
      binding: updated,
      instance: match.instance,
      aiSession: match.session,
      reply: `Active AI session: ${match.instance.name} / ${match.session.agent} ${match.session.id}`,
    };
  }

  async handleAiSessionIndexAction(binding: ChatSessionBinding, index: number) {
    const choices = await this.targets.aiSessionChoices(binding);
    const choice = choices.find((entry) => entry.index === index);
    if (!choice) {
      return {
        accepted: false,
        routed: false,
        binding,
        reply: "AI session was not found. Use /session to refresh the list.",
        replyMarkup: undefined,
      };
    }
    const updated = this.deps.upsertChatSession({
      ...binding,
      activeProjectId: choice.projectId || binding.activeProjectId,
      activeInstanceId: choice.instance.id,
      activeAiSessionId: choice.session.id,
    });
    const refreshed = await this.handleAiSessionsCommand(updated);
    return {
      ...refreshed,
      accepted: true,
      binding: updated,
      instance: choice.instance,
      aiSession: choice.session,
      message: `selected ${choice.session.id}`,
      reply: [
        `Current chat is bound to AI session ${choice.session.id}`,
        "",
        refreshed.reply,
      ].join("\n"),
    };
  }

  async handleAiSessionInterruptCommand(binding: ChatSessionBinding) {
    if (!binding.activeInstanceId || !binding.activeAiSessionId) {
      return {
        accepted: false,
        routed: false,
        binding,
        reply: "No active AI session is selected. Use /sessions and /session <id> first.",
      };
    }
    const instance = await this.deps.requireControlledInstance(binding.activeInstanceId, true) as ControlledInstance;
    const aiSession = await this.deps.interruptAiSession(instance.id, binding.activeAiSessionId);
    return {
      accepted: true,
      routed: true,
      binding,
      instance: publicInstanceWithAccess(instance),
      aiSession,
      reply: `Interrupt sent to ${instance.name} / ${binding.activeAiSessionId}.`,
    };
  }
}
