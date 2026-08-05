import type { ChatBridgeConfig, ChatGatewayMessage, ChatSessionBinding, PendingRoute } from "@task-handoff/protocol/control-plane";
import type { DWClientDownStream } from "dingtalk-stream";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { createInlineKeyboard } from "@task-handoff/core/core/chat-interactions";
import type { ChatInlineKeyboard, ChatInteractionPayload } from "@task-handoff/core/core/chat-interactions";
import {
  type AiSessionActionResult,
  type AiSessionMessageAttachment,
  type AiSessionsSnapshot,
  type AiSessionSummary,
} from "@task-handoff/protocol/ai-sessions";
import type { ControlPlaneAiSessionSnapshotUpdate } from "../../sessions/ai-session-aggregator.ts";
import { answerTelegramCallback, deleteTelegramMessage, editTelegramMessage, sendTelegramMessage, type TelegramMessageOptions } from "../adapters/telegram-gateway.ts";
import {
  parseChatGatewayCallbackAction,
} from "../adapters/callback-actions.ts";
import {
  parsePendingDecisionCallbackData,
  pendingDecisionRouteFingerprint,
} from "../action-token-service.ts";
import {
  dingdingCardUpdateResponse,
  parseDingdingCardEvent,
  parseDingdingRobotEvent,
  sendDingdingWebhook,
  type DingdingClientLike,
  type DingdingRuntimeState,
} from "../adapters/dingding.ts";
import { createChatGatewaySendAdapter } from "../adapters/factory.ts";
import {
  pollTelegramUpdates,
  telegramMessageAttachmentsWithDownloadedImages,
  TelegramProgressAdapter,
} from "../adapters/telegram.ts";
import { pollWechatMessages } from "../adapters/wechat.ts";
import { DingdingBridgeRuntimeManager } from "./dingding-bridge-runtime.ts";
import { LarkBridgeRuntimeManager, type LarkChannelFactoryInput } from "./lark-bridge-runtime.ts";
import type { LarkChannelLike, LarkRuntimeState } from "../adapters/lark.ts";
import { AsyncTtlCache } from "./async-ttl-cache.ts";
import { TelegramMessageAggregator, type TelegramMessageContext } from "./telegram-message-aggregator.ts";
import { TelegramAiSessionCallbacks } from "./telegram-ai-session-callbacks.ts";
import { PendingRouteNotifier } from "./pending-route-notifier.ts";

export { createDingdingStreamClient } from "./dingding-bridge-runtime.ts";
export { createLarkSdkChannel } from "./lark-bridge-runtime.ts";

type Timer = ReturnType<typeof setInterval>;
type ChatGatewayLogger = {
  info?: (data: Record<string, unknown>, message?: string) => void;
  warn?: (data: Record<string, unknown>, message?: string) => void;
  error?: (data: Record<string, unknown>, message?: string) => void;
};

