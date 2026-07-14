import { renderPlainChatPayload } from "./chat-render";
import type { SenderAttachment } from "./attachments";

type ChatPayloadKind = "task" | "result" | "approval";

type ChatPayload = {
  kind: ChatPayloadKind;
  conversationId: number;
  id?: number;
  title: string;
  timeoutLabel?: string;
  body: string;
  instruction?: string;
  attachments?: SenderAttachment[];
};

type ChatAction = {
  text: string;
  callbackData: string;
};

type ChatProgressOptions = {
  actions?: ChatAction[];
  actionRows?: ChatAction[][];
};

type ChatBridgeCapabilities = {
  markdown: boolean;
  buttons: boolean;
  editMessage: boolean;
  deleteMessage: boolean;
  reaction: boolean;
  progress: boolean;
  plainTextOnly: boolean;
};

type ChatBridge = {
  enabled?: boolean;
  capabilities?: Partial<ChatBridgeCapabilities>;
  stop?: () => void;
  send?: (text: string, route?: ActiveChatRoute) => unknown | Promise<unknown>;
  sendTask?: (payload: ChatPayload, route?: ActiveChatRoute) => unknown | Promise<unknown>;
  sendAttachment?: (attachment: SenderAttachment, route?: ActiveChatRoute) => unknown | Promise<unknown>;
  sendApprovalPayload?: (payload: ChatPayload, route?: ActiveChatRoute) => unknown | Promise<unknown>;
  updateProgress?: (key: string, text: string, route?: ActiveChatRoute, options?: ChatProgressOptions) => unknown;
  finishProgressPayload?: (key: string, payload: ChatPayload, route?: ActiveChatRoute) => boolean | Promise<boolean | undefined>;
  deleteProgress?: (key: string, route?: ActiveChatRoute) => boolean | Promise<boolean | undefined>;
};

type ChatBridgeRegistryEntry = {
  channel: string;
  bridge: ChatBridge;
  capabilities: ChatBridgeCapabilities;
};

type ChatRoute = {
  channel: string;
  instanceId?: string;
  routeKey?: string;
  conversationId: number;
  bridge?: ChatBridge;
  capabilities?: ChatBridgeCapabilities;
  requiresTarget?: boolean;
  hasTarget?: () => boolean;
  target?: Record<string, unknown>;
};

type ActiveChatRoute = Omit<ChatRoute, "bridge" | "capabilities"> & {
  bridge: ChatBridge;
  capabilities: ChatBridgeCapabilities;
};

type ChatTaskPayloadOptions = {
  conversationId: number;
  id?: number;
  timeoutLabel?: string;
  body?: unknown;
  title?: string;
  instruction?: string;
  attachments?: SenderAttachment[];
};

type ChatResultPayloadOptions = {
  conversationId: number;
  id?: number;
  body?: unknown;
  title?: string;
  attachments?: SenderAttachment[];
};

type ChatTextRouterOptions = {
  addLog: (message: string) => void;
  handleCommand: (line: string) => void;
  runCommand?: (line: string, context?: { conversationId?: number }) => unknown;
  sendCommandResponse?: (options: { channel: string; conversationId: number; text: string; route?: ChatRoute }) => unknown | Promise<unknown>;
  replyDefault: (
    text: string,
    label?: string,
    conversationId?: number,
    processing?: unknown,
    replyOptions?: unknown,
  ) => "sent" | "queued" | unknown;
};

type ChatTextRouterInput = {
  channel: string;
  conversationId: number;
  text: unknown;
  label?: string;
  processing?: unknown;
  replyOptions?: unknown;
  route?: ChatRoute;
};

type ProgressItem = {
  kind?: ChatPayloadKind;
  conversationId: number;
  transcriptPath?: string;
  codexId?: string;
  claudeId?: string;
  cwd?: string;
  routeTarget?: Record<string, unknown>;
  progressActions?: ChatAction[];
};

type ProgressEntry = {
  channel?: string;
  conversationId?: number;
  hasInterveningMessage?: boolean;
  transcriptPath?: string;
  route?: ActiveChatRoute;
  stop?: () => void;
};

type ProgressWatcher = {
  transcriptPath?: string;
  stop: () => void;
};

type ChatProgressControllerOptions = {
  routes: () => ActiveChatRoute[];
  progressMap: Map<string, ProgressEntry>;
  onLog?: (message: string) => void;
  watch: (options: {
    item: ProgressItem;
    route: ActiveChatRoute;
    onUpdate: (text: string) => void;
  }) => ProgressWatcher;
};

const DEFAULT_CHAT_CAPABILITIES: ChatBridgeCapabilities = {
  markdown: false,
  buttons: false,
  editMessage: false,
  deleteMessage: false,
  reaction: false,
  progress: false,
  plainTextOnly: true,
};

