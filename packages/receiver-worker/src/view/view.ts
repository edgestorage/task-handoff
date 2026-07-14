import React from "react";
import { Box, Text } from "ink";
import { TextArea } from "react-ink-textarea";
import { formatDuration } from "@task-handoff/terminal-ui";
import type { PendingViewItem, QueuedReplyViewItem, ReceiverConversation } from "../types";

type PanelProps = React.ComponentProps<typeof Box> & {
  title: string;
  children?: React.ReactNode;
};

type LogEntry = {
  id: string | number;
  message: string;
  level?: string;
};

type CommandSuggestion = {
  value: string;
  description: string;
};

type ConversationViewItem = ReceiverConversation & {
  waiting: number;
  queued: number;
  tags: string[];
};

type ReceiverViewProps = {
  activeConversationId: number;
  completeSelectedCommand: () => void;
  conversationItems: ConversationViewItem[];
  editorCursor: [number, number];
  focusedId?: number;
  input: string;
  inputPlaceholder: string;
  latestResult?: PendingViewItem & { result?: string };
  logs: LogEntry[];
  pending: Array<PendingViewItem & { id: number; kind?: string; result: string; timeoutMs: number }>;
  queuedReplies: Array<QueuedReplyViewItem & { id: number; value: string }>;
  ready: boolean;
  selectedSuggestion: number;
  setEditorCursor: (cursor: [number, number]) => void;
  setInput: (value: string) => void;
  showCommandPanel: boolean;
  statusItems: Array<[string, string]>;
  submitInput: (value: string) => void;
  suggestionWindow: { start: number; items: CommandSuggestion[] };
  suggestions: CommandSuggestion[];
  textAreaKeybindings: Record<string, boolean>;
};

function Panel({ title, children, ...boxProps }: PanelProps) {
  return React.createElement(
    Box,
    {
      borderStyle: "round",
      borderColor: "gray",
      flexDirection: "column",
      paddingX: 1,
      marginBottom: 1,
      ...boxProps,
    },
    React.createElement(Text, { color: "cyan", bold: true }, title),
    children,
  );
}

