import { DEFAULT_CONVERSATION_ID } from "./config";

type ConversationStatus = "open" | "closed";
type ConversationMode = "passive" | "codex" | "claude";
type ConversationAgent = "codex" | "claude";

type Conversation = {
  id: number;
  mode: ConversationMode;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  cwd?: string;
  timeoutMs?: number;
  agent?: ConversationAgent;
  aiSessionId?: string;
  agentSessionId?: string;
  codexSessionId?: string;
};

type ConversationSettings = {
  conversations?: Array<{
    id?: unknown;
    mode?: unknown;
    status?: unknown;
    createdAt?: string;
    updatedAt?: string;
    closedAt?: string;
    cwd?: unknown;
    timeoutMs?: unknown;
    agent?: unknown;
    aiSessionId?: unknown;
    agentSessionId?: unknown;
    codexSessionId?: unknown;
  }>;
  defaultConversationId?: unknown;
  nextConversationId?: unknown;
};

function parseConversationId(value: unknown) {
  const id = Number(String(value || "").trim());
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function parseConversationMode(value: unknown): ConversationMode | undefined {
  return value === "codex" || value === "claude" || value === "passive" ? value : undefined;
}

function parseConversationTimeoutMs(value: unknown) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
}

function parseConversationAgent(value: unknown): ConversationAgent | undefined {
  return value === "codex" || value === "claude" ? value : undefined;
}

function createConversation(id: number, mode: ConversationMode = "passive", status: ConversationStatus = "open"): Conversation {
  const timestamp = new Date().toISOString();
  return {
    id,
    mode,
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
    agent: mode === "codex" || mode === "claude" ? mode : undefined,
  };
}

function createPassiveConversation(id: number, status: ConversationStatus = "open"): Conversation {
  return createConversation(id, "passive", status);
}

function normalizeConversations(settings: ConversationSettings) {
  const byId = new Map<number, Conversation>();
  for (const conversation of Array.isArray(settings.conversations) ? settings.conversations : []) {
    const id = parseConversationId(conversation?.id);
    if (!id) {
      continue;
    }
    const mode = parseConversationMode(conversation.mode) || "passive";
    const agent = parseConversationAgent(conversation.agent) || (mode === "codex" || mode === "claude" ? mode : undefined);
    const agentSessionId =
      typeof conversation.agentSessionId === "string" && conversation.agentSessionId.trim()
        ? conversation.agentSessionId.trim()
        : agent === "codex" && typeof conversation.codexSessionId === "string" && conversation.codexSessionId.trim()
          ? conversation.codexSessionId.trim()
          : undefined;
    byId.set(id, {
      id,
      mode,
      status: conversation.status === "closed" ? "closed" : "open",
      createdAt: conversation.createdAt || new Date().toISOString(),
      updatedAt: conversation.updatedAt || new Date().toISOString(),
      closedAt: conversation.closedAt,
      cwd: typeof conversation.cwd === "string" && conversation.cwd.trim() ? conversation.cwd.trim() : undefined,
      timeoutMs: parseConversationTimeoutMs(conversation.timeoutMs),
      agent,
      aiSessionId: typeof conversation.aiSessionId === "string" && conversation.aiSessionId.trim() ? conversation.aiSessionId.trim() : undefined,
      agentSessionId,
      codexSessionId:
        typeof conversation.codexSessionId === "string" && conversation.codexSessionId.trim()
          ? conversation.codexSessionId.trim()
          : agent === "codex" && agentSessionId
            ? agentSessionId
          : undefined,
    });
  }

  const defaultId = parseConversationId(settings.defaultConversationId) || DEFAULT_CONVERSATION_ID;
  if (!byId.has(defaultId)) {
    byId.set(defaultId, createPassiveConversation(defaultId));
  }
  if (!byId.has(DEFAULT_CONVERSATION_ID)) {
    byId.set(DEFAULT_CONVERSATION_ID, createPassiveConversation(DEFAULT_CONVERSATION_ID));
  }

  const conversations = [...byId.values()].sort((a, b) => a.id - b.id);
  const nextConversationId = Math.max(
    Number(settings.nextConversationId) || 1,
    conversations.reduce((max, conversation) => Math.max(max, conversation.id + 1), 1),
  );

  return { conversations, defaultConversationId: defaultId, nextConversationId };
}

export {
  createConversation,
  createPassiveConversation,
  normalizeConversations,
  parseConversationAgent,
  parseConversationId,
  parseConversationMode,
  parseConversationTimeoutMs,
};
export type { Conversation, ConversationAgent, ConversationMode, ConversationSettings, ConversationStatus };
