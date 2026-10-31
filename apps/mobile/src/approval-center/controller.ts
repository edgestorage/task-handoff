import {
  aiSessionApprovalItems,
  applyApprovalCenterStoryDecision,
  deviceTrustApprovalItems,
  mergeApprovalCenterItems,
  nodeControlPlaneTrustApprovalItems,
  operationApprovalItems,
  storyDecisionApprovalItems,
  type ApprovalCenterItem,
  type ApprovalCenterSource,
  type ApprovalCenterSourceHealth,
  type ApprovalCenterSourcePhase,
  type ControlPlaneClient,
  type ControlPlaneInstanceResourceEntry,
  type NodeControlPlaneTrustSourceEntry,
  type StoryDecisionSourceEntry,
} from '@task-handoff/control-plane-client';
import {
  ApprovalChangedEventSchema,
  type ApprovalRequest,
} from '@task-handoff/protocol/operation-approvals';
import {
  CloudDeviceTrustChangedEventSchema,
  type CloudDeviceTrustSnapshot,
} from '@task-handoff/protocol/device-trust';
import {
  StoryDecisionChangedEventSchema,
  type StoryDecision,
} from '@task-handoff/protocol/stories';
import {
  nodeAgentCapabilitiesFromPublicNode,
  nodeStoryAgentToolCapabilities,
  supportsNodeControlPlaneTrust,
} from '@task-handoff/protocol/node-agent-capabilities';
import type { ControlPlaneNodeDirectoryEntry } from '@task-handoff/protocol/control-plane-directory';
import type { MobileAiSessionProfileState } from '../ai-sessions/store';
import { isStoryDecisionResumePending } from '../stories/story-decision';
import type { MobileControlPlaneEvent } from '../control-plane/transport';
import { MobileControlPlaneTransportError } from '../control-plane/transport';
import { mobileMetrics } from '../observability/mobile-metrics';

const STORY_REFRESH_DEBOUNCE_MS = 100;
const NODE_TRUST_REFRESH_DEBOUNCE_MS = 100;

export type ApprovalCenterActionState = {
  phase: 'idle' | 'busy' | 'failed' | 'result-unknown';
  error?: 'REQUEST_FAILED' | 'REQUEST_RESULT_UNKNOWN' | 'SOURCE_UNAVAILABLE' | 'STORY_RETRY_REQUIRED' | 'OFFLINE';
};

export type ApprovalCenterSourceState = {
  items: readonly ApprovalCenterItem[];
  health: ApprovalCenterSourceHealth;
};

export type MobileApprovalCenterState = {
  items: readonly ApprovalCenterItem[];
  sources: Readonly<Record<ApprovalCenterSource, ApprovalCenterSourceState>>;
  actions: Readonly<Record<string, ApprovalCenterActionState>>;
};

type DirectoryProjection = {
  nodes: readonly ControlPlaneNodeDirectoryEntry[];
  instances: readonly ControlPlaneInstanceResourceEntry[];
};

type ControllerOptions = {
  aiSessions: () => MobileAiSessionProfileState;
  directory: () => DirectoryProjection;
  supportsAiSessions: boolean;
  supportsStories: boolean;
  supportsNodes: boolean;
};

type Listener = () => void;
type NodeControlPlaneTrustSnapshot = NodeControlPlaneTrustSourceEntry['snapshot'];

const SOURCES: readonly ApprovalCenterSource[] = [
  'ai-session-approval',
  'story-decision',
  'operation-approval',
  'device-trust',
  'node-control-plane-trust',
];

export class MobileApprovalCenterController {
  private readonly listeners = new Set<Listener>();
  private readonly sourceItems = new Map<ApprovalCenterSource, readonly ApprovalCenterItem[]>();
  private readonly sourceHealth = new Map<ApprovalCenterSource, ApprovalCenterSourceHealth>();
  private readonly actionStates = new Map<string, ApprovalCenterActionState>();
  private readonly storyEntries = new Map<string, StoryDecisionSourceEntry>();
  private readonly nodeSnapshots = new Map<string, NodeControlPlaneTrustSnapshot>();
  private operationRequests = new Map<string, ApprovalRequest>();
  private operationRevision = -1;
  private onlineConnection = true;
  private deviceSnapshot?: CloudDeviceTrustSnapshot;
  private abortController?: AbortController;
  private epoch = 0;
  private storyRefreshTimer?: ReturnType<typeof setTimeout>;
  private nodeRefreshTimer?: ReturnType<typeof setTimeout>;
  private snapshotValue: MobileApprovalCenterState;

