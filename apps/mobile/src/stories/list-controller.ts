import type { ControlPlaneClient } from '@task-handoff/control-plane-client';
import type { Story } from '@task-handoff/protocol/stories';
import { StoryDecisionChangedEventType } from '@task-handoff/protocol/stories';
import type { MobileControlPlaneConnectionCoordinator, MobileControlPlaneDomain } from '../control-plane/use-mobile-control-plane-runtime';
import { traceDiagnosticTask } from '../observability/diagnostic-timing';
import { diagnosticLog } from '../observability/diagnostic-logs';
import { mergeStoryTreeSnapshot, storyTreeKey } from './story-tree-model';

type StoryList = Awaited<ReturnType<ControlPlaneClient['stories']['list']>>;
export type MobileStoryListState = {
  stories: Story[];
  unavailableNodeIds: string[];
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'offline';
  result?: StoryList;
  error?: string;
};

/** One snapshot owner per client lifetime; views and approval projections share it. */
export class MobileStoryListController {
  private state: MobileStoryListState = { stories: [], unavailableNodeIds: [], phase: 'idle' };
  private listeners = new Set<() => void>();
  private consumers = 0;
  private unregister?: () => void;
  private domain?: MobileControlPlaneDomain;
  private abort?: AbortController;
  private generation = 0;
  private inFlight?: Promise<StoryList>;
  private timer?: ReturnType<typeof setTimeout>;
  private queued = false;
  private lastError?: unknown;

  constructor(private readonly client: ControlPlaneClient) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private set(patch: Partial<MobileStoryListState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  acquire(coordinator?: Pick<MobileControlPlaneConnectionCoordinator, 'register'>) {
    if (++this.consumers === 1) {
      const domain = this.domain ??= {
        key: 'stories-list', topics: ['stories'], snapshotTopics: ['stories'], background: true,
        start: async (signal: AbortSignal) => { await this.start(signal).catch(() => undefined); },
        stop: () => this.stop(), offline: () => this.stop(),
        onConnectionError: () => this.stop(),
        onEvent: (event: Parameters<MobileControlPlaneDomain['onEvent']>[0]) => {
          // Decisions have their own authority and do not change the Story list.
          if (event.topic === 'stories' && event.type !== StoryDecisionChangedEventType) this.scheduleRefresh();
        },
      };
      this.unregister = coordinator ? coordinator.register(domain) : () => domain.stop();
      if (!coordinator) void domain.start(new AbortController().signal);
    }
    return () => {
      if (--this.consumers !== 0) return;
      this.unregister?.();
      this.unregister = undefined;
      // The coordinator owns stopping registered domains. Keeping its stable
      // domain alive through an immediate React remount avoids abort/restart.
    };
  }

  async start(signal: AbortSignal) {
    // A consumer can request the first snapshot before domain startup runs.
    // Adopt that in-flight request rather than cancelling and duplicating it.
    if (!this.inFlight) this.stop();
    const abort = this.abort ?? new AbortController();
    this.abort = abort;
    const forward = () => abort.abort();
    if (signal.aborted) forward();
    else signal.addEventListener('abort', forward, { once: true });
    try { return await this.refresh(); }
    finally { signal.removeEventListener('abort', forward); }
  }

  stop() {
    this.generation++;
    this.abort?.abort();
    this.abort = undefined;
    this.inFlight = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.queued = false;
    this.set({ phase: 'offline' });
  }

  /** A reader never owns cancellation of the shared HTTP request. */
  async read(signal?: AbortSignal): Promise<StoryList> {
    signal?.throwIfAborted();
    if (this.state.phase === 'error') throw this.lastError;
    const result = this.inFlight ? await this.inFlight
      : this.state.phase === 'ready' && this.state.result ? this.state.result : await this.refresh();
    signal?.throwIfAborted();
    return result;
  }

  refresh = (): Promise<StoryList> => {
    if (this.inFlight) return this.inFlight;
    this.abort ??= new AbortController();
    const signal = this.abort.signal;
    const generation = this.generation;
    this.lastError = undefined;
    this.set({ phase: 'loading', error: undefined });
    const request = traceDiagnosticTask('stories.shared.list', {}, () => this.client.stories.list(undefined, signal), signal)
      .then((result) => {
        if (generation !== this.generation || signal.aborted) throw new Error('Story snapshot was superseded.');
        this.set({ result, stories: mergeStoryTreeSnapshot(this.state.stories, result.stories, result.unavailableNodeIds),
          unavailableNodeIds: result.unavailableNodeIds, phase: 'ready' });
        diagnosticLog.info('stories.shared.snapshot', { storyCount: result.stories.length, unavailableNodeIds: result.unavailableNodeIds });
        return result;
      }).catch((cause: unknown) => {
        if (generation === this.generation && !signal.aborted) {
          this.lastError = cause;
          this.set({ phase: 'error', error: cause instanceof Error ? cause.message : String(cause) });
        }
        throw cause;
      }).finally(() => {
        if (this.inFlight !== request) return;
        this.inFlight = undefined;
        if (this.queued) { this.queued = false; this.scheduleRefresh(); }
      });
    this.inFlight = request;
    return request;
  };

  private scheduleRefresh() {
    if (this.inFlight) { this.queued = true; return; }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().catch(() => undefined);
    }, 100);
  }

  // Only authoritative mutation responses may update the shared snapshot.
  replaceStory(story: Story) {
    const replace = (stories: Story[]) => stories.map((entry) => storyTreeKey(entry) === storyTreeKey(story) ? story : entry);
    this.set({ stories: replace(this.state.stories), result: this.state.result && { ...this.state.result, stories: replace(this.state.result.stories) } });
  }
  removeStory(story: Story) {
    const remove = (stories: Story[]) => stories.filter((entry) => storyTreeKey(entry) !== storyTreeKey(story));
    this.set({ stories: remove(this.state.stories), result: this.state.result && { ...this.state.result, stories: remove(this.state.result.stories) } });
  }
}

const controllers = new WeakMap<ControlPlaneClient, MobileStoryListController>();
export function mobileStoryListFor(client: ControlPlaneClient) {
  let controller = controllers.get(client);
  if (!controller) { controller = new MobileStoryListController(client); controllers.set(client, controller); }
  return controller;
}
