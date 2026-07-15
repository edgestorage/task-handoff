import type { ChatBridgeConfig } from "@task-handoff/protocol/control-plane";
import { createInlineKeyboard, inlineKeyboardToActions } from "@task-handoff/core/core/chat-interactions";
import type { ChatInlineKeyboard } from "@task-handoff/core/core/chat-interactions";
import type {
  ChatGatewaySendAdapter,
  ChatGatewayIncomingMessage,
} from "./contracts.ts";

export type DingdingConversationType = "IM_GROUP" | "IM_SINGLE" | "IM_ROBOT";

export type DingdingRobotEvent = ChatGatewayIncomingMessage & {
  senderId?: string;
  sessionWebhook?: string;
  conversationType?: DingdingConversationType;
  raw: Record<string, unknown>;
};

export type DingdingCardEvent = {
  userId?: string;
  chatId: string;
  senderId?: string;
  deliverySenderId?: string;
  sessionWebhook?: string;
  conversationType?: DingdingConversationType;
  callbackData: string;
  body: Record<string, unknown>;
  params: Record<string, unknown>;
};


export type DingdingClientLike = {
  connect: () => Promise<unknown>;
  disconnect: () => void;
  onDisconnect?: (listener: (error?: unknown) => void) => void;
  getConfig?: () => { keepAlive?: boolean; autoReconnect?: boolean };
  registerCallbackListener: (topic: string, listener: (message: unknown) => void) => void;
  socketCallBackResponse: (messageId: string, response: unknown) => void;
};

export type DingdingRuntimeState = {
  client: DingdingClientLike;
  chatWebhooks: Map<string, string>;
  senderIds: Map<string, string>;
  conversationTypes: Map<string, DingdingConversationType>;
  accessToken?: { value: string; expiresAt: number };
  onLog?: (level: "info" | "warn", data: Record<string, unknown>, message: string) => void;
};

export function createDingdingSendAdapter(
  fetchImpl: typeof fetch,
  bridge: ChatBridgeConfig,
  dingdingRuntime?: DingdingRuntimeState,
): ChatGatewaySendAdapter {
  return {
    bridge,
    send: async (chatId, text, options = {}) => {
      const sessionWebhook = options.sessionWebhook || dingdingRuntime?.chatWebhooks.get(chatId) || stringSetting(bridge.settings.sessionWebhook);
      if (options.replyMarkup && dingdingRuntime) {
        const result = await sendDingdingActionsCard({
          fetchImpl,
          bridge,
          runtime: dingdingRuntime,
          chatId,
          text,
          replyMarkup: options.replyMarkup,
          sessionWebhook,
          senderId: options.senderId || dingdingRuntime.senderIds.get(chatId) || stringSetting(bridge.settings.senderId),
        });
        if (result?.delivered) {
          return { provider: "dingding", interactionId: result.outTrackId };
        }
      }
      if (sessionWebhook) {
        await sendDingdingWebhook(fetchImpl, sessionWebhook, text, dingdingRuntime?.onLog);
        return { provider: "dingding" };
      }
      return undefined;
    },
  };
}

export function markdownTitle(text: string) {
  const line = String(text || "").split(/\r?\n/, 1)[0].replace(/^#+\s*/, "").trim();
  return line.slice(0, 20) || "消息通知";
}

export function jsonValuesToString(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "string" ? item : JSON.stringify(item)]));
}

export function dingdingOpenSpaceIdIMGroup(openConversationId: string) {
  return `dtv1.card//IM_GROUP.${openConversationId}`;
}

export function dingdingOpenSpaceIdIMSingle(openConversationId: string) {
  return `dtv1.card//IM_SINGLE.${openConversationId}`;
}

export function dingdingOpenSpaceIdIMRobot(senderId: string) {
  return `dtv1.card//IM_ROBOT.${senderId}`;
}

export function dingdingChatIdFromCardCallback(body: Record<string, unknown>, params: Record<string, unknown>) {
  const direct = stringSetting(params.biz_conversation_id).trim();
  if (direct) {
    return direct;
  }
  return stringSetting(body.spaceId).replace(/^dtv1\.card\/\/(?:IM_GROUP|IM_SINGLE|IM_ROBOT)\./, "");
}

