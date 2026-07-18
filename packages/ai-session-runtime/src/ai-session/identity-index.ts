import type { AiSessionStatus } from "@task-handoff/protocol/ai-sessions";

function normalizeIdentityPart(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
}

export function providerSessionIdentity(agent: string, providerSessionId: string) {
  const normalizedAgent = normalizeIdentityPart(agent, 80);
  const normalizedProviderSessionId = normalizeIdentityPart(providerSessionId, 240);
  if (!normalizedAgent || !normalizedProviderSessionId) {
    return undefined;
  }
  return {
    agent: normalizedAgent,
    providerSessionId: normalizedProviderSessionId,
    key: `${normalizedAgent}\u0000${normalizedProviderSessionId}`,
  };
}

/**
 * A rebuildable projection of provider identities. Session files remain the
 * source of truth; callers must validate every indexed id against the store.
 */
export class AiSessionIdentityIndex {
  private readonly sessionIdsByProvider = new Map<string, Set<string>>();
  private readonly providerKeysBySessionId = new Map<string, Set<string>>();

  candidates(agent: string, providerSessionId: string) {
    const identity = providerSessionIdentity(agent, providerSessionId);
    return identity ? [...(this.sessionIdsByProvider.get(identity.key) || [])] : [];
  }

  replace(session: AiSessionStatus) {
    this.remove(session.id);
    const providerSessionId = session.providerSessionId;
    if (!providerSessionId) {
      return;
    }
    const identity = providerSessionIdentity(session.agent, providerSessionId);
    if (!identity) {
      return;
    }
    const sessionIds = this.sessionIdsByProvider.get(identity.key) || new Set<string>();
    sessionIds.add(session.id);
    this.sessionIdsByProvider.set(identity.key, sessionIds);
    this.providerKeysBySessionId.set(session.id, new Set([identity.key]));
  }

  remove(sessionId: string) {
    const keys = this.providerKeysBySessionId.get(sessionId);
    if (!keys) {
      return;
    }
    for (const key of keys) {
      const sessionIds = this.sessionIdsByProvider.get(key);
      sessionIds?.delete(sessionId);
      if (!sessionIds?.size) {
        this.sessionIdsByProvider.delete(key);
      }
    }
    this.providerKeysBySessionId.delete(sessionId);
  }

  rebuild(sessions: readonly AiSessionStatus[]) {
    this.clear();
    for (const session of sessions) {
      this.replace(session);
    }
  }

  clear() {
    this.sessionIdsByProvider.clear();
    this.providerKeysBySessionId.clear();
  }
}
