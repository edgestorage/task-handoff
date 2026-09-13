import { fireEvent, render } from '@testing-library/react-native';

import { InstanceDrawerContent } from '../src/instance-scope/InstanceDrawerContent';
import { useMobileControlPlaneRuntime } from '../src/control-plane/use-mobile-control-plane-runtime';
import { useCloudAccountState } from '../src/control-plane/use-cloud-account-state';
import { useActiveDirectories } from '../src/directories/use-directories';
import { useInstanceScope } from '../src/instance-scope/use-instance-scope';
import { useStoryNodeFilter } from '../src/stories/use-story-node-filter';

let mockPathname = '/stories';
jest.mock('expo-router', () => ({ router: { push: jest.fn() }, usePathname: () => mockPathname }));
jest.mock('expo-router/drawer', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { DrawerContentScrollView: ({ children }: { children: React.ReactNode }) => React.createElement(View, null, children) };
});
jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({ useMobileControlPlaneRuntime: jest.fn() }));
jest.mock('../src/control-plane/use-cloud-account-state', () => ({ useCloudAccountState: jest.fn() }));
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

test('Story drawer switches to node multi-select without changing other tab instance scope', async () => {
  const setFilter = jest.fn();
  mockStoryNodeFilter.mockReturnValue({ filter: { kind: 'all' }, setFilter });
  const storyScreen = await render(<InstanceDrawerContent {...drawerProps} />);

  expect(storyScreen.getByText('All Nodes')).toBeTruthy();
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
