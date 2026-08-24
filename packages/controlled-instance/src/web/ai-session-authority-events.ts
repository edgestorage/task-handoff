import type { AiSessionsSnapshot } from "@task-handoff/protocol/ai-sessions";

type AiSessionSummary = AiSessionsSnapshot["sessions"][number];

export type AiSessionAuthorityChange =
  | { kind: "snapshot"; snapshot: AiSessionsSnapshot }
  | { kind: "patch"; upserted: AiSessionSummary[]; removed: string[] }
  | { kind: "removed"; sessionIds: string[] }
  | { kind: "unchanged" };

function sameSession(previous: AiSessionSummary, next: AiSessionSummary) {
  return JSON.stringify(previous) === JSON.stringify(next);
}

/**
 * Project one authoritative registry state into the smallest recoverable event.
 * A full snapshot establishes a stream. Routine registry changes are patches or
 * tombstones; ordering-only changes are presentation details and emit nothing.
 */
export function projectAiSessionAuthorityChange(
  previous: AiSessionsSnapshot | undefined,
  next: AiSessionsSnapshot,
): AiSessionAuthorityChange {
  if (!previous) return { kind: "snapshot", snapshot: next };

  const previousById = new Map(previous.sessions.map((session) => [session.id, session]));
  const nextById = new Map(next.sessions.map((session) => [session.id, session]));
  const upserted = next.sessions.filter((session) => {
    const previousSession = previousById.get(session.id);
    return !previousSession || !sameSession(previousSession, session);
  });
  const removed = previous.sessions
    .filter((session) => !nextById.has(session.id))
    .map((session) => session.id);

  if (upserted.length) return { kind: "patch", upserted, removed };
  if (removed.length) return { kind: "removed", sessionIds: removed };
  return { kind: "unchanged" };
}