function envFlag(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function chatGatewayDiagnosticLogsEnabled() {
  return envFlag(process.env.TASK_HANDOFF_DIAGNOSTIC_LOGS);
}

const AI_SESSION_INSTANCE_NAMES_TTL_MS = 30_000;
const AI_SESSION_PENDING_ROUTES_TTL_MS = 1_000;
type TelegramReplyAiSessionTarget = {
  instanceId: string;
  sessionId: string;
  turnId?: string;
  messageId?: number;
};

type TelegramOwnedProgressEntry = {
  key: string;
  route: { bridgeId: string; chatId: string };
  messageId: number;
  owner: TelegramReplyAiSessionTarget;
};
type DingdingRuntimeBridge = DingdingRuntimeState;
type ControlPlaneChatGatewayRuntimeOptions = {
  createDingdingClient?: (input: { clientId: string; clientSecret: string }) => DingdingClientLike;
  createLarkChannel?: (input: LarkChannelFactoryInput) => LarkChannelLike;
  aiSessions?: {
    onSnapshot: (listener: (update: ControlPlaneAiSessionSnapshotUpdate) => void) => () => void;
  };
  logger?: ChatGatewayLogger;
  telegramProgressUpdateIntervalMs?: number;
};

type ChatActionToken = {
  token: string;
  type: "instance-app-menu" | "launch-app" | "pending-decision";
  instanceId?: string;
  appId?: string;
  routeId?: string;
  decision?: "allow" | "deny" | "skip";
  expiresAt: string;
};

type ChatGatewayAction =
  | { type: "ai-session"; index: number }
  | { type: "instance-app-menu"; instanceId: string }
  | { type: "launch-app"; instanceId: string; appId: string }
  | { type: "pending-decision"; routeId: string; decision: "allow" | "deny" | "skip" };

type ChatGatewayResult = {
  accepted?: boolean;
  routed?: boolean;
  binding?: ChatSessionBinding;
  reply?: string;
  message?: string;
  replyMarkup?: ChatInlineKeyboard;
  instanceId?: string;
  aiSessionId?: string;
  instance?: { id: string };
  aiSession?: AiSessionActionResult | AiSessionSummary;
  turnId?: string;
  providerTurnId?: string;
};

type ChatGatewayService = {
  listChatBridges(): Array<ChatBridgeConfig & { tokenSet?: boolean }>;
  requireChatBridge(id: string): ChatBridgeConfig;
  updateChatBridge?: (id: string, input: unknown) => unknown;
  listChatSessions(): ChatSessionBinding[];
  listPendingRoutes(): Promise<Array<PendingRoute & { instance?: { id: string; name?: string } }>>;
  handleChatGatewayMessage(input: ChatGatewayMessage): Promise<ChatGatewayResult>;
  handleChatGatewayAction(input: {
    source: {
      channel: ChatSessionBinding["channel"];
      bridgeId?: string;
      chatSessionId: string;
      userId?: string;
    };
    action: ChatGatewayAction;
  }): Promise<ChatGatewayResult>;
  resolveChatActionToken(token: string, type?: ChatActionToken["type"]): ChatActionToken;
  pendingDecisionCallbackData(routeId: string, decision: "allow" | "deny" | "skip"): string;
  listAiSessions(options?: { refresh?: boolean }): Promise<{ instances: Array<{ instanceId: string; aiSessions: AiSessionsSnapshot }> }>;
  listAiSessionInstanceNames?: () => Promise<Array<{ id: string; name?: string }>>;
  boardAsync(): Promise<Array<{ id: string; name?: string }>>;
  aiSessionQueue(instanceId: string, sessionId: string): Promise<unknown>;
  steerAiSessionQueuedMessage(instanceId: string, sessionId: string, queueId: string): Promise<unknown>;
  removeAiSessionQueuedMessage(instanceId: string, sessionId: string, queueId: string): Promise<unknown>;
  interruptAiSession(instanceId: string, sessionId: string): Promise<unknown>;
};

export type ChatGatewayRuntimeStatus = {
  running: boolean;
  bridges: Array<{
    id: string;
    channel: ChatBridgeConfig["channel"];
    name: string;
    running: boolean;
    tokenSet: boolean;
    defaultChatId?: string;
    lastUpdateId?: number;
    error?: string;
  }>;
};

export class ControlPlaneChatGatewayRuntime {
  private readonly service: ChatGatewayService;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: ChatGatewayLogger | undefined;
  private bridgeTimers = new Map<string, Timer>();
  private bridgePollingGenerations = new Map<string, number>();
  private bridgePolls = new Map<string, { generation: number; promise: Promise<void> }>();
  private readonly dingdingBridges: DingdingBridgeRuntimeManager;
  private readonly larkBridges: LarkBridgeRuntimeManager;
  private bridgeErrors = new Map<string, string>();
  private telegramOffsets = new Map<string, number>();
  private seenTelegramUpdates = new Set<string>();
  private wechatCursors = new Map<string, string>();
  private readonly pendingRouteNotifier: PendingRouteNotifier;
  private deliveredAiSessionFingerprints = new Map<string, string>();
  private readonly telegramAiSessionCallbacks: TelegramAiSessionCallbacks;
  private readonly telegramMessageAggregator: TelegramMessageAggregator;
  private telegramProgressMessageTargets = new Map<string, TelegramReplyAiSessionTarget>();
  private readonly aiSessionInstanceNamesCache: AsyncTtlCache<Map<string, string>>;
  private readonly aiSessionPendingRoutesCache: AsyncTtlCache<Array<PendingRoute & { instance?: { id: string; name?: string } }>>;
  private telegramProgress: TelegramProgressAdapter;
  private stopAiSessionListener: (() => void) | undefined;

  constructor(service: ChatGatewayService, fetchImpl: typeof fetch = fetch, options: ControlPlaneChatGatewayRuntimeOptions = {}) {
    this.service = service;
    this.fetchImpl = fetchImpl;
    this.logger = chatGatewayDiagnosticLogsEnabled() ? options.logger : undefined;
    this.aiSessionInstanceNamesCache = new AsyncTtlCache(AI_SESSION_INSTANCE_NAMES_TTL_MS, async () => {
      const instances = await (this.service.listAiSessionInstanceNames?.() || this.service.boardAsync()).catch(() => []);
      return new Map(instances.map((instance) => [instance.id, instance.name || instance.id] as const));
    });
    this.aiSessionPendingRoutesCache = new AsyncTtlCache(
      AI_SESSION_PENDING_ROUTES_TTL_MS,
      () => this.service.listPendingRoutes().catch(() => []),
    );
    this.telegramMessageAggregator = new TelegramMessageAggregator({
      requireBridge: (id) => this.service.requireChatBridge(id),
      send: (bridge, chatId, text, telegramOptions = {}) => this.sendTelegramMessage(bridge, chatId, text, telegramOptions),
      answerCallback: (bridge, callbackQueryId, text) => this.answerTelegramCallback(bridge, callbackQueryId, text),
      dispatch: (bridge, chatId, userId, text, attachments, context) => this.dispatchTelegramGatewayMessage(
        bridge,
        chatId,
        userId,
        text,
        attachments,
        context,
      ),
      onError: (bridgeId, error) => this.bridgeErrors.set(bridgeId, errorMessage(error)),
    });
    this.telegramAiSessionCallbacks = new TelegramAiSessionCallbacks({
      interrupt: (instanceId, sessionId) => this.service.interruptAiSession(instanceId, sessionId),
      queue: (instanceId, sessionId) => this.service.aiSessionQueue(instanceId, sessionId),
      steer: (instanceId, sessionId, queueId) => this.service.steerAiSessionQueuedMessage(instanceId, sessionId, queueId),
      remove: (instanceId, sessionId, queueId) => this.service.removeAiSessionQueuedMessage(instanceId, sessionId, queueId),
      actionAllowed: (bridge, chatId, instanceId, sessionId, messageId) => this.telegramAiSessionActionAllowed(
        bridge,
        chatId,
        instanceId,
        sessionId,
        messageId,
      ),
      answer: (bridge, callbackQueryId, text) => this.answerTelegramCallback(bridge, callbackQueryId, text),
      send: (bridge, chatId, text, telegramOptions = {}) => this.sendTelegramMessage(bridge, chatId, text, telegramOptions),
      deleteMessage: (bridge, chatId, messageId) => this.deleteTelegramMessage(bridge, chatId, messageId),
      setBridgeError: (bridgeId, error) => this.bridgeErrors.set(bridgeId, error),
      info: (data, message) => this.logInfo(data, message),
      warn: (data, message) => this.logWarn(data, message),
    });
    this.pendingRouteNotifier = new PendingRouteNotifier({
      listRoutes: () => this.service.listPendingRoutes(),
      listBindings: () => this.service.listChatSessions(),
      listBridges: () => this.service.listChatBridges(),
      requireBridge: (id) => this.service.requireChatBridge(id),
      callbackData: (routeId, decision) => this.service.pendingDecisionCallbackData(routeId, decision),
      send: (bridge, chatId, payload) => this.sendViaBridge(bridge, chatId, payload),
      setBridgeError: (bridgeId, error) => this.bridgeErrors.set(bridgeId, error),
    });
    this.telegramProgress = new TelegramProgressAdapter({
      updateIntervalMs: options.telegramProgressUpdateIntervalMs,
      requireBridge: (id) => this.service.requireChatBridge(id),
      send: (bridge, chatId, text, telegramOptions = {}) => this.sendTelegramMessage(bridge, chatId, text, telegramOptions),
      edit: (bridge, chatId, messageId, text, telegramOptions = {}) => this.editTelegramMessage(bridge, chatId, messageId, text, telegramOptions),
      deleteMessage: (bridge, chatId, messageId) => this.deleteTelegramMessage(bridge, chatId, messageId),
      onLog: (message) => this.logWarn({ message }, "telegram progress store warning"),
    });
    this.dingdingBridges = new DingdingBridgeRuntimeManager({
      fetchImpl: this.fetchImpl,
      createClient: options.createDingdingClient,
      logger: {
        info: (data, message) => this.logInfo(data, message),
        warn: (data, message) => this.logWarn(data, message),
      },
      onRobotMessage: (bridge, runtime, message) => this.handleDingdingRobotMessage(bridge, runtime, message),
      onCardCallback: (bridge, runtime, message) => this.handleDingdingCardCallback(bridge, runtime, message),
      onError: (bridgeId, error) => this.bridgeErrors.set(bridgeId, errorMessage(error)),
      clearError: (bridgeId) => this.bridgeErrors.delete(bridgeId),
    });
    this.larkBridges = new LarkBridgeRuntimeManager({
      createChannel: options.createLarkChannel,
      logger: {
        info: (data, message) => this.logInfo(data, message),
        warn: (data, message) => this.logWarn(data, message),
      },
      onMessage: (bridge, runtime, message) => this.handleLarkMessage(bridge, runtime, message),
      onError: (bridgeId, error) => this.bridgeErrors.set(bridgeId, errorMessage(error)),
      clearError: (bridgeId) => this.bridgeErrors.delete(bridgeId),
    });
    this.stopAiSessionListener = options.aiSessions?.onSnapshot((update) => {
      void this.deliverAiSessionSnapshot(update.instanceId, update.aiSessions).catch((error) => {
        this.logWarn({
          instanceId: update.instanceId,
          snapshotRevision: update.revision,
          error: errorMessage(error),
        }, "chat ai session snapshot delivery failed");
      });
    });
  }

  private logInfo(data: Record<string, unknown>, message: string) {
    this.logger?.info?.({ component: "control-plane-chat-gateway", ...data }, message);
  }

  private logWarn(data: Record<string, unknown>, message: string) {
    this.logger?.warn?.({ component: "control-plane-chat-gateway", ...data }, message);
  }

  private updateChatBridge(id: string, input: unknown) {
    this.service.updateChatBridge?.(id, input);
  }

  startEnabled() {
    this.logAiSessionDelivery({
      stage: "runtime-start-enabled",
      bridgeCount: this.service.listChatBridges().length,
      enabledBridgeCount: this.service.listChatBridges().filter((bridge) => bridge.enabled).length,
    });
    for (const bridge of this.service.listChatBridges()) {
      if (bridge.enabled) {
        this.startBridge(bridge.id);
      }
    }
  }

  startBridge(id: string) {
    if (this.bridgeTimers.has(id) || this.dingdingBridges.has(id) || this.larkBridges.has(id)) {
      this.logAiSessionDelivery({
        stage: "bridge-start-skipped-running",
        bridgeId: id,
      });
      return this.status();
    }
    const bridge = this.service.requireChatBridge(id);
    this.logAiSessionDelivery({
      stage: "bridge-start",
      bridgeId: bridge.id,
      channel: bridge.channel,
      enabled: bridge.enabled,
      hasToken: Boolean(bridge.token),
    });
    if (bridge.channel === "wechat") {
      return this.startPollingBridge(bridge, (current, isCurrent) => this.pollWechat(current, isCurrent));
    }
    if (bridge.channel === "dingding") {
      return this.startDingdingBridge(bridge);
    }
    if (bridge.channel === "lark") {
      return this.startLarkBridge(bridge);
    }
    if (bridge.channel !== "telegram") {
      this.bridgeErrors.set(id, `${bridge.channel} bridge is not supported in the control plane.`);
      return this.status();
    }
    if (!bridge.token) {
      this.bridgeErrors.set(id, "Telegram token is not configured.");
      return this.status();
    }
    return this.startPollingBridge(bridge, (current, isCurrent) => this.pollTelegram(current, isCurrent));
  }

  stopBridge(id: string) {
    this.advanceBridgePollingGeneration(id);
    const timer = this.bridgeTimers.get(id);
    if (timer) {
      clearInterval(timer);
      this.bridgeTimers.delete(id);
    }
    this.dingdingBridges.stop(id);
    this.larkBridges.stop(id);
    this.telegramMessageAggregator.stopBridge(id);
    return this.status();
  }

  stopAll() {
    const bridgeIds = new Set([
      ...this.service.listChatBridges().map((bridge) => bridge.id),
      ...this.bridgePollingGenerations.keys(),
      ...this.bridgeTimers.keys(),
      ...this.bridgePolls.keys(),
      ...this.dingdingBridges.ids(),
      ...this.larkBridges.ids(),
    ]);
    for (const id of bridgeIds) {
      this.stopBridge(id);
    }
    this.dingdingBridges.stopAll();
    this.larkBridges.stopAll();
    this.telegramMessageAggregator.stop();
    this.telegramAiSessionCallbacks.clear();
    this.stopAiSessionListener?.();
    this.stopAiSessionListener = undefined;
  }

  async pollBridgeNow(id: string) {
    const bridge = this.service.requireChatBridge(id);
    const generation = this.bridgePollingGeneration(id);
    if (bridge.channel === "telegram") {
      await this.runBridgePoll(bridge, generation, (current, isCurrent) => this.pollTelegram(current, isCurrent));
      return this.status();
    }
    if (bridge.channel === "wechat") {
      await this.runBridgePoll(bridge, generation, (current, isCurrent) => this.pollWechat(current, isCurrent));
      return this.status();
    }
    if (bridge.channel === "dingding") {
      return this.status();
    }
    if (bridge.channel === "lark") {
      return this.status();
    }
    this.bridgeErrors.set(id, `${bridge.channel} bridge is not supported in the control plane.`);
    return this.status();
  }

  async pollAiSessionsNow() {
    await this.pollAiSessionUpdates();
    return this.status();
  }

  status(): ChatGatewayRuntimeStatus {
    const bridges = this.service.listChatBridges().map((bridge) => ({
      id: bridge.id,
      channel: bridge.channel,
      name: bridge.name,
      running: this.bridgeTimers.has(bridge.id) || this.dingdingBridges.isRunning(bridge.id) || this.larkBridges.isRunning(bridge.id),
      tokenSet: Boolean(bridge.tokenSet),
      defaultChatId: bridge.defaultChatId,
      lastUpdateId: this.telegramOffsets.get(bridge.id),
      error: this.bridgeErrors.get(bridge.id),
    }));
    return {
      running: bridges.some((bridge) => bridge.running),
      bridges,
    };
  }

  private startPollingBridge(
    bridge: ChatBridgeConfig,
    poll: (bridge: ChatBridgeConfig, isCurrent: () => boolean) => Promise<void>,
  ) {
    if (!bridge.token) {
      this.bridgeErrors.set(bridge.id, `${bridge.channel} token is not configured.`);
      return this.status();
    }
    this.bridgeErrors.delete(bridge.id);
    const generation = this.advanceBridgePollingGeneration(bridge.id);
    const isCurrent = () => this.bridgePollingGeneration(bridge.id) === generation;
    const run = (current: ChatBridgeConfig) => {
      if (!isCurrent()) return;
      void this.runBridgePoll(current, generation, poll).catch((error) => {
        if (isCurrent()) this.bridgeErrors.set(bridge.id, error instanceof Error ? error.message : String(error));
      });
    };
    const interval = setInterval(() => {
      if (!isCurrent()) return;
      const current = this.service.requireChatBridge(bridge.id);
      if (!current.enabled) {
        this.stopBridge(bridge.id);
        return;
      }
      run(current);
    }, bridge.pollIntervalMs);
    this.bridgeTimers.set(bridge.id, interval);
    this.logAiSessionDelivery({
      stage: "bridge-poll-started",
      bridgeId: bridge.id,
      channel: bridge.channel,
      intervalMs: bridge.pollIntervalMs,
    });
    if (bridge.enabled) {
      const current = this.service.requireChatBridge(bridge.id);
      run(current);
    }
    return this.status();
  }

  private runBridgePoll(
    bridge: ChatBridgeConfig,
    generation: number,
    poll: (bridge: ChatBridgeConfig, isCurrent: () => boolean) => Promise<void>,
  ) {
    const existing = this.bridgePolls.get(bridge.id);
    if (existing?.generation === generation) return existing.promise;
    const run = async () => {
      const isCurrent = () => this.bridgePollingGeneration(bridge.id) === generation;
      if (!isCurrent()) return;
      await poll(bridge, isCurrent);
    };
    // A stopped generation is isolated by isCurrent(). Do not let a hung
    // request from that obsolete generation block a newly started bridge.
    const promise = run();
    this.bridgePolls.set(bridge.id, { generation, promise });
    const cleanup = () => {
      if (this.bridgePolls.get(bridge.id)?.promise === promise) this.bridgePolls.delete(bridge.id);
    };
    void promise.then(cleanup, cleanup);
    return promise;
  }

  private bridgePollingGeneration(bridgeId: string) {
    return this.bridgePollingGenerations.get(bridgeId) || 0;
  }

  private advanceBridgePollingGeneration(bridgeId: string) {
    const generation = this.bridgePollingGeneration(bridgeId) + 1;
    this.bridgePollingGenerations.set(bridgeId, generation);
    return generation;
  }

  private startDingdingBridge(bridge: ChatBridgeConfig) {
    this.dingdingBridges.start(bridge);
    return this.status();
  }

  private startLarkBridge(bridge: ChatBridgeConfig) {
    this.larkBridges.start(bridge);
    return this.status();
  }

  private async handleLarkMessage(bridge: ChatBridgeConfig, runtime: LarkRuntimeState, message: NormalizedMessage) {
    const allowed = this.larkAllowed(bridge, message.senderId);
    const text = String(message.content || "").trim();
    if (!allowed || !text) {
      this.logWarn({
        bridgeId: bridge.id,
        chatId: message.chatId,
        senderId: message.senderId,
        allowed,
        hasText: Boolean(text),
      }, "lark message ignored");
      return;
    }
    if (!bridge.defaultChatId) {
      this.updateChatBridge(bridge.id, { defaultChatId: message.chatId });
    }
    this.logInfo({
      bridgeId: bridge.id,
      chatId: message.chatId,
      senderId: message.senderId,
      chatType: message.chatType,
      messageId: message.messageId,
      textPreview: compactLogText(text),
    }, "lark chat gateway message received");
    let result: ChatGatewayResult;
    try {
      result = await this.service.handleChatGatewayMessage({
        source: {
          type: "chat-gateway",
          channel: "lark",
          bridgeId: bridge.id,
          chatSessionId: message.chatId,
          userId: message.senderId,
        },
        message: { text, attachments: [] },
      });
    } catch (error) {
      await runtime.channel.send(message.chatId, { markdown: `Failed to handle message: ${errorMessage(error)}` });
      return;
    }
    const reply = replyFromGatewayResult(result);
    if (!reply) return;
    const adapter = createChatGatewaySendAdapter({
      fetchImpl: this.fetchImpl,
      bridge,
      larkRuntime: runtime,
    });
    const sent = await adapter.send(message.chatId, reply);
    if (sent) {
      this.logInfo({
        bridgeId: bridge.id,
        chatId: message.chatId,
        senderId: message.senderId,
        provider: sent.provider,
        interactionId: sent.interactionId,
        routed: asRecord(result).routed === true,
        replyPreview: compactLogText(reply),
      }, "lark chat gateway reply sent");
    }
  }

  private async handleDingdingRobotMessage(bridge: ChatBridgeConfig, runtime: DingdingRuntimeBridge, message: DWClientDownStream) {
    const event = parseDingdingRobotEvent(message.data);
    runtime.client.socketCallBackResponse(message.headers.messageId, {});
    if (!event || !this.dingdingAllowed(bridge, event.senderId)) {
      this.logWarn({
        bridgeId: bridge.id,
        hasEvent: Boolean(event),
        senderId: event?.senderId,
        allowed: event ? this.dingdingAllowed(bridge, event.senderId) : undefined,
      }, "dingding robot message ignored");
      return;
    }
    const { chatId, text, senderId, sessionWebhook } = event;
    if (sessionWebhook) {
      runtime.chatWebhooks.set(chatId, sessionWebhook);
    }
    if (event.conversationType) {
      runtime.conversationTypes.set(chatId, event.conversationType);
    }
    const resolvedSessionWebhook = sessionWebhook || runtime.chatWebhooks.get(chatId) || stringSetting(bridge.settings.sessionWebhook);
    if (senderId) {
      runtime.senderIds.set(chatId, senderId);
    }
    if (!bridge.defaultChatId) {
      this.updateChatBridge(bridge.id, { defaultChatId: chatId });
    }
    this.logInfo({
      bridgeId: bridge.id,
      chatId,
      senderId,
      conversationType: event.conversationType,
      hasSessionWebhook: Boolean(sessionWebhook),
      hasCachedSessionWebhook: Boolean(runtime.chatWebhooks.get(chatId)),
      hasResolvedSessionWebhook: Boolean(resolvedSessionWebhook),
      textPreview: compactLogText(text),
    }, "dingding chat gateway message received");
    let result: ChatGatewayResult;
    try {
      result = await this.service.handleChatGatewayMessage({
        source: {
          type: "chat-gateway",
          channel: "dingding",
          bridgeId: bridge.id,
          chatSessionId: chatId,
          userId: senderId || undefined,
        },
        message: { text, attachments: [] },
      });
    } catch (error) {
      if (resolvedSessionWebhook) {
        await sendDingdingWebhook(this.fetchImpl, resolvedSessionWebhook, `Failed to handle message: ${errorMessage(error)}`, runtime.onLog);
        return;
      }
      throw error;
    }
    const reply = replyFromGatewayResult(result);
    if (reply) {
      const replyMarkup = replyMarkupFromGatewayResult(result);
      if (await this.sendDingdingRoutedAiSessionProgress(result, bridge, runtime, chatId, reply, {
        replyMarkup,
        sessionWebhook: resolvedSessionWebhook,
        senderId,
        sourcePrompt: text,
      })) {
        return;
      }
      const adapter = createChatGatewaySendAdapter({ fetchImpl: this.fetchImpl, bridge, dingdingRuntime: runtime });
      const sent = await adapter.send(chatId, reply, { replyMarkup, sessionWebhook: resolvedSessionWebhook, senderId });
      if (sent) {
        this.logInfo({
          bridgeId: bridge.id,
          chatId,
          senderId,
          provider: sent.provider,
          interactionId: sent.interactionId,
          routed: asRecord(result).routed === true,
          hasReplyMarkup: Boolean(replyMarkup),
          replyPreview: compactLogText(reply),
        }, "dingding chat gateway reply sent");
        return;
      }
      this.logWarn({
        bridgeId: bridge.id,
        chatId,
        senderId,
        hasReplyMarkup: Boolean(replyMarkup),
        hasSessionWebhook: Boolean(resolvedSessionWebhook),
        hasRobotCode: Boolean(stringSetting(bridge.settings.robotCode)),
        replyPreview: compactLogText(reply),
      }, "dingding chat gateway reply skipped");
    }
  }

  private async sendDingdingRoutedAiSessionProgress(
    result: ChatGatewayResult,
    bridge: ChatBridgeConfig,
    runtime: DingdingRuntimeBridge,
    chatId: string,
    text: string,
    options: {
      replyMarkup?: ChatInlineKeyboard;
      sessionWebhook?: string;
      senderId?: string;
      sourcePrompt?: string;
    } = {},
  ) {
    if (result.routed !== true) {
      return false;
    }
    const route = routedAiSessionResult(result);
    const { instanceId, sessionId, turnId } = route;
    if (!instanceId || !sessionId || !turnId) {
      this.logWarn({
        bridgeId: bridge.id,
        chatId,
        instanceId,
        sessionId,
        turnId,
        turnIdSources: route.sources,
        routed: result.routed,
      }, "dingding ai session progress card not started");
      return false;
    }
    const key = aiSessionDeliveryKey(instanceId, sessionId, turnId, bridge.id, chatId);
    const delivered = await this.dingdingBridges.applyProgressUpdate({
      bridge,
      key,
      chatId,
      text,
      replyMarkup: options.replyMarkup,
    });
    if (!delivered) {
      return false;
    }
    this.deliveredAiSessionFingerprints.delete(key);
    this.logInfo({
      bridgeId: bridge.id,
      chatId,
      instanceId,
      sessionId,
      turnId,
      key,
      hasSessionWebhook: Boolean(options.sessionWebhook),
      hasSenderId: Boolean(options.senderId),
      sourcePrompt: compactLogText(options.sourcePrompt, 80),
      textPreview: compactLogText(text),
    }, "dingding ai session progress card started");
    return true;
  }

  private async handleDingdingCardCallback(bridge: ChatBridgeConfig, runtime: DingdingRuntimeBridge, message: DWClientDownStream) {
    const event = parseDingdingCardEvent(message.data);
    if (!this.dingdingAllowed(bridge, event.userId)) {
      return dingdingCardUpdateResponse("not authorized", undefined, "unauthorized", event.body, event.params);
    }
    const chatId = event.chatId || stringSetting(bridge.defaultChatId);
    const senderId = event.deliverySenderId || event.senderId;
    const sessionWebhook = event.sessionWebhook;
    if (chatId && sessionWebhook) {
      runtime.chatWebhooks.set(chatId, sessionWebhook);
    }
    if (chatId && event.conversationType) {
      runtime.conversationTypes.set(chatId, event.conversationType);
    }
    if (chatId && senderId) {
      runtime.senderIds.set(chatId, senderId);
    }
    let action: ChatGatewayAction | undefined;
    try {
      action = await this.parseChatGatewayCallbackAction(event.callbackData);
    } catch (error) {
      if (hasErrorCode(error, "CHAT_PENDING_ACTION_STALE")) {
        return dingdingCardUpdateResponse(errorMessage(error), undefined, "approval_stale", event.body, event.params);
      }
      throw error;
    }
    if (!action) {
      this.logWarn({
        bridgeId: bridge.id,
        chatId,
        userId: event.userId,
        senderId,
        ...dingdingCardCallbackLogSummary(event),
      }, "dingding card callback action unsupported");
      return dingdingCardUpdateResponse("Unsupported action", undefined, "unsupported", event.body, event.params);
    }
    this.logInfo({
      bridgeId: bridge.id,
      chatId,
      userId: event.userId,
      senderId,
      actionType: action.type,
      ...dingdingCardCallbackLogSummary(event),
    }, "dingding card callback action parsed");
    const result = await this.service.handleChatGatewayAction({
      source: {
        channel: "dingding",
        bridgeId: bridge.id,
        chatSessionId: chatId,
        userId: event.userId || undefined,
      },
      action,
    });
    if (action.type === "pending-decision" && isAcceptedGatewayResult(result)) {
      return dingdingCardUpdateResponse(`${action.decision} sent`, undefined, "approval_done", event.body, event.params);
    }
    const reply = replyFromGatewayResult(result) || stringSetting((result as { message?: unknown }).message) || "updated";
    return dingdingCardUpdateResponse(reply, replyMarkupFromGatewayResult(result), "updated", event.body, event.params);
  }

  private async pollWechat(bridge: ChatBridgeConfig, isCurrent: () => boolean = () => true) {
    if (!bridge.token) {
      return;
    }
    const settings = bridge.settings || {};
    const cursor = this.wechatCursors.get(bridge.id) || stringSetting(settings.updatesBuf);
    const result = await pollWechatMessages({
      fetchImpl: this.fetchImpl,
      bridge,
      cursor,
    });
    if (!isCurrent()) return;
    if (result.cursor) {
      this.wechatCursors.set(bridge.id, result.cursor);
      this.updateChatBridge(bridge.id, { settings: { updatesBuf: result.cursor } });
    }
    for (const message of result.messages) {
      if (!isCurrent()) return;
      const { chatId, contextToken, text } = message;
      if (!bridge.defaultChatId) {
        this.updateChatBridge(bridge.id, { defaultChatId: chatId, settings: { contextToken } });
      }
      if (bridge.defaultChatId && bridge.defaultChatId !== chatId) {
        continue;
      }
      const result = await this.service.handleChatGatewayMessage({
        source: {
          type: "chat-gateway",
          channel: "wechat",
          bridgeId: bridge.id,
          chatSessionId: chatId,
        },
        message: { text, attachments: [] },
      });
      if (!isCurrent()) return;
      const reply = replyFromGatewayResult(result);
      if (reply) {
        const adapter = createChatGatewaySendAdapter({ fetchImpl: this.fetchImpl, bridge });
        await adapter.send(chatId, reply, { contextToken: contextToken || stringSetting(settings.contextToken) });
      }
    }
  }

  pollPendingRoutes() {
    return this.pendingRouteNotifier.poll();
  }

  private async sendToChatBinding(binding: { bridgeId?: string; chatSessionId: string }, payload: ChatInteractionPayload) {
    if (!binding.bridgeId) {
      return false;
    }
    const bridge = this.service.requireChatBridge(binding.bridgeId);
    if (!bridge.enabled) {
      return false;
    }
    const sent = await this.sendViaBridge(bridge, binding.chatSessionId, payload).catch((error) => {
      this.bridgeErrors.set(bridge.id, error instanceof Error ? error.message : String(error));
      return undefined;
    });
    return Boolean(sent);
  }

  private async sendViaBridge(bridge: ChatBridgeConfig, chatId: string, payload: ChatInteractionPayload | string) {
    const text = typeof payload === "string" ? payload : payload.text;
    const replyMarkup = typeof payload === "string" ? undefined : payload.replyMarkup;
    const adapter = createChatGatewaySendAdapter({
      fetchImpl: this.fetchImpl,
      bridge,
      dingdingRuntime: this.dingdingBridges.get(bridge.id),
      larkRuntime: this.larkBridges.get(bridge.id),
    });
    return adapter.send(chatId, text, { replyMarkup });
  }

  private async pollTelegram(bridge: ChatBridgeConfig, isCurrent: () => boolean = () => true) {
    if (!bridge.token) {
      return;
    }
    const persistedOffset = Number(bridge.settings?.telegramLastUpdateId);
    const offset = this.telegramOffsets.get(bridge.id) || (Number.isInteger(persistedOffset) ? persistedOffset : undefined);
    const result = await pollTelegramUpdates({
      fetchImpl: this.fetchImpl,
      bridge,
      offset,
    });
    if (!isCurrent()) return;
    if (result.conflict) {
      this.bridgeErrors.set(bridge.id, result.conflict);
      return;
    }
    for (const update of result.updates) {
      if (!isCurrent()) return;
      if (update.updateId !== undefined) {
        const seenKey = `${bridge.id}:${update.updateId}`;
        if (this.seenTelegramUpdates.has(seenKey) || update.updateId <= (this.telegramOffsets.get(bridge.id) || 0)) {
          continue;
        }
        this.seenTelegramUpdates.add(seenKey);
        this.telegramOffsets.set(bridge.id, update.updateId);
        this.updateChatBridge(bridge.id, { settings: { ...bridge.settings, telegramLastUpdateId: update.updateId } });
      }
      if ("callbackQuery" in update) {
        const callbackQuery = update.callbackQuery;
        await this.handleTelegramCallback(bridge, callbackQuery).catch(async (error) => {
          const message = asRecord(callbackQuery.message);
          const chat = asRecord(message.chat);
          const chatId = chat.id !== undefined ? String(chat.id) : bridge.defaultChatId;
          this.bridgeErrors.set(bridge.id, errorMessage(error));
          if (chatId) {
            await this.sendTelegramMessage(bridge, chatId, `Action failed: ${errorMessage(error)}`).catch((sendError) => {
              this.bridgeErrors.set(bridge.id, errorMessage(sendError));
            });
          }
        });
        continue;
      }
      if (!this.telegramAllowed(bridge, update.userId)) {
        continue;
      }
      const attachments = await telegramMessageAttachmentsWithDownloadedImages({
        fetchImpl: this.fetchImpl,
        bridge,
        message: update.message,
        onImageDownloadError: ({ fileId, fileName, error }) => {
          this.logWarn({
            bridgeId: bridge.id,
            fileId,
            fileName,
            error: errorMessage(error),
          }, "telegram image download skipped");
        },
      });
      if (!isCurrent()) return;
      const text = update.rawText.trim();
      if (!text && !attachments.length) {
        continue;
      }
      this.logInfo({
        bridgeId: bridge.id,
        chatId: update.chatId,
        messageId: update.messageId,
        replyToMessageId: update.replyToMessageId,
        hasQuote: Boolean(update.quoteText),
        textPreview: compactLogText(text),
      }, "telegram chat gateway message received");
      await this.telegramMessageAggregator.handleIncoming(bridge, update.chatId, update.userId, text, attachments, {
        sourceMessageId: update.messageId,
        replyToMessageId: update.replyToMessageId,
        quoteText: update.quoteText,
      }, {
        autoBegin: update.autoBegin,
      });
    }
  }

  private async dispatchTelegramGatewayMessage(bridge: ChatBridgeConfig, chatId: string, userId: string | undefined, text: string, attachments: AiSessionMessageAttachment[] = [], context: TelegramMessageContext = {}) {
    try {
      const replyTarget = context.replyToMessageId !== undefined ? this.telegramReplyAiSessionTarget(bridge.id, chatId, context.replyToMessageId) : undefined;
      const messageText = textWithTelegramQuote(text, context.quoteText);
      const result = await this.service.handleChatGatewayMessage({
        source: {
          type: "chat-gateway",
          channel: "telegram",
          bridgeId: bridge.id,
          chatSessionId: chatId,
          userId,
        },
        message: {
          text: messageText,
          attachments,
        },
        ...(replyTarget
          ? {
              target: {
                instanceId: replyTarget.instanceId,
                aiSessionId: replyTarget.sessionId,
              },
            }
          : {}),
      });
      const reply = replyFromGatewayResult(result);
      const replyMarkup = replyMarkupFromGatewayResult(result);
      if (reply) {
        const sent = await this.sendTelegramMessage(bridge, chatId, reply, {
          replyMarkup,
          replyToMessageId: context.sourceMessageId,
        });
        this.logInfo({
          bridgeId: bridge.id,
          chatId,
          sourceMessageId: context.sourceMessageId,
          replyToMessageId: context.replyToMessageId,
          replyTargetInstanceId: replyTarget?.instanceId,
          replyTargetSessionId: replyTarget?.sessionId,
          sentMessageId: Number(asRecord(sent).message_id) || undefined,
          routed: asRecord(result).routed === true,
          replyPreview: compactLogText(reply),
        }, "telegram chat gateway reply sent");
        await this.rememberTelegramProgressMessage(result, bridge, chatId, sent, reply);
      }
    } catch (error) {
      this.bridgeErrors.set(bridge.id, errorMessage(error));
      await this.sendTelegramMessage(bridge, chatId, `Failed to handle message: ${errorMessage(error)}`, { replyToMessageId: context.sourceMessageId }).catch((sendError) => {
        this.bridgeErrors.set(bridge.id, errorMessage(sendError));
      });
    }
  }

  private async handleTelegramCallback(bridge: ChatBridgeConfig, callbackQuery: Record<string, unknown>) {
    const data = stringSetting(callbackQuery.data);
    const from = asRecord(callbackQuery.from);
    const message = asRecord(callbackQuery.message);
    const chat = asRecord(message.chat);
    const chatId = chat.id !== undefined ? String(chat.id) : bridge.defaultChatId;
    const userId = from.id !== undefined ? String(from.id) : undefined;
    if (!chatId || !this.telegramAllowed(bridge, userId)) {
      return;
    }
    if (await this.telegramAiSessionCallbacks.tryHandle(data, {
      bridge,
      chatId,
      callbackQueryId: stringSetting(callbackQuery.id),
      userId,
      messageId: messageIdFromTelegramMessage(message),
    })) {
      return;
    }
    const aggregateEndMatch = data.match(/^task_handoff:cp_msg_end:([^:]+)$/);
    if (aggregateEndMatch) {
      await this.telegramMessageAggregator.handleEndCallback(bridge, chatId, stringSetting(callbackQuery.id), aggregateEndMatch[1], userId);
      return;
    }
    let action: ChatGatewayAction | undefined;
    try {
      action = await this.parseChatGatewayCallbackAction(data);
    } catch (error) {
      if (hasErrorCode(error, "CHAT_PENDING_ACTION_STALE")) {
        await this.answerTelegramCallback(bridge, stringSetting(callbackQuery.id), errorMessage(error));
        const messageId = messageIdFromTelegramMessage(message);
        if (messageId !== undefined) {
          await this.deleteTelegramStandaloneApprovalMessage(bridge, chatId, messageId);
        }
        return;
      }
      throw error;
    }
    if (!action) {
      await this.answerTelegramCallback(bridge, stringSetting(callbackQuery.id), "Unsupported action");
      return;
    }
    const result = await this.service.handleChatGatewayAction({
      source: {
        channel: "telegram",
        bridgeId: bridge.id,
        chatSessionId: chatId,
        userId,
      },
      action,
    });
    if (action.type === "pending-decision" && isAcceptedGatewayResult(result)) {
      await this.answerTelegramCallback(bridge, stringSetting(callbackQuery.id), "");
      const messageId = messageIdFromTelegramMessage(message);
      if (messageId !== undefined) {
        await this.deleteTelegramStandaloneApprovalMessage(bridge, chatId, messageId);
      }
      return;
    }
    await this.answerTelegramCallback(bridge, stringSetting(callbackQuery.id), stringSetting((result as { message?: unknown }).message) || "updated");
    const reply = replyFromGatewayResult(result);
    const replyMarkup = replyMarkupFromGatewayResult(result);
    const messageId = message.message_id;
    if (reply && typeof messageId === "number") {
      await this.editTelegramMessage(bridge, chatId, messageId, reply, { replyMarkup });
      return;
    }
    if (reply) {
      await this.sendTelegramMessage(bridge, chatId, reply, { replyMarkup });
    }
  }

  private async deleteTelegramStandaloneApprovalMessage(bridge: ChatBridgeConfig, chatId: string, messageId: number) {
    const progressEntry = [...this.telegramProgress.entries.values()].find((entry) => (
      entry.messageId === messageId &&
      entry.route?.bridgeId === bridge.id &&
      entry.route?.chatId === chatId
    ));
    if (progressEntry) {
      return;
    }
    await this.deleteTelegramMessage(bridge, chatId, messageId).catch((error) => {
      this.logWarn({
        bridgeId: bridge.id,
        chatId,
        messageId,
        error: errorMessage(error),
      }, "telegram callback message delete failed");
    });
  }

  private telegramAiSessionBindingActive(bridge: ChatBridgeConfig, chatId: string, instanceId: string, sessionId: string) {
    return this.service.listChatSessions().some((entry) =>
      entry.bridgeId === bridge.id &&
      entry.chatSessionId === chatId &&
      entry.activeInstanceId === instanceId &&
      entry.activeAiSessionId === sessionId
    );
  }

  private telegramAiSessionActionAllowed(bridge: ChatBridgeConfig, chatId: string, instanceId: string, sessionId: string, messageId?: number) {
    if (this.telegramAiSessionBindingActive(bridge, chatId, instanceId, sessionId)) {
      return true;
    }
    if (!Number.isInteger(messageId)) {
      return false;
    }
    const target = this.telegramReplyAiSessionTarget(bridge.id, chatId, messageId as number);
    return Boolean(target && target.instanceId === instanceId && target.sessionId === sessionId);
  }

  private async parseChatGatewayCallbackAction(data: string) {
    const pendingDecision = parsePendingDecisionCallbackData(data);
    if (pendingDecision) {
      const matches = (await this.service.listPendingRoutes()).filter((route) =>
        route.kind === "approval" &&
        route.status === "pending" &&
        pendingDecisionRouteFingerprint(route.id) === pendingDecision.routeFingerprint
      );
      if (matches.length !== 1) {
        const error = new Error("This approval is no longer pending.");
        Object.assign(error, { statusCode: 409, code: "CHAT_PENDING_ACTION_STALE" });
        throw error;
      }
      return {
        type: "pending-decision" as const,
        routeId: matches[0].id,
        decision: pendingDecision.decision,
      };
    }
    return parseChatGatewayCallbackAction(data, (token, expectedType) => this.service.resolveChatActionToken(token, expectedType));
  }

  private dingdingAllowed(bridge: ChatBridgeConfig, userId: string | undefined) {
    const normalized = String(userId || "").trim();
    if (!normalized) {
      return false;
    }
    if (bridge.allowedUserIds.length === 0) {
      bridge.allowedUserIds = [normalized];
      this.updateChatBridge(bridge.id, { allowedUserIds: bridge.allowedUserIds });
      this.logInfo({ bridgeId: bridge.id, userId: normalized }, "dingding user bound");
      return true;
    }
    return bridge.allowedUserIds.includes(normalized);
  }

  private larkAllowed(bridge: ChatBridgeConfig, userId: string | undefined) {
    const normalized = String(userId || "").trim();
    if (!normalized) {
      return false;
    }
    if (bridge.allowedUserIds.length === 0) {
      bridge.allowedUserIds = [normalized];
      this.updateChatBridge(bridge.id, { allowedUserIds: bridge.allowedUserIds });
      this.logInfo({ bridgeId: bridge.id, userId: normalized }, "lark user bound");
      return true;
    }
    return bridge.allowedUserIds.includes(normalized);
  }

  private telegramAllowed(bridge: ChatBridgeConfig, userId: string | undefined) {
    const normalized = String(userId || "").trim();
    if (!normalized) {
      return false;
    }
    if (bridge.allowedUserIds.length === 0) {
      bridge.allowedUserIds = [normalized];
      this.updateChatBridge(bridge.id, { allowedUserIds: bridge.allowedUserIds });
      this.logInfo({ bridgeId: bridge.id, userId: normalized }, "telegram user bound");
      return true;
    }
    return bridge.allowedUserIds.includes(normalized);
  }

  private async answerTelegramCallback(bridge: ChatBridgeConfig, callbackQueryId: string, text: string) {
    return answerTelegramCallback(this.fetchImpl, bridge, callbackQueryId, text);
  }

  private async editTelegramMessage(bridge: ChatBridgeConfig, chatId: string, messageId: number, text: string, options: TelegramMessageOptions = {}) {
    return editTelegramMessage(this.fetchImpl, bridge, chatId, messageId, text, options);
  }

  private async sendTelegramMessage(bridge: ChatBridgeConfig, chatId: string, text: string, options: TelegramMessageOptions = {}) {
    return sendTelegramMessage(this.fetchImpl, bridge, chatId, text, options);
  }

  private async deleteTelegramMessage(bridge: ChatBridgeConfig, chatId: string, messageId: number) {
    return deleteTelegramMessage(this.fetchImpl, bridge, chatId, messageId);
  }

  private async rememberTelegramProgressMessage(result: ChatGatewayResult, bridge: ChatBridgeConfig, chatId: string, sent: unknown, text: string) {
    if (result.routed !== true) {
      return;
    }
    const route = routedAiSessionResult(result);
    const { instanceId, sessionId, turnId } = route;
    const messageId = Number(asRecord(sent).message_id);
    if (!instanceId || !sessionId || !turnId || !Number.isInteger(messageId)) {
      this.logWarn({
        bridgeId: bridge.id,
        chatId,
        instanceId,
        sessionId,
        turnId,
        turnIdSources: route.sources,
        messageId: Number.isInteger(messageId) ? messageId : undefined,
        routed: result.routed,
      }, "telegram ai session progress message not remembered");
      return;
    }
    const key = aiSessionDeliveryKey(instanceId, sessionId, turnId, bridge.id, chatId);
    const replaced = this.telegramProgress.remember(key, messageId, text, { bridgeId: bridge.id, chatId });
    this.telegramProgressMessageTargets.set(telegramProgressMessageTargetKey(bridge.id, chatId, messageId), { instanceId, sessionId, turnId, messageId });
    this.deliveredAiSessionFingerprints.delete(key);
    this.logInfo({
      bridgeId: bridge.id,
      chatId,
      instanceId,
      sessionId,
      turnId,
      turnIdSources: route.sources,
      key,
      messageId,
      progressKeys: this.telegramProgressKeysFor(instanceId, sessionId, bridge.id, chatId),
      textPreview: compactLogText(text),
    }, "telegram ai session progress message remembered");
    if (routedAiSessionAction(result) !== "queue" || !replaced?.messageId || replaced.messageId === messageId) {
      return;
    }
    this.telegramProgressMessageTargets.delete(telegramProgressMessageTargetKey(bridge.id, chatId, replaced.messageId));
    await this.deleteTelegramMessage(bridge, chatId, replaced.messageId).catch((error) => {
      this.logWarn({
        bridgeId: bridge.id,
        chatId,
        instanceId,
        sessionId,
        turnId,
        replacedMessageId: replaced.messageId,
        replacementMessageId: messageId,
        error: errorMessage(error),
      }, "telegram queued progress message replacement cleanup failed");
    });
  }

  private telegramReplyAiSessionTarget(bridgeId: string, chatId: string, replyToMessageId: number): TelegramReplyAiSessionTarget | undefined {
    const remembered = this.telegramProgressMessageTargets.get(telegramProgressMessageTargetKey(bridgeId, chatId, replyToMessageId));
    if (remembered) {
      return remembered;
    }
    for (const [key, entry] of this.telegramProgress.entries) {
      if (entry.messageId === replyToMessageId && entry.route?.bridgeId === bridgeId && entry.route?.chatId === chatId) {
        const parsed = parseAiSessionDeliveryKey(key, bridgeId, chatId);
        if (parsed) {
          const target = { ...parsed, messageId: replyToMessageId };
          this.telegramProgressMessageTargets.set(telegramProgressMessageTargetKey(bridgeId, chatId, replyToMessageId), target);
          return target;
        }
      }
    }
    return undefined;
  }

  private async pollAiSessionUpdates() {
    this.logAiSessionDelivery({
      stage: "poll-tick",
    });
    const snapshot = await this.service.listAiSessions({ refresh: true }).catch(() => undefined);
    if (!snapshot) {
      this.logAiSessionDelivery({
        stage: "poll-no-snapshot",
      });
      return;
    }
    const byInstance = new Map<string, AiSessionsSnapshot>(snapshot.instances.map((entry) => [entry.instanceId, entry.aiSessions]));
    this.logAiSessionDelivery({
      stage: "poll-snapshot",
      instanceCount: byInstance.size,
      instances: [...byInstance.entries()].map(([instanceId, aiSessions]) => ({
        instanceId,
        sessionCount: aiSessions.sessions?.length || 0,
        runningCount: aiSessions.runningCount,
        waitingCount: aiSessions.waitingCount,
        updatedAt: aiSessions.updatedAt,
      })),
    });
    const instanceNames = await this.aiSessionInstanceNames();
    for (const [instanceId, aiSessions] of byInstance) {
      await this.deliverAiSessionSnapshot(instanceId, aiSessions, instanceNames);
    }
  }

  private async deliverAiSessionSnapshot(instanceId: string, snapshot: AiSessionsSnapshot, instanceNames?: Map<string, string>) {
    const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    this.pruneAiSessionDeliveryState(instanceId, new Set(sessions.map((session) => session.id)));
    if (sessions.length === 0) {
      return;
    }
    const names = instanceNames || await this.aiSessionInstanceNames();
    const pendingApprovals = await this.aiSessionPendingApprovalRoutes(instanceId);
    await this.deliverOwnedTelegramProgress(instanceId, sessions, names, pendingApprovals);
    await this.deliverActiveBindingTelegramProgress(instanceId, sessions, names, pendingApprovals);
  }

  private pruneAiSessionDeliveryState(instanceId: string, liveSessionIds: Set<string>) {
    for (const [key, entry] of this.telegramProgress.entries) {
      const owner = entry.route?.bridgeId && entry.route.chatId
        ? this.telegramProgressMessageTargets.get(telegramProgressMessageTargetKey(entry.route.bridgeId, entry.route.chatId, entry.messageId || 0))
          || parseAiSessionDeliveryKey(key, entry.route.bridgeId, entry.route.chatId)
        : undefined;
      if (!owner || owner.instanceId !== instanceId || liveSessionIds.has(owner.sessionId)) continue;
      if (entry.timer) clearTimeout(entry.timer);
      this.telegramProgress.entries.delete(key);
      this.deliveredAiSessionFingerprints.delete(key);
      if (entry.route?.bridgeId && entry.route.chatId && entry.messageId) {
        this.telegramProgressMessageTargets.delete(telegramProgressMessageTargetKey(entry.route.bridgeId, entry.route.chatId, entry.messageId));
      }
    }
  }

  private async deliverActiveBindingTelegramProgress(
    instanceId: string,
    sessions: AiSessionSummary[],
    names: Map<string, string>,
    pendingApprovals: Map<string, PendingRoute & { instance?: { id: string; name?: string } }>,
  ) {
    for (const binding of this.service.listChatSessions()) {
      if (!binding.bridgeId || binding.activeInstanceId !== instanceId || !binding.activeAiSessionId) {
        continue;
      }
      const session = sessions.find((entry) => entry.id === binding.activeAiSessionId);
      if (!session) {
        continue;
      }
      const heading = aiSessionDeliveryHeading(names.get(instanceId) || instanceId, session);
      const text = aiSessionDeliveryText(session, heading);
      if (!text) {
        this.logAiSessionDelivery({
          stage: "skip-empty-text",
          instanceId,
          sessionId: session.id,
          bridgeId: binding.bridgeId,
          chatId: binding.chatSessionId,
          status: session.status,
          phase: session.phase,
          activeTurnId: session.activeTurnId,
          latestTurn: aiSessionTurnLogSummary(latestAiSessionTurn(session)),
        });
        continue;
      }
      const turnId = aiSessionDeliveryTurnId(session);
      if (!turnId) {
        this.logAiSessionDelivery({
          stage: "skip-empty-turn-id",
          instanceId,
          sessionId: session.id,
          bridgeId: binding.bridgeId,
          chatId: binding.chatSessionId,
          status: session.status,
          phase: session.phase,
          activeTurnId: session.activeTurnId,
          latestTurn: aiSessionTurnLogSummary(latestAiSessionTurn(session)),
        });
        continue;
      }
      const ownedCurrentTurn = this.listTelegramOwnedProgressEntries(instanceId).some((owned) =>
        owned.route.bridgeId === binding.bridgeId &&
        owned.route.chatId === binding.chatSessionId &&
        owned.owner.sessionId === session.id &&
        owned.owner.turnId === turnId
      );
      if (ownedCurrentTurn) {
        continue;
      }
      const key = aiSessionDeliveryKey(instanceId, session.id, turnId, binding.bridgeId || "", binding.chatSessionId);
      const fingerprint = aiSessionFingerprint(session, heading);
      if (!fingerprint || this.deliveredAiSessionFingerprints.get(key) === fingerprint) {
        this.logAiSessionDelivery({
          stage: "skip-duplicate-fingerprint",
          instanceId,
          sessionId: session.id,
          bridgeId: binding.bridgeId,
          chatId: binding.chatSessionId,
          turnId,
          key,
          hasFingerprint: Boolean(fingerprint),
          fingerprintMatched: this.deliveredAiSessionFingerprints.get(key) === fingerprint,
          latestTurn: aiSessionTurnLogSummary(latestAiSessionTurn(session)),
          textPreview: compactLogText(text),
        });
        continue;
      }
      const actions = aiSessionProgressActions({
        cancelCallbackData: this.telegramAiSessionCallbacks.cancelCallbackData(instanceId, session.id),
        queueSteerCallbackData: (queueId) => this.telegramAiSessionCallbacks.queueSteerCallbackData(instanceId, session.id, queueId),
        queueDeleteMenuCallbackData: () => this.telegramAiSessionCallbacks.queueDeleteMenuCallbackData(instanceId, session.id),
        permissionCallbackData: (routeId, decision) => this.service.pendingDecisionCallbackData(routeId, decision),
        pendingApproval: pendingApprovals.get(session.id) || approvalRoute(instanceId, session),
        session,
      });
      this.logAiSessionDelivery({
        stage: "attempt",
        instanceId,
        sessionId: session.id,
        bridgeId: binding.bridgeId,
        chatId: binding.chatSessionId,
        turnId,
        key,
        relatedProgressKeys: this.telegramProgressKeysFor(instanceId, session.id, binding.bridgeId || "", binding.chatSessionId),
        hasProgressEntry: this.telegramProgress.entries.has(key),
        status: session.status,
        phase: session.phase,
        activeTurnId: session.activeTurnId,
        latestTurn: aiSessionTurnLogSummary(latestAiSessionTurn(session)),
        textPreview: compactLogText(text),
      });
      const delivered = await this.updateChatAiSessionProgress(binding, text, key, actions).catch((error) => {
        this.bridgeErrors.set(binding.bridgeId || "", error instanceof Error ? error.message : String(error));
        this.logWarn({
          bridgeId: binding.bridgeId,
          chatId: binding.chatSessionId,
          instanceId,
          sessionId: session.id,
          turnId,
          key,
          error: errorMessage(error),
        }, "chat ai session progress update failed");
        return false;
      });
      if (delivered) {
        this.logAiSessionDelivery({
          stage: "delivered",
          instanceId,
          sessionId: session.id,
          bridgeId: binding.bridgeId,
          chatId: binding.chatSessionId,
          turnId,
          key,
          textPreview: compactLogText(text),
        });
        this.deliveredAiSessionFingerprints.set(key, fingerprint);
        continue;
      }
      if (this.service.requireChatBridge(binding.bridgeId).channel === "telegram") {
        const progress = this.telegramProgress.entries.get(key);
        const bridge = this.service.requireChatBridge(binding.bridgeId);
        this.logAiSessionDelivery({
          stage: progress ? "telegram-update-not-delivered" : "telegram-no-progress-entry",
          instanceId,
          sessionId: session.id,
          bridgeId: binding.bridgeId,
          chatId: binding.chatSessionId,
          turnId,
          key,
          relatedProgressKeys: this.telegramProgressKeysFor(instanceId, session.id, binding.bridgeId || "", binding.chatSessionId),
          bridgeEnabled: bridge.enabled,
          bridgeChannel: bridge.channel,
          progressMessageId: progress?.messageId,
          progressLastText: compactLogText(progress?.lastText),
          progressHasPending: Boolean(progress?.pending),
          latestTurn: aiSessionTurnLogSummary(latestAiSessionTurn(session)),
          textPreview: compactLogText(text),
        });
        continue;
      }
      const fallbackSent = await this.sendToChatBinding(binding, { text }).catch((error) => {
        this.bridgeErrors.set(binding.bridgeId || "", error instanceof Error ? error.message : String(error));
        return false;
      });
      if (fallbackSent) {
        this.logAiSessionDelivery({
          stage: "fallback-sent",
          instanceId,
          sessionId: session.id,
          bridgeId: binding.bridgeId,
          chatId: binding.chatSessionId,
          turnId,
          key,
          textPreview: compactLogText(text),
        });
        this.deliveredAiSessionFingerprints.set(key, fingerprint);
      }
    }
  }

  private async deliverOwnedTelegramProgress(
    instanceId: string,
    sessions: AiSessionSummary[],
    names: Map<string, string>,
    pendingApprovals: Map<string, PendingRoute & { instance?: { id: string; name?: string } }>,
  ) {
    for (const owned of this.listTelegramOwnedProgressEntries(instanceId)) {
      const bridge = this.service.requireChatBridge(owned.route.bridgeId);
      if (bridge.channel !== "telegram" || !bridge.enabled) {
        continue;
      }
      const session = this.matchTelegramOwnedProgressSession(owned, sessions);
      if (!session) {
        continue;
      }
      const binding = {
        bridgeId: owned.route.bridgeId,
        chatSessionId: owned.route.chatId,
      };
      const heading = aiSessionDeliveryHeading(names.get(instanceId) || instanceId, session);
      const text = aiSessionDeliveryText(session, heading);
      const turnId = aiSessionDeliveryTurnId(session);
      if (!text || !turnId) {
        this.logAiSessionDelivery({ stage: "remembered-skip-turn-or-text", key: owned.key, parsedTurnId: owned.owner.turnId, currentTurnId: turnId, hasText: Boolean(text), instanceId, sessionId: session.id, bridgeId: owned.route.bridgeId, chatId: owned.route.chatId });
        continue;
      }
      if (owned.owner.turnId && turnId !== owned.owner.turnId) {
        this.logAiSessionDelivery({ stage: "remembered-skip-different-active-turn", key: owned.key, ownerTurnId: owned.owner.turnId, currentTurnId: turnId, instanceId, sessionId: session.id, bridgeId: owned.route.bridgeId, chatId: owned.route.chatId });
        continue;
      }
      const nextKey = turnId === owned.owner.turnId ? owned.key : aiSessionDeliveryKey(instanceId, session.id, turnId, owned.route.bridgeId, owned.route.chatId);
      if (nextKey !== owned.key && this.telegramProgress.entries.has(nextKey)) {
        continue;
      }
      if (nextKey !== owned.key) {
        if (!this.rekeyTelegramOwnedProgress(owned, nextKey, { instanceId, sessionId: session.id, turnId })) {
          continue;
        }
      }
      const fingerprint = aiSessionFingerprint(session, heading);
      if (!fingerprint || this.deliveredAiSessionFingerprints.get(nextKey) === fingerprint) {
        this.logAiSessionDelivery({ stage: "remembered-skip-fingerprint", key: owned.key, hasFingerprint: Boolean(fingerprint), fingerprintMatched: this.deliveredAiSessionFingerprints.get(nextKey) === fingerprint, instanceId, sessionId: session.id, bridgeId: owned.route.bridgeId, chatId: owned.route.chatId });
        continue;
      }
      const actions = aiSessionProgressActions({
        cancelCallbackData: this.telegramAiSessionCallbacks.cancelCallbackData(instanceId, session.id),
        queueSteerCallbackData: (queueId) => this.telegramAiSessionCallbacks.queueSteerCallbackData(instanceId, session.id, queueId),
        queueDeleteMenuCallbackData: () => this.telegramAiSessionCallbacks.queueDeleteMenuCallbackData(instanceId, session.id),
        permissionCallbackData: (routeId, decision) => this.service.pendingDecisionCallbackData(routeId, decision),
        pendingApproval: pendingApprovals.get(session.id) || approvalRoute(instanceId, session),
        session,
      });
      const delivered = await this.updateChatAiSessionProgress(binding, text, nextKey, actions).catch((error) => {
        this.bridgeErrors.set(binding.bridgeId || "", error instanceof Error ? error.message : String(error));
        return false;
      });
      this.logAiSessionDelivery({ stage: delivered ? "remembered-delivered" : "remembered-not-delivered", key: nextKey, instanceId, sessionId: session.id, bridgeId: owned.route.bridgeId, chatId: owned.route.chatId, textPreview: compactLogText(text) });
      if (delivered) {
        this.telegramProgressMessageTargets.set(
          telegramProgressMessageTargetKey(owned.route.bridgeId, owned.route.chatId, owned.messageId),
          { instanceId, sessionId: session.id, turnId, messageId: owned.messageId },
        );
        this.deliveredAiSessionFingerprints.set(nextKey, fingerprint);
      }
    }
  }

  private rekeyTelegramOwnedProgress(
    owned: TelegramOwnedProgressEntry,
    nextKey: string,
    owner: { instanceId: string; sessionId: string; turnId: string },
  ) {
    if (!this.telegramProgress.rekey(owned.key, nextKey)) {
      return false;
    }
    this.deliveredAiSessionFingerprints.delete(owned.key);
    this.telegramProgressMessageTargets.set(
      telegramProgressMessageTargetKey(owned.route.bridgeId, owned.route.chatId, owned.messageId),
      { ...owner, messageId: owned.messageId },
    );
    return true;
  }

  private logAiSessionDelivery(data: Record<string, unknown>) {
    this.logInfo(data, "telegram ai session delivery flow");
  }

  private telegramProgressKeysFor(instanceId: string, sessionId: string, bridgeId: string, chatId: string) {
    const prefix = `${instanceId}:${sessionId}:`;
    const suffix = `:${bridgeId}:${chatId}`;
    return [...this.telegramProgress.entries.keys()].filter((key) => key.startsWith(prefix) && key.endsWith(suffix));
  }

  private listTelegramOwnedProgressEntries(instanceId: string) {
    const entries: TelegramOwnedProgressEntry[] = [];
    for (const [key, entry] of this.telegramProgress.entries) {
      if (!entry.route?.bridgeId || !entry.route.chatId || !Number.isInteger(entry.messageId)) {
        continue;
      }
      const owner = this.telegramProgressMessageTargets.get(telegramProgressMessageTargetKey(entry.route.bridgeId, entry.route.chatId, entry.messageId))
        || parseAiSessionDeliveryKey(key, entry.route.bridgeId, entry.route.chatId);
      if (!owner || owner.instanceId !== instanceId) {
        continue;
      }
      entries.push({
        key,
        route: { bridgeId: entry.route.bridgeId, chatId: entry.route.chatId },
        messageId: entry.messageId,
        owner: { ...owner, messageId: entry.messageId },
      });
    }
    return entries;
  }

  private matchTelegramOwnedProgressSession(owned: TelegramOwnedProgressEntry, sessions: AiSessionSummary[]) {
    const bySessionId = sessions.find((session) => session.id === owned.owner.sessionId);
    if (bySessionId) {
      return bySessionId;
    }
    if (owned.owner.turnId) {
      const byTurnId = sessions.find((session) => (
        session.activeTurnId === owned.owner.turnId ||
        latestAiSessionTurn(session)?.id === owned.owner.turnId ||
        latestAiSessionTurn(session)?.providerTurnId === owned.owner.turnId
      ));
      if (byTurnId) {
        return byTurnId;
      }
    }
    return undefined;
  }

  private async updateChatAiSessionProgress(binding: { bridgeId?: string; chatSessionId: string }, text: string, key: string, actionRows?: Array<Array<{ text: string; callbackData: string }>>) {
    if (!binding.bridgeId) {
      this.logAiSessionDelivery({
        stage: "chat-update-skip-missing-bridge",
        chatId: binding.chatSessionId,
        key,
      });
      return false;
    }
    const bridge = this.service.requireChatBridge(binding.bridgeId);
    if (!bridge.enabled) {
      this.logAiSessionDelivery({
        stage: "chat-update-skip-bridge-state",
        bridgeId: binding.bridgeId,
        chatId: binding.chatSessionId,
        key,
        bridgeEnabled: bridge.enabled,
        bridgeChannel: bridge.channel,
      });
      return false;
    }
    if (bridge.channel === "dingding") {
      const runtime = this.dingdingBridges.get(bridge.id);
      if (!runtime) {
        return false;
      }
      const updated = await this.dingdingBridges.applyProgressUpdate({
        bridge,
        key,
        chatId: binding.chatSessionId,
        text,
        replyMarkup: progressReplyMarkup({ actionRows }),
      });
      if (updated) {
        this.logInfo({
          bridgeId: binding.bridgeId,
          chatId: binding.chatSessionId,
          key,
          textPreview: compactLogText(text),
        }, "dingding ai session progress updated");
      }
      return updated;
    }
    if (bridge.channel !== "telegram") {
      return false;
    }
    const progress = this.telegramProgress.entries.get(key);
    const updated = await this.telegramProgress.applyUpdate({
      bridge,
      key,
      chatId: binding.chatSessionId,
      text,
      actionRows,
    });
    if (!updated) {
      const nextProgress = this.telegramProgress.entries.get(key);
      this.logAiSessionDelivery({
        stage: "telegram-update-returned-false",
        bridgeId: binding.bridgeId,
        chatId: binding.chatSessionId,
        key,
        progressMessageId: progress?.messageId || nextProgress?.messageId,
        progressLastText: compactLogText(progress?.lastText || nextProgress?.lastText),
        progressHasPending: Boolean(progress?.pending || nextProgress?.pending),
      });
      return false;
    }
    this.logInfo({
      bridgeId: binding.bridgeId,
      chatId: binding.chatSessionId,
      key,
      messageId: progress?.messageId || this.telegramProgress.entries.get(key)?.messageId,
      textPreview: compactLogText(text),
    }, progress ? "telegram ai session progress edited" : "telegram ai session progress sent");
    return true;
  }

  private async aiSessionInstanceNames() {
    return this.aiSessionInstanceNamesCache.get();
  }

  private async aiSessionPendingApprovalRoutes(instanceId: string) {
    const routes = await this.aiSessionPendingRoutesCache.get();
    return new Map(routes
      .filter((route) => route.instanceId === instanceId && route.aiSessionId && route.kind === "approval")
      .map((route) => [route.aiSessionId || "", route]));
  }

}

function replyFromGatewayResult(result: unknown) {
  return typeof result === "object" && result && "reply" in result ? String((result as { reply?: unknown }).reply || "") : "";
}

function isAcceptedGatewayResult(result: unknown) {
  return typeof result === "object" && result !== null && (result as { accepted?: unknown }).accepted === true;
}

function replyMarkupFromGatewayResult(result: unknown): ChatInlineKeyboard | undefined {
  const replyMarkup = typeof result === "object" && result && "replyMarkup" in result ? (result as { replyMarkup?: unknown }).replyMarkup : undefined;
  if (!replyMarkup || typeof replyMarkup !== "object" || Array.isArray(replyMarkup)) {
    return undefined;
  }
  return replyMarkup as ChatInlineKeyboard;
}

function progressReplyMarkup(options: { actions?: Array<{ text: string; callbackData: string }>; actionRows?: Array<Array<{ text: string; callbackData: string }>> } | undefined): ChatInlineKeyboard | undefined {
  const actionRows = Array.isArray(options?.actionRows) ? options.actionRows : undefined;
  if (actionRows) {
    return createInlineKeyboard(actionRows);
  }
  const actions = Array.isArray(options?.actions) ? options.actions : [];
  return createInlineKeyboard(actions.map((action) => [action]));
}

function messageIdFromTelegramMessage(message: Record<string, unknown> | undefined) {
  const id = Number(message?.message_id);
  return Number.isInteger(id) ? id : undefined;
}

function telegramProgressMessageTargetKey(bridgeId: string, chatId: string, messageId: number) {
  return [bridgeId, chatId, String(messageId)].join(":");
}

function textWithTelegramQuote(text: string, quoteText: string | undefined) {
  const quote = String(quoteText || "").trim();
  const body = text.trim();
  if (!quote) {
    return body;
  }
  return [`引用：${quote}`, body].filter(Boolean).join("\n");
}

function parseAiSessionDeliveryKey(key: string, bridgeId: string, chatId: string): TelegramReplyAiSessionTarget | undefined {
  const suffix = `:${bridgeId}:${chatId}`;
  if (!key.endsWith(suffix)) {
    return undefined;
  }
  const prefix = key.slice(0, -suffix.length);
  const parts = prefix.split(":");
  const instanceId = parts[0] || "";
  const sessionId = parts[1] || "";
  const turnId = parts.slice(2).join(":") || undefined;
  return instanceId && sessionId ? { instanceId, sessionId, turnId } : undefined;
}

function stringSetting(value: unknown) {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function hasErrorCode(error: unknown, code: string) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function compactLogText(value: unknown, maxLength = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function dingdingCardCallbackLogSummary(event: ReturnType<typeof parseDingdingCardEvent>) {
  const cardActionData = recordSetting(event.body.cardActionData || event.body.content);
  const privateData = recordSetting(cardActionData.cardPrivateData || event.body.cardPrivateData || event.body.content);
  return {
    outTrackId: stringSetting(event.body.outTrackId),
    spaceId: stringSetting(event.body.spaceId),
    conversationType: event.conversationType,
    hasCallbackData: Boolean(event.callbackData),
    callbackDataPreview: compactLogText(event.callbackData, 120),
    actionIds: [
      ...stringArraySetting(privateData.actionIdList),
      ...stringArraySetting(cardActionData.actionIdList),
      stringSetting(privateData.actionId),
      stringSetting(cardActionData.actionId),
      stringSetting(event.body.actionId),
    ].filter(Boolean).slice(0, 5),
    cardActionDataKeys: Object.keys(cardActionData).sort(),
    privateDataKeys: Object.keys(privateData).sort(),
    paramKeys: Object.keys(event.params).sort(),
    hasSessionWebhook: Boolean(event.sessionWebhook),
  };
}

function aiSessionTurnLogSummary(turn: ReturnType<typeof latestAiSessionTurn>) {
  if (!turn) {
    return undefined;
  }
  return {
    id: turn.id,
    providerTurnId: turn.providerTurnId,
    source: turn.source,
    status: turn.status,
    phase: turn.phase,
    revision: turn.revision,
    userPrompt: compactLogText(turn.userPrompt, 80),
    hasResponse: Boolean(turn.lastMessage?.trim() || turn.summary?.trim()),
    responsePreview: compactLogText(turn.lastMessage || turn.summary, 80),
    updatedAt: turn.updatedAt,
    observedAt: turn.observedAt,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordSetting(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return {};
}

function stringArraySetting(value: unknown) {
  return Array.isArray(value) ? value.map((item) => stringSetting(item)).filter(Boolean) : [];
}

function routedAiSessionResult(result: ChatGatewayResult) {
  const actionResult = result.aiSession && "session" in result.aiSession ? result.aiSession : undefined;
  const session = actionResult?.session || (result.aiSession && "id" in result.aiSession ? result.aiSession : undefined);
  const instanceId = result.instanceId || result.instance?.id || "";
  const sessionId = result.aiSessionId || session?.id || result.binding?.activeAiSessionId || "";
  const turnId = result.turnId || result.providerTurnId || actionResult?.turnId || actionResult?.providerTurnId || (session ? aiSessionDeliveryTurnId(session) : "");
  return {
    instanceId,
    sessionId,
    turnId,
    sources: {
      resultTurnId: result.turnId,
      resultProviderTurnId: result.providerTurnId,
      actionTurnId: actionResult?.turnId,
      actionProviderTurnId: actionResult?.providerTurnId,
      sessionActiveTurnId: session?.activeTurnId,
      latestTurnId: session ? latestAiSessionTurn(session)?.id : undefined,
    },
  };
}

function routedAiSessionAction(result: ChatGatewayResult) {
  return result.aiSession && "action" in result.aiSession ? result.aiSession.action : undefined;
}

const TELEGRAM_AI_QUEUE_BUTTON_LIMIT = 5;
const TELEGRAM_AI_QUEUE_BUTTON_TEXT_MAX = 48;

function aiSessionProgressActions(input: {
  cancelCallbackData: string;
  queueSteerCallbackData: (queueId: string) => string;
  queueDeleteMenuCallbackData: () => string;
  permissionCallbackData: (routeId: string, decision: "allow" | "deny" | "skip") => string;
  pendingApproval?: Pick<PendingRoute, "id" | "kind">;
  session: AiSessionSummary;
}) {
  const { cancelCallbackData, queueSteerCallbackData, queueDeleteMenuCallbackData, permissionCallbackData, pendingApproval, session } = input;
  const permissionRows = pendingApproval?.kind === "approval"
    ? [[
        { text: "Allow", callbackData: permissionCallbackData(pendingApproval.id, "allow") },
        { text: "Skip", callbackData: permissionCallbackData(pendingApproval.id, "skip") },
        { text: "Deny", callbackData: permissionCallbackData(pendingApproval.id, "deny") },
      ]]
    : [];
  if (session.status !== "running") {
    return permissionRows;
  }
  const queuedItems = (session.queue?.items || [])
    .filter((item) => item.status === "queued")
    .slice(0, TELEGRAM_AI_QUEUE_BUTTON_LIMIT);
  const queueRows = queuedItems.map((item, index) => [{
      text: telegramQueueButtonText(item.message, index),
      callbackData: queueSteerCallbackData(item.id),
    }]);
  const footer = queuedItems.length
    ? [
        { text: "Delete Queue", callbackData: queueDeleteMenuCallbackData() },
        { text: "Cancel", callbackData: cancelCallbackData },
      ]
    : [{ text: "Cancel", callbackData: cancelCallbackData }];
  return [...queueRows, footer];
}

function approvalRoute(instanceId: string, session: AiSessionSummary): Pick<PendingRoute, "id" | "kind"> | undefined {
  if (session.phase !== "approval") {
    return undefined;
  }
  return {
    id: `${instanceId}:ai:${session.id}`,
    kind: "approval",
  };
}

function telegramQueueButtonText(message: string, index: number) {
  const prefix = `${index + 1}. `;
  const normalized = message.replace(/\s+/g, " ").trim() || "Queued message";
  const budget = Math.max(8, TELEGRAM_AI_QUEUE_BUTTON_TEXT_MAX - prefix.length);
  const chars = Array.from(normalized);
  const text = chars.length > budget ? `${chars.slice(0, Math.max(1, budget - 3)).join("")}...` : normalized;
  return `${prefix}${text}`;
}

function aiSessionDeliveryKey(instanceId: string, sessionId: string, ...parts: string[]) {
  return [instanceId, sessionId, ...parts].join(":");
}

function aiSessionDeliveryTurnId(session: Partial<AiSessionSummary> | Record<string, unknown>) {
  const latest = latestAiSessionTurn(session as Partial<AiSessionSummary>);
  if (latest?.id) {
    return latest.id;
  }
  return stringSetting((session as Partial<AiSessionSummary>).activeTurnId);
}

export function aiSessionFingerprint(session: Partial<AiSessionSummary>, heading = "") {
  const latestTurn = latestAiSessionTurn(session);
  return [
    heading,
    latestTurn?.id || "",
    String(latestTurn?.revision ?? ""),
    latestTurn?.status || session.status || "",
    latestTurn?.phase || session.phase || "",
    latestTurn?.lastMessage || "",
    latestTurn?.summary || "",
    latestTurn?.userPrompt || "",
    session.error || "",
    session.currentTool?.id || "",
    session.currentTool?.name || "",
    session.currentTool?.inputPreview || "",
    String(session.toolCallsSinceLastMessage ?? 0),
    aiSessionQueueFingerprint(session),
  ].join("\u0000");
}

function aiSessionQueueFingerprint(session: Partial<AiSessionSummary>) {
  return (session.queue?.items || [])
    .map((item) => [item.id, item.status, item.message].join(":"))
    .join("|");
}

export function aiSessionDeliveryText(session: AiSessionSummary, heading: string) {
  const latestTurn = latestAiSessionTurn(session);
  const body = aiSessionDeliveryBody(session, latestTurn);
  return body ? `${heading}\n${body}` : "";
}

function aiSessionDeliveryHeading(instanceName: string, session: Partial<AiSessionSummary>) {
  const state = [session.status, session.phase && session.phase !== "unknown" ? session.phase : undefined].filter(Boolean).join("/");
  return `${instanceName} · ${session.agent || "ai"} ${state || "unknown"}`;
}

function aiSessionDeliveryBody(session: AiSessionSummary, latestTurn: ReturnType<typeof latestAiSessionTurn>) {
  let response = "";
  if (latestTurn) {
    if (latestTurn.status === "waiting" && latestTurn.phase === "approval" && latestTurn.summary?.trim()) {
      response = latestTurn.summary.trim();
    } else if (latestTurn.lastMessage?.trim()) {
      response = latestTurn.lastMessage.trim();
    } else if (latestTurn.summary?.trim()) {
      response = latestTurn.summary.trim();
    }
  } else if (session.status === "waiting" && session.phase === "approval" && session.summary?.trim()) {
    response = session.summary.trim();
  } else if (session.lastMessage?.trim()) {
    response = session.lastMessage.trim();
  } else if (session.summary?.trim()) {
    response = session.summary.trim();
  } else if (session.error?.trim()) {
    response = session.status === "failed" ? `${session.agent} session failed:\n${session.error.trim()}` : session.error.trim();
  }

  const toolActivity = aiSessionToolActivityText(session);
  return [response, toolActivity && !toolActivityAlreadyDisplayed(response, session) ? toolActivity : ""].filter(Boolean).join("\n\n");
}

function toolActivityAlreadyDisplayed(response: string, session: Partial<AiSessionSummary>) {
  if (session.status !== "waiting" || session.phase !== "approval") return false;
  const preview = session.currentTool?.inputPreview?.trim();
  return Boolean(preview && response.includes(preview));
}

function aiSessionToolActivityText(session: Partial<AiSessionSummary>) {
  if (session.currentTool?.name) {
    return `Thinking... · ${session.currentTool.name}${session.currentTool.inputPreview ? ` · ${session.currentTool.inputPreview}` : ""}`;
  }
  const count = session.toolCallsSinceLastMessage ?? 0;
  return count > 0 ? `Thinking... · ${count} ${count === 1 ? "tool" : "tools"} completed` : "";
}

function latestAiSessionTurn(session: Partial<AiSessionSummary>) {
  const turns = (session.turns || []).filter((turn) => turn.id || turn.userPrompt?.trim() || turn.lastMessage?.trim() || turn.summary?.trim());
  return turns.at(-1);
}

function latestAiSessionTurnIndex(session: Partial<AiSessionSummary>) {
  const turns = session.turns || [];
  const latest = latestAiSessionTurn(session);
  return latest ? turns.indexOf(latest) : -1;
}
