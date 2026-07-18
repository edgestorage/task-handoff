const AI_SESSION_DRAFT_STORAGE_KEY = "task-handoff.control-plane.ai-session-drafts";
export const AI_SESSION_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

type StoredDraft = {
  value: string;
  updatedAt: number;
};

type StoredDrafts = Record<string, StoredDraft>;

function removeStoredDrafts(target: Storage) {
  try {
    target.removeItem(AI_SESSION_DRAFT_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }
}

function storage() {
  if (typeof window === "undefined") {
    return undefined;
  }
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readDrafts(now: number, target = storage()): StoredDrafts {
  if (!target) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(target.getItem(AI_SESSION_DRAFT_STORAGE_KEY) || "{}");
  } catch {
    removeStoredDrafts(target);
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    removeStoredDrafts(target);
    return {};
  }
  const valid: StoredDrafts = {};
  let changed = false;
  for (const [sessionId, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      changed = true;
      continue;
    }
    const record = entry as Partial<StoredDraft>;
    if (typeof record.value !== "string" || !Number.isFinite(record.updatedAt)) {
      changed = true;
      continue;
    }
    if (now - record.updatedAt >= AI_SESSION_DRAFT_TTL_MS) {
      changed = true;
      continue;
    }
    valid[sessionId] = { value: record.value, updatedAt: record.updatedAt };
  }
  if (changed) {
    try {
      if (Object.keys(valid).length) {
        target.setItem(AI_SESSION_DRAFT_STORAGE_KEY, JSON.stringify(valid));
      } else {
        target.removeItem(AI_SESSION_DRAFT_STORAGE_KEY);
      }
    } catch {
      // Storage may be unavailable or full; the in-memory draft remains usable.
    }
  }
  return valid;
}

export function loadAiSessionDraft(sessionId: string, now = Date.now()) {
  if (!sessionId.trim()) {
    return "";
  }
  return readDrafts(now)[sessionId]?.value || "";
}

export function persistAiSessionDraft(sessionId: string, value: string, now = Date.now()) {
  if (!sessionId.trim()) {
    return;
  }
  const target = storage();
  if (!target) {
    return;
  }
  const drafts = readDrafts(now, target);
  if (!value) {
    delete drafts[sessionId];
  } else {
    drafts[sessionId] = { value, updatedAt: now };
  }
  try {
    if (Object.keys(drafts).length) {
      target.setItem(AI_SESSION_DRAFT_STORAGE_KEY, JSON.stringify(drafts));
    } else {
      target.removeItem(AI_SESSION_DRAFT_STORAGE_KEY);
    }
  } catch {
    // Storage may be unavailable or full; the in-memory draft remains usable.
  }
}

export function clearAiSessionDraft(sessionId: string) {
  persistAiSessionDraft(sessionId, "");
}
