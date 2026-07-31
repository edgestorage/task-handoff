const ACTIVE_UPDATE_STATUSES = new Set([
  "queued",
  "updating-node",
  "restarting-node",
  "converging-instances",
]);

const TERMINAL_UPDATE_STATUSES = new Set([
  "succeeded",
  "degraded",
  "failed",
]);

export function isActiveNodeUpdate(status?: string) {
  return Boolean(status && ACTIVE_UPDATE_STATUSES.has(status));
}

export function isTerminalNodeUpdate(status?: string) {
  return Boolean(status && TERMINAL_UPDATE_STATUSES.has(status));
}

export async function refreshNodeUpdateHttpState(input: {
  status?: string;
  refreshRuntimeState: () => Promise<void>;
  refreshTopology: () => Promise<void>;
}) {
  if (isActiveNodeUpdate(input.status)) await input.refreshRuntimeState();
  if (isTerminalNodeUpdate(input.status)) await input.refreshTopology();
}
