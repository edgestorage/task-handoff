import {
  aiSessionStatusGroup,
  isAiSessionApprovalPending,
  type ControlPlaneAiSessions,
  type ControlPlaneAiSessionSummary,
} from '@task-handoff/control-plane-client';

import type { Translate } from '../i18n';

export type TaskStatusKind = 'active' | 'waiting' | 'problem' | 'idle';

export type TaskStatusProps = {
  activeCount: number;
  detail: string;
  message: string;
  problemCount: number;
  status: TaskStatusKind;
  statusLabel: string;
  title: string;
  waitingCount: number;
};

export type TaskStatusProjection = {
  props: TaskStatusProps;
  shouldShowLiveActivity: boolean;
};

export type TaskStatusSurfacesState = {
  endLiveActivity?: boolean;
  liveActivity?: TaskStatusProps;
  widget: TaskStatusProps;
};

type Candidate = {
  instanceId: string;
  session: ControlPlaneAiSessionSummary;
};

export function projectTaskStatus(
  snapshot: ControlPlaneAiSessions | undefined,
  instanceNames: ReadonlyMap<string, string>,
  t: Translate,
): TaskStatusProjection {
  const candidates = (snapshot?.instances ?? []).flatMap((entry) => entry.aiSessions.sessions.map((session) => ({
    instanceId: entry.instanceId,
    session,
  })));
  const counts = candidates.reduce((result, candidate) => {
    const status = aiSessionStatusGroup(candidate.session);
    result[status] += 1;
    return result;
  }, { active: 0, idle: 0, problem: 0, waiting: 0 });
  const selected = [...candidates].sort(compareCandidates)[0];
  const status = selected ? aiSessionStatusGroup(selected.session) : 'idle';
  const title = selected?.session.title?.trim() || t('sessions.untitled');
  const detail = selected
    ? instanceNames.get(selected.instanceId) || selected.instanceId
    : t('sessions.empty');

  return {
    props: {
      activeCount: counts.active,
      detail,
      message: selected ? latestAiMessage(selected.session, t) : t('sessions.noResponse'),
      problemCount: counts.problem,
      status,
      statusLabel: selected && isAiSessionApprovalPending(selected.session)
        ? t('sessions.approvalNeeded')
        : statusLabel(status, t),
      title: title.slice(0, 160),
      waitingCount: counts.waiting,
    },
    shouldShowLiveActivity: counts.active + counts.waiting > 0,
  };
}

export function projectSessionTaskStatus(
  session: ControlPlaneAiSessionSummary,
  instanceName: string,
  t: Translate,
): TaskStatusProjection {
  const status = aiSessionStatusGroup(session);
  return {
    props: {
      activeCount: status === 'active' ? 1 : 0,
      detail: instanceName,
      message: latestAiMessage(session, t),
      problemCount: status === 'problem' ? 1 : 0,
      status,
      statusLabel: isAiSessionApprovalPending(session) ? t('sessions.approvalNeeded') : statusLabel(status, t),
      title: (session.title?.trim() || t('sessions.untitled')).slice(0, 160),
      waitingCount: status === 'waiting' ? 1 : 0,
    },
    shouldShowLiveActivity: status === 'active' || status === 'waiting',
  };
}

function latestAiMessage(session: ControlPlaneAiSessionSummary, t: Translate) {
  const turns = session.turns ?? [];
  const latestTurn = turns.at(-1);
  return compactMessage(latestTurn?.lastMessage || session.lastMessage || t('sessions.noResponse'));
}

function compactMessage(value: string) {
  return value.trim().replace(/\s+/g, ' ').slice(0, 320);
}

function compareCandidates(left: Candidate, right: Candidate) {
  const priority = candidatePriority(left) - candidatePriority(right);
  if (priority !== 0) return priority;
  return right.session.updatedAt.localeCompare(left.session.updatedAt);
}

function candidatePriority(candidate: Candidate) {
  if (isAiSessionApprovalPending(candidate.session)) return 0;
  const status = aiSessionStatusGroup(candidate.session);
  if (status === 'waiting') return 1;
  if (status === 'active') return 2;
  if (status === 'problem') return 3;
  return 4;
}

function statusLabel(status: TaskStatusKind, t: Translate) {
  if (status === 'active') return t('sessions.filterActive');
  if (status === 'waiting') return t('sessions.filterWaiting');
  if (status === 'problem') return t('sessions.filterProblem');
  return t('sessions.filterIdle');
}
