import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type TranscriptTailerOptions = {
  transcriptPath: string;
  onUpdate: (summary: TranscriptSummary) => void;
  intervalMs?: number;
};

type ToolCallState = {
  tool: string;
  command: string;
  ignored: boolean;
  action?: string;
};

type TranscriptTextPart = {
  type: "text";
  text?: string;
};

type TranscriptToolUsePart = {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: unknown;
};

type TranscriptToolResultPart = {
  type: "tool_result";
  tool_use_id?: string;
  is_error?: boolean;
};

type TranscriptOutputTextPart = {
  type: "output_text";
  text?: string;
};

type TranscriptContentPart =
  | TranscriptTextPart
  | TranscriptToolUsePart
  | TranscriptToolResultPart
  | TranscriptOutputTextPart
  | {
      type: string;
      [key: string]: unknown;
    };

type TranscriptMessage = {
  role?: string;
  content?: string | TranscriptContentPart[];
};

type CodexEventPayload = {
  type?: string;
  turn_id?: string;
  message?: string;
};

type CodexResponsePayload =
  | {
      type: "custom_tool_call";
      status?: string;
      call_id?: string;
      name?: string;
      input?: string;
    }
  | {
      type: "custom_tool_call_output";
      call_id?: string;
      output?: string;
    }
  | {
      type: "function_call";
      name?: string;
      arguments?: string;
      call_id?: string;
    }
  | {
      type: "function_call_output";
      call_id?: string;
      output?: string;
    }
  | {
      type: "message";
      role?: string;
      content?: TranscriptContentPart[];
    }
  | {
      type: "reasoning";
      summary?: unknown;
      content?: unknown;
      encrypted_content?: string;
    };

type TranscriptEntry = {
  type: string;
  payload?: CodexEventPayload | CodexResponsePayload;
  message?: TranscriptMessage;
};

export type TranscriptSummary = {
  key?: string;
  text: string;
  kind?: "user" | "assistant" | "tool";
  timestamp?: string;
};

export function isSyntheticUserTranscriptText(value: unknown) {
  const text = fullText(value);
  return /^\[(?:request interrupted by user|user interrupted request)\]$/i.test(text);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseTranscriptEntry(value: unknown): TranscriptEntry {
  return asRecord(value) as TranscriptEntry;
}

function transcriptSummary(input: Omit<TranscriptSummary, "timestamp"> & { timestamp?: string }): TranscriptSummary {
  if (input.timestamp) {
    return input;
  }
  const { timestamp: _timestamp, ...summary } = input;
  return summary;
}

function contentParts(content: TranscriptMessage["content"]): TranscriptContentPart[] {
  return Array.isArray(content) ? content : [];
}

function isToolUsePart(part: TranscriptContentPart): part is TranscriptToolUsePart {
  return part.type === "tool_use";
}

function isToolResultPart(part: TranscriptContentPart): part is TranscriptToolResultPart {
  return part.type === "tool_result";
}

function isTextPart(part: TranscriptContentPart): part is TranscriptTextPart {
  return part.type === "text";
}

function isOutputTextPart(part: TranscriptContentPart): part is TranscriptOutputTextPart {
  return part.type === "output_text";
}

function textFromPart(part: TranscriptContentPart) {
  if ((part.type === "text" || part.type === "output_text" || part.type === "input_text") && typeof part.text === "string") {
    return part.text;
  }
  return "";
}

function textFromMessageContent(content: TranscriptMessage["content"]) {
  if (typeof content === "string") {
    return fullText(content);
  }
  const text = contentParts(content).map(textFromPart).filter(Boolean).join("\n");
  return text ? fullText(text) : "";
}

function compact(value: unknown, max = 180) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function fullText(value: unknown) {
  const text = String(value ?? "").trim();
  return text;
}

function parseCommand(argumentsText: unknown) {
  try {
    const parsed = asRecord(JSON.parse(String(argumentsText || "{}")));
    return compact(parsed.cmd || parsed.command || parsed.path || parsed.ref_id || parsed.pattern || "");
  } catch {
    return "";
  }
}

function parseToolInput(input: unknown) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const value = input as Record<string, unknown>;
    return compact(
      value.command ||
        value.cmd ||
        value.file_path ||
        value.filePath ||
        value.path ||
        value.ref_id ||
        value.pattern ||
        value.description ||
        "",
    );
  }
  return parseCommand(input);
}