function normalizeChatCommandLine(line: unknown) {
  return String(line).trim().replace(/^\/([^\s@]+)@[A-Za-z0-9_]+(?=\s|$)/, "/$1");
}

function normalizeChatCapabilities(capabilities: Partial<ChatBridgeCapabilities> = {}): ChatBridgeCapabilities {
  return { ...DEFAULT_CHAT_CAPABILITIES, ...capabilities };
}

function createChatTextRouter({
  addLog,
  handleCommand,
  replyDefault,
  runCommand,
  sendCommandResponse,
}: ChatTextRouterOptions) {
  return ({ channel, conversationId, text, label, processing, replyOptions, route }: ChatTextRouterInput) => {
    const line = String(text).trim();
    if (line.startsWith("/")) {
      addLog(`${channel} c${conversationId} command > ${line}`);
      const normalized = normalizeChatCommandLine(line);
      const response = runCommand ? runCommand(normalized, { conversationId }) : handleCommand(normalized);
      if (typeof response === "string" && response.trim() && sendCommandResponse) {
        Promise.resolve(sendCommandResponse({ channel, conversationId, text: response, route })).catch((error: unknown) => {
          addLog(`${channel} command response failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      return "command";
    }

    addLog(`${channel} c${conversationId} > ${text}`);
    return replyDefault(String(text), label, conversationId, processing, replyOptions) === "sent" ? "sent" : "queued";
  };
}

function createChatBridgeRegistry() {
  const bridges = new Map<string, ChatBridgeRegistryEntry>();

  return {
    set(channel: string, bridge: ChatBridge, options: { capabilities?: Partial<ChatBridgeCapabilities> } = {}) {
      bridges.set(channel, {
        channel,
        bridge,
        capabilities: normalizeChatCapabilities(options.capabilities || bridge?.capabilities),
      });
      return bridge;
    },
    get(channel: string) {
      return bridges.get(channel)?.bridge;
    },
    getEntry(channel: string) {
      return bridges.get(channel);
    },
    getCapabilities(channel: string) {
      return bridges.get(channel)?.capabilities || normalizeChatCapabilities();
    },
    delete(channel: string) {
      return bridges.delete(channel);
    },
    entries() {
      return [...bridges.values()];
    },
    stopAll() {
      for (const { bridge } of bridges.values()) {
        bridge?.stop?.();
      }
      bridges.clear();
    },
  };
}

function chatRoutesForConversation(
  registry: ReturnType<typeof createChatBridgeRegistry>,
  routes: ChatRoute[],
  conversationId: number,
): ActiveChatRoute[] {
  return routes
    .filter((route) => route.conversationId === conversationId)
    .map((route) => {
      const entry = route.bridge ? undefined : registry.getEntry(route.channel);
      const bridge = route.bridge || entry?.bridge;
      const capabilities = route.capabilities || entry?.capabilities;
      if (!bridge) {
        return undefined;
      }
      return {
        ...route,
        bridge,
        capabilities: normalizeChatCapabilities(capabilities),
      };
    })
    .filter((route): route is ActiveChatRoute => Boolean(route));
}

function createChatTaskPayload({
  conversationId,
  id,
  timeoutLabel,
  body,
  title,
  instruction,
  attachments = [],
}: ChatTaskPayloadOptions): ChatPayload {
  const idLabel = id === undefined || id === null ? "" : ` #${id}`;
  return {
    kind: "task",
    conversationId,
    id,
    title: title || `task-handoff c${conversationId}${idLabel}`,
    timeoutLabel,
    body: String(body || ""),
    instruction: instruction || "Reply here to send text back to the waiting CLI.",
    attachments,
  };
}

function createChatResultPayload({ conversationId, id, body, title, attachments = [] }: ChatResultPayloadOptions): ChatPayload {
  return {
    kind: "result",
    conversationId,
    id,
    title: title || `TaskHandoff c${conversationId} 任务已完成`,
    body: String(body || ""),
    attachments,
  };
}

function createChatApprovalPayload(options: ChatTaskPayloadOptions): ChatPayload {
  const { conversationId, id, timeoutLabel, body, title, instruction } = options;
  const idLabel = id === undefined || id === null ? "" : ` #${id}`;
  return {
    kind: "approval",
    conversationId,
    id,
    title: title || `task-handoff c${conversationId}${idLabel} approval`,
    timeoutLabel,
    body: String(body || ""),
    attachments: options.attachments || [],
    instruction:
      instruction ||
      (idLabel
        ? `Use approval buttons where available, or reply /approve${idLabel}, /skip${idLabel}, or /deny${idLabel}.`
        : "Use approval buttons where available, or reply /approve, /skip, or /deny."),
  };
}

async function deliverChatPayload(route: ActiveChatRoute, payload: ChatPayload) {
  if (payload.kind === "approval" && route.bridge.sendApprovalPayload) {
    return route.bridge.sendApprovalPayload(payload, route);
  }
  if (route.bridge.sendTask) {
    return route.bridge.sendTask(payload, route);
  }
  if (route.bridge.send) {
    return route.bridge.send(renderPlainChatPayload(payload), route);
  }
  return undefined;
}

function routeWithTargetContext(route: ActiveChatRoute, routeTarget?: Record<string, unknown>): ActiveChatRoute {
  if (!routeTarget) {
    return route;
  }
  const routeChatId = String(route.target?.chatId || "").trim();
  const targetChatId = String(routeTarget.chatId || "").trim();
  if (routeChatId && targetChatId && routeChatId !== targetChatId) {
    return route;
  }
  return { ...route, target: { ...routeTarget, ...(route.target || {}) } };
}

function createChatProgressController({ routes, progressMap, onLog, watch }: ChatProgressControllerOptions) {
  const keyFor = (route: ActiveChatRoute, conversationId: number) => `${route.routeKey || route.channel}:${conversationId}`;

  const stop = (conversationId: number) => {
    for (const route of routes()) {
      const key = keyFor(route, conversationId);
      const entry = progressMap.get(key);
      if (entry) {
        entry.stop?.();
        progressMap.delete(key);
      }
    }
  };

  const stopAll = () => {
    for (const entry of progressMap.values()) {
      entry.stop?.();
    }
    progressMap.clear();
  };

  const markIntervening = (conversationId: number) => {
    for (const route of routes()) {
      const entry = progressMap.get(keyFor(route, conversationId));
      if (entry) {
        entry.hasInterveningMessage = true;
      }
    }
  };

  const start = (item: ProgressItem) => {
    if (item.kind === "approval") {
      return;
    }

    for (const route of routes()) {
      if (route.conversationId !== item.conversationId || !route.capabilities.progress || !route.bridge?.enabled) {
        continue;
      }
      if (route.requiresTarget && !route.hasTarget?.()) {
        continue;
      }

      const activeRoute = routeWithTargetContext(route, item.routeTarget);
      const key = keyFor(activeRoute, item.conversationId);
      const existing = progressMap.get(key);
      existing?.stop?.();

      const progress: ProgressEntry = { channel: activeRoute.channel, conversationId: item.conversationId, route: activeRoute };
      progressMap.set(key, progress);
      const watcher = watch({
        item,
        route: activeRoute,
        onUpdate: (text) => {
          activeRoute.bridge.updateProgress?.(key, text, activeRoute, { actions: item.progressActions });
        },
      });
      progress.stop = watcher.stop;
      progress.transcriptPath = watcher.transcriptPath;
      if (watcher.transcriptPath) {
        onLog?.(`${route.channel} progress watching ${watcher.transcriptPath}`);
      }
    }
  };

  const finishRoute = async (route: ActiveChatRoute, conversationId: number, payload: ChatPayload) => {
    if (route.conversationId !== conversationId || !route.capabilities.progress) {
      return false;
    }
    const key = keyFor(route, conversationId);
    const entry = progressMap.get(key);
    if (!entry) {
      return false;
    }
    const activeRoute = entry.route || route;
    entry.stop?.();
    progressMap.delete(key);
    if (entry.hasInterveningMessage) {
      await activeRoute.bridge.deleteProgress?.(key, activeRoute);
      await deliverChatPayload(activeRoute, payload);
      return true;
    }
    const finished = Boolean(await activeRoute.bridge.finishProgressPayload?.(key, payload, activeRoute));
    if (!finished) {
      await deliverChatPayload(activeRoute, payload);
    }
    return true;
  };

  const finish = async (conversationId: number, payload: ChatPayload) => {
    const results = await Promise.all(routes().map((route) => finishRoute(route, conversationId, payload)));
    return results.some(Boolean);
  };

  return { finish, finishRoute, markIntervening, start, stop, stopAll };
}

export type {
  ActiveChatRoute,
  ChatAction,
  ChatBridge,
  ChatBridgeCapabilities,
  ChatBridgeRegistryEntry,
  ChatPayload,
  ChatPayloadKind,
  ChatRoute,
  ProgressItem,
  ChatProgressOptions,
};

export {
  createChatProgressController,
  createChatApprovalPayload,
  createChatBridgeRegistry,
  createChatResultPayload,
  createChatTaskPayload,
  createChatTextRouter,
  chatRoutesForConversation,
  deliverChatPayload,
  routeWithTargetContext,
  normalizeChatCommandLine,
  normalizeChatCapabilities,
  renderPlainChatPayload,
};
