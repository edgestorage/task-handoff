import {
  aiSessionLastUserMessageAt,
  sortedAiSessionInboxEntries,
  type ControlPlaneAiSessions,
  type ControlPlaneAiSessionSummary,
} from '@task-handoff/control-plane-client';

import type { MobileDirectoryProfileState } from '../directories/store';
import type { AiSessionScope, MobileAiSessionProfileState, MobileStreamingMessage } from './store';
import { aiSessionDisplayTurns } from './SessionDetail';

export type SessionStatusFilter = 'all' | 'active' | 'waiting' | 'idle' | 'problem';
export type SessionScopeOption = { label: string; scope: AiSessionScope };

export function inboxCardContent(session: ControlPlaneAiSessionSummary, messages: readonly MobileStreamingMessage[] = []) {
  const turns = aiSessionDisplayTurns(session);
  const lastUserMessageAt = aiSessionLastUserMessageAt(session);
  const matchingTurnIndex = lastUserMessageAt
    ? turns.findIndex((turn) => turn.userPrompt?.trim() && turn.startedAt === lastUserMessageAt)
    : -1;
  const selectedTurnIndex = matchingTurnIndex >= 0 ? matchingTurnIndex : Math.max(0, turns.length - 1);
  const turn = turns[selectedTurnIndex];
  const streamed = turn
    ? messages.filter((message) => message.turnId === turn.id).sort((left, right) => left.itemId.localeCompare(right.itemId)).map((message) => message.receivedText.trim()).filter(Boolean).join('\n\n')
    : '';
  return {
    prompt: turn?.userPrompt?.trim() || session.userPrompt?.trim() || session.title?.trim() || 'Untitled session',
    response: streamed || turn?.lastMessage?.trim() || turn?.summary?.trim() || session.lastMessage?.trim() || session.summary?.trim() || 'No response yet.',
    turnCount: turns.length,
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
  if (filter === 'all') return true;
  if (filter === 'active') return session.status === 'running';
  if (filter === 'waiting') return session.status === 'waiting';
  if (filter === 'problem') return session.status === 'failed';
  return session.status !== 'running' && session.status !== 'waiting' && session.status !== 'failed';
}

export function statusFilterLabel(filter: SessionStatusFilter) {
  return filter === 'all' ? 'All' : filter.charAt(0).toUpperCase() + filter.slice(1);
}

export function inboxStatusMessage(sync: MobileAiSessionProfileState['sync']) {
  return sync.phase === 'offline'
    ? 'Offline — showing the latest cached snapshot.'
    : sync.phase === 'stale'
      ? 'Live updates paused — showing cached data.'
      : sync.error;
}

export function sessionScopeOptions(directory?: Pick<MobileDirectoryProfileState, 'nodes' | 'instances'>): SessionScopeOption[] {
  const nodes = directory?.nodes ?? [];
  const nodeNames = new Map(nodes.map((node) => [node.id, node.name]));
  return [
    { label: 'All Sessions', scope: { kind: 'all' } },
    ...nodes.map((node) => ({ label: `Node · ${node.name}`, scope: { kind: 'node' as const, nodeId: node.id } })),
    ...(directory?.instances ?? []).map((instance) => ({
      label: `Instance · ${instance.name} — ${nodeNames.get(instance.nodeId) || instance.nodeId}`,
      scope: { kind: 'instance' as const, instanceId: instance.id },
    })),
  ];
}

export function sameScope(left: AiSessionScope, right: AiSessionScope) {
  return left.kind === right.kind
    && (left.kind === 'all' || (left.kind === 'node' && right.kind === 'node' && left.nodeId === right.nodeId) || (left.kind === 'instance' && right.kind === 'instance' && left.instanceId === right.instanceId));
}

export function workspaceLabel(cwd?: string) {
  const normalized = cwd?.replace(/\/+$/, '');
  return normalized?.split('/').filter(Boolean).at(-1) || cwd || 'Unknown workspace';
}
