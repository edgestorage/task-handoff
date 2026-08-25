import type {
  AiSessionDetail,
  AiSessionSummary,
  AiSessionTurn,
  AiSessionTurnIndex,
} from "@task-handoff/protocol/ai-sessions";
import { mergeAiSessionSummaryWithDetail } from "./ai-session-state.ts";

type CachedTurn = { revision: string; turn: AiSessionTurn };
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

  hasProjection(instanceId: string, sessionId: string) {
    const entry = this.entries.get(cacheKey(instanceId, sessionId));
    return Boolean(entry?.detail && entry.index);
  }

  hasTurnIndex(instanceId: string, summary: AiSessionSummary) {
    const entry = this.entries.get(cacheKey(instanceId, summary.id));
    return Boolean(entry?.index && entry.turnsRevision === aiSessionTurnsCacheRevision(summary));
  }

  setDetail(instanceId: string, summary: AiSessionSummary, detail: AiSessionDetail) {
    const entry = this.entry(instanceId, summary.id);
    entry.detail = detail;
    entry.detailRevision = aiSessionDetailCacheRevision(summary);
  }

  setTurnIndex(instanceId: string, summary: AiSessionSummary, index: AiSessionTurnIndex) {
    const entry = this.entry(instanceId, summary.id);
    entry.index = index;
    entry.turnsRevision = aiSessionTurnsCacheRevision(summary);
    const indexed = new Set(index.turns.map((turn) => turn.id));
    for (const turnId of entry.turns.keys()) {
      if (!indexed.has(turnId)) entry.turns.delete(turnId);
    }
  }

  turnIndex(instanceId: string, sessionId: string) {
    return this.entries.get(cacheKey(instanceId, sessionId))?.index;
  }

  needsTurn(instanceId: string, sessionId: string, turnId: string) {
    const entry = this.entries.get(cacheKey(instanceId, sessionId));
    const index = entry?.index?.turns.find((turn) => turn.id === turnId || turn.providerTurnId === turnId);
    return index && entry?.turns.get(index.id)?.revision !== index.bodyRevision ? index : undefined;
  }

  setTurn(instanceId: string, sessionId: string, revision: string, turn: AiSessionTurn) {
    this.entry(instanceId, sessionId).turns.set(turn.id, { revision, turn });
  }

  projection<Summary extends AiSessionSummary>(instanceId: string, summary: Summary): Summary {
    const entry = this.entries.get(cacheKey(instanceId, summary.id));
    const turns = entry?.index ? entry.index.turns.map((index) => {
      const body = entry?.turns.get(index.id);
      // Keep the previous body mounted while its replacement is loading.
      // bodyRevision is a refresh token, not part of the rendered identity.
      return body?.turn || index;
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
