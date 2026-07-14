type TelegramCallbackAction =
  | {
      type: "cwd";
      token: string;
      action: string;
      index?: number;
    }
  | {
      type: "history";
      conversationId: number;
      index: number;
    }
  | {
      type: "conversation";
      conversationId: number;
    }
  | {
      type: "session";
      conversationId: number;
      agent: string;
      sessionId: string;
    }
  | {
      type: "attachment";
      conversationId: number;
      id: number;
      attachmentId: string;
    }
  | {
      type: "active_cancel";
      conversationId: number;
    }
  | {
      type: "approval";
      conversationId: number;
      id: number;
      decision: "allow" | "deny" | "skip";
    };

function parseTelegramCallbackAction(data: string): TelegramCallbackAction | undefined {
  const cwdMatch = data.match(/^task_handoff:cwd:([^:]+):(up|confirm|cancel|open|prev|next)(?::(\d+))?$/);
  if (cwdMatch) {
    const [, token, action, index] = cwdMatch;
    return {
      type: "cwd",
      token,
      action,
      index: index === undefined ? undefined : Number(index),
    };
  }

  const historyMatch = data.match(/^task_handoff:history:(\d+):(\d+)$/);
  if (historyMatch) {
    const [, conversationId, index] = historyMatch;
    return {
      type: "history",
      conversationId: Number(conversationId),
      index: Number(index),
    };
  }

  const conversationMatch = data.match(/^task_handoff:conversation:(\d+)$/);
  if (conversationMatch) {
    return {
      type: "conversation",
      conversationId: Number(conversationMatch[1]),
    };
  }

  const sessionMatch = data.match(/^task_handoff:session:(\d+):(codex|claude):([^:]+)$/);
  if (sessionMatch) {
    const [, conversationId, agent, sessionId] = sessionMatch;
    return {
      type: "session",
      conversationId: Number(conversationId),
      agent,
      sessionId,
    };
  }

  const attachmentMatch = data.match(/^task_handoff:attachment:(\d+):(\d+):([^:]+)$/);
  if (attachmentMatch) {
    const [, conversationId, id, attachmentId] = attachmentMatch;
    return {
      type: "attachment",
      conversationId: Number(conversationId),
      id: Number(id),
      attachmentId,
    };
  }

  const activeCancelMatch = data.match(/^task_handoff:active_cancel:(\d+)$/);
  if (activeCancelMatch) {
    return {
      type: "active_cancel",
      conversationId: Number(activeCancelMatch[1]),
    };
  }

  const approvalMatch = data.match(/^task_handoff:approval:(\d+):(\d+):(allow|deny|skip)$/);
  if (approvalMatch) {
    const [, conversationId, id, decision] = approvalMatch;
    return {
      type: "approval",
      conversationId: Number(conversationId),
      id: Number(id),
      decision: decision as "allow" | "deny" | "skip",
    };
  }

  return undefined;
}

export { parseTelegramCallbackAction };
export type { TelegramCallbackAction };
