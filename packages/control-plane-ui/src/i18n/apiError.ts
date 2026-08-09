import type { Translate } from "./status.ts";

export type StructuredApiError = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
};

type ErrorDescriptor = {
  key: string;
  detailVariant?: {
    key: string;
    detailKey: string;
    parameter: string;
  };
};

const knownApiErrors: Record<string, ErrorDescriptor> = {
  HTTP_ERROR: { key: "errors.HTTP_ERROR" },
  NOT_FOUND: { key: "errors.NOT_FOUND" },
  UNAUTHORIZED: { key: "errors.UNAUTHORIZED" },
  FORBIDDEN: { key: "errors.FORBIDDEN" },

  AUTH_DISABLED: { key: "errors.AUTH_DISABLED" },
  AUTH_BOOTSTRAP_ALREADY_DONE: { key: "errors.AUTH_BOOTSTRAP_ALREADY_DONE" },
  AUTH_LOGIN_FAILED: { key: "errors.AUTH_LOGIN_FAILED" },
  AUTH_CURRENT_PASSWORD_INVALID: { key: "errors.AUTH_CURRENT_PASSWORD_INVALID" },
  AUTH_PASSWORD_UNCHANGED: { key: "errors.AUTH_PASSWORD_UNCHANGED" },
  AUTH_CREDENTIAL_UPDATE_IN_PROGRESS: { key: "errors.AUTH_CREDENTIAL_UPDATE_IN_PROGRESS" },
  CONTROL_PLANE_AUTH_REQUIRED: { key: "errors.CONTROL_PLANE_AUTH_REQUIRED" },
  CONTROL_PLANE_FORBIDDEN: { key: "errors.CONTROL_PLANE_FORBIDDEN" },

  CONTROLLED_INSTANCE_NOT_FOUND: {
    key: "errors.CONTROLLED_INSTANCE_NOT_FOUND",
    detailVariant: {
      key: "errors.CONTROLLED_INSTANCE_NOT_FOUND_WITH_ID",
      detailKey: "id",
      parameter: "id",
    },
  },
  INSTANCE_NOT_CONNECTED: { key: "errors.INSTANCE_NOT_CONNECTED" },
  INSTANCE_UNREACHABLE: { key: "errors.INSTANCE_UNREACHABLE" },
  INSTANCE_WEB_UNREACHABLE: { key: "errors.INSTANCE_WEB_UNREACHABLE" },
  INSTANCE_APP_MANAGEMENT_UNSUPPORTED: { key: "errors.INSTANCE_APP_MANAGEMENT_UNSUPPORTED" },
  INSTANCE_SOURCE_REQUIRED: { key: "errors.INSTANCE_SOURCE_REQUIRED" },
  INSTANCE_START_FAILED: { key: "errors.INSTANCE_START_FAILED" },
  LOCAL_RUNTIME_REQUIRES_LOCAL_FOLDER: { key: "errors.LOCAL_RUNTIME_REQUIRES_LOCAL_FOLDER" },
  LOCAL_FOLDER_REQUIRES_OWNER_NODE: { key: "errors.LOCAL_FOLDER_REQUIRES_OWNER_NODE" },
  LOCAL_FOLDER_REQUIRES_INSTANCE_NODE: { key: "errors.LOCAL_FOLDER_REQUIRES_INSTANCE_NODE" },
  APP_CWD_REQUIRES_LOCAL_FOLDER_SOURCE: { key: "errors.APP_CWD_REQUIRES_LOCAL_FOLDER_SOURCE" },
  APP_CWD_OUTSIDE_WORKSPACE: { key: "errors.APP_CWD_OUTSIDE_WORKSPACE" },
  RUNTIME_IMAGE_REQUIRED: { key: "errors.RUNTIME_IMAGE_REQUIRED" },
  IMAGE_IN_USE: { key: "errors.IMAGE_IN_USE" },

  MODEL_NOT_FOUND: { key: "errors.MODEL_NOT_FOUND" },
  MODEL_DISABLED: { key: "errors.MODEL_DISABLED" },
  MODEL_APP_MISMATCH: { key: "errors.MODEL_APP_MISMATCH" },

  NODE_OFFLINE: { key: "errors.NODE_OFFLINE" },
  NODE_NOT_FOUND: {
    key: "errors.NODE_NOT_FOUND",
    detailVariant: {
      key: "errors.NODE_NOT_FOUND_WITH_ID",
      detailKey: "nodeId",
      parameter: "id",
    },
  },
  NODE_REQUIRED: { key: "errors.NODE_REQUIRED" },
  NODE_ID_REQUIRED: { key: "errors.NODE_ID_REQUIRED" },
  NODE_AGENT_ENDPOINT_REQUIRED: { key: "errors.NODE_AGENT_ENDPOINT_REQUIRED" },
  NODE_AGENT_HEALTH_FAILED: { key: "errors.NODE_AGENT_HEALTH_FAILED" },
  NODE_AGENT_PAIRING_FAILED: { key: "errors.NODE_AGENT_PAIRING_FAILED" },
  NODE_AGENT_PAIRING_RESPONSE_INVALID: { key: "errors.NODE_AGENT_PAIRING_RESPONSE_INVALID" },
  NODE_AGENT_REMOTE_REQUIRES_PAIRED_HMAC: { key: "errors.NODE_AGENT_REMOTE_REQUIRES_PAIRED_HMAC" },
  NODE_AGENT_REMOTE_SECRET_REQUIRED: { key: "errors.NODE_AGENT_REMOTE_SECRET_REQUIRED" },
  NODE_AGENT_REMOTE_KEY_ID_REQUIRED: { key: "errors.NODE_AGENT_REMOTE_KEY_ID_REQUIRED" },
  NODE_AGENT_REVERSE_TUNNEL_OFFLINE: { key: "errors.NODE_AGENT_REVERSE_TUNNEL_OFFLINE" },
  NODE_JOIN_TOKEN_INVALID: { key: "errors.NODE_JOIN_TOKEN_INVALID" },
  NODE_JOIN_NODE_ALREADY_EXISTS: { key: "errors.NODE_JOIN_NODE_ALREADY_EXISTS" },
  NODE_RUNTIME_NOT_FOUND: { key: "errors.NODE_RUNTIME_NOT_FOUND" },
  NODE_LOCAL_FOLDER_NOT_FOUND: { key: "errors.NODE_LOCAL_FOLDER_NOT_FOUND" },
  LOCAL_NODE_CANNOT_BE_DELETED: { key: "errors.LOCAL_NODE_CANNOT_BE_DELETED" },
  NODE_MODEL_NOT_FOUND: { key: "errors.NODE_MODEL_NOT_FOUND" },
  NODE_MODEL_DISABLED: { key: "errors.NODE_MODEL_DISABLED" },
  NODE_MODEL_APP_MISMATCH: { key: "errors.NODE_MODEL_APP_MISMATCH" },
  NODE_MODEL_SELECTION_MISMATCH: { key: "errors.NODE_MODEL_SELECTION_MISMATCH" },
  NODE_MODEL_HASH_INVALID: { key: "errors.NODE_MODEL_HASH_INVALID" },
  NODE_MODEL_MIGRATION_REQUIRED: { key: "errors.NODE_MODEL_MIGRATION_REQUIRED" },

  AI_SESSION_NOT_FOUND: { key: "errors.AI_SESSION_NOT_FOUND" },
  AI_SESSION_ATTACHMENT_INVALID: { key: "errors.AI_SESSION_ATTACHMENT_INVALID" },
  AI_SESSION_ATTACHMENTS_TOO_LARGE: { key: "errors.AI_SESSION_ATTACHMENTS_TOO_LARGE" },
  AI_SESSION_RUNTIME_PATH_UNSUPPORTED: { key: "errors.AI_SESSION_RUNTIME_PATH_UNSUPPORTED" },
  APP_SESSION_NOT_FOUND: { key: "errors.APP_SESSION_NOT_FOUND" },
  APP_SESSION_DELTA_INVALID: { key: "errors.APP_SESSION_DELTA_INVALID" },

  REPOSITORY_SESSION_NOT_FOUND: { key: "errors.REPOSITORY_SESSION_NOT_FOUND" },
  REPOSITORY_SESSION_INACTIVE: { key: "errors.REPOSITORY_SESSION_INACTIVE" },
  REPOSITORY_CWD_MISSING: { key: "errors.REPOSITORY_CWD_MISSING" },
  REPOSITORY_CWD_INACCESSIBLE: { key: "errors.REPOSITORY_CWD_INACCESSIBLE" },
  REPOSITORY_GIT_UNAVAILABLE: { key: "errors.REPOSITORY_GIT_UNAVAILABLE" },
  REPOSITORY_NOT_WORKTREE: { key: "errors.REPOSITORY_NOT_WORKTREE" },
  REPOSITORY_PATH_INVALID: { key: "errors.REPOSITORY_PATH_INVALID" },
  REPOSITORY_PATH_FORBIDDEN: { key: "errors.REPOSITORY_PATH_FORBIDDEN" },
  REPOSITORY_FILE_NOT_FOUND: { key: "errors.REPOSITORY_FILE_NOT_FOUND" },
  REPOSITORY_FILE_EXISTS: { key: "errors.REPOSITORY_FILE_EXISTS" },
  REPOSITORY_FILE_TOO_LARGE: { key: "errors.REPOSITORY_FILE_TOO_LARGE" },
  REPOSITORY_FILE_BINARY: { key: "errors.REPOSITORY_FILE_BINARY" },
  REPOSITORY_FILE_STALE: { key: "errors.REPOSITORY_FILE_STALE" },
  REPOSITORY_STATE_STALE: { key: "errors.REPOSITORY_STATE_STALE" },
  REPOSITORY_WORKTREE_NOT_FOUND: { key: "errors.REPOSITORY_WORKTREE_NOT_FOUND" },
  REPOSITORY_WORKTREE_OCCUPIED: { key: "errors.REPOSITORY_WORKTREE_OCCUPIED" },
  REPOSITORY_WORKTREE_UNSAFE: { key: "errors.REPOSITORY_WORKTREE_UNSAFE" },
  REPOSITORY_BRANCH_INVALID: { key: "errors.REPOSITORY_BRANCH_INVALID" },
  REPOSITORY_BRANCH_OCCUPIED: { key: "errors.REPOSITORY_BRANCH_OCCUPIED" },
  REPOSITORY_BRANCH_UNMERGED: { key: "errors.REPOSITORY_BRANCH_UNMERGED" },
  REPOSITORY_CONFLICT: { key: "errors.REPOSITORY_CONFLICT" },
  REPOSITORY_DIRTY: { key: "errors.REPOSITORY_DIRTY" },
  REPOSITORY_NOTHING_TO_COMMIT: { key: "errors.REPOSITORY_NOTHING_TO_COMMIT" },
  REPOSITORY_IDENTITY_MISSING: { key: "errors.REPOSITORY_IDENTITY_MISSING" },
  REPOSITORY_HOOK_FAILED: { key: "errors.REPOSITORY_HOOK_FAILED" },
  REPOSITORY_SIGNING_FAILED: { key: "errors.REPOSITORY_SIGNING_FAILED" },
  REPOSITORY_AUTHENTICATION_FAILED: { key: "errors.REPOSITORY_AUTHENTICATION_FAILED" },
  REPOSITORY_NON_FAST_FORWARD: { key: "errors.REPOSITORY_NON_FAST_FORWARD" },
  REPOSITORY_UPSTREAM_MISSING: { key: "errors.REPOSITORY_UPSTREAM_MISSING" },
  REPOSITORY_COMMAND_TIMEOUT: { key: "errors.REPOSITORY_COMMAND_TIMEOUT" },
  REPOSITORY_OUTPUT_LIMIT: { key: "errors.REPOSITORY_OUTPUT_LIMIT" },
  REPOSITORY_OPERATION_ABORTED: { key: "errors.REPOSITORY_OPERATION_ABORTED" },
  REPOSITORY_OPERATION_FAILED: { key: "errors.REPOSITORY_OPERATION_FAILED" },
};

function errorRecord(error: unknown): StructuredApiError {
  return error && typeof error === "object" ? error as StructuredApiError : {};
}

function detailRecord(details: unknown): Record<string, unknown> {
  return details && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : {};
}

function interpolationValue(value: unknown): string | number | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  return undefined;
}

/**
 * Converts an API error into display text without inferring semantics from its
 * natural-language message. ApiError is supported through its structural
 * code/message/details fields, as are decoded API error payloads.
 */
export function translateApiError(error: unknown, t: Translate, fallback?: string) {
  const record = errorRecord(error);
  const code = typeof record.code === "string" ? record.code.trim() : "";
  const descriptor = code ? knownApiErrors[code] : undefined;

  if (descriptor) {
    const variant = descriptor.detailVariant;
    const detail = variant
      ? interpolationValue(detailRecord(record.details)[variant.detailKey])
      : undefined;
    if (variant && detail !== undefined) {
      return t(variant.key, { [variant.parameter]: detail });
    }
    return t(descriptor.key);
  }

  if (typeof record.message === "string" && record.message.trim()) {
    return record.message;
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback;
  }
  return t("errors.unknown");
}
