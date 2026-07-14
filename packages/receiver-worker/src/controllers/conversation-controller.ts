import fs from "node:fs";
import path from "node:path";
import { useCallback } from "react";
import { loadSettings, patchSettings } from "@task-handoff/core/core/persistence";
import { codexIdFromMessage } from "../state/bindings";
import { deleteConversationState } from "../state/conversation-store";
import { isActiveConversationMode } from "../domain/active-agents";
import {
  conversationAgent,
  conversationAgentSessionId,
  conversationWithCwd,
} from "../domain/conversation-actions";
import { createCwdPicker as createCwdPickerModel, handleCwdPickerAction as handleCwdPickerModelAction } from "../domain/cwd-picker";
import type { CwdPicker, CwdPickerAction } from "../domain/cwd-picker";
import { ownerKeysFromMessage, isConversationActivityExpired } from "../state/activity";
import { createConversation, createPassiveConversation, parseConversationId, parseConversationMode } from "../domain/conversations";
import type { ChatToolState } from "../state/chat-tools";
import type { ConversationActivity } from "../state/activity";
import type { PendingItem, QueuedReply, ReceiverConversation, ReceiverLogFn, ReceiverRef } from "../types";

type DeleteConversationOptions = {
  allowMissing?: boolean;
  silent?: boolean;
  reason?: string;
};

type ReceiverConversationControllerOptions = {
  activeConversationIdRef: ReceiverRef<number>;
  addLog: ReceiverLogFn;
  chatConversationCwdPromptsRef: ReceiverRef<Map<string, CwdPicker>>;
  chatToolStateRef: ReceiverRef<ChatToolState>;
  conversationActivityRef: ReceiverRef<ConversationActivity>;
  conversationsRef: ReceiverRef<ReceiverConversation[]>;
  defaultConversationIdRef: ReceiverRef<number>;
  nextConversationIdRef: ReceiverRef<number>;
  pendingRef: ReceiverRef<PendingItem[]>;
  queuedRepliesRef: ReceiverRef<QueuedReply[]>;
  setActiveConversationId: (id: number) => void;
  setConversations: (conversations: ReceiverConversation[]) => void;
};

