import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { InstanceDrawerContent } from '../src/instance-scope/InstanceDrawerContent';
import { mobileDarkColors, mobileLightColors } from '../src/components/theme';
import { useMobileControlPlaneRuntime } from '../src/control-plane/use-mobile-control-plane-runtime';
import { useCloudAccountState } from '../src/control-plane/use-cloud-account-state';
import { useActiveDirectories } from '../src/directories/use-directories';
import { useInstanceScope } from '../src/instance-scope/use-instance-scope';
import { useStoryNodeFilter } from '../src/stories/use-story-node-filter';

let mockPathname = '/stories';
let mockCloudRelayEnabled = false;
let mockDarkTheme = false;
jest.mock('../src/components/theme', () => {
  const actual = jest.requireActual<typeof import('../src/components/theme')>('../src/components/theme');
  return {
    ...actual,
    useMobileTheme: () => ({ colors: mockDarkTheme ? actual.mobileDarkColors : actual.mobileLightColors, dark: mockDarkTheme, preference: 'system', setPreference: async () => undefined }),
  };
});
jest.mock('expo-router', () => ({ router: { push: jest.fn() }, usePathname: () => mockPathname }));
jest.mock('expo-router/drawer', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { DrawerContentScrollView: ({ children }: { children: React.ReactNode }) => React.createElement(View, null, children) };
});
jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => { const useMobileControlPlaneRuntime = jest.fn(); return { useMobileControlPlaneRuntime, useOptionalMobileControlPlaneRuntime: useMobileControlPlaneRuntime }; });
jest.mock('../src/control-plane/use-cloud-account-state', () => ({ useCloudAccountState: jest.fn() }));
jest.mock('../src/platform/build-variant', () => ({
  isMobileFeatureEnabled: () => mockCloudRelayEnabled,
}));
jest.mock('../src/directories/use-directories', () => ({ useActiveDirectories: jest.fn() }));
jest.mock('../src/instance-scope/use-instance-scope', () => ({ useInstanceScope: jest.fn() }));
jest.mock('../src/stories/use-story-node-filter', () => ({ useStoryNodeFilter: jest.fn() }));

const mockRuntime = jest.mocked(useMobileControlPlaneRuntime);
const mockCloudAccount = jest.mocked(useCloudAccountState);
const mockDirectories = jest.mocked(useActiveDirectories);
const mockInstanceScope = jest.mocked(useInstanceScope);
const mockStoryNodeFilter = jest.mocked(useStoryNodeFilter);
const closeDrawer = jest.fn();
const drawerProps = { navigation: { closeDrawer } } as unknown as Parameters<typeof InstanceDrawerContent>[0];

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname = '/stories';
  mockCloudRelayEnabled = false;
  mockDarkTheme = false;
  mockRuntime.mockReturnValue({ triggerCapability: false } as ReturnType<typeof useMobileControlPlaneRuntime>);
  mockCloudAccount.mockReturnValue({ phase: 'signed-out' } as ReturnType<typeof useCloudAccountState>);
  mockDirectories.mockReturnValue({ controlPlaneOrigin: 'https://control.example', state: {
    phase: 'ready',
    nodes: [
      { id: 'node-a', name: 'Node A', status: 'online', health: 'ok' },
      { id: 'node-b', name: 'Node B', status: 'offline', health: 'unknown' },
    ],
    instances: [{ id: 'instance-a', nodeId: 'node-a', name: 'Instance A' }],
  } } as unknown as ReturnType<typeof useActiveDirectories>);
  mockInstanceScope.mockReturnValue({ scope: { kind: 'all' }, setScope: jest.fn() });
  mockStoryNodeFilter.mockReturnValue({ filter: { kind: 'all' }, setFilter: jest.fn() });
});

