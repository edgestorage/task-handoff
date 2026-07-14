import { decodeChatActionData, inlineKeyboardToActions } from "@task-handoff/core/core/chat-interactions";
import type { DingdingBridgeOptions, DingdingCardCallback } from "./dingding-types";
import { asRecord, jsonValuesToString } from "./dingding-utils";

type DingdingActionHandler = DingdingBridgeOptions["onAction"];

export async function handleDingdingLogicalCardAction({
  actionId,
  body,
  params,
  onAction,
}: {
  actionId: string;
  body: DingdingCardCallback;
  params: Record<string, unknown>;
  onAction?: DingdingActionHandler;
}) {
  if (actionId.startsWith("th_cb_")) {
    const callbackData = decodeChatActionData(actionId.slice("th_cb_".length));
    return handleTelegramStyleCallback(callbackData, body, params, onAction);
  }
  const approvalMatch = actionId.match(/^approval_(allow|skip|deny)_(\d+)$/);
  if (approvalMatch) {
    const [, decision, id] = approvalMatch;
    const handled = await onAction?.({
      type: "approval",
      id: Number(id),
      decision,
    });
    const description = handled ? `已${decision === "deny" ? "拒绝" : decision === "skip" ? "跳过" : "批准"} #${id}` : `审批请求 #${id} 不存在`;
    return {
      handled,
      cardResponse: dingdingCardUpdateResponse(description, [], "approval_done", body, params),
    };
  }
  return onAction?.({
    type: "card",
    outTrackId: body.outTrackId,
    userId: body.userId,
    actionId,
    params,
  });
}

async function handleTelegramStyleCallback(callbackData: string, body: DingdingCardCallback, params: Record<string, unknown>, onAction?: DingdingActionHandler) {
  const chatId = chatIdFromCardCallback(body, params);
  const conversationMatch = callbackData.match(/^task_handoff:conversation:(\d+)$/);
  if (conversationMatch) {
    const result = asRecord(await onAction?.({
      type: "conversation",
      conversationId: Number(conversationMatch[1]),
      chatId,
      senderId: body.userId || params.biz_sender_id,
      sessionWebhook: params.biz_session_webhook,
    }));
    return {
      ...result,
      cardResponse: dingdingCardUpdateResponse(String(result.text || result.message || "updated"), inlineKeyboardToActions(asRecord(result).replyMarkup), "conversation_updated", body, params),
    };
  }
  const historyMatch = callbackData.match(/^task_handoff:history:(\d+):(\d+)$/);
  if (historyMatch) {
    const result = asRecord(await onAction?.({
      type: "history",
      conversationId: Number(historyMatch[1]),
      index: Number(historyMatch[2]),
      chatId,
    }));
    return {
      ...result,
      cardResponse: dingdingCardUpdateResponse(String(result.text || result.message || "history not found"), inlineKeyboardToActions(asRecord(result).replyMarkup), "history_updated", body, params),
    };
  }
  const sessionMatch = callbackData.match(/^task_handoff:session:(\d+):(codex|claude):([^:]+)$/);
  if (sessionMatch) {
    const result = asRecord(await onAction?.({
      type: "session",
      conversationId: Number(sessionMatch[1]),
      agent: sessionMatch[2],
      sessionId: sessionMatch[3],
      chatId,
      senderId: body.userId || params.biz_sender_id,
      sessionWebhook: params.biz_session_webhook,
    }));
    return {
      ...result,
      cardResponse: dingdingCardUpdateResponse(String(result.text || result.message || "session not found"), inlineKeyboardToActions(asRecord(result).replyMarkup), "session_updated", body, params),
    };
  }
  const cwdMatch = callbackData.match(/^task_handoff:cwd:([^:]+):(up|confirm|cancel|open|prev|next)(?::(\d+))?$/);
  if (cwdMatch) {
    const [, token, action, index] = cwdMatch;
    const result = asRecord(await onAction?.({
      type: "cwd",
      token,
      action,
      index: index === undefined ? undefined : Number(index),
      chatId,
    }));
    const description = result.clear ? String(result.text || result.message || "已完成") : String(result.text || result.message || "updated");
    return {
      ...result,
      cardResponse: dingdingCardUpdateResponse(description, result.clear ? [] : inlineKeyboardToActions(asRecord(result).replyMarkup), result.clear ? "cwd_done" : "cwd_updated", body, params),
    };
  }
  const attachmentMatch = callbackData.match(/^task_handoff:attachment:(\d+):(\d+):([^:]+)$/);
  if (attachmentMatch) {
    const result = asRecord(await onAction?.({
      type: "attachment",
      conversationId: Number(attachmentMatch[1]),
      id: Number(attachmentMatch[2]),
      attachmentId: attachmentMatch[3],
      chatId,
      senderId: body.userId || params.biz_sender_id,
      sessionWebhook: params.biz_session_webhook,
    }));
    return {
      ...result,
      cardResponse: dingdingCardUpdateResponse(String(result.message || "该通道暂不支持附件直传"), [], "attachment_done", body, params),
    };
  }
  const activeCancelMatch = callbackData.match(/^task_handoff:active_cancel:(\d+)$/);
  if (activeCancelMatch) {
    const result = asRecord(await onAction?.({
      type: "active_cancel",
      conversationId: Number(activeCancelMatch[1]),
      chatId,
      senderId: body.userId || params.biz_sender_id,
      sessionWebhook: params.biz_session_webhook,
    }));
    return {
      ...result,
      cardResponse: dingdingCardUpdateResponse(String(result.message || (result.cancelled ? "已取消" : "没有正在执行的任务")), [], "active_cancel", body, params),
    };
  }
  return { message: "unknown action" };
}

export function chatIdFromCardCallback(body: DingdingCardCallback, params: Record<string, unknown>) {
  const direct = String(params.biz_conversation_id || "").trim();
  if (direct) {
    return direct;
  }
  const spaceId = String(body.spaceId || "").trim();
  return spaceId.replace(/^dtv1\.card\/\/IM_GROUP\./, "");
}

function dingdingCardUpdateResponse(description: string, actions: Array<{ text: string; id: string }> = [], step = "updated", body?: DingdingCardCallback, params: Record<string, unknown> = {}) {
  const chatId = chatIdFromCardCallback(body || {}, params);
  return {
    cardUpdateOptions: { updateCardDataByKey: true, updatePrivateDataByKey: false },
    cardData: {
      cardParamMap: jsonValuesToString({
        type: "actions",
        title: "TaskHandoff",
        description,
        list: actions,
        biz_out_track_id: body?.outTrackId || params.biz_out_track_id || "",
        biz_conversation_id: chatId,
        biz_sender_id: body?.userId || params.biz_sender_id || "",
        biz_session_webhook: params.biz_session_webhook || "",
        biz_step: step,
        error_msg: "",
      }),
    },
  };
}
