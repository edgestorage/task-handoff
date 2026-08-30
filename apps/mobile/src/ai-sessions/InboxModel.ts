import {
  aiSessionLastUserMessageAt,
  aiSessionStatusGroup,
  sortedAiSessionInboxEntries,
  type ControlPlaneAiSessions,
  type ControlPlaneAiSessionSummary,
} from '@task-handoff/control-plane-client';

import type { MobileDirectoryProfileState } from '../directories/store';
import { activeMobileStreamingMessage, type AiSessionScope, type MobileAiSessionProfileState, type MobileStreamingMessage } from './store';
import { aiSessionDisplayTurns } from './SessionDetail';
import { translate, type Translate } from '../i18n';

const english: Translate = (key, params) => translate('en-US', key, params);

export type SessionStatusFilter = 'all' | 'active' | 'waiting' | 'idle' | 'problem';
export type SessionScopeOption = { label: string; scope: AiSessionScope };

export function inboxCardContent(session: ControlPlaneAiSessionSummary, messages: readonly MobileStreamingMessage[] = [], t: Translate = english) {
  const turns = aiSessionDisplayTurns(session);
  const lastUserMessageAt = aiSessionLastUserMessageAt(session);
  const matchingTurnIndex = lastUserMessageAt
    ? turns.findIndex((turn) => turn.userPrompt?.trim() && turn.startedAt === lastUserMessageAt)
    : -1;
  const selectedTurnIndex = matchingTurnIndex >= 0 ? matchingTurnIndex : Math.max(0, turns.length - 1);
  const turn = turns[selectedTurnIndex];
  const streamed = turn ? activeMobileStreamingMessage(messages, turn.id)?.receivedText.trim() || '' : '';
  return {
    prompt: turn?.userPrompt?.trim() || session.userPrompt?.trim() || session.title?.trim() || t('sessions.untitled'),
    response: streamed || turn?.lastMessage?.trim() || turn?.summary?.trim() || session.lastMessage?.trim() || session.summary?.trim() || t('sessions.noResponse'),
    turnCount: session.turnCount ?? turns.length,
    turnIndex: Math.max(0, turns.length - 1),
  };
}

export function inboxEntries(snapshot: ControlPlaneAiSessions | undefined, scope: AiSessionScope = { kind: 'all' }, instanceNodeIds = new Map<string, string>()) {
  return sortedAiSessionInboxEntries((snapshot?.instances ?? [])
    .filter((entry) => scope.kind === 'all'
      || (scope.kind === 'instance' && entry.instanceId === scope.instanceId)
      || (scope.kind === 'node' && instanceNodeIds.get(entry.instanceId) === scope.nodeId))
    .flatMap((entry) => entry.aiSessions.sessions.map((session) => ({ instanceId: entry.instanceId, session }))));
}

export function matchesStatusFilter(session: ControlPlaneAiSessionSummary, filter: SessionStatusFilter) {
  return filter === 'all' || aiSessionStatusGroup(session) === filter;
}

export function statusFilterLabel(filter: SessionStatusFilter, t: Translate = english) {
  return t(`sessions.filter${filter.charAt(0).toUpperCase()}${filter.slice(1)}` as 'sessions.filterAll');
}

export function inboxStatusMessage(sync: MobileAiSessionProfileState['sync'], t: Translate = english) {
  return sync.phase === 'offline'
    ? t('sessions.syncOffline')
    : sync.phase === 'stale'
      ? t('sessions.syncStale')
      : sync.error;
}

export function sessionScopeOptions(directory?: Pick<MobileDirectoryProfileState, 'nodes' | 'instances'>, t: Translate = english): SessionScopeOption[] {
  const nodes = directory?.nodes ?? [];
  const nodeNames = new Map(nodes.map((node) => [node.id, node.name]));
  return [
    { label: t('sessions.scopeAll'), scope: { kind: 'all' } },
    ...nodes.map((node) => ({ label: t('sessions.scopeNode', { name: node.name }), scope: { kind: 'node' as const, nodeId: node.id } })),
    ...(directory?.instances ?? []).map((instance) => ({
      label: t('sessions.scopeInstance', { name: instance.name, node: nodeNames.get(instance.nodeId) || instance.nodeId }),
      scope: { kind: 'instance' as const, instanceId: instance.id },
    })),
  ];
}

export function sameScope(left: AiSessionScope, right: AiSessionScope) {
  return left.kind === right.kind
    && (left.kind === 'all' || (left.kind === 'node' && right.kind === 'node' && left.nodeId === right.nodeId) || (left.kind === 'instance' && right.kind === 'instance' && left.instanceId === right.instanceId));
}

export function workspaceLabel(cwd?: string, t: Translate = english) {
  const normalized = cwd?.replace(/\/+$/, '');
  return normalized?.split('/').filter(Boolean).at(-1) || cwd || t('sessions.unknownWorkspace');
}
