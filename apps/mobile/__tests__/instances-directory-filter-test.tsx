import { fireEvent, render } from '@testing-library/react-native';
import { ControlPlaneInstanceDirectoryEntrySchema, ControlPlaneNodeDirectoryEntrySchema } from '@task-handoff/protocol/control-plane-directory';

import { MobileThemeProvider } from '../src/components/theme';
import { InstancesDirectory } from '../src/directories/DirectoryLists';
import type { MobileDirectoryProfileState } from '../src/directories/store';

// The picker based filter UI only exists in the default (Android) file, so pin it here.
jest.mock('../src/directories/DirectoryLists', () => jest.requireActual('../src/directories/DirectoryLists.tsx'));

// The Android screen keeps the iOS picker flow: every filter opens a menu with the
// full, human-readable option list instead of a horizontally clipped chip row.
jest.mock('../src/components/AnchoredSelectMenu', () => {
  const { Pressable, Text, View } = jest.requireActual('react-native');
  return {
    AnchoredSelectMenu: ({ children, onSelect, options, title }: { children(onPress?: () => void): React.ReactElement; onSelect(value: string): void; options: { label: string; value: string }[]; title: string }) => (
      <View>
        {options.map((option) => <Pressable key={option.value} onPress={() => onSelect(option.value)}><Text>{`${title}:${option.label}`}</Text></Pressable>)}
        {children(() => undefined)}
      </View>
    ),
  };
});

function instanceOf(id: string, name: string, nodeId: string, aiSessions: { problemCount?: number; runningCount?: number } = {}) {
  return ControlPlaneInstanceDirectoryEntrySchema.parse({
    id, name, nodeId, status: 'running', health: 'ok', connectionStatus: 'online', ready: true,
    config: { defaultCodexPermissionMode: 'full-access' },
    capabilities: { aiSessionProviders: [{ agent: 'codex', actions: {}, permissionModes: ['ask'], timeline: {} }] },
    observedAt: '2026-10-14T00:00:00.000Z', runtime: { id: 'runtime-1', name: 'Local Docker', type: 'docker' }, workspace: { status: 'ready', path: '/workspace' },
    protocol: { version: '2026-08-01', compatible: true },
    aiSessions: { runningCount: aiSessions.runningCount ?? 0, waitingCount: 0, staleCount: 0, idleCount: 0, problemCount: aiSessions.problemCount ?? 0, updatedAt: '2026-10-14T00:00:00.000Z' },
    availableAgents: [{ id: 'codex', name: 'Codex', kind: 'tty', supportsCwdSelection: true }],
  });
}

const state: MobileDirectoryProfileState = {
  controlPlaneId: 'cp-1',
  nodes: [
    ControlPlaneNodeDirectoryEntrySchema.parse({ id: 'node-1', name: 'MacMini', status: 'online', health: 'ok', connectionMode: 'reverse-wss', observedAt: '2026-10-14T00:00:00.000Z', capabilities: [] }),
    ControlPlaneNodeDirectoryEntrySchema.parse({ id: 'node-2', name: 'Local Node', status: 'online', health: 'ok', connectionMode: 'local-ipc', observedAt: '2026-10-14T00:00:00.000Z', capabilities: [] }),
  ],
  instances: [
    instanceOf('instance-1', 'Browser', 'node-1'),
    instanceOf('instance-2', 'Builder', 'node-2', { problemCount: 2 }),
  ],
  nodeStates: [],
  phase: 'ready',
};

test('instance filters list node display names and filter behaviour through the picker menus', async () => {
  const screen = await render(<MobileThemeProvider><InstancesDirectory state={state} /></MobileThemeProvider>);

  expect(screen.getByText('Node:All Nodes')).toBeTruthy();
  expect(screen.getByText('Node:MacMini')).toBeTruthy();
  expect(screen.getByText('Node:Local Node')).toBeTruthy();
  expect(screen.queryByText(/node-1/)).toBeNull();
  expect(screen.getByText('Browser')).toBeTruthy();
  expect(screen.getByText('Builder')).toBeTruthy();

  await fireEvent.press(screen.getByText('Node:MacMini'));
  expect(screen.getByText('Browser')).toBeTruthy();
  expect(screen.queryByText('Builder')).toBeNull();

  await fireEvent.press(screen.getByText('AI:Problem'));
  expect(screen.queryByText('Browser')).toBeNull();

  await fireEvent.press(screen.getByText('Node:All Nodes'));
  expect(screen.getByText('Builder')).toBeTruthy();
  expect(screen.queryByText('Browser')).toBeNull();

  await screen.unmount();
});

test('the node scoped directory keeps its status summary and instance count without a node picker', async () => {
  const screen = await render(<MobileThemeProvider><InstancesDirectory nodeId="node-2" state={state} /></MobileThemeProvider>);

  expect(screen.getByText('Instances')).toBeTruthy();
  expect(screen.getByText('1')).toBeTruthy();
  expect(screen.getByText(/Online/)).toBeTruthy();
  expect(screen.queryByText('Node:All Nodes')).toBeNull();
  expect(screen.getByText('Builder')).toBeTruthy();
  expect(screen.queryByText('Browser')).toBeNull();

  await screen.unmount();
});
