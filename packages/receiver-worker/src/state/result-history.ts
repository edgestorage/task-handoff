import type { ReceiverRef } from "../types";
import { renderAttachmentSummary } from "@task-handoff/core/core/attachments";
import type { SenderAttachment } from "@task-handoff/core/core/attachments";

const MAX_RESULT_HISTORY_PER_CONVERSATION = 50;

type ResultHistoryKind = "task" | "active";

type ResultHistoryEntry = {
  id: number;
  taskId?: number;
  conversationId: number;
  source: string;
  kind: ResultHistoryKind;
  result: string;
  attachments?: SenderAttachment[];
  createdAt: string;
};

type ResultHistoryStore = {
  entries: ResultHistoryEntry[];
  nextId: number;
};

type AddResultHistoryOptions = {
  conversationId: number;
  taskId?: number;
  source: string;
  kind: ResultHistoryKind;
  result: string;
  attachments?: SenderAttachment[];
  createdAt?: string;
};

function createResultHistoryStore(): ResultHistoryStore {
  return { entries: [], nextId: 1 };
}

function trimResultHistory(store: ResultHistoryStore, conversationId: number) {
  const entriesForConversation = store.entries.filter((entry) => entry.conversationId === conversationId);
  if (entriesForConversation.length <= MAX_RESULT_HISTORY_PER_CONVERSATION) {
    return;
  }
  const removeCount = entriesForConversation.length - MAX_RESULT_HISTORY_PER_CONVERSATION;
  const removeIds = new Set(entriesForConversation.slice(0, removeCount).map((entry) => entry.id));
  store.entries = store.entries.filter((entry) => !removeIds.has(entry.id));
}

function addResultHistoryEntry(store: ResultHistoryStore, options: AddResultHistoryOptions) {
  const result = String(options.result || "").trim();
  if (!result) {
    return undefined;
  }
  const entry: ResultHistoryEntry = {
    id: store.nextId,
    taskId: options.taskId,
    conversationId: options.conversationId,
    source: options.source,
    kind: options.kind,
    result,
    attachments: options.attachments || [],
    createdAt: options.createdAt || new Date().toISOString(),
  };
  store.nextId += 1;
  store.entries.push(entry);
  trimResultHistory(store, entry.conversationId);
  return entry;
}

function resultHistoryForConversation(store: ResultHistoryStore, conversationId: number) {
  return store.entries.filter((entry) => entry.conversationId === conversationId);
}

function clampResultHistoryIndex(store: ResultHistoryStore, conversationId: number, index?: number) {
  const entries = resultHistoryForConversation(store, conversationId);
  if (entries.length === 0) {
    return { entries, index: -1 };
  }
  if (index === undefined || !Number.isFinite(index)) {
    return { entries, index: entries.length - 1 };
  }
  return { entries, index: Math.min(Math.max(0, Math.trunc(index)), entries.length - 1) };
}

function formatResultHistoryEntry(entry: ResultHistoryEntry, index: number, total: number) {
  const title = `历史结果 c${entry.conversationId} ${index + 1}/${total}`;
  const source = entry.kind === "active" ? `主动 ${entry.source}` : entry.source;
  const attachmentSummary = renderAttachmentSummary(entry.attachments);
  return [title, `来源：${source}`, `时间：${entry.createdAt}`, "", entry.result, attachmentSummary ? `\n${attachmentSummary}` : ""].join("\n");
}

function formatResultHistory(
  store: ResultHistoryStore,
  conversationId: number,
  index?: number,
) {
  const resolved = clampResultHistoryIndex(store, conversationId, index);
  if (resolved.index < 0) {
    return `会话 c${conversationId} 暂无历史结果`;
  }
  return formatResultHistoryEntry(resolved.entries[resolved.index], resolved.index, resolved.entries.length);
}

function resultHistoryReplyMarkup(conversationId: number, index: number, total: number) {
  if (total <= 1) {
    return undefined;
  }
  const previousIndex = Math.max(0, index - 1);
  const nextIndex = Math.min(total - 1, index + 1);
  return {
    inline_keyboard: [
      [
        { text: "上一条", callback_data: `task_handoff:history:${conversationId}:${previousIndex}` },
        { text: `${index + 1}/${total}`, callback_data: `task_handoff:history:${conversationId}:${index}` },
        { text: "下一条", callback_data: `task_handoff:history:${conversationId}:${nextIndex}` },
      ],
    ],
  };
}

function resultHistoryPayload(store: ResultHistoryStore, conversationId: number, index?: number) {
  const resolved = clampResultHistoryIndex(store, conversationId, index);
  if (resolved.index < 0) {
    return {
      text: `会话 c${conversationId} 暂无历史结果`,
      replyMarkup: undefined,
      found: false,
    };
  }
  return {
    text: formatResultHistoryEntry(resolved.entries[resolved.index], resolved.index, resolved.entries.length),
    replyMarkup: resultHistoryReplyMarkup(conversationId, resolved.index, resolved.entries.length),
    found: true,
  };
}

function addResultHistory(ref: ReceiverRef<ResultHistoryStore>, options: AddResultHistoryOptions) {
  return addResultHistoryEntry(ref.current, options);
}

export {
  addResultHistory,
  addResultHistoryEntry,
  createResultHistoryStore,
  formatResultHistory,
  resultHistoryForConversation,
  resultHistoryPayload,
};

export type { ResultHistoryEntry, ResultHistoryKind, ResultHistoryStore };
