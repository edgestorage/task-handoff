import { act, fireEvent, render } from '@testing-library/react-native';
import { StorySchema } from '@task-handoff/protocol/stories';
import { createElement } from 'react';

import { parseStoryMaxIdleAiSessions, resolveStoryOwnerNodeId, StoryEditor } from '../src/stories/StoryEditor';
import { useMobileControlPlaneRuntime } from '../src/control-plane/use-mobile-control-plane-runtime';
import { useActiveDirectories } from '../src/directories/use-directories';

jest.mock('../src/control-plane/use-mobile-control-plane-runtime', () => { const useMobileControlPlaneRuntime = jest.fn(); return { useMobileControlPlaneRuntime, useOptionalMobileControlPlaneRuntime: useMobileControlPlaneRuntime }; });
jest.mock('../src/directories/use-directories', () => ({ useActiveDirectories: jest.fn() }));

const mockRuntime = jest.mocked(useMobileControlPlaneRuntime);
const mockDirectories = jest.mocked(useActiveDirectories);

beforeEach(() => {
  jest.clearAllMocks();
  mockDirectories.mockReturnValue({ state: { instances: [], nodes: [] } } as unknown as ReturnType<typeof useActiveDirectories>);
});

async function expandAdvanced(screen: Awaited<ReturnType<typeof render>>) {
  await act(async () => { fireEvent.press(screen.getByLabelText('Advanced settings')); });
}

function contextNode(capabilities: Record<string, unknown> = { contextSettings: { settings: true, projects: true, sessionPrompting: true } }) {
  return jest.fn().mockResolvedValue({ id: 'node-1', capabilities: { agent: { capabilities: { stories: capabilities } } } });
}

