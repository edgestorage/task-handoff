import type { ControlPlaneInstanceDirectoryEntry, ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';

import type { AnchoredSelectOption } from '../components/AnchoredSelectMenu';

export function instanceSelectOptions(instances: readonly ControlPlaneInstanceDirectoryEntry[], nodes: readonly ControlPlaneNodeDirectoryEntry[]): AnchoredSelectOption[] {
  const nodeNames = new Map(nodes.map((node) => [node.id, node.name]));
  return instances.map((instance) => ({ label: instance.name, description: nodeNames.get(instance.nodeId) || instance.nodeId, systemImage: 'server.rack', value: instance.id }));
}
