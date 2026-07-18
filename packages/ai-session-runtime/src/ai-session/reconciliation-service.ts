import type { AiSessionStatus } from "@task-handoff/protocol/ai-sessions";

export type AppSessionPresenceCandidate = {
  id?: unknown;
  status?: unknown;
};

export type AiSessionOrphanStateChange =
  | { kind: "marked"; sessionId: string; orphanedAt: number }
  | { kind: "cleared"; sessionId: string };

export type AiSessionVisibilityResult = {
  visibleSessionIds: string[];
  hiddenSessionIds: string[];
};

export type AppSessionReconciliationResult = AiSessionVisibilityResult & {
  removeSessionIds: string[];
  orphanStateChanges: AiSessionOrphanStateChange[];
};

export type AdapterSessionReconciliationInput = {
  sessions: readonly AiSessionStatus[];
  agent: "codex" | "claude";
  appSessionIds?: ReadonlySet<string>;
  providerSessionIds?: ReadonlySet<string>;
  providerShorts?: ReadonlySet<string>;
};

export type AdapterSessionReconciliationResult = AiSessionVisibilityResult & {
  removeSessionIds: string[];
  orphanStateChanges: AiSessionOrphanStateChange[];
};

export type AiSessionPruneResult = {
  canonicalSessionIds: string[];
  duplicateSessionIds: string[];
  expiredSessionIds: string[];
  removeSessionIds: string[];
};

export function sessionIdentityKey(session: AiSessionStatus) {
  if (session.appSessionId) {
    return `${session.agent}:app:${session.appSessionId}`;
  }
  if (session.providerSessionId) {
    return `${session.agent}:provider:${session.providerSessionId}`;
  }
  if (session.transcriptPath) {
    return `${session.agent}:transcript:${session.transcriptPath}`;
  }
  return `${session.agent}:id:${session.id}`;
}

export function betterCanonicalSession(lhs: AiSessionStatus, rhs: AiSessionStatus) {
  const lhsActivity = activityScore(lhs);
  const rhsActivity = activityScore(rhs);
  if (lhsActivity !== rhsActivity) {
    return lhsActivity > rhsActivity ? lhs : rhs;
  }
  return Date.parse(lhs.updatedAt) >= Date.parse(rhs.updatedAt) ? lhs : rhs;
}

export function canonicalAiSessions(sessions: readonly AiSessionStatus[]) {
  const byIdentity = new Map<string, AiSessionStatus>();
  for (const session of sessions) {
    const key = sessionIdentityKey(session);
    const existing = byIdentity.get(key);
    byIdentity.set(key, existing ? betterCanonicalSession(existing, session) : session);
  }
  return [...byIdentity.values()].sort(byMostRecentlyUpdated);
}

export function activeAppSessionIds(appSessions: readonly AppSessionPresenceCandidate[]) {
  return new Set(
    appSessions
      .filter((session) => typeof session.status !== "string" || session.status === "running")
      .map((session) => (typeof session.id === "string" ? session.id.trim() : ""))
      .filter(Boolean),
  );
}

/**
 * Computes reconciliation decisions while leaving persistence to the registry/store.
 * Orphan timestamps are runtime state: callers should use the returned remove ids to
 * mutate the authoritative store, then call forgetSession for out-of-band removals.
 */
export class AiSessionReconciliationService {
  private readonly orphanedAppSessionAt = new Map<string, number>();

  canonicalSessions(sessions: readonly AiSessionStatus[]) {
    return canonicalAiSessions(sessions);
  }

  visibility(sessions: readonly AiSessionStatus[]): AiSessionVisibilityResult {
    const hiddenSessionIds = sessions
      .filter((session) => this.orphanedAppSessionAt.has(session.id))
      .map((session) => session.id);
    const hidden = new Set(hiddenSessionIds);
    const visibleSessionIds = canonicalAiSessions(sessions.filter((session) => !hidden.has(session.id)))
      .map((session) => session.id);
    return { visibleSessionIds, hiddenSessionIds };
  }

