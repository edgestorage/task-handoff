import {
  aiSessionLastUserMessageAt,
  aiSessionStableSortKey,
  aiSessionStatusGroup,
  compareAiSessionsByLastUserMessage,
  sortedAiSessionInboxEntries,
  type AiSessionInboxEntry,
  type ControlPlaneAiSessions,
  type ControlPlaneAiSessionSummary,
} from '@task-handoff/control-plane-client';

import type { MobileDirectoryProfileState } from '../directories/store';
import { activeMobileStreamingMessage, type AiSessionScope, type MobileAiSessionProfileState, type MobileStreamingMessage } from './store';
import { aiSessionDisplayTurns } from './SessionDetail';
import { translate, type Translate } from '../i18n';
import type { AiSessionInboxGroupBy } from './inbox-view-preferences';

const english: Translate = (key, params) => translate('en-US', key, params);

export type SessionStatusFilter = 'all' | 'active' | 'waiting' | 'idle' | 'problem';
export type SessionScopeOption = { label: string; scope: AiSessionScope };
export type AiSessionInboxPresentationRow =
  | { type: 'group'; key: string; label: string; count: number }
  | ({ type: 'session' } & AiSessionInboxEntry<ControlPlaneAiSessionSummary>);

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

export function aiSessionInboxRows(
  entries: readonly AiSessionInboxEntry<ControlPlaneAiSessionSummary>[],
  directory: Pick<MobileDirectoryProfileState, 'nodes' | 'instances'> | undefined,
  groupBy: AiSessionInboxGroupBy,
  sortByStatus: boolean,
  t: Translate = english,
): AiSessionInboxPresentationRow[] {
  const instances = new Map((directory?.instances ?? []).map((instance) => [instance.id, instance]));
  const nodes = new Map((directory?.nodes ?? []).map((node) => [node.id, node]));
  const sorted = [...entries].sort((left, right) => (
    compareAiSessionsByLastUserMessage(left.session, right.session, sortByStatus)
      || compareNaturalText(instances.get(left.instanceId)?.name || left.instanceId, instances.get(right.instanceId)?.name || right.instanceId)
      || left.instanceId.localeCompare(right.instanceId)
      || aiSessionStableSortKey(left.session).localeCompare(aiSessionStableSortKey(right.session))
  ));
  if (groupBy === 'none') return sorted.map((entry) => ({ type: 'session', ...entry }));

  const groups = new Map<string, { label: string; entries: typeof sorted }>();
  for (const entry of sorted) {
    const instance = instances.get(entry.instanceId);
    const group = aiSessionInboxGroup(entry, groupBy, instance, instance ? nodes.get(instance.nodeId) : undefined, t);
    const current = groups.get(group.key) ?? { label: group.label, entries: [] };
    current.entries.push(entry);
    groups.set(group.key, current);
  }
  return [...groups].flatMap(([key, group]) => [
    { type: 'group' as const, key: `group:${groupBy}:${key}`, label: group.label, count: group.entries.length },
    ...group.entries.map((entry) => ({ type: 'session' as const, ...entry })),
  ]);
}

function aiSessionInboxGroup(
  entry: AiSessionInboxEntry<ControlPlaneAiSessionSummary>,
  groupBy: Exclude<AiSessionInboxGroupBy, 'none'>,
  instance: MobileDirectoryProfileState['instances'][number] | undefined,
  node: MobileDirectoryProfileState['nodes'][number] | undefined,
  t: Translate,
) {
  if (groupBy === 'instance') return { key: entry.instanceId, label: instance?.name || entry.instanceId };
  if (groupBy === 'node') return { key: instance?.nodeId || '__unknown_node__', label: node?.name || instance?.nodeId || t('sessions.inbox.unknownNode') };
  if (groupBy === 'agent') return { key: entry.session.agent, label: appDisplayName(entry.session.agent) };
  const path = entry.session.cwd?.trim() || '';
  return { key: normalizeFolderPath(path) || '__unknown_path__', label: path || t('sessions.inbox.unknownPath') };
}

function normalizeFolderPath(value: string) {
  if (/^[A-Za-z]:[\\/]/u.test(value)) return value.replace(/\\/gu, '/').replace(/\/+$/u, '').toLocaleLowerCase();
  return value.replace(/\/+$/u, '');
}

function appDisplayName(id: string) {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (character) => character.toLocaleUpperCase());
}

function compareNaturalText(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
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
