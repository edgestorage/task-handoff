import type {
  AiSessionDetail,
  AiSessionSummary,
  AiSessionTurn,
  AiSessionTurnIndex,
} from "@task-handoff/protocol/ai-sessions";
import { mergeAiSessionSummaryWithDetail } from "./ai-session-state.ts";

type CachedTurn = { revision: string; turn: AiSessionTurn };
type IndexedTurn = AiSessionTurnIndex["turns"][number];
type CachedConversation = {
  detail?: AiSessionDetail;
  detailRevision?: string;
  index?: AiSessionTurnIndex;
  turnsRevision?: string;
  turns: Map<string, CachedTurn>;
};

export function aiSessionDetailCacheRevision(summary: AiSessionSummary) {
  return summary.detailRevision || `legacy:${summary.updatedAt}`;
}

export function aiSessionTurnsCacheRevision(summary: AiSessionSummary) {
  return summary.turnsRevision || `legacy:${summary.updatedAt}`;
}

function cacheKey(instanceId: string, sessionId: string) {
  return JSON.stringify([instanceId, sessionId]);
}

function projectTurn(index: IndexedTurn, body: CachedTurn | undefined): AiSessionTurn {
  if (!body) return index;
  const terminal = index.status === "completed" || index.status === "failed";
  return {
    ...body.turn,
    id: index.id,
    providerTurnId: index.providerTurnId ?? body.turn.providerTurnId,
    status: index.status,
    phase: index.phase ?? body.turn.phase,
    revision: index.revision,
    startedAt: index.startedAt ?? body.turn.startedAt,
    updatedAt: index.updatedAt ?? body.turn.updatedAt,
    completedAt: terminal ? index.completedAt ?? body.turn.completedAt : undefined,
  };
}

export class AiSessionConversationCache {
  private readonly entries = new Map<string, CachedConversation>();
  private readonly maxSessions: number;

  constructor(maxSessions = 80) {
    this.maxSessions = maxSessions;
  }

