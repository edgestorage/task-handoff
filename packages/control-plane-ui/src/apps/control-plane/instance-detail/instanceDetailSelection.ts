export type InstanceDetailSelection =
  | { kind: "app"; sessionKey: string }
  | { aiSessionId: string; kind: "ai" };

const STORAGE_PREFIX = "task-handoff.control-plane.instance-detail-selection:";

export function instanceDetailSelectionStorageKey(instanceId: string) {
  return `${STORAGE_PREFIX}${instanceId}`;
}

export function persistInstanceDetailSelection(instanceId: string, selection: InstanceDetailSelection) {
  try {
    window.localStorage?.setItem(instanceDetailSelectionStorageKey(instanceId), JSON.stringify(selection));
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

export function consumeInstanceDetailSelection(instanceId: string) {
  const key = instanceDetailSelectionStorageKey(instanceId);
  try {
    const value = window.localStorage?.getItem(key);
    if (value != null) window.localStorage?.removeItem(key);
    return parseInstanceDetailSelection(value);
  } catch {
    return undefined;
  }
}

export function parseInstanceDetailSelection(value: string | null | undefined): InstanceDetailSelection | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.kind === "app" && typeof parsed.sessionKey === "string" && parsed.sessionKey.trim()) {
      return { kind: "app", sessionKey: parsed.sessionKey };
    }
    if (parsed.kind === "ai" && typeof parsed.aiSessionId === "string" && parsed.aiSessionId.trim()) {
      return { kind: "ai", aiSessionId: parsed.aiSessionId };
    }
  } catch {
    // Ignore malformed transient UI intent.
  }
  return undefined;
}
