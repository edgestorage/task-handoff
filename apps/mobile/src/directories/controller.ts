import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import { ControlPlaneInstanceLifecycleDirectoryEventSchema, ControlPlaneNodeConnectionPhaseSchema, ControlPlaneNodeFleetStateSchema } from '@task-handoff/protocol/control-plane-directory';
import type { ControlPlaneInstanceAction } from '@task-handoff/protocol/control-plane-directory';
import { safeParseResponse } from '@task-handoff/protocol/response-validation';
import { z } from 'zod';

import { MobileDirectoryStore } from './store';
import { MobileControlPlaneTransportError } from '../control-plane/transport';
import type { MobileControlPlaneEvent, MobileControlPlaneEventConnection, MobileControlPlaneTransport } from '../control-plane/transport';
import { MobileReconnectBackoff } from '../platform/reconnect';

const NodeConnectionObservationSchema = z.object({
  nodeId: z.string().trim().min(1).max(160),
  phase: ControlPlaneNodeConnectionPhaseSchema,
  changedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().optional(),
}).strip();
const INSTANCE_LIFECYCLE_SNAPSHOT_EVENT = 'instance.lifecycle.snapshot';

export class MobileDirectoryController {
  private epoch = 0;
  private readonly storeGeneration: number;
  private connection?: MobileControlPlaneEventConnection;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private refreshInFlight?: Promise<void>;
  private refreshQueued = false;
  private activeSignal?: AbortSignal;
  private readonly reconnectBackoff = new MobileReconnectBackoff();
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly controlPlaneId: string,
    private readonly client: ControlPlaneClient,
    private readonly store: MobileDirectoryStore,
    private readonly transport?: MobileControlPlaneTransport,
  ) {
    this.storeGeneration = store.generation(controlPlaneId);
  }

  async start(signal?: AbortSignal, options: { managed?: boolean } = {}) {
    if (!this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return false;
    const epoch = ++this.epoch;
    this.activeSignal = signal;
    const current = this.store.profile(this.controlPlaneId);
    this.store.set(this.controlPlaneId, {
      phase: current.nodes.length || current.instances.length ? 'stale' : 'loading',
      error: undefined,
    });
    try {
      if (!options.managed) await this.transport?.revalidate?.();
      if (epoch !== this.epoch || !this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return false;
      const nodesPromise = this.client.resources.nodes(signal).then((nodes) => {
        if (epoch === this.epoch && this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) {
          this.store.set(this.controlPlaneId, { nodes });
        }
        return nodes;
      });
      const directoryPromise = this.instanceDirectory(signal);
      const [nodes, directory] = await Promise.all([nodesPromise, directoryPromise]);
      if (epoch !== this.epoch || !this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return false;
      this.store.set(this.controlPlaneId, {
        nodes,
        instances: directory.data,
        nodeStates: directory.meta?.nodeStates || [],
        phase: directoryPhase(directory.meta?.nodeStates || [], directory.data.length),
        updatedAt: new Date().toISOString(),
        error: undefined,
      });
      this.reconnectBackoff.reset();
      if (!options.managed) this.connectEvents(epoch);
      return true;
    } catch (cause) {
      if (epoch !== this.epoch || !this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return false;
      const latest = this.store.profile(this.controlPlaneId);
      this.store.set(this.controlPlaneId, {
        phase: latest.nodes.length || latest.instances.length ? 'stale' : 'error',
        error: cause instanceof Error ? cause.message : 'Directory unavailable.',
      });
      if (!options.managed && this.transport) this.scheduleReconnect(epoch);
      throw cause;
    }
  }

  async updateInstanceName(instanceId: string, name: string) {
    const updated = await this.client.resources.updateInstanceName(instanceId, name);
    if (this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) {
      this.store.setInstanceName(this.controlPlaneId, updated.id, updated.name);
      void this.requestRefresh().catch(() => undefined);
    }
    return updated;
  }

  async updateNodeName(nodeId: string, name: string) {
    const updated = await this.client.resources.updateNodeName(nodeId, name);
    if (this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) {
      this.store.setNodeName(this.controlPlaneId, updated.id, updated.name);
      void this.requestRefresh().catch(() => undefined);
    }
    return updated;
  }

  async runInstanceAction(instanceId: string, action: ControlPlaneInstanceAction) {
    const instance = this.store.profile(this.controlPlaneId).instances.find((candidate) => candidate.id === instanceId);
    if (!instance) throw new Error(`Instance ${instanceId} is not in the current directory snapshot.`);
    if (!instance.availableActions.includes(action)) throw new Error(`Instance action ${action} is not currently available.`);
    const result = await this.client.resources.instanceAction(instanceId, action);
    await this.requestRefresh();
    return result;
  }

  async refresh() {
    try {
      await this.requestRefresh();
    } catch (cause) {
      if (this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) {
        const current = this.store.profile(this.controlPlaneId);
        this.store.set(this.controlPlaneId, {
          phase: current.nodes.length || current.instances.length ? 'stale' : 'error',
          error: cause instanceof Error ? cause.message : 'Directory unavailable.',
        });
      }
      throw cause;
    }
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

  onConnectionError(error?: MobileControlPlaneTransportError) {
    if (!this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return;
    const current = this.store.profile(this.controlPlaneId);
    this.store.set(this.controlPlaneId, {
      phase: current.nodes.length || current.instances.length ? 'stale' : 'error',
      ...(error ? { error: error.message } : {}),
    });
  }

  stop() {
    this.epoch += 1;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.refreshTimer = undefined;
    this.reconnectTimer = undefined;
    this.reconnectBackoff.reset();
    this.refreshQueued = false;
    this.activeSignal = undefined;
    this.connection?.close();
    this.connection = undefined;
  }

  private connectEvents(epoch: number) {
    if (!this.transport || epoch !== this.epoch) return;
    this.connection?.close();
    this.connection = this.transport.connectEvents({
      onOpen: () => undefined,
      onEvent: (event) => { if (epoch === this.epoch) this.applyEvent(event); },
      onError: (cause) => {
        if (epoch !== this.epoch) return;
        const current = this.store.profile(this.controlPlaneId);
        this.store.set(this.controlPlaneId, { phase: current.nodes.length || current.instances.length ? 'stale' : 'error', error: cause.message });
        this.scheduleReconnect(epoch);
      },
      onClose: () => {
        if (epoch !== this.epoch) return;
        const current = this.store.profile(this.controlPlaneId);
        this.store.set(this.controlPlaneId, { phase: current.nodes.length || current.instances.length ? 'stale' : 'error' });
        this.scheduleReconnect(epoch);
      },
    });
  }

  applyEvent(event: MobileControlPlaneEvent) {
    if (event.type === 'node.connection.updated') {
      const parsed = safeParseResponse(NodeConnectionObservationSchema, event.payload);
      if (!parsed.success || event.scope?.nodeId !== parsed.data.nodeId) return false;
      this.store.setNodeConnection(this.controlPlaneId, parsed.data.nodeId, parsed.data.phase, parsed.data.changedAt, parsed.data.lastSeenAt);
      return true;
    }
    if (event.type === INSTANCE_LIFECYCLE_SNAPSHOT_EVENT) {
      const parsed = safeParseResponse(ControlPlaneInstanceLifecycleDirectoryEventSchema, event.payload);
      if (!parsed.success || event.scope?.instanceId !== parsed.data.instanceId) return false;
      const applied = this.store.applyInstanceLifecycle(this.controlPlaneId, parsed.data);
      if (applied) this.scheduleRefresh();
      return applied;
    }
    if (event.type === 'node.fleet.updated') {
      const parsed = safeParseResponse(ControlPlaneNodeFleetStateSchema, event.payload);
      if (!parsed.success || event.scope?.nodeId !== parsed.data.nodeId) return false;
      const current = this.store.profile(this.controlPlaneId);
      const previous = current.nodeStates.find((state) => state.nodeId === parsed.data.nodeId && state.resource === parsed.data.resource);
      if (previous?.revision !== undefined && parsed.data.revision !== undefined && previous.revision >= parsed.data.revision) return false;
      this.store.set(this.controlPlaneId, {
        nodeStates: [...current.nodeStates.filter((state) => state.nodeId !== parsed.data.nodeId || state.resource !== parsed.data.resource), parsed.data],
      });
      this.scheduleRefresh();
      return true;
    }
    if (event.topic === 'nodes' || event.topic === 'node.state' || event.topic === 'instances') {
      this.scheduleRefresh();
      return true;
    }
    return false;
  }

  private scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.requestRefresh().catch(() => undefined);
    }, 100);
  }

  private requestRefresh() {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }
    const epoch = this.epoch;
    const refresh = this.refreshDirectories(epoch, this.activeSignal).finally(() => {
      if (this.refreshInFlight !== refresh) return;
      this.refreshInFlight = undefined;
      if (!this.refreshQueued || epoch !== this.epoch) return;
      this.refreshQueued = false;
      void this.requestRefresh().catch(() => undefined);
    });
    this.refreshInFlight = refresh;
    return refresh;
  }

  private async refreshDirectories(epoch: number, signal?: AbortSignal) {
    const nodesPromise = this.client.resources.nodes(signal).then((nodes) => {
      if (!signal?.aborted && epoch === this.epoch && this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) {
        this.store.set(this.controlPlaneId, { nodes });
      }
      return nodes;
    });
    const [nodes, directory] = await Promise.all([nodesPromise, this.instanceDirectory(signal)]);
    if (signal?.aborted || epoch !== this.epoch || !this.store.isGeneration(this.controlPlaneId, this.storeGeneration)) return;
    this.store.set(this.controlPlaneId, {
      nodes,
      instances: directory.data,
      nodeStates: directory.meta?.nodeStates || [],
      phase: directoryPhase(directory.meta?.nodeStates || [], directory.data.length),
      updatedAt: new Date().toISOString(),
      error: undefined,
    });
  }

  private async instanceDirectory(signal?: AbortSignal) {
    const progressive = this.client.resources.instanceDirectory;
    if (typeof progressive !== 'function') {
      return { data: await this.client.resources.instanceBoard(signal), meta: undefined };
    }
    try {
      return await progressive(signal);
    } catch (cause) {
      // Compatibility for v0.0.21: progressive directory query parameters are
      // rejected by its strict route schema, so retain its blocking snapshot.
      if (!(cause instanceof MobileControlPlaneTransportError) || cause.status !== 400) throw cause;
      return { data: await this.client.resources.instanceBoard(signal), meta: undefined };
    }
  }

  private scheduleReconnect(epoch: number) {
    if (this.reconnectTimer || epoch !== this.epoch) return;
    const { delay } = this.reconnectBackoff.next();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (epoch !== this.epoch) return;
      void this.start().catch(() => undefined);
    }, delay);
  }
}

function directoryPhase(states: readonly { resource: string; phase: string }[], instanceCount: number) {
  const instanceStates = states.filter((state) => state.resource === 'instances');
  if (instanceStates.some((state) => state.phase === 'error') && !instanceCount) return 'error' as const;
  if (instanceStates.some((state) => state.phase === 'stale' || state.phase === 'error')) return 'stale' as const;
  if (instanceStates.some((state) => state.phase === 'loading' || state.phase === 'uninitialized')) return instanceCount ? 'stale' as const : 'loading' as const;
  return 'ready' as const;
}
