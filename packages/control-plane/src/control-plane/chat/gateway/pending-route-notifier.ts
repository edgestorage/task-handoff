import type { ChatBridgeConfig, ChatSessionBinding, PendingRoute } from "@task-handoff/protocol/control-plane";
import { createInlineKeyboard, type ChatInteractionPayload } from "@task-handoff/core/core/chat-interactions";

type PendingRouteWithInstance = PendingRoute & {
  project?: { id?: string; name?: string };
  instance?: { id: string; name?: string };
};

type PendingRouteNotifierOptions = {
  listRoutes: () => Promise<PendingRouteWithInstance[]>;
  listBindings: () => ChatSessionBinding[];
  listBridges: () => Array<ChatBridgeConfig & { tokenSet?: boolean }>;
  requireBridge: (id: string) => ChatBridgeConfig;
  callbackData: (routeId: string, decision: "allow" | "deny" | "skip") => string;
  send: (bridge: ChatBridgeConfig, chatId: string, payload: ChatInteractionPayload) => Promise<unknown>;
  setBridgeError: (bridgeId: string, error: string) => void;
};

export class PendingRouteNotifier {
  private readonly announced = new Set<string>();
  private readonly options: PendingRouteNotifierOptions;

  constructor(options: PendingRouteNotifierOptions) {
    this.options = options;
  }

  async poll() {
    const routes = await this.options.listRoutes().catch(() => []);
    for (const route of routes) {
      if (this.announced.has(route.id)) continue;
      const payload = renderPendingNotification(route, this.options.callbackData);
      const bindings = route.aiSessionId
        ? this.options.listBindings().filter((binding) =>
            binding.activeInstanceId === route.instanceId
            && binding.activeAiSessionId === route.aiSessionId)
        : [];
      const deliveredToBinding = await this.sendToBindings(bindings, payload);
      const delivered = deliveredToBinding || await this.sendToDefaults(payload);
      if (delivered) this.announced.add(route.id);
    }
  }

  private async sendToBindings(bindings: ChatSessionBinding[], payload: ChatInteractionPayload) {
    let delivered = false;
    for (const binding of bindings) {
      if (!binding.bridgeId) continue;
      const bridge = this.options.requireBridge(binding.bridgeId);
      if (!bridge.enabled) continue;
      const sent = await this.send(bridge, binding.chatSessionId, payload);
      delivered ||= sent;
    }
    return delivered;
  }

  private async sendToDefaults(payload: ChatInteractionPayload) {
    let delivered = false;
    for (const bridge of this.options.listBridges()) {
      if (!bridge.enabled || !bridge.defaultChatId) continue;
      let failed = false;
      const sent = await this.options.send(bridge, bridge.defaultChatId, payload).catch((error) => {
        this.options.setBridgeError(bridge.id, errorMessage(error));
        failed = true;
        return false;
      });
      if (sent) {
        delivered = true;
      } else if (!failed) {
        this.options.setBridgeError(bridge.id, "Chat bridge message was not delivered.");
      }
    }
    return delivered;
  }

  private async send(bridge: ChatBridgeConfig, chatId: string, payload: ChatInteractionPayload) {
    return this.options.send(bridge, chatId, payload)
      .then(Boolean)
      .catch((error) => {
        this.options.setBridgeError(bridge.id, errorMessage(error));
        return false;
      });
  }
}

function renderPendingNotification(
  route: PendingRouteWithInstance,
  callbackData: (routeId: string, decision: "allow" | "deny" | "skip") => string,
): ChatInteractionPayload {
  const target = `${route.project?.name || route.projectId} / ${route.instance?.name || route.instanceId}`;
  const command = route.kind === "approval"
    ? `/approve ${route.id}\n/deny ${route.id}\n/skip ${route.id}`
    : `/reply ${route.id} <message>`;
  const text = `[${target}]\n${route.result}\n\n${command}`;
  if (route.kind !== "approval") return { text };
  return {
    text,
    replyMarkup: createInlineKeyboard([[
      { text: "Allow", callbackData: callbackData(route.id, "allow") },
      { text: "Skip", callbackData: callbackData(route.id, "skip") },
      { text: "Deny", callbackData: callbackData(route.id, "deny") },
    ]]),
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
