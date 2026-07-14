import axios from "axios";
import { DWClient, TOPIC_CARD, TOPIC_ROBOT } from "dingtalk-stream";
import type { DWClientDownStream } from "dingtalk-stream";
import { attachmentLabel } from "@task-handoff/core/core/attachments";
import type { ChatBridgeCapabilities, ChatPayload } from "@task-handoff/core/core/chat";
import type { ChatProgressOptions } from "@task-handoff/core/core/chat";
import { encodeChatActionData, inlineKeyboardToActions } from "@task-handoff/core/core/chat-interactions";
import { renderPlainChatPayload } from "@task-handoff/core/core/chat-render";
import { color } from "@task-handoff/terminal-ui";
import { handleDingdingLogicalCardAction } from "./dingding-card-actions";
import type { DingdingBridgeOptions, DingdingCardCallback, DingdingProgressEntry, DingdingRobotMessage, DingdingTargetRoute } from "./dingding-types";
import { asRecord, errorMessage, jsonValuesToString, markdownTitle, normalizeAllowedUserIds, openSpaceIdIMGroup, parseDownstreamData, progressActions } from "./dingding-utils";

const DINGDING_API_BASE = "https://api.dingtalk.com";
const DEFAULT_CARD_TEMPLATE_ID = "13fc6717-12e4-43ed-8533-111a310d4995.schema";
const DEFAULT_CARD_CALLBACK_ROUTE_KEY = "bi_workflow_ticket";
const DINGDING_PROGRESS_UPDATE_MS = 1000;

class DingdingBridge {
  clientId?: string;
  clientSecret?: string;
  corpId?: string;
  robotCode?: string;
  cardTemplateId?: string;
  cardCallbackRouteKey?: string;
  cardUserIdType: number;
  chatId?: string;
  allowedUserIds: string[];
  enabled: boolean;
  multiChat: boolean;
  client?: DWClient;
  polling: boolean;
  sessionWebhooks: Map<string, string>;
  senderIds: Map<string, string>;
  accessToken?: { value: string; expiresAt: number };
  progressCards: Map<string, DingdingProgressEntry>;
  onText: DingdingBridgeOptions["onText"];
  onAction?: DingdingBridgeOptions["onAction"];
  onLog: (message: string) => void;
  onChange?: DingdingBridgeOptions["onChange"];
  capabilities: ChatBridgeCapabilities;

