import { loadSettings, patchSettings, type Settings } from "./persistence";

type ApprovalAutoAllowEntry = {
  enabled?: boolean;
  updatedAt?: string;
  source?: string;
};

type ApprovalPolicySettings = {
  autoAllowConversations?: Record<string, ApprovalAutoAllowEntry | undefined>;
};

function compact(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function approvalPolicy(settings: Settings = loadSettings()): ApprovalPolicySettings {
  const raw = settings.approvalPolicy;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as ApprovalPolicySettings) : {};
}

function approvalAutoAllowConversationMatch(conversationId: unknown, settings: Settings = loadSettings()) {
  const key = compact(conversationId);
  if (!key) {
    return undefined;
  }
  const entry = approvalPolicy(settings).autoAllowConversations?.[key];
  return entry?.enabled ? { key, entry } : undefined;
}

function setApprovalAutoAllowConversation(conversationId: number, enabled: boolean, source = "receiver") {
  const key = String(conversationId);
  const policy = approvalPolicy();
  const autoAllowConversations = {
    ...(policy.autoAllowConversations || {}),
    [key]: { enabled, updatedAt: new Date().toISOString(), source },
  };
  patchSettings({
    approvalPolicy: {
      ...policy,
      autoAllowConversations,
    },
  });
  return { key, enabled };
}

function formatApprovalAutoAllowConversationStatus(conversationId?: number) {
  const autoAllowConversations = approvalPolicy().autoAllowConversations || {};
  const keys = conversationId ? [String(conversationId)] : Object.keys(autoAllowConversations).sort((a, b) => Number(a) - Number(b));
  if (keys.length === 0) {
    return "approval auto-approve conversations: none";
  }
  return keys
    .map((key) => {
      const entry = autoAllowConversations[key];
      return `conversation ${key}: ${entry?.enabled ? "on" : "off"}${entry?.updatedAt ? ` (${entry.updatedAt})` : ""}`;
    })
    .join("\n");
}

export {
  approvalAutoAllowConversationMatch,
  formatApprovalAutoAllowConversationStatus,
  setApprovalAutoAllowConversation,
};
