import type { SenderAttachment } from "@task-handoff/core/core/attachments";

type ReceiverLogLevel = "info" | "success" | "warn" | "error";

type ReceiverLogFn = (message: string, level?: ReceiverLogLevel) => void;

type ReceiverInitialOptions = {
  telegramToken?: string;
  telegramChatId?: string;
  telegramAllowedUserIds?: string | string[];
  telegramConversationId?: number;
  wechatToken?: string;
  wechatBaseUrl?: string;
  wechatChatId?: string;
  wechatConversationId?: number;
  wechatContextToken?: string;
  wechatUpdatesBuf?: string;
  dingdingClientId?: string;
  dingdingClientSecret?: string;
  dingdingCorpId?: string;
  dingdingRobotCode?: string;
  dingdingCardTemplateId?: string;
  dingdingCardCallbackRouteKey?: string;
  dingdingCardUserIdType?: number;
  dingdingChatId?: string;
  dingdingAllowedUserIds?: string | string[];
  dingdingConversationId?: number;
};

type ChatStatus = {
  enabled: boolean;
  polling: boolean;
  tokenSet: boolean;
  chatId?: string;
  conversationId?: number;
  contextSet?: boolean;
};

type ReceiverConversation = Record<string, unknown> & {
  id: number;
  status?: string;
  mode?: string;
  agent?: string;
  aiSessionId?: string;
  agentSessionId?: string;
  codexSessionId?: string;
  cwd?: string;
  timeoutMs?: number;
  updatedAt?: string;
};

type PendingViewItem = Record<string, unknown> & {
  id: number;
  conversationId: number;
  result: string;
  attachments?: SenderAttachment[];
  timeoutMs: number;
  source?: string;
  visibleConversationIds?: number[];
  kind?: string;
};

type QueuedReplyViewItem = Record<string, unknown> & {
  id: number;
  conversationId: number;
  value: string;
  label?: string;
};

type QueuedReplySource = {
  channel: string;
  instanceId?: string;
  chatId?: string;
  messageId?: number;
};

type ReceiverRef<T> = {
  current: T;
};

type ReceiverStateSetter<T> = (value: T | ((current: T) => T)) => void;

type ReceiverProcessing = {
  start?: () => void;
  done?: () => void;
  cancel?: () => boolean;
  progressRouteTarget?: Record<string, unknown>;
};

type ReceiverSocket = {
  destroyed?: boolean;
  write: (data: string, callback?: () => void) => unknown;
  end: () => unknown;
  destroy?: () => unknown;
};

type ReceiverChatBridge = {
  enabled?: boolean;
  start?: () => unknown;
  stop?: () => unknown;
  destroy?: () => unknown;
};

type ReceiverChatRoute = Record<string, unknown> & {
  capabilities: { progress?: boolean };
};

type PendingItem = Record<string, unknown> & {
  id: number;
  conversationId: number;
  visibleConversationIds?: number[];
  socket: ReceiverSocket;
  result: string;
  attachments?: SenderAttachment[];
  timeoutMs: number;
  source: string;
  kind?: "task" | "result" | "approval";
  codexId?: string;
  claudeId?: string;
  cwd?: string;
  autoTimer?: ReturnType<typeof setTimeout>;
};

type QueuedReply = QueuedReplyViewItem & {
  processing?: ReceiverProcessing;
  source?: QueuedReplySource;
  routeTarget?: Record<string, unknown>;
};

type IncomingResultMessage = {
  type: "result";
  result: string;
  conversationId?: number | string;
  timeoutMs?: number | string;
  source?: string;
  kind?: string;
  cwd?: string;
  [key: string]: unknown;
};

export type {
  ChatStatus,
  IncomingResultMessage,
  PendingItem,
  PendingViewItem,
  QueuedReply,
  QueuedReplySource,
  QueuedReplyViewItem,
  ReceiverConversation,
  ReceiverInitialOptions,
  ReceiverLogFn,
  ReceiverLogLevel,
  ReceiverProcessing,
  ReceiverRef,
  ReceiverChatBridge,
  ReceiverChatRoute,
  ReceiverStateSetter,
  ReceiverSocket,
};
