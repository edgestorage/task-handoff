import {
  AiSessionHistoryItemSchema,
  AiSessionHistoryTurnSchema,
  type AiSessionHistoryItem,
  type AiSessionHistoryTurn,
  type AiSessionStatus,
} from "@task-handoff/protocol/ai-sessions";
import { AiSessionHistoryStore } from "./ai-session-history-store";
import { activeAppSessionIds, type AppSessionPresenceCandidate } from "./ai-session/reconciliation-service";

type ResumableAgentQuery = (agent: string) => boolean;

// Compatibility for v0.0.21: standalone consumers only knew the two released providers.
const legacyResumableAgent: ResumableAgentQuery = (agent) => agent === "codex" || agent === "claude";

export function aiSessionHistoryTurns(session: AiSessionStatus): AiSessionHistoryTurn[] {
  const turns = (session.turns || []).slice(-50).map((turn) => AiSessionHistoryTurnSchema.parse({
    id: turn.id,
    providerTurnId: turn.providerTurnId,
    userPrompt: turn.userPrompt,
    userMessages: turn.userMessages,
    status: turn.status,
    phase: turn.phase,
    summary: turn.summary,
    lastMessage: turn.lastMessage,
    contextCompactions: turn.contextCompactions,
    startedAt: turn.startedAt,
    updatedAt: turn.updatedAt,
    completedAt: turn.completedAt,
  }));
  if (turns.length || (!session.userPrompt && !session.lastMessage)) return turns;
  return [AiSessionHistoryTurnSchema.parse({
    id: session.activeTurnId || `history:${session.id}`,
    userPrompt: session.userPrompt,
    status: session.status === "failed" ? "failed" : session.status === "waiting" ? "waiting" : "completed",
    phase: session.phase,
    summary: session.summary,
    lastMessage: session.lastMessage,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt || session.updatedAt,
  })];
}

export function aiSessionHistoryItem(
  session: AiSessionStatus,
  archivedAt = new Date().toISOString(),
): AiSessionHistoryItem | undefined {
  if (!session.agent.trim() || !session.providerSessionId || !session.cwd) {
    return undefined;
  }
  return AiSessionHistoryItemSchema.parse({
    id: session.id,
    agent: session.agent,
    creationSource: session.creationSource,
    providerSessionId: session.providerSessionId,
    lineage: session.lineage,
    modelSelection: session.modelSelection,
    reasoningEffort: session.reasoningEffort,
    title: session.title,
    userPrompt: session.userPrompt,
    lastMessage: session.lastMessage,
    cwd: session.cwd,
    cwdFolderId: session.cwdFolderId,
    lastActiveAt: session.updatedAt,
    archivedAt,
  });
}

export class AiSessionHistoryLifecycle {
  private readonly store: AiSessionHistoryStore;
  private readonly isResumableAgent: ResumableAgentQuery;

  constructor(store: AiSessionHistoryStore, isResumableAgent: ResumableAgentQuery = legacyResumableAgent) {
    this.store = store;
    this.isResumableAgent = isResumableAgent;
  }

  activate(sessions: readonly AiSessionStatus[], appSessions: readonly AppSessionPresenceCandidate[]) {
    const activeIds = activeAppSessionIds(appSessions);
    let activated = 0;
    for (const session of sessions) {
      if (!this.isResumableAgent(session.agent) || !session.providerSessionId || !session.appSessionId || !activeIds.has(session.appSessionId)) continue;
      activated += Number(this.store.activate(session.id));
      activated += Number(this.store.activateIdentity(session.agent, session.providerSessionId));
    }
    return { activated, items: this.store.list() };
  }

  reconcile(
    sessions: readonly AiSessionStatus[],
    appSessions: readonly AppSessionPresenceCandidate[],
    archivedAt = new Date().toISOString(),
  ) {
    const activeIds = activeAppSessionIds(appSessions);
    let archived = 0;
    let activated = 0;
    for (const session of sessions) {
      if (!this.isResumableAgent(session.agent) || !session.providerSessionId || !session.appSessionId) continue;
      if (activeIds.has(session.appSessionId)) {
        activated += Number(this.store.activate(session.id));
        activated += Number(this.store.activateIdentity(session.agent, session.providerSessionId));
        continue;
      }
      const existing = this.store.get(session.id)
        || this.store.list().find((item) => item.agent === session.agent && item.providerSessionId === session.providerSessionId);
      const item = aiSessionHistoryItem(session, existing?.archivedAt || archivedAt);
      if (!item) continue;
      this.store.upsert(item, aiSessionHistoryTurns(session));
      archived += Number(!existing);
    }
    return { archived, activated, items: this.store.list() };
  }
}