function dingdingConversationType(value: unknown, options: { robotMessage?: boolean } = {}): DingdingConversationType | undefined {
  const type = stringSetting(value).trim().toUpperCase();
  if (type === "2" || type === "IM_GROUP") {
    return "IM_GROUP";
  }
  if (type === "1" || type === "IM_SINGLE") {
    return options.robotMessage ? "IM_ROBOT" : "IM_SINGLE";
  }
  if (type === "IM_ROBOT") {
    return "IM_ROBOT";
  }
  return undefined;
}

export function dingdingCallbackData(actionId: string) {
  if (actionId.startsWith("task_handoff:")) {
    return actionId;
  }
  if (!actionId.startsWith("th_cb_")) {
    return "";
  }
  try {
    return Buffer.from(actionId.slice("th_cb_".length), "base64url").toString("utf8");
  } catch {
    return "";
  }
}

export function dingdingCardUpdateResponse(description: string, replyMarkup: ChatInlineKeyboard | undefined, step: string, body: Record<string, unknown>, params: Record<string, unknown>) {
  const chatId = dingdingChatIdFromCardCallback(body, params);
  return {
    cardUpdateOptions: { updateCardDataByKey: true, updatePrivateDataByKey: false },
    cardData: {
      cardParamMap: jsonValuesToString({
        type: "actions",
        title: "TaskHandoff",
        description,
        list: inlineKeyboardToActions(replyMarkup),
        biz_out_track_id: body.outTrackId || params.biz_out_track_id || "",
        biz_conversation_id: chatId,
        biz_sender_id: params.biz_sender_id || body.userId || "",
        biz_session_webhook: params.biz_session_webhook || "",
        biz_conversation_type: params.biz_conversation_type || "",
        biz_step: step,
        error_msg: "",
      }),
    },
  };
}

export function parseDingdingRobotEvent(data: unknown): DingdingRobotEvent | undefined {
  const body = parseJsonRecord(data);
  const chatId = stringSetting(body.conversationId);
  const text = stringSetting(asRecord(body.text).content).trim();
  if (!chatId || !text) {
    return undefined;
  }
  const senderId = stringSetting(body.senderStaffId || body.senderId);
  return {
    chatId,
    userId: senderId || undefined,
    senderId: senderId || undefined,
    sessionWebhook: stringSetting(body.sessionWebhook) || undefined,
    conversationType: dingdingConversationType(body.conversationType, { robotMessage: true }),
    text,
    raw: body,
  };
}

export function parseDingdingCardEvent(data: unknown): DingdingCardEvent {
  const body = parseJsonRecord(data);
  const cardActionData = recordSetting(body.cardActionData || body.content);
  const privateData = recordSetting(cardActionData.cardPrivateData || body.cardPrivateData || body.content);
  const params = recordSetting(privateData.params || cardActionData.params || body.params);
  const userId = stringSetting(body.userId);
  const deliverySenderId = stringSetting(params.biz_sender_id);
  return {
    userId: userId || undefined,
    chatId: dingdingChatIdFromCardCallback(body, params),
    senderId: userId || undefined,
    deliverySenderId: deliverySenderId || undefined,
    sessionWebhook: stringSetting(params.biz_session_webhook) || undefined,
    conversationType: dingdingConversationType(params.biz_conversation_type || body.conversationType || body.conversation_type),
    callbackData: dingdingCallbackData(dingdingSelectedActionId(body, cardActionData, privateData)),
    body,
    params,
  };
}

function dingdingSelectedActionId(body: Record<string, unknown>, cardActionData: Record<string, unknown>, privateData: Record<string, unknown>) {
  const candidates: string[] = [];
  appendDingdingActionIdCandidates(candidates, privateData);
  appendDingdingActionIdCandidates(candidates, cardActionData);
  appendDingdingActionIdCandidates(candidates, body);
  return candidates.find((candidate) => dingdingCallbackData(candidate)) || "";
}

