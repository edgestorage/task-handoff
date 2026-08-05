import { render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import {
  ActiveAiSessionsProvider,
  useActiveAiSessions,
  type ActiveAiSessionsDependencies,
} from '../src/ai-sessions/use-active-sessions';

const profile = {
  version: 1 as const,
  identity: {
    controlPlaneId: 'cp-provider',
    publicKeyFingerprint: `sha256:${'a'.repeat(43)}`,
    protocolVersion: '2026-08-05',
  },
  access: {
    kind: 'direct' as const,
    origin: 'https://control.example.com',
    secureSessionKey: 'session.provider',
  },
  capabilities: { authentication: 'required' as const, aiSessions: true, nodes: true, instanceBoard: true },
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:00.000Z',
};

function Consumer({ name }: { name: string }) {
  const { controlPlaneId } = useActiveAiSessions();
  return <Text>{name}:{controlPlaneId}</Text>;
}

test('one root provider owns one AI session connection for multiple screens', async () => {
  const list = jest.fn().mockResolvedValue({ updatedAt: '2026-08-05T00:00:00.000Z', instances: [] });
  const connectEvents = jest.fn(() => ({ close: jest.fn() }));
  const subscribeProfiles = jest.fn(() => () => undefined);
  const dependencies: ActiveAiSessionsDependencies = {
    activeProfile: jest.fn().mockResolvedValue(profile),
    subscribeProfiles,
    createClient: () => ({
      api: {
        auth: { session: jest.fn().mockResolvedValue({ authenticated: true }) },
        aiSessions: { list },
      },
      transport: { revalidate: jest.fn().mockResolvedValue(undefined), connectEvents },
    }) as unknown as ReturnType<ActiveAiSessionsDependencies['createClient']>,
    subscribeLifecycle: (listener) => { listener('active'); return () => undefined; },
    subscribeNetwork: (listener) => { listener({ connected: true, internetReachable: true, type: 'wifi' }); return () => undefined; },
  };
  const screen = await render(
    <ActiveAiSessionsProvider dependencies={dependencies}>
      <Consumer name="inbox" />
      <Consumer name="detail" />
    </ActiveAiSessionsProvider>,
  );

  await waitFor(() => {
    screen.getByText('inbox:cp-provider');
    screen.getByText('detail:cp-provider');
    expect(list).toHaveBeenCalledTimes(1);
    expect(connectEvents).toHaveBeenCalledTimes(1);
  });
  expect(subscribeProfiles).toHaveBeenCalledTimes(1);
});
