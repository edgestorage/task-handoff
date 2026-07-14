import path from "node:path";
import { CONFIG_PATH, DEFAULT_SOCKET_PATH } from "@task-handoff/core/core/config";
import { appendJsonl, defaultDiagnosticLogPath, processSnapshot } from "@task-handoff/core/core/diagnostics";
import { loadSettings } from "@task-handoff/core/core/persistence";
import { approvalAutoAllowConversationMatch } from "@task-handoff/core/core/approval-policy";
import { waitForSenderReply } from "@task-handoff/protocol/sender";
import { identitiesFromMessage, sessionIdsForApprovalHook } from "@task-handoff/receiver-worker/state/binding-identities";
import { conversationIdForIdentities } from "@task-handoff/receiver-worker/state/conversation-bindings";

const APPROVAL_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const APPROVAL_TIMEOUT_REPLY = "deny";
const APPROVE = new Set(["allow", "approve", "approved", "yes", "y", "ok", "允许", "同意", "批准"]);
const DENY = new Set(["deny", "denied", "no", "n", "reject", "rejected", "拒绝", "不同意"]);
const SKIP = new Set(["skip", "skipped", "pass", "fallback", "continue", "跳过", "略过"]);

type CodexApprovalHookOptions = {
  socketPath?: string;
  timeoutMs?: number;
  conversationId?: number;
};

type ApprovalConversationCandidate = readonly [string, number | undefined];

function readStdin() {
  return new Promise<string>((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
  });
}

function compact(value: unknown, fallback = "") {
  return String(value ?? fallback).replace(/\s+/g, " ").trim();
}

function stringifyCompact(value: unknown) {
  try {
    return compact(JSON.stringify(value));
  } catch {
    return compact(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function formatPermissionRule(rule: unknown): string {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    return compact(rule);
  }
  const entry = asRecord(rule);
  const toolName = compact(entry.toolName || entry.tool_name || entry.tool || entry.name);
  const ruleContent = compact(entry.ruleContent || entry.rule_content || entry.content || entry.matcher);
  if (toolName && ruleContent) {
    return `${toolName}(${ruleContent})`;
  }
  return toolName || ruleContent || stringifyCompact(rule);
}

function formatPermissionEntry(entry: unknown): string {
  if (Array.isArray(entry)) {
    return entry.map(formatPermissionEntry).filter(Boolean).join(", ");
  }
  if (!entry || typeof entry !== "object") {
    return compact(entry);
  }

  const value = asRecord(entry);
  const behavior = compact(value.behavior);
  const destination = compact(value.destination);
  const mode = compact(value.mode);
  const directories = Array.isArray(value.directories)
    ? value.directories.map((directory) => compact(directory)).filter(Boolean).join(", ")
    : "";
  const rules = Array.isArray(value.rules) ? value.rules.map(formatPermissionRule).filter(Boolean).join(", ") : "";
  const action = compact(value.type || value.action || value.kind);
  const details = [behavior, mode, directories, rules].filter(Boolean).join(" ");
  if (action && details && destination) {
    return `${action} ${details} -> ${destination}`;
  }
  if (action && details) {
    return `${action} ${details}`;
  }
  return stringifyCompact(entry);
}

function formatPermissionValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.map(formatPermissionEntry).filter(Boolean).join("; ");
  }
  return formatPermissionEntry(value);
}

function pick(obj: unknown, paths: string[][]) {
  for (const parts of paths) {
    let current: unknown = obj;
    for (const part of parts) {
      current = asRecord(current)[part];
    }
    if (current !== undefined && current !== null && String(current).trim() !== "") {
      return current;
    }
  }
  return undefined;
}

