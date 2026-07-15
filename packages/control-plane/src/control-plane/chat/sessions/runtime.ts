import {
  ChatGatewayMessageSchema,
  type ChatGatewayMessage,
  type ChatSessionBinding,
} from "@task-handoff/protocol/control-plane";
import { normalizeChatCommand } from "../../common/helpers.ts";
import { ControlPlaneChatAiSessionCommands } from "../commands/ai-session.ts";
import { ControlPlaneChatAppCommands } from "../commands/app.ts";
import { ControlPlaneChatMessageSender } from "../message-sender.ts";
import { ControlPlaneChatPendingCommands } from "../commands/pending.ts";
import { ControlPlaneChatTargetCommands } from "../commands/target.ts";
import { ControlPlaneChatTargetResolver } from "../target-resolver.ts";
import type {
  ChatAiSessionActionDeps,
  ChatAiSessionSnapshotDeps,
  ChatAppSessionSnapshotDeps,
  ChatAppAccessDeps,
  ChatBoardDeps,
  ChatInstanceLookupDeps,
  ChatPendingDeps,
  ChatProjectLookupDeps,
  ChatSessionStoreDeps,
} from "../types.ts";

type ControlPlaneChatSessionRuntimeDeps =
  & ChatSessionStoreDeps
  & ChatBoardDeps
  & ChatAiSessionSnapshotDeps
  & ChatAppSessionSnapshotDeps
  & ChatInstanceLookupDeps
  & ChatProjectLookupDeps
  & ChatPendingDeps
  & ChatAiSessionActionDeps
  & ChatAppAccessDeps;

export class ControlPlaneChatSessionRuntime {
  private readonly deps: ControlPlaneChatSessionRuntimeDeps;
  private readonly targets: ControlPlaneChatTargetResolver;
  private readonly sender: ControlPlaneChatMessageSender;
  private readonly appCommands: ControlPlaneChatAppCommands;
  private readonly pendingCommands: ControlPlaneChatPendingCommands;
  private readonly aiSessionCommands: ControlPlaneChatAiSessionCommands;
  private readonly targetCommands: ControlPlaneChatTargetCommands;

  constructor(deps: ControlPlaneChatSessionRuntimeDeps) {
    this.deps = deps;
    this.targets = new ControlPlaneChatTargetResolver(deps);
    this.sender = new ControlPlaneChatMessageSender(deps, this.targets);
    this.appCommands = new ControlPlaneChatAppCommands(deps, this.targets);
    this.pendingCommands = new ControlPlaneChatPendingCommands(deps);
    this.aiSessionCommands = new ControlPlaneChatAiSessionCommands(deps, this.targets);
    this.targetCommands = new ControlPlaneChatTargetCommands(deps, this.targets);
  }

  async handleChatGatewayMessage(input: ChatGatewayMessage) {
    const parsed = ChatGatewayMessageSchema.parse(input);
    const binding = this.deps.upsertChatSession({
      channel: parsed.source.channel,
      bridgeId: parsed.source.bridgeId,
      chatSessionId: parsed.source.chatSessionId,
      userId: parsed.source.userId,
    });
    const text = parsed.message.text.trim();
    if (text.startsWith("/")) {
      return this.handleChatCommand(binding, text);
    }
    if (!text && !parsed.message.attachments.length) {
      return {
        accepted: false,
        routed: false,
        binding,
        reply: "",
      };
    }
    if (!binding.activeInstanceId) {
      return {
        accepted: false,
        routed: false,
        binding,
        reply: await this.targets.renderUseHelp(binding),
      };
    }
    return this.sender.forwardChatMessage(binding, parsed);
  }

  async handleChatGatewayAction(input: {
    source: {
      channel: ChatSessionBinding["channel"];
      bridgeId?: string;
      chatSessionId: string;
      userId?: string;
    };
    action: {
      type: "ai-session";
      index: number;
    } | {
      type: "instance-app-menu";
      instanceId: string;
    } | {
      type: "launch-app";
      instanceId: string;
      appId: string;
    } | {
      type: "pending-decision";
      routeId: string;
      decision: "allow" | "deny" | "skip";
    };
  }) {
    const binding = this.deps.upsertChatSession({
      channel: input.source.channel,
      bridgeId: input.source.bridgeId,
      chatSessionId: input.source.chatSessionId,
      userId: input.source.userId,
    });
    if (input.action.type === "ai-session") {
      return this.aiSessionCommands.handleAiSessionIndexAction(binding, input.action.index);
    }
    if (input.action.type === "instance-app-menu") {
      return this.appCommands.handleInstanceAppMenuAction(binding, input.action.instanceId);
    }
    if (input.action.type === "launch-app") {
      return this.appCommands.handleLaunchAppAction(binding, input.action.instanceId, input.action.appId);
    }
    if (input.action.type === "pending-decision") {
      return this.pendingCommands.handlePendingDecisionCommand(binding, [input.action.routeId], input.action.decision);
    }
    return {
      accepted: false,
      routed: false,
      binding,
      reply: "Unknown action.",
    };
  }

  async handleChatCommand(binding: ChatSessionBinding, text: string) {
    const [rawCommand = "", ...args] = text.split(/\s+/);
    const command = normalizeChatCommand(rawCommand);
    switch (command.toLowerCase()) {
      case "/help":
      case "/start":
        return {
          accepted: true,
          routed: false,
          binding,
          reply: await this.targets.renderChatHelp(binding),
        };
      case "/sessions":
        return this.aiSessionCommands.handleAiSessionsCommand(binding);
      case "/session":
        return this.aiSessionCommands.handleAiSessionCommand(binding, args);
      case "/cancel":
      case "/interrupt":
        return this.aiSessionCommands.handleAiSessionInterruptCommand(binding);
      case "/pending":
        return this.pendingCommands.handlePendingCommand(binding);
      case "/approve":
        return this.pendingCommands.handlePendingDecisionCommand(binding, args, "allow");
      case "/deny":
        return this.pendingCommands.handlePendingDecisionCommand(binding, args, "deny");
      case "/skip":
        return this.pendingCommands.handlePendingDecisionCommand(binding, args, "skip");
      case "/reply":
        return this.pendingCommands.handlePendingReplyCommand(binding, args);
      case "/instances":
        return this.appCommands.handleInstancesCommand(binding);
      case "/apps":
        return this.appCommands.handleAppsCommand(binding);
      case "/use":
        return this.targetCommands.handleUseCommand(binding, args);
      case "/project":
        return this.targetCommands.handleProjectCommand(binding, args);
      case "/status":
      case "/target":
        return {
          accepted: true,
          routed: false,
          binding,
          instance: binding.activeInstanceId ? (await this.deps.boardAsync()).find((item) => item.id === binding.activeInstanceId) : undefined,
          reply: await this.targets.renderChatStatus(binding),
        };
      default:
        return {
          accepted: false,
          routed: false,
          binding,
          reply: `Unknown command: ${command || rawCommand}. Try /help.`,
        };
    }
  }

}
