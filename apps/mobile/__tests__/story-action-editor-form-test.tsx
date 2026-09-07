import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ControlPlaneInstanceDirectoryEntrySchema } from '@task-handoff/protocol/control-plane-directory';
import { StorySchema } from '@task-handoff/protocol/stories';

import { StoryActionEditor } from '../src/stories/StoryActionEditor';
import { useMobileControlPlaneRuntime } from '../src/control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../src/directories/use-directories';

jest.mock('expo-crypto', () => ({ randomUUID: () => 'action-uuid' }));
jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({ useMobileControlPlaneRuntime: jest.fn() }));
jest.mock('../src/directories/use-directories', () => ({ useActiveDirectories: jest.fn() }));

const instance = ControlPlaneInstanceDirectoryEntrySchema.parse({
  id: 'instance-1',
  name: 'Instance',
  nodeId: 'node-1',
  status: 'running',
  health: 'ok',
  connectionStatus: 'online',
  ready: true,
  config: { defaultCodexPermissionMode: 'ask' },
  capabilities: { aiSessionProviders: [{ agent: 'codex', actions: {}, permissionModes: ['ask', 'auto-review', 'full-access'], timeline: {} }] },
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
  actions: [],
  documents: [],
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
});

test('reuses the new-session composer and saves its preset without attachments', async () => {
  const update = jest.fn().mockResolvedValue(story);
  jest.mocked(useMobileControlPlaneRuntime).mockReturnValue({
    api: {
      stories: { get: jest.fn().mockResolvedValue(story), update },
      resources: {
        nodeLocalFolders: jest.fn().mockResolvedValue([{ id: 'folder-1', name: 'Workspace', path: '/host/workspace' }]),
        instanceWorkspaceSource: jest.fn().mockResolvedValue({ type: 'local-folder', localFolderId: 'folder-1', path: '/host/workspace' }),
        models: jest.fn().mockResolvedValue({ models: [] }),
      },
      aiSessions: { workspace: jest.fn().mockResolvedValue({ availability: 'unavailable', branches: [] }) },
    },
  } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);
  jest.mocked(useActiveDirectories).mockReturnValue({
    state: { instances: [instance], nodes: [{ id: 'node-1', name: 'Node' }] },
  } as unknown as ReturnType<typeof useActiveDirectories>);

  const screen = await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
    <StoryActionEditor nodeId="node-1" onSaved={jest.fn()} storyId={story.id} />
  </SafeAreaProvider>);

  await screen.findByText('Workspace');
  expect(screen.getByTestId('new-session-scroll').props.contentInsetAdjustmentBehavior).toBe('automatic');
  expect(screen.getByTestId('new-session-composer-toolbar')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Add attachment' })).toBeNull();

  await fireEvent.changeText(screen.getByLabelText('Action title'), 'Deploy');
  await fireEvent.changeText(screen.getByLabelText('Prompt'), 'Deploy to staging');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create Action' })).toBeEnabled());
  await fireEvent.press(screen.getByRole('button', { name: 'Create Action' }));

  await waitFor(() => expect(update).toHaveBeenCalledWith(story.id, story.ownerNodeId, {
    actions: [{
      id: 'action-action-uuid',
      title: 'Deploy',
      promptTemplate: 'Deploy to staging',
      targetInstanceId: instance.id,
      sessionPreset: { agent: 'codex', cwdFolderId: 'folder-1', permissionMode: 'ask' },
    }],
  }));
});