function ReceiverView({
  activeConversationId,
  completeSelectedCommand,
  conversationItems,
  editorCursor,
  focusedId,
  input,
  inputPlaceholder,
  latestResult,
  logs,
  pending,
  queuedReplies,
  ready,
  selectedSuggestion,
  setEditorCursor,
  setInput,
  showCommandPanel,
  statusItems,
  submitInput,
  suggestionWindow,
  suggestions,
  textAreaKeybindings,
}: ReceiverViewProps) {
  return React.createElement(
    Box,
    { flexDirection: "column", paddingX: 1 },
    React.createElement(
      Box,
      { justifyContent: "space-between" },
      React.createElement(Text, { color: "cyan", bold: true }, "task-handoff receiver"),
      React.createElement(Text, { color: ready ? "green" : "yellow" }, ready ? "online" : "starting"),
    ),
    React.createElement(
      Box,
      { flexDirection: "row", gap: 1 },
      React.createElement(
        Box,
        { flexDirection: "column", flexGrow: 1, flexShrink: 1 },
        React.createElement(
          Panel,
          { title: "Status" },
          ...statusItems.map(([label, value]) =>
            React.createElement(
              Text,
              { key: label },
              React.createElement(Text, { color: "gray" }, `${label.padEnd(9)} `),
              value,
            ),
          ),
        ),
        React.createElement(
          Panel,
          { title: "Pending" },
          pending.length === 0
            ? React.createElement(Text, { color: "gray" }, "No waiting sender.")
            : pending.slice(0, 5).map((item) =>
                React.createElement(
                  Text,
                  { key: item.id },
                  React.createElement(Text, { color: item.id === focusedId ? "yellow" : "green" }, `#${item.id} `),
                  React.createElement(Text, { color: "cyan" }, `c${item.conversationId} `),
                  item.kind === "approval" ? React.createElement(Text, { color: "magenta" }, "approval ") : null,
                  React.createElement(Text, { color: "gray" }, `${formatDuration(item.timeoutMs)} `),
                  item.result.replace(/\s+/g, " ").slice(0, 90),
                ),
              ),
        ),
        React.createElement(
          Panel,
          { title: "Queued Replies" },
          queuedReplies.length === 0
            ? React.createElement(Text, { color: "gray" }, "No queued reply.")
            : queuedReplies.slice(0, 5).map((item) =>
                React.createElement(
                  Text,
                  { key: item.id },
                  React.createElement(Text, { color: "magenta" }, `#${item.id} `),
                  React.createElement(Text, { color: "cyan" }, `c${item.conversationId} `),
                  item.value.replace(/\s+/g, " ").slice(0, 90),
                ),
              ),
        ),
        React.createElement(
          Panel,
          { title: "Latest Message" },
          latestResult
            ? React.createElement(Text, null, latestResult.result)
            : React.createElement(Text, { color: "gray" }, "Waiting for first result."),
        ),
        React.createElement(
          Panel,
          { title: "Log" },
          logs.length === 0
            ? React.createElement(Text, { color: "gray" }, "No events yet.")
            : logs.map((entry) =>
                React.createElement(
                  Text,
                  {
                    key: entry.id,
                    color: entry.level === "error" ? "red" : entry.level === "warn" ? "yellow" : undefined,
                  },
                  entry.message,
                ),
              ),
        ),
        showCommandPanel &&
          React.createElement(
            Box,
            {
              borderStyle: "round",
              borderColor: suggestions.length > 0 ? "yellow" : "gray",
              flexDirection: "column",
              paddingX: 1,
              marginBottom: 1,
            },
            React.createElement(
              Text,
              { color: "gray" },
              suggestions.length === 0
                ? "No matching command."
                : `${suggestions.length} command${
                    suggestions.length === 1 ? "" : "s"
                  } - Up/Down to move, Tab/Enter to complete`,
            ),
            suggestions.length > 0 &&
              suggestionWindow.items.map((command, index: number) => {
                const absoluteIndex = suggestionWindow.start + index;
                return React.createElement(
                  Text,
                  {
                    key: command.value,
                    color: absoluteIndex === selectedSuggestion ? "yellow" : undefined,
                    bold: absoluteIndex === selectedSuggestion,
                  },
                  `${absoluteIndex === selectedSuggestion ? ">" : " "} ${command.value.padEnd(32)} ${
                    command.description
                  }`,
                );
              }),
          ),
        React.createElement(
          Box,
          { borderStyle: "round", borderColor: "cyan", paddingX: 1, flexDirection: "column" },
          React.createElement(Text, { color: "cyan" }, "reply > "),
          React.createElement(TextArea, {
            focus: true,
            value: input,
            cursorPosition: editorCursor,
            onChange: setInput,
            onCursorChange: setEditorCursor,
            onSubmit: submitInput,
            placeholder: inputPlaceholder,
            initialLineCount: 1,
            viewportLines: 6,
            keybindings: textAreaKeybindings,
            onTab: completeSelectedCommand,
          }),
        ),
        React.createElement(
          Text,
          { color: "gray" },
          "Enter to send. Ctrl+Enter for newline. Ctrl+C or /quit to stop. /restart to restart.",
        ),
      ),
      React.createElement(
        Panel,
        { title: "Sessions", width: 28, flexShrink: 0 },
        conversationItems.length === 0
          ? React.createElement(Text, { color: "gray" }, "No conversations.")
          : conversationItems.slice(0, 12).map((conversation) =>
              React.createElement(
                Box,
                { key: conversation.id, flexDirection: "column", marginBottom: 1 },
                React.createElement(
                  Text,
                  {
                    color:
                      conversation.id === activeConversationId
                        ? "yellow"
                        : conversation.status === "closed"
                          ? "gray"
                          : "green",
                    bold: conversation.id === activeConversationId,
                  },
                  `${conversation.id === activeConversationId ? ">" : " "} c${conversation.id} ${
                    conversation.status === "closed" ? "closed" : conversation.mode
                  }`,
                ),
                React.createElement(
                  Text,
                  { color: "gray" },
                  `  p${conversation.waiting} q${conversation.queued}${
                    conversation.tags.length > 0 ? ` ${conversation.tags.join("/")}` : ""
                  }`,
                ),
              ),
            ),
        conversationItems.length > 12 &&
          React.createElement(Text, { color: "gray" }, `... ${conversationItems.length - 12} more`),
      ),
    ),
  );
}

export { ReceiverView };
