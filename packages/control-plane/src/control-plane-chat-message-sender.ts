import type {
  ChatGatewayMessage,
  ChatSessionBinding,
  ControlledInstance,
  Project,
} from "@task-handoff/protocol/control-plane";
import type { AiSessionActionResult, AiSessionMessageAttachment } from "@task-handoff/protocol/ai-sessions";
import {
  aiSessionActionProviderTurnId,
  aiSessionActionTurnId,
} from "./control-plane-chat-rendering.ts";
import type { ControlPlaneChatTargetResolver } from "./control-plane-chat-targets.ts";
import type { ChatAiSessionActionDeps, ChatInstanceLookupDeps, ChatProjectLookupDeps, ChatSessionStoreDeps } from "./control-plane-chat-types.ts";
import { publicInstanceWithAccess, publicProject } from "./public-records.ts";
import { errorMessage, isMissingAiSessionError } from "./service-helpers.ts";

export type ControlPlaneChatMessageSenderDeps = ChatSessionStoreDeps & ChatInstanceLookupDeps & Pick<ChatProjectLookupDeps, "requireProject"> & Pick<ChatAiSessionActionDeps, "sendAiSessionMessage">;

export class ControlPlaneChatMessageSender {
  private readonly deps: ControlPlaneChatMessageSenderDeps;
  private readonly targets: ControlPlaneChatTargetResolver;

  constructor(deps: ControlPlaneChatMessageSenderDeps, targets: ControlPlaneChatTargetResolver) {
    this.deps = deps;
    this.targets = targets;
  }

  async forwardChatMessage(binding: ChatSessionBinding, input: ChatGatewayMessage) {
    const targetInstanceId = input.target?.instanceId || binding.activeInstanceId || "";
    const targetAiSessionId = input.target?.aiSessionId || binding.activeAiSessionId;
    const instance = await this.deps.requireControlledInstance(targetInstanceId, true) as ControlledInstance;
    const project = instance.projectId ? this.deps.requireProject(instance.projectId) : undefined;
    if (instance.connectionStatus !== "online") {
      const error = new Error(`Instance ${instance.name} is not reachable.`);
      Object.assign(error, { statusCode: 409, code: "CHAT_TARGET_UNREACHABLE" });
      throw error;
    }
    if (targetAiSessionId) {
      const sent = await this.trySendAiSessionMessage(binding, instance.id, targetAiSessionId, input.message.text, input.message.attachments, !input.target);
      if (!sent.ok) {
        return this.failedSendResult(sent.binding, project, instance, sent.reply);
      }
      return this.sentResult(binding, project, instance, targetAiSessionId, sent.aiSession);
    }

    const defaultAiSessionId = await this.targets.defaultAiSessionIdForInstance(instance.id);
    if (defaultAiSessionId) {
      const updated = this.deps.upsertChatSession({ ...binding, activeAiSessionId: defaultAiSessionId });
      const sent = await this.trySendAiSessionMessage(updated, instance.id, defaultAiSessionId, input.message.text, input.message.attachments);
      if (!sent.ok) {
        return this.failedSendResult(sent.binding, project, instance, sent.reply);
      }
      return this.sentResult(updated, project, instance, defaultAiSessionId, sent.aiSession);
    }

    return {
      accepted: false,
      routed: false,
      binding,
      project: project ? publicProject(project) : undefined,
      instance: publicInstanceWithAccess(instance),
      reply: `No active AI session is selected for ${instance.name}. Use /sessions and /session <id> first.`,
    };
  }

  private async trySendAiSessionMessage(binding: ChatSessionBinding, instanceId: string, sessionId: string, message: string, attachments: AiSessionMessageAttachment[] = [], clearMissingBinding = true) {
    try {
      return {
        ok: true as const,
        binding,
        aiSession: await this.deps.sendAiSessionMessage(instanceId, sessionId, message || "请查看附件图片。", undefined, attachments),
      };
    } catch (error) {
      if (isMissingAiSessionError(error)) {
        const updated = clearMissingBinding ? this.deps.upsertChatSession({ ...binding, activeAiSessionId: undefined }) : binding;
        return {
          ok: false as const,
          binding: updated,
          reply: `The selected AI session ${sessionId} no longer exists. Use /session to choose an active AI session.`,
        };
      }
      return {
        ok: false as const,
        binding,
        reply: `Failed to send to AI session ${sessionId}: ${errorMessage(error)}`,
      };
    }
  }

  private failedSendResult(binding: ChatSessionBinding, project: Project | undefined, instance: ControlledInstance, reply: string) {
    return {
      accepted: false,
      routed: false,
      binding,
      project: project ? publicProject(project) : undefined,
      instance: publicInstanceWithAccess(instance),
      reply,
    };
  }

  private sentResult(binding: ChatSessionBinding, project: Project | undefined, instance: ControlledInstance, sessionId: string, aiSession: AiSessionActionResult) {
    return {
      accepted: true,
      routed: true,
      binding,
      project: project ? publicProject(project) : undefined,
      instance: publicInstanceWithAccess(instance),
      aiSession,
      instanceId: instance.id,
      aiSessionId: sessionId,
      turnId: aiSessionActionTurnId(aiSession),
      providerTurnId: aiSessionActionProviderTurnId(aiSession),
      reply: `Sent to ${project?.name || instance.sourceSnapshot.name || "Source"} / ${instance.name} / ${sessionId}.`,
    };
  }
}