  private entry(instanceId: string, sessionId: string) {
    const key = cacheKey(instanceId, sessionId);
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }
    const created: CachedConversation = { turns: new Map() };
    this.entries.set(key, created);
    while (this.entries.size > this.maxSessions) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
    return created;
  }

  hasDetail(instanceId: string, summary: AiSessionSummary) {
    const entry = this.entries.get(cacheKey(instanceId, summary.id));
    return Boolean(entry?.detail && entry.detailRevision === aiSessionDetailCacheRevision(summary));
  }

  hasProjection(instanceId: string, summary: AiSessionSummary) {
    return this.hasDetail(instanceId, summary) && this.hasTurnIndex(instanceId, summary);
  }

  hasRenderableProjection(instanceId: string, sessionId: string) {
    const entry = this.entries.get(cacheKey(instanceId, sessionId));
    return Boolean(entry?.detail && entry.index);
  }

  detailRevision(instanceId: string, sessionId: string) {
    return this.entries.get(cacheKey(instanceId, sessionId))?.detailRevision;
  }

  turnsRevision(instanceId: string, sessionId: string) {
    return this.entries.get(cacheKey(instanceId, sessionId))?.turnsRevision;
  }

  hasTurnIndex(instanceId: string, summary: AiSessionSummary) {
    const entry = this.entries.get(cacheKey(instanceId, summary.id));
    return Boolean(entry?.index && entry.turnsRevision === aiSessionTurnsCacheRevision(summary));
  }

  setDetail(instanceId: string, revision: string, detail: AiSessionDetail) {
    const entry = this.entry(instanceId, detail.id);
    entry.detail = detail;
    entry.detailRevision = revision;
  }

  setTurnIndex(instanceId: string, revision: string, index: AiSessionTurnIndex) {
    const entry = this.entry(instanceId, index.sessionId);
    entry.index = index;
    entry.turnsRevision = revision;
    const indexed = new Set(index.turns.map((turn) => turn.id));
    for (const turnId of entry.turns.keys()) {
      if (!indexed.has(turnId)) entry.turns.delete(turnId);
    }
  }

  turnIndex(instanceId: string, sessionId: string, revision?: string) {
    const entry = this.entries.get(cacheKey(instanceId, sessionId));
    return revision === undefined || entry?.turnsRevision === revision ? entry?.index : undefined;
  }

  turnRevision(instanceId: string, sessionId: string, turnId: string) {
    const entry = this.entries.get(cacheKey(instanceId, sessionId));
    const index = entry?.index?.turns.find((turn) => turn.id === turnId || turn.providerTurnId === turnId);
    return index ? entry?.turns.get(index.id)?.revision : undefined;
  }

  turnEntry(instanceId: string, sessionId: string, turnId: string) {
    return this.entries.get(cacheKey(instanceId, sessionId))?.index?.turns
      .find((turn) => turn.id === turnId || turn.providerTurnId === turnId);
  }

  hasRenderableTurn(instanceId: string, sessionId: string, turnId: string) {
    const entry = this.entries.get(cacheKey(instanceId, sessionId));
    const index = entry?.index?.turns.find((turn) => turn.id === turnId || turn.providerTurnId === turnId);
    return Boolean(index && entry?.turns.has(index.id));
  }

  hasCurrentTurn(instanceId: string, sessionId: string, turnId: string) {
    const entry = this.entries.get(cacheKey(instanceId, sessionId));
    const index = entry?.index?.turns.find((turn) => turn.id === turnId || turn.providerTurnId === turnId);
    return Boolean(index && entry?.turns.get(index.id)?.revision === index.bodyRevision);
  }

  needsTurn(instanceId: string, sessionId: string, turnId: string) {
    const entry = this.entries.get(cacheKey(instanceId, sessionId));
    const index = entry?.index?.turns.find((turn) => turn.id === turnId || turn.providerTurnId === turnId);
    return index && entry?.turns.get(index.id)?.revision !== index.bodyRevision ? index : undefined;
  }

  setTurn(instanceId: string, sessionId: string, revision: string, turn: AiSessionTurn, authoritativeRevision?: string) {
    const entry = this.entry(instanceId, sessionId);
    const indexed = entry.index?.turns.find((candidate) => candidate.id === turn.id || candidate.providerTurnId === turn.id);
    const expectedRevision = authoritativeRevision ?? indexed?.bodyRevision;
    if (!indexed || expectedRevision !== revision) return false;
    if (authoritativeRevision) indexed.bodyRevision = authoritativeRevision;
    Object.assign(indexed, {
      providerTurnId: turn.providerTurnId ?? indexed.providerTurnId,
      status: turn.status,
      phase: turn.phase,
      revision: turn.revision,
      startedAt: turn.startedAt,
      updatedAt: turn.updatedAt,
      completedAt: turn.completedAt,
    });
    entry.turns.set(indexed.id, { revision, turn });
    return true;
  }

  projection<Summary extends AiSessionSummary>(instanceId: string, summary: Summary): Summary {
    const entry = this.entries.get(cacheKey(instanceId, summary.id));
    // Keep the last complete projection visible while a newer revision is
    // fetched. The summary remains authoritative for live list fields.
    const turns = entry?.index ? entry.index.turns.map((index) => {
      const body = entry?.turns.get(index.id);
      // The body owns conversation content, while the latest index owns the
      // Turn lifecycle. A completion event may update only turnsRevision, so
      // allowing a cached running body to replace index metadata leaves live
      // elapsed timers running until the client restarts.
      return projectTurn(index, body);
    }) : [...(summary.turns || [])];
    return entry?.detail && entry.detailRevision === aiSessionDetailCacheRevision(summary)
      ? mergeAiSessionSummaryWithDetail(summary, entry.detail, turns)
      : { ...summary, turns };
  }

  clear(instanceId: string, sessionId: string) {
    return this.entries.delete(cacheKey(instanceId, sessionId));
  }

  clearInstance(instanceId: string) {
    let deleted = false;
    for (const key of this.entries.keys()) {
      const [owner] = JSON.parse(key) as [string, string];
      if (owner !== instanceId) continue;
      this.entries.delete(key);
      deleted = true;
    }
    return deleted;
  }
}
