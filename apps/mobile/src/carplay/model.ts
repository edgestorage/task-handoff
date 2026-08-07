import {
  aiSessionStatusGroup,
  isAiSessionApprovalPending,
  sortedAiSessionInboxEntries,
  type ControlPlaneAiSessions,
} from '@task-handoff/control-plane-client';

import { inboxCardContent } from '../ai-sessions/InboxModel';
import type { MobileStreamingMessage } from '../ai-sessions/store';
import type { Translate } from '../i18n';

export type CarPlaySession = {
  detail: string;
  id: string;
  instance: string;
  instanceId: string;
  status: string;
  title: string;
};

export type CarPlayProjection = {
  featured?: CarPlaySession;
  sections: { sessions: CarPlaySession[]; title: string }[];
  updatedAt: string;
};

export function projectCarPlaySessions(
  snapshot: ControlPlaneAiSessions | undefined,
  instanceNames: ReadonlyMap<string, string>,
  messages: readonly MobileStreamingMessage[],
  t: Translate,
): CarPlayProjection {
  const entries = sortedAiSessionInboxEntries((snapshot?.instances ?? []).flatMap((entry) => (
    entry.aiSessions.sessions.map((session) => ({ instanceId: entry.instanceId, session }))
  ))).map(({ instanceId, session }) => {
    const status = aiSessionStatusGroup(session);
    const content = inboxCardContent(
      session,
      messages.filter((message) => message.instanceId === instanceId && message.sessionId === session.id),
      t,
    );
    return {
      approvalPending: isAiSessionApprovalPending(session),
      group: status,
      session: {
        detail: singleLine(content.response).slice(0, 120),
        id: session.id,
        instance: instanceNames.get(instanceId) || instanceId,
        instanceId,
        status: isAiSessionApprovalPending(session) ? t('sessions.approvalNeeded') : statusLabel(status, t),
        title: (session.title?.trim() || content.prompt || t('sessions.untitled')).slice(0, 80),
      },
    };
  });

  const attention = entries.filter((entry) => entry.approvalPending || entry.group === 'waiting' || entry.group === 'problem');
  const active = entries.filter((entry) => entry.group === 'active');
  const recent = entries.filter((entry) => entry.group === 'idle');
  const featured = active[0]?.session;
  return {
    ...(featured ? { featured } : {}),
    sections: [
      { title: t('carPlay.needsAttention'), sessions: attention.slice(0, 4).map((entry) => entry.session) },
      { title: t('carPlay.active'), sessions: active.slice(0, 6).map((entry) => entry.session) },
      { title: t('carPlay.recent'), sessions: recent.slice(0, 4).map((entry) => entry.session) },
    ],
    updatedAt: snapshot?.updatedAt || new Date(0).toISOString(),
  };
}

function singleLine(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function statusLabel(status: ReturnType<typeof aiSessionStatusGroup>, t: Translate) {
  if (status === 'active') return t('sessions.filterActive');
  if (status === 'waiting') return t('sessions.filterWaiting');
  if (status === 'problem') return t('sessions.filterProblem');
  return t('sessions.filterIdle');
}
