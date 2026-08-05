import type {
  ControlPlaneInstanceDirectoryEntry,
  ControlPlaneNodeDirectoryEntry,
} from '@task-handoff/protocol/control-plane-directory';

type NodeState = Pick<ControlPlaneNodeDirectoryEntry, 'health' | 'status'>;
type InstanceState = Pick<ControlPlaneInstanceDirectoryEntry, 'connectionStatus' | 'health' | 'status'>;
type AiSummary = ControlPlaneInstanceDirectoryEntry['aiSessions'];

export function nodeDisplayName(node: Pick<ControlPlaneNodeDirectoryEntry, 'id' | 'name'>) {
  const name = node.name.trim();
  if (name !== node.id) return name;
  const generatedSuffix = /^node[_:-]([a-z0-9]+)$/i.exec(node.id)?.[1];
  return generatedSuffix ? `Node ${generatedSuffix.slice(0, 8).toUpperCase()}` : name;
}

export function nodeSummary(instanceCount: number, node: NodeState) {
  const parts = [`${instanceCount} ${instanceCount === 1 ? 'Instance' : 'Instances'}`];
  const state = nodeStateLabel(node);
  if (state) parts.push(state);
  return parts.join(' · ');
}

export function nodeStateLabel(node: NodeState) {
  if (node.health === 'failed') return 'Failed';
  if (node.health === 'degraded' || node.status === 'degraded') return 'Degraded';
  if (node.status === 'online') return 'Online';
  if (node.status === 'offline') return 'Offline';
  return undefined;
}

export function instanceStateLabel(instance: InstanceState) {
  if (instance.health === 'failed' || instance.status === 'failed') return 'Failed';
  if (instance.health === 'degraded' || instance.status === 'unhealthy') return 'Needs attention';
  if (instance.connectionStatus === 'endpoint-unreachable') return 'Unreachable';
  if (instance.connectionStatus === 'offline') return 'Offline';
  switch (instance.status) {
    case 'provisioning': return 'Provisioning';
    case 'starting': return 'Starting';
    case 'registering': return 'Connecting';
    case 'stopping': return 'Stopping';
    case 'deleting': return 'Deleting';
    case 'stopped': return 'Stopped';
    case 'created': return 'Created';
    case 'registered': return 'Ready';
    case 'running': return instance.connectionStatus === 'online' ? 'Running' : 'Running';
  }
}

export function aiSessionSummary(summary: AiSummary) {
  const parts = [
    summary.runningCount ? `${summary.runningCount} active` : undefined,
    summary.waitingCount ? `${summary.waitingCount} waiting` : undefined,
    summary.problemCount ? `${summary.problemCount} ${summary.problemCount === 1 ? 'issue' : 'issues'}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join(' · ');
}

export function connectionModeLabel(mode: ControlPlaneNodeDirectoryEntry['connectionMode']) {
  return ({
    'local-ipc': 'Local',
    'local-loopback': 'Local',
    'direct-http': 'Direct',
    'reverse-wss': 'Remote',
    'control-plane-proxy': 'Proxy',
  } as const)[mode];
}

export function relativeObservedAt(value: string | number, now = Date.now()) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Seen recently';
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return 'Seen just now';
  if (elapsed < 60 * 60_000) return `Seen ${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 24 * 60 * 60_000) return `Seen ${Math.floor(elapsed / (60 * 60_000))}h ago`;
  const days = Math.floor(elapsed / (24 * 60 * 60_000));
  return days === 1 ? 'Seen yesterday' : `Seen ${days}d ago`;
}
