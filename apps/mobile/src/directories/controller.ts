import type { ControlPlaneClient } from '@task-handoff/control-plane-client';

import { MobileDirectoryStore } from './store';
import type { MobileControlPlaneTransport } from '../control-plane/transport';

export class MobileDirectoryController {
  private epoch = 0;
  private readonly storeGeneration: number;

  constructor(
    private readonly controlPlaneId: string,
    private readonly client: ControlPlaneClient,
    private readonly store: MobileDirectoryStore,
    private readonly transport?: MobileControlPlaneTransport,
  ) {
    this.storeGeneration = store.generation(controlPlaneId);
  }

  async start() {
    if (!this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return false;
    const epoch = ++this.epoch;
    const current = this.store.profile(this.controlPlaneId);
    this.store.set(this.controlPlaneId, {
      phase: current.nodes.length || current.instances.length ? 'stale' : 'loading',
      error: undefined,
    });
    try {
      await this.transport?.revalidate?.();
      if (epoch !== this.epoch || !this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return false;
      const [nodes, instances] = await Promise.all([
        this.client.resources.nodes(),
        this.client.resources.instanceBoard(),
      ]);
      if (epoch !== this.epoch || !this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return false;
      this.store.set(this.controlPlaneId, {
        nodes,
        instances,
        phase: 'ready',
        updatedAt: new Date().toISOString(),
        error: undefined,
      });
      return true;
    } catch (cause) {
      if (epoch !== this.epoch || !this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return false;
      const latest = this.store.profile(this.controlPlaneId);
      this.store.set(this.controlPlaneId, {
        phase: latest.nodes.length || latest.instances.length ? 'stale' : 'error',
        error: cause instanceof Error ? cause.message : 'Directory unavailable.',
      });
      throw cause;
    }
  }

  async updateInstanceName(instanceId: string, name: string) {
    const updated = await this.client.resources.updateInstanceName(instanceId, name);
    if (this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) {
      this.store.setInstanceName(this.controlPlaneId, updated.id, updated.name);
      void this.start().catch(() => undefined);
    }
    return updated;
  }

  async updateNodeName(nodeId: string, name: string) {
    const updated = await this.client.resources.updateNodeName(nodeId, name);
    if (this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) {
      this.store.setNodeName(this.controlPlaneId, updated.id, updated.name);
      void this.start().catch(() => undefined);
    }
    return updated;
  }

  offline() {
    this.stop();
    if (!this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return;
    const current = this.store.profile(this.controlPlaneId);
    this.store.set(this.controlPlaneId, {
      phase: 'offline',
      error: undefined,
      nodes: current.nodes,
      instances: current.instances,
    });
  }

  stop() {
    this.epoch += 1;
  }
}
