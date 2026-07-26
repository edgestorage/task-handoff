import { computed, reactive, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { AiSessionPermissionMode } from "@task-handoff/protocol/ai-sessions";

const AI_SESSION_PERMISSION_STORAGE_KEY = "task-handoff.control-plane.ai-session-permissions";
export const AI_SESSION_PERMISSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

type StoredPermission = {
  permissionMode: AiSessionPermissionMode;
  updatedAt: number;
};

const sharedModes = reactive<Record<string, AiSessionPermissionMode>>({});
const initializedKeys = new Set<string>();

export function aiSessionPermissionKey(instanceId: string, sessionId: string) {
  return `session:${encodeURIComponent(instanceId)}:${encodeURIComponent(sessionId)}`;
}

export function historyAiSessionPermissionKey(instanceId: string, historyId: string) {
  return `history:${encodeURIComponent(instanceId)}:${encodeURIComponent(historyId)}`;
}

export function loadAiSessionPermissionMode(key: string, now = Date.now()) {
  return readPermissions(now)[key]?.permissionMode;
}

export function persistAiSessionPermissionMode(key: string, permissionMode: AiSessionPermissionMode, now = Date.now()) {
  if (!key.trim()) return;
  sharedModes[key] = permissionMode;
  initializedKeys.add(key);
  const target = storage();
  if (!target) return;
  const permissions = readPermissions(now, target);
  permissions[key] = { permissionMode, updatedAt: now };
  writePermissions(target, permissions);
}

export function clearAiSessionPermissionMode(key: string, now = Date.now()) {
  if (!key.trim()) return;
  delete sharedModes[key];
  initializedKeys.delete(key);
  const target = storage();
  if (!target) return;
  const permissions = readPermissions(now, target);
  delete permissions[key];
  writePermissions(target, permissions);
}

export function useAiSessionPermissionMode(
  keyInput: MaybeRefOrGetter<string>,
  defaultInput: MaybeRefOrGetter<AiSessionPermissionMode>,
) {
  const key = computed(() => toValue(keyInput).trim());
  const defaultMode = computed(() => toValue(defaultInput));

  watch([key, defaultMode], ([nextKey, nextDefault]) => {
    if (!nextKey || initializedKeys.has(nextKey)) return;
    const stored = loadAiSessionPermissionMode(nextKey);
    persistAiSessionPermissionMode(nextKey, stored || nextDefault);
  }, { immediate: true });

  return computed<AiSessionPermissionMode>({
    get: () => sharedModes[key.value] || defaultMode.value,
    set: (value) => persistAiSessionPermissionMode(key.value, value),
  });
}

function storage() {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readPermissions(now: number, target = storage()) {
  if (!target) return {} as Record<string, StoredPermission>;
  let parsed: unknown;
  try {
    parsed = JSON.parse(target.getItem(AI_SESSION_PERMISSION_STORAGE_KEY) || "{}");
  } catch {
    removePermissions(target);
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    removePermissions(target);
    return {};
  }
  const valid: Record<string, StoredPermission> = {};
  let changed = false;
  for (const [key, entry] of Object.entries(parsed)) {
    const record = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Partial<StoredPermission> : undefined;
    if (!record || !isPermissionMode(record.permissionMode) || !Number.isFinite(record.updatedAt) || now - record.updatedAt >= AI_SESSION_PERMISSION_TTL_MS) {
      changed = true;
      continue;
    }
    valid[key] = { permissionMode: record.permissionMode, updatedAt: record.updatedAt };
  }
  if (changed) writePermissions(target, valid);
  return valid;
}

function writePermissions(target: Storage, permissions: Record<string, StoredPermission>) {
  try {
    if (Object.keys(permissions).length) target.setItem(AI_SESSION_PERMISSION_STORAGE_KEY, JSON.stringify(permissions));
    else target.removeItem(AI_SESSION_PERMISSION_STORAGE_KEY);
  } catch {
    // Storage may be unavailable or full; the shared in-memory state remains usable.
  }
}

function removePermissions(target: Storage) {
  try {
    target.removeItem(AI_SESSION_PERMISSION_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }
}

function isPermissionMode(value: unknown): value is AiSessionPermissionMode {
  return value === "ask" || value === "auto-review" || value === "full-access";
}
