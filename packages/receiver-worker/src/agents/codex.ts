import fs from "node:fs";
import { assistantJsonlText, findStringByKeys, firstNonEmptyLine, parseJsonLine, stringValue } from "./shared";
import type { ActiveAgentCommandOptions, ActiveAgentCommandSpec } from "./types";

function codexCommand(env: NodeJS.ProcessEnv = process.env) {
  if (env.TASK_HANDOFF_CODEX_COMMAND) {
    return env.TASK_HANDOFF_CODEX_COMMAND;
  }
  if (env.CODEX_CLI_PATH) {
    return env.CODEX_CLI_PATH;
  }
  const appCommand = "/Applications/Codex.app/Contents/Resources/codex";
  return fs.existsSync(appCommand) ? appCommand : "codex";
}

function codexCommandSpec({
  cwd = process.cwd(),
  env = process.env,
  outputPath,
  sessionId,
}: ActiveAgentCommandOptions): ActiveAgentCommandSpec {
  const model = String(env.TASK_HANDOFF_CODEX_MODEL || env.CODEX_MODEL || "").trim();
  const modelArgs = model ? ["--model", model] : [];
  if (sessionId) {
    return {
      command: codexCommand(env),
      args: ["exec", "resume", ...modelArgs, "--json", "-o", outputPath, sessionId, "-"],
      stdin: true,
    };
  }
  return {
    command: codexCommand(env),
    args: ["exec", ...modelArgs, "--json", "--cd", cwd, "-o", outputPath, "-"],
    stdin: true,
  };
}

function parseCodexJsonLine(line: string) {
  const event = parseJsonLine(line);
  if (!event) {
    return undefined;
  }
  if (event?.msg?.type === "agent_message" && typeof event.msg.message === "string") {
    return event.msg.message;
  }
  if (event?.type === "agent_message" && typeof event.message === "string") {
    return event.message;
  }
  if (event?.type === "message" && typeof event.message === "string") {
    return event.message;
  }
  if (event?.type === "assistant") {
    return assistantJsonlText(event);
  }
  return findStringByKeys(event, ["message", "content", "text", "last_message", "lastMessage", "response", "result"]) || undefined;
}

function summarizeCodexJsonLine(line: string) {
  const event = parseJsonLine(line);
  if (!event) {
    return undefined;
  }
  if (event.type === "thread.started") {
    const id = stringValue(event.thread_id);
    return id ? `Codex session ${id} started` : "Codex session started";
  }
  if (event.type === "turn.failed") {
    const message = stringValue(event.error?.message);
    return message ? `Codex failed: ${message}` : "Codex turn failed";
  }
  if (event.type === "result") {
    const text = stringValue(event.result);
    return text ? `Codex result: ${text}` : undefined;
  }
  if (event.type === "assistant") {
    const text = assistantJsonlText(event);
    return text ? `Codex: ${text}` : undefined;
  }
  if (event.type === "response_item" && event.payload?.type === "function_call") {
    const name = [event.payload.namespace, event.payload.name].filter(Boolean).join(".");
    return name ? `Tool: ${name}` : undefined;
  }
  if (event.type === "event_msg" && event.payload?.type === "mcp_tool_call_end") {
    const invocation = event.payload.invocation;
    const name = [invocation?.server, invocation?.tool].filter(Boolean).join(".");
    return name ? `Tool done: ${name}` : undefined;
  }
  return undefined;
}

function parseCodexSessionIdLine(line: string) {
  const event = parseJsonLine(line);
  if (!event) {
    return undefined;
  }
  if (event.type === "thread.started") {
    const id = stringValue(event.thread_id);
    if (id) {
      return id;
    }
  }
  const payload = event?.payload || event?.msg || event;
  const id =
    (event?.type === "session_meta" && payload?.id) ||
    payload?.session_id ||
    payload?.sessionId ||
    payload?.thread_id ||
    payload?.threadId;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function codexSessionId(output: string) {
  return output
    .split(/\r?\n/)
    .map(parseCodexSessionIdLine)
    .find((id): id is string => Boolean(id));
}

function lastCodexMessage(output: string) {
  const messages = output
    .split(/\r?\n/)
    .map(parseCodexJsonLine)
    .filter((message): message is string => Boolean(message?.trim()));
  return messages.at(-1);
}

function parseCodexFinalMessage(outputJsonl: string) {
  const messages = outputJsonl
    .split(/\r?\n/)
    .map(parseCodexJsonLine)
    .filter((message): message is string => Boolean(message?.trim()));
  return messages.at(-1) || "";
}

function summarizeCodexFailure(outputJsonl: string, stderr: string) {
  for (const rawLine of outputJsonl.split(/\r?\n/)) {
    const event = parseJsonLine(rawLine.trim());
    if (!event) {
      continue;
    }
    if (event.type === "turn.failed") {
      const message = stringValue(event.error?.message);
      if (message) {
        return message;
      }
    }
    if (event.type === "result") {
      const result = stringValue(event.result);
      if (result) {
        return event.api_error_status ? `API Error ${event.api_error_status}: ${result}` : result;
      }
    }
  }
  return firstNonEmptyLine(stderr);
}

export {
  codexCommand,
  codexCommandSpec,
  codexSessionId,
  lastCodexMessage,
  parseCodexFinalMessage,
  parseCodexSessionIdLine,
  summarizeCodexFailure,
  summarizeCodexJsonLine,
};