function appendDingdingActionIdCandidates(candidates: string[], record: Record<string, unknown>) {
  for (const key of ["actionIdList", "actionIds"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      candidates.push(...value.map((item) => stringSetting(item)).filter(Boolean));
    }
  }
  for (const key of ["actionId", "action_id", "id", "actionValue"]) {
    const value = stringSetting(record[key]);
    if (value) {
      candidates.push(value);
    }
  }
}

export async function sendDingdingWebhook(fetchImpl: typeof fetch, sessionWebhook: string, text: string, onLog?: DingdingRuntimeState["onLog"]) {
  onLog?.("info", {
    target: "sessionWebhook",
    hasSessionWebhook: Boolean(sessionWebhook),
    textPreview: compactLogText(text),
  }, "dingding webhook send requested");
  const response = await fetchImpl(sessionWebhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: {
        title: markdownTitle(text),
        text,
      },
    }),
  });
  const payload = await response.json().catch(() => undefined);
  onLog?.(response.ok ? "info" : "warn", {
    target: "sessionWebhook",
    status: response.status,
    response: dingdingResponseLogSummary(payload),
  }, "dingding webhook send completed");
  if (!response.ok) {
    throw new Error(`DingDing webhook failed with HTTP ${response.status}`);
  }
}


export async function sendDingdingActionsCard(input: {
  fetchImpl: typeof fetch;
  bridge: ChatBridgeConfig;
  runtime: DingdingRuntimeState;
  chatId: string;
  text: string;
  replyMarkup?: ChatInlineKeyboard;
  sessionWebhook?: string;
  senderId?: string;
  title?: string;
  step?: string;
  forceCard?: boolean;
}) {
  const actions = inlineKeyboardToActions(input.replyMarkup);
  if (!actions.length && !input.forceCard) {
    if (input.sessionWebhook) {
      await sendDingdingWebhook(input.fetchImpl, input.sessionWebhook, input.text, input.runtime.onLog);
    }
    return input.sessionWebhook ? { delivered: true } : undefined;
  }
  const settings = input.bridge.settings || {};
  const robotCode = stringSetting(settings.robotCode);
  const cardTemplateId = stringSetting(settings.cardTemplateId) || "13fc6717-12e4-43ed-8533-111a310d4995.schema";
  const callbackRouteKey = stringSetting(settings.cardCallbackRouteKey) || "bi_workflow_ticket";
  const senderId = input.senderId || input.runtime.senderIds.get(input.chatId) || stringSetting(settings.senderId);
  const conversationType = dingdingRuntimeConversationType(input.runtime, input.chatId);
  if (!robotCode || !cardTemplateId || !senderId) {
    if (input.sessionWebhook && !input.forceCard) {
      await sendDingdingWebhook(input.fetchImpl, input.sessionWebhook, input.text, input.runtime.onLog);
      return { delivered: true };
    }
    throw new Error("DingDing card target is incomplete.");
  }
  const outTrackId = `task_handoff_cp_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const cardParamMap = jsonValuesToString({
    type: "actions",
    title: input.title || markdownTitle(input.text),
    description: input.text,
    list: actions,
    biz_out_track_id: outTrackId,
    biz_step: input.step || "task_handoff_actions",
    biz_conversation_id: input.chatId,
    biz_sender_id: senderId,
    biz_session_webhook: input.sessionWebhook || input.runtime.chatWebhooks.get(input.chatId) || "",
    biz_conversation_type: conversationType,
    error_msg: "",
  });
  const deliveryTarget = dingdingCardDeliveryTarget(conversationType, input.chatId, senderId, robotCode);
  input.runtime.onLog?.("info", {
    target: "card",
    chatId: input.chatId,
    senderId,
    conversationType,
    openSpaceId: deliveryTarget.openSpaceId,
    hasSessionWebhook: Boolean(input.sessionWebhook || input.runtime.chatWebhooks.get(input.chatId)),
    hasReplyMarkup: Boolean(input.replyMarkup),
    actionCount: actions.length,
    textPreview: compactLogText(input.text),
  }, "dingding card send requested");
  await dingdingApi(input.fetchImpl, input.bridge, input.runtime, "POST", "/v1.0/card/instances/createAndDeliver", {
    userId: senderId,
    cardTemplateId,
    outTrackId,
    callbackType: "STREAM",
    callbackRouteKey,
    cardData: { cardParamMap },
    userIdType: Number(settings.cardUserIdType || 1),
    ...deliveryTarget,
  });
  return { delivered: true, outTrackId };
}

function dingdingRuntimeConversationType(runtime: DingdingRuntimeState, chatId: string): DingdingConversationType {
  return runtime.conversationTypes?.get(chatId) || "IM_GROUP";
}

function dingdingCardDeliveryTarget(
  conversationType: DingdingConversationType,
  chatId: string,
  senderId: string,
  robotCode: string,
) {
  if (conversationType === "IM_SINGLE") {
    return {
      openSpaceId: dingdingOpenSpaceIdIMSingle(chatId),
      imSingleOpenSpaceModel: {},
      imSingleOpenDeliverModel: { extension: {} },
    };
  }
  if (conversationType === "IM_ROBOT") {
    return {
      openSpaceId: dingdingOpenSpaceIdIMRobot(senderId),
      imRobotOpenSpaceModel: { supportForward: false },
      imRobotOpenDeliverModel: { extension: {}, robotCode, spaceType: "IM_ROBOT" },
    };
  }
  return {
    openSpaceId: dingdingOpenSpaceIdIMGroup(chatId),
    imGroupOpenSpaceModel: { supportForward: false },
    imGroupOpenDeliverModel: { extension: {}, robotCode },
  };
}

export async function updateDingdingActionsCard(input: {
  fetchImpl: typeof fetch;
  bridge: ChatBridgeConfig;
  runtime: DingdingRuntimeState;
  outTrackId: string;
  text: string;
  replyMarkup?: ChatInlineKeyboard;
  title?: string;
  step?: string;
}) {
  await dingdingApi(input.fetchImpl, input.bridge, input.runtime, "PUT", "/v1.0/card/instances", {
    outTrackId: input.outTrackId,
    cardData: {
      cardParamMap: jsonValuesToString({
        type: "actions",
        title: input.title || "TaskHandoff",
        description: input.text,
        list: inlineKeyboardToActions(input.replyMarkup),
        biz_step: input.step || "updated",
        error_msg: "",
      }),
    },
    cardUpdateOptions: {
      updateCardDataByKey: true,
      updatePrivateDataByKey: false,
    },
    userIdType: Number(input.bridge.settings.cardUserIdType || 1),
  });
}

async function dingdingApi(fetchImpl: typeof fetch, bridge: ChatBridgeConfig, runtime: DingdingRuntimeState, method: "POST" | "PUT", path: string, body: Record<string, unknown>) {
  const token = await dingdingAccessToken(fetchImpl, bridge, runtime);
  runtime.onLog?.("info", {
    method,
    path,
    body: dingdingRequestLogSummary(body),
  }, "dingding api request");
  const response = await fetchImpl(`https://api.dingtalk.com${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-acs-dingtalk-access-token": token,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => undefined);
  runtime.onLog?.(response.ok ? "info" : "warn", {
    method,
    path,
    status: response.status,
    response: dingdingResponseLogSummary(payload),
  }, "dingding api response");
  if (!response.ok) {
    throw new Error(`DingDing API failed with HTTP ${response.status}`);
  }
  const record = asRecord(payload);
  const code = record.code ?? record.errcode;
  const success = record.success;
  if ((code !== undefined && String(code) !== "0") || success === false) {
    throw new Error(stringSetting(record.message || record.errmsg) || `DingDing API returned ${String(code || "failure")}`);
  }
  const deliveryError = dingdingDeliveryError(payload);
  if (deliveryError) {
    throw new Error(deliveryError);
  }
  return response;
}

