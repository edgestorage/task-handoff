import type { ChatSessionBinding } from "@task-handoff/protocol/control-plane";
import {
  pendingRoutesKeyboard,
  renderPendingRouteLine,
} from "../../sessions/ai-session-presentation.ts";
import type { ChatAiSessionActionDeps, ChatPendingDeps } from "../types.ts";
import { parsePendingRouteId } from "../../common/helpers.ts";

export type ControlPlaneChatPendingCommandDeps = ChatPendingDeps & Pick<ChatAiSessionActionDeps, "sendAiSessionMessage">;

export class ControlPlaneChatPendingCommands {
  private readonly deps: ControlPlaneChatPendingCommandDeps;

  constructor(deps: ControlPlaneChatPendingCommandDeps) {
    this.deps = deps;
  }

  async handlePendingCommand(binding: ChatSessionBinding) {
    const routes = await this.deps.listPendingRoutes();
    const visible = binding.activeInstanceId ? routes.filter((route) => route.instanceId === binding.activeInstanceId) : routes;
    return {
      accepted: true,
      routed: false,
      binding,
      pending: visible,
      reply: visible.length ? visible.map(renderPendingRouteLine).join("\n") : "No pending routes.",
      replyMarkup: visible.length ? pendingRoutesKeyboard(visible as Parameters<typeof pendingRoutesKeyboard>[0], (route, decision) => this.deps.pendingDecisionCallbackData(route.id, decision)) : undefined,
    };
  }

  async handlePendingDecisionCommand(binding: ChatSessionBinding, args: string[], decision: "allow" | "deny" | "skip") {
    const route = parsePendingRouteId(args[0]);
    if (!route) {
      return {
        accepted: false,
        routed: false,
        binding,
        reply: `Usage: /${decision === "allow" ? "approve" : decision} <instance-id:pending-id>`,
      };
    }
    if (!route.aiSessionId) {
      return {
        accepted: false,
        routed: false,
        binding,
        pending: route,
        reply: "Only AI session pending routes are supported here.",
      };
    }
    const data = await this.deps.resolveAiSessionApproval(route.instanceId, route.aiSessionId, decision);
    return {
      accepted: true,
      routed: true,
      binding,
      pending: route,
      aiSession: data,
      reply: `${decision} sent for ${route.instanceId}:${route.aiSessionId}.`,
    };
  }

  async handlePendingReplyCommand(binding: ChatSessionBinding, args: string[]) {
    const route = parsePendingRouteId(args[0]);
    const markdown = args.slice(1).join(" ").trim();
    if (!route || !markdown) {
      return {
        accepted: false,
        routed: false,
        binding,
        reply: "Usage: /reply <instance-id:pending-id> <message>",
      };
    }
    if (!route.aiSessionId) {
      return {
        accepted: false,
        routed: false,
        binding,
        pending: route,
        reply: "Only AI session pending routes are supported here.",
      };
    }
    const data = await this.deps.sendAiSessionMessage(route.instanceId, route.aiSessionId, markdown);
    return {
      accepted: true,
      routed: true,
      binding,
      pending: route,
      aiSession: data,
      reply: `Reply sent for ${route.instanceId}:${route.aiSessionId}.`,
    };
  }
}