function isHandoffCommand(command: string) {
  return /\btask-handoff(\.js)?\b/.test(command);
}

function isFileEditTool(tool: string) {
  return ["edit", "multiedit", "write", "notebookedit"].includes(tool.toLowerCase());
}

export function codexSessionIdFromTranscriptPath(transcriptPath: string) {
  return path.basename(transcriptPath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1];
}

function displayPath(value: string) {
  if (!path.isAbsolute(value)) {
    return value;
  }
  const relative = path.relative(process.cwd(), value);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : value;
}

function patchTargets(input: unknown) {
  const files = [...String(input || "").matchAll(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/gm)].map((match) =>
    displayPath(match[1].trim()),
  );
  if (files.length === 0) {
    return "files";
  }
  const shown = files.slice(0, 2).join(", ");
  return files.length > 2 ? `${shown} +${files.length - 2} more` : shown;
}

export function findCodexTranscriptPath(sessionId: unknown, codexHome = path.join(os.homedir(), ".codex")) {
  const id = compact(sessionId, 200);
  if (!id) {
    return undefined;
  }
  const sessionsDir = path.join(codexHome, "sessions");
  const stack = [sessionsDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(id)) {
        return entryPath;
      }
    }
  }
  return undefined;
}

function claudeProjectDirName(cwd: string) {
  return path.resolve(cwd).split(path.sep).join("-");
}

export function findClaudeTranscriptPath(
  sessionId: unknown,
  cwd?: unknown,
  claudeHome = path.join(os.homedir(), ".claude"),
) {
  const id = compact(sessionId, 200);
  if (!id) {
    return undefined;
  }
  const projectsDir = path.join(claudeHome, "projects");
  const normalizedCwd = compact(cwd);
  if (normalizedCwd) {
    const candidate = path.join(projectsDir, claudeProjectDirName(normalizedCwd), `${id}.jsonl`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const stack = [projectsDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(id)) {
        return entryPath;
      }
    }
  }
  return undefined;
}

