import type {
  ControlPlaneInstanceDirectoryEntry,
  ControlPlaneNodeDirectoryEntry,
} from '@task-handoff/protocol/control-plane-directory';
import { translate, type Translate } from '../i18n';

const english: Translate = (key, params) => translate('en-US', key, params);

type NodeState = Pick<ControlPlaneNodeDirectoryEntry, 'health' | 'status'>;
type InstanceState = Pick<ControlPlaneInstanceDirectoryEntry, 'connectionStatus' | 'health' | 'status'>;
type AiSummary = ControlPlaneInstanceDirectoryEntry['aiSessions'];

export function nodeDisplayName(node: Pick<ControlPlaneNodeDirectoryEntry, 'id' | 'name'>, t: Translate = english) {
  const name = node.name.trim();
  if (name !== node.id) return name;
  const generatedSuffix = /^node[_:-]([a-z0-9]+)$/i.exec(node.id)?.[1];
  return generatedSuffix ? t('directories.generatedNode', { id: generatedSuffix.slice(0, 8).toUpperCase() }) : name;
}

export function nodeSummary(instanceCount: number, node: NodeState, t: Translate = english) {
  const parts = [t('directories.instanceCount', { count: instanceCount })];
  const state = nodeStateLabel(node, t);
  if (state) parts.push(state);
  return parts.join(' · ');
}

export function nodeStateLabel(node: NodeState, t: Translate = english) {
  if (node.health === 'failed') return t('status.failed');
  if (node.health === 'degraded' || node.status === 'degraded') return t('status.degraded');
  if (node.status === 'online') return t('status.online');
  if (node.status === 'offline') return t('status.offline');
  return undefined;
}

export function instanceStateLabel(instance: InstanceState, t: Translate = english) {
  if (instance.health === 'failed' || instance.status === 'failed') return t('status.failed');
  if (instance.health === 'degraded' || instance.status === 'unhealthy') return t('status.needsAttention');
  if (instance.connectionStatus === 'endpoint-unreachable') return t('status.unreachable');
  if (instance.connectionStatus === 'offline') return t('status.offline');
  switch (instance.status) {
    case 'provisioning': return t('status.provisioning');
    case 'starting': return t('status.starting');
    case 'registering': return t('status.connecting');
    case 'stopping': return t('status.stopping');
    case 'deleting': return t('status.deleting');
    case 'stopped': return t('status.stopped');
    case 'created': return t('status.created');
    case 'registered': return t('status.ready');
    case 'running': return t('status.running');
  }
}

export function aiSessionSummary(summary: AiSummary, t: Translate = english) {
  const parts = [
    summary.runningCount ? t('directories.activeCount', { count: summary.runningCount }) : undefined,
    summary.waitingCount ? t('directories.waitingCount', { count: summary.waitingCount }) : undefined,
    summary.problemCount ? t('directories.issueCount', { count: summary.problemCount }) : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join(' · ');
}

export function connectionModeLabel(mode: ControlPlaneNodeDirectoryEntry['connectionMode'], t: Translate = english) {
  return ({
    'local-ipc': t('directories.connectionLocal'),
    'local-loopback': t('directories.connectionLocal'),
    'direct-http': t('directories.connectionDirect'),
    'reverse-wss': t('directories.connectionRemote'),
    'control-plane-proxy': t('directories.connectionProxy'),
  } as const)[mode];
}

export function relativeObservedAt(value: string | number, nowOrTranslate: number | Translate = Date.now(), translateOverride?: Translate) {
  const now = typeof nowOrTranslate === 'number' ? nowOrTranslate : Date.now();
  const t = typeof nowOrTranslate === 'function' ? nowOrTranslate : translateOverride ?? english;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return t('time.recently');
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return t('time.justNow');
  if (elapsed < 60 * 60_000) return t('time.minutesAgo', { count: Math.floor(elapsed / 60_000) });
  if (elapsed < 24 * 60 * 60_000) return t('time.hoursAgo', { count: Math.floor(elapsed / (60 * 60_000)) });
  const days = Math.floor(elapsed / (24 * 60 * 60_000));
  return days === 1 ? t('time.yesterday') : t('time.daysAgo', { count: days });
}
