/** Local resource references only. Runtime state remains in the resource's own store. */
export type RepositoryResourcePage = 'files' | 'changes' | 'worktrees';
export type SessionResource =
  | { kind: 'repository'; page: RepositoryResourcePage; fileRequest?: { basePath?: string; href: string; id: number } }
  | { kind: 'app-session'; sessionId: string }
  | { kind: 'browser'; tabId: string };

export type ResourceWorkspaceState = { resources: readonly SessionResource[]; activeKey?: string; expanded?: boolean; fraction?: number };
export const EMPTY_RESOURCE_WORKSPACE: ResourceWorkspaceState = { resources: [] };

export function resourceContextKey(controlPlaneId: string, instanceId: string, aiSessionId: string) {
  return JSON.stringify([controlPlaneId, instanceId, aiSessionId]);
}

export function sessionResourceKey(resource: SessionResource) {
  return resource.kind === 'repository' ? `repository:${resource.page}`
    : resource.kind === 'app-session' ? `app-session:${resource.sessionId}` : `browser:${resource.tabId}`;
}

export function openSessionResource(state: ResourceWorkspaceState, resource: SessionResource): ResourceWorkspaceState {
  const activeKey = sessionResourceKey(resource);
  const index = state.resources.findIndex((item) => sessionResourceKey(item) === activeKey);
  return {
    ...state,
    resources: index < 0
      ? [...state.resources, resource]
      : state.resources.map((item, itemIndex) => itemIndex === index ? resource : item),
    activeKey,
  };
}

let repositoryFileRequestSequence = 0;

export function openRepositoryFileResource(state: ResourceWorkspaceState, href: string, basePath?: string): ResourceWorkspaceState {
  const value = href.trim();
  if (!value) return state;
  return {
    ...openSessionResource(state, {
      kind: 'repository',
      page: 'files',
      fileRequest: { ...(basePath !== undefined ? { basePath } : {}), href: value, id: ++repositoryFileRequestSequence },
    }),
    expanded: true,
  };
}

export function removeSessionResource(state: ResourceWorkspaceState, key: string): ResourceWorkspaceState {
  const index = state.resources.findIndex((item) => sessionResourceKey(item) === key);
  if (index < 0) return state;
  const resources = state.resources.filter((item) => sessionResourceKey(item) !== key);
  const active = resources[Math.min(index, resources.length - 1)];
  return { ...state, resources, activeKey: state.activeKey === key ? (active ? sessionResourceKey(active) : undefined) : state.activeKey };
}

export const RESOURCE_CONVERSATION_MIN_WIDTH = 480;
export const RESOURCE_PANEL_MIN_WIDTH = 360;
export const RESOURCE_INLINE_MIN_WIDTH = RESOURCE_CONVERSATION_MIN_WIDTH + RESOURCE_PANEL_MIN_WIDTH + 1;
const INLINE_HYSTERESIS = 16;

export function resourceLayoutMode(width: number, previous: 'overlay' | 'inline' = 'overlay') {
  return width >= RESOURCE_INLINE_MIN_WIDTH + (previous === 'inline' ? 0 : INLINE_HYSTERESIS) ? 'inline' : 'overlay';
}

export function resourcePanelWidth(width: number, fraction = 0.4) {
  return Math.min(Math.max(RESOURCE_PANEL_MIN_WIDTH, width * fraction), Math.max(0, width - RESOURCE_CONVERSATION_MIN_WIDTH - 1));
}

export function resourceOverlayWidth(width: number) {
  return Math.max(0, width);
}

export function sessionResourceTopInset(platform: string, headerHeight: number) {
  return platform === 'ios' ? Math.max(0, headerHeight) : 0;
}

export class ResourceWorkspaceStore {
  private activeContext?: string;
  enterContext(key: string) {
    if (this.activeContext === key) return;
    this.activeContext = key;
    const state = this.snapshot(key);
    this.update(key, { ...state, expanded: false });
  }
  isCurrentContext(key: string) { return this.activeContext === key; }
  private readonly states = new Map<string, ResourceWorkspaceState>();
  private readonly listeners = new Map<string, Set<() => void>>();
  snapshot(key: string) { return this.states.get(key) || EMPTY_RESOURCE_WORKSPACE; }
  subscribe(key: string, listener: () => void) {
    const listeners = this.listeners.get(key) || new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  }
  update(key: string, next: ResourceWorkspaceState) {
    this.states.set(key, next);
    for (const listener of this.listeners.get(key) || []) listener();
  }
  clearProfile(controlPlaneId: string) {
    for (const key of this.states.keys()) {
      if (JSON.parse(key)[0] !== controlPlaneId) continue;
      this.states.delete(key);
      for (const listener of this.listeners.get(key) || []) listener();
    }
  }
}
export const mobileResourceWorkspaceStore = new ResourceWorkspaceStore();
