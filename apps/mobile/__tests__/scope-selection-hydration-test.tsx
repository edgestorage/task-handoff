import * as SecureStore from 'expo-secure-store';
import { render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { InstanceScopeProvider, useInstanceScope } from '../src/instance-scope/use-instance-scope';
import { StoryNodeFilterProvider, useStoryNodeFilter } from '../src/stories/use-story-node-filter';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => { store.set(key, value); }),
    deleteItemAsync: jest.fn(async (key: string) => { store.delete(key); }),
  };
});

const secureStore = SecureStore as unknown as { __store: Map<string, string> };
let mockDirectory = {
  controlPlaneId: 'cp-1',
  state: {
    instances: [{ id: 'instance-a' }],
    nodes: [{ id: 'node-a' }, { id: 'node-b' }],
  },
};

jest.mock('../src/directories/use-directories', () => ({
  useActiveDirectories: () => mockDirectory,
}));

function Consumer() {
  const { scope } = useInstanceScope();
  const { filter } = useStoryNodeFilter();
  return <Text>{`${scope.kind === 'instance' ? scope.instanceId : scope.kind}|${filter.kind === 'selected' ? filter.nodeIds.join(',') : filter.kind}`}</Text>;
}

beforeEach(() => { secureStore.__store.clear(); });
afterEach(() => {
  mockDirectory = {
    controlPlaneId: 'cp-1',
    state: { instances: [{ id: 'instance-a' }], nodes: [{ id: 'node-a' }, { id: 'node-b' }] },
  };
});

test('restores persisted scope selections after the app starts', async () => {
  secureStore.__store.set('task-handoff.mobile.scope-selection-preferences', JSON.stringify({
    version: 1,
    instanceScopeByControlPlane: { 'cp-1': { kind: 'instance', instanceId: 'instance-a' } },
    storyNodeFilterByControlPlane: { 'cp-1': { kind: 'selected', nodeIds: ['node-a'] } },
  }));

  const screen = await render(<StoryNodeFilterProvider><InstanceScopeProvider><Consumer /></InstanceScopeProvider></StoryNodeFilterProvider>);
  await waitFor(() => screen.getByText('instance-a|node-a'));
});

test('an empty startup directory does not erase the persisted selection', async () => {
  secureStore.__store.set('task-handoff.mobile.scope-selection-preferences', JSON.stringify({
    version: 1,
    instanceScopeByControlPlane: { 'cp-1': { kind: 'instance', instanceId: 'instance-a' } },
    storyNodeFilterByControlPlane: { 'cp-1': { kind: 'selected', nodeIds: ['node-a'] } },
  }));
  mockDirectory.state = { instances: [], nodes: [] };

  const screen = await render(<StoryNodeFilterProvider><InstanceScopeProvider><Consumer /></InstanceScopeProvider></StoryNodeFilterProvider>);
  await waitFor(() => screen.getByText('all|all'));

  mockDirectory.state = { instances: [{ id: 'instance-a' }], nodes: [{ id: 'node-a' }, { id: 'node-b' }] };
  screen.rerender(<StoryNodeFilterProvider><InstanceScopeProvider><Consumer /></InstanceScopeProvider></StoryNodeFilterProvider>);
  await waitFor(() => screen.getByText('instance-a|node-a'));
});
