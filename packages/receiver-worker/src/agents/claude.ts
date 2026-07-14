import { randomUUID } from "node:crypto";
import { assistantJsonlText, findStringByKeys, firstNonEmptyLine, parseJsonLine, stringValue } from "./shared";
import type { ActiveAgentCommandOptions, ActiveAgentCommandSpec } from "./types";

function claudeCommand(env: NodeJS.ProcessEnv = process.env) {
  return env.TASK_HANDOFF_CLAUDE_COMMAND || env.CLAUDE_CLI_PATH || "claude";
}

function envFlag(env: NodeJS.ProcessEnv, ...names: string[]) {
  return names.some((name) => {
    const raw = env[name];
    return raw !== undefined && raw !== "" && ["1", "true", "yes", "on"].includes(raw.toLowerCase());
  });
}

function claudePermissionArgs(env: NodeJS.ProcessEnv) {
  return envFlag(env, "TASK_HANDOFF_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS", "TASK_HANDOFF_CLAUDE_SKIP_PERMISSIONS")
    ? ["--dangerously-skip-permissions"]
    : [];
}

function claudeCommandSpec({
  env = process.env,
  prompt = "",
  sessionId,
}: ActiveAgentCommandOptions): ActiveAgentCommandSpec {
  const claudeSessionId = sessionId || randomUUID();
  const args = [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    ...claudePermissionArgs(env),
  ];
  const claudeModel = String(env.TASK_HANDOFF_CLAUDE_MODEL || "").trim();
  if (claudeModel) {
    args.push("--model", claudeModel);
  }
  args.push(sessionId ? "--resume" : "--session-id", claudeSessionId, prompt);
  return {
    command: claudeCommand(env),
    args,
    sessionId: claudeSessionId,
    stdin: false,
  };
}

function parseClaudeJsonLine(line: string) {
  const event = parseJsonLine(line);
  if (!event) {
    return undefined;
  }
  if (event.type === "result") {
    return stringValue(event.result);
  }
  if (event.type === "assistant") {
    return assistantJsonlText(event) || findStringByKeys(event, ["text", "content", "message"]);
  }
  return findStringByKeys(event, ["message", "content", "text", "last_message", "lastMessage", "response", "result"]) || undefined;
}

function summarizeClaudeJsonLine(line: string) {
  const event = parseJsonLine(line);
  if (!event) {
    return undefined;
  }
  const sessionId = parseClaudeSessionIdLine(line);
  if (event.type === "system" && sessionId) {
    return `Claude session ${sessionId} started`;
  }
  if (event.type === "result") {
    const text = stringValue(event.result);
    return text ? `Claude result: ${text}` : undefined;
  }
  if (event.type === "assistant") {
    const text = parseClaudeJsonLine(line);
    return text ? `Claude: ${text}` : undefined;
  }
  if (event.type === "error") {
    const message = findStringByKeys(event, ["message", "error"]);
    return message ? `Claude failed: ${message}` : "Claude failed";
  }
  return undefined;
}

function parseClaudeSessionIdLine(line: string) {
  const event = parseJsonLine(line);
  if (!event) {
    return undefined;
  }
  const id = findStringByKeys(event, ["session_id", "sessionId"]);
  return id || undefined;
}

function claudeSessionId(output: string) {
  return output
    .split(/\r?\n/)
    .map(parseClaudeSessionIdLine)
    .find((id): id is string => Boolean(id));
}

function parseClaudeFinalMessage(outputJsonl: string) {
  const messages = outputJsonl
    .split(/\r?\n/)
    .map(parseClaudeJsonLine)
    .filter((message): message is string => Boolean(message?.trim()));
  return messages.at(-1) || "";
}

function summarizeClaudeFailure(outputJsonl: string, stderr: string) {
  const summaries = [];
  for (const rawLine of outputJsonl.split(/\r?\n/)) {
    const event = parseJsonLine(rawLine.trim());
    if (!event) {
      continue;
    }
    if (event.type === "error") {
      const message = findStringByKeys(event, ["message", "error"]);
      if (message) {
        return message;
      }
    }
    if (event.type === "result" && event.is_error) {
      const result = stringValue(event.result);
      if (result) {
        return result;
      }
    }
    if (event.type === "assistant") {
      const text = parseClaudeJsonLine(rawLine.trim());
      if (text) {
        summaries.push(text);
      }
    }
  }
  if (summaries.length > 0) {
    return summaries.at(-1) || "";
  }
  return firstNonEmptyLine(stderr);
}

export {
  claudeCommand,
  claudeCommandSpec,
  claudeSessionId,
  parseClaudeFinalMessage,
  parseClaudeSessionIdLine,
  summarizeClaudeFailure,
  summarizeClaudeJsonLine,
};
