import type { ControlPlaneCurrentAuthorization } from "@task-handoff/protocol/control-plane-access";

export function authorizationCacheEpoch(access: ControlPlaneCurrentAuthorization | undefined) {
  return access ? `${access.userId}:${access.authorizationRevision}` : "";
}

export function authorizationCacheEpochChanged(previous: string, current: string) {
  return Boolean(previous && current && previous !== current);
}

export function preserveAcrossAuthorizationChange(queryKey: readonly unknown[]) {
  return ["auth-session", "control-plane-current-access"].includes(String(queryKey[0] || ""));
}
