import { act, fireEvent, render } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { ControlPlaneInstanceDirectoryEntrySchema } from '@task-handoff/protocol/control-plane-directory';
import { StorySchema } from '@task-handoff/protocol/stories';

import { StoryDetail } from '../src/stories/StoryDetail';
import { useMobileControlPlaneRuntime } from '../src/control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../src/directories/use-directories';
import { useActiveAiSessionsSnapshot } from '../src/ai-sessions/use-active-sessions';
import { mobilePermissionStore } from '../src/control-plane/runtime';

jest.mock('expo-crypto', () => ({ randomUUID: () => 'action-request-1' }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({ useMobileControlPlaneRuntime: jest.fn() }));
jest.mock('../src/directories/use-directories', () => ({ useActiveDirectories: jest.fn() }));
jest.mock('../src/ai-sessions/use-active-sessions', () => ({ useActiveAiSessionsSnapshot: jest.fn() }));
jest.mock('../src/control-plane/runtime', () => ({ mobilePermissionStore: { write: jest.fn().mockResolvedValue(undefined) } }));

const instance = ControlPlaneInstanceDirectoryEntrySchema.parse({
  id: 'instance-1',
  name: 'Instance',
  nodeId: 'node-1',
  status: 'running',
  health: 'ok',
  connectionStatus: 'online',
  ready: true,
  config: { defaultCodexPermissionMode: 'ask' },
  observedAt: '2026-09-05T00:00:00.000Z',
  runtime: { id: 'runtime-1', name: 'Docker', type: 'docker' },
  workspace: { status: 'ready', path: '/workspace' },
  protocol: { version: '2026-09-03', compatible: true },
  aiSessions: { runningCount: 0, waitingCount: 0, staleCount: 0, idleCount: 0, problemCount: 0, updatedAt: '2026-09-05T00:00:00.000Z' },
  availableAgents: [{ id: 'codex', name: 'Codex', kind: 'tty', supportsCwdSelection: true }],
});

const story = StorySchema.parse({
  id: 'story-1',
  ownerNodeId: 'node-1',
  title: 'Release',
  actions: [{
    id: 'deploy',
    title: 'Deploy staging',
    promptTemplate: 'Deploy to staging',
    targetInstanceId: instance.id,
    parameters: [],
    sessionPreset: { agent: 'codex', mode: 'queue', permissionMode: 'auto-review' },
  }],
  documents: [],
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
});

const mockRuntime = jest.mocked(useMobileControlPlaneRuntime);
const mockDirectories = jest.mocked(useActiveDirectories);
const mockSessions = jest.mocked(useActiveAiSessionsSnapshot);

test('a preset action confirms before directly creating and opening an AI Session', async () => {
  const create = jest.fn().mockResolvedValue({ disposition: 'created', aiSessionId: 'session-1' });
  const get = jest.fn().mockResolvedValue(story);
  const onOpenSession = jest.fn();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  mockRuntime.mockReturnValue({ api: { stories: { get }, aiSessions: { create } } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);
  mockDirectories.mockReturnValue({ controlPlaneId: 'cp-1', state: { instances: [instance], nodes: [] } } as unknown as ReturnType<typeof useActiveDirectories>);
  mockSessions.mockReturnValue({ instances: [] } as unknown as ReturnType<typeof useActiveAiSessionsSnapshot>);

  const screen = await render(<StoryDetail nodeId="node-1" onOpenSession={onOpenSession} storyId={story.id} />);
  await act(async () => { fireEvent.press(await screen.findByText('Deploy staging')); });

  expect(create).not.toHaveBeenCalled();
  expect(Alert.alert).toHaveBeenCalledWith(
    'Run Deploy staging?',
    'This immediately creates a new AI Session using this preset action.',
    expect.any(Array),
  );
  const buttons = jest.mocked(Alert.alert).mock.calls[0][2]!;
  await act(async () => {
    buttons[1].onPress?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  expect(onOpenSession).toHaveBeenCalledWith(instance.id, 'session-1');
  expect(create).toHaveBeenCalledWith(instance.id, expect.objectContaining({
    clientRequestId: 'story-action-action-request-1',
    message: 'Deploy to staging',
    mode: 'queue',
    permissionMode: 'auto-review',
    storyId: story.id,
  }));
  expect(mobilePermissionStore.write).toHaveBeenCalledWith('cp-1', instance.id, 'session-1', 'auto-review');
});