describe('StoryEditor', () => {
  test('selects the first available node after the directory loads', () => {
    expect(resolveStoryOwnerNodeId('', [])).toBe('');
    expect(resolveStoryOwnerNodeId('', [{ id: 'node-1' }])).toBe('node-1');
    expect(resolveStoryOwnerNodeId('node-2', [{ id: 'node-1' }])).toBe('node-2');
  });

  test('accepts only the protocol retention range', () => {
    expect(parseStoryMaxIdleAiSessions('1')).toBe(1);
    expect(parseStoryMaxIdleAiSessions('50')).toBe(50);
    expect(parseStoryMaxIdleAiSessions('0')).toBeUndefined();
    expect(parseStoryMaxIdleAiSessions('51')).toBeUndefined();
    expect(parseStoryMaxIdleAiSessions('1.5')).toBeUndefined();
  });

  test('loads and updates the same idle Session retention setting as the Web editor', async () => {
    const story = StorySchema.parse({
      id: 'story-1', ownerNodeId: 'node-1', title: 'Release', actions: [], documents: [],
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    });
    const update = jest.fn().mockResolvedValue(story);
    const retentionSettings = jest.fn().mockResolvedValue({ maxIdleAiSessions: 7 });
    mockRuntime.mockReturnValue({ api: {
      resources: { node: contextNode({ enabled: true }), nodeLocalFolders: jest.fn().mockResolvedValue([]) },
      stories: { get: jest.fn().mockResolvedValue(story), retentionSettings, update },
    } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);

    const screen = await render(createElement(StoryEditor, { nodeId: 'node-1', onSaved: jest.fn(), storyId: 'story-1' }));
    await expandAdvanced(screen);
    const retentionInput = await screen.findByLabelText('Keep idle AI Sessions');
    expect(retentionInput.props.value).toBe('7');

    await act(async () => { fireEvent.changeText(retentionInput, '9'); });
    expect(screen.getByLabelText('Keep idle AI Sessions').props.value).toBe('9');
    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(retentionSettings).toHaveBeenCalledWith('story-1', 'node-1');
    expect(update).toHaveBeenCalledWith('story-1', 'node-1', expect.objectContaining({ maxIdleAiSessions: 9 }));
  });

  test('loads the authoritative Agent tool categories and saves changed policy', async () => {
    const story = StorySchema.parse({
      id: 'story-1', ownerNodeId: 'node-1', title: 'Release', actions: [], documents: [],
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    });
    const updateAgentToolSettings = jest.fn().mockResolvedValue({
      policy: { content: true, actions: false, automations: true, aiSessions: false, decisions: false },
      revision: 'b'.repeat(64),
    });
    const agentToolSettings = jest.fn().mockResolvedValue({
      policy: { content: true, actions: false, automations: false, aiSessions: false, decisions: false },
      revision: 'a'.repeat(64),
    });
    mockDirectories.mockReturnValue({ state: { instances: [], nodes: [{
      id: 'node-1', name: 'Node', connectionPhase: 'healthy',
      capabilities: [],
    }] } } as unknown as ReturnType<typeof useActiveDirectories>);
    const node = jest.fn().mockResolvedValue({
      id: 'node-1',
      capabilities: { agent: { capabilities: { stories: { agentToolCapabilities: { policy: true } } } } },
    });
    mockRuntime.mockReturnValue({ api: { resources: { node, nodeLocalFolders: jest.fn().mockResolvedValue([]) }, stories: {
      get: jest.fn().mockResolvedValue(story),
      retentionSettings: jest.fn().mockResolvedValue({ maxIdleAiSessions: 5 }),
      agentToolSettings,
      update: jest.fn().mockResolvedValue(story),
      updateAgentToolSettings,
    } } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);

    const screen = await render(createElement(StoryEditor, { nodeId: 'node-1', onSaved: jest.fn(), storyId: 'story-1' }));
    await expandAdvanced(screen);
    expect((await screen.findByLabelText('Content')).props.value).toBe(true);
    expect(screen.getByLabelText('Preset actions').props.value).toBe(false);
    expect(screen.getByLabelText('Automations').props.value).toBe(false);
    expect(screen.getByLabelText('AI Sessions').props.value).toBe(false);

    await act(async () => { fireEvent(screen.getByLabelText('Automations'), 'valueChange', true); });
    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(agentToolSettings).toHaveBeenCalledWith('story-1', 'node-1');
    expect(node).toHaveBeenCalledWith('node-1');
    expect(updateAgentToolSettings).toHaveBeenCalledWith('story-1', 'node-1', {
      content: true, actions: false, automations: true, aiSessions: false, decisions: false,
    });
  });

  test('disables Agent tool settings when the node capability is absent', async () => {
    const story = StorySchema.parse({
      id: 'story-1', ownerNodeId: 'node-1', title: 'Release', actions: [], documents: [],
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    });
    const agentToolSettings = jest.fn();
    mockDirectories.mockReturnValue({ state: { instances: [], nodes: [{
      id: 'node-1', name: 'Node', connectionPhase: 'healthy', capabilities: [],
    }] } } as unknown as ReturnType<typeof useActiveDirectories>);
    mockRuntime.mockReturnValue({ api: { resources: { node: jest.fn().mockResolvedValue({
      id: 'node-1',
      capabilities: { agent: { capabilities: { stories: { enabled: true, agentTools: true } } } },
    }), nodeLocalFolders: jest.fn().mockResolvedValue([]) }, stories: {
      get: jest.fn().mockResolvedValue(story),
      retentionSettings: jest.fn().mockResolvedValue({ maxIdleAiSessions: 5 }),
      agentToolSettings,
    } } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);

    const screen = await render(createElement(StoryEditor, { nodeId: 'node-1', onSaved: jest.fn(), storyId: 'story-1' }));
    await expandAdvanced(screen);
    expect(await screen.findByText('Tool settings are not supported by this node agent.')).toBeTruthy();
    expect(agentToolSettings).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Content')).toBeNull();
  });

  test('keeps the editor open when Agent tool policy save conflicts', async () => {
    const story = StorySchema.parse({
      id: 'story-1', ownerNodeId: 'node-1', title: 'Release', actions: [], documents: [],
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    });
    const onSaved = jest.fn();
    mockDirectories.mockReturnValue({ state: { instances: [], nodes: [{
      id: 'node-1', name: 'Node', connectionPhase: 'healthy',
      capabilities: [],
    }] } } as unknown as ReturnType<typeof useActiveDirectories>);
    mockRuntime.mockReturnValue({ api: { resources: { node: jest.fn().mockResolvedValue({
      id: 'node-1',
      capabilities: { agent: { capabilities: { stories: { agentToolCapabilities: { policy: true } } } } },
    }), nodeLocalFolders: jest.fn().mockResolvedValue([]) }, stories: {
      get: jest.fn().mockResolvedValue(story),
      retentionSettings: jest.fn().mockResolvedValue({ maxIdleAiSessions: 5 }),
      agentToolSettings: jest.fn().mockResolvedValue({ policy: { content: true, actions: false, automations: false, aiSessions: false, decisions: false }, revision: 'a'.repeat(64) }),
      update: jest.fn().mockResolvedValue(story),
      updateAgentToolSettings: jest.fn().mockRejectedValue(new Error('Story tool settings changed.')),
    } } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);

    const screen = await render(createElement(StoryEditor, { nodeId: 'node-1', onSaved, storyId: 'story-1' }));
    await expandAdvanced(screen);
    await screen.findByLabelText('Preset actions');
    await act(async () => { fireEvent(screen.getByLabelText('Preset actions'), 'valueChange', true); });
    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(await screen.findByText('Story tool settings changed.')).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Preset actions').props.value).toBe(true);
  });

  test('loads related projects before advanced settings and keeps the prompt inside advanced', async () => {
    const story = StorySchema.parse({
      id: 'story-1', ownerNodeId: 'node-1', title: 'Release', actions: [], documents: [],
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    });
    const contextSettings = jest.fn().mockResolvedValue({
      storyId: 'story-1', revision: 3, projectFolderIds: [], appendedPrompt: 'Shared Story instructions',
      updatedAt: '2026-09-05T00:00:00.000Z',
    });
    mockDirectories.mockReturnValue({ state: { instances: [], nodes: [{ id: 'node-1', name: 'Node', connectionPhase: 'healthy' }] } } as unknown as ReturnType<typeof useActiveDirectories>);
    mockRuntime.mockReturnValue({ api: {
      resources: { node: contextNode(), nodeLocalFolders: jest.fn().mockResolvedValue([]) },
      stories: {
        get: jest.fn().mockResolvedValue(story),
        retentionSettings: jest.fn().mockResolvedValue({ maxIdleAiSessions: 5 }),
        agentToolSettings: jest.fn().mockResolvedValue({ policy: { content: true, actions: false, automations: false, aiSessions: false, decisions: false }, revision: 'a'.repeat(64) }),
        contextSettings,
      },
    } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);

    const screen = await render(createElement(StoryEditor, { nodeId: 'node-1', onSaved: jest.fn(), storyId: 'story-1' }));
    await screen.findByLabelText('Title');
    expect(await screen.findByText('Related projects')).toBeTruthy();
    expect(screen.queryByText('No related projects')).toBeNull();
    expect(contextSettings).toHaveBeenCalledWith('story-1', 'node-1', expect.any(AbortSignal));
    expect(screen.queryByLabelText('Story additional instructions')).toBeNull();

    await expandAdvanced(screen);
    const prompt = await screen.findByLabelText('Story additional instructions');
    expect(prompt.props.value).toBe('Shared Story instructions');
    expect(contextSettings).toHaveBeenCalledTimes(1);
  });

  test('sorts projects, clears the prompt, and preserves an unavailable project', async () => {
    const story = StorySchema.parse({
      id: 'story-1', ownerNodeId: 'node-1', title: 'Release', actions: [], documents: [],
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    });
    const folders = [
      { id: 'folder-a', nodeId: 'node-1', name: 'Alpha', path: '/work/alpha', labels: {}, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' },
      { id: 'folder-b', nodeId: 'node-1', name: 'Beta', path: '/work/beta', labels: {}, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' },
    ];
    const updateContextSettings = jest.fn().mockImplementation(async (_storyId, _nodeId, input) => ({
      storyId: 'story-1', revision: 4, projectFolderIds: input.projectFolderIds,
      appendedPrompt: input.appendedPrompt, updatedAt: '2026-09-05T00:01:00.000Z',
    }));
    mockDirectories.mockReturnValue({ state: { instances: [], nodes: [{ id: 'node-1', name: 'Node', connectionPhase: 'healthy' }] } } as unknown as ReturnType<typeof useActiveDirectories>);
    mockRuntime.mockReturnValue({ api: {
      resources: { node: contextNode(), nodeLocalFolders: jest.fn().mockResolvedValue(folders) },
      stories: {
        get: jest.fn().mockResolvedValue(story),
        retentionSettings: jest.fn().mockResolvedValue({ maxIdleAiSessions: 5 }),
        agentToolSettings: jest.fn().mockResolvedValue({ policy: { content: true, actions: false, automations: false, aiSessions: false, decisions: false }, revision: 'a'.repeat(64) }),
        contextSettings: jest.fn().mockResolvedValue({
          storyId: 'story-1', revision: 3, projectFolderIds: ['folder-a', 'folder-stale', 'folder-b'],
          appendedPrompt: 'Keep me', updatedAt: '2026-09-05T00:00:00.000Z',
        }),
        update: jest.fn().mockResolvedValue(story),
        updateContextSettings,
      },
    } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);

    const screen = await render(createElement(StoryEditor, { nodeId: 'node-1', onSaved: jest.fn(), storyId: 'story-1' }));
    await expandAdvanced(screen);
    expect(await screen.findByText('Project unavailable')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Move Beta up')); });
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Story additional instructions'), ''); });
    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(updateContextSettings).toHaveBeenCalledWith('story-1', 'node-1', {
      expectedRevision: 3,
      projectFolderIds: ['folder-a', 'folder-b', 'folder-stale'],
      appendedPrompt: '',
    });
    expect(screen.getByText('Project unavailable')).toBeTruthy();
  });

  test('hides Story context for an old node without requesting it', async () => {
    const story = StorySchema.parse({
      id: 'story-1', ownerNodeId: 'node-1', title: 'Release', actions: [], documents: [],
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    });
    const contextSettings = jest.fn();
    mockDirectories.mockReturnValue({ state: { instances: [], nodes: [{ id: 'node-1', name: 'Node', connectionPhase: 'healthy' }] } } as unknown as ReturnType<typeof useActiveDirectories>);
    mockRuntime.mockReturnValue({ api: {
      resources: {
        node: contextNode({ agentToolCapabilities: { policy: true } }),
        nodeLocalFolders: jest.fn().mockResolvedValue([]),
      },
      stories: {
        get: jest.fn().mockResolvedValue(story),
        retentionSettings: jest.fn().mockResolvedValue({ maxIdleAiSessions: 5 }),
        agentToolSettings: jest.fn().mockResolvedValue({ policy: { content: true, actions: false, automations: false, aiSessions: false, decisions: false }, revision: 'a'.repeat(64) }),
        contextSettings,
      },
    } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);

    const screen = await render(createElement(StoryEditor, { nodeId: 'node-1', onSaved: jest.fn(), storyId: 'story-1' }));
    await expandAdvanced(screen);
    await screen.findByText('Agent tools');
    expect(screen.queryByText('Related projects')).toBeNull();
    expect(contextSettings).not.toHaveBeenCalled();
  });

  test('creates the Story before reading the default context revision and saving the context', async () => {
    const created = StorySchema.parse({
      id: 'story-1', ownerNodeId: 'node-1', title: 'Release', actions: [], documents: [],
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    });
    const calls: string[] = [];
    const create = jest.fn().mockImplementation(async () => { calls.push('create'); return created; });
    const contextSettings = jest.fn().mockImplementation(async () => {
      calls.push('read-context');
      return { storyId: 'story-1', revision: 4, projectFolderIds: [], appendedPrompt: '', updatedAt: '2026-09-05T00:00:00.000Z' };
    });
    const updateContextSettings = jest.fn().mockImplementation(async (_storyId, _nodeId, input) => {
      calls.push('write-context');
      return { storyId: 'story-1', revision: 5, projectFolderIds: input.projectFolderIds, appendedPrompt: input.appendedPrompt, updatedAt: '2026-09-05T00:01:00.000Z' };
    });
    mockDirectories.mockReturnValue({ state: { instances: [], nodes: [{ id: 'node-1', name: 'Node', connectionPhase: 'online' }] } } as unknown as ReturnType<typeof useActiveDirectories>);
    mockRuntime.mockReturnValue({ api: {
      resources: { node: contextNode(), nodeLocalFolders: jest.fn().mockResolvedValue([]) },
      stories: { create, contextSettings, updateContextSettings },
    } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);

    const onSaved = jest.fn();
    const screen = await render(createElement(StoryEditor, { onSaved }));
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Title'), 'Release'); });
    await expandAdvanced(screen);
    const prompt = await screen.findByLabelText('Story additional instructions');
    await act(async () => { fireEvent.changeText(prompt, 'Created with context'); });
    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(calls).toEqual(['create', 'read-context', 'write-context']);
    expect(updateContextSettings).toHaveBeenCalledWith('story-1', 'node-1', {
      expectedRevision: 4,
      projectFolderIds: [],
      appendedPrompt: 'Created with context',
    });
    expect(onSaved).toHaveBeenCalledWith(created);
  });

  test('keeps a created Story and context draft after a revision conflict so retry updates it', async () => {
    const created = StorySchema.parse({
      id: 'story-1', ownerNodeId: 'node-1', title: 'Release', actions: [], documents: [],
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    });
    const create = jest.fn().mockResolvedValue(created);
    const contextSettings = jest.fn()
      .mockResolvedValueOnce({ storyId: 'story-1', revision: 4, projectFolderIds: [], appendedPrompt: '', updatedAt: '2026-09-05T00:00:00.000Z' })
      .mockResolvedValueOnce({ storyId: 'story-1', revision: 5, projectFolderIds: [], appendedPrompt: '', updatedAt: '2026-09-05T00:00:00.000Z' });
    const updateContextSettings = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Story context settings changed since they were read.'), { code: 'STORY_CONTEXT_REVISION_CONFLICT' }))
      .mockImplementationOnce(async (_storyId, _nodeId, input) => ({ storyId: 'story-1', revision: 6, projectFolderIds: input.projectFolderIds, appendedPrompt: input.appendedPrompt, updatedAt: '2026-09-05T00:01:00.000Z' }));
    const updateStory = jest.fn().mockResolvedValue(created);
    mockDirectories.mockReturnValue({ state: { instances: [], nodes: [{ id: 'node-1', name: 'Node', connectionPhase: 'online' }] } } as unknown as ReturnType<typeof useActiveDirectories>);
    mockRuntime.mockReturnValue({ api: {
      resources: { node: contextNode(), nodeLocalFolders: jest.fn().mockResolvedValue([]) },
      stories: { create, update: updateStory, contextSettings, updateContextSettings },
    } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);

    const onSaved = jest.fn();
    const screen = await render(createElement(StoryEditor, { onSaved }));
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Title'), 'Release'); });
    await expandAdvanced(screen);
    const prompt = await screen.findByLabelText('Story additional instructions');
    await act(async () => { fireEvent.changeText(prompt, 'Retry me'); });
    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(await screen.findByText('Story context settings changed since they were read.')).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Story additional instructions').props.value).toBe('Retry me');

    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(updateStory).toHaveBeenCalledWith('story-1', 'node-1', expect.objectContaining({ title: 'Release' }));
    expect(updateContextSettings).toHaveBeenLastCalledWith('story-1', 'node-1', expect.objectContaining({ expectedRevision: 5, appendedPrompt: 'Retry me' }));
    expect(onSaved).toHaveBeenCalledWith(created);
  });

  test('creates a Story with the Web editor retention default', async () => {
    const created = StorySchema.parse({
      id: 'story-1', ownerNodeId: 'node-1', title: 'Release', actions: [], documents: [],
      createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    });
    const create = jest.fn().mockResolvedValue(created);
    mockRuntime.mockReturnValue({ api: {
      resources: { node: contextNode({}), nodeLocalFolders: jest.fn().mockResolvedValue([]) },
      stories: { create },
    } } as unknown as ReturnType<typeof useMobileControlPlaneRuntime>);
    mockDirectories.mockReturnValue({ state: { instances: [], nodes: [{ id: 'node-1', name: 'Node', connectionPhase: 'online' }] } } as unknown as ReturnType<typeof useActiveDirectories>);

    const screen = await render(createElement(StoryEditor, { onSaved: jest.fn() }));
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Title'), 'Release'); });
    expect(screen.getByLabelText('Title').props.value).toBe('Release');
    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(create).toHaveBeenCalledWith('node-1', expect.objectContaining({ maxIdleAiSessions: 5, title: 'Release' }));
  });
});