function formatApprovalRequest(event: unknown) {
  const eventRecord = asRecord(event);
  const params = eventRecord.params || event;
  const command = pick(params, [
    ["command"],
    ["tool_input", "command"],
    ["input", "command"],
    ["arguments", "cmd"],
    ["arguments", "command"],
  ]);
  const cwd = pick(params, [["cwd"], ["tool_input", "cwd"], ["input", "cwd"], ["arguments", "cwd"]]);
  const justification = pick(params, [
    ["justification"],
    ["reason"],
    ["description"],
    ["tool_input", "justification"],
    ["tool_input", "description"],
    ["input", "justification"],
    ["input", "description"],
    ["arguments", "justification"],
    ["arguments", "description"],
  ]);
  const permissions = pick(params, [["permissions"], ["permission"], ["sandbox_permissions"], ["requested_permissions"]]);
  const permissionSuggestions = pick(params, [
    ["permission_suggestions"],
    ["permissionSuggestions"],
    ["tool_input", "permission_suggestions"],
    ["tool_input", "permissionSuggestions"],
    ["input", "permission_suggestions"],
    ["input", "permissionSuggestions"],
    ["arguments", "permission_suggestions"],
    ["arguments", "permissionSuggestions"],
  ]);
  const toolName = pick(params, [["tool_name"], ["toolName"], ["tool"], ["name"]]);
  const formattedPermissions = permissions === undefined ? "" : formatPermissionValue(permissions);
  const formattedPermissionSuggestions =
    permissionSuggestions === undefined ? "" : formatPermissionValue(permissionSuggestions);

  return [
    "权限请求审批：",
    "",
    toolName ? `工具：${compact(toolName)}` : undefined,
    formattedPermissions ? `权限：${formattedPermissions}` : undefined,
    formattedPermissionSuggestions ? `权限建议：${formattedPermissionSuggestions}` : undefined,
    cwd ? `目录：${compact(cwd)}` : undefined,
    command ? `命令：${compact(command)}` : undefined,
    justification ? `原因：${compact(justification)}` : undefined,
    "",
    "回复 allow/approve/yes/允许 以允许；回复 deny/no/拒绝 以拒绝；回复 skip/跳过 以交回 Codex 自己处理。",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseConversationId(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    return undefined;
  }
  return id;
}

function normalizeCwd(value: unknown) {
  const cwd = compact(value);
  return cwd ? path.resolve(cwd) : undefined;
}

function parseDecision(reply: string) {
  const value = compact(reply).toLowerCase();
  if (APPROVE.has(value)) {
    return "allow";
  }
  if (DENY.has(value)) {
    return "deny";
  }
  if (SKIP.has(value)) {
    return "skip";
  }
  return undefined;
}

function logHook(event: string, details: Record<string, unknown> = {}) {
  const entry = {
    time: new Date().toISOString(),
    event,
    process: processSnapshot(),
    ...details,
  };
  const line = JSON.stringify(entry);
  const logPath =
    process.env.TASK_HANDOFF_APPROVAL_LOG || defaultDiagnosticLogPath(CONFIG_PATH, "codex-approval-hook.log");
  try {
    appendJsonl(logPath, { event, process: entry.process, ...details });
  } catch (error) {
    process.stderr.write(`codex approval hook log failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.stderr.write(`${line}\n`);
}

function writeDecision(decision?: "allow" | "deny" | "skip", reason?: string) {
  if (!decision || decision === "skip") {
    process.stdout.write("{}\n");
    return;
  }

  const output: {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest";
      decision: {
        behavior: "allow" | "deny";
        message?: string;
      };
    };
  } = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: decision,
      },
    },
  };
  if (reason) {
    output.hookSpecificOutput.decision.message = reason;
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function resolveApprovalConversation(candidates: readonly ApprovalConversationCandidate[]) {
  return candidates.find(([, value]) => value !== undefined);
}

export async function runCodexApprovalHook(options: CodexApprovalHookOptions = {}) {
  try {
    const raw = await readStdin();
    const event = raw.trim() ? JSON.parse(raw) : {};
    const eventRecord = asRecord(event);
    const params = eventRecord.params || event;
    const eventCwd = pick(params, [["cwd"], ["tool_input", "cwd"], ["input", "cwd"], ["arguments", "cwd"]]);
    const codexId =
      pick(params, [["session_id"], ["sessionId"], ["thread_id"], ["threadId"], ["thread", "id"]]) ||
      eventRecord.session_id ||
      eventRecord.sessionId ||
      eventRecord.thread_id ||
      eventRecord.threadId ||
      process.env.CODEX_THREAD_ID;
    const claudeSessionId = pick(params, [
      ["claude_session_id"],
      ["claudeSessionId"],
      ["session", "id"],
    ]) || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDECODE_SESSION_ID;
    const terminalSessionId =
      pick(params, [["terminal_session_id"], ["terminalSessionId"]]) || process.env.TERM_SESSION_ID;
    const settings = loadSettings();
    const sessionIds = sessionIdsForApprovalHook({ codexId, claudeSessionId, terminalSessionId });
    const cwd = normalizeCwd(eventCwd) || process.cwd();
    const identities = identitiesFromMessage({ sessionIds });
    const candidates = [
      ["option", options.conversationId],
      ["bindings", conversationIdForIdentities(settings, identities)],
      ["hook_payload", parseConversationId(pick(params, [["conversationId"], ["conversation_id"], ["conversation", "id"]]))],
    ] as const;
    const resolvedConversation = resolveApprovalConversation(candidates);
    if (!resolvedConversation) {
      logHook("skip_unmatched", {
        cwd,
        codexId,
        claudeSessionId,
        terminalSessionId,
        transcriptPath: pick(params, [["transcript_path"], ["transcriptPath"]]),
        hookEventName: event.hook_event_name || event.hookEventName || "PermissionRequest",
        toolName: pick(params, [["tool_name"], ["toolName"], ["tool"], ["name"]]),
      });
      writeDecision("skip");
      return;
    }
    const [conversationSource, conversationId] = resolvedConversation;
    const autoAllowConversation = approvalAutoAllowConversationMatch(conversationId, settings);
    if (autoAllowConversation) {
      logHook("auto_allow", {
        conversationId,
        conversationSource,
        key: `conversation:${autoAllowConversation.key}`,
        cwd,
        codexId,
        claudeSessionId,
        terminalSessionId,
        transcriptPath: pick(params, [["transcript_path"], ["transcriptPath"]]),
        hookEventName: event.hook_event_name || event.hookEventName || "PermissionRequest",
        toolName: pick(params, [["tool_name"], ["toolName"], ["tool"], ["name"]]),
      });
      writeDecision("allow");
      return;
    }
    logHook("request", {
      conversationId,
      conversationSource,
      cwd,
      codexId,
      claudeSessionId,
      terminalSessionId,
      transcriptPath: pick(params, [["transcript_path"], ["transcriptPath"]]),
      terminalApp: pick(params, [["terminal_app"], ["terminalApp"]]),
      terminalTTY: pick(params, [["terminal_tty"], ["terminalTTY"]]),
      hookEventName: event.hook_event_name || event.hookEventName || "PermissionRequest",
      toolName: pick(params, [["tool_name"], ["toolName"], ["tool"], ["name"]]),
    });
    const reply = process.env.TASK_HANDOFF_APPROVAL_REPLY
      ? process.env.TASK_HANDOFF_APPROVAL_REPLY
      : await waitForSenderReply({
          result: formatApprovalRequest(event),
          socketPath: options.socketPath || DEFAULT_SOCKET_PATH,
          conversationId,
          timeoutMs: options.timeoutMs || Number(process.env.TASK_HANDOFF_APPROVAL_TIMEOUT) || APPROVAL_TIMEOUT_MS,
          timeoutOverridden: true,
          kind: "approval",
          cwd,
          sessionIds,
          timeoutReply: APPROVAL_TIMEOUT_REPLY,
        });
    const decision = parseDecision(reply);
    logHook("reply", {
      conversationId,
      decision: decision || "undecided",
      reply: compact(reply),
    });
    writeDecision(decision, decision === "deny" ? "Denied by task-handoff approval reply." : undefined);
  } catch (error) {
    logHook("error", { message: error instanceof Error ? error.message : String(error) });
    writeDecision(undefined);
  }
}

export { APPROVAL_TIMEOUT_MS, APPROVAL_TIMEOUT_REPLY, resolveApprovalConversation, sessionIdsForApprovalHook };
