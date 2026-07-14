import { identitiesFromMessage, ownerKeysFromIdentities } from "./binding-identities";

const CONVERSATION_ACTIVE_MS = 12 * 60 * 60 * 1000;

type ConversationActivityEntry = {
  source?: string;
  activatedAt?: string;
  ownerKeys?: string[];
};

type ConversationActivity = Record<string, ConversationActivityEntry>;
type SettingsWithActivity = {
  conversationActivity?: Record<string, ConversationActivityEntry | undefined>;
};

function parseActivatedAt(value: unknown) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : undefined;
}

function normalizeConversationActivity(settings: SettingsWithActivity = {}): ConversationActivity {
  const raw = settings.conversationActivity;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const normalized: ConversationActivity = {};
  for (const [conversationId, entry] of Object.entries(raw)) {
    if (!entry) {
      continue;
    }
    const activatedAt = parseActivatedAt(entry.activatedAt);
    if (activatedAt) {
      normalized[conversationId] = {
        source: String(entry.source || ""),
        activatedAt: new Date(activatedAt).toISOString(),
        ownerKeys: normalizeOwnerKeys(entry),
      };
    }
  }
  return normalized;
}

function cleanOwnerKey(value: unknown) {
  const key = String(value || "").trim();
  return key || undefined;
}

function normalizeOwnerKeys(entry: ConversationActivityEntry) {
  const keys = new Set<string>();
  for (const key of Array.isArray(entry.ownerKeys) ? entry.ownerKeys : []) {
    const clean = cleanOwnerKey(key);
    if (clean) {
      keys.add(clean);
    }
  }
  return [...keys];
}

function isConversationActive(activity: ConversationActivity, conversationId: number, now = Date.now()) {
  const entry = activity[String(conversationId)];
  const activatedAt = parseActivatedAt(entry?.activatedAt);
  return activatedAt !== undefined && now - activatedAt < CONVERSATION_ACTIVE_MS;
}

function isConversationActivityExpired(activity: ConversationActivity, conversationId: number, now = Date.now()) {
  const entry = activity[String(conversationId)];
  const activatedAt = parseActivatedAt(entry?.activatedAt);
  return activatedAt !== undefined && now - activatedAt >= CONVERSATION_ACTIVE_MS;
}

function ownerKeysFromMessage(message: Record<string, unknown>) {
  return ownerKeysFromIdentities(identitiesFromMessage(message), message?.source);
}

function shouldAssignNewConversation(
  activity: ConversationActivity,
  conversationId: number,
  ownerKeys: string[] | string,
  now = Date.now(),
) {
  if (!isConversationActive(activity, conversationId, now)) {
    return false;
  }
  const incomingKeys = new Set(Array.isArray(ownerKeys) ? ownerKeys : [ownerKeys].filter(Boolean));
  const activeKeys = normalizeOwnerKeys(activity[String(conversationId)] || {});
  if (incomingKeys.size === 0 || activeKeys.length === 0) {
    return true;
  }
  return !activeKeys.some((key) => incomingKeys.has(key));
}

function markConversationActive(
  activity: ConversationActivity,
  conversationId: number,
  source: string,
  ownerKeys: string[] | string,
  now = Date.now(),
) {
  const normalizedOwnerKeys = Array.isArray(ownerKeys) ? ownerKeys : [ownerKeys].filter(Boolean);
  const mergedOwnerKeys = [
    ...new Set([...normalizeOwnerKeys(activity[String(conversationId)] || {}), ...normalizedOwnerKeys]),
  ];
  activity[String(conversationId)] = {
    source,
    ownerKeys: mergedOwnerKeys,
    activatedAt: new Date(now).toISOString(),
  };
  return activity;
}

export {
  CONVERSATION_ACTIVE_MS,
  isConversationActive,
  isConversationActivityExpired,
  markConversationActive,
  normalizeConversationActivity,
  ownerKeysFromMessage,
  shouldAssignNewConversation,
};

export type { ConversationActivity };
