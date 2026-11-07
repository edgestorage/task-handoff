import { fireEvent, render } from '@testing-library/react-native';

import type { MobileControlPlaneRuntimePhase } from '../src/control-plane/use-mobile-control-plane-runtime';
import { InstanceScopeHeaderButton } from '../src/instance-scope/InstanceScopeHeaderButton';
import { StoryNodeFilterHeaderButton } from '../src/stories/StoryNodeFilterHeaderButton';

let mockPhase: MobileControlPlaneRuntimePhase = 'connected';
let mockSnapshotReady = false;
jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({
  useMobileControlPlaneRuntime: () => ({ phase: mockPhase }),
  useMobileControlPlaneTopicSyncing: () => !mockSnapshotReady,
}));
jest.mock('../src/directories/use-directories', () => ({
  useActiveDirectories: () => ({ state: {
    instances: [{ id: 'instance-a', name: 'Instance A' }],
    nodes: [{ id: 'node-a', name: 'Node A' }],
  } }),
}));
jest.mock('../src/instance-scope/use-open-instance-drawer', () => ({ useOpenInstanceDrawer: () => jest.fn() }));
jest.mock('../src/instance-scope/use-instance-scope', () => ({
  useInstanceScope: () => ({ scope: { kind: 'instance', instanceId: 'instance-a' } }),
}));
jest.mock('../src/stories/use-story-node-filter', () => ({
  useStoryNodeFilter: () => ({ filter: { kind: 'selected', nodeIds: ['node-a'] } }),
}));

beforeEach(() => { mockPhase = 'connected'; mockSnapshotReady = false; });

describe.each([
  ['instance', InstanceScopeHeaderButton, 'Instance A'],
  ['node', StoryNodeFilterHeaderButton, 'Node A'],
] as const)('%s scope connection feedback', (_kind, Button, selectedLabel) => {
  test('keeps the drawer actionable throughout recovery and restores the selected label after connection', async () => {
    const onPress = jest.fn();
    const screen = await render(<Button onPress={onPress} />);
    expect(screen.getByText(selectedLabel)).toBeTruthy();

    for (const phase of ['verifying', 'loading', 'reconnecting', 'approved-connecting'] as const) {
      mockPhase = phase;
      await screen.rerender(<Button onPress={onPress} />);
      expect(screen.getByText('Loading…')).toBeTruthy();
      expect(screen.getAllByTestId('scope-header-loading', { includeHiddenElements: true })).toHaveLength(1);
      expect(screen.getByRole('button').props.accessibilityState.busy).toBe(true);
      expect(screen.getByRole('button').props.accessibilityLabel).toContain(selectedLabel);
      await fireEvent.press(screen.getByRole('button'));
    }
    expect(onPress).toHaveBeenCalledTimes(4);

    mockPhase = 'connected';
    await screen.rerender(<Button onPress={onPress} />);
    expect(screen.getByText(selectedLabel)).toBeTruthy();
    expect(screen.queryAllByTestId('scope-header-loading', { includeHiddenElements: true })).toHaveLength(0);
    expect(screen.getByRole('button').props.accessibilityState.busy).toBe(false);
  });

  test('ends loading when the current snapshot is ready while the shared connection is still recovering', async () => {
    mockPhase = 'loading';
    const screen = await render(<Button />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    mockSnapshotReady = true;
    await screen.rerender(<Button />);
    expect(screen.getByText(selectedLabel)).toBeTruthy();
    expect(screen.getByRole('button').props.accessibilityState.busy).toBe(false);
    expect(screen.queryAllByTestId('scope-header-loading', { includeHiddenElements: true })).toHaveLength(0);

    // A new recovery must not reuse the previous attempt's completed snapshot.
    mockSnapshotReady = false;
    mockPhase = 'reconnecting';
    await screen.rerender(<Button />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  test.each([
    ['offline', 'Offline'],
    ['session-expired', 'Sign-in expired'],
    ['waiting-device-approval', 'Waiting for Control Plane approval'],
    ['rejected', 'Device approval was rejected'],
    ['expired', 'Device approval expired'],
    ['revoked', 'Device trust was revoked'],
    ['trust-required', 'Update this client to connect'],
    ['control-plane-closed', 'Control Plane closed'],
    ['error', 'Failed'],
  ] as const)('stops the loading indicator when recovery enters %s', async (phase, status) => {
    mockPhase = 'reconnecting';
    const screen = await render(<Button />);
    mockPhase = phase;
    await screen.rerender(<Button />);
    expect(screen.getByText(status)).toBeTruthy();
    expect(screen.queryAllByTestId('scope-header-loading', { includeHiddenElements: true })).toHaveLength(0);
    expect(screen.getByRole('button').props.accessibilityState.busy).toBe(false);
  });

  test('does not spin while idle', async () => {
    mockPhase = 'idle';
    const screen = await render(<Button />);
    expect(screen.getByText(selectedLabel)).toBeTruthy();
    expect(screen.queryAllByTestId('scope-header-loading', { includeHiddenElements: true })).toHaveLength(0);
  });
});