function dingdingDeliveryError(payload: unknown) {
  const deliverResults = asRecord(asRecord(payload).result).deliverResults;
  if (!Array.isArray(deliverResults)) {
    return "";
  }
  const failed = deliverResults.find((item) => asRecord(item).success === false);
  if (!failed) {
    return "";
  }
  const record = asRecord(failed);
  const spaceId = stringSetting(record.spaceId);
  const error = stringSetting(record.errorMsg || record.message || record.errmsg) || "delivery failed";
  return spaceId ? `DingDing card delivery failed for ${spaceId}: ${error}` : `DingDing card delivery failed: ${error}`;
}

function dingdingRequestLogSummary(body: Record<string, unknown>) {
  const record = asRecord(body);
  const cardData = asRecord(record.cardData);
  const cardParamMap = asRecord(cardData.cardParamMap);
  return {
    openSpaceId: stringSetting(record.openSpaceId),
    outTrackId: stringSetting(record.outTrackId),
    userId: stringSetting(record.userId),
    userIdType: record.userIdType,
    callbackType: stringSetting(record.callbackType),
    callbackRouteKey: stringSetting(record.callbackRouteKey),
    hasImGroupTarget: Boolean(record.imGroupOpenSpaceModel || record.imGroupOpenDeliverModel),
    hasImSingleTarget: Boolean(record.imSingleOpenSpaceModel || record.imSingleOpenDeliverModel),
    hasImRobotTarget: Boolean(record.imRobotOpenSpaceModel || record.imRobotOpenDeliverModel),
    imGroupOpenDeliverModel: summarizeDingdingDeliverModel(record.imGroupOpenDeliverModel),
    imSingleOpenDeliverModel: summarizeDingdingDeliverModel(record.imSingleOpenDeliverModel),
    imRobotOpenDeliverModel: summarizeDingdingDeliverModel(record.imRobotOpenDeliverModel),
    bizConversationId: stringSetting(cardParamMap.biz_conversation_id),
    bizConversationType: stringSetting(cardParamMap.biz_conversation_type),
    bizSenderId: stringSetting(cardParamMap.biz_sender_id),
    hasBizSessionWebhook: Boolean(stringSetting(cardParamMap.biz_session_webhook)),
  };
}