test('drawer hides the Thandoff account entry unless cloud Relay is enabled', async () => {
  const hidden = await render(<InstanceDrawerContent {...drawerProps} />);
  expect(hidden.queryByText('Sign in to Thandoff account')).toBeNull();
  await hidden.unmount();

  mockCloudRelayEnabled = true;
  const enabled = await render(<InstanceDrawerContent {...drawerProps} />);
  expect(enabled.getByText('Sign in to Thandoff account')).toBeTruthy();
  await enabled.unmount();
});

test('drawer shows the Control Plane name for a cloud Relay profile', async () => {
  mockRuntime.mockReturnValue({
    profile: {
      access: { kind: 'cloud-relay' },
      identity: { displayName: 'Relay Studio' },
    },
    triggerCapability: false,
  } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);

  const screen = await render(<InstanceDrawerContent {...drawerProps} />);
  expect(screen.getByText('Relay Studio')).toBeTruthy();
  expect(screen.queryByText('https://control.example')).toBeNull();
  await screen.unmount();
});

test('Story drawer switches to node multi-select without changing other tab instance scope', async () => {
  const setFilter = jest.fn();
  mockStoryNodeFilter.mockReturnValue({ filter: { kind: 'all' }, setFilter });
  const storyScreen = await render(<InstanceDrawerContent {...drawerProps} />);

  expect(storyScreen.getByText('All Nodes')).toBeTruthy();
  expect(StyleSheet.flatten(storyScreen.getByTestId('drawer-all-nodes').props.style).backgroundColor).toBe(mobileLightColors.workbenchSelectionBackground);
  expect(storyScreen.getAllByRole('checkbox')).toHaveLength(2);
  expect(storyScreen.queryByText('Instance A')).toBeNull();
  await fireEvent.press(storyScreen.getByText('Node A'));
  expect(setFilter).toHaveBeenCalledWith({ kind: 'selected', nodeIds: ['node-a'] });
  await storyScreen.unmount();

  mockPathname = '/inbox';
  const instanceScreen = await render(<InstanceDrawerContent {...drawerProps} />);
  expect(instanceScreen.getByText('All Instances')).toBeTruthy();
  expect(instanceScreen.getByText('Instance A')).toBeTruthy();
  expect(instanceScreen.queryByText('All Nodes')).toBeNull();
  await instanceScreen.unmount();
});

test('Story drawer node checkboxes share the workbench selection background', async () => {
  mockStoryNodeFilter.mockReturnValue({ filter: { kind: 'selected', nodeIds: ['node-a'] }, setFilter: jest.fn() });
  const screen = await render(<InstanceDrawerContent {...drawerProps} />);

  expect(StyleSheet.flatten(screen.getByTestId('drawer-node-node-a').props.style).backgroundColor).toBe(mobileLightColors.workbenchSelectionBackground);
  expect(StyleSheet.flatten(screen.getByTestId('drawer-node-node-b').props.style).backgroundColor).toBeUndefined();
  await screen.unmount();
});

test('drawer footer circles reuse the workbench selection token', async () => {
  mockCloudRelayEnabled = true;
  mockCloudAccount.mockReturnValue({ phase: 'signed-in', profile: { email: 'test@example.com' } } as ReturnType<typeof useCloudAccountState>);

  for (const [colors, dark] of [[mobileLightColors, false], [mobileDarkColors, true]] as const) {
    mockDarkTheme = dark;
    const screen = await render(<InstanceDrawerContent {...drawerProps} />);
    expect(StyleSheet.flatten(screen.getByTestId('drawer-all-nodes').props.style).backgroundColor).toBe(colors.workbenchSelectionBackground);
    expect(StyleSheet.flatten(screen.getByTestId('drawer-account-avatar').props.style).backgroundColor).toBe(colors.workbenchSelectionBackground);
    expect(StyleSheet.flatten(screen.getByTestId('drawer-settings-button').props.style).backgroundColor).toBe(colors.workbenchSelectionBackground);
    await screen.unmount();
  }
});
