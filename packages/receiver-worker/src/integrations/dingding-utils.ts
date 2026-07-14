import type { DWClientDownStream } from "dingtalk-stream";
import type { ChatProgressOptions } from "@task-handoff/core/core/chat";
import { encodeChatActionData } from "@task-handoff/core/core/chat-interactions";

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function parseDownstreamData<T>(message: DWClientDownStream): T | undefined {
  try {
    return JSON.parse(String(message.data || "")) as T;
  } catch {
    return undefined;
  }
}

export function markdownTitle(text: string) {
  const line = String(text || "").split(/\r?\n/, 1)[0].replace(/^#+\s*/, "").trim();
  return line.slice(0, 20) || "消息通知";
}

export function jsonValuesToString(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "string" ? item : JSON.stringify(item)]));
}

export function openSpaceIdIMGroup(openConversationId: string) {
  return `dtv1.card//IM_GROUP.${openConversationId}`;
}

export function progressActions(options?: ChatProgressOptions) {
  return (options?.actions || []).map((action) => ({
    text: action.text,
    id: `th_cb_${encodeChatActionData(action.callbackData)}`,
  }));
}

export function normalizeAllowedUserIds(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
