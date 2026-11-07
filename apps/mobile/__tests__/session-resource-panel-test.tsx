import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ControlPlaneInstanceResourceEntry } from '@task-handoff/control-plane-client';
import { SessionResourcePanel } from '../src/ai-sessions/SessionResourcePanel';
import { mobileResourceWorkspaceStore, openSessionResource, resourceContextKey } from '../src/ai-sessions/resource-workspace-model';

const mockLaunch = jest.fn();
const mockUpsert = jest.fn();
const mockRuntime = { api: { appSessions: { launch: mockLaunch } }, profile: { id: 'cp-panel' } };
const mockAppState = { controlPlaneId: 'cp-panel', state: { snapshot: { instances: [
  { instanceId: 'instance-1', appSessions: { sessions: [{ id: 'existing', title: 'Instance terminal', appId: 'terminal' }] } },
  { instanceId: 'other-instance', appSessions: { sessions: [{ id: 'foreign', title: 'Foreign terminal', appId: 'terminal' }] } },
] } } };
jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({ useMobileControlPlaneRuntime: () => mockRuntime }));
jest.mock('../src/app-sessions/use-active-app-sessions', () => ({ useActiveAppSessions: () => mockAppState }));
jest.mock('../src/app-sessions/store', () => ({ mobileAppSessionStore: { upsertSession: (...args: unknown[]) => mockUpsert(...args) } }));
jest.mock('../src/control-plane/browser-context', () => ({ mobileBrowserCapability: async () => ({ supported: false }) }));
jest.mock('../src/browser/controller', () => ({ mobileBrowserController: {} }));
jest.mock('../src/app-sessions/AppSessionDetailScreen', () => ({ AppSessionDetailScreen: () => null }));
jest.mock('../src/browser/BrowserTabScreen', () => ({ BrowserTabScreen: () => null }));
jest.mock('../src/repository/RepositoryResourceView', () => ({ RepositoryResourceView: () => null }));
jest.mock('../src/components/MenuView', () => ({
  MenuView: ({ actions, onPressAction }: { actions: { id: string; title: string; attributes?: { disabled?: boolean }; subactions?: unknown[] }[]; onPressAction(event: unknown): void }) => {
    const { Pressable, Text } = jest.requireActual('react-native');
    const flatten = (items: typeof actions): typeof actions => items.flatMap((item) => item.subactions ? flatten(item.subactions as typeof actions) : [item]);
    return <>{flatten(actions).map((action) => <Pressable key={action.id} testID={action.id} disabled={action.attributes?.disabled} onPress={() => onPressAction({ nativeEvent: { event: action.id } })}><Text>{action.title}</Text></Pressable>)}</>;
  },
}));

const instance = { ready: true, connectionStatus: 'online', availableApps: [{ id: 'terminal', name: 'Terminal' }] } as ControlPlaneInstanceResourceEntry;
function props(sessionId: string) {
  return { contextKey: resourceContextKey('cp-panel', 'instance-1', sessionId), controlPlaneId: 'cp-panel', expanded: true, instance, instanceId: 'instance-1', onFractionChange: jest.fn(), session: { cwd: '/authoritative/worktree' }, sessionId, syncReady: true };
}
beforeEach(() => { mockLaunch.mockReset(); mockUpsert.mockReset(); mobileResourceWorkspaceStore.clearProfile('cp-panel'); });

test('instance app selection is scoped to the target instance and launch uses the session cwd', async () => {
  mockLaunch.mockResolvedValue({ id: 'launched', appId: 'terminal' });
  const current = props('session-launch');
  const screen = await render(<SessionResourcePanel {...current} />);
  expect(screen.queryByText('Foreign terminal')).toBeNull();
  await fireEvent.press(screen.getByTestId('app:existing'));
  expect(mobileResourceWorkspaceStore.snapshot(current.contextKey).activeKey).toBe('app-session:existing');
  await fireEvent.press(screen.getByTestId('launch:terminal'));
  await waitFor(() => expect(mockUpsert).toHaveBeenCalledWith('cp-panel', 'instance-1', { id: 'launched', appId: 'terminal' }));
  expect(mockLaunch).toHaveBeenCalledWith('instance-1', { appId: 'terminal', cwd: '/authoritative/worktree' });
  expect(mobileResourceWorkspaceStore.snapshot(current.contextKey).activeKey).toBe('app-session:launched');
  await screen.unmount();
});

test('a launch finishing after a context change updates its authoritative store without selecting a resource in the new session', async () => {
  let resolve!: (value: { id: string }) => void;
  mockLaunch.mockReturnValue(new Promise((done) => { resolve = done; }));
  const old = props('old');
  const next = props('next');
  const screen = await render(<SessionResourcePanel key={old.contextKey} {...old} />);
  await fireEvent.press(screen.getByTestId('launch:terminal'));
  await screen.rerender(<SessionResourcePanel key={next.contextKey} {...next} />);
  await act(async () => { resolve({ id: 'late-launch' }); });
  expect(mockUpsert).toHaveBeenCalledWith('cp-panel', 'instance-1', { id: 'late-launch' });
  expect(mobileResourceWorkspaceStore.snapshot(next.contextKey).resources).toHaveLength(0);
  expect(mobileResourceWorkspaceStore.snapshot(old.contextKey).resources).toHaveLength(0);
  await screen.unmount();
});

test('resource header uses tabs without a resource title or back button', async () => {
  const current = props('session-tabs');
  mobileResourceWorkspaceStore.update(current.contextKey, openSessionResource(mobileResourceWorkspaceStore.snapshot(current.contextKey), { kind: 'repository', page: 'files' }));
  const screen = await render(<SessionResourcePanel {...current} />);
  expect(screen.queryByText(/Resources|资源/)).toBeNull();
  expect(screen.queryByLabelText(/Back to session|返回会话/)).toBeNull();
  expect(screen.getByRole('tab', { name: /Files|文件/ })).toBeTruthy();
  await screen.unmount();
});

test('resource actions follow the active tab and include closing that tab', async () => {
  const current = props('session-tab-actions');
  mobileResourceWorkspaceStore.update(current.contextKey, openSessionResource(mobileResourceWorkspaceStore.snapshot(current.contextKey), { kind: 'repository', page: 'files' }));
  const screen = await render(<SessionResourcePanel {...current} />);
  expect(screen.queryByTestId('fullscreen')).toBeNull();
  expect(screen.queryByTestId('balanced')).toBeNull();
  expect(screen.queryByTestId('conversation')).toBeNull();
  expect(screen.queryByTestId('resource')).toBeNull();
  expect(screen.getByTestId('refresh')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('close-tab'));
  expect(mobileResourceWorkspaceStore.snapshot(current.contextKey).resources).toHaveLength(0);
  expect(screen.queryByTestId('close-tab')).toBeNull();
  await screen.unmount();
});