function useReceiverConversationController({
  activeConversationIdRef,
  addLog,
  chatConversationCwdPromptsRef,
  chatToolStateRef,
  conversationActivityRef,
  conversationsRef,
  defaultConversationIdRef,
  nextConversationIdRef,
  pendingRef,
  queuedRepliesRef,
  setActiveConversationId,
  setConversations,
}: ReceiverConversationControllerOptions) {
  const persistConversations = useCallback((nextConversations = conversationsRef.current) => {
    patchSettings({
      conversations: nextConversations,
      nextConversationId: nextConversationIdRef.current,
      defaultConversationId: defaultConversationIdRef.current,
    });
  }, [conversationsRef, defaultConversationIdRef, nextConversationIdRef]);

  const syncConversations = useCallback((nextConversations: ReceiverConversation[]) => {
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    persistConversations(nextConversations);
  }, [conversationsRef, persistConversations, setConversations]);

  const findConversation = useCallback((id: number) => conversationsRef.current.find((conversation) => conversation.id === id), [conversationsRef]);

  const visibleConversationIdsForApproval = useCallback((message: Record<string, unknown>, conversationId: number) => {
    const ids = new Set([conversationId]);
    const ownerKeys = ownerKeysFromMessage(message);
    const codexId = codexIdFromMessage(message);
    const sessionBindings = loadSettings().conversationBindings?.sessions || {};
    for (const ownerKey of ownerKeys) {
      const bindingKey = ownerKey.startsWith("session:") ? ownerKey.slice("session:".length) : ownerKey;
      const boundId = parseConversationId(sessionBindings[bindingKey]);
      if (boundId) {
        ids.add(boundId);
      }
    }
    if (codexId) {
      for (const conversation of conversationsRef.current) {
        if (conversationAgent(conversation) === "codex" && conversationAgentSessionId(conversation) === codexId) {
          ids.add(conversation.id);
        }
      }
    }
    return [...ids].filter((id) => findConversation(id)?.status !== "closed");
  }, [conversationsRef, findConversation]);

  const bindingConversationIdForApproval = useCallback(
    (message: Record<string, unknown>, fallbackConversationId: number, visibleConversationIds: number[]) => {
      const codexId = codexIdFromMessage(message);
      if (!codexId) {
        return fallbackConversationId;
      }
      return (
        visibleConversationIds.find((id) => {
          const conversation = findConversation(id);
          return conversationAgent(conversation) === "codex" && conversationAgentSessionId(conversation) === codexId && isActiveConversationMode(conversation.mode);
        }) || fallbackConversationId
      );
    },
    [findConversation],
  );

  const ensureConversation = useCallback(
    (id: number) => {
      const existing = findConversation(id);
      if (existing) {
        return existing;
      }
      const nextConversation = createPassiveConversation(id);
      nextConversationIdRef.current = Math.max(nextConversationIdRef.current, id + 1);
      syncConversations([...conversationsRef.current, nextConversation].sort((a, b) => a.id - b.id));
      addLog(`conversation ${id} created`, "success");
      return nextConversation;
    },
    [addLog, conversationsRef, findConversation, nextConversationIdRef, syncConversations],
  );

  const createNextConversation = useCallback((mode = "passive") => {
    const id = nextConversationIdRef.current;
    nextConversationIdRef.current += 1;
    const conversation = createConversation(id, parseConversationMode(mode) || "passive");
    if (isActiveConversationMode(conversation.mode)) {
      conversation.cwd = process.cwd();
      conversation.agent = conversation.mode === "codex" || conversation.mode === "claude" ? conversation.mode : undefined;
    }
    syncConversations([...conversationsRef.current, conversation].sort((a, b) => a.id - b.id));
    return conversation;
  }, [conversationsRef, nextConversationIdRef, syncConversations]);

  const setConversationCwd = useCallback(
    (conversationId: number, cwdValue: string) => {
      const resolvedCwd = String(cwdValue || "").trim() ? path.resolve(process.cwd(), String(cwdValue).trim()) : "";
      if (!conversationId || !resolvedCwd) {
        return { ok: false, message: "Usage: /conversation cwd [id] <path>" };
      }
      let stat;
      try {
        stat = fs.statSync(resolvedCwd);
      } catch {
        stat = undefined;
      }
      if (!stat?.isDirectory()) {
        return { ok: false, message: `conversation cwd is not a directory: ${resolvedCwd}` };
      }
      ensureConversation(conversationId);
      const now = new Date().toISOString();
      syncConversations(
        conversationsRef.current.map((conversation) => {
          if (conversation.id !== conversationId) {
            return conversation;
          }
          return conversationWithCwd(conversation, resolvedCwd, now);
        }),
      );
      return { ok: true, message: `conversation ${conversationId} cwd set to ${resolvedCwd}` };
    },
    [conversationsRef, ensureConversation, syncConversations],
  );

  const createCwdPicker = useCallback(
    (conversationId: number, cwdValue = "") => {
      const current = findConversation(conversationId)?.cwd || process.cwd();
      return createCwdPickerModel(chatConversationCwdPromptsRef.current, conversationId, current, cwdValue);
    },
    [chatConversationCwdPromptsRef, findConversation],
  );

  const handleCwdPickerAction = useCallback(
    (action: CwdPickerAction) => handleCwdPickerModelAction(chatConversationCwdPromptsRef.current, action, setConversationCwd),
    [chatConversationCwdPromptsRef, setConversationCwd],
  );

  const deleteConversation = useCallback(
    (conversationId: number, options: DeleteConversationOptions = {}) => {
      const allowMissing = Boolean(options.allowMissing);
      const silent = Boolean(options.silent);
      const reason = options.reason || "deleted";
      if (conversationId === defaultConversationIdRef.current) {
        if (!silent) {
          addLog("Cannot delete the default conversation. Set another default first.", "warn");
        }
        return false;
      }
      if (!findConversation(conversationId)) {
        if (!allowMissing && !silent) {
          addLog(`conversation ${conversationId} not found`, "warn");
        }
        return false;
      }
      if (
        pendingRef.current.some((item) => item.conversationId === conversationId) ||
        queuedRepliesRef.current.some((item) => item.conversationId === conversationId)
      ) {
        if (!silent) {
          addLog(`conversation ${conversationId} has pending or queued items. Clear them first.`, "warn");
        }
        return false;
      }

      const deletedState = deleteConversationState({
        settings: loadSettings(),
        conversations: conversationsRef.current,
        chatBindings: chatToolStateRef.current.chatBindings,
        conversationActivity: conversationActivityRef.current,
        conversationId,
      });
      chatToolStateRef.current.chatBindings = deletedState.chatBindings as ChatToolState["chatBindings"];
      conversationActivityRef.current = deletedState.conversationActivity;
      if (activeConversationIdRef.current === conversationId) {
        activeConversationIdRef.current = defaultConversationIdRef.current;
        setActiveConversationId(defaultConversationIdRef.current);
      }
      syncConversations(deletedState.conversations);
      patchSettings(deletedState.patch);
      if (!silent) {
        addLog(`conversation ${conversationId} ${reason}`, "success");
      }
      return true;
    },
    [
      activeConversationIdRef,
      addLog,
      chatToolStateRef,
      conversationActivityRef,
      conversationsRef,
      defaultConversationIdRef,
      findConversation,
      pendingRef,
      queuedRepliesRef,
      setActiveConversationId,
      syncConversations,
    ],
  );

  const pruneInactiveConversations = useCallback(() => {
    const deletedIds = [];
    for (const conversation of [...conversationsRef.current]) {
      if (
        conversation.id !== defaultConversationIdRef.current &&
        isConversationActivityExpired(conversationActivityRef.current, conversation.id)
      ) {
        if (deleteConversation(conversation.id, { reason: "deleted after 12h inactive" })) {
          deletedIds.push(conversation.id);
        }
      }
    }
    return deletedIds;
  }, [conversationActivityRef, conversationsRef, defaultConversationIdRef, deleteConversation]);

  return {
    bindingConversationIdForApproval,
    createCwdPicker,
    createNextConversation,
    deleteConversation,
    ensureConversation,
    findConversation,
    handleCwdPickerAction,
    persistConversations,
    pruneInactiveConversations,
    setConversationCwd,
    syncConversations,
    visibleConversationIdsForApproval,
  };
}

export { useReceiverConversationController };
