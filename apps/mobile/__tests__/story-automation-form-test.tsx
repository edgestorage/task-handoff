import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ControlPlaneInstanceDirectoryEntrySchema } from '@task-handoff/protocol/control-plane-directory';
import { StorySchema } from '@task-handoff/protocol/stories';

import { StoryAutomationForm } from '../src/stories/StoryAutomationForm';
import { useMobileControlPlaneRuntime } from '../src/control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../src/directories/use-directories';

jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => ({ useMobileControlPlaneRuntime: jest.fn() }));
jest.mock('../src/directories/use-directories', () => ({ useActiveDirectories: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'action-uuid' }));

const story = StorySchema.parse({
  id: 'story-1',
  ownerNodeId: 'node-1',
  title: 'Release',
  actions: [{ id: 'deploy', title: 'Deploy', promptTemplate: 'Deploy it', targetInstanceId: 'instance-1' }],
  documents: [],
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
});

test('keeps automation fields below the transparent navigation header', async () => {
  jest.mocked(useMobileControlPlaneRuntime).mockReturnValue({
    api: { stories: { get: jest.fn().mockResolvedValue(story) } },
  } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);
  jest.mocked(useActiveDirectories).mockReturnValue({
    state: { instances: [{ id: 'instance-1', name: 'Instance', nodeId: 'node-1', ready: true }], nodes: [] },
  } as unknown as ReturnType<typeof useActiveDirectories>);

  const screen = await render(<StoryAutomationForm nodeId="node-1" onSaved={jest.fn()} storyId={story.id} />);

  await screen.findByText('Schedule');
  expect(screen.getByTestId('story-automation-scroll').props.contentInsetAdjustmentBehavior).toBe('automatic');
});

test('creates a new Automation Action through the shared session composer', async () => {
  const instance = ControlPlaneInstanceDirectoryEntrySchema.parse({
    id: 'instance-1', name: 'Instance', nodeId: 'node-1', status: 'running', health: 'ok', connectionStatus: 'online', ready: true,
    config: { defaultCodexPermissionMode: 'auto-review' },
    capabilities: { aiSessionProviders: [{ agent: 'codex', actions: {}, permissionModes: ['ask', 'auto-review'], timeline: {} }] },
    observedAt: '2026-09-05T00:00:00.000Z', runtime: { id: 'runtime-1', name: 'Docker', type: 'docker' },
    workspace: { status: 'ready', path: '/workspace' }, protocol: { version: '2026-09-03', compatible: true },
    aiSessions: { runningCount: 0, waitingCount: 0, staleCount: 0, idleCount: 0, problemCount: 0, updatedAt: '2026-09-05T00:00:00.000Z' },
    availableAgents: [{ id: 'codex', name: 'Codex', kind: 'tty', supportsCwdSelection: true }],
  });
  const createAutomationWithAction = jest.fn().mockResolvedValue({});
  const onSaved = jest.fn();
  jest.mocked(useMobileControlPlaneRuntime).mockReturnValue({
    api: {
      stories: { get: jest.fn().mockResolvedValue(story), createAutomationWithAction },
      resources: {
        nodeLocalFolders: jest.fn().mockResolvedValue([{ id: 'folder-1', name: 'Workspace', path: '/host/workspace' }]),
        instanceWorkspaceSource: jest.fn().mockResolvedValue({ type: 'local-folder', localFolderId: 'folder-1', path: '/host/workspace' }),
        models: jest.fn().mockResolvedValue({ models: [] }),
      },
      aiSessions: { workspace: jest.fn().mockResolvedValue({ availability: 'unavailable', branches: [] }) },
    },
  } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);
  jest.mocked(useActiveDirectories).mockReturnValue({ state: { instances: [instance], nodes: [{ id: 'node-1', name: 'Node' }] } } as unknown as ReturnType<typeof useActiveDirectories>);

  const screen = await render(<StoryAutomationForm nodeId="node-1" onSaved={onSaved} storyId={story.id} />);
  await fireEvent.press(await screen.findByRole('radio', { name: 'New action' }));
  await screen.findByText('Workspace');
  expect(screen.getByTestId('new-session-embedded')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Action title'), 'Ship release');
  await fireEvent.changeText(screen.getByLabelText('Prompt'), 'Ship it safely');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add Automation' })).toBeEnabled());
  await fireEvent.press(screen.getByRole('button', { name: 'Add Automation' }));

  await waitFor(() => expect(createAutomationWithAction).toHaveBeenCalledWith(story.id, story.ownerNodeId, {
    action: {
      id: 'action-action-uuid',
      title: 'Ship release',
      promptTemplate: 'Ship it safely',
      targetInstanceId: instance.id,
      sessionPreset: { agent: 'codex', cwdFolderId: 'folder-1', permissionMode: 'auto-review' },
    },
    automation: {
      enabled: true,
      policy: { maxConcurrentRuns: 1, whenBusy: 'skip' },
      schedule: { intervalMs: 3_600_000, scheduleKind: 'interval' },
    },
  }));
  expect(onSaved).toHaveBeenCalled();
});
