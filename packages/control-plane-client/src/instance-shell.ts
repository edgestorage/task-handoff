import { INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL } from "@task-handoff/protocol/instance-shell";

/** Shared same-origin route. The caller owns the HTTP-to-WebSocket origin conversion. */
export function controlledInstanceShellRoute(instanceId: string) {
  if (!instanceId.trim()) throw new Error("Instance ID is required.");
  return `/api/controlled-instances/${encodeURIComponent(instanceId)}/shell`;
}

export const CONTROLLED_INSTANCE_SHELL_PROTOCOL = INSTANCE_SHELL_WEBSOCKET_SUBPROTOCOL;
