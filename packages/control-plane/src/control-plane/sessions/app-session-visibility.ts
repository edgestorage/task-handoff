import { normalizeAppSessionStatus } from "@task-handoff/protocol/app-sessions";

const HIDDEN_APP_SESSION_STATUSES = new Set(["stopped", "failed", "exited", "closed", "terminated"]);

export function isHiddenAppSessionStatus(status: string | undefined) {
  return HIDDEN_APP_SESSION_STATUSES.has(normalizeAppSessionStatus(status));
}

export function isVisibleAppSessionStatus(status: string | undefined) {
  return !isHiddenAppSessionStatus(status);
}