  reconcileAppSessionBindings(input: {
    sessions: readonly AiSessionStatus[];
    appSessions?: readonly AppSessionPresenceCandidate[];
    now: number;
    orphanRetentionMs: number;
  }): AppSessionReconciliationResult {
    const appSessionIds = activeAppSessionIds(input.appSessions || []);
    const removeSessionIds: string[] = [];
    const hiddenSessionIds: string[] = [];
    const orphanStateChanges: AiSessionOrphanStateChange[] = [];

    for (const session of input.sessions) {
      if (!session.appSessionId || appSessionIds.has(session.appSessionId)) {
        this.recordOrphanClear(session.id, orphanStateChanges);
        continue;
      }

      let orphanedAt = this.orphanedAppSessionAt.get(session.id);
      if (orphanedAt === undefined) {
        orphanedAt = input.now;
        this.orphanedAppSessionAt.set(session.id, orphanedAt);
        orphanStateChanges.push({ kind: "marked", sessionId: session.id, orphanedAt });
      }
      hiddenSessionIds.push(session.id);

      if (input.now - orphanedAt >= input.orphanRetentionMs) {
        removeSessionIds.push(session.id);
        this.recordOrphanClear(session.id, orphanStateChanges);
      }
    }

    const unavailable = new Set([...hiddenSessionIds, ...removeSessionIds]);
    const visibleSessionIds = canonicalAiSessions(input.sessions.filter((session) => !unavailable.has(session.id)))
      .map((session) => session.id);
    return { visibleSessionIds, hiddenSessionIds, removeSessionIds, orphanStateChanges };
  }

  reconcileAdapterSessions(input: AdapterSessionReconciliationInput): AdapterSessionReconciliationResult {
    const appSessionIds = input.appSessionIds || EMPTY_STRING_SET;
    const providerSessionIds = input.providerSessionIds || EMPTY_STRING_SET;
    const providerShorts = input.providerShorts || EMPTY_STRING_SET;
    const removeSessionIds: string[] = [];
    const orphanStateChanges: AiSessionOrphanStateChange[] = [];

    for (const session of input.sessions) {
      if (session.agent !== input.agent) {
        continue;
      }
      if (!session.appSessionId && !session.providerSessionId && !session.providerMeta?.short) {
        continue;
      }
      const short = typeof session.providerMeta?.short === "string" ? session.providerMeta.short : "";
      const present = Boolean(
        (session.appSessionId && appSessionIds.has(session.appSessionId))
        || (session.providerSessionId && providerSessionIds.has(session.providerSessionId))
        || (short && providerShorts.has(short)),
      );
      if (present) {
        this.recordOrphanClear(session.id, orphanStateChanges);
        continue;
      }
      removeSessionIds.push(session.id);
      this.recordOrphanClear(session.id, orphanStateChanges);
    }

    const removed = new Set(removeSessionIds);
    const remaining = input.sessions.filter((session) => !removed.has(session.id));
    const visibility = this.visibility(remaining);
    return { ...visibility, removeSessionIds, orphanStateChanges };
  }

  prune(input: {
    sessions: readonly AiSessionStatus[];
    now: number;
    retentionMs: number;
  }): AiSessionPruneResult {
    const canonicalSessionIds = canonicalAiSessions(input.sessions).map((session) => session.id);
    const canonical = new Set(canonicalSessionIds);
    const duplicateSessionIds = input.sessions
      .filter((session) => !canonical.has(session.id))
      .map((session) => session.id);
    const duplicate = new Set(duplicateSessionIds);
    const cutoff = input.now - input.retentionMs;
    const expiredSessionIds = input.sessions
      .filter((session) => !duplicate.has(session.id))
      .filter((session) => ["idle", "failed"].includes(session.status) && Date.parse(session.updatedAt) < cutoff)
      .map((session) => session.id);
    const removeSessionIds = [...duplicateSessionIds, ...expiredSessionIds];
    return { canonicalSessionIds, duplicateSessionIds, expiredSessionIds, removeSessionIds };
  }

  clearOrphan(sessionId: string) {
    this.orphanedAppSessionAt.delete(sessionId);
  }

  forgetSession(sessionId: string) {
    this.orphanedAppSessionAt.delete(sessionId);
  }

  private recordOrphanClear(sessionId: string, changes: AiSessionOrphanStateChange[]) {
    if (!this.orphanedAppSessionAt.delete(sessionId)) {
      return;
    }
    changes.push({ kind: "cleared", sessionId });
  }
}

const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>();

function activityScore(session: AiSessionStatus) {
  return Number(Boolean(session.userPrompt))
    + Number(Boolean(session.summary))
    + Number(Boolean(session.lastMessage))
    + (session.turns?.length || 0);
}

function byMostRecentlyUpdated(lhs: AiSessionStatus, rhs: AiSessionStatus) {
  return Date.parse(rhs.updatedAt) - Date.parse(lhs.updatedAt);
}
