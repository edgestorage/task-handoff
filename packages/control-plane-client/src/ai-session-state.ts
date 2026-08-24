import {
  applyAiSessionStreamEvent,
  type AiSessionStreamApplyResult,
  type AiSessionStreamEvent,
  type AiSessionSummary,
  type AiSessionSummaryTurn,
  type AiSessionTurn,
  type AiSessionUnreadState,
  type AiSessionsState,
} from "@task-handoff/protocol/ai-sessions";
import type { ControlPlaneAiSessions } from "./ai-sessions.ts";

export type AiSessionStatusGroup = "waiting" | "problem" | "active" | "idle";
export type AiSessionStreamingMessageStatus = "streaming" | "complete" | "waiting" | "failed" | "interrupted";

export function aiSessionElapsedSeconds(
  startedAt: string | undefined,
  endedAt: string | undefined,
  active: boolean,
  now = Date.now(),
) {
  if (!startedAt || (!endedAt && !active)) return undefined;
  const startedAtMs = Date.parse(startedAt);
  const endedAtMs = endedAt ? Date.parse(endedAt) : now;
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs < startedAtMs) return undefined;
  return Math.floor((endedAtMs - startedAtMs) / 1_000);
}

export type AiSessionMessageIdentity = {
  instanceId: string;
  sessionId: string;
  turnId: string;
  itemId: string;
};

export function aiSessionMessageKey(identity: AiSessionMessageIdentity) {
  return JSON.stringify([identity.instanceId, identity.sessionId, identity.turnId, identity.itemId]);
}

export function appendAiSessionMessageDelta<T extends {
  receivedText: string;
  status: AiSessionStreamingMessageStatus;
  receivedAt?: string;
  settledAt?: string;
  updatedAt: string;
}>(current: T, delta: string, receivedAt: string): T {
  return {
    ...current,
    receivedText: current.receivedText + delta,
    status: "streaming",
    receivedAt,
    settledAt: undefined,
    updatedAt: receivedAt,
  };
}

export function aiSessionAuthoritativeMessageStatus(session: AiSessionSummary, turnStatus?: string): AiSessionStreamingMessageStatus {
  if (session.status === "failed" || turnStatus === "failed") return "failed";
  if (session.status === "waiting" || turnStatus === "waiting") return "waiting";
  if (session.status === "idle" || turnStatus === "completed") return "complete";
  return "streaming";
}

export function isAiSessionApprovalPending(session: AiSessionSummary) {
  return session.status === "waiting" && session.phase === "approval";
}

export function canInterruptAiSession(session: AiSessionSummary) {
  return Boolean(session.actions?.interrupt);
}

export function aiSessionStatusGroup(session: AiSessionSummary): AiSessionStatusGroup {
  if (session.status === "waiting") return "waiting";
  if (session.status === "failed") return "problem";
  if (session.status === "running") return "active";
  return "idle";
}

export function aiSessionPriority(session: AiSessionSummary) {
  if (session.status === "waiting") return 4;
  if (session.status === "failed") return 3;
  if (session.status === "running") return 2;
  if (session.status === "idle") return 1;
  return 0;
}

export function aiSessionStableSortKey(session: AiSessionSummary) {
  return [session.cwd || "", session.agent || "", session.providerSessionId || session.id].join("\u0000");
}

export function aiSessionLastUserMessageAt(session: AiSessionSummary) {
  let latestValue: string | undefined;
  let latestTime = 0;
  for (const turn of session.turns || []) {
    if (!turn.userPrompt?.trim() || !turn.startedAt) continue;
    const timestamp = Date.parse(turn.startedAt);
    if (!Number.isFinite(timestamp) || timestamp < latestTime) continue;
    latestValue = turn.startedAt;
    latestTime = timestamp;
  }
  if (latestValue) return latestValue;
  return session.userPrompt?.trim() && Number.isFinite(Date.parse(session.startedAt)) ? session.startedAt : undefined;
}

export function mergeAiSessionSummaryTurnsWithDetail(
  summaryTurns: readonly AiSessionSummaryTurn[] | undefined,
  detailTurns: readonly AiSessionTurn[] | undefined,
): Array<AiSessionSummaryTurn & Pick<AiSessionTurn, "userMessages">> | undefined {
  if (summaryTurns === undefined) return detailTurns?.map((turn) => ({ ...turn }));
  if (summaryTurns.length === 0) return [];
  if (!detailTurns?.length) return [...summaryTurns];
  const summaryById = new Map(summaryTurns.map((turn) => [turn.id, turn]));
  const merged = detailTurns.map((detail) => {
    const summary = summaryById.get(detail.id);
    if (!summary) return { ...detail };
    summaryById.delete(detail.id);
    return { ...summary, ...(detail.userMessages ? { userMessages: detail.userMessages } : {}) };
  });
  merged.push(...summaryTurns.filter((turn) => summaryById.has(turn.id)));
  return merged.slice(-50);
}

