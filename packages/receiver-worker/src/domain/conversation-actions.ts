import path from "node:path";
import { isActiveConversationMode } from "./active-agents";
import type { ReceiverConversation } from "../types";

function conversationAgent(conversation?: ReceiverConversation) {
  return conversation?.agent || (conversation?.mode === "codex" || conversation?.mode === "claude" ? conversation.mode : undefined);
}

function conversationAgentSessionId(conversation?: ReceiverConversation) {
  return conversation?.agentSessionId || (conversationAgent(conversation) === "codex" ? conversation?.codexSessionId : undefined);
}

function conversationAiSessionId(conversation?: ReceiverConversation) {
  return typeof conversation?.aiSessionId === "string" && conversation.aiSessionId.trim() ? conversation.aiSessionId.trim() : undefined;
}

function conversationWithAiSession(
  conversation: ReceiverConversation,
  aiSession: { id: string; agent?: string; providerSessionId?: string; cwd?: string },
  updatedAt: string,
) {
  const agent = aiSession.agent || conversationAgent(conversation);
  return {
    ...conversation,
    mode: agent || conversation.mode,
    agent,
    aiSessionId: aiSession.id,
    agentSessionId: aiSession.providerSessionId || conversationAgentSessionId(conversation),
    codexSessionId: agent === "codex" ? aiSession.providerSessionId || conversation.codexSessionId : undefined,
    cwd: aiSession.cwd || conversation.cwd,
    updatedAt,
  };
}

function conversationWithAgentSession(conversation: ReceiverConversation, sessionId: string, aiSessionId?: string) {
  const agent = conversationAgent(conversation);
  return {
    ...conversation,
    agent,
    aiSessionId: aiSessionId || conversation.aiSessionId,
    agentSessionId: sessionId,
    codexSessionId: agent === "codex" ? sessionId : conversation.codexSessionId,
  };
}

function conversationWithNewAgentSession(conversation: ReceiverConversation, updatedAt: string) {
  const agent = conversationAgent(conversation);
  return {
    ...conversation,
    agent,
    aiSessionId: undefined,
    agentSessionId: undefined,
    codexSessionId: undefined,
    updatedAt,
  };
}

function conversationWithHistoricalSession(
  conversation: ReceiverConversation,
  agent: string,
  sessionId: string,
  cwd: string,
  updatedAt: string,
) {
  return {
    ...conversation,
    mode: agent,
    agent,
    aiSessionId: undefined,
    agentSessionId: sessionId,
    codexSessionId: agent === "codex" ? sessionId : undefined,
    cwd,
    updatedAt,
  };
}

function conversationWithCwd(conversation: ReceiverConversation, resolvedCwd: string, updatedAt: string, baseCwd = process.cwd()) {
  const previousCwd = conversation.cwd ? path.resolve(baseCwd, conversation.cwd) : "";
  const cwdChanged = previousCwd !== resolvedCwd;
  const next = { ...conversation, cwd: resolvedCwd, updatedAt };
  if (cwdChanged && isActiveConversationMode(conversation.mode)) {
    next.aiSessionId = undefined;
    next.agentSessionId = undefined;
    next.codexSessionId = undefined;
  }
  return next;
}

function conversationWithMode(conversation: ReceiverConversation, mode: string, updatedAt: string) {
  const active = isActiveConversationMode(mode);
  return {
    ...conversation,
    mode,
    agent: active ? mode : undefined,
    aiSessionId: active && conversationAgent(conversation) === mode ? conversationAiSessionId(conversation) : undefined,
    agentSessionId: active && conversationAgent(conversation) === mode ? conversationAgentSessionId(conversation) : undefined,
    codexSessionId: mode === "codex" && conversationAgent(conversation) === "codex" ? conversation.codexSessionId : undefined,
    cwd: active ? conversation.cwd || process.cwd() : conversation.cwd,
    updatedAt,
  };
}

export {
  conversationAiSessionId,
  conversationAgent,
  conversationAgentSessionId,
  conversationWithAiSession,
  conversationWithAgentSession,
  conversationWithCwd,
  conversationWithHistoricalSession,
  conversationWithMode,
  conversationWithNewAgentSession,
};
