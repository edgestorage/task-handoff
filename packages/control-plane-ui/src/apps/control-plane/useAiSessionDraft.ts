import { AiSessionReferenceSchema } from "@task-handoff/protocol/ai-sessions";
export { AI_SESSION_ATTACHMENT_ONLY_MESSAGE, aiSessionMessageText } from "@task-handoff/control-plane-client";
import type { AiSessionMentionBinding } from "../../components/ai-session/mentions";

const AI_SESSION_DRAFT_STORAGE_KEY = "task-handoff.control-plane.ai-session-drafts";
export const AI_SESSION_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export function aiSessionCreationDraftKey(instanceId: string) {
  return `new-session:${instanceId}`;
}

type StoredDraft = {
  value: string;
  bindings: AiSessionMentionBinding[];
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
    const record = entry as Partial<StoredDraft> & { references?: unknown };
    if (typeof record.value !== "string" || !Number.isFinite(record.updatedAt)) {
      changed = true;
      continue;
    }
    if (now - record.updatedAt >= AI_SESSION_DRAFT_TTL_MS) {
      changed = true;
      continue;
    }
    const rawBindings = Array.isArray(record.bindings) ? record.bindings : [];
    const bindings = rawBindings.flatMap(parseBinding).slice(0, 20);
    if (bindings.length !== rawBindings.length || Array.isArray(record.references)) changed = true;
    valid[sessionId] = { value: record.value, bindings, updatedAt: record.updatedAt };
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

export function loadAiSessionDraftPayload(sessionId: string, now = Date.now()) {
  if (!sessionId.trim()) return { value: "", bindings: [] as AiSessionMentionBinding[] };
  const draft = readDrafts(now)[sessionId];
  return draft ? { value: draft.value, bindings: draft.bindings } : { value: "", bindings: [] as AiSessionMentionBinding[] };
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
    drafts[sessionId] = { value, bindings: drafts[sessionId]?.bindings || [], updatedAt: now };
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

export function persistAiSessionDraftPayload(sessionId: string, value: string, bindings: AiSessionMentionBinding[], now = Date.now()) {
  if (!sessionId.trim()) return;
  const target = storage();
  if (!target) return;
  const drafts = readDrafts(now, target);
  if (!value && !bindings.length) {
    delete drafts[sessionId];
  } else {
    drafts[sessionId] = {
      value,
      bindings: bindings.flatMap(parseBinding).slice(0, 20),
      updatedAt: now,
    };
  }
  try {
    if (Object.keys(drafts).length) target.setItem(AI_SESSION_DRAFT_STORAGE_KEY, JSON.stringify(drafts));
    else target.removeItem(AI_SESSION_DRAFT_STORAGE_KEY);
  } catch {
    // Storage may be unavailable or full; the in-memory draft remains usable.
  }
}

export function clearAiSessionDraft(sessionId: string) {
  persistAiSessionDraftPayload(sessionId, "", []);
}

function parseBinding(value: unknown): AiSessionMentionBinding[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const binding = value as Partial<AiSessionMentionBinding>;
  const reference = AiSessionReferenceSchema.safeParse(binding.reference);
  if (!reference.success || typeof binding.id !== "string" || typeof binding.token !== "string"
    || !Number.isInteger(binding.start) || !Number.isInteger(binding.end)
    || (binding.start as number) < 0 || (binding.end as number) <= (binding.start as number)) return [];
  return [{
    id: binding.id,
    token: binding.token,
    start: binding.start as number,
    end: binding.end as number,
    reference: reference.data,
  }];
}