export function summarizeTranscriptLine(
  line: string,
  state: { calls: Map<string, ToolCallState> },
): TranscriptSummary | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  const entry = parseTranscriptEntry(parsed);
  const payload = asRecord(entry.payload);
  const timestamp = typeof asRecord(parsed).timestamp === "string" ? asRecord(parsed).timestamp as string : undefined;
  if (entry.type === "turn_context") {
    return undefined;
  }

  if (entry.type === "event_msg") {
    if (payload.type === "agent_message") {
      return transcriptSummary({ text: fullText(payload.message), kind: "assistant", timestamp });
    }
    return undefined;
  }

  if (entry.type === "assistant") {
    const content = contentParts(entry.message?.content);
    let firstSummary: TranscriptSummary | undefined;
    let firstText: string | undefined;
    for (const part of content) {
      if (isToolUsePart(part)) {
        const tool = compact(part.name || "tool", 80);
        const command = parseToolInput(part.input);
        const ignored = isHandoffCommand(command);
        const action = isFileEditTool(tool) ? "edit" : undefined;
        if (part.id) {
          state.calls.set(part.id, { tool, command, ignored, action });
        }
        if (ignored) {
          continue;
        }
        firstSummary ??= transcriptSummary({
          key: part.id,
          text: action === "edit" ? `Editing ${command || "files"}` : command ? `Running ${tool}: ${command}` : `Running ${tool}`,
          kind: "tool",
          timestamp,
        });
        continue;
      }
      if (isTextPart(part) && part.text) {
        firstText ??= fullText(part.text);
      }
    }
    return firstText ? transcriptSummary({ text: firstText, kind: "assistant", timestamp }) : firstSummary;
  }

  if (entry.type === "user") {
    const userText = textFromMessageContent(entry.message?.content);
    if (userText && !isSyntheticUserTranscriptText(userText)) {
      return transcriptSummary({ text: userText, kind: "user", timestamp });
    }
    const content = contentParts(entry.message?.content);
    for (const part of content) {
      if (!isToolResultPart(part)) {
        continue;
      }
      const call = part.tool_use_id ? state.calls.get(part.tool_use_id) : undefined;
      if (!call || call.ignored) {
        continue;
      }
      const failed = Boolean(part.is_error);
      return transcriptSummary({
        key: part.tool_use_id,
        text:
          call.action === "edit"
            ? failed
              ? `Edit failed: ${call.command || "files"}`
              : `Finished editing ${call.command || "files"}`
            : failed
              ? `Failed ${call.tool}${call.command ? `: ${call.command}` : ""}`
              : call.command
                ? `Finished ${call.tool}: ${call.command}`
                : `Finished ${call.tool}`,
        kind: "tool",
        timestamp,
      });
    }
    return undefined;
  }

  if (entry.type !== "response_item") {
    return undefined;
  }

  const responsePayload = entry.payload as CodexResponsePayload | undefined;
  if (!responsePayload) {
    return undefined;
  }
  if (responsePayload.type === "custom_tool_call") {
    const tool = compact(responsePayload.name || "custom_tool", 80);
    if (tool !== "apply_patch") {
      return undefined;
    }
    const command = patchTargets(responsePayload.input);
    if (responsePayload.call_id) {
      state.calls.set(responsePayload.call_id, { tool, command, ignored: false, action: "edit" });
    }
    return transcriptSummary({
      key: responsePayload.call_id,
      text: `Editing ${command}`,
      kind: "tool",
      timestamp,
    });
  }

  if (responsePayload.type === "custom_tool_call_output") {
    const call = responsePayload.call_id ? state.calls.get(responsePayload.call_id) : undefined;
    if (!call || call.ignored || call.action !== "edit") {
      return undefined;
    }
    const output = compact(responsePayload.output, 120);
    const failed = /failed|error/i.test(output);
    return transcriptSummary({
      key: responsePayload.call_id,
      text: failed ? `Edit failed: ${call.command}` : `Finished editing ${call.command}`,
      kind: "tool",
      timestamp,
    });
  }

  if (responsePayload.type === "function_call") {
    const tool = compact(responsePayload.name || "tool", 80);
    const command = parseCommand(responsePayload.arguments);
    const ignored = tool === "write_stdin" || isHandoffCommand(command);
    if (responsePayload.call_id) {
      state.calls.set(responsePayload.call_id, { tool, command, ignored });
    }
    if (ignored) {
      return undefined;
    }
    return transcriptSummary({
      key: responsePayload.call_id,
      text: command ? `Running ${tool}: ${command}` : `Running ${tool}`,
      kind: "tool",
      timestamp,
    });
  }

  if (responsePayload.type === "function_call_output") {
    const call = responsePayload.call_id ? state.calls.get(responsePayload.call_id) : undefined;
    if (!call || call.ignored) {
      return undefined;
    }
    return transcriptSummary({
      key: responsePayload.call_id,
      text: call.command ? `Finished ${call.tool}: ${call.command}` : `Finished ${call.tool}`,
      kind: "tool",
      timestamp,
    });
  }

  if (responsePayload.type === "message") {
    const text = textFromMessageContent(responsePayload.content);
    if (!text) {
      return undefined;
    }
    return transcriptSummary({
      text: fullText(text),
      kind: responsePayload.role === "user" ? "user" : "assistant",
      timestamp,
    });
  }

  return undefined;
}

export function watchTranscript({ transcriptPath, onUpdate, intervalMs = 1000 }: TranscriptTailerOptions) {
  const state = { calls: new Map<string, ToolCallState>() };
  let offset = 0;
  let partial = "";

  try {
    offset = fs.statSync(transcriptPath).size;
  } catch {
    return () => {};
  }

  const readNew = () => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(transcriptPath);
    } catch {
      return;
    }
    if (stat.size < offset) {
      offset = 0;
      partial = "";
    }
    if (stat.size === offset) {
      return;
    }

    const stream = fs.createReadStream(transcriptPath, {
      start: offset,
      end: stat.size - 1,
      encoding: "utf8",
    });
    offset = stat.size;
    stream.on("data", (chunk) => {
      partial += chunk;
      const lines = partial.split(/\n/);
      partial = lines.pop() || "";
      for (const line of lines) {
        const summary = summarizeTranscriptLine(line, state);
        if (summary) {
          onUpdate(summary);
        }
      }
    });
  };

  fs.watchFile(transcriptPath, { interval: intervalMs }, readNew);
  return () => fs.unwatchFile(transcriptPath, readNew);
}
