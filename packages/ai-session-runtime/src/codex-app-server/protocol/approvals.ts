import type { AiSessionApprovalDecision } from "../../ai-session-control";
import type { CodexApprovalRequest, JsonValue } from "./types";
import { asRecord, stringField } from "./values";

export function codexApprovalRequest(
  id: number,
  method: string,
  params: JsonValue,
): CodexApprovalRequest | undefined {
  if (method === "item/commandExecution/requestApproval") {
    const threadId = stringField(params, "threadId");
    if (!threadId) {
      return undefined;
    }
    const command = stringField(params, "command");
    const reason = stringField(params, "reason");
    return {
      id,
      method,
      kind: "command",
      threadId,
      turnId: stringField(params, "turnId"),
      itemId: stringField(params, "itemId"),
      summary: [reason, command ? `Command: ${command}` : undefined]
        .filter(Boolean)
        .join(" · ") || "Codex is requesting command approval.",
      params,
    };
  }

  if (method === "item/fileChange/requestApproval") {
    const threadId = stringField(params, "threadId");
    if (!threadId) {
      return undefined;
    }
    const grantRoot = stringField(params, "grantRoot");
    return {
      id,
      method,
      kind: "file-change",
      threadId,
      turnId: stringField(params, "turnId"),
      itemId: stringField(params, "itemId"),
      summary: stringField(params, "reason")
        || (grantRoot
          ? `Approve file changes under ${grantRoot}`
          : "Codex is requesting file change approval."),
      params,
    };
  }

  if (method === "item/permissions/requestApproval") {
    const threadId = stringField(params, "threadId");
    if (!threadId) {
      return undefined;
    }
    return {
      id,
      method,
      kind: "permissions",
      threadId,
      turnId: stringField(params, "turnId"),
      itemId: stringField(params, "itemId"),
      summary: stringField(params, "reason")
        || "Codex is requesting additional permissions.",
      params,
    };
  }

  return undefined;
}

export function approvalResponseForRequest(
  request: CodexApprovalRequest,
  decision: AiSessionApprovalDecision,
): JsonValue {
  if (request.kind === "command") {
    return {
      decision: decision === "allow"
        ? "accept"
        : decision === "skip"
          ? "cancel"
          : "decline",
    };
  }
  if (request.kind === "file-change") {
    return {
      decision: decision === "allow"
        ? "accept"
        : decision === "skip"
          ? "cancel"
          : "decline",
    };
  }
  if (decision !== "allow") {
    return { permissions: {}, scope: "turn" };
  }

  const requested = asRecord(request.params.permissions);
  const fileSystem = asRecord(requested.fileSystem);
  return {
    permissions: {
      ...(requested.network ? { network: requested.network } : {}),
      ...(Object.keys(fileSystem).length
        ? {
            fileSystem: {
              ...(Array.isArray(fileSystem.read) ? { read: fileSystem.read } : {}),
              ...(Array.isArray(fileSystem.write) ? { write: fileSystem.write } : {}),
              ...(Array.isArray(fileSystem.entries) ? { entries: fileSystem.entries } : {}),
              ...(fileSystem.globScanMaxDepth
                ? { globScanMaxDepth: fileSystem.globScanMaxDepth }
                : {}),
            },
          }
        : {}),
    },
    scope: "turn",
  };
}

export function approvalDecisionVerb(decision: AiSessionApprovalDecision) {
  if (decision === "allow") {
    return "allowed";
  }
  if (decision === "deny") {
    return "denied";
  }
  return "skipped";
}