  constructor(
    readonly controlPlaneId: string,
    private readonly client: ControlPlaneClient,
    private readonly options: ControllerOptions,
  ) {
    for (const source of SOURCES) {
      this.sourceItems.set(source, []);
      this.sourceHealth.set(source, this.health(source, 'idle', 0, false));
    }
    this.snapshotValue = this.buildSnapshot();
    this.syncAiSessions();
  }

  snapshot = () => this.snapshotValue;

  setOnline(online: boolean) {
    this.onlineConnection = online;
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  actionState(key: string) {
    return this.actionStates.get(key) ?? { phase: 'idle' as const };
  }

  async start(signal: AbortSignal) {
    const epoch = ++this.epoch;
    this.abortController?.abort();
    const abort = new AbortController();
    this.abortController = abort;
    this.actionStates.clear();
    const forwardAbort = () => abort.abort(signal.reason);
    if (signal.aborted) forwardAbort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
    try {
      for (const source of SOURCES) {
        if (!this.sourceEnabled(source)) {
          this.setSource(source, [], 'idle', false, { preserveLoadedAt: true });
        } else if (!this.sourceItems.get(source)?.length) {
          this.setLoading(source);
        }
      }
      this.syncAiSessions();
      const tasks: Promise<unknown>[] = [];
      if (this.options.supportsStories) tasks.push(this.refreshStories(epoch, abort.signal));
      tasks.push(this.refreshOperationApprovals(epoch, abort.signal));
      tasks.push(this.refreshDeviceTrust(epoch, abort.signal));
      if (this.options.supportsNodes) tasks.push(this.refreshNodeTrust(epoch, abort.signal));
      await Promise.allSettled(tasks);
    } finally {
      signal.removeEventListener('abort', forwardAbort);
    }
  }

  stop() {
    this.epoch += 1;
    this.abortController?.abort();
    this.abortController = undefined;
    this.clearRefreshTimers();
  }

  offline() {
    this.abortController?.abort();
    for (const source of SOURCES) {
      const current = this.sourceHealth.get(source);
      if (!current || current.phase === 'idle') continue;
      this.setHealth(source, current.phase === 'ready' ? 'stale' : current.phase);
    }
    for (const item of this.snapshotValue.items) {
      this.actionStates.set(item.key, { phase: 'failed', error: 'OFFLINE' });
    }
    this.publish();
  }

  onConnectionError() {
    for (const source of SOURCES) {
      const current = this.sourceHealth.get(source);
      if (current && (current.phase === 'ready' || current.phase === 'loading')) this.setHealth(source, 'stale');
    }
  }

  /** Re-map directory-derived labels without replacing authoritative approval state. */
  syncDirectory() {
    this.syncAiSessions();
    if (this.operationRequests.size) this.updateOperationItems();
    if (this.nodeSnapshots.size) {
      const current = this.sourceHealth.get('node-control-plane-trust');
      const phase = current?.phase === 'stale' || current?.phase === 'unavailable' ? current.phase : 'ready';
      this.updateNodeItems(phase, current?.diagnostic);
    }
  }

  syncAiSessions() {
    const source: ApprovalCenterSource = 'ai-session-approval';
    if (!this.options.supportsAiSessions) {
      this.setSource(source, [], 'idle', false);
      return;
    }
    const ai = this.options.aiSessions();
    const directory = this.options.directory();
    const items = ai.snapshot?.instances.flatMap((snapshot) => {
      const instance = directory.instances.find((candidate) => candidate.id === snapshot.instanceId);
      return instance ? [{
        instanceId: snapshot.instanceId,
        instanceName: instance.name,
        capabilities: instance.capabilities,
        aiSessions: snapshot.aiSessions,
      }] : [];
    }) ?? [];
    const hasSnapshot = Boolean(ai.snapshot);
    this.setSource(
      source,
      hasSnapshot ? aiSessionApprovalItems(this.controlPlaneId, items) : [],
      hasSnapshot ? ai.sync.phase === 'ready' ? 'ready' : 'stale' : ai.sync.phase === 'error' ? 'unavailable' : 'loading',
      true,
      { loadedAt: hasSnapshot ? ai.sync.lastSyncedAt : undefined },
    );
  }

  applyEvent(event: MobileControlPlaneEvent) {
    if (event.type === 'operation-approval.changed') {
      const parsed = ApprovalChangedEventSchema.safeParse(event.payload);
      if (!parsed.success || parsed.data.revision <= this.operationRevision) return;
      this.operationRevision = parsed.data.revision;
      if (parsed.data.status === 'pending') this.operationRequests.set(parsed.data.request.id, parsed.data.request);
      else this.operationRequests.delete(parsed.data.request.id);
      this.updateOperationItems();
      return;
    }
    if (event.type === 'device-trust.changed') {
      const parsed = CloudDeviceTrustChangedEventSchema.safeParse(event.payload);
      if (parsed.success && parsed.data.revision > (this.deviceSnapshot?.revision ?? -1)) {
        void this.refreshDeviceTrust(this.epoch, this.abortController?.signal);
      }
      return;
    }
    if (event.type === 'story.decision.changed') {
      const parsed = StoryDecisionChangedEventSchema.safeParse(event.payload);
      if (!parsed.success) return;
      if (parsed.data.decision) {
        this.applyStoryDecisionEvent(parsed.data.storyId, parsed.data.decision);
      } else {
        this.scheduleStoryRefresh(parsed.data.storyId);
      }
      return;
    }
    if (event.type === 'node.control-plane-trust.changed') {
      const nodeId = event.payload && typeof event.payload === 'object' && 'nodeId' in event.payload
        ? String((event.payload as { nodeId?: unknown }).nodeId ?? '')
        : '';
      if (nodeId) this.scheduleNodeRefresh(nodeId);
      return;
    }
    if (event.topic === 'nodes' || event.topic === 'node.state' || event.type.startsWith('node.')) {
      this.scheduleNodeRefresh();
    }
  }

  async retry(source?: ApprovalCenterSource) {
    const epoch = this.epoch;
    const signal = this.abortController?.signal;
    if (source === 'ai-session-approval') {
      this.syncAiSessions();
      return;
    }
    if (source === 'story-decision') await this.refreshStories(epoch, signal);
    else if (source === 'operation-approval') await this.refreshOperationApprovals(epoch, signal);
    else if (source === 'device-trust') await this.refreshDeviceTrust(epoch, signal);
    else if (source === 'node-control-plane-trust') await this.refreshNodeTrust(epoch, signal);
    else await Promise.allSettled([
      this.refreshStories(epoch, signal),
      this.refreshOperationApprovals(epoch, signal),
      this.refreshDeviceTrust(epoch, signal),
      this.refreshNodeTrust(epoch, signal),
    ]);
  }

  async decide(
    item: ApprovalCenterItem,
    input: { decision?: string; optionId?: string; response?: string; retry?: boolean },
  ) {
    const current = this.actionState(item.key);
    if (current.phase === 'busy') return;
    if (!this.onlineConnection) {
      this.actionStates.set(item.key, { phase: 'failed', error: 'OFFLINE' });
      this.publish();
      return;
    }
    if (this.sourceHealth.get(item.type)?.phase !== 'ready') {
      this.actionStates.set(item.key, { phase: 'failed', error: 'SOURCE_UNAVAILABLE' });
      this.publish();
      return;
    }
    this.actionStates.set(item.key, { phase: 'busy' });
    mobileMetrics.record('mobile-approval-center.decision', { action: item.type, result: 'submitted' });
    this.publish();
    try {
      const waitForAuthority = await this.submit(item, input);
      if (!waitForAuthority || !this.snapshotValue.items.some((candidate) => candidate.key === item.key)) {
        this.actionStates.delete(item.key);
      }
      mobileMetrics.record('mobile-approval-center.decision', { action: item.type, result: 'acknowledged' });
      this.publish();
    } catch (cause) {
      const unknown = cause instanceof MobileControlPlaneTransportError && cause.retryable;
      const retryStory = item.type === 'story-decision' && isStoryDecisionResumePending(cause);
      const conflict = cause instanceof MobileControlPlaneTransportError && cause.status === 409;
      this.actionStates.set(item.key, {
        phase: unknown ? 'result-unknown' : 'failed',
        error: retryStory ? 'STORY_RETRY_REQUIRED' : unknown ? 'REQUEST_RESULT_UNKNOWN' : 'REQUEST_FAILED',
      });
      mobileMetrics.record('mobile-approval-center.decision', {
        action: item.type,
        result: unknown ? 'unknown' : 'failed',
      });
      if (conflict) void this.retry(item.type);
      this.publish();
    }
  }

  private async submit(
    item: ApprovalCenterItem,
    input: { decision?: string; optionId?: string; response?: string; retry?: boolean },
  ): Promise<boolean> {
    switch (item.type) {
      case 'ai-session-approval': {
        if (input.decision !== 'allow' && input.decision !== 'deny' && input.decision !== 'skip') throw new Error('Unsupported approval decision.');
        await this.client.aiSessions.approval(item.instanceId, item.session.id, input.decision);
        this.syncAiSessions();
        return true;
      }
      case 'story-decision': {
        const updated = await this.client.stories.decideStory(item.story.id, item.decision.id, item.story.ownerNodeId, {
          expectedRevision: item.decision.revision,
          ...(input.optionId ? { optionId: input.optionId } : {}),
          ...(input.response ? { response: input.response } : {}),
          ...(input.retry ? { retry: true } : {}),
        });
        this.applyStoryDecisionEvent(item.story.id, updated);
        return false;
      }
      case 'operation-approval': {
        if (input.decision !== 'approve' && input.decision !== 'deny') throw new Error('Unsupported operation approval decision.');
        const result = await this.client.approvals.decide(item.request.id, input.decision);
        void result;
        this.operationRequests.delete(item.request.id);
        this.updateOperationItems();
        return false;
      }
      case 'device-trust': {
        if (input.decision !== 'approve' && input.decision !== 'reject') throw new Error('Unsupported device trust decision.');
        const snapshot = await this.client.deviceTrust.decide(item.request.requestId, {
          decision: input.decision,
          expectedFingerprint: item.request.fingerprint,
          expectedRevision: item.request.revision,
        });
        this.applyDeviceSnapshot(snapshot);
        return false;
      }
      case 'node-control-plane-trust': {
        if (input.decision !== 'approve' && input.decision !== 'reject') throw new Error('Unsupported node trust decision.');
        const current = await this.client.nodeAdmin.listControlPlaneTrust(item.nodeId);
        this.applyNodeSnapshot(item.nodeId, current);
        const request = current.requests.find((candidate) => candidate.requestId === item.request.requestId && candidate.status === 'pending');
        if (!request) return false;
        const snapshot = await this.client.nodeAdmin.decideControlPlaneTrust(item.nodeId, request.requestId, {
          action: input.decision,
          expectedFingerprint: request.fingerprint,
          expectedRevision: request.revision,
        });
        this.applyNodeSnapshot(item.nodeId, snapshot);
        return false;
      }
    }
  }

  private async refreshStories(epoch: number, signal?: AbortSignal) {
    const source: ApprovalCenterSource = 'story-decision';
    if (!this.options.supportsStories) {
      this.setSource(source, [], 'idle', false);
      return;
    }
    try {
      const result = await this.client.stories.list(undefined, signal);
      if (!this.live(epoch, signal)) return;
      const currentStoryIds = new Set(result.stories.map((story) => story.id));
      for (const storyId of this.storyEntries.keys()) {
        if (!currentStoryIds.has(storyId)) this.storyEntries.delete(storyId);
      }
      for (const story of result.stories) {
        if (story.archivedAt) this.storyEntries.delete(story.id);
      }
      const ownerIds = [...new Set(result.stories.filter((story) => !story.archivedAt).map((story) => story.ownerNodeId))];
      const capabilityReads = await Promise.allSettled(ownerIds.map(async (nodeId) => ({
        nodeId,
        node: await this.client.resources.node(nodeId, signal),
      })));
      const supportedNodeIds = new Set<string>();
      const unsupportedNodeIds = new Set<string>();
      let partial = result.unavailableNodeIds.length > 0;
      capabilityReads.forEach((read) => {
        if (read.status === 'rejected') partial = true;
        else if (supportsDecisionTools(read.value.node.capabilities)) supportedNodeIds.add(read.value.nodeId);
        else unsupportedNodeIds.add(read.value.nodeId);
      });
      const eligible = result.stories.filter((story) => !story.archivedAt && supportedNodeIds.has(story.ownerNodeId));
      const storiesToDelete = result.stories.filter((story) => story.archivedAt || unsupportedNodeIds.has(story.ownerNodeId));
      for (const story of storiesToDelete) this.storyEntries.delete(story.id);
      const decisionReads = await Promise.allSettled(eligible.map(async (story) => ({
        story,
        decisions: (await this.client.stories.listDecisions(story.id, story.ownerNodeId, signal)).decisions,
      })));
      if (!this.live(epoch, signal)) return;
      decisionReads.forEach((read) => {
        if (read.status === 'fulfilled') this.storyEntries.set(read.value.story.id, read.value);
        else partial = true;
      });
      this.updateStoryItems(partial ? 'stale' : 'ready', partial ? 'SOURCE_PARTIAL' : undefined);
    } catch (cause) {
      if (!this.live(epoch, signal)) return;
      this.markUnavailable(source, cause);
    }
  }

  private async refreshStory(storyId: string, epoch: number, signal?: AbortSignal) {
    const existing = this.storyEntries.get(storyId);
    if (!existing) {
      await this.refreshStories(epoch, signal);
      return;
    }
    try {
      const decisions = (await this.client.stories.listDecisions(storyId, existing.story.ownerNodeId, signal)).decisions;
      if (!this.live(epoch, signal)) return;
      this.storyEntries.set(storyId, { story: existing.story, decisions });
      this.updateStoryItems('ready');
    } catch (cause) {
      if (!this.live(epoch, signal)) return;
      this.markUnavailable('story-decision', cause);
    }
  }

  private async refreshOperationApprovals(epoch: number, signal?: AbortSignal) {
    const source: ApprovalCenterSource = 'operation-approval';
    try {
      const snapshot = await this.client.approvals.snapshot();
      if (!this.live(epoch, signal)) return;
      if (snapshot.revision >= this.operationRevision) {
        this.operationRevision = snapshot.revision;
        this.operationRequests = new Map(snapshot.requests.map((request) => [request.id, request]));
        this.updateOperationItems();
      }
      this.setHealth(source, 'ready');
    } catch (cause) {
      if (!this.live(epoch, signal)) return;
      this.markUnavailable(source, cause);
    }
  }

  private async refreshDeviceTrust(epoch: number, signal?: AbortSignal) {
    const source: ApprovalCenterSource = 'device-trust';
    try {
      const snapshot = await this.client.deviceTrust.snapshot();
      if (!this.live(epoch, signal)) return;
      this.applyDeviceSnapshot(snapshot);
    } catch (cause) {
      if (!this.live(epoch, signal)) return;
      this.markUnavailable(source, cause);
    }
  }

  private async refreshNodeTrust(epoch: number, signal?: AbortSignal, onlyNodeId?: string) {
    const source: ApprovalCenterSource = 'node-control-plane-trust';
    if (!this.options.supportsNodes) {
      this.setSource(source, [], 'idle', false);
      return;
    }
    const onlineNodes = this.options.directory().nodes.filter((node) => node.status === 'online');
    const onlineIds = new Set(onlineNodes.map((node) => node.id));
    for (const nodeId of this.nodeSnapshots.keys()) {
      if (!onlineIds.has(nodeId)) this.nodeSnapshots.delete(nodeId);
    }
    const targets = onlyNodeId
      ? onlineNodes.filter((node) => node.id === onlyNodeId)
      : onlineNodes;
    if (!targets.length) {
      this.updateNodeItems('ready');
      return;
    }
    const reads = await Promise.allSettled(targets.map(async (node) => {
      const detail = await this.client.resources.node(node.id, signal);
      if (!supportsNodeControlPlaneTrust(nodeAgentCapabilitiesFromPublicNode(detail.capabilities))) return { nodeId: node.id, supported: false as const };
      return {
        nodeId: node.id,
        supported: true as const,
        snapshot: await this.client.nodeAdmin.listControlPlaneTrust(node.id, signal),
      };
    }));
    if (!this.live(epoch, signal)) return;
    let partial = false;
    reads.forEach((read) => {
      if (read.status === 'rejected') {
        partial = true;
        return;
      }
      if (!read.value.supported) {
        this.nodeSnapshots.delete(read.value.nodeId);
        return;
      }
      this.nodeSnapshots.set(read.value.nodeId, read.value.snapshot);
    });
    this.updateNodeItems(partial ? 'stale' : 'ready', partial ? 'SOURCE_PARTIAL' : undefined);
  }

  private applyDeviceSnapshot(snapshot: CloudDeviceTrustSnapshot) {
    if (snapshot.revision < (this.deviceSnapshot?.revision ?? -1)) return;
    this.deviceSnapshot = snapshot;
    this.setSource(
      'device-trust',
      deviceTrustApprovalItems(this.controlPlaneId, snapshot),
      'ready',
      true,
      { loadedAt: new Date().toISOString() },
    );
  }

  private applyNodeSnapshot(nodeId: string, snapshot: NodeControlPlaneTrustSnapshot) {
    this.nodeSnapshots.set(nodeId, snapshot);
    const current = this.sourceHealth.get('node-control-plane-trust');
    const phase = current?.phase === 'stale' || current?.phase === 'unavailable' ? current.phase : 'ready';
    this.updateNodeItems(phase, current?.diagnostic);
  }

  private updateOperationItems() {
    this.setSource(
      'operation-approval',
      operationApprovalItems(this.controlPlaneId, [...this.operationRequests.values()]).map((item) => ({
        ...item,
        targetName: this.approvalTargetName(item.request.targetId),
      })),
      this.sourceHealth.get('operation-approval')?.phase === 'unavailable' ? 'stale' : 'ready',
      true,
      { loadedAt: new Date().toISOString() },
    );
  }

  private updateStoryItems(phase: ApprovalCenterSourcePhase, diagnostic?: string) {
    this.setSource(
      'story-decision',
      storyDecisionApprovalItems(this.controlPlaneId, [...this.storyEntries.values()]),
      phase,
      true,
      { loadedAt: new Date().toISOString(), diagnostic },
    );
  }

  private updateNodeItems(phase: ApprovalCenterSourcePhase, diagnostic?: string) {
    this.setSource(
      'node-control-plane-trust',
      nodeControlPlaneTrustApprovalItems(this.controlPlaneId, [...this.nodeSnapshots.entries()].map(([nodeId, snapshot]) => ({ nodeId, snapshot }))).map((item) => ({
        ...item,
        nodeName: this.options.directory().nodes.find((node) => node.id === item.nodeId)?.name,
      })),
      phase,
      true,
      { loadedAt: new Date().toISOString(), diagnostic },
    );
  }

  private approvalTargetName(targetId: string) {
    const directory = this.options.directory();
    return directory.nodes.find((node) => node.id === targetId)?.name
      ?? directory.instances.find((instance) => instance.id === targetId)?.name;
  }

  private applyStoryDecisionEvent(storyId: string, decision: StoryDecision) {
    const existing = this.storyEntries.get(storyId);
    if (!existing) {
      this.scheduleStoryRefresh(storyId);
      return;
    }
    const current = existing.decisions.find((candidate) => candidate.id === decision.id);
    if (current && current.revision > decision.revision) return;
    const next = existing.decisions.some((candidate) => candidate.id === decision.id)
      ? existing.decisions.map((candidate) => candidate.id === decision.id ? decision : candidate)
      : [...existing.decisions, decision];
    this.storyEntries.set(storyId, { story: existing.story, decisions: next });
    const sourceState = this.snapshotValue.sources['story-decision'];
    const nextItems = applyApprovalCenterStoryDecision(sourceState.items, decision);
    const phase = sourceState.health.phase === 'stale' || sourceState.health.phase === 'unavailable' ? sourceState.health.phase : 'ready';
    this.setSource('story-decision', nextItems, phase, true, {
      loadedAt: new Date().toISOString(),
      ...(sourceState.health.diagnostic ? { diagnostic: sourceState.health.diagnostic } : {}),
    });
  }

  private scheduleStoryRefresh(storyId?: string) {
    if (this.storyRefreshTimer) clearTimeout(this.storyRefreshTimer);
    this.storyRefreshTimer = setTimeout(() => {
      this.storyRefreshTimer = undefined;
      const epoch = this.epoch;
      const signal = this.abortController?.signal;
      void (storyId ? this.refreshStory(storyId, epoch, signal) : this.refreshStories(epoch, signal));
    }, STORY_REFRESH_DEBOUNCE_MS);
  }

  private scheduleNodeRefresh(nodeId?: string) {
    if (this.nodeRefreshTimer) clearTimeout(this.nodeRefreshTimer);
    this.nodeRefreshTimer = setTimeout(() => {
      this.nodeRefreshTimer = undefined;
      const epoch = this.epoch;
      const signal = this.abortController?.signal;
      void this.refreshNodeTrust(epoch, signal, nodeId);
    }, NODE_TRUST_REFRESH_DEBOUNCE_MS);
  }

  private markUnavailable(source: ApprovalCenterSource, _cause: unknown) {
    const current = this.sourceHealth.get(source);
    this.setSource(source, this.sourceItems.get(source) ?? [], current?.pendingCount ? 'stale' : 'unavailable', current?.retryable ?? true, {
      preserveLoadedAt: true,
      diagnostic: current?.pendingCount ? 'SOURCE_STALE' : 'SOURCE_UNAVAILABLE',
    });
  }

  private setLoading(source: ApprovalCenterSource) {
    this.setHealth(source, 'loading');
  }

  private setSource(
    source: ApprovalCenterSource,
    items: readonly ApprovalCenterItem[],
    phase: ApprovalCenterSourcePhase,
    retryable: boolean,
    options: { loadedAt?: string; preserveLoadedAt?: boolean; diagnostic?: string } = {},
  ) {
    this.sourceItems.set(source, items);
    this.pruneActionStates();
    const previous = this.sourceHealth.get(source);
    mobileMetrics.record('mobile-approval-center.source', { action: source, result: phase }, items.length);
    this.sourceHealth.set(source, {
      source,
      phase,
      pendingCount: items.length,
      lastLoadedAt: options.loadedAt ?? (options.preserveLoadedAt ? previous?.lastLoadedAt : undefined),
      retryable,
      ...(options.diagnostic ? { diagnostic: options.diagnostic } : {}),
    });
    this.publish();
  }

  private setHealth(source: ApprovalCenterSource, phase: ApprovalCenterSourcePhase) {
    const items = this.sourceItems.get(source) ?? [];
    const previous = this.sourceHealth.get(source);
    mobileMetrics.record('mobile-approval-center.source', { action: source, result: phase }, items.length);
    this.sourceHealth.set(source, {
      ...this.health(source, phase, items.length, previous?.retryable ?? true),
      ...(previous?.lastLoadedAt ? { lastLoadedAt: previous.lastLoadedAt } : {}),
      ...(previous?.diagnostic ? { diagnostic: previous.diagnostic } : {}),
    });
    this.publish();
  }

  private pruneActionStates() {
    const currentKeys = new Set(SOURCES.flatMap((source) => this.sourceItems.get(source) ?? []).map((item) => item.key));
    for (const key of this.actionStates.keys()) {
      if (!currentKeys.has(key)) this.actionStates.delete(key);
    }
  }

  private health(
    source: ApprovalCenterSource,
    phase: ApprovalCenterSourcePhase,
    pendingCount: number,
    retryable: boolean,
    diagnostic?: string,
  ): ApprovalCenterSourceHealth {
    return { source, phase, pendingCount, retryable, ...(diagnostic ? { diagnostic } : {}) };
  }

  private sourceEnabled(source: ApprovalCenterSource) {
    if (source === 'ai-session-approval') return this.options.supportsAiSessions;
    if (source === 'story-decision') return this.options.supportsStories;
    if (source === 'node-control-plane-trust') return this.options.supportsNodes;
    return true;
  }

  private live(epoch: number, signal?: AbortSignal) {
    return epoch === this.epoch && !signal?.aborted;
  }

  private clearRefreshTimers() {
    if (this.storyRefreshTimer) clearTimeout(this.storyRefreshTimer);
    if (this.nodeRefreshTimer) clearTimeout(this.nodeRefreshTimer);
    this.storyRefreshTimer = undefined;
    this.nodeRefreshTimer = undefined;
  }

  private buildSnapshot(): MobileApprovalCenterState {
    return {
      items: mergeApprovalCenterItems(SOURCES.flatMap((source) => this.sourceItems.get(source) ?? [])),
      sources: Object.fromEntries(SOURCES.map((source) => [source, {
        items: this.sourceItems.get(source) ?? [],
        health: this.sourceHealth.get(source)!,
      }])) as MobileApprovalCenterState['sources'],
      actions: Object.fromEntries(this.actionStates),
    };
  }

  private publish() {
    this.snapshotValue = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }
}

function supportsDecisionTools(capabilities: unknown) {
  return nodeStoryAgentToolCapabilities(nodeAgentCapabilitiesFromPublicNode(capabilities)).decisions;
}
