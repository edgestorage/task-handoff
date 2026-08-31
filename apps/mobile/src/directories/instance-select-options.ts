import type { ControlPlaneInstanceDirectoryEntry, ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';

import type { AnchoredSelectOption } from '../components/AnchoredSelectMenu';

export function instanceSelectOptions(instances: readonly ControlPlaneInstanceDirectoryEntry[], nodes: readonly ControlPlaneNodeDirectoryEntry[]): AnchoredSelectOption[] {
  const nodeNames = new Map(nodes.map((node) => [node.id, node.name]));
  const grouped = new Map<string, ControlPlaneInstanceDirectoryEntry[]>();
  for (const instance of instances) {
    const key = instance.nodeId;
    const items = grouped.get(key) || [];
    items.push(instance);
    grouped.set(key, items);
  }
  return [...grouped.entries()].flatMap(([nodeId, items]) => items.map((instance) => ({
    groupLabel: nodeNames.get(nodeId) || nodeId,
    label: instance.name,
    systemImage: 'server.rack' as const,
    value: instance.id,
  })));
}
