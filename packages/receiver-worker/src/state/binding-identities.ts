type BindingSection = "sessions";

type BindingIdentity = {
  section: BindingSection;
  key: string;
  ownerKey: string;
};

function compact(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function addIdentity(target: BindingIdentity[], section: BindingSection, key: unknown, ownerPrefix: string, ownerValue = key) {
  const normalized = compact(key);
  const normalizedOwnerValue = compact(ownerValue);
  if (normalized && normalizedOwnerValue) {
    target.push({ section, key: normalized, ownerKey: `${ownerPrefix}:${normalizedOwnerValue}` });
  }
}

function dedupeIdentities(identities: BindingIdentity[]) {
  const seen = new Set<string>();
  return identities.filter((identity) => {
    const key = `${identity.section}:${identity.key}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function codexIdFromSessionIds(sessionIds: Record<string, unknown> = {}) {
  return compact(sessionIds.codexId || sessionIds.codexSessionId || sessionIds.codexThreadId) || undefined;
}

function identitiesFromSessionIds(sessionIds: Record<string, unknown> = {}) {
  const identities: BindingIdentity[] = [];
  for (const [name, value] of Object.entries(sessionIds)) {
    addIdentity(identities, "sessions", `${name}:${value}`, `session:${name}`, value);
  }
  const codexId = codexIdFromSessionIds(sessionIds);
  if (codexId) {
    addIdentity(identities, "sessions", `codex:${codexId}`, "session:codex", codexId);
  }
  return identities;
}

function identitiesFromMessage(message: Record<string, unknown> = {}) {
  return dedupeIdentities(identitiesFromSessionIds((message.sessionIds as Record<string, unknown>) || {}));
}

function identitiesFromCodexThread(threadId: unknown) {
  const normalized = compact(threadId);
  return normalized
    ? identitiesFromSessionIds({
        codexId: normalized,
        codexThreadId: normalized,
        mcpThreadId: normalized,
      })
    : [];
}

function sessionIdsForCodexThread(threadId: unknown) {
  const normalized = compact(threadId);
  return normalized
    ? {
        codexId: normalized,
        codexThreadId: normalized,
        mcpThreadId: normalized,
      }
    : undefined;
}

function sessionIdsForApprovalHook({
  codexId,
  claudeSessionId,
  terminalSessionId,
}: {
  codexId?: unknown;
  claudeSessionId?: unknown;
  terminalSessionId?: unknown;
}) {
  const codex = compact(codexId);
  const claude = compact(claudeSessionId);
  const terminal = compact(terminalSessionId);
  return Object.fromEntries(
    [
      ["codexId", codex],
      ["codexSessionId", codex],
      ["codexThreadId", codex],
      ["claudeSessionId", claude],
      ["terminalSessionId", terminal],
    ].filter(([, value]) => value),
  );
}

function ownerKeysFromIdentities(identities: BindingIdentity[], source: unknown = "cli") {
  if (identities.length === 0) {
    return [`unknown:${source === "mcp" ? "mcp" : "cli"}`];
  }
  return [...new Set(identities.map((identity) => identity.ownerKey))];
}

function codexIdFromIdentities(identities: BindingIdentity[]) {
  const identity = identities.find((entry) => entry.section === "sessions" && entry.key.startsWith("codex:"));
  return identity?.key.slice("codex:".length) || undefined;
}

function claudeIdFromIdentities(identities: BindingIdentity[]) {
  const identity = identities.find((entry) => entry.section === "sessions" && entry.key.startsWith("claudeSessionId:"));
  return identity?.key.slice("claudeSessionId:".length) || undefined;
}

export {
  codexIdFromIdentities,
  claudeIdFromIdentities,
  compact,
  identitiesFromCodexThread,
  identitiesFromMessage,
  identitiesFromSessionIds,
  ownerKeysFromIdentities,
  sessionIdsForApprovalHook,
  sessionIdsForCodexThread,
};

export type { BindingIdentity, BindingSection };