  constructor({
    clientId,
    clientSecret,
    corpId,
    robotCode,
    cardTemplateId,
    cardCallbackRouteKey,
    cardUserIdType = 1,
    chatId,
    allowedUserIds,
    multiChat = false,
    onText,
    onAction,
    onLog,
    onChange,
  }: DingdingBridgeOptions) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = undefined;
    this.corpId = corpId;
    this.robotCode = robotCode;
    this.cardTemplateId = cardTemplateId || DEFAULT_CARD_TEMPLATE_ID;
    this.cardCallbackRouteKey = cardCallbackRouteKey || DEFAULT_CARD_CALLBACK_ROUTE_KEY;
    this.cardUserIdType = Number(cardUserIdType) || 1;
    this.chatId = chatId;
    this.allowedUserIds = this.normalizeAllowedUserIds(allowedUserIds);
    this.enabled = Boolean(clientId && clientSecret);
    this.multiChat = Boolean(multiChat);
    this.polling = false;
    this.onText = onText;
    this.onAction = onAction;
    this.onLog = onLog;
    this.onChange = onChange;
    this.capabilities = {
      markdown: true,
      buttons: true,
      editMessage: false,
      deleteMessage: false,
      reaction: false,
      progress: true,
      plainTextOnly: false,
    };
    this.sessionWebhooks = new Map();
    this.senderIds = new Map();
    this.progressCards = new Map();
  }

  statusLines() {
    return [
      `enabled: ${this.enabled ? "yes" : "no"}`,
      `client id: ${this.clientId ? "set" : "not set"}`,
      `client secret: ${this.clientSecret ? "set" : "not set"}`,
      `corp id: ${this.corpId || "not set"}`,
      `robot code: ${this.robotCode || "not set"}`,
      `card template: ${this.cardTemplateId || "not set"}`,
      `card callback route: ${this.cardCallbackRouteKey || "not set"}`,
      `chat id: ${this.chatId || "not set"}`,
      `allowed users: ${this.allowedUserIds.length || "pending first user"}`,
      `stream: ${this.polling ? "on" : "off"}`,
    ];
  }

  emitChange() {
    this.onChange?.({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      corpId: this.corpId,
      robotCode: this.robotCode,
      cardTemplateId: this.cardTemplateId,
      cardCallbackRouteKey: this.cardCallbackRouteKey,
      cardUserIdType: this.cardUserIdType,
      chatId: this.chatId,
      allowedUserIds: this.allowedUserIds,
    });
  }

  normalizeAllowedUserIds(value: unknown) {
    return normalizeAllowedUserIds(value);
  }

  isAllowedUser(userId: unknown) {
    const normalized = String(userId || "").trim();
    if (!normalized) {
      return false;
    }
    if (this.allowedUserIds.length === 0) {
      this.allowedUserIds = [normalized];
      this.onLog(color.green(`DingDing user bound: ${normalized}`));
      this.emitChange();
      return true;
    }
    return this.allowedUserIds.includes(normalized);
  }

  chatIdForRoute(route?: DingdingTargetRoute) {
    return String(route?.target?.chatId || this.chatId || "").trim();
  }

  sessionWebhookForRoute(route?: DingdingTargetRoute) {
    const direct = String(route?.target?.sessionWebhook || "").trim();
    if (direct) {
      return direct;
    }
    const chatId = this.chatIdForRoute(route);
    return chatId ? this.sessionWebhooks.get(chatId) || "" : "";
  }

  senderIdForRoute(route?: DingdingTargetRoute) {
    const direct = String(route?.target?.senderId || "").trim();
    if (direct) {
      return direct;
    }
    const chatId = this.chatIdForRoute(route);
    return chatId ? this.senderIds.get(chatId) || "" : "";
  }

  async getAccessToken() {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) {
      return this.accessToken.value;
    }
    if (!this.clientId || !this.clientSecret) {
      throw new Error("DingDing client id/secret is not set");
    }
    const response = await axios.post(
      `${DINGDING_API_BASE}/v1.0/oauth2/accessToken`,
      { appKey: this.clientId, appSecret: this.clientSecret },
      { timeout: 8000 },
    );
    const value = String(response.data?.accessToken || "");
    if (!value) {
      throw new Error("DingDing access token response is empty");
    }
    const expireIn = Number(response.data?.expireIn || 7200);
    this.accessToken = { value, expiresAt: Date.now() + Math.max(60, expireIn - 120) * 1000 };
    return value;
  }

  async dingdingApi(method: "POST" | "PUT", path: string, body: Record<string, unknown>) {
    const token = await this.getAccessToken();
    return axios.request({
      method,
      url: `${DINGDING_API_BASE}${path}`,
      headers: { "x-acs-dingtalk-access-token": token },
      data: body,
      timeout: 10_000,
    });
  }

  async sendActionsCard({
    title,
    description,
    actions = [],
    route,
    step = "task_handoff_actions",
    outTrackId = `task_handoff:${Date.now()}:${Math.random().toString(16).slice(2)}`,
  }: {
    title: string;
    description: string;
    actions?: Array<{ text: string; id: string }>;
    route?: DingdingTargetRoute;
    step?: string;
    outTrackId?: string;
  }) {
    const chatId = this.chatIdForRoute(route);
    const senderId = this.senderIdForRoute(route);
    const sessionWebhook = this.sessionWebhookForRoute(route);
    if (!chatId || !senderId || !this.robotCode || !this.cardTemplateId) {
      throw new Error("DingDing card target is incomplete");
    }
    const cardParamMap = jsonValuesToString({
      type: "actions",
      title,
      description,
      list: actions,
      biz_out_track_id: outTrackId,
      biz_step: step,
      biz_conversation_id: chatId,
      biz_sender_id: senderId,
      biz_session_webhook: sessionWebhook,
      error_msg: "",
    });
    await this.dingdingApi("POST", "/v1.0/card/instances/createAndDeliver", {
      userId: senderId,
      cardTemplateId: this.cardTemplateId,
      outTrackId,
      callbackType: "STREAM",
      callbackRouteKey: this.cardCallbackRouteKey,
      cardData: { cardParamMap },
      userIdType: this.cardUserIdType,
      openSpaceId: openSpaceIdIMGroup(chatId),
      imGroupOpenSpaceModel: { supportForward: false },
      imGroupOpenDeliverModel: { extension: {}, robotCode: this.robotCode },
    });
    return outTrackId;
  }

  async updateActionsCard(outTrackId: string, description: string, actions: Array<{ text: string; id: string }> = [], title = "TaskHandoff", step = "task_handoff_updated") {
    await this.dingdingApi("PUT", "/v1.0/card/instances", {
      outTrackId,
      cardData: {
        cardParamMap: jsonValuesToString({
          type: "actions",
          title,
          description,
          list: actions,
          biz_step: step,
          error_msg: "",
        }),
      },
      cardUpdateOptions: {
        updateCardDataByKey: true,
        updatePrivateDataByKey: false,
      },
      userIdType: this.cardUserIdType,
    });
  }

  async sendMarkdownByWebhook(sessionWebhook: string, text: string) {
    await axios.post(
      sessionWebhook,
      {
        msgtype: "markdown",
        markdown: {
          title: markdownTitle(text),
          text,
        },
      },
      { timeout: 8000 },
    );
  }

  async send(text: string, route?: DingdingTargetRoute) {
    const sessionWebhook = this.sessionWebhookForRoute(route);
    if (!sessionWebhook) {
      this.onLog(color.yellow("DingDing send skipped: sessionWebhook is not available"));
      return;
    }
    try {
      await this.sendMarkdownByWebhook(sessionWebhook, text);
    } catch (error) {
      this.onLog(color.red(`DingDing send failed: ${errorMessage(error)}`));
    }
  }

  async sendMessage(text: string, extraOrRoute?: Record<string, unknown> | DingdingTargetRoute, route?: DingdingTargetRoute) {
    const first = asRecord(extraOrRoute);
    const targetRoute = route || (first.target ? (extraOrRoute as DingdingTargetRoute) : undefined);
    const extra = first.target ? {} : first;
    const actions = inlineKeyboardToActions(extra.reply_markup);
    if (actions.length > 0) {
      try {
        const title = markdownTitle(text);
        await this.sendActionsCard({ title, description: String(text || ""), actions, route: targetRoute, step: "task_handoff_picker" });
        return;
      } catch (error) {
        this.onLog(color.yellow(`DingDing card send failed, falling back to markdown: ${errorMessage(error)}`));
      }
    }
    await this.send(text, targetRoute);
  }

  async sendPayload(payload: ChatPayload, route?: DingdingTargetRoute) {
    await this.send(renderPlainChatPayload(payload), route);
  }

  async sendTask(payload: ChatPayload, route?: DingdingTargetRoute) {
    if (payload.id && payload.attachments?.length) {
      const actions = payload.attachments.map((attachment) => ({
        text: attachmentLabel(attachment),
        id: `th_cb_${encodeChatActionData(`task_handoff:attachment:${payload.conversationId}:${payload.id}:${attachment.id}`)}`,
      }));
      try {
        await this.sendActionsCard({
          title: payload.title,
          description: renderPlainChatPayload(payload),
          actions,
          route,
          step: "task_attachments",
        });
        return;
      } catch (error) {
        this.onLog(color.yellow(`DingDing attachment card failed, falling back to markdown: ${errorMessage(error)}`));
      }
    }
    await this.sendPayload(payload, route);
  }

  async sendApprovalPayload(payload: ChatPayload, route?: DingdingTargetRoute) {
    const actions = [
      { text: "Allow", id: `approval_allow_${payload.id}` },
      { text: "Skip", id: `approval_skip_${payload.id}` },
      { text: "Deny", id: `approval_deny_${payload.id}` },
    ];
    try {
      await this.sendActionsCard({
        title: payload.title,
        description: renderPlainChatPayload(payload),
        actions,
        route,
        step: "approval_pending",
        outTrackId: `task_handoff_approval_${payload.conversationId}_${payload.id}_${Date.now()}`,
      });
    } catch (error) {
      this.onLog(color.yellow(`DingDing approval card failed, falling back to markdown: ${errorMessage(error)}`));
      await this.sendPayload(payload, route);
    }
  }

  updateProgress(key: string, text: unknown, route?: DingdingTargetRoute, options?: ChatProgressOptions) {
    const value = String(text || "").trim();
    if (!value) {
      return;
    }
    const existing = this.progressCards.get(key);
    if (existing) {
      existing.route = route || existing.route;
      existing.options = options || existing.options;
      if (!existing.outTrackId) {
        existing.pendingText = value;
        return;
      }
    }
    if (!existing?.outTrackId) {
      const entry: DingdingProgressEntry = { lastText: value, lastUpdateAt: Date.now(), route, options };
      entry.pending = this.sendActionsCard({
        title: "TaskHandoff 执行中",
        description: value,
        actions: progressActions(options),
        route,
        step: "progress",
        outTrackId: `task_handoff_progress_${encodeChatActionData(key).slice(0, 48)}_${Date.now()}`,
      })
        .then((outTrackId) => {
          if (this.progressCards.get(key) !== entry || !this.enabled) {
            return;
          }
          entry.outTrackId = outTrackId;
          const nextText = entry.pendingText;
          entry.pendingText = undefined;
          if (outTrackId && nextText && nextText !== entry.lastText) {
            entry.lastUpdateAt = 0;
            this.updateProgress(key, nextText, entry.route, entry.options);
          }
        })
        .catch((error) => {
          this.onLog(color.yellow(`DingDing progress card skipped: ${errorMessage(error)}`));
          if (this.progressCards.get(key) === entry) {
            this.progressCards.delete(key);
          }
        })
        .finally(() => {
          entry.pending = undefined;
        });
      this.progressCards.set(key, entry);
      return;
    }
    const elapsed = Date.now() - (existing.lastUpdateAt || 0);
    if (elapsed < DINGDING_PROGRESS_UPDATE_MS) {
      existing.pendingText = value;
      if (!existing.timer) {
        existing.timer = setTimeout(() => {
          existing.timer = undefined;
          const nextText = existing.pendingText;
          existing.pendingText = undefined;
          if (nextText) {
            this.updateProgress(key, nextText, route || existing.route, existing.options);
          }
        }, DINGDING_PROGRESS_UPDATE_MS - elapsed);
      }
      return;
    }
    existing.lastText = value;
    existing.lastUpdateAt = Date.now();
    void this.updateActionsCard(existing.outTrackId, value, progressActions(existing.options), "TaskHandoff 执行中", "progress").catch((error) => {
      this.onLog(color.yellow(`DingDing progress update skipped: ${errorMessage(error)}`));
    });
  }

  async finishProgressPayload(key: string, payload: ChatPayload) {
    const existing = this.progressCards.get(key);
    if (existing?.pending) {
      await existing.pending;
    }
    if (!existing?.outTrackId) {
      this.progressCards.delete(key);
      return false;
    }
    try {
      clearTimeout(existing.timer);
      const actions =
        payload.id && payload.attachments?.length
          ? payload.attachments.map((attachment) => ({
              text: attachmentLabel(attachment),
              id: `th_cb_${encodeChatActionData(`task_handoff:attachment:${payload.conversationId}:${payload.id}:${attachment.id}`)}`,
            }))
          : [];
      await this.updateActionsCard(existing.outTrackId, renderPlainChatPayload(payload), actions, payload.title, "progress_done");
      this.progressCards.delete(key);
      return true;
    } catch (error) {
      this.progressCards.delete(key);
      this.onLog(color.yellow(`DingDing progress finish skipped: ${errorMessage(error)}`));
      return false;
    }
  }

  async deleteProgress(key: string) {
    const existing = this.progressCards.get(key);
    if (!existing?.outTrackId) {
      this.progressCards.delete(key);
      return false;
    }
    try {
      clearTimeout(existing.timer);
      await this.updateActionsCard(existing.outTrackId, "已有新的聊天消息，进度卡片已收起。", [], "TaskHandoff", "progress_closed");
      this.progressCards.delete(key);
      return true;
    } catch {
      this.progressCards.delete(key);
      return false;
    }
  }

  bind(clientId: string, clientSecret: string, corpId?: string, robotCode?: string, chatId?: string) {
    this.stop();
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = undefined;
    this.corpId = corpId;
    this.robotCode = robotCode;
    this.chatId = chatId;
    this.enabled = Boolean(clientId && clientSecret);
    this.emitChange();
    this.start();
  }

  setChat(chatId: string) {
    this.chatId = chatId;
    this.emitChange();
  }

  unbind() {
    this.stop();
    this.clientId = undefined;
    this.clientSecret = undefined;
    this.accessToken = undefined;
    this.corpId = undefined;
    this.robotCode = undefined;
    this.chatId = undefined;
    this.enabled = false;
    this.emitChange();
  }

  start() {
    if (!this.clientId || !this.clientSecret) {
      this.onLog(color.yellow("DingDing client id/secret is not set."));
      return;
    }
    if (this.polling || this.client) {
      return;
    }
    this.enabled = true;
    const client = new DWClient({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      ua: "task-handoff",
      // dingtalk-stream 2.1.5 heartbeat pings can throw from an uncaught timer
      // while the socket is CONNECTING. Keep SDK reconnects, but avoid letting
      // bridge heartbeat failures crash the receiver process.
      keepAlive: false,
    });
    client.registerCallbackListener(TOPIC_ROBOT, (message) => {
      void this.handleRobotMessage(message as DWClientDownStream).catch((error: unknown) => {
        this.onLog(color.red(`DingDing robot message failed: ${errorMessage(error)}`));
      });
    });
    client.registerCallbackListener(TOPIC_CARD, (message) => {
      void this.handleCardCallback(message as DWClientDownStream)
        .then((result) => client.socketCallBackResponse((message as DWClientDownStream).headers.messageId, result || {}))
        .catch((error: unknown) => {
          this.onLog(color.red(`DingDing card callback failed: ${errorMessage(error)}`));
          client.socketCallBackResponse((message as DWClientDownStream).headers.messageId, {});
        });
    });
    this.client = client;
    client
      .connect()
      .then(() => {
        if (this.client !== client || !this.enabled) {
          return;
        }
        this.polling = true;
        this.onLog(color.green("DingDing stream enabled"));
      })
      .catch((error: unknown) => {
        if (this.client !== client) {
          return;
        }
        this.polling = false;
        this.client = undefined;
        this.onLog(color.red(`DingDing stream failed: ${errorMessage(error)}`));
      });
  }

  stop() {
    this.polling = false;
    this.enabled = false;
    for (const entry of this.progressCards.values()) {
      clearTimeout(entry.timer);
    }
    this.progressCards.clear();
    try {
      this.client?.disconnect();
    } catch {
      // Ignore SDK disconnect races.
    }
    this.client = undefined;
  }

  async handleRobotMessage(message: DWClientDownStream) {
    const body = parseDownstreamData<DingdingRobotMessage>(message);
    const chatId = String(body?.conversationId || "").trim();
    const text = String(body?.text?.content || "").trim();
    this.client?.socketCallBackResponse(message.headers.messageId, {});
    if (!chatId || !text) {
      return;
    }
    const senderId = body?.senderStaffId || body?.senderId;
    if (!this.isAllowedUser(senderId)) {
      this.onLog(color.yellow(`DingDing unauthorized user ignored: ${senderId || "unknown"}`));
      return;
    }
    if (body?.sessionWebhook) {
      this.sessionWebhooks.set(chatId, body.sessionWebhook);
    }
    if (senderId) {
      this.senderIds.set(chatId, senderId);
    }
    if (!this.chatId) {
      this.chatId = chatId;
      this.emitChange();
      if (!this.multiChat) {
        return;
      }
    }
    if (!this.multiChat && this.chatId !== chatId) {
      return;
    }
    await this.onText(text, {
      chatId,
      sessionWebhook: body?.sessionWebhook,
      senderId: body?.senderStaffId || body?.senderId,
      senderNick: body?.senderNick,
    });
  }

  async handleCardCallback(message: DWClientDownStream) {
    const body = parseDownstreamData<DingdingCardCallback>(message) || {};
    const userId = String(body.userId || "").trim();
    if (!this.isAllowedUser(userId)) {
      this.onLog(color.yellow(`DingDing unauthorized action ignored: ${userId || "unknown"}`));
      return undefined;
    }
    const privateData = asRecord(asRecord(body.cardActionData).cardPrivateData);
    const params = asRecord(privateData.params);
    const actionIdList = Array.isArray(privateData.actionIdList) ? privateData.actionIdList : [];
    const actionId = String(actionIdList[0] || "");
    const result = asRecord(await handleDingdingLogicalCardAction({ actionId, body, params, onAction: this.onAction }));
    if (result.cardResponse) {
      return result.cardResponse;
    }
    return undefined;
  }

  async handleLogicalCardAction(actionId: string, body: DingdingCardCallback, params: Record<string, unknown>) {
    return handleDingdingLogicalCardAction({ actionId, body, params, onAction: this.onAction });
  }
}

export { DingdingBridge, handleDingdingLogicalCardAction, markdownTitle };