export function aiSessionLastUserMessageTime(session: AiSessionSummary) {
  const value = aiSessionLastUserMessageAt(session);
  return value ? Date.parse(value) : 0;
}

export function compareAiSessionsByLastUserMessage(left: AiSessionSummary, right: AiSessionSummary, sortByStatus = true) {
  if (sortByStatus) {
    const priorityDelta = aiSessionPriority(right) - aiSessionPriority(left);
    if (priorityDelta) return priorityDelta;
  }
  return aiSessionLastUserMessageTime(right) - aiSessionLastUserMessageTime(left);
}

export function sortedAiSessions<T extends AiSessionSummary>(sessions?: readonly T[]): T[] {
  return [...(sessions || [])].sort((left, right) => {
    const priorityDelta = aiSessionPriority(right) - aiSessionPriority(left);
    return priorityDelta || aiSessionStableSortKey(left).localeCompare(aiSessionStableSortKey(right));
  });
}

export function sortedAiSessionsByLastUserMessage<T extends AiSessionSummary>(sessions?: readonly T[], sortByStatus = true): T[] {
  return [...(sessions || [])].sort((left, right) => (
    compareAiSessionsByLastUserMessage(left, right, sortByStatus)
      || aiSessionStableSortKey(left).localeCompare(aiSessionStableSortKey(right))
  ));
}

export type AiSessionInboxEntry<T extends AiSessionSummary = AiSessionSummary> = {
  instanceId: string;
  instanceName?: string;
  session: T;
};

export function sortedAiSessionInboxEntries<T extends AiSessionSummary>(entries: readonly AiSessionInboxEntry<T>[]) {
  return [...entries].sort((left, right) => (
    compareAiSessionsByLastUserMessage(left.session, right.session, false)
      || left.instanceId.localeCompare(right.instanceId)
      || aiSessionStableSortKey(left.session).localeCompare(aiSessionStableSortKey(right.session))
  ));
}

export function redactedAiSessionError(session: Pick<AiSessionSummary, "status" | "error">) {
  if (session.status !== "failed" || !session.error) return undefined;
  return "Session failed. Open the desktop app for diagnostic details.";
}

export function deriveAiSessionUnreadAfterStreamEvent(session: AiSessionSummary, previousUnread?: boolean) {
  return session.status === "running" || session.status === "waiting" ? false : Boolean(previousUnread);
}

export function applyAiSessionUnreadState<T extends AiSessionSummary>(session: T, state: AiSessionUnreadState): T {
  if (session.id !== state.sessionId || session.updatedAt !== state.sessionUpdatedAt) return session;
  return { ...session, unread: state.unread };
}

export type ControlPlaneAiSessionInstance = ControlPlaneAiSessions["instances"][number];

export function applyControlPlaneAiSessionStreamEvent(
  current: ControlPlaneAiSessionInstance | undefined,
  event: AiSessionStreamEvent,
): { result: AiSessionStreamApplyResult; entry?: ControlPlaneAiSessionInstance } {
  const projection: AiSessionsState | undefined = current ? {
    streamId: current.streamId,
    revision: current.revision ?? 0,
    lastEventAt: current.lastEventAt ?? current.aiSessions.updatedAt,
    // `unread` belongs to the Control Plane projection, not the public AI
    // Session stream protocol. Passing decorated sessions into the strict
    // protocol reducer makes every partial patch fail schema validation.
    snapshot: {
      ...current.aiSessions,
      sessions: current.aiSessions.sessions.map(({ unread: _unread, ...session }) => session),
    },
  } : undefined;
  const result = applyAiSessionStreamEvent(projection, event);
  if (result.kind !== "applied") return { result, entry: current };
  const previousUnread = new Map(current?.aiSessions.sessions.map((session) => [session.id, session.unread]) ?? []);
  return {
    result,
    entry: {
      instanceId: event.payload.meta.instanceId,
      streamId: result.projection.streamId,
      revision: result.projection.revision,
      lastEventAt: result.projection.lastEventAt,
      aiSessions: {
        ...result.projection.snapshot,
        sessions: result.projection.snapshot.sessions.map((session) => ({
          ...session,
          unread: deriveAiSessionUnreadAfterStreamEvent(session, previousUnread.get(session.id)),
        })),
      },
    },
  };
}
