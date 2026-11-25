import { readNodeStateProjection } from '../control-plane/node-state-event';
import type { MobileControlPlaneEvent } from '../control-plane/transport';

export class StoryNodeRecovery {
  private readonly nodes = new Map<string, { connectionEnabled?: boolean; online: boolean }>();

  apply(event: MobileControlPlaneEvent, ownerNodeId?: string) {
    const projection = readNodeStateProjection(event);
    if (!projection || (ownerNodeId && projection.nodeId !== ownerNodeId)) return false;
    const previous = this.nodes.get(projection.nodeId);
    const connectionEnabled = projection.connectionEnabled ?? previous?.connectionEnabled;
    const online = connectionEnabled !== false && projection.status === 'online';
    this.nodes.set(projection.nodeId, { connectionEnabled, online });
    return online && !previous?.online;
  }

  reset() { this.nodes.clear(); }
}