function summarizeDingdingDeliverModel(value: unknown) {
  const record = asRecord(value);
  if (!Object.keys(record).length) {
    return undefined;
  }
  return {
    hasExtension: Boolean(record.extension),
    hasRobotCode: Boolean(stringSetting(record.robotCode)),
    spaceType: stringSetting(record.spaceType),
    recipients: Array.isArray(record.recipients) ? record.recipients.length : undefined,
    atUserIds: record.atUserIds && typeof record.atUserIds === "object" ? Object.keys(record.atUserIds as Record<string, unknown>).length : undefined,
  };
}

function dingdingResponseLogSummary(payload: unknown) {
  const record = asRecord(payload);
  const result = asRecord(record.result);
  return {
    code: record.code ?? record.errcode,
    message: compactLogText(record.message || record.errmsg, 240),
    success: record.success,
    requestId: record.requestId,
    result: Object.keys(result).length ? result : undefined,
  };
}

function compactLogText(value: unknown, maxLength = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

async function dingdingAccessToken(fetchImpl: typeof fetch, bridge: ChatBridgeConfig, runtime: DingdingRuntimeState) {
  if (runtime.accessToken && runtime.accessToken.expiresAt > Date.now() + 60_000) {
    return runtime.accessToken.value;
  }
  const clientSecret = stringSetting(bridge.settings.clientSecret);
  if (!bridge.token || !clientSecret) {
    throw new Error("DingDing client id/secret is not configured.");
  }
  const response = await fetchImpl("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appKey: bridge.token, appSecret: clientSecret }),
  });
  const payload = (await response.json().catch(() => ({}))) as { accessToken?: string; expireIn?: number };
  if (!response.ok || !payload.accessToken) {
    throw new Error(`DingDing access token failed with HTTP ${response.status}`);
  }
  const expireIn = Number(payload.expireIn || 7200);
  runtime.accessToken = {
    value: payload.accessToken,
    expiresAt: Date.now() + Math.max(60, expireIn - 120) * 1000,
  };
  return runtime.accessToken.value;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordSetting(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    return parseJsonRecord(value);
  }
  return {};
}

function stringSetting(value: unknown) {
  return typeof value === "string" ? value : "";
}

function parseJsonRecord(value: unknown) {
  try {
    return asRecord(JSON.parse(String(value || "{}")));
  } catch {
    return {};
  }
}

export function dingdingActionsFingerprint(replyMarkup: ChatInlineKeyboard | undefined) {
  return JSON.stringify(inlineKeyboardToActions(replyMarkup));
}
