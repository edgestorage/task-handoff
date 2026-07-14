import { useCallback, useEffect } from "react";
import { useInput } from "ink";
import {
  getArgumentEntryCommand,
  getCommandSuggestions,
  hasCommandArguments,
  shouldCompleteCommand,
} from "../domain/commands";
import type { QueuedReply, ReceiverLogFn, ReceiverRef, ReceiverStateSetter } from "../types";

type ReceiverInputControllerOptions = {
  activeConversationIdRef: ReceiverRef<number>;
  addLog: ReceiverLogFn;
  dismissedCompletionInput?: string;
  handleCommand: (line: string) => void;
  input: string;
  queuedRepliesRef: ReceiverRef<QueuedReply[]>;
  replyDefault: (line: string, label: string) => unknown;
  selectedSuggestion: number;
  setDismissedCompletionInput: (value: string | undefined) => void;
  setEditorText: (value: string) => void;
  setSelectedSuggestion: ReceiverStateSetter<number>;
  stopAll: () => void;
  syncQueuedReplies: () => void;
};

function useReceiverInputController({
  activeConversationIdRef,
  addLog,
  dismissedCompletionInput,
  handleCommand,
  input,
  queuedRepliesRef,
  replyDefault,
  selectedSuggestion,
  setDismissedCompletionInput,
  setEditorText,
  setSelectedSuggestion,
  stopAll,
  syncQueuedReplies,
}: ReceiverInputControllerOptions) {
  const submitInput = useCallback(
    (value: string) => {
      const rawLine = value;
      const line = rawLine.trim();
      const argumentCommand = getArgumentEntryCommand(rawLine);
      const suggestions = getCommandSuggestions(rawLine);
      const selected = suggestions[selectedSuggestion] ?? suggestions[0];

      if (selected && shouldCompleteCommand(rawLine, selected)) {
        setEditorText(selected.complete);
        setSelectedSuggestion(0);
        return;
      }

      if (selected && !hasCommandArguments(rawLine, selected)) {
        setEditorText(selected.complete);
        setSelectedSuggestion(0);
        return;
      }

      if (argumentCommand && rawLine.slice(argumentCommand.complete.length).trim().length === 0) {
        setEditorText(argumentCommand.complete);
        return;
      }

      setEditorText("");
      if (!line) {
        return;
      }
      if (line.startsWith("/")) {
        handleCommand(line);
      } else {
        replyDefault(line, "sent");
      }
    },
    [handleCommand, replyDefault, selectedSuggestion, setEditorText, setSelectedSuggestion],
  );

  useInput((inputValue, key) => {
    const completionActive = input.startsWith("/") && dismissedCompletionInput !== input && !getArgumentEntryCommand(input);

    if (key.ctrl && inputValue === "c") {
      stopAll();
    } else if (key.escape && input.startsWith("/")) {
      setDismissedCompletionInput(input);
      setSelectedSuggestion(0);
    } else if (completionActive && key.upArrow) {
      const suggestions = getCommandSuggestions(input);
      if (suggestions.length > 0) {
        setSelectedSuggestion((current: number) => (current - 1 + suggestions.length) % suggestions.length);
      }
    } else if (completionActive && key.downArrow) {
      const suggestions = getCommandSuggestions(input);
      if (suggestions.length > 0) {
        setSelectedSuggestion((current: number) => (current + 1) % suggestions.length);
      }
    } else if (key.upArrow) {
      const conversationId = activeConversationIdRef.current;
      let queuedIndex = -1;
      for (let index = queuedRepliesRef.current.length - 1; index >= 0; index -= 1) {
        if (queuedRepliesRef.current[index].conversationId === conversationId) {
          queuedIndex = index;
          break;
        }
      }
      if (queuedIndex !== -1) {
        const [queued] = queuedRepliesRef.current.splice(queuedIndex, 1);
        syncQueuedReplies();
        setEditorText(queued.value);
        addLog(`recalled queued c${conversationId} #${queued.id}`, "success");
      }
    } else if (completionActive && key.tab) {
      const suggestions = getCommandSuggestions(input);
      const selected = suggestions[selectedSuggestion] ?? suggestions[0];
      if (selected) {
        setEditorText(selected.complete);
        setSelectedSuggestion(0);
      }
    }
  });

  useEffect(() => {
    const suggestions = getCommandSuggestions(input);
    if (selectedSuggestion >= suggestions.length) {
      setSelectedSuggestion(0);
    }
    if (dismissedCompletionInput && dismissedCompletionInput !== input) {
      setDismissedCompletionInput(undefined);
    }
  }, [dismissedCompletionInput, input, selectedSuggestion, setDismissedCompletionInput, setSelectedSuggestion]);

  return { submitInput };
}

export { useReceiverInputController };
