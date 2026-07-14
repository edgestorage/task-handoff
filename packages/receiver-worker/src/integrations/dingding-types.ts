import type { ChatRoute } from "@task-handoff/core/core/chat";
import type { ChatProgressOptions } from "@task-handoff/core/core/chat";

export type DingdingTargetRoute = Partial<ChatRoute> & {
  target?: {
    chatId?: unknown;
    sessionWebhook?: unknown;
    senderId?: unknown;
  };
};

export type DingdingBridgeOptions = {
  clientId?: string;
  clientSecret?: string;
  corpId?: string;
  robotCode?: string;
  cardTemplateId?: string;
  cardCallbackRouteKey?: string;
  cardUserIdType?: number;
  chatId?: string;
  allowedUserIds?: string | string[];
  multiChat?: boolean;
  onText: (text: string, meta?: { chatId?: string; sessionWebhook?: string; senderId?: string; senderNick?: string }) => unknown | Promise<unknown>;
  onAction?: (action: unknown) => unknown | Promise<unknown>;
  onLog: (message: string) => void;
  onChange?: (state: {
    clientId?: string;
    clientSecret?: string;
    corpId?: string;
    robotCode?: string;
    cardTemplateId?: string;
    cardCallbackRouteKey?: string;
    cardUserIdType?: number;
    chatId?: string;
    allowedUserIds?: string[];
  }) => void;
};

export type DingdingRobotMessage = {
  conversationId?: string;
  conversationType?: string;
  senderStaffId?: string;
  senderId?: string;
  senderNick?: string;
  sessionWebhook?: string;
  msgtype?: string;
  text?: { content?: string };
};

export type DingdingCardCallback = Record<string, unknown> & {
  outTrackId?: string;
  userId?: string;
  spaceId?: string;
  cardActionData?: {
    cardPrivateData?: {
      actionIdList?: string[];
      params?: Record<string, unknown>;
    };
  };
};

export type DingdingProgressEntry = {
  outTrackId?: string;
  route?: DingdingTargetRoute;
  lastText: string;
  lastUpdateAt: number;
  options?: ChatProgressOptions;
  pending?: Promise<unknown>;
  pendingText?: string;
  timer?: ReturnType<typeof setTimeout>;
};
