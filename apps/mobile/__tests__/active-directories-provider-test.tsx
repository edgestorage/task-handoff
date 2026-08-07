import { act, render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import {
  ActiveDirectoriesProvider,
  useActiveDirectories,
  type ActiveDirectoriesDependencies,
} from '../src/directories/use-directories';

const profile = {
  version: 1 as const,
  identity: {
    controlPlaneId: 'cp-first-setup',
    publicKeyFingerprint: `sha256:${'a'.repeat(43)}`,
    protocolVersion: '2026-08-05',
  },
  access: {
    kind: 'direct' as const,
    origin: 'https://control.example.com',
    secureSessionKey: 'session.first-setup',
  },
  capabilities: { authentication: 'required' as const, aiSessions: true, nodes: true, instanceBoard: true },
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:00.000Z',
};

function Consumer() {
  const { controlPlaneId, controlPlaneOrigin, state } = useActiveDirectories();
  return <Text>{controlPlaneId ?? 'none'}:{controlPlaneOrigin ?? 'none'}:{state.phase}:{state.nodes.length}:{state.instances.length}</Text>;
}

test('directory activates when the first Control Plane profile is created after mount', async () => {
  let activeProfile: typeof profile | undefined;
  let notifyProfileChange: () => void = () => undefined;
  const nodes = jest.fn().mockResolvedValue([{ id: 'node-1' }]);
  const instanceBoard = jest.fn().mockResolvedValue([{ id: 'instance-1', nodeId: 'node-1' }]);
  const dependencies: ActiveDirectoriesDependencies = {
    activeProfile: jest.fn(async () => activeProfile),
    subscribeProfiles: jest.fn((listener) => {
      notifyProfileChange = listener;
      return () => undefined;
    }),
    createClient: () => ({
      api: { resources: { nodes, instanceBoard } },
      transport: { revalidate: jest.fn().mockResolvedValue(undefined) },
    }) as unknown as ReturnType<ActiveDirectoriesDependencies['createClient']>,
    subscribeLifecycle: (listener) => { listener('active'); return () => undefined; },
    subscribeNetwork: (listener) => { listener({ connected: true, internetReachable: true, type: 'wifi' }); return () => undefined; },
  };
  const screen = await render(
    <ActiveDirectoriesProvider dependencies={dependencies}>
      <Consumer />
    </ActiveDirectoriesProvider>,
  );

  await waitFor(() => screen.getByText('none:none:idle:0:0'));

  activeProfile = profile;
  await act(async () => {
    notifyProfileChange();
  });

  await waitFor(() => {
    screen.getByText('cp-first-setup:https://control.example.com:ready:1:1');
    expect(nodes).toHaveBeenCalledTimes(1);
    expect(instanceBoard).toHaveBeenCalledTimes(1);
  });
});
